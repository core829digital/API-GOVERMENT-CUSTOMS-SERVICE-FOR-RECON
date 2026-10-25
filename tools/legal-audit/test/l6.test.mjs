import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as l6 from '../gates/l6.mjs';
import { parseLibtest } from '../lib/proc.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fx = (n) => join(here, 'fixtures', 'l6', n);
const mkctx = (opts = {}, release = false) => ({
  root: resolve(here, '..', '..', '..'),
  now: new Date('2026-10-23T00:00:00Z'),
  release,
  outDir: mkdtempSync(join(tmpdir(), 'l6-')),
  opts,
  log: () => {},
});

test('L6 passes when all five required tests are present and ok', async () => {
  const ctx = mkctx({ transcript: fx('all-ok.txt') });
  const r = await l6.run(ctx);
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  assert.equal(r.metrics.required_ok, 5);
  assert.deepEqual(r.evidence, ['L6-tests.json', 'L6-libtest.txt']);
  assert.ok(existsSync(join(ctx.outDir, 'L6-libtest.txt')));
  assert.match(Object.keys(r.inputs)[0], /fixtures\/l6\/all-ok\.txt$/);
  assert.match(Object.values(r.inputs)[0], /^[0-9a-f]{64}$/);
});

test('L6 fails on a FAILED required test and names it', async () => {
  const r = await l6.run(mkctx({ transcript: fx('failed.txt') }));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => f.subject === 'legal_hold_blocks_purge' && /FAILED/.test(f.message)));
  assert.equal(r.metrics.required_ok, 4);
});

test('L6 fails on an ignored required test', async () => {
  const r = await l6.run(mkctx({ transcript: fx('ignored.txt') }));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => f.subject === 'purge_appends_ledger_event' && /ignored/.test(f.message)));
});

test('L6 fails on an absent required test', async () => {
  const r = await l6.run(mkctx({ transcript: fx('missing.txt') }));
  assert.equal(r.status, 'fail');
  assert.ok(r.findings.some((f) => f.subject === 'erasure_deferral_is_ledgered' && /absent/.test(f.message)));
});

test('L6 fails on an unreadable or option-less transcript', async () => {
  assert.equal((await l6.run(mkctx({ transcript: fx('nope.txt') }))).status, 'fail');
  assert.equal((await l6.run(mkctx({ transcript: true }))).status, 'fail');
});

test('L6 --skip-reason skips outside release builds and is ignored in release builds', async () => {
  const s = await l6.run(mkctx({ 'skip-reason': 'docs-only change' }));
  assert.equal(s.status, 'skip');
  assert.equal(s.skip_reason, 'docs-only change');
  // release: the option is ignored and the gate runs (here: transcripts are refused in release, proving it ran)
  const r = await l6.run(mkctx({ 'skip-reason': 'docs-only change', transcript: fx('all-ok.txt') }, true));
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /not accepted for release/);
  assert.equal((await l6.run(mkctx({ 'skip-reason': true }))).status, 'fail');
});

test('L6 fails when cargo cannot be executed', async () => {
  const r = await l6.run(mkctx({ cargo: join(tmpdir(), 'definitely-not-cargo.exe') }));
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /cannot execute/);
});

// Live path: node is the "cargo"; a --import preload answers `node test ...` with a recorded transcript, so the real
// spawn/exit-code/argument handling of the gate is exercised without compiling anything.
function withShim(transcriptFile, exitCode, fn) {
  const shim = join(mkdtempSync(join(tmpdir(), 'l6-shim-')), 'shim.mjs');
  writeFileSync(
    shim,
    `import { readFileSync } from 'node:fs';
if (/[\\\\/]test$/.test(process.argv[1] ?? '')) {
  process.stdout.write('ARGS ' + process.argv.slice(1).join(' ') + '\\n' + readFileSync(${JSON.stringify(transcriptFile)}, 'utf8'));
  process.exit(${exitCode});
}
`,
  );
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import ${new URL(`file:///${shim.replace(/\\/g, '/')}`).href}`;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prev;
  });
}

test('L6 live run: passes on exit 0 with all tests ok and forwards --test-args', async () => {
  await withShim(fx('all-ok.txt'), 0, async () => {
    const ctx = mkctx({ cargo: process.execPath, 'test-args': '-- --test-threads=1' });
    const r = await l6.run(ctx);
    assert.equal(r.status, 'pass', JSON.stringify(r.findings));
    assert.match(r.tools.cargo, /^v\d+/);
    const raw = readFileSync(join(ctx.outDir, 'L6-libtest.txt'), 'utf8');
    assert.match(raw, /ARGS .*[\\/]test -p recon-store --test privacy -- --test-threads=1/);
  });
});

test('L6 live run: non-zero exit fails even if the required tests print ok', async () => {
  await withShim(fx('all-ok.txt'), 101, async () => {
    const r = await l6.run(mkctx({ cargo: process.execPath }));
    assert.equal(r.status, 'fail');
    assert.ok(r.findings.some((f) => /exited with code 101/.test(f.message)));
  });
});

test('L6 live run: FAILED transcript with exit 101 fails with the test named', async () => {
  await withShim(fx('failed.txt'), 101, async () => {
    const r = await l6.run(mkctx({ cargo: process.execPath }));
    assert.equal(r.status, 'fail');
    assert.ok(r.findings.some((f) => f.subject === 'legal_hold_blocks_purge'));
  });
});

test('parseLibtest handles ok / FAILED / ignored with reason and summaries', () => {
  const p = parseLibtest(
    ['     Running tests/privacy.rs (target/debug/deps/privacy-1.exe)', 'test a ... ok', 'test b ... FAILED', 'test c::d ... ignored, needs db', 'test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.1s'].join('\r\n'),
  );
  assert.deepEqual(p.tests.map((t) => [t.name, t.status]), [['a', 'ok'], ['b', 'FAILED'], ['c::d', 'ignored']]);
  assert.equal(p.tests[0].binary, 'tests/privacy.rs');
  assert.deepEqual(p.summaries, [{ ok: false, passed: 1, failed: 1, ignored: 1, binary: 'tests/privacy.rs' }]);
});
