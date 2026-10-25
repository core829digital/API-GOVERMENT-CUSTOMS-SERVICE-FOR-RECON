// L7 - Ledger integrity (Workflow.md 4.2; R-DB-6, R-PRIV-5).
// Runs `cargo test -p recon-store --test pair` and `cargo test -p recon-evidence` and requires the named tests to be
// PRESENT and `ok`: chain verifies on W and R, forks and mutation rejected, concurrent appends serialise, independent
// verifier vectors, and the RFC 3161 anchor tests against the test TSA. Waivers cannot cover L7.
// Options: --cargo <path> (default cargo), --test-args "<extra cargo test args>", --transcript <file> (tests only;
// a transcript holds the output of both invocations), --skip-reason <text> (ignored for release builds).
import { runLibtestGate, skipOrNull } from '../lib/proc.mjs';

export const id = 'L7';
export const name = 'Ledger integrity';

export const STORE_TESTS = Object.freeze([
  'rust_hash_layout_matches_sql_and_chain_verifies_on_w_and_r',
  'application_roles_cannot_fork_or_mutate_the_ledger_and_own_nothing',
  'concurrent_appends_for_one_tenant_serialise_into_a_valid_chain',
]);
export const EVIDENCE_TESTS = Object.freeze([
  'detects_field_tamper_prev_break_gap_and_cross_tenant',
  'verifies_independent_vector_including_non_ascii_lengths',
  'anchor_token_verifies_against_test_tsa',
  'anchor_rejects_wrong_hash',
  'anchor_rejects_tampered_token',
]);

export async function run(ctx) {
  const skipped = skipOrNull(ctx, id);
  if (skipped) return skipped;
  return runLibtestGate(ctx, {
    id,
    name,
    groups: [
      { label: 'recon-store pair', args: ['-p', 'recon-store', '--test', 'pair'], tests: [...STORE_TESTS] },
      { label: 'recon-evidence', args: ['-p', 'recon-evidence'], tests: [...EVIDENCE_TESTS] },
    ],
  });
}
