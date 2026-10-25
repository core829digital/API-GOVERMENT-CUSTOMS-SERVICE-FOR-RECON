<!--
PR title = squash-commit header, Conventional Commits: `type(scope): description`
(feat fix docs style refactor perf test build ci chore revert). Commits must be signed (R-GEN-3).
Checklist mirrors Workflow.md §12 (definition of done). Tick only what you actually did.
-->

## What and why

<!-- One logical change per PR (R-GEN-3). Link the Progress.md item or issue. -->

## Definition of done (Workflow.md §12)

- [ ] **1. Behaviour exercised by running it**, not only unit tests. DB changes were verified on the W+R pair (not mocks).
  - How I ran it / what I observed:
- [ ] **2. Rules.md satisfied**; the enforcing gate is green (cite the `R-…` ids touched):
- [ ] **3. Docs updated (R-DOC-3)**: `DatabaseInfo.md` for schema/roles/grants, regenerated `openapi/openapi.json` + `frontend/lib/api/openapi.d.ts` for the API, Architecture.md for failure behaviour, runbooks for new alerts; **Progress.md updated**.
- [ ] **4. Gated path touched?** (`rules/`, `docs/privacy/`, `migrations/`, `crates/recon-evidence/`, `infra/policies/`)
  - [ ] No
  - [ ] Yes: human compliance approval requested from `@core829srl/compliance` (gate L11; the approval must be on the latest commit)
- [ ] **5. No unverified regulatory claims** (R-DOC-1): every legal statement cites a primary source (CELEX/ELI/authority URL), article and access date, or is tagged `[UNVERIFIED]` and kept out of rule packs.

## Also check

- [ ] No stubs, TODO-implement or mocks standing in for behaviour (R-GEN-1).
- [ ] Destructive migration? It ships in a later release than the code that stops using the object, and carries `-- destructive: reviewed` (R-DB-8).
- [ ] No secrets, no PII in logs/fixtures (R-SEC-2, R-PRIV-1).
- [ ] Waiver added or changed in `docs/waivers.yml`? Owner, reason, linked issue, expiry <= 90 days. (L4, L6, L7, L10, L11 cannot be waived.)
