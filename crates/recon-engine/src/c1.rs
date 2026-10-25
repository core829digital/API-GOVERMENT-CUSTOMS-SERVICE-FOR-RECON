//! Check **C1**: invoices in the ERP ledger vs. the clearance status the authority side reports for them
//! (Research.md §3.4).
//!
//! [`evaluate`] is a pure function of the input records (R-ENG-1): no clock, randomness, network or model call,
//! and the output does not depend on the order in which records are passed in.
//!
//! ## Canonical inputs (jsonb in `ingest.source_record.canonical`)
//!
//! | `record_kind` | required fields |
//! |---|---|
//! | `invoice` | `invoice_ref` (opaque ERP reference, non-empty string), `currency` (3 upper-case letters), `total_minor` (integer minor units) |
//! | `clearance_status` | `invoice_ref`, `status` (`accepted` \| `rejected` \| `pending`), `currency`, `total_minor` |
//!
//! Records of any other kind are ignored. Two `invoice` records, or two `clearance_status` records, with the
//! same `invoice_ref` make the input ambiguous: evaluation fails instead of guessing ([`EvalError`]).
//!
//! ## Outcomes
//!
//! Per `invoice_ref`, at most one outcome (first match wins): no clearance record; clearance status other than
//! `accepted`; currency or total differs; clearance record without an invoice. Findings state that two sources
//! disagree; they never state a legal conclusion (R-ENG-3). Severities are engineering triage defaults, not legal
//! ratings.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const KIND_INVOICE: &str = "invoice";
pub const KIND_CLEARANCE: &str = "clearance_status";
pub const CHECK_CODE: &str = "C1";

/// A normalised source record as stored in `ingest.source_record`.
#[derive(Debug, Clone)]
pub struct Record {
    pub id: Uuid,
    pub kind: String,
    pub canonical: Value,
    pub sha256: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Outcome {
    NoClearanceRecord,
    NotAccepted,
    AmountMismatch,
    OrphanClearance,
}

impl Outcome {
    /// Code of the rule (in the run's pinned rule pack) a finding with this outcome must cite. A pack that lacks
    /// the rule cannot back this check: the run fails instead of emitting an uncited finding (R-DOC-1).
    pub const fn rule_code(self) -> &'static str {
        match self {
            Self::NoClearanceRecord => "C1-NO-CLEARANCE-RECORD",
            Self::NotAccepted => "C1-NOT-ACCEPTED",
            Self::AmountMismatch => "C1-AMOUNT-MISMATCH",
            Self::OrphanClearance => "C1-ORPHAN-CLEARANCE",
        }
    }

    pub const fn severity(self) -> &'static str {
        match self {
            Self::AmountMismatch => "high",
            Self::NoClearanceRecord | Self::NotAccepted => "medium",
            Self::OrphanClearance => "low",
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::NoClearanceRecord => "no_clearance_record",
            Self::NotAccepted => "not_accepted",
            Self::AmountMismatch => "amount_mismatch",
            Self::OrphanClearance => "orphan_clearance",
        }
    }

    const fn statement(self) -> &'static str {
        match self {
            Self::NoClearanceRecord => {
                "The ERP ledger lists this invoice; the authority-side source has no clearance record for it."
            }
            Self::NotAccepted => {
                "The ERP ledger lists this invoice; the authority-side source reports a status other than accepted."
            }
            Self::AmountMismatch => {
                "The ERP ledger and the authority-side source report a different currency or total for this invoice."
            }
            Self::OrphanClearance => {
                "The authority-side source has a clearance record for this invoice reference; the ERP ledger has no such invoice."
            }
        }
    }
}

/// A finding before persistence. `input_record_ids` / `input_hashes` are index-aligned (ERP record first).
#[derive(Debug, Clone, PartialEq)]
pub struct FindingDraft {
    pub outcome: Outcome,
    pub input_record_ids: Vec<Uuid>,
    pub input_hashes: Vec<Vec<u8>>,
    pub detail: Value,
}

/// The input cannot be evaluated deterministically. Persisted only as a stable reason code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EvalError {
    #[error("record {record} of kind `{kind}` is malformed: {reason}")]
    Malformed {
        record: Uuid,
        kind: &'static str,
        reason: &'static str,
    },
    #[error("more than one invoice record for the same invoice_ref")]
    DuplicateInvoice,
    #[error("more than one clearance_status record for the same invoice_ref")]
    DuplicateClearance,
}

impl EvalError {
    pub const fn reason_code(&self) -> &'static str {
        match self {
            Self::Malformed { .. } => "malformed_record",
            Self::DuplicateInvoice => "duplicate_invoice_ref",
            Self::DuplicateClearance => "duplicate_clearance_ref",
        }
    }
}

struct Invoice<'a> {
    rec: &'a Record,
    currency: &'a str,
    total_minor: i64,
}

struct Clearance<'a> {
    rec: &'a Record,
    status: &'a str,
    currency: &'a str,
    total_minor: i64,
}

fn text<'a>(rec: &'a Record, kind: &'static str, key: &str) -> Result<&'a str, EvalError> {
    rec.canonical
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(EvalError::Malformed {
            record: rec.id,
            kind,
            reason: "missing or non-string field",
        })
}

fn money<'a>(rec: &'a Record, kind: &'static str) -> Result<(&'a str, i64), EvalError> {
    let currency = text(rec, kind, "currency")?;
    if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(EvalError::Malformed {
            record: rec.id,
            kind,
            reason: "currency must be three upper-case letters",
        });
    }
    let total = rec
        .canonical
        .get("total_minor")
        .and_then(Value::as_i64)
        .ok_or(EvalError::Malformed {
            record: rec.id,
            kind,
            reason: "total_minor must be an integer",
        })?;
    Ok((currency, total))
}

/// Evaluate C1 over `records`. Findings are ordered by `(invoice_ref)`; the result is identical for any
/// permutation of `records`.
pub fn evaluate(records: &[Record]) -> Result<Vec<FindingDraft>, EvalError> {
    let mut sorted: Vec<&Record> = records.iter().collect();
    sorted.sort_by_key(|r| r.id);

    let mut invoices: BTreeMap<&str, Invoice> = BTreeMap::new();
    let mut clearances: BTreeMap<&str, Clearance> = BTreeMap::new();
    for rec in sorted {
        match rec.kind.as_str() {
            KIND_INVOICE => {
                let r = text(rec, KIND_INVOICE, "invoice_ref")?;
                let (currency, total_minor) = money(rec, KIND_INVOICE)?;
                if invoices
                    .insert(
                        r,
                        Invoice {
                            rec,
                            currency,
                            total_minor,
                        },
                    )
                    .is_some()
                {
                    return Err(EvalError::DuplicateInvoice);
                }
            }
            KIND_CLEARANCE => {
                let r = text(rec, KIND_CLEARANCE, "invoice_ref")?;
                let status = text(rec, KIND_CLEARANCE, "status")?;
                if !matches!(status, "accepted" | "rejected" | "pending") {
                    return Err(EvalError::Malformed {
                        record: rec.id,
                        kind: KIND_CLEARANCE,
                        reason: "status must be accepted, rejected or pending",
                    });
                }
                let (currency, total_minor) = money(rec, KIND_CLEARANCE)?;
                if clearances
                    .insert(
                        r,
                        Clearance {
                            rec,
                            status,
                            currency,
                            total_minor,
                        },
                    )
                    .is_some()
                {
                    return Err(EvalError::DuplicateClearance);
                }
            }
            _ => {}
        }
    }

    let refs: std::collections::BTreeSet<&str> = invoices
        .keys()
        .chain(clearances.keys())
        .copied()
        .collect();
    let mut out = Vec::new();
    for r in refs {
        let (outcome, ids, hashes, sources) = match (invoices.get(r), clearances.get(r)) {
            (Some(i), None) => (
                Outcome::NoClearanceRecord,
                vec![i.rec.id],
                vec![i.rec.sha256.clone()],
                json!({"erp": {"currency": i.currency, "total_minor": i.total_minor}}),
            ),
            (None, Some(c)) => (
                Outcome::OrphanClearance,
                vec![c.rec.id],
                vec![c.rec.sha256.clone()],
                json!({"authority": {"status": c.status, "currency": c.currency, "total_minor": c.total_minor}}),
            ),
            (Some(i), Some(c)) => {
                let outcome = if c.status != "accepted" {
                    Outcome::NotAccepted
                } else if c.currency != i.currency || c.total_minor != i.total_minor {
                    Outcome::AmountMismatch
                } else {
                    continue;
                };
                (
                    outcome,
                    vec![i.rec.id, c.rec.id],
                    vec![i.rec.sha256.clone(), c.rec.sha256.clone()],
                    json!({
                        "erp": {"currency": i.currency, "total_minor": i.total_minor},
                        "authority": {"status": c.status, "currency": c.currency, "total_minor": c.total_minor},
                    }),
                )
            }
            (None, None) => continue,
        };
        out.push(FindingDraft {
            outcome,
            input_record_ids: ids,
            input_hashes: hashes,
            detail: json!({
                "outcome": outcome.name(),
                "invoice_ref": r,
                "statement": outcome.statement(),
                "sources": sources,
            }),
        });
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn rec(n: u128, kind: &str, canonical: Value) -> Record {
        Record {
            id: Uuid::from_u128(n),
            kind: kind.into(),
            canonical,
            sha256: vec![u8::try_from(n % 256).unwrap(); 32],
        }
    }
    fn inv(n: u128, r: &str, total: i64) -> Record {
        rec(
            n,
            KIND_INVOICE,
            json!({"invoice_ref": r, "currency": "PLN", "total_minor": total}),
        )
    }
    fn clr(n: u128, r: &str, status: &str, total: i64) -> Record {
        rec(
            n,
            KIND_CLEARANCE,
            json!({"invoice_ref": r, "status": status, "currency": "PLN", "total_minor": total}),
        )
    }
    fn outcomes(d: &[FindingDraft]) -> Vec<(&str, Outcome)> {
        d.iter()
            .map(|f| (f.detail["invoice_ref"].as_str().unwrap(), f.outcome))
            .collect()
    }

    #[test]
    fn each_outcome_is_detected_and_agreement_is_silent() {
        let recs = [
            inv(1, "A", 100),
            clr(2, "A", "accepted", 100), // agrees: no finding
            inv(3, "B", 100),             // no clearance
            inv(4, "C", 100),
            clr(5, "C", "rejected", 100), // not accepted
            inv(6, "D", 100),
            clr(7, "D", "accepted", 101), // amount mismatch
            clr(8, "E", "accepted", 5),   // orphan
            inv(9, "F", 100),
            clr(10, "F", "pending", 999), // status wins over amount
        ];
        let got = evaluate(&recs).unwrap();
        assert_eq!(
            outcomes(&got),
            vec![
                ("B", Outcome::NoClearanceRecord),
                ("C", Outcome::NotAccepted),
                ("D", Outcome::AmountMismatch),
                ("E", Outcome::OrphanClearance),
                ("F", Outcome::NotAccepted),
            ]
        );
        let d = &got[2];
        assert_eq!(d.input_record_ids, vec![Uuid::from_u128(6), Uuid::from_u128(7)]);
        assert_eq!(d.input_hashes, vec![vec![6u8; 32], vec![7u8; 32]]);
    }

    #[test]
    fn currency_difference_alone_is_a_mismatch() {
        let mut c = clr(2, "A", "accepted", 100);
        c.canonical["currency"] = json!("EUR");
        let got = evaluate(&[inv(1, "A", 100), c]).unwrap();
        assert_eq!(outcomes(&got), vec![("A", Outcome::AmountMismatch)]);
    }

    #[test]
    fn output_is_identical_for_every_input_order() {
        let recs = vec![
            inv(1, "B", 1),
            clr(2, "B", "pending", 1),
            inv(3, "A", 1),
            clr(4, "Z", "accepted", 1),
            inv(5, "M", 2),
            clr(6, "M", "accepted", 3),
        ];
        let first = evaluate(&recs).unwrap();
        assert_eq!(first.len(), 4);
        let mut rev = recs.clone();
        rev.reverse();
        assert_eq!(evaluate(&rev).unwrap(), first);
        let mut rot = recs.clone();
        rot.rotate_left(3);
        assert_eq!(evaluate(&rot).unwrap(), first);
        assert_eq!(evaluate(&recs).unwrap(), first, "replay equality");
    }

    #[test]
    fn ambiguous_or_malformed_input_fails_with_stable_reason_codes() {
        let e = evaluate(&[inv(1, "A", 1), inv(2, "A", 1)]).unwrap_err();
        assert_eq!(e.reason_code(), "duplicate_invoice_ref");
        let e = evaluate(&[clr(1, "A", "accepted", 1), clr(2, "A", "accepted", 1)]).unwrap_err();
        assert_eq!(e.reason_code(), "duplicate_clearance_ref");
        let e = evaluate(&[clr(1, "A", "approved", 1)]).unwrap_err();
        assert_eq!(e.reason_code(), "malformed_record");
        let mut bad = inv(1, "A", 1);
        bad.canonical["total_minor"] = json!(1.5);
        assert_eq!(evaluate(&[bad]).unwrap_err().reason_code(), "malformed_record");
        let mut bad = inv(1, "A", 1);
        bad.canonical["currency"] = json!("pln");
        assert_eq!(evaluate(&[bad]).unwrap_err().reason_code(), "malformed_record");
    }

    #[test]
    fn other_record_kinds_are_ignored() {
        let got = evaluate(&[rec(1, "return_box", json!({"anything": true}))]).unwrap();
        assert!(got.is_empty());
    }
}
