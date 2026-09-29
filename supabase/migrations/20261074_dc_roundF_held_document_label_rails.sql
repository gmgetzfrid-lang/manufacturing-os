-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F — P5 HOLDS: the database half of HLD-1 — a held
-- document's revision label cannot be rewritten past the hold.
--
-- The publish guard (enforce_document_publish_guard, live body 20261060)
-- checks holds only on an ADVANCING write: current_version_id moving, or a
-- status transition into / out of Superseded, Archived, Void (20261060 made
-- → Archived advancing, so status→Archived on a held document is already
-- refused for a non-controller). A bare label rewrite skips it entirely:
-- lib/revisions.ts correctRevisionLabel updates document_versions.revision_label
-- and then documents.rev / documents.revision WITHOUT touching
-- current_version_id, and a metadata edit of `rev` takes the same path. That
-- changes what the register, the inspector and every printed hold card
-- display for a document that is under a stop-work.
--
-- Two small BEFORE UPDATE OF <label> triggers close it — a second rail, not a
-- re-creation of the publish guard (P4 REVIEW extends that body; the two must
-- not collide):
--   · documents: a change to rev / revision with current_version_id UNCHANGED
--     (publish-shaped writes move both and are the publish guard's business)
--     on a document under an active hold is refused for a non-controller.
--   · document_versions: a change to revision_label on a version whose parent
--     document is under an active hold is refused for a non-controller.
-- Controllers (is_org_controller — the collection, DEC-2) and the service
-- role (auth.uid() IS NULL — restores, cron) pass exactly as they do at the
-- publish guard. The same split the app already encodes: canForceHold is
-- controller-only, "an override-with-reason must never jump a safety hold".
--
-- NOT a widening. Inventory (DEC-30, before the DDL): documents under an
-- active hold — the population whose label rewrites now take a controller.
-- Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _dc_f74_before AS
SELECT 'documents under an active hold (a non-controller label rewrite on these is now refused until release)' AS what,
       COUNT(DISTINCT h.document_id) AS n
  FROM document_holds h WHERE h.released_at IS NULL;

BEGIN;

-- ── documents.rev / documents.revision on a held document ───────────────────
CREATE OR REPLACE FUNCTION enforce_document_hold_label_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();   -- NULL for service-role / SQL console
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;
  -- A publish-shaped write moves current_version_id with the label; the publish
  -- guard governs that. This rail is for the bare label rewrite that skips it.
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    RETURN NEW;
  END IF;
  IF NEW.rev IS NOT DISTINCT FROM OLD.rev AND NEW.revision IS NOT DISTINCT FROM OLD.revision THEN
    RETURN NEW;
  END IF;
  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION.
  IF is_org_controller(NEW.org_id) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = NEW.id AND h.released_at IS NULL) THEN
    RAISE EXCEPTION
      'Document has an active hold; release the hold before changing its revision label.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_hold_label_guard ON documents;
CREATE TRIGGER trg_document_hold_label_guard
  BEFORE UPDATE OF rev, revision ON documents
  FOR EACH ROW EXECUTE FUNCTION enforce_document_hold_label_guard();

-- ── document_versions.revision_label on a held document ─────────────────────
CREATE OR REPLACE FUNCTION enforce_version_hold_label_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();   -- NULL for service-role / SQL console
  v_org   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.revision_label IS NOT DISTINCT FROM OLD.revision_label THEN
    RETURN NEW;
  END IF;
  SELECT d.org_id INTO v_org FROM documents d WHERE d.id = NEW.record_id;
  IF v_org IS NULL OR is_org_controller(v_org) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = NEW.record_id AND h.released_at IS NULL) THEN
    RAISE EXCEPTION
      'Document has an active hold; release the hold before changing a revision label.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_version_hold_label_guard ON document_versions;
CREATE TRIGGER trg_version_hold_label_guard
  BEFORE UPDATE OF revision_label ON document_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_version_hold_label_guard();

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 4. Inventory rows: n = the aggregate count.
SELECT 'documents label rail installed (BEFORE UPDATE OF rev, revision; publish-shaped writes exempt; controllers pass)' AS check,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_hold_label_guard'
                 AND tgrelid = 'documents'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN%'
              AND prosrc LIKE '%is_org_controller(NEW.org_id)%'
              AND prosrc LIKE '%release the hold before changing its revision label.%'
              FROM pg_proc WHERE proname = 'enforce_document_hold_label_guard') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'document_versions label rail installed (BEFORE UPDATE OF revision_label; parent hold; controllers pass)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_version_hold_label_guard'
                 AND tgrelid = 'document_versions'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%h.document_id = NEW.record_id AND h.released_at IS NULL%'
              AND prosrc LIKE '%release the hold before changing a revision label.%'
              FROM pg_proc WHERE proname = 'enforce_version_hold_label_guard'),
       NULL::text
UNION ALL
SELECT 'the publish guard still exists and neither rail is wired to it (this migration owns only its two rails; P4 owns that body)',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger
                        WHERE tgname IN ('trg_document_hold_label_guard', 'trg_version_hold_label_guard')
                          AND tgfoid = 'enforce_document_publish_guard'::regproc),
       NULL::text
UNION ALL
SELECT 'both rails are SECURITY DEFINER with search_path pinned',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('enforce_document_hold_label_guard', 'enforce_version_hold_label_guard')
           AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'),
       NULL::text
UNION ALL
SELECT 'inventory (before apply): ' || what, NULL::boolean, n::text FROM _dc_f74_before;
