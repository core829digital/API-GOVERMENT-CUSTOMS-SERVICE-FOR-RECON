---
doc: ROPA
status: draft
reviewed_at:
reviewer: UNREVIEWED
next_review: 2027-01-23
---

# Record of processing activities — `recon` (DRAFT)

> **DRAFT for the Data Protection Officer and counsel. Not legal advice. Not reviewed by any human.** Prepared 2026-10-23 by an AI agent. This is a working draft of the record that GDPR Art. 30 asks controllers (Art. 30(1)) and processors (Art. 30(2)) to keep in writing and to make available to the supervisory authority on request (Art. 30(3)–(4)); article text read at EUR-Lex (CELEX:32016R0679) on 2026-10-23. Whether Art. 30(5) exempts the operator (fewer than 250 persons, unless the processing is likely to result in a risk, is not occasional, or includes special categories) is for the DPO; the exemption has conditions that this service probably does not meet (processing is not occasional). **[OPEN]**

How this file is produced: the table between the machine markers below is **generated** from the `COMMENT ON COLUMN` classification strings of every column in the replicated schemas (`core, ingest, recon, rules, ledger, privacy, ops` — the schemas of publication `recon_pub`; the unpublished `api` schema is not covered by gate L4 and therefore not by the generated block, see §1a) by gate L4. Do not edit it by hand: run `node tools/legal-audit/cli.mjs gate L4 --w-url <admin url> --migrate-bin <recon-migrate> --write-ropa` (options in the header of `tools/legal-audit/gates/l4.mjs`); gate L5 fails when the block differs from what L4 derives. The block is intentionally **empty of data rows** in this draft; the parent change fills it from the migrated schema. Everything outside the markers is human-maintained.

Columns in the table mean: `class` (`public`, `internal`, `financial`, `pii`, `pii_id`, `secret`), `basis` (the GDPR Art. 6(1) point the design assumes, or `contract_6_1_b`, or `none`), `retention` (a `privacy.retention_policy.data_class` name), `encrypted` (`true`, `hmac`, `hash`, `pseudonymous`, `none`).

## 1. Column-level record (machine-managed)

<!-- ropa:begin -->
| column | class | basis | retention | encrypted |
|---|---|---|---|---|
<!-- ropa:end -->

## 2. Controller / processor details (Art. 30(1)(a), 30(2)(a)) — **[OPEN]**

| Item | Value |
|---|---|
| Operator legal entity | not recorded in the repository; project documents mention a company form "SRL" only as an assumption (Progress.md D-1) |
| Contact details | [OPEN] |
| Data protection officer | not appointed (Progress.md D-5) |
| EU representative (if applicable) | [OPEN] — depends on establishment |
| Role | working assumption: processor for tenant records, controller for its own account/operations data (Workflow.md §8); to be confirmed by counsel (DPIA §2.2). If processor, Art. 30(2) requires one record per controller (per tenant); this draft does not yet separate them |

## 3. Purposes of processing (Art. 30(1)(b))

1. Reconcile a tenant's books against the copies held by authorities and produce findings with cited rules and tamper-evident evidence.
2. Keep an append-only, hash-chained log of commands and privacy decisions (legal-evidence function, Architecture.md §10).
3. Operate and verify the platform: fidelity checks between the authoritative cluster W and the derived cluster R, monitoring, backups.
4. Authenticate users and API keys; isolate tenants.
5. Apply retention, legal-hold and erasure decisions (crypto-shredding).

No marketing, profiling of natural persons, or sale of data is designed. Purposes and legal basis per column: **[OPEN]** — DPIA §2.6.

## 4. Categories of data subjects and personal data (Art. 30(1)(c))

| Data subjects | Personal data (examples; the authoritative per-column list is the generated block above) |
|---|---|
| Natural persons appearing in tenant records (sole traders, individual counterparties, contact persons) | VAT/tax identifiers (stored as ciphertext + keyed HMAC, **designed, not implemented**), possibly names and addresses inside uploaded source files held in EU object storage (not parsed yet) |
| End users of the web UI | OIDC subject and claims released by the identity provider (provider undecided, D-3); session cookie |
| API-key holders | key id (pseudonymous reference written to the ledger as `actor_ref`), key prefix |

Special categories (GDPR Art. 9) and criminal-offence data (Art. 10): none designed. Not analysed further. **[OPEN]**

## 5. Recipients (Art. 30(1)(d))

None decided. No sub-processor exists in the repository (see [SUBPROCESSORS.md](SUBPROCESSORS.md)). Authorities are **not** recipients of data from this service: the service reads or receives authority-side copies on the tenant's behalf; it does not file. **[OPEN]** confirm with product scope (D-1).

## 6. Transfers to third countries (Art. 30(1)(e))

**None, by design** (R-PRIV-4): tenant data stays in EU regions; no non-EU sub-processor; no SaaS model API on tenant data. See [TIA.md](TIA.md). The design is not yet verifiable at infrastructure level (hosting provider undecided, D-2).

## 7. Retention (Art. 30(1)(f)) — reference only

Retention periods are data in `privacy.retention_policy` (jurisdiction, data class, months, citation), not text in this file. The `retention` column of the generated table names the data class. As of 2026-10-23 the table has **no rows**, and per-country periods have **not been verified** (`rules/UNVERIFIED.md`); the privacy procedures refuse erasure and purge until a policy applies. The one EU-level period found is the 10-year OSS record period (`rules/EU/oss.yaml` `OSS-012`). Invoice-storage periods are set by each Member State (Directive 2006/112/EC Art. 247(1)). **[OPEN]**

## 8. Security measures (Art. 30(1)(g), 30(2)(d)) — general description

Summary only; detail and status per measure (built / recorded / designed / not built) are in [DPIA.md](DPIA.md) §5: tenant row-level security in both clusters; role separation with no DDL/DELETE/TRUNCATE for application roles; append-only hash-chained ledger without PII in payloads; envelope encryption of identifier columns and crypto-shredding (**encryption designed, not implemented**); EU-only hosting; TLS; signed releases. This summary must not be read as a statement that the measures are in operation: no deployment exists.

## 9. Maintenance

- Any new data category or processing purpose ⇒ this record and the DPIA are updated in the same pull request (Rules.md R-PRIV-7); gate L4 reports a ROPA diff when columns change.
- Review: `next_review: 2027-01-23` or sooner on change. Reviewer and review date are recorded in the front matter once a human has reviewed it.

## 10. Billing and payment data — processing row (DRAFT for the DPO; added 2026-10-25)

> **DRAFT. Not legal advice. Not reviewed by any human.** Added with `migrations/w/0008_billing.sql` and `crates/recon-billing` (Rules.md R-PRIV-7). Nothing below is in operation: no deployment exists and no payment-provider account has been configured. The `billing` schema is W-only and not in publication `recon_pub`, so gate L4 does not read it and the generated block in §1 does not list its columns; the classification comments exist in the migration (`COMMENT ON COLUMN billing.*`) and are summarised here by hand until L4 covers the schema.

| Item | Entry |
|---|---|
| Processing activity | Selling and administering paid subscriptions: plan assignment, entitlement and usage limits, payment-status handling, invoice references. |
| Purpose | Perform the subscription contract (Art. 6(1)(b)); keep invoice and accounting references (Art. 6(1)(c), period per national law — **[OPEN]**, `privacy.retention_policy` has no rows); enforce plan limits and prevent use beyond a lapsed subscription (contract; Art. 6(1)(f) for abuse prevention — **[OPEN]** DPO). |
| Data subjects | Customers' billing contacts and representatives. Tenants are companies, but a sole trader's data is personal data. |
| Data held by us (W, schema `billing`) | Tenant id; plan/status/period dates; Stripe customer, subscription and invoice **identifiers** (opaque; `provider_customer_id` is classified `internal` in the column comment but treated here as pseudonymous personal data because a customer may be a sole trader — DPO to decide whether to reclassify); invoice number, amount in minor units, currency, status; the Stripe-hosted invoice link (`hosted_url`, classified `secret`: a bearer link to a page that shows the customer's billing details, unencrypted at rest — **[OPEN]**); usage counters and idempotency keys; provider event ids with an allow-listed projection of each event. **Not held by us:** billing name, billing address, VAT id, e-mail, card or bank data — entered on Stripe's hosted pages and stored by Stripe only. |
| Ledger | Subscription creation, plan change, status change and cancel-at-period-end change are appended to the tenant's ledger with opaque ids only (no names, no provider customer id, no amounts). |
| Recipient / processor | **Stripe** (payment provider; role assumptions below). Entity and contract: **[UNVERIFIED]** which Stripe entity contracts with the operator and under which agreement version. |
| Data sent to Stripe | Tenant UUID and plan UUID (as `client_reference_id` and metadata), the Stripe price id, return URLs, and everything the customer enters on Stripe's pages. **No reconciliation data, findings, source records, evidence, tenant name or API keys are ever sent** (enforced by what the code puts in the request; asserted by a test on the exact form fields). |
| Transfers to third countries (Art. 30(1)(e)) | **Stripe is a US-parented processor. Data-residency caveat:** R-PRIV-4 ("no non-EU sub-processor receives tenant data") is satisfied for *tenant reconciliation data* by design, because none is sent. Billing identity data *does* go to a provider whose parent is US-based; whether it is stored or accessed outside the EEA, and the transfer mechanism, are **[UNVERIFIED]**. Stripe's published DPA (https://stripe.com/legal/dpa, accessed 2026-10-25) describes Stripe acting as processor and, for some purposes, as (joint/independent) controller, and lists the EU–US Data Privacy Framework and the EEA SCCs (Modules 1–3) among its transfer mechanisms; this was **not** checked against the operator's actual account or against a transfer impact assessment. Decision for the DPO and counsel before any live key is configured: accept with documented mechanism and add Stripe to SUBPROCESSORS.md and TIA.md, or choose an EU-only provider (the provider-specific code is confined to `stripe.rs`, `signature.rs`, `event.rs`). |
| Retention (Art. 30(1)(f)) | Retention classes in the column comments: `tax_record` (subscription, invoice references), `operational` (plans, usage, provider events). Periods **[OPEN]**. No purge procedure for `billing.usage_consumption` exists yet. |
| Security measures | Row-level security with fail-closed tenant binding; application roles have no direct write access to billing tables (state changes only through narrow `SECURITY DEFINER` functions); webhook authenticated by Stripe signature (HMAC-SHA256, constant-time, 5-minute tolerance) over the raw body; secrets only from the environment and redacted in `Debug`/`Display`; return URLs restricted to an allow-list of origins; stored event payloads are an allow-list projection, never the raw event. |
| Open items for the DPO | (1) Stripe's role per purpose and DPA/SCC/DPF basis; (2) add Stripe to SUBPROCESSORS.md and TIA.md; (3) retention period for invoice references; (4) whether `hosted_url` must be encrypted at rest; (5) DPIA update for the new category; (6) legal basis for limit enforcement. |
