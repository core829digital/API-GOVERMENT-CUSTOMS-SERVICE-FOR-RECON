// Result contract shared by every gate (Workflow.md section 4.2).
//
// A gate module exports:
//   export const id = 'L4';
//   export const name = '...';
//   export async function run(ctx) -> Result
// where ctx = { root, now: Date, release: boolean, outDir, opts, log(msg) }.
//   root    absolute repository root
//   now     injectable clock (tests pin it; CLI default = real time, overridable with --today YYYY-MM-DD)
//   release true for release builds: every gate runs, and warn-in-PR conditions become failures where specified
//   opts    gate specific options parsed from `--key value` / `--flag` (repeated keys become arrays)
//
// Result.status:
//   pass  all checks green
//   warn  green, but with findings a human should look at (never hides a failure)
//   fail  gate failed
//   skip  not executed; `skip_reason` says why (path filter or explicit); L12 treats skip as acceptable only
//         when the plan allowed it and the build is not a release build
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATUSES = Object.freeze(['pass', 'warn', 'fail', 'skip']);

/** Verbatim header required by Workflow.md section 4.3. Do not edit without editing Workflow.md. */
export const REPORT_HEADER =
  'Automated evidence and control checks only. This report is not legal advice and does not establish legal compliance. Human reviewers and approval dates are listed below.';

/**
 * @param {string} id gate id, e.g. "L4"
 * @param {'pass'|'warn'|'fail'|'skip'} status
 * @param {object} [body]
 * @param {string} [body.summary] one line
 * @param {Array<{severity:'error'|'warning'|'info', message:string, subject?:string}>} [body.findings]
 * @param {string[]} [body.evidence] paths (relative to outDir) of emitted evidence files
 * @param {object} [body.metrics] free-form counters
 * @param {object} [body.inputs] sha256 of consumed inputs, keyed by label
 * @param {object} [body.tools] tool versions used
 * @param {string[]} [body.waived] waiver ids applied
 * @param {string} [body.skip_reason]
 */
export function result(id, status, body = {}) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status ${status}`);
  if (status === 'skip' && !body.skip_reason) throw new Error('skip requires skip_reason');
  return {
    gate: id,
    status,
    summary: body.summary ?? '',
    findings: body.findings ?? [],
    evidence: body.evidence ?? [],
    metrics: body.metrics ?? {},
    inputs: body.inputs ?? {},
    tools: body.tools ?? {},
    waived: body.waived ?? [],
    ...(body.skip_reason ? { skip_reason: body.skip_reason } : {}),
  };
}

export const error = (message, subject) => ({ severity: 'error', message, ...(subject ? { subject } : {}) });
export const warning = (message, subject) => ({ severity: 'warning', message, ...(subject ? { subject } : {}) });
export const info = (message, subject) => ({ severity: 'info', message, ...(subject ? { subject } : {}) });

/** fail if any error finding, else warn if any warning, else pass. */
export function statusFromFindings(findings) {
  if (findings.some((f) => f.severity === 'error')) return 'fail';
  if (findings.some((f) => f.severity === 'warning')) return 'warn';
  return 'pass';
}

export function writeJson(outDir, file, value) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, file), `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export function writeText(outDir, file, text) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, file), text);
  return file;
}
