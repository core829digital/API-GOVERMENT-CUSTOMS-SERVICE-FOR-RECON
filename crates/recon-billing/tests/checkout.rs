//! Checkout, billing portal and the subscription overview through the HTTP router, against a LOCAL FAKE of the Stripe
//! API written in this file. Live Stripe was NOT exercised (no keys): these tests prove what this crate sends
//! (path, headers, form fields, no personal data), what it accepts back, and how it fails; they cannot prove Stripe's
//! own behaviour. Database: real PostgreSQL 18 (tests/common/mod.rs).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode, Uri};
use axum::response::IntoResponse;
use common::{PlanSpec, call, fx};
use recon_billing::{TenantId, keys, tenant_router};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct Captured {
    path: String,
    headers: HeaderMap,
    form: BTreeMap<String, String>,
}

#[derive(Clone, Default)]
struct Fake {
    seen: Arc<Mutex<Vec<Captured>>>,
    /// (status, body) to answer with; default: a session object chosen by path.
    reply: Arc<Mutex<Option<(StatusCode, Value)>>>,
    base: Arc<Mutex<String>>,
}

async fn fake_handler(
    State(fake): State<Fake>,
    uri: Uri,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    let form = url::form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    fake.seen.lock().unwrap().push(Captured {
        path: uri.path().to_string(),
        headers,
        form,
    });
    if let Some((status, body)) = fake.reply.lock().unwrap().clone() {
        return (status, axum::Json(body));
    }
    let base = fake.base.lock().unwrap().clone();
    let body = if uri.path() == "/v1/checkout/sessions" {
        json!({"id": "cs_test_1", "object": "checkout.session", "url": format!("{base}/pay/cs_test_1")})
    } else {
        json!({"id": "bps_1", "object": "billing_portal.session", "url": format!("{base}/portal/bps_1")})
    };
    (StatusCode::OK, axum::Json(body))
}

/// Start the fake on a free loopback port. Returns its base URL.
async fn start_fake(fake: &Fake) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    *fake.base.lock().unwrap() = base.clone();
    let app = Router::new()
        .fallback(fake_handler)
        .with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

fn post(path: &str, tenant: Option<Uuid>, body: Value) -> Request<Body> {
    let mut r = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    if let Some(t) = tenant {
        r.extensions_mut().insert(TenantId(t));
    }
    r
}

fn get(path: &str, tenant: Option<Uuid>) -> Request<Body> {
    let mut r = Request::builder()
        .method("GET")
        .uri(path)
        .body(Body::empty())
        .unwrap();
    if let Some(t) = tenant {
        r.extensions_mut().insert(TenantId(t));
    }
    r
}

const OK_URLS: (&str, &str) = (
    "https://app.example.eu/billing/done?session={CHECKOUT_SESSION_ID}",
    "https://app.example.eu/billing",
);

#[tokio::test]
async fn checkout_sends_only_billing_identity_and_returns_the_hosted_page() {
    let f = fx().await;
    let fake = Fake::default();
    let base = start_fake(&fake).await;
    let router = tenant_router(common::state(&f, &base));
    let tenant = f.tenant().await;
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;

    let (st, out) = call(
        &router,
        post(
            "/billing/checkout",
            Some(tenant),
            json!({"plan_id": plan, "success_url": OK_URLS.0, "cancel_url": OK_URLS.1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{out}");
    assert_eq!(out["id"], "cs_test_1");
    assert_eq!(out["url"], format!("{base}/pay/cs_test_1"));

    let seen = fake.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    let c = &seen[0];
    assert_eq!(c.path, "/v1/checkout/sessions");
    assert_eq!(
        c.headers["authorization"],
        format!("Bearer {}", common::STRIPE_KEY)
    );
    assert_eq!(
        c.headers["stripe-version"],
        recon_billing::stripe::API_VERSION
    );
    assert!(
        c.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/x-www-form-urlencoded")
    );
    let want: BTreeMap<&str, String> = BTreeMap::from([
        ("mode", "subscription".to_string()),
        ("client_reference_id", tenant.to_string()),
        ("line_items[0][price]", "price_pro".to_string()),
        ("line_items[0][quantity]", "1".to_string()),
        ("success_url", OK_URLS.0.to_string()),
        ("cancel_url", OK_URLS.1.to_string()),
        ("billing_address_collection", "required".to_string()),
        ("tax_id_collection[enabled]", "true".to_string()),
        (
            "subscription_data[metadata][recon_tenant_id]",
            tenant.to_string(),
        ),
        (
            "subscription_data[metadata][recon_plan_id]",
            plan.to_string(),
        ),
        ("metadata[recon_tenant_id]", tenant.to_string()),
        ("metadata[recon_plan_id]", plan.to_string()),
    ]);
    let got: BTreeMap<&str, String> = c
        .form
        .iter()
        .map(|(k, v)| (k.as_str(), v.clone()))
        .collect();
    assert_eq!(
        got, want,
        "exactly these fields, nothing else (no name, e-mail, tenant name or reconciliation data)"
    );
    f.cleanup().await;
}

#[tokio::test]
async fn return_urls_outside_the_allowlist_are_refused_before_stripe_is_called() {
    let f = fx().await;
    let fake = Fake::default();
    let base = start_fake(&fake).await;
    let router = tenant_router(common::state(&f, &base));
    let tenant = f.tenant().await;
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;

    for bad in [
        "https://evil.example/x",
        "http://app.example.eu/x",
        "https://app.example.eu@evil.example/",
        "javascript:alert(1)",
        "/relative",
    ] {
        let (st, out) = call(
            &router,
            post(
                "/billing/checkout",
                Some(tenant),
                json!({"plan_id": plan, "success_url": bad, "cancel_url": OK_URLS.1}),
            ),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{bad}");
        assert!(
            out["error"]["code"]
                .as_str()
                .unwrap()
                .starts_with("return_url"),
            "{out}"
        );
        let (st, _) = call(
            &router,
            post("/billing/portal", Some(tenant), json!({"return_url": bad})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{bad}");
    }
    // unknown fields and malformed bodies are refused too
    let (st, _) = call(&router, post("/billing/checkout", Some(tenant), json!({"plan_id": plan, "success_url": OK_URLS.0, "cancel_url": OK_URLS.1, "price_id": "price_cheap"}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = call(
        &router,
        post("/billing/checkout", Some(tenant), json!("not an object")),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(
        fake.seen.lock().unwrap().is_empty(),
        "Stripe was never contacted"
    );
    f.cleanup().await;
}

#[tokio::test]
async fn tenant_routes_fail_closed_without_the_tenant_extension() {
    let f = fx().await;
    let fake = Fake::default();
    let base = start_fake(&fake).await;
    let router = tenant_router(common::state(&f, &base));
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    for req in [
        post(
            "/billing/checkout",
            None,
            json!({"plan_id": plan, "success_url": OK_URLS.0, "cancel_url": OK_URLS.1}),
        ),
        post("/billing/portal", None, json!({"return_url": OK_URLS.1})),
        get("/billing/subscription", None),
    ] {
        let (st, out) = call(&router, req).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(out["error"]["code"], "unauthorized");
    }
    assert!(fake.seen.lock().unwrap().is_empty());
    f.cleanup().await;
}

#[tokio::test]
async fn only_purchasable_plans_and_only_tenants_without_a_live_subscription_can_check_out() {
    let f = fx().await;
    let fake = Fake::default();
    let base = start_fake(&fake).await;
    let router = tenant_router(common::state(&f, &base));
    let tenant = f.tenant().await;
    let body =
        |plan: Uuid| json!({"plan_id": plan, "success_url": OK_URLS.0, "cancel_url": OK_URLS.1});

    let good = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    let retired = f
        .plan(PlanSpec {
            code: "old",
            interval: "month",
            price: Some("price_old"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    sqlx::query("UPDATE billing.plan SET valid_to = now() WHERE id = $1")
        .bind(retired)
        .execute(&f.admin)
        .await
        .unwrap();
    let hidden = f
        .plan(PlanSpec {
            code: "custom",
            interval: "month",
            price: Some("price_custom"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    sqlx::query("UPDATE billing.plan SET is_public = false WHERE id = $1")
        .bind(hidden)
        .execute(&f.admin)
        .await
        .unwrap();
    let free = f
        .plan(PlanSpec {
            code: "sandbox",
            interval: "month",
            price: None,
            fallback: true,
            limits: &[(keys::RUNS_PER_MONTH, 1)],
        })
        .await;
    for plan in [retired, hidden, free, Uuid::from_u128(1)] {
        let (st, out) = call(&router, post("/billing/checkout", Some(tenant), body(plan))).await;
        assert_eq!(
            (st, out["error"]["code"].as_str()),
            (StatusCode::NOT_FOUND, Some("plan_not_available")),
            "{plan}"
        );
    }
    assert!(fake.seen.lock().unwrap().is_empty());

    // a returning customer: the earlier Stripe customer is reused and Checkout may save name and address on it
    f.subscription(
        tenant,
        good,
        "canceled",
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        None,
    )
    .await;
    let (st, _) = call(&router, post("/billing/checkout", Some(tenant), body(good))).await;
    assert_eq!(st, StatusCode::OK);
    let c = fake.seen.lock().unwrap()[0].clone();
    assert_eq!(c.form["customer"], format!("cus_{}", tenant.simple()));
    assert_eq!(
        (
            c.form["customer_update[name]"].as_str(),
            c.form["customer_update[address]"].as_str()
        ),
        ("auto", "auto")
    );

    // a live subscription: use the portal instead
    let other = f.tenant().await;
    f.subscription(
        other,
        good,
        "active",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        None,
    )
    .await;
    let (st, out) = call(&router, post("/billing/checkout", Some(other), body(good))).await;
    assert_eq!(
        (st, out["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("already_subscribed"))
    );
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
    f.cleanup().await;
}

#[tokio::test]
async fn the_portal_needs_an_existing_billing_account_and_returns_stripes_session_url() {
    let f = fx().await;
    let fake = Fake::default();
    let base = start_fake(&fake).await;
    let router = tenant_router(common::state(&f, &base));
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    let none = f.tenant().await;
    let (st, out) = call(
        &router,
        post(
            "/billing/portal",
            Some(none),
            json!({"return_url": OK_URLS.1}),
        ),
    )
    .await;
    assert_eq!(
        (st, out["error"]["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("no_billing_account"))
    );

    let tenant = f.tenant().await;
    f.subscription(
        tenant,
        plan,
        "active",
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        None,
    )
    .await;
    let (st, out) = call(
        &router,
        post(
            "/billing/portal",
            Some(tenant),
            json!({"return_url": OK_URLS.1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{out}");
    assert_eq!(out["url"], format!("{base}/portal/bps_1"));
    let c = fake.seen.lock().unwrap()[0].clone();
    assert_eq!(c.path, "/v1/billing_portal/sessions");
    assert_eq!(c.form["customer"], format!("cus_{}", tenant.simple()));
    assert_eq!(c.form["return_url"], OK_URLS.1);
    assert_eq!(c.form.len(), 2);
    f.cleanup().await;
}

#[tokio::test]
async fn provider_failures_become_a_generic_502_without_provider_text() {
    let f = fx().await;
    let fake = Fake::default();
    let base = start_fake(&fake).await;
    let router = tenant_router(common::state(&f, &base));
    let tenant = f.tenant().await;
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10)],
        })
        .await;
    let req = || {
        post(
            "/billing/checkout",
            Some(tenant),
            json!({"plan_id": plan, "success_url": OK_URLS.0, "cancel_url": OK_URLS.1}),
        )
    };

    *fake.reply.lock().unwrap() = Some((
        StatusCode::BAD_REQUEST,
        json!({"error": {"type": "invalid_request_error", "code": "resource_missing", "message": "No such price: 'price_pro' for jane@example.com"}}),
    ));
    let (st, out) = call(&router, req()).await;
    assert_eq!(
        (st, out["error"]["code"].as_str()),
        (StatusCode::BAD_GATEWAY, Some("billing_provider_error"))
    );
    assert!(
        !out.to_string().contains("jane@example.com") && !out.to_string().contains("price_pro")
    );

    // 200 with a body we cannot use, and a redirect URL on another scheme
    *fake.reply.lock().unwrap() = Some((StatusCode::OK, json!({"unexpected": true})));
    assert_eq!(call(&router, req()).await.0, StatusCode::BAD_GATEWAY);
    *fake.reply.lock().unwrap() = Some((
        StatusCode::OK,
        json!({"id": "cs_1", "url": "javascript:alert(1)"}),
    ));
    assert_eq!(call(&router, req()).await.0, StatusCode::BAD_GATEWAY);

    // unreachable provider
    let dead = tenant_router(common::state(&f, "http://127.0.0.1:1"));
    let (st, out) = call(&dead, req()).await;
    assert_eq!(
        (st, out["error"]["code"].as_str()),
        (StatusCode::BAD_GATEWAY, Some("billing_provider_error"))
    );
    f.cleanup().await;
}

#[tokio::test]
async fn the_overview_shows_plan_limits_usage_and_invoices_of_the_caller_only() {
    let f = fx().await;
    let state = common::state(&f, "http://127.0.0.1:1");
    let billing = state.billing().clone();
    let router = tenant_router(state);
    let plan = f
        .plan(PlanSpec {
            code: "pro",
            interval: "month",
            price: Some("price_pro"),
            fallback: false,
            limits: &[(keys::RUNS_PER_MONTH, 10), (keys::USERS, 3)],
        })
        .await;
    let tenant = f.tenant().await;
    let now = time::OffsetDateTime::now_utc();
    let start = (now - time::Duration::days(3))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    let end = (now + time::Duration::days(27))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    f.subscription(tenant, plan, "active", &start, &end, None)
        .await;
    sqlx::query("INSERT INTO billing.invoice_ref(tenant_id, provider_invoice_id, number, amount_minor, currency, status, hosted_url, provider_event_created) VALUES ($1, 'in_ov1', 'INV-1', 4900, 'EUR', 'paid', 'https://invoice.stripe.com/i/x', now())")
        .bind(tenant)
        .execute(&f.admin)
        .await
        .unwrap();
    billing
        .check_and_consume(tenant, keys::RUNS_PER_MONTH, 4, "r1")
        .await
        .unwrap();
    let stranger = f.tenant().await;

    let (st, out) = call(&router, get("/billing/subscription", Some(tenant))).await;
    assert_eq!(st, StatusCode::OK, "{out}");
    assert_eq!(out["plan"]["code"], "pro");
    assert_eq!(out["plan"]["display_key"], "billing.plan.pro");
    assert_eq!(
        (
            out["status"].as_str(),
            out["access"].as_str(),
            out["source"].as_str()
        ),
        (Some("active"), Some("full"), Some("subscription"))
    );
    assert_eq!(out["limits"], json!({"runs_per_month": 10, "users": 3}));
    assert_eq!(out["usage"], json!({"runs_per_month": 4}));
    assert_eq!(out["invoices"][0]["number"], "INV-1");
    assert_eq!(out["invoices"][0]["amount_minor"], 4900);
    assert!(out["period"]["start"].is_string() && out["cancel_at_period_end"] == false);

    let (st, out) = call(&router, get("/billing/subscription", Some(stranger))).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        (out["access"].as_str(), out["plan"].is_null()),
        (Some("none"), true)
    );
    assert_eq!(
        (
            out["usage"].as_object().unwrap().len(),
            out["invoices"].as_array().unwrap().len()
        ),
        (0, 0)
    );
    f.cleanup().await;
}
