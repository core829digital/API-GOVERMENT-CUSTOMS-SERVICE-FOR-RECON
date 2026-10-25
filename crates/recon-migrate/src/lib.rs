//! The only DDL path for clusters W and R (Rules R-DB-8, R-DB-9).
//!
//! * Migrations live in `migrations/w/` and `migrations/r/`, named `NNNN_name.sql`, and must start with
//!   `-- target: w` / `-- target: r` matching their directory.
//! * Each migration runs in one transaction; applied checksums are recorded in `public._recon_migrations`
//!   (never in a replicated schema). Editing an applied migration is an error.
//! * Logical replication does not carry DDL: additive changes must reach **R first**, then W.
//!   `up` is per cluster; callers (deploy tooling / CI) are responsible for that ordering, and
//!   `fingerprint`/`compare` detect divergence. A W-first mistake stalls the whole subscription
//!   (verified, Progress.md §7).

use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::path::{Path, PathBuf};

/// Which cluster a migration is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Target {
    W,
    R,
}

impl Target {
    /// Directory and header token.
    pub fn token(self) -> &'static str {
        match self {
            Target::W => "w",
            Target::R => "r",
        }
    }
}

/// A migration file loaded from disk.
#[derive(Clone, Debug)]
pub struct Migration {
    pub version: String,
    pub name: String,
    pub target: Target,
    pub sql: String,
    pub checksum: [u8; 32],
}

/// Errors from the migration tool.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("invalid migration file {path}: {reason}")]
    BadFile { path: PathBuf, reason: String },
    #[error("migration {version} was modified after being applied (checksum mismatch)")]
    ChecksumMismatch { version: String },
    #[error("applied migration {version} has no file on disk")]
    MissingFile { version: String },
    #[error("invalid identifier `{0}` (allowed: [a-z_][a-z0-9_]*)")]
    BadIdentifier(String),
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |source| Error::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Load and validate the migrations for `target` from `<root>/<w|r>/`.
pub fn discover(root: &Path, target: Target) -> Result<Vec<Migration>, Error> {
    let dir = root.join(target.token());
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(io(&dir))? {
        let path = entry.map_err(io(&dir))?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let bad = |reason: &str| Error::BadFile {
            path: path.clone(),
            reason: reason.to_string(),
        };
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| bad("non-utf8 name"))?;
        let (version, name) = stem
            .split_once('_')
            .ok_or_else(|| bad("expected NNNN_name.sql"))?;
        if version.len() != 4 || !version.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad("version must be 4 digits"));
        }
        let sql = std::fs::read_to_string(&path).map_err(io(&path))?;
        let first = sql.lines().next().unwrap_or_default().trim();
        if first != format!("-- target: {}", target.token()) {
            return Err(bad(
                "first line must be `-- target: <w|r>` matching its directory",
            ));
        }
        let checksum: [u8; 32] = Sha256::digest(sql.as_bytes()).into();
        out.push(Migration {
            version: version.to_string(),
            name: name.to_string(),
            target,
            sql,
            checksum,
        });
    }
    out.sort_by(|a, b| a.version.cmp(&b.version));
    for w in out.windows(2) {
        if w[0].version == w[1].version {
            return Err(Error::BadFile {
                path: dir.join(format!("{}_{}.sql", w[1].version, w[1].name)),
                reason: format!("duplicate version {}", w[1].version),
            });
        }
    }
    Ok(out)
}

/// Connect with a small pool.
pub async fn connect(url: &str) -> Result<PgPool, Error> {
    Ok(PgPoolOptions::new().max_connections(2).connect(url).await?)
}

const LOCK_KEY: i64 = 7_263_001;

/// Apply pending migrations (all, or up to and including `to`). Returns versions applied now.
pub async fn up(
    pool: &PgPool,
    migrations: &[Migration],
    to: Option<&str>,
) -> Result<Vec<String>, Error> {
    let mut conn = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(LOCK_KEY)
        .execute(&mut *conn)
        .await?;
    let result = up_locked(&mut conn, migrations, to).await;
    let unlock = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(LOCK_KEY)
        .execute(&mut *conn)
        .await;
    let applied = result?;
    unlock?;
    Ok(applied)
}

async fn up_locked(
    conn: &mut sqlx::PgConnection,
    migrations: &[Migration],
    to: Option<&str>,
) -> Result<Vec<String>, Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS public._recon_migrations (
           version text PRIMARY KEY, name text NOT NULL, checksum bytea NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now())",
    )
    .execute(&mut *conn)
    .await?;
    let rows: Vec<(String, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM public._recon_migrations")
            .fetch_all(&mut *conn)
            .await?;
    for (v, c) in &rows {
        match migrations.iter().find(|m| &m.version == v) {
            None => return Err(Error::MissingFile { version: v.clone() }),
            Some(m) if m.checksum.as_slice() != c.as_slice() => {
                return Err(Error::ChecksumMismatch { version: v.clone() });
            }
            Some(_) => {}
        }
    }
    let mut applied = Vec::new();
    for m in migrations {
        if rows.iter().any(|(v, _)| v == &m.version) {
            continue;
        }
        if to.is_some_and(|t| m.version.as_str() > t) {
            break;
        }
        let mut tx = sqlx::Connection::begin(&mut *conn).await?;
        // Safety of the SQL *text* (not memory safety): it comes from version-controlled migration files that pass
        // review and CI (L4/L10); no runtime or user input is ever interpolated into it.
        sqlx::raw_sql(sqlx::AssertSqlSafe(m.sql.clone()))
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO public._recon_migrations(version, name, checksum) VALUES ($1,$2,$3)",
        )
        .bind(&m.version)
        .bind(&m.name)
        .bind(m.checksum.as_slice())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        applied.push(m.version.clone());
    }
    Ok(applied)
}

/// Schemas whose structure must be identical on W and R.
pub const REPLICATED_SCHEMAS: [&str; 7] = [
    "core", "ingest", "recon", "rules", "ledger", "privacy", "ops",
];

/// SHA-256 (hex) over the column catalogue of the replicated schemas
/// (`schema.table.column:type:nullable`, sorted). Equal on W and R when additive DDL was applied correctly.
pub async fn fingerprint(pool: &PgPool) -> Result<String, Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type||':'||is_nullable
           FROM information_schema.columns
          WHERE table_schema = ANY($1)
          ORDER BY table_schema, table_name, column_name",
    )
    .bind(
        REPLICATED_SCHEMAS
            .iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<_>>(),
    )
    .fetch_all(pool)
    .await?;
    let mut h = Sha256::new();
    for (line,) in rows {
        h.update(line.as_bytes());
        h.update(b"\n");
    }
    Ok(hex::encode(h.finalize()))
}

fn ident(s: &str) -> Result<&str, Error> {
    let ok = !s.is_empty()
        && s.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b == b'_')
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if ok {
        Ok(s)
    } else {
        Err(Error::BadIdentifier(s.to_string()))
    }
}

fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Create the logical subscription on R (idempotent: no-op if it exists).
/// Options match DatabaseInfo.md §5: `copy_data=true, failover=true, streaming=parallel, origin=none`.
pub async fn subscribe(
    r: &PgPool,
    w_conninfo: &str,
    name: &str,
    publication: &str,
) -> Result<bool, Error> {
    let (name, publication) = (ident(name)?, ident(publication)?);
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT subname::text FROM pg_subscription WHERE subname = $1")
            .bind(name)
            .fetch_optional(r)
            .await?;
    if exists.is_some() {
        return Ok(false);
    }
    let sql = format!(
        "CREATE SUBSCRIPTION {name} CONNECTION {} PUBLICATION {publication} \
         WITH (copy_data = true, failover = true, streaming = parallel, origin = none)",
        literal(w_conninfo)
    );
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(r).await?;
    Ok(true)
}

/// `ALTER SUBSCRIPTION … REFRESH PUBLICATION` — required after new published tables appear.
pub async fn refresh(r: &PgPool, name: &str) -> Result<(), Error> {
    let name = ident(name)?;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "ALTER SUBSCRIPTION {name} REFRESH PUBLICATION"
    )))
    .execute(r)
    .await?;
    Ok(())
}

/// Process exit status for a fingerprint comparison: success iff identical.
pub fn compare_exit(w: &str, r: &str) -> std::process::ExitCode {
    if w == r {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::from(1)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_reject_injection() {
        assert!(ident("recon_r_sub").is_ok());
        assert!(ident("x; drop table y").is_err());
        assert!(ident("Upper").is_err());
        assert!(ident("").is_err());
        assert!(ident("1abc").is_err());
    }

    #[test]
    fn literal_escapes_quotes() {
        assert_eq!(literal("host=a password='x'"), "'host=a password=''x'''");
    }

    #[test]
    fn repo_migrations_are_well_formed_for_both_targets() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../migrations");
        for t in [Target::W, Target::R] {
            let m = discover(&root, t).unwrap();
            assert!(!m.is_empty());
            assert_eq!(m[0].version, "0001");
            // contiguous numbering without gaps
            for (i, mig) in m.iter().enumerate() {
                assert_eq!(
                    mig.version,
                    format!("{:04}", i + 1),
                    "gap or reorder in {:?}",
                    t
                );
            }
        }
    }

    #[test]
    fn header_must_match_directory() {
        let dir = std::env::temp_dir().join(format!("recon-mig-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("w")).unwrap();
        std::fs::write(dir.join("w/0001_x.sql"), "-- target: r\nselect 1;").unwrap();
        assert!(matches!(
            discover(&dir, Target::W),
            Err(Error::BadFile { .. })
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
