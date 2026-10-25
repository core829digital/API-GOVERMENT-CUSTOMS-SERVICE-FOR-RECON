#!/usr/bin/env node
// Conventional Commits lint (R-GEN-3; Workflow.md §1: squash merge, Conventional Commits).
//
//   node tools/ci/commit-lint.mjs --message "feat(api): add findings endpoint"      # PR title = the squash commit header
//   node tools/ci/commit-lint.mjs --message-file path/to/message.txt
//   node tools/ci/commit-lint.mjs --range <base>..<head> [--git git]               # every commit in the range (git log)
//
// Header: <type>[(scope)][!]: <description>, type in feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert, scope
// lowercase [a-z0-9._/-]+, description non-empty, header <= 100 characters. A blank line must follow the header when a body
// exists. `git revert`'s default header (Revert "<original header>") is accepted. Merge commits (linear history) and
// fixup!/squash!/amend! commits are rejected in --range mode. Signature verification is NOT done here: CI asks the GitHub API
// (commit.verification.verified) because verifying needs the signer's keys.
// Exit: 0 clean, 1 findings, 2 usage error.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { finding, parseArgs, report, runMain, UsageError } from './lib/common.mjs';

export const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?(!)?: (\\S.*)$`);
const MAX_HEADER = 100;

/** Problems with one commit message (empty array = valid). */
export function lintMessage(message) {
  const problems = [];
  const lines = message.replace(/\r\n/g, '\n').replace(/^\n+/, '').split('\n');
  const header = (lines[0] ?? '').trimEnd();
  if (header === '') return ['empty commit message'];
  if (/^(?:fixup|squash|amend)! /.test(header)) return [`"${header.split(' ')[0]}" commits must be squashed before merge`];
  if (/^Revert ".+"$/.test(header)) return problems;
  const m = HEADER.exec(header);
  if (!m) {
    problems.push(`header must be "<type>[(scope)][!]: <description>" with type one of ${TYPES.join(', ')} (found: "${header.slice(0, 70)}")`);
  }
  if (header.length > MAX_HEADER) problems.push(`header is ${header.length} characters, the limit is ${MAX_HEADER}`);
  if (lines.length > 1 && lines[1].trim() !== '') problems.push('the line after the header must be blank');
  return problems;
}

function commitsInRange(range, git) {
  if (!/^[\w./~^@{}-]+\.\.\.?[\w./~^@{}-]+$/.test(range)) throw new UsageError(`--range must look like <base>..<head>, got "${range}"`);
  const raw = execFileSync(git, ['log', '--format=%H%x1f%P%x1f%B%x1e', range], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim() !== '')
    .map((r) => {
      const [sha, parents, ...body] = r.split('\x1f');
      return { sha, parents: parents.split(' ').filter(Boolean), message: body.join('\x1f') };
    });
}

export function lintCommits(commits) {
  const findings = [];
  for (const c of commits) {
    const id = c.sha.slice(0, 12);
    if (c.parents.length > 1) findings.push(finding(id, 'merge commit: history must be linear (rebase or squash)'));
    for (const p of lintMessage(c.message)) findings.push(finding(id, p));
  }
  return findings;
}

runMain(import.meta.url, (argv) => {
  const { opts } = parseArgs(argv);
  const sources = ['message', 'message-file', 'range'].filter((k) => opts[k] !== undefined);
  if (sources.length !== 1) throw new UsageError('give exactly one of --message, --message-file, --range');
  if (opts.message !== undefined) {
    if (typeof opts.message !== 'string') throw new UsageError('--message needs a value');
    return report('commit-lint', lintMessage(opts.message).map((p) => finding('message', p)));
  }
  if (opts['message-file'] !== undefined) {
    if (typeof opts['message-file'] !== 'string') throw new UsageError('--message-file needs a path');
    return report('commit-lint', lintMessage(readFileSync(opts['message-file'], 'utf8')).map((p) => finding(opts['message-file'], p)));
  }
  if (typeof opts.range !== 'string') throw new UsageError('--range needs a value');
  const commits = commitsInRange(opts.range, typeof opts.git === 'string' ? opts.git : 'git');
  return report('commit-lint', lintCommits(commits), [`${commits.length} commit(s) checked`]);
});
