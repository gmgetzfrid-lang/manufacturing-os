-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 2 — P7 TRANSMITTALS (2 of 2): the transmittal
-- rails. APPLY AFTER 20261132 (this file's trigger asks the evaluator for
-- 'transmittal.issue'; without 20261132 the evaluator answers '[]' and nobody
-- could issue). The first statement inside the transaction checks it and
-- RAISES — rolling the whole file back — when 20261132 is not live.
--
--   TRX-1  A member session INSERTs a DRAFT only (transmittals_insert:
--          status = 'draft' AND portal_token IS NULL), so issuing is always
--          an UPDATE — and the draft → issued transition, voiding and
--          revoking the portal link need transmit authority: the
--          transmittal.issue capability (20261132), evaluated once per item's
--          LIBRARY (DEC-13). Drafting stays open to every active member.
--   TRX-2  An issued, acknowledged or voided transmittal is never deleted —
--          for every caller, the service role included (a BEFORE DELETE arm of
--          the same trigger; the only pass is the FK cascade of deleting the
--          workspace itself). The permissive DELETE policy is narrowed to
--          drafts, and the lifecycle runs one way (a draft is deleted, never
--          voided; nothing comes back from voided).
--   TRX-6  The UPDATE / DELETE `created_by` arms require an ACTIVE membership
--          of the transmittal's org (matching INSERT). Once issued, the
--          record's content (items, recipient, purpose, notes, issue time,
--          portal token and expiry) is immutable; workspace, number and
--          author never change; the receipt (acknowledged_*) is written once,
--          on the issued → acknowledged transition, by a service-role path
--          only (the recipient portal, or the register's receipt route which
--          checks transmit authority and records who recorded it).
--   TRX-3  The issue transition refuses an item whose document is withdrawn
--          (Superseded / Void / Archived, or archived), is under an active
--          document hold (HLD-1 — the shared hold gate's rule), or is not in
--          this workspace — and an item pinned to a revision that is no
--          longer the document's CURRENT one (it was added before a rev-up):
--          what goes out is the current revision, so the status written as
--          sent is the status of the revision actually sent.
--   TRX-8  At issue the database writes the as-sent snapshot onto each item:
--   TRX-12 the pinned version (an unpinned item is pinned to the current
--          revision, only when that IS the revision it names), the version's
--          file hash and size, the document's status and the revision's
--          effective date — the CURRENT, published revision of THAT document,
--          with a stored file, never a branch, an unreviewed submission or a
--          superseded revision. The browser cannot author the snapshot; the
--          issue time is the database's clock. A Rev mismatch names its cause
--          (the document's own Rev field drifted from its file, or the item
--          is stale).
--   DEC-45 A service-role INSERT born 'issued' is a restore from a backup
--          that predates the portal token column: it lands VOIDED with the
--          DEC-45 note, keeps its recorded issue date, mints no token and
--          skips the issue gate (which would re-date it, give it a live link
--          nobody chose to issue, or abort the restore on a document the
--          backup lists as withdrawn).
--   TRX-4  The portal link gets its own lifecycle, separate from the record:
--          portal_expires_at (issue + 90 days, set on the issue transition),
--          portal_revoked_at / portal_revoked_by (revoke without voiding;
--          durable — never cleared or moved), and a usage trail
--          (portal_last_used_at, portal_open_count, portal_download_count)
--          bumped by the portal route through bump_transmittal_portal_use
--          (service role only). Links issued before this file carry no expiry
--          and keep serving until revoked or voided (counted below).
--
-- ONE trigger, not two: transmittals_guard is re-created from its newest
-- definition (20261027 — no later migration re-creates it) with every line of
-- that body kept verbatim and contiguous (a shape test proves it line by
-- line), and trg_transmittals_guard now fires BEFORE INSERT OR UPDATE OR
-- DELETE. The 20261027 item rail is skipped only for an UPDATE that leaves
-- the items untouched and is not the issue transition: issued items are
-- frozen, a draft's were checked when written, and re-reading them would
-- refuse every void / revocation / receipt once a listed document is deleted
-- (the case the snapshot exists to survive).
--
-- NARROWS for members on apply. The UPDATE policy's new
-- org_capability_allows arm admits nobody new while no org stores a
-- transmittal.issue entry (its default is the controller pair the policy
-- already admits) — the inventory counts both.
--
-- DEC-30: the inventory (aggregate counts only) is captured BEFORE the
-- transaction — the issued transmittals with unpinned items (the portal's
-- label-fallback population, split by what the new fallback rule does with
-- each item), the issued and draft rows whose creator is no longer an active
-- member, the drafts pinned to a revision that is no longer current, the
-- live links that carry no expiry — and returned with the probes in ONE
-- result set.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS dc_round_f_133_before;
CREATE TEMP TABLE dc_round_f_133_before AS
WITH live AS (
  SELECT t.id, t.org_id, t.created_by, t.items, COALESCE(t.issued_at, t.created_at) AS issued_at
    FROM transmittals t
   WHERE t.status IN ('issued', 'acknowledged')
), unpinned AS (
  SELECT l.id AS transmittal_id, l.org_id, l.issued_at,
         NULLIF(it->>'documentId', '') AS doc,
         NULLIF(btrim(COALESCE(it->>'rev', '')), '') AS rev
    FROM live l,
         jsonb_array_elements(CASE WHEN jsonb_typeof(l.items) = 'array' THEN l.items ELSE '[]'::jsonb END) it
   WHERE NULLIF(COALESCE(it->>'versionId', it->>'version_id', ''), '') IS NULL
), cand AS (
  SELECT u.transmittal_id,
         (SELECT COUNT(*) FROM document_versions v
           WHERE u.doc IS NOT NULL AND u.rev IS NOT NULL
             AND v.record_id::text = u.doc AND v.org_id = u.org_id
             AND btrim(v.revision_label) = u.rev
             AND NOT COALESCE(v.is_branch, false)
             AND (v.review_state IS NULL OR v.review_state = 'approved')
             AND v.created_at <= u.issued_at) AS n
    FROM unpinned u
)
SELECT 'BEFORE (TRX-12): issued / acknowledged transmittals carrying an unpinned item (the portal label-fallback population)' AS inventory,
       (SELECT COUNT(DISTINCT transmittal_id) FROM unpinned)::text AS n
UNION ALL
SELECT 'BEFORE (TRX-12): unpinned items on them', (SELECT COUNT(*) FROM unpinned)::text
UNION ALL
SELECT 'BEFORE (TRX-12): of those items, exactly one published candidate at or before issue (they keep serving)', (SELECT COUNT(*) FROM cand WHERE n = 1)::text
UNION ALL
SELECT 'BEFORE (TRX-12): of those items, no candidate (the portal answers not-available; the issuer re-issues)', (SELECT COUNT(*) FROM cand WHERE n = 0)::text
UNION ALL
SELECT 'BEFORE (TRX-12): of those items, more than one candidate (the portal now refuses as ambiguous instead of serving the newest)', (SELECT COUNT(*) FROM cand WHERE n > 1)::text
UNION ALL
SELECT 'BEFORE (TRX-6): issued / acknowledged transmittals whose creator is no longer an active member (they lose update rights; the record is untouched)',
       (SELECT COUNT(*) FROM live l
         WHERE l.created_by IS NULL
            OR NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = l.org_id AND m.uid = l.created_by AND m.status = 'active'))::text
UNION ALL
SELECT 'BEFORE (TRX-6): drafts whose creator is no longer an active member (a controller or a transmit authority edits them now)',
       (SELECT COUNT(*) FROM transmittals t
         WHERE t.status = 'draft'
           AND (t.created_by IS NULL
                OR NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid = t.created_by AND m.status = 'active')))::text
UNION ALL
SELECT 'BEFORE (TRX-3): drafts carrying an item pinned to a revision that is no longer the document''s current one (refused at issue until the item is re-added)',
       (SELECT COUNT(DISTINCT t.id) FROM transmittals t
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]'::jsonb END) it
          JOIN documents d ON d.id::text = NULLIF(it->>'documentId', '') AND d.org_id = t.org_id
         WHERE t.status = 'draft'
           AND NULLIF(COALESCE(it->>'versionId', it->>'version_id', ''), '') IS NOT NULL
           AND COALESCE(it->>'versionId', it->>'version_id') IS DISTINCT FROM d.current_version_id::text)::text
UNION ALL
SELECT 'BEFORE (TRX-12): drafts carrying an item whose document has no published file (no current version, or one with no revision label) — refused at issue',
       (SELECT COUNT(DISTINCT t.id) FROM transmittals t
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]'::jsonb END) it
          JOIN documents d ON d.id::text = NULLIF(it->>'documentId', '') AND d.org_id = t.org_id
          LEFT JOIN document_versions v ON v.id = d.current_version_id AND v.org_id = t.org_id
         WHERE t.status = 'draft'
           AND (d.current_version_id IS NULL OR v.revision_label IS NULL))::text
UNION ALL
SELECT 'BEFORE (TRX-12): drafts carrying an item listed at a Rev other than its document''s current file label (the document''s Rev field drifted, or the item is stale) — refused at issue',
       (SELECT COUNT(DISTINCT t.id) FROM transmittals t
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]'::jsonb END) it
          JOIN documents d ON d.id::text = NULLIF(it->>'documentId', '') AND d.org_id = t.org_id
          JOIN document_versions v ON v.id = d.current_version_id AND v.org_id = t.org_id
         WHERE t.status = 'draft'
           AND NULLIF(btrim(COALESCE(it->>'rev', '')), '') IS NOT NULL
           AND btrim(v.revision_label) IS DISTINCT FROM btrim(it->>'rev'))::text
UNION ALL
SELECT 'BEFORE (TRX-2): issued / acknowledged / voided transmittals (never deletable from now on)',
       (SELECT COUNT(*) FROM transmittals WHERE status <> 'draft')::text
UNION ALL
SELECT 'BEFORE (TRX-4): live portal links (issued / acknowledged, token set) - no expiry recorded; they serve until revoked or voided',
       (SELECT COUNT(*) FROM transmittals WHERE status IN ('issued', 'acknowledged') AND portal_token IS NOT NULL)::text
UNION ALL
SELECT 'BEFORE (TRX-1, informational): issued / acknowledged transmittals whose creator would not hold transmittal.issue today (nothing is rewritten)',
       (SELECT COUNT(*) FROM live l
         WHERE l.created_by IS NULL
            OR NOT org_capability_allows_for(l.org_id, 'transmittal.issue', l.created_by, '{}'::jsonb))::text
UNION ALL
SELECT 'BEFORE: stored policies carrying a transmittal.issue entry (non-zero = the UPDATE policy admits those tokens on apply)',
       (SELECT COUNT(*) FROM org_configurations
         WHERE key = 'capability_policy' AND COALESCE(data->'caps', data) ? 'transmittal.issue')::text;

BEGIN;

-- ── 0. Apply order: 20261132 must already be live ───────────────────────────
-- Without its CASE row the evaluator answers '[]' for transmittal.issue, and
-- once this file commits nobody could issue, void or revoke. Refuse instead:
-- the RAISE rolls the whole transaction back and the editor shows why.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'org_capability_allows_for' AND pronargs = 4
       AND prosrc LIKE '%transmittal.issue%'
  ) THEN
    RAISE EXCEPTION 'Apply 20261132_dc_roundF_transmit_capability.sql first: org_capability_allows_for does not know transmittal.issue yet, so this file would leave nobody able to issue, void or revoke a transmittal. Nothing was changed.';
  END IF;
END $$;

-- ── 1. TRX-4: the portal link's own lifecycle ───────────────────────────────
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS portal_expires_at TIMESTAMPTZ;
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS portal_revoked_at TIMESTAMPTZ;
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS portal_revoked_by UUID;
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS portal_last_used_at TIMESTAMPTZ;
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS portal_open_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS portal_download_count INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN transmittals.portal_expires_at IS
  'TRX-4: when the portal link stops serving (issue + 90 days, set by trg_transmittals_guard on the issue transition). NULL = issued before 20261133.';
COMMENT ON COLUMN transmittals.portal_revoked_at IS
  'TRX-4: the portal link was cut WITHOUT voiding the record. Set once by a transmit authority; never cleared or moved.';
COMMENT ON COLUMN transmittals.portal_revoked_by IS
  'TRX-4: who revoked the portal link (stamped by the trigger).';
COMMENT ON COLUMN transmittals.portal_last_used_at IS
  'TRX-4: the last portal open or download (written by bump_transmittal_portal_use, service role only).';

-- ── 2. TRX-1 / TRX-2 / TRX-3 / TRX-6 / TRX-8 / TRX-12: the guard ────────────
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

DROP TRIGGER IF EXISTS trg_transmittals_guard ON transmittals;
CREATE TRIGGER trg_transmittals_guard
BEFORE INSERT OR UPDATE OR DELETE ON transmittals
FOR EACH ROW EXECUTE FUNCTION transmittals_guard();

-- ── 3. TRX-1 / TRX-2 / TRX-6: the policies ──────────────────────────────────
-- SELECT (members read, 20260910) and the RESTRICTIVE transmittals_delete_guard
-- (20260818) are unchanged.
DROP POLICY IF EXISTS transmittals_insert ON transmittals;
CREATE POLICY transmittals_insert ON transmittals FOR INSERT WITH CHECK (
  status = 'draft'
  AND portal_token IS NULL
  AND created_by = auth.uid()
  AND EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id
              AND uid = auth.uid() AND status = 'active')
);

DROP POLICY IF EXISTS transmittals_update ON transmittals;
CREATE POLICY transmittals_update ON transmittals FOR UPDATE USING (
  is_org_controller(org_id)
  OR org_capability_allows(org_id, 'transmittal.issue', auth.uid())
  OR (created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id
                  AND uid = auth.uid() AND status = 'active'))
) WITH CHECK (
  is_org_controller(org_id)
  OR org_capability_allows(org_id, 'transmittal.issue', auth.uid())
  OR (created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id
                  AND uid = auth.uid() AND status = 'active'))
);

DROP POLICY IF EXISTS transmittals_delete ON transmittals;
CREATE POLICY transmittals_delete ON transmittals FOR DELETE USING (
  status = 'draft'
  AND (is_org_controller(org_id)
       OR (created_by = auth.uid()
           AND EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id
                       AND uid = auth.uid() AND status = 'active')))
);

-- ── 4. TRX-4: the usage trail, written by the portal route only ─────────────
CREATE OR REPLACE FUNCTION bump_transmittal_portal_use(p_id uuid, p_kind text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('open', 'download') THEN
    RAISE EXCEPTION 'bump_transmittal_portal_use: unknown use %', p_kind;
  END IF;
  UPDATE transmittals
     SET portal_last_used_at = now(),
         portal_open_count = portal_open_count + CASE WHEN p_kind = 'open' THEN 1 ELSE 0 END,
         portal_download_count = portal_download_count + CASE WHEN p_kind = 'download' THEN 1 ELSE 0 END
   WHERE id = p_id AND status IN ('issued', 'acknowledged');
END;
$$;

REVOKE ALL ON FUNCTION bump_transmittal_portal_use(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_transmittal_portal_use(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION bump_transmittal_portal_use(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION bump_transmittal_portal_use(uuid, text) TO service_role;

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 9 ─────────
SELECT '20261132 is applied first (the evaluator knows transmittal.issue)' AS check,
       (SELECT prosrc LIKE '%WHEN ''transmittal.issue''%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'trg_transmittals_guard is the ONE trigger on transmittals and fires BEFORE INSERT, UPDATE and DELETE',
       (SELECT COUNT(*) = 1 AND bool_and((tgtype & 2) = 2 AND (tgtype & 4) = 4 AND (tgtype & 8) = 8 AND (tgtype & 16) = 16 AND tgname = 'trg_transmittals_guard')
          FROM pg_trigger WHERE tgrelid = 'transmittals'::regclass AND NOT tgisinternal),
       NULL::text
UNION ALL
SELECT 'transmittals_guard keeps the 20261027 item rail and token mint',
       (SELECT prosrc LIKE '%transmittal item names a document outside this workspace%'
              AND prosrc LIKE '%transmittal item names a version outside this workspace%'
              AND prosrc LIKE '%NEW.portal_token := replace(gen_random_uuid()::text, ''-'', '''')%'
          FROM pg_proc WHERE proname = 'transmittals_guard' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'transmittals_guard carries the 20261133 rules (authority per library, hold gate, current-revision pin, snapshot with size, restore arm, delete arm) with search_path pinned',
       (SELECT prosrc LIKE '%org_capability_allows_for(NEW.org_id, ''transmittal.issue'', v_uid%'
              AND prosrc LIKE '%FROM document_holds h WHERE h.document_id = v_doc AND h.released_at IS NULL%'
              AND prosrc LIKE '%''fileHash'', v_hash%'
              AND prosrc LIKE '%''fileSize'', v_size%'
              AND prosrc LIKE '%IF v_ver IS NOT NULL AND v_ver IS DISTINCT FROM v_current THEN%'
              AND prosrc LIKE '%Restored from a backup: the portal link was not restored (DEC-45)%'
              AND prosrc LIKE '%''statusAsSent'', v_status%'
              AND prosrc LIKE '%IF TG_OP = ''DELETE'' THEN%'
              AND prosrc LIKE '%NEW.portal_expires_at := now() + interval ''90 days''%'
              AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'transmittals_guard' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'transmittals_insert admits a draft with no portal token, by an active member, as themself (TRX-1)',
       (SELECT cmd = 'INSERT'
              AND with_check LIKE '%status = ''draft''%'
              AND with_check LIKE '%portal_token IS NULL%'
              AND with_check LIKE '%created_by = auth.uid()%'
              AND with_check LIKE '%org_members%'
          FROM pg_policies WHERE tablename = 'transmittals' AND policyname = 'transmittals_insert'),
       NULL::text
UNION ALL
SELECT 'transmittals_update: a controller, a transmit authority, or the creator while an active member (TRX-6)',
       (SELECT cmd = 'UPDATE'
              AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%transmittal.issue%' AND qual LIKE '%org_members%'
              AND with_check LIKE '%is_org_controller(org_id)%' AND with_check LIKE '%transmittal.issue%' AND with_check LIKE '%org_members%'
          FROM pg_policies WHERE tablename = 'transmittals' AND policyname = 'transmittals_update'),
       NULL::text
UNION ALL
SELECT 'transmittals_delete: drafts only - a controller, or the creator while an active member (TRX-2 / TRX-6)',
       (SELECT cmd = 'DELETE'
              AND qual LIKE '%status = ''draft''%' AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%org_members%'
          FROM pg_policies WHERE tablename = 'transmittals' AND policyname = 'transmittals_delete'),
       NULL::text
UNION ALL
SELECT 'the six portal lifecycle columns exist (TRX-4)',
       (SELECT COUNT(*) = 6 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transmittals'
           AND column_name IN ('portal_expires_at', 'portal_revoked_at', 'portal_revoked_by',
                               'portal_last_used_at', 'portal_open_count', 'portal_download_count')),
       NULL::text
UNION ALL
SELECT 'bump_transmittal_portal_use is SECURITY DEFINER, pinned, and executable by the service role only',
       (SELECT p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
              AND NOT has_function_privilege('public', 'bump_transmittal_portal_use(uuid,text)', 'EXECUTE')
              AND NOT has_function_privilege('anon', 'bump_transmittal_portal_use(uuid,text)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'bump_transmittal_portal_use(uuid,text)', 'EXECUTE')
              AND has_function_privilege('service_role', 'bump_transmittal_portal_use(uuid,text)', 'EXECUTE')
          FROM pg_proc p WHERE p.proname = 'bump_transmittal_portal_use' AND p.pronargs = 2),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_133_before
UNION ALL
SELECT 'AFTER: active members the UPDATE policy admits through transmittal.issue who are not controllers (expect 0 on apply)', NULL::boolean, COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active'
   AND org_capability_allows_for(m.org_id, 'transmittal.issue', m.uid, '{}'::jsonb)
   AND NOT (m.role = ANY(ARRAY['Admin','DocCtrl']::text[]) OR m.roles && ARRAY['Admin','DocCtrl']::text[]);
