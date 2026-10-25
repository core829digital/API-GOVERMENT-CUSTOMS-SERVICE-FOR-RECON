//! HTTP API. Query handlers use only [`ReadStore`] (cluster R) and command handlers only [`WriteStore`]
//! (cluster W) — Rules R-DB-1. The single, documented W read on a request path is credential lookup in [`auth`].
//!
//! Two routers are built from the same handlers:
//! * [`app`] — the **public** listener for customers with API keys: per-IP limiter first, then API-key auth.
//! * [`internal_app`] — the **internal** listener for our own services: client IP inside the allowlist and a
//!   `RECON-SVC-V1` signature on every request ([`service`]), in addition to the API key.
//!
//! Both answer every response (rejections included) with the headers of [`http::security_headers`].

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::middleware::{from_fn, from_fn_with_state};
use axum::routing::{MethodRouter, get, post};
use recon_store::{ReadStore, WriteStore};
use std::sync::Arc;
use std::time::Duration;

pub mod admin;
pub mod auth;
pub mod clock;
pub mod error;
pub mod guard;
pub mod http;
pub mod net;
pub mod ratelimit;
mod routes;
pub mod service;
pub mod validate;

pub use guard::{Guard, RateLimits, SecurityConfig};
pub use service::{ServiceKeys, ServicePlane};

/// Body limit of `POST /v1/batches`: five short fields; the longest is `object_uri` (2048 bytes) — 8 KiB leaves
/// room for JSON escaping and whitespace and is far below the 64 KiB default.
pub const BATCH_BODY_LIMIT: usize = 8 * 1024;
/// Body limit of `POST /v1/recon/runs`: a UUID and at most 100 batch UUIDs (about 4 KiB).
pub const RUN_BODY_LIMIT: usize = 8 * 1024;

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub(crate) w: WriteStore,
    pub(crate) r: ReadStore,
    /// How long a tokenised read waits for R to apply the client's write before answering `503 replica_lag`.
    pub(crate) bridge_wait: Duration,
    /// A valid Argon2id hash of a random secret, verified against when a key is unknown (timing equalisation).
    pub(crate) dummy_hash: Arc<String>,
    /// Rate limiters, the Argon2 concurrency cap and the trusted-proxy list.
    pub(crate) guard: Arc<Guard>,
}

impl AppState {
    /// Build state with the default [`SecurityConfig`]. Fails only if the OS random source or hashing is unavailable.
    pub fn new(
        w: WriteStore,
        r: ReadStore,
        bridge_wait: Duration,
    ) -> Result<Self, error::ApiError> {
        Self::with_security(w, r, bridge_wait, SecurityConfig::default())
    }

    /// Build state with explicit limits and trusted proxies.
    pub fn with_security(
        w: WriteStore,
        r: ReadStore,
        bridge_wait: Duration,
        security: SecurityConfig,
    ) -> Result<Self, error::ApiError> {
        let dummy = auth::generate_token()?;
        Ok(Self {
            w,
            r,
            bridge_wait,
            dummy_hash: Arc::new(dummy.secret_hash),
            guard: Arc::new(Guard::new(security)),
        })
    }
}

/// One route's rules: the body limit is applied three ways — declared `Content-Length` before authentication
/// (413), `DefaultBodyLimit` for streamed bodies read by extractors, and (internal listener) the buffering limit
/// of the signature check. `limit == 0` means the route takes no body.
fn guarded(
    route: MethodRouter<AppState>,
    limit: usize,
    plane: Option<&Arc<ServicePlane>>,
) -> MethodRouter<AppState> {
    let route = route.layer(DefaultBodyLimit::max(limit));
    let route = match plane {
        Some(p) => route.layer(from_fn_with_state(
            service::SignatureGate {
                plane: p.clone(),
                body_limit: limit,
            },
            service::require_signature,
        )),
        None => route,
    };
    route.layer(from_fn_with_state(
        http::RouteRules { body_limit: limit },
        http::enforce_route_rules,
    ))
}

fn build(state: AppState, plane: Option<Arc<ServicePlane>>) -> Router {
    let guard = state.guard.clone();
    let p = plane.as_ref();
    let router = Router::new()
        .route("/healthz", guarded(get(routes::healthz), 0, p))
        .route("/readyz", guarded(get(routes::readyz), 0, p))
        .route(
            "/v1/batches",
            guarded(post(routes::create_batch), BATCH_BODY_LIMIT, p),
        )
        .route("/v1/batches/{id}", guarded(get(routes::get_batch), 0, p))
        .route(
            "/v1/recon/runs",
            guarded(post(routes::create_run), RUN_BODY_LIMIT, p),
        )
        .route("/v1/recon/runs/{id}", guarded(get(routes::get_run), 0, p))
        .route("/v1/findings", guarded(get(routes::list_findings), 0, p))
        .fallback(http::not_found)
        .method_not_allowed_fallback(http::method_not_allowed)
        .with_state(state);

    // Outermost first when the request arrives: response headers, client IP, head limits, then the listener's gate.
    let router = match plane {
        Some(p) => router.layer(from_fn_with_state(p, service::require_allowed_source)),
        None => router.layer(from_fn_with_state(guard.clone(), http::limit_ip)),
    };
    router
        .layer(from_fn(http::limit_request_head))
        .layer(from_fn_with_state(guard, http::client_ip))
        .layer(from_fn(http::add_security_headers))
}

/// The public router (API keys only, per-IP limiter before authentication). Serve it with
/// `into_make_service_with_connect_info::<SocketAddr>()` so the client address is known.
pub fn app(state: AppState) -> Router {
    build(state, None)
}

/// The internal router: same routes, behind the source-IP allowlist and the request signature. Serve it with
/// `into_make_service_with_connect_info::<SocketAddr>()`.
pub fn internal_app(state: AppState, plane: Arc<ServicePlane>) -> Router {
    build(state, Some(plane))
}
