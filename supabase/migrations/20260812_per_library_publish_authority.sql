-- 20260812_per_library_publish_authority.sql
--
-- Teach the document publish-guard trigger about PER-LIBRARY publish authority.
--
-- WHY: 20260713_document_publish_guard.sql backstops "who may advance a document"
-- at the DB, but it trusts ONLY Admin/DocCtrl and otherwise just blocks on a
-- foreign lock / active hold. The product now lets an Admin grant a non-controller
-- (e.g. a Drafting Supervisor) the "publish" action on a SPECIFIC library via that
-- library's ACL. The client writes to Supabase directly, so this trigger — not the
-- app — has the final say. Without this change a granted Drafting Supervisor's
-- rev-up would be rejected at the DB even though the app allows it.
--
-- This mirrors lib/permissions.ts#canPublishOnLibrary exactly:
--   * Admin / DocCtrl  -> always allowed (broad tier; handled in the trigger).
--   * else             -> allowed iff the LIBRARY's acl_index grants this
--                         user/role/team the "publish" (or "admin") action,
--                         and is not explicitly denied it.
-- Authorized publishers may advance past a FOREIGN CHECKOUT (the override-with-
-- note flow); an active HOLD still blocks them (only controllers bypass holds).
-- Anyone without authority is now refused at the DB too (req: "no one else should
-- ever be uploading revisions unless granted").
--
-- libraries.acl_index is maintained by the Permissions drawer
-- (buildAclIndexFromChain); for a library node the chain is just the library, so
-- its own grants land in its acl_index. Strictly additive + idempotent.
--
-- >>> Apply to STAGING and exercise rev-up / revert / supersede / check-in, and a
--     granted-supervisor publish, before promoting. Idempotent: safe to re-run. <<<
--
-- Rollback (restores 20260713 behavior):
--   -- re-run 20260713_document_publish_guard.sql, then:
--   DROP FUNCTION IF EXISTS user_can_publish_on_library(uuid, text, uuid);

-- ── Per-library publish authority, read from libraries.acl_index ─────────────
-- SECURITY DEFINER so it can read libraries / org_members / team_members past RLS.
CREATE OR REPLACE FUNCTION user_can_publish_on_library(p_library uuid, p_uid text, p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role  text;
  v_teams text[];
  v_idx   jsonb;
BEGIN
  IF p_library IS NULL OR p_uid IS NULL OR p_org IS NULL THEN
    RETURN false;
  END IF;

  -- Broad controller tier is always allowed (matches isControllerRole).
  SELECT role INTO v_role
    FROM org_members
   WHERE org_id = p_org AND uid::text = p_uid AND status = 'active'
   LIMIT 1;
  IF v_role IN ('Admin', 'DocCtrl') THEN
    RETURN true;
  END IF;

  SELECT acl_index INTO v_idx FROM libraries WHERE id = p_library;
  IF v_idx IS NULL THEN
    RETURN false;   -- no grants recorded -> only controllers publish
  END IF;

  SELECT array_agg(team_id::text) INTO v_teams
    FROM team_members WHERE uid::text = p_uid AND org_id = p_org;

  -- Explicit deny of publish wins (user / role / team) — mirrors evaluateAcl.
  IF COALESCE((v_idx->'deny'->'users'->'publish') ? p_uid, false)
     OR COALESCE(v_role IS NOT NULL AND (v_idx->'deny'->'roles'->'publish') ? v_role, false)
     OR COALESCE(v_teams IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(v_teams) t WHERE (v_idx->'deny'->'teams'->'publish') ? t), false)
  THEN
    RETURN false;
  END IF;

  -- Allowed if granted "publish" OR "admin" (admin implies every action, matching
  -- evaluateAcl.can) to the user, their role, or one of their teams.
  RETURN COALESCE(
       (v_idx->'allow'->'users'->'publish') ? p_uid
    OR (v_idx->'allow'->'users'->'admin')   ? p_uid
    OR (v_role IS NOT NULL AND (
          (v_idx->'allow'->'roles'->'publish') ? v_role
       OR (v_idx->'allow'->'roles'->'admin')   ? v_role))
    OR (v_teams IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(v_teams) t
           WHERE (v_idx->'allow'->'teams'->'publish') ? t
              OR (v_idx->'allow'->'teams'->'admin')   ? t)),
    false);
END;
$$;

-- ── Recreate the publish guard so per-library publishers are honored ─────────
CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor       uuid    := auth.uid();   -- NULL for service-role / SQL console
  v_role        text;
  v_advancing   boolean;
  v_can_publish boolean;
  v_has_hold    boolean;
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

  -- Controllers (Admin / DocCtrl) may force anything (the app gates the UX).
  SELECT role INTO v_role
    FROM org_members
   WHERE org_id = NEW.org_id
     AND uid::text = v_actor::text
     AND status = 'active'
   LIMIT 1;
  IF v_role IN ('Admin', 'DocCtrl') THEN
    RETURN NEW;
  END IF;

  -- Per-library publish authority (Admin/DocCtrl already returned above).
  v_can_publish := user_can_publish_on_library(NEW.library_id, v_actor::text, NEW.org_id);

  -- Only an authorized publisher may advance a document at all.
  IF NOT v_can_publish THEN
    RAISE EXCEPTION
      'You do not have authority to publish revisions in this library.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- An authorized publisher MAY advance past a foreign checkout (the override-
  -- with-note flow lives in the app). We deliberately do NOT block on
  -- checked_out_by here. But an active HOLD still blocks them — holds are
  -- controller-only to bypass, and controllers already returned.
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

-- Trigger definition is unchanged but re-created idempotently for clarity.
DROP TRIGGER IF EXISTS trg_document_publish_guard ON documents;
CREATE TRIGGER trg_document_publish_guard
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_document_publish_guard();
