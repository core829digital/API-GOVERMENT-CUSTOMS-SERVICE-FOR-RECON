// L12 - Attestation (Workflow.md 4.2/4.3). Assembles legal-audit-report.json and legal-audit-report.md from the gate
// results L1..L11 in <outDir> (<GATE>.json written by cli.mjs). It does NOT sign: CI signs with cosign afterwards,
// and only if this gate is not `fail`. The report records "signed": false.
//
// Fails when: a result file L1..L11 is missing or malformed; any prerequisite has status fail; a prerequisite was
// skipped without the plan (--plan, default <outDir>/plan.json) allowing it, or the build is a release; a waiver id was
// applied on L4/L6/L7/L10/L11; evidence listed by a gate is missing; the commit SHA is absent in a release build or
// malformed; L11 evidence (approvals.json) is missing.
//
// Options: --commit <sha> (default env GITHUB_SHA), --plan <path>. L12 is never skippable: --skip-reason is ignored
// (and noted). The report is written even when the gate fails, so the reason is on record.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildReport, GATE_NAMES, NON_WAIVABLE, PREREQUISITES, renderMarkdown } from '../lib/report.mjs';
import { error, info, result, STATUSES, statusFromFindings, warning, writeJson, writeText } from '../lib/result.mjs';
import { inputLabel, sha256File } from '../lib/proc.mjs';

export const id = 'L12';
export const name = 'Attestation';

function mergeTools(perGate) {
  const merged = {};
  for (const tools of perGate) {
    for (const [k, v] of Object.entries(tools ?? {})) {
      const cur = merged[k];
      if (cur === undefined) merged[k] = v;
      else if (JSON.stringify(cur) !== JSON.stringify(v)) merged[k] = [].concat(cur, [v]).flat().filter((x, i, a) => a.indexOf(x) === i);
    }
  }
  return merged;
}

export async function run(ctx) {
  const problems = [];
  const findings = [];
  if (ctx.opts['skip-reason'] !== undefined) findings.push(info('--skip-reason ignored: L12 is never skipped'));

  // plan
  const planPath = resolve(ctx.root, typeof ctx.opts.plan === 'string' ? ctx.opts.plan : join(ctx.outDir, 'plan.json'));
  let plan = null;
  const inputs = {};
  if (existsSync(planPath)) {
    try {
      plan = JSON.parse(readFileSync(planPath, 'utf8'));
      inputs[inputLabel(ctx.root, planPath)] = sha256File(planPath);
    } catch (e) {
      problems.push(error(`plan file is not valid JSON: ${e.message}`, inputLabel(ctx.root, planPath)));
    }
  } else findings.push(info('no plan.json: no gate may be skipped'));
  if (plan && ctx.release && plan.release !== true) problems.push(error('release build but plan.json is not a release plan', 'plan.json'));

  // commit
  let commit = typeof ctx.opts.commit === 'string' ? ctx.opts.commit : process.env.GITHUB_SHA ?? null;
  if (commit === '') commit = null;
  if (commit === null) {
    if (ctx.release) problems.push(error('commit SHA missing: pass --commit or set GITHUB_SHA (required for release builds)'));
    else findings.push(warning('commit SHA not provided (--commit / GITHUB_SHA); the report is not bound to a commit'));
  } else if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
    problems.push(error(`commit "${commit}" is not a full git object id (40 or 64 hex digits)`));
  }

  // gate results
  const gates = [];
  for (const g of PREREQUISITES) {
    const file = `${g}.json`;
    const path = join(ctx.outDir, file);
    if (!existsSync(path)) {
      problems.push(error(`result ${file} is missing: the gate did not run`, g));
      continue;
    }
    let res;
    try {
      res = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      problems.push(error(`result ${file} is not valid JSON: ${e.message}`, g));
      continue;
    }
    if (res.gate !== g || !STATUSES.includes(res.status) || !Array.isArray(res.findings) || !Array.isArray(res.evidence)) {
      problems.push(error(`result ${file} is malformed (gate/status/findings/evidence)`, g));
      continue;
    }
    const waived = Array.isArray(res.waived) ? res.waived : [];
    if (res.status === 'fail') problems.push(error(`prerequisite ${g} failed: ${res.summary || 'see findings'}`, g));
    if (res.status === 'skip') {
      const allowed = plan?.gates?.[g]?.run === false && !ctx.release && plan.release !== true;
      if (!allowed) problems.push(error(ctx.release ? 'skipped in a release build (release runs every gate)' : 'skipped, but plan.json does not allow skipping this gate', g));
      if (!res.skip_reason) problems.push(error('skip without skip_reason', g));
    }
    if (waived.length && NON_WAIVABLE.includes(g)) problems.push(error(`waiver(s) ${waived.join(', ')} applied on ${g}, which can never be waived`, g));
    const evidence = [];
    for (const e of res.evidence) {
      const ep = join(ctx.outDir, e);
      if (!existsSync(ep)) problems.push(error(`evidence file ${e} listed by ${g} is missing`, g));
      else evidence.push({ file: e, sha256: sha256File(ep) });
    }
    gates.push({
      gate: g,
      name: GATE_NAMES[g],
      status: res.status,
      summary: res.summary ?? '',
      ...(res.skip_reason ? { skip_reason: res.skip_reason } : {}),
      waived,
      errors: res.findings.filter((f) => f.severity === 'error').length,
      warnings: res.findings.filter((f) => f.severity === 'warning').length,
      result_sha256: sha256File(path),
      inputs: res.inputs ?? {},
      tools: res.tools ?? {},
      evidence,
    });
  }

  // human approvers from L11 evidence
  let approvers = [];
  const l11 = gates.find((g) => g.gate === 'L11');
  if (l11 && l11.status !== 'skip' && l11.status !== 'fail') {
    const ap = join(ctx.outDir, 'approvals.json');
    if (!l11.evidence.some((e) => e.file === 'approvals.json') || !existsSync(ap)) problems.push(error('L11 evidence approvals.json is missing; human approvers cannot be recorded', 'L11'));
    else {
      try {
        approvers = JSON.parse(readFileSync(ap, 'utf8')).approvers ?? [];
      } catch (e) {
        problems.push(error(`approvals.json is not valid JSON: ${e.message}`, 'L11'));
      }
    }
  }

  const report = buildReport({
    commit,
    release: ctx.release,
    generatedAt: ctx.now.toISOString(),
    gates,
    approvers,
    problems,
    toolVersions: { node: process.version, ...mergeTools(gates.map((g) => g.tools)) },
    plan,
  });
  const evidence = [writeJson(ctx.outDir, 'legal-audit-report.json', report), writeText(ctx.outDir, 'legal-audit-report.md', `${renderMarkdown(report)}\n`)];
  const all = [...problems, ...findings];
  const status = report.status === 'fail' ? 'fail' : statusFromFindings(all) === 'warn' || report.status === 'warn' ? 'warn' : 'pass';
  return result(id, status, {
    summary: `${gates.length}/${PREREQUISITES.length} gate results assembled; report status ${report.status}; signed=false`,
    findings: all,
    evidence,
    metrics: { gates_found: gates.length, skipped: report.plan_skips.length, waivers_used: report.waivers_used.length },
    inputs,
    tools: { node: process.version },
  });
}
