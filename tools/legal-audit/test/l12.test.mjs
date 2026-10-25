import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as l12 from '../gates/l12.mjs';
import { error, REPORT_HEADER, result, warning, writeJson } from '../lib/result.mjs';

const SHA = 'a'.repeat(40);
const NOW = new Date('2026-10-23T08:00:00Z');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Directory with plausible results L1..L11 written exactly as cli.mjs writes them (writeJson of result()). */
function outDirWith(overrides = {}) {
  const out = mkdtempSync(join(tmpdir(), 'l12-'));
  for (let i = 1; i <= 11; i++) {
    const id = `L${i}`;
    if (overrides[id] === null) continue;
    const res =
      overrides[id] ??
      result(id, 'pass', {
        summary: `${id} ok`,
        inputs: { [`input-of-${id}`]: createHash('sha256').update(id).digest('hex') },
        tools: id === 'L1' ? { 'cargo-deny': 'cargo-deny 0.18.5' } : id === 'L2' ? { 'cargo-deny': 'cargo-deny 0.18.5', 'osv-scanner': '2.2.2' } : {},
      });
    writeJson(out, `${id}.json`, res);
  }
  if (!('L11' in overrides)) {
    writeJson(out, 'approvals.json', {
      head_sha: SHA,
      approvers: [{ login: 'alice-compliance', teams: ['core829srl/compliance'], commit_id: SHA, submitted_at: '2026-10-22T11:30:00Z' }],
    });
    writeJson(out, 'L11.json', result('L11', 'pass', { summary: '1 gated file', evidence: ['approvals.json'] }));
  }
  return out;
}
const ctxOf = (outDir, opts = {}, release = false) => ({ root: outDir, now: NOW, release, outDir, opts: { commit: SHA, ...opts }, log: () => {} });
const report = (out) => JSON.parse(readFileSync(join(out, 'legal-audit-report.json'), 'utf8'));

test('assembles a report when L1-L11 pass: verbatim header, unsigned, hashes, tool versions, approvers', async () => {
  const out = outDirWith();
  const r = await l12.run(ctxOf(out));
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  const rep = report(out);
  assert.equal(rep.header, REPORT_HEADER);
  assert.equal(rep.signed, false);
  assert.equal(rep.commit, SHA);
  assert.equal(rep.status, 'pass');
  assert.equal(rep.gates.length, 11);
  assert.equal(rep.gates[3].gate, 'L4');
  assert.equal(rep.gates[3].result_sha256, sha(join(out, 'L4.json')));
  assert.equal(rep.gates[3].inputs['input-of-L4'], createHash('sha256').update('L4').digest('hex'));
  assert.equal(rep.gates[10].evidence[0].sha256, sha(join(out, 'approvals.json')));
  assert.equal(rep.tool_versions['cargo-deny'], 'cargo-deny 0.18.5', 'identical versions are not duplicated');
  assert.equal(rep.tool_versions['osv-scanner'], '2.2.2');
  assert.equal(rep.human_approvers[0].login, 'alice-compliance');
  const md = readFileSync(join(out, 'legal-audit-report.md'), 'utf8');
  assert.ok(md.includes(REPORT_HEADER));
  assert.match(md, /alice-compliance \| core829srl\/compliance \| a{40} \| 2026-10-22T11:30:00Z/);
  assert.match(md, /Signed: false/);
  assert.deepEqual(r.evidence, ['legal-audit-report.json', 'legal-audit-report.md']);
});

test('conflicting tool versions between gates are both kept', async () => {
  const out = outDirWith({ L1: result('L1', 'pass', { tools: { 'cargo-deny': '0.18.5' } }), L2: result('L2', 'pass', { tools: { 'cargo-deny': '0.18.6' } }) });
  await l12.run(ctxOf(out));
  assert.deepEqual(report(out).tool_versions['cargo-deny'], ['0.18.5', '0.18.6']);
});

test('a warning in a prerequisite makes the report and gate warn, not fail', async () => {
  const out = outDirWith({ L8: result('L8', 'warn', { findings: [warning('pack older than 90 days', 'EU/vat')] }) });
  const r = await l12.run(ctxOf(out));
  assert.equal(r.status, 'warn');
  assert.equal(report(out).gates[7].warnings, 1);
});

test('a missing prerequisite result fails and writes the report documenting it', async () => {
  const out = outDirWith({ L5: null });
  const r = await l12.run(ctxOf(out));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => f.subject === 'L5' && /missing/.test(f.message)));
  assert.equal(report(out).status, 'fail');
  assert.equal(report(out).gates.length, 10);
});

test('a failed prerequisite fails L12', async () => {
  const out = outDirWith({ L3: result('L3', 'fail', { summary: '1 secret', findings: [error('aws key', 'a.txt')] }) });
  const r = await l12.run(ctxOf(out));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => /prerequisite L3 failed/.test(f.message)));
});

test('malformed result file (wrong gate id / unknown status) fails', async () => {
  const out = outDirWith();
  writeJson(out, 'L2.json', { ...result('L2', 'pass'), gate: 'L9' });
  assert.equal((await l12.run(ctxOf(out))).status, 'fail');
  const out2 = outDirWith();
  writeFileSync(join(out2, 'L2.json'), '{"gate":"L2","status":"green","findings":[],"evidence":[]}');
  assert.equal((await l12.run(ctxOf(out2))).status, 'fail');
  const out3 = outDirWith();
  writeFileSync(join(out3, 'L2.json'), 'not json');
  assert.equal((await l12.run(ctxOf(out3))).status, 'fail');
});

test('skip is accepted only when plan.json allows it and the build is not a release', async () => {
  const skipped = result('L9', 'skip', { skip_reason: 'docs-only change' });
  const plan = { release: false, changed: ['README.md'], gates: { L9: { run: false, reason: 'docs-only change' }, L1: { run: true, reason: '' } } };
  const out = outDirWith({ L9: skipped });
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan));
  const r = await l12.run(ctxOf(out));
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  assert.deepEqual(report(out).plan_skips, [{ gate: 'L9', reason: 'docs-only change' }]);
  assert.equal(Object.keys(r.inputs)[0], 'plan.json');

  const noPlan = outDirWith({ L9: skipped });
  assert.equal((await l12.run(ctxOf(noPlan))).status, 'fail', 'no plan: skip not allowed');

  const planSaysRun = outDirWith({ L9: skipped });
  writeFileSync(join(planSaysRun, 'plan.json'), JSON.stringify({ ...plan, gates: { L9: { run: true, reason: 'rules changed' } } }));
  assert.equal((await l12.run(ctxOf(planSaysRun))).status, 'fail', 'plan required L9 to run');

  const rel = outDirWith({ L9: skipped });
  writeFileSync(join(rel, 'plan.json'), JSON.stringify({ ...plan, release: true }));
  const rr = await l12.run(ctxOf(rel, {}, true));
  assert.equal(rr.status, 'fail');
  assert.ok(rr.findings.some((f) => /release/.test(f.message) && f.subject === 'L9'));
});

test('waivers: recorded for L1, forbidden on L4/L6/L7/L10/L11', async () => {
  const ok = outDirWith({ L1: result('L1', 'warn', { waived: ['W-2026-001'], findings: [warning('waived advisory', 'RUSTSEC-2026-0001')] }) });
  const r = await l12.run(ctxOf(ok));
  assert.equal(r.status, 'warn');
  assert.deepEqual(report(ok).waivers_used, [{ gate: 'L1', ids: ['W-2026-001'] }]);
  for (const g of ['L4', 'L6', 'L7', 'L10']) {
    const out = outDirWith({ [g]: result(g, 'pass', { waived: ['W-2026-002'] }) });
    const res = await l12.run(ctxOf(out));
    assert.equal(res.status, 'fail', g);
    assert.ok(res.findings.some((f) => f.subject === g && /never be waived/.test(f.message)));
  }
  const l11 = outDirWith({ L11: result('L11', 'pass', { waived: ['W-1'], evidence: ['approvals.json'] }) });
  writeJson(l11, 'approvals.json', { approvers: [] });
  assert.equal((await l12.run(ctxOf(l11))).status, 'fail');
});

test('commit: from --commit or GITHUB_SHA; required in release; must be a full object id', async () => {
  const prev = process.env.GITHUB_SHA;
  try {
    delete process.env.GITHUB_SHA;
    const out = outDirWith();
    const noCommit = await l12.run({ ...ctxOf(out), opts: {} });
    assert.equal(noCommit.status, 'warn');
    assert.equal(report(out).commit, null);
    const rel = outDirWith();
    writeFileSync(join(rel, 'plan.json'), JSON.stringify({ release: true, changed: [], gates: {} }));
    const r = await l12.run({ ...ctxOf(rel, {}, true), opts: {} });
    assert.equal(r.status, 'fail');
    assert.ok(r.findings.some((f) => /commit SHA missing/.test(f.message)));
    process.env.GITHUB_SHA = 'b'.repeat(40);
    const fromEnv = outDirWith();
    await l12.run({ ...ctxOf(fromEnv), opts: {} });
    assert.equal(report(fromEnv).commit, 'b'.repeat(40));
    const bad = outDirWith();
    assert.equal((await l12.run(ctxOf(bad, { commit: 'HEAD' }))).status, 'fail');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = prev;
  }
});

test('evidence listed by a gate but absent on disk fails', async () => {
  const out = outDirWith({ L3: result('L3', 'pass', { evidence: ['gitleaks.json'] }) });
  const r = await l12.run(ctxOf(out));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => /gitleaks\.json/.test(f.message)));
});

test('L11 without approvals.json evidence fails (approvers cannot be recorded)', async () => {
  const out = outDirWith({ L11: result('L11', 'pass') });
  const r = await l12.run(ctxOf(out));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => /approvals\.json/.test(f.message)));
});

test('L12 is never skippable: --skip-reason is ignored', async () => {
  const out = outDirWith();
  const r = await l12.run(ctxOf(out, { 'skip-reason': 'nothing to attest' }));
  assert.notEqual(r.status, 'skip');
  assert.ok(existsSync(join(out, 'legal-audit-report.json')));
  assert.ok(r.findings.some((f) => /never skipped/.test(f.message)));
});

