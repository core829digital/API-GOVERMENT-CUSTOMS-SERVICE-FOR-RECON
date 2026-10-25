#!/usr/bin/env node
// Local development helper: runs TWO PostgreSQL 18 clusters (W and R) for the W/R architecture.
//   node tools/dev/pg-pair.mjs start|stop|reset|status
// Env: PG_BIN   directory containing initdb/pg_ctl/psql (default: use PATH)
//      PG_PAIR_DIR data directory root (default: ./.dev/pg)
//      PG_PAIR_PORT_W / PG_PAIR_PORT_R  ports (default 5440 / 5441); lets several pairs run side by side
// Ports: W=5440 (db recon_w), R=5441 (db recon_r). Superuser `postgres`, trust auth, localhost only.
// This is a DEV tool: trust auth, no TLS. Never use for anything but local development.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BIN = process.env.PG_BIN ? process.env.PG_BIN : '';
const ROOT = resolve(process.env.PG_PAIR_DIR ?? '.dev/pg');
const exe = (n) => (BIN ? join(BIN, process.platform === 'win32' ? `${n}.exe` : n) : n);
const PORT_W = Number(process.env.PG_PAIR_PORT_W ?? 5440);
const PORT_R = Number(process.env.PG_PAIR_PORT_R ?? 5441);
if (![PORT_W, PORT_R].every((p) => Number.isInteger(p) && p > 0 && p < 65536)) throw new Error('invalid PG_PAIR_PORT_W / PG_PAIR_PORT_R');
const nodes = [
  { name: 'w', port: PORT_W, db: 'recon_w', conf: ['wal_level = logical', 'max_replication_slots = 10', 'max_wal_senders = 10'] },
  { name: 'r', port: PORT_R, db: 'recon_r', conf: ['max_logical_replication_workers = 8'] },
];
const dir = (n) => join(ROOT, n.name);

function run(cmd, args, opts = {}) {
  // stdio is fully ignored for pg_ctl start: the server inherits handles, and piped stdio would hang the caller (observed on Windows).
  const r = spawnSync(exe(cmd), args, { encoding: 'utf8', stdio: opts.ignore ? 'ignore' : 'pipe' });
  if (r.error) throw r.error;
  return r;
}
function mustRun(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r;
}
const isRunning = (n) => run('pg_ctl', ['status', '-D', dir(n)]).status === 0;

function init(n) {
  if (existsSync(join(dir(n), 'PG_VERSION'))) return;
  mkdirSync(dir(n), { recursive: true });
  mustRun('initdb', ['-D', dir(n), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  appendFileSync(join(dir(n), 'postgresql.conf'), `\nport = ${n.port}\nlisten_addresses = 'localhost'\n${n.conf.join('\n')}\n`);
}
function start(n) {
  init(n);
  if (!isRunning(n)) mustRun('pg_ctl', ['-D', dir(n), '-l', join(ROOT, `${n.name}.log`), '-w', 'start'], { ignore: true });
  const have = mustRun('psql', ['-h', 'localhost', '-p', String(n.port), '-U', 'postgres', '-d', 'postgres', '-Atc', `select 1 from pg_database where datname='${n.db}'`]).stdout.trim();
  if (have !== '1') mustRun('psql', ['-h', 'localhost', '-p', String(n.port), '-U', 'postgres', '-d', 'postgres', '-c', `create database ${n.db}`]);
}
function stop(n) {
  if (existsSync(join(dir(n), 'PG_VERSION')) && isRunning(n)) mustRun('pg_ctl', ['-D', dir(n), '-m', 'fast', '-w', 'stop'], { ignore: true });
}

const cmd = process.argv[2];
if (cmd === 'start') { nodes.forEach(start); console.log(`W postgres://postgres@localhost:${PORT_W}/recon_w\nR postgres://postgres@localhost:${PORT_R}/recon_r`); }
else if (cmd === 'stop') { nodes.forEach(stop); console.log('stopped'); }
else if (cmd === 'reset') { nodes.forEach(stop); rmSync(ROOT, { recursive: true, force: true }); nodes.forEach(start); console.log('reset: fresh W and R'); }
else if (cmd === 'status') { nodes.forEach((n) => console.log(n.name, isRunning(n) ? 'running' : 'stopped', `port ${n.port}`)); }
else { console.error('usage: pg-pair.mjs start|stop|reset|status'); process.exit(2); }
