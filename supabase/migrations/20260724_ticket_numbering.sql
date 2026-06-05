-- 20260724_ticket_numbering.sql
-- Human, collision-proof request numbers:  {ORG}-DDRT-{YY}-{NNNN}
-- e.g. KE-DDRT-26-0001  (Kern Energy · Drafting & Design Request Ticket · 2026 · #1)
--
--   • Per-org configurable prefix / record-code / padding (on orgs).
--   • An ATOMIC per-(org, year) counter so numbers are sequential, gap-free,
--     and can never collide even under simultaneous submissions. Resets yearly.
--   • Trigram index on ticket_id for fast partial/fuzzy number search.
--
-- Additive + idempotent. Reversible (drop the columns / table / function / index).

-- 1) Per-org numbering config. prefix NULL/'' = omitted from the number.
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS ticket_prefix      TEXT,
  ADD COLUMN IF NOT EXISTS ticket_record_code TEXT NOT NULL DEFAULT 'DDRT',
  ADD COLUMN IF NOT EXISTS ticket_number_pad  INT  NOT NULL DEFAULT 4
    CHECK (ticket_number_pad BETWEEN 1 AND 9);

-- 2) Atomic sequential counter — one row per (org, year) → yearly reset.
CREATE TABLE IF NOT EXISTS ticket_number_counters (
  org_id   UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  year     INT  NOT NULL,
  next_seq INT  NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, year)
);
-- Locked down: the SECURITY DEFINER function below is the only writer; no direct
-- client access (RLS on, no policies).
ALTER TABLE ticket_number_counters ENABLE ROW LEVEL SECURITY;

-- 3) Hand out the next number atomically. The upsert takes a row lock, so two
--    concurrent callers can never receive the same value. Guarded to active
--    members of the org so the counter can't be bumped cross-tenant.
CREATE OR REPLACE FUNCTION next_ticket_number(p_org UUID, p_year INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_seq INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = p_org AND uid = auth.uid() AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'not an active member of this org';
  END IF;

  INSERT INTO ticket_number_counters (org_id, year, next_seq)
  VALUES (p_org, p_year, 1)
  ON CONFLICT (org_id, year)
  DO UPDATE SET next_seq = ticket_number_counters.next_seq + 1
  RETURNING next_seq INTO v_seq;

  RETURN v_seq;
END$$;

GRANT EXECUTE ON FUNCTION next_ticket_number(UUID, INT) TO authenticated;

-- 4) Fast partial / fuzzy search on the human number (e.g. ILIKE '%0847%').
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS tickets_ticket_id_trgm_idx ON tickets USING GIN (ticket_id gin_trgm_ops);

-- 5) Set your workspace abbreviation (or do it in Admin → Settings).
--    Uncomment + adjust:
-- UPDATE orgs SET ticket_prefix = 'KE' WHERE name = 'Kern Energy';
