//! Read-your-writes across W and R using the per-tenant ledger sequence token.
//!
//! Every command appends a ledger event in the same W transaction as its change and returns the event's
//! `seq` (`X-Commit-Seq`). Logical replication applies each transaction atomically in commit order, so
//! `R.ledger.chain_head.last_seq >= seq` proves the change is visible to the next R snapshot.
//!
//! LSN-based tokens were tested and rejected: a post-commit WAL position is not reliably reachable by the
//! subscriber's applied position once any non-replicated WAL follows (Architecture.md §5.2, Progress.md §7).
//!
//! **This is the only module that may wait for replication or read `ledger.chain_head` for
//! synchronisation** (Rules R-DB-4).

use crate::{ReadStore, StoreError};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Current `last_seq` the replica has applied for `tenant` (`None` if the chain head has not replicated yet).
pub async fn applied_seq(store: &ReadStore, tenant: Uuid) -> Result<Option<i64>, StoreError> {
    let mut tx = store.begin_tenant(tenant).await?;
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT last_seq FROM ledger.chain_head WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_optional(tx.conn())
            .await?;
    tx.finish().await?;
    Ok(row.map(|r| r.0))
}

/// Data watermark for `X-Data-Watermark`: wall-clock time (Unix microseconds) of the newest ledger event for
/// `tenant` that R has applied. `None` if nothing has replicated for the tenant yet. Clients can read it as
/// "this response reflects at least everything committed up to this time".
pub async fn watermark_micros(store: &ReadStore, tenant: Uuid) -> Result<Option<i64>, StoreError> {
    let mut tx = store.begin_tenant(tenant).await?;
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT ((extract(epoch FROM occurred_at) * 1000000)::bigint)
           FROM ledger.audit_event WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1",
    )
    .bind(tenant)
    .fetch_optional(tx.conn())
    .await?;
    tx.finish().await?;
    Ok(row.map(|r| r.0))
}

/// Wait until R has applied at least `min_seq` for `tenant`, polling with short backoff.
/// Returns the observed `last_seq`, or [`StoreError::ReplicaLag`] after `max_wait` (map to `503` +
/// `Retry-After`). Never falls back to W (R-DB-5).
pub async fn wait_for_seq(
    store: &ReadStore,
    tenant: Uuid,
    min_seq: i64,
    max_wait: Duration,
) -> Result<i64, StoreError> {
    let deadline = Instant::now() + max_wait;
    let mut delay = Duration::from_millis(10);
    loop {
        let observed = applied_seq(store, tenant).await?;
        if let Some(s) = observed.filter(|s| *s >= min_seq) {
            return Ok(s);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(StoreError::ReplicaLag {
                wanted: min_seq,
                observed,
            });
        }
        tokio::time::sleep(delay.min(deadline - now)).await;
        delay = (delay * 2).min(Duration::from_millis(100));
    }
}
