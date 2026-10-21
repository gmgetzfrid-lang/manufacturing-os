-- ─────────────────────────────────────────────────────────────────────────────
-- 20261257_dc_roundG_document_notice_record.sql
--
-- document-control Round G — P38 DOCUMENT NOTICE RECORD (DIST-19, the
-- document half of drafting-flow EVID-8). The ticket side's shape
-- (ticket_notice_events, 20261255) for documents: every reminder and
-- escalation the three document scans land is a durable fact on the record,
-- not one overwritten notified_at and a purgeable bell row.
--
--   document_notice_events (new) — one row per notice that LANDED, for one
--   person: who was told (recipient), about whose silence (subject_user_id),
--   for which document, revision (version_id + revision_label) and obligation
--   (source: review_signoff | acknowledgment | distribution_ack, and
--   source_id, the obligation's own row), what it was (kind: reminded |
--   escalated | alternate_activated, and delivered | not_emailed for the
--   request paths), when it landed (noticed_at) and when it was recorded
--   (created_at). Written by the review-reminder scan (lib/reviewControl.ts
--   scanReviews), the acknowledgment scan (lib/acknowledgments.ts
--   scanAndNotifyAcks) and the distribution-ack nag (lib/distributionAcks.ts
--   scanDistributionAcks), through lib/documentNoticeRecord.ts.
--
--   APPEND-ONLY: an UPDATE is refused for every role; a DELETE only once its
--   document or its org is gone (their ON DELETE CASCADE — every document
--   delete and the org shed keep working), as ticket_notice_events. Read as
--   the document reads (the EXISTS on documents runs under the reader's own
--   documents policies, ACL included); a not_emailed row only by the person
--   it is about (a preference is theirs). No client writes (no INSERT /
--   UPDATE / DELETE grant, no write policy) — only the service role, which
--   the maintenance cron binds, writes. No SECURITY DEFINER function: the
--   trigger function is SECURITY INVOKER, search_path pinned, EXECUTE revoked
--   (a trigger fires without it).
--
--   audit_logs_notice_deferred_server_only (new, P38 fix pass) — one
--   RESTRICTIVE FOR INSERT policy on audit_logs (TO anon, authenticated):
--   a signed-in member may no longer insert a DOCUMENT_NOTICE_RECORD_DEFERRED
--   row. The scans keep a record row they could not write in such a row
--   (the system actor, user_id NULL, the service role) and replay it into
--   this append-only table; a member-written one would plant a permanent
--   false notice (and silence the distribution nag). The replay already reads
--   only user_id IS NULL rows (a member's insert must name their own uid
--   under audit_logs_insert); this is the database's half (the GOV-14
--   precedent, 20261163). Every other row a member may insert is unaffected
--   (restrictive: it ANDs with audit_logs_insert). NOTE: like 20261163, it is
--   a second RESTRICTIVE policy on audit_logs, so 20261142's / 20261157's
--   final probe ("one RESTRICTIVE") reads false if either is re-pasted after
--   this file — expected (it already does after 20261163).
--   ROLLBACK of this policy alone:
--     DROP POLICY IF EXISTS audit_logs_notice_deferred_server_only ON audit_logs;
--
-- WHAT DOES NOT CHANGE (DEC-90 ruling (2)): no existing table, column,
-- policy, function or trigger is touched (the one new audit_logs policy
-- above is new, re-creates nothing, and narrows only). document_review_signoffs.notified_at
-- and document_acknowledgments.notified_at are written exactly as before, in
-- the same place, by the same scans; every reader of them is unchanged.
--
-- THE ONE QUERY (DIST-19 done-when 3) — asked / reminded / escalated /
-- answered, for a revision ($1, a document_versions id) and a person ($2),
-- after the bell rows are purged:
--
--   SELECT o.obligation, o.asked_at, o.answered_at, o.status,
--          (SELECT COUNT(*) FROM document_notice_events e
--            WHERE e.source = o.source AND e.source_id = o.id AND e.kind = 'reminded') AS reminders,
--          (SELECT MIN(e.noticed_at) FROM document_notice_events e
--            WHERE e.source = o.source AND e.source_id = o.id AND e.kind = 'reminded') AS first_reminded,
--          (SELECT MAX(e.noticed_at) FROM document_notice_events e
--            WHERE e.source = o.source AND e.source_id = o.id AND e.kind = 'reminded') AS last_reminded,
--          (SELECT MIN(e.noticed_at) FROM document_notice_events e
--            WHERE e.source = o.source AND e.source_id = o.id AND e.kind = 'escalated') AS first_escalated,
--          (SELECT array_agg(DISTINCT e.recipient) FROM document_notice_events e
--            WHERE e.source = o.source AND e.source_id = o.id AND e.kind = 'escalated') AS escalated_to,
--          (SELECT MIN(e.noticed_at) FROM document_notice_events e
--            WHERE e.source = o.source AND e.source_id = o.id AND e.kind = 'alternate_activated') AS activated_as_alternate
--     FROM (
--       SELECT 'review_signoff' AS source, 'pre-publish review' AS obligation, s.id, s.assigned_at AS asked_at, s.signed_at AS answered_at, s.status
--         FROM document_review_signoffs s WHERE s.document_version_id = $1 AND s.reviewer_user_id = $2
--       UNION ALL
--       SELECT 'acknowledgment', 'read and understood', a.id, a.assigned_at, a.acknowledged_at, a.status
--         FROM document_acknowledgments a WHERE a.document_version_id = $1 AND a.assignee_user_id = $2
--       UNION ALL
--       SELECT 'distribution_ack', 'distribution receipt', d.id, d.requested_at, d.acknowledged_at,
--              CASE WHEN d.acknowledged_at IS NULL THEN 'pending' ELSE 'acknowledged' END
--         FROM distribution_acks d WHERE d.version_id = $1 AND d.recipient_user_id = $2
--     ) o
--    ORDER BY o.asked_at;
--
-- PASTE / DEPLOY ORDER. Independent of every other pending paste (it creates
-- one new table and one new restrictive audit_logs policy, and touches
-- nothing else; its prerequisites date from 20260817 / 20260818 / 20260825). Either order with the P38 deploy is safe;
-- RECOMMENDED: deploy the app first, then paste.
--   * App deployed, not pasted: the scans remind, escalate and stamp exactly
--     as today; their first write meets 42P01 / PGRST205 (or 42703 / PGRST204)
--     and the run's line says once "the document notice record is not in this
--     database yet" — nothing is written, nothing is deferred, nobody is
--     reminded differently. The distribution nag's cooldown read of the record
--     fails the same way and it counts from the notifications rows alone, as
--     today.
--   * Pasted, app not yet deployed: the old app never reads or writes the
--     table; nothing changes.
--   * Reminders sent before the paste are not back-filled (their only trace is
--     notified_at and whatever bell rows remain); the record starts at the
--     first run after both are in place.
--
-- NOT A WIDENING (no person can do anything new; a member gains a read of
-- facts about documents they can already read, and loses only the insert of
-- one server-only audit action). Re-runnable: CREATE TABLE IF
-- NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.documents') IS NULL
     OR to_regclass('public.audit_logs') IS NULL
     OR to_regclass('public.document_review_signoffs') IS NULL
     OR to_regclass('public.document_acknowledgments') IS NULL
     OR to_regclass('public.distribution_acks') IS NULL THEN
    RAISE EXCEPTION '20261257 needs documents, audit_logs, document_review_signoffs (20260818), document_acknowledgments (20260817) and distribution_acks (20260825); nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS dc_round_g_257_before;
CREATE TEMP TABLE dc_round_g_257_before AS
SELECT 1 AS ord, 'inventory (before apply): pending review sign-offs whose reminder history is one notified_at (kept and still written as before; not back-filled)' AS inventory,
       COUNT(*)::text AS n
  FROM document_review_signoffs WHERE status = 'pending' AND notified_at IS NOT NULL
UNION ALL
SELECT 2, 'inventory (before apply): pending acknowledgments whose reminder history is one notified_at (kept and still written as before; not back-filled)',
       COUNT(*)::text FROM document_acknowledgments WHERE status = 'pending' AND notified_at IS NOT NULL
UNION ALL
SELECT 3, 'inventory (before apply): outstanding distribution acks (no reminder column; their nudges were only bell rows — not back-filled)',
       COUNT(*)::text FROM distribution_acks WHERE acknowledged_at IS NULL
UNION ALL
SELECT 4, 'inventory (before apply): DOCUMENT_NOTICE_RECORD_DEFERRED audit rows a signed-in member wrote (user_id set — never replayed; expected 0)',
       COUNT(*)::text FROM audit_logs WHERE action = 'DOCUMENT_NOTICE_RECORD_DEFERRED' AND user_id IS NOT NULL;

BEGIN;

-- ── the record that survives any bell purge (append-only) ───────────────────
CREATE TABLE IF NOT EXISTS document_notice_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id UUID,
  revision_label TEXT,
  source TEXT NOT NULL CHECK (source IN ('review_signoff', 'acknowledgment', 'distribution_ack')),
  source_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('delivered', 'reminded', 'escalated', 'alternate_activated', 'not_emailed')),
  recipient UUID NOT NULL,
  subject_user_id UUID,
  notification_id UUID,
  actor_name TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  noticed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS document_notice_events_document_idx ON document_notice_events (document_id, noticed_at);
CREATE INDEX IF NOT EXISTS document_notice_events_source_idx ON document_notice_events (source, source_id, kind);
CREATE INDEX IF NOT EXISTS document_notice_events_org_source_idx ON document_notice_events (org_id, source, noticed_at);

CREATE OR REPLACE FUNCTION document_notice_events_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'document_notice_events is append-only: a notice record is never rewritten.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A DELETE passes only once its document or its org is gone (the cascades
  -- of a document's deletion and of an org's deletion).
  IF EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id)
     AND EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
    RAISE EXCEPTION 'document_notice_events is append-only: a notice record is removed only with its document.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION document_notice_events_append_only() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_document_notice_events_append_only ON document_notice_events;
CREATE TRIGGER trg_document_notice_events_append_only
BEFORE UPDATE OR DELETE ON document_notice_events
FOR EACH ROW EXECUTE FUNCTION document_notice_events_append_only();

ALTER TABLE document_notice_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_notice_events_read ON document_notice_events;
CREATE POLICY document_notice_events_read ON document_notice_events
  FOR SELECT TO authenticated
  USING ((kind <> 'not_emailed' OR recipient = auth.uid())
         AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_notice_events.document_id AND d.org_id = document_notice_events.org_id));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON document_notice_events FROM anon, authenticated;
REVOKE ALL ON document_notice_events FROM anon;

-- ── the deferred-record audit rows are the server's alone (GOV-14 shape) ───
DROP POLICY IF EXISTS audit_logs_notice_deferred_server_only ON audit_logs;
CREATE POLICY audit_logs_notice_deferred_server_only ON audit_logs
  AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (action IS DISTINCT FROM 'DOCUMENT_NOTICE_RECORD_DEFERRED');

COMMENT ON POLICY audit_logs_notice_deferred_server_only ON audit_logs IS
  'DIST-19 (20261257): only the document scans (service role, system actor) write DOCUMENT_NOTICE_RECORD_DEFERRED rows; the next scan replays them into the append-only document_notice_events, so a member-written one would plant a permanent false notice. Every other row a member may insert is unaffected (restrictive: ANDs with the permissive member insert policy).';

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 8 on a correct paste. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'DIST-19: document_notice_events exists with row security on, its kind and source CHECKs, and cascades from documents and orgs' AS check,
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relname = 'document_notice_events')
       AND (SELECT COUNT(*) = 2 FROM pg_constraint
             WHERE conrelid = 'public.document_notice_events'::regclass AND contype = 'f' AND confdeltype = 'c')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_notice_events'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%alternate_activated%')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_notice_events'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%distribution_ack%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'append-only: a BEFORE UPDATE OR DELETE trigger, enabled; its function SECURITY INVOKER with search_path pinned and EXECUTE granted to no one',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_notice_events_append_only' AND NOT tgisinternal AND tgenabled = 'O')
       AND (SELECT NOT prosecdef AND proconfig @> ARRAY['search_path=public'] FROM pg_proc WHERE proname = 'document_notice_events_append_only')
       AND NOT has_function_privilege('authenticated', 'public.document_notice_events_append_only()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.document_notice_events_append_only()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 3, 'read follows the document (a not_emailed row only by its person); one SELECT policy; no write policy',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_notice_events' AND cmd = 'SELECT'
         AND qual LIKE '%FROM documents d%' AND qual LIKE '%not_emailed%' AND qual LIKE '%auth.uid()%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_notice_events' AND cmd <> 'SELECT'),
       NULL
UNION ALL
SELECT 1, 4, 'no client writes: authenticated has no INSERT / UPDATE / DELETE; anon has nothing',
       NOT has_table_privilege('authenticated', 'public.document_notice_events', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.document_notice_events', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.document_notice_events', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.document_notice_events', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.document_notice_events', 'INSERT'),
       NULL
UNION ALL
SELECT 1, 5, 'the three indexes the scans and the one query read (document, source row, org + source cooldown)',
       (SELECT COUNT(*) = 3 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'document_notice_events'
         AND indexname IN ('document_notice_events_document_idx', 'document_notice_events_source_idx', 'document_notice_events_org_source_idx')),
       NULL
UNION ALL
SELECT 1, 6, 'nothing else touched: the notified_at columns are still on document_review_signoffs and document_acknowledgments',
       (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'notified_at'
           AND table_name IN ('document_review_signoffs', 'document_acknowledgments')),
       NULL
UNION ALL
SELECT 1, 7, 'audit_logs_notice_deferred_server_only is a RESTRICTIVE INSERT policy for anon and authenticated refusing DOCUMENT_NOTICE_RECORD_DEFERRED, with no USING clause',
       COALESCE((SELECT permissive = 'RESTRICTIVE' AND cmd = 'INSERT'
                        AND 'authenticated' = ANY (roles) AND 'anon' = ANY (roles)
                        AND qual IS NULL
                        AND with_check LIKE '%action IS DISTINCT FROM ''DOCUMENT_NOTICE_RECORD_DEFERRED''%'
                   FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_notice_deferred_server_only'), false),
       NULL
UNION ALL
SELECT 1, 8, 'audit_logs is otherwise untouched: RLS on, and still exactly one PERMISSIVE INSERT policy (the member insert, binding the caller''s own uid)',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.audit_logs')), false)
       AND (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs'
             AND permissive = 'PERMISSIVE' AND cmd = 'INSERT' AND with_check LIKE '%auth.uid()%'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM dc_round_g_257_before
UNION ALL
SELECT 3, 1, 'after: notice records on file (0 right after a first paste)', NULL,
       (SELECT COUNT(*) FROM document_notice_events)::text
) AS final_rows
ORDER BY sec, ord;
