-- EGRESS-5 / DEC-19: scope access_requests to its org, close the anonymous
-- insert door, and reconcile the org_id column drift.
--
-- The orphan-table backfill (20260819) created access_requests WITHOUT org_id
-- and an admin SELECT policy correlated on NOTHING — so any active Admin of any
-- org could read every org's access requests (name + email) via PostgREST. The
-- live route already filters and inserts org_id, so the backfill CREATE TABLE
-- is the stale side; this migration adds the column (idempotent), backfills
-- legacy rows by org name (fail closed: unmatched rows stay NULL = visible to
-- no one), org-correlates the SELECT policy (additive-roles aware), and removes
-- the WITH CHECK(true) anonymous insert policy — the only writer is the
-- service-role request-access route, which bypasses RLS.
--
-- Do NOT edit 20260819 — it must stay a faithful no-op against the live DB.

-- 1. org_id drift.
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES orgs(id) ON DELETE CASCADE;

UPDATE access_requests ar
   SET org_id = o.id
  FROM orgs o
 WHERE ar.org_id IS NULL
   AND lower(btrim(o.name)) = lower(btrim(ar.org_name));

-- 2. Org-correlated admin SELECT, additive-roles aware.
DROP POLICY IF EXISTS access_requests_admin_select ON access_requests;
CREATE POLICY access_requests_admin_select ON access_requests FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
      WHERE m.org_id = access_requests.org_id
        AND m.uid = auth.uid()
        AND m.status = 'active'
        AND (m.role = 'Admin' OR m.roles && ARRAY['Admin']::text[])
    )
  );

-- 3. Close the direct anonymous PostgREST insert door. The public route inserts
--    with the service role (RLS-bypassing), same posture as signup_attempts
--    (RLS on, no policies → service-role only). This stops an attacker writing
--    access_requests rows straight through PostgREST, unmediated by the
--    route's rate limit.
DROP POLICY IF EXISTS access_requests_anyone_insert ON access_requests;

-- 4. Hot queries: the admin pending list and the route's duplicate check.
CREATE INDEX IF NOT EXISTS access_requests_org_status_idx ON access_requests (org_id, status);
