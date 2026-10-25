//! API server. Configuration (environment):
//!   RECON_W_URL        W connection string for the command role (`w_cmd` members)
//!   RECON_R_URL        R connection string for the query role (`r_api` members)
//!   RECON_BIND         listen address (default 127.0.0.1:8080)
//!   RECON_BRIDGE_WAIT_MS  max wait for `X-Min-Seq` reads before `503 replica_lag` (default 1500)

use recon_api::{AppState, app};
use recon_store::{ReadStore, WriteStore};
use std::process::ExitCode;
use std::time::Duration;

fn var(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("environment variable {name} is required"))
}

async fn run() -> Result<(), String> {
    let (w_url, r_url) = (var("RECON_W_URL")?, var("RECON_R_URL")?);
    let bind = std::env::var("RECON_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let wait_ms: u64 = match std::env::var("RECON_BRIDGE_WAIT_MS") {
        Ok(v) => v
            .parse()
            .map_err(|_| "RECON_BRIDGE_WAIT_MS must be an integer".to_string())?,
        Err(_) => 1500,
    };
    let w = WriteStore::connect(&w_url, 16)
        .await
        .map_err(|e| format!("cannot connect to W: {e}"))?;
    let r = ReadStore::connect(&r_url, 16)
        .await
        .map_err(|e| format!("cannot connect to R: {e}"))?;
    let state = AppState::new(w, r, Duration::from_millis(wait_ms))
        .map_err(|e| format!("startup failed: {}", e.message))?;
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .map_err(|e| format!("cannot bind {bind}: {e}"))?;
    println!("listening on {bind}");
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
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
