//! The internal ("service plane") listener: requests from our own services (the Next.js BFF, worker, admin tooling).
//!
//! On top of the API key every request needs
//!  1. a client IP inside `RECON_INTERNAL_ALLOWED_CIDRS` ([`require_allowed_source`]), and
//!  2. a valid `RECON-SVC-V1` request signature ([`require_signature`]).
//!
//! ## Signature scheme `RECON-SVC-V1`
//!
//! Headers: `X-Recon-Key-Id` (`^[a-z0-9-]{1,32}$`), `X-Recon-Timestamp` (Unix seconds, decimal),
//! `X-Recon-Nonce` (base64url without padding, 16-32 random bytes), `X-Recon-Signature` (base64url without padding).
//!
//! ```text
//! canonical = "RECON-SVC-V1\n" METHOD "\n" TARGET "\n" TIMESTAMP "\n" NONCE "\n" lower-hex(SHA-256(body))
//! signature = base64url(HMAC-SHA256(secret, canonical))
//! ```
//!
//! `METHOD` is upper-case; `TARGET` is the path, followed by `?` and the raw (still percent-encoded) query only
//! when the query is non-empty; the body hash of an empty body is the SHA-256 of the empty string. The shared,
//! machine-readable test vectors live in `tests/vectors/service-signature-v1.json`; the TypeScript signer in
//! `frontend/lib/service-signature.ts` is tested against the same file.
//!
//! Verification: HMAC compared in constant time; `|now - timestamp| <= 60 s`; each `(key id, nonce)` is accepted
//! once within 120 s (bounded in-memory set, per replica; only requests with a *valid* signature can occupy it);
//! an unknown key id costs the same HMAC and gets the same `401` body as a wrong signature. Several keys may be
//! active at once (rotation). The body is buffered up to the endpoint's size limit before it is hashed.

use crate::clock::Clock;
use crate::error::ApiError;
use crate::net::{ClientIp, Cidr, in_any, parse_cidr_list};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

pub const SCHEME: &str = "RECON-SVC-V1";
/// Largest accepted difference between the signed timestamp and the server clock, either direction.
pub const MAX_SKEW_SECS: i64 = 60;
/// How long a nonce is remembered (>= 2 x [`MAX_SKEW_SECS`], so a replay is always either expired or remembered).
pub const NONCE_TTL_SECS: u64 = 120;
/// Most remembered nonces. When full, signed requests get `503` rather than an unchecked replay window.
pub const MAX_NONCES: usize = 200_000;
pub const MIN_SECRET_BYTES: usize = 32;
const MAX_KEYS: usize = 16;

const H_KEY_ID: HeaderName = HeaderName::from_static("x-recon-key-id");
const H_TIMESTAMP: HeaderName = HeaderName::from_static("x-recon-timestamp");
const H_NONCE: HeaderName = HeaderName::from_static("x-recon-nonce");
const H_SIGNATURE: HeaderName = HeaderName::from_static("x-recon-signature");

type HmacSha256 = Hmac<Sha256>;

/// The text that is signed.
pub fn canonical(method: &str, target: &str, timestamp: &str, nonce: &str, body: &[u8]) -> String {
    format!(
        "{SCHEME}\n{}\n{target}\n{timestamp}\n{nonce}\n{}",
        method.to_ascii_uppercase(),
        hex::encode(Sha256::digest(body)),
    )
}

/// `path` plus `?query` when the query is non-empty.
pub fn request_target(uri: &Uri) -> String {
    match uri.query() {
        Some(q) if !q.is_empty() => format!("{}?{q}", uri.path()),
        _ => uri.path().to_string(),
    }
}

fn hmac(secret: &[u8], canonical: &str) -> Option<HmacSha256> {
    let mut mac = HmacSha256::new_from_slice(secret).ok()?;
    mac.update(canonical.as_bytes());
    Some(mac)
}

/// `base64url(HMAC-SHA256(secret, canonical))`, as a client computes it.
pub fn sign(secret: &[u8], canonical: &str) -> Option<String> {
    hmac(secret, canonical).map(|m| URL_SAFE_NO_PAD.encode(m.finalize().into_bytes()))
}

/// Active signing keys: `<key-id>:<base64url secret>` pairs, secrets of at least 32 bytes.
pub struct ServiceKeys(HashMap<String, Vec<u8>>);

impl std::fmt::Debug for ServiceKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut ids: Vec<&String> = self.0.keys().collect();
        ids.sort();
        f.debug_struct("ServiceKeys").field("key_ids", &ids).finish_non_exhaustive()
    }
}

fn valid_key_id(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl ServiceKeys {
    /// Parse `RECON_SERVICE_KEYS`. Errors never include secret material.
    pub fn parse(s: &str) -> Result<Self, String> {
        let mut keys = HashMap::new();
        for (i, entry) in s.split(',').map(str::trim).enumerate().filter(|(_, e)| !e.is_empty()) {
            let n = i + 1;
            let (id, secret) = entry
                .split_once(':')
                .ok_or_else(|| format!("entry {n} is not <key-id>:<base64url-secret>"))?;
            if !valid_key_id(id) {
                return Err(format!("entry {n}: key id must match [a-z0-9-]{{1,32}}"));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(secret)
                .map_err(|_| format!("entry {n}: secret is not base64url without padding"))?;
            if bytes.len() < MIN_SECRET_BYTES {
                return Err(format!("entry {n}: secret must be at least {MIN_SECRET_BYTES} bytes"));
            }
            if keys.insert(id.to_string(), bytes).is_some() {
                return Err(format!("entry {n}: duplicate key id"));
            }
        }
        if keys.is_empty() {
            return Err("no keys given".into());
        }
        if keys.len() > MAX_KEYS {
            return Err(format!("at most {MAX_KEYS} keys may be active"));
        }
        Ok(Self(keys))
    }
}

#[derive(Debug, PartialEq, Eq)]
enum NonceOutcome {
    Fresh,
    Replayed,
    Full,
}

type NonceKey = (String, String);

struct NonceInner {
    expires: HashMap<NonceKey, u64>,
    /// Insertion order == expiry order (fixed TTL, monotonic clock).
    order: VecDeque<(NonceKey, u64)>,
}

/// Remembers `(key id, nonce)` pairs for [`NONCE_TTL_SECS`].
struct NonceCache {
    ttl_nanos: u64,
    max: usize,
    clock: Arc<dyn Clock>,
    inner: Mutex<NonceInner>,
}

impl NonceCache {
    fn new(max: usize, clock: Arc<dyn Clock>) -> Self {
        Self {
            ttl_nanos: NONCE_TTL_SECS * 1_000_000_000,
            max: max.max(1),
            clock,
            inner: Mutex::new(NonceInner {
                expires: HashMap::new(),
                order: VecDeque::new(),
            }),
        }
    }

    fn insert(&self, key_id: &str, nonce: &str) -> NonceOutcome {
        let now = self.clock.monotonic_nanos();
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        while let Some((_, exp)) = inner.order.front() {
            if *exp > now {
                break;
            }
            if let Some((k, _)) = inner.order.pop_front() {
                inner.expires.remove(&k);
            }
        }
        let key = (key_id.to_string(), nonce.to_string());
        if inner.expires.contains_key(&key) {
            return NonceOutcome::Replayed;
        }
        if inner.expires.len() >= self.max {
            return NonceOutcome::Full;
        }
        let exp = now.saturating_add(self.ttl_nanos);
        inner.expires.insert(key.clone(), exp);
        inner.order.push_back((key, exp));
        NonceOutcome::Fresh
    }
}

/// Why a signed request was refused. `Invalid` is one class on the wire (same body, same status) whatever the
/// cause, so a caller cannot tell an unknown key id from a wrong signature, a stale timestamp or a replay.
#[derive(Debug, PartialEq, Eq)]
pub enum SigFailure {
    Invalid(&'static str),
    Busy,
}

impl SigFailure {
    fn into_api_error(self) -> ApiError {
        match self {
            Self::Invalid(reason) => {
                // Reason is a fixed label; nothing from the request is logged.
                eprintln!("service request refused: {reason}");
                ApiError::new(
                    axum::http::StatusCode::UNAUTHORIZED,
                    "invalid_service_signature",
                    "missing or invalid service signature",
                )
            }
            Self::Busy => ApiError::busy(),
        }
    }
}

/// Configuration and state of the internal listener.
pub struct ServicePlane {
    keys: ServiceKeys,
    allowed: Vec<Cidr>,
    nonces: NonceCache,
    clock: Arc<dyn Clock>,
    /// Stands in for the secret of unknown key ids so they cost the same HMAC.
    decoy_secret: [u8; 32],
}

fn single_header<'h>(headers: &'h HeaderMap, name: &HeaderName) -> Option<&'h str> {
    let mut it = headers.get_all(name).iter();
    let first = it.next()?;
    if it.next().is_some() {
        return None;
    }
    first.to_str().ok()
}

impl ServicePlane {
    /// Fails closed: an empty allowlist or no keys is an error, never "allow all".
    pub fn new(keys: ServiceKeys, allowed: Vec<Cidr>, max_nonces: usize, clock: Arc<dyn Clock>) -> Result<Self, String> {
        if keys.0.is_empty() {
            return Err("RECON_SERVICE_KEYS: no keys given".into());
        }
        if allowed.is_empty() {
            return Err("RECON_INTERNAL_ALLOWED_CIDRS must list at least one CIDR".into());
        }
        let mut decoy_secret = [0u8; 32];
        getrandom::fill(&mut decoy_secret).map_err(|_| "the OS random source is unavailable".to_string())?;
        Ok(Self {
            keys,
            allowed,
            nonces: NonceCache::new(max_nonces, clock.clone()),
            clock,
            decoy_secret,
        })
    }

    /// Build from `RECON_SERVICE_KEYS` and `RECON_INTERNAL_ALLOWED_CIDRS` (`get` returns `None` when unset).
    pub fn from_env(get: impl Fn(&str) -> Option<String>, clock: Arc<dyn Clock>) -> Result<Self, String> {
        let keys = get("RECON_SERVICE_KEYS").ok_or("RECON_SERVICE_KEYS is required (internal listener fails closed)")?;
        let cidrs = get("RECON_INTERNAL_ALLOWED_CIDRS")
            .ok_or("RECON_INTERNAL_ALLOWED_CIDRS is required (internal listener fails closed)")?;
        let keys = ServiceKeys::parse(&keys).map_err(|e| format!("RECON_SERVICE_KEYS: {e}"))?;
        let allowed = parse_cidr_list(&cidrs).map_err(|e| format!("RECON_INTERNAL_ALLOWED_CIDRS: {e}"))?;
        Self::new(keys, allowed, MAX_NONCES, clock)
    }

    /// Whether `ip` may use the internal listener at all.
    pub fn source_allowed(&self, ip: Option<std::net::IpAddr>) -> bool {
        ip.is_some_and(|ip| in_any(&self.allowed, ip))
    }

    /// Check the four `X-Recon-*` headers against `method`, `target` and the fully buffered `body`.
    pub fn verify(&self, method: &str, target: &str, headers: &HeaderMap, body: &[u8]) -> Result<(), SigFailure> {
        let bad = SigFailure::Invalid;
        let key_id = single_header(headers, &H_KEY_ID).filter(|k| valid_key_id(k)).ok_or(bad("malformed key id"))?;
        let timestamp = single_header(headers, &H_TIMESTAMP).ok_or(bad("malformed timestamp"))?;
        let nonce = single_header(headers, &H_NONCE).ok_or(bad("malformed nonce"))?;
        let signature = single_header(headers, &H_SIGNATURE).ok_or(bad("malformed signature"))?;

        let ts: i64 = (!timestamp.is_empty() && timestamp.len() <= 12 && timestamp.bytes().all(|b| b.is_ascii_digit()))
            .then(|| timestamp.parse().ok())
            .flatten()
            .ok_or(bad("malformed timestamp"))?;
        let nonce_len = URL_SAFE_NO_PAD.decode(nonce).map(|b| b.len()).map_err(|_| bad("malformed nonce"))?;
        if !(16..=32).contains(&nonce_len) {
            return Err(bad("malformed nonce"));
        }
        let sig = URL_SAFE_NO_PAD.decode(signature).map_err(|_| bad("malformed signature"))?;

        let secret = self.keys.0.get(key_id);
        let canonical = canonical(method, target, timestamp, nonce, body);
        let mac = hmac(secret.map_or(&self.decoy_secret[..], Vec::as_slice), &canonical).ok_or(bad("hmac"))?;
        let signature_ok = mac.verify_slice(&sig).is_ok(); // constant time
        let fresh = (self.clock.unix_secs() - ts).abs() <= MAX_SKEW_SECS;

        if secret.is_none() {
            return Err(bad("unknown key id"));
        }
        if !signature_ok {
            return Err(bad("signature mismatch"));
        }
        if !fresh {
            return Err(bad("timestamp outside the allowed window"));
        }
        // Only a request with a valid signature may occupy the nonce cache.
        match self.nonces.insert(key_id, nonce) {
            NonceOutcome::Fresh => Ok(()),
            NonceOutcome::Replayed => Err(bad("replayed nonce")),
            NonceOutcome::Full => Err(SigFailure::Busy),
        }
    }
}

/// Middleware: refuse requests whose client IP (see [`crate::net`]) is outside the allowlist, before anything
/// else about them is looked at. Needs [`crate::http::client_ip`] outside it.
pub async fn require_allowed_source(State(plane): State<Arc<ServicePlane>>, req: Request, next: Next) -> Response {
    let ip = req.extensions().get::<ClientIp>().and_then(|c| c.0);
    if !plane.source_allowed(ip) {
        return ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "forbidden_source",
            "this listener does not accept requests from your address",
        )
        .into_response();
    }
    next.run(req).await
}

/// State of [`require_signature`]: the plane and the endpoint's body-size limit.
#[derive(Clone)]
pub struct SignatureGate {
    pub plane: Arc<ServicePlane>,
    pub body_limit: usize,
}

/// Middleware: buffer the body (at most `body_limit`), verify the signature over it, then pass the request on with
/// the same body.
pub async fn require_signature(State(gate): State<SignatureGate>, req: Request, next: Next) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, gate.body_limit).await {
        Ok(b) => b,
        Err(_) => return ApiError::payload_too_large().into_response(),
    };
    let target = request_target(&parts.uri);
    if let Err(f) = gate.plane.verify(parts.method.as_str(), &target, &parts.headers, &bytes) {
        return f.into_api_error().into_response();
    }
    next.run(Request::from_parts(parts, Body::from(bytes))).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;
    use crate::net::parse_cidr_list;
    use axum::http::{HeaderValue, Method, StatusCode};
    use serde::Deserialize;
    use tower::ServiceExt;

    #[derive(Deserialize)]
    struct Vectors {
        key_id: String,
        secret_hex: String,
        secret_base64url: String,
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        method: String,
        target: String,
        timestamp: String,
        nonce: String,
        body: String,
        body_sha256_hex: String,
        canonical: String,
        signature: String,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../tests/vectors/service-signature-v1.json")).unwrap()
    }

    #[test]
    fn shared_vectors_canonicalise_and_sign_exactly() {
        let v = vectors();
        let secret = hex::decode(&v.secret_hex).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(&v.secret_base64url).unwrap(), secret);
        assert!(v.vectors.len() >= 4);
        for t in &v.vectors {
            assert_eq!(hex::encode(Sha256::digest(t.body.as_bytes())), t.body_sha256_hex, "{}", t.name);
            let c = canonical(&t.method, &t.target, &t.timestamp, &t.nonce, t.body.as_bytes());
            assert_eq!(c, t.canonical, "{}", t.name);
            assert_eq!(sign(&secret, &c).unwrap(), t.signature, "{}", t.name);
        }
    }

    #[test]
    fn target_is_path_plus_non_empty_raw_query() {
        let t = |s: &str| request_target(&s.parse::<Uri>().unwrap());
        assert_eq!(t("/v1/findings"), "/v1/findings");
        assert_eq!(t("/v1/findings?"), "/v1/findings");
        assert_eq!(t("/v1/findings?a=b%2Fc&d=e"), "/v1/findings?a=b%2Fc&d=e");
    }

    const NOW: i64 = 1_700_000_000;

    fn plane_with(clock: Arc<ManualClock>, max_nonces: usize) -> (Arc<ServicePlane>, Vec<u8>) {
        let v = vectors();
        let keys = ServiceKeys::parse(&format!(
            "{}:{},old-1:{}",
            v.key_id,
            v.secret_base64url,
            URL_SAFE_NO_PAD.encode([7u8; 40])
        ))
        .unwrap();
        let plane = ServicePlane::new(keys, parse_cidr_list("127.0.0.1/32,10.0.0.0/8").unwrap(), max_nonces, clock).unwrap();
        (Arc::new(plane), hex::decode(v.secret_hex).unwrap())
    }

    struct Req<'a> {
        key_id: &'a str,
        method: &'a str,
        target: &'a str,
        ts: i64,
        nonce: &'a str,
        body: &'a [u8],
    }

    fn signed(secret: &[u8], r: &Req<'_>) -> HeaderMap {
        let ts = r.ts.to_string();
        let sig = sign(secret, &canonical(r.method, r.target, &ts, r.nonce, r.body)).unwrap();
        let mut h = HeaderMap::new();
        h.insert(H_KEY_ID, HeaderValue::from_str(r.key_id).unwrap());
        h.insert(H_TIMESTAMP, HeaderValue::from_str(&ts).unwrap());
        h.insert(H_NONCE, HeaderValue::from_str(r.nonce).unwrap());
        h.insert(H_SIGNATURE, HeaderValue::from_str(&sig).unwrap());
        h
    }

    const NONCE_A: &str = "AAECAwQFBgcICQoLDA0ODw";
    const NONCE_B: &str = "EBESExQVFhcYGRobHB0eHw";

    fn base<'a>(nonce: &'a str, body: &'a [u8]) -> Req<'a> {
        Req { key_id: "bff-1", method: "POST", target: "/v1/batches?x=1", ts: NOW, nonce, body }
    }

    fn verify(plane: &ServicePlane, r: &Req<'_>, h: &HeaderMap, body: &[u8]) -> Result<(), SigFailure> {
        plane.verify(r.method, r.target, h, body)
    }

    #[test]
    fn a_correctly_signed_request_is_accepted_once() {
        let (plane, secret) = plane_with(Arc::new(ManualClock::new(NOW)), 100);
        let r = base(NONCE_A, b"{}");
        let h = signed(&secret, &r);
        assert_eq!(verify(&plane, &r, &h, b"{}"), Ok(()));
        assert_eq!(verify(&plane, &r, &h, b"{}"), Err(SigFailure::Invalid("replayed nonce")));
    }

    #[test]
    fn wrong_secret_altered_body_query_or_method_are_refused() {
        let (plane, secret) = plane_with(Arc::new(ManualClock::new(NOW)), 100);
        let r = base(NONCE_A, b"{}");
        let good = signed(&secret, &r);
        assert_eq!(
            verify(&plane, &r, &signed(&[9u8; 32], &r), b"{}"),
            Err(SigFailure::Invalid("signature mismatch"))
        );
        assert!(verify(&plane, &r, &good, b"{ }").is_err(), "altered body");
        assert!(plane.verify("POST", "/v1/batches?x=2", &good, b"{}").is_err(), "altered query");
        assert!(plane.verify("POST", "/v1/batches", &good, b"{}").is_err(), "dropped query");
        assert!(plane.verify("GET", "/v1/batches?x=1", &good, b"{}").is_err(), "altered method");
        assert!(plane.verify("POST", "/v1/runs?x=1", &good, b"{}").is_err(), "altered path");
        // none of the failures consumed the nonce: the genuine request still passes
        assert_eq!(verify(&plane, &r, &good, b"{}"), Ok(()));
    }

    #[test]
    fn stale_and_future_timestamps_are_refused_at_the_boundary() {
        let (plane, secret) = plane_with(Arc::new(ManualClock::new(NOW)), 100);
        let mk = |ts: i64, nonce: &'static str| {
            let r = Req { ts, ..base(nonce, b"") };
            let h = signed(&secret, &r);
            verify(&plane, &r, &h, b"")
        };
        assert_eq!(mk(NOW - 60, "AAECAwQFBgcICQoLDA0ODw"), Ok(()));
        assert_eq!(mk(NOW + 60, "EBESExQVFhcYGRobHB0eHw"), Ok(()));
        assert!(mk(NOW - 61, "ICEiIyQlJicoKSorLC0uLw").is_err());
        assert!(mk(NOW + 61, "MDEyMzQ1Njc4OTo7PD0-Pw").is_err());
        assert!(mk(0, "QEFCQ0RFRkdISUpLTE1OTw").is_err());
    }

    #[test]
    fn a_nonce_is_remembered_for_the_ttl_and_per_key_id() {
        let clock = Arc::new(ManualClock::new(NOW));
        let (plane, secret) = plane_with(clock.clone(), 100);
        let r = base(NONCE_A, b"");
        assert_eq!(verify(&plane, &r, &signed(&secret, &r), b""), Ok(()));
        // same nonce under another key id is a different entry (old-1 signs with its own secret)
        let other = Req { key_id: "old-1", ..base(NONCE_A, b"") };
        assert_eq!(verify(&plane, &other, &signed(&[7u8; 40], &other), b""), Ok(()));
        clock.advance_secs(NONCE_TTL_SECS + 1);
        // after the TTL the entry is gone; a fresh timestamp is signed, so only the nonce cache decides
        let later = Req { ts: NOW + 121, ..base(NONCE_A, b"") };
        assert_eq!(verify(&plane, &later, &signed(&secret, &later), b""), Ok(()));
    }

    #[test]
    fn unknown_key_id_and_malformed_headers_look_like_any_other_failure() {
        let (plane, secret) = plane_with(Arc::new(ManualClock::new(NOW)), 100);
        let r = Req { key_id: "nobody", ..base(NONCE_A, b"") };
        let e = verify(&plane, &r, &signed(&secret, &r), b"").unwrap_err();
        assert_eq!(e, SigFailure::Invalid("unknown key id"));
        assert_eq!(e.into_api_error().code, "invalid_service_signature");

        let r = base(NONCE_B, b"");
        let good = signed(&secret, &r);
        for (name, value) in [
            (H_KEY_ID, "BFF-1"),
            (H_KEY_ID, ""),
            (H_TIMESTAMP, "17e9"),
            (H_TIMESTAMP, "-5"),
            (H_TIMESTAMP, "1700000000000000"),
            (H_NONCE, "AAAA"),                   // 3 bytes
            (H_NONCE, "AAECAwQFBgcICQoLDA0ODw=="), // padded
            (H_NONCE, "AAECAwQFBgcICQoL+A0ODw"),  // not base64url
            (H_SIGNATURE, "AAAA"),
            (H_SIGNATURE, "!!!"),
        ] {
            let mut h = good.clone();
            h.insert(name, HeaderValue::from_static(value));
            assert!(verify(&plane, &r, &h, b"").is_err(), "{value}");
        }
        // missing and duplicated headers
        for name in [H_KEY_ID, H_TIMESTAMP, H_NONCE, H_SIGNATURE] {
            let mut h = good.clone();
            h.remove(&name);
            assert!(verify(&plane, &r, &h, b"").is_err());
            let mut h = good.clone();
            let v = h.get(&name).unwrap().clone();
            h.append(name, v);
            assert!(verify(&plane, &r, &h, b"").is_err());
        }
        assert_eq!(verify(&plane, &r, &good, b""), Ok(()));
    }

    #[test]
    fn rotation_accepts_every_active_key_and_a_full_nonce_cache_fails_closed() {
        let (plane, secret) = plane_with(Arc::new(ManualClock::new(NOW)), 2);
        let old = Req { key_id: "old-1", ..base(NONCE_A, b"") };
        assert_eq!(verify(&plane, &old, &signed(&[7u8; 40], &old), b""), Ok(()));
        let new = base(NONCE_B, b"");
        assert_eq!(verify(&plane, &new, &signed(&secret, &new), b""), Ok(()));
        let third = base("ICEiIyQlJicoKSorLC0uLw", b"");
        assert_eq!(verify(&plane, &third, &signed(&secret, &third), b""), Err(SigFailure::Busy));
        // an unauthenticated flood cannot fill the cache: invalid signatures never reach it
        let bad = base("MDEyMzQ1Njc4OTo7PD0-Pw", b"");
        assert!(matches!(verify(&plane, &bad, &signed(&[1u8; 32], &bad), b""), Err(SigFailure::Invalid(_))));
    }

    #[test]
    fn configuration_fails_closed() {
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(NOW));
        let key = format!("bff-1:{}", URL_SAFE_NO_PAD.encode([1u8; 32]));
        let env = |pairs: Vec<(&'static str, String)>| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
        };
        assert!(ServicePlane::from_env(env(vec![]), clock.clone()).is_err());
        assert!(ServicePlane::from_env(env(vec![("RECON_SERVICE_KEYS", key.clone())]), clock.clone()).is_err());
        assert!(ServicePlane::from_env(env(vec![("RECON_INTERNAL_ALLOWED_CIDRS", "127.0.0.1/32".into())]), clock.clone()).is_err());
        assert!(
            ServicePlane::from_env(
                env(vec![("RECON_SERVICE_KEYS", key.clone()), ("RECON_INTERNAL_ALLOWED_CIDRS", String::new())]),
                clock.clone()
            )
            .is_err(),
            "an empty allowlist must not mean allow-all"
        );
        assert!(
            ServicePlane::from_env(
                env(vec![("RECON_SERVICE_KEYS", key.clone()), ("RECON_INTERNAL_ALLOWED_CIDRS", "127.0.0.1/32".into())]),
                clock.clone()
            )
            .is_ok()
        );
        for bad in [
            "".to_string(),
            "bff-1".to_string(),
            format!("BFF:{}", URL_SAFE_NO_PAD.encode([1u8; 32])),
            format!("bff-1:{}", URL_SAFE_NO_PAD.encode([1u8; 31])),
            format!("bff-1:{}=", URL_SAFE_NO_PAD.encode([1u8; 33])),
            format!("{key},{key}"),
            "bff-1:!!!".to_string(),
        ] {
            assert!(ServiceKeys::parse(&bad).is_err(), "{bad}");
        }
        let dbg = format!("{:?}", ServiceKeys::parse(&key).unwrap());
        assert!(dbg.contains("bff-1") && !dbg.contains("AQEB"), "{dbg}");
    }

    /// The three middlewares in front of a trivial handler, as `lib.rs` stacks them on the internal listener.
    fn stack(plane: Arc<ServicePlane>, limit: usize) -> axum::Router {
        use axum::middleware::from_fn_with_state;
        axum::Router::new()
            .route(
                "/v1/echo",
                axum::routing::any(|body: axum::body::Bytes| async move { body })
                    .layer(from_fn_with_state(SignatureGate { plane: plane.clone(), body_limit: limit }, require_signature)),
            )
            .layer(from_fn_with_state(plane, require_allowed_source))
            .layer(from_fn_with_state(Arc::new(crate::guard::Guard::new(Default::default())), crate::http::client_ip))
    }

    fn call(app: &axum::Router, peer: &str, headers: HeaderMap, extra: &[(&str, &str)], method: &str, uri: &str, body: &'static [u8]) -> impl Future<Output = (StatusCode, Vec<u8>)> {
        let mut req = Request::builder().method(method.parse::<Method>().unwrap()).uri(uri);
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        let mut req = req.body(Body::from(body)).unwrap();
        req.extensions_mut().insert(axum::extract::ConnectInfo::<std::net::SocketAddr>(format!("{peer}:5000").parse().unwrap()));
        let app = app.clone();
        async move {
            let res = app.oneshot(req).await.unwrap();
            let status = res.status();
            (status, axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec())
        }
    }

    #[tokio::test]
    async fn the_internal_stack_enforces_source_ip_then_signature() {
        let (plane, secret) = plane_with(Arc::new(ManualClock::new(NOW)), 100);
        let app = stack(plane, 1024);
        let r = Req { method: "POST", target: "/v1/echo?a=b", ..base(NONCE_A, b"hello") };
        let h = signed(&secret, &r);

        // allowed source, valid signature: the handler echoes the (re-attached) body
        let (s, body) = call(&app, "127.0.0.1", h.clone(), &[], "POST", "/v1/echo?a=b", b"hello").await;
        assert_eq!((s, body.as_slice()), (StatusCode::OK, &b"hello"[..]));
        // replay
        let (s, body) = call(&app, "127.0.0.1", h.clone(), &[], "POST", "/v1/echo?a=b", b"hello").await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        let replay_body = String::from_utf8(body).unwrap();
        // unsigned, altered body
        let (s, unsigned_body) = call(&app, "127.0.0.1", HeaderMap::new(), &[], "POST", "/v1/echo?a=b", b"hello").await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(replay_body, String::from_utf8(unsigned_body).unwrap(), "one 401 body for every signature failure");
        let r2 = Req { method: "POST", target: "/v1/echo?a=b", ..base(NONCE_B, b"hello") };
        let (s, _) = call(&app, "127.0.0.1", signed(&secret, &r2), &[], "POST", "/v1/echo?a=b", b"HELLO").await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        // body above the endpoint limit
        let big: &'static [u8] = &[b'x'; 2048];
        let r3 = Req { method: "POST", target: "/v1/echo", ..base("ICEiIyQlJicoKSorLC0uLw", big) };
        let (s, _) = call(&app, "127.0.0.1", signed(&secret, &r3), &[], "POST", "/v1/echo", big).await;
        assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);

        // a correctly signed request from outside the allowlist is refused before the signature is looked at
        let r4 = Req { method: "POST", target: "/v1/echo", ..base("MDEyMzQ1Njc4OTo7PD0-Pw", b"") };
        let (s, body) = call(&app, "203.0.113.9", signed(&secret, &r4), &[], "POST", "/v1/echo", b"").await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        assert!(String::from_utf8(body).unwrap().contains("forbidden_source"));
        // spoofing the source through X-Forwarded-For does nothing: the peer is not a trusted proxy
        let r5 = Req { method: "POST", target: "/v1/echo", ..base("QEFCQ0RFRkdISUpLTE1OTw", b"") };
        let (s, _) = call(&app, "203.0.113.9", signed(&secret, &r5), &[("x-forwarded-for", "127.0.0.1"), ("forwarded", "for=127.0.0.1"), ("x-real-ip", "127.0.0.1")], "POST", "/v1/echo", b"").await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // and a request with no peer address at all is refused
        let mut req = Request::builder().uri("/v1/echo").body(Body::empty()).unwrap();
        req.extensions_mut().clear();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
    }
}
