//! DEV-ONLY: loads a small SYNTHETIC data set (no real invoices) for one tenant so the engine and the UI have
//! something to show. Until the ingest worker exists there is no other way for records to reach
//! `ingest.source_record`.
//!
//!   recon-dev-seed --tenant <UUID>        (RECON_W_URL: a `w_cmd` login)
//!
//! Registers two batches (`erp_ledger`, `authority_clearance`), inserts the records below, marks both batches
//! `parsed`, appends a ledger event per batch and prints the batch ids. Every run creates new batches.

use recon_store::{Actor, WriteStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::process::ExitCode;
use uuid::Uuid;

fn sha(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn invoice(r: &str, total: i64) -> Value {
    json!({"invoice_ref": r, "currency": "PLN", "total_minor": total})
}

fn clearance(r: &str, status: &str, total: i64) -> Value {
    json!({"invoice_ref": r, "status": status, "currency": "PLN", "total_minor": total})
}

async fn seed_batch(
    w: &WriteStore,
    tenant: Uuid,
    source_type: &str,
    kind: &str,
    records: &[Value],
) -> Result<Uuid, String> {
    let e = |e: &dyn std::fmt::Display| e.to_string();
    let mut tx = w.begin_tenant(tenant).await.map_err(|x| e(&x))?;
    let nonce = Uuid::now_v7();
    let (batch,): (Uuid,) = sqlx::query_as(
        "INSERT INTO ingest.source_batch(tenant_id, source_type, object_uri, sha256, status)
         VALUES ($1, $2, $3, $4, 'parsed') RETURNING id",
    )
    .bind(tenant)
    .bind(source_type)
    .bind(format!("https://synthetic.invalid/{nonce}"))
    .bind(sha(nonce.as_bytes()))
    .fetch_one(tx.conn())
    .await
    .map_err(|x| e(&x))?;
    for rec in records {
        let canonical = serde_json::to_vec(rec).map_err(|x| e(&x))?;
        sqlx::query(
            "INSERT INTO ingest.source_record(tenant_id, batch_id, record_kind, canonical, record_sha256)
             VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(tenant)
        .bind(batch)
        .bind(kind)
        .bind(rec)
        .bind(sha(&canonical))
        .execute(tx.conn())
        .await
        .map_err(|x| e(&x))?;
    }
    tx.append_event(
        "batch.parsed",
        Actor::System("recon-dev-seed"),
        &json!({"batch_id": batch, "record_count": records.len(), "synthetic": true}),
    )
    .await
    .map_err(|x| e(&x))?;
    tx.commit().await.map_err(|x| e(&x))?;
    Ok(batch)
}

async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let tenant = match (args.next().as_deref(), args.next()) {
        (Some("--tenant"), Some(t)) => t.parse::<Uuid>().map_err(|_| "invalid tenant UUID".to_string())?,
        _ => return Err("usage: recon-dev-seed --tenant <UUID>".into()),
    };
    let url = std::env::var("RECON_W_URL").map_err(|_| "RECON_W_URL is required".to_string())?;
    let w = WriteStore::connect(&url, 2).await.map_err(|e| format!("cannot connect to W: {e}"))?;

    let erp = seed_batch(
        &w,
        tenant,
        "erp_ledger",
        "invoice",
        &[
            invoice("SYN-001", 12_300), // cleared, agrees
            invoice("SYN-002", 45_000), // no clearance record
            invoice("SYN-003", 8_000),  // rejected
            invoice("SYN-004", 99_900), // cleared with a different total
            invoice("SYN-005", 1_500),  // pending
        ],
    )
    .await?;
    let authority = seed_batch(
        &w,
        tenant,
        "authority_clearance",
        "clearance_status",
        &[
            clearance("SYN-001", "accepted", 12_300),
            clearance("SYN-003", "rejected", 8_000),
            clearance("SYN-004", "accepted", 99_000),
            clearance("SYN-005", "pending", 1_500),
            clearance("SYN-099", "accepted", 700), // no invoice
        ],
    )
    .await?;
    println!("erp_batch={erp}\nauthority_batch={authority}");
    Ok(())
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
