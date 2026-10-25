// L4 - Data classification (Workflow.md 4.2; R-DB-2, R-DB-3, R-DB-10, R-PRIV-7).
//
// Creates a uniquely named scratch database on the server given by --w-url, applies the W migrations with
// `recon-migrate up --target w`, reads the catalog and checks EVERY column of EVERY table in the replicated schemas
// (core, ingest, recon, rules, ledger, privacy, ops = the schemas of publication `recon_pub` in migrations/w/0001_init.sql).
// The scratch database is dropped on success and on failure. Waivers cannot cover L4, and a documented in-comment
// exception token is NOT supported: `pii`/`pii_id` columns must say `encrypted=true`.
//
// Options
//   --w-url <url>          admin (CREATEDB) URL of a server where a scratch database may be created   [required]
//   --migrate-bin <path>   recon-migrate executable                                                    [required]
//   --migrations-dir <d>   default <root>/migrations
//   --ropa <path>          ROPA.md to compare with (default docs/privacy/ROPA.md)
//   --write-ropa [<path>]  rewrite the machine-managed block (<!-- ropa:begin --> .. <!-- ropa:end -->) in place
//   --skip-reason <text>   path-filter skip (ignored for release builds)
//
// Evidence (outDir): classification.json, ropa-diff.md, ropa-diff.json.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { error, info, result, statusFromFindings, warning, writeJson, writeText } from '../lib/result.mjs';
import { inputLabel, runProc, sha256File, skipOrNull } from '../lib/proc.mjs';

export const id = 'L4';
export const name = 'Data classification';

/** Schemas of publication recon_pub (migrations/w/0001_init.sql). `api` is deliberately NOT replicated. */
export const REPLICATED_SCHEMAS = Object.freeze(['core', 'ingest', 'recon', 'rules', 'ledger', 'privacy', 'ops']);
export const UNPUBLISHED_SCHEMAS = Object.freeze(['api']);
export const CLASSES = Object.freeze(['public', 'internal', 'financial', 'pii', 'pii_id', 'secret']);
export const ENCRYPTED_VALUES = Object.freeze(['none', 'true', 'hmac', 'pseudonymous', 'hash']);
/**
 * Retention data classes. Source: `privacy.retention_policy.data_class` is the intended vocabulary (DatabaseInfo.md 3),
 * but the migrations create that table WITHOUT seed rows, so the vocabulary cannot be read from the schema. This list
 * is the five values used by the classification comments in migrations/w/0002_classification.sql (tax_record, ledger,
 * operational, key_material, rule_data). A new retention class therefore fails L4 until it is added here, which makes
 * it a visible change in the ROPA diff and in review. Rows that DO exist in privacy.retention_policy in the scratch
 * database are added to the allowed set at run time.
 */
export const RETENTION_CLASSES = Object.freeze(['tax_record', 'ledger', 'operational', 'key_material', 'rule_data']);
/**
 * Documented exceptions to "pii/pii_id needs encrypted=true" (Workflow.md 4.2 allows "or documented exception"; decision
 * by the project owner, 2026-10-23). Keyed by exact `schema.table.column`; a column passes only when its encrypted token
 * equals the entry's token. Every applied exception is a `warning` finding and is listed in ropa-diff.md; an entry whose
 * column no longer exists / no longer carries that class and token is an error (stale). Waivers do not apply to L4.
 */
export const DOCUMENTED_EXCEPTIONS = Object.freeze({
  'core.legal_entity.vat_id_hmac': Object.freeze({
    token: 'hmac',
    reason: 'keyed HMAC used for exact-match lookup without decryption (R-PRIV-2); the key is held outside the database',
  }),
  'ledger.audit_event.actor_ref': Object.freeze({
    token: 'pseudonymous',
    reason: 'opaque actor reference, never a name or e-mail (R-PRIV-1)',
  }),
});
const BASIS_RE = /^(none|gdpr_6_1_[a-f]|contract_6_1_b)$/;
const MONEY_NAME_RE = /amount|total|price|minor/i;
const FLOAT_TYPES = new Set(['float4', 'float8', 'numeric']);
const KEYS = ['class', 'basis', 'retention', 'encrypted'];
export const ROPA_BEGIN = '<!-- ropa:begin -->';
export const ROPA_END = '<!-- ropa:end -->';
const ROPA_HEADER = ['column', 'class', 'basis', 'retention', 'encrypted'];

// ---------------------------------------------------------------------------------------------------------------
// classification comment grammar:  class=<c>;basis=<b>;retention=<r>;encrypted=<e>   (all four keys, any order)

/** @returns {{value?:{class:string,basis:string,retention:string,encrypted:string}, problems:string[]}} */
export function parseClassification(comment) {
  const problems = [];
  const kv = {};
  for (const part of comment.split(';')) {
    const m = /^([a-z_]+)=([a-z0-9_]+)$/.exec(part);
    if (!m) {
      problems.push(`malformed element "${part}" (expected key=value with lowercase [a-z0-9_] value)`);
      continue;
    }
    if (!KEYS.includes(m[1])) problems.push(`unknown key "${m[1]}"`);
    else if (m[1] in kv) problems.push(`duplicate key "${m[1]}"`);
    else kv[m[1]] = m[2];
  }
  for (const k of KEYS) if (!(k in kv)) problems.push(`missing key "${k}"`);
  if (problems.length) return { problems };
  if (!CLASSES.includes(kv.class)) problems.push(`unknown class "${kv.class}" (allowed: ${CLASSES.join(', ')})`);
  if (!BASIS_RE.test(kv.basis)) problems.push(`unknown basis "${kv.basis}"`);
  if (!ENCRYPTED_VALUES.includes(kv.encrypted)) problems.push(`unknown encrypted value "${kv.encrypted}" (allowed: ${ENCRYPTED_VALUES.join(', ')})`);
  return problems.length ? { problems } : { value: kv, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// ROPA machine-managed block (docs/privacy/ROPA.md)

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const ropaRowLine = (r) => `| ${r.column} | ${r.class} | ${r.basis} | ${r.retention} | ${r.encrypted} |`;

/** Block text without trailing newline, markers included. */
export function renderRopaBlock(rows) {
  return [
    ROPA_BEGIN,
    `| ${ROPA_HEADER.join(' | ')} |`,
    `|${ROPA_HEADER.map(() => '---').join('|')}|`,
    ...rows.map(ropaRowLine),
    ROPA_END,
  ].join('\n');
}

/**
 * @returns {{found:boolean, rows:object[], invalid:string[], problems:string[], begin:number, end:number}}
 *   begin/end are the string offsets of the begin marker and the end of the end marker (when found)
 */
export function parseRopaBlock(text) {
  const out = { found: false, rows: [], invalid: [], problems: [], begin: -1, end: -1 };
  const b = text.indexOf(ROPA_BEGIN);
  const e = text.indexOf(ROPA_END);
  if (b < 0 || e < 0) {
    out.problems.push(b < 0 && e < 0 ? 'no ropa:begin/ropa:end markers' : `missing ${b < 0 ? 'ropa:begin' : 'ropa:end'} marker`);
    return out;
  }
  if (text.indexOf(ROPA_BEGIN, b + 1) >= 0 || text.indexOf(ROPA_END, e + 1) >= 0) out.problems.push('duplicate ropa markers');
  if (e < b) out.problems.push('ropa:end precedes ropa:begin');
  if (out.problems.length) return out;
  out.found = true;
  out.begin = b;
  out.end = e + ROPA_END.length;
  const lines = text.slice(b + ROPA_BEGIN.length, e).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.shift();
  const sep = lines.shift();
  const cells = (l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (!header || cells(header).join('|') !== ROPA_HEADER.join('|')) out.invalid.push(header ?? '(empty block)');
  if (!sep || !/^\|?\s*-+\s*(\|\s*-+\s*)+\|?$/.test(sep)) out.invalid.push(sep ?? '(missing separator row)');
  for (const l of lines) {
    const c = l.startsWith('|') && l.endsWith('|') ? cells(l) : [];
    if (c.length !== ROPA_HEADER.length || c.some((x) => x === '')) out.invalid.push(l);
    else out.rows.push(Object.fromEntries(ROPA_HEADER.map((k, i) => [k, c[i]])));
  }
  return out;
}

/** Row-level diff of the ROPA block (by `column`). */
export function diffRopa(current, derived) {
  const cur = new Map(current.map((r) => [r.column, r]));
  const der = new Map(derived.map((r) => [r.column, r]));
  const added = derived.filter((r) => !cur.has(r.column));
  const removed = current.filter((r) => !der.has(r.column));
  const changed = derived
    .filter((r) => cur.has(r.column) && ropaRowLine(cur.get(r.column)) !== ropaRowLine(r))
    .map((r) => ({ column: r.column, current: cur.get(r.column), derived: r }));
  return { added, removed, changed };
}

/** Replace the machine-managed block in `text`, keeping everything outside the markers and the file's EOL style. */
export function replaceRopaBlock(text, rows) {
  const p = parseRopaBlock(text);
  if (!p.found) throw new Error(`cannot rewrite ROPA: ${p.problems.join('; ')}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.slice(0, p.begin) + renderRopaBlock(rows).split('\n').join(eol) + text.slice(p.end);
}

function renderDiffMd(d) {
  const lines = ['# ROPA diff (L4)', '', `ROPA file: \`${d.ropa_path}\` - status: **${d.status}**`, `Derived rows: ${d.derived_rows}; rows in ROPA block: ${d.current_rows}`, ''];
  if (d.notes.length) lines.push(...d.notes.map((n) => `- ${n}`), '');
  const section = (title, rows, fmt) => {
    lines.push(`## ${title} (${rows.length})`, '');
    if (rows.length) lines.push(...rows.map(fmt));
    else lines.push('_none_');
    lines.push('');
  };
  section('Missing from ROPA (columns in the schema)', d.added, (r) => `- \`${r.column}\`: ${r.class} / ${r.basis} / ${r.retention} / ${r.encrypted}`);
  section('Stale in ROPA (no such column)', d.removed, (r) => `- \`${r.column}\``);
  section('Changed', d.changed, (c) => `- \`${c.column}\`: ROPA \`${ropaRowLine(c.current)}\` -> schema \`${ropaRowLine(c.derived)}\``);
  section('Documented exceptions (pii/pii_id without encrypted=true)', d.exceptions, (x) => `- \`${x.column}\` (${x.class}, encrypted=${x.token}): ${x.reason}`);
  lines.push(`Retention classes in use: ${d.retention_classes_in_use.join(', ') || '(none)'}`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// database work

const COLUMNS_SQL = `
SELECT n.nspname AS schema, c.relname AS "table", a.attnum, a.attname AS "column",
       format_type(a.atttypid, a.atttypmod) AS type_text,
       COALESCE(bt.typname, t.typname) AS base_type,
       col_description(c.oid, a.attnum) AS comment,
       a.attidentity::text AS identity,
       pg_get_expr(d.adbin, d.adrelid) AS default_expr,
       c.relrowsecurity AS rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
 WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') AND NOT c.relispartition
 ORDER BY n.nspname, c.relname, a.attnum`;

const PUBLISHED_SQL = `SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'recon_pub' ORDER BY 1, 2`;

function scratchUrlOf(adminUrl, db) {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

const redact = (text, secrets) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join('***'), text);
const tail = (text, n = 15) => text.trim().split(/\r?\n/).slice(-n).join('\n');

function migrationFiles(dir) {
  const files = [];
  for (const sub of ['w']) {
    const d = join(dir, sub);
    if (existsSync(d)) for (const f of readdirSync(d).sort()) if (f.endsWith('.sql')) files.push(join(d, f));
  }
  return files;
}

/** Pure checks over the catalog rows. Returns findings + classification rows. */
export function analyseColumns(columns, extraRetention = [], exceptions = DOCUMENTED_EXCEPTIONS) {
  const applied = [];
  const findings = [];
  const rows = [];
  const unclassified = [];
  const retentionAllowed = new Set([...RETENTION_CLASSES, ...extraRetention]);
  const tablesWithTenant = new Map();
  for (const c of columns) {
    const subject = `${c.schema}.${c.table}.${c.column}`;
    if (/[|\r\n]/.test(subject) || subject !== subject.trim()) {
      findings.push(error(`identifier cannot be represented in the ROPA table: ${JSON.stringify(subject)}`, subject));
      continue;
    }
    const tkey = `${c.schema}.${c.table}`;
    if (!tablesWithTenant.has(tkey)) tablesWithTenant.set(tkey, { rls: c.rls, tenant: false });
    if (c.column === 'tenant_id') tablesWithTenant.get(tkey).tenant = true;

    if (c.default_expr && /nextval\s*\(/i.test(c.default_expr)) {
      findings.push(error(`sequence default (${c.default_expr}) on a replicated table; sequences are not replicated - use uuidv7() (R-DB-3)`, subject));
    }
    if (c.identity) findings.push(error(`identity column (attidentity='${c.identity}') on a replicated table; identity sequences are not replicated - use uuidv7() (R-DB-3)`, subject));
    if (FLOAT_TYPES.has(c.base_type) && MONEY_NAME_RE.test(c.column)) {
      findings.push(error(`money-like column typed ${c.type_text}; money is bigint minor units + char(3) currency (R-DB-2)`, subject));
    }

    if (c.comment === null || c.comment === undefined || c.comment.trim() === '') {
      unclassified.push(subject);
      findings.push(error('unclassified column: missing COMMENT ON COLUMN class=...;basis=...;retention=...;encrypted=... (R-DB-10)', subject));
      continue;
    }
    const parsed = parseClassification(c.comment);
    if (!parsed.value) {
      unclassified.push(subject);
      for (const p of parsed.problems) findings.push(error(`invalid classification comment: ${p}`, subject));
      continue;
    }
    const v = parsed.value;
    if (!retentionAllowed.has(v.retention)) {
      findings.push(error(`retention "${v.retention}" is not a known data class (${[...retentionAllowed].join(', ')})`, subject));
    }
    const row = { column: subject, class: v.class, basis: v.basis, retention: v.retention, encrypted: v.encrypted };
    if ((v.class === 'pii' || v.class === 'pii_id') && v.encrypted !== 'true') {
      const ex = exceptions[subject];
      if (ex && ex.token === v.encrypted) {
        row.exception = { token: ex.token, reason: ex.reason };
        applied.push({ column: subject, class: v.class, token: ex.token, reason: ex.reason });
        findings.push(warning(`documented exception applied: class=${v.class} with encrypted=${ex.token} - ${ex.reason}`, subject));
      } else {
        findings.push(error(`class=${v.class} requires encrypted=true (found encrypted=${v.encrypted})${ex ? `; the documented exception for this column only covers encrypted=${ex.token}` : ''}; L4 cannot be waived (R-PRIV-2)`, subject));
      }
    }
    rows.push(row);
  }
  for (const [t, s] of tablesWithTenant) {
    if (s.tenant && !s.rls) findings.push(error('table has a tenant_id column but row level security is not enabled (R-SEC-3)', t));
  }
  for (const [column, ex] of Object.entries(exceptions)) {
    const col = columns.find((c) => `${c.schema}.${c.table}.${c.column}` === column);
    const row = rows.find((r) => r.column === column);
    if (col && !row) continue; // present but unclassified/invalid: already an error
    if (!row) findings.push(error(`stale documented exception: column no longer exists (${ex.reason})`, column));
    else if (!['pii', 'pii_id'].includes(row.class) || row.encrypted !== ex.token) {
      findings.push(error(`stale documented exception: column is class=${row.class}, encrypted=${row.encrypted}, not a pii/pii_id column with encrypted=${ex.token}; remove the entry`, column));
    }
  }
  rows.sort((a, b) => cmp(a.column, b.column));
  return { findings, rows, unclassified, exceptions: applied };
}

/** Publication consistency: api never published; every replicated table published; nothing else published. */
export function analysePublication(published, columns) {
  const findings = [];
  const pubSet = new Set(published.map((p) => `${p.schemaname}.${p.tablename}`));
  for (const p of published) {
    if (UNPUBLISHED_SCHEMAS.includes(p.schemaname)) findings.push(error(`schema "${p.schemaname}" must not be in publication recon_pub (api/secret material is never replicated to R)`, `${p.schemaname}.${p.tablename}`));
    else if (!REPLICATED_SCHEMAS.includes(p.schemaname)) findings.push(error(`publication recon_pub publishes ${p.schemaname}.${p.tablename}, which is outside the replicated schemas`, `${p.schemaname}.${p.tablename}`));
  }
  const tables = new Set(columns.map((c) => `${c.schema}.${c.table}`));
  for (const t of tables) if (!pubSet.has(t)) findings.push(error('table in a replicated schema is not in publication recon_pub (it would silently not replicate)', t));
  return findings;
}

async function inspectScratch(ctx, { Client, scratchUrl, secrets }) {
  const out = { findings: [], columns: [], published: null, pgVersion: null, extraRetention: [], complete: false };
  const client = new Client({ connectionString: scratchUrl });
  client.on('error', () => {});
  try {
    await client.connect();
    out.pgVersion = (await client.query('SHOW server_version')).rows[0].server_version;
    out.columns = (await client.query(COLUMNS_SQL, [[...REPLICATED_SCHEMAS]])).rows;
    const pub = await client.query(`SELECT 1 FROM pg_publication WHERE pubname = 'recon_pub'`);
    out.published = pub.rowCount ? (await client.query(PUBLISHED_SQL)).rows : null;
    const hasPolicy = (await client.query(`SELECT to_regclass('privacy.retention_policy') AS t`)).rows[0].t;
    if (hasPolicy) out.extraRetention = (await client.query('SELECT DISTINCT data_class FROM privacy.retention_policy')).rows.map((r) => r.data_class);
    out.complete = true;
  } catch (e) {
    out.findings.push(error(`catalog inspection failed: ${redact(e.message, secrets)}`));
  } finally {
    await client.end().catch(() => {});
  }
  return out;
}

export async function run(ctx) {
  const skipped = skipOrNull(ctx, id);
  if (skipped) return skipped;
  const findings = [];
  const wUrl = ctx.opts['w-url'];
  const migrateBin = ctx.opts['migrate-bin'];
  if (typeof wUrl !== 'string' || typeof migrateBin !== 'string') {
    return result(id, 'fail', { summary: 'missing options', findings: [error('L4 requires --w-url <admin postgres URL> and --migrate-bin <recon-migrate executable>')] });
  }
  const binPath = resolve(ctx.root, migrateBin);
  if (!existsSync(binPath)) return result(id, 'fail', { summary: 'recon-migrate missing', findings: [error(`recon-migrate executable not found: ${migrateBin}`)] });
  const dir = resolve(ctx.root, typeof ctx.opts['migrations-dir'] === 'string' ? ctx.opts['migrations-dir'] : 'migrations');
  const files = migrationFiles(dir);
  if (files.length === 0) return result(id, 'fail', { summary: 'no migrations', findings: [error(`no W migrations found under ${dir}/w`)] });

  const inputs = {};
  for (const f of files) inputs[inputLabel(ctx.root, f)] = sha256File(f);
  const tools = { 'recon-migrate': `sha256:${sha256File(binPath)}` };

  let pg;
  try {
    pg = (await import('pg')).default;
  } catch (e) {
    return result(id, 'fail', { summary: 'pg package missing', findings: [error(`cannot load the "pg" package (run npm ci in tools/legal-audit): ${e.message}`)] });
  }
  const scratch = `recon_l4_${randomBytes(6).toString('hex')}`;
  const scratchUrl = scratchUrlOf(wUrl, scratch);
  const secrets = [new URL(wUrl).password, decodeURIComponent(new URL(wUrl).password)];
  const admin = new pg.Client({ connectionString: wUrl });
  admin.on('error', () => {});
  let created = false;
  let inspected = { findings: [], columns: [], published: null, pgVersion: null, extraRetention: [], complete: false };
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratch}"`);
    created = true;
    const m = await runProc(binPath, ['up', '--target', 'w', '--url', scratchUrl, '--dir', dir], { timeoutMs: 5 * 60 * 1000 });
    if (m.error || m.code !== 0) {
      findings.push(error(`recon-migrate up --target w failed (exit ${m.code}${m.error ? `, ${m.error.message}` : ''}): ${redact(tail(`${m.stdout}\n${m.stderr}`), secrets)}`));
    } else {
      ctx.log(`L4: ${tail(m.stdout, 1)}`);
      inspected = await inspectScratch(ctx, { Client: pg.Client, scratchUrl, secrets });
    }
  } catch (e) {
    findings.push(error(`scratch database setup failed: ${redact(e.message, secrets)}`));
  } finally {
    if (created) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
      } catch (e) {
        findings.push(error(`scratch database "${scratch}" could not be dropped: ${redact(e.message, secrets)}`));
      }
    }
    await admin.end().catch(() => {});
  }
  findings.push(...inspected.findings);
  if (inspected.pgVersion) tools.postgres = inspected.pgVersion;

  const analysed = analyseColumns(inspected.columns, inspected.extraRetention);
  if (inspected.complete) {
    findings.push(...analysed.findings);
    if (inspected.columns.length === 0) findings.push(error('no tables found in the replicated schemas after applying the migrations'));
    if (inspected.published === null) {
      findings.push(info('migrations create no publication recon_pub; api/replication exposure not checked'));
    } else {
      findings.push(...analysePublication(inspected.published, inspected.columns));
    }
  }

  // ---- ROPA
  const writeOpt = ctx.opts['write-ropa'];
  const ropaOpt = typeof ctx.opts.ropa === 'string' ? ctx.opts.ropa : typeof writeOpt === 'string' ? writeOpt : 'docs/privacy/ROPA.md';
  const ropaPath = resolve(ctx.root, ropaOpt);
  const notes = [];
  let current = [];
  let ropaText = null;
  let status;
  if (!existsSync(ropaPath)) {
    status = 'ropa_missing';
    notes.push(`${ropaOpt} does not exist`);
  } else {
    ropaText = readFileSync(ropaPath, 'utf8');
    inputs[inputLabel(ctx.root, ropaPath)] = sha256File(ropaPath);
    const p = parseRopaBlock(ropaText);
    if (!p.found) {
      status = 'block_missing';
      notes.push(...p.problems);
    } else {
      current = p.rows;
      for (const l of p.invalid) notes.push(`invalid ROPA block line: ${l}`);
    }
  }
  const d = diffRopa(current, analysed.rows);
  if (!status) status = d.added.length || d.removed.length || d.changed.length || notes.length ? 'out_of_date' : 'in_sync';
  const diff = {
    ropa_path: ropaOpt.split('\\').join('/'),
    status,
    derived_rows: analysed.rows.length,
    current_rows: current.length,
    notes,
    ...d,
    retention_classes_in_use: [...new Set(analysed.rows.map((r) => r.retention))].sort(),
    exceptions: analysed.exceptions,
  };
  if (inspected.complete && status !== 'in_sync') {
    findings.push(warning(`ROPA block check: ${status} relative to the schema (${d.added.length} missing, ${d.removed.length} stale, ${d.changed.length} changed); regenerate with --write-ropa (L5 fails until it is reflected)`, diff.ropa_path));
  }
  if (writeOpt !== undefined) {
    if (!inspected.complete || analysed.unclassified.length > 0) {
      findings.push(error('ROPA block NOT rewritten: the classification of the schema is incomplete (fix the errors above first)'));
    } else if (ropaText === null) {
      findings.push(error(`--write-ropa: ${ropaOpt} does not exist (the gate creates no files other than evidence)`));
    } else {
      try {
        const next = replaceRopaBlock(ropaText, analysed.rows);
        if (next !== ropaText) writeFileSync(ropaPath, next);
        findings.push(info(`ROPA block rewritten with ${analysed.rows.length} rows${next === ropaText ? ' (already up to date)' : ''}`, diff.ropa_path));
        diff.rewritten = next !== ropaText;
      } catch (e) {
        findings.push(error(e.message, diff.ropa_path));
      }
    }
  }

  const counts = {};
  for (const r of analysed.rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
  const evidence = [
    writeJson(ctx.outDir, 'classification.json', {
      schema_version: 1,
      replicated_schemas: [...REPLICATED_SCHEMAS],
      columns_inspected: inspected.columns.length,
      unclassified: analysed.unclassified,
      retention_classes_in_use: diff.retention_classes_in_use,
      rows: analysed.rows,
    }),
    writeText(ctx.outDir, 'ropa-diff.md', renderDiffMd(diff)),
    writeJson(ctx.outDir, 'ropa-diff.json', diff),
  ];
  const final = statusFromFindings(findings);
  return result(id, final, {
    summary: `${inspected.columns.length} columns inspected, ${analysed.rows.length} classified, ${findings.filter((f) => f.severity === 'error').length} errors`,
    findings,
    evidence,
    metrics: { columns: inspected.columns.length, classified: analysed.rows.length, unclassified: analysed.unclassified.length, by_class: counts, ropa_status: status },
    inputs,
    tools,
  });
}
