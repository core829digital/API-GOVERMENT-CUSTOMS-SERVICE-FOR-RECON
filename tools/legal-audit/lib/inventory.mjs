// Dependency inventory readers shared by L1 (licences) and L2 (SBOM): `cargo metadata`, Cargo.lock and npm lockfiles.
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, posix } from 'node:path';
import { cargoBinDirs, describeFailure, resolveBinary, run, toolVersion } from './exec.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------------------------------------------

/**
 * `cargo metadata --locked --format-version 1` for the workspace at `root`.
 * @throws {Error} with a readable message when cargo fails (missing Cargo.lock, offline registry, ...)
 */
export async function cargoMetadata(cargoBin, root, { timeoutMs = 300_000 } = {}) {
  const r = await run(cargoBin, ['metadata', '--locked', '--format-version', '1'], { cwd: root, timeoutMs });
  if (r.code !== 0) throw new Error(`cargo metadata --locked failed: ${describeFailure(r)}`);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`cargo metadata produced invalid JSON: ${e.message}`);
  }
}

/**
 * Minimal reader for the Cargo.lock subset we need (`[[package]]` tables with name, version, source, checksum and
 * dependencies). Everything else (`[metadata]`, `[[patch.unused]]`) is ignored.
 * @returns {Array<{name:string, version:string, source:string|null, checksum:string|null, dependencies:string[]}>}
 */
export function parseCargoLock(text) {
  const pkgs = [];
  let cur = null;
  let inDeps = false;
  const strings = (s) => [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '[[package]]') {
      cur = { name: '', version: '', source: null, checksum: null, dependencies: [] };
      pkgs.push(cur);
      inDeps = false;
      continue;
    }
    if (line.startsWith('[')) {
      cur = null;
      inDeps = false;
      continue;
    }
    if (!cur) continue;
    if (inDeps) {
      if (line.startsWith(']')) inDeps = false;
      else cur.dependencies.push(...strings(line));
      continue;
    }
    const m = /^([A-Za-z_-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'dependencies') {
      if (val.startsWith('[') && val.includes(']')) cur.dependencies.push(...strings(val));
      else {
        inDeps = true;
        cur.dependencies.push(...strings(val));
      }
    } else if (['name', 'version', 'source', 'checksum'].includes(key)) {
      cur[key] = strings(val)[0] ?? null;
    }
  }
  return pkgs.filter((p) => p.name && p.version);
}

export function readCargoLock(root) {
  const p = join(root, 'Cargo.lock');
  return existsSync(p) ? parseCargoLock(readFileSync(p, 'utf8')) : null;
}

/** Cargo's legacy `MIT/Apache-2.0` separator means OR; returns the expression with `/` replaced when that is the form. */
export function normaliseCargoLicense(license) {
  if (typeof license !== 'string') return license;
  const t = license.trim();
  if (/^[A-Za-z0-9.+-]+(\/[A-Za-z0-9.+-]+)+$/.test(t)) return t.split('/').join(' OR ');
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------------------------------------------

/** Licence metadata in any of the forms npm has used -> one SPDX-ish string, or null. */
export function normaliseNpmLicense(pkg) {
  const one = (v) => {
    if (typeof v === 'string') return v.trim() || null;
    if (v && typeof v === 'object' && typeof v.type === 'string') return v.type.trim() || null;
    return null;
  };
  if (pkg.license !== undefined && pkg.license !== null) {
    const l = one(pkg.license);
    if (l) return l;
  }
  const many = Array.isArray(pkg.licenses) ? pkg.licenses.map(one).filter(Boolean) : [];
  if (many.length === 1) return many[0];
  if (many.length > 1) return `(${many.join(' OR ')})`;
  return null;
}

/** npm `integrity` (`sha512-<base64>`, possibly several) -> CycloneDX hashes, strongest algorithm first. */
export function integrityHashes(integrity) {
  if (typeof integrity !== 'string') return [];
  const algs = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' };
  const out = [];
  for (const part of integrity.trim().split(/\s+/)) {
    const m = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(part);
    if (m) out.push({ alg: algs[m[1]], content: Buffer.from(m[2], 'base64').toString('hex') });
  }
  const order = ['SHA-512', 'SHA-384', 'SHA-256', 'SHA-1'];
  return out.sort((a, b) => order.indexOf(a.alg) - order.indexOf(b.alg));
}

/**
 * Read an npm lockfile (lockfileVersion 2 or 3) and resolve each package's licence: the installed
 * `node_modules/<pkg>/package.json` wins, the lockfile `license` field is the fallback.
 * @param {string} root repository root
 * @param {string} relLock lockfile path relative to root (e.g. `frontend/package-lock.json`)
 * @returns {{rel:string, lockfileVersion:number, packages:object[]}}
 */
export function readNpmLock(root, relLock) {
  const abs = join(root, relLock);
  const lock = JSON.parse(readFileSync(abs, 'utf8'));
  if (![2, 3].includes(lock.lockfileVersion) || typeof lock.packages !== 'object' || lock.packages === null) {
    throw new Error(`${relLock}: unsupported lockfile (lockfileVersion ${lock.lockfileVersion}); regenerate it with npm >= 7`);
  }
  const dir = posix.dirname(relLock.replaceAll('\\', '/'));
  const packages = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.link === true || !path.includes('node_modules/')) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    let license = null;
    let licenseSource = null;
    const installed = join(root, dir, path, 'package.json');
    if (existsSync(installed)) {
      try {
        license = normaliseNpmLicense(JSON.parse(readFileSync(installed, 'utf8')));
        if (license) licenseSource = 'installed';
      } catch {
        /* unreadable package.json: fall back to the lockfile */
      }
    }
    if (!license) {
      license = normaliseNpmLicense(entry);
      if (license) licenseSource = 'lockfile';
    }
    packages.push({
      lockfile: relLock,
      path,
      name,
      version: entry.version ?? null,
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      license,
      licenseSource,
      dev: entry.dev === true,
      optional: entry.optional === true,
      dependencies: { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) },
    });
  }
  const rootEntry = lock.packages[''] ?? {};
  const rootDependencies = Object.keys({ ...rootEntry.dependencies, ...rootEntry.devDependencies, ...rootEntry.optionalDependencies });
  return { rel: relLock, lockfileVersion: lock.lockfileVersion, packages, rootDependencies };
}

/** Node resolution: the lock path of the package that satisfies dependency `dep` of the package at `fromPath`. */
export function resolveNpmDependency(pathSet, fromPath, dep) {
  let base = fromPath;
  for (;;) {
    const candidate = `${base}/node_modules/${dep}`.replace(/^\//, '');
    if (pathSet.has(candidate)) return candidate;
    const idx = base.lastIndexOf('/node_modules/');
    if (idx < 0) {
      const top = `node_modules/${dep}`;
      return pathSet.has(top) ? top : null;
    }
    base = base.slice(0, idx);
  }
}

/** purl for an npm package (`@scope/name` -> `pkg:npm/%40scope/name@1.2.3`). */
export function npmPurl(name, version) {
  const enc = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${enc}@${version}`;
}

/** purl for a crate; non-crates.io registries carry `repository_url`, git sources `vcs_url`. */
export function cargoPurl(name, version, source) {
  const base = `pkg:cargo/${name}@${version}`;
  if (!source || source.startsWith('registry+https://github.com/rust-lang/crates.io-index') || source.startsWith('sparse+https://index.crates.io/')) return base;
  if (source.startsWith('registry+') || source.startsWith('sparse+')) {
    return `${base}?repository_url=${encodeURIComponent(source.replace(/^(registry|sparse)\+/, ''))}`;
  }
  if (source.startsWith('git+')) return `${base}?vcs_url=${encodeURIComponent(source.slice(4).split('#')[0])}`;
  return base;
}

// ---------------------------------------------------------------------------------------------------------------
// cargo / cargo-deny invocation (L1, L2)
// ---------------------------------------------------------------------------------------------------------------

export const locateCargo = (opts) =>
  resolveBinary('cargo', { explicit: opts.cargo, envVar: 'LEGAL_AUDIT_CARGO', extraDirs: cargoBinDirs() });

/** Environment that lets cargo-deny find `cargo` (it shells out to `cargo metadata`). */
export function cargoEnv(cargoBin) {
  const sep = delimiter;
  return { PATH: `${dirname(cargoBin)}${sep}${process.env.PATH ?? process.env.Path ?? ''}`, CARGO: cargoBin };
}

/**
 * Find cargo-deny: `--cargo-deny <bin>` / LEGAL_AUDIT_CARGO_DENY / `cargo-deny` on PATH or in the cargo bin dir; when
 * none is found and no explicit path was requested, fall back to the `cargo deny` subcommand if cargo knows it.
 * @returns {Promise<{cmd:string, prefix:string[], version:string}|null>}
 */
export async function locateCargoDeny(opts, cargoBin) {
  const bin = resolveBinary('cargo-deny', { explicit: opts['cargo-deny'], envVar: 'LEGAL_AUDIT_CARGO_DENY', extraDirs: cargoBinDirs() });
  if (bin) {
    const version = await toolVersion(bin, ['--version'], { env: cargoBin ? cargoEnv(cargoBin) : undefined });
    return version ? { cmd: bin, prefix: [], version } : null;
  }
  if (opts['cargo-deny'] !== undefined || !cargoBin) return null;
  const version = await toolVersion(cargoBin, ['deny', '--version'], { env: cargoEnv(cargoBin) });
  return version ? { cmd: cargoBin, prefix: ['deny'], version } : null;
}

/**
 * Parse cargo-deny `--format json` output: one JSON object per line on stderr (`type: diagnostic|summary|log`).
 * @returns {{diagnostics: object[], summary: object|null, logs: object[], unparsed: string[]}}
 */
export function parseDenyOutput(text) {
  const diagnostics = [];
  const logs = [];
  const unparsed = [];
  let summary = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      unparsed.push(line);
      continue;
    }
    if (obj.type === 'diagnostic') diagnostics.push(obj.fields);
    else if (obj.type === 'summary') summary = obj.fields;
    else if (obj.type === 'log') logs.push(obj.fields);
    else unparsed.push(line);
  }
  return { diagnostics, summary, logs, unparsed };
}

/**
 * Run `cargo-deny --locked --format json --config <deny.toml> check <which>` in `root`.
 * @returns {Promise<{parsed: ReturnType<typeof parseDenyOutput>, run: import('./exec.mjs').RunResult}>}
 */
export async function runCargoDeny(inv, cargoBin, root, which, { config, extraArgs = [], timeoutMs = 600_000 } = {}) {
  const args = [...inv.prefix, '--locked', '--format', 'json', '--config', config, 'check', ...extraArgs, which];
  const r = await run(inv.cmd, args, { cwd: root, env: cargoEnv(cargoBin), timeoutMs });
  return { parsed: parseDenyOutput(`${r.stderr}\n${r.stdout}`), run: r };
}

