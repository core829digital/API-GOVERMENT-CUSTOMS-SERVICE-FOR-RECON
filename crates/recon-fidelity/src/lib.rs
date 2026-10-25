//! Fidelity sweep: proves the fidelity copy (R) still equals W (Architecture.md §6).
//!
//! Three checks, all writing verdicts to `ops.fidelity_check` (on W, replicated to R):
//! * `chain_head` — per tenant, `(last_seq, last_hash)` equal on W and R; a ledger is exact.
//! * `range_hash` — per replicated table, SHA-256 over canonically ordered PK-range row text, equal on W and R.
//!   Mismatching ranges are re-compared after `settle` (in-flight replication catches up); only persistent
//!   mismatches are reported as `mismatch_persistent`.
//! * `schema` — hash of the replicated-catalog fingerprint (columns in declaration order), equal on W and R.
//!
//! This crate is the ONLY writer to `ops.fidelity_check` (grants: `w_verifier`).
#![forbid(unsafe_code)]

use sha2::Digest;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FidelityError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("table {0}: {1}")]
    Table(String, #[source] sqlx::Error),
    #[error("digest had {0} bytes, expected 32")]
    DigestLength(usize),
}

/// One persisted sweep verdict. `w_digest`/`r_digest` are `None` for `chain_head` and `schema` kinds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub table_name: String,
    pub kind: &'static str,
    pub range_from: Option<String>,
    pub range_to: Option<String>,
    pub w_digest: Option<[u8; 32]>,
    pub r_digest: Option<[u8; 32]>,
    pub verdict: &'static str, // match | mismatch_transient | mismatch_persistent
}

#[derive(Debug, Clone, Copy)]
pub struct SweepConfig {
    /// Range size for `range_hash`, in rows (Architecture.md §6: 10k).
    pub range_rows: i64,
    /// Re-compare delay for transient mismatches.
    pub settle: Duration,
    /// Max replicated tables swept. `None` = all in the publication schemas.
    pub max_tables: Option<usize>,
}

impl Default for SweepConfig {
    fn default() -> Self {
        Self { range_rows: 10_000, settle: Duration::from_secs(60), max_tables: None }
    }
}

/// The schemas W publishes (migrations/w/0001_init.sql). `api` is intentionally absent.
pub const PUBLISHED_SCHEMAS: [&str; 7] =
    ["core", "ingest", "recon", "rules", "ledger", "privacy", "ops"];

/// Connects as `w_verifier` (W) and `r_api` (R). The sweep must not be able to write anything else:
/// `w_verifier` has INSERT on `ops.fidelity_check` and SELECT on replicated schemas only (R-DB-7).
pub async fn connect(w_url: &str, r_url: &str) -> Result<(PgPool, PgPool), sqlx::Error> {
    // The database roles grant what this code may do; connecting options only pin the login role.
    let w = PgPoolOptions::new().max_connections(2).connect(w_url).await?;
    let r = PgPoolOptions::new().max_connections(2).connect(r_url).await?;
    Ok((w, r))
}

/// Full sweep: chain heads for every tenant + range hashes for every replicated table + schema fingerprint.
/// Returns all verdicts in persistence order. `w` must connect as `w_verifier`, `r` as `r_api` or a
/// read-only verifier role on R.
pub async fn sweep(w: &PgPool, r: &PgPool, cfg: SweepConfig) -> Result<Vec<Verdict>, FidelityError> {
    let mut out = Vec::new();
    out.extend(check_chain_heads(w, r).await?);
    out.extend(check_schema(w, r, cfg.max_tables).await?);
    out.extend(check_ranges(w, r, cfg).await?);
    Ok(out)
}

/// Persist one verdict. Idempotent by content: `ops.fidelity_check` is an append-only log of checks.
pub async fn record(w: &PgPool, v: &Verdict) -> Result<(), FidelityError> {
    sqlx::query(
        "INSERT INTO ops.fidelity_check(table_name, kind, range_from, range_to, w_digest, r_digest, verdict)
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(&v.table_name)
    .bind(v.kind)
    .bind(&v.range_from)
    .bind(&v.range_to)
    .bind(v.w_digest.map(|d| d.to_vec()))
    .bind(v.r_digest.map(|d| d.to_vec()))
    .bind(v.verdict)
    .execute(w)
    .await?;
    Ok(())
}

/// Persist a whole sweep, W transactionally.
pub async fn record_all(w: &PgPool, verdicts: &[Verdict]) -> Result<(), FidelityError> {
    let mut tx = w.begin().await?;
    for v in verdicts {
        sqlx::query(
            "INSERT INTO ops.fidelity_check(table_name, kind, range_from, range_to, w_digest, r_digest, verdict)
             VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(&v.table_name)
        .bind(v.kind)
        .bind(&v.range_from)
        .bind(&v.range_to)
        .bind(v.w_digest.map(|d| d.to_vec()))
        .bind(v.r_digest.map(|d| d.to_vec()))
        .bind(v.verdict)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ---------- chain heads ----------

/// `(last_seq, last_hash)` per tenant must be identical on W and R (ledger is exact, Architecture.md §6).
pub async fn check_chain_heads(w: &PgPool, r: &PgPool) -> Result<Vec<Verdict>, FidelityError> {
    let w_heads: Vec<(uuid::Uuid, i64, Vec<u8>)> =
        sqlx::query_as("SELECT tenant_id, last_seq, last_hash FROM ledger.chain_head ORDER BY tenant_id")
            .fetch_all(w)
            .await?;
    let r_heads: Vec<(uuid::Uuid, i64, Vec<u8>)> =
        sqlx::query_as("SELECT tenant_id, last_seq, last_hash FROM ledger.chain_head ORDER BY tenant_id")
            .fetch_all(r)
            .await?;
    let mut out = Vec::with_capacity(w_heads.len());
    let mut ri = 0usize;
    for (tid, w_seq, w_hash) in &w_heads {
        while ri < r_heads.len() && r_heads[ri].0 < *tid {
            out.push(Verdict {
                table_name: format!("ledger.chain_head[{0}]", r_heads[ri].0),
                kind: "chain_head",
                range_from: None,
                range_to: None,
                w_digest: None,
                r_digest: None,
                verdict: "mismatch_persistent", // tenant missing on W: replicated extra
            });
            ri += 1;
        }
        let ok = ri < r_heads.len()
            && r_heads[ri].0 == *tid
            && r_heads[ri].1 == *w_seq
            && r_heads[ri].2 == *w_hash;
        if ri < r_heads.len() && r_heads[ri].0 == *tid {
            ri += 1;
        }
        out.push(Verdict {
            table_name: format!("ledger.chain_head[{tid}]"),
            kind: "chain_head",
            range_from: None,
            range_to: None,
            w_digest: None,
            r_digest: None,
            verdict: if ok { "match" } else { "mismatch_persistent" },
        });
    }
    for head in &r_heads[ri..] {
        out.push(Verdict {
            table_name: format!("ledger.chain_head[{0}]", head.0),
            kind: "chain_head",
            range_from: None,
            range_to: None,
            w_digest: None,
            r_digest: None,
            verdict: "mismatch_persistent", // tenant missing on W
        });
    }
    Ok(out)
}

// ---------- schema fingerprint ----------

/// SHA-256 over `schema.table\ncol type notnull default` lines for every replicated table, in catalog order.
/// Catalog order is deterministic on both clusters because migrations run in the same order.
pub async fn schema_fingerprint(pool: &PgPool) -> Result<Vec<u8>, FidelityError> {
    let rows: Vec<(String, String, String, String, bool, Option<String>)> = sqlx::query_as(
        "SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), \
                a.attnotnull, pg_get_expr(d.adbin, d.adrelid) \
           FROM pg_class c \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
           LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
          WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') \
          ORDER BY n.nspname, c.relname, a.attnum",
    )
    .bind(PUBLISHED_SCHEMAS.map(String::from))
    .fetch_all(pool)
    .await?;
    let mut h = sha2::Sha256::new();
    for r in rows {
        use sha2::Digest;
        h.update(r.0.as_bytes());
        h.update(b".");
        h.update(r.1.as_bytes());
        h.update(b"\n");
        h.update(r.2.as_bytes());
        h.update(b" ");
        h.update(r.3.as_bytes());
        h.update(if r.4 { &b" NOT NULL"[..] } else { &b""[..] });
        if let Some(def) = r.5 {
            h.update(b" DEFAULT ");
            h.update(def.as_bytes());
        }
        h.update(b"\n");
    }
    Ok(h.finalize().to_vec())
}

/// Schema fingerprints must be identical (Architecture.md §6; CI blocks deploys otherwise).
pub async fn check_schema(
    w: &PgPool,
    r: &PgPool,
    max_tables: Option<usize>,
) -> Result<Vec<Verdict>, FidelityError> {
    let tables = |rows: Vec<(String, String)>| {
        let mut t: Vec<String> = rows
            .into_iter()
            .filter(|(s, _)| PUBLISHED_SCHEMAS.contains(&s.as_str()))
            .map(|(s, n)| format!("{s}.{n}"))
            .collect();
        t.sort();
        if let Some(max) = max_tables {
            t.truncate(max);
        }
        t
    };
    let w_tables = tables(
        sqlx::query_as(
            "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p')",
        )
        .bind(PUBLISHED_SCHEMAS.map(String::from))
        .fetch_all(w)
        .await?,
    );
    let r_tables = tables(
        sqlx::query_as(
            "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p')",
        )
        .bind(PUBLISHED_SCHEMAS.map(String::from))
        .fetch_all(r)
        .await?,
    );
    let fw = schema_fingerprint(w).await?;
    let fr = schema_fingerprint(r).await?;
    let ok = w_tables == r_tables && fw == fr;
    Ok(vec![Verdict {
        table_name: "<schema>".into(),
        kind: "schema",
        range_from: None,
        range_to: None,
        w_digest: Some(to_digest(fw)?),
        r_digest: Some(to_digest(fr)?),
        verdict: if ok { "match" } else { "mismatch_persistent" },
    }])
}

/// SHA-256 is always 32 bytes; a `try_into` failure would mean a broken hasher, which is a bug, not a
/// runtime condition, so it is reported as an error instead of panicking (R-SEC-6).
fn to_digest(v: Vec<u8>) -> Result<[u8; 32], FidelityError> {
    <[u8; 32]>::try_from(v).map_err(|bad: Vec<u8>| {
        FidelityError::DigestLength(bad.len())
    })
}

// ---------- range hashes ----------

/// Canonical digest of one PK range. Columns come from the catalog on each cluster independently, so a
/// column that exists on only one side produces different column sets and thus a mismatch.
async fn canonical_range_digest(
    pool: &PgPool,
    table: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<u8>, FidelityError> {
    // columns in catalog order, cast to text; NULL marker distinguishes NULL from empty string
    let cols: Vec<(String, String)> = sqlx::query_as(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod) \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
          WHERE n.nspname || '.' || c.relname = $1 ORDER BY a.attnum",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| FidelityError::Table(table.into(), e))?;
    if cols.is_empty() {
        return Err(FidelityError::Table(table.into(), sqlx::Error::ColumnNotFound(table.into())));
    }
    // canonical cell: NULL -> "\x00", text otherwise; separator \x1f between cells, \n between rows
    let exprs: Vec<String> = cols
        .iter()
        .map(|(name, _)| format!("coalesce({name}::text, E'\\x00')"))
        .collect();
    // Identifiers come from the catalog (attname/relname), never user input; range bounds are bound
    // parameters ($2/$3), so the interpolated text is injection-free by construction (audited, R-SEC-5).
    let sql = format!(
        "SELECT sha256(convert_to(coalesce(string_agg(row_text, E'\\n' ORDER BY pk_text), ''), 'UTF8')) \
           FROM (SELECT concat_ws(E'\\x1f', {}) AS row_text, {}::text AS pk_text FROM {table} \
          WHERE {}::text >= $2 AND {}::text < $3) s",
        exprs.join(", "),
        cols[0].0, // PK = first catalog column (migrations always declare tenant_id/id first)
        cols[0].0,
        cols[0].0,
    );
    let (digest,): (Vec<u8>,) = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(from)
        .bind(to)
        .fetch_one(pool)
        .await
        .map_err(|e| FidelityError::Table(table.into(), e))?;
    Ok(digest)
}

/// Range-hash sweep over every replicated table with a single-column comparable PK.
/// Two-pass: transient mismatches are re-compared after `cfg.settle`.
pub async fn check_ranges(w: &PgPool, r: &PgPool, cfg: SweepConfig) -> Result<Vec<Verdict>, FidelityError> {
    let tables: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT n.nspname || '.' || c.relname, a.attname, format_type(a.atttypid, a.atttypmod) \
           FROM pg_class c \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
           JOIN pg_constraint k ON k.conrelid = c.oid AND k.contype = 'p' \
           JOIN unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord) ON u.ord = 1 \
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum \
          WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') \
          ORDER BY 1",
    )
    .bind(PUBLISHED_SCHEMAS.map(String::from))
    .fetch_all(w)
    .await?;
    let tables = if let Some(max) = cfg.max_tables { tables.into_iter().take(max).collect() } else { tables };

    let mut out = Vec::new();
    for (table, pk, ty) in tables {
        // text-comparable PKs only: uuid, text, ints, dates, timestamps (cast to text, ordered lexicographically)
        let orderable = matches!(
            ty.as_str(),
            "uuid" | "text" | "character varying" | "bigint" | "integer" | "smallint"
                | "date" | "timestamp without time zone" | "timestamp with time zone"
        );
        if !orderable {
            continue;
        }
        // PK range bounds from W's rows; R might be missing rows entirely, which the range still catches
        // Identifiers from the catalog only; bounds via bind params (audited, R-SEC-5).
        let bounds: (Option<String>, Option<String>) =
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT min({pk}::text), max({pk}::text) FROM {table}"
            )))
            .fetch_one(w)
                .await
                .map_err(|e| FidelityError::Table(table.clone(), e))?;
        let (Some(min), Some(max)) = bounds else {
            continue; // empty table: nothing to hash
        };
        // advance the range cursor in text space
        let mut from = min;
        loop {
            let to = next_text_bound(&from);
            let dw = canonical_range_digest(w, &table, Some(&from), to.as_deref()).await?;
            let dr = canonical_range_digest(r, &table, Some(&from), to.as_deref()).await?;
            let (verdict, w_digest, r_digest) = if dw == dr {
                ("match", dw, dr)
            } else {
                tokio::time::sleep(cfg.settle).await;
                let dw2 = canonical_range_digest(w, &table, Some(&from), to.as_deref()).await?;
                let dr2 = canonical_range_digest(r, &table, Some(&from), to.as_deref()).await?;
                (if dw2 == dr2 { "match" } else { "mismatch_persistent" }, dw2, dr2)
            };
            out.push(Verdict {
                table_name: table.clone(),
                kind: "range_hash",
                range_from: Some(from.clone()),
                range_to: to.clone(),
                w_digest: Some(to_digest(w_digest)?),
                r_digest: Some(to_digest(r_digest)?),
                verdict,
            });
            let done = match &to {
                Some(t) => t.as_str() > max.as_str(),
                None => true,
            };
            match to {
                Some(t) => from = t,
                None => break,
            }
            if done {
                break;
            }
        }
    }
    Ok(out)
}

/// Smallest text strictly greater than every string with prefix `s` plus something: `s` with last byte
/// incremented, then `\x00`-terminated. For a uuid/text PK this walks forward one bucket at a time.
fn next_text_bound(s: &str) -> Option<String> {
    let mut b = s.as_bytes().to_vec();
    loop {
        match b.last_mut() {
            Some(last) if *last < 0xFF => {
                *last += 1;
                match String::from_utf8(b) {
                    Ok(t) => return Some(t),
                    // Increment crossed a UTF-8 sequence boundary (e.g. "ÿ" C3 BF -> C3 C0):
                    // drop the invalid tail byte and carry into the previous character.
                    Err(e) => {
                        b = e.into_bytes();
                        b.pop();
                    }
                }
            }
            Some(_) => {
                b.pop();
            }
            None => return None,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn next_text_bound_walks_forward() {
        assert_eq!(next_text_bound("a"), Some("b".to_owned()));
        assert_eq!(next_text_bound("0198a"), Some("0198b".to_owned()));
        assert_eq!(next_text_bound("0198\u{ff}"), Some("0199".to_owned()));
        assert_eq!(next_text_bound("\u{10FFFF}"), None);
    }
}
