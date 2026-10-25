// Minimal argv parser: `--key value`, `--key=value`, `--flag`. Repeated keys become arrays. Positionals are returned
// in `_`. A bare `--flag` followed by another `--x` or end of input is `true`.
export function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
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
    if (key in opts) opts[key] = [].concat(opts[key], value);
    else opts[key] = value;
  }
  return { opts, _: positional };
}

export const asArray = (v) => (v === undefined ? [] : [].concat(v));
