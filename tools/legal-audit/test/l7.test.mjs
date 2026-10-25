import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as l7 from '../gates/l7.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fx = (n) => join(here, 'fixtures', 'l7', n);
const mkctx = (opts = {}, release = false) => ({
  root: resolve(here, '..', '..', '..'),
  now: new Date('2026-10-23T00:00:00Z'),
  release,
  outDir: mkdtempSync(join(tmpdir(), 'l7-')),
  opts,
  log: () => {},
});

test('L7 passes when all eight required tests (both crates) are present and ok', async () => {
  const r = await l7.run(mkctx({ transcript: fx('all-ok.txt') }));
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  assert.equal(r.metrics.required_tests, 8);
  assert.equal(r.metrics.required_ok, 8);
});

test('L7 matches module-qualified unit test names (real recon-evidence output uses tests::<name>)', async () => {
  const raw = readFileSync(fx('all-ok.txt'), 'utf8');
  assert.match(raw, /^test tests::detects_field_tamper_prev_break_gap_and_cross_tenant \.\.\. ok$/m);
  const r = await l7.run(mkctx({ transcript: fx('all-ok.txt') }));
  assert.equal(r.status, 'pass');
});

test('L7 fails on a FAILED test in recon-store and reports libtest failure', async () => {
  const r = await l7.run(mkctx({ transcript: fx('failed.txt') }));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => f.subject === 'concurrent_appends_for_one_tenant_serialise_into_a_valid_chain' && /FAILED/.test(f.message)));
  assert.equal(r.metrics.required_ok, 7);
});

test('L7 fails on an ignored anchor test', async () => {
  const r = await l7.run(mkctx({ transcript: fx('ignored.txt') }));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => f.subject === 'anchor_rejects_wrong_hash' && /ignored/.test(f.message)));
});

test('L7 fails when an anchor test is missing', async () => {
  const r = await l7.run(mkctx({ transcript: fx('missing.txt') }));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => f.subject === 'anchor_rejects_tampered_token' && /absent/.test(f.message)));
});

test('L7 fails on output without any libtest lines (e.g. compile error)', async () => {
  const r = await l7.run(mkctx({ transcript: fx('no-tests.txt') }));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => /no libtest/.test(f.message)));
  assert.equal(r.metrics.required_ok, 0);
});

test('L7 skip-reason and release behaviour', async () => {
  assert.equal((await l7.run(mkctx({ 'skip-reason': 'no code change' }))).status, 'skip');
  const r = await l7.run(mkctx({ 'skip-reason': 'no code change', transcript: fx('all-ok.txt') }, true));
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /release/);
});

// live path with node as "cargo" (see l6.test.mjs): two invocations, each with its own required tests
test('L7 runs both cargo invocations with the contract arguments', async () => {
  const shim = join(mkdtempSync(join(tmpdir(), 'l7-shim-')), 'shim.mjs');
  writeFileSync(
    shim,
    `import { readFileSync } from 'node:fs';
if (/[\\\\/]test$/.test(process.argv[1] ?? '')) {
  const all = readFileSync(${JSON.stringify(fx('all-ok.txt'))}, 'utf8');
  process.stdout.write(all);
  process.exit(0);
}
`,
  );
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import ${new URL(`file:///${shim.replace(/\\/g, '/')}`).href}`;
  try {
    const ctx = mkctx({ cargo: process.execPath });
    const r = await l7.run(ctx);
    assert.equal(r.status, 'pass', JSON.stringify(r.findings));
    const rep = JSON.parse(readFileSync(join(ctx.outDir, 'L7-tests.json'), 'utf8'));
    assert.deepEqual(rep.groups.map((g) => g.command.slice(1).join(' ').replace(/^.*?test /, 'test ')), ['test -p recon-store --test pair', 'test -p recon-evidence']);
  } finally {
    if (prev === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prev;
  }
});
