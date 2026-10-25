//! API-key authentication (Rules R-SEC-4: Argon2id hashes, shown once, scoped, revocable).
//!
//! Token format: `rk_<16 hex prefix>_<64 hex secret>`. Only the prefix is indexed; the secret is verified
//! against an Argon2id PHC string stored in `api.api_key.secret_hash` (W only: the `api` schema is never
//! replicated to R).
//!
//! **Documented exception to "queries hit R":** credential lookup reads W through `api.lookup_api_key()` because
//! secret hashes must never exist on R. It is the only W read on a request path, it is confined to this module,
//! and it is not cached yet (revocation is immediate); add a cache only when measured (R-GEN-4).
//!
//! **Abuse limits (R-SEC-9).** Argon2 is expensive, so it is never reached by traffic that has not passed the
//! per-IP limiter (`http::limit_ip`, public listener), a token that is not even shaped like a key costs no Argon2
//! at all, and verifications are capped at `argon2_concurrency` at a time (`Guard::verify_password`, `503 busy`
//! when saturated). After a successful verification the per-key and per-tenant limiters apply (stricter for
//! POST).

use crate::{AppState, error::ApiError};
use argon2::password_hash::phc::PasswordHash;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::extract::FromRequestParts;
use axum::http::{Method, header, request::Parts};
use uuid::Uuid;

/// Scopes a key may carry.
pub const SCOPES: [&str; 5] = [
    "batches:write",
    "batches:read",
    "findings:read",
    "runs:write",
    "runs:read",
];

/// An authenticated caller.
#[derive(Debug, Clone)]
pub struct Principal {
    pub tenant: Uuid,
    pub key_id: Uuid,
    scopes: Vec<String>,
}

impl Principal {
    /// Fail with 403 unless the credential carries `scope`.
    pub fn require(&self, scope: &str) -> Result<(), ApiError> {
        if self.scopes.iter().any(|s| s == scope) {
            Ok(())
        } else {
            Err(ApiError::forbidden(scope))
        }
    }
}

fn random_hex(bytes: usize) -> Result<String, getrandom::Error> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf)?;
    Ok(hex::encode(buf))
}

fn argon2() -> Argon2<'static> {
    Argon2::default() // Argon2id v1.3 with the crate's default cost parameters
}

/// Hash a secret into an Argon2id PHC string.
pub fn hash_secret(secret: &str) -> Result<String, ApiError> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|_| ApiError::internal())?;
    let phc: PasswordHash = argon2()
        .hash_password_with_salt(secret.as_bytes(), &salt)
        .map_err(|_| ApiError::internal())?;
    Ok(phc.to_string())
}

/// A freshly generated token and the parts to store.
pub struct NewToken {
    pub token: String,
    pub prefix: String,
    pub secret_hash: String,
}

/// Generate a token (returned once to the caller) and its storable hash.
pub fn generate_token() -> Result<NewToken, ApiError> {
    let prefix = random_hex(8).map_err(|_| ApiError::internal())?;
    let secret = random_hex(32).map_err(|_| ApiError::internal())?;
    let secret_hash = hash_secret(&secret)?;
    Ok(NewToken {
        token: format!("rk_{prefix}_{secret}"),
        prefix,
        secret_hash,
    })
}

/// Split `rk_<prefix>_<secret>`; `None` if the shape is wrong.
pub fn parse_token(token: &str) -> Option<(&str, &str)> {
    let rest = token.strip_prefix("rk_")?;
    let (prefix, secret) = rest.split_once('_')?;
    let hex_ok = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit());
    (hex_ok(prefix, 16) && hex_ok(secret, 64)).then_some((prefix, secret))
}

impl FromRequestParts<AppState> for Principal {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let mut values = parts.headers.get_all(header::AUTHORIZATION).iter();
        let (Some(value), None) = (values.next(), values.next()) else {
            return Err(ApiError::unauthorized());
        };
        let token = value
            .to_str()
            .ok()
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or_else(ApiError::unauthorized)?;
        // A malformed token carries no secret to protect and must not cost Argon2 time.
        let (prefix, secret) = parse_token(token).ok_or_else(ApiError::unauthorized)?;

        let mut tx = state.w.begin_unbound().await?;
        let row: Option<(Uuid, Uuid, Vec<u8>, Vec<String>)> =
            sqlx::query_as("SELECT id, tenant_id, secret_hash, scopes FROM api.lookup_api_key($1)")
                .bind(prefix)
                .fetch_optional(tx.conn())
                .await?;
        drop(tx); // read-only use: roll back

        let Some((key_id, tenant, hash, scopes)) = row else {
            // equalise timing for unknown prefixes
            state
                .guard
                .verify_password((*state.dummy_hash).clone(), secret.to_string())
                .await?;
            return Err(ApiError::unauthorized());
        };
        let hash = String::from_utf8(hash).map_err(|_| ApiError::internal())?;
        if !state.guard.verify_password(hash, secret.to_string()).await? {
            return Err(ApiError::unauthorized());
        }
        let write = !matches!(parts.method, Method::GET | Method::HEAD);
        state.guard.check_principal(key_id, tenant, write)?;
        Ok(Principal {
            tenant,
            key_id,
            scopes,
        })
    }
}

/// Argon2id verification on the blocking pool (CPU and memory bound).
pub async fn verify(phc: String, secret: String) -> bool {
    // `verify_password` takes the PHC string directly; a malformed string is an Err, i.e. `false`.
    tokio::task::spawn_blocking(move || {
        argon2()
            .verify_password(secret.as_bytes(), phc.as_str())
            .is_ok()
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn token_shape() {
        let t = generate_token().unwrap();
        let (p, s) = parse_token(&t.token).unwrap();
        assert_eq!((p, t.prefix.as_str()), (t.prefix.as_str(), p));
        assert_eq!(s.len(), 64);
        assert!(parse_token("rk_zz_zz").is_none());
        assert!(parse_token("Bearer x").is_none());
        assert!(parse_token(&format!("rk_{}_{}", "g".repeat(16), "a".repeat(64))).is_none());
    }

    #[tokio::test]
    async fn hash_verifies_only_the_right_secret() {
        let h = hash_secret("correct").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify(h.clone(), "correct".into()).await);
        assert!(!verify(h, "wrong".into()).await);
        assert!(!verify("not-a-phc-string".into(), "x".into()).await);
    }
}
