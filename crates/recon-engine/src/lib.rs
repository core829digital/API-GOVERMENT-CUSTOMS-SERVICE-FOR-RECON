//! Reconciliation engine worker (Architecture.md §4 step 3).
//!
//! For each tenant it claims one `queued` run (`FOR UPDATE SKIP LOCKED`), waits through the bridge until R has
//! applied the run's `min_seq`, reads the run's normalised records **from R**, evaluates the check
//! deterministically ([`c1`]) and writes findings plus the final run state **to W**, appending one ledger event.
//!
//! The whole run is ONE W transaction opened before the R read:
//! * a crash or a replica-lag deferral rolls back and the run stays `queued` (stages are resumable, §7);
//! * the per-tenant ledger lock is taken only by the final `append_event`, so commands of the same tenant are not
//!   blocked while the engine waits for R or evaluates.
//!
//! A run whose input cannot be evaluated (ambiguous or malformed records, or a rule pack that lacks a rule the
//! outcome must cite) ends `failed` with a stable reason code in its ledger event; nothing partial is written.

use recon_store::{Actor, ReadStore, StoreError, WriteStore, bridge};
use serde_json::json;
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

pub mod c1;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// What one [`Engine::process_next`] call did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// No queued run for the tenant.
    Idle,
    Completed {
        run: Uuid,
        findings: usize,
    },
    Failed {
        run: Uuid,
        reason: &'static str,
    },
    /// R has not applied the run's `min_seq` within the bridge wait; the run stays `queued`.
    Deferred {
        run: Uuid,
    },
}

/// Totals over one pass across all tenants.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Pass {
    pub completed: usize,
    pub failed: usize,
    pub deferred: usize,
}

pub struct Engine {
    w: WriteStore,
    r: ReadStore,
    bridge_wait: Duration,
}

type RunRow = (Uuid, Uuid, Vec<Uuid>, i64);
type RecordRow = (Uuid, String, serde_json::Value, Vec<u8>);

impl Engine {
    /// `w` must connect as a `w_worker` member (tenant iteration), `r` as an `r_api` member.
    pub fn new(w: WriteStore, r: ReadStore, bridge_wait: Duration) -> Self {
        Self { w, r, bridge_wait }
    }

    /// Process queued runs of every tenant until none is processable. A deferred run ends that tenant's pass
    /// (it would be retried immediately otherwise).
    pub async fn run_pass(&self) -> Result<Pass, EngineError> {
        let mut tx = self.w.begin_unbound().await?;
        let tenants: Vec<(Uuid,)> = sqlx::query_as("SELECT core.list_tenant_ids()")
            .fetch_all(tx.conn())
            .await?;
        tx.commit().await?;

        let mut pass = Pass::default();
        for (tenant,) in tenants {
            loop {
                match self.process_next(tenant).await? {
                    Step::Idle => break,
                    Step::Completed { .. } => pass.completed += 1,
                    Step::Failed { .. } => pass.failed += 1,
                    Step::Deferred { .. } => {
                        pass.deferred += 1;
                        break;
                    }
                }
            }
        }
        Ok(pass)
    }

    /// Claim and process at most one queued run of `tenant`.
    pub async fn process_next(&self, tenant: Uuid) -> Result<Step, EngineError> {
        let mut tx = self.w.begin_tenant(tenant).await?;
        let claimed: Option<RunRow> = sqlx::query_as(
            "SELECT id, rule_pack_id, input_batch_ids, min_seq FROM recon.run
              WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
        .fetch_optional(tx.conn())
        .await?;
        let Some((run, pack, batches, min_seq)) = claimed else {
            return Ok(Step::Idle);
        };

        match bridge::wait_for_seq(&self.r, tenant, min_seq, self.bridge_wait).await {
            Ok(_) => {}
            Err(StoreError::ReplicaLag { .. }) => return Ok(Step::Deferred { run }), // tx drops: rolled back
            Err(e) => return Err(e.into()),
        }

        let mut rtx = self.r.begin_tenant(tenant).await?;
        let rows: Vec<RecordRow> = sqlx::query_as(
            "SELECT id, record_kind, canonical, record_sha256 FROM ingest.source_record
              WHERE tenant_id = $1 AND batch_id = ANY($2) AND record_kind = ANY($3) ORDER BY id",
        )
        .bind(tenant)
        .bind(&batches)
        .bind([c1::KIND_INVOICE, c1::KIND_CLEARANCE].as_slice())
        .fetch_all(rtx.conn())
        .await?;
        rtx.finish().await?;
        let records: Vec<c1::Record> = rows
            .into_iter()
            .map(|(id, kind, canonical, sha256)| c1::Record {
                id,
                kind,
                canonical,
                sha256,
            })
            .collect();

        let rule_ids: HashMap<String, Uuid> =
            sqlx::query_as::<_, (String, Uuid)>("SELECT code, id FROM rules.rule WHERE pack_id = $1")
                .bind(pack)
                .fetch_all(tx.conn())
                .await?
                .into_iter()
                .collect();

        let verdict = c1::evaluate(&records)
            .map_err(|e| e.reason_code())
            .and_then(|drafts| {
                drafts
                    .into_iter()
                    .map(|d| {
                        rule_ids
                            .get(d.outcome.rule_code())
                            .map(|rule| (d, *rule))
                            .ok_or("rule_missing_in_pack")
                    })
                    .collect::<Result<Vec<_>, _>>()
            });

        let step = match verdict {
            Ok(findings) => {
                for (d, rule) in &findings {
                    sqlx::query(
                        "INSERT INTO recon.finding(tenant_id, run_id, check_code, rule_id, severity, subject_ref,
                                                   input_record_ids, input_hashes, detail)
                         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8)",
                    )
                    .bind(tenant)
                    .bind(run)
                    .bind(c1::CHECK_CODE)
                    .bind(rule)
                    .bind(d.outcome.severity())
                    .bind(&d.input_record_ids)
                    .bind(&d.input_hashes)
                    .bind(&d.detail)
                    .execute(tx.conn())
                    .await?;
                }
                sqlx::query("UPDATE recon.run SET status='done', started_at=now(), finished_at=now() WHERE id=$1")
                    .bind(run)
                    .execute(tx.conn())
                    .await?;
                tx.append_event(
                    "recon.run_completed",
                    Actor::System("recon-engine"),
                    &json!({"run_id": run, "finding_count": findings.len()}),
                )
                .await?;
                Step::Completed {
                    run,
                    findings: findings.len(),
                }
            }
            Err(reason) => {
                sqlx::query("UPDATE recon.run SET status='failed', started_at=now(), finished_at=now() WHERE id=$1")
                    .bind(run)
                    .execute(tx.conn())
                    .await?;
                tx.append_event(
                    "recon.run_failed",
                    Actor::System("recon-engine"),
                    &json!({"run_id": run, "reason": reason}),
                )
                .await?;
                Step::Failed { run, reason }
            }
        };
        tx.commit().await?;
        Ok(step)
    }
}
