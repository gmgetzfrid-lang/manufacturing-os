-- 20260901_db_hard_enforcement.sql
--
-- Promotes the last app-layer-only enforcement to DATABASE-HARD, removing
-- the "a scripted client could still…" caveat:
--
--   1. org_capability_allows(): Postgres now reads the org's capability
--      policy (org_configurations key 'capability_policy') — role tokens
--      ('*', exact, 'Engineer' = every Engineer-N tier), additive roles[],
--      and per-person grants[] with expiry.
--   2. HOLDS: document_holds drops its members-can-do-anything policy.
--      Opening requires the holds.open capability; releasing requires
--      holds.release; hard delete stays controller-only. Defaults ('*')
--      preserve behavior for untouched orgs.
--   3. CHECKOUT FORCE-RELEASE: the guard now honors the policy — the
--      Admin/DocCtrl default can be widened or narrowed by an admin, at
--      the database, not just in the UI.
--   4. CONTENT DENY RULES: an explicit ACL deny (write / editMetadata /
--      upload) on a document, or inherited via its chain-resolved
--      acl_index, now blocks the write AT THE DATABASE (restrictive
--      policies on documents). Absent an explicit deny, behavior is
--      unchanged — this enforces the deny side of the model, which is
--      exactly what "hide/deny must actually mean no" requires.
--
-- Additive + idempotent. Apply AFTER 20260831.

-- ─── 1. Capability policy, readable by Postgres ─────────────────────────

CREATE OR REPLACE FUNCTION org_capability_allows(p_org UUID, p_cap TEXT, p_uid UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_val JSONB;
  v_tokens JSONB;
  v_role TEXT;
  v_roles TEXT[];
  v_grant JSONB;
  t TEXT;
BEGIN
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
  FROM org_members
  WHERE org_id = p_org AND uid = p_uid AND status = 'active'
  LIMIT 1;
  IF v_role IS NULL THEN RETURN FALSE; END IF;

  SELECT value INTO v_val FROM org_configurations
  WHERE org_id = p_org AND key = 'capability_policy';

  -- Role tokens for this capability: stored (canonical {caps} or legacy
  -- flat), else the SHIPPED DEFAULT for the caps the DB enforces.
  v_tokens := COALESCE(v_val->'caps'->p_cap, v_val->p_cap);
  IF v_tokens IS NULL OR jsonb_typeof(v_tokens) <> 'array' THEN
    v_tokens := CASE p_cap
      WHEN 'holds.open' THEN '["*"]'::jsonb
      WHEN 'holds.release' THEN '["*"]'::jsonb
      WHEN 'checkout.force_release' THEN '["Admin","DocCtrl"]'::jsonb
      ELSE '[]'::jsonb
    END;
  END IF;

  FOR t IN SELECT jsonb_array_elements_text(v_tokens) LOOP
    IF t = '*' THEN RETURN TRUE; END IF;
    IF t = 'Engineer' AND EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE r LIKE '%Engineer%') THEN
      RETURN TRUE;
    END IF;
    IF t = ANY(v_roles) THEN RETURN TRUE; END IF;
  END LOOP;

  -- Per-person delegation with live expiry.
  IF v_val ? 'grants' AND jsonb_typeof(v_val->'grants') = 'array' THEN
    FOR v_grant IN SELECT jsonb_array_elements(v_val->'grants') LOOP
      IF v_grant->>'cap' = p_cap AND v_grant->>'uid' = p_uid::text
         AND (v_grant->>'expiresAt' IS NULL
              OR (v_grant->>'expiresAt')::timestamptz > NOW()) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
  END IF;
  RETURN FALSE;
END;
$$;

-- ─── 2. Holds: capability-gated at the database ─────────────────────────

DROP POLICY IF EXISTS "document_holds_member_all" ON document_holds;
DROP POLICY IF EXISTS document_holds_select ON document_holds;
DROP POLICY IF EXISTS document_holds_insert ON document_holds;
DROP POLICY IF EXISTS document_holds_update ON document_holds;
DROP POLICY IF EXISTS document_holds_delete ON document_holds;

CREATE POLICY document_holds_select ON document_holds FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_holds.org_id
          AND uid = auth.uid() AND status = 'active')
);
CREATE POLICY document_holds_insert ON document_holds FOR INSERT WITH CHECK (
  org_capability_allows(org_id, 'holds.open', auth.uid())
);
-- Releasing = the UPDATE that sets released_at; the capability gates every
-- update (the row has no other mutable purpose).
CREATE POLICY document_holds_update ON document_holds FOR UPDATE USING (
  org_capability_allows(org_id, 'holds.release', auth.uid())
) WITH CHECK (
  org_capability_allows(org_id, 'holds.release', auth.uid())
);
CREATE POLICY document_holds_delete ON document_holds FOR DELETE USING (
  is_org_controller(org_id)
);

-- ─── 3. Force-release honors the policy (widen OR narrow) ───────────────

CREATE OR REPLACE FUNCTION enforce_checkout_release_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF OLD.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status
     AND OLD.user_id::text <> auth.uid()::text
     AND NOT org_capability_allows(OLD.org_id, 'checkout.force_release', auth.uid()) THEN
    RAISE EXCEPTION 'You are not allowed to release another user''s checkout. An Admin can delegate this under Admin → Permissions.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 4. Content DENY rules enforced at the database ─────────────────────
-- acl_index is chain-resolved when written (built from library→folder→node),
-- so a single-node check faithfully enforces inherited denies.

CREATE OR REPLACE FUNCTION acl_index_denies(p_idx JSONB, p_org UUID, p_uid UUID, p_action TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_roles TEXT[];
BEGIN
  IF p_idx IS NULL THEN RETURN FALSE; END IF;
  IF p_idx->'deny'->'users'->p_action ? p_uid::text THEN RETURN TRUE; END IF;
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
  FROM org_members WHERE org_id = p_org AND uid = p_uid AND status = 'active' LIMIT 1;
  IF v_roles IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_roles) r
    WHERE p_idx->'deny'->'roles'->p_action ? r
  ) THEN RETURN TRUE; END IF;
  IF EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.user_id = p_uid::text
      AND p_idx->'deny'->'teams'->p_action ? tm.team_id::text
  ) THEN RETURN TRUE; END IF;
  RETURN FALSE;
END;
$$;

-- Controllers are exempt (they hold the system together); explicit denies
-- bind everyone else. Service role (auth.uid() NULL) exempt.
DROP POLICY IF EXISTS documents_deny_write_guard ON documents;
CREATE POLICY documents_deny_write_guard ON documents
  AS RESTRICTIVE FOR UPDATE
  USING (
    auth.uid() IS NULL
    OR is_org_controller(org_id)
    OR NOT (
      acl_index_denies(acl_index, org_id, auth.uid(), 'write')
      OR acl_index_denies(acl_index, org_id, auth.uid(), 'editMetadata')
    )
  );

DROP POLICY IF EXISTS documents_deny_upload_guard ON documents;
CREATE POLICY documents_deny_upload_guard ON documents
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    auth.uid() IS NULL
    OR is_org_controller(org_id)
    OR NOT EXISTS (
      SELECT 1 FROM libraries l
      WHERE l.id = documents.library_id
        AND acl_index_denies(l.acl_index, documents.org_id, auth.uid(), 'upload')
    )
  );
