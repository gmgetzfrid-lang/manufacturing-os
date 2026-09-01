-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 4 — the ticket workflow's DATABASE rails.
--
-- The workflow engine (lib/workflow.ts) and the workflow-action route decide
-- WHO may transition a ticket, but until now the tickets table itself accepted
-- any UPDATE from any active org member (tickets_org_access FOR ALL USING
-- org-membership, no WITH CHECK, no triggers beyond tsvector). This migration
-- gives the state machine teeth at the layer a devtools client talks to:
--
--   WF-5  (INSERT)  a creator cannot stamp someone else as requester, claim a
--                   role they don't hold, or spawn a ticket mid-workflow.
--   WF-15 (INSERT)  request_type must be one the org configured (plus the
--                   check-in/transition vocabulary Revision/ASBUILT/RFI);
--                   unconfigured orgs keep free vocabulary.
--   WF-2  (UPDATE)  workflow-owned columns (status, identities, approval
--                   stamps, deliverable rev, archive linkage) change only
--                   through the service-role routes; the history log may only
--                   grow, never shrink.
--   DEL   (DELETE)  a RESTRICTIVE controllers-only rail — no app path deletes
--                   tickets today, so nothing regresses; devtools deletion of
--                   the drafting record stops being possible for everyone else.
--   WF-23 (FUNCTION) org_capability_allows' fallback CASE knew only 3 of the
--                   17 capabilities — every other capability was deny-all the
--                   moment a DB policy consulted it. Rebuilt to mirror
--                   lib/capabilityPolicy.ts CAPABILITY_DEFS exactly, so SQL
--                   and TS agree on unconfigured-org defaults.
--
-- Service-role writes (auth.uid() IS NULL) pass every guard: the API routes
-- are the enforcement point for their own paths and stamp identity themselves.
-- Client writers that legitimately touch tickets (priority, comments,
-- attachments, watchers, unread_by, history APPENDS) touch none of the
-- guarded columns — write-path census in the Phase 4 recon maps.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── WF-23: org_capability_allows — complete fallback CASE ───────────────────
-- Same body as 20261025 (data column, roles collection, Engineer token,
-- grants) with the fallback covering ALL capabilities from CAPABILITY_DEFS.
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

  SELECT data INTO v_val FROM org_configurations
  WHERE org_id = p_org AND key = 'capability_policy';

  v_tokens := COALESCE(v_val->'caps'->p_cap, v_val->p_cap);
  IF v_tokens IS NULL OR jsonb_typeof(v_tokens) <> 'array' THEN
    -- Mirrors lib/capabilityPolicy.ts CAPABILITY_DEFS defaultRoles exactly —
    -- a shape test compares this CASE against the TS source on every run.
    v_tokens := CASE p_cap
      WHEN 'ticket.manage'            THEN '["Admin","Manager","Supervisor"]'::jsonb
      WHEN 'ticket.initial_review'    THEN '["Admin","Manager","Supervisor","Engineer"]'::jsonb
      WHEN 'ticket.eng_review'        THEN '["Engineer"]'::jsonb
      WHEN 'ticket.assign'            THEN '["Admin","Manager","Supervisor","DraftingSupervisor"]'::jsonb
      WHEN 'ticket.self_assign'       THEN '["Drafter"]'::jsonb
      WHEN 'ticket.draft_work'        THEN '["Drafter"]'::jsonb
      WHEN 'ticket.requester_review'  THEN '["Requester"]'::jsonb
      WHEN 'ticket.direct_approve'    THEN '["Engineer"]'::jsonb
      WHEN 'ticket.final_approve'     THEN '["Engineer"]'::jsonb
      WHEN 'ticket.reopen'            THEN '["Admin","Manager","Supervisor"]'::jsonb
      WHEN 'ticket.force_close'       THEN '["Admin","Manager","Supervisor"]'::jsonb
      WHEN 'ticket.reassign_engineer' THEN '["Admin"]'::jsonb
      WHEN 'holds.open'               THEN '["*"]'::jsonb
      WHEN 'holds.release'            THEN '["*"]'::jsonb
      WHEN 'checkout.force_release'   THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'admin.analytics_view'     THEN '["Admin","Manager","Supervisor","DocCtrl"]'::jsonb
      WHEN 'admin.archive_view'       THEN '["Admin","DocCtrl"]'::jsonb
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

-- ── WF-5 + WF-15: honest ticket birth ───────────────────────────────────────
-- Every client-created ticket: requester IS the caller, requester_role IS a
-- role they hold, status IS the queue entry, request_type IS a configured
-- type (or the built-in check-in/transition vocabulary).
CREATE OR REPLACE FUNCTION ticket_insert_integrity()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role  TEXT;
  v_roles TEXT[];
  v_email TEXT;
  v_types TEXT[];
BEGIN
  -- Service-role writes (API routes) stamp identity themselves.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  SELECT role, COALESCE(roles, ARRAY[role]), email INTO v_role, v_roles, v_email
  FROM org_members
  WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active'
  LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'tickets: only active members of the workspace can create requests';
  END IF;

  -- WF-5: the requester is the caller — not whoever the payload names.
  NEW.requester_id := auth.uid();
  IF v_email IS NOT NULL THEN
    NEW.requester_email := v_email;
  END IF;
  -- The stamped role must be one the caller actually HOLDS (multi-role
  -- members may file under any of their roles); otherwise their primary.
  IF NEW.requester_role IS NULL OR NOT (NEW.requester_role = ANY(v_roles)) THEN
    NEW.requester_role := v_role;
  END IF;
  -- Tickets are born in the assignment queue, never mid-workflow.
  NEW.status := 'PENDING_ASSIGNMENT';
  -- Nothing is approved, closed, or archived at birth.
  NEW.assigned_drafter_id := NULL;
  NEW.assigned_drafter_name := NULL;
  NEW.assigned_engineer_id := NULL;
  NEW.assigned_engineer_name := NULL;
  NEW.assigned_engineer_email := NULL;
  NEW.engineer_approved_at := NULL;
  NEW.closed_at := NULL;
  NEW.archived_at := NULL;
  NEW.archive_id := NULL;

  -- WF-15: request_type honesty. The union keeps the check-in / transition-in
  -- vocabulary (Revision / ASBUILT / RFI) working for orgs whose configured
  -- portal list doesn't include them. Unconfigured orgs keep free vocabulary.
  SELECT array_agg(o->>'value') INTO v_types
  FROM org_configurations c,
       jsonb_array_elements(c.data->'requestTypes'->'options') o
  WHERE c.org_id = NEW.org_id AND c.key = 'drafting'
    AND jsonb_typeof(c.data->'requestTypes'->'options') = 'array';
  IF v_types IS NOT NULL AND array_length(v_types, 1) > 0
     AND NOT (NEW.request_type = ANY(v_types))
     AND NEW.request_type NOT IN ('Revision', 'ASBUILT', 'RFI') THEN
    RAISE EXCEPTION 'tickets: request type "%" is not one this workspace offers', NEW.request_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_insert_integrity ON tickets;
CREATE TRIGGER trg_ticket_insert_integrity
  BEFORE INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_insert_integrity();

-- ── WF-2: workflow-owned columns are trigger-guarded on UPDATE ──────────────
CREATE OR REPLACE FUNCTION ticket_update_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bad TEXT[] := '{}';
BEGIN
  -- The workflow-action route (service role) is the transition authority.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  IF NEW.org_id                      IS DISTINCT FROM OLD.org_id                      THEN v_bad := array_append(v_bad, 'org_id'); END IF;
  IF NEW.ticket_id                   IS DISTINCT FROM OLD.ticket_id                   THEN v_bad := array_append(v_bad, 'ticket_id'); END IF;
  IF NEW.status                      IS DISTINCT FROM OLD.status                      THEN v_bad := array_append(v_bad, 'status'); END IF;
  IF NEW.requester_id                IS DISTINCT FROM OLD.requester_id                THEN v_bad := array_append(v_bad, 'requester_id'); END IF;
  IF NEW.requester_role              IS DISTINCT FROM OLD.requester_role              THEN v_bad := array_append(v_bad, 'requester_role'); END IF;
  IF NEW.requester_name              IS DISTINCT FROM OLD.requester_name              THEN v_bad := array_append(v_bad, 'requester_name'); END IF;
  IF NEW.requester_email             IS DISTINCT FROM OLD.requester_email             THEN v_bad := array_append(v_bad, 'requester_email'); END IF;
  IF NEW.assigned_drafter_id         IS DISTINCT FROM OLD.assigned_drafter_id         THEN v_bad := array_append(v_bad, 'assigned_drafter_id'); END IF;
  IF NEW.assigned_drafter_name       IS DISTINCT FROM OLD.assigned_drafter_name       THEN v_bad := array_append(v_bad, 'assigned_drafter_name'); END IF;
  IF NEW.assigned_engineer_id        IS DISTINCT FROM OLD.assigned_engineer_id        THEN v_bad := array_append(v_bad, 'assigned_engineer_id'); END IF;
  IF NEW.assigned_engineer_name      IS DISTINCT FROM OLD.assigned_engineer_name      THEN v_bad := array_append(v_bad, 'assigned_engineer_name'); END IF;
  IF NEW.assigned_engineer_email     IS DISTINCT FROM OLD.assigned_engineer_email     THEN v_bad := array_append(v_bad, 'assigned_engineer_email'); END IF;
  IF NEW.engineer_review_requested_at IS DISTINCT FROM OLD.engineer_review_requested_at THEN v_bad := array_append(v_bad, 'engineer_review_requested_at'); END IF;
  IF NEW.engineer_approved_at        IS DISTINCT FROM OLD.engineer_approved_at        THEN v_bad := array_append(v_bad, 'engineer_approved_at'); END IF;
  IF NEW.engineer_review_reason      IS DISTINCT FROM OLD.engineer_review_reason      THEN v_bad := array_append(v_bad, 'engineer_review_reason'); END IF;
  IF NEW.deliverable_rev             IS DISTINCT FROM OLD.deliverable_rev             THEN v_bad := array_append(v_bad, 'deliverable_rev'); END IF;
  IF NEW.draft_iteration             IS DISTINCT FROM OLD.draft_iteration             THEN v_bad := array_append(v_bad, 'draft_iteration'); END IF;
  IF NEW.revision_count              IS DISTINCT FROM OLD.revision_count              THEN v_bad := array_append(v_bad, 'revision_count'); END IF;
  IF NEW.closed_at                   IS DISTINCT FROM OLD.closed_at                   THEN v_bad := array_append(v_bad, 'closed_at'); END IF;
  IF NEW.archived_at                 IS DISTINCT FROM OLD.archived_at                 THEN v_bad := array_append(v_bad, 'archived_at'); END IF;
  IF NEW.archive_id                  IS DISTINCT FROM OLD.archive_id                  THEN v_bad := array_append(v_bad, 'archive_id'); END IF;
  IF NEW.created_at                  IS DISTINCT FROM OLD.created_at                  THEN v_bad := array_append(v_bad, 'created_at'); END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'tickets: column(s) % are workflow-owned — use the request workflow actions', array_to_string(v_bad, ', ');
  END IF;

  -- WF-2: the history log only grows. (Append is a legitimate client write —
  -- file uploads and project links add entries — deletion is not.)
  IF jsonb_array_length(COALESCE(NEW.history, '[]'::jsonb))
     < jsonb_array_length(COALESCE(OLD.history, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'tickets: the history log cannot shrink';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_update_guard ON tickets;
CREATE TRIGGER trg_ticket_update_guard
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_update_guard();

-- ── DELETE rail: controllers only (no app path deletes tickets today) ───────
DROP POLICY IF EXISTS tickets_delete_controllers ON tickets;
CREATE POLICY tickets_delete_controllers ON tickets
  AS RESTRICTIVE FOR DELETE
  USING (is_org_controller(org_id));

COMMIT;

-- ── Verification (read-only) — expect true × 6 ──────────────────────────────
SELECT 'ticket insert integrity trigger installed' AS check,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_insert_integrity'
                AND tgrelid = 'tickets'::regclass AND NOT tgisinternal) AS ok
UNION ALL
SELECT 'ticket update guard trigger installed',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_update_guard'
                AND tgrelid = 'tickets'::regclass AND NOT tgisinternal)
UNION ALL
SELECT 'tickets DELETE is controllers-only (restrictive)',
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tickets'
                AND policyname = 'tickets_delete_controllers' AND permissive = 'RESTRICTIVE')
UNION ALL
SELECT 'capability fallback knows the full set (spot: ticket.assign + admin.archive_view)',
       (SELECT prosrc LIKE '%ticket.assign%' AND prosrc LIKE '%admin.archive_view%'
          FROM pg_proc WHERE proname = 'org_capability_allows')
UNION ALL
SELECT 'all three functions pin search_path',
       (SELECT COUNT(*) = 3 FROM pg_proc
         WHERE proname IN ('org_capability_allows', 'ticket_insert_integrity', 'ticket_update_guard')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%')
UNION ALL
SELECT 'every guarded column exists on tickets (late-bound plpgsql safety)',
       (SELECT COUNT(*) = 22 FROM information_schema.columns
         WHERE table_name = 'tickets' AND column_name IN
          ('org_id','ticket_id','status','requester_id','requester_role','requester_name',
           'requester_email','assigned_drafter_id','assigned_drafter_name','assigned_engineer_id',
           'assigned_engineer_name','assigned_engineer_email','engineer_review_requested_at',
           'engineer_approved_at','engineer_review_reason','deliverable_rev','draft_iteration',
           'revision_count','closed_at','archived_at','archive_id','created_at'));

-- ── Inventory (read-only, paste back) — expect 0 / 0 / 0:
-- 1. tickets claiming a requester who is not a member of their org (WF-5
--    residue from the unguarded era; informational, not corrected here).
-- 2. tickets in a status the state machine doesn't know (would strand).
-- 3. engineer-approved tickets with no engineer on record (WF-22 residue).
SELECT 'requesters not in their org' AS inventory,
       COUNT(*)::text AS n
FROM tickets t
WHERE NOT EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = t.org_id AND m.uid = t.requester_id)
UNION ALL
SELECT 'tickets in an unknown status',
       COUNT(*)::text
FROM tickets
WHERE status NOT IN ('NEW','PENDING_ENG_INITIAL','PENDING_ENG_TEAM','PENDING_ASSIGNMENT',
                     'DRAFTING','REVISION_REQ','PENDING_REVIEW','PENDING_FINAL_APPROVAL',
                     'PENDING_IFC','FINAL_DRAFT','CLOSED')
UNION ALL
SELECT 'engineer-approved with no engineer on record',
       COUNT(*)::text
FROM tickets
WHERE engineer_approved_at IS NOT NULL AND assigned_engineer_id IS NULL;
