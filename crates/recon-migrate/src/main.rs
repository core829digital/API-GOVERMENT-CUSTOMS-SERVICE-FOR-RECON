use clap::{Parser, Subcommand};
use recon_migrate::{Target, compare_exit, connect, discover, fingerprint, refresh, subscribe, up};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "recon-migrate", about = "DDL tool for clusters W and R")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Apply pending migrations to one cluster.
    Up {
        #[arg(long, value_enum)]
        target: Target,
        #[arg(long, env = "RECON_DB_URL")]
        url: String,
        #[arg(long, default_value = "migrations")]
        dir: PathBuf,
        /// Apply up to and including this 4-digit version.
        #[arg(long)]
        to: Option<String>,
    },
    /// Create the logical subscription on R (idempotent).
    Subscribe {
        #[arg(long, env = "RECON_R_URL")]
        r_url: String,
        /// libpq connection string R uses to reach W.
        #[arg(long, env = "RECON_W_CONNINFO")]
        w_conninfo: String,
        #[arg(long, default_value = "recon_r_sub")]
        name: String,
        #[arg(long, default_value = "recon_pub")]
        publication: String,
    },
    /// ALTER SUBSCRIPTION … REFRESH PUBLICATION.
    Refresh {
        #[arg(long, env = "RECON_R_URL")]
        r_url: String,
        #[arg(long, default_value = "recon_r_sub")]
        name: String,
    },
    /// Print the replicated-schema fingerprint of one cluster.
    Fingerprint {
        #[arg(long, env = "RECON_DB_URL")]
        url: String,
    },
    /// Exit non-zero unless W and R have identical replicated-schema fingerprints.
    Compare {
        #[arg(long, env = "RECON_W_URL")]
        w_url: String,
        #[arg(long, env = "RECON_R_URL")]
        r_url: String,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}

async fn run(cli: Cli) -> Result<ExitCode, recon_migrate::Error> {
    match cli.cmd {
        Cmd::Up {
            target,
            url,
            dir,
            to,
        } => {
            let migrations = discover(&dir, target)?;
            let pool = connect(&url).await?;
            let applied = up(&pool, &migrations, to.as_deref()).await?;
            if applied.is_empty() {
                println!("{}: up to date", target.token());
            } else {
                println!("{}: applied {}", target.token(), applied.join(", "));
            }
        }
        Cmd::Subscribe {
            r_url,
            w_conninfo,
            name,
            publication,
        } => {
            let pool = connect(&r_url).await?;
            let created = subscribe(&pool, &w_conninfo, &name, &publication).await?;
            println!(
                "{}",
                if created {
                    "subscription created"
                } else {
                    "subscription already exists"
                }
            );
        }
        Cmd::Refresh { r_url, name } => {
            refresh(&connect(&r_url).await?, &name).await?;
            println!("refreshed");
        }
        Cmd::Fingerprint { url } => println!("{}", fingerprint(&connect(&url).await?).await?),
        Cmd::Compare { w_url, r_url } => {
            let (w, r) = (
                fingerprint(&connect(&w_url).await?).await?,
                fingerprint(&connect(&r_url).await?).await?,
            );
            println!("W {w}\nR {r}");
            return Ok(compare_exit(&w, &r));
        }
    }
    Ok(ExitCode::SUCCESS)
}
