#!/usr/bin/env node
// One command for the whole local development stack.
//
//   node tools/dev/dev-up.mjs [up] [--no-demo] [--no-web] [--reset]   start everything, stream logs, Ctrl+C stops it
//   node tools/dev/dev-up.mjs down                                    stop leftover services and the two databases
//   node tools/dev/dev-up.mjs status                                  what is listening
//
// What "everything" is (each piece is explained in CLAUDE.md > Commands):
//   1. databases W and R (tools/dev/pg-pair.mjs), migrated and connected by logical replication on first run
//   2. non-superuser login roles, one tenant and one API key (kept in .dev/dev-state.json, gitignored)
//   3. the API, the dev-only identity provider, the engine worker and the Next.js frontend
//   4. unless --no-demo: a SYNTHETIC rule pack, synthetic batches and one queued run, so the console shows findings
//
// Environment (all optional): PG_BIN (directory with pg_ctl/psql; auto-detected), DEV_DIR (default .dev),
// DEV_PORT_W 5440, DEV_PORT_R 5441, DEV_PORT_API 8080, DEV_PORT_IDP 9443, DEV_PORT_WEB 3000.
// DEV TOOL ONLY: trust authentication, a mock identity provider that signs anyone in, a self-signed certificate.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const port = (name, dflt) => {
  const v = Number(process.env[name] ?? dflt);
  if (!Number.isInteger(v) || v < 1 || v > 65535) fail(`${name} must be a port number`);
  return v;
};
const P = {
  w: port('DEV_PORT_W', 5440),
  r: port('DEV_PORT_R', 5441),
  api: port('DEV_PORT_API', 8080),
  idp: port('DEV_PORT_IDP', 9443),
  web: port('DEV_PORT_WEB', 3000),
};
const DEV = resolve(REPO, process.env.DEV_DIR ?? '.dev');
const STATE = join(DEV, 'dev-state.json');
const PIDS = join(DEV, 'dev-pids.json');
const TARGET = join(REPO, 'target', 'debug');
const bin = (n) => join(TARGET, n + EXE);
const W_SUPER = `postgres://postgres@localhost:${P.w}/recon_w`;
const R_SUPER = `postgres://postgres@localhost:${P.r}/recon_r`;
const SCOPES = ['batches:write', 'batches:read', 'findings:read', 'runs:write', 'runs:read'];

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'up';
const flag = (n) => args.includes(`--${n}`);

function fail(msg) {
  console.error(`\nerror: ${msg}`);
  process.exit(1);
}
const step = (msg) => console.log(`\n\x1b[1m> ${msg}\x1b[0m`);

// ------------------------------------------------------------------ helpers
function findPgBin() {
  const exe = (d) => join(d, `pg_ctl${EXE}`);
  const candidates = [
    process.env.PG_BIN,
    ...(process.env.PATH ?? '').split(WIN ? ';' : ':'),
    WIN && join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Temp', 'pg', 'pgsql', 'bin'),
    WIN && 'C:/Program Files/PostgreSQL/18/bin',
    !WIN && '/usr/lib/postgresql/18/bin',
    !WIN && '/opt/homebrew/opt/postgresql@18/bin',
  ].filter(Boolean);
  const hit = candidates.find((d) => existsSync(exe(d)));
  if (!hit) fail('PostgreSQL 18 binaries not found. Install PostgreSQL 18 and set PG_BIN to its bin directory.');
  return hit;
}

function run(file, argv, opts = {}) {
  const r = spawnSync(file, argv, { encoding: 'utf8', cwd: REPO, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${file} ${argv.join(' ')} exited ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

const PG_BIN = cmd === 'up' || cmd === 'down' ? findPgBin() : '';
const psql = (portNo, db, sql) =>
  run(join(PG_BIN, `psql${EXE}`), ['-h', 'localhost', '-p', String(portNo), '-U', 'postgres', '-d', db, '-X', '-Atq', '-c', sql]).trim();
const pgPair = (sub) =>
  run(process.execPath, [join(REPO, 'tools/dev/pg-pair.mjs'), sub], {
    env: { ...process.env, PG_BIN, PG_PAIR_DIR: join(DEV, 'pg'), PG_PAIR_PORT_W: String(P.w), PG_PAIR_PORT_R: String(P.r) },
  });

function listening(portNo, host = '127.0.0.1') {
  return new Promise((ok) => {
    const s = net.connect({ port: portNo, host });
    s.once('connect', () => (s.destroy(), ok(true)));
    s.once('error', () => ok(false));
    s.setTimeout(1000, () => (s.destroy(), ok(false)));
  });
}

async function waitFor(label, probe, seconds = 120) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  fail(`${label} did not become ready within ${seconds}s`);
}

const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const writeState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

function killTree(pid) {
  try {
    if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

// ------------------------------------------------------------------ child processes with prefixed logs
const children = [];
const COLORS = { api: 36, engine: 35, idp: 33, web: 32 };

function launch(name, file, argv, env, opts = {}) {
  const child = spawn(file, argv, {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: opts.shell ?? false,
    detached: !WIN,
    windowsHide: true,
  });
  const tag = `\x1b[${COLORS[name] ?? 37}m[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) console.log(tag + l);
    });
  }
  child.on('exit', (code) => {
    if (!stopping) console.log(`${tag}exited with code ${code}`);
  });
  children.push({ name, child });
  writeFileSync(PIDS, JSON.stringify(children.map((c) => ({ name: c.name, pid: c.child.pid }))));
  return child;
}

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\nstopping services (the databases keep running; `node tools/dev/dev-up.mjs down` stops them)');
  for (const { child } of children) killTree(child.pid);
  rmSync(PIDS, { force: true });
  setTimeout(() => process.exit(code), 500);
}

// ------------------------------------------------------------------ commands
async function status() {
  for (const [name, p] of Object.entries(P)) console.log(`${name.padEnd(4)} :${p}  ${(await listening(p)) ? 'listening' : 'not listening'}`);
}

async function down() {
  if (existsSync(PIDS)) {
    for (const { name, pid } of JSON.parse(readFileSync(PIDS, 'utf8'))) {
      console.log(`stopping ${name} (pid ${pid})`);
      killTree(pid);
    }
    rmSync(PIDS, { force: true });
  }
  pgPair('stop');
  console.log('databases stopped');
}

function ensureRoles() {
  const mk = (portNo, db, login, group) =>
    psql(portNo, db, `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${login}') THEN CREATE ROLE ${login} LOGIN IN ROLE ${group}; END IF; END $$;`);
  mk(P.w, 'recon_w', 'dev_w_admin', 'w_admin');
  mk(P.w, 'recon_w', 'dev_w_cmd', 'w_cmd');
  mk(P.w, 'recon_w', 'dev_w_worker', 'w_worker');
  mk(P.r, 'recon_r', 'dev_r_api', 'r_api');
}

function migrate() {
  const hasVector = psql(P.r, 'recon_r', "SELECT count(*) FROM pg_available_extensions WHERE name='vector'") !== '0';
  if (!hasVector) console.log('  pgvector is not installed: migrating R up to 0005 (vector search migrations skipped)');
  const base = ['--dir', join(REPO, 'migrations')];
  run(bin('recon-migrate'), ['up', '--target', 'r', '--url', R_SUPER, ...base, ...(hasVector ? [] : ['--to', '0005'])]);
  run(bin('recon-migrate'), ['up', '--target', 'w', '--url', W_SUPER, ...base]);
  run(bin('recon-migrate'), ['subscribe', '--r-url', R_SUPER, '--w-conninfo', `host=localhost port=${P.w} dbname=recon_w user=postgres`]);
}

const tenantExists = (id) => psql(P.w, 'recon_w', `SELECT count(*) FROM core.tenant WHERE id='${id}'`) === '1';

function issueKey(tenant) {
  const out = run(bin('recon-admin'), ['issue-api-key', '--tenant', tenant, ...SCOPES.flatMap((s) => ['--scope', s])], {
    env: { ...process.env, RECON_W_URL: `postgres://dev_w_cmd@localhost:${P.w}/recon_w` },
  });
  const token = out.match(/rk_[0-9a-f]{16}_[0-9a-f]{64}/)?.[0];
  if (!token) throw new Error('recon-admin did not print an API token');
  return token;
}

async function tokenWorks(token) {
  try {
    const r = await fetch(`http://127.0.0.1:${P.api}/v1/findings?limit=1`, { headers: { authorization: `Bearer ${token}` } });
    return r.status === 200;
  } catch {
    return false;
  }
}

async function seedDemo(state, token) {
  if (state.demo && tenantExists(state.tenantId)) return state.demo;
  psql(P.w, 'recon_w', 'SELECT 1'); // fail early if W is unreachable
  run(join(PG_BIN, `psql${EXE}`), ['-h', 'localhost', '-p', String(P.w), '-U', 'postgres', '-d', 'recon_w', '-X', '-q', '-f', join(REPO, 'tools/dev/seed-synthetic-pack.sql')], { stdio: 'pipe' });
  const packId = psql(P.w, 'recon_w', "SELECT id FROM rules.rule_pack WHERE name='synthetic-fixture' AND jurisdiction='XX' AND version='0.0.0'");
  const out = run(bin('recon-dev-seed'), ['--tenant', state.tenantId], { env: { ...process.env, RECON_W_URL: `postgres://dev_w_cmd@localhost:${P.w}/recon_w` } });
  const erp = out.match(/erp_batch=([0-9a-f-]{36})/)?.[1];
  const authority = out.match(/authority_batch=([0-9a-f-]{36})/)?.[1];
  if (!packId || !erp || !authority) throw new Error('demo seeding did not return the expected ids');
  const res = await fetch(`http://127.0.0.1:${P.api}/v1/recon/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `demo-${state.tenantId}` },
    body: JSON.stringify({ rule_pack_id: packId, batch_ids: [erp, authority] }),
  });
  if (res.status !== 202) throw new Error(`queueing the demo run failed: HTTP ${res.status} ${await res.text()}`);
  return { packId, batchIds: [erp, authority], runId: (await res.json()).id };
}

async function up() {
  for (const [name, p] of Object.entries(P)) {
    if (name === 'w' || name === 'r') continue;
    if (name === 'web' && flag('no-web')) continue;
    if (await listening(p)) fail(`port ${p} (${name}) is already in use. Is another stack running? Try: node tools/dev/dev-up.mjs down`);
  }
  mkdirSync(DEV, { recursive: true });
  if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) fail('Rust (cargo) is not installed or not on PATH');
  if (!flag('no-web') && !existsSync(join(REPO, 'frontend', 'node_modules'))) fail('frontend dependencies are missing: run `npm ci` in frontend/');

  if (flag('reset')) {
    step('resetting databases and dev state');
    pgPair('stop');
    rmSync(STATE, { force: true });
    pgPair('reset');
  }

  step('building Rust binaries (first build takes a few minutes)');
  run('cargo', ['build', '-q', '-p', 'recon-api', '-p', 'recon-migrate', '-p', 'recon-engine'], { stdio: 'inherit' });

  step(`starting databases W :${P.w} and R :${P.r}`);
  pgPair('start');
  const fresh = psql(P.w, 'recon_w', "SELECT to_regclass('core.tenant') IS NULL");
  step(fresh === 't' ? 'first run: migrating both databases and creating the replication subscription' : 'applying pending migrations');
  migrate();
  ensureRoles();

  let state = readState();
  if (!state.tenantId || !tenantExists(state.tenantId)) {
    step('creating the dev tenant');
    const out = run(bin('recon-admin'), ['create-tenant', '--name', 'Dev Tenant'], { env: { ...process.env, RECON_ADMIN_W_URL: `postgres://dev_w_admin@localhost:${P.w}/recon_w` } });
    const id = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    if (!id) throw new Error('recon-admin did not print a tenant id');
    state = { tenantId: id, sessionSecret: state.sessionSecret };
  }
  state.sessionSecret ??= randomBytes(32).toString('base64url');
  writeState(state);

  step(`starting the API on :${P.api}`);
  const apiEnv = { RECON_W_URL: `postgres://dev_w_cmd@localhost:${P.w}/recon_w`, RECON_R_URL: `postgres://dev_r_api@localhost:${P.r}/recon_r`, RECON_BIND: `127.0.0.1:${P.api}` };
  launch('api', bin('recon-api'), [], apiEnv);
  await waitFor('the API', async () => (await fetch(`http://127.0.0.1:${P.api}/readyz`).then((r) => r.ok, () => false)));

  if (!state.token || !(await tokenWorks(state.token))) {
    step('issuing an API key for the dev tenant');
    state.token = issueKey(state.tenantId);
    writeState(state);
  }
  if (!flag('no-demo')) {
    if (!state.demo) step('loading the SYNTHETIC demo data set (a fixture rule pack, two batches, one queued run)');
    state.demo = await seedDemo(state, state.token);
    writeState(state);
  }

  step('starting the engine worker');
  launch('engine', bin('recon-engine'), [], { RECON_W_URL: `postgres://dev_w_worker@localhost:${P.w}/recon_w`, RECON_R_URL: apiEnv.RECON_R_URL });

  if (!flag('no-web')) {
    const appBase = `http://localhost:${P.web}`;
    step(`starting the dev identity provider on :${P.idp}`);
    launch('idp', process.execPath, [join(REPO, 'tools/dev/dev-idp.mjs')], { RECON_DEV_API_TOKEN: state.token, DEV_IDP_PORT: String(P.idp), APP_BASE_URL: appBase });
    await waitFor('the identity provider', () => listening(P.idp));
    const cert = join(DEV, 'idp', 'cert.pem');
    await waitFor('the identity provider certificate', () => existsSync(cert));

    step(`starting the frontend on :${P.web}`);
    launch(
      'web',
      process.execPath,
      [join(REPO, 'frontend', 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--port', String(P.web)],
      {
        NODE_EXTRA_CA_CERTS: cert,
        OIDC_ISSUER: `https://localhost:${P.idp}`,
        OIDC_CLIENT_ID: 'recon-web',
        APP_BASE_URL: appBase,
        RECON_API_BASE_URL: `http://127.0.0.1:${P.api}`,
        SESSION_SECRET: state.sessionSecret,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      { cwd: join(REPO, 'frontend') },
    );
    await waitFor('the frontend', () => listening(P.web, '127.0.0.1').then((ok) => ok || listening(P.web, '::1')), 180);
    // The IdP uses a self-signed certificate; the browser asks once. Probe it so a broken IdP shows up here.
    await waitFor('the identity provider TLS endpoint', () => new Promise((ok) => {
      const s = tls.connect({ port: P.idp, host: 'localhost', rejectUnauthorized: false }, () => (s.destroy(), ok(true)));
      s.once('error', () => ok(false));
    }), 20);
  }

  console.log(`
\x1b[1m==================== dev stack is up ====================\x1b[0m
  ${flag('no-web') ? `API         http://127.0.0.1:${P.api}   (readyz: /readyz)` : `Website     http://localhost:${P.web}\n  Console     http://localhost:${P.web}/overview   (sign in: the dev identity provider lets anyone in)\n  API         http://127.0.0.1:${P.api}`}
  Databases   W postgres://postgres@localhost:${P.w}/recon_w   R postgres://postgres@localhost:${P.r}/recon_r
  Tenant      ${state.tenantId}
  API key     in ${STATE} (gitignored)
  Demo data   ${flag('no-demo') ? 'skipped (--no-demo)' : 'SYNTHETIC fixture; findings appear once the engine has processed the queued run'}
  ${flag('no-web') ? '' : `First sign-in: your browser warns about the self-signed certificate of https://localhost:${P.idp}. Accept it once.`}
  Ctrl+C stops the services. \`node tools/dev/dev-up.mjs down\` also stops the databases.
`);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

try {
  if (cmd === 'status') await status();
  else if (cmd === 'down') await down();
  else if (cmd === 'up') await up();
  else fail(`unknown command "${cmd}". Use: up | down | status`);
} catch (e) {
  console.error(`\nerror: ${e.message}`);
  stopAll(1);
}
