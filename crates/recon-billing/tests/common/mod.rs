//! Shared fixture: every test gets its OWN scratch database on the W server, migrated from the real migration files with
//! `recon-migrate`, so tests cannot see each other's plans (there is at most one fallback plan per database) and no
//! shared dev database is touched. The application under test connects as a NON-superuser login role
//! (`t_bill_cmd`, member of `w_cmd`): superusers bypass RLS and would hide isolation bugs (Rules R-SEC-3, R-GEN-2: real
//! PostgreSQL, no mocks).
//!
//! Prerequisite: env `RECON_TEST_W_URL`, a superuser URL of a PostgreSQL 18 server (any database; trust auth as in
//! tools/dev/pg-pair.mjs). A missing variable fails loudly; tests never skip.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use recon_billing::plans::{Entitlement, NewPlan, create_plan};
use recon_store::WriteStore;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
use uuid::Uuid;

pub struct Fx {
    /// Superuser pool on the scratch database (independent inspection and setup only).
    pub admin: PgPool,
    /// The application role (RLS applies).
    pub cmd: WriteStore,
    /// Plan operator role (`w_billing_admin`).
    pub plans: WriteStore,
    tenants: WriteStore,
    server: PgPool,
    db: String,
}

fn w_url() -> String {
    std::env::var("RECON_TEST_W_URL").unwrap_or_else(|_| {
        panic!("set RECON_TEST_W_URL; see the header of crates/recon-billing/tests/common/mod.rs")
    })
}

pub async fn fx() -> Fx {
    let base = PgConnectOptions::from_str(&w_url()).unwrap();
    let server = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(base.clone().database("postgres"))
        .await
        .unwrap();
    // role creation is cluster-wide: serialise concurrent tests
    {
        let mut c = server.acquire().await.unwrap();
        sqlx::query("SELECT pg_advisory_lock(424243)")
            .execute(&mut *c)
            .await
            .unwrap();
        for (login, group) in [
            ("t_bill_cmd", "w_cmd"),
            ("t_bill_plans", "w_billing_admin"),
            ("t_bill_tenants", "w_admin"),
        ] {
            // the group roles are created by migration 0005/0008; create them first if this is the very first database
            let sql = format!(
                "DO $$ BEGIN
                   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{group}') THEN CREATE ROLE {group} NOLOGIN; END IF;
                   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{login}') THEN CREATE ROLE {login} LOGIN IN ROLE {group}; END IF;
                 END $$;"
            );
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut *c)
                .await
                .unwrap();
        }
        sqlx::query("SELECT pg_advisory_unlock(424243)")
            .execute(&mut *c)
            .await
            .unwrap();
    }
    let db = format!("recon_billing_t_{}", Uuid::now_v7().simple());
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {db}")))
        .execute(&server)
        .await
        .unwrap();
    let admin = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(base.clone().database(&db))
        .await
        .unwrap();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../migrations");
    let migrations = recon_migrate::discover(&dir, recon_migrate::Target::W).unwrap();
    recon_migrate::up(&admin, &migrations, None).await.unwrap();

    let as_role = |role: &str| base.clone().database(&db).username(role);
    Fx {
        cmd: WriteStore::connect_with(as_role("t_bill_cmd"), 24)
            .await
            .unwrap(),
        plans: WriteStore::connect_with(as_role("t_bill_plans"), 2)
            .await
            .unwrap(),
        tenants: WriteStore::connect_with(as_role("t_bill_tenants"), 2)
            .await
            .unwrap(),
        admin,
        server,
        db,
    }
}

impl Fx {
    /// Drop the scratch database. Call at the end of a test (a failing test leaves its database behind on purpose).
    pub async fn cleanup(self) {
        self.admin.close().await;
        let sql = format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.db);
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&self.server)
            .await
            .unwrap();
    }

    pub async fn tenant(&self) -> Uuid {
        let mut tx = self.tenants.begin_unbound().await.unwrap();
        let (id,): (Uuid,) = sqlx::query_as("SELECT core.create_tenant($1)")
            .bind(format!("billing-test-{}", Uuid::now_v7()))
            .fetch_one(tx.conn())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        id
    }

    /// Insert a plan through the real seeding path (operator role).
    pub async fn plan(&self, p: PlanSpec<'_>) -> Uuid {
        let plan = NewPlan {
            code: p.code.into(),
            display_key: format!("billing.plan.{}", p.code),
            billing_interval: p.interval.into(),
            currency: "EUR".into(),
            unit_amount_minor: if p.fallback { 0 } else { 100 },
            is_public: !p.fallback,
            is_fallback: p.fallback,
            sort_order: 0,
            provider_price_id: p.price.map(str::to_string),
            // valid long before the explicit test clocks (a plan is only effective from valid_from)
            valid_from: Some(at("2020-01-01T00:00:00Z")),
            entitlements: p
                .limits
                .iter()
                .map(|(k, v)| ((*k).to_string(), Entitlement::Limit(*v)))
                .collect::<BTreeMap<_, _>>(),
        };
        create_plan(&self.plans, &plan).await.unwrap()
    }

    /// A subscription row inserted directly (setup only; the code path under test for rows is the webhook).
    pub async fn subscription(
        &self,
        tenant: Uuid,
        plan: Uuid,
        status: &str,
        start: &str,
        end: &str,
        past_due_since: Option<&str>,
    ) {
        let sql = "INSERT INTO billing.subscription(tenant_id, plan_id, status, current_period_start, current_period_end,
                      past_due_since, provider_customer_id, provider_subscription_id, provider_event_created)
                   VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7, $8, now())";
        sqlx::query(sql)
            .bind(tenant)
            .bind(plan)
            .bind(status)
            .bind(start)
            .bind(end)
            .bind(past_due_since)
            .bind(format!("cus_{}", tenant.simple()))
            .bind(format!("sub_{}", tenant.simple()))
            .execute(&self.admin)
            .await
            .unwrap();
    }
}

pub struct PlanSpec<'a> {
    pub code: &'a str,
    pub interval: &'a str,
    pub price: Option<&'a str>,
    pub fallback: bool,
    pub limits: &'a [(&'a str, u64)],
}

pub fn at(s: &str) -> time::OffsetDateTime {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).unwrap()
}

pub const WEBHOOK_SECRET: &str = "whsec_test_secret_one";
pub const STRIPE_KEY: &str = "sk_test_unit_key_not_real";

pub fn config() -> recon_billing::BillingConfig {
    recon_billing::BillingConfig::from_lookup(|k| match k {
        "STRIPE_SECRET_KEY" => Some(STRIPE_KEY.to_string()),
        "STRIPE_WEBHOOK_SECRET" => Some(WEBHOOK_SECRET.to_string()),
        "BILLING_ALLOWED_RETURN_ORIGINS" => Some("https://app.example.eu".to_string()),
        _ => None,
    })
    .unwrap()
}

/// Billing state against a Stripe base URL (a fake local server, or a closed port when Stripe must not be called).
pub fn state(f: &Fx, stripe_base: &str) -> recon_billing::BillingState {
    let cfg = config();
    let stripe = recon_billing::stripe::StripeClient::with_base_url(
        cfg.stripe_secret_key.clone(),
        stripe_base,
    )
    .unwrap();
    recon_billing::BillingState::with_stripe(f.cmd.clone(), cfg, stripe)
}

/// Send one request through a router; returns status and JSON body (Null when empty).
pub async fn call(
    router: &axum::Router,
    req: axum::http::Request<axum::body::Body>,
) -> (axum::http::StatusCode, serde_json::Value) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

pub fn unix_now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// A Stripe event envelope as JSON bytes.
pub fn event(id: &str, kind: &str, created: i64, object: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "id": id, "object": "event", "api_version": "2026-09-30.endive", "created": created,
        "type": kind, "livemode": false, "data": {"object": object}
    }))
    .unwrap()
}

/// POST a webhook with an explicit signature header.
pub fn webhook_request(
    body: Vec<u8>,
    header: Option<String>,
) -> axum::http::Request<axum::body::Body> {
    let mut b = axum::http::Request::builder()
        .method("POST")
        .uri(recon_billing::http::WEBHOOK_PATH);
    if let Some(h) = header {
        b = b.header("Stripe-Signature", h);
    }
    b.body(axum::body::Body::from(body)).unwrap()
}

/// POST a correctly signed webhook (signed now).
pub fn signed(body: Vec<u8>) -> axum::http::Request<axum::body::Body> {
    let h = recon_billing::signature::sign(
        &body,
        &recon_billing::Secret::new(WEBHOOK_SECRET),
        unix_now(),
    );
    webhook_request(body, Some(h))
}
