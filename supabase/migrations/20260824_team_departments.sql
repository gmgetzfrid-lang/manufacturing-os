-- 20260824_team_departments.sql
--
-- Teams as departments. A team gets a SUPERVISOR (lead), and a library can be
-- OWNED BY A TEAM — in which case that team's supervisor becomes the library's
-- effective owner. This slots a department layer into the existing owner chain
-- without disturbing roles or explicit owners:
--   document owner > folder owner > library owner > library's TEAM SUPERVISOR > Admin/DocCtrl
--
-- Additive + idempotent. Dated after 20260823.

ALTER TABLE teams     ADD COLUMN IF NOT EXISTS supervisor_user_id UUID;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS owner_team_id UUID;
CREATE INDEX IF NOT EXISTS libraries_owner_team_idx ON libraries(owner_team_id) WHERE owner_team_id IS NOT NULL;

-- Extend the server-side ownership check used by the publish guard so a team-
-- owned library resolves to the team's supervisor (mirrors lib/ownership.ts).
-- Same signature as 20260816; adds the team fallback after the library owner.
CREATE OR REPLACE FUNCTION user_is_effective_owner(p_doc_owner uuid, p_collection uuid, p_library uuid, p_uid uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_team  uuid;
BEGIN
  IF p_uid IS NULL THEN RETURN false; END IF;
  IF p_doc_owner IS NOT NULL THEN
    RETURN p_doc_owner = p_uid;                       -- an explicit doc owner is authoritative
  END IF;
  IF p_collection IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner FROM collections WHERE id = p_collection;
    IF v_owner IS NOT NULL THEN RETURN v_owner = p_uid; END IF;
  END IF;
  IF p_library IS NOT NULL THEN
    SELECT owner_user_id, owner_team_id INTO v_owner, v_team FROM libraries WHERE id = p_library;
    IF v_owner IS NOT NULL THEN RETURN v_owner = p_uid; END IF;
    IF v_team IS NOT NULL THEN                         -- team-owned library → its supervisor
      SELECT supervisor_user_id INTO v_owner FROM teams WHERE id = v_team;
      IF v_owner IS NOT NULL THEN RETURN v_owner = p_uid; END IF;
    END IF;
  END IF;
  RETURN false;
END;
$$;
