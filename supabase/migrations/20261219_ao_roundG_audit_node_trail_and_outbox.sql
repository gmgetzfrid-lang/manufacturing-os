-- 20261219_ao_roundG_audit_node_trail_and_outbox.sql
--
-- admin-and-org Round G — package P13 (audit follow-ups): ALOG-16 and the
-- drafting-flow EVID-6 outbox. ONE paste, two independent parts.
--
-- ═══ PART 1 — ALOG-16: node-level authority rows only to those who may see them
--
-- WHY:
--   DEC-17's RESTRICTIVE overlay on audit_logs (audit_logs_admin_trail)
--   hides the org-level authority trail from members without the Audit log
--   permission (admin.audit_view) by matching org-level resource types and
--   action prefixes. A change to a NODE's authority is written with the node
--   as its resource: NODE_ACL_CHANGED (components/permissions/
--   PermissionDrawer.tsx — the node's full before / after access list in
--   details), OWNER_ASSIGNED / OWNER_CLEARED / OWNER_TEAM_* (lib/ownership.ts,
--   lib/libraryCollections.ts, lib/teams.ts) and ACCESS_RECERTIFIED
--   (lib/accessRecert.ts), typed library / collection / document. The
--   overlay's predicate does not reach them, so audit_logs_org_access lets
--   every active member read them — on /activity and straight through
--   PostgREST — including who holds access to a restricted library they
--   cannot open.
--
-- DECISION (DEC-90 ruling for this package; fail-safe, least privilege):
--   such a row is readable only by a holder of the Audit log permission or by
--   a person who may manage that node; enforced by the database.
--
-- WHAT:
--   1. public.audit_row_node_manageable(p_type text, p_id text) — may the
--      caller manage the node an audit row names? library / collection /
--      document → the node's org controller (is_org_controller), its
--      effective owner (user_is_effective_owner, the owner cascade with
--      active membership at every level), or a holder of an admin /
--      managePermissions grant on it (can_manage_node over its acl_index,
--      deny wins) — the same people the access drawer admits. A non-UUID id,
--      a node that is gone or that the caller cannot read, or any other type
--      → false (an audit viewer still reads the row through the overlay's
--      first limb). SECURITY INVOKER, no SET clause (no per-row GUC save /
--      restore — 20261142's precedent), names schema-qualified; EXECUTE for
--      anon, authenticated and service_role (every role the overlay is
--      evaluated for), revoked from PUBLIC.
--   2. audit_logs_admin_trail re-created from its NEWEST definition, NARROWED
--      by one AND clause (the action test inline). Which body is newest
--      depends on what has been pasted, so the paste picks it at run time:
--        * 20261157 applied (audit_row_project_ref_visible exists) →
--          20261157 §7's body + the ALOG-16 clause;
--        * otherwise (20261142 applied) → 20261142 §2's body + the clause;
--        * 20261142 NOT applied (audit_row_project_visible missing) → the
--          paste STOPS, changes nothing, and says to apply 20261142 first
--          (its body is the floor this file builds on — 20261157's
--          precedent).
--      Both bodies are byte-faithful to their source files except the added
--      clause (lib/__tests__/aoRoundGP13AuditTrailMigration.test.ts finds
--      each source by scanning the sequence and lineDiffs it). An audit
--      viewer reads every row as before; every row outside the five actions
--      reads exactly as before; a node-level authority row reaches anyone
--      else only when they may manage that node.
--
-- ═══ PART 2 — drafting-flow EVID-6: the audit dead-letter outbox
--
-- WHY:
--   lib/audit.ts logAuditAction reports a refused insert (returned, logged)
--   but a caller that ignores the result still loses the row, with nothing
--   durable for anyone to find. EVID-6's remedy: a durable dead-letter /
--   outbox the maintenance cron drains and alerts on (no new cron entry).
--
-- WHAT:
--   3. public.audit_dead_letters — one row per audit row that could not be
--      written: the workspace, the action, the row as it was meant to be
--      written (entry jsonb — as the WRITER sent it, never trusted as
--      identity), the refusal, where it came from (browser through
--      /api/audit/dead-letter, which verifies the caller is an active member
--      writing about themself; or the server's own client), who reported it
--      (the verified caller), when, and the drain's state (attempts, last
--      error, drained_at, the audit_logs row it became). RLS ON with NO
--      policy, and nothing granted to anon / authenticated: only the service
--      role reads or writes it (the route and the cron) — SELECT, INSERT,
--      UPDATE, and DELETE for the drain's prune of drained rows.
--      The drain (app/api/cron/maintenance/route.ts, one step with its own
--      budget) claims each row (a compare-and-set on drain_attempts, so an
--      overlapping run skips it), writes it into audit_logs as an
--      AUDIT_DEAD_LETTER MACHINE row UNDER THE OUTBOX ROW'S OWN ID (the
--      primary key makes a second write impossible; user_id NULL,
--      resource_type 'org' — inside the overlay's org-level set, so audit
--      viewers only) carrying the lost row and the verified reporter in
--      details, and reports what it drained in the run's errors; a row that
--      fails 5 times is parked (no longer read, reported every run), and rows
--      drained 30 days ago are pruned. It never re-inserts the lost action
--      itself: a refusal the database meant (a forged consent row, a
--      signed-in INTAKE_ action) cannot be laundered through the service role
--      into the real action. No index on audit_logs is added.
--
-- WHAT DOES NOT CHANGE: who may insert audit rows (audit_logs_insert and
-- 20261163's restrictive INSERT rule untouched), the permissive member read
-- (audit_logs_org_access), any audit row (none is updated or deleted), any
-- other table.
--
-- APP BEFORE AND AFTER THE PASTE:
--   Part 1 needs no app change, but the P13 app's /activity states the
--   narrowed rule, so that app is deployed only AFTER this paste (the deploy
--   gate below) — the page never says more than the database enforces.
--   Part 2: before the paste the dead-letter route answers 503 (42P01 /
--   PGRST205, "the outbox is not installed") and logAuditAction keeps today's
--   path (the refusal returned and logged); the drain step finds no table and
--   says nothing. After it, refused rows are kept and drained nightly.
--
-- PASTE AND DEPLOY ORDER:
--   * AFTER 20261142 (the file stops otherwise).
--   * BEFORE the admin-and-org P13 deploy — a HARD GATE, not a
--     recommendation: deploy the app carrying admin-and-org P13 only once
--     20261142 and then this file are pasted (expect ok = true on every
--     probe). That app's /activity states that node-level permission,
--     ownership and recertification rows are restricted; deployed first, it
--     would state a confidentiality rule the database does not yet enforce.
--   * 20261157 is HOLD: when it is pasted LATER, it re-creates the overlay
--     from 20261142's body without this clause, re-opening those rows to
--     every member — PASTE THIS FILE AGAIN right
--     after 20261157, IN THE SAME SQL-EDITOR WINDOW (re-runnable; it then
--     takes 20261157's body). The same for any later re-paste of 20261142 or
--     20261157.
--
-- ROLLBACK:
--   Part 1 — re-paste the overlay's previous definition (20261157 §7 when
--   20261157 is applied, else 20261142 §2), then
--     DROP FUNCTION IF EXISTS public.audit_row_node_manageable(text, text);
--   Part 2 — DROP TABLE IF EXISTS public.audit_dead_letters;
--     (undrained rows are lost; drain first). The app keeps working.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the final
-- SELECT carries every probe (ok true/false, n NULL; expect ok = true on
-- every probe row) and the inventory counts (ok NULL, n the count —
-- aggregate counts only, never a row).

-- ── Before-apply inventory (aggregate counts only, read BEFORE the change) ──
DROP TABLE IF EXISTS pg_temp._ao_g219_before;
CREATE TEMP TABLE _ao_g219_before AS
SELECT 'inventory: node-level authority rows (NODE_ACL_CHANGED, OWNER_ASSIGNED, OWNER_CLEARED, OWNER_TEAM_*, ACCESS_RECERTIFIED) — before this paste every active member could read them' AS inventory,
       COUNT(*)::text AS n FROM audit_logs
        WHERE action IN ('NODE_ACL_CHANGED', 'OWNER_ASSIGNED', 'OWNER_CLEARED', 'ACCESS_RECERTIFIED') OR left(action, 11) = 'OWNER_TEAM_'
UNION ALL
SELECT 'inventory: of those, typed library / collection / document (the rows a node manager keeps reading)',
       COUNT(*)::text FROM audit_logs
        WHERE (action IN ('NODE_ACL_CHANGED', 'OWNER_ASSIGNED', 'OWNER_CLEARED', 'ACCESS_RECERTIFIED') OR left(action, 11) = 'OWNER_TEAM_')
          AND resource_type IN ('library', 'collection', 'document')
UNION ALL
SELECT 'inventory: 20261142 applied before this paste (audit_row_project_visible present: 1 = yes; 0 = the paste stops)',
       (to_regprocedure('public.audit_row_project_visible(text, text)') IS NOT NULL)::int::text
UNION ALL
SELECT 'inventory: 20261157 applied before this paste (1 = the overlay is re-created from 20261157''s body; 0 = from 20261142''s)',
       (to_regprocedure('public.audit_row_project_ref_visible(text, text, text, jsonb)') IS NOT NULL)::int::text
UNION ALL
SELECT 'inventory: audit_row_node_manageable present before this paste (0 = first apply; 1 = a re-run)',
       (to_regprocedure('public.audit_row_node_manageable(text, text)') IS NOT NULL)::int::text
UNION ALL
SELECT 'inventory: audit_dead_letters present before this paste (0 = first apply; 1 = a re-run)',
       (to_regclass('public.audit_dead_letters') IS NOT NULL)::int::text;

BEGIN;

-- ── 0. the floor: 20261142's overlay body must be live ──────────────────────
DO $guard$
BEGIN
  IF to_regprocedure('public.audit_row_project_visible(text, text)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261142_prj_roundG_project_audit_rows.sql first — this file re-creates audit_logs_admin_trail from its body (or 20261157''s). Nothing was changed.';
  END IF;
END
$guard$;

-- ── 1. who may manage the node an audit row names ───────────────────────────
CREATE OR REPLACE FUNCTION public.audit_row_node_manageable(p_type text, p_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_id IS NULL OR p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false
    WHEN p_type = 'library' THEN EXISTS (
      SELECT 1 FROM public.libraries l
       WHERE l.id = p_id::uuid
         AND (public.is_org_controller(l.org_id)
              OR public.user_is_effective_owner(NULL::uuid, NULL::uuid, l.id, auth.uid())
              OR public.can_manage_node(l.acl_index, l.org_id)))
    WHEN p_type = 'collection' THEN EXISTS (
      SELECT 1 FROM public.collections c
       WHERE c.id = p_id::uuid
         AND (public.is_org_controller(c.org_id)
              OR public.user_is_effective_owner(NULL::uuid, c.id, c.library_id, auth.uid())
              OR public.can_manage_node(c.acl_index, c.org_id)))
    WHEN p_type = 'document' THEN EXISTS (
      SELECT 1 FROM public.documents d
       WHERE d.id = p_id::uuid
         AND (public.is_org_controller(d.org_id)
              OR public.user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
              OR public.can_manage_node(d.acl_index, d.org_id)))
    ELSE false
  END;
$$;

COMMENT ON FUNCTION public.audit_row_node_manageable(text, text) IS
  'ALOG-16 (20261219): may the caller manage the node an audit row names? library / collection / document → its org controller, its effective owner (the owner cascade, active members only) or a holder of an admin / managePermissions grant on its acl_index (deny wins) — the people the access drawer admits; a non-UUID id, a gone or unreadable node, or any other type → false. SECURITY INVOKER, no SET clause, names schema-qualified. Called by audit_logs_admin_trail for the node-level authority actions only.';

REVOKE ALL ON FUNCTION public.audit_row_node_manageable(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_row_node_manageable(text, text) TO anon, authenticated, service_role;

-- ── 2. the audit trail overlay: its NEWEST body + the ALOG-16 clause ───────
-- The body is chosen by what is applied (see the header); each EXECUTEd text
-- is its source's policy, byte for byte, with the one clause added.
DO $alog16$
BEGIN
  IF to_regprocedure('public.audit_row_project_ref_visible(text, text, text, jsonb)') IS NULL THEN
    -- 20261142 is applied, 20261157 is not: 20261142 §2's body.
    EXECUTE $world_b$DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs$world_b$;
    EXECUTE $world_b$
CREATE POLICY audit_logs_admin_trail ON audit_logs
  AS RESTRICTIVE FOR SELECT
  USING (
    org_capability_allows(org_id, 'admin.audit_view', auth.uid())
    OR NOT (
      COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
      OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
      OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
      OR action LIKE 'DATA_EXPORT%' OR action LIKE 'RESTORE_%' OR action LIKE 'PURGE_%'
    )
    -- SEC-20 (20261142): a row about a project, a cost record or a quality
    -- sign-off is the project's — readable when the caller can see the
    -- project. AND binds tighter than OR: an audit viewer reads every row;
    -- anyone else reads a row that is not the org-level trail AND whose
    -- project they can see. The type test is inline: a row of any other
    -- type never calls the function.
    AND (COALESCE(resource_type, '') NOT IN ('project', 'cost', 'project_checklist', 'turnover_item')
         OR audit_row_project_visible(resource_type, resource_id))
    -- ALOG-16 (20261219): a node-level authority row — a library's, folder's
    -- or document's access list changed (NODE_ACL_CHANGED, its full before /
    -- after list in details), its owner assigned or cleared (OWNER_ASSIGNED,
    -- OWNER_CLEARED, OWNER_TEAM_*) or its access recertified
    -- (ACCESS_RECERTIFIED) — is readable by an audit viewer (above) or by a
    -- person who may manage that node (audit_row_node_manageable); never by
    -- every member. The action test is inline: no other row calls the
    -- function, so every other row reads exactly as before.
    AND ((COALESCE(action, '') NOT IN ('NODE_ACL_CHANGED', 'OWNER_ASSIGNED', 'OWNER_CLEARED', 'ACCESS_RECERTIFIED')
          AND left(COALESCE(action, ''), 11) <> 'OWNER_TEAM_')
         OR audit_row_node_manageable(resource_type, resource_id))
  );
$world_b$;
  ELSE
    -- 20261157 is applied: 20261157 §7's body (the newest in the sequence).
    EXECUTE $world_c$DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs$world_c$;
    EXECUTE $world_c$
CREATE POLICY audit_logs_admin_trail ON audit_logs
  AS RESTRICTIVE FOR SELECT
  USING (
    org_capability_allows(org_id, 'admin.audit_view', auth.uid())
    OR NOT (
      COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
      OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
      OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
      OR action LIKE 'DATA_EXPORT%' OR action LIKE 'RESTORE_%' OR action LIKE 'PURGE_%'
    )
    -- SEC-20 (20261142): a row about a project, a cost record or a quality
    -- sign-off is the project's — readable when the caller can see the
    -- project. AND binds tighter than OR: an audit viewer reads every row;
    -- anyone else reads a row that is not the org-level trail AND whose
    -- project they can see. The type test is inline: a row of any other
    -- type never calls the function.
    AND (COALESCE(resource_type, '') NOT IN ('project', 'cost', 'project_checklist', 'turnover_item')
         OR audit_row_project_visible(resource_type, resource_id))
    -- SEC-21 (20261157): a row about a project written under another type —
    -- an intake-link row, an INTAKE_ row, a MILESTONE_ row — follows the
    -- project it names. The kind test is inline: no other row calls the
    -- function.
    AND ((COALESCE(resource_type, '') <> 'project_intake_link'
          AND left(COALESCE(action, ''), 10) <> 'MILESTONE_'
          AND left(COALESCE(action, ''), 7) <> 'INTAKE_')
         OR audit_row_project_ref_visible(action, resource_type, resource_id, details))
    -- ALOG-16 (20261219): a node-level authority row — a library's, folder's
    -- or document's access list changed (NODE_ACL_CHANGED, its full before /
    -- after list in details), its owner assigned or cleared (OWNER_ASSIGNED,
    -- OWNER_CLEARED, OWNER_TEAM_*) or its access recertified
    -- (ACCESS_RECERTIFIED) — is readable by an audit viewer (above) or by a
    -- person who may manage that node (audit_row_node_manageable); never by
    -- every member. The action test is inline: no other row calls the
    -- function, so every other row reads exactly as before.
    AND ((COALESCE(action, '') NOT IN ('NODE_ACL_CHANGED', 'OWNER_ASSIGNED', 'OWNER_CLEARED', 'ACCESS_RECERTIFIED')
          AND left(COALESCE(action, ''), 11) <> 'OWNER_TEAM_')
         OR audit_row_node_manageable(resource_type, resource_id))
  );
$world_c$;
  END IF;
END
$alog16$;

-- ── 3. the audit dead-letter outbox (EVID-6) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_dead_letters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  action         text NOT NULL,
  entry          jsonb NOT NULL,
  error          text,
  source         text NOT NULL CHECK (source IN ('browser', 'server')),
  reported_by    uuid,
  reported_at    timestamptz NOT NULL DEFAULT now(),
  drain_attempts integer NOT NULL DEFAULT 0,
  drain_error    text,
  drained_at     timestamptz,
  audit_log_id   uuid
);

CREATE INDEX IF NOT EXISTS audit_dead_letters_undrained_idx
  ON public.audit_dead_letters (reported_at, id) WHERE drained_at IS NULL;
CREATE INDEX IF NOT EXISTS audit_dead_letters_reporter_idx
  ON public.audit_dead_letters (reported_by, reported_at);

ALTER TABLE public.audit_dead_letters ENABLE ROW LEVEL SECURITY;
-- No policy: the service role (the dead-letter route, the maintenance cron)
-- is the only reader and writer.
REVOKE ALL ON public.audit_dead_letters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_dead_letters TO service_role;

COMMENT ON TABLE public.audit_dead_letters IS
  'EVID-6 (20261219): audit rows that could not be written — the workspace, the action, the row as its writer sent it (entry; never trusted as identity), the refusal, its source (browser via /api/audit/dead-letter, which verifies the caller; or server), the verified reporter, and the drain''s state. Service role only (RLS on, no policy). The maintenance cron claims each row (compare-and-set on drain_attempts) and drains it into audit_logs as an AUDIT_DEAD_LETTER machine row typed org (audit viewers only) under this row''s id, and reports it; it never re-inserts the lost action itself. Parked after 5 failed attempts; pruned 30 days after it is drained.';

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_policies.qual is DEPARSED; pg_proc.prosrc is verbatim.
SELECT 'audit_logs_admin_trail is still RESTRICTIVE SELECT, reads admin.audit_view through the policy evaluator and keeps the org-level trail and the SEC-20 project clause' AS check,
       (SELECT permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
               AND qual LIKE '%org_capability_allows(org_id, ''admin.audit_view''%'
               AND qual LIKE '%capability_policy%' AND qual LIKE '%export_destination%'
               AND qual LIKE '%CAPABILITY_%' AND qual LIKE '%RESTORE_%' AND qual LIKE '%PURGE_%'
               AND qual LIKE '%audit_row_project_visible(resource_type, resource_id)%'
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'ALOG-16: the overlay gates NODE_ACL_CHANGED / OWNER_ASSIGNED / OWNER_CLEARED / OWNER_TEAM_* / ACCESS_RECERTIFIED rows on audit_row_node_manageable(resource_type, resource_id), the action test inline',
       (SELECT qual LIKE '%audit_row_node_manageable(resource_type, resource_id)%'
               AND qual LIKE '%NODE_ACL_CHANGED%' AND qual LIKE '%OWNER_ASSIGNED%' AND qual LIKE '%OWNER_CLEARED%'
               AND qual LIKE '%ACCESS_RECERTIFIED%' AND qual LIKE '%OWNER_TEAM_%'
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail'),
       NULL::text
UNION ALL
SELECT 'the SEC-21 clause is carried exactly when 20261157 is applied (the newest body was taken)',
       (SELECT (qual LIKE '%audit_row_project_ref_visible(action, resource_type, resource_id, details)%')
               = (to_regprocedure('public.audit_row_project_ref_visible(text, text, text, jsonb)') IS NOT NULL)
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail'),
       NULL::text
UNION ALL
SELECT 'the read side is still one permissive member read (audit_logs_org_access) and ONE restrictive overlay; the INSERT rules are untouched',
       (SELECT COUNT(*) FILTER (WHERE permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND policyname = 'audit_logs_org_access') = 1
               AND COUNT(*) FILTER (WHERE permissive = 'RESTRICTIVE' AND cmd IN ('SELECT', 'ALL')) = 1
               AND COUNT(*) FILTER (WHERE permissive = 'PERMISSIVE' AND cmd = 'INSERT') = 1
               AND COUNT(*) FILTER (WHERE cmd IN ('UPDATE', 'DELETE')) = 0
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs'),
       NULL::text
UNION ALL
SELECT 'audit_row_node_manageable is SECURITY INVOKER with no SET clause, its names schema-qualified, and every role the overlay is evaluated for may execute it (PUBLIC revoked)',
       (SELECT NOT p.prosecdef AND p.proconfig IS NULL
               AND p.prosrc LIKE '%public.is_org_controller(l.org_id)%'
               AND p.prosrc LIKE '%public.user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())%'
               AND p.prosrc LIKE '%public.can_manage_node(c.acl_index, c.org_id)%'
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.audit_row_node_manageable(text, text)'))
       AND has_function_privilege('anon', 'public.audit_row_node_manageable(text, text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.audit_row_node_manageable(text, text)', 'EXECUTE')
       AND has_function_privilege('service_role', 'public.audit_row_node_manageable(text, text)', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                        WHERE p.oid = to_regprocedure('public.audit_row_node_manageable(text, text)') AND a.grantee = 0),
       NULL::text
UNION ALL
SELECT 'self-test: the function answers false for a non-UUID id and for a type outside library / collection / document',
       public.audit_row_node_manageable('library', 'not-a-uuid') IS FALSE
       AND public.audit_row_node_manageable('org', '00000000-0000-4000-8000-000000000000') IS FALSE
       AND public.audit_row_node_manageable(NULL, NULL) IS FALSE,
       NULL::text
UNION ALL
SELECT 'EVID-6: audit_dead_letters exists with RLS on and no policy; anon and authenticated hold no privilege on it; the service role may select, insert, update and delete (the prune)',
       to_regclass('public.audit_dead_letters') IS NOT NULL
       AND (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.audit_dead_letters'))
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_dead_letters')
       AND NOT has_table_privilege('anon', 'public.audit_dead_letters', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.audit_dead_letters', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.audit_dead_letters', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.audit_dead_letters', 'DELETE')
       AND has_table_privilege('service_role', 'public.audit_dead_letters', 'INSERT')
       AND has_table_privilege('service_role', 'public.audit_dead_letters', 'UPDATE')
       AND has_table_privilege('service_role', 'public.audit_dead_letters', 'DELETE'),
       NULL::text
UNION ALL
SELECT 'EVID-6: the outbox keeps the drain''s state (drained_at, drain_attempts, drain_error, audit_log_id) and its source is browser or server only',
       (SELECT COUNT(*) = 4 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'audit_dead_letters'
           AND column_name IN ('drained_at', 'drain_attempts', 'drain_error', 'audit_log_id'))
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = to_regclass('public.audit_dead_letters') AND contype = 'c'
                      AND pg_get_constraintdef(oid) LIKE '%browser%server%'),
       NULL::text
UNION ALL SELECT inventory, NULL, n FROM _ao_g219_before
UNION ALL
SELECT 'after: node-level authority rows now readable only by audit viewers and the node''s managers',
       NULL, (SELECT COUNT(*)::text FROM audit_logs
               WHERE action IN ('NODE_ACL_CHANGED', 'OWNER_ASSIGNED', 'OWNER_CLEARED', 'ACCESS_RECERTIFIED') OR left(action, 11) = 'OWNER_TEAM_')
UNION ALL
SELECT 'after: audit_dead_letters rows (0 on a first apply)',
       NULL, (SELECT COUNT(*)::text FROM public.audit_dead_letters);
