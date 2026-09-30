-- 20261104_prj_roundG_intake_links.sql
--
-- projects Round G — J1 INTAKE-DOOR, migration A (projects-and-cost INTK-1,
-- INTK-9, INTK-14, INTK-8, PM-2; projects-tab SEC-3, SEC-12, SEC-11, SEC-5,
-- SEC-8). The contractor intake link as a bounded credential.
--
-- WHAT:
--   1. documents.authored_by_link_id — the ONE authorship fact (INTK-1 /
--      SEC-3 / SEC-12). The intake route stamps it when it CREATES a
--      document and never again; "may this link auto-publish?" reads it,
--      never the version chain the route keeps appending to. Backfilled from
--      each document's FIRST version (lowest created_at): a document whose
--      first version came through a link was born through that link; an
--      org document the link was later ASSIGNED was not.
--   2. trg_intake_links_assignment_guard — BEFORE INSERT OR UPDATE OF
--      assigned_doc_ids on project_intake_links (INTK-9 / SEC-11): every
--      newly assigned document must exist in the LINK'S org, and the writer
--      must hold publish authority on that document's library
--      (is_org_controller OR user_can_publish_on_library) — assigning a
--      controlled document to an outside company is a publish-grade act, not
--      a project-ownership one. At most 500 entries. Service-role / SQL
--      writes (no JWT) are exempt, as every rail since 20260831. A trigger,
--      not a second permissive policy (the cluster-3 lesson).
--   3. (section 3b) bump_intake_use(p_link uuid, p_bytes bigint DEFAULT 0) — REVOKEd from
--      PUBLIC, anon and authenticated; EXECUTE to service_role only
--      (INTK-14; the 20260930 pattern). The one-argument form is dropped and
--      re-created with a byte count (the per-link storage budget, INTK-8).
--   4. project_intake_links.project_id REFERENCES projects(id) ON DELETE
--      CASCADE (PM-2): deleting a project closes its contractor doors. Two
--      worlds (DEC-30): links whose project is already gone are REVOKED
--      first (a door with no project behind it, nobody left to revoke it) and
--      the constraint is added NOT VALID — binding every new row — then
--      VALIDATEd only when no orphan remains. Orphans are never deleted: the
--      documents they submitted keep their provenance.
--   5. Link lifetime (SEC-5): every link created from now on must carry an
--      expiry no later than created_at + 91 days (the 90-day policy plus one
--      day for an end-of-day local expiry). Rows created before this
--      migration are grandfathered by the CHECK (a literal apply timestamp),
--      and live DOCUMENT links with no expiry get one: 14 days from apply —
--      a real TTL without cutting off a contractor mid-job. Quote links are
--      left to 20261096's blocked backfill (INTK-12's decision).
--   6. (section 3a, before the counter that fills it) Per-link budget
--      (INTK-8 dw4): max_submissions (default 500),
--      max_total_bytes (default 5 GB), bytes_received — the route refuses a
--      link that has spent either.
--
-- NOT a widening: every change narrows who may do what, or adds a fact.
-- DEC-30 inventories (aggregate counts, captured BEFORE the transaction)
-- are returned with the verification probes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (a second run is safe: every step is idempotent). The final SELECT is
-- the only result set shown — probe rows must read ok = true; inventory rows
-- carry ok NULL and a count in n.

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
DROP TABLE IF EXISTS pg_temp.prj_g_j1a_inventory;
CREATE TEMP TABLE prj_g_j1a_inventory AS
SELECT 'inventory: intake links whose project no longer exists (revoked by this migration if still live)' AS inventory,
       COUNT(*)::text AS n
  FROM project_intake_links l
 WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id)
UNION ALL
SELECT 'inventory: …of which still live (not revoked) before apply', COUNT(*)::text
  FROM project_intake_links l
 WHERE l.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id)
UNION ALL
SELECT 'inventory: assigned_doc_ids entries naming a document outside the link''s org (or no document)', COUNT(*)::text
  FROM project_intake_links l
  CROSS JOIN LATERAL unnest(COALESCE(l.assigned_doc_ids, '{}'::uuid[])) AS a(doc_id)
 WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = a.doc_id AND d.org_id = l.org_id)
UNION ALL
SELECT 'inventory: documents born through an intake link (first version carries a link) — authored_by_link_id backfill', COUNT(*)::text
  FROM (SELECT DISTINCT ON (v.record_id) v.record_id, v.intake_link_id
          FROM document_versions v ORDER BY v.record_id, v.created_at ASC, v.id ASC) f
 WHERE f.intake_link_id IS NOT NULL
UNION ALL
SELECT 'inventory: intake-born documents whose NEWEST version came through a different link than the first (INTK-1 bootstraps to look at)', COUNT(*)::text
  FROM (SELECT DISTINCT ON (v.record_id) v.record_id, v.intake_link_id
          FROM document_versions v ORDER BY v.record_id, v.created_at ASC, v.id ASC) f
  JOIN (SELECT DISTINCT ON (v.record_id) v.record_id, v.intake_link_id
          FROM document_versions v WHERE v.intake_link_id IS NOT NULL
         ORDER BY v.record_id, v.created_at DESC, v.id DESC) n ON n.record_id = f.record_id
 WHERE f.intake_link_id IS NOT NULL AND n.intake_link_id IS DISTINCT FROM f.intake_link_id
UNION ALL
SELECT 'inventory: ASSIGNED org documents that already took an intake auto-publish (published version from the link, review_state NULL)', COUNT(*)::text
  FROM project_intake_links l
  CROSS JOIN LATERAL unnest(COALESCE(l.assigned_doc_ids, '{}'::uuid[])) AS a(doc_id)
  JOIN document_versions v ON v.record_id = a.doc_id AND v.intake_link_id = l.id
 WHERE v.review_state IS NULL AND v.released_at IS NOT NULL
UNION ALL
SELECT 'inventory: live DOCUMENT links with no expiry (given now() + 14 days below)', COUNT(*)::text
  FROM project_intake_links
 WHERE expires_at IS NULL AND revoked_at IS NULL AND COALESCE(purpose, 'documents') <> 'quote'
UNION ALL
SELECT 'inventory: …of which used in the last 30 days (contractors to tell about the new expiry)', COUNT(*)::text
  FROM project_intake_links
 WHERE expires_at IS NULL AND revoked_at IS NULL AND COALESCE(purpose, 'documents') <> 'quote'
   AND last_used_at IS NOT NULL AND last_used_at > NOW() - INTERVAL '30 days'
UNION ALL
SELECT 'inventory: live links already past the 500-submission default budget', COUNT(*)::text
  FROM project_intake_links WHERE revoked_at IS NULL AND submission_count >= 500;

BEGIN;

-- ── 1. authorship, fixed at creation (INTK-1 / SEC-3 / SEC-12) ───────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS authored_by_link_id UUID
  REFERENCES project_intake_links(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS documents_authored_by_link_idx
  ON documents (authored_by_link_id) WHERE authored_by_link_id IS NOT NULL;
COMMENT ON COLUMN documents.authored_by_link_id IS
  'INTK-1: the contractor intake link that CREATED this document (stamped once, at creation, by app/api/intake/upload). A trusted link may auto-publish only a document it authored, that it was not assigned, and that has had at least one approved revision. NULL = an org document.';

UPDATE documents d
   SET authored_by_link_id = f.intake_link_id
  FROM (SELECT DISTINCT ON (v.record_id) v.record_id, v.intake_link_id
          FROM document_versions v
         ORDER BY v.record_id, v.created_at ASC, v.id ASC) f
 WHERE f.record_id = d.id
   AND f.intake_link_id IS NOT NULL
   AND d.authored_by_link_id IS NULL
   AND EXISTS (SELECT 1 FROM project_intake_links l WHERE l.id = f.intake_link_id AND l.org_id = d.org_id);

-- ── 2. what a link may be assigned (INTK-9 / SEC-11) ─────────────────────
CREATE OR REPLACE FUNCTION enforce_intake_link_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_before uuid[] := '{}'::uuid[];
  v_added uuid[];
  v_doc   record;
BEGIN
  -- Server routes and SQL (no JWT) carry their own checks.
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;
  IF cardinality(COALESCE(NEW.assigned_doc_ids, '{}'::uuid[])) > 500 THEN
    RAISE EXCEPTION 'A contractor link can be assigned at most 500 documents.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    v_before := COALESCE(OLD.assigned_doc_ids, '{}'::uuid[]);
  END IF;
  -- Only NEW entries are checked: removing an assignment is always allowed.
  SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_added
    FROM unnest(COALESCE(NEW.assigned_doc_ids, '{}'::uuid[])) AS x
   WHERE NOT (x = ANY (v_before));
  FOR v_doc IN
    SELECT a.doc_id, d.id AS found_id, d.org_id, d.library_id
      FROM unnest(v_added) AS a(doc_id)
      LEFT JOIN documents d ON d.id = a.doc_id
  LOOP
    IF v_doc.found_id IS NULL OR v_doc.org_id IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'That document is not in this organization and cannot be assigned to a contractor link.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT is_org_controller(NEW.org_id)
       AND NOT user_can_publish_on_library(v_doc.library_id, v_actor::text, NEW.org_id) THEN
      RAISE EXCEPTION 'Assigning a controlled document to a contractor link needs publish authority on its library — ask Document Control.'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_intake_links_assignment_guard ON project_intake_links;
CREATE TRIGGER trg_intake_links_assignment_guard
  BEFORE INSERT OR UPDATE OF assigned_doc_ids ON project_intake_links
  FOR EACH ROW EXECUTE FUNCTION enforce_intake_link_assignment();

REVOKE ALL ON FUNCTION enforce_intake_link_assignment() FROM PUBLIC, anon, authenticated;

-- ── 3a. the per-link budget (INTK-8 dw4) — before the counter that fills it
ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS max_submissions INT NOT NULL DEFAULT 500;
ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS max_total_bytes BIGINT NOT NULL DEFAULT 5368709120;
ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS bytes_received BIGINT NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_intake_links_budget_positive') THEN
    ALTER TABLE project_intake_links ADD CONSTRAINT project_intake_links_budget_positive
      CHECK (max_submissions > 0 AND max_total_bytes > 0 AND bytes_received >= 0);
  END IF;
END $$;
COMMENT ON COLUMN project_intake_links.max_submissions IS 'INTK-8: lifetime submission cap for this link (default 500); the upload route refuses beyond it.';
COMMENT ON COLUMN project_intake_links.max_total_bytes IS 'INTK-8: lifetime storage budget for this link in bytes (default 5 GB).';
COMMENT ON COLUMN project_intake_links.bytes_received IS 'INTK-8: bytes accepted through this link so far (bump_intake_use).';

-- ── 3b. the usage counter is the server's alone (INTK-14 / INTK-8) ───────
DROP FUNCTION IF EXISTS bump_intake_use(uuid);
CREATE OR REPLACE FUNCTION bump_intake_use(p_link uuid, p_bytes bigint DEFAULT 0)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE project_intake_links
     SET last_used_at = NOW(),
         submission_count = submission_count + 1,
         bytes_received = bytes_received + GREATEST(COALESCE(p_bytes, 0), 0)
   WHERE id = p_link;
$$;
REVOKE ALL ON FUNCTION bump_intake_use(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bump_intake_use(uuid, bigint) TO service_role;

-- ── 4. a deleted project closes its doors (PM-2) ─────────────────────────
UPDATE project_intake_links l
   SET revoked_at = NOW()
 WHERE l.revoked_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_intake_links_project_fk') THEN
    ALTER TABLE project_intake_links ADD CONSTRAINT project_intake_links_project_fk
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE NOT VALID;
  END IF;
  -- Validate only in the world with no orphan left (the revoked orphans
  -- keep the constraint NOT VALID; it still binds every new row).
  IF NOT EXISTS (SELECT 1 FROM project_intake_links l
                  WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id)) THEN
    ALTER TABLE project_intake_links VALIDATE CONSTRAINT project_intake_links_project_fk;
  END IF;
END $$;

-- ── 5. every new link expires, within 90 days (SEC-5) ────────────────────
UPDATE project_intake_links
   SET expires_at = NOW() + INTERVAL '14 days'
 WHERE expires_at IS NULL AND revoked_at IS NULL AND COALESCE(purpose, 'documents') <> 'quote';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_intake_links_ttl') THEN
    EXECUTE format(
      'ALTER TABLE project_intake_links ADD CONSTRAINT project_intake_links_ttl CHECK ('
      || 'created_at < %L::timestamptz OR ('
      || 'expires_at IS NOT NULL AND expires_at > created_at AND expires_at <= created_at + INTERVAL ''91 days''))',
      NOW());
  END IF;
END $$;
COMMENT ON CONSTRAINT project_intake_links_ttl ON project_intake_links IS
  'SEC-5: a link created after 20261104 was applied must expire within 90 days (+1 day for an end-of-day local expiry). Older rows are grandfathered by the literal cutoff; live document links among them were given 14 days at apply.';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'documents.authored_by_link_id exists with FK to project_intake_links (ON DELETE SET NULL)' AS check,
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.documents'::regclass AND contype = 'f'
                  AND confrelid = 'public.project_intake_links'::regclass AND confdeltype = 'n'
                  AND pg_get_constraintdef(oid) ILIKE '%(authored_by_link_id)%') AS ok,
       NULL::text AS n
UNION ALL SELECT 'every intake-born document carries its authoring link (first version → authored_by_link_id)',
       NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (v.record_id) v.record_id, v.intake_link_id
                                    FROM document_versions v ORDER BY v.record_id, v.created_at ASC, v.id ASC) f
                     JOIN documents d ON d.id = f.record_id
                     JOIN project_intake_links l ON l.id = f.intake_link_id AND l.org_id = d.org_id
                    WHERE d.authored_by_link_id IS DISTINCT FROM f.intake_link_id), NULL
UNION ALL SELECT 'assignment guard trigger installed on project_intake_links',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_intake_links_assignment_guard'
                AND tgrelid = 'public.project_intake_links'::regclass AND NOT tgisinternal), NULL
UNION ALL SELECT 'assignment guard checks the org and publish authority, SECURITY DEFINER with search_path pinned',
       (SELECT prosecdef AND prosrc LIKE '%v_doc.org_id IS DISTINCT FROM NEW.org_id%'
               AND prosrc LIKE '%user_can_publish_on_library(v_doc.library_id, v_actor::text, NEW.org_id)%'
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'enforce_intake_link_assignment'), NULL
UNION ALL SELECT 'bump_intake_use(uuid) is gone; bump_intake_use(uuid, bigint) exists',
       NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'bump_intake_use' AND pronargs = 1)
       AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'bump_intake_use' AND pronargs = 2), NULL
UNION ALL SELECT 'bump_intake_use: service_role may execute; PUBLIC, anon and authenticated may not',
       has_function_privilege('service_role', 'bump_intake_use(uuid, bigint)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'bump_intake_use(uuid, bigint)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'bump_intake_use(uuid, bigint)', 'EXECUTE'), NULL
UNION ALL SELECT 'project_intake_links.project_id → projects ON DELETE CASCADE',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_intake_links_project_fk'
                AND confrelid = 'public.projects'::regclass AND confdeltype = 'c'), NULL
UNION ALL SELECT 'no LIVE link points at a missing project',
       NOT EXISTS (SELECT 1 FROM project_intake_links l
                    WHERE l.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id)), NULL
UNION ALL SELECT 'TTL CHECK installed (new links: expiry required, within 91 days of creation)',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_intake_links_ttl'
                AND pg_get_constraintdef(oid) LIKE '%expires_at IS NOT NULL%'
                AND pg_get_constraintdef(oid) LIKE '%91 days%'), NULL
UNION ALL SELECT 'no live document link is left without an expiry',
       NOT EXISTS (SELECT 1 FROM project_intake_links
                    WHERE expires_at IS NULL AND revoked_at IS NULL AND COALESCE(purpose, 'documents') <> 'quote'), NULL
UNION ALL SELECT 'per-link budget columns exist (max_submissions, max_total_bytes, bytes_received)',
       (SELECT COUNT(*) = 3 FROM information_schema.columns
         WHERE table_name = 'project_intake_links'
           AND column_name IN ('max_submissions', 'max_total_bytes', 'bytes_received')), NULL
UNION ALL SELECT 'inventory: orphan links (revoked) that keep project_intake_links_project_fk NOT VALID — 0 means it was validated',
       NULL::boolean,
       (SELECT COUNT(*)::text FROM project_intake_links l
         WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id))
UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_j1a_inventory;
