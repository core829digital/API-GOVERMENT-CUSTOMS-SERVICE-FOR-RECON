# DatabaseInfo.md

Status: **design, partially validated.** The SQL blocks in §3–§7 were extracted from this file and applied to a fresh PostgreSQL 18.6 pair with logical replication on 2026-10-23; four defects found that way are fixed here (results and gaps: Progress.md §7). **Not validated:** everything involving pgvector (`vector`, `halfvec`, HNSW, `hnsw.iterative_scan` — extension unavailable in the test binaries), failover/slot synchronisation, PgBouncer, performance. The authoritative DDL will live in `migrations/` and is gated by CI. Sizes, timeouts and settings are starting points to tune under load, not recommendations proven here.

Versions: PostgreSQL **18.x**, pgvector **0.8.x** (re-pin at scaffold). Context: Architecture.md §5–6.

---

## 1. Topology

| Cluster | Role | Instances | Authoritative? |
|---|---|---|---|
| **W** (`recon_w`) | The only database that is written by application commands | 3 (3 AZs), quorum sync; + async DR standby in 2nd EU region | **Yes** |
| **R** (`recon_r`) | The only database queried by the API | primary (logical subscriber) + ≥1 hot physical standby | **No** — derived, rebuildable |

PgBouncer in front of each (transaction pooling, `max_prepared_statements` > 0 — requires PgBouncer ≥ 1.21 for sqlx prepared statements; verify in the spike).

### W settings (starting points)
```
wal_level = logical
synchronous_commit = on
synchronous_standby_names = 'ANY 1 (w2, w3)'     # quorum; names set by operator
max_replication_slots = 10
max_wal_senders = 10
sync_replication_slots = on                       # on standbys, for logical slot failover
hot_standby_feedback = on                         # on standbys hosting slots
idle_in_transaction_session_timeout = '30s'
statement_timeout = '15s'                         # per-role overrides for workers
```
### R settings (starting points)
```
max_logical_replication_workers = 8
max_parallel_apply_workers_per_subscription = 4
hot_standby_feedback = off                        # R standbys: prefer replay progress; measure conflicts
max_standby_streaming_delay = '30s'
statement_timeout = '10s'                         # API role
```

## 2. Schemas

| Schema | In W | Replicated to R | In R only | Content |
|---|---|---|---|---|
| `core` | ✓ | ✓ | | tenants, legal entities, counterparties |
| `ingest` | ✓ | ✓ | | batches, source records |
| `recon` | ✓ | ✓ | | runs, findings |
| `rules` | ✓ | ✓ | | rule packs, rules, legal sources/chunks (text) |
| `ledger` | ✓ | ✓ | | audit events, chain heads, anchors |
| `privacy` | ✓ | ✓ (wrapped keys only) | | subject keys, retention, legal holds |
| `ops` | ✓ | ✓ | | fidelity checks |
| `api` | ✓ | **✗** | | idempotency keys, API keys (never leave W) |
| `proj` | | | ✓ | denormalised read models, projector checkpoints |
| `vec` | | | ✓ | embedding model registry, embeddings |
| `fidelity` | | | ✓ | local verifier scratch (range hashes) |

All primary keys are **UUIDv7** (`DEFAULT uuidv7()`); replicated tables have **no sequence-backed defaults** (sequences are not replicated — PG18 docs §29.8). Money: `bigint` minor units + `char(3)` currency; never floating point. Time: `timestamptz`, UTC.

## 3. Data classification (CI-enforced)

Every column in a replicated schema carries a machine-readable comment; CI gate L4 parses the live schema from an ephemeral cluster and **fails on any unclassified column**. It also emits the Art. 30 record-of-processing diff.

```sql
COMMENT ON COLUMN core.legal_entity.vat_id_ct IS
  'class=pii_id;basis=gdpr_6_1_c;retention=tax_record;encrypted=true';
COMMENT ON COLUMN recon.finding.check_code IS
  'class=public;basis=none;retention=tax_record';
```
Classes: `public`, `internal`, `financial`, `pii`, `pii_id`, `secret`. `retention=` references `privacy.retention_policy.data_class`.

## 4. W schema (key tables)

```sql
-- ===== schemas (W). R creates the same replicated schemas except `api`, plus proj, vec, fidelity =====
CREATE SCHEMA core; CREATE SCHEMA ingest; CREATE SCHEMA recon; CREATE SCHEMA rules;
CREATE SCHEMA ledger; CREATE SCHEMA privacy; CREATE SCHEMA ops; CREATE SCHEMA api;

-- ===== core =====
CREATE TABLE core.tenant (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  name          text NOT NULL,
  data_region   text NOT NULL CHECK (data_region IN ('eu')),  -- extendable only via ADR
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- privacy.subject_key is defined here (not under "privacy" below) because core.legal_entity references it
CREATE TABLE privacy.subject_key (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES core.tenant(id),
  wrapped_dek bytea,                       -- wrapped by EU KMS KEK; useless without KMS; NULL once shredded
  kek_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','shredded')),
  shredded_at timestamptz,
  CHECK ((state = 'active') = (wrapped_dek IS NOT NULL))
);

CREATE TABLE core.legal_entity (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES core.tenant(id),
  country       char(2) NOT NULL,
  vat_id_ct     bytea,            -- ciphertext, envelope-encrypted
  vat_id_key_id uuid REFERENCES privacy.subject_key(id),
  vat_id_hmac   bytea,            -- keyed HMAC for exact-match lookups without decryption
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ===== ingest =====
CREATE TABLE ingest.source_batch (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES core.tenant(id),
  source_type   text NOT NULL,                -- 'erp_ledger','kseF_status','vat_return',...
  period_start  date, period_end date,
  object_uri    text NOT NULL,                -- EU object storage
  sha256        bytea NOT NULL CHECK (octet_length(sha256)=32),
  status        text NOT NULL CHECK (status IN ('registered','parsing','parsed','failed')),
  failure_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_type, sha256)     -- same file twice = same batch
);

CREATE TABLE ingest.source_record (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL REFERENCES ingest.source_batch(id),
  record_kind   text NOT NULL,                -- 'invoice','return_box','customs_line',...
  canonical     jsonb NOT NULL,               -- no direct PII; refs to core.*
  record_sha256 bytea NOT NULL CHECK (octet_length(record_sha256)=32),
  UNIQUE (batch_id, record_sha256)
);
CREATE INDEX ON ingest.source_record (tenant_id, record_kind);

-- ===== rules =====
CREATE TABLE rules.rule_pack (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL, jurisdiction text NOT NULL,       -- 'EU','RO','PL',...
  version text NOT NULL,                                -- semver
  content_sha256 bytea NOT NULL,
  valid_from date NOT NULL, valid_to date,
  last_reviewed date NOT NULL, reviewed_by text NOT NULL,
  UNIQUE (name, jurisdiction, version)
);
CREATE TABLE rules.rule (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  pack_id uuid NOT NULL REFERENCES rules.rule_pack(id),
  code text NOT NULL,
  source_ref text NOT NULL,       -- CELEX/ELI or official URL
  article text NOT NULL,
  accessed_on date NOT NULL,
  UNIQUE (pack_id, code)
);   -- NOT NULL on source_ref/article/accessed_on = no uncited rules (Rules R-DOC-1)

CREATE TABLE rules.legal_source (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  jurisdiction text NOT NULL, citation text NOT NULL,
  url text NOT NULL, accessed_on date NOT NULL, language char(2) NOT NULL,
  UNIQUE (citation, language)
);
CREATE TABLE rules.legal_chunk (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  source_id uuid NOT NULL REFERENCES rules.legal_source(id),
  ordinal int NOT NULL, text text NOT NULL,
  text_sha256 bytea NOT NULL,
  UNIQUE (source_id, ordinal)
);

-- ===== recon =====
CREATE TABLE recon.run (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES core.tenant(id),
  rule_pack_id uuid NOT NULL REFERENCES rules.rule_pack(id),
  input_batch_ids uuid[] NOT NULL,
  min_seq bigint NOT NULL,                  -- tenant ledger seq the engine waited for on R (bridge token)
  status text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  started_at timestamptz, finished_at timestamptz
);
CREATE TABLE recon.finding (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES recon.run(id),
  check_code text NOT NULL,                 -- 'C1'..'C8'
  rule_id uuid NOT NULL REFERENCES rules.rule(id),
  severity text NOT NULL CHECK (severity IN ('info','low','medium','high')),
  subject_ref uuid,                         -- opaque; no PII
  input_record_ids uuid[] NOT NULL,
  input_hashes bytea[] NOT NULL,            -- determinism + evidence
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON recon.finding (tenant_id, check_code, severity);

-- ===== ledger (append-only) =====
CREATE TABLE ledger.chain_head (
  tenant_id uuid PRIMARY KEY REFERENCES core.tenant(id),
  last_seq  bigint NOT NULL DEFAULT 0,
  last_hash bytea  NOT NULL DEFAULT decode(repeat('00',32),'hex')
);

CREATE TABLE ledger.audit_event (
  tenant_id      uuid   NOT NULL REFERENCES core.tenant(id),
  seq            bigint NOT NULL,
  id             uuid   NOT NULL DEFAULT uuidv7(),
  event_type     text   NOT NULL,
  actor_type     text   NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  actor_ref      text   NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload        jsonb  NOT NULL,                        -- NO PII; opaque refs only
  payload_sha256 bytea  NOT NULL CHECK (octet_length(payload_sha256)=32),
  prev_hash      bytea  NOT NULL CHECK (octet_length(prev_hash)=32),
  hash           bytea  NOT NULL CHECK (octet_length(hash)=32),
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (id)
);

CREATE TABLE ledger.chain_anchor (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid   NOT NULL,
  to_seq      bigint NOT NULL,
  anchor_hash bytea  NOT NULL CHECK (octet_length(anchor_hash)=32),  -- = audit_event.hash at to_seq
  tst         bytea  NOT NULL,                                       -- RFC 3161 TimeStampToken (DER)
  tsa_name    text   NOT NULL,
  qualified   boolean NOT NULL,
  anchored_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, to_seq) REFERENCES ledger.audit_event(tenant_id, seq)
);

-- Immutability: privileges AND triggers
CREATE FUNCTION ledger.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only (% on %)', TG_OP, TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON ledger.audit_event
  FOR EACH ROW EXECUTE FUNCTION ledger.deny_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON ledger.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.deny_mutation();
CREATE TRIGGER chain_anchor_no_update BEFORE UPDATE OR DELETE ON ledger.chain_anchor
  FOR EACH ROW EXECUTE FUNCTION ledger.deny_mutation();
CREATE TRIGGER chain_anchor_no_truncate BEFORE TRUNCATE ON ledger.chain_anchor
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.deny_mutation();

-- ===== privacy =====
CREATE TABLE privacy.retention_policy (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  jurisdiction text NOT NULL,              -- 'RO','DE',...
  data_class  text NOT NULL,               -- 'tax_record', 'ledger', ...
  retention_months int NOT NULL CHECK (retention_months > 0),
  source_ref text NOT NULL, accessed_on date NOT NULL,
  valid_from date NOT NULL, valid_to date,
  UNIQUE (jurisdiction, data_class, valid_from)
);
CREATE TABLE privacy.legal_hold (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL, scope jsonb NOT NULL,
  reason text NOT NULL, placed_by text NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);

-- ===== ops =====
CREATE TABLE ops.fidelity_check (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  table_name text NOT NULL, kind text NOT NULL CHECK (kind IN ('chain_head','range_hash','schema')),
  range_from text, range_to text,
  w_digest bytea, r_digest bytea,
  verdict text NOT NULL CHECK (verdict IN ('match','mismatch_transient','mismatch_persistent'))
);

-- ===== api (W only, NOT published) =====
CREATE TABLE api.idempotency_key (
  tenant_id uuid NOT NULL, key text NOT NULL,
  request_sha256 bytea NOT NULL,
  response_status int, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE api.api_key (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL, prefix text NOT NULL UNIQUE,
  secret_hash bytea NOT NULL,              -- Argon2id
  scopes text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
```

### 4.1 Ledger append: `ledger.append_event()` (one W transaction, SECURITY DEFINER)

The database — not the application — assigns `seq`, `id`, `occurred_at`, `prev_hash` and computes `hash`. Application roles cannot touch `ledger.chain_head` or insert into `ledger.audit_event` directly, so a compromised or buggy app cannot fork or rewrite a chain.

```sql
-- owned by w_migrator; EXECUTE granted to w_cmd / w_worker; search_path pinned
CREATE FUNCTION ledger.append_event(
  p_tenant uuid, p_event_type text, p_actor_type text, p_actor_ref text,
  p_payload jsonb, p_payload_sha256 bytea          -- sha256(JCS(payload)), RFC 8785, computed by app
) RETURNS TABLE (seq bigint, hash bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
DECLARE h ledger.chain_head%ROWTYPE; v_id uuid := uuidv7(); v_at timestamptz := clock_timestamp(); v_hash bytea;
BEGIN
  SELECT * INTO h FROM ledger.chain_head WHERE tenant_id = p_tenant FOR UPDATE;  -- per-tenant serialisation
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown tenant chain %', p_tenant; END IF;
  v_hash := sha256(
      h.last_hash || uuid_send(p_tenant) || int8send(h.last_seq + 1) || uuid_send(v_id)
   || int4send(octet_length(convert_to(p_event_type,'UTF8'))) || convert_to(p_event_type,'UTF8')
   || int4send(octet_length(convert_to(p_actor_type,'UTF8'))) || convert_to(p_actor_type,'UTF8')
   || int4send(octet_length(convert_to(p_actor_ref ,'UTF8'))) || convert_to(p_actor_ref ,'UTF8')
   || int8send((extract(epoch FROM v_at) * 1000000)::bigint) || p_payload_sha256);
  INSERT INTO ledger.audit_event(tenant_id, seq, id, event_type, actor_type, actor_ref, occurred_at,
                                 payload, payload_sha256, prev_hash, hash)
  VALUES (p_tenant, h.last_seq + 1, v_id, p_event_type, p_actor_type, p_actor_ref, v_at,
          p_payload, p_payload_sha256, h.last_hash, v_hash);
  UPDATE ledger.chain_head SET last_seq = h.last_seq + 1, last_hash = v_hash WHERE tenant_id = p_tenant;
  RETURN QUERY SELECT h.last_seq + 1, v_hash;
END $$;
REVOKE EXECUTE ON FUNCTION ledger.append_event(uuid,text,text,text,jsonb,bytea) FROM PUBLIC;  -- functions are PUBLIC-executable by default
```

- The `FOR UPDATE` on the head row serialises appends **per tenant** and holds until commit, so `seq` commit order equals `seq` order: downstream readers never observe a higher `seq` before a lower one.
- Hash layout (also implemented independently in Rust in `recon-evidence` for the offline verifier, with shared test vectors): `SHA-256(prev_hash ‖ tenant_id[16] ‖ seq[8 BE] ‖ id[16] ‖ (u32 BE len ‖ UTF-8) for event_type, actor_type, actor_ref ‖ occurred_at_unix_micros[8 BE] ‖ payload_sha256)`. Any layout change = new `chain_version` column and a new function.
- The domain change and its ledger event **commit atomically** (same transaction).
- Grants: `w_cmd`/`w_worker` have `EXECUTE` on this function only; no direct privileges on `ledger.chain_head` or `ledger.audit_event` writes. Function body is covered by a unit test that forks attempts (duplicate `seq`, wrong `prev_hash` via direct insert) are rejected.

Throughput note: one tenant's appends are serial. Mitigation: multiple events per transaction (batch), measured in Phase 1.

## 5. Publication / subscription

```sql
-- On W
CREATE PUBLICATION recon_pub FOR TABLES IN SCHEMA core, ingest, recon, rules, ledger, privacy, ops;
-- 'api' schema is intentionally absent.
```
```sql
-- On R (subscription created by a dedicated owner role)
CREATE SUBSCRIPTION recon_r_sub
  CONNECTION 'host=w-rw.internal dbname=recon_w user=repl_r sslmode=verify-full'
  PUBLICATION recon_pub
  WITH (copy_data = true, failover = true, streaming = parallel, origin = none);
```
Notes:
- New tables added to a published schema are not picked up by an existing subscription automatically: after creating them on both sides, run `ALTER SUBSCRIPTION recon_r_sub REFRESH PUBLICATION` (done by `recon-migrate`).
- `TRUNCATE` replicates; mutation is blocked on W for ledger tables by trigger; for other tables truncation is revoked from every application role.
- Replicated tables on R need matching schema, constraints and **replica identity** (all have PKs).
- R's replicated tables are read-only by *privilege* (§6); the subscription owner is the only writer.

## 6. Roles and grants

| Role | Cluster | Can |
|---|---|---|
| `w_cmd` | W | SELECT/INSERT/UPDATE on core, ingest, recon, rules, privacy, api; SELECT on `ledger.audit_event`; EXECUTE `ledger.append_event` only (no direct write to `ledger.*`); **no** DELETE/TRUNCATE; **no** DDL |
| `w_worker` | W | as `w_cmd` plus claim queues (`FOR UPDATE SKIP LOCKED`) |
| `w_anchor` | W | INSERT on `ledger.chain_anchor`; SELECT on `ledger.audit_event` |
| `w_retention` | W | scoped DELETE via `SECURITY DEFINER` purge procedures only (honour legal holds); logged to ledger |
| `w_verifier` | W | SELECT on all replicated schemas; INSERT `ops.fidelity_check` |
| `w_migrator` | W | DDL (used only by `recon-migrate`) |
| `repl_r` | W | REPLICATION; SELECT on published tables |
| `r_sub_owner` | R | owns subscription; sole writer to replicated tables |
| `r_api` | R | SELECT on `proj`, `vec`, and RLS-protected views of replicated tables; **no** write anywhere |
| `r_projector` | R | SELECT on replicated tables; INSERT/UPDATE/DELETE on `proj`, `vec` only |
| `r_verifier` | R | SELECT on replicated tables; write to `fidelity` |
| `r_migrator` | R | DDL |

`REVOKE ALL ON SCHEMA ... FROM PUBLIC` everywhere. There is **no** role that can write R's replicated tables other than `r_sub_owner`, and none that `r_api`-style code can acquire on W for queries.

### 6.1 Row-level security (both clusters)
```sql
ALTER TABLE recon.finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE recon.finding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recon.finding
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```
Applications run `SET LOCAL app.tenant_id = '<uuid>'` inside each transaction (safe with PgBouncer transaction mode). A missing setting must **fail closed** — use `current_setting('app.tenant_id')` without the `missing_ok` flag, so an unset value raises an error, and test it. Subscription apply bypasses RLS (owner/replication path) by design. `rules.*` is global (non-tenant) data.

## 7. R-only schemas

```sql
-- proj
CREATE TABLE proj.checkpoint (
  projector text PRIMARY KEY,
  tenant_id uuid NOT NULL, last_seq bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);  -- (projector, tenant_id) composite in the real DDL
CREATE TABLE proj.finding_view (
  finding_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  check_code text NOT NULL, severity text NOT NULL,
  period daterange, jurisdiction text, summary text NOT NULL,
  rule_citation text NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX ON proj.finding_view (tenant_id, created_at DESC);

-- vec
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE vec.model (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL, version text NOT NULL, dims int NOT NULL,
  hosting text NOT NULL, dpa_ref text,
  UNIQUE (name, version)
);
-- One embedding table PER MODEL VERSION (dimension fixed at creation). Dimension below is a placeholder until D-4 is decided.
CREATE TABLE vec.legal_chunk_emb_v1 (
  chunk_id uuid PRIMARY KEY,                 -- = rules.legal_chunk.id
  model_id uuid NOT NULL REFERENCES vec.model(id),
  jurisdiction text NOT NULL,
  embedding halfvec(1024) NOT NULL           -- placeholder dims
);
CREATE INDEX ON vec.legal_chunk_emb_v1 USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
```
Query pattern (filtered ANN; enable iterative scan so the filter does not starve results):
```sql
SET LOCAL hnsw.iterative_scan = relaxed_order;   -- pgvector 0.8
SELECT chunk_id FROM vec.legal_chunk_emb_v1
 WHERE jurisdiction = ANY($2)
 ORDER BY embedding <=> $1 LIMIT 10;
```
- Only **public legal text** is embedded (Architecture §11). `chunk_id` joins to replicated `rules.legal_chunk` for text and citation.
- Projector idempotency: key = `(chunk_id, model_id)`; re-embedding on model change writes a new table, then cuts reads over by config.
- Projector reads replicated ledger by `(tenant_id, seq)` after its checkpoint. Because per-tenant appends are serialised until commit (§4.1), gaps cannot appear out of order; the projector still verifies `prev_hash` continuity and halts on a break.

## 8. Fidelity verification (implementation notes)

- **Chain heads (every minute):** for each active tenant compare `(last_seq, last_hash)` from W `ledger.chain_head` with R's replicated copy; if R is behind, compare R's `audit_event` at R's own max seq with W's event at that seq (prefix equality). Divergence at equal seq = P1.
- **Range hash:** order by PK; hash of `row_to_json`-free canonical text (`concat_ws` with explicit separators and `NULL` markers) per 10k-row range via `sha256(convert_to(string_agg(... ORDER BY id), 'UTF8'))`. Compare ranges; re-compare mismatches after 60 s settle; persist verdicts to `ops.fidelity_check`.
- **Schema fingerprint:** sha256 over `pg_get_*def` outputs for replicated tables (columns, types, constraints, indexes that affect identity) on both clusters.
- **Lag measurement (monitoring only):** `pg_replication_origin_status.remote_lsn` / `pg_stat_subscription.latest_end_lsn` on R vs W `pg_current_wal_lsn()` for byte lag; timestamp of the last applied commit for the watermark header. **Never** use LSNs for read-your-writes (Architecture §5.2).
- **Known limitation:** logical equality ≠ physical identity. Physical identity of W is protected by physical standbys and backups; R is verified logically.

## 9. Backup, restore, retention

| Item | Policy |
|---|---|
| W WAL archive + base backups | Continuous WAL; daily base backup; EU object storage, versioning + Object Lock (compliance mode); encryption with EU KMS |
| Restore drill | Monthly to a scratch cluster; verify chain integrity and fidelity check; record in `ops` and Progress.md |
| R | No backups required for recovery (rebuild from W). A snapshot may be kept to shorten rebuild; not authoritative |
| Retention | Per-jurisdiction `privacy.retention_policy` rows with citation + validity; purge via `w_retention` procedures only; legal holds block purge; every purge writes a ledger event |
| Erasure | Crypto-shred: delete `wrapped_dek`/set `state='shredded'` on W (replicates to R) + disable KMS key version; ledger payloads contain no PII so the chain remains verifiable |
| Object Lock vs. erasure | Evidence packs/backups under Object Lock cannot be deleted before expiry; therefore PII inside them is only ever ciphertext under shreddable keys. DPIA must document this (Workflow.md gate L5) |

## 10. Migration workflow (summary; full in Workflow.md)

1. Author migration with `-- target: both|w|r` header and classification comments for new columns.
2. CI: apply to fresh W and R, run replication, compare schema fingerprints, run RLS and role-grant tests, run L4 classification gate.
3. Deploy: additive → R then W; destructive → W then R; `ALTER SUBSCRIPTION … REFRESH PUBLICATION` when new published tables appear.
4. Expand/contract only. No destructive change in the same release as the code that stops using the object.

## 11. Open database decisions

| ID | Question | Default until decided |
|---|---|---|
| DB-1 | Postgres operator: CloudNativePG vs Patroni | CloudNativePG, pending spike |
| DB-2 | Embedding dimension/model | `halfvec(1024)` placeholder; blocked on D-4 |
| DB-3 | Ledger partitioning strategy once volume known | none until measured |
| DB-4 | Per-tenant dedicated W/R for enterprise tier | not offered in v1 |
