// Shared helpers for tools/ci scripts. Zero dependencies, Node >= 24.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** `--key value`, `--key=value`, `--flag`; repeated keys become arrays; positionals in `_`. */
export function parseArgs(argv) {
  const opts = {};
  const _ = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      _.push(a);
      continue;
    }
    let key = a.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    } else {
      value = true;
    }
    opts[key] = key in opts ? [].concat(opts[key], value) : value;
  }
  return { opts, _ };
}

/** Thrown for usage / environment problems (exit code 2), as opposed to lint findings (exit code 1). */
export class UsageError extends Error {}

export function requireString(opts, key) {
  const v = opts[key];
  if (typeof v !== 'string' || v === '') throw new UsageError(`missing required option --${key} <value>`);
  return v;
}

/** One repo-relative path per line (CRLF tolerated, blank lines and backslashes normalised). */
export function parseFileList(text) {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim().replaceAll('\\', '/')).filter(Boolean))];
}

export function readFileList(path) {
  return parseFileList(readFileSync(path, 'utf8'));
}

export const finding = (file, message, line) => ({ file, line: line ?? null, message });

export function formatFinding(f) {
  return `${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}`;
}

/** Prints findings, returns the process exit code (0 clean, 1 findings). */
export function report(tool, findings, extra = []) {
  for (const note of extra) console.log(`${tool}: note: ${note}`);
  if (findings.length === 0) {
    console.log(`${tool}: OK`);
    return 0;
  }
  for (const f of findings) console.error(formatFinding(f));
  console.error(`${tool}: FAIL (${findings.length} finding${findings.length === 1 ? '' : 's'})`);
  return 1;
}

/** Runs `main(argv)` when the module is the process entry point; maps UsageError to exit code 2. */
export function runMain(metaUrl, main) {
  if (metaUrl !== pathToFileURL(process.argv[1]).href) return;
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then(
      (code) => process.exit(code),
      (e) => {
        console.error(e instanceof UsageError ? `usage error: ${e.message}` : `error: ${e.stack ?? e}`);
        process.exit(e instanceof UsageError ? 2 : 1);
      },
    );
}
