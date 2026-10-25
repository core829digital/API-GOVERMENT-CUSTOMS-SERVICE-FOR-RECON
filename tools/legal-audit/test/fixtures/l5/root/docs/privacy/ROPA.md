---
doc: ROPA
status: reviewed
reviewed_at: 2026-10-01
reviewer: "Example DPO (fixture)"
next_review: 2027-04-01
---

# ROPA (fixture)

Text above the machine-managed block is preserved.

<!-- ropa:begin -->
| column | class | basis | retention | encrypted |
|---|---|---|---|---|
| core.legal_entity.vat_id_ct | pii_id | gdpr_6_1_c | tax_record | true |
| core.tenant.id | internal | gdpr_6_1_c | tax_record | none |
| core.tenant.name | internal | contract_6_1_b | operational | none |
<!-- ropa:end -->

Text below the block is preserved too.
