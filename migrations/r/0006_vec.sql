-- target: r
-- pgvector schema. REQUIRES the pgvector extension (0.8.x). Not validated locally: no pgvector in the local test binaries.
-- Generated from DatabaseInfo.md DDL blocks (validated on PostgreSQL 18.6, see Progress.md §7). Edit DatabaseInfo.md first, then regenerate.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE vec.model (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL, version text NOT NULL, dims int NOT NULL,
  hosting text NOT NULL, dpa_ref text,
  UNIQUE (name, version)
);
-- One embedding table PER MODEL VERSION (dimension fixed at creation). Dimension below is a placeholder until D-4 is decided.
CREATE TABLE vec.legal_chunk_emb_v1 (
  chunk_id uuid PRIMARY KEY,                 -- = rules.legal_chunk.id
  model_id uuid NOT NULL REFERENCES vec.model(id),
  jurisdiction text NOT NULL,
  embedding halfvec(1024) NOT NULL           -- placeholder dims
);
CREATE INDEX ON vec.legal_chunk_emb_v1 USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
