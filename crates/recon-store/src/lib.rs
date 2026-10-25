//! Access to the two clusters.
//!
//! * [`WriteStore`] talks to **W** (authoritative, commands only).
//! * [`ReadStore`] talks to **R** (derived copy, queries only; every transaction is `READ ONLY`).
//! * No function in this crate takes both (Rules R-DB-1). Query handlers receive a `&ReadStore`,
//!   command handlers a `&WriteStore`.
//! * [`bridge`] is the only place that waits for replication (R-DB-4), using the per-tenant
//!   **ledger sequence token** — never an LSN (Architecture.md §5.2).
//! * Every transaction is bound to one tenant with `SET LOCAL app.tenant_id` (RLS, R-SEC-3).

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use std::str::FromStr;
use uuid::Uuid;

pub mod bridge;
pub mod privacy;

/// Errors from the store layer.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("evidence error: {0}")]
    Evidence(#[from] recon_evidence::EvidenceError),
    #[error("invalid connection string: {0}")]
    BadUrl(String),
    /// R has not yet applied the requested ledger sequence for this tenant (maps to `503 replica_lag`).
    #[error("replica lag: wanted seq >= {wanted}, replica at {observed:?}")]
    ReplicaLag { wanted: i64, observed: Option<i64> },
}

/// Who performed an action; stored in the ledger. Never put PII in the reference (R-PRIV-1):
/// use opaque ids.
#[derive(Debug, Clone, Copy)]
pub enum Actor<'a> {
    User(&'a str),
    ApiKey(&'a str),
    System(&'a str),
}

impl Actor<'_> {
    fn parts(&self) -> (&'static str, &str) {
        match self {
            Actor::User(r) => ("user", r),
            Actor::ApiKey(r) => ("api_key", r),
            Actor::System(r) => ("system", r),
        }
    }
}

/// Result of a ledger append: the token the client passes back as `X-Min-Seq`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appended {
    pub seq: i64,
    pub hash: [u8; 32],
}

async fn bind_tenant(conn: &mut PgConnection, tenant: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('app.tenant_id', $1, true)")
        .bind(tenant.to_string())
        .execute(conn)
        .await?;
    Ok(())
}

fn options(url: &str) -> Result<PgConnectOptions, StoreError> {
    PgConnectOptions::from_str(url).map_err(|e| StoreError::BadUrl(e.to_string()))
}

/// Handle to cluster **W**.
#[derive(Clone)]
pub struct WriteStore {
    pool: PgPool,
}

impl WriteStore {
    /// Connect using a W connection string.
    pub async fn connect(url: &str, max_connections: u32) -> Result<Self, StoreError> {
        Self::connect_with(options(url)?, max_connections).await
    }

    /// Connect with explicit options (e.g. a specific login role).
    pub async fn connect_with(
        opts: PgConnectOptions,
        max_connections: u32,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            pool: PgPoolOptions::new()
                .max_connections(max_connections)
                .connect_with(opts)
                .await?,
        })
    }

    /// Begin a read-write transaction bound to `tenant`.
    pub async fn begin_tenant(&self, tenant: Uuid) -> Result<WriteTx, StoreError> {
        let mut tx = self.pool.begin().await?;
        bind_tenant(&mut tx, tenant).await?;
        Ok(WriteTx { tx, tenant })
    }

    /// Begin a transaction with **no** tenant bound (tenant-agnostic admin calls such as `core.create_tenant`).
    pub async fn begin_unbound(&self) -> Result<WriteTx, StoreError> {
        Ok(WriteTx {
            tx: self.pool.begin().await?,
            tenant: Uuid::nil(),
        })
    }

    /// Liveness probe.
    pub async fn ping(&self) -> Result<(), StoreError> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
}

/// A command transaction on W.
pub struct WriteTx {
    tx: Transaction<'static, Postgres>,
    tenant: Uuid,
}

impl WriteTx {
    /// Raw connection for command SQL.
    pub fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }

    /// Tenant this transaction is bound to (`Uuid::nil()` if unbound).
    pub fn tenant(&self) -> Uuid {
        self.tenant
    }

    /// Append a ledger event in this transaction (R-API-2: every command does this). The database assigns
    /// `seq`, `id`, `occurred_at` and computes the hash (DatabaseInfo.md §4.1).
    pub async fn append_event(
        &mut self,
        event_type: &str,
        actor: Actor<'_>,
        payload: &serde_json::Value,
    ) -> Result<Appended, StoreError> {
        let digest = recon_evidence::payload_sha256(payload)?;
        let (actor_type, actor_ref) = actor.parts();
        let (seq, hash): (i64, Vec<u8>) =
            sqlx::query_as("SELECT seq, hash FROM ledger.append_event($1,$2,$3,$4,$5,$6)")
                .bind(self.tenant)
                .bind(event_type)
                .bind(actor_type)
                .bind(actor_ref)
                .bind(payload)
                .bind(digest.as_slice())
                .fetch_one(&mut *self.tx)
                .await?;
        let hash: [u8; 32] = hash
            .try_into()
            .map_err(|_| sqlx::Error::Protocol("hash length".into()))?;
        Ok(Appended { seq, hash })
    }

    /// Commit.
    pub async fn commit(self) -> Result<(), StoreError> {
        Ok(self.tx.commit().await?)
    }
}

/// Handle to cluster **R**. Read-only by construction.
#[derive(Clone)]
pub struct ReadStore {
    pool: PgPool,
}

impl ReadStore {
    /// Connect using an R connection string.
    pub async fn connect(url: &str, max_connections: u32) -> Result<Self, StoreError> {
        Self::connect_with(options(url)?, max_connections).await
    }

    /// Connect with explicit options (e.g. the `r_api` login role).
    pub async fn connect_with(
        opts: PgConnectOptions,
        max_connections: u32,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            pool: PgPoolOptions::new()
                .max_connections(max_connections)
                .connect_with(opts)
                .await?,
        })
    }

    /// Begin a `READ ONLY` transaction bound to `tenant`.
    pub async fn begin_tenant(&self, tenant: Uuid) -> Result<ReadTx, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION READ ONLY")
            .execute(&mut *tx)
            .await?;
        bind_tenant(&mut tx, tenant).await?;
        Ok(ReadTx { tx })
    }

    /// Liveness probe.
    pub async fn ping(&self) -> Result<(), StoreError> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
}

/// A query transaction on R (always `READ ONLY`).
pub struct ReadTx {
    tx: Transaction<'static, Postgres>,
}

impl ReadTx {
    /// Raw connection for query SQL.
    pub fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }

    /// End the transaction (nothing to commit; releases the connection cleanly).
    pub async fn finish(self) -> Result<(), StoreError> {
        Ok(self.tx.rollback().await?)
    }
}
