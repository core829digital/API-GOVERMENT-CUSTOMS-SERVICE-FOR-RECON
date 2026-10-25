#!/usr/bin/env node
// Resolves the commit range a CI run is about, from the GitHub event, so every job uses the same base/head:
//   * the path-filter plan (`tools/legal-audit/cli.mjs plan --base --head`), doc-drift, migration-lint, L11 changed-file list.
//
//   node tools/ci/resolve-range.mjs [--git git] [--out range.json] [--changed-out changed.txt]
//
// Reads GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA and the event payload at GITHUB_EVENT_PATH (never interpolated into
// shell). Needs full history (actions/checkout fetch-depth: 0).
//   pull_request   base = merge-base(PR base sha, PR head sha), head = PR head sha            release = false
//   push, branch   base = payload.before when it is a real commit, else head^                 release = false
//   push, tag v*   base = head^ (the released commit's own change set), head = GITHUB_SHA      release = true
//   other events   base = head^ (schedule / workflow_dispatch: the latest commit)              release = false
// A root commit (no parent) uses git's empty tree as base. Writes `base=`, `head=`, `release=` to $GITHUB_OUTPUT when set.
// Why head^ for tags: approvals (L11) are evaluated for the pull request that produced the released commit; every earlier
// PR was gated by its own run on main. Exit: 0 ok, 1 failure.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, runMain, UsageError } from './lib/common.mjs';

const ZERO = /^0+$/;

export function resolveRange({ git = 'git', eventName, ref, sha, payload }) {
  const run = (...args) => execFileSync(git, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tryRun = (...args) => {
    try {
      return run(...args);
    } catch {
      return null;
    }
  };
  const emptyTree = () => execFileSync(git, ['hash-object', '-t', 'tree', '--stdin'], { input: '', encoding: 'utf8' }).trim();
  const parentOrEmpty = (head) => tryRun('rev-parse', '--verify', '--quiet', `${head}^`) ?? emptyTree();
  const isCommit = (s) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s ?? '') && !ZERO.test(s) && tryRun('cat-file', '-e', `${s}^{commit}`) !== null;

  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha ?? '')) throw new UsageError(`GITHUB_SHA is not a full commit id: "${sha}"`);
  const release = typeof ref === 'string' && /^refs\/tags\/v/.test(ref);

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const baseSha = payload?.pull_request?.base?.sha;
    const headSha = payload?.pull_request?.head?.sha;
    if (!isCommit(baseSha) || !isCommit(headSha)) throw new Error('PR base/head commits are not present in the clone: checkout with fetch-depth: 0');
    return { base: run('merge-base', baseSha, headSha), head: headSha, release: false, event: eventName };
  }
  if (eventName === 'push' && !release) {
    const before = payload?.before;
    return { base: isCommit(before) ? before : parentOrEmpty(sha), head: sha, release: false, event: eventName };
  }
  return { base: parentOrEmpty(sha), head: sha, release, event: eventName };
}

runMain(import.meta.url, (argv) => {
  const { opts } = parseArgs(argv);
  const git = typeof opts.git === 'string' ? opts.git : 'git';
  const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const r = resolveRange({ git, eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, payload });
  console.log(JSON.stringify(r));
  if (typeof opts.out === 'string') writeFileSync(opts.out, `${JSON.stringify(r, null, 2)}\n`);
  if (typeof opts['changed-out'] === 'string') {
    const names = execFileSync(git, ['diff', '--name-only', '--no-renames', r.base, r.head], { encoding: 'utf8' });
    writeFileSync(opts['changed-out'], names);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${r.base}\nhead=${r.head}\nrelease=${r.release}\n`);
  return 0;
});
