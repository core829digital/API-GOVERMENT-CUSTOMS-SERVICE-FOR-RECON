# Progress.md

Single source of truth for status. Update in every PR that changes status (Workflow.md §12). Dates are absolute.

Last updated: 2026-10-23

---

## 1. Status summary

| Area | Status | Notes |
|---|---|---|
| Market + regulatory research | **done, with known gaps** | docs/Research.md. First scout pass had 11 errors, corrected. Competitor-capability depth and willingness-to-pay **not yet validated** (§4). |
| Documentation set | **drafted, awaiting user review** | CLAUDE.md, AGENTS.md, Architecture.md, DatabaseInfo.md, Rules.md, Workflow.md, SystemMasterPrompt.md, Progress.md, docs/Research.md |
| Application code | **in progress** | Rust workspace (`recon-store`, `-api`, `-evidence`, `-migrate`, `-fidelity`, `-verify`, `-engine`) and the Next.js frontend exist. 2026-10-25: 44 Rust tests (against a real local W/R pair) and 62 frontend tests pass, `clippy --workspace --all-targets` is clean. Not covered by any run: CI, Linux, load. The rows below this one were written before the code existed and have not all been re-audited. |
| Database | **designed; DDL + ledger + bridge semantics validated** on a local PostgreSQL 18.6 W/R pair; pgvector, failover, PgBouncer not validated | DatabaseInfo.md; evidence in §7 |
| Infra | not started | |
| Measured performance / HA | **none** | all RPO/RTO/SLO figures are design targets |

Earlier status rows (CI, infra, HA) are unchanged and unverified. The only database validation recorded in §7 ran on a throwaway local PostgreSQL 18.6 pair; since then a persistent local pair (`tools/dev/pg-pair.mjs`) is used for tests and development (commands: CLAUDE.md).

## 2. Phase plan and exit criteria

| Phase | Scope | Exit criteria (all observable) |
|---|---|---|
| **0 — Docs & research** | the documents above | User review done; open decisions D-1…D-8 answered or consciously defaulted |
| **1 — Foundations** | Cargo workspace; compose with W+R + PgBouncer; `recon-migrate` (roles, schemas, publication/subscription, fingerprint); RLS; `ledger.append_event()` + Rust verifier with shared vectors; fidelity verifier; **CI with all legal-audit gates L1–L12 on the skeleton**; operator spike (CloudNativePG vs Patroni); k6 harness; synthetic data generator | (a) DDL from DatabaseInfo.md applies cleanly on PG 18 and replicates; (b) failover spike: W primary killed, no acknowledged write lost, R subscription resumes via synced slot, RTO measured; (c) R rebuild from scratch passes verifier; (d) injected divergence is detected by verifier; (e) cross-tenant suite green on W and R; (f) legal-audit job green and produces a signed attestation; (g) deploy step refuses an artifact without attestation |
| **2 — Ingest + first checks** | pilot country adapters; checks C1, C2, C3; findings; evidence pack + `recon-verify` CLI; minimal dashboard (shadcn, Lenis scoped); per-country data-availability matrix; competitor capability record | C1–C3 produce deterministic findings on synthetic + (if available) real anonymised data; replay-equality test; evidence pack verifies offline; ≥10 customer interviews completed; data-availability matrix reviewed |
| **3 — Breadth** | C4–C7; qualified TSA anchoring; legal-corpus vector search; i18n; second/third pilot countries | anchors verify against a qualified TSA; retrieval returns cited chunks only; per-country L9 fixtures |
| **4 — Hardening** | DR region, pen test, restore/failover drills at cadence, SLO review, ISO 27001 / SOC 2 readiness assessment, cloud-config drift scan | drill records; pen-test findings closed; measured SLOs published |
| **Later** | C8 (CESOP exposure), DAC7/DAC8-adjacent features, customs-data hub integration, filing | scoped separately; each needs its own research pass |

## 3. Open decisions (need an owner)

| ID | Decision | Default if not answered | Blocks |
|---|---|---|---|
| **D-1** | Target persona and pilot countries. Proposal: B2B API for multi-country e-commerce/SaaS finance teams and accounting firms; pilots **RO → PL → IT** (RO assumed from the company form "SRL"; RO e-Factura/SAF-T D406 mismatch is an evidenced audit trigger, Research.md §3.2) | proposal as stated | Phase 2 adapters |
| **D-2** | EU hosting provider / regions (hyperscaler EU region vs EU-sovereign provider) | none; Phase 1 can use local compose only | Phase 1 infra spike, L10 policies |
| **D-3** | Identity provider (self-hosted vs EU-managed OIDC) | self-hosted OIDC in dev | auth implementation |
| **D-4** | Embedding model and hosting (self-hosted in EU vs EU-region provider with DPA); dimension | none; `halfvec(1024)` placeholder | Phase 3 vector search |
| **D-5** | Legal positioning and ownership: counsel on whether findings with cited rules count as regulated tax advice in target states; DPO appointment; compliance owner team for CODEOWNERS; NIS2/DORA/AMLR scope assessment; regulatory monitoring owner | assume advisory-only wording (R-ENG-3), no named owners yet — **L11 cannot pass until named** | any release; Phase 1 gate L11 |
| **D-6** | Product name and crate prefix | working name `recon` | scaffolding |
| **D-7** | Qualified trust service provider for RFC 3161 timestamps (must appear on the EU Trusted List) | test TSA in dev | Phase 3 anchoring |
| **D-8** | Frontend framework confirmation (Next.js proposed), UI languages for pilots (EN + RO proposed) | Next.js, EN + RO | frontend scaffold |

## 4. Known risks and unknowns

| ID | Risk / unknown | Mitigation / next action |
|---|---|---|
| K-1 | Differentiation unproven: Sovos APR, Avalara Returns, Vertex VAT Compliance may already cover parts of reconciliation | Phase 2: record exact capabilities from first-party docs/demos per check C1–C7 |
| K-2 | No customer validation / willingness to pay | ≥10 interviews before Phase 3 commitments |
| K-3 | Authority-side data availability uneven; customs data via broker files, no unified API | data-availability matrix per pilot country |
| K-4 | Logical-replication failover correctness depends on operator behaviour (slot sync) | Phase 1 spike is an exit criterion; Patroni fallback |
| K-5 | Per-tenant serial ledger appends may bottleneck heavy tenants | measure; batch events; tenant-sharded W as escape hatch |
| K-6 | Object Lock vs erasure | PII only as ciphertext in locked artefacts; DPIA must document; counsel review |
| K-7 | Regulatory dates move (e.g. Spain VeriFactu delay announced, not published as of 2026-10-23) | rule-pack data with `pending_change`; weekly monitoring |
| K-8 | PgBouncer + sqlx prepared statements need PgBouncer ≥ 1.21 settings | verify in Phase 1 |
| K-9 | R hot-standby query conflicts / cancellations | tune and measure; alert on conflicts |
| K-10 | Scout-reported competitor details (pricing tiers, features) unverified | do not use externally until re-verified |
| K-11 | Tax-advice and AML-obliged-entity classification unresolved | D-5 counsel review |
| K-12 | Several regulatory items tagged K (prior knowledge) in Research.md §5 (Romania dates, Germany phases, CESOP applicability, DAC7 application date) | verify against EUR-Lex/authority pages before they enter any rule pack |

## 5. Next actions

1. **User review** of the nine documents; answer D-1…D-8 (or confirm defaults).
2. Verify the K-tagged items in Research.md §5 against primary sources (assign to scout + independent verifier).
3. Start Phase 1 once D-5 owners are named enough to satisfy L11, and D-2 allows the operator spike (or run the spike locally on kind/minikube first).

## 6. Change log

| Date | Change |
|---|---|
| 2026-10-23 | Research pass 1 (scout) and pass 2 (verification). 11 corrections logged in Research.md §1. Pain point selected as hypothesis. |
| 2026-10-23 | First drafts of CLAUDE.md and AGENTS.md written before research completed; **both rewritten** after verification. |
| 2026-10-23 | Architecture.md, DatabaseInfo.md, Rules.md, Workflow.md, SystemMasterPrompt.md, Progress.md, docs/Research.md created. `ledger.append_event()` moved to a SECURITY DEFINER SQL function after a design review found the app-side hash flow needed privileges on `chain_head` that would have let a compromised app fork chains. |
| 2026-10-23 | Executed the DDL from DatabaseInfo.md on a real PostgreSQL 18.6 W/R pair. Found and fixed: forward FK (`legal_entity` → `subject_key`), missing `CREATE SCHEMA`, comment examples naming nonexistent columns, `NOT NULL wrapped_dek` making crypto-shred impossible; added real anchor-table immutability triggers and `REVOKE EXECUTE … FROM PUBLIC` on `append_event`. |
| 2026-10-23 | **Bridge redesigned.** Original LSN-token read-your-writes was disproved by test (stalls once non-replicated WAL follows the commit). Replaced with a per-tenant ledger-sequence token (`commit_seq` / `X-Min-Seq`); LSNs kept for monitoring only. Updated Architecture §2–5/§17, DatabaseInfo (`recon.run.min_seq`), Rules R-DB-4/R-API-2/R-ENG-2, CLAUDE.md, SystemMasterPrompt. |
| 2026-10-25 | **First Phase-2 slice.** `POST /v1/recon/runs`, `GET /v1/recon/runs/{id}` (scopes `runs:write`, `runs:read`), `GET /v1/findings?run_id=`; new crate `recon-engine` (worker + pure, order-independent check C1 over `invoice` / `clearance_status` records; ONE W transaction per run; a run that cannot be evaluated ends `failed` with a stable reason). Findings API now returns the `finding_view` shape the frontend validates (`finding_id`, `jurisdiction`, `summary`, `rule_citation`) — the live UI had shown "Unexpected response" because the API returned raw columns. `tools/dev/dev-idp.mjs` (dev-only OIDC provider), `tools/dev/seed-synthetic-pack.sql`, `recon-dev-seed`. |
| 2026-10-25 | **Public website, branded sign-in, one-command dev stack.** Frontend: own brand (mark whose two sources fill with hatch/dot patterns on hover), ink/paper palette, IBM Plex (self-hosted), scroll reveals, custom icon set (`lucide-react` and the unused `cn` package removed). New public pages `/`, `/platform`, `/checks`, `/trust`; `/login` page; console moved to `/overview` and gated by `proxy.ts`; auth handler failures now redirect to `/login?error=…` instead of a raw JSON page. Catalogs split per area (`messages/{en,ro}/*.json`). All site copy marks each capability `building` / `planned` / `later`; everything shown runs on synthetic data only. Bugs found while driving it live: the findings table fell back to a raw `Date` string (invalid `Intl` option mix), and the e2e helper could not create a `__Host-` cookie with `addCookies`. `node tools/dev/dev-up.mjs` starts databases, API, engine, dev IdP and frontend. Verified: `tsc`, eslint, 92 vitest, production build, 112 Playwright tests (axe in both themes and both locales, Lenis scoping, gating, login states). **Not verified:** Romanian copy (needs a native review), the real browser sign-in through the dev IdP's self-signed certificate (headless Chromium cannot accept it; the flow was verified with an HTTP client and a session cookie), Safari/Firefox. |
| 2026-10-25 | **Eight interface languages** (en, ro, it, es, fr, de, nl, pl; Belgium via nl/fr/de). Per-language catalogs (`messages/<lang>/*.json`, 8 areas), first-visit language from `Accept-Language`, language menu with endonyms, localized 404 and error pages, illustration labels moved from code into the catalogs. Parity (keys, `{placeholders}`, `<code>` tags, "actually translated") is enforced per language by unit tests and by the type checker; Playwright runs axe in both themes for every language and checks 360-px overflow for every language × public page. Translations were produced by AI agents from the English source and **have had no native-speaker review**; terms to confirm per language are listed by their authors (e.g. DE "Schweregrad", NL "bevinding", PL "rozbieżność", FR "constat", ES "hallazgo", IT "rilevazione" for *finding*; "tenant" literal or loanword in several). |

## 7. Drill and verification log

| Date | Drill / verification | Result |
|---|---|---|
| 2026-10-23 | DDL from DatabaseInfo.md applied to fresh W + R (PostgreSQL 18.6, EDB Windows binaries, one host, run as superuser except the test roles); subscription created with `failover = true, streaming = parallel, origin = none` (W slot reports `failover = t`) | **Applied** after the fixes in §6 |
| 2026-10-23 | Ledger: 6-event chain built via `ledger.append_event()`; independent JS implementation of the documented hash layout validated it on W **and** on R | PASS |
| 2026-10-23 | Ledger immutability: UPDATE, DELETE blocked (trigger); TRUNCATE … CASCADE blocked (trigger); role `w_cmd` cannot INSERT into `audit_event` or touch `chain_head`, can append via function; PUBLIC lost EXECUTE after REVOKE | PASS |
| 2026-10-23 | Tamper on R: normal session blocked by trigger; privileged bypass (`session_replication_role = replica`) altering `actor_ref` at seq 2 was **detected** by chain verification; W chain unaffected | PASS |
| 2026-10-23 | Bridge: LSN token (post-commit `pg_current_wal_insert_lsn()`) vs R `remote_lsn` — reached on an idle system, **not reached** after a non-replicated write (`remote_lsn` 0/1D5AB90 < token 0/1D5AD38; `latest_end_lsn` reached it but means "received"). Ledger-seq token: 12/12 trials exact (event row visible in the same snapshot whenever `last_seq ≥ token`), and exact after non-replicated WAL | LSN **rejected**; seq token adopted |
| 2026-10-23 | RLS on W and R (non-superuser role): tenant unset ⇒ error (fail closed); tenant A sees only its row; after the `SET LOCAL` transaction ends on the same session ⇒ error (empty string is not a uuid), no leak | PASS |
| 2026-10-23 | Crypto-shred: shredding without nulling the DEK rejected by CHECK; shred (state + NULL DEK) replicated to R; `api` schema absent on R | PASS |
| 2026-10-23 | DDL ordering: W-first additive column ⇒ row did not reach R, `apply_error_count` 0 → 3, **unrelated table replication also blocked** until column added on R, then all rows arrived; R-first ⇒ no errors; schema fingerprints equal afterwards | PASS (claim confirmed; stall severity newly documented) |
| 2026-10-23 | Fidelity: range hash of `ingest.source_batch` equal on W/R; injected row change on R detected | PASS |
| — | **Not verified:** pgvector/HNSW/halfvec (extension not in the binaries); W failover with slot synchronisation (single node, no standbys); PgBouncer + sqlx prepared statements; CloudNativePG/Patroni; performance or load; RFC 8785 canonicalisation (the test used `JSON.stringify` as a stand-in for already-sorted compact JSON); behaviour as non-superuser owner under `FORCE ROW LEVEL SECURITY`; Linux; real TSA | open — Phase 1 exit criteria |
