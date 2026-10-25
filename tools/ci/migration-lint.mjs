#!/usr/bin/env node
// Migration lint (R-DB-2, R-DB-3, R-DB-8). Static checks on migrations/{w,r}/*.sql; the replication behaviour itself is
// proven by the db-integration job, not here.
//
//   node tools/ci/migration-lint.mjs [--root DIR] [--changed-file <list>]
//
// File rules (mirror crates/recon-migrate/src/lib.rs `discover`, which is the real loader):
//   * only migrations/w/ and migrations/r/ are applied; a .sql anywhere else under migrations/ is an error
//   * file name NNNN_name.sql (4 digits, underscore); versions unique per directory
//   * first line, trimmed, is exactly `-- target: <dir>`. Rules.md R-DB-8 also lists `both`, but the loader has no such
//     directory: a `-- target: both` header is rejected with a pointer to the real convention (same file in w/ and r/)
// Schema rules (R-DB-2/3) on CREATE/ALTER TABLE, CREATE SEQUENCE/TYPE/DOMAIN whose object is in a replicated schema
// (core, ingest, recon, rules, ledger, privacy, ops; unqualified names are treated as replicated, the conservative
// reading): no serial/bigserial/smallserial, no GENERATED ... AS IDENTITY, no nextval, no CREATE SEQUENCE, no
// float/real/double precision. Comments, string literals and dollar-quoted function bodies are ignored.
// Destructive rules (R-DB-8, expand/contract): a statement that is DROP ..., TRUNCATE ..., or an ALTER ... containing
// DROP or RENAME is destructive. It needs a line `-- destructive: reviewed` in the same file. When --changed-file is
// given and that migration is part of the change set, the change set must also not contain application source
// (crates/**/*.rs, frontend/**/*.{ts,tsx}) that still mentions the dropped/renamed object name (whole-word,
// case-insensitive): the code that stops using an object must ship in an EARLIER release than the migration that removes it.
// This is a textual approximation: it can flag an unrelated identifier with the same name (then ship the migration in its
// own, later change) and cannot see dynamic SQL.
// Limits: function bodies are not inspected; a DO block is only scanned for the words DROP/TRUNCATE/RENAME (needs the
// marker); SQL built with EXECUTE '...' is invisible. Write destructive changes as top-level statements.
// Exit: 0 clean, 1 findings, 2 usage error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finding, parseArgs, readFileList, report, runMain, UsageError } from './lib/common.mjs';
import { maskSql, splitStatements } from './lib/sql.mjs';

export const REPLICATED_SCHEMAS = ['core', 'ingest', 'recon', 'rules', 'ledger', 'privacy', 'ops'];
const TARGET_DIRS = ['w', 'r'];
const MARKER = /^\s*--\s*destructive:\s*reviewed\s*$/m;

const NAME = String.raw`((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)`;
const OBJECT_DDL = [
  new RegExp(String.raw`^CREATE (?:(?:UNLOGGED|GLOBAL TEMPORARY|GLOBAL TEMP|LOCAL TEMPORARY|LOCAL TEMP|TEMPORARY|TEMP) )?TABLE (?:IF NOT EXISTS )?${NAME}`, 'i'),
  new RegExp(String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${NAME}`, 'i'),
  new RegExp(String.raw`^CREATE SEQUENCE (?:IF NOT EXISTS )?${NAME}`, 'i'),
  new RegExp(String.raw`^CREATE TYPE ${NAME}`, 'i'),
  new RegExp(String.raw`^CREATE DOMAIN ${NAME}`, 'i'),
];

const FORBIDDEN = [
  [/\b(?:small|big)?serial[248]?\b/i, 'serial column (sequence default): replicated tables use uuidv7() keys (R-DB-3)'],
  [/\bGENERATED (?:ALWAYS|BY DEFAULT) AS IDENTITY\b/i, 'identity column (sequence): replicated tables use uuidv7() keys (R-DB-3)'],
  [/\bnextval\b/i, 'nextval(): sequences are not replicated (R-DB-3)'],
  [/^CREATE SEQUENCE\b/i, 'CREATE SEQUENCE in a replicated schema: sequences are not replicated (R-DB-3)'],
  [/\bdouble precision\b/i, 'double precision: money is bigint minor units + char(3) currency (R-DB-2)'],
  [/\bfloat[48]?\b/i, 'float type: money is bigint minor units + char(3) currency (R-DB-2)'],
  [/\breal\b/i, 'real type: money is bigint minor units + char(3) currency (R-DB-2)'],
];

const stripQuotes = (s) => s.replace(/^"|"$/g, '');

/** Schema of the object a DDL statement targets, or null when the statement is not object DDL. 'unqualified' when none. */
export function ddlSchema(stmt) {
  for (const re of OBJECT_DDL) {
    const m = re.exec(stmt);
    if (m) {
      const parts = m[1].split('.');
      return parts.length === 2 ? stripQuotes(parts[0]).toLowerCase() : 'unqualified';
    }
  }
  return null;
}

/** Objects a destructive statement removes/renames, or null when the statement is not destructive. */
export function destructiveObjects(stmt) {
  const last = (n) => stripQuotes(n.split('.').pop());
  let m;
  if ((m = /^DROP (?:MATERIALIZED |FOREIGN )?[A-Za-z]+ (?:IF EXISTS )?(.+)$/i.exec(stmt))) {
    const names = m[1]
      .replace(/ (?:CASCADE|RESTRICT)$/i, '')
      .split(',')
      .map((s) => s.trim().replace(/\(.*$/, '').replace(/ ON .*$/i, ''))
      .filter(Boolean)
      .map(last);
    return { kind: 'DROP', objects: names.length ? names : ['?'] };
  }
  if (/^DROP\b/i.test(stmt)) return { kind: 'DROP', objects: ['?'] };
  if ((m = /^TRUNCATE (?:TABLE )?(?:ONLY )?(.+)$/i.exec(stmt))) {
    return { kind: 'TRUNCATE', objects: m[1].replace(/ (?:RESTART|CONTINUE) IDENTITY.*$|\s(?:CASCADE|RESTRICT)$/i, '').split(',').map((s) => last(s.trim())) };
  }
  if (/^ALTER\b/i.test(stmt) && (/\bDROP\b/i.test(stmt) || /\bRENAME\b/i.test(stmt))) {
    const objects = [];
    const head = /^ALTER (?:TABLE|VIEW|INDEX|SEQUENCE|TYPE|DOMAIN|SCHEMA|MATERIALIZED VIEW) (?:IF EXISTS )?(?:ONLY )?(\S+)/i.exec(stmt);
    if (head) objects.push(last(head[1]));
    for (const d of stmt.matchAll(/\bDROP (?:COLUMN |CONSTRAINT )?(?:IF EXISTS )?("[^"]+"|[A-Za-z_][\w$]*)/gi)) {
      if (!/^(?:NOT|DEFAULT|IDENTITY|EXPRESSION|COLUMN|CONSTRAINT|IF)$/i.test(d[1])) objects.push(stripQuotes(d[1]));
    }
    for (const r of stmt.matchAll(/\bRENAME (?:COLUMN |CONSTRAINT )?("[^"]+"|[A-Za-z_][\w$]*)(?= TO\b)/gi)) {
      if (!/^TO$/i.test(r[1])) objects.push(stripQuotes(r[1]));
    }
    return { kind: /\bRENAME\b/i.test(stmt) && !/\bDROP\b/i.test(stmt) ? 'RENAME' : 'ALTER..DROP', objects: [...new Set(objects)] };
  }
  return null;
}

const APP_SOURCE = (p) =>
  /^crates\/.+\.rs$/.test(p) || /^frontend\/(?!node_modules\/|\.next\/).+\.(?:ts|tsx)$/.test(p);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function lintMigrations({ root, changed }) {
  const findings = [];
  const notes = [];
  const migDir = join(root, 'migrations');
  if (!existsSync(migDir)) throw new UsageError(`no migrations directory under ${root}`);
  const changedSet = changed ? new Set(changed) : null;
  if (!changedSet) notes.push('no --changed-file: the destructive same-change-set check was not performed');

  // .sql files outside w/ and r/ are never applied
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), p);
      else if (e.name.endsWith('.sql') && !TARGET_DIRS.some((t) => p.startsWith(`migrations/${t}/`) && p.split('/').length === 3)) {
        findings.push(finding(p, 'migration is not directly inside migrations/w/ or migrations/r/: recon-migrate will never apply it'));
      }
    }
  };
  walk(migDir, 'migrations');

  for (const target of TARGET_DIRS) {
    const dir = join(migDir, target);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      findings.push(finding(`migrations/${target}`, 'directory missing'));
      continue;
    }
    const seen = new Map();
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const rel = `migrations/${target}/${name}`;
      const m = /^(\d{4})_(.+)\.sql$/.exec(name);
      if (!m) {
        findings.push(finding(rel, 'file name must be NNNN_name.sql (4-digit version, underscore, name)'));
        continue;
      }
      if (seen.has(m[1])) findings.push(finding(rel, `duplicate version ${m[1]} (also ${seen.get(m[1])})`));
      else seen.set(m[1], name);

      const sql = readFileSync(join(dir, name), 'utf8'); // no BOM stripping: the loader compares the raw first line
      const first = (sql.split(/\r?\n/, 1)[0] ?? '').trim();
      if (first !== `-- target: ${target}`) {
        const both = first === '-- target: both';
        findings.push(
          finding(
            rel,
            both
              ? 'header `-- target: both` is not supported by recon-migrate: keep one file in migrations/w/ and one in migrations/r/, each with its own target header'
              : `first line must be exactly \`-- target: ${target}\` (matching its directory), found \`${first.slice(0, 60)}\``,
            1,
          ),
        );
      }

      const stmts = splitStatements(maskSql(sql));
      for (const body of sql.matchAll(/\bDO\s+(?:LANGUAGE\s+\w+\s+)?(\$[A-Za-z_]*\$)([\s\S]*?)\1/gi)) {
        const inner = maskSql(body[2]);
        if (/\b(?:DROP|TRUNCATE|RENAME)\b/i.test(inner) && !MARKER.test(sql)) {
          const line = sql.slice(0, body.index).split('\n').length;
          findings.push(finding(rel, 'DO block contains DROP/TRUNCATE/RENAME and the file has no `-- destructive: reviewed` line (R-DB-8)', line));
        }
      }
      for (const s of stmts) {
        const schema = ddlSchema(s.text);
        if (schema !== null && (schema === 'unqualified' || REPLICATED_SCHEMAS.includes(schema))) {
          for (const [re, why] of FORBIDDEN) if (re.test(s.text)) findings.push(finding(rel, `${why} -- in: ${s.text.slice(0, 70)}`, s.line));
        }
        const d = destructiveObjects(s.text);
        if (d === null) continue;
        if (!MARKER.test(sql)) {
          findings.push(finding(rel, `destructive statement (${d.kind} ${d.objects.join(', ')}) without a \`-- destructive: reviewed\` line (R-DB-8)`, s.line));
          continue;
        }
        if (changedSet && changedSet.has(rel)) {
          for (const src of changed.filter(APP_SOURCE)) {
            const path = join(root, src);
            if (!existsSync(path)) continue;
            const text = readFileSync(path, 'utf8');
            for (const obj of d.objects.filter((o) => o !== '?')) {
              const re = new RegExp(`(?<![\\w$])${escapeRe(obj)}(?![\\w$])`, 'i');
              const hit = text.split('\n').findIndex((l) => re.test(l));
              if (hit >= 0) {
                findings.push(
                  finding(
                    rel,
                    `destructive ${d.kind} of "${obj}" ships in the same change set as ${src}:${hit + 1}, which still mentions it: stop using the object in an earlier release first (R-DB-8)`,
                    s.line,
                  ),
                );
              }
            }
          }
        }
      }
    }
  }
  return { findings, notes };
}

runMain(import.meta.url, (argv) => {
  const { opts } = parseArgs(argv);
  const root = resolve(typeof opts.root === 'string' ? opts.root : process.cwd());
  const changed = typeof opts['changed-file'] === 'string' ? readFileList(opts['changed-file']) : undefined;
  const { findings, notes } = lintMigrations({ root, changed });
  return report('migration-lint', findings, notes);
});
