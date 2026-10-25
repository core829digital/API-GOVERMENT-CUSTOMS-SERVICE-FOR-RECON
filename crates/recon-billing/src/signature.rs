//! Stripe webhook signature verification (`Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…][,v0=…]`).
//!
//! Scheme, from https://docs.stripe.com/webhooks (section "Verify webhook signatures manually", accessed 2026-10-25):
//! the signed payload is `<t>` `.` `<raw request body>`; the signature is HMAC-SHA256 keyed with the endpoint signing
//! secret (the whole `whsec_…` string as bytes); only `v1` signatures count (other schemes, including the test-only `v0`,
//! are ignored to prevent downgrade); several `v1` values appear while an endpoint secret is being rolled; comparison
//! MUST be constant-time; the timestamp is checked against a tolerance (5 minutes in Stripe's libraries, never 0).
//!
//! This function takes the RAW body bytes. Anything that parses or re-serialises the JSON before verification breaks the
//! signature, so the HTTP handler verifies before it parses.

use crate::config::Secret;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Accepted distance between the signed timestamp and the local clock, in seconds (5 minutes).
pub const TOLERANCE_SECS: i64 = 300;

const MAX_V1_SIGNATURES: usize = 8;
const MAX_HEADER_LEN: usize = 1024;

/// Why a webhook was rejected. All variants map to the same `400` response; the distinction is for logs and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SignatureError {
    #[error("signature header is malformed")]
    Malformed,
    #[error("no valid v1 signature")]
    NoSignature,
    #[error("signature does not match")]
    Mismatch,
    #[error("timestamp outside the tolerance")]
    TimestampOutOfTolerance,
}

struct Parsed {
    timestamp: i64,
    v1: Vec<[u8; 32]>,
}

fn parse(header: &str) -> Result<Parsed, SignatureError> {
    if header.len() > MAX_HEADER_LEN {
        return Err(SignatureError::Malformed);
    }
    let mut timestamp = None;
    let mut v1 = Vec::new();
    let mut v1_seen = 0usize;
    for part in header.split(',') {
        let Some((k, v)) = part.trim().split_once('=') else {
            return Err(SignatureError::Malformed);
        };
        match k {
            "t" => {
                if timestamp.is_some() {
                    return Err(SignatureError::Malformed);
                }
                timestamp = Some(v.parse::<i64>().map_err(|_| SignatureError::Malformed)?);
            }
            "v1" => {
                v1_seen += 1;
                if v1_seen > MAX_V1_SIGNATURES {
                    return Err(SignatureError::Malformed);
                }
                // A v1 value that is not 32 hex-encoded bytes can never match; it is skipped, not fatal.
                if let Ok(bytes) = hex::decode(v)
                    && let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice())
                {
                    v1.push(arr);
                }
            }
            _ => {}
        }
    }
    let timestamp = timestamp.ok_or(SignatureError::Malformed)?;
    if v1.is_empty() {
        return Err(SignatureError::NoSignature);
    }
    Ok(Parsed { timestamp, v1 })
}

fn expected(secret: &Secret, timestamp: i64, payload: &[u8]) -> [u8; 32] {
    // HMAC accepts keys of any length, so this cannot fail; the fallback keeps the function total without panicking.
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.expose().as_bytes()) else {
        return [0u8; 32];
    };
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(payload);
    mac.finalize().into_bytes().into()
}

/// Verify `header` against `payload` for any of `secrets`, at local time `now_unix`.
///
/// Succeeds when at least one `v1` signature equals the HMAC of `"<t>.<payload>"` under at least one secret AND
/// `|now − t| ≤ TOLERANCE_SECS`. Every candidate is compared (no early exit on the first mismatch) in constant time.
pub fn verify(
    payload: &[u8],
    header: &str,
    secrets: &[Secret],
    now_unix: i64,
) -> Result<(), SignatureError> {
    let parsed = parse(header)?;
    let mut matched = subtle::Choice::from(0u8);
    for secret in secrets {
        let want = expected(secret, parsed.timestamp, payload);
        for got in &parsed.v1 {
            matched |= want.ct_eq(got);
        }
    }
    if !bool::from(matched) {
        return Err(SignatureError::Mismatch);
    }
    if now_unix.abs_diff(parsed.timestamp) > TOLERANCE_SECS as u64 {
        return Err(SignatureError::TimestampOutOfTolerance);
    }
    Ok(())
}

/// Build a header for `payload` (what Stripe sends). Public so tests and local tooling can sign fixtures; never used on
/// the receiving path.
pub fn sign(payload: &[u8], secret: &Secret, timestamp: i64) -> String {
    format!(
        "t={timestamp},v1={}",
        hex::encode(expected(secret, timestamp, payload))
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000;
    const BODY: &[u8] = br#"{"id":"evt_1","object":"event"}"#;

    fn secret(s: &str) -> Secret {
        Secret::new(s)
    }

    #[test]
    fn matches_the_documented_construction() {
        // independent re-computation of HMAC-SHA256(secret, "<t>.<body>") through a second code path
        let mut mac = Hmac::<Sha256>::new_from_slice(b"whsec_test").unwrap();
        mac.update(format!("{NOW}.").as_bytes());
        mac.update(BODY);
        let header = format!("t={NOW},v1={}", hex::encode(mac.finalize().into_bytes()));
        assert_eq!(verify(BODY, &header, &[secret("whsec_test")], NOW), Ok(()));
    }

    #[test]
    fn valid_signature_is_accepted_and_v0_is_ignored() {
        let h = sign(BODY, &secret("whsec_a"), NOW);
        assert_eq!(verify(BODY, &h, &[secret("whsec_a")], NOW), Ok(()));
        // a header carrying only the test-only v0 scheme is not accepted, even when it is a correct HMAC
        let v0_only = h.replace("v1=", "v0=");
        assert_eq!(
            verify(BODY, &v0_only, &[secret("whsec_a")], NOW),
            Err(SignatureError::NoSignature)
        );
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let h = sign(BODY, &secret("whsec_a"), NOW);
        let mut tampered = BODY.to_vec();
        tampered[7] = b'X';
        assert_eq!(
            verify(&tampered, &h, &[secret("whsec_a")], NOW),
            Err(SignatureError::Mismatch)
        );
        // re-serialised JSON (whitespace) is a different byte string and must fail too
        assert_eq!(
            verify(
                br#"{ "id":"evt_1","object":"event"}"#,
                &h,
                &[secret("whsec_a")],
                NOW
            ),
            Err(SignatureError::Mismatch)
        );
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let h = sign(BODY, &secret("whsec_a"), NOW);
        assert_eq!(
            verify(BODY, &h, &[secret("whsec_b")], NOW),
            Err(SignatureError::Mismatch)
        );
        assert_eq!(verify(BODY, &h, &[], NOW), Err(SignatureError::Mismatch));
    }

    #[test]
    fn old_and_future_timestamps_are_rejected_but_the_edge_passes() {
        let s = secret("whsec_a");
        let old = sign(BODY, &s, NOW - 301);
        assert_eq!(
            verify(BODY, &old, std::slice::from_ref(&s), NOW),
            Err(SignatureError::TimestampOutOfTolerance)
        );
        let edge = sign(BODY, &s, NOW - 300);
        assert_eq!(verify(BODY, &edge, std::slice::from_ref(&s), NOW), Ok(()));
        let future = sign(BODY, &s, NOW + 301);
        assert_eq!(
            verify(BODY, &future, std::slice::from_ref(&s), NOW),
            Err(SignatureError::TimestampOutOfTolerance)
        );
    }

    #[test]
    fn a_valid_signature_among_several_v1_values_is_enough() {
        let good = sign(BODY, &secret("whsec_new"), NOW);
        let good_v1 = good.split_once(",v1=").unwrap().1;
        let junk = "00".repeat(32);
        let header = format!("t={NOW},v1={junk},v1=zz,v1={good_v1},v0={junk}");
        assert_eq!(verify(BODY, &header, &[secret("whsec_new")], NOW), Ok(()));
        // rolled secret: the old and the new secret are both configured, the delivery is signed with the new one only
        assert_eq!(
            verify(
                BODY,
                &good,
                &[secret("whsec_old"), secret("whsec_new")],
                NOW
            ),
            Ok(())
        );
        // none of several signatures valid
        let header = format!("t={NOW},v1={junk},v1={junk}");
        assert_eq!(
            verify(BODY, &header, &[secret("whsec_new")], NOW),
            Err(SignatureError::Mismatch)
        );
    }

    #[test]
    fn a_timestamp_swapped_into_another_signature_does_not_verify() {
        let s = secret("whsec_a");
        let h = sign(BODY, &s, NOW - 3600);
        let v1 = h.split_once(",v1=").unwrap().1;
        let forged = format!("t={NOW},v1={v1}");
        assert_eq!(
            verify(BODY, &forged, std::slice::from_ref(&s), NOW),
            Err(SignatureError::Mismatch)
        );
    }

    #[test]
    fn malformed_headers_are_rejected() {
        let s = [secret("whsec_a")];
        for h in [
            "",
            "garbage",
            "t=abc,v1=00",
            "v1=00",
            "t=1,t=2,v1=00",
            &format!("t={NOW}"),
            &format!("t={NOW},v1={}", "a".repeat(2000)),
        ] {
            assert!(verify(BODY, h, &s, NOW).is_err(), "accepted {h:?}");
        }
        let many = format!("t={NOW}{}", ",v1=00".repeat(9));
        assert_eq!(verify(BODY, &many, &s, NOW), Err(SignatureError::Malformed));
    }
}
