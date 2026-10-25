// Thin git wrapper for the gates and the path-filter plan. All calls go through lib/exec.mjs (no shell).
import { describeFailure, resolveBinary, run } from './exec.mjs';

const ZERO_SHA = /^0{7,64}$/;

export function gitBinary(opts = {}) {
  return resolveBinary('git', { explicit: opts.git, envVar: 'LEGAL_AUDIT_GIT' });
}

/** Run `git <args>` in `cwd`. Throws with a readable message when git is missing or the command fails. */
export async function git(cwd, args, opts = {}) {
  const bin = gitBinary(opts);
  if (!bin) throw new Error('git executable not found (set --git <path> or LEGAL_AUDIT_GIT, or put git on PATH)');
  // quotepath off: report real file names; no pager / prompts in CI.
  const r = await run(bin, ['-c', 'core.quotepath=off', ...args], {
    cwd,
    timeoutMs: 120_000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${describeFailure(r)}`);
  return r.stdout;
}

export async function isGitRepo(cwd, opts = {}) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'], opts)).trim() === 'true';
  } catch {
    return false;
  }
}

export const isZeroSha = (sha) => typeof sha === 'string' && ZERO_SHA.test(sha);

/**
 * Files that differ between two commits. Renames are reported as delete + add so both the old and the new path
 * count as changed (a path filter must see the file that disappeared too).
 * @returns {Promise<string[]>} forward-slash paths relative to the repository top level, sorted, unique
 */
export async function changedFiles(cwd, base, head, opts = {}) {
  const out = await git(cwd, ['diff', '--name-only', '--no-renames', '-z', base, head, '--'], opts);
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

export async function revParse(cwd, rev, opts = {}) {
  return (await git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`], opts)).trim();
}
