//! Operator tool: insert plan rows from a JSON file, or retire one.
//!
//! ```text
//! RECON_BILLING_ADMIN_W_URL=postgres://<login in role w_billing_admin>@…/recon_w recon-billing-seed apply plans.json
//! RECON_BILLING_ADMIN_W_URL=… recon-billing-seed retire <plan-uuid>
//! ```
//!
//! The file is `{"plans": [ {code, display_key, billing_interval, currency, unit_amount_minor, is_public, is_fallback,
//! sort_order, provider_price_id, valid_from, entitlements: {key: integer|boolean}} ]}` (see `NewPlan`). Prices are an
//! input of this tool, never a default of the code. A plan row cannot be edited afterwards; apply a new row instead.

use recon_billing::plans::{NewPlan, SeedFile, create_plan, retire_plan};
use recon_store::WriteStore;
use std::process::ExitCode;
use uuid::Uuid;

const URL_VAR: &str = "RECON_BILLING_ADMIN_W_URL";

async fn run(args: Vec<String>) -> Result<(), String> {
    let url = std::env::var(URL_VAR).map_err(|_| format!("set {URL_VAR}"))?;
    let store = WriteStore::connect(&url, 2)
        .await
        .map_err(|e| e.to_string())?;
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["apply", file] => {
            let text =
                std::fs::read_to_string(file).map_err(|e| format!("cannot read {file}: {e}"))?;
            let seed: SeedFile =
                serde_json::from_str(&text).map_err(|e| format!("invalid seed file: {e}"))?;
            // validate everything first so a typo in the last plan does not leave the file half applied
            seed.plans
                .iter()
                .try_for_each(NewPlan::validate)
                .map_err(|e| e.to_string())?;
            for p in &seed.plans {
                let id = create_plan(&store, p).await.map_err(|e| e.to_string())?;
                println!("{} {} {}", id, p.code, p.billing_interval);
            }
            Ok(())
        }
        ["retire", id] => {
            let id = Uuid::parse_str(id).map_err(|_| "plan id must be a UUID".to_string())?;
            let done = retire_plan(&store, id, None)
                .await
                .map_err(|e| e.to_string())?;
            println!(
                "{}",
                if done {
                    "retired"
                } else {
                    "not found or already retired"
                }
            );
            Ok(())
        }
        _ => Err("usage: recon-billing-seed apply <plans.json> | retire <plan-uuid>".into()),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("recon-billing-seed: {e}");
            ExitCode::FAILURE
        }
    }
}
