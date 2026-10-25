//! Engine worker. Configuration (environment):
//!   RECON_W_URL            W connection string, a `w_worker` login
//!   RECON_R_URL            R connection string, an `r_api` login
//!   RECON_BRIDGE_WAIT_MS   max wait for R to apply a run's `min_seq` (default 1500); a longer lag defers the run
//!   RECON_ENGINE_POLL_MS   pause between passes (default 1000)
//! Flags: `--once` runs a single pass over all tenants and exits.

use recon_engine::Engine;
use recon_store::{ReadStore, WriteStore};
use std::process::ExitCode;
use std::time::Duration;

fn var(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("environment variable {name} is required"))
}

fn millis(name: &str, default: u64) -> Result<Duration, String> {
    match std::env::var(name) {
        Ok(v) => v
            .parse()
            .map(Duration::from_millis)
            .map_err(|_| format!("{name} must be an integer")),
        Err(_) => Ok(Duration::from_millis(default)),
    }
}

async fn run() -> Result<(), String> {
    let once = std::env::args().skip(1).any(|a| a == "--once");
    let w = WriteStore::connect(&var("RECON_W_URL")?, 4)
        .await
        .map_err(|e| format!("cannot connect to W: {e}"))?;
    let r = ReadStore::connect(&var("RECON_R_URL")?, 4)
        .await
        .map_err(|e| format!("cannot connect to R: {e}"))?;
    let engine = Engine::new(w, r, millis("RECON_BRIDGE_WAIT_MS", 1500)?);
    let poll = millis("RECON_ENGINE_POLL_MS", 1000)?;

    let stop = tokio::signal::ctrl_c();
    tokio::pin!(stop);
    loop {
        let pass = engine
            .run_pass()
            .await
            .map_err(|e| format!("pass failed: {e}"))?;
        if pass != Default::default() {
            println!(
                "pass: completed={} failed={} deferred={}",
                pass.completed, pass.failed, pass.deferred
            );
        }
        if once {
            return Ok(());
        }
        tokio::select! {
            _ = &mut stop => return Ok(()),
            () = tokio::time::sleep(poll) => {}
        }
    }
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
