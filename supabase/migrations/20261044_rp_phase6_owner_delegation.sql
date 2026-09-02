-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 6 — DEL-1 + GAP-3: an owner can delegate a
-- specific file (bounded), and folder-level delegation is possible at all.
--
-- The database already honoured a managePermissions/admin grant on a node
-- (can_manage_node) — that path just had no client. The client now computes
-- the drawer's authority as controller OR effective owner OR manage-grant,
-- and edits in "delegation mode" for non-controllers: allow-only, no
-- admin/managePermissions, expiry required. This migration makes the
-- database agree, and bounds the owner at the layer a devtools client
-- talks to:
--   1. documents_guard_access_change — the effective owner may change the
--      ACL/visibility of their own document (owner arm), and a NON-controller
--      may not mint admin/managePermissions grants (per-bucket comparison of
--      the chain-resolved acl_index the DB itself reads).
--   2. collections_update_controllers — controller OR folder owner OR
--      manage-grant (was controller-only: "folder-level delegation is dead at
--      the database").
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Helper: does NEW's allow-index grant `admin` or `managePermissions` to any
-- subject that OLD's did not? (Bucket-by-bucket, subject-by-subject.)
CREATE OR REPLACE FUNCTION acl_index_grants_admin_beyond(p_old jsonb, p_new jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM (VALUES ('users'), ('roles'), ('teams'), ('orgs')) b(bucket),
         (VALUES ('admin'), ('managePermissions')) a(action),
         jsonb_array_elements_text(COALESCE(p_new->'allow'->b.bucket->a.action, '[]'::jsonb)) subj
    WHERE NOT (COALESCE(p_old->'allow'->b.bucket->a.action, '[]'::jsonb) ? subj)
  );
$$;

-- ── 1. documents: owner arm + non-controller bound (body from 20261036) ─────
CREATE OR REPLACE FUNCTION documents_guard_access_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.visibility IS DISTINCT FROM OLD.visibility
      OR NEW.acl IS DISTINCT FROM OLD.acl
      OR NEW.acl_index IS DISTINCT FROM OLD.acl_index) THEN
    -- Only real end users are gated; service-role/superuser have a null uid.
    -- DEL-1 / GAP-3: the document's EFFECTIVE owner may delegate on their own
    -- node (owner arm), alongside controllers and manage-grant holders.
    IF auth.uid() IS NOT NULL
       AND NOT can_manage_node(OLD.acl_index, OLD.org_id)
       AND NOT user_is_effective_owner(OLD.owner_user_id, OLD.collection_id, OLD.library_id, auth.uid())
       AND NOT (OLD.acl_index IS NULL AND COALESCE(OLD.visibility, 'normal') = 'normal') THEN
      RAISE EXCEPTION 'Not permitted to change document visibility or access control on this document';
    END IF;
    -- GAP-3 bound: a NON-controller may not mint new admin / managePermissions
    -- grants (that would be self-escalation dressed as delegation). Compared
    -- per subject bucket on the chain-resolved index the DB itself reads.
    IF auth.uid() IS NOT NULL AND NOT is_org_controller(OLD.org_id)
       AND acl_index_grants_admin_beyond(OLD.acl_index, NEW.acl_index) THEN
      RAISE EXCEPTION 'Owners can delegate access but cannot grant Admin or Manage Permissions — ask a controller.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- OWN-2: ownership is authority (the effective owner may publish), so the
  -- owner columns get the same discipline: a controller, an ACL
  -- manage-grant, or the CURRENT owner may reassign. First assignment on an
  -- unowned, unrestricted document stays open (DEC-6: the Inspector's
  -- "Assign owner" must keep working on default-open libraries); a TAKEOVER
  -- of an owned document is refused.
  IF (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.owner_name IS DISTINCT FROM OLD.owner_name) THEN
    IF auth.uid() IS NOT NULL
       AND NOT is_org_controller(OLD.org_id)
       AND NOT can_manage_node(OLD.acl_index, OLD.org_id)
       AND OLD.owner_user_id::text IS DISTINCT FROM auth.uid()::text
       AND NOT (OLD.owner_user_id IS NULL
                AND OLD.acl_index IS NULL
                AND COALESCE(OLD.visibility, 'normal') = 'normal') THEN
      RAISE EXCEPTION 'Not permitted to change this document''s owner.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


-- ── 2. folders: controller OR owner OR manage-grant ─────────────────────────
DROP POLICY IF EXISTS collections_update_controllers ON collections;
CREATE POLICY collections_update_controllers ON collections
  AS RESTRICTIVE FOR UPDATE
  USING (
    is_org_controller(org_id)
    OR owner_user_id::text = auth.uid()::text
    OR can_manage_node(acl_index, org_id)
  )
  WITH CHECK (
    is_org_controller(org_id)
    OR owner_user_id::text = auth.uid()::text
    OR can_manage_node(acl_index, org_id)
    -- GAP-3 bound: a non-controller's folder write may not mint admin grants.
    OR NOT acl_index_grants_admin_beyond('{}'::jsonb, acl_index)
  );

COMMIT;

-- ── Verification (read-only) — expect true × 4 ──────────────────────────────
SELECT 'documents access guard carries the owner arm' AS check,
       (SELECT prosrc LIKE '%user_is_effective_owner(OLD.owner_user_id, OLD.collection_id, OLD.library_id, auth.uid())%'
          AND prosrc LIKE '%acl_index_grants_admin_beyond(OLD.acl_index, NEW.acl_index)%'
          FROM pg_proc WHERE proname = 'documents_guard_access_change') AS ok
UNION ALL
SELECT 'documents access guard keeps the OWN-2 ownership arm',
       (SELECT prosrc LIKE '%Not permitted to change this document''s owner.%'
          FROM pg_proc WHERE proname = 'documents_guard_access_change')
UNION ALL
SELECT 'folder update policy admits owner and manage-grant',
       (SELECT qual LIKE '%owner_user_id%::text = %auth.uid()%::text%' AND qual LIKE '%can_manage_node(acl_index, org_id)%'
          FROM pg_policies WHERE tablename = 'collections' AND policyname = 'collections_update_controllers')
UNION ALL
SELECT 'admin-grant bound helper installed',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'acl_index_grants_admin_beyond');
