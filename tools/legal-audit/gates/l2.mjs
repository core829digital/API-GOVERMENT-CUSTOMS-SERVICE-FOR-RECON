// L2 - Vulnerabilities + SBOM (Workflow.md 4.2, R-SEC-7).
//
//   * `cargo-deny --locked --format json --config <root>/deny.toml check advisories` (RustSec database)
//   * `osv-scanner scan source --format json -L <lockfile>...` over Cargo.lock, frontend/package-lock.json and
//     tools/legal-audit/package-lock.json (OSV database; needs network access to api.osv.dev)
//   * a CycloneDX 1.6 JSON SBOM built by this gate from `cargo metadata --locked`, Cargo.lock and the npm lockfiles
//
// Severity policy: CVSS base score >= 7.0 (HIGH, CRITICAL) is an error. A vulnerability without a score is an error when
// no fixed version is known and a warning when a fix exists. A CVSS vector this gate cannot score (v2, v4, malformed) is
// treated as HIGH, never silently ignored. Below 7.0 is a warning (>= 4.0) or info. Findings are waivable per advisory id
// (`finding.subject` = primary advisory id, e.g. RUSTSEC-2021-0003 or GHSA-xxxx) via docs/waivers.yml gate L2.
// Non-vulnerability advisories (unmaintained, unsound, yanked, notice) keep the severity cargo-deny assigned from deny.toml.
//
// Options: --osv-scanner <bin> --cargo-deny <bin> --cargo <bin> --sbom-name <name> --sbom-version <v> --skip-reason <text>
// Env    : LEGAL_AUDIT_OSV_SCANNER, LEGAL_AUDIT_CARGO_DENY, LEGAL_AUDIT_CARGO
// Evidence: sbom.cdx.json, osv-scanner-report.json, cargo-deny-advisories.json, vulnerabilities.json
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFailure, resolveBinary, run as runProcess, toolVersion } from '../lib/exec.mjs';
import { applyWaivers, hashInputs, loadWaivers, missingTool, optString, skipRequested } from '../lib/common.mjs';
import { cargoMetadata, locateCargo, locateCargoDeny, readCargoLock, readNpmLock, runCargoDeny } from '../lib/inventory.mjs';
import { error, info, result, statusFromFindings, warning, writeJson } from '../lib/result.mjs';
import { buildSbom } from '../lib/sbom.mjs';

export const id = 'L2';
export const name = 'Vulnerabilities + SBOM';

const LOCKFILES = ['Cargo.lock', 'frontend/package-lock.json', 'tools/legal-audit/package-lock.json'];
const NPM_LOCKS = LOCKFILES.filter((l) => l.endsWith('package-lock.json'));
export const HIGH_THRESHOLD = 7.0;
const MEDIUM_THRESHOLD = 4.0;

// ---------------------------------------------------------------------------------------------------------------
// CVSS v3.x base score (FIRST CVSS v3.1 specification, section 7.1)
// ---------------------------------------------------------------------------------------------------------------

const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
  PR_U: { N: 0.85, L: 0.62, H: 0.27 },
  PR_C: { N: 0.85, L: 0.68, H: 0.5 },
};

function roundUp1(x) {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

/** @returns {number|null} base score, or null when the vector is not a complete CVSS v3.0/v3.1 vector */
export function cvss3Score(vector) {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(vector ?? '');
  if (!m) return null;
  const v = {};
  for (const part of m[1].split('/')) {
    const [k, val] = part.split(':');
    v[k] = val;
  }
  const changed = v.S === 'C';
  const av = W.AV[v.AV];
  const ac = W.AC[v.AC];
  const pr = (changed ? W.PR_C : W.PR_U)[v.PR];
  const ui = W.UI[v.UI];
  const c = W.CIA[v.C];
  const i = W.CIA[v.I];
  const a = W.CIA[v.A];
  if ([av, ac, pr, ui, c, i, a].some((x) => x === undefined) || !['U', 'C'].includes(v.S)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  return roundUp1(changed ? Math.min(1.08 * (impact + exploitability), 10) : Math.min(impact + exploitability, 10));
}

const LABEL_SCORE = { CRITICAL: 9.0, HIGH: 7.0, MODERATE: 5.0, MEDIUM: 5.0, LOW: 2.0 };

// ---------------------------------------------------------------------------------------------------------------
// Normalised vulnerability records
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} Vuln
 * @property {string} id           primary advisory id (finding subject)
 * @property {string[]} allIds     id + aliases
 * @property {string} pkg          package name
 * @property {string} version
 * @property {string} ecosystem
 * @property {string} source       lockfile / tool the record came from
 * @property {number|null} score   CVSS base score when known
 * @property {boolean} unscorable  a severity vector exists but could not be scored
 * @property {boolean} fixAvailable
 * @property {string[]} fixedVersions
 * @property {string} title
 * @property {string} tool
 */

function fixedVersionsOf(affected) {
  const out = new Set();
  for (const a of affected ?? []) for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) out.add(e.fixed);
  return [...out];
}

function scoreFromOsvRecords(records, groupMax) {
  const n = Number.parseFloat(groupMax);
  if (Number.isFinite(n)) return { score: n, unscorable: false };
  let best = null;
  let unscorable = false;
  for (const rec of records) {
    const label = LABEL_SCORE[String(rec.database_specific?.severity ?? '').toUpperCase()];
    if (label !== undefined) best = Math.max(best ?? 0, label);
    for (const s of rec.severity ?? []) {
      const sc = cvss3Score(s.score);
      if (sc === null) unscorable = true;
      else best = Math.max(best ?? 0, sc);
    }
  }
  return { score: best, unscorable: best === null && unscorable };
}

/** osv-scanner `--format json` document -> Vuln[] (one per OSV group, i.e. per distinct advisory x package). */
export function parseOsv(doc) {
  const out = [];
  for (const res of doc.results ?? []) {
    for (const p of res.packages ?? []) {
      const byId = new Map((p.vulnerabilities ?? []).map((v) => [v.id, v]));
      const groups = p.groups?.length ? p.groups : (p.vulnerabilities ?? []).map((v) => ({ ids: [v.id], aliases: v.aliases ?? [] }));
      for (const g of groups) {
        const records = (g.ids ?? []).map((i) => byId.get(i)).filter(Boolean);
        if (records.length === 0) continue;
        const { score, unscorable } = scoreFromOsvRecords(records, g.max_severity);
        const fixed = [...new Set(records.flatMap((r) => fixedVersionsOf(r.affected)))];
        out.push({
          id: g.ids[0],
          allIds: [...new Set([...(g.ids ?? []), ...(g.aliases ?? [])])],
          pkg: p.package.name,
          version: p.package.version,
          ecosystem: p.package.ecosystem,
          source: res.source?.path ?? '',
          score,
          unscorable,
          fixAvailable: fixed.length > 0,
          fixedVersions: fixed,
          title: records[0].summary ?? records[0].id,
          tool: 'osv-scanner',
        });
      }
    }
  }
  return out;
}

/**
 * cargo-deny `check advisories` diagnostics -> {vulns, others}. `vulns` are code "vulnerability" records;
 * `others` are unmaintained / unsound / yanked / notice / config diagnostics which keep cargo-deny's own severity.
 */
export function parseDenyAdvisories(diagnostics) {
  const vulns = [];
  const others = [];
  for (const d of diagnostics) {
    const krate = d.graphs?.[0]?.Krate;
    if (d.code === 'vulnerability' && d.advisory) {
      const a = d.advisory;
      const score = cvss3Score(a.cvss);
      const solution = (d.notes ?? []).find((n) => n.startsWith('Solution:'));
      vulns.push({
        id: a.id,
        allIds: [a.id, ...(a.aliases ?? [])],
        pkg: krate?.name ?? a.package,
        version: krate?.version ?? '',
        ecosystem: 'crates.io',
        source: 'cargo-deny',
        score,
        unscorable: score === null && typeof a.cvss === 'string' && a.cvss !== '',
        fixAvailable: solution !== undefined && !/no safe upgrade/i.test(solution),
        fixedVersions: [],
        title: a.title ?? d.message,
        tool: 'cargo-deny',
      });
    } else {
      others.push(d);
    }
  }
  return { vulns, others };
}

/** @returns {'error'|'warning'|'info'} */
export function classify(v) {
  if (v.score !== null) {
    if (v.score >= HIGH_THRESHOLD) return 'error';
    return v.score >= MEDIUM_THRESHOLD ? 'warning' : 'info';
  }
  if (v.unscorable) return 'error';
  return v.fixAvailable ? 'warning' : 'error';
}

function describe(v) {
  const sev = v.score !== null ? `CVSS ${v.score.toFixed(1)}` : v.unscorable ? 'severity vector not scorable (treated as HIGH)' : 'unscored';
  const fix = v.fixAvailable ? `fixed in ${v.fixedVersions.length ? v.fixedVersions.join(', ') : 'a newer version'}` : 'no fix available';
  const aliases = v.allIds.filter((x) => x !== v.id);
  return `${v.pkg}@${v.version}${aliases.length ? ` (${aliases.join(', ')})` : ''} - ${v.title}; ${sev}; ${fix} [${v.tool}${v.source && v.tool === 'osv-scanner' ? `: ${v.source}` : ''}]`;
}

function vulnFinding(v) {
  const sev = classify(v);
  const make = sev === 'error' ? error : sev === 'warning' ? warning : info;
  return make(describe(v), v.id);
}

// ---------------------------------------------------------------------------------------------------------------

function denyOtherFinding(d) {
  const krate = d.graphs?.[0]?.Krate;
  const subject = d.advisory?.id ?? (krate ? `${krate.name}@${krate.version}` : undefined);
  const sev = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info';
  const make = sev === 'error' ? error : sev === 'warning' ? warning : info;
  const where = krate ? `${krate.name}@${krate.version}: ` : '';
  return make(`${where}${d.message} [cargo-deny ${d.code ?? 'diagnostic'}]`, subject);
}

export async function run(ctx) {
  const skipped = skipRequested(id, name, ctx);
  if (skipped) return skipped;

  const findings = [];
  const tools = {};
  const evidence = [];
  const metrics = { vulnerabilities: 0, errors: 0, sbom_components: 0 };
  const vulns = [];
  const lockfiles = LOCKFILES.filter((l) => existsSync(join(ctx.root, l)));
  const hasCargo = existsSync(join(ctx.root, 'Cargo.toml'));
  if (lockfiles.length === 0 && !hasCargo) {
    findings.push(error('nothing to scan: no Cargo.toml, Cargo.lock or npm lockfile at the expected locations'));
  }

  const cargoBin = locateCargo(ctx.opts);

  // ---- cargo-deny advisories -----------------------------------------------------------------------------------
  if (hasCargo) {
    const denyToml = join(ctx.root, 'deny.toml');
    if (!existsSync(denyToml)) {
      findings.push(error('deny.toml not found at the repository root (cargo-deny advisories need its [advisories] section)', 'deny.toml'));
    } else if (!cargoBin) {
      findings.push(missingTool('cargo', 'put cargo on PATH or pass --cargo <path> (LEGAL_AUDIT_CARGO)'));
    } else {
      const inv = await locateCargoDeny(ctx.opts, cargoBin);
      if (!inv) {
        findings.push(missingTool('cargo-deny', 'install it (cargo install cargo-deny --locked) or pass --cargo-deny <path> (LEGAL_AUDIT_CARGO_DENY)'));
      } else {
        tools['cargo-deny'] = inv.version;
        const { parsed, run: r } = await runCargoDeny(inv, cargoBin, ctx.root, 'advisories', { config: denyToml });
        if (parsed.summary === null) {
          findings.push(error(`cargo-deny advisories did not complete (no summary in its output): ${describeFailure(r)}`, 'cargo-deny'));
        } else {
          const { vulns: dv, others } = parseDenyAdvisories(parsed.diagnostics);
          vulns.push(...dv);
          for (const d of others) findings.push(denyOtherFinding(d));
          const errs = parsed.summary.advisories?.errors ?? 0;
          const seenErr = dv.length + others.filter((d) => d.severity === 'error').length;
          if (errs > 0 && seenErr === 0) {
            findings.push(error(`cargo-deny reported ${errs} advisory error(s) without a diagnostic: ${describeFailure(r)}`, 'cargo-deny'));
          }
        }
        evidence.push(writeJson(ctx.outDir, 'cargo-deny-advisories.json', { command: r.command, exit_code: r.code, summary: parsed.summary, diagnostics: parsed.diagnostics }));
      }
    }
  }

  // ---- osv-scanner ---------------------------------------------------------------------------------------------
  if (lockfiles.length > 0) {
    const osv = resolveBinary('osv-scanner', { explicit: ctx.opts['osv-scanner'], envVar: 'LEGAL_AUDIT_OSV_SCANNER' });
    if (!osv) {
      findings.push(missingTool('osv-scanner', 'install it from https://github.com/google/osv-scanner/releases or pass --osv-scanner <path> (LEGAL_AUDIT_OSV_SCANNER)'));
    } else {
      tools['osv-scanner'] = ((await toolVersion(osv, ['--version'])) ?? 'unknown').split(/\r?\n/)[0];
      const tmp = mkdtempSync(join(tmpdir(), 'legal-audit-osv-'));
      const reportPath = join(tmp, 'osv.json');
      try {
        const args = ['scan', 'source', '--format', 'json', '--output-file', reportPath];
        for (const l of lockfiles) args.push('-L', join(ctx.root, l));
        const r = await runProcess(osv, args, { cwd: ctx.root, timeoutMs: 900_000 });
        // exit 0 = no vulnerabilities, 1 = vulnerabilities found; anything else is a tool failure.
        if (![0, 1].includes(r.code) || !existsSync(reportPath)) {
          findings.push(error(`osv-scanner failed: ${describeFailure(r)}`, 'osv-scanner'));
        } else {
          let doc = null;
          try {
            doc = JSON.parse(readFileSync(reportPath, 'utf8'));
          } catch (e) {
            findings.push(error(`osv-scanner produced an unreadable report: ${e.message}`, 'osv-scanner'));
          }
          if (doc) {
            // the report is evidence: store lockfile paths relative to the repository root, not machine specific
            const rootPrefix = `${ctx.root.replaceAll('\\', '/').replace(/\/$/, '')}/`;
            for (const rres of doc.results ?? []) {
              const p = String(rres.source?.path ?? '').replaceAll('\\', '/');
              if (rres.source) rres.source.path = p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p;
            }
            const relDoc = doc;
            // cargo-deny and osv-scanner both read Cargo.lock: keep the cargo-deny record, drop the osv duplicate
            for (const v of parseOsv(relDoc)) {
              const dup = vulns.some((x) => x.tool === 'cargo-deny' && x.pkg === v.pkg && x.version === v.version && x.allIds.some((i) => v.allIds.includes(i)));
              if (!dup) vulns.push(v);
            }
            evidence.push(writeJson(ctx.outDir, 'osv-scanner-report.json', relDoc));
          }
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  for (const v of vulns) findings.push(vulnFinding(v));
  metrics.vulnerabilities = vulns.length;
  evidence.push(writeJson(ctx.outDir, 'vulnerabilities.json', vulns.map((v) => ({ ...v, severity: classify(v) }))));

  // ---- SBOM ------------------------------------------------------------------------------------------------------
  if (lockfiles.length > 0 || hasCargo) {
    try {
      let meta = null;
      if (hasCargo) {
        if (!cargoBin) findings.push(missingTool('cargo', 'needed for `cargo metadata --locked` (SBOM)'));
        else meta = await cargoMetadata(cargoBin, ctx.root);
      }
      const npmLocks = NPM_LOCKS.filter((l) => existsSync(join(ctx.root, l))).map((l) => readNpmLock(ctx.root, l));
      if (meta || npmLocks.length > 0) {
        const pkgJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
        const { bom, counts } = buildSbom({
          cargoMetadata: meta,
          cargoLock: readCargoLock(ctx.root),
          npmLocks,
          now: ctx.now,
          rootName: optString(ctx, 'sbom-name') ?? 'recon',
          rootVersion: optString(ctx, 'sbom-version'),
          tool: { name: 'recon-legal-audit-L2', version: pkgJson.version },
        });
        metrics.sbom_components = counts.cargo + counts.npm;
        evidence.unshift(writeJson(ctx.outDir, 'sbom.cdx.json', bom));
        findings.push(info(`SBOM CycloneDX 1.6: ${counts.cargo} crates, ${counts.npm} npm packages`));
      }
    } catch (e) {
      findings.push(error(`SBOM generation failed: ${e.message}`, 'sbom'));
    }
  }

  // ---- waivers + result ------------------------------------------------------------------------------------------
  const wv = loadWaivers(ctx.root, id, ctx.now);
  const applied = applyWaivers(findings, wv.waivers);
  const all = [...applied.findings, ...wv.findings];
  metrics.errors = all.filter((f) => f.severity === 'error').length;
  return result(id, statusFromFindings(all), {
    summary: `${metrics.vulnerabilities} known vulnerabilities, ${metrics.errors} blocking; SBOM with ${metrics.sbom_components} components`,
    findings: all,
    evidence,
    metrics,
    inputs: hashInputs(ctx.root, ['deny.toml', ...LOCKFILES, 'Cargo.toml', 'docs/waivers.yml']),
    tools,
    waived: applied.waived,
  });
}
