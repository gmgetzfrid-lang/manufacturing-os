-- ─────────────────────────────────────────────────────────────────────────────
-- projects Round G — J2b QUALITY-SIGNOFF-AUTHORITY (projects-and-cost QUAL-4).
-- One script, one result set. APPLY AFTER 20261091 (the quality rails),
-- 20261125 (is_org_controller_for) and 20261132 (the newest evaluator); the
-- file refuses to start — and changes nothing — when one of them is not live.
--
-- QUAL-4: only a controller or the one project owner could record any quality
-- decision, nobody else could be given that authority on one project, and the
-- same person could author, sign, complete and accept alone, with an email
-- prefix as the whole identity of the sign-off. This file:
--
-- 1. org_capability_allows_for is re-created from its NEWEST definition
--    (20261132 — itself 20261063 plus the transmittal.issue row), every line
--    of that body kept (lib/__tests__/qualitySignoff.test.ts proves it with a
--    lineDiff), with exactly three line changes:
--      * the two FOREACH lines of the rule matcher read a fifth resource key,
--        'projectId' (lib/capabilityPolicy.ts RESOURCE_KEYS moves with them),
--        so a rule can be scoped to ONE project — DEC-13's resource dimension,
--        one key wider. A stored rule naming projectId would, until now, have
--        read as UNCONDITIONAL in SQL; the inventory counts them (expect 0).
--      * ONE CASE row: WHEN 'quality.sign_off' THEN [] — the capability
--        grants sign-off BEYOND its standing holders (CAPABILITY_DEFS carries
--        the same empty default). Controllers (Admin / Document Control) and
--        the project owner write and sign off by the policies' own clauses —
--        is_org_controller and the owner disjunct — whatever the policy says,
--        so the permissions grid never shows them as a control that unticks
--        nothing; an unconfigured org grants nobody new.
--    EXECUTE is revoked from PUBLIC and anon (DRLS-16: the evaluator answers
--    for ANY uid it is handed) and granted to authenticated (transmittals_guard
--    runs under the caller's rights) and service_role. The 3-argument wrapper
--    org_capability_allows is untouched — and keeps the platform's default
--    EXECUTE for anon: it is SECURITY DEFINER, so it still answers the
--    base-list question (no resource) for any uid, quality.sign_off included.
--    Policies anon may evaluate call it (audit_logs_admin_trail, the
--    document_holds and transmittals policies), so closing it is not this
--    file's change; only the resource-aware entry point is closed here.
--    The sign-off helpers below are closed to anon too, and the four write
--    policies that call quality_signoff_granted are re-created TO
--    authenticated (§3), so anon never evaluates them: an anonymous read of
--    the quality tables still answers "no rows" (the member-read policies),
--    never "permission denied for function".
-- 2. The quality sign-off helpers — SECURITY DEFINER, search_path pinned,
--    EXECUTE revoked from PUBLIC and anon:
--      quality_signoff_granted_for(org, project, uid) — the capability decision
--        for that project (resource {"projectId": …}) AND that uid can see the
--        project (project_visible_to_me's rule with the uid named): a grant
--        never opens a private project's rows to someone who cannot read it
--        (SEC-2 — a FOR ALL policy's USING also admits SELECT). Service role.
--      quality_signoff_granted(org, project) — the same for the caller; the
--        write policies read it. authenticated + service_role.
--      quality_signer_eligible(org, project, uid) — an active member who is a
--        controller (is_org_controller_for), the project's owner, or granted
--        above: exactly who the write policies admit. Service role.
--      quality_other_signers(org, project, uid) — how many OTHER active members
--        are eligible (DEC-12's derivation, counted for this project's sign-off
--        slot — DEC-37). Service role.
--      quality_signoff_status(project) — {maySign, otherSigners} for the
--        caller, on a project the caller can see (NULL otherwise): the decision
--        the Quality tab draws its controls from (QUAL-4 done-when 4).
-- 3. The four write policies are REPLACED (DROP + CREATE under the same name —
--    the DRLS-1 lesson: never a second permissive policy beside a FOR ALL),
--    each byte-carried from its NEWEST body with ONE added disjunct, on USING
--    and WITH CHECK alike, and ONE added clause, TO authenticated (anon has
--    no EXECUTE on the helper the disjunct calls, and never wrote here):
--      project_checklists_write (20261091)  OR quality_signoff_granted(org_id, project_id)
--      checklist_items_write    (20261091)  … AND (user_owns_project(c.project_id)
--                                              OR quality_signoff_granted(c.org_id, c.project_id))
--      turnover_items_write     (20261013)  OR quality_signoff_granted(org_id, project_id)
--      punch_items_write        (20261013)  OR quality_signoff_granted(org_id, project_id)
--    WIDENS — whoever an org grants quality.sign_off (nobody beyond the
--    controllers and the owner until it does) may write that project's quality rows; the
--    20261091 rails (reason bar, machine actor, completion gate, org match)
--    bind them exactly as they bind the owner.
-- 4. Separation of duties and the bound sign-off — BEFORE INSERT OR UPDATE
--    rails that run after J2's (trigger-name order):
--      project_checklists_signoff_rail — the author (created_by) is the
--      signed-in caller at insert and is never rewritten; a checklist never
--      moves to another project (that would take it, unsigned, out of one
--      project's package); a COMPLETED checklist — a signed sign-off — is
--      reopened or voided only by a controller (Admin / Document Control —
--      an org always keeps an active Admin, so this is never a dead end):
--      anyone else's move out of complete would erase the second person's
--      completion record with no reason and no signature (checklists keep no
--      history table) — NARROWS the owner and grantees; no product path
--      reopens or voids a checklist; the status change is stamped (status_changed_at, the
--      database's clock); a move to complete
--        * is refused for the AUTHOR while another eligible signer exists
--          (quality_other_signers > 0); with none it is allowed and MARKED
--          (completed_single_signer = true) — DEC-12 / DEC-37, no toggle;
--        * needs the completer's own e-signature on THIS checklist —
--          e_signatures resource_type 'project_checklist', resource_id = the
--          checklist, signer = the caller, intent Reviewed / Approved — made in
--          the last 15 minutes AND after the checklist's last status change.
--          That row exists only through the 20261050 ceremony: the signing
--          route re-authenticates, names the signer from org_members and mints
--          it with the service key; no client can insert one;
--        * records completed_by, completed_by_name (the signature's signer
--          name), completed_at, completed_signature_id and the marker — the
--          database's values, a client's are ignored; a standing completion
--          keeps them; any other status clears them (the signature row stays).
--      turnover_items_signoff_rail — the creator is the caller at insert and is
--      never rewritten; an item is never BORN accepted or waived; a required
--      item is never unmarked and no item moves to another project (either
--      would take it out of its package unsigned — or carry a signed decision
--      into another project's); it leaves by a signed waiver; a
--      move to accepted OR waived — either one clears the item from the
--      progress, the project snapshot and the closeout gate — carries the
--      same two rules (the creator against a second eligible signer; the
--      decider's e-signature on THIS item — 'turnover_item' — in the last 15
--      minutes and after the item's last history row) and records
--      reviewed_signature_id + reviewed_single_signer. The creator of a
--      seeded item (seedTurnoverItems, the project wizard) is whoever seeded
--      it — usually the owner — so a second eligible signer accepts or
--      waives every seeded item while one exists (DEC-44 (provisional)).
--    The service pass (auth.uid() IS NULL — restores, server routes, the SQL
--    editor) passes, as in 20261091.
-- 5. Deleting (quality_records_delete_rail, BEFORE DELETE on
--    project_checklists, turnover_items and punch_items): the FOR ALL
--    policies' new disjunct would admit DELETE as well, so the rail refuses a
--    grantee's delete (except createChecklist taking back its own item-less
--    header) and keeps a signed sign-off — a checklist that carries a
--    signature (completed now, or signed before a controller reopened or
--    voided it: its e_signatures row is the only trace), an accepted or
--    waived turnover item — and a required turnover item to controllers
--    (NARROWS the owner there; no product path deletes one). An FK cascade
--    and delete_project_record's audited purge pass.
--
-- DEC-30 inventory (captured BEFORE the transaction; aggregate counts only,
-- never rows): stored policies / grants already naming quality.sign_off and
-- stored rules conditioned on projectId (expect 0 each); and, informational
-- (the plan's two), completed checklists whose completion audit row names
-- their own author, and accepted turnover items whose reviewer is the project
-- owner on projects where another eligible signer existed (an active
-- controller other than the owner — the only other writer the policies
-- admitted before this file) and, the plan's literal reading, on projects
-- with another active project member — plus accepted or waived items whose
-- reviewer created them. Nothing is rewritten: the rails
-- bind the next completion / acceptance / waiver. The AFTER rows ask the new
-- helpers whom they admit and how many undecided records now need a second
-- signer (every open, received or rejected turnover item counts — a seeded
-- item is born open); they ask the helper once per (org, project, author),
-- not once per row, so the one result set stays fast on a large package.
-- The inventory's label column is `label`, never a reserved word.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Apply order — refuse before anything runs ────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.turnover_review_events') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'project_checklists' AND column_name = 'completed_basis')
     OR to_regprocedure('public.quality_actor_name(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261091_prj_roundG_quality_rails.sql first: the sign-off rails read its review history and its actor name. Nothing was changed.';
  END IF;
  IF to_regprocedure('public.is_org_controller_for(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261125_intel_roundG_skills_authority.sql first: the sign-off helpers read is_org_controller_for. Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE proname = 'org_capability_allows_for' AND pronargs = 4
                    AND prosrc LIKE '%transmittal.issue%') THEN
    RAISE EXCEPTION 'Apply 20261132_dc_roundF_transmit_capability.sql first: this file re-creates the evaluator from that body. Nothing was changed.';
  END IF;
END $$;

-- ── DEC-30 inventory — BEFORE the transaction; counts only, never rows ───────
DROP TABLE IF EXISTS prj_roundg_signoff_before;
CREATE TEMP TABLE prj_roundg_signoff_before AS
SELECT 'BEFORE: stored capability policies already carrying a quality.sign_off entry (expect 0 — the id is new)'::text AS label,
       (SELECT COUNT(*) FROM org_configurations
         WHERE key = 'capability_policy'
           AND jsonb_typeof(COALESCE(data->'caps', data)) = 'object'
           AND COALESCE(data->'caps', data) ? 'quality.sign_off')::text AS n
UNION ALL
SELECT 'BEFORE: live per-person grants of quality.sign_off (expect 0)',
       (SELECT COUNT(*) FROM org_configurations c
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g
         WHERE c.key = 'capability_policy' AND g->>'cap' = 'quality.sign_off')::text
UNION ALL
SELECT 'BEFORE: stored capability rules conditioned on a projectId (expect 0 — no evaluator read the key until now; in SQL such a rule read as unconditional)',
       (SELECT COUNT(*) FROM org_configurations c
          CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(COALESCE(c.data->'caps', c.data)) = 'object' THEN COALESCE(c.data->'caps', c.data) ELSE '{}'::jsonb END) e
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END) r
         WHERE c.key = 'capability_policy'
           AND jsonb_typeof(r.value) = 'object'
           AND jsonb_typeof(r.value->'when') = 'object'
           AND (r.value->'when') ? 'projectId')::text
UNION ALL
SELECT 'BEFORE (informational, QUAL-4): completed checklists whose completion audit row names their own author (the self-completion the rail now refuses where a second signer exists; nothing is rewritten)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete' AND c.created_by IS NOT NULL
           AND EXISTS (SELECT 1 FROM audit_logs a
                        WHERE a.action = 'CHECKLIST_STATUS' AND a.resource_type = 'project'
                          AND a.resource_id = c.project_id::text
                          AND a.details->>'checklistId' = c.id::text
                          AND a.details->>'status' = 'complete'
                          AND a.user_id::text = c.created_by::text))::text
UNION ALL
SELECT 'BEFORE (informational): completed checklists with no completion audit row on record (who completed them is unknown)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND NOT EXISTS (SELECT 1 FROM audit_logs a
                            WHERE a.action = 'CHECKLIST_STATUS' AND a.resource_type = 'project'
                              AND a.resource_id = c.project_id::text
                              AND a.details->>'checklistId' = c.id::text
                              AND a.details->>'status' = 'complete'))::text
UNION ALL
SELECT 'BEFORE (informational, QUAL-4): accepted turnover items whose reviewer is the project owner, on projects where another eligible signer existed (an active Admin / Document Control other than the owner — the shape the rail now refuses; nothing is rewritten)',
       (SELECT COUNT(*) FROM turnover_items t
          JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'accepted' AND t.reviewed_by IS NOT NULL
           AND t.reviewed_by::text = p.owner_user_id::text
           AND EXISTS (SELECT 1 FROM org_members m
                        WHERE m.org_id = p.org_id AND m.status = 'active'
                          AND m.uid::text IS DISTINCT FROM p.owner_user_id::text
                          AND is_org_controller_for(p.org_id, m.uid)))::text
UNION ALL
SELECT 'BEFORE (informational, QUAL-4): accepted turnover items whose reviewer is the project owner, on projects with another active project member (project_members — the plan''s "other active members", read per project)',
       (SELECT COUNT(*) FROM turnover_items t
          JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'accepted' AND t.reviewed_by IS NOT NULL
           AND t.reviewed_by::text = p.owner_user_id::text
           AND EXISTS (SELECT 1 FROM project_members pm
                         JOIN org_members m ON m.org_id = p.org_id AND m.uid::text = pm.user_id::text AND m.status = 'active'
                        WHERE pm.project_id = p.id
                          AND pm.user_id::text IS DISTINCT FROM p.owner_user_id::text))::text
UNION ALL
SELECT 'BEFORE (informational): accepted or waived turnover items whose reviewer created them (the shape the rail now refuses where a second signer exists; nothing is rewritten)',
       (SELECT COUNT(*) FROM turnover_items t
         WHERE t.status IN ('accepted', 'waived') AND t.reviewed_by IS NOT NULL AND t.created_by IS NOT NULL
           AND t.reviewed_by::text = t.created_by::text)::text
UNION ALL
SELECT 'BEFORE: completed checklists (all)',
       (SELECT COUNT(*) FROM project_checklists WHERE status = 'complete')::text
UNION ALL
SELECT 'BEFORE: accepted turnover items (all)',
       (SELECT COUNT(*) FROM turnover_items WHERE status = 'accepted')::text
UNION ALL
SELECT 'BEFORE: waived turnover items (all — a waiver is a signed sign-off from now on; earlier ones keep their records)',
       (SELECT COUNT(*) FROM turnover_items WHERE status = 'waived')::text;

BEGIN;

-- ── 1. The evaluator learns the projectId key and quality.sign_off ──────────
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
      WHEN 'holds.release'            THEN '["*"]'::jsonb
      WHEN 'checkout.force_release'   THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'admin.analytics_view'     THEN '["Admin","Manager","Supervisor","DocCtrl"]'::jsonb
      WHEN 'admin.archive_view'       THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'admin.audit_view'         THEN '["Admin","Manager","Supervisor","DocCtrl","Auditor"]'::jsonb
      WHEN 'transmittal.issue'        THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'quality.sign_off'         THEN '[]'::jsonb
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

REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) TO authenticated, service_role;

-- ── 2. Who may sign off a project's quality records ─────────────────────────
-- The capability decision for one project, for a named uid, AND that uid can
-- see the project (project_visible_to_me's rule, the uid named for
-- auth.uid()). Read by the SECURITY DEFINER helpers below; no client calls it
-- (it answers for any uid).
CREATE OR REPLACE FUNCTION quality_signoff_granted_for(p_org uuid, p_project uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p
     WHERE p.id = p_project AND p.org_id = p_org
       AND (p.visibility IS DISTINCT FROM 'private'
            OR p.owner_user_id::text = p_uid::text
            OR is_org_controller_for(p.org_id, p_uid)
            OR EXISTS (SELECT 1 FROM project_members pm
                        WHERE pm.project_id = p.id AND pm.user_id::text = p_uid::text))
       AND org_capability_allows_for(p_org, 'quality.sign_off', p_uid, jsonb_build_object('projectId', p_project::text))
  );
$$;

COMMENT ON FUNCTION quality_signoff_granted_for(uuid, uuid, uuid) IS
  'QUAL-4: quality.sign_off for one project (resource {"projectId": …}, DEC-13) AND the uid can see the project (project_visible_to_me''s rule). Service role only — it answers for any uid.';

-- The same decision for the caller: the four quality write policies read it.
CREATE OR REPLACE FUNCTION quality_signoff_granted(p_org uuid, p_project uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT quality_signoff_granted_for(p_org, p_project, auth.uid());
$$;

COMMENT ON FUNCTION quality_signoff_granted(uuid, uuid) IS
  'QUAL-4: the caller holds quality.sign_off for this project and can see it — the disjunct the four quality write policies gained in 20261136.';

-- Exactly who the write policies admit: an active member who is a controller,
-- the project's owner, or granted quality.sign_off for it.
CREATE OR REPLACE FUNCTION quality_signer_eligible(p_org uuid, p_project uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = p_org AND m.uid = p_uid AND m.status = 'active')
     AND EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project AND p.org_id = p_org)
     AND (is_org_controller_for(p_org, p_uid)
          OR EXISTS (SELECT 1 FROM projects p
                      WHERE p.id = p_project AND p.owner_user_id::text = p_uid::text)
          OR quality_signoff_granted_for(p_org, p_project, p_uid));
$$;

COMMENT ON FUNCTION quality_signer_eligible(uuid, uuid, uuid) IS
  'QUAL-4: an active member the quality write policies admit on this project — a controller, the project owner, or a quality.sign_off holder who can see it. Service role only.';

-- How many OTHER members could sign this project's quality records off — the
-- separation-of-duties rails refuse an author's own sign-off only while this
-- is above zero (DEC-12, per slot: DEC-37).
CREATE OR REPLACE FUNCTION quality_other_signers(p_org uuid, p_project uuid, p_uid uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COUNT(DISTINCT m.uid)::integer FROM org_members m
   WHERE m.org_id = p_org AND m.status = 'active'
     AND m.uid IS DISTINCT FROM p_uid
     AND quality_signer_eligible(p_org, p_project, m.uid);
$$;

COMMENT ON FUNCTION quality_other_signers(uuid, uuid, uuid) IS
  'QUAL-4 / DEC-12: the number of active members other than p_uid who are eligible to sign off this project''s quality records. Service role only.';

-- The caller's answer, for the surface: may I sign off here, and how many
-- others could? NULL on a project the caller cannot see.
CREATE OR REPLACE FUNCTION quality_signoff_status(p_project uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'maySign', quality_signer_eligible(p.org_id, p.id, auth.uid()),
           'otherSigners', quality_other_signers(p.org_id, p.id, auth.uid()))
    FROM projects p
   WHERE p.id = p_project AND project_visible_to_me(p.id);
$$;

COMMENT ON FUNCTION quality_signoff_status(uuid) IS
  'QUAL-4: {maySign, otherSigners} for the caller on a project they can see — the decision the Quality tab renders its sign-off controls from (lib/checklists.ts loadSignoffAuthority).';

REVOKE ALL ON FUNCTION quality_signoff_granted_for(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION quality_signoff_granted_for(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION quality_signoff_granted_for(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION quality_signoff_granted_for(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION quality_signer_eligible(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION quality_signer_eligible(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION quality_signer_eligible(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION quality_signer_eligible(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION quality_other_signers(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION quality_other_signers(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION quality_other_signers(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION quality_other_signers(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION quality_signoff_granted(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION quality_signoff_granted(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION quality_signoff_granted(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION quality_signoff_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION quality_signoff_status(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION quality_signoff_status(uuid) TO authenticated, service_role;

-- ── 3. The four write policies: replaced, one disjunct added ────────────────
-- Each is its NEWEST body byte for byte plus the sign-off disjunct, on USING
-- and WITH CHECK alike, and TO authenticated: anon cannot execute
-- quality_signoff_granted, and PostgreSQL checks that while it plans the
-- policy, so a policy anon still evaluated would turn an anonymous read into
-- "permission denied" instead of no rows (the shape test proves the diff is
-- exactly the disjunct and the role clause).
DROP POLICY IF EXISTS project_checklists_write ON project_checklists;
CREATE POLICY project_checklists_write ON project_checklists FOR ALL TO authenticated
  USING (is_org_controller(org_id) OR user_owns_project(project_id) OR quality_signoff_granted(org_id, project_id))
  WITH CHECK ((is_org_controller(org_id) OR user_owns_project(project_id) OR quality_signoff_granted(org_id, project_id))
    AND org_id = (SELECT p.org_id FROM projects p WHERE p.id = project_checklists.project_id));

COMMENT ON POLICY project_checklists_write ON project_checklists IS
  'Controllers, the project owner, or a quality.sign_off holder for the project (QUAL-4, 20261136) write; WITH CHECK also requires org_id = the project org_id (QUAL-12).';

DROP POLICY IF EXISTS checklist_items_write ON checklist_items;
CREATE POLICY checklist_items_write ON checklist_items FOR ALL TO authenticated
  USING (is_org_controller(org_id) OR EXISTS (
    SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND (user_owns_project(c.project_id) OR quality_signoff_granted(c.org_id, c.project_id))))
  WITH CHECK ((is_org_controller(org_id) OR EXISTS (
    SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND (user_owns_project(c.project_id) OR quality_signoff_granted(c.org_id, c.project_id))))
    AND org_id = (SELECT c.org_id FROM project_checklists c WHERE c.id = checklist_items.checklist_id));

COMMENT ON POLICY checklist_items_write ON checklist_items IS
  'Controllers, the project owner, or a quality.sign_off holder for the checklist''s project (QUAL-4, 20261136) write; WITH CHECK also requires org_id = the parent checklist org_id (QUAL-12).';

DROP POLICY IF EXISTS turnover_items_write ON turnover_items;
CREATE POLICY turnover_items_write ON turnover_items FOR ALL TO authenticated
    USING (is_org_controller(org_id) OR user_owns_project(project_id) OR quality_signoff_granted(org_id, project_id))
    WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id) OR quality_signoff_granted(org_id, project_id));

COMMENT ON POLICY turnover_items_write ON turnover_items IS
  'Controllers, the project owner, or a quality.sign_off holder for the project (QUAL-4, 20261136) write; the 20261091 rails and turnover_items_signoff_rail bind every decision.';

DROP POLICY IF EXISTS punch_items_write ON punch_items;
CREATE POLICY punch_items_write ON punch_items FOR ALL TO authenticated
    USING (is_org_controller(org_id) OR user_owns_project(project_id) OR quality_signoff_granted(org_id, project_id))
    WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id) OR quality_signoff_granted(org_id, project_id));

COMMENT ON POLICY punch_items_write ON punch_items IS
  'Controllers, the project owner, or a quality.sign_off holder for the project (QUAL-4, 20261136) write; punch_items_void_rail (20261091) binds every closure.';

-- ── 4. The sign-off record ──────────────────────────────────────────────────
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_by UUID;
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_by_name TEXT;
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_signature_id UUID;
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_single_signer BOOLEAN;
ALTER TABLE turnover_items ADD COLUMN IF NOT EXISTS reviewed_signature_id UUID;
ALTER TABLE turnover_items ADD COLUMN IF NOT EXISTS reviewed_single_signer BOOLEAN;

COMMENT ON COLUMN project_checklists.status_changed_at IS
  'QUAL-4: when the status last changed, by the database''s clock — a completion''s e-signature must be newer (a signature made before a reopen never completes the reopened checklist).';
COMMENT ON COLUMN project_checklists.completed_signature_id IS
  'QUAL-4: the e_signatures row (resource_type project_checklist) the completion rests on — written by project_checklists_signoff_rail, never by a client.';
COMMENT ON COLUMN project_checklists.completed_single_signer IS
  'QUAL-4 / DEC-12: true when the author completed it because nobody else on the project could sign it off — allowed, and marked on the record.';
COMMENT ON COLUMN turnover_items.reviewed_signature_id IS
  'QUAL-4: the e_signatures row (resource_type turnover_item) a standing acceptance or waiver rests on — written by turnover_items_signoff_rail, never by a client.';
COMMENT ON COLUMN turnover_items.reviewed_single_signer IS
  'QUAL-4 / DEC-12: true when the item''s creator accepted or waived it because nobody else on the project could — allowed, and marked on the record.';

-- ── 5. Separation of duties + the signed sign-off, at the database ──────────
CREATE OR REPLACE FUNCTION project_checklists_signoff_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_others integer := 0;
  v_sig uuid;
  v_signer text;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor

  IF TG_OP = 'INSERT' THEN
    -- The author is the signed-in caller, never a client-chosen uid — the
    -- separation-of-duties rule below compares against it.
    NEW.created_by := v_uid;
    NEW.created_by_name := quality_actor_name(v_uid);
    NEW.status_changed_at := NOW();
    NEW.completed_by := NULL;
    NEW.completed_by_name := NULL;
    NEW.completed_at := NULL;
    NEW.completed_signature_id := NULL;
    NEW.completed_single_signer := NULL;
    RETURN NEW;
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'The author of a checklist is never rewritten; nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A checklist stays on the project it was written for: a move would take
  -- it out of that project's package unsigned (J2 already holds a completed one).
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'A checklist stays on the project it was written for — create it again on the other project. Nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A completion is a signed sign-off — often the second person's, because
  -- the author could not give it. Reopening or voiding it clears the
  -- completion record below and checklists keep no history table, so only a
  -- controller undoes one (an org always keeps an active Admin: never a dead
  -- end); its e_signatures row stays, and keeps the checklist from anyone
  -- else's delete (quality_records_delete_rail).
  IF OLD.status = 'complete' AND NEW.status IS DISTINCT FROM 'complete'
     AND NOT is_org_controller(OLD.org_id) THEN
    RAISE EXCEPTION 'A completed checklist is a signed sign-off — only Admin / Document Control reopens or voids it. Nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.status_changed_at := CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN NOW() ELSE OLD.status_changed_at END;

  IF NEW.status = 'complete' AND OLD.status IS DISTINCT FROM 'complete' THEN
    -- DEC-12 / DEC-37: the author does not sign their own checklist off
    -- while anyone else on the project could.
    IF OLD.created_by IS NOT NULL AND OLD.created_by = v_uid THEN
      v_others := quality_other_signers(NEW.org_id, NEW.project_id, v_uid);
      IF v_others > 0 THEN
        RAISE EXCEPTION 'You created this checklist, so a second person signs it off — % other eligible signer(s) on this project. Nothing was changed. QUAL-4, 20261136', v_others
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- The completer's own ceremony signature on THIS checklist, made for
    -- this completion (fresh, and after the last status change).
    SELECT e.id, e.signer_name INTO v_sig, v_signer
      FROM e_signatures e
     WHERE e.org_id = NEW.org_id
       AND e.resource_type = 'project_checklist'
       AND e.resource_id = NEW.id
       AND e.signer_user_id = v_uid
       AND e.intent IN ('Reviewed', 'Approved')
       AND e.signed_at > NOW() - interval '15 minutes'
       AND e.signed_at > COALESCE(OLD.status_changed_at, '-infinity'::timestamptz)
     ORDER BY e.signed_at DESC
     LIMIT 1;
    IF v_sig IS NULL THEN
      RAISE EXCEPTION 'A checklist is completed by a signed sign-off: sign it (your e-signature on this checklist, made in the last 15 minutes) and complete it again. Nothing was changed. QUAL-4, 20261136'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.completed_by := v_uid;
    NEW.completed_by_name := COALESCE(NULLIF(btrim(v_signer), ''), quality_actor_name(v_uid));
    NEW.completed_at := NOW();
    NEW.completed_signature_id := v_sig;
    NEW.completed_single_signer := (OLD.created_by IS NOT NULL AND OLD.created_by = v_uid);
  ELSIF NEW.status = 'complete' THEN
    -- A standing completion keeps its sign-off until a controller reopens it.
    IF NEW.completed_by IS DISTINCT FROM OLD.completed_by
       OR NEW.completed_by_name IS DISTINCT FROM OLD.completed_by_name
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.completed_signature_id IS DISTINCT FROM OLD.completed_signature_id
       OR NEW.completed_single_signer IS DISTINCT FROM OLD.completed_single_signer THEN
      RAISE EXCEPTION 'A completed checklist keeps its sign-off — only Admin / Document Control reopens it to change it; nothing was changed. QUAL-4, 20261136'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- Not complete: no completion record (the signature row itself stays).
    NEW.completed_by := NULL;
    NEW.completed_by_name := NULL;
    NEW.completed_at := NULL;
    NEW.completed_signature_id := NULL;
    NEW.completed_single_signer := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION project_checklists_signoff_rail() IS
  'QUAL-4: the author is the caller at insert and never rewritten; a checklist never moves to another project; a completed checklist is reopened or voided only by a controller; a move to complete is refused for the author while another eligible signer exists (allowed and marked single-signer otherwise) and needs the completer''s own e-signature on this checklist from the last 15 minutes and after the last status change; the completion record is the database''s.';

DROP TRIGGER IF EXISTS trg_project_checklists_signoff_rail ON project_checklists;
CREATE TRIGGER trg_project_checklists_signoff_rail
  BEFORE INSERT OR UPDATE ON project_checklists
  FOR EACH ROW EXECUTE FUNCTION project_checklists_signoff_rail();

CREATE OR REPLACE FUNCTION turnover_items_signoff_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_others integer := 0;
  v_sig uuid;
  v_since timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := v_uid;
    IF NEW.status IN ('accepted', 'waived') THEN
      RAISE EXCEPTION 'A turnover item is accepted or waived by its signed review, never born accepted or waived — add it, then decide it with your signature. Nothing was changed. QUAL-4, 20261136'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.reviewed_signature_id := NULL;
    NEW.reviewed_single_signer := NULL;
    RETURN NEW;
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'The creator of a turnover item is never rewritten; nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A required item leaves the package only by a signed waiver: unmarking it
  -- would clear it from every count an acceptance clears it from, unsigned.
  IF OLD.required AND NOT NEW.required THEN
    RAISE EXCEPTION 'A required turnover item stays required — set it aside with a signed waiver and its reason instead. Nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Nor does an item change project: that would drop it from one package
  -- unsigned, or carry a decision signed for one project into another's
  -- closeout. No product path moves one.
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'A turnover item stays in the package it was added to — add it again on the other project. Nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('accepted', 'waived') AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- An acceptance and a waiver both clear the item from the package (the
    -- progress, the project snapshot, the closeout gate), so both are signed
    -- sign-offs. DEC-12 / DEC-37: whoever put the item on the record does not
    -- accept or waive it while anyone else on the project could.
    IF OLD.created_by IS NOT NULL AND OLD.created_by = v_uid THEN
      v_others := quality_other_signers(NEW.org_id, NEW.project_id, v_uid);
      IF v_others > 0 THEN
        RAISE EXCEPTION 'You added this turnover item, so a second person accepts or waives it — % other eligible signer(s) on this project. Nothing was changed. QUAL-4, 20261136', v_others
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- The decider's own ceremony signature on THIS item, made after its last
    -- status change (its newest history row, 20261091) and in the last 15 minutes.
    SELECT max(h.created_at) INTO v_since FROM turnover_review_events h WHERE h.item_id = NEW.id;
    SELECT s.id INTO v_sig
      FROM e_signatures s
     WHERE s.org_id = NEW.org_id
       AND s.resource_type = 'turnover_item'
       AND s.resource_id = NEW.id
       AND s.signer_user_id = v_uid
       AND s.intent IN ('Reviewed', 'Approved')
       AND s.signed_at > NOW() - interval '15 minutes'
       AND s.signed_at > COALESCE(v_since, '-infinity'::timestamptz)
     ORDER BY s.signed_at DESC
     LIMIT 1;
    IF v_sig IS NULL THEN
      RAISE EXCEPTION 'A turnover acceptance or waiver is a signed sign-off: sign it (your e-signature on this item, made in the last 15 minutes) and decide it again. Nothing was changed. QUAL-4, 20261136'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.reviewed_signature_id := v_sig;
    NEW.reviewed_single_signer := (OLD.created_by IS NOT NULL AND OLD.created_by = v_uid);
  ELSIF NEW.status IN ('accepted', 'waived') THEN
    -- A standing acceptance or waiver keeps its sign-off until it is reopened.
    IF NEW.reviewed_signature_id IS DISTINCT FROM OLD.reviewed_signature_id
       OR NEW.reviewed_single_signer IS DISTINCT FROM OLD.reviewed_single_signer THEN
      RAISE EXCEPTION 'A standing acceptance or waiver keeps its sign-off — reopen the item to change it; nothing was changed. QUAL-4, 20261136'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    NEW.reviewed_signature_id := NULL;
    NEW.reviewed_single_signer := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION turnover_items_signoff_rail() IS
  'QUAL-4: the creator is the caller at insert and never rewritten; no item is born accepted or waived; a required item is never unmarked; no item moves to another project; a move to accepted or waived (either clears the item from the package) is refused for the creator while another eligible signer exists (allowed and marked single-signer otherwise) and needs the decider''s own e-signature on this item from the last 15 minutes and after its last history row.';

DROP TRIGGER IF EXISTS trg_turnover_items_signoff_rail ON turnover_items;
CREATE TRIGGER trg_turnover_items_signoff_rail
  BEFORE INSERT OR UPDATE ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION turnover_items_signoff_rail();

-- ── 6. Deleting a quality record: never the grant's, never a signed one ─────
-- The four write policies are FOR ALL, so the sign-off disjunct would admit
-- DELETE too. A grant writes a project's quality records; it does not delete
-- them. A signed sign-off (a checklist that carries a signature — completed
-- now, or signed before a controller reopened or voided it; an accepted or
-- waived turnover item) and a required turnover item are deleted by a
-- controller only: they leave by a controller's reopen or void, a signed
-- waiver, or with their project. A checklist keeps no history table, so its
-- signature row is the test, not only its current status. (A reopened
-- turnover item's signed decision outlives it in turnover_review_events,
-- which has no foreign key.) The owner's delete of anything else (20261013)
-- stands. The service pass, an FK cascade (one trigger level down) and
-- delete_project_record's audited purge (20261103's app.record_purge) pass.
CREATE OR REPLACE FUNCTION quality_records_delete_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old jsonb;
  v_status text;
BEGIN
  IF v_uid IS NULL THEN RETURN OLD; END IF;            -- service pass: restores, server routes, the SQL editor
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;   -- an FK cascade: the project's or the org's own delete
  v_old := to_jsonb(OLD);                              -- one function for three tables: read fields by name
  v_status := v_old->>'status';
  IF COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.project_id::text THEN
    RETURN OLD;                                        -- delete_project_record's audited purge (20261103)
  END IF;
  IF is_org_controller(OLD.org_id) THEN RETURN OLD; END IF;

  IF TG_TABLE_NAME = 'project_checklists'
     AND (v_status = 'complete'
          OR EXISTS (SELECT 1 FROM e_signatures e
                      WHERE e.org_id = OLD.org_id
                        AND e.resource_type = 'project_checklist'
                        AND e.resource_id = OLD.id)) THEN
    RAISE EXCEPTION 'This checklist carries a signed sign-off (completed, or signed before it was reopened or voided) — only Admin / Document Control deletes one. Nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'turnover_items'
     AND (v_status IN ('accepted', 'waived') OR COALESCE((v_old->>'required')::boolean, true)) THEN
    RAISE EXCEPTION 'A required or decided turnover item leaves the package by a signed waiver (or with its project), never by a delete; only Admin / Document Control deletes one. Nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT user_owns_project(OLD.project_id) THEN
    -- The one delete the app makes: createChecklist taking back the header
    -- it just inserted when its items failed to save (no item exists).
    IF TG_TABLE_NAME = 'project_checklists' AND v_status = 'open'
       AND v_old->>'created_by' = v_uid::text
       AND NOT EXISTS (SELECT 1 FROM checklist_items i WHERE i.checklist_id = OLD.id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A quality sign-off grant writes this project''s quality records but does not delete them — void or waive with a reason, or ask the project owner or Admin / Document Control. Nothing was changed. QUAL-4, 20261136'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION quality_records_delete_rail() IS
  'QUAL-4: a quality.sign_off grant never deletes a project''s checklists, turnover or punch (only its own item-less checklist header, the create rollback); a checklist that carries a signature (completed, or signed before a reopen or void), an accepted or waived turnover item and a required turnover item are deleted by a controller only. The service pass, an FK cascade and delete_project_record''s purge pass.';

DROP TRIGGER IF EXISTS trg_project_checklists_signoff_delete_rail ON project_checklists;
CREATE TRIGGER trg_project_checklists_signoff_delete_rail
  BEFORE DELETE ON project_checklists
  FOR EACH ROW EXECUTE FUNCTION quality_records_delete_rail();
DROP TRIGGER IF EXISTS trg_turnover_items_signoff_delete_rail ON turnover_items;
CREATE TRIGGER trg_turnover_items_signoff_delete_rail
  BEFORE DELETE ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION quality_records_delete_rail();
DROP TRIGGER IF EXISTS trg_punch_items_signoff_delete_rail ON punch_items;
CREATE TRIGGER trg_punch_items_signoff_delete_rail
  BEFORE DELETE ON punch_items
  FOR EACH ROW EXECUTE FUNCTION quality_records_delete_rail();

-- Trigger functions run only as triggers; no client role needs them directly.
REVOKE ALL ON FUNCTION project_checklists_signoff_rail() FROM PUBLIC;
REVOKE ALL ON FUNCTION project_checklists_signoff_rail() FROM anon;
GRANT EXECUTE ON FUNCTION project_checklists_signoff_rail() TO authenticated, service_role;
REVOKE ALL ON FUNCTION turnover_items_signoff_rail() FROM PUBLIC;
REVOKE ALL ON FUNCTION turnover_items_signoff_rail() FROM anon;
GRANT EXECUTE ON FUNCTION turnover_items_signoff_rail() TO authenticated, service_role;
REVOKE ALL ON FUNCTION quality_records_delete_rail() FROM PUBLIC;
REVOKE ALL ON FUNCTION quality_records_delete_rail() FROM anon;
GRANT EXECUTE ON FUNCTION quality_records_delete_rail() TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_policies.qual / with_check are DEPARSED; pg_proc.prosrc is verbatim.
SELECT 'apply order: 20261091, 20261125 and 20261132 were live (the file checked before it started)' AS check,
       (to_regclass('public.turnover_review_events') IS NOT NULL
        AND to_regprocedure('public.is_org_controller_for(uuid,uuid)') IS NOT NULL
        AND (SELECT prosrc LIKE '%WHEN ''transmittal.issue''%' FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4)) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the evaluator carries the quality.sign_off default (none — controllers and the project owner sign off by standing, not through the capability) and every earlier default',
       (SELECT prosrc LIKE '%WHEN ''quality.sign_off''         THEN ''[]''::jsonb%'
              AND prosrc LIKE '%WHEN ''transmittal.issue''        THEN ''["Admin","DocCtrl"]''::jsonb%'
              AND prosrc LIKE '%admin.audit_view%' AND prosrc LIKE '%admin.archive_view%'
              AND prosrc LIKE '%checkout.force_release%' AND prosrc LIKE '%ticket.engineer_gate_exempt%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4),
       NULL::text
UNION ALL
SELECT 'the evaluator reads five resource keys (projectId added) in both rule passes',
       (SELECT (length(prosrc) - length(replace(prosrc, '''requestType'', ''unit'', ''libraryId'', ''discipline'', ''projectId''', '')))
                 / length('''requestType'', ''unit'', ''libraryId'', ''discipline'', ''projectId''') = 2
          FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4),
       NULL::text
UNION ALL
SELECT 'the 3-argument wrapper is untouched and still delegates with an empty resource',
       (SELECT prosrc LIKE '%org_capability_allows_for(p_org, p_cap, p_uid, ''{}''::jsonb)%'
          FROM pg_proc WHERE proname = 'org_capability_allows' AND pronargs = 3),
       NULL::text
UNION ALL
SELECT 'search_path pinned on both evaluator entry points',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('org_capability_allows', 'org_capability_allows_for')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%'),
       NULL::text
UNION ALL
SELECT 'anon cannot execute the resource-aware evaluator org_capability_allows_for; authenticated and service_role can (DRLS-16) — the 3-argument wrapper keeps its default grant',
       (NOT has_function_privilege('anon', 'org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE')
        AND has_function_privilege('service_role', 'org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE')),
       NULL::text
UNION ALL
SELECT 'the five sign-off helpers are SECURITY DEFINER with search_path pinned',
       (SELECT COUNT(*) = 5 FROM pg_proc
         WHERE proname IN ('quality_signoff_granted_for', 'quality_signoff_granted', 'quality_signer_eligible', 'quality_other_signers', 'quality_signoff_status')
           AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'),
       NULL::text
UNION ALL
SELECT 'no sign-off helper is executable by anon; the per-uid ones by no client; the caller''s two by authenticated',
       (NOT has_function_privilege('anon', 'quality_signoff_granted(uuid,uuid)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'quality_signoff_status(uuid)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'quality_signoff_granted(uuid,uuid)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'quality_signoff_status(uuid)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'quality_signoff_granted_for(uuid,uuid,uuid)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'quality_signoff_granted_for(uuid,uuid,uuid)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'quality_signer_eligible(uuid,uuid,uuid)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'quality_other_signers(uuid,uuid,uuid)', 'EXECUTE')
        AND has_function_privilege('service_role', 'quality_other_signers(uuid,uuid,uuid)', 'EXECUTE')),
       NULL::text
UNION ALL
SELECT 'project_checklists_write is the ONLY permissive write policy on project_checklists, and carries the sign-off disjunct on USING and WITH CHECK',
       (SELECT COUNT(*) FILTER (WHERE cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE') AND permissive = 'PERMISSIVE') = 1
              AND bool_or(policyname = 'project_checklists_write' AND cmd = 'ALL'
                          AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%user_owns_project(project_id)%'
                          AND qual LIKE '%quality_signoff_granted(org_id, project_id)%'
                          AND with_check LIKE '%quality_signoff_granted(org_id, project_id)%')
          FROM pg_policies WHERE tablename = 'project_checklists'),
       NULL::text
UNION ALL
SELECT 'checklist_items_write is the ONLY permissive write policy on checklist_items, and carries the sign-off disjunct on USING and WITH CHECK',
       (SELECT COUNT(*) FILTER (WHERE cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE') AND permissive = 'PERMISSIVE') = 1
              AND bool_or(policyname = 'checklist_items_write' AND cmd = 'ALL'
                          AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%user_owns_project(c.project_id)%'
                          AND qual LIKE '%quality_signoff_granted(c.org_id, c.project_id)%'
                          AND with_check LIKE '%quality_signoff_granted(c.org_id, c.project_id)%')
          FROM pg_policies WHERE tablename = 'checklist_items'),
       NULL::text
UNION ALL
SELECT 'turnover_items_write is the ONLY permissive write policy on turnover_items, and carries the sign-off disjunct on USING and WITH CHECK',
       (SELECT COUNT(*) FILTER (WHERE cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE') AND permissive = 'PERMISSIVE') = 1
              AND bool_or(policyname = 'turnover_items_write' AND cmd = 'ALL'
                          AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%user_owns_project(project_id)%'
                          AND qual LIKE '%quality_signoff_granted(org_id, project_id)%'
                          AND with_check LIKE '%quality_signoff_granted(org_id, project_id)%')
          FROM pg_policies WHERE tablename = 'turnover_items'),
       NULL::text
UNION ALL
SELECT 'punch_items_write is the ONLY permissive write policy on punch_items, and carries the sign-off disjunct on USING and WITH CHECK',
       (SELECT COUNT(*) FILTER (WHERE cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE') AND permissive = 'PERMISSIVE') = 1
              AND bool_or(policyname = 'punch_items_write' AND cmd = 'ALL'
                          AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%user_owns_project(project_id)%'
                          AND qual LIKE '%quality_signoff_granted(org_id, project_id)%'
                          AND with_check LIKE '%quality_signoff_granted(org_id, project_id)%')
          FROM pg_policies WHERE tablename = 'punch_items'),
       NULL::text
UNION ALL
SELECT 'the four write policies apply TO authenticated only — anon never evaluates quality_signoff_granted, so an anonymous read answers no rows, not an error',
       (SELECT COUNT(*) = 4 FROM pg_policies
         WHERE policyname IN ('project_checklists_write', 'checklist_items_write', 'turnover_items_write', 'punch_items_write')
           AND tablename IN ('project_checklists', 'checklist_items', 'turnover_items', 'punch_items')
           AND roles::text[] = ARRAY['authenticated']::text[]),
       NULL::text
UNION ALL
SELECT 'the sign-off record columns exist (6 on project_checklists, 2 on turnover_items)',
       ((SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'project_checklists'
            AND column_name IN ('status_changed_at', 'completed_by', 'completed_by_name', 'completed_at', 'completed_signature_id', 'completed_single_signer')) = 6
        AND (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'turnover_items'
                AND column_name IN ('reviewed_signature_id', 'reviewed_single_signer')) = 2),
       NULL::text
UNION ALL
SELECT 'both sign-off rails fire BEFORE INSERT OR UPDATE, beside J2''s rails (completion basis, decision rail, org match)',
       (SELECT COUNT(*) = 2 FROM pg_trigger t
         WHERE NOT t.tgisinternal
           AND ((t.tgname = 'trg_project_checklists_signoff_rail' AND t.tgrelid = 'project_checklists'::regclass)
                OR (t.tgname = 'trg_turnover_items_signoff_rail' AND t.tgrelid = 'turnover_items'::regclass))
           AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16)
       AND (SELECT COUNT(*) = 3 FROM pg_trigger t
             WHERE NOT t.tgisinternal
               AND t.tgname IN ('trg_project_checklists_completion_basis', 'trg_turnover_items_decision_rail', 'trg_project_checklists_org_matches_project')),
       NULL::text
UNION ALL
SELECT 'the checklist rail refuses the author''s own completion while others can sign, requires a fresh signature on the checklist, keeps a completed checklist''s reopen or void to controllers, and never moves a checklist to another project',
       (SELECT prosrc LIKE '%v_others := quality_other_signers(NEW.org_id, NEW.project_id, v_uid);%'
              AND prosrc LIKE '%IF OLD.status = ''complete'' AND NEW.status IS DISTINCT FROM ''complete''%AND NOT is_org_controller(OLD.org_id) THEN%'
              AND prosrc LIKE '%IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN%'
              AND prosrc LIKE '%e.resource_type = ''project_checklist''%'
              AND prosrc LIKE '%e.signer_user_id = v_uid%'
              AND prosrc LIKE '%e.signed_at > NOW() - interval ''15 minutes''%'
              AND prosrc LIKE '%e.signed_at > COALESCE(OLD.status_changed_at, ''-infinity''::timestamptz)%'
              AND prosrc LIKE '%NEW.created_by := v_uid;%'
              AND prosrc LIKE '%NEW.completed_single_signer := (OLD.created_by IS NOT NULL AND OLD.created_by = v_uid);%'
              AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'project_checklists_signoff_rail' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'the turnover rail treats an acceptance AND a waiver as a sign-off (the creator refused while others can sign; a fresh signature on the item), refuses an item born accepted or waived, never unmarks a required item, and never moves an item to another project',
       (SELECT prosrc LIKE '%IF NEW.status IN (''accepted'', ''waived'') AND NEW.status IS DISTINCT FROM OLD.status THEN%'
              AND prosrc LIKE '%v_others := quality_other_signers(NEW.org_id, NEW.project_id, v_uid);%'
              AND prosrc LIKE '%s.resource_type = ''turnover_item''%'
              AND prosrc LIKE '%s.signer_user_id = v_uid%'
              AND prosrc LIKE '%s.signed_at > NOW() - interval ''15 minutes''%'
              AND prosrc LIKE '%IF NEW.status IN (''accepted'', ''waived'') THEN%never born accepted or waived%'
              AND prosrc LIKE '%IF OLD.required AND NOT NEW.required THEN%'
              AND prosrc LIKE '%IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN%'
              AND prosrc LIKE '%NEW.reviewed_single_signer := (OLD.created_by IS NOT NULL AND OLD.created_by = v_uid);%'
              AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'turnover_items_signoff_rail' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'the delete rail fires BEFORE DELETE on project_checklists, turnover_items and punch_items: a grant never deletes; a signed sign-off (a checklist carrying a signature, completed or not) or a required turnover item is a controller''s to delete; cascade and purge pass',
       (SELECT COUNT(*) = 3 FROM pg_trigger t
         WHERE NOT t.tgisinternal
           AND ((t.tgname = 'trg_project_checklists_signoff_delete_rail' AND t.tgrelid = 'project_checklists'::regclass)
                OR (t.tgname = 'trg_turnover_items_signoff_delete_rail' AND t.tgrelid = 'turnover_items'::regclass)
                OR (t.tgname = 'trg_punch_items_signoff_delete_rail' AND t.tgrelid = 'punch_items'::regclass))
           AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8 AND (t.tgtype & 1) = 1)
       AND (SELECT prosrc LIKE '%IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;%'
                   AND prosrc LIKE '%current_setting(''app.record_purge'', true)%'
                   AND prosrc LIKE '%IF is_org_controller(OLD.org_id) THEN RETURN OLD; END IF;%'
                   AND prosrc LIKE '%v_status = ''complete''%'
                   AND prosrc LIKE '%OR EXISTS (SELECT 1 FROM e_signatures e%e.resource_type = ''project_checklist''%e.resource_id = OLD.id%'
                   AND prosrc LIKE '%v_status IN (''accepted'', ''waived'') OR COALESCE((v_old->>''required'')::boolean, true)%'
                   AND prosrc LIKE '%IF NOT user_owns_project(OLD.project_id) THEN%'
                   AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'quality_records_delete_rail' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT label, NULL::boolean, n FROM prj_roundg_signoff_before
UNION ALL
SELECT 'AFTER: active members the evaluator grants quality.sign_off with no project named (expect 0 until an org grants it — controllers and the project owner sign off by standing, not through the capability)', NULL::boolean, COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active' AND org_capability_allows_for(m.org_id, 'quality.sign_off', m.uid, '{}'::jsonb)
UNION ALL
SELECT 'AFTER: active controllers (Admin / Document Control) — standing signers on every project they can see, whatever the capability policy says', NULL::boolean, COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active' AND is_org_controller_for(m.org_id, m.uid)
UNION ALL
SELECT 'AFTER: open checklists whose author now needs a second person to sign them off (another eligible signer exists)', NULL::boolean, COALESCE(SUM(g.n), 0)::text
  FROM (SELECT c.org_id, c.project_id, c.created_by, COUNT(*) AS n
          FROM project_checklists c
         WHERE c.status = 'open' AND c.created_by IS NOT NULL
         GROUP BY c.org_id, c.project_id, c.created_by) g
 WHERE quality_other_signers(g.org_id, g.project_id, g.created_by) > 0
UNION ALL
SELECT 'AFTER: open checklists whose author is the only eligible signer (their completion will be marked single-signer)', NULL::boolean, COALESCE(SUM(g.n), 0)::text
  FROM (SELECT c.org_id, c.project_id, c.created_by, COUNT(*) AS n
          FROM project_checklists c
         WHERE c.status = 'open' AND c.created_by IS NOT NULL
         GROUP BY c.org_id, c.project_id, c.created_by) g
 WHERE quality_other_signers(g.org_id, g.project_id, g.created_by) = 0
UNION ALL
SELECT 'AFTER: undecided turnover items (open, received or rejected — every seeded item is born open) whose creator now needs a second person to accept or waive them', NULL::boolean, COALESCE(SUM(g.n), 0)::text
  FROM (SELECT t.org_id, t.project_id, t.created_by, COUNT(*) AS n
          FROM turnover_items t
         WHERE t.status NOT IN ('accepted', 'waived') AND t.created_by IS NOT NULL
         GROUP BY t.org_id, t.project_id, t.created_by) g
 WHERE quality_other_signers(g.org_id, g.project_id, g.created_by) > 0;
