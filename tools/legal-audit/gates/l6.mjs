// L6 - Erasure & retention behaviour (Workflow.md 4.2; R-PRIV-3, R-PRIV-5).
// Runs `cargo test -p recon-store --test privacy` and requires the named tests to be PRESENT and `ok`
// (an absent or ignored test is an error: a skipped assertion proves nothing). The tests need the migrated W/R pair
// (RECON_TEST_W_URL / RECON_TEST_R_URL in the environment). Waivers cannot cover L6.
// Options: --cargo <path> (default cargo), --test-args "<extra cargo test args>", --transcript <file> (tests only),
// --skip-reason <text> (path-filter skip; ignored for release builds).
import { runLibtestGate, skipOrNull } from '../lib/proc.mjs';

export const id = 'L6';
export const name = 'Erasure & retention behaviour';

export const REQUIRED_TESTS = Object.freeze([
  'crypto_shred_makes_plaintext_unrecoverable_on_w_and_r',
  'legal_hold_blocks_purge',
  'purge_appends_ledger_event',
  'erasure_deferral_is_ledgered',
  'shred_keeps_chain_verifiable_on_w_and_r',
]);

export async function run(ctx) {
  const skipped = skipOrNull(ctx, id);
  if (skipped) return skipped;
  return runLibtestGate(ctx, {
    id,
    name,
    groups: [{ label: 'recon-store privacy', args: ['-p', 'recon-store', '--test', 'privacy'], tests: [...REQUIRED_TESTS] }],
  });
}
