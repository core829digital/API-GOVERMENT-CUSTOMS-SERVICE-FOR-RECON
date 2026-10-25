//! API server with two listeners built from the same handlers (see `recon_api` crate docs).
//!
//! Configuration (environment):
//!   RECON_W_URL        W connection string for the command role (`w_cmd` members)
//!   RECON_R_URL        R connection string for the query role (`r_api` members)
//!   RECON_BRIDGE_WAIT_MS  max wait for `X-Min-Seq` reads before `503 replica_lag` (default 1500)
//!
//! Public listener (customers, API keys; per-IP rate limit before authentication):
//!   RECON_BIND         listen address (default 127.0.0.1:8080)
//!
//! Internal listener (our own services: BFF, worker, admin tooling). Requires a source IP inside the allowlist and
//! a `RECON-SVC-V1` signature in addition to the API key. The process REFUSES TO START without the two
//! variables below: there is no "allow everything" default.
//!   RECON_INTERNAL_BIND           listen address (default 127.0.0.1:8081)
//!   RECON_INTERNAL_ALLOWED_CIDRS  comma-separated CIDRs, IPv4 and IPv6, e.g. `127.0.0.1/32,::1/128`
//!   RECON_SERVICE_KEYS            comma-separated `<key-id>:<base64url secret, >= 32 bytes>`; several keys = rotation
//!
//! Both listeners:
//!   RECON_TRUSTED_PROXY_CIDRS     peers whose X-Forwarded-For is believed (default none: the TCP peer is the client)
//!   RECON_RATE_IP, RECON_RATE_KEY_READ, RECON_RATE_KEY_WRITE, RECON_RATE_TENANT_READ, RECON_RATE_TENANT_WRITE
//!                                 `<per_minute>/<burst>` token buckets (defaults: see `recon_api::guard::RateLimits`)
//!   RECON_RATE_MAX_KEYS           tracked keys per limiter (default 100000)
//!   RECON_ARGON2_CONCURRENCY      simultaneous Argon2id verifications (default 4)
//!   RECON_ARGON2_WAIT_MS          wait for a verification slot before `503 busy` (default 500)

use recon_api::clock::{Clock, SystemClock};
use recon_api::{AppState, SecurityConfig, ServicePlane, app, internal_app};
use recon_store::{ReadStore, WriteStore};
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

fn var(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("environment variable {name} is required"))
}

fn get(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn run() -> Result<(), String> {
    let (w_url, r_url) = (var("RECON_W_URL")?, var("RECON_R_URL")?);
    let bind = get("RECON_BIND").unwrap_or_else(|| "127.0.0.1:8080".into());
    let internal_bind = get("RECON_INTERNAL_BIND").unwrap_or_else(|| "127.0.0.1:8081".into());
    let wait_ms: u64 = match std::env::var("RECON_BRIDGE_WAIT_MS") {
        Ok(v) => v
            .parse()
            .map_err(|_| "RECON_BRIDGE_WAIT_MS must be an integer".to_string())?,
        Err(_) => 1500,
    };

    // Security configuration first: a misconfigured internal listener must stop the process before it serves anything.
    let security = SecurityConfig::from_env(get)?;
    let clock: Arc<dyn Clock> = Arc::new(SystemClock::new());
    let plane = Arc::new(ServicePlane::from_env(get, clock)?);

    let w = WriteStore::connect(&w_url, 16)
        .await
        .map_err(|e| format!("cannot connect to W: {e}"))?;
    let r = ReadStore::connect(&r_url, 16)
        .await
        .map_err(|e| format!("cannot connect to R: {e}"))?;
    let state = AppState::with_security(w, r, Duration::from_millis(wait_ms), security)
        .map_err(|e| format!("startup failed: {}", e.message))?;

    let public = tokio::net::TcpListener::bind(&bind)
        .await
        .map_err(|e| format!("cannot bind {bind}: {e}"))?;
    let internal = tokio::net::TcpListener::bind(&internal_bind)
        .await
        .map_err(|e| format!("cannot bind {internal_bind}: {e}"))?;
    println!("public listener on {bind}");
    println!("internal listener on {internal_bind}");

    let public_server = axum::serve(
        public,
        app(state.clone()).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown());
    let internal_server = axum::serve(
        internal,
        internal_app(state, plane).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown());

    tokio::try_join!(public_server.into_future(), internal_server.into_future())
        .map(|_| ())
        .map_err(|e| format!("server error: {e}"))
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("error: {msg}");
            ExitCode::from(1)
        }
    }
}
