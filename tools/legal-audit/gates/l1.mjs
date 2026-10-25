// L1 - Licence policy (Workflow.md 4.2, R-SEC-7).
//
//   Rust : `cargo-deny --locked --format json --config <root>/deny.toml check licenses`; deny.toml holds the allowlist.
//          `cargo metadata --locked` supplies the full inventory (cargo-deny only reports violations).
//   npm  : every package of frontend/package-lock.json and tools/legal-audit/package-lock.json is judged against
//          policy/npm-licenses.json (SPDX expression evaluation). The licence comes from the installed
//          node_modules/<pkg>/package.json when present, else from the lockfile's `license` field.
//
// Fails on: disallowed licence, unknown / UNLICENSED / missing / non-SPDX licence, missing deny.toml, missing tool.
// Waivers (docs/waivers.yml, gate L1) match `finding.subject` = "<name>@<version>" exactly; they downgrade to warning.
//
// Options: --cargo-deny <bin> --cargo <bin> --npm-policy <file> --skip-reason <text>
// Env    : LEGAL_AUDIT_CARGO_DENY, LEGAL_AUDIT_CARGO
// Evidence: licence-inventory.json (every Rust crate and npm package with licence, source and verdict),
//           cargo-deny-licenses.json (raw diagnostics).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFailure, toolVersion } from '../lib/exec.mjs';
import { applyWaivers, hashInputs, loadWaivers, missingTool, optString, sha256File, skipRequested } from '../lib/common.mjs';
import { cargoMetadata, locateCargo, locateCargoDeny, normaliseCargoLicense, readNpmLock, runCargoDeny } from '../lib/inventory.mjs';
import { error, info, result, statusFromFindings, writeJson } from '../lib/result.mjs';
import { evaluateSpdx } from '../lib/spdx.mjs';

export const id = 'L1';
export const name = 'Licence policy';

const NPM_LOCKS = ['frontend/package-lock.json', 'tools/legal-audit/package-lock.json'];
const DEFAULT_NPM_POLICY = join(dirname(fileURLToPath(import.meta.url)), '..', 'policy', 'npm-licenses.json');

/** Translate one cargo-deny diagnostic into a finding. Exported for tests against real cargo-deny output. */
export function denyDiagnosticToFinding(d) {
  const krate = d.graphs?.[0]?.Krate;
  const subject = krate ? `${krate.name}@${krate.version}` : undefined;
  const severity = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info';
  const labelNotes = (d.labels ?? []).map((l) => l.message).filter(Boolean);
  const spans = (d.labels ?? []).filter((l) => !l.message).map((l) => l.span);
  const parts = [d.message];
  if (spans.length > 0) parts.push(`licence expression: ${[...new Set(spans)].join(', ')}`);
  if (labelNotes.length > 0) parts.push([...new Set(labelNotes)].join('; '));
  const text = `${parts.join(' - ')} [cargo-deny ${d.code ?? 'diagnostic'}]`;
  const f = { severity, message: text };
  if (subject) f.subject = subject;
  return f;
}

/** Evaluate one npm package; returns null when allowed, else a finding message. */
export function npmVerdict(license, policy) {
  if (license === null || license === undefined) {
    return 'no licence information (neither the installed package.json nor the lockfile declares one)';
  }
  if (/^UNLICEN[SC]ED$/i.test(license.trim())) return 'declared UNLICENSED (no licence granted)';
  const ev = evaluateSpdx(license, policy);
  if (ev.error) return `licence "${license}" is not a valid SPDX expression (${ev.error})`;
  if (ev.ok) return null;
  return `licence "${license}" is not allowed by policy (not on the allowlist: ${ev.disallowed.join(', ')})`;
}

function loadNpmPolicy(path) {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(p.allow) || p.allow.length === 0 || p.allow.some((x) => typeof x !== 'string')) {
    throw new Error(`${path}: "allow" must be a non-empty array of SPDX identifiers`);
  }
  return { allow: p.allow, exceptions: Array.isArray(p.exceptions) ? p.exceptions : [] };
}

export async function run(ctx) {
  const skipped = skipRequested(id, name, ctx);
  if (skipped) return skipped;

  const findings = [];
  const tools = {};
  const evidence = [];
  const inventory = { generated_at: ctx.now.toISOString(), cargo: [], npm: [] };
  const metrics = { rust_crates: 0, npm_packages: 0, rejected: 0 };
  let checked = 0;

  // ---- Rust -----------------------------------------------------------------------------------------------------
  const hasCargo = existsSync(join(ctx.root, 'Cargo.toml'));
  if (hasCargo) {
    checked++;
    const denyToml = join(ctx.root, 'deny.toml');
    const cargoBin = locateCargo(ctx.opts);
    if (!existsSync(denyToml)) {
      findings.push(error('deny.toml not found at the repository root: the Rust licence allowlist lives there', 'deny.toml'));
    } else if (!cargoBin) {
      findings.push(missingTool('cargo', 'put cargo on PATH or pass --cargo <path> (LEGAL_AUDIT_CARGO)'));
    } else {
      const inv = await locateCargoDeny(ctx.opts, cargoBin);
      if (!inv) {
        findings.push(missingTool('cargo-deny', 'install it (cargo install cargo-deny --locked) or pass --cargo-deny <path> (LEGAL_AUDIT_CARGO_DENY)'));
      } else {
        tools['cargo-deny'] = inv.version;
        tools.cargo = (await toolVersion(cargoBin, ['--version'])) ?? 'unknown';
        const { parsed, run: r } = await runCargoDeny(inv, cargoBin, ctx.root, 'licenses', { config: denyToml });
        const rejected = new Map();
        if (parsed.summary === null) {
          findings.push(error(`cargo-deny did not complete (no summary in its output): ${describeFailure(r)}`, 'cargo-deny'));
        } else {
          const errs = parsed.diagnostics.filter((d) => d.severity === 'error');
          for (const d of parsed.diagnostics) {
            const f = denyDiagnosticToFinding(d);
            findings.push(f);
            if (d.severity === 'error' && f.subject) rejected.set(f.subject, f.message);
          }
          const reported = parsed.summary.licenses?.errors ?? 0;
          if (reported > 0 && errs.length === 0) {
            findings.push(error(`cargo-deny reported ${reported} licence error(s) without a diagnostic: ${describeFailure(r)}`, 'cargo-deny'));
          }
          metrics.rejected += rejected.size;
        }
        try {
          const meta = await cargoMetadata(cargoBin, ctx.root);
          const members = new Set(meta.workspace_members);
          for (const p of meta.packages) {
            const subject = `${p.name}@${p.version}`;
            inventory.cargo.push({
              name: p.name,
              version: p.version,
              license: p.license ? normaliseCargoLicense(p.license) : null,
              license_file: p.license_file ?? null,
              source: p.source ?? 'path',
              workspace_member: members.has(p.id),
              verdict: rejected.has(subject) ? 'rejected' : 'accepted-by-cargo-deny',
            });
          }
          inventory.cargo.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
          metrics.rust_crates = inventory.cargo.length;
        } catch (e) {
          findings.push(error(`cannot build the Rust licence inventory: ${e.message}`, 'cargo metadata'));
        }
        evidence.push(writeJson(ctx.outDir, 'cargo-deny-licenses.json', { command: r.command, exit_code: r.code, summary: parsed.summary, diagnostics: parsed.diagnostics }));
      }
    }
  } else {
    findings.push(info('no Cargo.toml at the repository root: Rust licences not checked'));
  }

  // ---- npm ------------------------------------------------------------------------------------------------------
  const policyPath = typeof optString(ctx, 'npm-policy') === 'string' ? optString(ctx, 'npm-policy') : DEFAULT_NPM_POLICY;
  const lockfiles = NPM_LOCKS.filter((l) => existsSync(join(ctx.root, l)));
  if (lockfiles.length > 0) {
    checked++;
    let policy = null;
    try {
      policy = loadNpmPolicy(policyPath);
    } catch (e) {
      findings.push(error(`npm licence policy unusable: ${e.message}`, 'npm-licenses.json'));
    }
    if (policy) {
      for (const lockRel of lockfiles) {
        let lock;
        try {
          lock = readNpmLock(ctx.root, lockRel);
        } catch (e) {
          findings.push(error(`cannot read ${lockRel}: ${e.message}`, lockRel));
          continue;
        }
        for (const p of lock.packages) {
          const msg = npmVerdict(p.license, policy);
          inventory.npm.push({
            lockfile: lockRel,
            name: p.name,
            version: p.version,
            license: p.license,
            license_source: p.licenseSource,
            dev: p.dev,
            optional: p.optional,
            verdict: msg === null ? 'allowed' : 'rejected',
            ...(msg === null ? {} : { reason: msg }),
          });
          if (msg !== null) {
            findings.push(error(`${msg} (${lockRel})`, `${p.name}@${p.version}`));
            metrics.rejected++;
          }
        }
        metrics.npm_packages += lock.packages.length;
      }
    }
  } else {
    findings.push(info(`none of ${NPM_LOCKS.join(', ')} exists: npm licences not checked`));
  }

  if (checked === 0) {
    findings.push(error('nothing to check: the repository root has neither Cargo.toml nor an npm lockfile'));
  }

  evidence.unshift(writeJson(ctx.outDir, 'licence-inventory.json', inventory));

  // ---- waivers --------------------------------------------------------------------------------------------------
  const wv = loadWaivers(ctx.root, id, ctx.now);
  const applied = applyWaivers(findings, wv.waivers);
  const all = [...applied.findings, ...wv.findings];
  const status = statusFromFindings(all);
  const errCount = all.filter((f) => f.severity === 'error').length;
  return result(id, status, {
    summary: `${metrics.rust_crates} Rust crates, ${metrics.npm_packages} npm packages checked; ${errCount} licence error(s)`,
    findings: all,
    evidence,
    metrics,
    inputs: {
      ...hashInputs(ctx.root, ['deny.toml', 'Cargo.lock', 'Cargo.toml', ...lockfiles, 'docs/waivers.yml']),
      ...(sha256File(policyPath) ? { 'npm-licenses.json': sha256File(policyPath) } : {}),
    },
    tools,
    waived: applied.waived,
  });
}
