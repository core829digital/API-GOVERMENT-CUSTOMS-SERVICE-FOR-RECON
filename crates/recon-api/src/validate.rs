//! Strict input validation and sanitisation (Rules R-API-7, R-API-8).
//!
//! Every function either returns the parsed value or a 400 [`ApiError`] with a stable machine-readable code and a
//! fixed message: **no rejected input is ever echoed back** (R-API-5, and the `<script>`-in-an-error-body case of
//! R-API-9). Nothing is coerced: out-of-range, mis-cased or oddly encoded input is refused, not repaired.
//!
//! Sanitisation is rejection, not rewriting. Text is never HTML-escaped on the way in (storage holds what the
//! client sent; output encoding is the renderer's job, see the response headers in [`crate::http`]). Every string a
//! request can carry in v1 is additionally restricted to ASCII by its own grammar, and ASCII is NFC by
//! definition, so no Unicode normalisation library is needed. A future free-text field MUST call
//! [`reject_unsafe_chars`] and add NFC handling (reject or normalise) before it is accepted.

use crate::error::ApiError;
use uuid::Uuid;

/// Source kinds the engine can reconcile: `erp_ledger` carries the books (C1 `invoice` records) and
/// `authority_clearance` the authority-side copy (C1 `clearance_status` records). The database stores any text; the
/// API accepts only kinds the engine has a parser/check for, so a new source type is a code change.
pub const SOURCE_TYPES: [&str; 2] = ["erp_ledger", "authority_clearance"];
/// URI schemes allowed for `object_uri` (EU object storage, HTTPS). `file:`, `data:`, `javascript:`, `http:` … are refused.
pub const OBJECT_URI_SCHEMES: [&str; 2] = ["https", "s3"];
pub const MAX_OBJECT_URI_LEN: usize = 2048;
pub const MAX_IDEMPOTENCY_KEY_LEN: usize = 128;
pub const MAX_CHECK_CODE_LEN: usize = 64;
pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 200;
/// Accepted calendar range for period dates (inclusive years).
pub const MIN_YEAR: u32 = 1990;
pub const MAX_YEAR: u32 = 2100;
/// Longest accepted `X-Min-Seq` text (`i64::MAX` has 19 digits).
pub const MAX_MIN_SEQ_LEN: usize = 19;

fn invalid(code: &'static str, message: &'static str) -> ApiError {
    ApiError::bad_request(code, message)
}

/// Characters that never belong in an identifier or text field: NUL and other C0/C1 controls (incl. TAB/LF/CR),
/// DEL, zero-width and invisible formatting characters, the BOM, and all Unicode bidirectional override/embedding/
/// isolate characters (they reorder text on screen: "Trojan Source").
pub fn is_unsafe_char(c: char) -> bool {
    c.is_control() // C0 (U+0000-001F), DEL, C1 (U+0080-009F)
        || matches!(c,
            '\u{00AD}'          // soft hyphen
            | '\u{061C}'        // Arabic letter mark (bidi)
            | '\u{180E}'        // Mongolian vowel separator
            | '\u{200B}'..='\u{200F}' // zero-width space/non-joiner/joiner, LRM, RLM
            | '\u{202A}'..='\u{202E}' // LRE RLE PDF LRO RLO
            | '\u{2060}'..='\u{2064}' // word joiner, invisible operators
            | '\u{2066}'..='\u{2069}' // LRI RLI FSI PDI
            | '\u{FEFF}'        // BOM / zero-width no-break space
        )
}

/// Reject (400 `invalid_characters`) any string that contains an [`is_unsafe_char`]. No field allows multi-line
/// text in v1, so TAB and LF are refused as well.
pub fn reject_unsafe_chars(s: &str) -> Result<(), ApiError> {
    if s.chars().any(is_unsafe_char) {
        return Err(invalid(
            "invalid_characters",
            "input contains control, invisible or bidirectional-override characters",
        ));
    }
    Ok(())
}

pub fn source_type(s: &str) -> Result<&'static str, ApiError> {
    reject_unsafe_chars(s)?;
    SOURCE_TYPES.iter().copied().find(|t| *t == s).ok_or_else(|| {
        invalid(
            "invalid_source_type",
            "source_type is not one of the supported source types",
        )
    })
}

fn is_uri_byte(b: u8) -> bool {
    // RFC 3986: unreserved / reserved / "%" — i.e. printable ASCII without space and without  " < > \ ^ ` { | }
    b.is_ascii_alphanumeric() || b"-._~:/?#[]@!$&'()*+,;=%".contains(&b)
}

fn is_host_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_'
}

/// `https://host[:port]/…` or `s3://bucket/…`: lower-case allowed scheme, ASCII-only RFC 3986 characters,
/// well-formed `%XX` escapes, a plain host (no `user:pass@` credentials, no IP-literal brackets), at most
/// [`MAX_OBJECT_URI_LEN`] bytes.
pub fn object_uri(s: &str) -> Result<(), ApiError> {
    reject_unsafe_chars(s)?;
    let bad = || invalid("invalid_object_uri", "object_uri must be an https:// or s3:// URI");
    if s.len() > MAX_OBJECT_URI_LEN || !s.bytes().all(is_uri_byte) {
        return Err(bad());
    }
    let (scheme, rest) = s.split_once("://").ok_or_else(bad)?;
    if !OBJECT_URI_SCHEMES.contains(&scheme) {
        return Err(bad());
    }
    let bytes = s.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'%' {
            let ok = bytes
                .get(i + 1..i + 3)
                .is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit));
            if !ok {
                return Err(bad());
            }
        }
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    let port_ok = port.is_none_or(|p| {
        scheme == "https" && !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit())
    });
    if host.is_empty()
        || host.len() > 253
        || !host.bytes().all(is_host_byte)
        || host.starts_with(['.', '-'])
        || !port_ok
    {
        return Err(bad());
    }
    Ok(())
}

/// Exactly 64 lower-case hexadecimal characters (a SHA-256 digest).
pub fn sha256_hex(s: &str) -> Result<[u8; 32], ApiError> {
    reject_unsafe_chars(s)?;
    let bad = || invalid("invalid_sha256", "sha256 must be 64 lower-case hexadecimal characters");
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(bad());
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out).map_err(|_| bad())?;
    Ok(out)
}

/// A real calendar date; ordered chronologically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Date {
    year: u32,
    month: u32,
    day: u32,
}

fn days_in_month(year: u32, month: u32) -> Option<u32> {
    let leap = (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400);
    Some(match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    })
}

/// `YYYY-MM-DD`, ASCII digits only, a date that exists, year within [`MIN_YEAR`], [`MAX_YEAR`].
pub fn calendar_date(s: &str) -> Result<Date, ApiError> {
    reject_unsafe_chars(s)?;
    let bad = || invalid("invalid_period", "period dates must be real calendar dates (YYYY-MM-DD) from 1990 to 2100");
    let b = s.as_bytes();
    let shape_ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !shape_ok {
        return Err(bad());
    }
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<u32>().ok());
    let (Some(year), Some(month), Some(day)) = (num(0..4), num(5..7), num(8..10)) else {
        return Err(bad());
    };
    let dim = days_in_month(year, month).ok_or_else(bad)?;
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) || !(1..=dim).contains(&day) {
        return Err(bad());
    }
    Ok(Date { year, month, day })
}

/// Optional period bounds: each a [`calendar_date`]; when both are present `start <= end`.
pub fn period(start: Option<&str>, end: Option<&str>) -> Result<(), ApiError> {
    let start = start.map(calendar_date).transpose()?;
    let end = end.map(calendar_date).transpose()?;
    if let (Some(a), Some(b)) = (start, end)
        && a > b
    {
        return Err(invalid("invalid_period", "period_start must not be after period_end"));
    }
    Ok(())
}

/// A UUID in the canonical 36-character hyphenated form (either case). The `simple`, braced and `urn:` spellings
/// that `Uuid::parse_str` also accepts are refused.
pub fn uuid(s: &str, code: &'static str) -> Result<Uuid, ApiError> {
    let bad = || invalid(code, "identifier must be a UUID");
    let b = s.as_bytes();
    let shape_ok = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    if !shape_ok {
        return Err(bad());
    }
    Uuid::parse_str(s).map_err(|_| bad())
}

/// `Idempotency-Key`: 1..=[`MAX_IDEMPOTENCY_KEY_LEN`] characters of `[A-Za-z0-9._:~-]`.
pub fn idempotency_key(s: &str) -> Result<&str, ApiError> {
    reject_unsafe_chars(s)?;
    let ok = !s.is_empty()
        && s.len() <= MAX_IDEMPOTENCY_KEY_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:~-".contains(&b));
    if ok {
        Ok(s)
    } else {
        Err(invalid(
            "idempotency_key_invalid",
            "Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 . _ : ~ -",
        ))
    }
}

/// `check_code` filter: 1..=[`MAX_CHECK_CODE_LEN`] characters of `[A-Za-z0-9._-]`.
pub fn check_code(s: &str) -> Result<&str, ApiError> {
    reject_unsafe_chars(s)?;
    let ok = !s.is_empty()
        && s.len() <= MAX_CHECK_CODE_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    if ok {
        Ok(s)
    } else {
        Err(invalid("invalid_check_code", "check_code must be 1-64 characters of A-Z a-z 0-9 . _ -"))
    }
}

/// Page size: decimal digits only, `1..=`[`MAX_LIMIT`]. Out-of-range values are refused, not clamped.
pub fn limit(s: &str) -> Result<u32, ApiError> {
    reject_unsafe_chars(s)?;
    s.bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| s.parse::<u32>().ok())
        .flatten()
        .filter(|n| (1..=MAX_LIMIT).contains(n))
        .ok_or_else(|| invalid("invalid_limit", "limit must be an integer from 1 to 200"))
}

/// `X-Min-Seq`: decimal digits only, at most [`MAX_MIN_SEQ_LEN`] of them, fits `i64`.
pub fn min_seq(s: &str) -> Result<i64, ApiError> {
    (!s.is_empty() && s.len() <= MAX_MIN_SEQ_LEN && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse::<i64>().ok())
        .flatten()
        .ok_or_else(|| invalid("invalid_min_seq", "X-Min-Seq must be a non-negative integer"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn code(r: Result<impl std::fmt::Debug, ApiError>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn unsafe_characters_are_rejected_in_every_field_before_its_grammar() {
        for c in [
            "\u{0}", "\u{1}", "\t", "\n", "\r", "\u{7f}", "\u{85}", "\u{9f}", "\u{200b}", "\u{200d}", "\u{200e}",
            "\u{202a}", "\u{202e}", "\u{2066}", "\u{2069}", "\u{feff}", "\u{2060}", "\u{ad}",
        ] {
            assert_eq!(code(source_type(&format!("erp{c}ledger"))), "invalid_characters", "{c:?}");
            assert_eq!(code(object_uri(&format!("https://a.example/{c}"))), "invalid_characters");
            assert_eq!(code(idempotency_key(&format!("k{c}"))), "invalid_characters");
            assert_eq!(code(check_code(&format!("C1{c}"))), "invalid_characters");
            assert_eq!(code(calendar_date(&format!("2026-01-0{c}"))), "invalid_characters");
            assert_eq!(code(sha256_hex(&format!("{c}{}", "a".repeat(63)))), "invalid_characters");
        }
    }

    #[test]
    fn rejection_messages_never_echo_input() {
        let hostile = "<script>alert(1)</script>'; DROP TABLE x;--";
        let errors = [
            source_type(hostile).unwrap_err(),
            object_uri(hostile).unwrap_err(),
            sha256_hex(hostile).unwrap_err(),
            calendar_date(hostile).unwrap_err(),
            uuid(hostile, "invalid_id").unwrap_err(),
            idempotency_key(hostile).unwrap_err(),
            check_code(hostile).unwrap_err(),
            limit(hostile).unwrap_err(),
            min_seq(hostile).unwrap_err(),
        ];
        for e in errors {
            assert!(!e.message.contains("script") && !e.message.contains("DROP"), "{}", e.message);
        }
    }

    #[test]
    fn source_type_is_a_closed_set() {
        assert_eq!(source_type("erp_ledger").unwrap(), "erp_ledger");
        assert_eq!(source_type("authority_clearance").unwrap(), "authority_clearance");
        for bad in ["", "ERP_LEDGER", "erp_ledger ", "vat_return", "erp_ledger\u{0}", "<script>"] {
            assert!(source_type(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn object_uri_allows_only_https_and_s3() {
        for ok in [
            "https://eu.example/x",
            "https://eu.example:8443/a/b?c=d#e",
            "s3://bucket-name/key/with%20escapes",
            "https://a.example/'%3B%20DROP%20TABLE%20x%3B--;a=b",
        ] {
            object_uri(ok).unwrap();
        }
        for bad in [
            "http://insecure/x",
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "file:///etc/passwd",
            "ftp://x/y",
            "HTTPS://eu.example/x",
            "https://user:pw@eu.example/x",
            "https://eu.example/a b",
            "https://eu.example/<x>",
            "https://eu.example/%zz",
            "https://eu.example/%4",
            "https://",
            "https:///path",
            "https://.eu/x",
            "https://[::1]/x",
            "https://eu.example:/x",
            "https://eu.example:99999a/x",
            "s3://bucket:80/x",
            "https://exämple.eu/x",
            "//eu.example/x",
            "",
        ] {
            assert!(object_uri(bad).is_err(), "{bad:?}");
        }
        assert!(object_uri(&format!("https://a.example/{}", "a".repeat(MAX_OBJECT_URI_LEN))).is_err());
        assert!(object_uri(&format!("https://a.example/{}", "a".repeat(MAX_OBJECT_URI_LEN - 18))).is_ok());
    }

    #[test]
    fn sha256_is_64_lowercase_hex() {
        assert_eq!(sha256_hex(&"ab".repeat(32)).unwrap()[0], 0xab);
        for bad in [&"AB".repeat(32), &"a".repeat(63), &"a".repeat(65), &"g".repeat(64), "", &"é".repeat(32)] {
            assert!(sha256_hex(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn dates_are_real_calendar_dates_within_bounds() {
        for ok in ["2024-02-29", "2000-02-29", "1990-01-01", "2100-12-31", "2026-04-30"] {
            calendar_date(ok).unwrap();
        }
        for bad in [
            "2023-02-29", "1900-02-29", "2026-13-01", "2026-04-31", "2026-00-10", "2026-01-00", "2026-4-1", "26-04-01",
            "2026/04/01", "１２３４-01-01", "1989-12-31", "2101-01-01", "2026-01-01T00:00:00Z", " 2026-01-01", "+026-01-01",
        ] {
            assert!(calendar_date(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn period_requires_start_not_after_end() {
        period(None, None).unwrap();
        period(Some("2026-01-01"), None).unwrap();
        period(None, Some("2026-01-31")).unwrap();
        period(Some("2026-01-31"), Some("2026-01-31")).unwrap();
        period(Some("2026-01-01"), Some("2026-12-31")).unwrap();
        assert_eq!(code(period(Some("2026-02-01"), Some("2026-01-31"))), "invalid_period");
        assert_eq!(code(period(Some("2025-12-31"), Some("2026-13-01"))), "invalid_period");
    }

    #[test]
    fn uuids_are_canonical_only() {
        let id = "0190c1f2-7a3b-7c4d-8e5f-0123456789ab";
        assert_eq!(uuid(id, "invalid_id").unwrap().to_string(), id);
        uuid(&id.to_uppercase(), "invalid_id").unwrap();
        for bad in [
            "",
            "not-a-uuid",
            "0190c1f27a3b7c4d8e5f0123456789ab",
            "{0190c1f2-7a3b-7c4d-8e5f-0123456789ab}",
            "urn:uuid:0190c1f2-7a3b-7c4d-8e5f-0123456789ab",
            "0190c1f2-7a3b-7c4d-8e5f-0123456789a",
            "0190c1f2-7a3b-7c4d-8e5f-0123456789abc",
            "0190c1f2-7a3b-7c4d-8e5f-0123456789ag",
            "../etc/passwd",
        ] {
            assert_eq!(code(uuid(bad, "invalid_id")), "invalid_id", "{bad:?}");
        }
    }

    #[test]
    fn idempotency_key_charset_and_length() {
        idempotency_key("a").unwrap();
        idempotency_key(&"A1._:~-".repeat(19)[..128]).unwrap();
        assert!(idempotency_key("").is_err());
        assert!(idempotency_key(&"a".repeat(129)).is_err());
        for bad in ["a b", "a/b", "a;b", "a\"b", "é", "a,b", "<x>"] {
            assert!(idempotency_key(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn limit_and_min_seq_are_bounded_not_clamped() {
        assert_eq!(limit("1").unwrap(), 1);
        assert_eq!(limit("200").unwrap(), 200);
        for bad in ["0", "201", "-1", "+5", "5.0", "", "1e2", "99999999999999999999", " 5"] {
            assert!(limit(bad).is_err(), "{bad:?}");
        }
        assert_eq!(min_seq("0").unwrap(), 0);
        assert_eq!(min_seq("9223372036854775807").unwrap(), i64::MAX);
        for bad in ["", "-1", "9223372036854775808", "12345678901234567890", "1 ", "0x10"] {
            assert!(min_seq(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn check_code_charset() {
        check_code("C1").unwrap();
        for bad in ["", "C 1", "C1;", &"c".repeat(65), "<b>"] {
            assert!(check_code(bad).is_err(), "{bad:?}");
        }
    }
}
