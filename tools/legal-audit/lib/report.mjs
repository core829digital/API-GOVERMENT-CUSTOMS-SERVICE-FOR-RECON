// legal-audit-report assembly and rendering (gate L12; Workflow.md 4.3).
import { REPORT_HEADER } from './result.mjs';

export const GATE_NAMES = Object.freeze({
  L1: 'Licence policy',
  L2: 'Vulnerabilities + SBOM',
  L3: 'Secret scan',
  L4: 'Data classification',
  L5: 'Privacy docs freshness',
  L6: 'Erasure & retention behaviour',
  L7: 'Ledger integrity',
  L8: 'Rule-pack citations & freshness',
  L9: 'E-invoice conformance fixtures',
  L10: 'Infrastructure policy',
  L11: 'Required human sign-off',
  L12: 'Attestation',
});

/** Gates whose findings can never be waived (Workflow.md 4.2). */
export const NON_WAIVABLE = Object.freeze(['L4', 'L6', 'L7', 'L10', 'L11']);
export const PREREQUISITES = Object.freeze(Array.from({ length: 11 }, (_, i) => `L${i + 1}`));

/**
 * @param {object} p
 * @param {string|null} p.commit
 * @param {boolean} p.release
 * @param {string} p.generatedAt ISO timestamp (from ctx.now)
 * @param {Array<object>} p.gates per prerequisite: {gate, name, status, summary, skip_reason?, waived, errors, warnings, result_sha256, inputs, tools, evidence:[{file, sha256}]}
 * @param {Array<object>} p.approvers [{login, teams, commit_id, submitted_at}]
 * @param {Array<object>} p.problems error findings raised by L12 itself
 * @param {object} p.toolVersions
 * @param {object|null} p.plan
 */
export function buildReport(p) {
  const planSkips = p.gates.filter((g) => g.status === 'skip').map((g) => ({ gate: g.gate, reason: g.skip_reason ?? null }));
  const waiversUsed = p.gates.filter((g) => g.waived.length).map((g) => ({ gate: g.gate, ids: g.waived }));
  const failed = p.problems.length > 0 || p.gates.some((g) => g.status === 'fail');
  const status = failed ? 'fail' : p.gates.some((g) => g.status === 'warn') ? 'warn' : 'pass';
  return {
    header: REPORT_HEADER,
    schema_version: 1,
    status,
    signed: false,
    signing: 'not signed by this gate; CI signs the report with cosign only when status is pass or warn',
    commit: p.commit,
    release: p.release,
    generated_at: p.generatedAt,
    gates: p.gates,
    human_approvers: p.approvers,
    plan_skips: planSkips,
    waivers_used: waiversUsed,
    tool_versions: p.toolVersions,
    problems: p.problems,
    plan: p.plan ? { release: p.plan.release === true, changed_files: Array.isArray(p.plan.changed) ? p.plan.changed.length : null } : null,
  };
}

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(r) {
  const out = [];
  out.push('# Legal-audit report', '', `> ${r.header}`, '');
  out.push(`- Overall status: **${r.status.toUpperCase()}**`);
  out.push(`- Commit: ${r.commit ?? '(not provided)'}`);
  out.push(`- Release build: ${r.release}`);
  out.push(`- Generated: ${r.generated_at}`);
  out.push(`- Signed: ${r.signed} (${r.signing})`, '');
  if (r.problems.length) {
    out.push('## Problems', '');
    for (const p of r.problems) out.push(`- ${p.subject ? `\`${cell(p.subject)}\`: ` : ''}${cell(p.message)}`);
    out.push('');
  }
  out.push('## Gates', '', '| gate | name | status | summary | errors | warnings | waivers |', '|---|---|---|---|---|---|---|');
  for (const g of r.gates) {
    out.push(`| ${g.gate} | ${cell(g.name)} | ${g.status} | ${cell(g.status === 'skip' ? `skipped: ${g.skip_reason}` : g.summary)} | ${g.errors} | ${g.warnings} | ${cell(g.waived.join(', ') || '-')} |`);
  }
  out.push('', '## Human approvers (L11)', '');
  if (r.human_approvers.length) {
    out.push('| login | teams | commit | approved at |', '|---|---|---|---|');
    for (const a of r.human_approvers) out.push(`| ${cell(a.login)} | ${cell((a.teams ?? []).join(', ') || '-')} | ${cell(a.commit_id)} | ${cell(a.submitted_at ?? 'unknown')} |`);
  } else out.push('_No human approvals recorded (no gated path required one, or L11 did not run)._');
  out.push('', '## Plan skips', '');
  if (r.plan_skips.length) for (const s of r.plan_skips) out.push(`- ${s.gate}: ${cell(s.reason)}`);
  else out.push('_none_');
  out.push('', '## Waivers used', '');
  if (r.waivers_used.length) for (const w of r.waivers_used) out.push(`- ${w.gate}: ${w.ids.join(', ')}`);
  else out.push('_none_');
  out.push('', '## Tool versions', '');
  const tv = Object.entries(r.tool_versions);
  if (tv.length) for (const [k, v] of tv) out.push(`- ${cell(k)}: ${cell(Array.isArray(v) ? v.join(' | ') : v)}`);
  else out.push('_none reported_');
  out.push('', '## Hashes of consumed inputs and evidence (sha256)', '');
  for (const g of r.gates) {
    const inputs = Object.entries(g.inputs ?? {});
    out.push(`### ${g.gate}`, '', `- result file: \`${g.result_sha256}\``);
    for (const [k, v] of inputs) out.push(`- input \`${cell(k)}\`: \`${v}\``);
    for (const e of g.evidence) out.push(`- evidence \`${cell(e.file)}\`: \`${e.sha256}\``);
    out.push('');
  }
  return out.join('\n');
}
