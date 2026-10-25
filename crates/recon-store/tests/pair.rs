//! Integration tests against a REAL W + R pair with logical replication (Rules R-GEN-2: no mocks here).
//! Prerequisites and fixture: see `tests/common/mod.rs`. Missing prerequisites fail loudly; they never skip.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{append, export, fx, hex, new_tenant};
use recon_evidence::{payload_sha256, verify_chain};
use recon_store::{Actor, ReadStore, StoreError, bridge};
use sqlx::ConnectOptions;
use sqlx::postgres::PgConnectOptions;
use std::str::FromStr;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[tokio::test]
async fn create_tenant_creates_chain_that_replicates_to_r() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    let seen = bridge::wait_for_seq(&f.r_api, t, 1, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(seen >= 1);
}

#[tokio::test]
async fn rust_hash_layout_matches_sql_and_chain_verifies_on_w_and_r() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    let mut last = 1;
    for n in 0..3 {
        last = append(f, t, n).await;
    }
    assert_eq!(last, 4, "tenant.created + 3 events");
    bridge::wait_for_seq(&f.r_api, t, last, Duration::from_secs(10))
        .await
        .unwrap();

    for (name, pool) in [("W", &f.admin_w), ("R", &f.admin_r)] {
        let (events, payloads) = export(pool, t).await;
        let head = verify_chain(&events).unwrap_or_else(|e| panic!("chain invalid on {name}: {e}"));
        assert_eq!(events.len(), 4);
        assert_eq!(hex(head), events[3].hash, "{name}");
        // payload hash recomputed from the STORED jsonb equals the stored hash (JCS stable through jsonb)
        for (e, p) in events.iter().zip(&payloads) {
            assert_eq!(
                hex(payload_sha256(p).unwrap()),
                e.payload_sha256,
                "{name} seq {}",
                e.seq
            );
        }
    }
    // chain_head on W agrees with the verified head
    let (h,): (String,) =
        sqlx::query_as("SELECT encode(last_hash,'hex') FROM ledger.chain_head WHERE tenant_id=$1")
            .bind(t)
            .fetch_one(&f.admin_w)
            .await
            .unwrap();
    assert_eq!(h, export(&f.admin_w, t).await.0[3].hash);
}

#[tokio::test]
async fn seq_token_gives_exact_read_your_writes() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    for n in 0..15 {
        let seq = append(f, t, n).await;
        bridge::wait_for_seq(&f.r_api, t, seq, Duration::from_secs(10))
            .await
            .unwrap();
        // the moment the token is satisfied the event itself must be readable on R
        let mut tx = f.r_api.begin_tenant(t).await.unwrap();
        let (c,): (i64,) =
            sqlx::query_as("SELECT count(*) FROM ledger.audit_event WHERE tenant_id=$1 AND seq=$2")
                .bind(t)
                .bind(seq)
                .fetch_one(tx.conn())
                .await
                .unwrap();
        tx.finish().await.unwrap();
        assert_eq!(c, 1, "token satisfied but event {seq} not visible");
    }
}

#[tokio::test]
async fn wait_times_out_with_replica_lag_and_does_not_fall_back_to_w() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    bridge::wait_for_seq(&f.r_api, t, 1, Duration::from_secs(10))
        .await
        .unwrap();
    let start = Instant::now();
    let err = bridge::wait_for_seq(&f.r_api, t, 1_000_000, Duration::from_millis(300))
        .await
        .unwrap_err();
    assert!(start.elapsed() >= Duration::from_millis(300));
    assert!(start.elapsed() < Duration::from_secs(3));
    match err {
        StoreError::ReplicaLag { wanted, observed } => {
            assert_eq!(wanted, 1_000_000);
            assert!(observed.is_some_and(|s| s >= 1));
        }
        other => panic!("expected ReplicaLag, got {other}"),
    }
}

#[tokio::test]
async fn rls_isolates_tenants_on_r_and_w_and_fails_closed() {
    let fixture = fx().await;
    let f = &fixture;
    let (a, b) = (new_tenant(f).await, new_tenant(f).await);
    let sa = append(f, a, 1).await;
    let sb = append(f, b, 1).await;
    bridge::wait_for_seq(&f.r_api, a, sa, Duration::from_secs(10))
        .await
        .unwrap();
    bridge::wait_for_seq(&f.r_api, b, sb, Duration::from_secs(10))
        .await
        .unwrap();

    // R: tenant A sees only A's events, never B's
    let mut tx = f.r_api.begin_tenant(a).await.unwrap();
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT DISTINCT tenant_id FROM ledger.audit_event")
        .fetch_all(tx.conn())
        .await
        .unwrap();
    tx.finish().await.unwrap();
    assert_eq!(rows, vec![(a,)]);

    // W: tenant A's transaction cannot write a row for tenant B (policy applies to INSERT)
    let mut tx = f.w_cmd.begin_tenant(a).await.unwrap();
    let r = sqlx::query(
        "INSERT INTO ingest.source_batch(tenant_id, source_type, object_uri, sha256, status)
         VALUES ($1,'erp_ledger','s3://x', sha256('x'), 'registered')",
    )
    .bind(b)
    .execute(tx.conn())
    .await;
    assert!(r.is_err(), "cross-tenant insert must be rejected by RLS");
    drop(tx);

    // R: a session that never bound a tenant fails closed
    let opts = PgConnectOptions::from_str(&f.r_url)
        .unwrap()
        .username("t_r_api");
    let mut raw = opts.connect().await.unwrap();
    let e = sqlx::query("SELECT count(*) FROM ledger.audit_event")
        .fetch_one(&mut raw)
        .await
        .unwrap_err();
    assert!(
        e.to_string().contains("app.tenant_id"),
        "unexpected error: {e}"
    );
}

#[tokio::test]
async fn read_transactions_are_read_only_even_for_a_privileged_role() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    // superuser connection through ReadStore: privileges would allow the write, READ ONLY must still refuse
    let admin_store = ReadStore::connect(&f.r_url, 2).await.unwrap();
    let mut tx = admin_store.begin_tenant(t).await.unwrap();
    let e = sqlx::query(
        "INSERT INTO proj.checkpoint(projector, tenant_id, last_seq) VALUES ('x', $1, 0)",
    )
    .bind(t)
    .execute(tx.conn())
    .await
    .unwrap_err();
    assert!(
        e.to_string().contains("read-only transaction"),
        "unexpected error: {e}"
    );
}

#[tokio::test]
async fn application_roles_cannot_fork_or_mutate_the_ledger_and_own_nothing() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;

    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let e = sqlx::query(
        "INSERT INTO ledger.audit_event(tenant_id,seq,event_type,actor_type,actor_ref,payload,payload_sha256,prev_hash,hash)
         VALUES ($1, 99, 'x','system','x','{}', sha256('a'), sha256('b'), sha256('c'))",
    )
    .bind(t)
    .execute(tx.conn())
    .await
    .unwrap_err();
    assert!(e.to_string().contains("permission denied"), "{e}");
    drop(tx);

    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let e = sqlx::query("UPDATE ledger.chain_head SET last_seq = 0")
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("permission denied"), "{e}");
    drop(tx);

    // even a superuser cannot rewrite history (trigger)
    let e = sqlx::query("UPDATE ledger.audit_event SET actor_ref='evil' WHERE tenant_id=$1")
        .bind(t)
        .execute(&f.admin_w)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("append-only"), "{e}");
    let e = sqlx::query("TRUNCATE ledger.audit_event CASCADE")
        .execute(&f.admin_w)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("append-only"), "{e}");

    // R-DB-12: application group roles own no objects on either cluster
    for (pool, roles) in [
        (
            &f.admin_w,
            vec![
                "w_admin",
                "w_cmd",
                "w_worker",
                "w_anchor",
                "w_verifier",
                "w_retention",
                "t_w_cmd",
                "t_w_admin",
                "t_w_retention",
            ],
        ),
        (
            &f.admin_r,
            vec!["r_api", "r_projector", "r_verifier", "t_r_api"],
        ),
    ] {
        let (owned,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = ANY($1)",
        )
        .bind(roles.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(owned, 0, "application roles must not own relations");
    }
}

#[tokio::test]
async fn concurrent_appends_for_one_tenant_serialise_into_a_valid_chain() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    let tasks: Vec<_> = (0..20)
        .map(|n| {
            let store = f.w_cmd.clone();
            tokio::spawn(async move {
                let mut tx = store.begin_tenant(t).await.unwrap();
                let a = tx
                    .append_event(
                        "test.concurrent",
                        Actor::System("pair-test"),
                        &serde_json::json!({"n": n}),
                    )
                    .await
                    .unwrap();
                tx.commit().await.unwrap();
                a.seq
            })
        })
        .collect();
    let mut seqs = Vec::new();
    for h in tasks {
        seqs.push(h.await.unwrap());
    }
    seqs.sort_unstable();
    assert_eq!(
        seqs,
        (2..=21).collect::<Vec<i64>>(),
        "gap-free, unique sequence under concurrency"
    );
    bridge::wait_for_seq(&f.r_api, t, 21, Duration::from_secs(10))
        .await
        .unwrap();
    for pool in [&f.admin_w, &f.admin_r] {
        let (events, _) = export(pool, t).await;
        assert_eq!(events.len(), 21);
        verify_chain(&events).unwrap();
    }
}
