import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as l4 from '../gates/l4.mjs';
import * as l5 from '../gates/l5.mjs';
import { writeJson } from '../lib/result.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(here, '..', '..', '..');
const NOW = new Date('2026-10-23T00:00:00Z');

// ---------------------------------------------------------------------------------------------------------------
// pure checks (no database)

const col = (schema, table, column, comment, extra = {}) => ({
  schema, table, column, comment, type_text: 'text', base_type: 'text', identity: '', default_expr: null, rls: true, ...extra,
});
const C = (cls, enc = 'none', ret = 'tax_record', basis = 'gdpr_6_1_c') => `class=${cls};basis=${basis};retention=${ret};encrypted=${enc}`;
const errs = (a) => a.findings.filter((f) => f.severity === 'error');

test('parseClassification accepts the grammar in use and rejects unknown keys/values/malformed input', () => {
  const ok = l4.parseClassification('class=pii_id;basis=gdpr_6_1_c;retention=tax_record;encrypted=true');
  assert.deepEqual(ok.value, { class: 'pii_id', basis: 'gdpr_6_1_c', retention: 'tax_record', encrypted: 'true' });
  assert.ok(l4.parseClassification('encrypted=none;retention=rule_data;basis=none;class=public').value, 'order is free');
  const bad = (c) => l4.parseClassification(c).problems.join(' | ');
  assert.match(bad('class=public;basis=none;retention=tax_record'), /missing key "encrypted"/);
  assert.match(bad('class=secretish;basis=none;retention=tax_record;encrypted=none'), /unknown class "secretish"/);
  assert.match(bad('class=public;basis=none;retention=tax_record;encrypted=none;owner=x'), /unknown key "owner"/);
  assert.match(bad('class=public;class=internal;basis=none;retention=tax_record;encrypted=none'), /duplicate key "class"/);
  assert.match(bad('class=public;basis=whatever;retention=tax_record;encrypted=none'), /unknown basis/);
  assert.match(bad('class=public;basis=none;retention=tax_record;encrypted=maybe'), /unknown encrypted value/);
  assert.match(bad('class = public;basis=none;retention=tax_record;encrypted=none'), /malformed element/);
  assert.match(bad('free text'), /malformed element/);
});

test('every class and the documented basis values are accepted', () => {
  for (const c of l4.CLASSES) assert.ok(l4.parseClassification(C(c === 'pii' || c === 'pii_id' ? c : c, 'true')).value, c);
  for (const b of ['none', 'gdpr_6_1_a', 'gdpr_6_1_f', 'contract_6_1_b']) assert.ok(l4.parseClassification(C('internal', 'none', 'ledger', b)).value, b);
});

test('unclassified column, unknown retention, float money, sequence and identity defaults, missing RLS', () => {
  const a = l4.analyseColumns([
    col('core', 'tenant', 'id', C('internal')),
    col('core', 'tenant', 'note', null),
    col('core', 'tenant', 'blank', '  '),
    col('recon', 'finding', 'x', C('internal', 'none', 'forever')),
    col('recon', 'finding', 'amount_total', C('financial'), { type_text: 'double precision', base_type: 'float8' }),
    col('recon', 'finding', 'price_minor', C('financial'), { type_text: 'numeric(12,2)', base_type: 'numeric' }),
    col('recon', 'finding', 'amount_minor', C('financial'), { type_text: 'bigint', base_type: 'int8' }),
    col('recon', 'finding', 'ratio', C('financial'), { type_text: 'real', base_type: 'float4' }),
    col('ops', 'seq', 'id', C('internal'), { type_text: 'bigint', base_type: 'int8', default_expr: "nextval('ops.seq_id_seq'::regclass)" }),
    col('ops', 'ident', 'id', C('internal'), { type_text: 'bigint', base_type: 'int8', identity: 'a' }),
    col('ops', 'norls', 'tenant_id', C('internal'), { rls: false }),
    col('ops', 'withrls', 'tenant_id', C('internal'), { rls: true }),
  ], [], {});
  const by = (s) => errs(a).filter((f) => f.subject === s).map((f) => f.message).join(' | ');
  assert.match(by('core.tenant.note'), /unclassified column/);
  assert.match(by('core.tenant.blank'), /unclassified column/);
  assert.match(by('recon.finding.x'), /retention "forever" is not a known data class/);
  assert.match(by('recon.finding.amount_total'), /R-DB-2/);
  assert.match(by('recon.finding.price_minor'), /R-DB-2/);
  assert.equal(by('recon.finding.amount_minor'), '', 'bigint minor units are fine');
  assert.equal(by('recon.finding.ratio'), '', 'float in a non-money column is not flagged');
  assert.match(by('ops.seq.id'), /sequence default.*R-DB-3/);
  assert.match(by('ops.ident.id'), /identity column.*R-DB-3/);
  assert.match(by('ops.norls'), /row level security/);
  assert.equal(by('ops.withrls'), '');
  assert.deepEqual(a.unclassified, ['core.tenant.note', 'core.tenant.blank']);
  assert.equal(a.rows.length, 10);
});

test('pii / pii_id need encrypted=true; only the two documented exceptions pass, as warnings', () => {
  const real = [
    col('core', 'legal_entity', 'vat_id_ct', C('pii_id', 'true')),
    col('core', 'legal_entity', 'vat_id_hmac', C('pii_id', 'hmac')),
    col('ledger', 'audit_event', 'actor_ref', C('pii', 'pseudonymous', 'ledger')),
  ];
  const a = l4.analyseColumns(real);
  assert.equal(errs(a).length, 0, JSON.stringify(a.findings));
  const warn = a.findings.filter((f) => f.severity === 'warning');
  assert.deepEqual(warn.map((f) => f.subject).sort(), ['core.legal_entity.vat_id_hmac', 'ledger.audit_event.actor_ref']);
  assert.match(warn[0].message, /documented exception applied/);
  assert.deepEqual(a.exceptions.map((e) => [e.column, e.token]), [['core.legal_entity.vat_id_hmac', 'hmac'], ['ledger.audit_event.actor_ref', 'pseudonymous']]);
  const row = a.rows.find((r) => r.column === 'core.legal_entity.vat_id_hmac');
  assert.equal(row.exception.token, 'hmac');
  assert.ok(row.exception.reason.length > 10);
  assert.equal(a.rows.find((r) => r.column === 'core.legal_entity.vat_id_ct').exception, undefined);

  // planted plaintext pii
  const plain = l4.analyseColumns([...real, col('core', 'legal_entity', 'contact_email', C('pii', 'none'))]);
  assert.ok(errs(plain).some((f) => f.subject === 'core.legal_entity.contact_email' && /requires encrypted=true/.test(f.message)));
  // the hmac token on a different column stays an error
  const other = l4.analyseColumns([...real, col('core', 'legal_entity', 'tax_ref_hmac', C('pii_id', 'hmac'))]);
  assert.ok(errs(other).some((f) => f.subject === 'core.legal_entity.tax_ref_hmac'));
  // the right column with the wrong token stays an error and names the covered token
  const wrongTok = l4.analyseColumns([col('core', 'legal_entity', 'vat_id_hmac', C('pii_id', 'none')), col('ledger', 'audit_event', 'actor_ref', C('pii', 'pseudonymous', 'ledger'))]);
  assert.ok(errs(wrongTok).some((f) => f.subject === 'core.legal_entity.vat_id_hmac' && /only covers encrypted=hmac/.test(f.message)));
  // pseudonymous on pii_id of the actor_ref column is a different token => error
  const mismatch = l4.analyseColumns([col('ledger', 'audit_event', 'actor_ref', C('pii', 'hmac', 'ledger')), col('core', 'legal_entity', 'vat_id_hmac', C('pii_id', 'hmac'))]);
  assert.ok(errs(mismatch).some((f) => f.subject === 'ledger.audit_event.actor_ref'));
});

test('stale exceptions are errors: column gone, or no longer pii/pii_id with that token', () => {
  const gone = l4.analyseColumns([col('core', 'legal_entity', 'vat_id_hmac', C('pii_id', 'hmac'))]);
  assert.ok(errs(gone).some((f) => f.subject === 'ledger.audit_event.actor_ref' && /stale documented exception: column no longer exists/.test(f.message)));
  const reclass = l4.analyseColumns([col('core', 'legal_entity', 'vat_id_hmac', C('internal')), col('ledger', 'audit_event', 'actor_ref', C('pii', 'pseudonymous', 'ledger'))]);
  assert.ok(errs(reclass).some((f) => f.subject === 'core.legal_entity.vat_id_hmac' && /stale documented exception/.test(f.message)));
  const encrypted = l4.analyseColumns([col('core', 'legal_entity', 'vat_id_hmac', C('pii_id', 'true')), col('ledger', 'audit_event', 'actor_ref', C('pii', 'pseudonymous', 'ledger'))]);
  assert.ok(errs(encrypted).some((f) => f.subject === 'core.legal_entity.vat_id_hmac' && /stale/.test(f.message)));
});

test('publication: api must not be published, every replicated table must be, nothing else may be', () => {
  const cols = [col('core', 'tenant', 'id', C('internal')), col('ledger', 'audit_event', 'seq', C('internal'))];
  const good = [{ schemaname: 'core', tablename: 'tenant' }, { schemaname: 'ledger', tablename: 'audit_event' }];
  assert.deepEqual(l4.analysePublication(good, cols), []);
  const withApi = l4.analysePublication([...good, { schemaname: 'api', tablename: 'api_key' }], cols);
  assert.ok(withApi.some((f) => f.subject === 'api.api_key' && /must not be in publication/.test(f.message)));
  assert.ok(l4.analysePublication([...good, { schemaname: 'proj', tablename: 'x' }], cols).some((f) => /outside the replicated schemas/.test(f.message)));
  assert.ok(l4.analysePublication(good.slice(0, 1), cols).some((f) => f.subject === 'ledger.audit_event' && /not in publication/.test(f.message)));
});

test('ROPA block render/parse/diff/replace round trip keeps surrounding text and EOL style', () => {
  const rows = [
    { column: 'core.tenant.id', class: 'internal', basis: 'gdpr_6_1_c', retention: 'tax_record', encrypted: 'none' },
    { column: 'core.tenant.name', class: 'internal', basis: 'contract_6_1_b', retention: 'operational', encrypted: 'none' },
  ];
  const doc = `# ROPA\r\n\r\nbefore\r\n\r\n${l4.renderRopaBlock([rows[0]]).split('\n').join('\r\n')}\r\n\r\nafter\r\n`;
  const p = l4.parseRopaBlock(doc);
  assert.equal(p.found, true);
  assert.deepEqual(p.rows, [rows[0]]);
  const d = l4.diffRopa(p.rows, rows);
  assert.deepEqual(d.added.map((r) => r.column), ['core.tenant.name']);
  const next = l4.replaceRopaBlock(doc, rows);
  assert.ok(next.startsWith('# ROPA\r\n\r\nbefore\r\n\r\n') && next.endsWith('\r\n\r\nafter\r\n'));
  assert.ok(!/[^\r]\n/.test(next), 'CRLF preserved');
  assert.deepEqual(l4.parseRopaBlock(next).rows, rows);
  assert.equal(l4.replaceRopaBlock(next, rows), next, 'idempotent');
  assert.throws(() => l4.replaceRopaBlock('no markers', rows), /cannot rewrite ROPA/);
  assert.equal(l4.parseRopaBlock(`${l4.ROPA_END}\n${l4.ROPA_BEGIN}`).found, false);
});

test('--skip-reason / missing options', async () => {
  const ctx = (opts, release = false) => ({ root: REPO, now: NOW, release, outDir: mkdtempSync(join(tmpdir(), 'l4-')), opts, log: () => {} });
  assert.equal((await l4.run(ctx({ 'skip-reason': 'no db change' }))).status, 'skip');
  assert.equal((await l4.run(ctx({}))).status, 'fail');
  const r = await l4.run(ctx({ 'skip-reason': 'x' }, true));
  assert.equal(r.status, 'fail', 'release ignores the skip and then fails on missing options');
  assert.match(r.findings[0].message, /requires --w-url/);
});

// ---------------------------------------------------------------------------------------------------------------
// integration: a real PostgreSQL 18 server and the real recon-migrate binary

const W_URL = process.env.L4_TEST_W_URL ?? 'postgres://postgres@localhost:5450/postgres';
const BIN = process.env.L4_TEST_MIGRATE_BIN ?? join(REPO, 'target', 'debug', process.platform === 'win32' ? 'recon-migrate.exe' : 'recon-migrate');
const required = process.env.L4_TEST_W_URL !== undefined;

async function probe() {
  const c = new pg.Client({ connectionString: W_URL, connectionTimeoutMillis: 3000 });
  c.on('error', () => {});
  try {
    await c.connect();
    await c.end();
    return existsSync(BIN) ? null : `recon-migrate not found at ${BIN}`;
  } catch (e) {
    return `PostgreSQL not reachable at ${new URL(W_URL).host}: ${e.message}`;
  }
}
const unavailable = await probe();
if (unavailable && required) test('L4 integration environment is available', () => assert.fail(unavailable));
const it = (name, fn) => test(name, { skip: unavailable && !required ? `${unavailable} (set L4_TEST_W_URL / L4_TEST_MIGRATE_BIN)` : false, timeout: 180_000 }, fn);

async function leftovers() {
  const c = new pg.Client({ connectionString: W_URL });
  await c.connect();
  try {
    return (await c.query(`SELECT datname FROM pg_database WHERE datname LIKE 'recon\\_l4\\_%'`)).rows.map((r) => r.datname);
  } finally {
    await c.end();
  }
}
function ctxOf(opts, outDir = mkdtempSync(join(tmpdir(), 'l4-out-')), root = REPO) {
  return { root, now: NOW, release: false, outDir, opts: { 'w-url': W_URL, 'migrate-bin': BIN, ...opts }, log: () => {} };
}
/** Copy of the real migrations plus one extra W migration. */
function migrationsWith(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'l4-mig-'));
  cpSync(join(REPO, 'migrations'), dir, { recursive: true });
  writeFileSync(join(dir, 'w', '0900_l4_deliberately_bad.sql'), `-- target: w\n${sql}\n`);
  return dir;
}
const errorSubjects = (r) => new Set(r.findings.filter((f) => f.severity === 'error').map((f) => f.subject));
const msgOf = (r, subject) => r.findings.filter((f) => f.severity === 'error' && f.subject === subject).map((f) => f.message).join(' | ');

it('real migrations: classification is complete, only the two documented exceptions warn, scratch DB is dropped', async () => {
  const before = await leftovers();
  const ctx = ctxOf({ ropa: 'does/not/exist.md' });
  const r = await l4.run(ctx);
  assert.deepEqual(r.findings.filter((f) => f.severity === 'error'), [], 'real migrations must be clean (if this fails after a new migration, the finding is genuine)');
  assert.equal(r.status, 'warn');
  const cls = JSON.parse(readFileSync(join(ctx.outDir, 'classification.json'), 'utf8'));
  assert.ok(cls.columns_inspected >= 124);
  assert.equal(cls.rows.length, cls.columns_inspected);
  assert.deepEqual(cls.unclassified, []);
  const columns = cls.rows.map((x) => x.column);
  assert.deepEqual(columns, [...columns].sort(), 'rows sorted by column');
  assert.ok(columns.every((c) => /^(core|ingest|recon|rules|ledger|privacy|ops)\./.test(c)), 'api is not part of the ROPA rows');
  assert.deepEqual(cls.rows.filter((x) => x.exception).map((x) => x.column), ['core.legal_entity.vat_id_hmac', 'ledger.audit_event.actor_ref']);
  const vat = cls.rows.find((x) => x.column === 'core.legal_entity.vat_id_ct');
  assert.deepEqual(vat, { column: 'core.legal_entity.vat_id_ct', class: 'pii_id', basis: 'gdpr_6_1_c', retention: 'tax_record', encrypted: 'true' });
  const md = readFileSync(join(ctx.outDir, 'ropa-diff.md'), 'utf8');
  assert.match(md, /## Documented exceptions .*\(2\)/);
  assert.match(md, /vat_id_hmac/);
  const diff = JSON.parse(readFileSync(join(ctx.outDir, 'ropa-diff.json'), 'utf8'));
  assert.equal(diff.status, 'ropa_missing');
  assert.equal(diff.added.length, cls.rows.length);
  assert.deepEqual(r.evidence, ['classification.json', 'ropa-diff.md', 'ropa-diff.json']);
  assert.match(r.tools.postgres, /^18\./);
  assert.match(r.tools['recon-migrate'], /^sha256:[0-9a-f]{64}$/);
  assert.ok(r.inputs['migrations/w/0001_init.sql']);
  assert.deepEqual(await leftovers(), before, 'scratch database dropped');
});

it('deliberately bad migration copy turns L4 RED on every planted defect (and the scratch DB is still dropped)', async () => {
  const dir = migrationsWith(`
ALTER TABLE core.tenant ADD COLUMN unclassified_note text;
ALTER TABLE core.legal_entity ADD COLUMN contact_email text;
COMMENT ON COLUMN core.legal_entity.contact_email IS 'class=pii;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
ALTER TABLE core.legal_entity ADD COLUMN tax_ref_hmac bytea;
COMMENT ON COLUMN core.legal_entity.tax_ref_hmac IS 'class=pii_id;basis=gdpr_6_1_c;retention=tax_record;encrypted=hmac';
ALTER TABLE recon.finding ADD COLUMN amount_total double precision;
COMMENT ON COLUMN recon.finding.amount_total IS 'class=financial;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
ALTER TABLE recon.finding ADD COLUMN price_minor numeric;
COMMENT ON COLUMN recon.finding.price_minor IS 'class=financial;basis=gdpr_6_1_c;retention=tax_record;encrypted=none';
ALTER TABLE ops.fidelity_check ADD COLUMN bad_class text;
COMMENT ON COLUMN ops.fidelity_check.bad_class IS 'class=secretish;basis=none;retention=operational;encrypted=none';
ALTER TABLE ops.fidelity_check ADD COLUMN bad_retention text;
COMMENT ON COLUMN ops.fidelity_check.bad_retention IS 'class=internal;basis=gdpr_6_1_f;retention=forever;encrypted=none';
CREATE TABLE ops.bad_seq (id bigserial PRIMARY KEY);
COMMENT ON COLUMN ops.bad_seq.id IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
CREATE TABLE ops.bad_ident (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
COMMENT ON COLUMN ops.bad_ident.id IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
CREATE TABLE ops.bad_norls (tenant_id uuid NOT NULL);
COMMENT ON COLUMN ops.bad_norls.tenant_id IS 'class=internal;basis=gdpr_6_1_f;retention=operational;encrypted=none';
`);
  const before = await leftovers();
  const r = await l4.run(ctxOf({ 'migrations-dir': dir, ropa: 'none.md' }));
  assert.equal(r.status, 'fail');
  const s = errorSubjects(r);
  assert.match(msgOf(r, 'core.tenant.unclassified_note'), /unclassified column/);
  assert.match(msgOf(r, 'core.legal_entity.contact_email'), /requires encrypted=true/);
  assert.match(msgOf(r, 'core.legal_entity.tax_ref_hmac'), /requires encrypted=true/, 'hmac token on another column is not covered by the exception');
  assert.match(msgOf(r, 'recon.finding.amount_total'), /R-DB-2/);
  assert.match(msgOf(r, 'recon.finding.price_minor'), /R-DB-2/);
  assert.match(msgOf(r, 'ops.fidelity_check.bad_class'), /unknown class "secretish"/);
  assert.match(msgOf(r, 'ops.fidelity_check.bad_retention'), /retention "forever"/);
  assert.match(msgOf(r, 'ops.bad_seq.id'), /sequence default/);
  assert.match(msgOf(r, 'ops.bad_ident.id'), /identity column/);
  assert.match(msgOf(r, 'ops.bad_norls'), /row level security/);
  assert.ok(!s.has('core.legal_entity.vat_id_hmac') && !s.has('ledger.audit_event.actor_ref'), 'documented exceptions still apply');
  assert.deepEqual(await leftovers(), before);
});

it('stale exceptions turn L4 RED (column dropped / reclassified)', async () => {
  const dir = migrationsWith(`
ALTER TABLE core.legal_entity DROP COLUMN vat_id_hmac;
COMMENT ON COLUMN ledger.audit_event.actor_ref IS 'class=internal;basis=gdpr_6_1_c;retention=ledger;encrypted=none';
`);
  const r = await l4.run(ctxOf({ 'migrations-dir': dir, ropa: 'none.md' }));
  assert.equal(r.status, 'fail');
  assert.match(msgOf(r, 'core.legal_entity.vat_id_hmac'), /stale documented exception: column no longer exists/);
  assert.match(msgOf(r, 'ledger.audit_event.actor_ref'), /stale documented exception/);
});

it('api schema published in recon_pub turns L4 RED', async () => {
  const dir = migrationsWith('ALTER PUBLICATION recon_pub ADD TABLES IN SCHEMA api;');
  const r = await l4.run(ctxOf({ 'migrations-dir': dir, ropa: 'none.md' }));
  assert.equal(r.status, 'fail');
  assert.match(msgOf(r, 'api.api_key'), /must not be in publication recon_pub/);
});

it('a migration that fails to apply fails the gate, reports the tool output, and drops the scratch DB', async () => {
  const dir = migrationsWith('SELECT * FROM table_that_does_not_exist;');
  const before = await leftovers();
  const ctx = ctxOf({ 'migrations-dir': dir, ropa: 'none.md' });
  const r = await l4.run(ctx);
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /recon-migrate up --target w failed/);
  const cls = JSON.parse(readFileSync(join(ctx.outDir, 'classification.json'), 'utf8'));
  assert.equal(cls.columns_inspected, 0);
  assert.deepEqual(await leftovers(), before);
});

it('unreachable server and missing binary fail without leaving anything behind', async () => {
  const dead = new URL(W_URL);
  dead.port = '1';
  const r = await l4.run(ctxOf({ 'w-url': dead.toString() }));
  assert.equal(r.status, 'fail');
  assert.match(r.findings[0].message, /scratch database setup failed/);
  const r2 = await l4.run(ctxOf({ 'migrate-bin': join(tmpdir(), 'no-such-recon-migrate') }));
  assert.equal(r2.status, 'fail');
  assert.match(r2.findings[0].message, /not found/);
});

it('--write-ropa rewrites only the machine block; the result is in sync and satisfies L5', async () => {
  const root = mkdtempSync(join(tmpdir(), 'l4-root-'));
  cpSync(join(here, 'fixtures', 'l5', 'root'), root, { recursive: true });
  cpSync(join(REPO, 'migrations'), join(root, 'migrations'), { recursive: true });
  const ropaPath = join(root, 'docs', 'privacy', 'ROPA.md');
  const original = readFileSync(ropaPath, 'utf8');
  const outDir = mkdtempSync(join(tmpdir(), 'l4-out-'));

  const check = await l4.run(ctxOf({}, outDir, root));
  assert.equal(JSON.parse(readFileSync(join(outDir, 'ropa-diff.json'), 'utf8')).status, 'out_of_date');
  assert.equal(readFileSync(ropaPath, 'utf8'), original, 'check-only never writes');
  assert.ok(check.findings.some((f) => f.severity === 'warning' && /ROPA block check: out_of_date/.test(f.message)));

  const written = await l4.run(ctxOf({ 'write-ropa': 'docs/privacy/ROPA.md' }, outDir, root));
  assert.equal(written.findings.filter((f) => f.severity === 'error').length, 0);
  const text = readFileSync(ropaPath, 'utf8');
  assert.ok(text.startsWith(original.slice(0, original.indexOf('<!-- ropa:begin -->'))), 'text before the block untouched');
  assert.ok(text.endsWith(original.slice(original.indexOf('<!-- ropa:end -->'))), 'text after the block untouched');

  const again = await l4.run(ctxOf({}, outDir, root));
  const diff = JSON.parse(readFileSync(join(outDir, 'ropa-diff.json'), 'utf8'));
  assert.equal(diff.status, 'in_sync');
  assert.equal(again.findings.filter((f) => /ROPA block check/.test(f.message)).length, 0);
  const cls = JSON.parse(readFileSync(join(outDir, 'classification.json'), 'utf8'));
  assert.equal(l4.parseRopaBlock(text).rows.length, cls.rows.length);

  // L5 consumes exactly what L4 produced
  writeJson(outDir, 'L4.json', again);
  const l5r = await l5.run({ root, outDir, now: NOW, release: false, opts: {}, log: () => {} });
  assert.equal(l5r.findings.filter((f) => /ROPA/.test(`${f.subject} ${f.message}`) && f.severity === 'error').length, 0, JSON.stringify(l5r.findings));
});

it('--write-ropa refuses (and leaves the file alone) when the schema classification is incomplete or the block is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'l4-root-'));
  mkdirSync(join(root, 'docs', 'privacy'), { recursive: true });
  const ropaPath = join(root, 'docs', 'privacy', 'ROPA.md');
  writeFileSync(ropaPath, '# ROPA without markers\n');
  const r = await l4.run(ctxOf({ 'write-ropa': true, 'migrations-dir': join(REPO, 'migrations') }, undefined, root));
  assert.ok(r.findings.some((f) => f.severity === 'error' && /cannot rewrite ROPA/.test(f.message)));
  assert.equal(readFileSync(ropaPath, 'utf8'), '# ROPA without markers\n');
  const bad = migrationsWith('ALTER TABLE core.tenant ADD COLUMN unclassified_note text;');
  const r2 = await l4.run(ctxOf({ 'write-ropa': 'docs/privacy/ROPA.md', 'migrations-dir': bad }, undefined, root));
  assert.ok(r2.findings.some((f) => /NOT rewritten/.test(f.message)));
  assert.equal(readFileSync(ropaPath, 'utf8'), '# ROPA without markers\n');
});
