-- Document-control Phase 7 — acknowledgment and pin integrity (DIST-3, PKG-5).
--
--   · DIST-3 — distribution_acks UPDATE was any-active-member with no
--     recipient predicate, and the app's acknowledge() filtered by id alone:
--     one person could stamp another's acknowledgment and the PSM
--     "prove the field knew" register became a forgery with no mark. The
--     20260828 hardening fixed this exact shape on document_acknowledgments
--     and document_review_signoffs and skipped this table.
--   · PKG-5 — work_package_documents pins (the data the PUBLIC field verdict
--     reads) were writable by any member with unconstrained values, and the
--     INSERT never bound package_id to the caller's org — a member of org A
--     could inject rows into org B's pack.
--
-- Same design as Phases 3/4: trigger guards for value/identity integrity
-- (service-role writes pass — auth.uid() IS NULL), policy tightening where
-- the shipped app flows allow it.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

-- ── DIST-3: an acknowledgment is the recipient's own act ────────────────────
ALTER TABLE distribution_acks ADD COLUMN IF NOT EXISTS acknowledged_by UUID;
COMMENT ON COLUMN distribution_acks.acknowledged_by IS
  'Who actually stamped acknowledged_at (set by trigger) — a proxy acknowledgment is visible after the fact.';

-- Roster creation may not create acknowledgment (the RG-1 shape): the
-- requester's upsert never sets acknowledged_at, so nothing legitimate breaks.
DROP POLICY IF EXISTS distribution_acks_org_insert ON distribution_acks;
CREATE POLICY distribution_acks_org_insert ON distribution_acks FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = distribution_acks.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND distribution_acks.acknowledged_at IS NULL
);

-- The permissive UPDATE stays (the requester's re-nudge upsert refreshes
-- requested_at/requested_by on RECIPIENTS' rows — a legitimate cross-user
-- write); the guard below owns the acknowledged_at transition specifically.
CREATE OR REPLACE FUNCTION enforce_distribution_ack_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

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

DROP TRIGGER IF EXISTS trg_distribution_ack_guard ON distribution_acks;
CREATE TRIGGER trg_distribution_ack_guard
BEFORE UPDATE ON distribution_acks
FOR EACH ROW EXECUTE FUNCTION enforce_distribution_ack_guard();

-- ── PKG-5: work-package pins feed a public safety verdict ───────────────────
-- INSERT binds the referenced package AND document to the row's own org — a
-- cross-org package_id can never be persisted.
DROP POLICY IF EXISTS work_package_documents_org_insert ON work_package_documents;
CREATE POLICY work_package_documents_org_insert ON work_package_documents FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND EXISTS (SELECT 1 FROM work_packages p
              WHERE p.id = work_package_documents.package_id
                AND p.org_id = work_package_documents.org_id)
  AND EXISTS (SELECT 1 FROM documents d
              WHERE d.id = work_package_documents.document_id
                AND d.org_id = work_package_documents.org_id)
);

-- UPDATE: the package's owner or a controller — the pin is a safety statement,
-- not a convenience. (The /packages "Refresh pins" button remains visible to
-- everyone; a non-owner's refresh now fails with the lib's explicit
-- zero-rows error rather than silently moving pins.) WITH CHECK re-asserts
-- the same authority; identity immutability is the trigger's job.
DROP POLICY IF EXISTS work_package_documents_org_update ON work_package_documents;
CREATE POLICY work_package_documents_org_update ON work_package_documents FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND (
    EXISTS (SELECT 1 FROM work_packages p
            WHERE p.id = work_package_documents.package_id
              AND p.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM org_members m
               WHERE m.org_id = work_package_documents.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND (m.role IN ('Admin','DocCtrl')
                      OR m.roles && ARRAY['Admin','DocCtrl']))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

-- DELETE: same bar as UPDATE — removing the one stale sheet flips a pack's
-- public verdict to green just as effectively as re-pinning it.
DROP POLICY IF EXISTS work_package_documents_org_delete ON work_package_documents;
CREATE POLICY work_package_documents_org_delete ON work_package_documents FOR DELETE USING (
  EXISTS (SELECT 1 FROM work_packages p
          WHERE p.id = work_package_documents.package_id
            AND p.owner_user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = work_package_documents.org_id
               AND m.uid = auth.uid() AND m.status = 'active'
               AND (m.role IN ('Admin','DocCtrl')
                    OR m.roles && ARRAY['Admin','DocCtrl']))
);

-- Trigger: identity immutable, and a pin may only name a version OF THIS
-- row's document in this org — an arbitrary pin value cannot fake freshness.
CREATE OR REPLACE FUNCTION enforce_wpd_pin_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.org_id      IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Work-package membership rows are immutable in identity.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.pinned_version_id IS DISTINCT FROM OLD.pinned_version_id
     AND NEW.pinned_version_id IS NOT NULL
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
BEFORE UPDATE ON work_package_documents
FOR EACH ROW EXECUTE FUNCTION enforce_wpd_pin_guard();

COMMIT;

-- ── Verification (read-only) — expect true / true / true / true ─────────────
SELECT 'distribution ack guard installed' AS check,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_distribution_ack_guard' AND NOT tgisinternal) AS ok
UNION ALL
SELECT 'ack INSERT forbids rows born acknowledged',
       (SELECT with_check LIKE '%acknowledged_at IS NULL%' FROM pg_policies
         WHERE tablename = 'distribution_acks' AND policyname = 'distribution_acks_org_insert')
UNION ALL
SELECT 'pack-pin INSERT binds package+document to the row org',
       (SELECT with_check LIKE '%p.org_id = work_package_documents.org_id%' FROM pg_policies
         WHERE tablename = 'work_package_documents' AND policyname = 'work_package_documents_org_insert')
UNION ALL
SELECT 'pack-pin guard installed',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wpd_pin_guard' AND NOT tgisinternal);
