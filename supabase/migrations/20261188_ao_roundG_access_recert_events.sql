-- 20261188_ao_roundG_access_recert_events.sql
--
-- admin-and-org Round G — package P9 (permissions console truth and access
-- recertification): ALOG-2 done-when 2 and 3, and document-control RET-4
-- done-when 3's second table (access_recertification_events).
-- Decision (the integrator's, under the user's delegation, DEC-90 practice:
-- least privilege): the people who may RECORD an access recertification are
-- NARROWED to the library's owner and the controllers (Admin / Document
-- Control, by the role collection) — the population the daily scan already
-- notifies (lib/accessRecert.ts scanAccessRecerts: owner_user_id + the org's
-- controllers), the library page already offers the flow to
-- (app/(protected)/documents/[libraryId]/page.tsx: isController ||
-- isLibraryOwner) and the library guard already admits for the attestation
-- columns (20261077 §2: is_org_controller OR owner_user_id). The
-- notification is not widened.
--
-- WHY:
--   access_recertification_events is the attestation evidence — "on this
--   date, this person reviewed who has access and said it is still right".
--   Its only policies are two FOR ALL policies with a bare active-member
--   test on both USING and WITH CHECK:
--     "access_recert_events_member"              (20260821_access_recert.sql:39-44)
--     "access_recertification_events_member_all" (20260819_orphan_tables_backfill.sql:223-238, the loop)
--   so ANY active member — a Viewer, a Contractor, the departed contractor
--   being reviewed — can INSERT a forged 'recertified' row naming anyone
--   (performed_by is not bound to the caller), UPDATE a real one, or DELETE
--   the record that a review ever happened. Those two are the only policies
--   the numbered sequence ever creates on the table (lib/__tests__/
--   aoRoundGP9PermissionsConsole.test.ts replays schema.sql and every
--   numbered migration).
--
-- WHAT:
--   1. Both FOR ALL policies are dropped.
--   2. SELECT (authenticated): every active member of the row's org — as
--      before; the recertification history stays readable to the org.
--   3. INSERT (authenticated): the row names the caller
--      (performed_by = auth.uid()), the caller is an ACTIVE member of the
--      row's org, the row's library belongs to that org, and the caller is a
--      controller of it (is_org_controller — role IN (Admin, DocCtrl) OR the
--      roles collection holds one, active) or the library's owner
--      (libraries.owner_user_id, the column 20261077 §2 reads). The same
--      authority is also a RESTRICTIVE INSERT policy, so a permissive policy
--      added later cannot widen who may attest (the DRLS-1 lesson: a
--      permissive policy ORs away a narrower one).
--   4. No UPDATE and no DELETE for any non-service role: RESTRICTIVE
--      USING (false). An attestation is append-only evidence. The service
--      role (the restore routes) bypasses RLS as before.
--
-- NARROWS only — nobody gains. Every write the app makes today is still
-- admitted: the only writer is lib/accessRecert.ts (setRecertPolicy,
-- recertifyAccess), reached only through AccessRecertModal, which the
-- library page opens for a controller or the library owner, and both
-- writes carry performed_by = the signed-in uid. What changes for a
-- legitimate user: nothing. What is refused from now on: a member who is
-- neither a controller nor the owner writing an attestation through
-- PostgREST, an attestation naming someone else, and any UPDATE / DELETE.
-- One write the app could still attempt and which is now refused: a
-- holder of can_manage_node on the library who is neither a controller
-- nor its owner may set the CADENCE on the library row (20261036's policy
-- arm), but no product surface offers them the modal; if they reach
-- setRecertPolicy anyway, its event row is refused and the app says so
-- (lib/accessRecert.ts checks the insert since this package).
--
-- APP BEFORE AND AFTER THE PASTE: the app is the same either side. Before
-- the paste every member's insert is admitted as today; after it, the
-- recertifiers' inserts are admitted and anyone else's is refused (42501),
-- which lib/accessRecert.ts surfaces instead of reporting success. No
-- function, column or table is added, so there is no 42883 / PGRST202 /
-- 42P01 path.
--
-- PASTE AND DEPLOY ORDER: either order. Deploying the app first is the
-- usual order: from that deploy on, a refused attestation record is
-- surfaced to the reviewer (and the library's dates are put back), so the
-- paste can never turn a silently-dropped record into a silently-refused
-- one. Independent of every other pending file (it re-creates no function,
-- trigger or evaluator; it reads is_org_controller(uuid), live since
-- 20260814).
--
-- ROLLBACK (restores the previous behaviour exactly):
--   DROP POLICY IF EXISTS access_recert_events_select ON access_recertification_events;
--   DROP POLICY IF EXISTS access_recert_events_insert ON access_recertification_events;
--   DROP POLICY IF EXISTS access_recert_events_insert_authority ON access_recertification_events;
--   DROP POLICY IF EXISTS access_recert_events_no_update ON access_recertification_events;
--   DROP POLICY IF EXISTS access_recert_events_no_delete ON access_recertification_events;
--   CREATE POLICY "access_recert_events_member" ON access_recertification_events FOR ALL
--     USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = access_recertification_events.org_id AND uid = auth.uid() AND status = 'active'))
--     WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = access_recertification_events.org_id AND uid = auth.uid() AND status = 'active'));
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the final
-- SELECT carries every probe (ok true/false, n NULL; expect ok = true × 9)
-- and the inventory counts (ok NULL, n the count — aggregate counts only,
-- never a row). Until it is pasted, behaviour is unchanged.

-- ── Before-apply inventory (aggregate counts only, read BEFORE the change) ──
DROP TABLE IF EXISTS pg_temp._ao_g88_before;
CREATE TEMP TABLE _ao_g88_before AS
SELECT 'inventory: access_recertification_events rows' AS inventory,
       COUNT(*)::text AS n FROM access_recertification_events
UNION ALL
SELECT 'inventory: rows with action = recertified',
       COUNT(*)::text FROM access_recertification_events WHERE action = 'recertified'
UNION ALL
SELECT 'inventory: rows with action = policy_set',
       COUNT(*)::text FROM access_recertification_events WHERE action = 'policy_set'
UNION ALL
SELECT 'inventory: rows with any other action',
       COUNT(*)::text FROM access_recertification_events WHERE action IS DISTINCT FROM 'recertified' AND action IS DISTINCT FROM 'policy_set'
UNION ALL
SELECT 'inventory: rows naming no performer (performed_by NULL) — kept, never deleted',
       COUNT(*)::text FROM access_recertification_events WHERE performed_by IS NULL
UNION ALL
SELECT 'inventory: rows whose performer is today neither an active controller of the org nor the library''s owner — the rule below would not admit them as new rows; they are kept, never deleted',
       COUNT(*)::text FROM access_recertification_events e
        WHERE e.performed_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM org_members m
                           WHERE m.org_id = e.org_id AND m.uid = e.performed_by AND m.status = 'active'
                             AND (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]))
          AND NOT EXISTS (SELECT 1 FROM libraries l
                           WHERE l.id = e.library_id AND l.owner_user_id::text = e.performed_by::text)
UNION ALL
SELECT 'inventory: rows whose library belongs to another org, or names no library',
       COUNT(*)::text FROM access_recertification_events e
        WHERE NOT EXISTS (SELECT 1 FROM libraries l WHERE l.id = e.library_id AND l.org_id = e.org_id)
UNION ALL
SELECT 'inventory: FOR ALL policies on the table before this paste (2 = first apply; 0 = a re-run)',
       COUNT(*)::text FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'access_recertification_events' AND cmd = 'ALL';

BEGIN;

-- ── 1. the two member FOR ALL policies go ───────────────────────────────────
DROP POLICY IF EXISTS "access_recert_events_member" ON access_recertification_events;
DROP POLICY IF EXISTS "access_recertification_events_member_all" ON access_recertification_events;

-- ── 2. read: every active member of the row's org, as before ────────────────
DROP POLICY IF EXISTS access_recert_events_select ON access_recertification_events;
CREATE POLICY access_recert_events_select ON access_recertification_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = access_recertification_events.org_id AND m.uid = auth.uid() AND m.status = 'active'));

-- ── 3. attest: the caller, an active member, a controller or the owner ──────
DROP POLICY IF EXISTS access_recert_events_insert ON access_recertification_events;
CREATE POLICY access_recert_events_insert ON access_recertification_events
  FOR INSERT TO authenticated
  WITH CHECK (
    performed_by = auth.uid()
    AND EXISTS (SELECT 1 FROM org_members m
                 WHERE m.org_id = access_recertification_events.org_id AND m.uid = auth.uid() AND m.status = 'active')
    AND EXISTS (SELECT 1 FROM libraries l
                 WHERE l.id = access_recertification_events.library_id
                   AND l.org_id = access_recertification_events.org_id
                   AND (is_org_controller(l.org_id) OR l.owner_user_id::text = auth.uid()::text))
  );

DROP POLICY IF EXISTS access_recert_events_insert_authority ON access_recertification_events;
CREATE POLICY access_recert_events_insert_authority ON access_recertification_events
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    performed_by = auth.uid()
    AND EXISTS (SELECT 1 FROM libraries l
                 WHERE l.id = access_recertification_events.library_id
                   AND l.org_id = access_recertification_events.org_id
                   AND (is_org_controller(l.org_id) OR l.owner_user_id::text = auth.uid()::text))
  );

-- ── 4. append-only: no UPDATE, no DELETE for any non-service role ───────────
DROP POLICY IF EXISTS access_recert_events_no_update ON access_recertification_events;
CREATE POLICY access_recert_events_no_update ON access_recertification_events
  AS RESTRICTIVE FOR UPDATE USING (false);
DROP POLICY IF EXISTS access_recert_events_no_delete ON access_recertification_events;
CREATE POLICY access_recert_events_no_delete ON access_recertification_events
  AS RESTRICTIVE FOR DELETE USING (false);

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 9 (n NULL). Inventory rows: ok NULL, n = the count.
SELECT 'access_recertification_events: RLS still on' AS check,
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.access_recertification_events')), false) AS ok,
       NULL::text AS n
UNION ALL SELECT 'no FOR ALL policy remains on the table (both member policies dropped)',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'access_recertification_events' AND cmd = 'ALL'), NULL
UNION ALL SELECT 'SELECT: one policy for authenticated, bound to the caller''s active membership of the row''s org',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'access_recertification_events' AND policyname = 'access_recert_events_select'
                  AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND 'authenticated' = ANY (roles)
                  AND qual LIKE '%org_members%' AND qual LIKE '%auth.uid()%' AND qual LIKE '%active%'), NULL
UNION ALL SELECT 'INSERT: permissive, for authenticated, binds performed_by to auth.uid() and requires an active membership',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'access_recertification_events' AND policyname = 'access_recert_events_insert'
                  AND cmd = 'INSERT' AND permissive = 'PERMISSIVE' AND 'authenticated' = ANY (roles)
                  AND with_check LIKE '%performed_by = auth.uid()%'
                  AND with_check LIKE '%org_members%' AND with_check LIKE '%active%'), NULL
UNION ALL SELECT 'INSERT: the recertifiers are a controller of the library''s org or the library''s owner',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'access_recertification_events' AND policyname = 'access_recert_events_insert'
                  AND with_check LIKE '%is_org_controller(l.org_id)%' AND with_check LIKE '%owner_user_id%'
                  AND with_check LIKE '%l.org_id = access_recertification_events.org_id%'), NULL
UNION ALL SELECT 'INSERT: the same authority is RESTRICTIVE, so a later permissive policy cannot widen it',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'access_recertification_events' AND policyname = 'access_recert_events_insert_authority'
                  AND cmd = 'INSERT' AND permissive = 'RESTRICTIVE'
                  AND with_check LIKE '%performed_by = auth.uid()%'
                  AND with_check LIKE '%is_org_controller(l.org_id)%' AND with_check LIKE '%owner_user_id%'), NULL
UNION ALL SELECT 'no UPDATE: RESTRICTIVE USING (false)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'access_recertification_events' AND policyname = 'access_recert_events_no_update'
                  AND cmd = 'UPDATE' AND permissive = 'RESTRICTIVE' AND qual = 'false'), NULL
UNION ALL SELECT 'no DELETE: RESTRICTIVE USING (false)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'access_recertification_events' AND policyname = 'access_recert_events_no_delete'
                  AND cmd = 'DELETE' AND permissive = 'RESTRICTIVE' AND qual = 'false'), NULL
UNION ALL SELECT 'no PERMISSIVE UPDATE or DELETE policy exists (nothing to OR the refusals away)',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'access_recertification_events'
                      AND permissive = 'PERMISSIVE' AND cmd IN ('UPDATE', 'DELETE', 'ALL')), NULL
UNION ALL SELECT inventory, NULL, n FROM _ao_g88_before;
