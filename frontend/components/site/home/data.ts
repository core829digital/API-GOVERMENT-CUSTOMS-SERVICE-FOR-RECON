/**
 * Decorative synthetic records shared by the hero illustration and the finding anatomy. None of these identifiers
 * exists anywhere; they are shaped like real ones so the picture reads as a ledger. References, hashes and amounts
 * are data and are not translated; the clearance status is a catalog key (`home.field.status.*`) so the word
 * shown is in the visitor's language.
 */
export interface LedgerRow {
  /** Invoice reference on both sides. */
  ref: string;
  /** Truncated record hash on the books side. */
  booksHash: string;
  /** Truncated record hash on the authority side. */
  authorityHash: string;
  /** Amount in integer minor units, as the canonical record stores it. */
  amount: string;
  /** Clearance status on the authority side, as a key of `home.field.status`. */
  status: "cleared" | "rejected";
  /** The one row whose two sides disagree under the cited rule. */
  flagged?: true;
}

/** The one pair whose sides disagree: the books say issued, the authority's copy holds another status. */
export const FLAGGED: LedgerRow = {
  ref: "INV-0004",
  booksHash: "7d21…c0e4",
  authorityHash: "b07e…41d8",
  amount: "76250",
  status: "rejected",
  flagged: true,
};

export const ROWS: readonly LedgerRow[] = [
  { ref: "INV-0001", booksHash: "3c1f…9ab2", authorityHash: "3c1f…9ab2", amount: "128400", status: "cleared" },
  { ref: "INV-0002", booksHash: "e482…07d1", authorityHash: "e482…07d1", amount: "5900", status: "cleared" },
  { ref: "INV-0003", booksHash: "91ab…f3c6", authorityHash: "91ab…f3c6", amount: "240000", status: "cleared" },
  FLAGGED,
  { ref: "INV-0005", booksHash: "0f5a…6e19", authorityHash: "0f5a…6e19", amount: "31000", status: "cleared" },
  { ref: "INV-0006", booksHash: "c8d3…2b70", authorityHash: "c8d3…2b70", amount: "9875", status: "cleared" },
];

/** Placeholder rule identifier for the synthetic fixture. Not a real citation. */
export const SYNTHETIC_RULE = "urn:recon:synthetic-fixture";

export const CHECK_CODE = "C1";
export const HASH_ALGORITHM = "sha256";
