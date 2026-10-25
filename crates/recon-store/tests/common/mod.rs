//! Shared fixture for the integration tests against a REAL W + R pair (Rules R-GEN-2: no mocks).
//!
//! Prerequisites (CI does the same; locally see tools/dev/pg-pair.mjs):
//!   * W and R migrated with `recon-migrate` (R first; locally R `--to 0005` if pgvector is unavailable),
//!   * the subscription created (`recon-migrate subscribe`),
//!   * env `RECON_TEST_W_URL` and `RECON_TEST_R_URL`: superuser/admin URLs used only for setup and
//!     independent inspection. The stores under test connect as NON-superuser login roles
//!     (superusers bypass RLS and would hide isolation bugs).
//!
//! Missing prerequisites fail loudly; they never skip.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use recon_evidence::ChainEvent;
use recon_store::{Actor, ReadStore, WriteStore};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;
use uuid::Uuid;

pub fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("set {name}; see the header of crates/recon-store/tests/common/mod.rs")
    })
}

pub struct Fx {
    pub admin_w: PgPool,
    pub admin_r: PgPool,
    pub w_admin: WriteStore,
    pub w_cmd: WriteStore,
    pub w_retention: WriteStore,
    pub r_api: ReadStore,
    pub w_url: String,
    pub r_url: String,
}

/// Builds a fixture for ONE test. Not shared between tests: each #[tokio::test] owns a separate Tokio runtime and the
/// pools are bound to it.
pub async fn fx() -> Fx {
    let (w_url, r_url) = (env("RECON_TEST_W_URL"), env("RECON_TEST_R_URL"));
    let admin_w = PgPoolOptions::new()
        .max_connections(4)
        .connect(&w_url)
        .await
        .unwrap();
    let admin_r = PgPoolOptions::new()
        .max_connections(4)
        .connect(&r_url)
        .await
        .unwrap();
    for (pool, roles) in [
        (
            &admin_w,
            [
                ("t_w_cmd", "w_cmd"),
                ("t_w_admin", "w_admin"),
                ("t_w_retention", "w_retention"),
            ]
            .as_slice(),
        ),
        (&admin_r, [("t_r_api", "r_api")].as_slice()),
    ] {
        // role creation is cluster-wide and idempotent; serialise concurrent tests with an advisory lock
        let mut c = pool.acquire().await.unwrap();
        sqlx::query("SELECT pg_advisory_lock(424242)")
            .execute(&mut *c)
            .await
            .unwrap();
        for (login, group) in roles {
            let sql = format!(
                "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{login}') \
                 THEN CREATE ROLE {login} LOGIN IN ROLE {group}; END IF; END $$;"
            );
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut *c)
                .await
                .unwrap();
        }
        sqlx::query("SELECT pg_advisory_unlock(424242)")
            .execute(&mut *c)
            .await
            .unwrap();
    }
    let sub: (i64,) =
        sqlx::query_as("SELECT count(*) FROM pg_subscription WHERE subname='recon_r_sub'")
            .fetch_one(&admin_r)
            .await
            .unwrap();
    assert_eq!(
        sub.0, 1,
        "subscription recon_r_sub missing on R: run `recon-migrate subscribe`"
    );
    let as_user = |url: &str, user: &str| PgConnectOptions::from_str(url).unwrap().username(user);
    Fx {
        w_admin: WriteStore::connect_with(as_user(&w_url, "t_w_admin"), 4)
            .await
            .unwrap(),
        w_cmd: WriteStore::connect_with(as_user(&w_url, "t_w_cmd"), 16)
            .await
            .unwrap(),
        w_retention: WriteStore::connect_with(as_user(&w_url, "t_w_retention"), 4)
            .await
            .unwrap(),
        r_api: ReadStore::connect_with(as_user(&r_url, "t_r_api"), 8)
            .await
            .unwrap(),
        admin_w,
        admin_r,
        w_url,
        r_url,
    }
}

pub async fn new_tenant(f: &Fx) -> Uuid {
    let mut tx = f.w_admin.begin_unbound().await.unwrap();
    let (id,): (Uuid,) = sqlx::query_as("SELECT core.create_tenant($1)")
        .bind(format!("test-{}", Uuid::now_v7()))
        .fetch_one(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    id
}

pub async fn append(f: &Fx, tenant: Uuid, n: i64) -> i64 {
    let mut tx = f.w_cmd.begin_tenant(tenant).await.unwrap();
    // unordered keys on purpose: the stored hash must be over the JCS form
    let payload = serde_json::json!({"z": n, "a": {"y": 1, "b": [3, 2, 1]}});
    let a = tx
        .append_event("test.event", Actor::System("pair-test"), &payload)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    a.seq
}

type Row = (
    Uuid,
    i64,
    Uuid,
    String,
    String,
    String,
    i64,
    String,
    String,
    String,
    serde_json::Value,
);

/// The tenant's full ledger as seen by `pool` (use a superuser pool: independent of RLS), with stored payloads.
pub async fn export(pool: &PgPool, tenant: Uuid) -> (Vec<ChainEvent>, Vec<serde_json::Value>) {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT tenant_id, seq, id, event_type, actor_type, actor_ref,
                ((extract(epoch FROM occurred_at) * 1000000)::bigint),
                encode(payload_sha256,'hex'), encode(prev_hash,'hex'), encode(hash,'hex'), payload
           FROM ledger.audit_event WHERE tenant_id = $1 ORDER BY seq",
    )
    .bind(tenant)
    .fetch_all(pool)
    .await
    .unwrap();
    let payloads = rows.iter().map(|r| r.10.clone()).collect();
    let events = rows
        .into_iter()
        .map(|r| ChainEvent {
            tenant_id: r.0,
            seq: r.1,
            id: r.2,
            event_type: r.3,
            actor_type: r.4,
            actor_ref: r.5,
            occurred_at_micros: r.6,
            payload_sha256: r.7,
            prev_hash: r.8,
            hash: r.9,
        })
        .collect();
    (events, payloads)
}

pub fn hex(h: [u8; 32]) -> String {
    h.iter().map(|b| format!("{b:02x}")).collect()
}
