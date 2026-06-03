-- 20260712_document_publish_guard.sql
--
-- DEFENSE-IN-DEPTH for the document-control invariants now enforced in
-- lib/documentGuards.ts. The app guard covers every path that goes through
-- the lib (rev-up / revert / supersede). This trigger backstops anything that
-- bypasses it — a raw PostgREST call, a future code path, a bug — so the DB
-- itself refuses to advance a document that is locked by someone else or
-- sitting on an active hold.
--
-- FAIL-SAFE / CONSERVATIVE by design (chosen to avoid breaking legitimate
-- flows, mirroring 20260708_acl_rls_enforcement.sql):
--   * It ONLY guards "advance" transitions — a new canonical version
--     (current_version_id changes) or a supersession (status -> 'Superseded').
--     Lock clears, collaborator edits, metadata, archive, etc. pass untouched.
--   * Service-role / SQL-console writes (no JWT, auth.uid() IS NULL) are
--     trusted and skip the guard.
--   * Controllers (Admin / DocCtrl) are trusted to force — the app adds an
--     explicit force-confirm UX; the DB only blocks everyone else.
--   * All identity comparisons are ::text so they're type-agnostic.
--
-- >>> Apply to STAGING and exercise rev-up / revert / supersede / check-in
--     before promoting to production. Idempotent: safe to re-run. <<<
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_document_publish_guard ON documents;
--   DROP FUNCTION IF EXISTS enforce_document_publish_guard();

CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor    uuid    := auth.uid();   -- NULL for service-role / SQL console
  v_role     text;
  v_advancing boolean;
  v_has_hold boolean;
BEGIN
  -- Trusted server-side (no JWT) — skip.
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only guard canonical "advance" transitions.
  v_advancing :=
       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded');
  IF NOT v_advancing THEN
    RETURN NEW;
  END IF;

  -- Controllers may force (the app gates the force UX; the DB trusts them).
  SELECT role INTO v_role
    FROM org_members
   WHERE org_id = NEW.org_id
     AND uid::text = v_actor::text
     AND status = 'active'
   LIMIT 1;
  IF v_role IN ('Admin', 'DocCtrl') THEN
    RETURN NEW;
  END IF;

  -- Block: checked out by someone other than the actor.
  IF OLD.checked_out_by IS NOT NULL
     AND OLD.checked_out_by::text <> v_actor::text THEN
    RAISE EXCEPTION
      'Document is checked out by another user; check it in or force-unlock before publishing a new revision.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Block: an active (unreleased) hold exists.
  SELECT EXISTS (
    SELECT 1 FROM document_holds h
     WHERE h.document_id = NEW.id
       AND h.released_at IS NULL
  ) INTO v_has_hold;
  IF v_has_hold THEN
    RAISE EXCEPTION
      'Document has an active hold; release the hold before publishing a new revision.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_publish_guard ON documents;
CREATE TRIGGER trg_document_publish_guard
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_document_publish_guard();

-- ── Subscription helper (NOT wired to any blocking policy yet) ──────────────
-- Mirrors lib/subscription.ts#hasAccess so future RLS write-policies (or a
-- server check) can gate billable writes on a current subscription. Provided
-- here so the logic lives in ONE place at the DB layer when you're ready to
-- enforce it; wiring it into RESTRICTIVE policies should be validated in
-- staging (it can lock out a workspace if mis-scoped).
CREATE OR REPLACE FUNCTION org_has_active_subscription(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN o.subscription_status IN ('active', 'past_due') THEN true
    WHEN o.subscription_status = 'trialing'
         AND (o.trial_ends_at IS NULL OR o.trial_ends_at > now()) THEN true
    ELSE false
  END
  FROM orgs o
  WHERE o.id = p_org;
$$;
