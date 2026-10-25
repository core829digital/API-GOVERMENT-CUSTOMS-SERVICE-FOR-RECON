//! Provisioning operations used by the `recon-admin` binary (and by tests). Not exposed over HTTP.

use crate::auth::{SCOPES, generate_token};
use crate::error::ApiError;
use recon_store::{Actor, WriteStore};
use uuid::Uuid;

/// Create a tenant together with its ledger chain (`core.create_tenant`). Requires the `w_admin` role.
pub async fn create_tenant(w: &WriteStore, name: &str) -> Result<Uuid, ApiError> {
    let mut tx = w.begin_unbound().await?;
    let (id,): (Uuid,) = sqlx::query_as("SELECT core.create_tenant($1)")
        .bind(name)
        .fetch_one(tx.conn())
        .await?;
    tx.commit().await?;
    Ok(id)
}

/// A newly issued API key. `token` is shown exactly once; only its Argon2id hash is stored.
pub struct IssuedKey {
    pub key_id: Uuid,
    pub token: String,
}

/// Issue an API key for `tenant` with `scopes`, ledgered as `api_key.issued`. Requires the `w_cmd` role.
pub async fn issue_api_key(
    w: &WriteStore,
    tenant: Uuid,
    scopes: &[String],
) -> Result<IssuedKey, ApiError> {
    if scopes.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_scopes",
            "at least one scope is required",
        ));
    }
    if let Some(bad) = scopes.iter().find(|s| !SCOPES.contains(&s.as_str())) {
        return Err(ApiError::bad_request(
            "invalid_scopes",
            format!("unknown scope `{bad}`; allowed: {}", SCOPES.join(", ")),
        ));
    }
    let t = generate_token()?;
    let mut tx = w.begin_tenant(tenant).await?;
    let (key_id,): (Uuid,) = sqlx::query_as("INSERT INTO api.api_key(tenant_id, prefix, secret_hash, scopes) VALUES ($1,$2,$3,$4) RETURNING id")
        .bind(tenant)
        .bind(&t.prefix)
        .bind(t.secret_hash.as_bytes())
        .bind(scopes)
        .fetch_one(tx.conn())
        .await?;
    tx.append_event(
        "api_key.issued",
        Actor::System("recon-admin"),
        &serde_json::json!({"key_id": key_id, "scopes": scopes}),
    )
    .await?;
    tx.commit().await?;
    Ok(IssuedKey {
        key_id,
        token: t.token,
    })
}
