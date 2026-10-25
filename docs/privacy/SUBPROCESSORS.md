# Sub-processors

Status: **DRAFT** for the DPO/counsel. `reviewed_at`: not reviewed. `reviewer`: none. `next_review`: none.
Rule: R-PRIV-4 — tenant data stays in EU regions and no non-EU sub-processor receives tenant data. Until a processor is
listed here with a DPA reference and an EU region, it MUST NOT process tenant data. This file is not legal advice.

## Tenant data (ledger exports, authority-side records, findings, evidence)

| Processor | Service | Region | DPA reference | Status |
|---|---|---|---|---|
| — | — | — | — | **none engaged**. No production hosting provider has been chosen (D-2). |

Planned categories to be filled when D-2 is decided: EU cloud region (compute + object storage with Object Lock),
Postgres operator/support, observability. Each entry needs: legal entity, EU region, DPA signed, sub-processor list
received, transfer mechanism (none expected: intra-EU), and the date of the last review.

## Billing data (never tenant reconciliation data)

| Processor | Service | Data | Status |
|---|---|---|---|
| Stripe Payments Europe, Limited (IE) | Subscription billing, Checkout, invoices | Billing identity (company name, billing address, VAT id, e-mail), amounts. **No invoice lines, no ledger data, no findings.** | planned; DPA to be signed before `BILLING_ENABLED=true` |

Stripe is US-parented. The assessment in `docs/privacy/ROPA.md` §10 records the position: billing identity only,
no tenant data, DPA + EU entity. Counsel/DPO to confirm.

## Not sub-processors, but relevant

- **Identity provider** (D-3, undecided): authentication only; receives e-mail/name at sign-in. To be listed here once chosen.
- **Vercel** (frontend hosting): today only the public marketing site is deployed there; the BFF proxies API calls
  through Vercel functions, which would make Vercel a processor for tenant data the moment the console is used in
  production. It is **not listed above** because no production console is live. Adding it requires an EU function
  region (`fra1`), a DPA and an entry in this table.

## Change control

Adding or replacing a processor requires: DPA, region confirmation, an entry here, a ROPA update, and a review by the
DPO. Customer-facing text must not name a processor that is not listed here.
