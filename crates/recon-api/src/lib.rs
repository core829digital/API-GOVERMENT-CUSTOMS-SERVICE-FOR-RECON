//! HTTP API. Query handlers use only [`ReadStore`] (cluster R) and command handlers only [`WriteStore`]
//! (cluster W) — Rules R-DB-1. The single, documented W read on a request path is credential lookup in [`auth`].

use axum::Router;
use axum::routing::get;
use recon_store::{ReadStore, WriteStore};
use std::sync::Arc;
use std::time::Duration;

pub mod admin;
pub mod auth;
pub mod error;
mod routes;

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub(crate) w: WriteStore,
    pub(crate) r: ReadStore,
    /// How long a tokenised read waits for R to apply the client's write before answering `503 replica_lag`.
    pub(crate) bridge_wait: Duration,
    /// A valid Argon2id hash of a random secret, verified against when a key is unknown (timing equalisation).
    pub(crate) dummy_hash: Arc<String>,
}

impl AppState {
    /// Build state. Fails only if the OS random source or hashing is unavailable.
    pub fn new(
        w: WriteStore,
        r: ReadStore,
        bridge_wait: Duration,
    ) -> Result<Self, error::ApiError> {
        let dummy = auth::generate_token()?;
        Ok(Self {
            w,
            r,
            bridge_wait,
            dummy_hash: Arc::new(dummy.secret_hash),
        })
    }
}

/// The application router.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(routes::healthz))
        .route("/readyz", get(routes::readyz))
        .route("/v1/batches", axum::routing::post(routes::create_batch))
        .route("/v1/batches/{id}", get(routes::get_batch))
        .route("/v1/recon/runs", axum::routing::post(routes::create_run))
        .route("/v1/recon/runs/{id}", get(routes::get_run))
        .route("/v1/findings", get(routes::list_findings))
        .with_state(state)
}
