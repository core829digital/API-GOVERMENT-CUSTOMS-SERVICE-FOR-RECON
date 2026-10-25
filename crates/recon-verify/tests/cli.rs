//! End-to-end tests of the verifier binary using the independently computed vector from recon-evidence
//! (computed with Node's crypto from the documented layout, not with this code).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::{Command, Stdio};

const T: &str = "11111111-1111-7111-8111-111111111111";
const E1: &str = "aece54ccea84a7ac7f088676bfe9c9449859f1a5c1b3e5d033d77f0df5fae035";
const E2: &str = "9a1a243d505eac68887d2970cccf8633804132de904acd18d98851131deb68db";
const P1: &str = "2bfd14f43d17fc7cea24e0917a8879b4b2f880b8baeec1b9d90fbaad655e71bd";
const P2: &str = "363379742f80b51bdb9206579af7754911543079b9399cb3fc315fb199f476e8";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn line1() -> String {
    format!(
        r#"{{"tenant_id":"{T}","seq":1,"id":"0198a000-0000-7000-8000-000000000001","event_type":"test.event","actor_type":"system","actor_ref":"sys","occurred_at_micros":1790000000123456,"payload_sha256":"{P1}","prev_hash":"{ZERO}","hash":"{E1}"}}"#
    )
}

fn line2(actor_ref: &str) -> String {
    format!(
        r#"{{"tenant_id":"{T}","seq":2,"id":"0198a000-0000-7000-8000-000000000002","event_type":"ünïcode.event","actor_type":"user","actor_ref":"{actor_ref}","occurred_at_micros":1790000001000000,"payload_sha256":"{P2}","prev_hash":"{E1}","hash":"{E2}"}}"#
    )
}

/// Runs the binary with `input` on stdin; returns (exit code, stdout).
fn verify(input: &str, extra: &[&str]) -> (i32, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_recon-verify"))
        .args(["chain", "-"])
        .args(extra)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap(),
        String::from_utf8(out.stdout).unwrap(),
    )
}

#[test]
fn valid_chain_passes_and_prints_head() {
    let (code, out) = verify(&format!("{}\n{}\n", line1(), line2("u-é")), &[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains(&format!("head={E2}")), "{out}");
}

#[test]
fn tampered_field_is_invalid() {
    let (code, out) = verify(&format!("{}\n{}\n", line1(), line2("evil")), &[]);
    assert_eq!(code, 1);
    assert!(out.contains("hash mismatch at seq 2"), "{out}");
}

#[test]
fn truncated_tail_is_only_detected_when_the_expected_head_is_pinned() {
    // a prefix of a valid chain is itself a valid chain...
    let (code, _) = verify(&format!("{}\n", line1()), &[]);
    assert_eq!(
        code, 0,
        "documented limitation: a bare hash chain cannot show truncation"
    );
    // ...unless the caller pins the anchored head
    let (code, out) = verify(&format!("{}\n", line1()), &["--expect-head", E2]);
    assert_eq!(code, 1);
    assert!(out.contains("does not match expected"), "{out}");
    // full chain with the right pinned head passes; wrong pinned head fails
    let full = format!("{}\n{}\n", line1(), line2("u-é"));
    assert_eq!(verify(&full, &["--expect-head", E2]).0, 0);
    assert_eq!(verify(&full, &["--expect-head", E1]).0, 1);
}

#[test]
fn usage_and_input_errors_exit_2() {
    assert_eq!(verify("", &[]).0, 2, "empty input");
    assert_eq!(verify("not json\n", &[]).0, 2, "malformed line");
    assert_eq!(verify(&line1(), &["--expect-head", "xyz"]).0, 2, "bad hex");
}
