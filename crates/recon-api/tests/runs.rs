//! HTTP + engine integration against a REAL W + R pair (Rules R-GEN-2: no mocks). Prerequisites: W and R migrated,
//! subscription created, `RECON_TEST_W_URL` / `RECON_TEST_R_URL` set to superuser URLs (setup only). Missing
//! prerequisites fail loudly. The stores under test connect as non-superuser login roles so RLS applies.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use http_body_util::BodyExt;
use recon_api::admin::{create_tenant, issue_api_key};
use recon_api::{AppState, app};
use recon_engine::{Engine, Step};
use recon_store::{Actor, ReadStore, WriteStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;
use std::time::{Duration, Instant};
use tower::ServiceExt;
use uuid::Uuid;

struct Fx {
    admin_w: PgPool,
    w_admin: WriteStore,
    w_cmd: WriteStore,
    engine: Engine,
    app: Router,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set (see the module docs)"))
}

async fn fx() -> Fx {
    let (w_url, r_url) = (env("RECON_TEST_W_URL"), env("RECON_TEST_R_URL"));
    let admin_w = PgPoolOptions::new().max_connections(4).connect(&w_url).await.unwrap();
    let admin_r = PgPoolOptions::new().max_connections(2).connect(&r_url).await.unwrap();
    for (pool, roles) in [
        (
            &admin_w,
            [("t_w_admin", "w_admin"), ("t_w_cmd", "w_cmd"), ("t_w_worker", "w_worker")].as_slice(),
        ),
        (&admin_r, [("t_r_api", "r_api")].as_slice()),
    ] {
        let mut c = pool.acquire().await.unwrap();
        sqlx::query("SELECT pg_advisory_lock(424242)").execute(&mut *c).await.unwrap();
        for (login, group) in roles {
            let sql = format!(
                "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{login}') \
                 THEN CREATE ROLE {login} LOGIN IN ROLE {group}; END IF; END $$;"
            );
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(&mut *c).await.unwrap();
        }
        sqlx::query("SELECT pg_advisory_unlock(424242)").execute(&mut *c).await.unwrap();
    }
    let as_user = |url: &str, user: &str| PgConnectOptions::from_str(url).unwrap().username(user);
    let w_admin = WriteStore::connect_with(as_user(&w_url, "t_w_admin"), 2).await.unwrap();
    let w_cmd = WriteStore::connect_with(as_user(&w_url, "t_w_cmd"), 8).await.unwrap();
    let w_worker = WriteStore::connect_with(as_user(&w_url, "t_w_worker"), 2).await.unwrap();
    let r_api = ReadStore::connect_with(as_user(&r_url, "t_r_api"), 8).await.unwrap();
    let r_engine = ReadStore::connect_with(as_user(&r_url, "t_r_api"), 2).await.unwrap();
    let engine = Engine::new(w_worker, r_engine, Duration::from_secs(10));
    let state = AppState::new(w_cmd.clone(), r_api, Duration::from_secs(10)).unwrap();
    Fx { admin_w, w_admin, w_cmd, engine, app: app(state) }
}

async fn tenant_with_key(f: &Fx, scopes: &[&str]) -> (Uuid, String) {
    let t = create_tenant(&f.w_admin, &format!("it-{}", Uuid::now_v7())).await.unwrap();
    let scopes: Vec<String> = scopes.iter().map(|s| (*s).to_string()).collect();
    let key = issue_api_key(&f.w_cmd, t, &scopes).await.unwrap();
    (t, key.token)
}

const ALL: [&str; 5] = ["batches:write", "batches:read", "findings:read", "runs:write", "runs:read"];
const CODES: [&str; 4] = [
    "C1-NO-CLEARANCE-RECORD",
    "C1-NOT-ACCEPTED",
    "C1-AMOUNT-MISMATCH",
    "C1-ORPHAN-CLEARANCE",
];

/// A pack with the given rule codes; unique name so tests never collide.
async fn pack(f: &Fx, codes: &[&str]) -> (Uuid, Vec<(String, Uuid)>) {
    let (id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO rules.rule_pack(name, jurisdiction, version, content_sha256, valid_from, last_reviewed, reviewed_by)
         VALUES ($1,'XX','0.0.0',sha256($1::bytea),DATE '2000-01-01',DATE '2026-10-25','SYNTHETIC TEST FIXTURE') RETURNING id",
    )
    .bind(format!("it-{}", Uuid::now_v7()))
    .fetch_one(&f.admin_w)
    .await
    .unwrap();
    let mut rules = Vec::new();
    for c in codes {
        let (rid,): (Uuid,) = sqlx::query_as(
            "INSERT INTO rules.rule(pack_id, code, source_ref, article, accessed_on)
             VALUES ($1,$2,'urn:recon:synthetic-fixture','none',DATE '2026-10-25') RETURNING id",
        )
        .bind(id)
        .bind(c)
        .fetch_one(&f.admin_w)
        .await
        .unwrap();
        rules.push(((*c).to_string(), rid));
    }
    (id, rules)
}

async fn batch(f: &Fx, tenant: Uuid, status: &str, kind: &str, records: &[Value]) -> Uuid {
    let mut tx = f.w_cmd.begin_tenant(tenant).await.unwrap();
    let nonce = Uuid::now_v7();
    let (b,): (Uuid,) = sqlx::query_as(
        "INSERT INTO ingest.source_batch(tenant_id, source_type, object_uri, sha256, status)
         VALUES ($1,'it',$2,$3,$4) RETURNING id",
    )
    .bind(tenant)
    .bind(format!("https://synthetic.invalid/{nonce}"))
    .bind(Sha256::digest(nonce.as_bytes()).to_vec())
    .bind(status)
    .fetch_one(tx.conn())
    .await
    .unwrap();
    for r in records {
        sqlx::query(
            "INSERT INTO ingest.source_record(tenant_id, batch_id, record_kind, canonical, record_sha256)
             VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(tenant)
        .bind(b)
        .bind(kind)
        .bind(r)
        .bind(Sha256::digest(serde_json::to_vec(r).unwrap()).to_vec())
        .execute(tx.conn())
        .await
        .unwrap();
    }
    tx.append_event("batch.parsed", Actor::System("it"), &json!({"batch_id": b}))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    b
}

fn inv(r: &str, total: i64) -> Value {
    json!({"invoice_ref": r, "currency": "PLN", "total_minor": total})
}
fn clr(r: &str, status: &str, total: i64) -> Value {
    json!({"invoice_ref": r, "status": status, "currency": "PLN", "total_minor": total})
}

/// Two parsed batches producing one finding of each outcome plus one agreeing pair.
async fn standard_batches(f: &Fx, t: Uuid) -> Vec<Uuid> {
    vec![
        batch(f, t, "parsed", "invoice", &[inv("A", 1), inv("B", 2), inv("C", 3), inv("D", 4)]).await,
        batch(
            f,
            t,
            "parsed",
            "clearance_status",
            &[clr("A", "accepted", 1), clr("C", "rejected", 3), clr("D", "accepted", 5), clr("Z", "accepted", 9)],
        )
        .await,
    ]
}

async fn call(
    f: &Fx,
    method: &str,
    uri: &str,
    token: &str,
    idem: Option<&str>,
    min_seq: Option<i64>,
    body: Option<Value>,
) -> (StatusCode, HeaderMap, Value) {
    let mut req = Request::builder().method(method).uri(uri).header("authorization", format!("Bearer {token}"));
    if let Some(k) = idem {
        req = req.header("idempotency-key", k);
    }
    if let Some(s) = min_seq {
        req = req.header("x-min-seq", s.to_string());
    }
    let body = body.map_or_else(Body::empty, |b| Body::from(b.to_string()));
    let res = f.app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (parts.status, parts.headers, json)
}

fn seq(h: &HeaderMap) -> i64 {
    h["x-commit-seq"].to_str().unwrap().parse().unwrap()
}

async fn queue(f: &Fx, token: &str, pack: Uuid, batches: &[Uuid]) -> (Uuid, i64) {
    let (st, h, b) = call(
        f,
        "POST",
        "/v1/recon/runs",
        token,
        Some(&Uuid::now_v7().to_string()),
        None,
        Some(json!({"rule_pack_id": pack, "batch_ids": batches})),
    )
    .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{b}");
    (b["id"].as_str().unwrap().parse().unwrap(), seq(&h))
}

/// Poll `GET /v1/recon/runs/{id}` until it leaves `queued`.
async fn finished_run(f: &Fx, token: &str, run: Uuid, min_seq: i64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let (st, _, b) = call(f, "GET", &format!("/v1/recon/runs/{run}"), token, None, Some(min_seq), None).await;
        assert_eq!(st, StatusCode::OK, "{b}");
        if b["status"] != "queued" && b["status"] != "running" {
            return b;
        }
        assert!(Instant::now() < deadline, "run did not finish: {b}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn findings(f: &Fx, token: &str, run: Uuid) -> Vec<Value> {
    let (st, _, b) = call(f, "GET", &format!("/v1/findings?run_id={run}"), token, None, None, None).await;
    assert_eq!(st, StatusCode::OK);
    b["items"].as_array().unwrap().clone()
}

#[tokio::test]
async fn queued_run_is_processed_into_cited_findings_and_replays_identically() {
    let fx = fx().await;
    let f = &fx;
    let (t, token) = tenant_with_key(f, &ALL).await;
    let (pack_id, rules) = pack(f, &CODES).await;
    let batches = standard_batches(f, t).await;

    let (run, commit_seq) = queue(f, &token, pack_id, &batches).await;
    let (st, _, body) = call(f, "GET", &format!("/v1/recon/runs/{run}"), &token, None, Some(commit_seq), None).await;
    assert_eq!((st, body["status"].as_str()), (StatusCode::OK, Some("queued")));
    assert_eq!(body["min_seq"], commit_seq);

    let step = f.engine.process_next(t).await.unwrap();
    assert_eq!(step, Step::Completed { run, findings: 4 });
    assert_eq!(f.engine.process_next(t).await.unwrap(), Step::Idle);

    let done = finished_run(f, &token, run, commit_seq).await;
    assert_eq!(done["status"], "done");
    assert_eq!(done["finding_count"], 4);

    let got = findings(f, &token, run).await;
    // wire contract the frontend validates (frontend/lib/api/schemas.ts)
    for x in &got {
        for key in ["finding_id", "check_code", "severity", "jurisdiction", "summary", "rule_citation", "created_at"] {
            assert!(x[key].as_str().is_some_and(|s| !s.is_empty()), "{key} missing in {x}");
        }
        assert_eq!(x["rule_citation"], "urn:recon:synthetic-fixture — none");
        assert_eq!(x["jurisdiction"], "XX");
    }
    let mut seen: Vec<(String, String, String, Uuid)> = got
        .iter()
        .map(|x| {
            (
                x["detail"]["invoice_ref"].as_str().unwrap().to_string(),
                x["detail"]["outcome"].as_str().unwrap().to_string(),
                x["severity"].as_str().unwrap().to_string(),
                x["rule_id"].as_str().unwrap().parse().unwrap(),
            )
        })
        .collect();
    seen.sort();
    let rule = |code: &str| rules.iter().find(|(c, _)| c == code).unwrap().1;
    assert_eq!(
        seen,
        vec![
            ("B".into(), "no_clearance_record".into(), "medium".into(), rule("C1-NO-CLEARANCE-RECORD")),
            ("C".into(), "not_accepted".into(), "medium".into(), rule("C1-NOT-ACCEPTED")),
            ("D".into(), "amount_mismatch".into(), "high".into(), rule("C1-AMOUNT-MISMATCH")),
            ("Z".into(), "orphan_clearance".into(), "low".into(), rule("C1-ORPHAN-CLEARANCE")),
        ]
    );

    // R-ENG-1 / R-ENG-2: a second run over the same inputs and pack yields the same findings, each pinned to its inputs.
    let (run2, seq2) = queue(f, &token, pack_id, &batches).await;
    assert_eq!(f.engine.process_next(t).await.unwrap(), Step::Completed { run: run2, findings: 4 });
    finished_run(f, &token, run2, seq2).await;
    let rows = |run: Uuid| {
        let pool = f.admin_w.clone();
        async move {
            sqlx::query_as::<_, (String, Uuid, String, Vec<Uuid>, Vec<Vec<u8>>, Value)>(
                "SELECT check_code, rule_id, severity, input_record_ids, input_hashes, detail
                   FROM recon.finding WHERE run_id = $1 ORDER BY detail->>'invoice_ref'",
            )
            .bind(run)
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    let (a, b) = (rows(run).await, rows(run2).await);
    assert_eq!(a.len(), 4);
    assert_eq!(a, b);
    assert!(a.iter().all(|r| r.3.len() == r.4.len() && r.4.iter().all(|h| h.len() == 32)));

    // the engine's outcome is in the ledger, in the same transaction as the findings
    let (n,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM ledger.audit_event WHERE tenant_id=$1 AND event_type='recon.run_completed' AND payload->>'run_id' = $2",
    )
    .bind(t)
    .bind(run.to_string())
    .fetch_one(&f.admin_w)
    .await
    .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn pack_without_a_cited_rule_fails_the_run_and_writes_no_findings() {
    let fx = fx().await;
    let f = &fx;
    let (t, token) = tenant_with_key(f, &ALL).await;
    let (pack_id, _) = pack(f, &CODES[..3]).await; // lacks C1-ORPHAN-CLEARANCE
    let batches = standard_batches(f, t).await;
    let (run, s) = queue(f, &token, pack_id, &batches).await;

    assert_eq!(
        f.engine.process_next(t).await.unwrap(),
        Step::Failed { run, reason: "rule_missing_in_pack" }
    );
    assert_eq!(finished_run(f, &token, run, s).await["status"], "failed");
    assert!(findings(f, &token, run).await.is_empty());
    let (reason,): (String,) = sqlx::query_as(
        "SELECT payload->>'reason' FROM ledger.audit_event WHERE tenant_id=$1 AND event_type='recon.run_failed'",
    )
    .bind(t)
    .fetch_one(&f.admin_w)
    .await
    .unwrap();
    assert_eq!(reason, "rule_missing_in_pack");
}

#[tokio::test]
async fn ambiguous_input_fails_the_run_with_a_stable_reason() {
    let fx = fx().await;
    let f = &fx;
    let (t, token) = tenant_with_key(f, &ALL).await;
    let (pack_id, _) = pack(f, &CODES).await;
    let b = batch(f, t, "parsed", "invoice", &[inv("A", 1), inv("A", 2)]).await;
    let (run, _) = queue(f, &token, pack_id, &[b]).await;
    assert_eq!(
        f.engine.process_next(t).await.unwrap(),
        Step::Failed { run, reason: "duplicate_invoice_ref" }
    );
}

#[tokio::test]
async fn engine_only_touches_the_tenant_it_is_asked_about() {
    let fx = fx().await;
    let f = &fx;
    let (a, token_a) = tenant_with_key(f, &ALL).await;
    let (b, _) = tenant_with_key(f, &ALL).await;
    let (pack_id, _) = pack(f, &CODES).await;
    let batches = standard_batches(f, a).await;
    let (run, _) = queue(f, &token_a, pack_id, &batches).await;

    assert_eq!(f.engine.process_next(b).await.unwrap(), Step::Idle);
    let (status,): (String,) = sqlx::query_as("SELECT status FROM recon.run WHERE id=$1")
        .bind(run)
        .fetch_one(&f.admin_w)
        .await
        .unwrap();
    assert_eq!(status, "queued");
}

#[tokio::test]
async fn run_requests_are_validated_scoped_idempotent_and_tenant_isolated() {
    let fx = fx().await;
    let f = &fx;
    let (t, token) = tenant_with_key(f, &ALL).await;
    let (_, read_only) = tenant_with_key(f, &["runs:read"]).await;
    let (other, _) = tenant_with_key(f, &ALL).await;
    let (pack_id, _) = pack(f, &CODES).await;
    let good = batch(f, t, "parsed", "invoice", &[inv("A", 1)]).await;
    let unparsed = batch(f, t, "registered", "invoice", &[]).await;
    let foreign = batch(f, other, "parsed", "invoice", &[inv("A", 1)]).await;
    let post = |token: &str, idem: Option<&str>, body: Value| {
        let token = token.to_string();
        let idem = idem.map(str::to_string);
        async move { call(f, "POST", "/v1/recon/runs", &token, idem.as_deref(), None, Some(body)).await }
    };

    // scope
    let (st, ..) = post(&read_only, Some("k"), json!({"rule_pack_id": pack_id, "batch_ids": [good]})).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    // idempotency key required
    let (st, _, b) = post(&token, None, json!({"rule_pack_id": pack_id, "batch_ids": [good]})).await;
    assert_eq!((st, b["error"]["code"].as_str()), (StatusCode::BAD_REQUEST, Some("idempotency_key_required")));
    // body shape
    for body in [
        json!({"rule_pack_id": pack_id, "batch_ids": []}),
        json!({"rule_pack_id": pack_id, "batch_ids": [good, good]}),
        json!({"rule_pack_id": pack_id}),
        json!({"rule_pack_id": pack_id, "batch_ids": [good], "extra": 1}),
        json!({"rule_pack_id": "nope", "batch_ids": [good]}),
    ] {
        let (st, ..) = post(&token, Some(&Uuid::now_v7().to_string()), body.clone()).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{body}");
    }
    // references
    let idem = || Uuid::now_v7().to_string();
    let (st, _, b) = post(&token, Some(&idem()), json!({"rule_pack_id": Uuid::now_v7(), "batch_ids": [good]})).await;
    assert_eq!((st, b["error"]["code"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("unknown_rule_pack")));
    let (st, _, b) = post(&token, Some(&idem()), json!({"rule_pack_id": pack_id, "batch_ids": [foreign]})).await;
    assert_eq!((st, b["error"]["code"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("unknown_batch")));
    let (st, _, b) = post(&token, Some(&idem()), json!({"rule_pack_id": pack_id, "batch_ids": [unparsed]})).await;
    assert_eq!((st, b["error"]["code"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("batch_not_parsed")));
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM recon.run WHERE tenant_id=$1")
        .bind(t)
        .fetch_one(&f.admin_w)
        .await
        .unwrap();
    assert_eq!(n, 0, "rejected requests must not leave runs behind");

    // idempotency: replay returns the stored response and creates no second run; a different body is refused
    let req = json!({"rule_pack_id": pack_id, "batch_ids": [good]});
    let (st1, h1, b1) = post(&token, Some("same-key"), req.clone()).await;
    let (st2, h2, b2) = post(&token, Some("same-key"), req.clone()).await;
    assert_eq!((st1, st2), (StatusCode::ACCEPTED, StatusCode::ACCEPTED));
    assert_eq!((&b1, seq(&h1)), (&b2, seq(&h2)));
    assert_eq!(h2["idempotent-replayed"], "true");
    let (st, ..) = post(&token, Some("same-key"), json!({"rule_pack_id": pack_id, "batch_ids": [good, unparsed]})).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM recon.run WHERE tenant_id=$1")
        .bind(t)
        .fetch_one(&f.admin_w)
        .await
        .unwrap();
    assert_eq!(n, 1);

    // reads: another tenant cannot see the run; unknown id is 404
    let run: Uuid = b1["id"].as_str().unwrap().parse().unwrap();
    let (_, other_token) = tenant_with_key(f, &ALL).await;
    let (st, ..) = call(f, "GET", &format!("/v1/recon/runs/{run}"), &other_token, None, None, None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, ..) = call(f, "GET", &format!("/v1/recon/runs/{}", Uuid::now_v7()), &token, None, None, None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}
