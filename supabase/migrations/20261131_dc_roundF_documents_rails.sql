-- ─────────────────────────────────────────────────────────────────────────────
-- 20261131_dc_roundF_documents_rails.sql
--
-- document-control Round F wave 2 — P3 LIFECYCLE: the documents-table rails.
-- DRLS-3 (the register label moves without the file), DRLS-14 (version
-- pointers with no referential rail; child evidence cascaded away), DRLS-13
-- (any member may insert or delete the supersession map), REV-14 (the
-- supersession pair must be unique for the lineage upsert).
--
--   DRLS-3   `documents` had no guard on rev / revision / document_number /
--            effective_date: the publish guard returns early unless the
--            write is "advancing", so any active member could PATCH the
--            register label to a revision the file is not. A new rail,
--            trg_document_register_rail (BEFORE UPDATE OF rev, revision,
--            document_number, effective_date, current_version_id,
--            pending_version_id), refuses a change to any of the four
--            register fields by anyone outside the publisher tier (the org's
--            controllers — is_org_controller, the role COLLECTION —, a
--            publisher granted on the library, or the document's effective
--            owner: the population the publish guard admits), and keeps
--            rev / revision equal to the revision_label of the row named by
--            current_version_id whenever either side moves. The one
--            tolerated form is the review promote: pointing at an in-review
--            draft with its base label ('2A' promotes as '2'; the relabel
--            follows in finalizeReviewedRevision). The other direction is a
--            sync, not a refusal: trg_sync_current_version_label (AFTER
--            UPDATE OF revision_label ON document_versions) carries a CURRENT
--            revision's corrected label onto its document in the same
--            statement — which also runs the rail, so only the publisher
--            tier can relabel a current revision at all.
--   DRLS-14  documents.current_version_id / pending_version_id are
--            enforced as references to a revision OF THIS DOCUMENT:
--              · on UPDATE, for every caller (service role included), a
--                pointer that moves must name an existing version whose
--                record_id is the document (the rail above);
--              · on DELETE of a version, trg_document_versions_pointer_rail
--                (a constraint trigger, end of statement — the NO ACTION
--                timing, so a whole-document or whole-org cascade still
--                passes) refuses while any document names it as current,
--                and clears a pending pointer to it (SET NULL semantics: a
--                draft that no longer exists is not pending).
--              · on INSERT by a signed-in caller, trg_document_insert_pointer_rail
--                requires both pointers to be NULL: no genuine creation flow
--                sets them at insert (a version references its document, so
--                it cannot exist first), and a member could otherwise create
--                a document already pointing at another document's revision
--                (or a dangling id) — a write neither the publish guard nor
--                the register rail (both BEFORE UPDATE) would see. The
--                service role (auth.uid() NULL) is exempt: the restore
--                replays documents before their versions.
--            They are deliberately NOT declared FOREIGN KEYs: the restore
--            replays `documents` before `document_versions`
--            (lib/dataRestore.ts RESTORE_TABLE_ORDER — versions reference
--            their document), so a declared FK would refuse every restored
--            document that has a current revision.
--            DEC-44 (P3 LIFECYCLE; provisional number,
--            renumbered on merge) records the call.
--            The child evidence tables now agree: distribution_acks.version_id
--            goes from ON DELETE CASCADE to NO ACTION, and
--            document_acknowledgments / document_review_signoffs gain the FK
--            they never had (NO ACTION) — deleting a revision that carries
--            acknowledgment or sign-off evidence is REFUSED instead of
--            cascading it away (distribution_acks) or orphaning it (the other
--            two). A whole-document delete still cascades through
--            document_id, as it always did (legal hold governs that) — so
--            the evidence survives a VERSION delete, not a document delete
--            (DRLS-14 stays open on that half; DRLS-17 records the library
--            page's delete flow, which this rail now stops part-way). Where
--            orphaned evidence already exists the FK is added NOT VALID:
--            every new row is bound, the residue is counted, never deleted.
--            work_package_documents.pinned_version_id (NO ACTION) and
--            revision_branches.branch_version_id (CASCADE — bookkeeping about
--            the version itself, not evidence about people) are unchanged.
--   DRLS-13  document_supersessions had one policy, FOR ALL to any active
--            member: any Viewer could delete a supersession link or assert
--            that any document supersedes any other. Now: SELECT any active
--            member (unchanged read); INSERT / UPDATE only when
--            supersession_writable() — an active member with publish
--            authority on the SUPERSEDED document (controller, library
--            publisher or its effective owner), both documents in the row's
--            org; DELETE the org's controllers only.
--   REV-13   documents.effective_date is a copy of the CURRENT revision's:
--            whenever current_version_id moves — by any door, the
--            service-role intake auto-publish included — the register rail
--            copies the new revision's effective_date onto the document and
--            sets the announcement watermark: stamped when there is nothing
--            to announce (no date, or a date before yesterday in UTC — past
--            in every zone), cleared when the date may still be ahead in the
--            facility's calendar, which the app's scan decides (REV-9).
--   REV-14   supersedeDocument / markSupersededAndLink write lineage as an
--            upsert on (superseded_doc_id, replacement_doc_id). The unique
--            constraint exists in 20260526; if a database lacks it, a unique
--            index is built here — only in the world with no duplicate pair
--            (the inventory counts them; nothing is deleted).
--
-- NOT a widening: every rule refuses something that was allowed. DEC-30
-- inventories (aggregate counts, captured BEFORE the transaction): dangling
-- and cross-document pointers (DRLS-14), documents whose rev / revision
-- differ from their current revision's label (DRLS-3 — they are not
-- rewritten; the rail binds the next change), documents whose effective date
-- is not their current revision's (REV-13 — not rewritten; the next pointer
-- move reconciles), duplicate supersession pairs
-- (REV-14), orphaned evidence (the NOT VALID world), Superseded documents
-- with no lineage row (REV-14's visible-warning population).
-- ⚠ NOT PASTEABLE YET — PREREQUISITES (document-control 99-fix-sequencing.md):
-- do not paste this until BOTH library-page fixes are DEPLOYED: the metadata
-- save stops sending a changed rev and surfaces refusals (DRLS-15), and the
-- delete flow stops clearing the pointer before deleting versions
-- (DRLS-17). Pasted earlier, both break from this paste on — every edit in
-- a save that touches Rev is silently lost, and a delete stops part-way
-- leaving a live document with no current file.
-- HOW TO APPLY: after 20261130. Single paste: temp-table inventory →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_131_before;
CREATE TEMP TABLE dc_round_f_131_before AS
SELECT 'inventory (before apply): documents whose current_version_id names no revision (DRLS-14 dangling)' AS inventory,
       COUNT(*)::text AS n
  FROM documents d
 WHERE d.current_version_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.id = d.current_version_id)
UNION ALL
SELECT 'inventory (before apply): documents whose current_version_id names ANOTHER document''s revision (DRLS-14)',
       COUNT(*)::text
  FROM documents d JOIN document_versions v ON v.id = d.current_version_id
 WHERE v.record_id <> d.id
UNION ALL
SELECT 'inventory (before apply): documents whose pending_version_id names no revision (DRLS-14 dangling)',
       COUNT(*)::text
  FROM documents d
 WHERE d.pending_version_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.id = d.pending_version_id)
UNION ALL
SELECT 'inventory (before apply): documents whose pending_version_id names ANOTHER document''s revision (DRLS-14)',
       COUNT(*)::text
  FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
 WHERE v.record_id <> d.id
UNION ALL
SELECT 'inventory (before apply): documents whose rev differs from the current revision''s label (DRLS-3; not rewritten — the rail binds the next change)',
       COUNT(*)::text
  FROM documents d JOIN document_versions v ON v.id = d.current_version_id
 WHERE btrim(COALESCE(d.rev, '')) <> btrim(COALESCE(v.revision_label, ''))
UNION ALL
SELECT 'inventory (before apply): documents whose revision (when set) differs from the current revision''s label (DRLS-3)',
       COUNT(*)::text
  FROM documents d JOIN document_versions v ON v.id = d.current_version_id
 WHERE d.revision IS NOT NULL AND btrim(d.revision) <> btrim(COALESCE(v.revision_label, ''))
UNION ALL
SELECT 'inventory (before apply): documents whose effective_date differs from their current revision''s (REV-13; not rewritten — the next pointer move reconciles)',
       COUNT(*)::text
  FROM documents d JOIN document_versions v ON v.id = d.current_version_id
 WHERE d.effective_date IS DISTINCT FROM v.effective_date
UNION ALL
SELECT 'inventory (before apply): duplicate document_supersessions pairs (REV-14; the pair index is built only at 0)',
       COUNT(*)::text
  FROM (SELECT 1 FROM document_supersessions
         GROUP BY superseded_doc_id, replacement_doc_id HAVING COUNT(*) > 1) dup
UNION ALL
SELECT 'inventory (before apply): supersession rows whose documents are not both in the row''s org (DRLS-13; kept, never deleted)',
       COUNT(*)::text
  FROM document_supersessions s
 WHERE NOT EXISTS (SELECT 1 FROM documents a WHERE a.id = s.superseded_doc_id AND a.org_id = s.org_id)
    OR NOT EXISTS (SELECT 1 FROM documents b WHERE b.id = s.replacement_doc_id AND b.org_id = s.org_id)
UNION ALL
SELECT 'inventory (before apply): Superseded documents with no supersession row (retired with nothing pointing forward)',
       COUNT(*)::text
  FROM documents d
 WHERE d.status = 'Superseded'
   AND NOT EXISTS (SELECT 1 FROM document_supersessions s WHERE s.superseded_doc_id = d.id)
UNION ALL
SELECT 'inventory (before apply): document_acknowledgments naming a revision that no longer exists (their FK is added NOT VALID when > 0)',
       COUNT(*)::text
  FROM document_acknowledgments a
 WHERE a.document_version_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.id = a.document_version_id)
UNION ALL
SELECT 'inventory (before apply): document_review_signoffs naming a revision that no longer exists (their FK is added NOT VALID when > 0)',
       COUNT(*)::text
  FROM document_review_signoffs s
 WHERE s.document_version_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.id = s.document_version_id);

BEGIN;

-- ── DRLS-3 + DRLS-14: the register rail on documents ────────────────────────
CREATE OR REPLACE FUNCTION enforce_document_register_rail()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor     uuid    := auth.uid();   -- NULL for service-role / SQL console
  v_ptr_moved boolean := NEW.current_version_id IS DISTINCT FROM OLD.current_version_id;
  v_rev_moved boolean := (NEW.rev IS DISTINCT FROM OLD.rev) OR (NEW.revision IS DISTINCT FROM OLD.revision);
  v_eff_moved boolean := NEW.effective_date IS DISTINCT FROM OLD.effective_date;
  v_label     text;
  v_base      text;
  v_state     text;
  v_promote   boolean;
  v_eff       date;
BEGIN
  -- DRLS-14: a pointer that MOVES names a revision of THIS document — for
  -- every caller, the service role included (a signed-in INSERT is railed by
  -- trg_document_insert_pointer_rail; a service-role INSERT is not: a
  -- restore replays documents before their versions).
  IF v_ptr_moved AND NEW.current_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM document_versions v
                      WHERE v.id = NEW.current_version_id AND v.record_id = NEW.id) THEN
    RAISE EXCEPTION 'current_version_id must name a revision of this document.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.pending_version_id IS DISTINCT FROM OLD.pending_version_id AND NEW.pending_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM document_versions v
                      WHERE v.id = NEW.pending_version_id AND v.record_id = NEW.id) THEN
    RAISE EXCEPTION 'pending_version_id must name a revision of this document.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- REV-13: the document's effective date is its CURRENT revision's — copied
  -- whenever the pointer moves, by every door (the service-role intake
  -- auto-publish included), so a withdrawn revision's future date never
  -- outlives it on the register. The watermark is stamped only when there is
  -- nothing left to announce: no date, or a date before yesterday in UTC
  -- (past in every zone). A date that may still be ahead in the facility's
  -- calendar leaves it clear; the app's scan decides in that calendar
  -- (REV-9), and applyEffectiveDate re-decides after an app publish.
  IF v_ptr_moved THEN
    SELECT v.effective_date INTO v_eff
      FROM document_versions v WHERE v.id = NEW.current_version_id;
    NEW.effective_date := v_eff;
    IF v_eff IS NULL OR v_eff < (now() AT TIME ZONE 'UTC')::date - 1 THEN
      NEW.effective_notified_at := now();
    ELSE
      NEW.effective_notified_at := NULL;
    END IF;
  END IF;

  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  -- DRLS-3: the register fields are the publisher tier's (the caller's own
  -- change to the effective date — not the REV-13 copy above).
  IF (v_rev_moved
      OR NEW.document_number IS DISTINCT FROM OLD.document_number
      OR v_eff_moved)
     AND NOT is_org_controller(NEW.org_id)
     AND NOT user_can_publish_on_library(NEW.library_id, v_actor::text, NEW.org_id)
     AND NOT user_is_effective_owner(NEW.owner_user_id, NEW.collection_id, NEW.library_id, v_actor) THEN
    RAISE EXCEPTION 'Only a publisher on this library (or the document''s owner) may change its revision label, number or effective date.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- DRLS-3: the label is the current revision's label. The review promote
  -- may carry the in-review draft's base label (finalize relabels next).
  IF NEW.current_version_id IS NOT NULL AND (v_ptr_moved OR v_rev_moved) THEN
    SELECT btrim(COALESCE(v.revision_label, '')), btrim(COALESCE(v.base_rev, '')), v.review_state
      INTO v_label, v_base, v_state
      FROM document_versions v WHERE v.id = NEW.current_version_id;
    IF FOUND THEN
      v_promote := v_ptr_moved AND v_state = 'in_review' AND v_base <> '';
      IF NOT (btrim(COALESCE(NEW.rev, '')) = v_label
              OR (v_promote AND btrim(COALESCE(NEW.rev, '')) = v_base))
         OR (NEW.revision IS NOT NULL
             AND (v_ptr_moved OR NEW.revision IS DISTINCT FROM OLD.revision)
             AND NOT (btrim(NEW.revision) = v_label
                      OR (v_promote AND btrim(NEW.revision) = v_base))) THEN
        RAISE EXCEPTION 'The document''s revision label must match its current revision (Rev %). Correct the label on the revision itself.', v_label
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_register_rail ON documents;
CREATE TRIGGER trg_document_register_rail
  BEFORE UPDATE OF rev, revision, document_number, effective_date, current_version_id, pending_version_id ON documents
  FOR EACH ROW EXECUTE FUNCTION enforce_document_register_rail();

-- ── DRLS-14: a signed-in INSERT is born with no version pointers ────────────
CREATE OR REPLACE FUNCTION enforce_document_insert_pointer_rail()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- The service role (auth.uid() NULL) is exempt: the restore replays
  -- documents before the versions their pointers name.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.current_version_id IS NOT NULL OR NEW.pending_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'A new document is created without a current or pending revision; its first revision is attached once the document exists.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_insert_pointer_rail ON documents;
CREATE TRIGGER trg_document_insert_pointer_rail
  BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION enforce_document_insert_pointer_rail();

-- ── DRLS-3: a CURRENT revision's corrected label is the document's label ────
CREATE OR REPLACE FUNCTION sync_current_version_label()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.revision_label IS NOT DISTINCT FROM OLD.revision_label THEN
    RETURN NULL;
  END IF;
  UPDATE documents
     SET rev = NEW.revision_label,
         revision = NEW.revision_label
   WHERE current_version_id = NEW.id
     AND (rev IS DISTINCT FROM NEW.revision_label OR revision IS DISTINCT FROM NEW.revision_label);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_current_version_label ON document_versions;
CREATE TRIGGER trg_sync_current_version_label
  AFTER UPDATE OF revision_label ON document_versions
  FOR EACH ROW EXECUTE FUNCTION sync_current_version_label();

-- ── DRLS-14: a revision a document names as current cannot be deleted ───────
CREATE OR REPLACE FUNCTION enforce_document_versions_pointer_rail()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM documents d WHERE d.current_version_id = OLD.id) THEN
    RAISE EXCEPTION 'This revision is a document''s current revision and cannot be deleted; publish or revert to another revision first.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  UPDATE documents SET pending_version_id = NULL WHERE pending_version_id = OLD.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_versions_pointer_rail ON document_versions;
CREATE CONSTRAINT TRIGGER trg_document_versions_pointer_rail
  AFTER DELETE ON document_versions
  NOT DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_document_versions_pointer_rail();

-- ── DRLS-14: acknowledgment and sign-off evidence survives, never cascades ──
DO $$
DECLARE
  v_con  text;
  v_del  "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO v_con, v_del
    FROM pg_constraint c
   WHERE c.conrelid = 'distribution_acks'::regclass AND c.contype = 'f'
     AND c.confrelid = 'document_versions'::regclass
     AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                            WHERE a.attrelid = 'distribution_acks'::regclass AND a.attname = 'version_id')]::smallint[];
  IF v_con IS NOT NULL AND v_del <> 'a' THEN
    EXECUTE format('ALTER TABLE distribution_acks DROP CONSTRAINT %I', v_con);
    v_con := NULL;
  END IF;
  IF v_con IS NULL THEN
    ALTER TABLE distribution_acks
      ADD CONSTRAINT distribution_acks_version_id_fkey
      FOREIGN KEY (version_id) REFERENCES document_versions(id) ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_acknowledgments_version_fkey') THEN
    IF EXISTS (SELECT 1 FROM document_acknowledgments a
                WHERE a.document_version_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.id = a.document_version_id)) THEN
      ALTER TABLE document_acknowledgments
        ADD CONSTRAINT document_acknowledgments_version_fkey
        FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE NO ACTION NOT VALID;
      RAISE NOTICE 'document_acknowledgments_version_fkey added NOT VALID: orphaned rows exist (see the inventory)';
    ELSE
      ALTER TABLE document_acknowledgments
        ADD CONSTRAINT document_acknowledgments_version_fkey
        FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE NO ACTION;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_review_signoffs_version_fkey') THEN
    IF EXISTS (SELECT 1 FROM document_review_signoffs s
                WHERE s.document_version_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.id = s.document_version_id)) THEN
      ALTER TABLE document_review_signoffs
        ADD CONSTRAINT document_review_signoffs_version_fkey
        FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE NO ACTION NOT VALID;
      RAISE NOTICE 'document_review_signoffs_version_fkey added NOT VALID: orphaned rows exist (see the inventory)';
    ELSE
      ALTER TABLE document_review_signoffs
        ADD CONSTRAINT document_review_signoffs_version_fkey
        FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE NO ACTION;
    END IF;
  END IF;
END $$;

-- ── REV-14: one row per supersession pair (the lineage upsert's target) ─────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'document_supersessions'::regclass AND i.indisunique AND i.indpred IS NULL
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(i.indkey::int2[]) k
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k)
           = ARRAY['replacement_doc_id', 'superseded_doc_id']
  ) THEN
    IF EXISTS (SELECT 1 FROM document_supersessions
                GROUP BY superseded_doc_id, replacement_doc_id HAVING COUNT(*) > 1) THEN
      RAISE NOTICE 'document_supersessions pair index NOT built: duplicate pairs exist (see the inventory) — reconcile and re-run';
    ELSE
      CREATE UNIQUE INDEX document_supersessions_pair_uniq
        ON document_supersessions (superseded_doc_id, replacement_doc_id);
    END IF;
  END IF;
END $$;

-- ── DRLS-13: who may write the supersession map ─────────────────────────────
CREATE OR REPLACE FUNCTION supersession_writable(p_org uuid, p_superseded uuid, p_replacement uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = p_org AND m.uid = auth.uid() AND m.status = 'active')
     AND EXISTS (SELECT 1 FROM documents s
                  WHERE s.id = p_superseded AND s.org_id = p_org
                    AND (is_org_controller(p_org)
                         OR user_can_publish_on_library(s.library_id, auth.uid()::text, s.org_id)
                         OR user_is_effective_owner(s.owner_user_id, s.collection_id, s.library_id, auth.uid())))
     AND EXISTS (SELECT 1 FROM documents r
                  WHERE r.id = p_replacement AND r.org_id = p_org);
$$;
REVOKE ALL ON FUNCTION supersession_writable(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION supersession_writable(uuid, uuid, uuid) TO authenticated;

ALTER TABLE document_supersessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_supersessions_member_all" ON document_supersessions;
DROP POLICY IF EXISTS document_supersessions_select ON document_supersessions;
DROP POLICY IF EXISTS document_supersessions_insert ON document_supersessions;
DROP POLICY IF EXISTS document_supersessions_update ON document_supersessions;
DROP POLICY IF EXISTS document_supersessions_delete ON document_supersessions;
CREATE POLICY document_supersessions_select ON document_supersessions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = document_supersessions.org_id AND m.uid = auth.uid() AND m.status = 'active'));
CREATE POLICY document_supersessions_insert ON document_supersessions
  FOR INSERT TO authenticated
  WITH CHECK (supersession_writable(org_id, superseded_doc_id, replacement_doc_id));
CREATE POLICY document_supersessions_update ON document_supersessions
  FOR UPDATE TO authenticated
  USING (supersession_writable(org_id, superseded_doc_id, replacement_doc_id))
  WITH CHECK (supersession_writable(org_id, superseded_doc_id, replacement_doc_id));
CREATE POLICY document_supersessions_delete ON document_supersessions
  FOR DELETE TO authenticated
  USING (is_org_controller(org_id));

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 11. Inventory rows: n = the aggregate count.
SELECT 'register rail installed on documents (BEFORE UPDATE OF rev, revision, document_number, effective_date, current_version_id, pending_version_id)' AS check,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_register_rail'
                 AND tgrelid = 'documents'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%must name a revision of this document%'
               AND prosrc LIKE '%NOT is_org_controller(NEW.org_id)%'
               AND prosrc LIKE '%NOT user_can_publish_on_library(NEW.library_id, v_actor::text, NEW.org_id)%'
               AND prosrc LIKE '%NOT user_is_effective_owner(NEW.owner_user_id, NEW.collection_id, NEW.library_id, v_actor)%'
               AND prosrc LIKE '%must match its current revision%'
               AND prosrc LIKE '%v_state = ''in_review''%'
              FROM pg_proc WHERE proname = 'enforce_document_register_rail') AS ok,
       NULL::text AS n
UNION ALL SELECT 'REV-13: a pointer move copies the new current revision''s effective date onto the document, the watermark cleared while the date may be ahead',
       (SELECT prosrc LIKE '%NEW.effective_date := v_eff;%'
               AND prosrc LIKE '%NEW.effective_notified_at := NULL;%'
               AND prosrc LIKE '%(now() AT TIME ZONE ''UTC'')::date - 1%'
               AND prosrc LIKE '%OR v_eff_moved)%'
              FROM pg_proc WHERE proname = 'enforce_document_register_rail'), NULL
UNION ALL SELECT 'DRLS-14: a signed-in INSERT may not set current_version_id or pending_version_id (BEFORE INSERT; the service role exempt for the restore)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_insert_pointer_rail'
                 AND tgrelid = 'documents'::regclass AND NOT tgisinternal
                 AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT ON public.documents FOR EACH ROW%')
       AND (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN%'
               AND prosrc LIKE '%NEW.current_version_id IS NOT NULL OR NEW.pending_version_id IS NOT NULL%'
              FROM pg_proc WHERE proname = 'enforce_document_insert_pointer_rail'), NULL
UNION ALL SELECT 'a corrected label on a CURRENT revision is carried onto its document (AFTER UPDATE OF revision_label)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_current_version_label'
                 AND tgrelid = 'document_versions'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%WHERE current_version_id = NEW.id%'
              FROM pg_proc WHERE proname = 'sync_current_version_label'), NULL
UNION ALL SELECT 'deleting a document''s current revision is refused at end of statement; a pending pointer to a deleted draft is cleared',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_versions_pointer_rail'
                 AND tgrelid = 'document_versions'::regclass AND tgconstraint <> 0 AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%WHERE d.current_version_id = OLD.id%'
               AND prosrc LIKE '%SET pending_version_id = NULL WHERE pending_version_id = OLD.id%'
              FROM pg_proc WHERE proname = 'enforce_document_versions_pointer_rail'), NULL
UNION ALL SELECT 'distribution_acks.version_id no longer cascades (NO ACTION)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'distribution_acks'::regclass AND contype = 'f'
                  AND confrelid = 'document_versions'::regclass AND confdeltype = 'a'), NULL
UNION ALL SELECT 'document_acknowledgments and document_review_signoffs reference their revision (NO ACTION; NOT VALID only where orphans exist)',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_acknowledgments_version_fkey' AND confdeltype = 'a')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_review_signoffs_version_fkey' AND confdeltype = 'a'), NULL
UNION ALL SELECT 'document_supersessions has a unique (superseded_doc_id, replacement_doc_id) — or duplicates exist (see the inventory)',
       EXISTS (SELECT 1 FROM pg_index i
                WHERE i.indrelid = 'document_supersessions'::regclass AND i.indisunique AND i.indpred IS NULL
                  AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                         FROM unnest(i.indkey::int2[]) k
                         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k)
                      = ARRAY['replacement_doc_id', 'superseded_doc_id'])
       OR EXISTS (SELECT 1 FROM document_supersessions
                   GROUP BY superseded_doc_id, replacement_doc_id HAVING COUNT(*) > 1), NULL
UNION ALL SELECT 'document_supersessions: no FOR ALL policy; INSERT/UPDATE need supersession_writable; DELETE is controller-only',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_supersessions' AND cmd = 'ALL')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_supersessions' AND policyname = 'document_supersessions_insert'
                    AND cmd = 'INSERT' AND with_check LIKE '%supersession_writable(%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_supersessions' AND policyname = 'document_supersessions_update'
                    AND cmd = 'UPDATE' AND qual LIKE '%supersession_writable(%' AND with_check LIKE '%supersession_writable(%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_supersessions' AND policyname = 'document_supersessions_delete'
                    AND cmd = 'DELETE' AND qual LIKE '%is_org_controller(%')
       AND (SELECT COUNT(*) = 4 FROM pg_policies WHERE tablename = 'document_supersessions'), NULL
UNION ALL SELECT 'supersession_writable demands publish authority on the superseded document and both documents in the row''s org',
       (SELECT prosrc LIKE '%user_can_publish_on_library(s.library_id, auth.uid()::text, s.org_id)%'
               AND prosrc LIKE '%r.id = p_replacement AND r.org_id = p_org%'
              FROM pg_proc WHERE proname = 'supersession_writable')
       AND has_function_privilege('authenticated', 'supersession_writable(uuid, uuid, uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'supersession_writable(uuid, uuid, uuid)', 'EXECUTE'), NULL
UNION ALL SELECT 'every function this paste creates is SECURITY DEFINER with search_path pinned',
       (SELECT COUNT(*) = 5 FROM pg_proc
         WHERE proname IN ('enforce_document_register_rail', 'sync_current_version_label',
                           'enforce_document_versions_pointer_rail', 'supersession_writable',
                           'enforce_document_insert_pointer_rail')
           AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'), NULL
UNION ALL SELECT inventory, NULL::boolean, n FROM dc_round_f_131_before;
