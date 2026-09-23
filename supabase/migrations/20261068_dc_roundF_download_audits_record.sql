-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F — P2 EGRESS: download_audits is a RECORD (DEC-44 §1).
--
--   DIST-9 / DRLS-8  The distribution record — the ONLY evidence base for
--                    stale-copy recall ("who is still holding an outdated copy
--                    of this drawing") and for the PSM answer "who has had it,
--                    and when" — was governed by one policy:
--                      download_audits_org_access FOR ALL USING (org_id IN (SELECT my_org_ids()))
--                    FOR ALL covers UPDATE and DELETE, and with no WITH CHECK
--                    the same membership test governed the post-image. Any
--                    active member could delete their own pull, re-point
--                    user_id at a colleague, or erase a document's whole
--                    distribution history — and the panel would then assert
--                    "all N current". audit_logs, six lines above it in
--                    schema.sql, already had the append-only shape; this file
--                    gives download_audits the same one.
--   XEDGE-3 (limb)   Append-only at the database, so the restore path's
--                    immutability list (P10 EDGES) stands on a rail, not a
--                    convention.
--   DIST-7 / TRX-9   The external channels — share links and the transmittal
--   SHR-5 / PHYS-8   portal — need somewhere to record a pull that is NOT a
--                    member's own act. `source` (the channel), `share_id` and
--                    `transmittal_id` (the attribution); user_id becomes
--                    nullable behind a CHECK that every row is attributed to
--                    SOMETHING — a member, a share, or a transmittal. The two
--                    attribution columns are plain uuids, deliberately NOT
--                    foreign keys: the record must outlive the share or
--                    transmittal it names and must never block their deletion.
--                    P1 SHARE and P7 TRANSMITTALS write these columns; until
--                    they merge nothing writes them, and the CHECK is
--                    satisfied by every existing row (user_id is NOT NULL
--                    today).
--
-- Policies after apply:
--   download_audits_select      FOR SELECT  USING (org_id IN (SELECT my_org_ids()))
--                               — the SELECT arm of the old FOR ALL policy,
--                                 byte-carried from schema.sql.
--   download_audits_insert_own  FOR INSERT  WITH CHECK (org_id IN (SELECT my_org_ids())
--                                                       AND user_id = auth.uid())
--                               — a member records only their OWN pull, in an
--                                 org they belong to. Every app writer already
--                                 sets user_id to the acting user. External
--                                 rows (NULL user_id + share_id / transmittal_id)
--                                 are written by the service role from the
--                                 share and transmittal routes, which bypass RLS.
--   (no UPDATE, no DELETE)      — nothing a member does rewrites or erases the
--                                 record. Retention and service jobs bypass RLS.
--
-- org_id: backfilled from the row's document, then NOT NULL. A row can only be
-- left without an org if its document is gone (document_id ON DELETE CASCADE
-- makes that unusual, but the DEC-30 inventory below says how many). In that
-- world the column cannot go NOT NULL without inventing an org, so a NOT VALID
-- CHECK (org_id IS NOT NULL) guards every NEW row instead, and the probe
-- reports which world applied. Re-running the file is safe: every step is
-- IF [NOT] EXISTS / DROP-then-CREATE.
--
-- NARROWS for members (UPDATE / DELETE go away; INSERT gains a self-only
-- term). Nobody gains anything on apply. The inventory is captured BEFORE the
-- transaction because the NOT NULL step depends on data this repo cannot see.
--
-- Sequencing: land this before the P1 (share attribution) and P7 (portal
-- write) migrations — both write the columns this file adds.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
CREATE TEMP TABLE dc_round_f_68_before AS
SELECT 'BEFORE: download_audits rows (all)' AS inventory, COUNT(*)::text AS n
  FROM download_audits
UNION ALL
SELECT 'BEFORE: rows with NULL org_id', COUNT(*)::text
  FROM download_audits WHERE org_id IS NULL
UNION ALL
SELECT 'BEFORE: rows with NULL org_id whose document still exists (backfilled below)', COUNT(*)::text
  FROM download_audits a JOIN documents d ON d.id = a.document_id
 WHERE a.org_id IS NULL AND d.org_id IS NOT NULL
UNION ALL
SELECT 'BEFORE: rows with NULL org_id and no document to backfill from (if > 0 the NOT VALID fallback applies instead of NOT NULL)', COUNT(*)::text
  FROM download_audits a LEFT JOIN documents d ON d.id = a.document_id
 WHERE a.org_id IS NULL AND (d.id IS NULL OR d.org_id IS NULL)
UNION ALL
SELECT 'BEFORE: rows with NULL user_id (external attribution; expect 0 - the column is NOT NULL until this file)', COUNT(*)::text
  FROM download_audits WHERE user_id IS NULL
UNION ALL
SELECT 'BEFORE: rows whose user_id is not a member of the row org (service-role writes attributed outside the org)', COUNT(*)::text
  FROM download_audits a
 WHERE a.org_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = a.org_id AND m.uid = a.user_id)
UNION ALL
SELECT 'BEFORE: policies on download_audits (expect 1: download_audits_org_access FOR ALL)', COUNT(*)::text
  FROM pg_policies WHERE tablename = 'download_audits';

BEGIN;

-- ── 1. the record's shape: the channel + external attribution ───────────────
ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS share_id UUID;
ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS transmittal_id UUID;
COMMENT ON COLUMN download_audits.source IS
  'DEC-44: the channel the copy left through (app writers: NULL; share_link / share_link_unstamped; transmittal_portal; drafting / drafting_print).';
COMMENT ON COLUMN download_audits.share_id IS
  'DEC-44: the document_shares row an external pull came through. Attribution, not a foreign key - the record outlives the share.';
COMMENT ON COLUMN download_audits.transmittal_id IS
  'DEC-44: the transmittal an external portal pull came through. Attribution, not a foreign key - the record outlives the transmittal.';

ALTER TABLE download_audits ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE download_audits DROP CONSTRAINT IF EXISTS download_audits_attributed;
ALTER TABLE download_audits ADD CONSTRAINT download_audits_attributed
  CHECK (user_id IS NOT NULL OR share_id IS NOT NULL OR transmittal_id IS NOT NULL);

-- ── 2. org_id: backfill from the document, then NOT NULL (or the fallback) ──
UPDATE download_audits a SET org_id = d.org_id
  FROM documents d
 WHERE a.org_id IS NULL AND a.document_id = d.id AND d.org_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM download_audits WHERE org_id IS NULL) THEN
    -- Rows with nowhere to backfill from: guard every NEW row, keep the old.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'download_audits_org_id_present'
                      AND conrelid = 'download_audits'::regclass) THEN
      ALTER TABLE download_audits ADD CONSTRAINT download_audits_org_id_present CHECK (org_id IS NOT NULL) NOT VALID;
    END IF;
  ELSE
    ALTER TABLE download_audits ALTER COLUMN org_id SET NOT NULL;
    ALTER TABLE download_audits DROP CONSTRAINT IF EXISTS download_audits_org_id_present;
  END IF;
END $$;

-- ── 3. the policy set: SELECT members, INSERT own rows, nothing else ────────
DROP POLICY IF EXISTS "download_audits_org_access" ON download_audits;

DROP POLICY IF EXISTS download_audits_select ON download_audits;
CREATE POLICY download_audits_select ON download_audits FOR SELECT
  USING (org_id IN (SELECT my_org_ids()));

DROP POLICY IF EXISTS download_audits_insert_own ON download_audits;
CREATE POLICY download_audits_insert_own ON download_audits FOR INSERT
  WITH CHECK (org_id IN (SELECT my_org_ids()) AND user_id = auth.uid());

COMMENT ON TABLE download_audits IS
  'DEC-44: append-only distribution record. Members read their org and insert only their own pulls; no member UPDATE or DELETE. External pulls (share links, the transmittal portal) are service-role rows attributed by share_id / transmittal_id.';

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. Inventory rows carry ok NULL and the
--    count in n. pg_policies.qual / with_check are DEPARSED, so the patterns
--    below match the deparsed text (no casts inside a LIKE pattern).
SELECT 'exactly two permissive policies on download_audits: download_audits_select (SELECT) and download_audits_insert_own (INSERT)' AS check,
       (SELECT COUNT(*) = 2 FROM pg_policies WHERE tablename = 'download_audits')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'download_audits'
                    AND policyname = 'download_audits_select' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'download_audits'
                    AND policyname = 'download_audits_insert_own' AND cmd = 'INSERT' AND permissive = 'PERMISSIVE') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'no policy admits UPDATE, DELETE or ALL (the FOR ALL policy is gone)',
       (SELECT COUNT(*) = 0 FROM pg_policies
         WHERE tablename = 'download_audits' AND cmd IN ('UPDATE', 'DELETE', 'ALL')),
       NULL
UNION ALL
SELECT 'SELECT keeps the membership term (my_org_ids)',
       (SELECT qual LIKE '%my_org_ids()%'
          FROM pg_policies WHERE tablename = 'download_audits' AND policyname = 'download_audits_select'),
       NULL
UNION ALL
SELECT 'INSERT pins the row to the caller (user_id = auth.uid()) AND to an org they belong to',
       (SELECT with_check LIKE '%user_id = auth.uid()%' AND with_check LIKE '%my_org_ids()%'
          FROM pg_policies WHERE tablename = 'download_audits' AND policyname = 'download_audits_insert_own'),
       NULL
UNION ALL
SELECT 'RLS is enabled on download_audits',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'download_audits'::regclass),
       NULL
UNION ALL
SELECT 'source, share_id, transmittal_id columns exist',
       (SELECT COUNT(*) = 3 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'download_audits'
           AND column_name IN ('source', 'share_id', 'transmittal_id')),
       NULL
UNION ALL
SELECT 'user_id is nullable and every row is attributed (CHECK download_audits_attributed)',
       (SELECT is_nullable = 'YES' FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'download_audits' AND column_name = 'user_id')
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'download_audits_attributed'
                      AND conrelid = 'download_audits'::regclass AND contype = 'c'),
       NULL
UNION ALL
SELECT 'org_id is NOT NULL, or the NOT VALID fallback guards every new row (the AFTER rows say which)',
       (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'download_audits'::regclass AND attname = 'org_id')
       OR EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'download_audits_org_id_present'
                     AND conrelid = 'download_audits'::regclass),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM dc_round_f_68_before
UNION ALL
SELECT 'AFTER: org_id NOT NULL applied (1) or the NOT VALID fallback is in force (0)', NULL,
       (SELECT CASE WHEN attnotnull THEN 1 ELSE 0 END
          FROM pg_attribute WHERE attrelid = 'download_audits'::regclass AND attname = 'org_id')::text
UNION ALL
SELECT 'AFTER: rows still carrying NULL org_id (0 in the NOT NULL world)', NULL,
       (SELECT COUNT(*) FROM download_audits WHERE org_id IS NULL)::text
UNION ALL
SELECT 'AFTER: rows with NULL user_id (external attribution; 0 until P1 / P7 write them)', NULL,
       (SELECT COUNT(*) FROM download_audits WHERE user_id IS NULL)::text;
