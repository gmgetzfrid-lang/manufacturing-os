-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F — P5 HOLDS: document_holds integrity
-- (HLD-5, HLD-9, and the holds half of HLD-7).
--
--   HLD-5  document_holds rows were wholly mutable by anyone holding
--          holds.release (the shipped default is '*'): a raw PATCH could release
--          a hold under another person's name, re-date it, re-word it, or set
--          released_at back to NULL — and the only HOLD_RELEASED audit row was
--          the one lib/holds.ts chose to write. A BEFORE UPDATE guard (the
--          20261030 / 20261032 shape) now makes the row immutable in identity
--          (org, document, reason, who placed it and when, the revision it
--          stopped), refuses resurrection, freezes a release record once it is
--          written, requires a release reason, and — for a signed-in caller —
--          pins released_by / released_at / released_by_name to the session and
--          WRITES the HOLD_RELEASED audit_logs row itself, stamping
--          release_recorded_at so the app knows not to write a second one.
--          Service-role writes (the ticket close gate, restores) carry no JWT:
--          the identity, resurrection and reason rules still bind them; the
--          attribution and audit row are that code's own — it names its actor
--          and writes its row (app/api/tickets/workflow-action/route.ts).
--   HLD-9  nothing tied document_holds.org_id to the held document's org: a
--          row carrying the wrong org blocks the document (every enforcement
--          path keys on document_id) while its own org's SELECT policy hides
--          it. A BEFORE INSERT guard refuses any row whose org_id differs from
--          the document's, and the INSERT policy binds the row's org to the
--          document's (the 20261032 PKG-5 shape) on top of the UNCHANGED
--          3-argument capability check the 20261052 probe expects.
--   HLD-7  a hold did not know the revision it stopped, so a printed card and
--          the public verify page could only show whatever the document reads
--          NOW. held_rev_label / held_version_id are captured at open time
--          (derived from the document when the client does not supply them)
--          and pinned with the rest of the row's identity.
--
--   DEC-25: origin_ticket_id is NOT an identity column and stays writable;
--   notes and expected_release_at stay editable on an OPEN hold. A released
--   hold is closed history: nothing on it moves.
--
-- NOT a widening: every rule here refuses something that was allowed. Pre-apply
-- inventory is captured BEFORE the DDL (DEC-30): holds whose org differs from
-- their document's (the HLD-9 population — such a row cannot be repaired in
-- place once identity is pinned; delete and re-place it), released holds with
-- no reason (history the new rule would have refused), open holds with no
-- reason yet and no expected release date (the HLD-14 aging population).
--
-- Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _dc_f73_before AS
SELECT 'holds whose org_id differs from their document''s org (HLD-9: invisible-but-blocking; re-place, do not edit)' AS what, COUNT(*) AS n
  FROM document_holds h JOIN documents d ON d.id = h.document_id
 WHERE h.org_id IS DISTINCT FROM d.org_id
UNION ALL
SELECT 'released holds with no release reason (history the reason rule would have refused)', COUNT(*)
  FROM document_holds WHERE released_at IS NOT NULL AND NULLIF(btrim(released_reason), '') IS NULL
UNION ALL
SELECT 'open holds (their next release must carry a reason and is attributed to the session)', COUNT(*)
  FROM document_holds WHERE released_at IS NULL
UNION ALL
SELECT 'open holds with no expected release date (the HLD-14 age-based nudge population)', COUNT(*)
  FROM document_holds WHERE released_at IS NULL AND expected_release_at IS NULL;

BEGIN;

-- ── HLD-7: the revision a hold stopped, and the guard's own audit stamp ──────
ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS held_rev_label TEXT;
ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS held_version_id UUID;
ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS release_recorded_at TIMESTAMPTZ;
COMMENT ON COLUMN document_holds.held_rev_label IS
  'The document''s rev when the hold was placed (HLD-7): what the card printed and what the verify page shows beside the current rev. Captured at INSERT, immutable after.';
COMMENT ON COLUMN document_holds.held_version_id IS
  'documents.current_version_id when the hold was placed (HLD-7). A recorded pointer, deliberately no FK: the version may later be gone, the record stays.';
COMMENT ON COLUMN document_holds.release_recorded_at IS
  'Set by enforce_document_hold_guard when IT wrote the HOLD_RELEASED audit row for a signed-in release (HLD-5); NULL means the releasing code owns the audit row.';

-- ── HLD-9: a hold carries the org of the document it holds ──────────────────
CREATE OR REPLACE FUNCTION enforce_document_hold_org_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_doc_org uuid;
  v_doc_rev text;
  v_doc_ver uuid;
BEGIN
  SELECT d.org_id, d.rev, d.current_version_id
    INTO v_doc_org, v_doc_rev, v_doc_ver
    FROM documents d WHERE d.id = NEW.document_id;
  IF v_doc_org IS NULL THEN
    RAISE EXCEPTION 'A hold must name an existing document.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- Applies to EVERYONE (service role included): this is a constraint, not an
  -- authority check — a hold in the wrong org is unreachable by the people it
  -- blocks.
  IF NEW.org_id IS DISTINCT FROM v_doc_org THEN
    RAISE EXCEPTION 'A hold must carry the org of the document it holds.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- HLD-7: the hold records the revision it stopped (the client may name it;
  -- a lifecycle copy or a direct insert gets it from the document).
  IF NEW.held_rev_label IS NULL THEN NEW.held_rev_label := v_doc_rev; END IF;
  IF NEW.held_version_id IS NULL THEN NEW.held_version_id := v_doc_ver; END IF;
  -- A row is never born released or pre-recorded.
  NEW.release_recorded_at := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_hold_org_guard ON document_holds;
CREATE TRIGGER trg_document_hold_org_guard
BEFORE INSERT ON document_holds
FOR EACH ROW EXECUTE FUNCTION enforce_document_hold_org_guard();

-- The INSERT policy binds the row's org to the document's on top of the
-- unchanged 3-argument capability check (body from 20260901 + one conjunct).
-- The subquery runs under the caller's documents RLS: a document the caller
-- cannot see resolves to NULL and the row is refused — you cannot hold what
-- you cannot see.
DROP POLICY IF EXISTS document_holds_insert ON document_holds;
CREATE POLICY document_holds_insert ON document_holds FOR INSERT WITH CHECK (
  org_capability_allows(org_id, 'holds.open', auth.uid())
  AND org_id = (SELECT d.org_id FROM documents d WHERE d.id = document_holds.document_id)
);

-- ── HLD-5: a hold row is immutable in identity; a release is the session's own
--    act, carries a reason, and is recorded by the database ───────────────────
CREATE OR REPLACE FUNCTION enforce_document_hold_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();   -- NULL for service-role / SQL console
  v_name  text;
  v_email text;
  v_role  text;
BEGIN
  -- Identity is immutable — for everyone, service role included (the legal-hold
  -- delete guards take the same stance): a hold cannot be repointed, re-dated,
  -- re-attributed or re-worded after the fact.
  IF NEW.org_id             IS DISTINCT FROM OLD.org_id
     OR NEW.document_id     IS DISTINCT FROM OLD.document_id
     OR NEW.reason          IS DISTINCT FROM OLD.reason
     OR NEW.opened_by       IS DISTINCT FROM OLD.opened_by
     OR NEW.opened_by_name  IS DISTINCT FROM OLD.opened_by_name
     OR NEW.opened_at       IS DISTINCT FROM OLD.opened_at
     OR NEW.held_rev_label  IS DISTINCT FROM OLD.held_rev_label
     OR NEW.held_version_id IS DISTINCT FROM OLD.held_version_id THEN
    RAISE EXCEPTION 'Hold rows are immutable in identity (document, reason, who placed it and when).'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A released hold is closed history: it is never reopened (place a new one)
  -- and its release record is never rewritten.
  IF OLD.released_at IS NOT NULL THEN
    IF NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'A released hold cannot be reopened; place a new hold instead.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.released_at            IS DISTINCT FROM OLD.released_at
       OR NEW.released_by         IS DISTINCT FROM OLD.released_by
       OR NEW.released_by_name    IS DISTINCT FROM OLD.released_by_name
       OR NEW.released_reason     IS DISTINCT FROM OLD.released_reason
       OR NEW.release_recorded_at IS DISTINCT FROM OLD.release_recorded_at THEN
      RAISE EXCEPTION 'The release record of a hold cannot be rewritten.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Still open and staying open: notes, expected_release_at and
  -- origin_ticket_id (DEC-25) may move; release attribution may not appear
  -- without a release.
  IF NEW.released_at IS NULL THEN
    IF NEW.released_by            IS DISTINCT FROM OLD.released_by
       OR NEW.released_by_name    IS DISTINCT FROM OLD.released_by_name
       OR NEW.released_reason     IS DISTINCT FROM OLD.released_reason
       OR NEW.release_recorded_at IS DISTINCT FROM OLD.release_recorded_at THEN
      RAISE EXCEPTION 'Release attribution can only be written by releasing the hold.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- The release transition (open → released). A stop-work is lifted for a
  -- stated reason, by a named person, at a database-recorded time.
  IF NULLIF(btrim(NEW.released_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A release reason is required — say what cleared the hold.'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.release_recorded_at := NULL;

  IF v_actor IS NULL THEN
    -- Service role: the calling code names its actor and writes its own
    -- HOLD_RELEASED row; the release must still name someone.
    IF NEW.released_by IS NULL THEN
      RAISE EXCEPTION 'A release must name who released the hold.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Signed-in caller: attribution is the session, not the payload.
  NEW.released_by := v_actor;
  NEW.released_at := now();
  -- DEC-2 / ADD-1: the audit row records the role COLLECTION, never the
  -- headline alone (the same COALESCE(roles, ARRAY[role]) idiom the census pins).
  SELECT COALESCE(NULLIF(btrim(m.display_name), ''), m.email), m.email,
         array_to_string(COALESCE(NULLIF(m.roles, '{}'::text[]), ARRAY[m.role]), ',')
    INTO v_name, v_email, v_role
    FROM org_members m
   WHERE m.org_id = NEW.org_id AND m.uid = v_actor
   LIMIT 1;
  IF v_name IS NOT NULL THEN
    NEW.released_by_name := v_name;
  END IF;

  -- The audit row the trail cannot lose: written here, by the database, for
  -- every signed-in release however it was issued. The app (lib/holds.ts)
  -- sees release_recorded_at on the returned row and does not write a second.
  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details)
  VALUES ('HOLD_RELEASED', NEW.document_id::text, 'document', NEW.org_id, v_actor, v_email, v_role,
          jsonb_build_object(
            'holdId', NEW.id,
            'reason', NEW.reason,
            'releasedReason', NEW.released_reason,
            'durationMs', (EXTRACT(EPOCH FROM (NEW.released_at - NEW.opened_at)) * 1000)::bigint,
            'source', 'document_holds_guard'));
  NEW.release_recorded_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_hold_guard ON document_holds;
CREATE TRIGGER trg_document_hold_guard
BEFORE UPDATE ON document_holds
FOR EACH ROW EXECUTE FUNCTION enforce_document_hold_guard();

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 6. Inventory rows: n = the aggregate count.
SELECT 'hold guard installed BEFORE UPDATE on document_holds (identity pinned, no resurrection, reason required)' AS check,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_hold_guard'
                 AND tgrelid = 'document_holds'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%Hold rows are immutable in identity%'
              AND prosrc LIKE '%A released hold cannot be reopened; place a new hold instead.%'
              AND prosrc LIKE '%A release reason is required%'
              FROM pg_proc WHERE proname = 'enforce_document_hold_guard') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'hold guard pins a signed-in release to the session and writes the HOLD_RELEASED audit row itself',
       (SELECT prosrc LIKE '%NEW.released_by := v_actor;%'
          AND prosrc LIKE '%INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details)%'
          AND prosrc LIKE '%''source'', ''document_holds_guard''%'
          AND prosrc LIKE '%NEW.release_recorded_at := now();%'
          FROM pg_proc WHERE proname = 'enforce_document_hold_guard'),
       NULL::text
UNION ALL
SELECT 'org guard installed BEFORE INSERT on document_holds (org must match the document; held rev captured)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_hold_org_guard'
                 AND tgrelid = 'document_holds'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%A hold must carry the org of the document it holds.%'
              AND prosrc LIKE '%NEW.held_rev_label := v_doc_rev;%'
              FROM pg_proc WHERE proname = 'enforce_document_hold_org_guard'),
       NULL::text
UNION ALL
SELECT 'document_holds INSERT policy binds org to the document and still calls the 3-argument org_capability_allows',
       (SELECT with_check LIKE '%org_capability_allows(%'
          AND with_check LIKE '%''holds.open''%'
          AND with_check LIKE '%d.id = document_holds.document_id%'
          FROM pg_policies WHERE tablename = 'document_holds' AND policyname = 'document_holds_insert'),
       NULL::text
UNION ALL
SELECT 'held_rev_label, held_version_id and release_recorded_at exist on document_holds',
       (SELECT COUNT(*) = 3 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'document_holds'
           AND column_name IN ('held_rev_label', 'held_version_id', 'release_recorded_at')),
       NULL::text
UNION ALL
SELECT 'both guards are SECURITY DEFINER with search_path pinned',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('enforce_document_hold_guard', 'enforce_document_hold_org_guard')
           AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'),
       NULL::text
UNION ALL
SELECT 'inventory (before apply): ' || what, NULL::boolean, n::text FROM _dc_f73_before
UNION ALL
SELECT 'inventory (after apply): open holds with no held_rev_label (placed before this migration; the rev they stopped is not knowable after the fact — left NULL, shown as unknown)',
       NULL::boolean, COUNT(*)::text
  FROM document_holds WHERE released_at IS NULL AND held_rev_label IS NULL;
