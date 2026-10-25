# Architecture.md

Status: **design**; the W/R DDL, ledger function and read-your-writes bridge semantics were validated on a PostgreSQL 18.6 pair (Progress.md §7). No application code exists. Targets below are design targets to be validated by load tests and game days; none is a measured claim.

Evidence base: docs/Research.md. Schema detail: DatabaseInfo.md. Hard rules: Rules.md.

---

## 1. Purpose and scope

An API service that continuously **reconciles a company's books against the copy each EU authority holds** (e-invoice clearance data, SAF-T, returns, customs import data, VIES) and emits **findings with cited legal basis and tamper-evident evidence packs**.

In scope (v1): ingest → normalise → reconcile (checks C1–C7, Research.md §3.4) → findings → evidence pack → dashboard.
Out of scope (v1): filing/submission to authorities, payroll/social security, transfer pricing/DAC6, PE risk, WHT, MAP, KYC/seller onboarding. Out-of-scope items are roadmap, not abandoned.

The service is **not a tax adviser**. Findings say "these two sources disagree under rule X (citation)". Legal conclusions remain with the customer's advisers (open decision D-5).

## 2. Hard architectural constraints (from the brief)

| Constraint | Realisation |
|---|---|
| Rust | Cargo workspace; Axum/Tokio/sqlx |
| Postgres + pgvector | PostgreSQL 18, pgvector 0.8.x in the read cluster |
| 1 database to **write** | **Write cluster (W)** — sole source of truth |
| 1 database to **read** | **Read cluster (R)** — separate cluster, derived, disposable |
| Fault tolerant | Quorum-sync HA for W; hot standbys for R; R rebuildable from W; WAL archive with Object Lock |
| Fidelity copy | Logical replication W→R **plus** continuous hash verification (§6) |
| Bridge between the 2 DBs | Replication + ledger-sequence read-your-writes bridge in `recon-store` (§5) |
| Frontend: shadcn + Lenis | Next.js + shadcn/ui + Lenis, scoped (§12) |
| Load balancing, horizontal scale, HA | Stateless API/FE replicas behind L7 LB; HPA; PDBs; multi-AZ (§8–9) |
| EU compliance | EU-only regions, GDPR-by-design, eIDAS timestamps, CI legal-evidence gates (Workflow.md) |

## 3. Logical architecture

```mermaid
flowchart LR
  subgraph Edge
    CL[Clients: ERP / marketplace / browser] --> LB[L7 LB + WAF]
  end
  LB --> FE[Next.js x N]
  LB --> API[recon-api x N stateless]
  FE -->|BFF, OIDC session| API

  API -->|commands only| PW[PgBouncer-W]
  API -->|queries only| PR[PgBouncer-R]
  PW --> W[(W: primary + 2 quorum standbys)]
  PR --> R[(R: subscriber primary + hot standbys)]

  W == logical replication, failover slots ==> R

  WK[recon-worker: ingest / engine / projector / anchor / verifier / retention]
  WK -->|writes: batches, findings, ledger| PW
  WK -->|derived writes: projections, embeddings| R
  WK -->|reads after seq wait| PR

  W -->|WAL archive + base backups| OBJ[(EU object storage, Object Lock)]
  WK -->|RFC 3161| TSA[Qualified TSA - eIDAS]
  WK --> EMB[Embedding model, EU-hosted or self-hosted]
```

### 3.1 Components

| Component | Responsibility | State |
|---|---|---|
| `recon-api` | HTTP API (Axum). Query handlers take `&ReadStore`; command handlers take `&WriteStore`. Auth, rate limit, idempotency, tenant context. | stateless |
| `recon-worker` | Subcommands: `ingest`, `engine`, `projector`, `anchor`, `verifier`, `retention`. Horizontally scalable; work claimed with `FOR UPDATE SKIP LOCKED`. | stateless |
| `recon-migrate` | Applies migrations to W and R in the correct order (§5.3). Only DDL path. | — |
| Frontend | Next.js App Router, shadcn/ui, Lenis. Talks only to `recon-api`. | stateless |
| W cluster | All authoritative data: tenants, source records, findings, rules, ledger, privacy keys. | durable |
| R cluster | Replicated copies + projections + vectors. Never authoritative. | rebuildable |
| Object storage | Raw uploaded files, evidence packs, WAL/base backups. EU region, versioned, Object Lock (compliance mode) on backups and evidence. | durable |

Deliberately absent in v1: Kafka, Redis, service mesh, Citus (§14). Reintroduce only against a measured need.

## 4. Data flow

1. **Ingest.** Client uploads (pre-signed URL to object storage) → `POST /v1/batches` registers `sha256`, source type, period. Idempotent via `Idempotency-Key`. Command writes `ingest.source_batch` + a ledger event in one W transaction. Returns `commit_seq` (the tenant ledger sequence of the event committed with the batch).
2. **Normalise.** `ingest` worker parses to canonical records (`ingest.source_record`; invoices mapped to an EN 16931-shaped canonical model with country CIUS adapters).
3. **Reconcile.** `engine` worker waits (bridge) until R's `ledger.chain_head.last_seq` for the tenant ≥ the batch's `commit_seq`, reads normalised records from R, evaluates the pinned **rule-pack version** deterministically, writes `recon.run` / `recon.finding` rows **to W**.
4. **Project.** `projector` reads replicated findings/ledger from R, writes denormalised projections and embeddings **into R's derived schemas**.
5. **Evidence.** `anchor` periodically obtains an RFC 3161 timestamp token for each tenant's ledger head hash → `ledger.chain_anchor` (W). Evidence packs are generated on demand from replicated data plus anchors.
6. **Read.** API queries R. Responses carry `X-Data-Watermark`; clients that just wrote pass `X-Min-Seq` (§5.2).

## 5. The bridge between W and R

### 5.1 Replication (the "fidelity copy" transport)
- W publishes `FOR TABLES IN SCHEMA core, ingest, recon, rules, ledger, privacy, ops` (explicit table lists for sensitive exceptions, see DatabaseInfo.md §publication).
- R subscribes with `failover = true`, `streaming = parallel`. W standbys run `sync_replication_slots = on` so the slot survives W failover.
- Replicated tables on R live in the same schema names (read-only by privilege). Derived data lives in R-only schemas `proj`, `vec`, `fidelity`.

### 5.2 Read-your-writes (ledger sequence token)
- **Every command appends at least one ledger event in the same W transaction as its change** (`ledger.append_event()`, Rules R-DB-6/R-API-2). The response returns `commit_seq` (header `X-Commit-Seq`): the tenant ledger `seq` of the last event it appended.
- A read with `X-Min-Seq: <n>` makes `ReadStore` poll `SELECT last_seq FROM ledger.chain_head WHERE tenant_id = $1` **on R** until `last_seq >= n` or `bridge.wait_ms` (default 1500, config) elapses → `503 replica_lag` + `Retry-After`. **No silent fallback to W.** Poll with short backoff (tens of ms).
- Why this is exact: logical replication applies each transaction atomically, in commit order; the event and the change commit together; so `last_seq >= n` on R implies the change is visible to the next R snapshot. Per-tenant appends are serialised until commit (DatabaseInfo §4.1), so `last_seq` never overtakes a lower, uncommitted `seq`.
- **Why not an LSN token** (the first design, rejected after testing on PostgreSQL 18.6, Progress.md §7): a post-commit `pg_current_wal_insert_lsn()` token is **not reliably reachable** through R's `pg_replication_origin_status.remote_lsn` — once any non-replicated WAL follows the commit (e.g. the `api.idempotency_key` write that every command makes, other databases, checkpoints) `remote_lsn` stays behind the token and the wait stalls until timeout. `pg_stat_subscription.latest_end_lsn` did reach it, but means "received", not "applied", so it cannot prove visibility. LSNs are used for **lag monitoring only**.
- Reads without a token are eventually consistent and flagged by `X-Data-Watermark` (timestamp of the last applied commit).
- Only the `bridge` module in `recon-store` may implement this waiting; no other code reads `chain_head` for synchronisation. Enforced by module visibility (Rules.md R-DB-4).

### 5.3 Schema changes (DDL is not replicated)
`recon-migrate` uses **expand/contract** with strict order:
- Additive: apply to **R first**, then W (subscriber must accept new columns before publisher sends them).
- Destructive: stop writing in app code → drop on **W**, then **R**.
- Each migration file is tagged `target = both | w | r`; CI verifies both clusters converge to the identical replicated-schema fingerprint (DatabaseInfo.md §fidelity).
- Sequences are not replicated → primary keys are **UUIDv7** (`uuidv7()`, PG 18); no replicated table uses a sequence default.
- **Order matters (verified on PostgreSQL 18.6):** adding a column on W first made the publisher send a column R did not have; R's apply worker errored (`apply_error_count` 0 → 3) and the **entire subscription stalled, including unrelated tables**, until the column existed on R. R-first produced no errors. Therefore: `recon-migrate` enforces order; alert (P1) on `pg_stat_subscription_stats.apply_error_count` increasing.

### 5.4 Roles
Separate DB roles per component per cluster; no application credential exists that can write R's replicated tables or read W from a query path (DatabaseInfo.md §roles). The API service holds *both* a W-command credential and an R-query credential, but the type system (separate `WriteStore`/`ReadStore`) and grants make cross-use impossible without a deliberate, reviewed change.

## 6. Fidelity verification

Logical replication gives *logical* equality, not byte identity. Fidelity is therefore **asserted by continuous verification**, not assumed.

- **Ledger (append-only):** exact. Verifier recomputes the hash chain on R from `seq` ranges and compares each chain head to W's; any divergence is a P1 alert. Chains are also externally anchored (§10).
- **Mutable tables:** range-hash comparison over primary-key ranges (`md5/sha256` of canonically ordered row text). Two-pass: ranges that differ are re-compared after a settle delay; only **persistent** mismatches alert (avoids false positives from in-flight changes).
- **Cadence:** ledger heads every minute; full-table range sweep at least daily per table, hot tables more often. Results stored in `ops.fidelity_check` (W, replicated).
- **Schema fingerprint:** hash of catalog definition for replicated tables on both clusters; mismatch blocks deploys.
- **Disaster test:** monthly restore of W backup to a scratch cluster, chain verification, and R rebuild drill (`copy_data = true` from scratch), recorded.

## 7. Consistency and failure semantics

| Event | Behaviour |
|---|---|
| W primary fails | Operator promotes a quorum-sync standby (RPO 0 by design). Writes get `503 Retry-After` during promotion (target < 60 s). Reads continue from R with a growing watermark age. Subscription resumes via synchronised slot. |
| W entire AZ lost | Quorum (`ANY 1` of 2 standbys across 3 AZs) still commits. |
| W region lost | Async DR standby in a second **EU** region; manual promote; RPO > 0 possible (target ≤ 5 min), declared in customer SLA. |
| R primary fails | Promote hot standby. R is derived → no RPO requirement. If both lost: rebuild from W (runbook; hours, not minutes — hence 2 R nodes minimum). API reads return 503, **never** redirected to W. |
| Replication lag spikes | Alert at 5 s p99. Beyond `bridge.wait_ms`, tokenised reads fail fast. Engine pauses new runs. |
| Slot invalidated | Page. Runbook: recreate subscription with `copy_data = true`, then verifier full sweep. |
| TSA unavailable | Anchoring retries with backoff; ledger keeps appending (hash chain already tamper-evident); anchor lag alert. Evidence packs state the latest anchored `seq`. |
| Poison ingest file | Worker marks batch `failed` with reason; no partial effects (single transaction per batch stage). |

Idempotency: all POSTs require `Idempotency-Key` (stored with request hash + response in `api.idempotency_key`, W). Worker stages are idempotent and resumable.

## 8. High availability and load balancing

| Layer | Mechanism | Design target (unvalidated) |
|---|---|---|
| Edge | Managed L7 LB with health checks, multi-AZ; WAF | — |
| API / FE | ≥3 replicas across AZs; PodDisruptionBudgets; readiness gates on DB reachability; graceful drain | zero-downtime deploy |
| Postgres W | 3 instances / 3 AZs, quorum sync commit, operator-managed failover, PgBouncer | RPO 0 in-region; RTO < 60 s |
| Postgres R | primary + ≥1 hot standby; read load across standbys | RTO < 2 min; lag p99 < 5 s |
| Backups | continuous WAL archive + daily base backup → EU object storage, Object Lock (compliance mode) | restore drill monthly |
| DR | async standby in second EU region | RPO ≤ 5 min; RTO ≤ 4 h |
| API SLO | initial **99.9 %** monthly; revisit after 2 quarters of data | — |

No 99.99 % claim is made: it would require validated multi-region active/active behaviour that this design does not include.

Filing-deadline calendar: HA windows get change freezes around customer-critical dates (Workflow.md §release).

## 9. Horizontal scaling

- **API / FE:** HPA on CPU + in-flight requests. Stateless; sessions in signed cookies / OIDC tokens.
- **Workers:** scale on queue depth; `SKIP LOCKED` claims; per-tenant concurrency caps to prevent noisy neighbours.
- **R reads:** add hot standbys. Tune `hot_standby_feedback` / `max_standby_streaming_delay` to avoid query-conflict cancellations (measure).
- **W writes:** single-writer. Controls: batch events per transaction; per-tenant ledger head row lock (serialises one tenant, not all); later hash-partition large tables by `tenant_id`. If one writer is ever insufficient, the next step is tenant-sharded W clusters (router in `recon-store`), not Citus — decided when measurements demand.
- **pgvector:** HNSW on R only; legal corpus is small relative to HNSW limits. Tenant data is not embedded (§11).
- **Capacity:** no load figures were supplied. Phase 1 sets targets using k6 against a realistic synthetic data set (Workflow.md).

## 10. Legal-evidence architecture

| Need | Mechanism |
|---|---|
| Tamper evidence | Per-tenant append-only **hash chain** (`ledger.audit_event`): `hash = SHA-256(prev_hash ‖ canonical fields ‖ payload_sha256)`; payload canonicalised per RFC 8785 (JCS). UPDATE/DELETE/TRUNCATE blocked by privileges **and** triggers. |
| Trusted time | `anchor` worker timestamps the chain head via **RFC 3161** with a **qualified** trust service provider where available. Qualified electronic timestamps carry a presumption of date/time accuracy under eIDAS Arts. 41–42 (Research.md §5). Chain heads make Merkle trees unnecessary: timestamping the head covers all prior events. |
| Evidence pack | ZIP: `manifest.json` (finding, rule-pack version, citations, input record hashes), source record extracts, chain segment, anchor token(s), verification script. Verifiable offline with the open verifier CLI (`recon-verify`). Packs stored with Object Lock. |
| Determinism | Findings are a pure function of (input record hashes, rule-pack version). Re-running reproduces identical output; engine records both in the finding. |
| Erasure vs. retention | PII never stored in ledger payloads (opaque `subject_ref`). PII fields encrypted with per-subject DEKs wrapped by an EU KMS key; erasure = **crypto-shred** (delete wrapped DEK on W → replicated to R; disable KMS key version). Retention is **per jurisdiction data** (`privacy.retention_policy`), subject to legal holds; erasure requests under Art. 17 are refused/deferred where Art. 17(3)(b) applies, and that decision is itself logged. |

## 11. Vector / AI layer

- pgvector lives **only in R** (`vec` schema). Embeddings are derived data produced by `projector`; they never enter W.
- Corpus: public legal text (EUR-Lex, national guidance, ECJ case summaries), curated rule-pack commentary, and customer-agnostic product/HS descriptions. **No tenant PII and no raw tenant records are embedded** (embedding inversion risk; Rules.md R-AI-2).
- Uses: (1) retrieve citations for a finding's explanation; (2) suggest rule-pack entries for human review; (3) "similar finding" lookup within a tenant's own derived projections (non-PII features only).
- **AI is advisory.** Deterministic rules decide findings. LLM output never becomes a finding, citation, or legal statement without matching a retrieved source chunk id (Rules.md R-AI-1, R-AI-3).
- Embedding model must run in the EU (self-hosted or EU-region provider with Art. 28 DPA). Model, dimension and version are recorded in `vec.model`; changing models = new table + re-embed, not an in-place update. Open decision D-4.
- AI Act: advisory retrieval over public text is not an Annex III use case on current reading; re-assess on scope change (Research.md §5). Counsel to confirm.

## 12. Frontend

- Next.js (App Router) + React + Tailwind + **shadcn/ui** (copied into repo, owned by us). TanStack Query for server state; API client generated from the OpenAPI spec (`utoipa` → `openapi-typescript`) so contracts cannot drift (CI gate).
- Auth: OIDC code flow in the Next.js server (BFF); browser holds only an HttpOnly session cookie.
- **Lenis scoping:** Lenis honors `prefers-reduced-motion` by default (smoothing off) — keep that default. Use it on marketing/overview pages. In app views with nested scrollers (data tables, Radix dialogs/sheets/popovers, command palette), mark those containers `data-lenis-prevent` to avoid scroll hijacking; virtualised tables are excluded. Lenis never drives anything that affects correctness.
- Accessibility target **WCAG 2.2 AA**; axe-core in CI. i18n from day 1 (EN, then RO and country languages per pilot); no hard-coded strings.
- Deployment: static assets on CDN, SSR containers stateless behind the same LB.

## 13. Security

- TLS 1.3 everywhere; mTLS between API and workers' internal endpoints and to Postgres (`verify-full`).
- AuthN: OIDC for humans (EU-hosted IdP), API keys for machines (hashed at rest, prefix-indexed, scoped, rotatable), optional mTLS-bound keys for enterprise.
- AuthZ: tenant-scoped RBAC; Postgres **RLS** on `tenant_id` in both clusters; tenant bound per transaction with `SET LOCAL app.tenant_id` (compatible with PgBouncer transaction pooling).
- Secrets: EU KMS / Vault; never in env files in repo. Application-layer envelope encryption for tax IDs, IBANs, names.
- Supply chain: SBOM (CycloneDX), `cargo-deny`, `cargo-audit`, npm audit/osv, pinned actions by SHA, signed images (cosign), provenance attestation.
- Logs/traces: structured, **PII-free by construction** (typed redaction wrappers; tests).
- Tenant isolation proof: cross-tenant test suite runs against both clusters in CI.

## 14. Rejected / deferred alternatives

| Option | Why not (now) |
|---|---|
| Kafka/Redpanda + Debezium | Extra moving parts; Postgres logical replication already provides ordered change feed to R; ledger gives ordered per-tenant events. Revisit if non-Postgres consumers appear. |
| Full event sourcing | Heavy. Chosen: relational state + append-only hash-chained audit ledger + deterministic re-runs. |
| `postgres_fdw` between W and R | Creates a query path across the separation boundary; defeats "1 reads / 1 writes". |
| Citus / sharding now | No measured need; operational cost. Tenant-sharded W is the planned escape hatch. |
| Redis | Idempotency + queues live in W; rate limiting at the edge LB/gateway. Add only if measured. |
| Service mesh (Istio) | mTLS can be done with cert-manager + app config at this size. |
| Serverless compute | Long-running workers, connection pooling, and EU-region/portability favour containers. |
| Blockchain anchoring | RFC 3161 qualified timestamps have explicit eIDAS legal presumption; public chains do not. |
| SaaS LLM API on tenant data | Transfer + inversion risk (Rules.md R-AI-2). |

## 15. Observability and operations

OpenTelemetry traces/metrics/logs; Prometheus + Grafana (or managed EU equivalent). Mandatory SLIs: API availability/latency, replication lag (bytes and seconds), subscription `apply_error_count`, slot retained WAL, fidelity mismatches, anchor lag, worker queue depth, per-tenant error rate. Alerts map to runbooks in `docs/runbooks/` (to be created in Phase 1).

## 16. Deployment topology

Kubernetes in an **EU-only** region set (provider undecided, D-2). Declarative Postgres via an operator — **CloudNativePG proposed** (supports quorum sync, backup to object storage, logical slot failover synchronisation per docs referenced in Research.md §6); Patroni is the acceptable alternative. Phase 1 includes a spike that proves, on a throwaway cluster: failover of W while R's subscription keeps flowing with no data loss, and R rebuild. The design is not accepted until that spike passes.

## 17. API surface (v1 sketch, OpenAPI is source of truth once written)

| Method & path | Side | Notes |
|---|---|---|
| `POST /v1/batches` | W | register upload; idempotent; returns `commit_seq` |
| `GET /v1/batches/{id}` | R | status |
| `POST /v1/recon/runs` | W | pin rule-pack version; async |
| `GET /v1/recon/runs/{id}` | R | |
| `GET /v1/findings` | R | filters: check, severity, period, jurisdiction |
| `GET /v1/findings/{id}/evidence` | R | evidence pack (signed URL) |
| `GET /v1/rules/search` | R | hybrid keyword + vector over legal corpus |
| `POST /v1/privacy/erasure-requests` | W | |
| `GET /v1/privacy/export` | R | Art. 20 portability, machine-readable |
| Webhooks | W→client | run completed, finding raised; signed |

Versioning: URL major version; additive-only within a major; deprecation ≥ 12 months.

## 18. Open decisions (owner needed)

See Progress.md D-1…D-8. Architecture holds under any resolution except D-5 (tax-advice positioning), which may change finding wording and UI, and D-2 (provider), which may change the Postgres operator.
