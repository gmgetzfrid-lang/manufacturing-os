-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 6 severity sweep, Round B (1 of 2):
-- authority by the role COLLECTION everywhere the database still read the
-- headline mirror, the three evaluators agreeing on explicit deny, terminal
-- status transitions guarded, the mirror kept in sync at the database.
--
--   ADD-4     Fifteen policies / functions still read org_members.role alone.
--             Every one now goes through caller_holds_any_role (20261045) or
--             the collection directly. Includes is_org_admin (the "only an
--             Admin may confer Admin" clause and the branding policies),
--             the teams policies (SURF-16 DB half), orgs_admin_write (only
--             ever defined in schema.sql), and prevent_last_admin_removal
--             (the last-admin invariant missed collection-only Admins).
--   DOCACL-1  can_manage_node matched a role-subject grant against the
--             headline only — an additively held role could not manage.
--   DEL-4     Changing a department's supervisor transfers publish authority
--             over every library it owns; a BEFORE UPDATE guard makes that a
--             controller act (Manager keeps name/colour/roster).
--   OWN-8     Explicit deny wins (DEC-8): an 'admin' allow no longer grants
--             publish when 'admin' is explicitly denied (the app evaluators
--             change in the same commit).
--   OWN-15    Leaving Superseded / Archived / Void is a publish-shaped act:
--             enforce_document_publish_guard treats it as advancing.
--   ADD-5     A BEFORE INSERT OR UPDATE trigger keeps org_members.role
--             (the mirror) and roles[] (the collection) consistent.
--   DEL-9     user_is_effective_owner is executable by authenticated, so the
--             app can ask the SAME cascade the database enforces.
--
-- Widening (an additively held Admin/Manager/DocCtrl/Supervisor gains where
-- the headline alone was read): the pre-apply inventory at the end is
-- recorded BEFORE the DDL is pasted (DEC-2 reversal clause).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 0. helpers ──────────────────────────────────────────────────────────────
-- is_org_admin: by the collection (feeds org_members_update/write's
-- Admin-conferral clause and the branding policies).
CREATE OR REPLACE FUNCTION is_org_admin(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT caller_holds_any_role(p_org, ARRAY['Admin']::text[]);
$$;

-- ADD-5: the rank table lib/roleCapabilities.ts ROLE_RANK uses — never
-- reordered (DEC-2); a role unknown to the table ranks 0.
CREATE OR REPLACE FUNCTION role_rank(p_role text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role
    WHEN 'Admin' THEN 100 WHEN 'Manager' THEN 90 WHEN 'Supervisor' THEN 80
    WHEN 'DraftingSupervisor' THEN 75 WHEN 'DocCtrl' THEN 70
    WHEN 'Engineer-4' THEN 64 WHEN 'Engineer-3' THEN 63 WHEN 'Engineer-2' THEN 62 WHEN 'Engineer-1' THEN 61
    WHEN 'Drafter' THEN 50 WHEN 'Requester' THEN 40
    WHEN 'Operations' THEN 35 WHEN 'Maintenance' THEN 34 WHEN 'Safety' THEN 33
    WHEN 'HR' THEN 32 WHEN 'Accounting' THEN 31 WHEN 'Contractor' THEN 30
    WHEN 'Auditor' THEN 20 WHEN 'Viewer' THEN 10
    ELSE 0 END;
$$;

-- ADD-5: the invariant lib/roleCapabilities.ts computes (primaryRole /
-- normalizeRoles), enforced where the row is written. Idempotent for every
-- correct row. A writer that wants to DEMOTE must remove the role from the
-- collection — the headline is derived, never authoritative.
CREATE OR REPLACE FUNCTION org_members_sync_role_collection()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_headline text;
BEGIN
  -- (a) an empty collection is seeded from the headline
  IF (NEW.roles IS NULL OR NEW.roles = '{}') AND NEW.role IS NOT NULL AND NEW.role <> '' THEN
    NEW.roles := ARRAY[NEW.role];
  END IF;
  -- (b) the headline is always a member of the collection
  IF NEW.role IS NOT NULL AND NEW.role <> '' AND NOT (NEW.role = ANY(NEW.roles)) THEN
    NEW.roles := NEW.roles || ARRAY[NEW.role];
  END IF;
  -- (c) the headline is the highest-ranked held role
  IF NEW.roles IS NOT NULL AND array_length(NEW.roles, 1) > 0 THEN
    SELECT r INTO v_headline FROM unnest(NEW.roles) r ORDER BY role_rank(r) DESC, r ASC LIMIT 1;
    IF v_headline IS NOT NULL AND v_headline IS DISTINCT FROM NEW.role THEN
      NEW.role := v_headline;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_members_sync_roles ON org_members;
CREATE TRIGGER trg_org_members_sync_roles
  BEFORE INSERT OR UPDATE OF role, roles ON org_members
  FOR EACH ROW EXECUTE FUNCTION org_members_sync_role_collection();

-- One-shot repair of rows written before the trigger (idempotent; the same
-- two branches as 20261024, never losing a role).
UPDATE org_members SET roles = ARRAY[role]
 WHERE role IS NOT NULL AND role <> '' AND (roles IS NULL OR roles = '{}');
UPDATE org_members SET roles = roles || ARRAY[role]
 WHERE role IS NOT NULL AND role <> '' AND roles <> '{}' AND NOT (role = ANY(roles));

-- ── 1. ADD-4: the mirror-only definitions, by the collection ────────────────
-- teams / team_members (SURF-16 DB half): Admin or Manager by collection.
DROP POLICY IF EXISTS teams_admin_write ON teams;
CREATE POLICY teams_admin_write ON teams FOR ALL
  USING (caller_holds_any_role(org_id, ARRAY['Admin','Manager']::text[]))
  WITH CHECK (caller_holds_any_role(org_id, ARRAY['Admin','Manager']::text[]));
DROP POLICY IF EXISTS team_members_admin_write ON team_members;
CREATE POLICY team_members_admin_write ON team_members FOR ALL
  USING (caller_holds_any_role(org_id, ARRAY['Admin','Manager']::text[]))
  WITH CHECK (caller_holds_any_role(org_id, ARRAY['Admin','Manager']::text[]));

-- DEL-4: the supervisor swap is the authority transfer — controllers only.
CREATE OR REPLACE FUNCTION teams_guard_supervisor_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF NEW.supervisor_user_id IS DISTINCT FROM OLD.supervisor_user_id
     AND NOT is_org_controller(OLD.org_id) THEN
    RAISE EXCEPTION 'Only an Admin or Document Controller can change a department''s supervisor — it transfers publish authority over every library the department owns.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS teams_guard_supervisor ON teams;
CREATE TRIGGER teams_guard_supervisor
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_guard_supervisor_change();

-- checkout_messages: own row, or a controller by collection.
DROP POLICY IF EXISTS checkout_messages_own_update ON checkout_messages;
CREATE POLICY checkout_messages_own_update ON checkout_messages FOR UPDATE USING (
  user_id::text = auth.uid()::text
  OR caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl']::text[])
);

-- orgs: only ever defined in schema.sql — recreated here by the collection.
DROP POLICY IF EXISTS orgs_admin_write ON orgs;
CREATE POLICY orgs_admin_write ON orgs FOR UPDATE
  USING (caller_holds_any_role(id, ARRAY['Admin']::text[]));

-- The eight FOR ALL write policies on the intelligence / registry side
-- tables. Existing tables only (the loop skips one that is not present).
DO $$
DECLARE
  spec record;
  pred text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('org_ai_instructions',        'org_ai_instructions_write',        ARRAY['Admin','DocCtrl']),
      ('document_related_resources', 'document_related_resources_write', ARRAY['Admin','DocCtrl','Manager','Supervisor']),
      ('library_numbering',          'library_numbering_write',          ARRAY['Admin','DocCtrl']),
      ('proposed_links',             'proposed_links_write',             ARRAY['Admin','DocCtrl','Manager','Supervisor']),
      ('asset_aliases',              'asset_aliases_write',              ARRAY['Admin','DocCtrl','Manager','Supervisor']),
      ('codebook_entries',           'codebook_entries_write',           ARRAY['Admin','DocCtrl']),
      ('codebook_config',            'codebook_config_write',            ARRAY['Admin','DocCtrl']),
      ('entity_mentions',            'entity_mentions_write',            ARRAY['Admin','DocCtrl','Manager','Supervisor'])
    ) v(tbl, pol, roles)
  LOOP
    IF to_regclass('public.' || spec.tbl) IS NULL THEN CONTINUE; END IF;
    pred := format('caller_holds_any_role(org_id, %L::text[])', spec.roles);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', spec.pol, spec.tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (%s) WITH CHECK (%s)', spec.pol, spec.tbl, pred, pred);
  END LOOP;
END $$;

-- DOCACL-1 / ADD-4: can_manage_node evaluates ANY held role (allow and deny).
CREATE OR REPLACE FUNCTION can_manage_node(p_acl_index jsonb, p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   text := auth.uid()::text;
  v_role  text;
  v_roles text[];
  v_teams text[];
  v_allow jsonb;
  v_deny  jsonb;
  v_org   text := p_org::text;
BEGIN
  IF is_org_controller(p_org) THEN RETURN true; END IF;
  IF p_acl_index IS NULL THEN RETURN false; END IF;

  -- The member's FULL role collection (headline ∪ additive).
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;
  IF v_role IS NULL THEN RETURN false; END IF;  -- not an active member of this org
  IF NOT (v_role = ANY(v_roles)) THEN v_roles := array_append(v_roles, v_role); END IF;
  SELECT array_agg(team_id::text) INTO v_teams FROM team_members WHERE uid = auth.uid();

  v_allow := p_acl_index->'allow';
  v_deny  := p_acl_index->'deny';

  -- 'admin' allow (user / ANY held role / team) wins unless 'admin' is denied
  -- to the user, ANY held role, or a team (deny-if-any, CHAIN-1).
  IF EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE acl_subject_has_action(v_allow, 'admin', v_uid, r, v_teams, v_org))
     AND NOT EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE acl_subject_has_action(v_deny, 'admin', v_uid, r, v_teams, v_org)) THEN
    RETURN true;
  END IF;
  -- 'managePermissions' allow unless denied — same shape.
  IF EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE acl_subject_has_action(v_allow, 'managePermissions', v_uid, r, v_teams, v_org))
     AND NOT EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE acl_subject_has_action(v_deny, 'managePermissions', v_uid, r, v_teams, v_org)) THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

-- The last-admin invariant by the collection (an Admin held additively counts).
CREATE OR REPLACE FUNCTION prevent_last_admin_removal()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_remaining INT;
  v_old_admin boolean;
  v_new_admin boolean;
BEGIN
  -- Service-role / SQL-console operations (restore, support) are exempt.
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_old_admin := OLD.status = 'active' AND (OLD.role = 'Admin' OR OLD.roles && ARRAY['Admin']::text[]);
  v_new_admin := TG_OP <> 'DELETE' AND NEW.status = 'active' AND (NEW.role = 'Admin' OR NEW.roles && ARRAY['Admin']::text[]);
  -- Only care when an ACTIVE Admin (by collection) stops being one.
  IF v_old_admin AND NOT v_new_admin THEN
    SELECT COUNT(*) INTO v_remaining
    FROM org_members
    WHERE org_id = OLD.org_id AND status = 'active' AND uid <> OLD.uid
      AND (role = 'Admin' OR roles && ARRAY['Admin']::text[]);
    IF v_remaining = 0 THEN
      RAISE EXCEPTION 'This is the organization''s last active Admin — assign another Admin before demoting or removing this one.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ── 2. OWN-8: explicit deny wins on the publish path (body from 20261040) ───
CREATE OR REPLACE FUNCTION user_can_publish_on_library(p_library uuid, p_uid text, p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role  text;
  v_roles text[];
  v_teams text[];
  v_idx   jsonb;
  v_admin_denied boolean;
BEGIN
  IF p_library IS NULL OR p_uid IS NULL OR p_org IS NULL THEN
    RETURN false;
  END IF;

  -- The member's FULL role collection (headline ∪ additive), never empty
  -- for an active member.
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
    FROM org_members
   WHERE org_id = p_org AND uid::text = p_uid AND status = 'active'
   LIMIT 1;
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  IF NOT (v_role = ANY(v_roles)) THEN
    v_roles := array_append(v_roles, v_role);
  END IF;

  -- OWN-3/DEC-2: the broad controller tier follows the COLLECTION.
  IF v_roles && ARRAY['Admin','DocCtrl']::text[] THEN
    RETURN true;
  END IF;

  SELECT acl_index INTO v_idx FROM libraries WHERE id = p_library;
  IF v_idx IS NULL THEN
    RETURN false;   -- no grants recorded -> only controllers publish
  END IF;

  SELECT array_agg(team_id::text) INTO v_teams
    FROM team_members WHERE uid::text = p_uid AND org_id = p_org;

  -- Explicit deny of publish wins (user / ANY held role / team).
  IF COALESCE((v_idx->'deny'->'users'->'publish') ? p_uid, false)
     OR EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE (v_idx->'deny'->'roles'->'publish') ? r)
     OR COALESCE(v_teams IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(v_teams) t WHERE (v_idx->'deny'->'teams'->'publish') ? t), false)
  THEN
    RETURN false;
  END IF;

  -- OWN-8 / DEC-8: an 'admin' allow grants publish only when 'admin' is not
  -- itself explicitly denied (user / ANY held role / team) — the app's
  -- evaluators apply the same order.
  v_admin_denied :=
       COALESCE((v_idx->'deny'->'users'->'admin') ? p_uid, false)
    OR EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE (v_idx->'deny'->'roles'->'admin') ? r)
    OR COALESCE(v_teams IS NOT NULL AND EXISTS (
         SELECT 1 FROM unnest(v_teams) t WHERE (v_idx->'deny'->'teams'->'admin') ? t), false);

  -- Allowed if granted "publish" OR (not admin-denied and granted "admin") to
  -- the user, ANY held role, or a team.
  RETURN COALESCE(
       (v_idx->'allow'->'users'->'publish') ? p_uid
    OR (NOT v_admin_denied AND (v_idx->'allow'->'users'->'admin') ? p_uid)
    OR EXISTS (SELECT 1 FROM unnest(v_roles) r
                WHERE (v_idx->'allow'->'roles'->'publish') ? r
                   OR (NOT v_admin_denied AND (v_idx->'allow'->'roles'->'admin') ? r))
    OR (v_teams IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(v_teams) t
           WHERE (v_idx->'allow'->'teams'->'publish') ? t
              OR (NOT v_admin_denied AND (v_idx->'allow'->'teams'->'admin') ? t))),
    false);
END;
$$;

-- ── 3. OWN-15: leaving a terminal status takes publish authority (body from 20261045)
CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor        uuid    := auth.uid();   -- NULL for service-role / SQL console
  v_advancing    boolean;
  v_independent  integer;
  v_on_roster    boolean;
  v_require_ind  boolean;
  v_can_publish  boolean;
  v_has_hold     boolean;
  v_primary_reqs integer;
  v_signed       integer;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_advancing :=
       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded')
    -- OWN-15: un-supersede, unarchive and un-void are publish-shaped acts —
    -- the same authority that put the record there takes it back out.
    OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status);
  IF NOT v_advancing THEN
    RETURN NEW;
  END IF;

  -- Review gate (applies to ALL authenticated publishers, including Admin/DocCtrl):
  -- if the version being made current has a reviewer roster, every required sign-
  -- off must be in — and a sign-off only counts when it carries the reviewer's
  -- OWN e-signature for this draft (RG-1: a row born 'signed' is not an approval).
  IF NEW.current_version_id IS NOT NULL
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    -- The version match tolerates a NULL on the SIGNATURE side only: legacy
    -- signatures predate the column being stamped, and the only ways to MINT
    -- a signed row now (rail 1 + rail 2) both require a strict match — so
    -- the tolerant branch is reachable only for pre-existing history.
    SELECT count(*) FILTER (WHERE s.slot = 'primary'),
           count(*) FILTER (WHERE s.status = 'signed'
                              AND s.signature_id IS NOT NULL
                              AND EXISTS (
                                SELECT 1 FROM e_signatures e
                                WHERE e.id = s.signature_id
                                  AND e.signer_user_id = s.reviewer_user_id
                                  AND e.org_id = s.org_id
                                  AND (e.document_version_id = s.document_version_id
                                       OR e.document_version_id IS NULL)
                              ))
      INTO v_primary_reqs, v_signed
      FROM document_review_signoffs s
     WHERE s.document_version_id = NEW.current_version_id;
    IF COALESCE(v_primary_reqs, 0) > 0 AND COALESCE(v_signed, 0) < v_primary_reqs THEN
      RAISE EXCEPTION
        'This revision still has outstanding review sign-offs; complete the review before publishing.'
        USING ERRCODE = 'check_violation';
    END IF;

    -- DEC-21: reviewer independence. When the publisher is themselves on the
    -- roster, at least one signed PRIMARY must be someone else. A per-library
    -- policy, ON by default wherever a roster is configured; a library opts
    -- out with review_control.requireIndependentReviewer = false.
    IF COALESCE(v_primary_reqs, 0) > 0 THEN
      SELECT EXISTS (SELECT 1 FROM document_review_signoffs s
                      WHERE s.document_version_id = NEW.current_version_id
                        AND s.reviewer_user_id = v_actor)
        INTO v_on_roster;
      IF v_on_roster THEN
        SELECT COALESCE((l.review_control->>'requireIndependentReviewer')::boolean, true)
          INTO v_require_ind FROM libraries l WHERE l.id = NEW.library_id;
        IF COALESCE(v_require_ind, true) THEN
          SELECT count(*) INTO v_independent
            FROM document_review_signoffs s
           WHERE s.document_version_id = NEW.current_version_id
             AND s.slot = 'primary' AND s.status = 'signed' AND s.signature_id IS NOT NULL
             AND s.reviewer_user_id <> v_actor;
          IF COALESCE(v_independent, 0) = 0 THEN
            RAISE EXCEPTION
              'Reviewer independence: you are on this revision''s review roster, so at least one other primary reviewer must sign before you can publish it.'
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION.
  -- v_actor IS auth.uid() here (service-role returned above), so the shared
  -- additive helper applies.
  IF is_org_controller(NEW.org_id) THEN
    RETURN NEW;
  END IF;

  -- Per-library publish authority OR the document's effective owner may publish.
  v_can_publish := user_can_publish_on_library(NEW.library_id, v_actor::text, NEW.org_id)
                OR user_is_effective_owner(NEW.owner_user_id, NEW.collection_id, NEW.library_id, v_actor);

  IF NOT v_can_publish THEN
    RAISE EXCEPTION
      'You do not have authority to publish revisions in this library.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM document_holds h
     WHERE h.document_id = NEW.id AND h.released_at IS NULL
  ) INTO v_has_hold;
  IF v_has_hold THEN
    RAISE EXCEPTION
      'Document has an active hold; release the hold before publishing a new revision.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 4. DEL-9: the app may ask the database's own ownership cascade ──────────
GRANT EXECUTE ON FUNCTION user_is_effective_owner(uuid, uuid, uuid, uuid) TO authenticated;

COMMIT;

-- ── Verification (read-only) — expect true × 12 ─────────────────────────────
SELECT 'is_org_admin reads the collection' AS check,
       (SELECT prosrc LIKE '%caller_holds_any_role(p_org, ARRAY[''Admin'']::text[])%' FROM pg_proc WHERE proname = 'is_org_admin') AS ok
UNION ALL
SELECT 'teams / team_members write policies read the collection',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE policyname IN ('teams_admin_write', 'team_members_admin_write') AND qual LIKE '%caller_holds_any_role(org_id%')
UNION ALL
SELECT 'supervisor change is a controller act (BEFORE UPDATE guard on teams)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'teams_guard_supervisor' AND tgrelid = 'teams'::regclass AND NOT tgisinternal)
UNION ALL
SELECT 'checkout_messages / orgs policies read the collection',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE policyname IN ('checkout_messages_own_update', 'orgs_admin_write') AND qual LIKE '%caller_holds_any_role(%')
UNION ALL
SELECT 'the eight side-table write policies read the collection (existing tables only)',
       (SELECT COUNT(*) = (SELECT COUNT(*) FROM (VALUES ('org_ai_instructions'),('document_related_resources'),('library_numbering'),('proposed_links'),('asset_aliases'),('codebook_entries'),('codebook_config'),('entity_mentions')) v(t)
                                WHERE to_regclass('public.' || v.t) IS NOT NULL)
          FROM pg_policies WHERE policyname IN ('org_ai_instructions_write','document_related_resources_write','library_numbering_write','proposed_links_write','asset_aliases_write','codebook_entries_write','codebook_config_write','entity_mentions_write')
            AND qual LIKE '%caller_holds_any_role(org_id%')
UNION ALL
SELECT 'can_manage_node evaluates every held role',
       (SELECT prosrc LIKE '%unnest(v_roles) r WHERE acl_subject_has_action(v_allow, ''admin''%' FROM pg_proc WHERE proname = 'can_manage_node')
UNION ALL
SELECT 'last-admin invariant counts collection-held Admins',
       (SELECT prosrc LIKE '%OLD.roles && ARRAY[''Admin'']::text[]%' FROM pg_proc WHERE proname = 'prevent_last_admin_removal')
UNION ALL
SELECT 'publish authority: an admin allow is gated on no admin deny',
       (SELECT prosrc LIKE '%v_admin_denied%' FROM pg_proc WHERE proname = 'user_can_publish_on_library')
UNION ALL
SELECT 'publish guard treats leaving Superseded/Archived/Void as advancing',
       (SELECT prosrc LIKE '%OLD.status IN (''Superseded'', ''Archived'', ''Void'')%' FROM pg_proc WHERE proname = 'enforce_document_publish_guard')
UNION ALL
SELECT 'role/roles sync trigger installed and the rank table matches the app',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_org_members_sync_roles' AND tgrelid = 'org_members'::regclass AND NOT tgisinternal)
       AND role_rank('Admin') = 100 AND role_rank('DocCtrl') = 70 AND role_rank('Viewer') = 10 AND role_rank('nonsense') = 0
UNION ALL
SELECT 'user_is_effective_owner executable by authenticated',
       has_function_privilege('authenticated', 'user_is_effective_owner(uuid, uuid, uuid, uuid)', 'EXECUTE')
UNION ALL
SELECT 'search_path pinned on the seven re-created functions',
       (SELECT COUNT(*) = 7 FROM pg_proc
         WHERE proname IN ('is_org_admin', 'org_members_sync_role_collection', 'teams_guard_supervisor_change', 'can_manage_node',
                           'prevent_last_admin_removal', 'user_can_publish_on_library', 'enforce_document_publish_guard')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%');

-- ── Inventory (read-only, aggregate) — run BEFORE the DDL ───────────────────
-- Widening: members whose additively held role is now read where only the
-- headline was; and the rows the sync trigger's one-shot repair will touch.
SELECT 'members holding Admin/Manager/DocCtrl/Supervisor additively under a lower headline' AS inventory, COUNT(*)::text AS n
FROM org_members m WHERE m.status = 'active'
  AND EXISTS (SELECT 1 FROM unnest(COALESCE(m.roles, ARRAY[]::text[])) r
              WHERE r IN ('Admin','Manager','DocCtrl','Supervisor') AND r <> m.role)
UNION ALL
SELECT 'members whose roles[] is empty (seeded from the headline by the repair)', COUNT(*)::text
FROM org_members WHERE roles IS NULL OR roles = '{}'
UNION ALL
SELECT 'members whose headline is missing from roles[] (appended by the repair)', COUNT(*)::text
FROM org_members WHERE roles <> '{}' AND role IS NOT NULL AND role <> '' AND NOT (role = ANY(roles))
UNION ALL
SELECT 'members whose headline is not their highest-ranked held role (re-derived on next write)', COUNT(*)::text
FROM org_members m WHERE m.roles IS NOT NULL AND array_length(m.roles, 1) > 1
  AND m.role IS DISTINCT FROM (SELECT r FROM unnest(m.roles) r ORDER BY
        CASE r WHEN 'Admin' THEN 100 WHEN 'Manager' THEN 90 WHEN 'Supervisor' THEN 80 WHEN 'DraftingSupervisor' THEN 75 WHEN 'DocCtrl' THEN 70
               WHEN 'Engineer-4' THEN 64 WHEN 'Engineer-3' THEN 63 WHEN 'Engineer-2' THEN 62 WHEN 'Engineer-1' THEN 61 WHEN 'Drafter' THEN 50
               WHEN 'Requester' THEN 40 WHEN 'Operations' THEN 35 WHEN 'Maintenance' THEN 34 WHEN 'Safety' THEN 33 WHEN 'HR' THEN 32
               WHEN 'Accounting' THEN 31 WHEN 'Contractor' THEN 30 WHEN 'Auditor' THEN 20 WHEN 'Viewer' THEN 10 ELSE 0 END DESC, r ASC LIMIT 1)
UNION ALL
SELECT 'documents currently Superseded / Archived / Void (now guarded on the way out)', COUNT(*)::text
FROM documents WHERE status IN ('Superseded','Archived','Void');
