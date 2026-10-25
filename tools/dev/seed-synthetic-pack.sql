-- DEV/TEST ONLY. A SYNTHETIC rule pack so the engine can be exercised end to end.
-- It makes NO regulatory statement: `source_ref` is a placeholder URN, not a citation, and the pack is named and
-- attributed as a fixture. It must never be loaded into a customer-facing environment. Real packs live in rules/
-- and need human compliance approval (Rules.md R-RULES-2); none of them defines the C1-* rules the engine cites.
--
--   psql -h localhost -p 5440 -U postgres -d recon_w -f tools/dev/seed-synthetic-pack.sql
--
-- Run as a superuser on W only (rules.* is replicated to R). Idempotent.
WITH pack AS (
  INSERT INTO rules.rule_pack(name, jurisdiction, version, content_sha256, valid_from, last_reviewed, reviewed_by)
  VALUES ('synthetic-fixture', 'XX', '0.0.0', sha256('synthetic-fixture 0.0.0'::bytea), DATE '2000-01-01', DATE '2026-10-25',
          'SYNTHETIC FIXTURE - not reviewed, not a legal source')
  ON CONFLICT (name, jurisdiction, version) DO NOTHING
  RETURNING id
), pack_id AS (
  SELECT id FROM pack
  UNION ALL
  SELECT id FROM rules.rule_pack WHERE name = 'synthetic-fixture' AND jurisdiction = 'XX' AND version = '0.0.0'
  LIMIT 1
)
INSERT INTO rules.rule(pack_id, code, source_ref, article, accessed_on)
SELECT pack_id.id, c.code, 'urn:recon:synthetic-fixture', 'none (fixture)', DATE '2026-10-25'
  FROM pack_id,
       (VALUES ('C1-NO-CLEARANCE-RECORD'), ('C1-NOT-ACCEPTED'), ('C1-AMOUNT-MISMATCH'), ('C1-ORPHAN-CLEARANCE')) AS c(code)
ON CONFLICT (pack_id, code) DO NOTHING;

SELECT p.id AS rule_pack_id, count(r.*) AS rules
  FROM rules.rule_pack p JOIN rules.rule r ON r.pack_id = p.id
 WHERE p.name = 'synthetic-fixture' GROUP BY p.id;
