import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as l11 from '../gates/l11.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fx = (n) => join(here, 'fixtures', 'l11', n);
const HEAD = '2222222222222222222222222222222222222222';
const OLD = '1111111111111111111111111111111111111111';

const review = (login, state, { type = 'User', commit = HEAD, at = '2026-10-22T11:30:00Z' } = {}) => ({
  id: Math.floor(Math.random() * 1e6),
  user: { login, id: 7, type },
  state,
  commit_id: commit,
  submitted_at: at,
  body: '',
});

/** A temp dir holding CODEOWNERS (fixture), team-members (fixture), a changed list and the given reviews. */
function setup({ changed = 'changed-gated.txt', reviews = null, members = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'l11-'));
  copyFileSync(fx('CODEOWNERS'), join(dir, 'CODEOWNERS'));
  copyFileSync(fx(changed), join(dir, 'changed.txt'));
  writeFileSync(join(dir, 'team-members.json'), members ? JSON.stringify(members) : readFileSync(fx('team-members.json')));
  if (reviews) writeFileSync(join(dir, 'reviews.json'), JSON.stringify(reviews));
  const opts = {
    codeowners: 'CODEOWNERS',
    'changed-file': 'changed.txt',
    reviews: 'reviews.json',
    'team-members': 'team-members.json',
    'head-sha': HEAD,
  };
  return { dir, opts };
}
const ctxOf = (s, extra = {}, release = false) => ({ root: s.dir, now: new Date('2026-10-23T00:00:00Z'), release, outDir: join(s.dir, 'out'), opts: { ...s.opts, ...extra }, log: () => {} });

test('CODEOWNERS patterns: anchored directories match everything below, last match wins', () => {
  const rules = l11.parseCodeowners(readFileSync(fx('CODEOWNERS'), 'utf8'));
  const owners = (p) => l11.ownersOf(rules, p)?.owners.join(' ');
  assert.equal(owners('rules/EU/vat-invoice-core.yaml'), '@core829srl/compliance @core829srl/engineering');
  assert.equal(owners('migrations/w/0001_init.sql'), '@core829srl/compliance @core829srl/engineering');
  assert.equal(owners('crates/recon-evidence/src/lib.rs'), '@core829srl/compliance @core829srl/engineering');
  assert.equal(owners('crates/recon-evidence-extra/src/lib.rs'), '@core829srl/engineering', 'prefix of a directory name is not a match');
  assert.equal(owners('crates/recon-store/src/lib.rs'), '@core829srl/engineering');
  assert.equal(owners('docs/rules/readme.md'), '@core829srl/engineering', '/rules/ is anchored at the root');
  assert.equal(owners('infra/policies/residency.rego'), '@core829srl/compliance @core829srl/engineering');
  assert.equal(owners('infra/helm/values.yaml'), '@core829srl/engineering');
});

test('CODEOWNERS pattern forms', () => {
  const m = (pat, path) => l11.compilePattern(pat).test(path);
  assert.ok(m('*.md', 'a/b/c.md'));
  assert.ok(!m('*.md', 'a/b/c.mdx'));
  assert.ok(m('/docs/privacy', 'docs/privacy/ROPA.md'), 'no trailing slash: directory contents match');
  assert.ok(m('/docs/privacy', 'docs/privacy'));
  assert.ok(!m('/docs/privacy/', 'docs/privacy'), 'directory-only pattern does not match a file with that name');
  assert.ok(m('docs/**/*.md', 'docs/a/b/x.md'));
  assert.ok(m('docs/**/*.md', 'docs/x.md'));
  assert.ok(m('/a/?.txt', 'a/b.txt'));
  assert.ok(!m('/a/?.txt', 'a/bc.txt'));
  assert.ok(m('build', 'x/y/build/out.o'), 'unanchored name matches at any depth');
  const rules = l11.parseCodeowners('# c\n\n/a/ @x/one\n/a/b/ @x/two   # trailing comment\n/a/b/keep.txt\n');
  assert.deepEqual(l11.ownersOf(rules, 'a/b/f').owners, ['@x/two']);
  assert.deepEqual(l11.ownersOf(rules, 'a/b/keep.txt').owners, [], 'a pattern with no owners unowns the file');
  assert.equal(l11.ownersOf(rules, 'z'), null);
});

test('no gated file changed: passes without any review inputs', async () => {
  const s = setup({ changed: 'changed-plain.txt' });
  const r = await l11.run(ctxOf(s, { reviews: undefined, 'team-members': undefined, 'head-sha': undefined }));
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  assert.equal(r.metrics.gated, 0);
});

test('gated file with a valid human approval from a compliance member passes and lists the approver', async () => {
  const s = setup({ reviews: JSON.parse(readFileSync(fx('reviews-approved.json'), 'utf8')) });
  const r = await l11.run(ctxOf(s));
  assert.equal(r.status, 'pass', JSON.stringify(r.findings));
  const ap = JSON.parse(readFileSync(join(s.dir, 'out', 'approvals.json'), 'utf8'));
  assert.deepEqual(ap.gated.map((g) => [g.file, g.approved_by]), [['migrations/w/0007_example.sql', ['alice-compliance']]]);
  assert.deepEqual(ap.approvers.map((a) => [a.login, a.teams]), [['alice-compliance', ['core829srl/compliance']]]);
  assert.equal(ap.ignored_reviews.length, 1, 'the stale engineering approval by bob-dev is recorded as ignored');
  assert.equal(ap.ignored_reviews[0].login, 'bob-dev');
  assert.equal(Object.keys(r.inputs).length, 4);
});

test('no approvals at all => error naming the gated file', async () => {
  const r = await l11.run(ctxOf(setup({ reviews: [] })));
  assert.equal(r.status, 'fail');
  assert.equal(r.findings.filter((f) => f.severity === 'error')[0].subject, 'migrations/w/0007_example.sql');
});

test('approval of an older commit (stale after a later push) does not count', async () => {
  const r = await l11.run(ctxOf(setup({ reviews: [review('alice-compliance', 'APPROVED', { commit: OLD })] })));
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /stale/);
});

test('approval by a Bot account does not count', async () => {
  const s = setup({ reviews: [review('alice-compliance', 'APPROVED', { type: 'Bot' })] });
  const r = await l11.run(ctxOf(s));
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /not a human User/);
});

test('approval by an engineering-only member does not satisfy a compliance-gated path', async () => {
  const r = await l11.run(ctxOf(setup({ reviews: [review('bob-dev', 'APPROVED')] })));
  assert.equal(r.status, 'fail');
});

test('COMMENTED reviews are not approvals; a later CHANGES_REQUESTED revokes an earlier approval', async () => {
  assert.equal((await l11.run(ctxOf(setup({ reviews: [review('alice-compliance', 'COMMENTED')] })))).status, 'fail');
  const r = await l11.run(
    ctxOf(setup({ reviews: [review('alice-compliance', 'APPROVED', { at: '2026-10-22T10:00:00Z' }), review('alice-compliance', 'CHANGES_REQUESTED', { at: '2026-10-22T12:00:00Z' })] })),
  );
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /CHANGES_REQUESTED/);
  const ok = await l11.run(
    ctxOf(setup({ reviews: [review('alice-compliance', 'CHANGES_REQUESTED', { at: '2026-10-22T10:00:00Z' }), review('alice-compliance', 'APPROVED', { at: '2026-10-22T12:00:00Z' })] })),
  );
  assert.equal(ok.status, 'pass');
});

test('team-members may be keyed by the bare slug and logins compare case-insensitively', async () => {
  const s = setup({ reviews: [review('carol-dpo', 'APPROVED')], members: { compliance: ['Carol-DPO'] } });
  assert.equal((await l11.run(ctxOf(s))).status, 'pass');
});

test('gated change without review inputs fails with a clear error', async () => {
  const s = setup();
  const r = await l11.run(ctxOf(s, { reviews: undefined }));
  assert.equal(r.status, 'fail');
  assert.match(r.findings.at(-1).message, /--reviews, --team-members and --head-sha/);
});

test('malformed review JSON fails', async () => {
  const s = setup({ reviews: { message: 'Not Found' } });
  const r = await l11.run(ctxOf(s));
  assert.equal(r.status, 'fail');
  assert.match(r.summary, /JSON array/);
});

test('empty changed-file list: pass outside release, error in release', async () => {
  const s = setup();
  writeFileSync(join(s.dir, 'changed.txt'), '\n');
  assert.equal((await l11.run(ctxOf(s))).status, 'pass');
  const r = await l11.run(ctxOf(s, {}, true));
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /empty changed-file list/);
});

test('missing --changed-file or CODEOWNERS fails; --skip-reason skips only outside release', async () => {
  const s = setup();
  assert.equal((await l11.run(ctxOf(s, { 'changed-file': undefined }))).status, 'fail');
  assert.equal((await l11.run(ctxOf(s, { codeowners: 'nope' }))).status, 'fail');
  assert.equal((await l11.run(ctxOf(s, { 'skip-reason': 'x' }))).status, 'skip');
  assert.notEqual((await l11.run(ctxOf(s, { 'skip-reason': 'x', reviews: undefined }, true))).status, 'skip');
});
