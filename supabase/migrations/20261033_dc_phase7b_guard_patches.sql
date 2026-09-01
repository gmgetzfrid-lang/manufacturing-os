-- Document-control Phase 7b — guard patches from the Phase-7a self-audit.
--
--   · The acknowledged_by forensic column added by 20261032 was itself
--     forgeable: the deliberately-retained permissive UPDATE policy admits any
--     active member's PATCH, and the guard only touched acknowledged_by inside
--     the acknowledged_at-transition branch — a write that left acknowledged_at
--     alone could rewrite WHO stamped it. The column is now trigger-owned:
--     every user-path write starts from OLD.acknowledged_by, and only the
--     transition branch (the recipient's own act) sets it.
--   · trg_wpd_pin_guard fired only BEFORE UPDATE, so "a pin must name a
--     revision of this row's own document" was not enforced on INSERT — a
--     member could INSERT a row whose pin points at a different document's
--     version and fake freshness that way. The guard now fires on INSERT too.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run. Requires 20261032.

BEGIN;

-- ── acknowledged_by is trigger-owned ────────────────────────────────────────
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
     OR NEW.org_id          IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Distribution-ack rows are immutable in identity.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only the named recipient stamps (or changes) their acknowledgment, and
  -- the row records who stamped it.
  IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
    IF OLD.recipient_user_id::text <> auth.uid()::text THEN
      RAISE EXCEPTION 'Only the named recipient can acknowledge their own distribution.'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.acknowledged_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

-- (trg_distribution_ack_guard keeps its BEFORE UPDATE binding — unchanged.)

-- ── the pin guard also fires on INSERT ──────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_wpd_pin_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.package_id IS DISTINCT FROM OLD.package_id
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.org_id      IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION 'Work-package membership rows are immutable in identity.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- A pin — set at INSERT or changed by UPDATE — may only name a version OF
  -- THIS row's document in this org; an arbitrary value cannot fake freshness.
  IF NEW.pinned_version_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.pinned_version_id IS DISTINCT FROM OLD.pinned_version_id)
     AND NOT EXISTS (
       SELECT 1 FROM document_versions v
       WHERE v.id = NEW.pinned_version_id
         AND v.record_id = NEW.document_id
         AND v.org_id = NEW.org_id
     ) THEN
    RAISE EXCEPTION 'A pin must name a revision of this row''s own document.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wpd_pin_guard ON work_package_documents;
CREATE TRIGGER trg_wpd_pin_guard
BEFORE INSERT OR UPDATE ON work_package_documents
FOR EACH ROW EXECUTE FUNCTION enforce_wpd_pin_guard();

COMMIT;

-- ── Verification (read-only) — expect true / true / true / true ─────────────
SELECT 'ack guard owns acknowledged_by' AS check,
       (SELECT prosrc LIKE '%NEW.acknowledged_by := OLD.acknowledged_by%'
          FROM pg_proc WHERE proname = 'enforce_distribution_ack_guard') AS ok
UNION ALL
SELECT 'pin guard fires on INSERT',
       (SELECT (tgtype::int & 4) = 4 FROM pg_trigger
         WHERE tgname = 'trg_wpd_pin_guard' AND NOT tgisinternal)
UNION ALL
SELECT 'pin guard still fires on UPDATE',
       (SELECT (tgtype::int & 16) = 16 FROM pg_trigger
         WHERE tgname = 'trg_wpd_pin_guard' AND NOT tgisinternal)
UNION ALL
SELECT 'search_path still pinned on both guards',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('enforce_distribution_ack_guard', 'enforce_wpd_pin_guard')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%');
