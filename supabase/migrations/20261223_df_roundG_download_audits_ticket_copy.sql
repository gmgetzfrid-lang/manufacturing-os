-- ─────────────────────────────────────────────────────────────────────────────
-- 20261223_df_roundG_download_audits_ticket_copy.sql
--
-- drafting-flow Round G — DF-P12 DELIVERABLE FOLLOW-UPS: the distribution
-- record names WHICH ticket file left (public-surfaces PHYS-17, PHYS-8
-- done-when 3; drafting-flow EVID-16's record).
--
--   download_audits (20261068: an append-only record — members read their org
--   and insert only their own pulls) had no ticket or attachment column, so a
--   drafting-ticket copy was recorded as "someone pulled something" with the
--   file named only on an audit_logs row beside it, and lib/staleCopies.ts —
--   keyed on document_id / version_id — could never list the holder of a
--   superseded ticket deliverable. This file adds:
--     ticket_id      UUID  the ticket whose file left
--     attachment_id  TEXT  the file (TicketAttachment.id) on that ticket
--   Plain columns, deliberately NOT foreign keys — as 20261068's share_id and
--   transmittal_id: the record must outlive the ticket's archive shed and must
--   never block a ticket's deletion. A partial index serves the ticket arm of
--   the recall (lib/staleCopies.ts getTicketCopyRecall).
--   download_audits_insert_own is UNCHANGED (a member records only their own
--   pull, user_id = auth.uid(), in an org they belong to); the server stamping
--   route (/api/tickets/copy) writes as the service role.
--   download_audits_ticket_read_scope (new, AS RESTRICTIVE, FOR SELECT, TO
--   authenticated): download_audits_select admits every member of the org to
--   every row, and a row naming a ticket now carries that ticket's id — the
--   public verify key (/api/verify-ticket?t=<id> answers its number, title
--   and revision status). A member who may not read the ticket (a
--   Contractor-only member outside drafting-flow AUTHZ-13's scope —
--   20261166 tickets_read_scope) must not learn it from the record either:
--   a row naming a ticket is visible only when the caller can read that
--   ticket (the EXISTS runs under the caller's own tickets policies). A row
--   naming no ticket (every document copy) is untouched; a row whose ticket
--   was deleted is readable by the service role only. It narrows; it admits
--   nothing.
--   The `source` column comment (20261068) is restated with the four drafting
--   channel values the app writes: drafting / drafting_print (20261068
--   already named them) and drafting_unstamped / drafting_print_unstamped (a
--   copy that left without its stamp — DF-P10, recorded since).
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261068 (its first statement refuses
-- otherwise, changing nothing: the comment restates 20261068's `source`).
-- Either order with the DF-P12 deploy: the DF-P12 app writes ticket_id /
-- attachment_id and, without them (42703 / PGRST204 naming either), writes
-- today's row (the file still named on the audit_logs row); the ticket arm of
-- the recall answers "the record cannot be read by ticket yet" (a gap, never
-- "nobody holds a copy") until the paste. The app before DF-P12 never writes
-- the columns.
--
-- Not a widening (two nullable columns and one RESTRICTIVE read policy that
-- only narrows). Re-runnable: ADD COLUMN / INDEX IF NOT EXISTS; COMMENT
-- replaces; the policy is DROP-then-CREATE. A later re-paste of 20261068
-- leaves the new policy in place, but its first probe ("exactly two
-- policies") then reads false — the count is three from this paste on.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'download_audits' AND column_name = 'source') THEN
    RAISE EXCEPTION '20261223 needs 20261068 (download_audits as a record: source, share_id, transmittal_id) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS df_round_g_223_before;
CREATE TEMP TABLE df_round_g_223_before AS
SELECT 1 AS ord, 'inventory (before apply): download_audits rows (all)' AS inventory,
       COUNT(*)::text AS n
  FROM download_audits
UNION ALL
SELECT 2, 'inventory (before apply): drafting-ticket copies recorded without the file (source drafting*; the file is named only on the audit_logs DOWNLOAD row beside each)',
       COUNT(*)::text
  FROM download_audits
 WHERE source IN ('drafting', 'drafting_print', 'drafting_unstamped', 'drafting_print_unstamped')
UNION ALL
SELECT 3, 'inventory (before apply): policies on download_audits (expect 2 on a first paste: download_audits_select, download_audits_insert_own; 3 on a re-paste)',
       COUNT(*)::text
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'download_audits'
UNION ALL
SELECT 4, 'inventory (before apply): rows naming a ticket, readable by every member of their org until this paste (0 on a first paste — the column is new)',
       COUNT(*) FILTER (WHERE to_jsonb(d) ->> 'ticket_id' IS NOT NULL)::text
  FROM download_audits d
UNION ALL
SELECT 5, 'inventory (before apply): active Contractor-only members (the callers download_audits_ticket_read_scope narrows; every other member reads the tickets of their org)',
       COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active'
   AND COALESCE((SELECT bool_and(btrim(h.r) = 'Contractor')
                   FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) AS h(r)
                  WHERE btrim(h.r) <> ''), false);

BEGIN;

ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS ticket_id UUID;
ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS attachment_id TEXT;
CREATE INDEX IF NOT EXISTS download_audits_ticket_idx
  ON download_audits(ticket_id, created_at DESC) WHERE ticket_id IS NOT NULL;
COMMENT ON COLUMN download_audits.ticket_id IS
  'drafting-flow PHYS-17 (20261223): the drafting ticket whose file left (a ticket copy has no document_id / version_id). Attribution, not a foreign key - the record outlives the ticket''s archive shed.';
COMMENT ON COLUMN download_audits.attachment_id IS
  'drafting-flow PHYS-17 (20261223): the file on that ticket (TicketAttachment.id). Its revision is read from the ticket''s attachments by the stale-copies ticket arm.';
COMMENT ON COLUMN download_audits.source IS
  'DEC-44: the channel the copy left through (app writers: NULL; share_link / share_link_unstamped; transmittal_portal; drafting / drafting_print; drafting_unstamped / drafting_print_unstamped - a ticket copy that left without its stamp).';

-- A row naming a ticket is read under the caller's ticket scope (header).
DROP POLICY IF EXISTS download_audits_ticket_read_scope ON download_audits;
CREATE POLICY download_audits_ticket_read_scope ON download_audits
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (ticket_id IS NULL OR EXISTS (SELECT 1 FROM tickets t WHERE t.id = download_audits.ticket_id));

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'PHYS-17: download_audits.ticket_id (uuid) and attachment_id (text) exist, nullable, not foreign keys; the ticket index exists' AS check,
       (EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'download_audits' AND column_name = 'ticket_id' AND data_type = 'uuid' AND is_nullable = 'YES')
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'download_audits' AND column_name = 'attachment_id' AND data_type = 'text' AND is_nullable = 'YES')
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
                         WHERE c.conrelid = 'public.download_audits'::regclass AND c.contype = 'f' AND a.attname IN ('ticket_id', 'attachment_id'))
        AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'download_audits' AND indexname = 'download_audits_ticket_idx')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the permissive policies are unchanged: download_audits_select (SELECT) and download_audits_insert_own (INSERT, user_id = auth.uid()), and nothing admits UPDATE, DELETE or ALL',
       (SELECT COUNT(*) = 2 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'download_audits' AND permissive = 'PERMISSIVE')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'download_audits'
                    AND policyname = 'download_audits_select' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'download_audits'
                    AND policyname = 'download_audits_insert_own' AND cmd = 'INSERT' AND with_check LIKE '%user_id = auth.uid()%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'download_audits' AND cmd IN ('UPDATE', 'DELETE', 'ALL')),
       NULL
UNION ALL
SELECT 'download_audits_ticket_read_scope: RESTRICTIVE, SELECT, authenticated only; a row naming a ticket is read only when the caller can read the ticket (deparsed)',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'download_audits'
                AND policyname = 'download_audits_ticket_read_scope' AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
                AND roles = ARRAY['authenticated']::name[]
                AND qual LIKE '%ticket_id IS NULL%'
                AND qual LIKE '%FROM tickets t%'
                AND qual LIKE '%t.id = download_audits.ticket_id%')
       AND (SELECT COUNT(*) = 3 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'download_audits'),
       NULL
UNION ALL
SELECT 'the source comment names every drafting channel the app writes',
       (SELECT col_description('public.download_audits'::regclass, a.attnum) LIKE '%drafting_print_unstamped%'
               AND col_description('public.download_audits'::regclass, a.attnum) LIKE '%share_link_unstamped%'
          FROM pg_attribute a WHERE a.attrelid = 'public.download_audits'::regclass AND a.attname = 'source'),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM (SELECT ord, inventory, n FROM df_round_g_223_before ORDER BY ord) b
UNION ALL
SELECT 'after: drafting-ticket copies naming their ticket and file (0 right after the paste)', NULL,
       (SELECT COUNT(*) FROM download_audits WHERE ticket_id IS NOT NULL)::text;
