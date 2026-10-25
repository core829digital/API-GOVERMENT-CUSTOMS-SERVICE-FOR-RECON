# Strategy.md — Is this business real, and what must be true for it to make money

Status: decision document, first draft 2026-10-25. Tags: **V** verified on a primary source by the second pass, **S** scout-reported only, **K** prior knowledge, **[UNVERIFIED]** could not be checked. Nothing here is legal, tax or investment advice. Customer-facing text may only use **V** facts.

## 0. Verdict in one paragraph

The *technical* premise holds: in Poland, Romania and Italy the tax authority already holds a machine-readable copy of invoices, and a third party can be authorised to read it for a customer (KSeF permissions; ANAF OAuth with the customer's qualified certificate; SdI delegation through an intermediary). The *commercial* premise is **not yet proven**: there is no evidence that companies pay for ledger-vs-authority reconciliation at SMB/mid-market scale, and the only products that do this are enterprise, quote-only suites. So this is a **credible but unvalidated business**: buildable, plausibly monetisable, but it must pass a demand gate before more engineering. A pre-revenue Romanian SRL should expect **6–12 months to the first paying design partner and 12–24 months to a defensible ARR**, not weeks.

## 1. What is actually true today (evidence)

| Claim | Tag | Source |
|---|---|---|
| KSeF 2.0 is the current Polish clearance API (mandatory from 1 Feb 2026 per the official migration note); it has a permission model that lets one entity grant another the right to read or issue invoices, including re-delegation to employees ("uprawnienia pośrednie", `permissions/entities/grants`) | V | [ksef-docs: KSeF API 2.0 changes](https://github.com/CIRFMF/ksef-docs/blob/main/przeglad-kluczowych-zmian-ksef-api-2-0.md) |
| KSeF publishes an OpenAPI v2 specification, a test environment, official client libraries and documented rate limits | V | same |
| Romania's ANAF exposes an OAuth2 API; authentication happens with the taxpayer's **qualified digital certificate** at `logincert.anaf.ro`; a software vendor registers an application ("client app id") and the token carries the user's SPV rights (legal representative, designated representative, proxy) | V | [ANAF OAuth2 registration procedure (PDF)](https://static.anaf.ro/static/10/Anaf/Informatii_R/API/Oauth_procedura_inregistrare_aplicatii_portal_ANAF.pdf) |
| Italy delegates e-invoicing consultation to intermediaries through a formal delegation recorded in a register; delegation of consumer invoices to third parties is explicitly **not** possible | V | [Agenzia delle Entrate FAQ deleghe](https://www.agenziaentrate.gov.it/portale/schede/comunicazioni/fatture-e-corrispettivi/faq-fe/risposte-alle-domande-piu-frequenti-categoria/deleghe-ai-servizi-di-fatturazione-elettronica-intermediari) |
| Avalara VAT Reporting already "provides reconciliation reports to match VAT returns with your general ledger (GL)" (48 countries); Sovos Intelligence matches e-invoicing data, filings and SAF-T and classifies matched/unmatched/exception; Thomson Reuters ONESOURCE Reconciliations does e-invoice-vs-return at line level | V (Avalara), S (Sovos Intelligence, ONESOURCE) | [Avalara](https://www.avalara.com/us/en/products/vat-returns-and-reporting.html), [Sovos](https://sovos.com/press-releases/the-expansion-of-sovos-intelligence-closes-the-global-compliance-reconciliation-gap/), [Thomson Reuters](https://www.thomsonreuters.com/en-us/posts/innovation/real-time-tax-reporting-is-here-manual-reconciliation-isnt-going-to-keep-up/) |
| Those four reconciliation-class vendors publish no price; Sovos states its pricing is custom and names self-service, credit-card buyers as a poor fit | V (Sovos), S (others) | [Sovos solutions page](https://sovos.com/taxapedia/solutions/) |
| Published self-serve prices in the neighbourhood: Recommand €29/€99/€199/€349 per month by document volume; Invopop Pro €500 + Pops + €300 per extra country; Quaderno 24–149; Viesvat €49/€199; Stripe Tax USD 90–1,500 | V | docs/Research.md §7 |
| Demand evidence: a vendor-sponsored survey of 230 IDT professionals reports 10% fully automated reconciliation | S | [TR Institute](https://www.thomsonreuters.com/en/institute/reports/indirect-tax-europe-report-2026) |
| Willingness to pay for this specific product | **none found** | documented search; K-2 stays open |
| EIC Accelerator: grant below €2.5M, equity €1–10M, TRL 6–8, 2026 batching dates (7 Jan, 4 Mar, 6 May, 8 Jul, 2 Sep, 4 Nov) | V | [EIC Accelerator](https://eic.ec.europa.eu/eic-funding-opportunities/eic-accelerator_en) |
| Number of active enterprises per country; SMB e-invoicing penetration; sales-cycle benchmarks | **[UNVERIFIED]** — not fetched in this pass | — |

## 2. The nine questions

### 1. How do we monetise?

Subscription with a metered component, priced inside the verified band (Research §7.2): **Sandbox €0 · Starter €49 · Growth €149 · Scale €399 per month · Enterprise quote**, annual −15%. The metered unit is **records processed per month**; overage offers an upgrade instead of a surprise bill (Quaderno model). Additional revenue levers, in order of realism:

1. **Design-partner pilots** (€500–2,000/month, 3–6 months) before self-serve exists. This is the realistic first revenue.
2. **Per-country add-on** (Invopop charges €300/month per extra government app — V). Justified only when an adapter exists.
3. **Evidence-pack retention** beyond the plan window (object storage cost pass-through plus margin).
4. **Accounting-firm seat pooling** (Recommand pools volume across companies — V): one firm, many client tenants.

Do **not** sell the current build as a production subscription: the pricing page must mark every planned capability, and checkout stays disabled (`BILLING_ENABLED=false`) until Progress.md commercial gates pass.

### 2. How will the service be used?

Three loops, in this order of adoption cost:

- **API loop** (developer): register tenant → upload ERP ledger export + authority-side data → create run pinned to a rule pack → read findings → download evidence pack. Every write is idempotent; every read can wait for replication (`X-Min-Seq`).
- **Console loop** (finance user): sign in with the company IdP → onboarding wizard (entity, countries, ERP, pain questions) → connect data → see findings with cited rules → acknowledge/annotate → export.
- **Accountant loop** (channel): one firm, many client entities, pooled volume, one dashboard, delegated authority access where the country allows it.

### 3. How do we reach the user's pain point?

Not by advertising "reconciliation". By three concrete triggers that already exist in the market:

1. **Mandate deadlines** (KSeF 2026, Romania e-Factura, Italy SdI). Search intent is "am I compliant", not "reconcile my ledger".
2. **Authority letters**: ANAF mismatch notices, Italian anomaly letters, Polish pre-audit checks. The product is the answer to a letter already received.
3. **Accountants' close process**: the firm that already does the client's books is the buyer of the monitoring layer, and the cheapest channel.

Channel plan: (a) 3 accounting firms in RO as design partners; (b) integration listings where the ERP/accounting vendors publish partner programmes; (c) content on the specific mismatch mechanics with primary-source citations. Paid acquisition is not justified before CAC is measured.

### 4. What is the pain point?

Stated as a testable hypothesis, not a fact: *a finance team discovers a difference between its books and the authority's copy only when a notice or audit arrives; reconstructing why is expensive, and penalties or forced payments follow.* Evidence for consequences exists (penalty regimes, authority cross-checks); evidence that this is a **top-three** pain for SMB finance teams is **[UNVERIFIED]**. That is exactly what the 15 interviews must answer. Falsifiers: (i) interviewees say their ERP already surfaces the mismatch; (ii) they would not pay €49–149/month; (iii) accountants perform the check manually in minutes.

### 5. How do we protect user data?

Layered (onion) controls, mapped to code and docs:

| Layer | Control | State |
|---|---|---|
| Edge | rate limits (pre-auth per IP before Argon2, post-auth per key/tenant), body size limits, strict JSON, allowlisted BFF routes, CSP + security headers | implemented and tested in this pass |
| Transport | TLS 1.3, signed service requests (RECON-SVC-V1, HMAC over method/target/time/nonce/body, 60 s window, nonce replay cache) on a separate internal listener with an IP CIDR allowlist | implemented; internal listener verified locally |
| Identity | OIDC (EU-hosted IdP), sealed HttpOnly session cookie, API keys Argon2id, scope checks | session + keys exist; **users/RBAC not built yet** |
| Data | RLS on both clusters, tenant bound per transaction, fail closed; PII as application-layer ciphertext; crypto-shredding; no PII in logs/ledger/embeddings | implemented and tested on a local pair |
| Storage | `pg_hba.conf` template: `hostssl`, scram/client cert, per-role lines, final `reject`, replication only from R | template added; **not exercised on a real cluster** |
| Database | allowlisted access from our servers' CIDRs; `sslmode=verify-full` | documented |
| Audit | hash-chained ledger; signed security events | ledger V; **signed security events not built yet** |
| Process | DPIA/ROPA drafts, sub-processor list (**missing file**), pen test (open), DPO (open) | partial |

### 6. How do we give verified information without bluffing?

A three-state labelling rule, enforced in the app, not in prose:

- **Verified** — the statement comes from `rules.legal_source` with a CELEX/ELI/authority URL, article, access date and validity window, and a named human approver reviewed it.
- **Unreviewed** — the same shape, but no approver: shown with an explicit badge and never used in a finding's citation.
- **Detected change** — the watcher saw the cited page/act change: shown as a notice with the old and new hash, no claim about what the change means until a human classifies it.

No LLM writes a finding, a citation or a legal statement (R-AI-1/3). Rule packs are drafts until a compliance owner signs (open item).

### 7. How do we stay compliant?

| Obligation | What it needs | State |
|---|---|---|
| GDPR Art. 30 / 35 | ROPA and DPIA with reviewer and next-review dates | drafts exist, no human review |
| GDPR Art. 28 | DPA per processor; sub-processor list | **missing `docs/privacy/SUBPROCESSORS.md`** |
| Data residency (R-PRIV-4) | EU-only hosting and processors; no tenant data to Stripe, only billing identity | design; provider undecided (D-2) |
| eIDAS timestamps | qualified TSA on the EU Trusted List | undecided (D-7) |
| Tax-advice boundary | counsel opinion per country; wording rules | undecided (D-5) |
| NIS2 / DORA | scope assessment | not assessed |
| Selling the subscription | VAT: B2B reverse charge / OSS; invoice content; consumer rights | **needs the accountant**; not implemented |
| AI Act | advisory retrieval only; transparency notice | design rule |

### 8. How do we manage users, and is it scalable?

Users: one identity per person (OIDC), membership of one or more tenants, roles `owner`, `admin`, `analyst`, `viewer`, plus platform role `superadmin` (yours) that is **not** a tenant role. Superadmin actions are read-only in the console, masked, and write a signed audit event. This is not built yet; the tables and the JWT claim validation are the next slice.

Scalability: stateless API replicas behind an LB; W/R split; engine workers claim runs with `FOR UPDATE SKIP LOCKED`. Known bottlenecks: (a) per-tenant serial ledger appends (K-5) — heavy tenants must batch events or be sharded; (b) in-process rate limiting is per replica (documented); (c) the BFF is serverless and cannot hold long connections; (d) reconciliation runs are CPU-bound per run and scale horizontally. No load test exists — every capacity claim is a design target.

### 9. How does a user get an answer? Chat, AI, onboarding, workflow, news?

- **Onboarding** asks the questions that decide the first answer: entity and VAT id, countries, ERP/invoicing system, authority-side access (does the client hold a qualified certificate / KSeF permission?), what triggered the interest (notice, deadline, close), volume. It ends with a **first successful run** on the user's own data, not a tour.
- **Guidance**: a guided questionnaire maps the user's situation to *candidate checks*, then shows **cited retrieval** over the legal corpus. A free-form chat that answers legal questions is **deliberately not shipped** until an EU-hosted model and an evaluation harness exist; when it arrives, answers must be retrieval-bounded and display sources, and it still cannot create findings.
- **Workflow**: upload → normalise → run → findings → acknowledge/annotate → evidence pack → (later) filing is out of scope.
- **Legislation freshness**: a `recon-watch` worker fetches primary sources (EUR-Lex CELLAR/SPARQL and OJ feeds, Commission DG TAXUD, KSeF/ANAF/Agenzia technical pages, Peppol/CEN artefacts), stores content hashes and version identifiers, emits a **change item** when a hash or version changes, and links the affected rule packs. The **News** page lists these items with three states (verified change / detected change / unverified). Automatic *legal interpretation* is never generated; a human classifies. Source list and reuse terms are being researched; **[UNVERIFIED]** until each source is checked for machine-readable access and licence.
- **Aliveness**: activation metric = tenant has run ≥1 check on non-demo data within 14 days; weekly digest of new findings; "changes since your last visit" on the dashboard. Selling: design partners first, then self-serve with a 14-day trial, accountant channel second.

## 3. Money and time — honest ranges

Assumptions (all falsifiable): one technical founder plus part-time help; RO cost base; 10–15 interviews in 8 weeks; one country (RO) first; design partners pay from month 4.

| Milestone | Realistic window | Evidence needed to claim it |
|---|---|---|
| 15 structured interviews done | 6–10 weeks | notes, segment mix, price reactions |
| 3 design partners signed (paid pilot €500–2,000/mo) | months 3–6 | signed pilot terms, first invoice paid |
| First self-serve subscription | months 8–14 | checkout live, entitlement enforced, VAT invoicing correct |
| MRR €5k | months 12–18 | 30–60 customers or 5–10 pilots |
| MRR €30k / seed-ready | months 20–30 | retention, CAC, gross margin >75% |
| Break-even (one founder + infra) | months 18–30 at €8–15k MRR | measured costs |

Cost base per tenant is small: two Postgres clusters, object storage, one API service — infrastructure at €150–400/month for the first tens of tenants, dominated by fixed database and observability cost. Gross margin above 80% is plausible; **do not quote it as measured**.

## 4. Fundraising

- **EIC Accelerator** is the only EU instrument with a published, large ticket (grant < €2.5M, equity €1–10M — V). It targets TRL 6–8 and "game-changing" innovation; a compliance SaaS without a validated market is a weak fit on the innovation criterion and needs traction to survive the jury.
- **Bootstrapping + paid pilots** is the credible path: the product's cost base is low, and the first revenue can be design-partner fees.
- Romanian national programmes and CEE pre-seed funds: **[UNVERIFIED]** in this pass (no first-party pages fetched). Seed benchmarks and SaaS metrics expectations: **[UNVERIFIED]**.
- What due diligence will demand: customer references, security attestations (SOC 2 / ISO 27001 readiness), a DPA, a sub-processor list, and a counsel opinion on the tax-advice boundary. None exists today.

## 5. What would make this fail (watch these)

1. Authority-side access turns out to require an accreditation the company cannot obtain (Italy: intermediario status; RO: certificate per customer).
2. ERP vendors ship the same check natively (SAP eDocument cockpit already has KSeF status queries — S).
3. Accountants treat the check as a 15-minute manual task and will not pay.
4. The tax-advice boundary forces wording so hedged that the product reads as useless.
5. Regulatory dates move and the mandate-driven urgency evaporates (Spain already slipped).

## 6. The immediate plan (phases, with gates)

| Phase | Work | Gate to pass |
|---|---|---|
| P0 (done) | security plane, billing core, ambient design, pricing evidence, dashboard verified | builds + tests green; dashboard loads on synthetic data |
| P1 (2–3 weeks) | identity (OIDC users/membership/RBAC), onboarding wizard, superadmin read-only console with audit events, legal pages as drafts, pricing page (checkout disabled) | a real user can register, onboard, see a finding; superadmin view is masked and audited |
| P2 (4–6 weeks) | KSeF adapter against the official test environment; RO e-Factura adapter against ANAF test; ingestion of real ledger exports; C2/C3 checks | a design partner runs a real period end to end |
| P3 | News/watch pipeline, cited retrieval, evidence packs, TSA anchoring | every published statement carries a V citation |
| P4 | load test, failover drill, pen test, SOC 2 readiness | measured numbers replace design targets |

## 7. Decisions still needed from the owner

| # | Decision | Why it blocks |
|---|---|---|
| S-1 | Interview 15 finance/accounting people before more features | the only way to kill or confirm the demand hypothesis |
| S-2 | First country: RO, PL or IT | determines the first adapter and the pilot set |
| S-3 | Identity provider (EU-hosted managed vs self-hosted) | login/register cannot be finished without it |
| S-4 | Payment provider: Stripe (EU entity) vs merchant of record | VAT liability and invoicing differ |
| S-5 | Compliance owner name and counsel | rule packs cannot be approved, L11 cannot pass |
| S-6 | Hosting provider in the EU (D-2) | production deployment and DPIA |
