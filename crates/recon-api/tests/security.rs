//! Security behaviour of the HTTP surface against a REAL W + R pair (Rules R-GEN-2): input validation and
//! sanitisation, response headers, rate limits, Argon2 cap and the internal (signed) listener. Same prerequisites as
//! `runs.rs`: `RECON_TEST_W_URL` / `RECON_TEST_R_URL` point at migrated, subscribed clusters (superuser URLs, setup only).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Request, StatusCode};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http_body_util::BodyExt;
use recon_api::admin::{create_tenant, issue_api_key};
use recon_api::clock::{Clock, SystemClock};
use recon_api::guard::RateLimits;
use recon_api::ratelimit::Quota;
use recon_api::service::{canonical, request_target, sign};
use recon_api::{AppState, SecurityConfig, ServiceKeys, ServicePlane, app, internal_app};
use recon_store::{Actor, ReadStore, WriteStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

struct Fx {
    admin_w: PgPool,
    w_admin: WriteStore,
    w_cmd: WriteStore,
    r_api: ReadStore,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set (see the module docs)"))
}

async fn fx() -> Fx {
    let (w_url, r_url) = (env("RECON_TEST_W_URL"), env("RECON_TEST_R_URL"));
    let admin_w = PgPoolOptions::new().max_connections(4).connect(&w_url).await.unwrap();
    let admin_r = PgPoolOptions::new().max_connections(2).connect(&r_url).await.unwrap();
    for (pool, roles) in [
        (&admin_w, [("t_w_admin", "w_admin"), ("t_w_cmd", "w_cmd")].as_slice()),
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
    Fx {
        w_admin: WriteStore::connect_with(as_user(&w_url, "t_w_admin"), 2).await.unwrap(),
        w_cmd: WriteStore::connect_with(as_user(&w_url, "t_w_cmd"), 8).await.unwrap(),
        r_api: ReadStore::connect_with(as_user(&r_url, "t_r_api"), 8).await.unwrap(),
        admin_w,
    }
}

fn roomy() -> RateLimits {
    let q = Quota::new(600_000, 100_000);
    RateLimits { ip: q, key_read: q, key_write: q, tenant_read: q, tenant_write: q, ..RateLimits::default() }
}

impl Fx {
    fn state(&self, security: SecurityConfig) -> AppState {
        AppState::with_security(self.w_cmd.clone(), self.r_api.clone(), Duration::from_secs(10), security).unwrap()
    }
    fn public(&self) -> Router {
        app(self.state(SecurityConfig { limits: roomy(), ..SecurityConfig::default() }))
    }
    async fn tenant_with_key(&self, scopes: &[&str]) -> (Uuid, String) {
        let t = create_tenant(&self.w_admin, &format!("sec-{}", Uuid::now_v7())).await.unwrap();
        let scopes: Vec<String> = scopes.iter().map(|s| (*s).to_string()).collect();
        (t, issue_api_key(&self.w_cmd, t, &scopes).await.unwrap().token)
    }
}

const ALL: [&str; 5] = ["batches:write", "batches:read", "findings:read", "runs:write", "runs:read"];
const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("x-content-type-options", "nosniff"),
    ("cache-control", "no-store"),
    ("content-security-policy", "default-src 'none'; frame-ancestors 'none'"),
    ("referrer-policy", "no-referrer"),
    ("cross-origin-resource-policy", "same-origin"),
];

struct Out {
    status: StatusCode,
    headers: HeaderMap,
    text: String,
}

impl Out {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or_else(|_| panic!("not JSON: {}", self.text))
    }
    fn code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or("").to_string()
    }
    fn assert_security_headers(&self) {
        for (name, value) in SECURITY_HEADERS {
            assert_eq!(self.headers.get(name).and_then(|v| v.to_str().ok()), Some(value), "{name} on {}", self.status);
        }
    }
}

struct Req {
    peer: Option<&'static str>,
    method: &'static str,
    uri: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// Send `Content-Length` (a real client always does unless it streams chunked).
    declare_length: bool,
}

impl Req {
    fn new(method: &'static str, uri: &str) -> Self {
        Self { peer: Some("203.0.113.9"), method, uri: uri.into(), headers: vec![], body: vec![], declare_length: true }
    }
    fn streamed(mut self) -> Self {
        self.declare_length = false;
        self
    }
    fn token(self, t: &str) -> Self {
        self.header("authorization", &format!("Bearer {t}"))
    }
    fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
    fn json(mut self, v: &Value) -> Self {
        self.body = v.to_string().into_bytes();
        self.header("content-type", "application/json")
    }
    fn raw(mut self, body: &str) -> Self {
        self.body = body.as_bytes().to_vec();
        self.header("content-type", "application/json")
    }
    fn peer(mut self, p: &'static str) -> Self {
        self.peer = Some(p);
        self
    }
    async fn send(self, app: &Router) -> Out {
        let mut b = Request::builder().method(self.method).uri(&self.uri);
        for (k, v) in &self.headers {
            b = b.header(k, v);
        }
        let mut req = b.body(Body::from(self.body.clone())).unwrap();
        if self.declare_length && !self.body.is_empty() {
            req.headers_mut().insert("content-length", self.body.len().into());
        }
        if let Some(p) = self.peer {
            let addr = if p.contains(':') { format!("[{p}]:5000") } else { format!("{p}:5000") };
            req.extensions_mut().insert(ConnectInfo::<SocketAddr>(addr.parse().unwrap()));
        }
        let res = app.clone().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        let text = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
        Out { status: parts.status, headers: parts.headers, text }
    }
}

fn sha_hex(seed: &str) -> String {
    hex::encode(Sha256::digest(seed.as_bytes()))
}

fn batch_body(seed: &str) -> Value {
    json!({"source_type": "erp_ledger", "object_uri": format!("https://eu.example/{seed}"), "sha256": sha_hex(seed)})
}

fn idem() -> String {
    Uuid::now_v7().to_string()
}

#[tokio::test]
async fn every_response_carries_the_security_headers_and_a_script_payload_stays_a_json_string() {
    let f = fx().await;
    let app = f.public();
    let (t, token) = f.tenant_with_key(&ALL).await;

    // A stored value that is hostile markup (inserted through the command role, as an ingest component would).
    let payload = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    let mut tx = f.w_cmd.begin_tenant(t).await.unwrap();
    let (id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO ingest.source_batch(tenant_id, source_type, object_uri, sha256, status, failure_reason)
         VALUES ($1,$2,'https://eu.example/x',$3,'failed',$2) RETURNING id",
    )
    .bind(t)
    .bind(payload)
    .bind(Sha256::digest(payload.as_bytes()).to_vec())
    .fetch_one(tx.conn())
    .await
    .unwrap();
    tx.append_event("batch.registered", Actor::System("it"), &json!({"batch_id": id})).await.unwrap();
    tx.commit().await.unwrap();

    let mut out = None;
    for _ in 0..200 {
        let o = Req::new("GET", &format!("/v1/batches/{id}")).token(&token).send(&app).await;
        if o.status == StatusCode::OK {
            out = Some(o);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let out = out.expect("batch did not replicate to R");
    assert_eq!(out.headers["content-type"], "application/json");
    out.assert_security_headers();
    let body = out.json();
    assert_eq!(body["source_type"], payload, "returned verbatim, as data inside a JSON string");
    assert_eq!(body["failure_reason"], payload);

    // errors, 404, 405, 401, 400 and plain health all carry the headers too and never reflect input
    let hostile_path = "/v1/%3Cscript%3Ealert(1)%3C%2Fscript%3E";
    for o in [
        Req::new("GET", hostile_path).token(&token).send(&app).await,
        Req::new("DELETE", "/v1/findings").token(&token).send(&app).await,
        Req::new("GET", "/v1/findings").send(&app).await,
        Req::new("GET", "/v1/findings").header("authorization", "Bearer <script>alert(1)</script>").send(&app).await,
        Req::new("GET", "/v1/batches/%3Cscript%3E").token(&token).send(&app).await,
        Req::new("GET", "/v1/findings?check_code=%3Cscript%3E").token(&token).send(&app).await,
        Req::new("POST", "/v1/batches")
            .token(&token)
            .header("idempotency-key", &idem())
            .json(&json!({"source_type": payload, "object_uri": payload, "sha256": payload}))
            .send(&app)
            .await,
        Req::new("GET", "/healthz").send(&app).await,
    ] {
        o.assert_security_headers();
        assert!(!o.text.to_lowercase().contains("script"), "{} reflected input: {}", o.status, o.text);
    }
    let health = Req::new("GET", "/healthz").send(&app).await;
    assert_eq!((health.status, health.text.as_str()), (StatusCode::OK, "ok"));
    assert!(health.headers["content-type"].to_str().unwrap().starts_with("text/plain"));
    assert_eq!(Req::new("GET", hostile_path).token(&token).send(&app).await.status, StatusCode::NOT_FOUND);
    assert_eq!(Req::new("DELETE", "/v1/findings").token(&token).send(&app).await.status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn hostile_sql_text_is_stored_and_returned_as_plain_data() {
    let f = fx().await;
    let app = f.public();
    let (t, token) = f.tenant_with_key(&ALL).await;
    // `'`, `;`, `--` and a comment are all legal URI characters, so this reaches the database verbatim.
    let nonce = Uuid::now_v7();
    let uri = format!("https://eu.example/{nonce}'; DROP TABLE ingest.source_batch;--").replace(' ', "%20");
    let body = json!({"source_type": "erp_ledger", "object_uri": uri, "sha256": sha_hex(&uri)});
    let out = Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &idem()).json(&body).send(&app).await;
    assert_eq!(out.status, StatusCode::CREATED, "{}", out.text);
    let id: Uuid = out.json()["id"].as_str().unwrap().parse().unwrap();

    let (stored,): (String,) = sqlx::query_as("SELECT object_uri FROM ingest.source_batch WHERE id = $1 AND tenant_id = $2")
        .bind(id)
        .bind(t)
        .fetch_one(&f.admin_w)
        .await
        .unwrap();
    assert_eq!(stored, uri, "stored byte-for-byte, not escaped or truncated");
    let (rows,): (i64,) = sqlx::query_as("SELECT count(*) FROM ingest.source_batch").fetch_one(&f.admin_w).await.unwrap();
    assert!(rows >= 1, "the table is still there");
}

#[tokio::test]
async fn bad_bodies_ids_queries_and_headers_are_refused_with_stable_codes_and_no_echo() {
    let f = fx().await;
    let app = f.public();
    let (_, token) = f.tenant_with_key(&ALL).await;
    let post = |body: Value| Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &idem()).json(&body);
    let good = batch_body("ok");
    let with = |k: &str, v: Value| {
        let mut b = good.clone();
        b[k] = v;
        b
    };

    let cases: Vec<(Req, StatusCode, &str)> = vec![
        (post(with("source_type", json!("vat_return"))), StatusCode::BAD_REQUEST, "invalid_source_type"),
        (post(with("source_type", json!("erp_ledger\u{202e}"))), StatusCode::BAD_REQUEST, "invalid_characters"),
        (post(with("source_type", json!("erp\u{0}ledger"))), StatusCode::BAD_REQUEST, "invalid_characters"),
        (post(with("object_uri", json!("javascript:alert(1)"))), StatusCode::BAD_REQUEST, "invalid_object_uri"),
        (post(with("object_uri", json!("file:///etc/passwd"))), StatusCode::BAD_REQUEST, "invalid_object_uri"),
        (post(with("object_uri", json!("data:text/html,<script>"))), StatusCode::BAD_REQUEST, "invalid_object_uri"),
        (post(with("object_uri", json!("http://eu.example/x"))), StatusCode::BAD_REQUEST, "invalid_object_uri"),
        (post(with("object_uri", json!("https://eu.example/\u{200b}x"))), StatusCode::BAD_REQUEST, "invalid_characters"),
        (post(with("object_uri", json!(format!("https://eu.example/{}", "a".repeat(2100))))), StatusCode::BAD_REQUEST, "invalid_object_uri"),
        (post(with("sha256", json!(sha_hex("ok").to_uppercase()))), StatusCode::BAD_REQUEST, "invalid_sha256"),
        (post(with("sha256", json!("abc"))), StatusCode::BAD_REQUEST, "invalid_sha256"),
        (post(with("period_start", json!("2026-02-30"))), StatusCode::BAD_REQUEST, "invalid_period"),
        (post(with("period_start", json!("1850-01-01"))), StatusCode::BAD_REQUEST, "invalid_period"),
        (
            post({
                let mut b = with("period_start", json!("2026-03-01"));
                b["period_end"] = json!("2026-02-01");
                b
            }),
            StatusCode::BAD_REQUEST,
            "invalid_period",
        ),
        (post(with("extra", json!(1))), StatusCode::BAD_REQUEST, "invalid_body"),
        (post(with("source_type", json!(5))), StatusCode::BAD_REQUEST, "invalid_body"),
        (post(json!([1, 2])), StatusCode::BAD_REQUEST, "invalid_body"),
        (
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &idem()).raw("{not json"),
            StatusCode::BAD_REQUEST,
            "invalid_body",
        ),
        (
            // duplicate keys: two parsers could disagree on which one wins, so neither is accepted
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &idem()).raw(&format!(
                r#"{{"source_type":"erp_ledger","source_type":"authority_clearance","object_uri":"https://eu.example/d","sha256":"{}"}}"#,
                sha_hex("d")
            )),
            StatusCode::BAD_REQUEST,
            "invalid_body",
        ),
        // Idempotency-Key
        (Req::new("POST", "/v1/batches").token(&token).json(&good), StatusCode::BAD_REQUEST, "idempotency_key_required"),
        (
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &"k".repeat(129)).json(&good),
            StatusCode::BAD_REQUEST,
            "idempotency_key_invalid",
        ),
        (
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", "has space").json(&good),
            StatusCode::BAD_REQUEST,
            "idempotency_key_invalid",
        ),
        (
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", "a").header("idempotency-key", "b").json(&good),
            StatusCode::BAD_REQUEST,
            "idempotency_key_required",
        ),
        // content type
        (
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &idem()).header("content-type", "text/plain").json_body_only(&good),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
        ),
        (
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &idem()).json_body_only(&good),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
        ),
        (
            Req::new("POST", "/v1/batches")
                .token(&token)
                .header("idempotency-key", &idem())
                .header("content-type", "application/x-www-form-urlencoded")
                .json_body_only(&good),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
        ),
        // size: declared length, and a streamed body without a declared length is cut at the limit too
        (
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &idem()).raw(&format!(
                r#"{{"source_type":"erp_ledger","pad":"{}"}}"#,
                "x".repeat(9 * 1024)
            )),
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
        ),
        (
            Req::new("POST", "/v1/batches").token(&token).header("idempotency-key", &idem()).streamed().raw(&format!(
                r#"{{"source_type":"erp_ledger","pad":"{}"}}"#,
                "x".repeat(9 * 1024)
            )),
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
        ),
        // ids, query, X-Min-Seq
        (Req::new("GET", "/v1/batches/not-a-uuid").token(&token), StatusCode::BAD_REQUEST, "invalid_id"),
        (Req::new("GET", "/v1/batches/0190c1f27a3b7c4d8e5f0123456789ab").token(&token), StatusCode::BAD_REQUEST, "invalid_id"),
        (Req::new("GET", "/v1/recon/runs/%00").token(&token), StatusCode::BAD_REQUEST, "invalid_id"),
        (Req::new("GET", "/v1/findings?limit=0").token(&token), StatusCode::BAD_REQUEST, "invalid_limit"),
        (Req::new("GET", "/v1/findings?limit=201").token(&token), StatusCode::BAD_REQUEST, "invalid_limit"),
        (Req::new("GET", "/v1/findings?limit=-1").token(&token), StatusCode::BAD_REQUEST, "invalid_limit"),
        (Req::new("GET", "/v1/findings?after=zzz").token(&token), StatusCode::BAD_REQUEST, "invalid_after"),
        (Req::new("GET", "/v1/findings?run_id=1").token(&token), StatusCode::BAD_REQUEST, "invalid_run_id"),
        (Req::new("GET", "/v1/findings?check_code=a%20b").token(&token), StatusCode::BAD_REQUEST, "invalid_check_code"),
        (Req::new("GET", "/v1/findings?check_code=C1%00").token(&token), StatusCode::BAD_REQUEST, "invalid_characters"),
        (Req::new("GET", "/v1/findings?severity=high").token(&token), StatusCode::BAD_REQUEST, "invalid_query"),
        (Req::new("GET", "/v1/findings?limit=5&limit=6").token(&token), StatusCode::BAD_REQUEST, "invalid_query"),
        (Req::new("GET", "/v1/findings").token(&token).header("x-min-seq", "-1"), StatusCode::BAD_REQUEST, "invalid_min_seq"),
        (Req::new("GET", "/v1/findings").token(&token).header("x-min-seq", "1").header("x-min-seq", "2"), StatusCode::BAD_REQUEST, "invalid_min_seq"),
        // request head limits
        (Req::new("GET", &format!("/v1/findings?check_code={}", "a".repeat(5000))).token(&token), StatusCode::URI_TOO_LONG, "uri_too_long"),
        (
            Req::new("GET", "/v1/findings").token(&token).header("x-pad", &"p".repeat(5000)),
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            "headers_too_large",
        ),
        // a body on a route that takes none
        (Req::new("GET", "/v1/findings").token(&token).raw("{}"), StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
    ];
    for (req, status, code) in cases {
        let label = format!("{} {}", req.method, req.uri.chars().take(60).collect::<String>());
        let out = req.send(&app).await;
        assert_eq!((out.status, out.code().as_str()), (status, code), "{label}: {}", out.text);
        out.assert_security_headers();
        for needle in ["javascript", "passwd", "<script>", "vat_return", "not-a-uuid", "zzz"] {
            assert!(!out.text.contains(needle), "{label} echoed `{needle}`: {}", out.text);
        }
    }

    // the request that is valid on every one of those axes still works
    let ok = Req::new("POST", "/v1/batches")
        .token(&token)
        .header("idempotency-key", &idem())
        .json(&with("period_start", json!("2026-01-01")))
        .send(&app)
        .await;
    assert_eq!(ok.status, StatusCode::CREATED, "{}", ok.text);
    assert_eq!(Req::new("GET", "/v1/findings?limit=200").token(&token).send(&app).await.status, StatusCode::OK);
}

impl Req {
    /// Body without adding a `content-type` (the caller sets, or deliberately omits, it).
    fn json_body_only(mut self, v: &Value) -> Self {
        self.body = v.to_string().into_bytes();
        self
    }
}

#[tokio::test]
async fn the_per_ip_limit_answers_429_before_authentication_with_retry_hints() {
    let f = fx().await;
    let security = SecurityConfig {
        limits: RateLimits { ip: Quota::new(1, 5), ..roomy() },
        ..SecurityConfig::default()
    };
    let app = app(f.state(security));
    for i in 0..5 {
        let o = Req::new("GET", "/v1/findings").header("authorization", "Bearer rk_nope").send(&app).await;
        assert_eq!(o.status, StatusCode::UNAUTHORIZED, "request {i}");
    }
    let limited = Req::new("GET", "/v1/findings").header("authorization", "Bearer rk_nope").send(&app).await;
    assert_eq!((limited.status, limited.code().as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    assert!(limited.headers["retry-after"].to_str().unwrap().parse::<u32>().unwrap() >= 1);
    assert_eq!(limited.headers["ratelimit-limit"], "5");
    assert_eq!(limited.headers["ratelimit-remaining"], "0");
    assert!(limited.headers.contains_key("ratelimit-reset"));
    limited.assert_security_headers();
    // another client address has its own bucket
    let other = Req::new("GET", "/healthz").peer("198.51.100.4").send(&app).await;
    assert_eq!(other.status, StatusCode::OK);
    // a forged X-Forwarded-For does not give the limited client a fresh bucket (the peer is not a trusted proxy)
    let spoof = Req::new("GET", "/healthz").header("x-forwarded-for", "198.51.100.77").send(&app).await;
    assert_eq!(spoof.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn trusted_proxies_may_forward_the_client_address_and_nobody_else() {
    let f = fx().await;
    let security = SecurityConfig {
        limits: RateLimits { ip: Quota::new(1, 1), ..roomy() },
        trusted_proxies: recon_api::net::parse_cidr_list("10.0.0.0/8").unwrap(),
        ..SecurityConfig::default()
    };
    let app = app(f.state(security));
    let via = |client: &str| Req::new("GET", "/healthz").peer("10.1.1.1").header("x-forwarded-for", &format!("1.2.3.4, {client}"));
    assert_eq!(via("198.51.100.1").send(&app).await.status, StatusCode::OK);
    assert_eq!(via("198.51.100.1").send(&app).await.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(via("198.51.100.2").send(&app).await.status, StatusCode::OK, "a different forwarded client has its own bucket");
}

#[tokio::test]
async fn per_key_and_per_tenant_limits_apply_after_authentication_and_writes_are_stricter() {
    let f = fx().await;
    let security = SecurityConfig {
        limits: RateLimits {
            key_write: Quota::new(1, 2),
            tenant_read: Quota::new(1, 3),
            ..roomy()
        },
        ..SecurityConfig::default()
    };
    let app = app(f.state(security));
    let (t, key_a) = f.tenant_with_key(&ALL).await;
    let key_b = issue_api_key(&f.w_cmd, t, &ALL.map(String::from)).await.unwrap().token;

    // writes: burst 2, then 429 — reads of the same key are separate
    for i in 0..2 {
        let o = Req::new("POST", "/v1/batches").token(&key_a).header("idempotency-key", &idem()).json(&batch_body(&format!("w{i}-{t}"))).send(&app).await;
        assert_eq!(o.status, StatusCode::CREATED, "{}", o.text);
    }
    let third = Req::new("POST", "/v1/batches").token(&key_a).header("idempotency-key", &idem()).json(&batch_body(&format!("w2-{t}"))).send(&app).await;
    assert_eq!((third.status, third.code().as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    assert!(third.headers.contains_key("retry-after") && third.headers.contains_key("ratelimit-limit"));
    third.assert_security_headers();

    // the tenant's read budget (3) is shared by both of its keys
    assert_eq!(Req::new("GET", "/v1/findings").token(&key_a).send(&app).await.status, StatusCode::OK);
    assert_eq!(Req::new("GET", "/v1/findings").token(&key_b).send(&app).await.status, StatusCode::OK);
    assert_eq!(Req::new("GET", "/v1/findings").token(&key_a).send(&app).await.status, StatusCode::OK);
    assert_eq!(Req::new("GET", "/v1/findings").token(&key_b).send(&app).await.status, StatusCode::TOO_MANY_REQUESTS);
    // another tenant is unaffected
    let (_, other) = f.tenant_with_key(&ALL).await;
    assert_eq!(Req::new("GET", "/v1/findings").token(&other).send(&app).await.status, StatusCode::OK);
}

#[tokio::test]
async fn saturated_argon2_slots_fail_fast_with_503_instead_of_queueing() {
    let f = fx().await;
    let security = SecurityConfig {
        limits: roomy(),
        argon2_concurrency: 1,
        argon2_wait: Duration::from_millis(1),
        ..SecurityConfig::default()
    };
    let app = app(f.state(security));
    let (_, token) = f.tenant_with_key(&ALL).await;
    let tasks: Vec<_> = (0..12)
        .map(|_| {
            let (app, token) = (app.clone(), token.clone());
            tokio::spawn(async move { Req::new("GET", "/v1/findings").token(&token).send(&app).await })
        })
        .collect();
    let mut statuses = vec![];
    for t in tasks {
        let o = t.await.unwrap();
        if o.status == StatusCode::SERVICE_UNAVAILABLE {
            assert_eq!(o.code(), "busy");
            assert!(o.headers.contains_key("retry-after"));
        }
        statuses.push(o.status);
    }
    assert!(statuses.contains(&StatusCode::OK), "someone got the slot: {statuses:?}");
    assert!(statuses.contains(&StatusCode::SERVICE_UNAVAILABLE), "contention was refused, not queued: {statuses:?}");
}

// ------------------------------------------------------------------ internal listener

const SECRET: [u8; 40] = [42; 40];

fn plane(clock: Arc<dyn Clock>) -> Arc<ServicePlane> {
    let keys = ServiceKeys::parse(&format!("bff-1:{}", URL_SAFE_NO_PAD.encode(SECRET))).unwrap();
    let allowed = recon_api::net::parse_cidr_list("127.0.0.1/32,::1/128").unwrap();
    Arc::new(ServicePlane::new(keys, allowed, 1000, clock).unwrap())
}

fn nonce() -> String {
    URL_SAFE_NO_PAD.encode(Uuid::now_v7().as_bytes())
}

/// The four signature headers for a request, signed now.
fn signed(method: &str, uri: &str, body: &[u8], ts_offset: i64, nonce: &str) -> Vec<(String, String)> {
    let ts = (SystemClock::new().unix_secs() + ts_offset).to_string();
    let target = request_target(&uri.parse().unwrap());
    let sig = sign(&SECRET, &canonical(method, &target, &ts, nonce, body)).unwrap();
    vec![
        ("x-recon-key-id".into(), "bff-1".into()),
        ("x-recon-timestamp".into(), ts),
        ("x-recon-nonce".into(), nonce.into()),
        ("x-recon-signature".into(), sig),
    ]
}

fn with_headers(mut r: Req, h: Vec<(String, String)>) -> Req {
    r.headers.extend(h);
    r
}

#[tokio::test]
async fn the_internal_listener_demands_source_ip_signature_and_api_key() {
    let f = fx().await;
    let app = internal_app(f.state(SecurityConfig { limits: roomy(), ..SecurityConfig::default() }), plane(Arc::new(SystemClock::new())));
    let (_, token) = f.tenant_with_key(&ALL).await;
    let get = |uri: &str| Req::new("GET", uri).peer("127.0.0.1").token(&token);

    // unsigned: 401 whatever the API key says
    let unsigned = get("/v1/findings").send(&app).await;
    assert_eq!((unsigned.status, unsigned.code().as_str()), (StatusCode::UNAUTHORIZED, "invalid_service_signature"));
    unsigned.assert_security_headers();

    // correctly signed, allowed source: reaches the handler and succeeds
    let uri = "/v1/findings?limit=5";
    let n = nonce();
    let ok = with_headers(get(uri), signed("GET", uri, b"", 0, &n)).send(&app).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text);
    ok.assert_security_headers();

    // replay of the very same signed request
    let replay = with_headers(get(uri), signed("GET", uri, b"", 0, &n)).send(&app).await;
    assert_eq!(replay.status, StatusCode::UNAUTHORIZED);
    assert_eq!(replay.text, unsigned.text, "one 401 body for every signature failure");

    // bad signature (signed for another query), wrong method, stale and future timestamps
    let other = with_headers(get(uri), signed("GET", "/v1/findings?limit=6", b"", 0, &nonce())).send(&app).await;
    assert_eq!(other.status, StatusCode::UNAUTHORIZED);
    let method = with_headers(Req::new("POST", "/v1/batches").peer("127.0.0.1").token(&token), signed("GET", "/v1/batches", b"", 0, &nonce()))
        .header("idempotency-key", &idem())
        .json(&batch_body("m"))
        .send(&app)
        .await;
    assert_eq!(method.status, StatusCode::UNAUTHORIZED);
    for offset in [-61, 61] {
        let o = with_headers(get(uri), signed("GET", uri, b"", offset, &nonce())).send(&app).await;
        assert_eq!(o.status, StatusCode::UNAUTHORIZED, "offset {offset}");
    }
    let mut unknown = signed("GET", uri, b"", 0, &nonce());
    unknown[0].1 = "bff-2".into();
    assert_eq!(with_headers(get(uri), unknown).send(&app).await.text, unsigned.text, "unknown key id looks like a bad signature");

    // signed but no / wrong API key: the key is still required
    let n2 = nonce();
    let no_key = with_headers(Req::new("GET", uri).peer("127.0.0.1"), signed("GET", uri, b"", 0, &n2)).send(&app).await;
    assert_eq!((no_key.status, no_key.code().as_str()), (StatusCode::UNAUTHORIZED, "unauthorized"));

    // a signed POST: the body is hashed, so altering it breaks the signature, and the genuine one is accepted
    let body = batch_body("signed-post").to_string();
    let n3 = nonce();
    let post = |b: &str, headers: Vec<(String, String)>| {
        with_headers(Req::new("POST", "/v1/batches").peer("127.0.0.1").token(&token).header("idempotency-key", &idem()).raw(b), headers)
    };
    let tampered = post(&body.replace("signed-post", "signed-pozt"), signed("POST", "/v1/batches", body.as_bytes(), 0, &n3)).send(&app).await;
    assert_eq!(tampered.status, StatusCode::UNAUTHORIZED);
    let created = post(&body, signed("POST", "/v1/batches", body.as_bytes(), 0, &nonce())).send(&app).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);

    // the body limit applies before hashing
    let big = format!(r#"{{"pad":"{}"}}"#, "x".repeat(9 * 1024));
    let too_big = post(&big, signed("POST", "/v1/batches", big.as_bytes(), 0, &nonce())).send(&app).await;
    assert_eq!(too_big.status, StatusCode::PAYLOAD_TOO_LARGE);

    // outside the allowlist: refused before the signature matters, and X-Forwarded-For cannot talk its way in
    let n4 = nonce();
    let outside = with_headers(get(uri).peer("203.0.113.9"), signed("GET", uri, b"", 0, &n4)).send(&app).await;
    assert_eq!((outside.status, outside.code().as_str()), (StatusCode::FORBIDDEN, "forbidden_source"));
    outside.assert_security_headers();
    let spoofed = with_headers(get(uri).peer("203.0.113.9"), signed("GET", uri, b"", 0, &nonce()))
        .header("x-forwarded-for", "127.0.0.1")
        .send(&app)
        .await;
    assert_eq!(spoofed.status, StatusCode::FORBIDDEN);
    let v6 = with_headers(get(uri).peer("::1"), signed("GET", uri, b"", 0, &nonce())).send(&app).await;
    assert_eq!(v6.status, StatusCode::OK, "IPv6 loopback is on the list");
}
