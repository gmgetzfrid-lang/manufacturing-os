-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 3 — P24 TRANSMITTAL ISSUE VERDICT (TRX-17):
-- the database requires a server-recorded stamp verdict, or the issuer's
-- recorded yes, for every file a transmittal issues.
--
-- DEC-61 §5 as amended (ratified DEC-90 A5): a PDF the portal cannot stamp
-- goes out unstamped only on the issuer's recorded yes. Until this file the
-- issue-time check (/api/transmittal/stamp-check, TRX-16), the arming mark
-- (`stampable: true`, P22) and the issuer's yes were all browser-written, and
-- the issue trigger (20261133) accepted a draft → issued UPDATE without them:
-- a direct PATCH ({ status: 'issued' }) or a modified client issued every PDF
-- unchecked, unarmed and with no yes recorded.
--
--   1. transmittals.stamp_check (JSONB) — the server's record of the last
--      issue-time check of a DRAFT: { draftUpdatedAt, checkedAt, checkedBy,
--      items: [{ documentId, versionId, verdict, detail? }] }. Written by the
--      stamp-check route only (service role), and only on the draft row as
--      it read it (an updated_at match). A member session never writes it
--      (the guard refuses), a member INSERT starts it empty, and once issued
--      it is frozen with the record.
--   2. transmittals_guard() re-created from its NEWEST definition (20261133 —
--      no later migration re-creates it), every line of that body kept
--      verbatim (lib/__tests__/dcRoundFTransmittalIssueVerdict.test.ts proves
--      it line by line), with four additions:
--        · the member-session refusal and the INSERT reset above;
--        · on the draft → issued transition, the check counts only when its
--          draftUpdatedAt IS the draft row's updated_at (the draft as
--          issued), and each item's verdict only when it names the very
--          version the issue pins;
--        · each item needs a decided verdict — `stampable` or `not_pdf` — or
--          the issuer's yes (`stampAccepted: true` on the item); otherwise
--          the issue is REFUSED, naming the item (check_violation);
--        · the snapshot records the server's verdict on each item
--          (`stampVerdict`; 'none' when no check was recorded), sets the
--          portal's arming mark `stampable: true` from the SERVER verdict
--          alone (a browser-written mark is dropped), and stamps a yes with
--          who gave it and when (`stampAcceptedBy`, `stampAcceptedAt`).
--      Invoker rights and search_path = public as before; no SECURITY
--      DEFINER is created (DRLS-16 has nothing to pin here). The trigger
--      itself (trg_transmittals_guard, BEFORE INSERT OR UPDATE OR DELETE) is
--      unchanged.
--
-- NARROWS: a draft → issued UPDATE that carries neither a recorded check nor
-- a yes is refused. Nothing already issued is touched (the inventory counts
-- them).
--
-- ⚠ DEPLOY ORDER: deploy the app carrying P24 FIRST, then paste this file.
--   * New app, this file not pasted: the stamp-check route's write meets the
--     missing column (PGRST204 / 42703) and answers the check exactly as
--     before; the issue flow asks for the issuer's yes on an undecided file
--     and writes it on the item (the 20261133 trigger keeps the key as item
--     JSON). Issuing works as today.
--   * Both: every issue from the register records its check, and the
--     database requires it (or the yes).
--   * Pasted BEFORE the app deploys: the old app's route records no check
--     and its issue writes no yes, so EVERY issue from the register is
--     refused with the TRX-17 sentence until the app deploys (fail closed —
--     nothing leaves unchecked). Keep that window at zero.
--
-- DEC-30: the inventory (aggregate counts only) is captured BEFORE the
-- transaction and returned with the probes in ONE result set.
-- APPLY AFTER 20261133 (the guard's base; the first statement inside the
-- transaction checks it and RAISES, rolling the file back).
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS dc_round_f_199_before;
CREATE TEMP TABLE dc_round_f_199_before AS
WITH live AS (
  SELECT t.items FROM transmittals t WHERE t.status IN ('issued', 'acknowledged')
), live_items AS (
  SELECT it FROM live l,
         jsonb_array_elements(CASE WHEN jsonb_typeof(l.items) = 'array' THEN l.items ELSE '[]'::jsonb END) it
), draft_items AS (
  SELECT it FROM transmittals t,
         jsonb_array_elements(CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]'::jsonb END) it
   WHERE t.status = 'draft'
)
SELECT 'BEFORE (TRX-17): issued / acknowledged transmittals — none carries a server-recorded stamp verdict (issued before this file; unchanged)' AS inventory,
       (SELECT COUNT(*) FROM live)::text AS n
UNION ALL
SELECT 'BEFORE (TRX-17): items on them armed by the browser mark (stampable = true, P22) — the portal keeps refusing such a PDF if it cannot be stamped (unchanged)',
       (SELECT COUNT(*) FROM live_items WHERE it->>'stampable' = 'true')::text
UNION ALL
SELECT 'BEFORE (TRX-17): items on them with no mark — a PDF among them still leaves unstamped under DEC-61 §5 if the portal cannot stamp it (unchanged; issued before the rule)',
       (SELECT COUNT(*) FROM live_items WHERE it->>'stampable' IS DISTINCT FROM 'true')::text
UNION ALL
SELECT 'BEFORE (TRX-17): drafts — from now on each issues only with a stamp check the server recorded for the draft as issued, or the issuer''s recorded yes per file',
       (SELECT COUNT(*) FROM transmittals WHERE status = 'draft')::text
UNION ALL
SELECT 'BEFORE (TRX-17): items on those drafts',
       (SELECT COUNT(*) FROM draft_items)::text;

BEGIN;

-- ── 0. Apply order: 20261133 must already be live ───────────────────────────
-- This file re-creates the 20261133 guard; over an older one it would apply
-- the snapshot rules without the rails they rest on. Refuse instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'transmittals_guard' AND pronargs = 0
       AND prosrc LIKE '%''statusAsSent'', v_status%'
  ) THEN
    RAISE EXCEPTION 'Apply 20261133_dc_roundF_transmittal_rails.sql first: this file re-creates its transmittals guard. Nothing was changed.';
  END IF;
END $$;

-- ── 1. TRX-17: the server's record of the issue-time stamp check ────────────
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS stamp_check JSONB;
COMMENT ON COLUMN transmittals.stamp_check IS
  'TRX-17: the server''s record of the last issue-time stamp check of this draft ({ draftUpdatedAt, checkedAt, checkedBy, items: [{ documentId, versionId, verdict, detail }] }), written by /api/transmittal/stamp-check (service role) only. The issue counts it only when draftUpdatedAt is the draft''s updated_at; frozen once issued.';

-- ── 2. TRX-17: the guard, re-created from 20261133 with the verdict rule ────
CREATE OR REPLACE FUNCTION transmittals_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  it JSONB;
  v_doc uuid;
  v_ver uuid;
  -- 20261133 (TRX-1 / TRX-2 / TRX-3 / TRX-4 / TRX-6 / TRX-8 / TRX-12):
  v_uid uuid := auth.uid();
  v_issue boolean := false;
  v_items JSONB;
  v_lib uuid;
  v_status text;
  v_archived timestamptz;
  v_current uuid;
  v_record uuid;
  v_label text;
  v_hash text;
  v_eff date;
  v_branch boolean;
  v_review text;
  v_key text;
  v_shed timestamptz;
  v_doc_rev text;
  v_cur_label text;
  v_size bigint;
  v_superseded timestamptz;
  -- 20261199 (TRX-17):
  v_check_ok boolean := false;
  v_verdict text;
  v_accepted boolean;
BEGIN
  -- ── TRX-2: an issued transmittal never leaves the register ───────────────
  -- Only a draft is deleted — for EVERY caller, the service role included
  -- (20260826's rule for held records). The one pass is an FK cascade from
  -- deleting the workspace itself: the org row is already gone in this
  -- snapshot, so the org's own delete decided.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IS DISTINCT FROM 'draft'
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id) THEN
      RAISE EXCEPTION 'Transmittal % was issued — it stays on the register (void it instead). Only a draft can be deleted. (TRX-2, 20261133)', OLD.number
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  v_issue := NEW.status = 'issued'
             AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'issued');

  IF TG_OP = 'INSERT' THEN
    -- ── TRX-1: a member session creates a DRAFT ─────────────────────────────
    -- Issuing is an UPDATE this trigger authorizes; the server-owned columns
    -- start empty whatever the client sent. (The service role — a restore —
    -- keeps its rows as written: a restored issued row arrives voided, DEC-45.)
    IF v_uid IS NOT NULL THEN
      IF NEW.status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'A transmittal is created as a draft and issued from the register — it cannot be born %. (TRX-1, 20261133)', NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.portal_token := NULL;
      NEW.issued_at := NULL;
      NEW.acknowledged_at := NULL;
      NEW.acknowledged_by_name := NULL;
      NEW.acknowledged_via := NULL;
      NEW.acknowledged_meta := NULL;
      NEW.portal_expires_at := NULL;
      NEW.portal_revoked_at := NULL;
      NEW.portal_revoked_by := NULL;
      NEW.portal_last_used_at := NULL;
      NEW.portal_open_count := 0;
      NEW.portal_download_count := 0;
      NEW.stamp_check := NULL;
    ELSIF NEW.status = 'issued' THEN
      -- ── DEC-45: a service-role INSERT born issued is a restore ──────────
      -- (no app path inserts with the service role). Its backup predates the
      -- portal_token column, so the restore's scrub could not void it: it
      -- lands voided here instead — the register keeps the record and its
      -- issue date, no live link is minted, and the issue gate is not run
      -- (it would re-date the record, or abort the whole restore on a
      -- document the backup lists as withdrawn).
      NEW.status := 'voided';
      NEW.portal_token := NULL;
      NEW.notes := concat_ws(E'\n\n', NULLIF(btrim(COALESCE(NEW.notes, '')), ''),
        'Restored from a backup: the portal link was not restored (DEC-45). Issue a new transmittal to send these documents again.');
      v_issue := false;
    END IF;
  ELSE
    -- ── TRX-6: identity is fixed at creation ────────────────────────────────
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.seq IS DISTINCT FROM OLD.seq
       OR NEW.number IS DISTINCT FROM OLD.number OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'A transmittal''s workspace, number and author are fixed when it is created. (TRX-6, 20261133)'
        USING ERRCODE = 'check_violation';
    END IF;

    -- ── TRX-2 / TRX-6: the lifecycle runs one way ───────────────────────────
    -- draft → issued → acknowledged, and issued / acknowledged → voided.
    -- Nothing comes back from voided, nothing returns to draft, and a draft
    -- is deleted rather than voided.
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status = 'issued')
      OR (OLD.status = 'issued' AND NEW.status IN ('acknowledged', 'voided'))
      OR (OLD.status = 'acknowledged' AND NEW.status = 'voided')) THEN
      RAISE EXCEPTION 'A transmittal cannot move from % to %. (TRX-2 / TRX-6, 20261133)', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    -- ── TRX-6: once issued, the record is the record ───────────────────────
    -- The documents, the recipient, the purpose, the issue time and the
    -- portal link are what was sent. Unlinking it from a project is allowed
    -- only as the FK's own ON DELETE SET NULL (one trigger level down) or by
    -- the service role (the project purge).
    IF OLD.status <> 'draft' AND (
         NEW.items IS DISTINCT FROM OLD.items
      OR NEW.recipient_name IS DISTINCT FROM OLD.recipient_name
      OR NEW.recipient_company IS DISTINCT FROM OLD.recipient_company
      OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.subject IS DISTINCT FROM OLD.subject
      OR NEW.notes IS DISTINCT FROM OLD.notes
      OR NEW.created_by_name IS DISTINCT FROM OLD.created_by_name
      OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
      OR NEW.portal_token IS DISTINCT FROM OLD.portal_token
      OR NEW.portal_expires_at IS DISTINCT FROM OLD.portal_expires_at
      OR (NEW.project_id IS DISTINCT FROM OLD.project_id
          AND NOT (NEW.project_id IS NULL AND (pg_trigger_depth() > 1 OR v_uid IS NULL)))) THEN
      RAISE EXCEPTION 'Transmittal % has been issued — its documents, recipient, purpose and portal link are the record and cannot be edited. Void it and issue a new one. (TRX-6, 20261133)', OLD.number
        USING ERRCODE = 'check_violation';
    END IF;

    -- ── TRX-17 (20261199): the stamp check an issue relied on is frozen with it
    IF OLD.status <> 'draft' AND NEW.stamp_check IS DISTINCT FROM OLD.stamp_check THEN
      RAISE EXCEPTION 'Transmittal % has been issued — the stamp check it was issued on is part of the record. (TRX-17, 20261199)', OLD.number
        USING ERRCODE = 'check_violation';
    END IF;

    -- ── TRX-6: the receipt is written once, server-side ─────────────────────
    -- acknowledged_* change only on the issued → acknowledged transition, and
    -- only from a service-role path (the recipient portal, or the register's
    -- receipt route, which checks transmit authority and names the recorder).
    IF (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
        OR NEW.acknowledged_by_name IS DISTINCT FROM OLD.acknowledged_by_name
        OR NEW.acknowledged_via IS DISTINCT FROM OLD.acknowledged_via
        OR NEW.acknowledged_meta IS DISTINCT FROM OLD.acknowledged_meta)
       AND NOT (OLD.status = 'issued' AND NEW.status = 'acknowledged') THEN
      RAISE EXCEPTION 'A transmittal''s receipt is recorded once and never edited. (TRX-6, 20261133)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'issued' AND NEW.status = 'acknowledged' THEN
      IF v_uid IS NOT NULL THEN
        RAISE EXCEPTION 'A receipt is recorded by the recipient portal, or on the register through the receipt route — never by a member session. (TRX-6, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.acknowledged_at IS NULL THEN
        RAISE EXCEPTION 'An acknowledgment records when it happened. (TRX-6, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- ── TRX-4: revoking the portal link is durable ─────────────────────────
    -- Revocation cuts the link without repudiating the record. It is set
    -- once, on a live link of an issued transmittal, stamped with the
    -- database's clock and the caller; it never clears or moves.
    IF NEW.portal_revoked_at IS DISTINCT FROM OLD.portal_revoked_at
       OR NEW.portal_revoked_by IS DISTINCT FROM OLD.portal_revoked_by THEN
      IF OLD.portal_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'This portal link was revoked on % — a revocation never clears or moves. (TRX-4, 20261133)', OLD.portal_revoked_at
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.portal_revoked_at IS NULL OR OLD.status NOT IN ('issued', 'acknowledged') OR OLD.portal_token IS NULL THEN
        RAISE EXCEPTION 'Only the live portal link of an issued transmittal can be revoked. (TRX-4, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.portal_revoked_at := now();
      NEW.portal_revoked_by := COALESCE(v_uid, NEW.portal_revoked_by);
    END IF;

    IF v_uid IS NOT NULL THEN
      -- ── TRX-4: the usage trail is the portal's, not a member's ──────────
      IF NEW.portal_last_used_at IS DISTINCT FROM OLD.portal_last_used_at
         OR NEW.portal_open_count IS DISTINCT FROM OLD.portal_open_count
         OR NEW.portal_download_count IS DISTINCT FROM OLD.portal_download_count THEN
        RAISE EXCEPTION 'The portal usage trail is written by the portal, not by a member session. (TRX-4, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;

      -- ── TRX-17 (20261199): the stamp check is the server's record ───────
      -- /api/transmittal/stamp-check writes it (service role) for the draft
      -- it checked; a member session never writes, moves or clears it.
      IF NEW.stamp_check IS DISTINCT FROM OLD.stamp_check THEN
        RAISE EXCEPTION 'The issue-time stamp check is recorded by the server, not by a member session. (TRX-17, 20261199)'
          USING ERRCODE = 'check_violation';
      END IF;

      -- ── TRX-1: issuing, voiding and revoking are transmit authority ─────
      -- The capability policy decides (transmittal.issue), once per item's
      -- LIBRARY (DEC-13: a library rule replaces the base list for that
      -- library); an item whose document is gone — and a transmittal with no
      -- items — is judged on the base list. Drafting stays open to members.
      IF (OLD.status = 'draft' AND NEW.status = 'issued')
         OR (NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided')
         OR NEW.portal_revoked_at IS DISTINCT FROM OLD.portal_revoked_at THEN
        IF NEW.items IS NULL OR jsonb_typeof(NEW.items) <> 'array' OR jsonb_array_length(NEW.items) = 0 THEN
          IF NOT org_capability_allows_for(NEW.org_id, 'transmittal.issue', v_uid, '{}'::jsonb) THEN
            RAISE EXCEPTION 'Only a transmit authority (the "Issue transmittals" capability) can issue, void or revoke transmittal %. (TRX-1, 20261133)', NEW.number
              USING ERRCODE = 'insufficient_privilege';
          END IF;
        ELSE
          FOR it IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
            v_lib := NULL;
            SELECT d.library_id INTO v_lib FROM documents d
             WHERE d.id = NULLIF(it->>'documentId', '')::uuid AND d.org_id = NEW.org_id;
            IF NOT org_capability_allows_for(NEW.org_id, 'transmittal.issue', v_uid,
                 CASE WHEN v_lib IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('libraryId', v_lib::text) END) THEN
              RAISE EXCEPTION 'You do not hold transmit authority (the "Issue transmittals" capability) for % — only a transmit authority for every document on it can issue, void or revoke transmittal %. (TRX-1, 20261133)', COALESCE(it->>'number', it->>'documentId'), NEW.number
                USING ERRCODE = 'insufficient_privilege';
            END IF;
          END LOOP;
        END IF;
      END IF;
    END IF;
  END IF;

  -- ── TRX-3 / TRX-8 / TRX-12: the issue gate, and the as-sent snapshot ─────
  -- On the issue transition every item must name a current, unheld document
  -- of this workspace and that document's CURRENT revision — published, not
  -- superseded, with a stored file. An unpinned item is pinned here — to the
  -- current revision, and only when that is the revision the item names; a
  -- pinned item must still BE the current revision (status truth: the
  -- document's status is written as the status of what was sent). The
  -- database then writes what was sent onto the item (the version, its file
  -- hash and size, the document's status and the revision's effective date),
  -- stamps the issue time with its own clock and gives the portal link its
  -- lifetime.
  IF v_issue THEN
    IF NEW.items IS NULL OR jsonb_typeof(NEW.items) <> 'array' OR jsonb_array_length(NEW.items) = 0 THEN
      RAISE EXCEPTION 'A transmittal needs at least one document to be issued. (TRX-3, 20261133)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NULLIF(btrim(COALESCE(NEW.recipient_name, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(NEW.recipient_company, '')), '') IS NULL THEN
      RAISE EXCEPTION 'A transmittal needs a recipient (a name or a company) to be issued. (TRX-3, 20261133)'
        USING ERRCODE = 'check_violation';
    END IF;
    v_items := '[]'::jsonb;
    -- ── TRX-17 (20261199): the server's stamp check, for the draft as issued ─
    -- The check counts only when it was recorded on the draft row as it
    -- stands now (its updated_at): a draft saved after the check is not
    -- what was checked.
    v_check_ok := false;
    IF TG_OP = 'UPDATE' AND jsonb_typeof(NEW.stamp_check) = 'object' AND jsonb_typeof(NEW.stamp_check->'items') = 'array' THEN
      BEGIN
        v_check_ok := COALESCE((NEW.stamp_check->>'draftUpdatedAt')::timestamptz = OLD.updated_at, false);
      EXCEPTION WHEN others THEN
        v_check_ok := false;
      END;
    END IF;
    FOR it IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
      v_doc := NULLIF(it->>'documentId', '')::uuid;
      IF v_doc IS NULL THEN
        RAISE EXCEPTION 'Every item on a transmittal must name a document. (TRX-3, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;
      v_status := NULL; v_archived := NULL; v_current := NULL; v_doc_rev := NULL; v_cur_label := NULL;
      SELECT d.status, d.archived_at, d.current_version_id, d.rev
        INTO v_status, v_archived, v_current, v_doc_rev
        FROM documents d WHERE d.id = v_doc AND d.org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'transmittal item names a document outside this workspace';
      END IF;
      IF v_archived IS NOT NULL OR v_status IN ('Superseded', 'Void', 'Archived') THEN
        RAISE EXCEPTION '% is withdrawn (%) and cannot be issued on a transmittal. (TRX-3, 20261133)', COALESCE(it->>'number', v_doc::text), COALESCE(CASE WHEN v_archived IS NOT NULL THEN 'archived' END, v_status)
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = v_doc AND h.released_at IS NULL) THEN
        RAISE EXCEPTION '% is under an active hold — release the hold before issuing it on a transmittal. (HLD-1 / TRX-3, 20261133)', COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT v.revision_label INTO v_cur_label FROM document_versions v
       WHERE v.id = v_current AND v.org_id = NEW.org_id;
      IF v_current IS NULL OR v_cur_label IS NULL THEN
        RAISE EXCEPTION '% has no published file to send. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      -- Status truth: a pin to an older revision (added before a rev-up) is
      -- refused, naming the revision that replaced it.
      v_ver := NULLIF(it->>'versionId', '')::uuid;
      IF v_ver IS NOT NULL AND v_ver IS DISTINCT FROM v_current THEN
        RAISE EXCEPTION '% Rev % has been superseded by Rev % — remove % and add it again to send the current revision. (TRX-3 / TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), COALESCE(NULLIF(btrim(COALESCE(it->>'rev', '')), ''), '?'), btrim(v_cur_label), COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      -- A Rev that is not the current file's label: either the document's own
      -- Rev field drifted from its file (re-adding cannot help — correct the
      -- document), or the item is stale (re-add it).
      IF NULLIF(btrim(COALESCE(it->>'rev', '')), '') IS NOT NULL AND btrim(v_cur_label) IS DISTINCT FROM btrim(it->>'rev') THEN
        IF btrim(COALESCE(v_doc_rev, '')) = btrim(it->>'rev') THEN
          RAISE EXCEPTION '%: the document''s Rev field (%) does not match its current file (Rev %) — correct the document''s revision, then issue. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), btrim(v_doc_rev), btrim(v_cur_label)
            USING ERRCODE = 'check_violation';
        END IF;
        RAISE EXCEPTION '% is listed at Rev %, but its current file is Rev % — remove % and add it again. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), btrim(it->>'rev'), btrim(v_cur_label), COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      v_ver := v_current;
      v_record := NULL; v_label := NULL; v_hash := NULL; v_eff := NULL;
      v_branch := NULL; v_review := NULL; v_key := NULL; v_shed := NULL;
      v_size := NULL; v_superseded := NULL;
      SELECT v.record_id, v.revision_label, v.file_hash, v.effective_date, v.is_branch, v.review_state, v.file_url, v.archived_at, v.size, v.superseded_at
        INTO v_record, v_label, v_hash, v_eff, v_branch, v_review, v_key, v_shed, v_size, v_superseded
        FROM document_versions v WHERE v.id = v_ver AND v.org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'transmittal item names a version outside this workspace';
      END IF;
      IF v_record IS DISTINCT FROM v_doc THEN
        RAISE EXCEPTION 'The revision pinned for % belongs to another document. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      IF COALESCE(v_branch, false) OR v_review IN ('in_review', 'rejected') THEN
        RAISE EXCEPTION '% Rev % is not a published revision (an unreconciled branch or an unreviewed submission). (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), v_label
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_superseded IS NOT NULL THEN
        RAISE EXCEPTION '% Rev % is marked superseded (%) and cannot be issued. (TRX-3, 20261133)', COALESCE(it->>'number', v_doc::text), v_label, v_superseded
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_key IS NULL OR v_shed IS NOT NULL THEN
        RAISE EXCEPTION '% Rev % has no stored file to send. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), v_label
          USING ERRCODE = 'check_violation';
      END IF;
      -- ── TRX-17 (20261199): a server verdict for the file issued, or a yes ─
      -- A PDF goes out only with a server-recorded verdict for the very file
      -- being issued (the version pinned above) — stampable (the mark below
      -- arms the portal's refusal) or not a PDF — or with the issuer's yes to
      -- it leaving without the UNCONTROLLED marking (`stampAccepted` on the
      -- item), recorded here with who and when. Without either the issue is
      -- refused: a PATCH that skips the register's check cannot issue. The
      -- mark is the server's alone; a browser-written one is not kept.
      v_verdict := NULL;
      IF v_check_ok THEN
        SELECT c->>'verdict' INTO v_verdict
          FROM jsonb_array_elements(NEW.stamp_check->'items') c
         WHERE c->>'documentId' = v_doc::text AND c->>'versionId' = v_ver::text
         LIMIT 1;
      END IF;
      v_accepted := COALESCE(it->>'stampAccepted', '') = 'true';
      IF v_verdict IS DISTINCT FROM 'stampable' AND v_verdict IS DISTINCT FROM 'not_pdf' AND NOT v_accepted THEN
        IF v_verdict IS NULL THEN
          RAISE EXCEPTION '% was not issued: no stamp check is recorded for its file as issued (Rev %), and no yes is recorded for it leaving the portal without the UNCONTROLLED marking. Issue it from the register — it checks each file and asks. (TRX-17, 20261199)', COALESCE(it->>'number', v_doc::text), v_label
            USING ERRCODE = 'check_violation';
        END IF;
        RAISE EXCEPTION '% was not issued: the stamp check answered % for its file, so the portal may release it without the UNCONTROLLED marking, and no yes is recorded for that. Issue it from the register — it asks. (TRX-17, 20261199)', COALESCE(it->>'number', v_doc::text), v_verdict
          USING ERRCODE = 'check_violation';
      END IF;
      it := (it - 'stampable' - 'stampAccepted' - 'stampAcceptedBy' - 'stampAcceptedAt' - 'stampVerdict')
            || jsonb_build_object('stampVerdict', COALESCE(v_verdict, 'none'))
            || CASE WHEN v_verdict = 'stampable' THEN jsonb_build_object('stampable', true) ELSE '{}'::jsonb END
            || CASE WHEN v_verdict IS DISTINCT FROM 'stampable' AND v_verdict IS DISTINCT FROM 'not_pdf'
                    THEN jsonb_build_object('stampAccepted', true, 'stampAcceptedBy', v_uid, 'stampAcceptedAt', now())
                    ELSE '{}'::jsonb END;
      v_items := v_items || jsonb_build_array(
        it || jsonb_build_object(
          'versionId', v_ver::text,
          'rev', COALESCE(NULLIF(btrim(COALESCE(it->>'rev', '')), ''), btrim(v_label)),
          'fileHash', v_hash,
          'fileSize', v_size,
          'statusAsSent', v_status,
          'effectiveDate', v_eff));
    END LOOP;
    NEW.items := v_items;
    NEW.issued_at := now();
    NEW.portal_expires_at := now() + interval '90 days';
  END IF;

  -- A write that leaves the items as they were (a draft's other fields, a
  -- void, a revocation, a receipt, the usage trail, a project unlink) has
  -- nothing for the item rail below to re-check: issued items are frozen
  -- above, and a draft's were checked when written. Re-reading them would
  -- refuse every later write once a listed document is deleted — the very
  -- case the snapshot exists to survive.
  IF TG_OP = 'UPDATE' AND NOT v_issue AND NEW.items IS NOT DISTINCT FROM OLD.items THEN
    RETURN NEW;
  END IF;

  -- Every item that names a document or a version must name one in THIS
  -- transmittal's org. `items` is browser-written JSONB, so this is the rail
  -- behind the portal's read-time org scope: a forged cross-org id can never
  -- be persisted, in draft or issued state.
  IF NEW.items IS NOT NULL AND jsonb_typeof(NEW.items) = 'array' THEN
    FOR it IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
      v_doc := NULLIF(it->>'documentId', '')::uuid;
      v_ver := NULLIF(it->>'versionId', '')::uuid;
      IF v_doc IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.id = v_doc AND d.org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'transmittal item names a document outside this workspace';
      END IF;
      IF v_ver IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM document_versions v WHERE v.id = v_ver AND v.org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'transmittal item names a version outside this workspace';
      END IF;
    END LOOP;
  END IF;

  -- Server-mint the portal token on the ISSUE TRANSITION, overriding whatever
  -- the client sent — so the creator cannot pre-choose (or pre-know via a
  -- predictable value) a token for a row they were not permitted to issue
  -- (EGR-1 done-when 4). Only on the transition: an already-issued transmittal
  -- keeps its live token so re-saves never invalidate the recipient's link.
  IF NEW.status = 'issued'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'issued') THEN
    NEW.portal_token := replace(gen_random_uuid()::text, '-', '')
                        || replace(gen_random_uuid()::text, '-', '');
  END IF;

  RETURN NEW;
END;
$$;
COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 5 ─────────
SELECT 'transmittals.stamp_check exists (jsonb) — the server''s record of the issue-time check (TRX-17)' AS check,
       (SELECT COUNT(*) = 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transmittals'
           AND column_name = 'stamp_check' AND data_type = 'jsonb') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'transmittals_guard requires a server verdict for the file issued, or a recorded yes, and refuses a member''s write of the check (TRX-17)',
       (SELECT prosrc LIKE '%(NEW.stamp_check->>''draftUpdatedAt'')::timestamptz = OLD.updated_at%'
              AND prosrc LIKE '%WHERE c->>''documentId'' = v_doc::text AND c->>''versionId'' = v_ver::text%'
              AND prosrc LIKE '%v_accepted := COALESCE(it->>''stampAccepted'', '''') = ''true'';%'
              AND prosrc LIKE '%jsonb_build_object(''stampAccepted'', true, ''stampAcceptedBy'', v_uid, ''stampAcceptedAt'', now())%'
              AND prosrc LIKE '%The issue-time stamp check is recorded by the server, not by a member session. (TRX-17, 20261199)%'
              AND prosrc LIKE '%NEW.stamp_check := NULL;%'
          FROM pg_proc WHERE proname = 'transmittals_guard' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'transmittals_guard keeps every 20261133 rule (authority per library, hold gate, current-revision pin, snapshot with size, restore arm, delete arm, item rail, token mint)',
       (SELECT prosrc LIKE '%org_capability_allows_for(NEW.org_id, ''transmittal.issue'', v_uid%'
              AND prosrc LIKE '%FROM document_holds h WHERE h.document_id = v_doc AND h.released_at IS NULL%'
              AND prosrc LIKE '%''fileHash'', v_hash%'
              AND prosrc LIKE '%''fileSize'', v_size%'
              AND prosrc LIKE '%IF v_ver IS NOT NULL AND v_ver IS DISTINCT FROM v_current THEN%'
              AND prosrc LIKE '%Restored from a backup: the portal link was not restored (DEC-45)%'
              AND prosrc LIKE '%''statusAsSent'', v_status%'
              AND prosrc LIKE '%IF TG_OP = ''DELETE'' THEN%'
              AND prosrc LIKE '%NEW.portal_expires_at := now() + interval ''90 days''%'
              AND prosrc LIKE '%transmittal item names a document outside this workspace%'
              AND prosrc LIKE '%NEW.portal_token := replace(gen_random_uuid()::text, ''-'', '''')%'
          FROM pg_proc WHERE proname = 'transmittals_guard' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'transmittals_guard is invoker-rights with search_path pinned (no SECURITY DEFINER created)',
       (SELECT NOT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'transmittals_guard' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'trg_transmittals_guard is still the ONE trigger on transmittals, BEFORE INSERT, UPDATE and DELETE',
       (SELECT COUNT(*) = 1 AND bool_and((tgtype & 2) = 2 AND (tgtype & 4) = 4 AND (tgtype & 8) = 8 AND (tgtype & 16) = 16 AND tgname = 'trg_transmittals_guard')
          FROM pg_trigger WHERE tgrelid = 'transmittals'::regclass AND NOT tgisinternal),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_199_before
UNION ALL
SELECT 'AFTER (TRX-17): drafts carrying a server-recorded stamp check (expect 0 on apply — the next issue from the register records one)', NULL::boolean, COUNT(*)::text
  FROM transmittals WHERE status = 'draft' AND stamp_check IS NOT NULL;
