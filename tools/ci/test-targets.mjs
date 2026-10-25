#!/usr/bin/env node
// Lists the `cargo test` invocations that need NO database, for the `lint-build-unit` job (Workflow.md §3: "cargo test (non-DB)").
// Tests that need the W/R pair read RECON_TEST_W_URL / RECON_TEST_R_URL and fail loudly (never skip) when they are unset, so
// they run only in `db-integration`, which executes the whole workspace with the pair available.
//
//   node tools/ci/test-targets.mjs [--root DIR]
//
// Prints one argument string per line, to be run as `cargo test --locked <line>`:
//   --workspace --lib --bins
//   --workspace --doc
//   -p <package> --test <target>          for every crates/*/tests/<target>.rs (or <target>/main.rs) that does not use RECON_TEST_*
// An integration test target is a "DB test" when its source mentions `RECON_TEST_`, or declares `mod X;` where tests/X.rs or
// tests/X/mod.rs does. Nothing is dropped silently: DB targets are listed on stderr as `db-only: <package> <target>`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, runMain } from './lib/common.mjs';

const DB_MARK = /RECON_TEST_/;

function packageName(manifest) {
  const m = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/s.exec(readFileSync(manifest, 'utf8'));
  return m ? m[1] : null;
}

export function listTargets(root) {
  const crates = join(root, 'crates');
  const nodb = [];
  const db = [];
  if (!existsSync(crates)) return { nodb, db };
  for (const c of readdirSync(crates, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const manifest = join(crates, c, 'Cargo.toml');
    const tests = join(crates, c, 'tests');
    if (!existsSync(manifest) || !existsSync(tests)) continue;
    const pkg = packageName(manifest) ?? c;
    const usesDb = (rel) => {
      const p = join(tests, rel);
      return existsSync(p) && DB_MARK.test(readFileSync(p, 'utf8'));
    };
    for (const e of readdirSync(tests, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      let target;
      let text;
      if (e.isFile() && e.name.endsWith('.rs')) {
        target = e.name.slice(0, -3);
        text = readFileSync(join(tests, e.name), 'utf8');
      } else if (e.isDirectory() && existsSync(join(tests, e.name, 'main.rs'))) {
        target = e.name;
        text = readFileSync(join(tests, e.name, 'main.rs'), 'utf8');
      } else continue;
      const helperUsesDb = [...text.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)].some((m) => usesDb(`${m[1]}.rs`) || usesDb(`${m[1]}/mod.rs`));
      (DB_MARK.test(text) || helperUsesDb ? db : nodb).push({ pkg, target });
    }
  }
  return { nodb, db };
}

runMain(import.meta.url, (argv) => {
  const { opts } = parseArgs(argv);
  const root = resolve(typeof opts.root === 'string' ? opts.root : process.cwd());
  const { nodb, db } = listTargets(root);
  console.log('--workspace --lib --bins');
  console.log('--workspace --doc');
  for (const t of nodb) console.log(`-p ${t.pkg} --test ${t.target}`);
  for (const t of db) console.error(`db-only: ${t.pkg} ${t.target}`);
  return 0;
});
