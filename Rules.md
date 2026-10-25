# Rules.md

Numbered, enforceable rules. Each rule names how it is enforced: **CI** (gate id from Workflow.md), **TEST**, **REVIEW** (human), or **DESIGN** (structurally impossible to violate). A rule with no enforcement is a wish; add one or delete the rule.

Keywords per RFC 2119. Rule IDs are stable — never renumber; retire with a note.

---

## R-DOC — evidence and claims

| ID | Rule | Enforced by |
|---|---|---|
| R-DOC-1 | Every regulatory statement in code, rule packs, UI copy or docs MUST cite a primary source (CELEX/ELI or official authority URL), article/section, and access date. Unverified statements MUST be tagged `[UNVERIFIED]` and MUST NOT enter rule packs. | CI L8 (rule packs), REVIEW (docs) |
| R-DOC-2 | Absolute market claims ("no vendor…") MUST NOT be written unless backed by a dated exhaustive search recorded in Research.md. | REVIEW |
| R-DOC-3 | Changing a contract (schema, API, ledger layout, role grants, failure behaviour) MUST update the matching doc in the same PR. | CI (doc-drift check: migrations/OpenAPI changed ⇒ DatabaseInfo.md/openapi diff present), REVIEW |
| R-DOC-4 | Targets (RPO/RTO/SLO) are labelled "target" until measured; measured values are recorded with date and method. | REVIEW |

## R-DB — data layer

| ID | Rule | Enforced by |
|---|---|---|
| R-DB-1 | Query handlers MUST use `ReadStore` (cluster R). Command handlers MUST use `WriteStore` (cluster W). No handler MAY hold both stores in one function signature. | DESIGN (types), CI clippy lint / `cargo-deny` crate-boundary check, REVIEW |
| R-DB-2 | Money = `bigint` minor units + `char(3)` ISO-4217; never `float`/`f64`. Time = `timestamptz` UTC. | CI (schema lint), TEST |
| R-DB-3 | Primary keys are UUIDv7 (`uuidv7()`); replicated tables MUST NOT use sequence defaults (sequences are not replicated). | CI (schema lint) |
| R-DB-4 | Only `recon-store::bridge` MAY wait for replication catch-up (via the ledger-sequence token). No other code polls `chain_head`, LSNs, or replication views for synchronisation. | DESIGN (module visibility), REVIEW |
| R-DB-5 | Never fall back from R to W for query traffic. R unavailable ⇒ `503`. | TEST (chaos test), REVIEW |
| R-DB-6 | `ledger.*` is append-only and written only via `ledger.append_event()`. UPDATE/DELETE/TRUNCATE are blocked by privileges and triggers. | TEST (L7), DESIGN |
| R-DB-7 | R's replicated tables are written only by the subscription owner. Derived data lives only in `proj`, `vec`, `fidelity`. | TEST (grant test), DESIGN |
| R-DB-8 | Every migration declares `-- target: both|w|r`, follows expand/contract, and applies additive changes R→W, destructive W→R. Destructive change MUST NOT ship in the same release as the code that stops using the object. | CI (migration lint + replication test), REVIEW |
| R-DB-9 | Both clusters MUST converge to the same replicated-schema fingerprint in CI and before deploy. | CI |
| R-DB-10 | Every column in a replicated schema MUST carry a classification comment (class, legal basis, retention class). | CI L4 |
| R-DB-11 | `api` schema (idempotency keys, API keys) MUST NOT be published to R. | TEST |
| R-DB-12 | Application DB roles MUST have no DDL and no TRUNCATE. | TEST (grant test) |

## R-API — service behaviour

| ID | Rule | Enforced by |
|---|---|---|
| R-API-1 | Every mutating endpoint MUST require `Idempotency-Key` and return the stored response on replay with the same request hash; same key + different hash ⇒ `422`. | TEST |
| R-API-2 | Every mutating command MUST append ≥1 ledger event in the same W transaction and return `commit_seq` (`X-Commit-Seq`); tokenised reads MUST honour `X-Min-Seq` or fail with `503 replica_lag` + `Retry-After`. | TEST |
| R-API-3 | All reads MUST return `X-Data-Watermark`. | TEST |
| R-API-4 | The OpenAPI spec is generated from code; the TypeScript client is generated from the spec; CI fails on drift. Additive-only within a major version. | CI |
| R-API-5 | Error bodies MUST NOT leak internals, SQL, other tenants' identifiers, or PII. | TEST, REVIEW |
| R-API-6 | Webhooks MUST be signed and replay-protected (timestamp + signature). | TEST |
| R-API-7 | Request bodies MUST be typed structs with `deny_unknown_fields` (duplicate keys refused), sent as `application/json` (415 otherwise) and limited per endpoint (413; 8 KiB for the two POST endpoints, none for GET; any larger limit needs a justification next to its constant). Ids, hashes, dates, enums, URIs, `Idempotency-Key`, `limit`, URI length and header sizes MUST be validated strictly and rejected, never coerced or clamped. | TEST (`validate::tests`, `tests/security.rs`) |
| R-API-8 | Text from clients MUST be rejected with `400 invalid_characters` if it contains NUL/C0/C1 controls, zero-width or BOM characters or bidirectional overrides/isolates; it is stored as sent (no HTML escaping on input) and only through parameterised SQL. A new free-text field MUST add NFC handling. | TEST (`validate::tests`, `tests/security.rs::hostile_sql_text_…`) |
| R-API-9 | Every API response, errors and rejections included, MUST carry `nosniff`, `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`; error messages MUST be fixed strings that never contain request input. | TEST (`tests/security.rs`) |
| R-API-10 | The service plane (internal listener) MUST fail closed: no start without `RECON_INTERNAL_ALLOWED_CIDRS` and `RECON_SERVICE_KEYS`; every request needs an allowlisted client IP and a valid `RECON-SVC-V1` signature (±60 s, nonce once per 120 s, constant-time compare, unknown key id indistinguishable from a bad signature) in addition to the API key. `X-Forwarded-For` counts only from `RECON_TRUSTED_PROXY_CIDRS`. The Rust verifier and the TypeScript signer MUST pass the same vectors (`crates/recon-api/tests/vectors/service-signature-v1.json`). | TEST (`service::tests`, `net::tests`, `tests/security.rs`, `frontend/tests/service-signature.test.ts`) |

## R-ENG — reconciliation engine

| ID | Rule | Enforced by |
|---|---|---|
| R-ENG-1 | Engine output MUST be a pure function of (input record hashes, rule-pack version). No wall-clock, randomness, network, or model call inside rule evaluation. | TEST (replay-equality test), REVIEW |
| R-ENG-2 | A finding MUST store `rule_id`, `input_record_ids`, `input_hashes`, `rule_pack_id`, and the run's bridge `min_seq`. | DESIGN (NOT NULL columns) |
| R-ENG-3 | Findings MUST state disagreement between sources and cite the rule; they MUST NOT state a legal conclusion ("you owe…", "this is unlawful"). | REVIEW, TEST (copy lint on finding templates) |
| R-ENG-4 | Rule evaluation MUST be tenant-isolated (RLS-bound transaction per tenant). | TEST |

## R-RULES — rule packs (regulatory data)

| ID | Rule | Enforced by |
|---|---|---|
| R-RULES-1 | Country dates, thresholds, rates, schema versions, and retention periods are data in `rules/` with `source_ref`, `article`, `accessed_on`, `valid_from`, `valid_to`. Never hard-coded. | CI L8 |
| R-RULES-2 | Rule-pack PRs require approval from the compliance owner team (CODEOWNERS) in addition to engineering review. Agents MAY draft; agents MUST NOT be the only approver. | CI L11 |
| R-RULES-3 | `last_reviewed` older than 90 days ⇒ warning issue; older than 180 days ⇒ gate fails for that jurisdiction's pack. | CI L8 |
| R-RULES-4 | Rule packs are versioned and immutable once released; corrections are new versions. Past findings keep their original pack reference. | DESIGN, TEST |
| R-RULES-5 | Unsettled regulatory dates (e.g. announced-but-unpublished delays) MUST be modelled with the currently published legal date and a visible `pending_change` note, never silently adopted. | REVIEW |

## R-SEC — security

| ID | Rule | Enforced by |
|---|---|---|
| R-SEC-1 | TLS 1.3 for all transport; DB connections `sslmode=verify-full`. | TEST (config test), CI L10 |
| R-SEC-2 | No secrets in the repository, images, or CI logs. Short-lived credentials via OIDC federation where the platform allows. | CI L3 |
| R-SEC-3 | RLS enabled **and forced** on every tenant table in both clusters; tenant bound per transaction (`SET LOCAL app.tenant_id`); unset tenant fails closed. | TEST (cross-tenant suite on both clusters) |
| R-SEC-4 | API keys stored as Argon2id hashes; shown once; scoped; revocable. | TEST, REVIEW |
| R-SEC-5 | `unsafe` is forbidden (`#![forbid(unsafe_code)]`) except in a reviewed, isolated crate with justification. | CI (clippy/rustc lint) |
| R-SEC-6 | No `unwrap()`/`expect()` on fallible runtime paths in non-test code; no panics on user input. | CI (clippy deny) |
| R-SEC-7 | Dependencies: license allowlist, no known-vulnerable versions, SBOM generated per release, GitHub Actions pinned by commit SHA. | CI L1, L2 |
| R-SEC-8 | Release artifacts MUST be signed and carry provenance; deploy verifies signature and the legal-audit attestation. | CI L12 |
| R-SEC-9 | Argon2 MUST NOT be reachable by traffic that has not passed the per-IP limiter; concurrent verifications are capped (`503 busy` when saturated). After authentication per-key and per-tenant limits apply, stricter for writes. Limiters are memory-bounded; 429 carries `Retry-After` and `RateLimit-*`. In-process state is per replica and docs MUST say so. | TEST (`ratelimit::tests`, `guard::tests`, `tests/security.rs`) |
| R-SEC-10 | Database servers accept connections only from the application networks: provider-level allowlist AND `pg_hba.conf` (`hostssl`, `scram-sha-256`, per-role per-database lines, replication role only from R, final `reject`); clients use `sslmode=verify-full`. Currently a template (`infra/postgres/`), not deployed. | REVIEW (template), CI L10 (config test once a provider is chosen) |

## R-PRIV — privacy and retention

| ID | Rule | Enforced by |
|---|---|---|
| R-PRIV-1 | No PII in logs, traces, metrics labels, error messages, ledger payloads, or embeddings. PII-bearing types MUST be wrapper types whose `Debug`/`Display` redact. | TEST (log-capture test), REVIEW |
| R-PRIV-2 | PII/identifier columns are envelope-encrypted with per-subject DEKs wrapped by an EU KMS; exact-match lookup uses keyed HMAC, not plaintext. | TEST, REVIEW |
| R-PRIV-3 | Retention is per-jurisdiction data (`privacy.retention_policy`) with citation; purge only through `w_retention` procedures; legal holds block purge; every purge and erasure decision is ledgered. | TEST (L6) |
| R-PRIV-4 | Tenant data stays in EU regions. No non-EU sub-processor receives tenant data. Sub-processors are listed in `docs/privacy/SUBPROCESSORS.md` with DPA reference. | CI L10, L5, REVIEW |
| R-PRIV-5 | Erasure uses crypto-shredding; a test MUST prove that after shredding the data is unreadable on both W and R while the ledger chain still verifies. | TEST (L6/L7) |
| R-PRIV-6 | `docs/privacy/{DPIA,ROPA,TIA,SUBPROCESSORS}.md` MUST exist with `reviewed_at`, `reviewer`, `next_review`; overdue ⇒ gate fails. These are drafts for the DPO/counsel, not legal advice. | CI L5 |
| R-PRIV-7 | New data category or processing purpose ⇒ DPIA/ROPA updated in the same PR. | CI L4/L5 (ROPA diff), REVIEW |

## R-AI — vector and model use

| ID | Rule | Enforced by |
|---|---|---|
| R-AI-1 | Models are advisory. Findings, citations, and legal statements MUST come from deterministic rules and retrieved source chunks (by `chunk_id`), never from free generation. | TEST, REVIEW |
| R-AI-2 | Do not embed or send to any model: tenant PII, raw tenant records, tax IDs. Only public legal text and tenant-agnostic descriptions. No SaaS LLM APIs on tenant data. | TEST (corpus allowlist), REVIEW |
| R-AI-3 | Any AI-generated explanation shown to users MUST display its source citations and an "automated, not legal advice" notice. | REVIEW, TEST |
| R-AI-4 | Model, version, dimension, hosting, and DPA reference are recorded in `vec.model`; a model change creates a new embedding table. | DESIGN |
| R-AI-5 | Re-assess AI Act classification when any AI feature touches natural persons, risk-scores individuals, or supports authority decisions. | REVIEW |

## R-FE — frontend

| ID | Rule | Enforced by |
|---|---|---|
| R-FE-1 | Lenis MUST keep the library default of honouring `prefers-reduced-motion`. Nested scroll containers (tables, dialogs, popovers, command palette) carry `data-lenis-prevent`. Lenis never gates functionality. | TEST (Playwright), REVIEW |
| R-FE-2 | WCAG 2.2 AA target; axe-core must report no serious/critical violations on primary flows. | CI |
| R-FE-3 | No hard-coded user-facing strings; i18n catalogs only. | CI (lint) |
| R-FE-4 | Browser never holds bearer tokens; session via HttpOnly, Secure, SameSite cookie through the Next.js BFF. | TEST, REVIEW |
| R-FE-5 | shadcn components are copied into the repo and owned; do not patch `node_modules`. | REVIEW |
| R-FE-6 | Pages MUST be served with a per-request nonce Content-Security-Policy (no `unsafe-inline`/`unsafe-eval` for scripts in production; `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`) and the headers set in `next.config.ts`. No `dangerouslySetInnerHTML`, `innerHTML` or eval-style code; a library that needs eval MUST be configured not to (zod `jitless`). | TEST (`csp.test.ts`), REVIEW; the browser-console check was run by hand, no automated check yet |
| R-FE-7 | The BFF MUST reach the API only through the internal listener with a service signature, forward only allowlisted v1 routes, query parameters and request headers, and answer every other path with 400. | TEST (`bff.test.ts`, `service-signature.test.ts`) |

## R-OPS — operations

| ID | Rule | Enforced by |
|---|---|---|
| R-OPS-1 | Alert on: replication lag, subscription apply errors, retained-WAL growth, fidelity mismatch (persistent), anchor lag, backup age, error budget burn. Each alert links a runbook. | REVIEW (runbook lint in CI) |
| R-OPS-2 | Restore drill monthly; R-rebuild drill quarterly; W failover game day quarterly. Results recorded in Progress.md. | REVIEW |
| R-OPS-3 | Change freeze around customer-critical filing deadlines (calendar kept in `rules/`), except security hotfixes. | REVIEW |
| R-OPS-4 | Personal-data breach: notify supervisory authority within 72 h where required (GDPR Art. 33); if NIS2 applies, early warning within 24 h. Scope assessment tracked as D-5. | REVIEW |

## R-GEN — general engineering

| ID | Rule | Enforced by |
|---|---|---|
| R-GEN-1 | No stubs, TODO-implement, mocks standing in for real behaviour in `main`. Unfinished work stays on a branch or is not merged. | REVIEW |
| R-GEN-2 | Tests cover consumer-visible behaviour, boundaries, invariants, failures. No tests of wiring, copies, mocks, or source text. DB tests run on real Postgres 18 pairs with replication. | REVIEW |
| R-GEN-3 | Conventional Commits; signed commits; squash-merge; one logical change per PR. | CI |
| R-GEN-4 | No code is written for requirements nobody stated (extra retries, validators, telemetry, abstractions). | REVIEW |
| R-GEN-5 | Regulation- or tax-law-dependent behaviour MUST be reviewed by a human with the relevant competence before release. | CI L11 |

## Rule lifecycle
Add a rule only with an enforcement mechanism. Retire by marking `RETIRED (date, reason)`; keep the ID. Rules are reviewed quarterly alongside the regulatory register.
