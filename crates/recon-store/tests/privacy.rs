//! L6 — erasure and retention behaviour (Rules R-PRIV-3, R-PRIV-5; Workflow.md §4.2) against a REAL W + R pair.
//! Prerequisites and fixture: see `tests/common/mod.rs`. Missing prerequisites fail loudly; they never skip.
//!
//! The data-subject scenario uses a real AES-256-GCM envelope (a KEK wraps a per-subject DEK, the DEK encrypts the
//! identifier) so "unrecoverable after shredding" is demonstrated, not assumed. Retention jurisdictions are test-only
//! codes (`X1`…`X5`, `ZZ`, `NOPOL`); each test owns its own so tests can run in parallel.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use aes_gcm::aead::{Aead, Generate, Key, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use common::{Fx, append, export, fx, hex, new_tenant};
use recon_evidence::{payload_sha256, verify_chain};
use recon_store::privacy::{ErasureOutcome, PurgeOutcome, PurgeReport};
use recon_store::{Actor, StoreError, bridge};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

// ------------------------------------------------------------------ envelope crypto (test-local KMS stand-in)

fn seal(key: &Key<Aes256Gcm>, plaintext: &[u8]) -> Vec<u8> {
    let nonce = Nonce::generate();
    let mut out = nonce.to_vec();
    out.extend(Aes256Gcm::new(key).encrypt(&nonce, plaintext).unwrap());
    out
}

fn open(key: &Key<Aes256Gcm>, blob: &[u8]) -> Option<Vec<u8>> {
    let (n, ct) = blob.split_at_checked(12)?;
    let nonce = Nonce::try_from(n).ok()?;
    Aes256Gcm::new(key).decrypt(&nonce, ct).ok()
}

// ------------------------------------------------------------------ fixtures

/// Make every earlier W commit of `t` visible on R: append a marker event and wait for its sequence on R
/// (replication applies commits in order, Architecture.md §5.2).
async fn barrier(f: &Fx, t: Uuid) {
    let seq = append(f, t, 0).await;
    bridge::wait_for_seq(&f.r_api, t, seq, Duration::from_secs(10))
        .await
        .unwrap();
}

async fn insert_policy(f: &Fx, jurisdiction: &str, months: i32) {
    sqlx::query(
        "INSERT INTO privacy.retention_policy(jurisdiction, data_class, retention_months, source_ref, accessed_on, valid_from)
         VALUES ($1, 'tax_record', $2, 'test:l6', '2026-10-23', '2000-01-01')
         ON CONFLICT (jurisdiction, data_class, valid_from) DO UPDATE SET retention_months = EXCLUDED.retention_months, valid_to = NULL",
    )
    .bind(jurisdiction)
    .bind(months)
    .execute(&f.admin_w)
    .await
    .unwrap();
}

async fn insert_key(f: &Fx, t: Uuid, wrapped: &[u8]) -> Uuid {
    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let (id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO privacy.subject_key(tenant_id, wrapped_dek, kek_ref, state)
         VALUES ($1, $2, 'test-kek', 'active') RETURNING id",
    )
    .bind(t)
    .bind(wrapped)
    .fetch_one(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// A legal entity whose identifier ciphertext is bound to `key`, created `age_days` ago.
async fn insert_entity(f: &Fx, t: Uuid, country: &str, key: Uuid, ct: &[u8], age_days: i32) {
    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    sqlx::query(
        "INSERT INTO core.legal_entity(tenant_id, country, vat_id_ct, vat_id_key_id, vat_id_hmac, created_at)
         VALUES ($1, $2, $3, $4, sha256($3), now() - make_interval(days => $5))",
    )
    .bind(t)
    .bind(country)
    .bind(ct)
    .bind(key)
    .bind(age_days)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

/// A source batch whose period ended `age_days` ago (inserted as superuser: ingest commands are not built yet).
async fn insert_batch(f: &Fx, t: Uuid, age_days: i32) -> Uuid {
    let (id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO ingest.source_batch(tenant_id, source_type, period_start, period_end, object_uri, sha256, status)
         VALUES ($1, 'erp_ledger', (now() AT TIME ZONE 'UTC')::date - $2 - 30, (now() AT TIME ZONE 'UTC')::date - $2,
                 's3://test/batch', sha256(uuid_send(uuidv7())), 'parsed') RETURNING id",
    )
    .bind(t)
    .bind(age_days)
    .fetch_one(&f.admin_w)
    .await
    .unwrap();
    id
}

async fn insert_record(f: &Fx, t: Uuid, batch: Uuid) {
    sqlx::query(
        "INSERT INTO ingest.source_record(tenant_id, batch_id, record_kind, canonical, record_sha256)
         VALUES ($1, $2, 'invoice', '{}'::jsonb, sha256(uuid_send(uuidv7())))",
    )
    .bind(t)
    .bind(batch)
    .execute(&f.admin_w)
    .await
    .unwrap();
}

async fn place_hold(f: &Fx, t: Uuid, scope: Value) -> Uuid {
    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let id = tx
        .place_legal_hold(&scope, "test hold", "counsel-1", Actor::User("counsel-1"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    id
}

async fn release_hold(f: &Fx, t: Uuid, hold: Uuid) -> bool {
    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let released = tx
        .release_legal_hold(hold, Actor::User("counsel-1"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    released
}

async fn erase(f: &Fx, t: Uuid, key: Uuid) -> ErasureOutcome {
    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let outcome = tx
        .process_erasure_request(key, Actor::User("dpo-1"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    outcome
}

async fn purge(f: &Fx, t: Uuid, jurisdiction: &str) -> PurgeReport {
    let mut tx = f.w_retention.begin_tenant(t).await.unwrap();
    let report = tx
        .purge_expired_batches(jurisdiction, Actor::System("retention-worker"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    report
}

/// `(actor_type, actor_ref, payload)` of the tenant's events of one type, oldest first (superuser view of W).
async fn events_of(f: &Fx, t: Uuid, event_type: &str) -> Vec<(String, String, Value)> {
    sqlx::query_as(
        "SELECT actor_type, actor_ref, payload FROM ledger.audit_event
          WHERE tenant_id = $1 AND event_type = $2 ORDER BY seq",
    )
    .bind(t)
    .bind(event_type)
    .fetch_all(&f.admin_w)
    .await
    .unwrap()
}

async fn count(pool: &sqlx::PgPool, sql: &'static str, t: Uuid) -> i64 {
    let (n,): (i64,) = sqlx::query_as(sql).bind(t).fetch_one(pool).await.unwrap();
    n
}

async fn key_state(pool: &sqlx::PgPool, key: Uuid) -> (String, Option<Vec<u8>>, bool) {
    sqlx::query_as(
        "SELECT state, wrapped_dek, shredded_at IS NOT NULL FROM privacy.subject_key WHERE id = $1",
    )
    .bind(key)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn err_text(e: StoreError) -> String {
    e.to_string()
}

// ------------------------------------------------------------------ tests

#[tokio::test]
async fn crypto_shred_makes_plaintext_unrecoverable_on_w_and_r() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    insert_policy(f, "X1", 12).await;

    let kek = Key::<Aes256Gcm>::generate();
    let dek = Key::<Aes256Gcm>::generate();
    let plaintext = format!("RO{}", Uuid::now_v7().simple());
    let key_id = insert_key(f, t, &seal(&kek, dek.as_slice())).await;
    insert_entity(f, t, "X1", key_id, &seal(&dek, plaintext.as_bytes()), 800).await;
    barrier(f, t).await;

    // BEFORE: everything R holds is enough to recover the identifier (proves the fixture is a real envelope).
    let (state, wrapped, _) = key_state(&f.admin_r, key_id).await;
    assert_eq!(state, "active");
    let dek_on_r = Key::<Aes256Gcm>::try_from(
        open(&kek, &wrapped.expect("wrapped DEK replicated to R"))
            .unwrap()
            .as_slice(),
    )
    .unwrap();
    let (ct_on_r,): (Vec<u8>,) =
        sqlx::query_as("SELECT vat_id_ct FROM core.legal_entity WHERE vat_id_key_id = $1")
            .bind(key_id)
            .fetch_one(&f.admin_r)
            .await
            .unwrap();
    assert_eq!(open(&dek_on_r, &ct_on_r).unwrap(), plaintext.as_bytes());

    // application roles cannot shred by hand: no UPDATE on key material, only the ledgered function
    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let e = sqlx::query(
        "UPDATE privacy.subject_key SET state = 'shredded', wrapped_dek = NULL WHERE id = $1",
    )
    .bind(key_id)
    .execute(tx.conn())
    .await
    .unwrap_err();
    assert!(e.to_string().contains("permission denied"), "{e}");
    drop(tx);

    // SHRED
    assert_eq!(erase(f, t, key_id).await, ErasureOutcome::Shredded);
    barrier(f, t).await;

    // AFTER, on W and on R: no wrapped DEK, state shredded; neither the DEK nor the plaintext appear anywhere the
    // tenant's data lives; the ciphertext is still stored (the record is kept) but nothing can open it.
    for (name, pool) in [("W", &f.admin_w), ("R", &f.admin_r)] {
        let (state, wrapped, shredded_at) = key_state(pool, key_id).await;
        assert_eq!(state, "shredded", "{name}");
        assert!(wrapped.is_none(), "{name}: wrapped DEK must be gone");
        assert!(shredded_at, "{name}");

        let (hits,): (i64,) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM core.legal_entity e
                      WHERE e.tenant_id = $1 AND (position($2::bytea IN e.vat_id_ct) > 0 OR position($4::bytea IN e.vat_id_ct) > 0))
                  + (SELECT count(*) FROM ledger.audit_event a WHERE a.tenant_id = $1 AND a.payload::text LIKE '%' || $3 || '%')
                  + (SELECT count(*) FROM privacy.subject_key k
                      WHERE k.tenant_id = $1 AND position($4::bytea IN coalesce(k.wrapped_dek, ''::bytea)) > 0)",
        )
        .bind(t)
        .bind(plaintext.as_bytes())
        .bind(&plaintext)
        .bind(dek.as_slice())
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(hits, 0, "{name}: plaintext or DEK still present");

        let (ct_rows,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM core.legal_entity WHERE vat_id_key_id = $1 AND vat_id_ct IS NOT NULL",
        )
        .bind(key_id)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(
            ct_rows, 1,
            "{name}: record must be retained, only unreadable"
        );
    }
    // a wrong key does not open the retained ciphertext (AES-GCM authentication)
    let (ct,): (Vec<u8>,) =
        sqlx::query_as("SELECT vat_id_ct FROM core.legal_entity WHERE vat_id_key_id = $1")
            .bind(key_id)
            .fetch_one(&f.admin_r)
            .await
            .unwrap();
    assert!(open(&Key::<Aes256Gcm>::generate(), &ct).is_none());

    let shredded = events_of(f, t, "privacy.erasure.shredded").await;
    assert_eq!(shredded.len(), 1);
    assert_eq!(shredded[0].0, "user");
    assert_eq!(shredded[0].1, "dpo-1");
    assert_eq!(shredded[0].2, json!({"key_id": key_id.to_string()}));
}

#[tokio::test]
async fn legal_hold_blocks_purge() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    insert_policy(f, "X2", 12).await;
    let (a, b, recent) = (
        insert_batch(f, t, 800).await,
        insert_batch(f, t, 800).await,
        insert_batch(f, t, 0).await,
    );
    for id in [a, b, recent] {
        insert_record(f, t, id).await;
        insert_record(f, t, id).await;
    }

    // only `w_retention` may purge, and only through the function
    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let e = tx
        .purge_expired_batches("X2", Actor::System("rogue"))
        .await
        .map(|_| ())
        .unwrap_err();
    assert!(err_text(e).contains("permission denied"));
    drop(tx);
    let mut tx = f.w_retention.begin_tenant(t).await.unwrap();
    let e = sqlx::query("DELETE FROM ingest.source_batch WHERE tenant_id = $1")
        .bind(t)
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("permission denied"), "{e}");
    drop(tx);
    // the function refuses a tenant other than the one the transaction is bound to (it bypasses RLS as its owner)
    let other = new_tenant(f).await;
    let mut tx = f.w_retention.begin_tenant(other).await.unwrap();
    let e = sqlx::query("SELECT * FROM privacy.purge_expired_batches($1, 'X2', 'system', 'x')")
        .bind(t)
        .fetch_all(tx.conn())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("not bound"), "{e}");
    drop(tx);
    assert_eq!(
        count(
            &f.admin_w,
            "SELECT count(*) FROM ingest.source_batch WHERE tenant_id = $1",
            t
        )
        .await,
        3
    );

    // an `all` hold blocks everything
    let hold = place_hold(f, t, json!({"all": true})).await;
    let report = purge(f, t, "X2").await;
    assert_eq!(
        report,
        PurgeReport {
            outcome: PurgeOutcome::Held,
            batches_purged: 0,
            records_purged: 0,
            batches_held: 2
        }
    );
    assert_eq!(
        count(
            &f.admin_w,
            "SELECT count(*) FROM ingest.source_batch WHERE tenant_id = $1",
            t
        )
        .await,
        3
    );
    assert!(release_hold(f, t, hold).await);
    assert!(!release_hold(f, t, hold).await, "second release is a no-op");

    // released: expired batches go (W and R), the batch inside its retention period stays
    let report = purge(f, t, "X2").await;
    assert_eq!(
        report,
        PurgeReport {
            outcome: PurgeOutcome::Purged,
            batches_purged: 2,
            records_purged: 4,
            batches_held: 0
        }
    );
    barrier(f, t).await;
    for (name, pool) in [("W", &f.admin_w), ("R", &f.admin_r)] {
        assert_eq!(
            count(
                pool,
                "SELECT count(*) FROM ingest.source_batch WHERE tenant_id = $1",
                t
            )
            .await,
            1,
            "{name}"
        );
        assert_eq!(
            count(
                pool,
                "SELECT count(*) FROM ingest.source_record WHERE tenant_id = $1",
                t
            )
            .await,
            2,
            "{name}"
        );
    }

    // a hold scoped to one batch protects only that batch
    let (c, d) = (insert_batch(f, t, 900).await, insert_batch(f, t, 900).await);
    let hold = place_hold(f, t, json!({"batch_ids": [c.to_string()]})).await;
    let report = purge(f, t, "X2").await;
    assert_eq!(
        report,
        PurgeReport {
            outcome: PurgeOutcome::Purged,
            batches_purged: 1,
            records_purged: 0,
            batches_held: 1
        }
    );
    barrier(f, t).await;
    for (name, pool) in [("W", &f.admin_w), ("R", &f.admin_r)] {
        let ids: Vec<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM ingest.source_batch WHERE tenant_id = $1 AND id = ANY($2)",
        )
        .bind(t)
        .bind(vec![c, d])
        .fetch_all(pool)
        .await
        .unwrap();
        assert_eq!(ids, vec![(c,)], "{name}: only the held batch survives");
    }
    assert!(release_hold(f, t, hold).await);
    assert_eq!(purge(f, t, "X2").await.batches_purged, 1);
}

#[tokio::test]
async fn purge_appends_ledger_event() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;

    // no policy: refused, nothing deleted, refusal ledgered
    let batch = insert_batch(f, t, 5000).await;
    let report = purge(f, t, "NOPOL").await;
    assert_eq!(report.outcome, PurgeOutcome::RefusedNoRetentionPolicy);
    assert_eq!(
        count(
            &f.admin_w,
            "SELECT count(*) FROM ingest.source_batch WHERE tenant_id = $1",
            t
        )
        .await,
        1
    );
    let refused = events_of(f, t, "privacy.purge.refused").await;
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].0, "system");
    assert_eq!(refused[0].1, "retention-worker");
    assert_eq!(
        refused[0].2,
        json!({"jurisdiction": "NOPOL", "reason": "no_retention_policy"})
    );

    // with a policy: purge executes and the event states exactly what happened (and nothing personal)
    insert_policy(f, "X3", 12).await;
    insert_record(f, t, batch).await;
    let second = insert_batch(f, t, 5000).await;
    insert_record(f, t, second).await;
    insert_record(f, t, second).await;
    let report = purge(f, t, "X3").await;
    assert_eq!(
        report,
        PurgeReport {
            outcome: PurgeOutcome::Purged,
            batches_purged: 2,
            records_purged: 3,
            batches_held: 0
        }
    );
    let executed = events_of(f, t, "privacy.purge.executed").await;
    assert_eq!(executed.len(), 1);
    let payload = executed[0].2.as_object().unwrap();
    let mut keys: Vec<&str> = payload.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "batches_held",
            "batches_purged",
            "cutoff",
            "data_class",
            "jurisdiction",
            "policy_id",
            "records_purged"
        ]
    );
    assert_eq!(payload["jurisdiction"], "X3");
    assert_eq!(payload["data_class"], "tax_record");
    assert_eq!(payload["batches_purged"], 2);
    assert_eq!(payload["records_purged"], 3);
    assert_eq!(payload["batches_held"], 0);
    let (policy_id,): (Uuid,) = sqlx::query_as(
        "SELECT id FROM privacy.retention_policy WHERE jurisdiction = 'X3' AND data_class = 'tax_record' AND valid_from = '2000-01-01'",
    )
    .fetch_one(&f.admin_w)
    .await
    .unwrap();
    assert_eq!(payload["policy_id"], policy_id.to_string());
    assert!(payload["cutoff"].as_str().unwrap().len() == 10);

    // nothing left to purge: no event noise
    assert_eq!(
        purge(f, t, "X3").await.outcome,
        PurgeOutcome::NothingExpired
    );
    assert_eq!(events_of(f, t, "privacy.purge.executed").await.len(), 1);

    barrier(f, t).await;
    assert_eq!(
        count(
            &f.admin_r,
            "SELECT count(*) FROM ingest.source_batch WHERE tenant_id = $1",
            t
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &f.admin_r,
            "SELECT count(*) FROM ingest.source_record WHERE tenant_id = $1",
            t
        )
        .await,
        0
    );
}

#[tokio::test]
async fn erasure_deferral_is_ledgered() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    insert_policy(f, "X4", 12).await;
    let dek = Key::<Aes256Gcm>::generate();
    let ct = seal(&dek, b"identifier");

    // key1: data created yesterday under a 12-month policy; key2: data in a jurisdiction with no policy row
    let key1 = insert_key(f, t, b"wrapped-1").await;
    insert_entity(f, t, "X4", key1, &ct, 1).await;
    let key2 = insert_key(f, t, b"wrapped-2").await;
    insert_entity(f, t, "ZZ", key2, &ct, 5000).await;

    // an active hold on the key wins over everything else
    let hold = place_hold(f, t, json!({"subject_key_ids": [key1.to_string()]})).await;
    assert_eq!(erase(f, t, key1).await, ErasureOutcome::DeferredLegalHold);
    let deferred = events_of(f, t, "privacy.erasure.deferred").await;
    assert_eq!(
        deferred.last().unwrap().2,
        json!({"key_id": key1.to_string(), "reason": "legal_hold", "hold_ids": [hold.to_string()]})
    );
    // a hold on key1 does not cover key2; an `all` hold covers both and still wins over the missing policy
    let all = place_hold(f, t, json!({"all": true})).await;
    assert_eq!(erase(f, t, key2).await, ErasureOutcome::DeferredLegalHold);
    assert!(release_hold(f, t, all).await);

    // hold released: the running retention period defers key1 (Art. 17(3)(b)-type retention obligation)
    assert!(release_hold(f, t, hold).await);
    assert_eq!(erase(f, t, key1).await, ErasureOutcome::DeferredRetention);
    let (in_window,): (bool,) = sqlx::query_as(
        "SELECT (payload ->> 'retain_until')::timestamptz BETWEEN now() + interval '11 months' AND now() + interval '13 months'
           FROM ledger.audit_event
          WHERE tenant_id = $1 AND event_type = 'privacy.erasure.deferred' AND payload ->> 'reason' = 'retention'",
    )
    .bind(t)
    .fetch_one(&f.admin_w)
    .await
    .unwrap();
    assert!(in_window, "retain_until must be created_at + 12 months");

    // unknown retention is never treated as expired
    assert_eq!(
        erase(f, t, key2).await,
        ErasureOutcome::DeferredNoRetentionPolicy
    );
    let deferred = events_of(f, t, "privacy.erasure.deferred").await;
    assert_eq!(
        deferred.last().unwrap().2,
        json!({"key_id": key2.to_string(), "reason": "no_retention_policy", "jurisdictions": ["ZZ"]})
    );
    assert_eq!(
        deferred.len(),
        4,
        "legal_hold, legal_hold, retention, no_retention_policy"
    );
    assert!(
        deferred
            .iter()
            .all(|(ty, who, _)| ty == "user" && who == "dpo-1")
    );

    // deferral kept the key material on W and R
    barrier(f, t).await;
    for (name, pool) in [("W", &f.admin_w), ("R", &f.admin_r)] {
        for key in [key1, key2] {
            let (state, wrapped, _) = key_state(pool, key).await;
            assert_eq!(state, "active", "{name}");
            assert!(wrapped.is_some(), "{name}");
        }
    }

    // not found / already shredded: reported, not ledgered
    let before = events_of(f, t, "privacy.erasure.deferred").await.len();
    assert_eq!(erase(f, t, Uuid::now_v7()).await, ErasureOutcome::NotFound);
    let key3 = insert_key(f, t, b"wrapped-3").await;
    insert_entity(f, t, "X4", key3, &ct, 800).await;
    assert_eq!(erase(f, t, key3).await, ErasureOutcome::Shredded);
    assert_eq!(erase(f, t, key3).await, ErasureOutcome::AlreadyShredded);
    assert_eq!(events_of(f, t, "privacy.erasure.shredded").await.len(), 1);
    assert_eq!(
        events_of(f, t, "privacy.erasure.deferred").await.len(),
        before
    );

    // another tenant's key is invisible to this tenant
    let other = new_tenant(f).await;
    let foreign = insert_key(f, other, b"wrapped-x").await;
    assert_eq!(erase(f, t, foreign).await, ErasureOutcome::NotFound);
}

#[tokio::test]
async fn shred_keeps_chain_verifiable_on_w_and_r() {
    let fixture = fx().await;
    let f = &fixture;
    let t = new_tenant(f).await;
    insert_policy(f, "X5", 12).await;
    let ct = seal(&Key::<Aes256Gcm>::generate(), b"identifier");

    // exercise every event type the privacy functions write, with every payload shape they use
    let hold = place_hold(
        f,
        t,
        json!({"all": true, "batch_ids": [Uuid::now_v7().to_string()], "subject_key_ids": [Uuid::now_v7().to_string()]}),
    )
    .await;
    assert!(release_hold(f, t, hold).await);
    let recent = insert_key(f, t, b"wrapped-a").await;
    insert_entity(f, t, "X5", recent, &ct, 1).await;
    assert_eq!(erase(f, t, recent).await, ErasureOutcome::DeferredRetention);
    let old = insert_key(f, t, b"wrapped-b").await;
    insert_entity(f, t, "X5", old, &ct, 900).await;
    assert_eq!(erase(f, t, old).await, ErasureOutcome::Shredded);
    assert_eq!(
        purge(f, t, "NOPOL").await.outcome,
        PurgeOutcome::RefusedNoRetentionPolicy
    );
    let batch = insert_batch(f, t, 900).await;
    insert_record(f, t, batch).await;
    assert_eq!(purge(f, t, "X5").await.outcome, PurgeOutcome::Purged);
    barrier(f, t).await;

    for (name, pool) in [("W", &f.admin_w), ("R", &f.admin_r)] {
        let (events, payloads) = export(pool, t).await;
        let head = verify_chain(&events).unwrap_or_else(|e| panic!("chain invalid on {name}: {e}"));
        assert_eq!(hex(head), events.last().unwrap().hash, "{name}");
        // SQL computed these payload hashes; the Rust JCS implementation must agree on the stored jsonb
        for (e, p) in events.iter().zip(&payloads) {
            assert_eq!(
                hex(payload_sha256(p).unwrap()),
                e.payload_sha256,
                "{name} seq {} ({})",
                e.seq,
                e.event_type
            );
        }
        let mut types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
        types.sort_unstable();
        types.dedup();
        for wanted in [
            "privacy.legal_hold.placed",
            "privacy.legal_hold.released",
            "privacy.erasure.deferred",
            "privacy.erasure.shredded",
            "privacy.purge.refused",
            "privacy.purge.executed",
        ] {
            assert!(types.contains(&wanted), "{name}: missing {wanted}");
        }
    }
}

#[tokio::test]
async fn sql_jcs_matches_rust_jcs_for_supported_shapes() {
    let fixture = fx().await;
    let f = &fixture;
    let supported = [
        json!({}),
        json!([]),
        json!(null),
        json!({"b": 1, "a": {"z": [3, 2, 1], "A": true}, "_": null, "Z1": false, "a1": "x"}),
        json!({"s": "quote \" backslash \\ slash / newline \n tab \t cr \r bs \u{8} ff \u{c} nul-ish \u{1} us \u{1f} del \u{7f}"}),
        json!({"u": "é € 😀 \u{2028}", "k": [0, -5, 999_999_999_999_999_i64, -999_999_999_999_999_i64]}),
        json!({"nested": {"deep": {"er": [{"b": 2, "a": 1}, [], {}]}}}),
    ];
    for v in supported {
        let (sql_hash,): (String,) = sqlx::query_as(
            "SELECT encode(sha256(convert_to(ledger.jcs_text($1::jsonb), 'UTF8')), 'hex')",
        )
        .bind(&v)
        .fetch_one(&f.admin_w)
        .await
        .unwrap();
        assert_eq!(sql_hash, hex(payload_sha256(&v).unwrap()), "payload {v}");
    }
    // unsupported shapes fail closed instead of producing a hash that could disagree with RFC 8785
    for bad in [
        json!({"f": 1.5}),
        json!({"big": 1_234_567_890_123_456_i64}),
        json!({"é": 1}),
    ] {
        let e = sqlx::query("SELECT ledger.jcs_text($1::jsonb)")
            .bind(&bad)
            .fetch_one(&f.admin_w)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("jcs:"), "{bad}: {e}");
    }
}
