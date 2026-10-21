-- ─────────────────────────────────────────────────────────────────────────────
-- 20261239 — drafting-flow Round G, DF-P11 AFTER-DC: who may release a hold by
-- default, a personal grant scoped to one project, and the distribution-ack
-- record made one-way (DEC-30: one paste; the app works before and after it).
--
-- WHAT THIS FILE DOES.
--
--   1. org_capability_allows_for (the 4-argument evaluator) is re-created from
--      its NEWEST body — 20261137 (20261224 changed its EXECUTE grant, not its
--      body) — with exactly two changes, pinned by a lineDiff test that scans
--      supabase/migrations at test time:
--        a. drafting-flow HAND-2: the shipped default of holds.release is the
--           controller tier plus the hold's own opener,
--           ["Admin","DocCtrl","$opener"] (it was ["*"]) — the controller
--           tier is checkout.force_release's. A hold is the controller tier's
--           veto (lib/documentGuards.ts refuses even a library publisher's
--           force past one), so the person a hold was placed against no
--           longer lifts it by default. "$opener" is an IDENTITY token: no
--           role matches it in this evaluator's token loop (no role is named
--           "$opener"); the hold UPDATE policy reads it through step 4's
--           hold_opener_may_update. lib/capabilityPolicy.ts CAPABILITY_DEFS
--           says the same (HOLD_OPENER_TOKEN; a shape test compares the CASE
--           with it on every run). An org whose stored policy names
--           holds.release is UNCHANGED — its list decides exactly as written.
--           The ticket close gate releases its own hold as the service role
--           (DEC-25), which this file does not touch. The management tier
--           (Manager, Supervisor) is deliberately NOT in the default though
--           it holds ticket.force_close: the close gate releases only holds
--           whose origin_ticket_id is the ticket being closed (a drafter's
--           as-built discrepancy hold, CheckInPanel), and only with the
--           closer's explicit release-or-keep resolution, recorded — it
--           never reaches a hold placed on the document from its hold strip
--           (a controller's veto). Release on the hold itself reaches every
--           hold, so it stays the controller tier's unless an Admin ticks
--           Manager or Supervisor on the row.
--        b. projects-and-cost QUAL-14 done-when 2: a personal grant that
--           names a projectId holds only when the decision is about that
--           project (p_resource->>'projectId'). A grant naming none holds
--           everywhere, as before. The policy route stores a scoped grant
--           only after it sees capability_grant_scope_ready() (step 2), so
--           no database before this paste ever holds one.
--      EXECUTE: REVOKE from PUBLIC and anon, GRANT to service_role; the
--      authenticated grant is revoked only where it was already gone before
--      this paste (20261224's narrowing is kept; a database where 20261224 is
--      not pasted, or kept it under its precondition, keeps it). CREATE OR
--      REPLACE keeps every other privilege.
--   2. capability_grant_scope_ready() (NEW, SECURITY INVOKER, returns true):
--      the marker the policy route probes before storing a project-scoped
--      grant. Service role only.
--   3. enforce_distribution_ack_guard (BEFORE UPDATE on distribution_acks) is
--      re-created from its NEWEST body — 20261033 — with three additions
--      (drafting-flow EVID-2), pinned by the same lineDiff test:
--        a. a recorded acknowledgment is never withdrawn (set back to NULL)
--           or re-dated by a signed-in caller;
--        b. requested_at may be changed only by the person who requested the
--           acknowledgment or a document controller (is_org_controller), and
--           never moved earlier (no app path writes it since DIST-12);
--        c. requested_by joins the immutable identity columns (otherwise a
--           member could name themselves the requester first).
--      The service role (auth.uid() NULL) is unchanged: it returns first.
--   4. hold_opener_may_update(org, opened_by) (NEW, SECURITY DEFINER,
--      search_path pinned; EXECUTE taken from PUBLIC and anon and granted to
--      authenticated and service_role only (DRLS-16, DF-P11 fix pass 3): the
--      UPDATE policy below is re-created TO authenticated, so anon has no
--      applicable policy at all — an anon UPDATE touches 0 rows without the
--      planner ever reaching this function. It answers only about the
--      caller — FALSE at once with no auth.uid() or when the caller is not
--      the hold's opener): true when the
--      caller IS the hold's opener, is an active member of the hold's org,
--      AND that org's effective holds.release list names "$opener" — read
--      exactly as org_capability_allows_for reads it for a caller with no
--      resource (the stored bare list, else the first unconditional rule,
--      else the shipped default, which names it).
--   5. document_holds_update (the UPDATE policy — release and re-date) is
--      re-created from its NEWEST body — 20260901 — with one added leg
--      (drafting-flow HAND-2, DEC-90 ruling (3), review fix passes):
--      `OR hold_opener_may_update(org_id, opened_by)`, and scoped
--      `TO authenticated` (fix pass 3; 20260901 wrote it for PUBLIC): the
--      only callers it ever admitted are signed-in members (the service
--      role bypasses row-level security), and anon now has no UPDATE policy
--      on document_holds — 0 rows, as before. The person who stopped
--      work lifts their own stop once their condition clears — while the org's
--      list names the opener (the default does); a stored list that leaves
--      "$opener" out ("only Admins lift holds") is honoured exactly, so this
--      file widens nothing. A hold placed by someone else still needs
--      holds.release. opened_by is pinned once placed (20261073's guard), so
--      the leg cannot be re-pointed; the release still needs a reason and is
--      attributed to the session (20261073). Pinned by the same lineDiff test.
--      The 3-argument org_capability_allows call is kept (20261052's probe).
--
-- WHO GAINS OR LOSES WHAT (HAND-2, DEC-90 ruling (3)). NOBODY GAINS. In an
-- org that stores no holds.release entry, every role other than Admin and
-- DocCtrl LOSES the right to release or re-date a hold placed by SOMEONE
-- ELSE (Manager, Supervisor, DraftingSupervisor, every Engineer tier,
-- Drafter, Requester, Viewer, Auditor, Contractor and any custom role).
-- Everyone KEEPS release and re-date of a hold they placed themselves (the
-- default names "$opener"). Inventory rows 4 and 5 count the members and the
-- open holds this touches. An org that STORED a holds.release list keeps
-- exactly what it had: before this paste its list decided; after, its list
-- still decides ("$opener" can only be in it once an Admin ticks it). Every
-- org can widen it again in Admin → Permissions → Action permissions (a
-- role, the opener tick, or a personal grant).
--
-- THE REMAINDER THIS FILE DOES NOT NARROW (fix pass 3). Until DF-P11 fix
-- pass 3, every save of the Action-permissions grid wrote EVERY capability,
-- so a workspace whose Admin changed any row stored holds.release as ["*"]
-- (the old default) without anyone choosing it. Such a workspace is still
-- "everyone releases" after this paste — its stored list decides. Inventory
-- row 1 counts exactly these (stored holds.release equal to ["*"]); row 2
-- counts every other stored list (a deliberate one, or a rule list). The
-- grid now names a ["*"] row as the old default with a one-click "Use the
-- shipped default", and no longer writes rows equal to their default. Any
-- data step that rewrites a stored ["*"] is the integrator's ruling
-- (HAND-2's Partial), never this file's.
--
-- BEFORE / AFTER THE PASTE (the app works either way).
--   Before: the app already applies the narrower holds.release default
--   (lib/capabilityPolicy.ts) — offering a hold's opener Release on their own
--   hold, which the '*' database admits (and, for an org that stored a list
--   without "$opener", offering it nothing extra — the database agrees) —
--   and refuses a project-scoped grant (the route's
--   probe answers PGRST202 → 409, nothing stored); the database still admits
--   '*' and ignores grant scopes (no scoped grant can exist). A distribution
--   ack can still be un-stamped by its recipient and requested_at moved by a
--   member, as today.
--   After: the database agrees with the app on holds.release (the controller
--   tier, or the hold's own opener while the list names "$opener") and reads
--   a grant's project; the ack record is one-way, and its guard function is
--   no longer executable by PUBLIC / anon / authenticated (DRLS-16).
-- PASTE ORDER: deploy the app first (an old app still shows Release to every
-- member; the database would then refuse the click). Any time after
-- 20261137 and 20261033 (applied). Independent of 20261136 and 20261224 —
-- paste either before or after; re-pasting 20261137 afterwards would put the
-- '*' default and the unscoped grant loop back (re-paste this file after it).
-- Idempotent: safe to paste again.
--
-- ROLLBACK: re-paste 20261137's org_capability_allows_for, 20261033's
-- enforce_distribution_ack_guard and 20260901's document_holds_update policy;
-- DROP FUNCTION capability_grant_scope_ready() and
-- hold_opener_may_update(uuid, uuid) (after the policy no longer calls it).
-- Remove any project-scoped grant first (it would read as org-wide).
-- ─────────────────────────────────────────────────────────────────────────────

-- Apply-order check: this file starts from 20261137's and 20261033's bodies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)') AND prosrc LIKE '%WHEN ''ai.manage_caps''%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_distribution_ack_guard' AND prosrc LIKE '%NEW.acknowledged_by := OLD.acknowledged_by;%')
     OR to_regclass('public.distribution_acks') IS NULL
     OR to_regclass('public.document_holds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_holds' AND policyname = 'document_holds_update') THEN
    RAISE EXCEPTION '20261239 needs 20261137 and 20261033 pasted first; nothing was changed.';
  END IF;
END $$;

-- Pre-apply inventory (counts only — never a customer row).
DROP TABLE IF EXISTS df_p11_20261239_inventory;
CREATE TEMP TABLE df_p11_20261239_inventory (ord int, check_name text, n bigint);
INSERT INTO df_p11_20261239_inventory
SELECT 1, 'inventory: workspaces whose stored holds.release is exactly ["*"] — the old default, which every grid save stored with every other row whether or not anyone chose it (unchanged by this file: still everyone; the grid names it)', COUNT(*)
  FROM org_configurations c
 WHERE c.key = 'capability_policy'
   AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') = '["*"]'::jsonb;
INSERT INTO df_p11_20261239_inventory
SELECT 2, 'inventory: workspaces whose stored holds.release is any other list or a rule list (unchanged by this file: that list decides)', COUNT(*)
  FROM org_configurations c
 WHERE c.key = 'capability_policy'
   AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') IS NOT NULL
   AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') <> '["*"]'::jsonb;
INSERT INTO df_p11_20261239_inventory
SELECT 3, 'inventory: workspaces on the shipped holds.release default (now Admin, DocCtrl and each hold''s own opener)', COUNT(*)
  FROM orgs o
 WHERE NOT EXISTS (SELECT 1 FROM org_configurations c
                    WHERE c.org_id = o.id AND c.key = 'capability_policy'
                      AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') IS NOT NULL);
INSERT INTO df_p11_20261239_inventory
SELECT 4, 'inventory: active members of those workspaces who lose release of holds placed by someone else (not Admin / DocCtrl, no live personal grant of it)', COUNT(*)
  FROM org_members m
 WHERE m.status = 'active'
   AND NOT (m.role IN ('Admin', 'DocCtrl') OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl']::text[])
   AND NOT EXISTS (SELECT 1 FROM org_configurations c
                    WHERE c.org_id = m.org_id AND c.key = 'capability_policy'
                      AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM org_configurations c,
                          jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g
                    WHERE c.org_id = m.org_id AND c.key = 'capability_policy'
                      AND g->>'cap' = 'holds.release' AND g->>'uid' = m.uid::text);
INSERT INTO df_p11_20261239_inventory
SELECT 5, 'inventory: open holds in those workspaces opened by someone who is not Admin / DocCtrl there (released now by their opener, a controller, or the close of their ticket)', COUNT(*)
  FROM document_holds h
 WHERE h.released_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM org_configurations c
                    WHERE c.org_id = h.org_id AND c.key = 'capability_policy'
                      AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = h.org_id AND m.uid = h.opened_by AND m.status = 'active'
                      AND (m.role IN ('Admin', 'DocCtrl') OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl']::text[]));
INSERT INTO df_p11_20261239_inventory
SELECT 6, 'inventory (expect 0): stored personal grants that name a project (the route refuses them until this paste)', COUNT(*)
  FROM org_configurations c,
       jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g
 WHERE c.key = 'capability_policy' AND COALESCE(g->>'projectId', '') <> '';
INSERT INTO df_p11_20261239_inventory
SELECT 7, 'inventory: distribution acks already acknowledged (from now on a signed-in caller cannot withdraw or re-date them)', COUNT(*)
  FROM distribution_acks a
 WHERE a.acknowledged_at IS NOT NULL;
INSERT INTO df_p11_20261239_inventory
SELECT 8, 'state before: authenticated may execute org_capability_allows_for (1 = yes: kept; 0 = no: kept narrowed)',
       CASE WHEN has_function_privilege('authenticated', 'public.org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE') THEN 1 ELSE 0 END;

BEGIN;

-- ── 1. the evaluator: holds.release to the controller tier; a grant's project ─
CREATE OR REPLACE FUNCTION org_capability_allows_for(p_org UUID, p_cap TEXT, p_uid UUID, p_resource JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_val JSONB;
  v_entry JSONB;
  v_tokens JSONB;
  v_rule JSONB;
  v_list JSONB;
  v_key TEXT;
  v_cond BOOLEAN;
  v_hit BOOLEAN;
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

  p_resource := COALESCE(p_resource, '{}'::jsonb);
  v_entry := COALESCE(v_val->'caps'->p_cap, v_val->p_cap);

  IF v_entry IS NOT NULL AND jsonb_typeof(v_entry) = 'array' THEN
    IF jsonb_array_length(v_entry) > 0 AND jsonb_typeof(v_entry->0) = 'object' THEN
      -- A RULE LIST (DEC-13). The resource keys read here are the ONLY keys
      -- either evaluator reads — lib/capabilityPolicy.ts RESOURCE_KEYS.
      -- 1. The first conditional rule whose every listed key matches.
      FOR v_rule IN SELECT jsonb_array_elements(v_entry) LOOP
        v_cond := FALSE;
        v_hit := TRUE;
        FOREACH v_key IN ARRAY ARRAY['requestType', 'unit', 'libraryId', 'discipline', 'projectId'] LOOP
          v_list := v_rule->'when'->v_key;
          IF v_list IS NOT NULL AND jsonb_typeof(v_list) = 'array' AND jsonb_array_length(v_list) > 0 THEN
            v_cond := TRUE;
            IF p_resource->>v_key IS NULL OR NOT (v_list ? (p_resource->>v_key)) THEN
              v_hit := FALSE;
            END IF;
          END IF;
        END LOOP;
        IF v_cond AND v_hit THEN
          v_tokens := v_rule->'tokens';
          EXIT;
        END IF;
      END LOOP;
      -- 2. Otherwise the first unconditional rule — the base list.
      IF v_tokens IS NULL THEN
        FOR v_rule IN SELECT jsonb_array_elements(v_entry) LOOP
          v_cond := FALSE;
          FOREACH v_key IN ARRAY ARRAY['requestType', 'unit', 'libraryId', 'discipline', 'projectId'] LOOP
            v_list := v_rule->'when'->v_key;
            IF v_list IS NOT NULL AND jsonb_typeof(v_list) = 'array' AND jsonb_array_length(v_list) > 0 THEN
              v_cond := TRUE;
            END IF;
          END LOOP;
          IF NOT v_cond THEN
            v_tokens := v_rule->'tokens';
            EXIT;
          END IF;
        END LOOP;
      END IF;
    ELSE
      -- The legacy bare token list (an empty list included: it denies).
      v_tokens := v_entry;
    END IF;
  END IF;

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
      WHEN 'ticket.engineer_gate_exempt' THEN '["Admin","Manager","Supervisor","Engineer","DocCtrl"]'::jsonb
      WHEN 'holds.open'               THEN '["*"]'::jsonb
      WHEN 'holds.release'            THEN '["Admin","DocCtrl","$opener"]'::jsonb
      WHEN 'checkout.force_release'   THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'admin.analytics_view'     THEN '["Admin","Manager","Supervisor","DocCtrl"]'::jsonb
      WHEN 'admin.archive_view'       THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'admin.audit_view'         THEN '["Admin","Manager","Supervisor","DocCtrl","Auditor"]'::jsonb
      WHEN 'transmittal.issue'        THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'quality.sign_off'         THEN '[]'::jsonb
      WHEN 'ai.manage_caps'           THEN '["Admin"]'::jsonb
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
              OR (v_grant->>'expiresAt')::timestamptz > NOW())
         -- QUAL-14 (20261239): a grant that names a project holds on that project only.
         AND (COALESCE(v_grant->>'projectId', '') = ''
              OR v_grant->>'projectId' = p_resource->>'projectId') THEN
        RETURN TRUE;
      END IF;
    END LOOP;
  END IF;
  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM PUBLIC, anon;
DO $$
BEGIN
  -- 20261224's narrowing is kept where it ran; nothing is taken from
  -- authenticated where it still had EXECUTE before this paste.
  IF EXISTS (SELECT 1 FROM df_p11_20261239_inventory WHERE ord = 8 AND n = 0) THEN
    REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) TO service_role;

-- ── 2. the marker the policy route probes before storing a scoped grant ───────
CREATE OR REPLACE FUNCTION capability_grant_scope_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT true;
$$;
REVOKE ALL ON FUNCTION capability_grant_scope_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION capability_grant_scope_ready() TO service_role;

-- ── 3. the distribution-ack guard: one-way acknowledgment, bounded request time
CREATE OR REPLACE FUNCTION enforce_distribution_ack_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- The forensic column cannot be written from the app — whatever the caller
  -- sent, start from the recorded value; only the transition below sets it.
  NEW.acknowledged_by := OLD.acknowledged_by;

  -- Identity is immutable.
  IF NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
     OR NEW.version_id      IS DISTINCT FROM OLD.version_id
     OR NEW.document_id     IS DISTINCT FROM OLD.document_id
     OR NEW.org_id          IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by    IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'Distribution-ack rows are immutable in identity.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only the named recipient stamps (or changes) their acknowledgment, and
  -- the row records who stamped it.
  IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
    -- EVID-2 (20261239): a recorded acknowledgment is evidence — it is never
    -- withdrawn (set back to NULL) or re-dated by a signed-in caller.
    IF OLD.acknowledged_at IS NOT NULL THEN
      RAISE EXCEPTION 'A recorded acknowledgment cannot be withdrawn or re-dated.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.recipient_user_id::text <> auth.uid()::text THEN
      RAISE EXCEPTION 'Only the named recipient can acknowledge their own distribution.'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.acknowledged_by := auth.uid();
  END IF;

  -- EVID-2 (20261239): requested_at anchors the nag clock and the escalation —
  -- only the person who asked, or a document controller, may move it, and
  -- never earlier than it was.
  IF NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    IF NOT (OLD.requested_by::text = auth.uid()::text OR is_org_controller(OLD.org_id)) THEN
      RAISE EXCEPTION 'Only the person who requested this acknowledgment, or a document controller, can change when it was requested.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.requested_at < OLD.requested_at THEN
      RAISE EXCEPTION 'A request time cannot be moved earlier.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- (trg_distribution_ack_guard keeps its BEFORE UPDATE binding — unchanged.)
-- DRLS-16: a trigger function is never called directly, but EXECUTE is still
-- taken from PUBLIC and every client role (the trigger fires regardless).
REVOKE ALL ON FUNCTION enforce_distribution_ack_guard() FROM PUBLIC, anon, authenticated;

-- ── 4. the opener leg: the hold's own opener, while the list names "$opener" ─
-- holds.release's list is read as org_capability_allows_for reads it for a
-- caller with no resource (the policy's 3-argument call): the stored entry
-- (caps first, then the legacy top level); a rule list's first unconditional
-- rule; else the shipped default. Mirrors lib/capabilityPolicy.ts
-- holdOpenerTokenOn (pinned by a shape test).
CREATE OR REPLACE FUNCTION hold_opener_may_update(p_org UUID, p_opened_by UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry JSONB;
  v_tokens JSONB;
  v_rule JSONB;
  v_list JSONB;
  v_key TEXT;
  v_cond BOOLEAN;
BEGIN
  -- Only the hold's own opener, signed in and an active member of its org.
  -- A caller with no session uid (anon; the service role, which RLS does
  -- not judge) is never the opener: IS DISTINCT FROM a NULL uid is true, so
  -- it is refused here — no NULL-uid branch lets anyone through (DRLS-16).
  IF p_opened_by IS NULL OR p_opened_by IS DISTINCT FROM auth.uid() THEN
    RETURN FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members
                  WHERE org_id = p_org AND uid = auth.uid() AND status = 'active') THEN
    RETURN FALSE;
  END IF;

  SELECT COALESCE(data->'caps'->'holds.release', data->'holds.release') INTO v_entry
  FROM org_configurations
  WHERE org_id = p_org AND key = 'capability_policy';

  IF v_entry IS NOT NULL AND jsonb_typeof(v_entry) = 'array' THEN
    IF jsonb_array_length(v_entry) > 0 AND jsonb_typeof(v_entry->0) = 'object' THEN
      -- A rule list: the first unconditional rule — the base list.
      FOR v_rule IN SELECT jsonb_array_elements(v_entry) LOOP
        v_cond := FALSE;
        FOREACH v_key IN ARRAY ARRAY['requestType', 'unit', 'libraryId', 'discipline', 'projectId'] LOOP
          v_list := v_rule->'when'->v_key;
          IF v_list IS NOT NULL AND jsonb_typeof(v_list) = 'array' AND jsonb_array_length(v_list) > 0 THEN
            v_cond := TRUE;
          END IF;
        END LOOP;
        IF NOT v_cond THEN
          v_tokens := v_rule->'tokens';
          EXIT;
        END IF;
      END LOOP;
    ELSE
      -- The legacy bare token list (an empty list included: no opener).
      v_tokens := v_entry;
    END IF;
  END IF;

  IF v_tokens IS NULL OR jsonb_typeof(v_tokens) <> 'array' THEN
    -- The shipped default — org_capability_allows_for's holds.release row.
    v_tokens := '["Admin","DocCtrl","$opener"]'::jsonb;
  END IF;
  RETURN v_tokens ? '$opener';
END;
$$;
-- DRLS-16 (fix pass 3): not PUBLIC, not anon — the UPDATE policy below is
-- TO authenticated, so anon never reaches it; authenticated (the policy's
-- role) and service_role only. The function also answers FALSE for a
-- caller with no auth.uid() before it reads anything.
REVOKE ALL ON FUNCTION hold_opener_may_update(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hold_opener_may_update(uuid, uuid) TO authenticated, service_role;

-- ── 5. the hold UPDATE policy: holds.release, or the opener leg ─────────────
-- Body from 20260901 + one leg (HAND-2 review fix passes), scoped TO
-- authenticated (fix pass 3: anon has no UPDATE policy here — 0 rows, as
-- before — and never plans the opener function). The leg reads the row's
-- opened_by, which 20261073's guard pins once a hold is placed.
DROP POLICY IF EXISTS document_holds_update ON document_holds;
-- Releasing = the UPDATE that sets released_at; the capability gates every
-- update (the row has no other mutable purpose).
CREATE POLICY document_holds_update ON document_holds FOR UPDATE TO authenticated USING (
  org_capability_allows(org_id, 'holds.release', auth.uid())
  OR hold_opener_may_update(org_id, opened_by)
) WITH CHECK (
  org_capability_allows(org_id, 'holds.release', auth.uid())
  OR hold_opener_may_update(org_id, opened_by)
);

COMMIT;

-- ── One result set: probes (ok, n NULL) and the inventory (ok NULL, n) ───────
SELECT check_name AS "check", ok, n FROM (
  SELECT 100 AS ord, 'holds.release ships to the controller tier plus the hold''s opener token in the evaluator' AS check_name,
         EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)')
                  AND prosrc LIKE '%WHEN ''holds.release''            THEN ''["Admin","DocCtrl","$opener"]''::jsonb%') AS ok, NULL::text AS n
  UNION ALL
  SELECT 101, 'the evaluator reads a personal grant''s project',
         EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)')
                  AND prosrc LIKE '%v_grant->>''projectId'' = p_resource->>''projectId''%'), NULL
  UNION ALL
  SELECT 102, 'the evaluator keeps every earlier row (ai.manage_caps, transmittal.issue, quality.sign_off) and still reads projectId rules',
         EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)')
                  AND prosrc LIKE '%WHEN ''ai.manage_caps''%' AND prosrc LIKE '%WHEN ''transmittal.issue''%'
                  AND prosrc LIKE '%WHEN ''quality.sign_off''%' AND prosrc LIKE '%''discipline'', ''projectId''%'), NULL
  UNION ALL
  SELECT 103, 'the evaluator is SECURITY DEFINER with search_path pinned',
         EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)')
                  AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'), NULL
  UNION ALL
  SELECT 104, 'anon cannot execute the evaluator; the service role can',
         NOT has_function_privilege('anon', 'public.org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE')
         AND has_function_privilege('service_role', 'public.org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE'), NULL
  UNION ALL
  SELECT 105, 'authenticated keeps exactly the EXECUTE it had before this paste',
         has_function_privilege('authenticated', 'public.org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE')
           = EXISTS (SELECT 1 FROM df_p11_20261239_inventory WHERE ord = 8 AND n = 1), NULL
  UNION ALL
  SELECT 106, 'the 3-argument entry point still calls the evaluator (the document_holds policies read it)',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'org_capability_allows' AND pronargs = 3
                  AND prosrc LIKE '%org_capability_allows_for(p_org, p_cap, p_uid, ''{}''::jsonb)%'), NULL
  UNION ALL
  SELECT 107, 'capability_grant_scope_ready() answers true and only the service role may call it',
         to_regprocedure('public.capability_grant_scope_ready()') IS NOT NULL
         AND has_function_privilege('service_role', 'public.capability_grant_scope_ready()', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.capability_grant_scope_ready()', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.capability_grant_scope_ready()', 'EXECUTE'), NULL
  UNION ALL
  SELECT 108, 'the ack guard refuses withdrawing or re-dating a recorded acknowledgment',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_distribution_ack_guard'
                  AND prosrc LIKE '%A recorded acknowledgment cannot be withdrawn or re-dated.%'), NULL
  UNION ALL
  SELECT 109, 'the ack guard binds requested_at to the requester or a controller, never earlier; requested_by is immutable',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_distribution_ack_guard'
                  AND prosrc LIKE '%is_org_controller(OLD.org_id)%'
                  AND prosrc LIKE '%NEW.requested_at < OLD.requested_at%'
                  AND prosrc LIKE '%NEW.requested_by    IS DISTINCT FROM OLD.requested_by%'), NULL
  UNION ALL
  SELECT 110, 'the ack guard keeps the recipient-only stamp, is still bound BEFORE UPDATE with search_path pinned, and neither anon nor authenticated may execute it',
         EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'enforce_distribution_ack_guard' AND p.prosecdef
                  AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                  AND p.prosrc LIKE '%Only the named recipient can acknowledge their own distribution.%')
         AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_distribution_ack_guard'
                      AND t.tgrelid = 'public.distribution_acks'::regclass AND NOT t.tgisinternal)
         AND NOT has_function_privilege('anon', 'public.enforce_distribution_ack_guard()', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.enforce_distribution_ack_guard()', 'EXECUTE'), NULL
  UNION ALL
  SELECT 111, 'the hold UPDATE policy admits holds.release or the opener leg, still calls the 3-argument entry point, and applies to authenticated only',
         EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_holds' AND policyname = 'document_holds_update'
                  AND cmd = 'UPDATE' AND roles = ARRAY['authenticated']::name[]
                  AND COALESCE(qual, '') LIKE '%org_capability_allows(%' AND COALESCE(qual, '') LIKE '%hold_opener_may_update(org_id, opened_by)%'
                  AND COALESCE(with_check, '') LIKE '%org_capability_allows(%' AND COALESCE(with_check, '') LIKE '%hold_opener_may_update(org_id, opened_by)%'), NULL
  UNION ALL
  SELECT 112, 'the opener leg is SECURITY DEFINER with search_path pinned, reads the opener token, answers only about the caller, and is executable by authenticated and the service role only (not PUBLIC, not anon)',
         EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.hold_opener_may_update(uuid,uuid)')
                  AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
                  AND prosrc LIKE '%RETURN v_tokens ? ''$opener'';%'
                  AND prosrc LIKE '%v_tokens := ''["Admin","DocCtrl","$opener"]''::jsonb;%'
                  AND prosrc LIKE '%p_opened_by IS DISTINCT FROM auth.uid()%')
         AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                          WHERE p.oid = to_regprocedure('public.hold_opener_may_update(uuid,uuid)') AND a.grantee = 0)
         AND has_function_privilege('authenticated', 'public.hold_opener_may_update(uuid,uuid)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.hold_opener_may_update(uuid,uuid)', 'EXECUTE')
         AND has_function_privilege('service_role', 'public.hold_opener_may_update(uuid,uuid)', 'EXECUTE'), NULL
  UNION ALL
  SELECT ord, check_name, NULL, n::text FROM df_p11_20261239_inventory
) r
ORDER BY ord;
