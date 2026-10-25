// Process execution for the legal-audit gates. Never goes through a shell: arguments are passed as an argv array,
// so repository paths, refs and file names cannot be interpreted as shell syntax.
//
//   run(bin, args, opts)        spawn, capture stdout/stderr, enforce a timeout and an output cap
//   resolveBinary(name, opts)   explicit option -> environment variable -> PATH (+ extra dirs); Windows `.exe` aware
//   toolVersion(bin, args)      first non-empty line of `<bin> --version`, or null
//
// `.cmd`/`.bat` shims cannot be spawned without a shell on Windows (Node rejects them), so only real executables
// (`.exe`, `.com`) are resolved there.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const IS_WIN = process.platform === 'win32';
const WIN_EXT = ['.exe', '.com'];
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function withExtensions(base) {
  if (!IS_WIN) return isFile(base) ? base : null;
  if (/\.[A-Za-z0-9]+$/.test(base) && isFile(base)) return base;
  for (const ext of WIN_EXT) if (isFile(base + ext)) return base + ext;
  return null;
}

/** Directories searched after PATH for cargo-installed tools (`cargo`, `cargo-deny`). */
export function cargoBinDirs(env = process.env) {
  const dirs = [];
  if (env.CARGO_HOME) dirs.push(join(env.CARGO_HOME, 'bin'));
  dirs.push(join(homedir(), '.cargo', 'bin'));
  return dirs;
}

/**
 * Locate an executable.
 * @param {string} name        executable base name (`gitleaks`, `cargo-deny`)
 * @param {object} [o]
 * @param {string|true} [o.explicit] value of a `--tool <path>` option. When given the result is that path or null;
 *                                   an explicit choice never silently falls back to another binary.
 * @param {string} [o.envVar]  environment variable holding a path (e.g. LEGAL_AUDIT_GITLEAKS)
 * @param {string[]} [o.extraDirs] searched after PATH
 * @returns {string|null} absolute or as-given path of an existing file
 */
export function resolveBinary(name, { explicit, envVar, extraDirs = [], env = process.env } = {}) {
  const pick = (value) => {
    if (typeof value !== 'string' || value === '') return null;
    const p = isAbsolute(value) || /[\\/]/.test(value) ? resolve(value) : null;
    if (p) return withExtensions(p);
    return searchPath(value, [], env);
  };
  if (explicit !== undefined) return pick(explicit);
  if (envVar && env[envVar]) return pick(env[envVar]);
  return searchPath(name, extraDirs, env);
}

function searchPath(name, extraDirs, env) {
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = [...pathVar.split(delimiter).filter(Boolean), ...extraDirs];
  for (const d of dirs) {
    const hit = withExtensions(join(d, name));
    if (hit) return hit;
  }
  return null;
}

/** Merge `extra` over the process environment; on Windows environment names are case-insensitive (`Path` vs `PATH`). */
export function mergeEnv(extra = {}, base = process.env) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (IS_WIN) {
      for (const existing of Object.keys(out)) if (existing.toLowerCase() === k.toLowerCase()) delete out[existing];
    }
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * @typedef {object} RunResult
 * @property {number|null} code       exit code, null when the process could not start / was killed
 * @property {string|null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} truncated      output cap exceeded (process killed)
 * @property {string|null} spawnError message when the process could not be started
 * @property {number} durationMs
 * @property {string} command         printable command line (redacted)
 */

/**
 * Run a program without a shell.
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [o]
 * @param {string} [o.cwd]
 * @param {Record<string,string|undefined>} [o.env]   merged over process.env
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxBuffer]    bytes captured per stream before the process is killed
 * @param {string} [o.input]        written to stdin
 * @param {(text:string)=>string} [o.redact] applied to stdout, stderr, spawnError and the printable command
 * @returns {Promise<RunResult>}
 */
export function run(bin, args = [], o = {}) {
  const { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, input, redact = (s) => s } = o;
  const started = Date.now();
  const command = redact([bin, ...args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' '));
  return new Promise((resolvePromise) => {
    let child;
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated = false;
    let spawnError = null;
    let settled = false;
    let timer = null;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code,
        signal: signal ?? null,
        stdout: redact(Buffer.concat(out).toString('utf8')),
        stderr: redact(Buffer.concat(err).toString('utf8')),
        timedOut,
        truncated,
        spawnError: spawnError === null ? null : redact(spawnError),
        durationMs: Date.now() - started,
        command,
      });
    };

    try {
      child = spawn(bin, args, {
        cwd,
        env: env ? mergeEnv(env) : process.env,
        shell: false,
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      spawnError = e.message;
      finish(null, null);
      return;
    }

    const kill = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    child.on('error', (e) => {
      spawnError = e.message;
      finish(null, null);
    });
    child.stdout.on('data', (d) => {
      outBytes += d.length;
      if (outBytes > maxBuffer) {
        truncated = true;
        kill();
      } else out.push(d);
    });
    child.stderr.on('data', (d) => {
      errBytes += d.length;
      if (errBytes > maxBuffer) {
        truncated = true;
        kill();
      } else err.push(d);
    });
    child.on('close', (code, signal) => finish(code, signal));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
    }
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** One-line description of a failed run for use in a finding message. */
export function describeFailure(r) {
  if (r.spawnError) return `could not start: ${r.spawnError}`;
  if (r.timedOut) return `timed out after ${Math.round(r.durationMs / 1000)}s`;
  if (r.truncated) return 'output exceeded the capture limit';
  const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
  return `exit code ${r.code}${tail ? `: ${tail.slice(0, 500)}` : ''}`;
}

/** First non-empty line of `<bin> <args>` output (stdout, else stderr) or null when the command fails. */
export async function toolVersion(bin, args = ['--version'], o = {}) {
  const r = await run(bin, args, { timeoutMs: 30_000, ...o });
  if (r.code !== 0) return null;
  const line = (r.stdout || r.stderr).split(/\r?\n/).find((l) => l.trim() !== '');
  return line ? line.trim() : null;
}

export const exists = existsSync;
