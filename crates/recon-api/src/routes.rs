//! Route handlers.
//!
//! Commands (POST) go through `AppState::w` only; queries (GET) through `AppState::r` only.
//! Every command: requires `Idempotency-Key` (R-API-1), appends a ledger event in the same transaction and
//! returns `X-Commit-Seq` (R-API-2). Every read returns `X-Data-Watermark` (R-API-3) and honours `X-Min-Seq`.

use crate::{AppState, auth::Principal, error::ApiError};
use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use recon_store::{Actor, WriteTx, bridge};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

const H_COMMIT_SEQ: HeaderName = HeaderName::from_static("x-commit-seq");
const H_MIN_SEQ: HeaderName = HeaderName::from_static("x-min-seq");
const H_WATERMARK: HeaderName = HeaderName::from_static("x-data-watermark");
const H_IDEMPOTENCY: HeaderName = HeaderName::from_static("idempotency-key");
const H_REPLAYED: HeaderName = HeaderName::from_static("idempotent-replayed");

pub async fn healthz() -> &'static str {
    "ok"
}

pub async fn readyz(State(s): State<AppState>) -> Response {
    let (w, r) = (s.w.ping().await.is_ok(), s.r.ping().await.is_ok());
    let status = if w && r {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let up = |b: bool| if b { "ok" } else { "down" };
    (status, Json(json!({"w": up(w), "r": up(r)}))).into_response()
}

// ---------------------------------------------------------------- validation (no external crates)

fn valid_source_type(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn valid_object_uri(s: &str) -> bool {
    (s.starts_with("s3://") || s.starts_with("https://"))
        && s.len() <= 2048
        && !s
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
}

fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<u32>().ok());
    let (Some(y), Some(m), Some(d)) = (num(0..4), num(5..7), num(8..10)) else {
        return false;
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    y >= 1900 && (1..=dim).contains(&d)
}

// ---------------------------------------------------------------- POST /v1/batches (command, W)

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewBatch {
    source_type: String,
    object_uri: String,
    sha256: String,
    period_start: Option<String>,
    period_end: Option<String>,
}

fn idempotency_key(h: &HeaderMap) -> Result<String, ApiError> {
    let v = h
        .get(H_IDEMPOTENCY)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            ApiError::bad_request(
                "idempotency_key_required",
                "the Idempotency-Key header is required",
            )
        })?;
    if v.is_empty() || v.len() > 200 || !v.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ApiError::bad_request(
            "idempotency_key_invalid",
            "Idempotency-Key must be 1-200 visible ASCII characters",
        ));
    }
    Ok(v.to_string())
}

fn with_commit_seq(status: StatusCode, seq: i64, body: Value, replayed: bool) -> Response {
    let mut res = (status, Json(body)).into_response();
    res.headers_mut()
        .insert(H_COMMIT_SEQ, HeaderValue::from(seq));
    if replayed {
        res.headers_mut()
            .insert(H_REPLAYED, HeaderValue::from_static("true"));
    }
    res
}

/// Claim `key` for this request inside `tx`. The unique key serialises concurrent requests with the same key: the
/// loser waits for the winner's commit, then gets `Some(stored response)` to return as a replay (R-API-1).
/// `None` means the caller owns the key and must call [`finish_idempotent`] before committing.
async fn begin_idempotent(
    tx: &mut WriteTx,
    tenant: Uuid,
    key: &str,
    request_sha: &[u8],
) -> Result<Option<Response>, ApiError> {
    let inserted = sqlx::query("INSERT INTO api.idempotency_key(tenant_id, key, request_sha256) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(tenant)
        .bind(key)
        .bind(request_sha)
        .execute(tx.conn())
        .await?
        .rows_affected();
    if inserted == 1 {
        return Ok(None);
    }
    let (stored_sha, status, stored): (Vec<u8>, Option<i32>, Option<Value>) =
        sqlx::query_as("SELECT request_sha256, response_status, response_body FROM api.idempotency_key WHERE tenant_id=$1 AND key=$2")
            .bind(tenant)
            .bind(key)
            .fetch_one(tx.conn())
            .await?;
    if stored_sha.as_slice() != request_sha {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "idempotency_key_reuse",
            "this Idempotency-Key was used with a different request body",
        ));
    }
    let (Some(status), Some(stored)) = (status, stored) else {
        return Err(ApiError::internal());
    };
    let seq = stored["commit_seq"]
        .as_i64()
        .ok_or_else(ApiError::internal)?;
    let code = u16::try_from(status)
        .ok()
        .and_then(|c| StatusCode::from_u16(c).ok())
        .ok_or_else(ApiError::internal)?;
    Ok(Some(with_commit_seq(code, seq, stored["body"].clone(), true)))
}

/// Store the response under the key claimed by [`begin_idempotent`], in the same transaction.
async fn finish_idempotent(
    tx: &mut WriteTx,
    tenant: Uuid,
    key: &str,
    commit_seq: i64,
    status: StatusCode,
    body: &Value,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE api.idempotency_key SET response_status=$3, response_body=$4 WHERE tenant_id=$1 AND key=$2")
        .bind(tenant)
        .bind(key)
        .bind(i32::from(status.as_u16()))
        .bind(json!({"commit_seq": commit_seq, "body": body}))
        .execute(tx.conn())
        .await?;
    Ok(())
}

pub async fn create_batch(
    State(s): State<AppState>,
    principal: Principal,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    principal.require("batches:write")?;
    let key = idempotency_key(&headers)?;

    let raw: Value = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("invalid_json", "request body must be a JSON object"))?;
    let request_sha = recon_evidence::payload_sha256(&raw).map_err(|_| {
        ApiError::bad_request("invalid_json", "request body cannot be canonicalised")
    })?;
    let req: NewBatch = serde_json::from_value(raw)
        .map_err(|_| ApiError::bad_request("invalid_body", "body must contain source_type, object_uri, sha256 and optional period_start, period_end"))?;

    if !valid_source_type(&req.source_type) {
        return Err(ApiError::bad_request(
            "invalid_source_type",
            "source_type must match [a-z0-9_]{1,64}",
        ));
    }
    if !valid_object_uri(&req.object_uri) {
        return Err(ApiError::bad_request(
            "invalid_object_uri",
            "object_uri must be an s3:// or https:// URI",
        ));
    }
    let sha = hex::decode(&req.sha256)
        .ok()
        .filter(|b| b.len() == 32)
        .ok_or_else(|| {
            ApiError::bad_request("invalid_sha256", "sha256 must be 64 hex characters")
        })?;
    for d in [&req.period_start, &req.period_end].into_iter().flatten() {
        if !valid_date(d) {
            return Err(ApiError::bad_request(
                "invalid_period",
                "period dates must be valid YYYY-MM-DD dates",
            ));
        }
    }

    let tenant = principal.tenant;
    let mut tx = s.w.begin_tenant(tenant).await?;

    if let Some(replay) = begin_idempotent(&mut tx, tenant, &key, request_sha.as_slice()).await? {
        return Ok(replay);
    }

    let created: Option<(Uuid,)> = sqlx::query_as(
        "INSERT INTO ingest.source_batch(tenant_id, source_type, period_start, period_end, object_uri, sha256, status)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,'registered')
         ON CONFLICT (tenant_id, source_type, sha256) DO NOTHING RETURNING id",
    )
    .bind(tenant)
    .bind(&req.source_type)
    .bind(&req.period_start)
    .bind(&req.period_end)
    .bind(&req.object_uri)
    .bind(sha.as_slice())
    .fetch_optional(tx.conn())
    .await?;

    let (batch_id, status_text, deduplicated) = match created {
        Some((id,)) => (id, "registered".to_string(), false),
        None => {
            let (id, st): (Uuid, String) = sqlx::query_as("SELECT id, status FROM ingest.source_batch WHERE tenant_id=$1 AND source_type=$2 AND sha256=$3")
                .bind(tenant)
                .bind(&req.source_type)
                .bind(sha.as_slice())
                .fetch_one(tx.conn())
                .await?;
            (id, st, true)
        }
    };

    // Ledger payload carries opaque ids and non-personal metadata only (R-PRIV-1).
    let event = if deduplicated {
        "batch.registration_deduplicated"
    } else {
        "batch.registered"
    };
    let appended = tx
        .append_event(
            event,
            Actor::ApiKey(&principal.key_id.to_string()),
            &json!({"batch_id": batch_id, "source_type": req.source_type, "sha256": req.sha256}),
        )
        .await?;

    let (code, body) = if deduplicated {
        (
            StatusCode::OK,
            json!({"id": batch_id, "status": status_text, "deduplicated": true}),
        )
    } else {
        (
            StatusCode::CREATED,
            json!({"id": batch_id, "status": status_text, "deduplicated": false}),
        )
    };
    finish_idempotent(&mut tx, tenant, &key, appended.seq, code, &body).await?;
    tx.commit().await?;
    Ok(with_commit_seq(code, appended.seq, body, false))
}

// ---------------------------------------------------------------- POST /v1/recon/runs (command, W)

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewRun {
    rule_pack_id: Uuid,
    batch_ids: Vec<Uuid>,
}

const MAX_RUN_BATCHES: usize = 100;

/// Queue a reconciliation run pinned to one rule pack and a set of parsed batches. The engine worker picks it up
/// asynchronously (Architecture.md §4). `min_seq` is the ledger sequence of the `recon.run_queued` event written in
/// this transaction: when R has applied it, the run and every record it references are visible on R.
pub async fn create_run(
    State(s): State<AppState>,
    principal: Principal,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    principal.require("runs:write")?;
    let key = idempotency_key(&headers)?;
    let raw: Value = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("invalid_json", "request body must be a JSON object"))?;
    let request_sha = recon_evidence::payload_sha256(&raw).map_err(|_| {
        ApiError::bad_request("invalid_json", "request body cannot be canonicalised")
    })?;
    let req: NewRun = serde_json::from_value(raw).map_err(|_| {
        ApiError::bad_request(
            "invalid_body",
            "body must contain rule_pack_id (uuid) and batch_ids (array of uuid)",
        )
    })?;
    let mut distinct = req.batch_ids.clone();
    distinct.sort_unstable();
    distinct.dedup();
    if distinct.is_empty() || distinct.len() != req.batch_ids.len() || distinct.len() > MAX_RUN_BATCHES {
        return Err(ApiError::bad_request(
            "invalid_batch_ids",
            format!("batch_ids must hold 1 to {MAX_RUN_BATCHES} distinct ids"),
        ));
    }

    let tenant = principal.tenant;
    let mut tx = s.w.begin_tenant(tenant).await?;
    if let Some(replay) = begin_idempotent(&mut tx, tenant, &key, request_sha.as_slice()).await? {
        return Ok(replay);
    }

    let pack: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM rules.rule_pack WHERE id = $1")
        .bind(req.rule_pack_id)
        .fetch_optional(tx.conn())
        .await?;
    if pack.is_none() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unknown_rule_pack",
            "rule_pack_id does not name a rule pack",
        ));
    }
    // RLS limits this to the caller's tenant: another tenant's batch id looks exactly like a missing one.
    let found: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, status FROM ingest.source_batch WHERE tenant_id = $1 AND id = ANY($2)",
    )
    .bind(tenant)
    .bind(&req.batch_ids)
    .fetch_all(tx.conn())
    .await?;
    if found.len() != req.batch_ids.len() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unknown_batch",
            "every batch id must name a batch of this tenant",
        ));
    }
    if found.iter().any(|(_, st)| st != "parsed") {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "batch_not_parsed",
            "every batch must be parsed before it can be reconciled",
        ));
    }

    let (run_id,): (Uuid,) = sqlx::query_as("SELECT uuidv7()")
        .fetch_one(tx.conn())
        .await?;
    let appended = tx
        .append_event(
            "recon.run_queued",
            Actor::ApiKey(&principal.key_id.to_string()),
            &json!({"run_id": run_id, "rule_pack_id": req.rule_pack_id, "batch_ids": req.batch_ids}),
        )
        .await?;
    sqlx::query(
        "INSERT INTO recon.run(id, tenant_id, rule_pack_id, input_batch_ids, min_seq, status)
         VALUES ($1,$2,$3,$4,$5,'queued')",
    )
    .bind(run_id)
    .bind(tenant)
    .bind(req.rule_pack_id)
    .bind(&req.batch_ids)
    .bind(appended.seq)
    .execute(tx.conn())
    .await?;

    let (code, body) = (StatusCode::ACCEPTED, json!({"id": run_id, "status": "queued"}));
    finish_idempotent(&mut tx, tenant, &key, appended.seq, code, &body).await?;
    tx.commit().await?;
    Ok(with_commit_seq(code, appended.seq, body, false))
}

// ---------------------------------------------------------------- reads (queries, R)

/// Apply `X-Min-Seq` (if present) via the bridge; then the caller queries R.
async fn honour_min_seq(s: &AppState, tenant: Uuid, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(v) = headers.get(H_MIN_SEQ) else {
        return Ok(());
    };
    let min_seq: i64 = v
        .to_str()
        .ok()
        .and_then(|t| t.parse().ok())
        .filter(|n| *n >= 0)
        .ok_or_else(|| {
            ApiError::bad_request(
                "invalid_min_seq",
                "X-Min-Seq must be a non-negative integer",
            )
        })?;
    bridge::wait_for_seq(&s.r, tenant, min_seq, s.bridge_wait).await?;
    Ok(())
}

async fn watermark_header(s: &AppState, tenant: Uuid, res: &mut Response) {
    // best effort: a failure to compute the watermark must not fail an otherwise successful read
    if let Ok(Some(w)) = bridge::watermark_micros(&s.r, tenant).await {
        res.headers_mut().insert(H_WATERMARK, HeaderValue::from(w));
    }
}

/// `(id, source_type, status, failure_reason, period_start, period_end, created_at)` as read from `ingest.source_batch`.
type BatchRow = (Uuid, String, String, Option<String>, Option<String>, Option<String>, String);

pub async fn get_batch(
    State(s): State<AppState>,
    principal: Principal,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    principal.require("batches:read")?;
    honour_min_seq(&s, principal.tenant, &headers).await?;
    let mut tx = s.r.begin_tenant(principal.tenant).await?;
    let row: Option<BatchRow> = sqlx::query_as(
        "SELECT id, source_type, status, failure_reason, period_start::text, period_end::text,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')
           FROM ingest.source_batch WHERE tenant_id = $1 AND id = $2",
    )
    .bind(principal.tenant)
    .bind(id)
    .fetch_optional(tx.conn())
    .await?;
    tx.finish().await?;
    let (id, source_type, status, failure_reason, ps, pe, created_at) = row.ok_or_else(ApiError::not_found)?;
    let mut res = Json(json!({"id": id, "source_type": source_type, "status": status, "failure_reason": failure_reason, "period_start": ps, "period_end": pe, "created_at": created_at})).into_response();
    watermark_header(&s, principal.tenant, &mut res).await;
    Ok(res)
}

/// `(id, status, rule_pack_id, input_batch_ids, min_seq, started_at, finished_at, finding_count)`.
type RunRow = (Uuid, String, Uuid, Vec<Uuid>, i64, Option<String>, Option<String>, i64);

pub async fn get_run(
    State(s): State<AppState>,
    principal: Principal,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    principal.require("runs:read")?;
    honour_min_seq(&s, principal.tenant, &headers).await?;
    let mut tx = s.r.begin_tenant(principal.tenant).await?;
    let row: Option<RunRow> = sqlx::query_as(
        "SELECT r.id, r.status, r.rule_pack_id, r.input_batch_ids, r.min_seq,
                to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
                to_char(r.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
                (SELECT count(*) FROM recon.finding f WHERE f.tenant_id = r.tenant_id AND f.run_id = r.id)
           FROM recon.run r WHERE r.tenant_id = $1 AND r.id = $2",
    )
    .bind(principal.tenant)
    .bind(id)
    .fetch_optional(tx.conn())
    .await?;
    tx.finish().await?;
    let (id, status, rule_pack_id, batch_ids, min_seq, started_at, finished_at, finding_count) =
        row.ok_or_else(ApiError::not_found)?;
    let mut res = Json(json!({
        "id": id, "status": status, "rule_pack_id": rule_pack_id, "batch_ids": batch_ids, "min_seq": min_seq,
        "started_at": started_at, "finished_at": finished_at, "finding_count": finding_count,
    }))
    .into_response();
    watermark_header(&s, principal.tenant, &mut res).await;
    Ok(res)
}

/// `(id, check_code, severity, rule_id, detail, created_at, jurisdiction, summary, rule_citation)`.
type FindingRow = (Uuid, String, String, Uuid, Value, String, String, String, String);

#[derive(Deserialize)]
pub struct FindingsQuery {
    limit: Option<i64>,
    after: Option<Uuid>,
    check_code: Option<String>,
    run_id: Option<Uuid>,
}

pub async fn list_findings(
    State(s): State<AppState>,
    principal: Principal,
    headers: HeaderMap,
    Query(q): Query<FindingsQuery>,
) -> Result<Response, ApiError> {
    principal.require("findings:read")?;
    honour_min_seq(&s, principal.tenant, &headers).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let mut tx = s.r.begin_tenant(principal.tenant).await?;
    // Wire shape follows `proj.finding_view` (DatabaseInfo.md): the citation comes from the rule the finding
    // cites, the summary is the engine's neutral statement of disagreement (R-ENG-3). `rule_id` and `detail`
    // carry the evidence behind it.
    let rows: Vec<FindingRow> = sqlx::query_as(
        "SELECT f.id, f.check_code, f.severity, f.rule_id, f.detail,
                to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
                p.jurisdiction, coalesce(f.detail->>'statement', ''), ru.source_ref || ' — ' || ru.article
           FROM recon.finding f
           JOIN rules.rule ru ON ru.id = f.rule_id
           JOIN rules.rule_pack p ON p.id = ru.pack_id
          WHERE f.tenant_id = $1 AND ($2::uuid IS NULL OR f.id < $2) AND ($3::text IS NULL OR f.check_code = $3)
            AND ($5::uuid IS NULL OR f.run_id = $5)
          ORDER BY f.id DESC LIMIT $4",
    )
    .bind(principal.tenant)
    .bind(q.after)
    .bind(q.check_code)
    .bind(limit)
    .bind(q.run_id)
    .fetch_all(tx.conn())
    .await?;
    tx.finish().await?;
    let next_after = if i64::try_from(rows.len()).is_ok_and(|n| n == limit) {
        rows.last().map(|r| r.0)
    } else {
        None
    };
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, check_code, severity, rule_id, detail, created_at, jurisdiction, summary, rule_citation)| json!({"finding_id": id, "check_code": check_code, "severity": severity, "jurisdiction": jurisdiction, "summary": summary, "rule_citation": rule_citation, "rule_id": rule_id, "detail": detail, "created_at": created_at}))
        .collect();
    let mut res = Json(json!({"items": items, "next_after": next_after})).into_response();
    watermark_header(&s, principal.tenant, &mut res).await;
    Ok(res)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_validated_including_leap_years() {
        assert!(valid_date("2024-02-29"));
        assert!(!valid_date("2023-02-29"));
        assert!(!valid_date("1900-02-29"));
        assert!(valid_date("2000-02-29"));
        assert!(!valid_date("2026-13-01"));
        assert!(!valid_date("2026-04-31"));
        assert!(!valid_date("2026-4-1"));
        assert!(!valid_date("26-04-01"));
        assert!(!valid_date("2026/04/01"));
        assert!(!valid_date("１２３４-01-01"));
    }

    #[test]
    fn source_type_and_uri_rules() {
        assert!(valid_source_type("erp_ledger"));
        assert!(!valid_source_type("ERP"));
        assert!(!valid_source_type(""));
        assert!(!valid_source_type(&"a".repeat(65)));
        assert!(valid_object_uri("s3://bucket/key"));
        assert!(valid_object_uri("https://eu.example/x"));
        assert!(!valid_object_uri("http://insecure/x"));
        assert!(!valid_object_uri("s3://a b"));
        assert!(!valid_object_uri("file:///etc/passwd"));
    }
}
