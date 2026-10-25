# Database network access (infra/postgres)

Who may open a connection to the recon databases. Status: **a template, not deployed.** The hosting provider is
undecided (Progress.md D-2), so nothing here names a cloud product; no cluster in this repository applies this file
yet (the dev databases of `tools/dev/pg-pair.mjs` use `trust` authentication on localhost and are for development
only).

## Layers (all of them, not one of them)

1. **Network allowlist at the provider** (firewall / security group / network policy): only the CIDRs of the machines
   that run recon services may reach the database port. Whatever the provider calls it, the rule is the same list as
   the `{{...}}_CIDR` placeholders below. This stops packets before Postgres sees them.
2. **`pg_hba.conf`** (`pg_hba.conf.template`): Postgres re-checks the source address, requires TLS (`hostssl`), the
   authentication method (`scram-sha-256`, plus a client certificate), and binds each *role* to the *database* and
   *network* it is meant for. The two layers are independent on purpose: a mistake in one (a too-wide security group, a
   stale `pg_hba` line) does not by itself open the database.
3. **Roles and grants** (`migrations/w/0005_roles.sql`, `migrations/r/0005_roles.sql`, DatabaseInfo.md §6): even a
   connection that gets through can do only what its group role may do; application roles have no DDL and no
   `TRUNCATE` (R-DB-12); tenant isolation by RLS (R-SEC-3).
4. **TLS with verification on the client**: every connection string used by the API, the engine, `recon-migrate` and
   the subscription uses `sslmode=verify-full` with `sslrootcert` pointing at the CA that signed the server
   certificate (R-SEC-1). `verify-full` checks the certificate chain *and* that the host name matches, so a
   connection cannot be silently redirected to another server by DNS or routing tricks. `sslmode=require` or
   weaker is not accepted anywhere.

## Using the template

`pg_hba.conf.template` contains a W block and an R block. On each cluster: copy it, delete the other cluster's block,
replace the placeholders, keep one line per CIDR, and keep the final `reject` lines last (first match wins).

| Placeholder | Meaning |
|---|---|
| `{{API_CIDR}}` | networks running `recon-api` (command role `w_cmd` on W, query role `r_api` on R) |
| `{{WORKER_CIDR}}` | networks running the engine worker, anchoring and verification jobs |
| `{{OPS_CIDR}}` | migration job and operator bastion (`w_admin`, `w_migrator`, `r_migrator`) |
| `{{R_CIDR}}` | the address of cluster R and nothing else |
| `{{REPL_ROLE}}` | the replication login role (`repl_r` in DatabaseInfo.md §5-6) |

Server side (postgresql.conf): `ssl = on`, `ssl_min_protocol_version = 'TLSv1.3'`, `ssl_cert_file`, `ssl_key_file`,
`ssl_ca_file` (the CA that signs client certificates), `password_encryption = scram-sha-256`, and
`listen_addresses` limited to the private interface (never `*` on a public interface). The `postgres` superuser is
refused over the network by the first lines of the template.

`+w_cmd` style entries match every member of that group role. The deployment creates login roles (for example one per
service) and grants them the group; the template does not need to know their names.

## Replication (R subscribes to W)

R pulls from W with a logical-replication subscription (DatabaseInfo.md §5). The subscription worker on R opens an
ordinary connection to the database `recon_w` as the replication login role, so the pg_hba line is
`hostssl recon_w {{REPL_ROLE}} {{R_CIDR}} ...` (the keyword `replication` in the DATABASE column only matches
*physical* replication, which this design does not use unless an operator adds standbys explicitly). That line is the
only way in for the replication role, and its address is **R's address only**: nothing else can use the replication
credentials even if they leak, and R itself exposes no inbound replication line. Create the subscription with a
connection string that carries `sslmode=verify-full&sslrootcert=...` (recon-migrate's `subscribe` takes it from
`RECON_W_CONNINFO`, and the Helm migrate job already sets `sslmode=verify-full`).

## What this does not cover

* Cloud-specific rule syntax (undecided provider, D-2).
* Certificate issuance and rotation for server and client certificates (a platform decision; the template only
  requires that a CA exists).
* The tools under `tools/dev/`, which deliberately do none of this.
* Nothing here has been run against a real hardened cluster: the template was reviewed against the role migrations
  and the replication description, not exercised end to end.

## Why not just the firewall

Cloud firewalls are usually managed by other tooling and other people than the database; they are coarse (IP:port),
and rules accumulate. `pg_hba.conf` is versioned with the application, names the roles, and is the last check before
authentication. Conversely, `pg_hba.conf` alone would still accept TCP connections from anywhere to be refused only
after the handshake, which is a resource-exhaustion surface the provider-level allowlist removes.
