-- 20261105_prj_roundG_intake_review_and_attempts.sql
--
-- projects Round G — J1 INTAKE-DOOR, migration B (projects-and-cost INTK-8,
-- INTK-5, INTK-4, INTK-13; projects-tab SEC-8, SAF-10, REL-8, SAF-9,
-- SEC-13, SEC-14, SAF-12). The review side of the external door.
--
-- WHAT:
--   1. intake_attempts (INTK-8 / SEC-8) — the durable per-token / per-IP
--      window the upload route counts before it reads a body, and the
--      one-notice-per-window marker. The token is stored HASHED. RLS on, NO
--      policies (service role only, the signup_attempts shape);
--      prune_intake_attempts() keeps two days and is called by the ONE
--      maintenance-cron step (no new vercel.json cron).
--   2. document_versions.review_state admits 'superseded' (INTK-4 /
--      SAF-10): a submission displaced by a newer one from the same link is
--      RESOLVED, never left 'in_review' with nothing pointing at it.
--      document_versions.review_note carries the reviewer's rejection
--      reason to the contractor's portal (SAF-9).
--   3. Idempotency (REL-8 / INTK-13): cost_documents.file_hash; a partial
--      UNIQUE index per (intake link, file hash) over the rows still
--      awaiting a decision — an in-review version, a draft quote — so a
--      retried upload cannot double-create even when two retries race. Each
--      index is created only in the world where no duplicate exists yet
--      (the inventory reports the count; nothing is deleted).
--   4. uniqueness_key backfill (INTK-5): rows with a document number and no
--      key get the key lib/uniqueness.ts computes — the library's
--      uniqueness_keys tuple (default: the number), each part trimmed and
--      lower-cased, joined with '::'. A row whose key would collide with a
--      LIVE row (or with another backfilled live row) is SKIPPED and
--      counted: the database never guesses which of two same-numbered
--      drawings is the real one.
--   5. orphaned_in_review_versions_count() — the health signal SAF-10 asks
--      for: in-review versions no document points at. Service role only;
--      the maintenance cron reports it.
--   6. enforce_document_publish_guard, re-created from its live body
--      (20261070) with two additions for EXTERNAL submissions only
--      (versions carrying an intake_link_id), promoted by a signed-in user:
--        · SEC-13 — a policy that REQUIRES sign-off binds an intake
--          submission too (RG-7 exempted it); the Intake tab sends it to the
--          resolved roster, and a promote that skipped the roster is refused;
--        · SEC-14 — an external submission of a drawing-class document
--          needs its MOC reference, the rule publish_revision already
--          applies to the service-role door.
--      Nothing else in the body changes (lib/__tests__/intakeDoorMigration
--      line-diffs the two).
--   7. publish_revision, re-created from its live body (20261049) with ONE
--      change: a 'superseded' (displaced, never reviewed) submission is not
--      a revert target — the revert-target gate lists it beside
--      'in_review' and 'rejected'.
--
-- NOT a widening: 1, 3 and 5 are service-role surfaces; 2 adds a state and
-- a note; 4 fills a key; 6 and 7 refuse more, never less. DEC-30
-- inventories (aggregate counts, captured BEFORE the transaction) are
-- returned with the verification probes.
--
-- HOW TO APPLY: AFTER document-control Round F's 20261070 (the guard body
-- re-created here is 20261070's, and it reads the slot columns and
-- review_control_mode_for that 20261070 creates) and after 20261104. Paste
-- the whole file into the Supabase SQL editor and run it once (a second
-- run is safe). The final SELECT is the only result set shown — probe rows
-- must read ok = true; inventory rows carry ok NULL and a count in n.

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
DROP TABLE IF EXISTS pg_temp.prj_g_j1b_keys;
CREATE TEMP TABLE prj_g_j1b_keys AS
SELECT d.id, d.library_id,
       (d.status IS NOT NULL AND d.status NOT IN ('Archived', 'Superseded')) AS live,
       (SELECT CASE WHEN bool_and(p.v = '') THEN NULL ELSE string_agg(p.v, '::' ORDER BY p.ord) END
          FROM (SELECT k.ord,
                       lower(btrim(COALESCE(CASE k.key
                                               WHEN 'documentNumber' THEN d.document_number
                                               WHEN 'title' THEN d.title
                                               WHEN 'rev' THEN d.rev
                                               WHEN 'status' THEN d.status
                                               ELSE d.metadata->>k.key
                                             END, ''), E' \t\n\r\f')) AS v
                  FROM unnest(CASE WHEN l.uniqueness_keys IS NULL OR cardinality(l.uniqueness_keys) = 0
                                   THEN ARRAY['documentNumber']::text[] ELSE l.uniqueness_keys END)
                       WITH ORDINALITY AS k(key, ord)) p) AS key
  FROM documents d
  JOIN libraries l ON l.id = d.library_id
 WHERE d.uniqueness_key IS NULL AND d.document_number IS NOT NULL;

DROP TABLE IF EXISTS pg_temp.prj_g_j1b_inventory;
CREATE TEMP TABLE prj_g_j1b_inventory AS
SELECT 'inventory: documents with a number and NO uniqueness_key (backfill candidates)' AS inventory, COUNT(*)::text AS n
  FROM prj_g_j1b_keys
UNION ALL
SELECT 'inventory: …in how many libraries', COUNT(DISTINCT library_id)::text FROM prj_g_j1b_keys
UNION ALL
SELECT 'inventory: …LIVE candidates whose key collides with another live document (SKIPPED — two sources of truth to resolve by hand)', COUNT(*)::text
  FROM prj_g_j1b_keys c
 WHERE c.live AND c.key IS NOT NULL
   AND (EXISTS (SELECT 1 FROM documents o
                 WHERE o.library_id = c.library_id AND o.uniqueness_key = c.key AND o.id <> c.id
                   AND o.status IS NOT NULL AND o.status NOT IN ('Archived', 'Superseded'))
        OR EXISTS (SELECT 1 FROM prj_g_j1b_keys o
                    WHERE o.library_id = c.library_id AND o.key = c.key AND o.id <> c.id AND o.live))
UNION ALL
SELECT 'inventory: in-review versions no document points at (INTK-4 orphans — surfaced, not auto-voided)', COUNT(*)::text
  FROM document_versions v
  LEFT JOIN documents d ON d.id = v.record_id
 WHERE v.review_state = 'in_review' AND d.pending_version_id IS DISTINCT FROM v.id
UNION ALL
SELECT 'inventory: …of which external intake submissions', COUNT(*)::text
  FROM document_versions v
  LEFT JOIN documents d ON d.id = v.record_id
 WHERE v.review_state = 'in_review' AND v.intake_link_id IS NOT NULL AND d.pending_version_id IS DISTINCT FROM v.id
UNION ALL
SELECT 'inventory: projects with more than one "Intake — …" folder in their intake library (INTK-13 duplicates, not merged)', COUNT(*)::text
  FROM (SELECT p.id
          FROM projects p
          JOIN collections c ON c.library_id = p.intake_library_id AND c.name = 'Intake — ' || COALESCE(p.name, 'Project')
         GROUP BY p.id HAVING COUNT(*) > 1) x
UNION ALL
SELECT 'inventory: in-review intake versions sharing (link, file hash) — the in-flight idempotency index is created only at 0', COUNT(*)::text
  FROM (SELECT intake_link_id, file_hash FROM document_versions
         WHERE intake_link_id IS NOT NULL AND file_hash IS NOT NULL AND review_state = 'in_review'
         GROUP BY 1, 2 HAVING COUNT(*) > 1) x
UNION ALL
SELECT 'inventory: pending intake submissions in a library that REQUIRES sign-off with no roster (approval now opens one first)', COUNT(*)::text
  FROM documents d
  JOIN document_versions v ON v.id = d.pending_version_id
 WHERE v.intake_link_id IS NOT NULL
   AND review_control_mode_for(d.review_control, d.collection_id, d.library_id) = 'require'
   AND NOT EXISTS (SELECT 1 FROM document_review_signoffs s WHERE s.document_version_id = v.id AND s.slot = 'primary')
UNION ALL
SELECT 'inventory: pending intake submissions with no MOC reference (approval of a drawing-class one now asks for it)', COUNT(*)::text
  FROM documents d
  JOIN document_versions v ON v.id = d.pending_version_id
 WHERE v.intake_link_id IS NOT NULL AND length(btrim(COALESCE(v.moc_reference, ''))) < 3;

BEGIN;

-- ── 1. the attempt window (INTK-8 / SEC-8) ───────────────────────────────
CREATE TABLE IF NOT EXISTS intake_attempts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL,           -- sha256 of the presented token, never the token
  ip         TEXT NOT NULL,
  link_id    UUID,
  outcome    TEXT NOT NULL,           -- 'attempt' | 'notified'
  bytes      BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS intake_attempts_token_time_idx ON intake_attempts (token_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_attempts_ip_time_idx ON intake_attempts (ip, created_at DESC);
ALTER TABLE intake_attempts ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service role only.
COMMENT ON TABLE intake_attempts IS
  'INTK-8 / SEC-8: the intake door''s durable rate window (per hashed token, per IP) and its one-notice-per-window marker. Service role only; pruned by prune_intake_attempts() from the maintenance cron.';

CREATE OR REPLACE FUNCTION prune_intake_attempts() RETURNS integer
LANGUAGE sql SET search_path = public AS $$
  WITH gone AS (DELETE FROM intake_attempts WHERE created_at < NOW() - INTERVAL '2 days' RETURNING 1)
  SELECT COUNT(*)::integer FROM gone;
$$;
REVOKE ALL ON FUNCTION prune_intake_attempts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_intake_attempts() TO service_role;

-- ── 2. a displaced submission is resolved; a rejection says why ──────────
ALTER TABLE document_versions DROP CONSTRAINT IF EXISTS document_versions_review_state_check;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_review_state_check
  CHECK (review_state IS NULL OR review_state IN ('in_review', 'approved', 'rejected', 'superseded'));
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS review_note TEXT;
COMMENT ON COLUMN document_versions.review_note IS
  'SAF-9: the reviewer''s reason for a rejected external submission — shown to the contractor on their portal.';

-- ── 3. a retried upload returns the original (REL-8 / INTK-13) ───────────
ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS file_hash TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM document_versions
                                 WHERE intake_link_id IS NOT NULL AND file_hash IS NOT NULL AND review_state = 'in_review'
                                 GROUP BY intake_link_id, file_hash HAVING COUNT(*) > 1) x) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS document_versions_intake_inflight_uniq
      ON document_versions (intake_link_id, file_hash)
      WHERE intake_link_id IS NOT NULL AND file_hash IS NOT NULL AND review_state = 'in_review';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM cost_documents
                                 WHERE intake_link_id IS NOT NULL AND file_hash IS NOT NULL AND status = 'draft'
                                 GROUP BY intake_link_id, file_hash HAVING COUNT(*) > 1) x) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS cost_documents_intake_inflight_uniq
      ON cost_documents (intake_link_id, file_hash)
      WHERE intake_link_id IS NOT NULL AND file_hash IS NOT NULL AND status = 'draft';
  END IF;
END $$;

-- ── 4. the uniqueness_key backfill (INTK-5) ──────────────────────────────
UPDATE documents d
   SET uniqueness_key = c.key
  FROM prj_g_j1b_keys c
 WHERE d.id = c.id
   AND d.uniqueness_key IS NULL
   AND c.key IS NOT NULL
   AND NOT (c.live AND (
         EXISTS (SELECT 1 FROM documents o
                  WHERE o.library_id = c.library_id AND o.uniqueness_key = c.key AND o.id <> c.id
                    AND o.status IS NOT NULL AND o.status NOT IN ('Archived', 'Superseded'))
      OR EXISTS (SELECT 1 FROM prj_g_j1b_keys o
                  WHERE o.library_id = c.library_id AND o.key = c.key AND o.id <> c.id AND o.live)));

-- ── 5. the orphan health signal (SAF-10 dw3) ─────────────────────────────
CREATE OR REPLACE FUNCTION orphaned_in_review_versions_count() RETURNS bigint
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COUNT(*)
    FROM document_versions v
    LEFT JOIN documents d ON d.id = v.record_id
   WHERE v.review_state = 'in_review' AND d.pending_version_id IS DISTINCT FROM v.id;
$$;
REVOKE ALL ON FUNCTION orphaned_in_review_versions_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION orphaned_in_review_versions_count() TO service_role;

-- ── 6. the publish guard: intake submissions meet the review policy and the
--       MOC rule (SEC-13 / SEC-14) — 20261070 body + two blocks ──────────
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
  v_review_state text;
  v_change_type  text;
  v_intake_link  uuid;
  v_review_mode  text;
  v_moc          text;
  v_doc_class    text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_advancing :=
       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded')
    -- OWN-15: un-supersede, unarchive and un-void are publish-shaped acts —
    -- the same authority that put the record there takes it back out.
    OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status)
    -- OWN-19: archiving is a lifecycle act of the same shape as supersede —
    -- the publisher tier (controller / granted publisher / effective owner)
    -- retires a record whichever door it leaves by.
    OR (NEW.status = 'Archived' AND COALESCE(OLD.status, '') <> 'Archived');
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
    -- RG-4 / DRLS-6: completion is PER SLOT. Every primary row is a slot in
    -- its slot_group; a slot is filled by its own primary's bound signature
    -- or by the bound signature of an ACTIVATED alternate of the same group
    -- (one signature fills one slot). Primaries count in every status; a
    -- standby alternate, or one with no group and no primary, fills nothing.
    -- Rows without a group (pre-20261070) share one legacy group.
    SELECT COALESCE(sum(g.reqs), 0), COALESCE(sum(LEAST(g.reqs, g.filled)), 0)
      INTO v_primary_reqs, v_signed
      FROM (
        SELECT COALESCE(s.slot_group, '') AS grp,
               count(*) FILTER (WHERE s.slot = 'primary') AS reqs,
               count(*) FILTER (WHERE (s.slot = 'primary' OR s.activated)
                                  AND s.status = 'signed'
                                  AND s.signature_id IS NOT NULL
                                  AND EXISTS (
                                    SELECT 1 FROM e_signatures e
                                    WHERE e.id = s.signature_id
                                      AND e.signer_user_id = s.reviewer_user_id
                                      AND e.org_id = s.org_id
                                      AND (e.document_version_id = s.document_version_id
                                           OR e.document_version_id IS NULL)
                                  )) AS filled
          FROM document_review_signoffs s
         WHERE s.document_version_id = NEW.current_version_id
         GROUP BY COALESCE(s.slot_group, '')
      ) g;
    IF COALESCE(v_primary_reqs, 0) > 0 AND COALESCE(v_signed, 0) < v_primary_reqs THEN
      RAISE EXCEPTION
        'This revision still has outstanding review sign-offs; complete the review before publishing.'
        USING ERRCODE = 'check_violation';
    END IF;

    -- RG-7: an absent roster is not "no gate". A draft SUBMITTED for review
    -- (review_state 'in_review', not an external intake submission) with no
    -- primary slot was never reviewed; and a direct non-Minor revision of a
    -- controlled document whose EFFECTIVE policy requires review — resolved
    -- along the same container chain the app walks — may not skip the gate
    -- by never opening a roster. Minor / Correction is the declared escape
    -- hatch; publisher_choice is the publisher's call; a document's first
    -- controlled revision is not a revision through the gate.
    IF COALESCE(v_primary_reqs, 0) = 0 THEN
      SELECT v.review_state, v.change_type, v.intake_link_id
        INTO v_review_state, v_change_type, v_intake_link
        FROM document_versions v WHERE v.id = NEW.current_version_id;
      IF v_review_state = 'in_review' AND v_intake_link IS NULL THEN
        RAISE EXCEPTION
          'This draft was submitted for review but has no reviewer roster; set the reviewers and resubmit it before publishing.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.current_version_id IS NOT NULL AND v_intake_link IS NULL
         AND COALESCE(v_change_type, '') NOT IN ('Minor', 'Correction') THEN
        v_review_mode := review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id);
        IF v_review_mode = 'require' THEN
          RAISE EXCEPTION
            'This library requires reviewer sign-off for a Major revision; submit it for review instead of publishing directly.'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      -- SEC-13 (projects Round G): an EXTERNAL submission is no exception to
      -- a policy that requires sign-off — its first issue included. The
      -- Intake tab sends it to the resolved roster; a promote that skipped
      -- the roster is refused here.
      IF v_intake_link IS NOT NULL THEN
        v_review_mode := review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id);
        IF v_review_mode = 'require' THEN
          RAISE EXCEPTION
            'This library requires reviewer sign-off; send the external submission to its reviewers before publishing it.'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
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

    -- SEC-14 (projects Round G): an external submission of a drawing-class
    -- document carries a management-of-change reference into the
    -- controlled revision however it is promoted — the class rule
    -- publish_revision already applies to the service-role door (DCK-1).
    SELECT v.intake_link_id, v.moc_reference INTO v_intake_link, v_moc
      FROM document_versions v WHERE v.id = NEW.current_version_id;
    IF v_intake_link IS NOT NULL THEN
      BEGIN
        v_doc_class := COALESCE(
                         NULLIF(NEW.doc_class, ''),
                         (SELECT NULLIF(c.doc_class, '') FROM collections c WHERE c.id = NEW.collection_id),
                         (SELECT NULLIF(l.doc_class, '') FROM libraries l WHERE l.id = NEW.library_id)
                       );
      EXCEPTION WHEN undefined_column THEN
        v_doc_class := NULL;
      END;
      IF v_doc_class = 'drawing' AND length(btrim(COALESCE(v_moc, ''))) < 3 THEN
        RAISE EXCEPTION
          'PSM requires an MOC reference to publish an external submission of a drawing-class document (OSHA 1910.119(l)); add it to the submission before approving.'
          USING ERRCODE = 'check_violation';
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

-- ── 7. publish_revision: a displaced submission is not a revert target —
--       20261049 body + one word in the revert-target gate ───────────────
CREATE OR REPLACE FUNCTION publish_revision(
  p_doc UUID,
  p_expected_base UUID,
  p_op_class TEXT,
  p_version JSONB,
  p_actor UUID,
  p_actor_name TEXT DEFAULT NULL,
  p_force BOOLEAN DEFAULT FALSE,
  p_as_branch BOOLEAN DEFAULT FALSE,
  p_branch_reason TEXT DEFAULT NULL,
  p_new_status TEXT DEFAULT 'Issued',
  p_override_lock BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_doc RECORD;
  v_is_member BOOLEAN;
  v_is_controller BOOLEAN;
  v_current RECORD;
  v_new_id UUID;
  v_new_row JSONB;
  v_branch_id UUID;
  v_label TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_doc_class TEXT;
  v_is_revert BOOLEAN;
  v_minor_like BOOLEAN;
  v_revert_target UUID;
BEGIN
  IF p_op_class NOT IN ('content','metadata') THEN
    RAISE EXCEPTION 'publish_revision: unknown op_class %', p_op_class;
  END IF;

  -- OWN-5: the acting identity comes from the SESSION. A signed-in caller
  -- cannot publish as someone else — attribution, authority, and lock
  -- evaluation all follow auth.uid(). Only a service-role call (auth.uid()
  -- IS NULL) may name its actor explicitly.
  IF auth.uid() IS NOT NULL THEN
    IF p_actor IS NULL THEN
      p_actor := auth.uid();
    ELSIF p_actor IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'publish_revision: p_actor does not match the calling session.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_actor IS NULL THEN
    RAISE EXCEPTION 'publish_revision: a service-role call must name its actor';
  END IF;

  SELECT * INTO v_doc FROM documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publish_revision: document % not found', p_doc;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_doc.org_id AND uid = p_actor AND status = 'active'
  ) INTO v_is_member;
  IF NOT v_is_member THEN
    RAISE EXCEPTION 'publish_revision: actor is not an active member of this org';
  END IF;

  -- OWN-3/DEC-2: the controller tier is a property of the COLLECTION.
  -- Inline (not is_org_controller) because p_actor may be a service-role
  -- caller's named actor, not auth.uid().
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_doc.org_id AND uid = p_actor AND status = 'active'
      AND (role IN ('Admin','DocCtrl') OR roles && ARRAY['Admin','DocCtrl']::text[])
  ) INTO v_is_controller;

  IF v_doc.checked_out_by IS NOT NULL
     AND v_doc.checked_out_by::text <> p_actor::text
     AND NOT (p_override_lock OR (p_force AND v_is_controller)) THEN
    RETURN jsonb_build_object(
      'status', 'locked_by_other',
      'holder_name', v_doc.checked_out_by_name
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM document_holds
    WHERE document_id = p_doc AND released_at IS NULL
  ) AND NOT (p_force AND v_is_controller) THEN
    RETURN jsonb_build_object('status', 'on_hold');
  END IF;

  IF p_op_class = 'content' AND NOT p_as_branch
     AND v_doc.current_version_id IS DISTINCT FROM p_expected_base THEN
    SELECT id, revision_label, created_by, created_by_name, created_at, change_log
      INTO v_current FROM document_versions WHERE id = v_doc.current_version_id;
    RETURN jsonb_build_object(
      'status', 'stale_base',
      'current_version_id', v_current.id,
      'current_rev', v_current.revision_label,
      'current_by', v_current.created_by,
      'current_by_name', v_current.created_by_name,
      'current_at', v_current.created_at,
      'current_change_log', v_current.change_log
    );
  END IF;

  IF p_as_branch AND (p_branch_reason IS NULL OR btrim(p_branch_reason) = '') THEN
    RAISE EXCEPTION 'publish_revision: a branch publish requires a reason';
  END IF;

  -- OWN-5: the BRANCH insert carries the same publish-authority bar as the
  -- promote. The promote's authority lives in trg_document_publish_guard on
  -- the documents write — a branch never touches documents, so without this
  -- block any active member could park arbitrary content as a branch row.
  IF p_as_branch AND auth.uid() IS NOT NULL AND NOT v_is_controller
     AND NOT user_can_publish_on_library(v_doc.library_id, p_actor::text, v_doc.org_id)
     AND NOT user_is_effective_owner(v_doc.owner_user_id, v_doc.collection_id, v_doc.library_id, p_actor) THEN
    RAISE EXCEPTION 'publish_revision: you do not have authority to publish revisions (branches included) in this library.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_op_class = 'content' THEN
    BEGIN
      SELECT COALESCE(
               NULLIF(v_doc.doc_class, ''),
               (SELECT NULLIF(c.doc_class, '') FROM collections c WHERE c.id = v_doc.collection_id),
               (SELECT NULLIF(l.doc_class, '') FROM libraries l WHERE l.id = v_doc.library_id)
             ) INTO v_doc_class;
    EXCEPTION WHEN undefined_column THEN
      v_doc_class := NULL;
    END;
    v_is_revert := NULLIF(p_version->>'reverted_from_version_id', '') IS NOT NULL;
    v_minor_like := COALESCE(NULLIF(p_version->>'change_type', ''), '') IN ('Minor', 'Correction')
                    AND NOT v_is_revert;
    IF v_doc_class = 'drawing' AND NOT v_minor_like
       AND length(btrim(COALESCE(p_version->>'moc_reference', ''))) < 3 THEN
      RAISE EXCEPTION 'publish_revision: PSM requires an MOC reference to publish a non-minor revision of a drawing-class document (OSHA 1910.119(l)).'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_op_class = 'content'
     AND NULLIF(p_version->>'reverted_from_version_id', '') IS NOT NULL THEN
    v_revert_target := (p_version->>'reverted_from_version_id')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM document_versions t
      WHERE t.id = v_revert_target AND t.record_id = p_doc
    ) THEN
      RAISE EXCEPTION 'publish_revision: revert target is not a revision of this document.'
        USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM document_versions t
        WHERE t.id = v_revert_target
          AND (COALESCE(t.review_state, '') IN ('in_review', 'rejected', 'superseded')
               OR COALESCE(t.is_branch, FALSE))
      ) THEN
        RAISE EXCEPTION 'publish_revision: revert target is an unreviewed draft or an unreconciled branch — only previously-issued revisions can be restored.'
          USING ERRCODE = 'check_violation';
      END IF;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END;
  END IF;

  v_label := COALESCE(p_version->>'revision_label', '');
  IF btrim(v_label) = '' THEN
    RAISE EXCEPTION 'publish_revision: revision_label is required';
  END IF;

  BEGIN
    INSERT INTO document_versions (
      org_id, record_id, revision_label, issue_type, change_type,
      file_url, file_type, size, change_log,
      created_by, created_by_name, created_at,
      supersedes_version_id, drawn_by_name, checked_by_name, approved_by_name,
      released_at, moc_reference, source_file_name, source_file_key, file_hash,
      reverted_from_version_id,
      is_branch, published_base_version_id, provenance, related_ticket_id
    ) VALUES (
      v_doc.org_id, p_doc, btrim(v_label),
      NULLIF(p_version->>'issue_type',''), NULLIF(p_version->>'change_type',''),
      p_version->>'file_url', NULLIF(p_version->>'file_type',''),
      NULLIF(p_version->>'size','')::bigint, NULLIF(p_version->>'change_log',''),
      p_actor, COALESCE(NULLIF(p_version->>'created_by_name',''), p_actor_name, p_actor::text), v_now,
      CASE WHEN p_as_branch THEN NULL ELSE v_doc.current_version_id END,
      NULLIF(p_version->>'drawn_by_name',''), NULLIF(p_version->>'checked_by_name',''),
      NULLIF(p_version->>'approved_by_name',''),
      v_now, NULLIF(p_version->>'moc_reference',''),
      NULLIF(p_version->>'source_file_name',''), NULLIF(p_version->>'source_file_key',''),
      NULLIF(p_version->>'file_hash',''),
      NULLIF(p_version->>'reverted_from_version_id','')::uuid,
      p_as_branch, p_expected_base, NULLIF(p_version->>'provenance',''),
      NULLIF(p_version->>'related_ticket_id','')::uuid
    )
    RETURNING id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'duplicate_label', 'label', btrim(v_label));
  END;

  IF p_as_branch THEN
    INSERT INTO revision_branches (
      org_id, document_id, branch_version_id, diverged_from_version_id,
      reason, created_by, created_by_name
    ) VALUES (
      v_doc.org_id, p_doc, v_new_id, v_doc.current_version_id,
      btrim(p_branch_reason), p_actor::text, p_actor_name
    ) RETURNING id INTO v_branch_id;
  ELSE
    IF v_doc.current_version_id IS NOT NULL THEN
      UPDATE document_versions SET superseded_at = v_now
      WHERE id = v_doc.current_version_id;
    END IF;
    UPDATE documents SET
      current_version_id = v_new_id,
      rev = btrim(v_label),
      revision = btrim(v_label),
      status = COALESCE(NULLIF(p_new_status,''), 'Issued'),
      updated_at = v_now,
      updated_by = p_actor
    WHERE id = p_doc;
  END IF;

  SELECT to_jsonb(dv) INTO v_new_row FROM document_versions dv WHERE dv.id = v_new_id;
  RETURN jsonb_build_object(
    'status', CASE WHEN p_as_branch THEN 'branched' ELSE 'published' END,
    'version', v_new_row,
    'branch_id', v_branch_id,
    'superseded_version_id', CASE WHEN p_as_branch THEN NULL ELSE v_doc.current_version_id END
  );
END;
$$;

COMMENT ON FUNCTION publish_revision IS
  'Transactional, per-document-serialized revision publish. The acting identity is derived from auth.uid() (p_actor honored only on service-role calls). content op_class enforces the expected-base check, the drawing-class MOC gate (DCK-1) and the revert-target gate (REV-2; in-review, rejected and superseded submissions are never targets); a branch insert carries the same publish-authority bar as a promote (OWN-5). p_override_lock = authorized publisher''s checkout-override (passes the lock, never a hold); p_force = controller-only emergency bypass.';

REVOKE ALL ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'intake_attempts exists with RLS on and NO policies (service role only)' AS check,
       EXISTS (SELECT 1 FROM pg_class WHERE relname = 'intake_attempts' AND relrowsecurity)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'intake_attempts') AS ok,
       NULL::text AS n
UNION ALL SELECT 'intake_attempts indexed on (token_hash, created_at) and (ip, created_at)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'intake_attempts_token_time_idx')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'intake_attempts_ip_time_idx'), NULL
UNION ALL SELECT 'prune_intake_attempts: service_role may execute; anon and authenticated may not',
       has_function_privilege('service_role', 'prune_intake_attempts()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'prune_intake_attempts()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'prune_intake_attempts()', 'EXECUTE'), NULL
UNION ALL SELECT 'review_state admits superseded',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_versions_review_state_check'
                AND pg_get_constraintdef(oid) LIKE '%superseded%'), NULL
UNION ALL SELECT 'document_versions.review_note exists',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'document_versions' AND column_name = 'review_note'), NULL
UNION ALL SELECT 'cost_documents.file_hash exists',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cost_documents' AND column_name = 'file_hash'), NULL
UNION ALL SELECT 'in-flight idempotency index on document_versions (link, file hash) WHERE in_review',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'document_versions_intake_inflight_uniq'
                AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%in_review%'), NULL
UNION ALL SELECT 'in-flight idempotency index on cost_documents (link, file hash) WHERE draft',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'cost_documents_intake_inflight_uniq'
                AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%draft%'), NULL
UNION ALL SELECT 'no numbered document is left without a uniqueness_key except the skipped live collisions',
       NOT EXISTS (SELECT 1 FROM prj_g_j1b_keys c JOIN documents d ON d.id = c.id
                    WHERE d.uniqueness_key IS NULL AND c.key IS NOT NULL
                      AND NOT (c.live AND (
                            EXISTS (SELECT 1 FROM documents o
                                     WHERE o.library_id = c.library_id AND o.uniqueness_key = c.key AND o.id <> c.id
                                       AND o.status IS NOT NULL AND o.status NOT IN ('Archived', 'Superseded'))
                         OR EXISTS (SELECT 1 FROM prj_g_j1b_keys o
                                     WHERE o.library_id = c.library_id AND o.key = c.key AND o.id <> c.id AND o.live)))), NULL
UNION ALL SELECT 'orphaned_in_review_versions_count: service_role only',
       has_function_privilege('service_role', 'orphaned_in_review_versions_count()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'orphaned_in_review_versions_count()', 'EXECUTE'), NULL
UNION ALL SELECT 'publish guard binds intake submissions to a required review policy (SEC-13) and the drawing-class MOC rule (SEC-14)',
       (SELECT prosrc LIKE '%send the external submission to its reviewers before publishing it%'
               AND prosrc LIKE '%publish an external submission of a drawing-class document%'
               AND prosrc LIKE '%This draft was submitted for review but has no reviewer roster%'
               AND prosrc LIKE '%Reviewer independence%'
               AND prosrc LIKE '%You do not have authority to publish revisions in this library.%'
               AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'), NULL
UNION ALL SELECT 'publish_revision refuses a superseded submission as a revert target, and keeps its MOC and authority arms',
       (SELECT prosrc LIKE '%IN (''in_review'', ''rejected'', ''superseded'')%'
               AND prosrc LIKE '%PSM requires an MOC reference%'
               AND prosrc LIKE '%roles && ARRAY[''Admin'',''DocCtrl'']%'
               AND prosrc LIKE '%NULLIF(p_version->>''related_ticket_id'','''')::uuid%'
          FROM pg_proc WHERE proname = 'publish_revision'), NULL
UNION ALL SELECT 'authenticated may execute publish_revision; PUBLIC may not',
       has_function_privilege('authenticated', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean)', 'EXECUTE')
       AND NOT has_function_privilege('public', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean)', 'EXECUTE'), NULL
UNION ALL SELECT 'inventory: uniqueness keys backfilled by this run', NULL::boolean,
       (SELECT COUNT(*)::text FROM prj_g_j1b_keys c JOIN documents d ON d.id = c.id WHERE d.uniqueness_key IS NOT NULL)
UNION ALL SELECT 'inventory: in-review versions no document points at, after apply', NULL::boolean,
       orphaned_in_review_versions_count()::text
UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_j1b_inventory;
