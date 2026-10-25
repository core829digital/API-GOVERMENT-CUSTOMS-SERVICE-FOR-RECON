import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as l5 from '../gates/l5.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const FX = join(here, 'fixtures', 'l5');
const NOW = new Date('2026-10-23T00:00:00Z');

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'l5-'));
  cpSync(join(FX, 'root'), join(base, 'root'), { recursive: true });
  cpSync(join(FX, 'out'), join(base, 'out'), { recursive: true });
  return { root: join(base, 'root'), outDir: join(base, 'out') };
}
const run = (s, { release = false, opts = {}, now = NOW } = {}) => l5.run({ root: s.root, outDir: s.outDir, now, release, opts, log: () => {} });
const edit = (s, rel, fn) => {
  const p = join(s.root, rel);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
};
const errors = (r) => r.findings.filter((f) => f.severity === 'error');
const has = (r, re, sev = 'error') => r.findings.some((f) => f.severity === sev && re.test(`${f.subject ?? ''} ${f.message}`));

test('fixture set is consistent: passes (ROPA equals L4 rows, listed sub-processors cover annotations)', async () => {
  const s = setup();
  const r = await run(s);
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  assert.equal(r.metrics.documents_present, 4);
  assert.equal(r.metrics.annotations, 2, 'the rego reference and the workflow comment are not annotations');
  const doc = JSON.parse(readFileSync(join(s.outDir, 'privacy-docs.json'), 'utf8'));
  assert.deepEqual(doc.docs.map((d) => d.doc), ['DPIA', 'ROPA', 'TIA', 'SUBPROCESSORS']);
  assert.ok(r.inputs['docs/privacy/ROPA.md'] && r.inputs['classification.json'] && r.inputs['L4.json']);
});

test('missing document is an error', async () => {
  const s = setup();
  rmSync(join(s.root, 'docs/privacy/TIA.md'));
  const r = await run(s);
  assert.equal(r.status, 'fail');
  assert.ok(has(r, /TIA\.md.*missing/));
});

test('next_review boundary: today is fine, yesterday fails', async () => {
  const s = setup();
  edit(s, 'docs/privacy/DPIA.md', (t) => t.replace('next_review: 2027-04-01', 'next_review: 2026-10-23'));
  assert.equal((await run(s)).status, 'pass');
  edit(s, 'docs/privacy/DPIA.md', (t) => t.replace('next_review: 2026-10-23', 'next_review: 2026-10-22'));
  const r = await run(s);
  assert.equal(r.status, 'fail');
  assert.ok(has(r, /DPIA\.md.*next_review 2026-10-22 has passed/));
});

test('draft / UNREVIEWED: warning normally, error in release builds', async () => {
  const s = setup();
  edit(s, 'docs/privacy/TIA.md', (t) => t.replace('status: reviewed', 'status: draft').replace('reviewed_at: 2026-10-01', 'reviewed_at:').replace('"Example DPO (fixture)"', 'UNREVIEWED'));
  const r = await run(s);
  assert.equal(r.status, 'warn');
  assert.ok(has(r, /TIA\.md.*not human-reviewed/, 'warning'));
  const rel = await run(s, { release: true });
  assert.equal(rel.status, 'fail');
  edit(s, 'docs/privacy/TIA.md', (t) => t.replace('status: draft', 'status: reviewed').replace('reviewed_at:', 'reviewed_at: 2026-10-01'));
  assert.equal((await run(s)).status, 'warn', 'reviewed but reviewer UNREVIEWED still warns');
});

test('front matter validation: missing key, extra key, bad dates, no front matter', async () => {
  const s = setup();
  edit(s, 'docs/privacy/DPIA.md', (t) => t.replace('reviewer: "Example DPO (fixture)"\n', ''));
  assert.ok(has(await run(s), /DPIA\.md.*"reviewer" is missing/));
  const s2 = setup();
  edit(s2, 'docs/privacy/DPIA.md', (t) => t.replace('next_review:', 'owner: me\nnext_review:'));
  assert.ok(has(await run(s2), /unexpected front matter key "owner"/));
  const s3 = setup();
  edit(s3, 'docs/privacy/DPIA.md', (t) => t.replace('next_review: 2027-04-01', 'next_review: 2027-13-45'));
  assert.ok(has(await run(s3), /next_review must be YYYY-MM-DD/));
  const s4 = setup();
  edit(s4, 'docs/privacy/DPIA.md', (t) => t.replace('reviewed_at: 2026-10-01', 'reviewed_at: 2026-11-01'));
  assert.ok(has(await run(s4), /reviewed_at 2026-11-01 is in the future/));
  const s5 = setup();
  edit(s5, 'docs/privacy/DPIA.md', (t) => t.replace(/^---[\s\S]*?---\n/, ''));
  assert.ok(has(await run(s5), /does not start with a `---`/));
  const s6 = setup();
  edit(s6, 'docs/privacy/DPIA.md', (t) => t.replace('status: reviewed', 'status: approved'));
  assert.ok(has(await run(s6), /status must be "draft" or "reviewed"/));
});

test('CRLF files parse', async () => {
  const s = setup();
  edit(s, 'docs/privacy/DPIA.md', (t) => t.replace(/\n/g, '\r\n'));
  assert.equal((await run(s)).status, 'pass');
});

test('ROPA vs L4: missing, stale and changed rows and unsorted blocks fail', async () => {
  const s = setup();
  edit(s, 'docs/privacy/ROPA.md', (t) => t.replace('| core.tenant.name | internal | contract_6_1_b | operational | none |\n', ''));
  let r = await run(s);
  assert.equal(r.status, 'fail');
  assert.ok(has(r, /lacks 1 column\(s\).*core\.tenant\.name/));

  const s2 = setup();
  edit(s2, 'docs/privacy/ROPA.md', (t) => t.replace('<!-- ropa:end -->', '| core.tenant.legacy | internal | gdpr_6_1_c | tax_record | none |\n<!-- ropa:end -->'));
  r = await run(s2);
  assert.ok(has(r, /lists 1 column\(s\) not in the schema.*core\.tenant\.legacy/));

  const s3 = setup();
  edit(s3, 'docs/privacy/ROPA.md', (t) => t.replace('core.legal_entity.vat_id_ct | pii_id | gdpr_6_1_c | tax_record | true', 'core.legal_entity.vat_id_ct | internal | gdpr_6_1_c | tax_record | none'));
  r = await run(s3);
  assert.ok(has(r, /differs from the schema classification for 1 column\(s\).*vat_id_ct/));

  const s4 = setup();
  edit(s4, 'docs/privacy/ROPA.md', (t) =>
    t.replace('| core.tenant.id | internal | gdpr_6_1_c | tax_record | none |\n| core.tenant.name | internal | contract_6_1_b | operational | none |', '| core.tenant.name | internal | contract_6_1_b | operational | none |\n| core.tenant.id | internal | gdpr_6_1_c | tax_record | none |'),
  );
  assert.ok(has(await run(s4), /not sorted by column/));

  const s5 = setup();
  edit(s5, 'docs/privacy/ROPA.md', (t) => t.replace(/<!-- ropa:begin -->[\s\S]*<!-- ropa:end -->/, 'no block here'));
  assert.ok(has(await run(s5), /no machine-managed block/));

  const s6 = setup();
  edit(s6, 'docs/privacy/ROPA.md', (t) => t.replace('| core.tenant.id | internal | gdpr_6_1_c | tax_record |', '| core.tenant.id | internal | gdpr_6_1_c |'));
  assert.ok(has(await run(s6), /invalid ROPA block line/));
});

test('L4 evidence: absent => "run L4 first"; skipped => info only; failed-before-read => error', async () => {
  const s = setup();
  rmSync(join(s.outDir, 'L4.json'));
  let r = await run(s);
  assert.equal(r.status, 'fail');
  assert.ok(has(r, /run L4 first/));

  const s2 = setup();
  rmSync(join(s2.outDir, 'classification.json'));
  assert.ok(has(await run(s2), /run L4 first/));

  const s3 = setup();
  writeFileSync(join(s3.outDir, 'L4.json'), JSON.stringify({ gate: 'L4', status: 'skip', skip_reason: 'no migrations changed', findings: [], evidence: [], inputs: {} }));
  rmSync(join(s3.outDir, 'classification.json'));
  r = await run(s3);
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  assert.ok(has(r, /not re-verified: L4 was skipped/, 'info'));

  const s4 = setup();
  writeFileSync(join(s4.outDir, 'classification.json'), JSON.stringify({ columns_inspected: 0, rows: [] }));
  assert.ok(has(await run(s4), /inspected no columns/));
});

test('sub-processor annotation missing from SUBPROCESSORS.md fails', async () => {
  const s = setup();
  mkdirSync(join(s.root, 'infra/terraform'), { recursive: true });
  writeFileSync(join(s.root, 'infra/terraform/tags.tf'), 'locals {\n  tags = {\n    "recon.core829.eu/subprocessor" = "Unlisted Analytics SAS"\n  }\n}\n');
  const r = await run(s);
  assert.equal(r.status, 'fail');
  assert.ok(has(r, /"Unlisted Analytics SAS".*infra\/terraform\/tags\.tf:3.*not listed/));
});

test('sub-processor with non-EU region fails; name match ignores case and spacing', async () => {
  const s = setup();
  edit(s, 'infra/k8s/kms.yaml', (t) => t.replace('Example KMS Ltd', 'EXAMPLE   mail inc'));
  const r = await run(s);
  assert.equal(r.status, 'fail');
  assert.ok(has(r, /EXAMPLE\s+mail inc.*us-east-1.*not an EU\/EEA/));
});

test('sub-processor annotation in .github (workflow, not markdown) is scanned; empty annotation is an error', async () => {
  const s = setup();
  edit(s, '.github/workflows/ci.yml', (t) => `${t}# end\n`.replace('jobs:', 'x-meta:\n  recon.core829.eu/subprocessor: Example Hosting EU GmbH\njobs:'));
  assert.equal((await run(s)).status, 'pass');
  edit(s, '.github/workflows/ci.yml', (t) => t.replace('subprocessor: Example Hosting EU GmbH', 'subprocessor:'));
  const r = await run(s);
  assert.ok(has(r, /empty recon\.core829\.eu\/subprocessor annotation at line \d+/));
});

test('SUBPROCESSORS.md without the table header is an error when annotations exist', async () => {
  const s = setup();
  edit(s, 'docs/privacy/SUBPROCESSORS.md', (t) => t.replace('| name | purpose | region | dpa_ref |', '| name | purpose | where | dpa |'));
  const r = await run(s);
  assert.ok(has(r, /no table with the header/));
  assert.ok(has(r, /not listed/));
});

test('isEuEeaRegion', () => {
  for (const ok of ['eu', 'EU', 'eea', 'DE', 'eu-central-1', 'de-frankfurt', 'Germany', 'Czech Republic', 'Ireland', 'eu-central-1 (Frankfurt, DE)', 'de, fr', 'Germany / Netherlands', 'ie']) {
    assert.ok(l5.isEuEeaRegion(ok), ok);
  }
  for (const bad of ['us-east-1', 'US', 'United States', 'uk', 'London', 'global', '', ' ', 'de, us', 'eu, global', 'denmarkistan', 'Singapore', 'ap-southeast-1']) {
    assert.ok(!l5.isEuEeaRegion(bad), bad);
  }
});

test('--skip-reason skips outside release only', async () => {
  const s = setup();
  assert.equal((await run(s, { opts: { 'skip-reason': 'x' } })).status, 'skip');
  assert.notEqual((await run(s, { release: true, opts: { 'skip-reason': 'x' } })).status, 'skip');
});

// ---- Helm templated annotations (the shape infra/helm/recon/templates/frontend.yaml uses)
function addChart(s, { values, templateValue = '{{ .Values.oidc.subprocessor | quote }}' }) {
  const dir = join(s.root, 'infra/helm/chart');
  mkdirSync(join(dir, 'templates'), { recursive: true });
  writeFileSync(join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: chart\nversion: 0.1.0\n');
  writeFileSync(join(dir, 'values.yaml'), values);
  writeFileSync(
    join(dir, 'templates/deploy.yaml'),
    `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n  {{- if .Values.oidc.subprocessor }}\n  annotations:\n    recon.core829.eu/subprocessor: ${templateValue}\n  {{- end }}\n`,
  );
}

test('Helm template annotation with an empty default is reported as value-driven (info), not an error', async () => {
  const s = setup();
  addChart(s, { values: 'oidc:\n  subprocessor: ""\n' });
  const r = await run(s);
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  assert.ok(has(r, /value-driven.*empty in the chart's default values/, 'info'));
});

test('Helm template annotation resolved from values.yaml is checked against SUBPROCESSORS.md', async () => {
  const s = setup();
  addChart(s, { values: 'oidc:\n  subprocessor: Example Mail Inc\n' });
  let r = await run(s);
  assert.equal(r.status, 'fail');
  assert.ok(has(r, /Example Mail Inc.*us-east-1/));
  const s2 = setup();
  addChart(s2, { values: 'oidc:\n  subprocessor: Example KMS Ltd\n' });
  assert.equal((await run(s2)).status, 'pass');
  const s3 = setup();
  addChart(s3, { values: 'oidc:\n  subprocessor: Not Listed AB\n' });
  assert.ok(has(await run(s3), /"Not Listed AB".*not listed/));
});

test('Helm template with an expression that cannot be resolved statically warns', async () => {
  const s = setup();
  addChart(s, { values: 'oidc:\n  subprocessor: ""\n', templateValue: '{{ include "x.processor" . }}' });
  const r = await run(s);
  assert.equal(r.status, 'warn');
  assert.ok(has(r, /cannot be resolved statically/, 'warning'));
});

test('yamlScalarAt reads dotted paths by indentation and tolerates flow mappings elsewhere', () => {
  const text = 'image: {repo: x, tag: y}\noidc:\n  # comment\n  issuer: "https://idp"\n  subprocessor: "Example KMS Ltd"   # trailing\n  subprocessorRegion: eu-central-1\nother:\n  subprocessor: nope\n';
  assert.equal(l5.yamlScalarAt(text, ['oidc', 'subprocessor']), 'Example KMS Ltd');
  assert.equal(l5.yamlScalarAt(text, ['oidc', 'subprocessorRegion']), 'eu-central-1');
  assert.equal(l5.yamlScalarAt(text, ['other', 'subprocessor']), 'nope');
  assert.equal(l5.yamlScalarAt(text, ['oidc', 'missing']), undefined);
  assert.equal(l5.yamlScalarAt('oidc:\n  subprocessor: ""\n', ['oidc', 'subprocessor']), '');
});
