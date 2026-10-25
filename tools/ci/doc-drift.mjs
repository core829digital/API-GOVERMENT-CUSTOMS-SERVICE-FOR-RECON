#!/usr/bin/env node
// R-DOC-3 doc-drift check: a change to a contract must update the matching document in the same change set.
//
//   node tools/ci/doc-drift.mjs --changed-file <list> [--diff <unified diff file>]
//
// <list>  newline-separated repo-relative paths of the PR (`git diff --name-only BASE HEAD`).
// <diff>  `git diff BASE HEAD -- crates/recon-store`; REQUIRED when the list contains crates/recon-store/** (a path list
//         cannot tell a role/grant change from any other edit, the diff can).
//
// Rules (exactly these three):
//   1. migrations/**                        changed  =>  DatabaseInfo.md changed
//   2. openapi/openapi.json                 changed  =>  frontend/lib/api/openapi.d.ts changed (openapi.json is itself the
//                                                        API document; the generated client must move with it, R-API-4)
//   3. crates/recon-store/** role/grant change (added or removed line that is a GRANT / REVOKE / CREATE ROLE /
//      ALTER ROLE / ALTER DEFAULT PRIVILEGES statement)  =>  DatabaseInfo.md changed
// Exit: 0 clean, 1 drift, 2 usage error.
import { readFileSync } from 'node:fs';
import { finding, parseArgs, readFileList, report, requireString, runMain, UsageError } from './lib/common.mjs';

const DB_DOC = 'DatabaseInfo.md';
const OPENAPI = 'openapi/openapi.json';
const OPENAPI_CLIENT = 'frontend/lib/api/openapi.d.ts';

const GRANT_SQL = [
  /\bGRANT\s+\S+(?:\s*,\s*\S+)*\s+(?:ON|TO)\b/i,
  /\bREVOKE\s+\S+(?:\s*,\s*\S+)*\s+(?:ON|FROM)\b/i,
  /\bCREATE\s+ROLE\s+\S+/i,
  /\bALTER\s+ROLE\s+\S+/i,
  /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i,
];

/** Added/removed lines per file of a unified diff (`diff --git` headers; `+++`/`---` file markers excluded). */
export function changedLinesByFile(diffText) {
  const out = new Map();
  let file = null;
  for (const line of diffText.split(/\r?\n/)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      file = m[2];
      if (!out.has(file)) out.set(file, []);
      continue;
    }
    if (file === null || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) out.get(file).push(line.slice(1));
  }
  return out;
}

export function docDrift({ changed, diffText }) {
  const set = new Set(changed);
  const findings = [];

  const migrations = changed.filter((f) => f.startsWith('migrations/'));
  if (migrations.length > 0 && !set.has(DB_DOC)) {
    findings.push(finding(migrations[0], `migrations changed (${migrations.length} file(s)) but ${DB_DOC} did not (R-DOC-3)`));
  }

  if (set.has(OPENAPI) && !set.has(OPENAPI_CLIENT)) {
    findings.push(finding(OPENAPI, `${OPENAPI} changed but the generated client ${OPENAPI_CLIENT} did not (R-API-4, R-DOC-3)`));
  }

  const store = changed.filter((f) => f.startsWith('crates/recon-store/'));
  if (store.length > 0) {
    if (diffText === undefined) throw new UsageError('crates/recon-store/** changed: pass --diff <unified diff> so role/grant changes can be detected');
    for (const [file, lines] of changedLinesByFile(diffText)) {
      if (!file.startsWith('crates/recon-store/')) continue;
      const hit = lines.find((l) => GRANT_SQL.some((re) => re.test(l)));
      if (hit !== undefined && !set.has(DB_DOC)) {
        findings.push(finding(file, `role/grant change ("${hit.trim().slice(0, 80)}") but ${DB_DOC} did not change (R-DOC-3)`));
      }
    }
  }
  return findings;
}

runMain(import.meta.url, (argv) => {
  const { opts } = parseArgs(argv);
  const changed = readFileList(requireString(opts, 'changed-file'));
  const diffText = typeof opts.diff === 'string' ? readFileSync(opts.diff, 'utf8') : undefined;
  return report('doc-drift', docDrift({ changed, diffText }));
});
