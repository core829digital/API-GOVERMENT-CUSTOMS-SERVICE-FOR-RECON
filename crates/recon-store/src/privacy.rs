//! Privacy operations on W: legal holds, erasure decisions (crypto-shred) and retention purge
//! (Rules R-PRIV-3, R-PRIV-5).
//!
//! Each operation is ONE SQL function (`migrations/w/0007_privacy_procedures.sql`) that changes state and appends its
//! ledger event in the same transaction, so there is no way to erase, purge or hold without a chained record. The
//! functions require the transaction to be bound to the tenant (`WriteStore::begin_tenant`). Which login role may call
//! which function is decided by grants: `w_cmd` holds and erasures, `w_retention` purges (DatabaseInfo.md §6).

use crate::{Actor, StoreError, WriteTx};
use uuid::Uuid;

/// Result of [`WriteTx::process_erasure_request`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErasureOutcome {
    /// The subject key's wrapped DEK was deleted; ciphertext encrypted under it is unrecoverable.
    Shredded,
    /// The key was shredded earlier; nothing changed, nothing ledgered.
    AlreadyShredded,
    /// No such key for this tenant; nothing changed, nothing ledgered.
    NotFound,
    /// An active legal hold covers the key. Ledgered.
    DeferredLegalHold,
    /// Data referencing the key lives in a jurisdiction without a retention policy row (erasure refused). Ledgered.
    DeferredNoRetentionPolicy,
    /// A retention period for data referencing the key is still running. Ledgered.
    DeferredRetention,
}

impl ErasureOutcome {
    fn parse(s: &str) -> Result<Self, StoreError> {
        Ok(match s {
            "shredded" => Self::Shredded,
            "already_shredded" => Self::AlreadyShredded,
            "not_found" => Self::NotFound,
            "deferred_legal_hold" => Self::DeferredLegalHold,
            "deferred_no_retention_policy" => Self::DeferredNoRetentionPolicy,
            "deferred_retention" => Self::DeferredRetention,
            other => {
                return Err(StoreError::Db(sqlx::Error::Protocol(format!(
                    "unknown erasure outcome {other:?}"
                ))));
            }
        })
    }
}

/// Outcome of a purge run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeOutcome {
    /// At least one expired batch was deleted.
    Purged,
    /// Expired batches exist but every one is covered by an active legal hold.
    Held,
    /// Nothing is past its retention period.
    NothingExpired,
    /// No retention policy for the jurisdiction: nothing was deleted. Ledgered.
    RefusedNoRetentionPolicy,
}

/// Result of [`WriteTx::purge_expired_batches`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PurgeReport {
    pub outcome: PurgeOutcome,
    pub batches_purged: i32,
    pub records_purged: i64,
    pub batches_held: i32,
}

impl WriteTx {
    /// Place a legal hold. `scope` is a non-empty JSON object with any of `all` (bool), `batch_ids` and
    /// `subject_key_ids` (arrays of lowercase UUID strings). Returns the hold id.
    pub async fn place_legal_hold(
        &mut self,
        scope: &serde_json::Value,
        reason: &str,
        placed_by: &str,
        actor: Actor<'_>,
    ) -> Result<Uuid, StoreError> {
        let (actor_type, actor_ref) = actor.parts();
        let id: Uuid = sqlx::query_scalar("SELECT privacy.place_legal_hold($1,$2,$3,$4,$5,$6)")
            .bind(self.tenant)
            .bind(scope)
            .bind(reason)
            .bind(placed_by)
            .bind(actor_type)
            .bind(actor_ref)
            .fetch_one(&mut *self.tx)
            .await?;
        Ok(id)
    }

    /// Release a legal hold. `false` when the hold does not exist for this tenant or was already released.
    pub async fn release_legal_hold(
        &mut self,
        hold: Uuid,
        actor: Actor<'_>,
    ) -> Result<bool, StoreError> {
        let (actor_type, actor_ref) = actor.parts();
        Ok(
            sqlx::query_scalar("SELECT privacy.release_legal_hold($1,$2,$3,$4)")
                .bind(self.tenant)
                .bind(hold)
                .bind(actor_type)
                .bind(actor_ref)
                .fetch_one(&mut *self.tx)
                .await?,
        )
    }

    /// Decide an erasure request for one subject key: crypto-shred it, or defer (legal hold, missing retention policy,
    /// running retention period). Deferrals are ledgered with their reason.
    pub async fn process_erasure_request(
        &mut self,
        key: Uuid,
        actor: Actor<'_>,
    ) -> Result<ErasureOutcome, StoreError> {
        let (actor_type, actor_ref) = actor.parts();
        let outcome: String =
            sqlx::query_scalar("SELECT privacy.process_erasure_request($1,$2,$3,$4)")
                .bind(self.tenant)
                .bind(key)
                .bind(actor_type)
                .bind(actor_ref)
                .fetch_one(&mut *self.tx)
                .await?;
        ErasureOutcome::parse(&outcome)
    }

    /// Delete this tenant's expired source batches (and records) for `jurisdiction`, skipping legal-held batches.
    /// Only the `w_retention` role may call this.
    pub async fn purge_expired_batches(
        &mut self,
        jurisdiction: &str,
        actor: Actor<'_>,
    ) -> Result<PurgeReport, StoreError> {
        let (actor_type, actor_ref) = actor.parts();
        let (outcome, batches_purged, records_purged, batches_held): (String, i32, i64, i32) =
            sqlx::query_as(
                "SELECT outcome, batches_purged, records_purged, batches_held
                   FROM privacy.purge_expired_batches($1,$2,$3,$4)",
            )
            .bind(self.tenant)
            .bind(jurisdiction)
            .bind(actor_type)
            .bind(actor_ref)
            .fetch_one(&mut *self.tx)
            .await?;
        let outcome = match outcome.as_str() {
            "purged" => PurgeOutcome::Purged,
            "held" => PurgeOutcome::Held,
            "nothing_expired" => PurgeOutcome::NothingExpired,
            "refused_no_retention_policy" => PurgeOutcome::RefusedNoRetentionPolicy,
            other => {
                return Err(StoreError::Db(sqlx::Error::Protocol(format!(
                    "unknown purge outcome {other:?}"
                ))));
            }
        };
        Ok(PurgeReport {
            outcome,
            batches_purged,
            records_purged,
            batches_held,
        })
    }
}
