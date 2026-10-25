//! Offline verifier for exported ledger chains.
//!
//! `recon-verify chain <file.ndjson | -> [--expect-head <64-hex>]`
//!
//! Input: one `recon_evidence::ChainEvent` JSON object per line, ordered by `seq`, starting at `seq = 1`.
//! Exit codes: 0 = chain valid (and head matches `--expect-head` if given), 1 = INVALID (prints why),
//! 2 = usage or input error. The verifier shares no code with the database; it implements the frozen hash
//! layout in `recon-evidence` (version 1).
//!
//! **A hash chain cannot reveal truncation of its tail**: a prefix of a valid chain is itself valid. Pin the head you
//! expect (e.g. the `anchor_hash` covered by an RFC 3161 time-stamp token, DatabaseInfo.md `ledger.chain_anchor`)
//! with `--expect-head`; without it a VALID result only proves internal consistency of what was supplied.

use recon_evidence::{ChainEvent, verify_chain};
use std::io::{BufRead, BufReader, Read};
use std::process::ExitCode;

fn parse(reader: impl Read) -> Result<Vec<ChainEvent>, String> {
    let mut events = Vec::new();
    for (i, line) in BufReader::new(reader).lines().enumerate() {
        let line = line.map_err(|e| format!("line {}: read error: {e}", i + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        events.push(
            serde_json::from_str::<ChainEvent>(&line)
                .map_err(|e| format!("line {}: {e}", i + 1))?,
        );
    }
    Ok(events)
}

fn run(args: &[String]) -> Result<ExitCode, String> {
    const USAGE: &str = "usage: recon-verify chain <file.ndjson | -> [--expect-head <64-hex>]";
    let (path, expect_head) = match args {
        [cmd, path] if cmd == "chain" => (path, None),
        [cmd, path, flag, head] if cmd == "chain" && flag == "--expect-head" => {
            if head.len() != 64 || !head.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("--expect-head must be 64 hex characters".into());
            }
            (path, Some(head.to_ascii_lowercase()))
        }
        _ => return Err(USAGE.into()),
    };
    let events = if path == "-" {
        parse(std::io::stdin())?
    } else {
        parse(std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?)?
    };
    if events.is_empty() {
        return Err("no events in input".into());
    }
    match verify_chain(&events) {
        Ok(head) => {
            let head: String = head.iter().map(|b| format!("{b:02x}")).collect();
            if let Some(expected) = expect_head.filter(|e| *e != head) {
                println!(
                    "INVALID head {head} does not match expected {expected} (tail truncated, extended, or wrong chain)"
                );
                return Ok(ExitCode::from(1));
            }
            println!("VALID events={} head={head}", events.len());
            Ok(ExitCode::SUCCESS)
        }
        Err(e) => {
            println!("INVALID {e}");
            Ok(ExitCode::from(1))
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => code,
        Err(msg) => {
            eprintln!("{msg}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parse_skips_blank_lines_and_reports_line_numbers() {
        let good = r#"{"tenant_id":"11111111-1111-7111-8111-111111111111","seq":1,"id":"0198a000-0000-7000-8000-000000000001","event_type":"e","actor_type":"system","actor_ref":"s","occurred_at_micros":1,"payload_sha256":"00","prev_hash":"00","hash":"00"}"#;
        assert_eq!(
            parse(format!("{good}\n\n{good}\n").as_bytes())
                .unwrap()
                .len(),
            2
        );
        let err = parse(format!("{good}\nnot json\n").as_bytes()).unwrap_err();
        assert!(err.starts_with("line 2:"), "{err}");
    }
}
