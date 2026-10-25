#!/usr/bin/env node
// Installs pinned CI tool binaries after verifying their sha256 (R-SEC-7 supply-chain hygiene: no `curl | sh`, no
// unpinned `latest`).
//
//   node tools/ci/install-tools.mjs <tool> [<tool> ...] [--dest DIR] [--manifest FILE] [--verify-only]
//
// Versions, URLs and expected sha256 live in tools/ci/tool-versions.json. The download is rejected (exit 1, nothing
// installed) when its sha256 differs. Binaries are placed in DIR (default $RUNNER_TEMP/tool-bin, else ./.tool-bin) and DIR
// is appended to $GITHUB_PATH when that variable is set. --verify-only downloads and checks without installing (works on
// any OS; used to validate the manifest). Installing requires the platform named in the manifest (linux-x64) and `tar`.
// Exit: 0 ok, 1 verification/download failure, 2 usage error.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs, runMain, UsageError } from './lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function installTool(name, spec, { dest, verifyOnly }) {
  const data = await download(spec.url);
  const got = sha256(data);
  if (got !== spec.sha256) {
    throw new Error(`${name}: sha256 mismatch for ${spec.url}\n  expected ${spec.sha256}\n  actual   ${got}`);
  }
  if (verifyOnly) return `${name} ${spec.version}: sha256 verified (${data.length} bytes), not installed`;
  mkdirSync(dest, { recursive: true });
  const target = join(dest, spec.binary);
  if (spec.archive === 'none') {
    writeFileSync(target, data);
  } else if (spec.archive === 'tar.gz') {
    const work = mkdtempSync(join(tmpdir(), 'ci-tool-'));
    try {
      const archive = join(work, 'a.tar.gz');
      writeFileSync(archive, data);
      execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'pipe' });
      const bin = findFile(work, spec.binary);
      if (!bin) throw new Error(`${name}: binary "${spec.binary}" not found inside the archive`);
      copyFileSync(bin, target);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } else throw new Error(`${name}: unknown archive type "${spec.archive}"`);
  chmodSync(target, 0o755);
  return `${name} ${spec.version}: installed to ${target}`;
}

runMain(import.meta.url, async (argv) => {
  const { opts, _ } = parseArgs(argv);
  if (_.length === 0) throw new UsageError('name at least one tool');
  const manifestPath = typeof opts.manifest === 'string' ? opts.manifest : join(here, 'tool-versions.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const verifyOnly = opts['verify-only'] === true;
  for (const n of _) if (!manifest.tools[n]) throw new UsageError(`unknown tool "${n}" (known: ${Object.keys(manifest.tools).join(', ')})`);
  if (!verifyOnly && `${process.platform}-${process.arch}` !== manifest.platform) {
    throw new UsageError(`manifest is for ${manifest.platform}, this machine is ${process.platform}-${process.arch}`);
  }
  const dest = resolve(typeof opts.dest === 'string' ? opts.dest : join(process.env.RUNNER_TEMP ?? '.', process.env.RUNNER_TEMP ? 'tool-bin' : '.tool-bin'));
  let failed = false;
  for (const n of _) {
    try {
      console.log(await installTool(n, manifest.tools[n], { dest, verifyOnly }));
    } catch (e) {
      failed = true;
      console.error(`error: ${e.message}`);
    }
  }
  if (!failed && !verifyOnly && process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${dest}\n`);
  return failed ? 1 : 0;
});
