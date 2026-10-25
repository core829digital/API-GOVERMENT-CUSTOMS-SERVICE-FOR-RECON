//! Provisioning CLI.
//!   recon-admin create-tenant --name <NAME>                      (RECON_ADMIN_W_URL: a `w_admin` login)
//!   recon-admin issue-api-key --tenant <UUID> --scope <S> [...]  (RECON_W_URL: a `w_cmd` login)
//! The API token is printed once to stdout and is never stored in plaintext.

use clap::{Parser, Subcommand};
use recon_api::admin::{create_tenant, issue_api_key};
use recon_store::WriteStore;
use std::process::ExitCode;
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "recon-admin")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    CreateTenant {
        #[arg(long)]
        name: String,
        #[arg(long, env = "RECON_ADMIN_W_URL")]
        url: String,
    },
    IssueApiKey {
        #[arg(long)]
        tenant: Uuid,
        /// Repeatable: batches:write, batches:read, findings:read
        #[arg(long = "scope", required = true)]
        scopes: Vec<String>,
        #[arg(long, env = "RECON_W_URL")]
        url: String,
    },
}

async fn run(cli: Cli) -> Result<(), String> {
    match cli.cmd {
        Cmd::CreateTenant { name, url } => {
            let w = WriteStore::connect(&url, 2)
                .await
                .map_err(|e| e.to_string())?;
            let id = create_tenant(&w, &name).await.map_err(|e| e.message)?;
            println!("{id}");
        }
        Cmd::IssueApiKey {
            tenant,
            scopes,
            url,
        } => {
            let w = WriteStore::connect(&url, 2)
                .await
                .map_err(|e| e.to_string())?;
            let k = issue_api_key(&w, tenant, &scopes)
                .await
                .map_err(|e| e.message)?;
            eprintln!("key id: {} (the token below is shown once)", k.key_id);
            println!("{}", k.token);
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("error: {msg}");
            ExitCode::from(1)
        }
    }
}
