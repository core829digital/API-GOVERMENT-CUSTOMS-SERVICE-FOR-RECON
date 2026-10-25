# rules/ — regulatory rule packs (data, not code)

Status: **drafts**. Every pack here is `enabled: false` and `reviewed_by: "UNREVIEWED agent draft (awaiting @compliance, Progress.md D-5)"`. Nothing in this directory is legal advice or an approved record of what the law requires.

Rules.md R-RULES-1: country dates, thresholds, rates, schema versions and retention periods are **data with a citation**, never constants in code. This directory is that data. Consumers: gate L8 (citations and freshness), gate L9 (conformance fixtures for packs with `enabled: true`), and later the engine (`rules.rule_pack` / `rules.rule`, DatabaseInfo.md §4).

## Layout

```
rules/<JURISDICTION>/<pack-name>.yaml     JURISDICTION = EU or an ISO 3166-1 alpha-2 country code (uppercase)
rules/README.md                           this file
rules/UNVERIFIED.md                       claims that were NOT verified and therefore are not in any pack
```

Only `rules/<JURISDICTION>/*.yaml` files are packs.

## Pack format

The format is a subset of YAML that `tools/legal-audit/lib/miniyaml.mjs` parses (no anchors, no multi-line scalars, no nested flow collections; dates stay strings). Quote any string containing `:` or `#`. Key order below is the order used in the existing packs.

```yaml
pack: vat-invoice-core            # must equal the file base name
jurisdiction: EU                  # must equal the directory name
version: 0.1.0                    # semver; a released version is immutable (R-RULES-4)
valid_from: 2007-01-01            # earliest date any rule in the pack applies
valid_to:                         # empty = open ended
last_reviewed: 2026-10-23         # >90 days: L8 warning, >180 days: L8 error (R-RULES-3)
reviewed_by: "UNREVIEWED agent draft (awaiting @compliance, Progress.md D-5)"   # human name/team once approved
enabled: false                    # L9 inspects only packs with enabled: true
rules:
  - code: INV-010                 # unique within the pack
    title: "Invoice detail listed in Art. 226(1): the date of issue"   # neutral description of the provision
    source_ref: "CELEX:32006L0112"          # CELEX:<id> | ELI:<uri> | https://<official authority URL>
    article: "Art. 226 point (1)"
    accessed_on: 2026-10-23       # date the source text was actually read
    valid_from: 2007-01-01        # date the wording read applies (see "valid_from" below)
    valid_to:
    pending_change:               # empty, or text: a published-but-not-yet-applicable or unsettled change
```

Packs that are switched on must additionally list `fixtures:` (paths relative to the repo root) and `schema_versions:` for L9 (`tools/legal-audit` contract §3.2). None of the drafts has them: none is enabled.

### Rules about the content

- **Titles describe the provision, never a conclusion.** "Invoice detail listed in Art. 226(1): the date of issue" is a description; "an invoice without a date is non-compliant" is a legal conclusion and is forbidden (R-ENG-3). Findings built on these rules state that two sources disagree under a cited rule; they never say what a person owes or whether something is lawful.
- **`valid_from` is the application date of the text that was read**, taken from the amending act (e.g. `Directive 2010/45/EU` applies from 2013-01-01), not the date of the consolidated version and not the date of this draft.
- **Retention periods are national.** Directive 2006/112/EC Art. 247(1) leaves the storage period of invoices to each Member State, so no EU-wide invoice retention value is encoded (rule `INV-042` records only that the period is national). A country period belongs in a country pack and in `privacy.retention_policy` with its own citation. The one EU-level period found is the 10-year record period of the OSS scheme (`OSS-012`).
- **Announced or published-but-not-yet-applicable changes go in `pending_change`** (R-RULES-5). The currently applicable published date stays authoritative; the pending note is visible, never silently adopted. A replaced provision keeps its old text in its pack until a human releases a new version; the replacement sits in its own pack (`vida`) with its own future `valid_from`.
- **Unverified claims never enter a pack** (R-DOC-1). Whatever could not be checked against a primary source is listed in `rules/UNVERIFIED.md` with the reason.
- A pack is data a human approves. The checker (L8) verifies the presence and syntax of citations, **not** that the cited article says what the rule claims (Workflow.md §4.4). That is the compliance approver's job.

## Lifecycle (Workflow.md §6)

1. **Monitor** EUR-Lex, authority portals, newsletters (weekly; owner assigned by D-5 — not yet named).
2. **Triage**: relevant to v1? Date? Scope?
3. **Verify against the primary source.** Read the authentic text (EUR-Lex / official gazette / the authority's own page), record the access date. Secondary sources (blogs, vendor pages) are leads, not evidence. The first research pass of this project contained 11 factual errors (docs/Research.md §1).
4. **Rule-pack PR** with citations. Bump `version`, set `last_reviewed`.
5. **Human compliance approval** (L11): the PR touches `/rules/`, a CODEOWNERS-gated path; an approving review by a human member of the compliance team, made after the last push, is required.
6. **Shadow run** on historical data.
7. **Release** the new pack version with its effective date; past findings keep their original pack reference and are never recomputed in place.

## Who may do what (R-RULES-2)

- **Agents may draft** packs. These files are such drafts.
- **A human compliance approver must approve.** An agent is never the only approver; L11 checks that the approval comes from a user of type `User` (not a bot) who belongs to the compliance team and approved after the last push.
- The compliance owner team is not yet named (D-5). Until it is, no pack can be approved and none may be switched on: `enabled: false` is the default and the only value used. Setting `enabled: true` is a deliberate, reviewed act by the approver, and also requires L9 fixtures.

## What `pending_change` means

`pending_change` is empty when the rule is settled as read. When it holds text, the rule is correct **as currently published and applicable**, and the text names a change that is already published (or only announced) and has not yet become applicable, with the date and the source. Examples in the drafts:

- `INV-001`, `INV-002`, `INV-006`, `INV-007`, `INV-023`: replaced from 2030-07-01 by Directive (EU) 2025/516 Art. 5 (replacement text in pack `vida`).
- `VIDA-003` (Art. 28a): the Member State application date lies between 2028-07-01 and 2030-01-01; the country date is not recorded.
- `VIDA-007`, `VIDA-008`, `VIDA-017`: Member States with a qualifying domestic real-time reporting obligation may apply by 2035-01-01.

The engine and the UI must surface `pending_change` next to any finding that cites the rule. Nobody may delete the text to "make the rule current"; when the change becomes applicable, a new pack version moves it into `valid_from`/`valid_to`.

## Verification log of the current drafts (access date 2026-10-23)

All texts below were fetched and read in full for the cited provisions on the access date. EUR-Lex pages were retrieved through a real browser session (the plain HTTP client is served an anti-bot challenge page); text was read from the `TXT/HTML` rendering.

| What was read | URL | What was checked |
|---|---|---|
| Consolidated VAT Directive (version dated 2025-04-14; the latest in the EUR-Lex version list on the access date) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02006L0112-20250414 | Wording of Arts. 138, 203, 217-226b, 229, 230, 232-233, 244-245, 247-249, 262-266, 369-369k; modification markers (M-numbers) to identify the amending act; Art. 413 (entry into force 2007-01-01); list of amending acts |
| Directive (EU) 2025/516 as published | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32025L0516 | Arts. 1-8: amendments and their application dates (Art. 6), 20-day entry into force, derogations (Art. 6(3), 6(5)), new Arts. 28a, 46a, 369xa-369xk, 217, 218, 222, 223, 226, 232, 262-264, 271a-271c |
| Directive 2010/45/EU | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32010L0045 | Art. 2(1): application from 2013-01-01; list of amended invoicing Articles |
| Directive (EU) 2018/1910 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32018L1910 | Art. 2(1): application from 2020-01-01; text of new Arts. 138(1a), 262 |
| Directives 2008/8/EC and 2008/117/EC | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32008L0008 and ...CELEX:32008L0117 | 2008/8 Art. 2 (applies from 2010-01-01: Arts. 262, 264), Art. 5 (2015-01-01: Arts. 369a-369k as introduced, incl. the 10-year record period in 369k(2)); 2008/117 Art. 3(1) (2010-01-01: Arts. 263, 264(2), 265(2)) |
| Directives (EU) 2017/2455 and (EU) 2019/1995; Council Decision (EU) 2020/1109 | ...CELEX:32017L2455, ...CELEX:32019L1995, ...CELEX:32020D1109 | Amended Arts. 369a-369k; the original 2021-01-01 application was moved to 2021-07-01 by the Decision (Arts. 1 and 2) |
| Directive (EU) 2020/1756, 2020/2020 (consolidation list) | ...CELEX:32020L1756, ...CELEX:32020L2020 | Fetched while identifying the date-moving instrument; neither is cited (one concerns the Northern Ireland prefix, the other COVID-19 vaccines) |
| KSeF portal, "Zakres obowiązkowego KSeF" | https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/zakres-obowiazkowego-ksef/ | Dates 2026-02-01 and 2026-04-01 and their conditions; receiving obligation from 2026-02-01; page metadata (published 2025-06-30, modified 2026-02-06) |
| MoF news item, 2024-06-11 | https://www.gov.pl/web/finanse/obowiazkowy-ksef-odroczony-do-1-lutego-2026-r | Historic (describes a plan); its "200 million PLN in 2025" disagrees with the portal and the statute ("2024"): not used |
| Dz.U. 2025 poz. 1203 (Act of 2025-08-05), as published | https://api.sejm.gov.pl/eli/acts/DU/2025/1203/text.pdf (metadata: https://api.sejm.gov.pl/eli/acts/DU/2025/1203) | Wording of Arts. 145l, 145m, 145n and 108g of the VAT Act, application date of Art. 108g (2027-01-01), act status "obowiązujący" in the Sejm API |

Limits of this verification:

- The EUR-Lex consolidated text carries a "no legal effect" notice; the Official Journal text of the amending acts was read to date the wording. A human must still confirm the wording against the authentic text.
- The Polish act was read **as published** in the Dziennik Ustaw, not as a consolidated text; later amendments to Arts. 145l-145n or 108g were not searched for.
- Pages were read as served on 2026-10-23. Any change after that time is not reflected.

## Open items for the compliance approver

See `rules/UNVERIFIED.md` for items that were deliberately left out. Corrections to `docs/Research.md` found while verifying (that file is not owned by this slice): see the report that accompanies this change.
