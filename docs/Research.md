# Research.md — Market, Pain Point, Regulatory Register

Research date: 2026-10-23. Method: one scout sweep (agent `MarketResearch`), then a second pass that re-checked every load-bearing claim against primary or near-primary sources. Claims carry a status tag:

- **[V]** verified this session (source linked)
- **[S]** scout-reported, plausible, not re-verified — do not use externally without re-checking
- **[K]** engineer's prior knowledge, not re-verified this session — verify before relying
- **[X]** scout claim found wrong; corrected below

Rule R-DOC-1 (Rules.md): no regulatory statement enters code, rule packs, or customer-facing text without a citation (ELI/CELEX + article) and an access date.

---

## 1. Corrections to the first scout report

The first report contained errors that would have propagated into the product. Logged so they are never reintroduced.

| # | Scout claim | Finding | Tag |
|---|---|---|---|
| 1 | ViDA platform rules and Single VAT Registration in 2027 | Platform deemed-supplier rules and SVR start **1 Jul 2028**. DRR for intra-EU B2B starts **1 Jul 2030**. [EC ViDA page](https://taxation-customs.ec.europa.eu/taxation/vat/vat-digital-age-vida_en) | X→V |
| 2 | Poland KSeF mandatory 2027 | Already live: **1 Feb 2026** (large taxpayers), **1 Apr 2026** (all others). [EDICOM](https://edicomgroup.com/blog/poland-will-make-b2b-electronic-invoicing-mandatory), [Dudkowiak & Putyra](https://www.dudkowiak.com/tax-law-in-poland/e-invoicing-in-poland-ksef) | X→V |
| 3 | Spain VeriFactu 2025/2026 | Legal dates after RDL 15/2025: **1 Jan 2027** (corporate-tax payers), **1 Jul 2027** (others). A further delay to **Oct 2028** was announced in Oct 2026 but, per [Lookuptax](https://lookuptax.com/tax-changes/spain/verifactu-october-2028-announced), was **not yet in the BOE**. Treat as unsettled; model as data with `valid_from`. VeriFactu is tamper-evident billing-software rules (SIF), not a clearance e-invoicing mandate [K]. [AEAT note](https://sede.agenciatributaria.gob.es/Sede/en_gb/iva/sistemas-informaticos-facturacion-verifactu/nota-informativa-ampliacion-plazo-adaptacion-facturacion.html) | X→V |
| 3b | France: "PPF clearance, Y-model" | Since **1 Sep 2026** every VAT-registered business must be able to **receive** e-invoices; large/mid-size must issue via a certified private platform (**PA**, ~150 certified as of Aug 2026). PPF is the directory/concentrator, not the issuing route. SME issuing obligation: 1 Sep 2027 [K]. [impots.gouv.fr FAQ](https://www.impots.gouv.fr/sites/default/files/media/1_metier/2_professionnel/EV/2_gestion/290_facturation_electronique/faq_tout_savoir_facturation-electronique.pdf) | X→V |
| 4 | DAC7 "effective 1 Jan 2024"; listed as VAT Directive amendment; "Arts. 369f–j"; submit via Peppol/AS4 | DAC7 (Directive (EU) 2021/514) amends **Directive 2011/16/EU** (administrative cooperation), not the VAT Directive. It applies from **1 Jan 2023**; first reports were due 31 Jan 2024 [K]. Reports go to the national tax authority; exchange between Member States is via CCN. Penalties are national. Arts. 369f–j of the VAT Directive are OSS provisions. | X |
| 5 | "Czech EET" as e-invoicing | EET was a cash-register reporting scheme. Not an e-invoicing system. | X |
| 6 | "10-year retention, Art. 6 VAT Directive" | Retention periods are set **by Member States** (VAT Directive Arts. 244–248 require storage; the period is national) [K]. Periods differ per country and change (e.g. Germany shortened some periods). Must be per-jurisdiction data, never a constant. | X |
| 7 | Taxdoo exit (Apr 2026) as an open go-to-market wedge | Taxdoo ended VAT services **30 Apr 2026** — already past; sellers have migrated. [VATAi](https://www.vatai.com/blog/taxdoo-to-end-vat-services-in-2026). Not a wedge. | X→V |
| 8 | "Zero vendors do CESOP" while its own matrix credits Sovos | Self-contradictory. CESOP is a PSP obligation; not our v1 scope. | X |
| 9 | "No SaaS for DAC6 / transfer pricing / A1" | Overclaim — unsourced absolute. Do not repeat. | X |
| 10 | Competitor tech stacks (e.g. "Fonoa uses pgvector", "Taxually .NET") and headcounts | No sources given. Discarded. | X |
| 11 | DAC8 not mentioned | **DAC8** (Directive (EU) 2023/2226) applies from **1 Jan 2026**. [EC](https://taxation-customs.ec.europa.eu/taxation/tax-transparency-cooperation/administrative-co-operation-and-mutual-assistance/directive-administrative-cooperation-dac/dac8_en), [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023L2226). Out of v1 scope, tracked. | V |

---

## 2. Market landscape

Tiers (scout-reported **[S]**; structure consistent with 2026 comparisons such as [hellotax](https://hellotax.com/blog/eu-vat-compliance-providers/) and [AVASK](https://avask.com/blog/best-vat-compliance-software)):

| Tier | Vendors | Model | Notes |
|---|---|---|---|
| Enterprise suites | Avalara, Sovos, Vertex | Per-module + volume; sales-led | Broad e-invoicing/SAF-T/returns. Sovos and Avalara both rated Leaders in IDC MarketScape for compliant e-invoicing (Sep 2026) [V via [Sovos](https://sovos.com/taxapedia/vs/sovos-vs-avalara/) — vendor-authored] |
| API-first / mid-market | Fonoa, Quaderno, Taxually | Usage/plan based | Strong calculation and invoicing APIs |
| SME / managed filing | hellotax, Lovat, SimplyVAT | Per country / per filing | Service-heavy; only hellotax and Lovat publish full prices [V via AVASK] |
| Merchant of Record | Paddle, Lemon Squeezy | % of revenue | Different liability model; not a direct substitute |

Common structure across all tiers: they sell **determination → return → filing** per obligation. Reconciliation across obligations is a feature inside a module, not the product.

## 3. Pain point selected (hypothesis)

### 3.1 Statement

> Authorities now hold the *other side* of your numbers — e-invoice clearance data, SAF-T, pre-filled returns, customs import data, VIES — and mismatch against what the business booked or filed is what triggers audits. Businesses have no single system that continuously reconciles **their books vs. each authority's copy** and produces **evidence an auditor or court will accept**.

### 3.2 Evidence

| Evidence | Source | Tag |
|---|---|---|
| IT: SdI data feeds periodic VAT communications (LIPE) and the pre-filled VAT return. RO: ANAF-signed XML gates VAT deduction; parallel SAF-T (D406) mismatches trigger audit. | [VATupdate, July 2026 deck](https://www.vatupdate.com/wp-content/uploads/2026/07/2026-07-02-E-Invoice_Correction_ERreporting_8Countries_July2026.pdf) | V (secondary) |
| "Errors that once surfaced at a year-end review are now flagged within days." | [VATupdate, 24 Jul 2026](https://www.vatupdate.com/2026/07/24/vat-concepts-explained-digital-reporting-saf-t-vat-audits-in-the-data-era) | V (secondary) |
| Reconciling VAT returns, SAF-T and e-invoicing reports "is now non-negotiable". | [Global Indirect Tax Mgmt](https://globalindirecttaxmanagement.com/best-practices/vat-gst-risk-management-key-trends/why-reconciling-vat-returns-saf-t-and-e-invoicing-reports-is-now-non-negotiable) | V (secondary) |
| A PDF that materially deviates from its XML can be treated as a separate invoice (Art. 203 VAT Directive). | [VATupdate, 17 Aug 2026](https://www.vatupdate.com/2026/08/17/vat-headaches-e-invoicing-mismatches-when-the-legal-invoice-and-the-erp-output-differ) | V (secondary) |
| "Reported does not mean correct — the legal VAT position remains the taxpayer's responsibility" (pre-filled returns). | [VATupdate, 28 Jul 2026](https://www.vatupdate.com/wp-content/uploads/2026/07/2026-07-28-VAT_PreFilled_Returns.pdf) | V (secondary) |
| Real-time reporting expands: ViDA DRR 2030, KSeF 2026, France 2026, Belgium 2026. | §5 | V |

### 3.3 What is NOT established — must be validated before building beyond Phase 2

1. **No-competitor claim is unproven.** Sovos (Advanced Periodic Reporting) and Vertex (VAT Compliance "improves data quality") have reconciliation-adjacent features. Search did not surface their depth. The differentiation we are betting on is *cross-source + authority-side + evidence*, not "reconciliation exists". Action: request demos/read docs for Sovos APR, Avalara Returns, Vertex VAT Compliance, Fonoa; record exact capability per check in §3.4.
2. **Willingness to pay** — zero customer interviews so far. Action: ≥10 interviews (tax managers at multi-country e-commerce / SaaS companies; accounting firms) before Phase 3.
3. **Authority-side data availability** is uneven. Clearance statuses are API-accessible in some countries (PL KSeF, RO e-Factura, IT SdI via intermediaries) [K]; customs import data usually arrives via broker/forwarder files, not an API. Action: per-country data-availability matrix (Phase 2).
4. **Regulatory positioning** — reconciliation findings with rule citations may approach tax advice, which is a regulated activity in some Member States. Counsel review required (Progress.md open decision D-5).

### 3.4 Check catalogue (v1 candidates)

| ID | Check | Sources compared | Authority-side? | Phase |
|---|---|---|---|---|
| C1 | Invoice issued vs. clearance status/content | ERP ledger ↔ KSeF / e-Factura / SdI status | yes | 2 |
| C2 | PDF vs. structured XML payload | invoice PDF ↔ XML | no | 2 |
| C3 | VAT return boxes vs. ledger by period | ledger ↔ filed return | partial | 2 |
| C4 | OSS/IOSS return vs. B2C sales by consumption state and rate | ledger/marketplace ↔ OSS return | partial | 3 |
| C5 | B2B intra-EU supplies vs. VAT-ID validity at time of supply | ledger ↔ VIES result history | yes | 3 |
| C6 | Import VAT claimed vs. customs/import statement | ledger ↔ customs file | yes | 3 |
| C7 | Marketplace report vs. ledger (Art. 14a facilitated supplies) | marketplace report ↔ ledger | no | 3 |
| C8 | Payments vs. invoices (CESOP exposure) | bank/PSP ↔ ledger | no | later |

Out of v1 (deliberately): filing, payroll/social security, transfer pricing/DAC6, PE risk, WHT reclaim, MAP. These are the user's other listed pain points; they are mapped as roadmap, not silently dropped (see Progress.md).

---

## 4. Customer persona (assumption)

The brief ended by asking whether the target is an e-commerce seller, a company with remote workers, or a freelancer. That question was part of pasted source material, not addressed to this project. **Working assumption:** B2B API consumed by (a) multi-country e-commerce / SaaS companies' finance and tax teams, (b) accounting/tax firms, (c) ERP/marketplace integrators. Freelancers and payroll/remote-worker scenarios are out of v1. Confirm via Progress.md decision D-1.

---

## 5. Regulatory register

| Instrument | Relevance to v1 | Key dates | Tag |
|---|---|---|---|
| VAT Directive 2006/112/EC (CELEX 32006L0112) | Core: place of supply, invoicing (Arts. 217–240), returns, recapitulative statements, record storage (Arts. 244–248) | — | K |
| ViDA — Council Directive (EU) 2025/516 (CELEX 32025L0516) | DRR + e-invoicing intra-EU B2B 1 Jul 2030; platform rules + SVR 1 Jul 2028; Member States may mandate domestic e-invoicing since 14 Apr 2025; domestic national systems must align by 2035 [K] | see left | V (dates), K (2035) |
| EN 16931 + national CIUS | Canonical invoice semantics; per-country profile | — | K |
| Poland KSeF | Mandatory clearance model | 1 Feb 2026 / 1 Apr 2026 | V |
| France e-invoicing (PA model) | Receive: all, 1 Sep 2026; issue: large/mid 1 Sep 2026; SMEs 1 Sep 2027 [K] | | V/K |
| Spain Veri*Factu (RDL 15/2025) | SIF billing-software rules | 1 Jan / 1 Jul 2027 legal; Oct 2028 announced | V (unsettled) |
| Italy SdI | Clearance; feeds pre-filled returns | since 2019 B2B [K] | K |
| Romania e-Factura / SAF-T D406 | Clearance; SAF-T mismatch audit trigger | B2B 1 Jan 2024; B2C 1 Jan 2025 [K] | K — verify |
| Belgium Peppol B2B | 4-corner | 1 Jan 2026 [S] | S |
| Germany | Receive since 1 Jan 2025; issue phased 2027/2028 [K] | | K |
| DAC7 — Directive (EU) 2021/514 (amends 2011/16/EU) | Platform-operator reporting; not v1 | applies 1 Jan 2023 | K |
| DAC8 — Directive (EU) 2023/2226 | Crypto-asset reporting; not v1 | 1 Jan 2026 | V |
| CESOP — Directive (EU) 2020/284 | PSP payment reporting; check C8 later | applies 1 Jan 2024 [K] | K |
| EU Customs Reform; Regulation (EU) 2026/2108 | Customs data hub; check C6 data source; €3 duty on low-value parcels (Jul 2026) and €2 Union handling fee (from 1 Nov 2026) per EC page | Data hub from 2028 [UNVERIFIED] | V (fee), verify rest — [EC customs reform](https://taxation-customs.ec.europa.eu/customs/eu-customs-reform_en), [EUR-Lex 2026/2108](https://eur-lex.europa.eu/eli/reg/2026/2108/oj/eng) |
| GDPR — Regulation (EU) 2016/679 | Arts. 5, 6(1)(c), 17(3)(b), 20, 25, 28, 30, 32, 33, 35, 44–49 | in force | K |
| eIDAS — Regulation (EU) 910/2014 as amended by (EU) 2024/1183 | Qualified electronic time stamps carry a presumption of date/time accuracy (Arts. 41–42); electronic ledgers have legal effect (Art. 45k) | in force | V — [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/1183/oj/eng) |
| AI Act — Regulation (EU) 2024/1689, amended by Digital Omnibus Regulation (EU) 2026/1744 | AI used for advisory retrieval/classification only; high-risk obligations deferred by the Omnibus (in force 27 Jul 2026); transparency duties not deferred | see left | V — [White & Case](https://www.whitecase.com/insight-alert/eu-ai-omnibus-enters-force-amending-ai-act) |
| NIS2 — Directive (EU) 2022/2555 | Scope assessment needed (cloud/digital provider status) | transposition national | K — assess |
| DORA — Regulation (EU) 2022/2554 | Applies to us contractually if customers are financial entities | in force | K — assess |
| AMLD6 (EU) 2024/1640 / AMLR (EU) 2024/1624 | **Not applicable** while we do no KYC/seller onboarding; becomes relevant if scope widens. Counsel to confirm. | | S/K |

### Register maintenance
Country calendars (go-live dates, schema versions, retention periods) live in **rule packs as dated data** (DatabaseInfo.md §rules), not in code. Each entry: `source_celex_or_url`, `article`, `valid_from`, `valid_to`, `last_reviewed`, `reviewer`. CI gate L8 fails on missing citations and warns on `last_reviewed` older than 90 days.

---

## 6. Technical findings feeding the architecture

| Finding | Source | Consequence |
|---|---|---|
| PostgreSQL 18 is current (18.6, 13 Aug 2026); 19 is beta. | [postgresql.org](https://www.postgresql.org/docs/18/release-18.html) | Target **PG 18**. |
| pgvector 0.8.6 (29 Jul 2026) is current; HNSW iterative scans, halfvec available in 0.8.x. | [pgvector changelog](https://github.com/pgvector/pgvector/blob/v0.8.6/CHANGELOG.md), [tutorial](https://nerdleveltech.com/pgvector-hnsw-postgres-18-production-tuning-tutorial) | Target **pgvector 0.8.x**; re-pin at scaffold. |
| Logical replication does **not** replicate DDL or sequence data; TRUNCATE needs care. | [PG18 docs §29.8](https://www.postgresql.org/docs/current/logical-replication-restrictions.html) | Migrations applied to both DBs by one tool (expand/contract); UUIDv7 keys, no sequences cross the bridge. |
| After publisher failover, logical subscribers break unless replication slots are synchronized. | [pgEdge/CNPG docs](https://docs.pgedge.com/cloudnativepg/development/logical_replication) | `failover = true` subscription + `sync_replication_slots` on standbys; tested in CI/game-day. |
| Lenis honors `prefers-reduced-motion` by default (smoothing disabled); 1.3.x current. | [lenis README](https://github.com/darkroomengineering/lenis) | Accessible by default; still scope it (see Architecture §Frontend). |
