-- ─────────────────────────────────────────────────────────────────────────────
-- 20261259_dc_roundG_notice_deferred_read.sql
--
-- document-control Round G — P39 NOTICE RECORD REQUESTS (DIST-20, the done-
-- when the integrator added at the P38 merge under DEC-90). A
-- DOCUMENT_NOTICE_RECORD_DEFERRED audit row (lib/documentNoticeRecord.ts —
-- a document notice record row that could not be written twice, kept for the
-- next scan to replay) names a document, a person, a notice kind and a time.
-- The record itself (document_notice_events, 20261257) is read as the
-- document reads — its ACL included — but every member of the workspace
-- reads audit_logs (audit_logs_org_access), so for a document under an ACL
-- that one audit row showed a member what the record would refuse them.
--
--   audit_logs_notice_deferred_readers (new) — one RESTRICTIVE FOR SELECT
--   policy on audit_logs: a DOCUMENT_NOTICE_RECORD_DEFERRED row is read only
--   by someone who can read the document it names (the EXISTS on documents
--   runs under the reader's own documents policies, ACL included — the same
--   test as document_notice_events_read; Admins and Document Controllers read
--   every document of their workspace, so they read every such row). A row
--   whose document is gone, or that names no document, is read by no signed-
--   in member (the record's own rows went with the document — their cascade).
--   EVERY OTHER ACTION reads exactly as before: the action test is first and
--   inline, so no other row ever reaches the documents read, and a
--   RESTRICTIVE policy only ever ANDs with the permissive member read
--   (audit_logs_org_access) and the existing overlay (audit_logs_admin_trail).
--   The service role (the scans' replay, which reads these rows) has no
--   row security and is unaffected.
--
-- WHY A POLICY, NOT A SERVICE-ROLE-ONLY DEFERRAL TABLE (DEC-90 ruling (4)
-- for P39 — "the smallest safe change"): the deferral, the replay, the
-- member-insert refusal (audit_logs_notice_deferred_server_only, 20261257)
-- and their tests all stand as built; a new table would need its own export
-- decision, retention, purge and replay path, and would move rows a
-- re-pasted 20261257 still expects in audit_logs. A second RESTRICTIVE
-- SELECT policy narrows one action and touches nothing else; it is new,
-- re-creates nothing, and narrows only.
--
-- NOTE (20261142 / 20261157 / 20261219 — corrected at the P39 fix pass).
-- Like 20261163 / 20261257 for INSERT, this is a second RESTRICTIVE policy
-- on audit_logs:
--   * 20261142 / 20261157 count EVERY restrictive policy on audit_logs, so
--     their "one RESTRICTIVE" probe already reads false since 20261163 —
--     unchanged by this file.
--   * 20261219 (admin-and-org P13, NOT YET PASTED — row 172) counts the
--     restrictive SELECT policies and expects ONE (its own overlay). ANY
--     paste of 20261219 after this file — its FIRST paste as much as a
--     re-paste — reads that one probe ("the read side is still one
--     permissive member read (audit_logs_org_access) and ONE restrictive
--     overlay ...") false. Expected, and harmless: 20261219 re-creates only
--     audit_logs_admin_trail, never removes this policy (the read rule here
--     stays in force), and every other probe of its result set reads true.
-- ROLLBACK of this policy alone:
--   DROP POLICY IF EXISTS audit_logs_notice_deferred_readers ON audit_logs;
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261219 — and so after the 20261142 /
-- 20261157 → 20261219 sequence (rows 107 / 128 / 172) — so that 20261219's
-- result set reads all true as its row says; pasted the other way round,
-- expect that one false probe on 20261219's paste (above). That is the only
-- ordering constraint: the file itself needs only audit_logs and documents
-- (schema.sql), so it may go in before or after 20261257 (before it, no such
-- audit row exists yet and nothing changes for anyone). Either order with the
-- P39 app is safe — the app never reads these rows through a member's
-- session (the replay is the service role's).
--   * Pasted: a member who cannot read a document no longer reads a deferred
--     notice row about it; every other row, for every reader, is unchanged.
--   * Not pasted: today's reads (every member reads every row of the
--     workspace, as P38 recorded).
--
-- NOT A WIDENING (no one can read or do anything new; members lose the read
-- of one server-only action's rows about documents they cannot read).
-- Re-runnable: DROP POLICY IF EXISTS / CREATE POLICY.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NULL OR to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION '20261259 needs audit_logs and documents (supabase/schema.sql); nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS dc_round_g_259_before;
CREATE TEMP TABLE dc_round_g_259_before AS
SELECT 1 AS ord, 'inventory (before apply): DOCUMENT_NOTICE_RECORD_DEFERRED audit rows on file (each still read by the document''s readers and replayed by the scans)' AS inventory,
       COUNT(*)::text AS n
  FROM audit_logs WHERE action = 'DOCUMENT_NOTICE_RECORD_DEFERRED'
UNION ALL
SELECT 2, 'inventory (before apply): of those, rows about a document under an access list (a member that list refuses stops reading them)',
       COUNT(*)::text
  FROM audit_logs a JOIN documents d ON d.id::text = a.resource_id AND d.org_id = a.org_id
 WHERE a.action = 'DOCUMENT_NOTICE_RECORD_DEFERRED' AND d.acl_index IS NOT NULL
UNION ALL
SELECT 3, 'inventory (before apply): of those, rows whose document is gone or not named (read by no signed-in member after the paste; the replay drops their rows already)',
       COUNT(*)::text
  FROM audit_logs a
 WHERE a.action = 'DOCUMENT_NOTICE_RECORD_DEFERRED'
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id::text = a.resource_id AND d.org_id = a.org_id)
UNION ALL
SELECT 4, 'inventory (before apply): RESTRICTIVE SELECT policies on audit_logs (1 = the audit trail overlay alone; 2 = a re-run of this file)',
       COUNT(*)::text
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND permissive = 'RESTRICTIVE' AND cmd IN ('SELECT', 'ALL');

BEGIN;

-- ── the deferred notice rows read as the record reads (DIST-20) ─────────────
DROP POLICY IF EXISTS audit_logs_notice_deferred_readers ON audit_logs;
CREATE POLICY audit_logs_notice_deferred_readers ON audit_logs
  AS RESTRICTIVE FOR SELECT
  USING (
    COALESCE(action, '') <> 'DOCUMENT_NOTICE_RECORD_DEFERRED'
    OR (resource_type = 'document'
        AND EXISTS (SELECT 1 FROM documents d
                     WHERE d.id = CASE WHEN resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                       THEN resource_id::uuid END
                       AND d.org_id = audit_logs.org_id))
  );

COMMENT ON POLICY audit_logs_notice_deferred_readers ON audit_logs IS
  'DIST-20 (20261259): a DOCUMENT_NOTICE_RECORD_DEFERRED row (a document notice record row kept for the next scan''s replay — document, person, kind, time) is read only by someone who can read the document it names (the documents policies, ACL included — the notice record''s own read rule, 20261257); every other action reads exactly as before (the action test is first; restrictive: ANDs with audit_logs_org_access and audit_logs_admin_trail). The service role''s replay is unaffected.';

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 4 on a correct paste. Inventory rows: n = the count.
-- pg_policies.qual is DEPARSED (the CASE and the regex read back as written,
-- the cast as ::uuid).
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'DIST-20: audit_logs_notice_deferred_readers is a RESTRICTIVE SELECT policy for every role, gating only DOCUMENT_NOTICE_RECORD_DEFERRED rows on a read of the document they name' AS check,
       COALESCE((SELECT permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
                        AND roles = ARRAY['public']::name[]
                        AND with_check IS NULL
                        AND qual LIKE '%<> ''DOCUMENT_NOTICE_RECORD_DEFERRED''%'
                        AND qual LIKE '%FROM documents d%'
                        AND qual LIKE '%d.org_id = audit_logs.org_id%'
                        AND qual LIKE '%resource_type = ''document''%'
                   FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_notice_deferred_readers'), false) AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'every other audit_logs rule is untouched: RLS on; the member read (audit_logs_org_access, PERMISSIVE SELECT) and the audit trail overlay (audit_logs_admin_trail, RESTRICTIVE SELECT) still present; no UPDATE / DELETE policy',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.audit_logs')), false)
       AND (SELECT COUNT(*) FILTER (WHERE policyname = 'audit_logs_org_access' AND permissive = 'PERMISSIVE' AND cmd = 'SELECT') = 1
               AND COUNT(*) FILTER (WHERE policyname = 'audit_logs_admin_trail' AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT') = 1
               AND COUNT(*) FILTER (WHERE cmd IN ('UPDATE', 'DELETE')) = 0
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs'),
       NULL
UNION ALL
SELECT 1, 3, 'the read side is the member read, the audit trail overlay and this one rule: exactly two RESTRICTIVE SELECT policies',
       (SELECT COUNT(*) = 2 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs'
         AND permissive = 'RESTRICTIVE' AND cmd IN ('SELECT', 'ALL')
         AND policyname IN ('audit_logs_admin_trail', 'audit_logs_notice_deferred_readers'))
       AND (SELECT COUNT(*) = 2 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs'
         AND permissive = 'RESTRICTIVE' AND cmd IN ('SELECT', 'ALL')),
       NULL
UNION ALL
SELECT 1, 4, 'the INSERT rules are untouched: still exactly one PERMISSIVE INSERT policy (the member insert, binding the caller''s own uid)',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs'
         AND permissive = 'PERMISSIVE' AND cmd = 'INSERT' AND with_check LIKE '%auth.uid()%'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM dc_round_g_259_before
) AS final_rows
ORDER BY sec, ord;
