//! Tamper-evident ledger primitives shared by the service and the offline verifier.
//!
//! The hash layout is **frozen** per `CHAIN_VERSION` and is implemented independently in
//! SQL (`ledger.append_event()`, see DatabaseInfo.md §4.1). Any change to the layout requires a
//! new `CHAIN_VERSION`, a new SQL function, and new test vectors.
//!
//! `hash = SHA-256( prev_hash[32] ‖ tenant_id[16] ‖ seq[8, BE] ‖ id[16]
//!                  ‖ (u32 BE len ‖ UTF-8) for event_type, actor_type, actor_ref
//!                  ‖ occurred_at_unix_micros[8, BE] ‖ payload_sha256[32] )`

pub mod anchor;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Version of the frozen hash layout implemented here.
pub const CHAIN_VERSION: u32 = 1;

/// A SHA-256 digest.
pub type Hash = [u8; 32];

/// `prev_hash` of the first event of every tenant chain.
pub const GENESIS: Hash = [0u8; 32];

/// Errors from hashing or verifying evidence.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EvidenceError {
    /// A variable-length field does not fit the u32 length prefix.
    #[error("field too long for chain encoding")]
    FieldTooLong,
    /// Payload could not be canonicalised (RFC 8785).
    #[error("payload canonicalisation failed: {0}")]
    Canonicalisation(String),
    /// A hex field in an exported event is malformed.
    #[error("invalid hex in field `{0}`")]
    BadHex(&'static str),
}

/// Why a chain failed verification.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ChainError {
    /// Event belongs to a different tenant than the first event.
    #[error("tenant mismatch at seq {seq}")]
    TenantMismatch { seq: i64 },
    /// `seq` is not exactly previous + 1 (first must be 1).
    #[error("sequence gap: expected {expected}, found {found}")]
    SeqGap { expected: i64, found: i64 },
    /// `prev_hash` does not equal the previous event's `hash` (or genesis).
    #[error("prev_hash break at seq {seq}")]
    PrevHashBreak { seq: i64 },
    /// Recomputed hash differs from the stored `hash`.
    #[error("hash mismatch at seq {seq}")]
    HashMismatch { seq: i64 },
    /// Event could not be hashed (e.g. over-long field).
    #[error("event at seq {seq} not hashable: {source}")]
    Unhashable { seq: i64, source: EvidenceError },
}

/// Inputs to the event hash, borrowed.
#[derive(Debug, Clone, Copy)]
pub struct EventFields<'a> {
    pub prev_hash: Hash,
    pub tenant_id: Uuid,
    pub seq: i64,
    pub id: Uuid,
    pub event_type: &'a str,
    pub actor_type: &'a str,
    pub actor_ref: &'a str,
    /// Microseconds since the Unix epoch (UTC).
    pub occurred_at_micros: i64,
    pub payload_sha256: Hash,
}

fn put_str(h: &mut Sha256, s: &str) -> Result<(), EvidenceError> {
    let len = u32::try_from(s.len()).map_err(|_| EvidenceError::FieldTooLong)?;
    h.update(len.to_be_bytes());
    h.update(s.as_bytes());
    Ok(())
}

/// Compute the chain hash of one event (layout frozen at [`CHAIN_VERSION`]).
pub fn event_hash(f: &EventFields<'_>) -> Result<Hash, EvidenceError> {
    let mut h = Sha256::new();
    h.update(f.prev_hash);
    h.update(f.tenant_id.as_bytes());
    h.update(f.seq.to_be_bytes());
    h.update(f.id.as_bytes());
    put_str(&mut h, f.event_type)?;
    put_str(&mut h, f.actor_type)?;
    put_str(&mut h, f.actor_ref)?;
    h.update(f.occurred_at_micros.to_be_bytes());
    h.update(f.payload_sha256);
    Ok(h.finalize().into())
}

/// SHA-256 of the RFC 8785 (JCS) canonical form of `payload`.
///
/// Payload numbers must be exactly representable as IEEE-754 doubles (JCS rule); encode larger
/// integers as strings.
pub fn payload_sha256(payload: &serde_json::Value) -> Result<Hash, EvidenceError> {
    let bytes = serde_json_canonicalizer::to_vec(payload)
        .map_err(|e| EvidenceError::Canonicalisation(e.to_string()))?;
    Ok(Sha256::digest(bytes).into())
}

/// One event as exported for offline verification (NDJSON line). Hashes are lowercase hex.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChainEvent {
    pub tenant_id: Uuid,
    pub seq: i64,
    pub id: Uuid,
    pub event_type: String,
    pub actor_type: String,
    pub actor_ref: String,
    pub occurred_at_micros: i64,
    pub payload_sha256: String,
    pub prev_hash: String,
    pub hash: String,
}

fn decode32(s: &str, field: &'static str) -> Result<Hash, EvidenceError> {
    let v = hex::decode(s).map_err(|_| EvidenceError::BadHex(field))?;
    v.try_into().map_err(|_| EvidenceError::BadHex(field))
}

/// Verify a contiguous chain starting at seq 1 (`GENESIS` prev). Returns the final head hash.
pub fn verify_chain(events: &[ChainEvent]) -> Result<Hash, ChainError> {
    verify_segment(events, 1, GENESIS)
}

/// Verify a contiguous segment given the expected first `seq` and the `prev_hash` it must carry.
/// Returns the hash of the last event (or `prev` for an empty segment).
pub fn verify_segment(
    events: &[ChainEvent],
    first_seq: i64,
    prev: Hash,
) -> Result<Hash, ChainError> {
    let mut prev_hash = prev;
    let tenant = events.first().map(|e| e.tenant_id);
    for (expected_seq, e) in (first_seq..).zip(events) {
        let unhash = |source| ChainError::Unhashable { seq: e.seq, source };
        if Some(e.tenant_id) != tenant {
            return Err(ChainError::TenantMismatch { seq: e.seq });
        }
        if e.seq != expected_seq {
            return Err(ChainError::SeqGap {
                expected: expected_seq,
                found: e.seq,
            });
        }
        let stored_prev = decode32(&e.prev_hash, "prev_hash").map_err(unhash)?;
        if stored_prev != prev_hash {
            return Err(ChainError::PrevHashBreak { seq: e.seq });
        }
        let computed = event_hash(&EventFields {
            prev_hash: stored_prev,
            tenant_id: e.tenant_id,
            seq: e.seq,
            id: e.id,
            event_type: &e.event_type,
            actor_type: &e.actor_type,
            actor_ref: &e.actor_ref,
            occurred_at_micros: e.occurred_at_micros,
            payload_sha256: decode32(&e.payload_sha256, "payload_sha256").map_err(unhash)?,
        })
        .map_err(unhash)?;
        let stored = decode32(&e.hash, "hash").map_err(unhash)?;
        if computed != stored {
            return Err(ChainError::HashMismatch { seq: e.seq });
        }
        prev_hash = stored;
    }
    Ok(prev_hash)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    // Vectors computed independently with Node's crypto from the documented layout
    // (not from this implementation).
    const TENANT: &str = "11111111-1111-7111-8111-111111111111";
    const P1: &str = "2bfd14f43d17fc7cea24e0917a8879b4b2f880b8baeec1b9d90fbaad655e71bd";
    const E1: &str = "aece54ccea84a7ac7f088676bfe9c9449859f1a5c1b3e5d033d77f0df5fae035";
    const P2: &str = "363379742f80b51bdb9206579af7754911543079b9399cb3fc315fb199f476e8";
    const E2: &str = "9a1a243d505eac68887d2970cccf8633804132de904acd18d98851131deb68db";

    fn chain() -> Vec<ChainEvent> {
        vec![
            ChainEvent {
                tenant_id: TENANT.parse().unwrap(),
                seq: 1,
                id: "0198a000-0000-7000-8000-000000000001".parse().unwrap(),
                event_type: "test.event".into(),
                actor_type: "system".into(),
                actor_ref: "sys".into(),
                occurred_at_micros: 1_790_000_000_123_456,
                payload_sha256: P1.into(),
                prev_hash: hex::encode(GENESIS),
                hash: E1.into(),
            },
            ChainEvent {
                tenant_id: TENANT.parse().unwrap(),
                seq: 2,
                id: "0198a000-0000-7000-8000-000000000002".parse().unwrap(),
                event_type: "ünïcode.event".into(),
                actor_type: "user".into(),
                actor_ref: "u-é".into(),
                occurred_at_micros: 1_790_000_001_000_000,
                payload_sha256: P2.into(),
                prev_hash: E1.into(),
                hash: E2.into(),
            },
        ]
    }

    #[test]
    fn verifies_independent_vector_including_non_ascii_lengths() {
        let head = verify_chain(&chain()).unwrap();
        assert_eq!(hex::encode(head), E2);
    }

    #[test]
    fn detects_field_tamper_prev_break_gap_and_cross_tenant() {
        let mut c = chain();
        c[1].actor_ref = "evil".into();
        assert_eq!(verify_chain(&c), Err(ChainError::HashMismatch { seq: 2 }));

        let mut c = chain();
        c[1].prev_hash = hex::encode([7u8; 32]);
        assert_eq!(verify_chain(&c), Err(ChainError::PrevHashBreak { seq: 2 }));

        let mut c = chain();
        c.remove(0);
        assert_eq!(
            verify_chain(&c),
            Err(ChainError::SeqGap {
                expected: 1,
                found: 2
            })
        );

        let mut c = chain();
        c[1].tenant_id = Uuid::nil();
        assert_eq!(verify_chain(&c), Err(ChainError::TenantMismatch { seq: 2 }));
    }

    #[test]
    fn rejects_malformed_hex() {
        let mut c = chain();
        c[0].hash = "zz".into();
        assert!(matches!(
            verify_chain(&c),
            Err(ChainError::Unhashable { seq: 1, .. })
        ));
    }

    #[test]
    fn segment_verification_starts_mid_chain() {
        let c = chain();
        let prev: Hash = hex::decode(E1).unwrap().try_into().unwrap();
        let head = verify_segment(&c[1..], 2, prev).unwrap();
        assert_eq!(hex::encode(head), E2);
    }

    #[test]
    fn jcs_hash_is_key_order_independent_and_matches_rfc8785_example_form() {
        let a: serde_json::Value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
        let b: serde_json::Value = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();
        assert_eq!(payload_sha256(&a).unwrap(), payload_sha256(&b).unwrap());
        // canonical form of {"a":1,"b":2} is the compact, key-sorted text
        let expected: Hash = Sha256::digest(br#"{"a":1,"b":2}"#).into();
        assert_eq!(payload_sha256(&a).unwrap(), expected);
    }
}
