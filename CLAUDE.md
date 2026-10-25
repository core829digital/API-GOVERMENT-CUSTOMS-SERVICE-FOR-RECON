# CLAUDE.md

Project instructions for AI coding agents. Humans: start with Architecture.md.

**State: design phase. No application code exists yet.** Do not describe planned commands or crates as working. See Progress.md for current status and open decisions.

## What this is

An EU-compliant **API service that reconciles a company's books against the copy each authority holds** (e-invoice clearance data, SAF-T, VAT/OSS returns, customs import data, VIES) and produces **findings with cited legal basis plus tamper-evident, time-stamped evidence packs**. Working name: `recon` (decision D-6).

Why this and not another tax tool: authorities now hold the other side of the numbers and cross-match them; mismatches trigger audits. Rationale, evidence, and — importantly — what is **not yet proven** are in `docs/Research.md`. Do not claim "no competitor does this"; the claim is unverified.

Not in v1: filing, payroll/social security, transfer pricing/DAC6, PE risk, WHT, MAP, KYC/seller onboarding.

The service is **not a tax adviser**; findings state that sources disagree under a cited rule. Never write UI or API text that gives legal advice.

## Document map

| File | Read when |
|---|---|
| `Architecture.md` | designing or changing any component, failure behaviour, scaling |
| `DatabaseInfo.md` | touching schema, roles, replication, ledger, migrations |
| `Rules.md` | before every change — numbered, CI-mapped rules (`R-…`) |
| `Workflow.md` | CI, legal-audit gate, release, migrations, incidents |
| `SystemMasterPrompt.md` | writing prompts/agents; defines non-negotiable agent behaviour |
| `AGENTS.md` | delegating work to subagents |
| `Progress.md` | what is done, what is blocked, open decisions D-1…D-8 |
| `docs/Research.md` | any regulatory or competitive statement |

Filenames `CLAUDE.md` and `AGENTS.md` are uppercase because tools look for them; the rest follow the brief's names.

## Stack (decided) — pin exact versions at scaffold, verified current as of 2026-10-23

- Rust, Cargo workspace; Axum + Tokio + sqlx. (Pin versions from crates.io at scaffold; none are recorded here to avoid stale claims.)
- PostgreSQL **18.x** (18.6 current), pgvector **0.8.x** (0.8.6 current).
- **Two clusters:** **W** = only authoritative, only written by commands. **R** = derived copy (logical replication) + projections + vectors; only queried by the API. Details: Architecture.md §5.
- Frontend: Next.js (App Router), shadcn/ui, Tailwind, **Lenis** (scoped), TanStack Query, generated OpenAPI client.
- Kubernetes, EU-only regions, Postgres operator (CloudNativePG proposed; spike required).
- No Kafka, Redis, service mesh, Citus, `postgres_fdw` in v1 (Architecture.md §14).

## Invariants — violating any of these is a bug regardless of tests

1. API query handlers use `ReadStore` (cluster R); command handlers use `WriteStore` (cluster W). Nothing crosses. Only `recon-store::bridge` waits for replication (ledger-sequence token, never LSN). (R-DB-1…4)
2. Ledger is append-only, written only through `ledger.append_event()`. (R-DB-6)
3. Money is integer minor units + currency; time is UTC `timestamptz`; keys are UUIDv7; no sequences on replicated tables. (R-DB-2, R-DB-3)
4. Tenant isolation via RLS in **both** clusters; unset tenant fails closed. (R-SEC-3)
5. No PII in logs, traces, ledger payloads, or embeddings. (R-PRIV-1, R-AI-2)
6. Findings are deterministic: same input hashes + same rule-pack version → same output. No LLM decides a finding. (R-ENG-1, R-AI-1)
7. Every rule, retention period, and country date is **data with a citation** (CELEX/ELI/URL, article, access date, validity). Never a constant in code. (R-DOC-1, R-RULES-1)
8. Regulatory statements require a primary source. If unverified, mark it `[UNVERIFIED]`. (R-DOC-1)
9. EU-only data residency; no tenant data to non-EU processors or SaaS LLM APIs. (R-PRIV-4, R-AI-2)

## Working agreement

- Read the relevant doc section before editing; follow existing patterns; one convention only.
- Change a contract (schema, API, ledger layout, role grants) → update the matching doc in the same PR (CI doc-drift checks apply).
- Run the thing you changed; tests alone are not proof. For DB work, run against two real Postgres 18 instances with replication, not mocks.
- Do not pad scope: no features, retries, abstractions, or telemetry not asked for.
- Regulatory research: use `scout` for discovery, then verify load-bearing claims against EUR-Lex/authority pages in a second pass. The first research pass for this project contained 10+ factual errors (Research.md §1).
- Prefer asking the user for genuine decisions (D-x list) over guessing; otherwise choose the conservative, standard option and state it.

## Planned layout (does not exist yet)

```
crates/ recon-domain  recon-store  recon-rules  recon-ingest  recon-engine
        recon-evidence  recon-embed  recon-api  recon-worker  recon-migrate  recon-verify
frontend/        Next.js app
migrations/      w/ r/ both/
rules/           rule packs (YAML + citations), CODEOWNERS-gated
infra/           k8s, helm, terraform, conftest policies
docs/            Research.md, privacy/ (DPIA, ROPA, TIA, SUBPROCESSORS), runbooks/
.github/workflows/  ci.yml  (includes legal-audit job)  release.yml
```

## Commands

**One command (recommended).** From the repo root: `node tools/dev/dev-up.mjs` (Windows: `dev`). It builds the Rust binaries, starts the two databases, migrates them and creates the replication subscription on a fresh pair, creates the non-superuser roles, one tenant and one API key (`.dev/dev-state.json`, gitignored), then starts API, engine worker, dev identity provider and the frontend, and loads a SYNTHETIC demo data set. Open http://localhost:3000. `Ctrl+C` stops the services; `dev down` also stops the databases; `dev status` shows what listens. Flags: `--no-demo`, `--no-web`, `--reset` (wipes `.dev/pg` and the dev state). Ports/paths via `DEV_PORT_W|R|API|IDP|WEB`, `DEV_DIR`, `PG_BIN` (auto-detected on Windows). Verified 2026-10-25: a fresh database pair (migrations, subscription, roles, tenant, key, demo run, engine, 5 findings through the API) and a restart on the existing pair; the full stack including the frontend was then driven in a browser.

What it does, step by step (use these when you need to run one piece alone). Local dev stack (Windows paths shown; PostgreSQL 18 binaries are not on `PATH`, so set `PG_BIN`):

```bash
# 1. W (5440) + R (5441) clusters. Idempotent; `reset` wipes .dev/pg.
PG_BIN="C:/Users/conta/AppData/Local/Temp/pg/pgsql/bin" node tools/dev/pg-pair.mjs start

# 2. First time on a fresh pair only: migrate R first, then W, then subscribe (R `--to 0005` if pgvector is missing)
cargo run -p recon-migrate -- up --target r --url postgres://postgres@localhost:5441/recon_r
cargo run -p recon-migrate -- up --target w --url postgres://postgres@localhost:5440/recon_w
RECON_W_CONNINFO="host=localhost port=5440 dbname=recon_w user=postgres" \
  cargo run -p recon-migrate -- subscribe --r-url postgres://postgres@localhost:5441/recon_r

# 3. Non-superuser login roles (superusers bypass RLS). Create once with psql as `postgres`:
#    W: dev_w_admin IN ROLE w_admin, dev_w_cmd IN ROLE w_cmd, dev_w_worker IN ROLE w_worker;  R: dev_r_api IN ROLE r_api

# 4. API: public listener http://127.0.0.1:8080 (customers, API keys) + internal listener http://127.0.0.1:8081 (our services; allowlisted
#    client IP + RECON-SVC-V1 signature + API key). The process refuses to start without RECON_INTERNAL_ALLOWED_CIDRS and RECON_SERVICE_KEYS.
#    Dev service key: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
RECON_W_URL=postgres://dev_w_cmd@localhost:5440/recon_w RECON_R_URL=postgres://dev_r_api@localhost:5441/recon_r \
  RECON_INTERNAL_ALLOWED_CIDRS=127.0.0.1/32,::1/128 RECON_SERVICE_KEYS=dev-bff:<base64url secret, >= 32 bytes> \
  cargo run -p recon-api --bin recon-api

# 5. Tenant + API key (the token is printed once)
RECON_ADMIN_W_URL=postgres://dev_w_admin@localhost:5440/recon_w cargo run -p recon-api --bin recon-admin -- create-tenant --name Dev
RECON_W_URL=postgres://dev_w_cmd@localhost:5440/recon_w cargo run -p recon-api --bin recon-admin -- issue-api-key --tenant <UUID> \
  --scope batches:write --scope batches:read --scope findings:read --scope runs:write --scope runs:read

# 6. Browser: dev-only mock IdP (https://localhost:9443, signs anyone in, hands the API key to the BFF) + frontend
RECON_DEV_API_TOKEN=rk_... node tools/dev/dev-idp.mjs
cd frontend && NODE_EXTRA_CA_CERTS=<repo>/.dev/idp/cert.pem OIDC_ISSUER=https://localhost:9443 OIDC_CLIENT_ID=recon-web \
  APP_BASE_URL=http://localhost:3000 RECON_API_BASE_URL=http://127.0.0.1:8080 RECON_API_INTERNAL_URL=http://127.0.0.1:8081 \
  RECON_SERVICE_KEY_ID=dev-bff RECON_SERVICE_KEY_SECRET=<the same secret> SESSION_SECRET=<base64url 32 bytes> npm run dev
# open http://localhost:3000 (accept the self-signed certificate of https://localhost:9443 once)

# 7. Engine and synthetic data (dev/test only; the synthetic pack makes no regulatory claim)
psql -h localhost -p 5440 -U postgres -d recon_w -f tools/dev/seed-synthetic-pack.sql     # prints rule_pack_id
RECON_W_URL=postgres://dev_w_cmd@localhost:5440/recon_w cargo run -p recon-engine --bin recon-dev-seed -- --tenant <UUID>  # prints batch ids
#    POST /v1/recon/runs {"rule_pack_id": ..., "batch_ids": [...]} with an Idempotency-Key header, then:
RECON_W_URL=postgres://dev_w_worker@localhost:5440/recon_w RECON_R_URL=postgres://dev_r_api@localhost:5441/recon_r \
  cargo run -p recon-engine --bin recon-engine            # add `-- --once` for a single pass
```

Tests need real clusters: `RECON_TEST_W_URL=postgres://postgres@localhost:5440/recon_w RECON_TEST_R_URL=postgres://postgres@localhost:5441/recon_r cargo test --workspace`.
On Windows stop `recon-api` before rebuilding it (the running `.exe` is locked).

Frontend conventions (R-FE-3, R-FE-5): the interface is available in eight languages — `en` (source of truth and type of the rest), `ro`, `it`, `es`, `fr`, `de`, `nl`, `pl`; Belgium is served by `nl`, `fr` and `de` (regional tags such as `nl-BE` map to the language), there is no separate "Belgian" catalog. Copy lives in `frontend/messages/<lang>/<area>.json` (areas: app, site, pages, home, platform, checks, trust, login; merged by `messages/index.ts`; one top-level namespace per file; every language key-identical to `en`, enforced by `tests/i18n.test.ts` and by the TypeScript build; no literal text in JSX or in code constants that reach the screen). The first-visit language follows `Accept-Language` (`negotiateLocale` in `i18n/config.ts`); the language menu sets the `recon_locale` cookie, which wins. Adding a language: add it to `locales`, to `shell.language.*` in every `app.json`, create the seven-plus-one files, add the imports in `messages/index.ts`. **No catalog other than `en` has had a native-speaker review**; the translations were machine-produced and the legal-tone statements ("not tax advice", findings as disagreements) need a human check per language. Icons come from `components/icons.tsx` (project set, no icon dependency): `shadcn add` may re-introduce `lucide-react` imports; replace them. Routes: public `(site)` = `/`, `/platform`, `/checks`, `/trust`; `(auth)` = `/login`; console = `/overview`, `/findings`, `/batches/[id]`, gated by `proxy.ts`. Lenis only in `(site)` and `(overview)`. The default theme is dark.

