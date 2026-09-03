-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 6 severity sweep, Round B (2 of 2): integrity
-- rails — the rows that record a person's own act can only be minted by that
-- person, the mail queue is honest about who may read, write and address it,
-- project roster roles mean something, and a hold knows the ticket it came
-- from.
--
--   SURF-12  document_acknowledgments: INSERT may only create a PENDING row
--            (the RG-1 shape 20261032 gave distribution_acks); a BEFORE UPDATE
--            guard makes the pending → acknowledged transition the named
--            assignee's own act, bound to their own e-signature, never
--            self-waived, never quietly edited.
--   SURF-13  the review sign-off guard also pins reviewer_name and refuses a
--            signature attached to a row that is not being signed.
--   SURF-11  project_members.role decides management authority (observer
--            manages nothing) and the roster helpers require an ACTIVE org
--            membership; can_manage_project gains the search_path pin.
--   SURF-17  a member can no longer queue mail to an arbitrary address: a
--            client INSERT must address a member of the same org and may not
--            be marked external (external mail is server-side only, via the
--            transmittal send route that renders from the row).
--   SURF-18  email_notifications gains SELECT (own rows, or Admin/Manager by
--            collection) and a confined UPDATE (Admin/Manager; status /
--            attempt_count only) so the dedupe check and the dead-letter
--            panel read something instead of silently nothing.
--   LIFE-6   document_holds.origin_ticket_id — the hold knows its ticket, the
--            close gate (app) can find the hold, and neither is a guess.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. SURF-12: read-and-understood acknowledgments are the assignee's own act
DROP POLICY IF EXISTS doc_ack_insert ON document_acknowledgments;
CREATE POLICY doc_ack_insert ON document_acknowledgments FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
  AND status = 'pending' AND signature_id IS NULL AND acknowledged_at IS NULL
);

CREATE OR REPLACE FUNCTION enforce_document_ack_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Service-role / cron / restore writes carry no JWT and are trusted.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- Identity is immutable — an acknowledgment cannot be repointed.
  IF NEW.assignee_user_id     IS DISTINCT FROM OLD.assignee_user_id
     OR NEW.document_id        IS DISTINCT FROM OLD.document_id
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.org_id             IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Acknowledgment rows are immutable in identity.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Becoming acknowledged: only the named assignee, with their own
  -- e-signature for this org (and this revision, where the row names one).
  IF NEW.status = 'acknowledged' AND OLD.status IS DISTINCT FROM 'acknowledged' THEN
    IF OLD.assignee_user_id::text <> auth.uid()::text THEN
      RAISE EXCEPTION 'Only the named assignee can acknowledge their own read-and-understood row.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.signature_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM e_signatures e
      WHERE e.id = NEW.signature_id
        AND e.signer_user_id::text = auth.uid()::text
        AND e.org_id = OLD.org_id
        AND (OLD.document_version_id IS NULL
             OR e.document_version_id = OLD.document_version_id
             OR e.document_version_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'An acknowledgment must carry the assignee''s own e-signature for this revision.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A waiver is someone else's explicit, logged act — never the assignee's own.
  IF NEW.status = 'waived' AND OLD.status IS DISTINCT FROM 'waived'
     AND OLD.assignee_user_id::text = auth.uid()::text
     AND NOT is_org_controller(OLD.org_id) THEN
    RAISE EXCEPTION 'You cannot waive your own acknowledgment.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A recorded acknowledgment cannot be quietly edited or resurrected.
  IF OLD.status = 'acknowledged' AND NEW.status = 'acknowledged'
     AND (NEW.signature_id IS DISTINCT FROM OLD.signature_id
          OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at) THEN
    RAISE EXCEPTION 'A recorded acknowledgment cannot be altered.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'A decided acknowledgment row cannot return to pending — open a new roster for a new revision.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_ack_guard ON document_acknowledgments;
CREATE TRIGGER trg_document_ack_guard
BEFORE UPDATE ON document_acknowledgments
FOR EACH ROW EXECUTE FUNCTION enforce_document_ack_guard();

-- ── 2. SURF-13: the review sign-off guard (body from 20261030) pins the name
CREATE OR REPLACE FUNCTION enforce_review_signoff_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Service-role / cron / restore writes carry no JWT and are trusted.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- The row's identity is immutable — repointing an approval at a different
  -- reviewer, slot, draft or document is never a legitimate edit.
  IF NEW.reviewer_user_id     IS DISTINCT FROM OLD.reviewer_user_id
     OR NEW.reviewer_name      IS DISTINCT FROM OLD.reviewer_name
     OR NEW.slot               IS DISTINCT FROM OLD.slot
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.document_id        IS DISTINCT FROM OLD.document_id
     OR NEW.org_id             IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Review sign-off rows are immutable in identity — void it and open a new roster instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- SURF-13: a signature is attached only by the act of signing.
  IF NEW.signature_id IS DISTINCT FROM OLD.signature_id AND NEW.status IS DISTINCT FROM 'signed' THEN
    RAISE EXCEPTION 'A signature can only be attached to a review row by signing it.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Becoming signed: only the named reviewer, with their own e-signature
  -- bound to this exact draft. (e_signatures is self-insert-only by RLS, so
  -- signer_user_id is trustworthy.)
  IF NEW.status = 'signed' AND OLD.status IS DISTINCT FROM 'signed' THEN
    IF OLD.reviewer_user_id::text <> auth.uid()::text THEN
      RAISE EXCEPTION 'Only the named reviewer can sign their own review row.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Strict on every axis for NEW signings: the app always stamps the
    -- signature with this draft's version and org, and signature_id carries
    -- no FK — without the org/version match a dangling or reused UUID (even
    -- another org's) would pass.
    IF NEW.signature_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM e_signatures e
      WHERE e.id = NEW.signature_id
        AND e.signer_user_id::text = auth.uid()::text
        AND e.org_id = OLD.org_id
        AND e.document_version_id = OLD.document_version_id
    ) THEN
      RAISE EXCEPTION 'A review sign-off must carry the reviewer''s own e-signature for this draft.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A recorded approval cannot be quietly edited or resurrected: on a row
  -- already signed, the signature may not be swapped, and the only way OUT of
  -- 'signed' (or back from any decided state to 'pending') is void/invalidate.
  IF OLD.status = 'signed' AND NEW.status = 'signed'
     AND (NEW.signature_id IS DISTINCT FROM OLD.signature_id
          OR NEW.signed_at IS DISTINCT FROM OLD.signed_at) THEN
    RAISE EXCEPTION 'A signed review row''s signature cannot be altered.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'A decided review row cannot return to pending — open a new roster for a new draft.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. SURF-11: project roster roles mean something; roster helpers need an active membership
CREATE OR REPLACE FUNCTION can_manage_project(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p WHERE p.id = p_project AND (
      (p.owner_user_id = auth.uid()
       AND EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = p.org_id AND om.uid = auth.uid() AND om.status = 'active'))
      OR caller_holds_any_role(p.org_id, ARRAY['Admin','Manager']::text[])
      -- SURF-11: an 'observer' is on the roster to SEE, never to manage.
      OR EXISTS (SELECT 1 FROM project_members pm
                 JOIN org_members om ON om.org_id = p.org_id AND om.uid = pm.user_id AND om.status = 'active'
                 WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
                   AND COALESCE(pm.role, 'collaborator') IN ('owner', 'collaborator'))
    )
  );
$$;

CREATE OR REPLACE FUNCTION is_project_member(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM project_members pm
                 JOIN projects p ON p.id = pm.project_id
                 JOIN org_members om ON om.org_id = p.org_id AND om.uid = pm.user_id AND om.status = 'active'
                 WHERE pm.project_id = p_project AND pm.user_id::text = auth.uid()::text);
$$;

CREATE OR REPLACE FUNCTION is_project_owner(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM projects p
                 JOIN org_members om ON om.org_id = p.org_id AND om.uid = p.owner_user_id AND om.status = 'active'
                 WHERE p.id = p_project AND p.owner_user_id::text = auth.uid()::text);
$$;

-- ── 4. SURF-17 / SURF-18: the mail queue is honest ──────────────────────────
-- INSERT (client): an active member may queue mail only to a member of the
-- same org, and may not mark it external. External mail (transmittal
-- recipients, intake submitters) is queued server-side, rendered from the row.
DROP POLICY IF EXISTS email_notif_insert ON email_notifications;
CREATE POLICY email_notif_insert ON email_notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members WHERE org_id = email_notifications.org_id AND uid = auth.uid() AND status = 'active')
    AND COALESCE(metadata->>'external', '') <> 'true'
    AND EXISTS (SELECT 1 FROM org_members r WHERE r.org_id = email_notifications.org_id
                AND lower(r.email) = lower(email_notifications.to_email))
  );

-- SELECT: your own rows (the dedupe window), or the admin trail (dead letters).
DROP POLICY IF EXISTS email_notif_select_own_or_admin ON email_notifications;
CREATE POLICY email_notif_select_own_or_admin ON email_notifications
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM org_members WHERE org_id = email_notifications.org_id AND uid = auth.uid() AND status = 'active')
    AND (to_user_id = auth.uid() OR caller_holds_any_role(org_id, ARRAY['Admin','Manager']::text[]))
  );

-- UPDATE: Admin/Manager only, and only the delivery bookkeeping (status,
-- attempt_count) — never the address or the body of a queued message.
DROP POLICY IF EXISTS email_notif_update_admin_requeue ON email_notifications;
CREATE POLICY email_notif_update_admin_requeue ON email_notifications
  FOR UPDATE TO authenticated
  USING (caller_holds_any_role(org_id, ARRAY['Admin','Manager']::text[]))
  WITH CHECK (caller_holds_any_role(org_id, ARRAY['Admin','Manager']::text[]));

CREATE OR REPLACE FUNCTION enforce_email_requeue_columns()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - 'status' - 'attempt_count' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'attempt_count' - 'updated_at') THEN
    RAISE EXCEPTION 'A queued message can be re-queued or cancelled, never rewritten.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_email_requeue_columns ON email_notifications;
CREATE TRIGGER trg_email_requeue_columns
BEFORE UPDATE ON email_notifications
FOR EACH ROW EXECUTE FUNCTION enforce_email_requeue_columns();

-- ── 5. LIFE-6: a hold knows the ticket it came from ─────────────────────────
ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS origin_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS document_holds_origin_ticket_open_idx
  ON document_holds(origin_ticket_id) WHERE released_at IS NULL;
COMMENT ON COLUMN document_holds.origin_ticket_id IS
  'The drafting ticket whose check-in placed this hold (DEC-25): the close gate finds it here, the hold shows it.';

COMMIT;

-- ── Verification (read-only) — expect true × 10 ─────────────────────────────
SELECT 'document_acknowledgments: INSERT may only mint a pending, unsigned row' AS check,
       (SELECT with_check LIKE '%status = ''pending''%' AND with_check LIKE '%signature_id IS NULL%'
          FROM pg_policies WHERE tablename = 'document_acknowledgments' AND policyname = 'doc_ack_insert') AS ok
UNION ALL
SELECT 'document_acknowledgments guard installed (assignee-only, signature-bound, no self-waiver)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_ack_guard' AND tgrelid = 'document_acknowledgments'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%Only the named assignee can acknowledge%' AND prosrc LIKE '%You cannot waive your own acknowledgment.%'
              FROM pg_proc WHERE proname = 'enforce_document_ack_guard')
UNION ALL
SELECT 'review sign-off guard pins reviewer_name and refuses a signature outside signing',
       (SELECT prosrc LIKE '%NEW.reviewer_name      IS DISTINCT FROM OLD.reviewer_name%'
          AND prosrc LIKE '%A signature can only be attached to a review row by signing it.%'
          FROM pg_proc WHERE proname = 'enforce_review_signoff_guard')
UNION ALL
SELECT 'can_manage_project reads project_members.role and requires an active membership',
       (SELECT prosrc LIKE '%COALESCE(pm.role, ''collaborator'') IN (''owner'', ''collaborator'')%' AND prosrc LIKE '%om.status = ''active''%'
          FROM pg_proc WHERE proname = 'can_manage_project')
UNION ALL
SELECT 'is_project_member / is_project_owner require an active membership',
       (SELECT COUNT(*) = 2 FROM pg_proc WHERE proname IN ('is_project_member', 'is_project_owner') AND prosrc LIKE '%om.status = ''active''%')
UNION ALL
SELECT 'email INSERT: same-org member address only, never external',
       (SELECT with_check LIKE '%external%' AND with_check LIKE '%lower(r.email) = lower(email_notifications.to_email)%'
          FROM pg_policies WHERE tablename = 'email_notifications' AND policyname = 'email_notif_insert')
UNION ALL
SELECT 'email SELECT (own or admin) and confined UPDATE installed',
       (SELECT COUNT(*) = 2 FROM pg_policies WHERE tablename = 'email_notifications'
          AND policyname IN ('email_notif_select_own_or_admin', 'email_notif_update_admin_requeue'))
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_email_requeue_columns' AND tgrelid = 'email_notifications'::regclass AND NOT tgisinternal)
UNION ALL
SELECT 'document_holds.origin_ticket_id exists with its partial index',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_holds' AND column_name = 'origin_ticket_id')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'document_holds' AND indexname = 'document_holds_origin_ticket_open_idx')
UNION ALL
SELECT 'every column the guards late-bind exists',
       (SELECT COUNT(*) = 14 FROM information_schema.columns c
          JOIN (VALUES
            ('document_acknowledgments','assignee_user_id'), ('document_acknowledgments','document_id'), ('document_acknowledgments','document_version_id'),
            ('document_acknowledgments','org_id'), ('document_acknowledgments','status'), ('document_acknowledgments','signature_id'), ('document_acknowledgments','acknowledged_at'),
            ('document_review_signoffs','reviewer_name'), ('document_review_signoffs','signature_id'), ('document_review_signoffs','signed_at'),
            ('email_notifications','status'), ('email_notifications','attempt_count'), ('email_notifications','to_email'), ('email_notifications','metadata')
          ) v(t, col) ON c.table_schema = 'public' AND c.table_name = v.t AND c.column_name = v.col)
UNION ALL
SELECT 'search_path pinned on the six functions',
       (SELECT COUNT(*) = 6 FROM pg_proc
         WHERE proname IN ('enforce_document_ack_guard', 'enforce_review_signoff_guard', 'can_manage_project',
                           'is_project_member', 'is_project_owner', 'enforce_email_requeue_columns')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%');

-- ── Inventory (read-only, aggregate) — run BEFORE the DDL ───────────────────
SELECT 'acknowledgment rows acknowledged without a signature (history the guard would now refuse)' AS inventory, COUNT(*)::text AS n
FROM document_acknowledgments WHERE status = 'acknowledged' AND signature_id IS NULL
UNION ALL
SELECT 'project roster rows with role observer (lose management authority)', COUNT(*)::text
FROM project_members WHERE role = 'observer'
UNION ALL
SELECT 'client-queued mail (90 days) to a non-member address and not external (the INSERT bar would have refused)', COUNT(*)::text
FROM email_notifications e
WHERE e.created_at > NOW() - INTERVAL '90 days'
  AND COALESCE(e.metadata->>'external', '') <> 'true'
  AND NOT EXISTS (SELECT 1 FROM org_members r WHERE r.org_id = e.org_id AND lower(r.email) = lower(e.to_email))
UNION ALL
SELECT 'queued mail marked external (90 days — the transmittal path, now server-side)', COUNT(*)::text
FROM email_notifications WHERE created_at > NOW() - INTERVAL '90 days' AND COALESCE(metadata->>'external', '') = 'true'
UNION ALL
SELECT 'open holds with reason Field Verification Needed (unlinked until their next check-in)', COUNT(*)::text
FROM document_holds WHERE released_at IS NULL AND reason = 'Field Verification Needed';
