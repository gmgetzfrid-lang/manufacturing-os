-- 20261141_prj_roundG_intake_token_hash_and_adoption.sql
--
-- projects Round G — J11 PROJECTS RESIDUALS, migration A: the contractor
-- door's credential at rest (projects-tab SEC-19) and adoption's number rule
-- in the database (projects-and-cost INTK-16).
--
-- WHAT:
--   1. SEC-19 — project_intake_links keeps no usable token. The door's
--      credential is stored as its SHA-256 (hex): token_hash, plus a
--      six-character token_prefix the lists show so a person can tell two
--      links apart. Every link minted before this migration is HASHED IN
--      PLACE (its token nulled); the contractors' URLs keep working, because
--      both public routes (/api/intake/resolve, /api/intake/upload) look a
--      link up by sha256(token) — the same value lib/intakeRateLimit.ts
--      sha256Hex already computes for the rate window.
--        * trg_project_intake_links_hash_token (BEFORE INSERT OR UPDATE): a
--          `token` written by ANY writer — the Intake and Costs tabs' mint,
--          a re-issue, an older client still sending the plain value, the
--          org restore's revoked placeholder (lib/dataRestore.ts) — is hashed
--          into token_hash / token_prefix and NULLED before the row is
--          stored. Writing `token` again on an existing link is the RE-ISSUE
--          (a new credential on the same link: its id, its authorship of the
--          documents it created, its history and its budget stay); writing
--          token_hash or token_prefix directly on an existing link is
--          refused — the credential changes only through its token.
--        * CHECK project_intake_links_no_plain_token (token IS NULL): the
--          database itself holds no usable token, whatever writes the row.
--          The `token` column stays as the write-only input (dropping it
--          would break the restore path, which inserts the placeholder by
--          that name, and any client deployed before this migration).
--        * a unique index on token_hash (the lookup key).
--      DEC-45 (export redaction) is unchanged in kind: lib/exportTables.ts
--      redacts token, token_hash and token_prefix (the hash is the value a
--      link is matched by — reinstating it from a backup would revive the
--      link), and a restored link still arrives REVOKED with an unguessable
--      placeholder token, which this trigger hashes. 20261104's grants, its
--      TTL CHECK and its budget columns are untouched.
--   2. INTK-16 — adoption's cross-library number rule runs in the database.
--        * trg_documents_authorship_fixed (BEFORE INSERT OR UPDATE OF
--          authored_by_link_id ON documents, search_path pinned): authorship
--          is a fact the DOOR fixes at creation. A signed-in session never
--          writes it — an INSERT naming a link and any UPDATE that changes it
--          (clearing it, or stamping a link's id onto an org document) are
--          refused. The door (service role) and the org restore (service
--          role) are the column's only writers and stay exempt. Without this
--          the rule below could be skipped by clearing the column in the same
--          PATCH or a prior one, and the door's own-document and trusted
--          auto-publish decision (app/api/intake/upload/route.ts) would rest
--          on a writable fact.
--        * trg_documents_intake_adoption_guard (BEFORE UPDATE OF library_id,
--          collection_id, document_number, status ON documents, SECURITY
--          DEFINER, search_path pinned): for an INTAKE-BORN document
--          (authored_by_link_id set — the STORED value, OLD's, so a
--          statement that also clears it is still judged as the sheet it
--          was) that stays live, a signed-in change of
--          its library, folder or number is refused when a LIVE document
--          (not Archived / Superseded) in the same org, outside the sheet's
--          ORIGINAL folder, carries the same number (trimmed,
--          case-insensitive) and — the SAF-12 rule, DEC-56 item 6 — the
--          destination library's tuple is the number alone (["documentNumber"],
--          or none) OR that document lives in ANOTHER library. In a
--          multi-part library (["documentNumber","sheet"]) the full key
--          decides between the sheets INSIDE it (the partial unique index).
--          The same rule binds a sheet coming back to life (Archived or
--          Superseded → live) outside a project's intake folder — otherwise a
--          move made while archived, revived after, would skip it.
--          The service pass (auth.uid() NULL — the org restore, server
--          routes, the SQL editor) is exempt, as every rail since 20260831.
--        * adopt_intake_document(p_doc, p_library, p_collection,
--          p_new_number, p_details) — SECURITY DEFINER, search_path pinned,
--          refuses a NULL auth.uid(), REVOKEd from PUBLIC and anon, EXECUTE
--          to authenticated only (DRLS-16): the caller must be an org
--          controller (the move guard's tier); the document must be
--          intake-born, approved, and not in review; the destination library
--          and folder must be the document's org's (the folder inside that
--          library); the uniqueness key is computed HERE — lib/uniqueness.ts's
--          rule, written only when every part of the destination tuple is
--          filled (INTK-5; the same expression 20261105's backfill used); the
--          move is written (the guard above and the unique index decide) and
--          its TRANSITION_IN audit row with it. lib/transitionIn.ts
--          adoptDocument calls it (TransitionInPanel adopts through that).
--
-- REQUIRES 20261104 (documents.authored_by_link_id, the intake-link budget)
-- and 20261105. The second statement checks and stops with a sentence when
-- 20261104 is missing.
--
-- DEPLOY PREREQUISITE (SEC-19 — IRREVERSIBLE): apply ONLY after the J11 build
-- is live in production — the build whose public routes look a link up by
-- its hash (lib/intakeLinks.ts readIntakeLinkByToken) and whose Intake and
-- Costs tabs list token_prefix and re-issue a lost address. This file nulls
-- every stored token and its CHECK keeps the column NULL; code from before
-- that build looks a link up by the plain token (every contractor URL would
-- answer "link invalid") and builds Copy link and the RFQ from it (a
-- /submit/null address sent to a vendor). A code ROLLBACK to a build before
-- J11 after this is applied breaks every link the same way — the plain
-- tokens are not kept anywhere, so there is no way back but re-issuing each
-- link. The FIRST statement refuses to run until the operator confirms:
-- uncomment the SET line just above it once the J11 build is live.
--
-- NOT a widening: every change narrows who may do what or adds a fact. The
-- DEC-30 inventory (aggregate counts only, never rows) is captured BEFORE the
-- transaction and returned with the probes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (a second run is safe: every step is idempotent). The final SELECT is
-- the only result set shown — probe rows must read ok = true; inventory rows
-- carry ok NULL and a count in n.

-- DEPLOY PREREQUISITE (see above). Uncomment the next line ONLY once the J11
-- build is live in production:
-- SET app.j11_deployed = 'yes';
DO $$
BEGIN
  IF COALESCE(current_setting('app.j11_deployed', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'DEPLOY PREREQUISITE: apply 20261141 only after the J11 build (intake links looked up by their hash, token_prefix lists, re-issue) is live in production. This file nulls every stored intake token; code from before that build — or a rollback to it — breaks every contractor link, irreversibly. Once the J11 build is live, uncomment the line  SET app.j11_deployed = ''yes'';  just above this block and run the whole file again. Nothing was changed.';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'authored_by_link_id') THEN
    RAISE EXCEPTION 'Apply 20261104_prj_roundG_intake_links.sql (and 20261105) first — this migration builds on documents.authored_by_link_id. Nothing was changed.';
  END IF;
END;
$$;

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
DROP TABLE IF EXISTS pg_temp.prj_g_j11a_inventory;
CREATE TEMP TABLE prj_g_j11a_inventory AS
SELECT 'inventory: intake links' AS inventory, COUNT(*)::text AS n
  FROM project_intake_links
UNION ALL
SELECT 'inventory: …whose token is stored in plain before apply (hashed in place by this run)', COUNT(*)::text
  FROM project_intake_links WHERE token IS NOT NULL
UNION ALL
SELECT 'inventory: …live (not revoked, not expired) — their contractors'' URLs keep working', COUNT(*)::text
  FROM project_intake_links WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
UNION ALL
SELECT 'inventory: tokens shared by two links (expect 0 — the column was UNIQUE)', COUNT(*)::text
  FROM (SELECT token FROM project_intake_links WHERE token IS NOT NULL GROUP BY token HAVING COUNT(*) > 1) t
UNION ALL
SELECT 'inventory: live intake-born documents (authored_by_link_id set)', COUNT(*)::text
  FROM documents WHERE authored_by_link_id IS NOT NULL AND status NOT IN ('Archived', 'Superseded')
UNION ALL
SELECT 'inventory: …whose number is ALREADY a live document''s in another library (two sources of truth today — reported, not changed; the guard binds their next move)', COUNT(*)::text
  FROM documents d
 WHERE d.authored_by_link_id IS NOT NULL AND d.status NOT IN ('Archived', 'Superseded')
   AND NULLIF(btrim(d.document_number), '') IS NOT NULL
   AND EXISTS (SELECT 1 FROM documents o
                WHERE o.org_id = d.org_id AND o.id <> d.id
                  AND lower(btrim(o.document_number)) = lower(btrim(d.document_number))
                  AND o.status NOT IN ('Archived', 'Superseded')
                  AND o.library_id IS DISTINCT FROM d.library_id);

BEGIN;

-- ── 1. SEC-19: the door's credential is stored as its SHA-256 ────────────
ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS token_prefix TEXT;
ALTER TABLE project_intake_links ALTER COLUMN token DROP NOT NULL;

COMMENT ON COLUMN project_intake_links.token_hash IS
  'SEC-19: sha256(token) as lowercase hex — the value both public intake routes look a link up by. Derived by trg_project_intake_links_hash_token from a written token; never written directly on an existing link.';
COMMENT ON COLUMN project_intake_links.token_prefix IS
  'SEC-19: the first six characters of the token, so a person can tell two links apart. Not a credential.';
COMMENT ON COLUMN project_intake_links.token IS
  'SEC-19: write-only. A token written here (a mint, a re-issue, a restore placeholder) is hashed into token_hash and nulled before the row is stored; CHECK project_intake_links_no_plain_token keeps it NULL.';

-- Links minted before this migration: hashed in place (before the trigger
-- exists, so its "never write the hash directly" rule does not see this).
UPDATE project_intake_links
   SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'),
       token_prefix = left(token, 6),
       token = NULL
 WHERE token IS NOT NULL;

CREATE OR REPLACE FUNCTION project_intake_links_hash_token()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.token IS NOT NULL THEN
    -- A mint, a re-issue, an older client's plain token, a restore's
    -- placeholder: the credential is kept only as its hash.
    NEW.token_hash := encode(sha256(convert_to(NEW.token, 'UTF8')), 'hex');
    NEW.token_prefix := left(NEW.token, 6);
    NEW.token := NULL;
  ELSIF TG_OP = 'UPDATE'
        AND (NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.token_prefix IS DISTINCT FROM OLD.token_prefix) THEN
    RAISE EXCEPTION 'A link''s credential changes only by re-issuing it (a new token) — nothing was changed. SEC-19, 20261141'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_intake_links_hash_token ON project_intake_links;
CREATE TRIGGER trg_project_intake_links_hash_token
  BEFORE INSERT OR UPDATE ON project_intake_links
  FOR EACH ROW EXECUTE FUNCTION project_intake_links_hash_token();

REVOKE ALL ON FUNCTION project_intake_links_hash_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION project_intake_links_hash_token() FROM anon;
GRANT EXECUTE ON FUNCTION project_intake_links_hash_token() TO authenticated, service_role;

ALTER TABLE project_intake_links DROP CONSTRAINT IF EXISTS project_intake_links_no_plain_token;
ALTER TABLE project_intake_links ADD CONSTRAINT project_intake_links_no_plain_token CHECK (token IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS project_intake_links_token_hash_key
  ON project_intake_links (token_hash) WHERE token_hash IS NOT NULL;

-- ── 2. INTK-16: adoption's number rule, at the database ──────────────────
-- Authorship is fixed at creation, by the door: the rule below (and the
-- door's own-document decision) reads it, so a signed-in session never
-- writes it.
CREATE OR REPLACE FUNCTION documents_authorship_fixed()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- the door and the org restore (service role), the SQL editor
  IF TG_OP = 'INSERT' THEN
    IF NEW.authored_by_link_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only the contractor door records that a link authored a document — a document filed here is the organization''s. Nothing was changed. INTK-16, 20261141'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.authored_by_link_id IS DISTINCT FROM OLD.authored_by_link_id THEN
    RAISE EXCEPTION 'Which contractor link authored a document is fixed when the door files it — it is not changed afterwards. Nothing was changed. INTK-16, 20261141'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION documents_authorship_fixed() IS
  'INTK-16: documents.authored_by_link_id is written only by the door (service role) at creation and by the org restore — a signed-in INSERT naming a link, or a signed-in UPDATE changing it, is refused. The adoption guard and the door''s own-document decision read it.';

DROP TRIGGER IF EXISTS trg_documents_authorship_fixed ON documents;
CREATE TRIGGER trg_documents_authorship_fixed
  BEFORE INSERT OR UPDATE OF authored_by_link_id ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_authorship_fixed();

REVOKE ALL ON FUNCTION documents_authorship_fixed() FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_authorship_fixed() FROM anon;
GRANT EXECUTE ON FUNCTION documents_authorship_fixed() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION documents_intake_adoption_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_decides boolean;
  v_hit     record;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;   -- service pass: the org restore, server routes, the SQL editor
  -- Intake-born is the STORED fact: a statement that also clears the column
  -- (refused anyway by trg_documents_authorship_fixed) is judged as the sheet it was.
  IF COALESCE(OLD.authored_by_link_id, NEW.authored_by_link_id) IS NULL THEN RETURN NEW; END IF;   -- an org document: not this rule's
  IF NEW.status IS NULL OR NEW.status IN ('Archived', 'Superseded') THEN RETURN NEW; END IF;
  IF NEW.library_id IS NOT DISTINCT FROM OLD.library_id
     AND NEW.collection_id IS NOT DISTINCT FROM OLD.collection_id
     AND NEW.document_number IS NOT DISTINCT FROM OLD.document_number THEN
    -- Not a move. Only a sheet coming back to life (Archived / Superseded →
    -- live) is this rule's — a move made while archived, revived after,
    -- would otherwise skip it — and not one still in a project's intake
    -- folder (not in the register yet).
    IF OLD.status IS NOT NULL AND OLD.status NOT IN ('Archived', 'Superseded') THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM projects p
                WHERE p.org_id = NEW.org_id AND p.intake_collection_id = NEW.collection_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NULLIF(btrim(NEW.document_number), '') IS NULL THEN RETURN NEW; END IF;
  -- Does the number alone identify a document in the destination library?
  -- (lib/intakeLinks.ts numberIsTheKey: the default tuple, or none set.)
  SELECT (l.uniqueness_keys IS NULL OR cardinality(l.uniqueness_keys) = 0
          OR l.uniqueness_keys = ARRAY['documentNumber']::text[])
    INTO v_decides
    FROM libraries l WHERE l.id = NEW.library_id;
  v_decides := COALESCE(v_decides, true);
  -- SAF-12 / DEC-56 item 6: a live same-numbered document outside the
  -- sheet's original folder blocks — anywhere when the number is the key,
  -- in ANOTHER library when the destination is a multi-part library.
  SELECT d.document_number, d.rev INTO v_hit
    FROM documents d
   WHERE d.org_id = NEW.org_id
     AND d.id <> NEW.id
     AND lower(btrim(d.document_number)) = lower(btrim(NEW.document_number))
     AND d.status NOT IN ('Archived', 'Superseded')
     AND d.collection_id IS DISTINCT FROM OLD.collection_id
     AND (v_decides OR d.library_id IS DISTINCT FROM NEW.library_id)
   ORDER BY d.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% (Rev %) is already a live document with this number — an intake sheet is adopted only under a number no other live document carries (renumber it, or resolve which one is the source of truth first). Nothing was changed. INTK-16, 20261141',
      v_hit.document_number, COALESCE(v_hit.rev, '—')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION documents_intake_adoption_guard() IS
  'INTK-16: a signed-in change of an intake-born live document''s library, folder or number — or its return to life (Archived / Superseded → live) outside a project''s intake folder — is refused while a live same-numbered document outside its original folder stands — anywhere when the destination library''s key is the number alone, in another library when it is a multi-part library (SAF-12, DEC-56 item 6). Intake-born is the stored authored_by_link_id (fixed by trg_documents_authorship_fixed). The service pass is exempt.';

DROP TRIGGER IF EXISTS trg_documents_intake_adoption_guard ON documents;
CREATE TRIGGER trg_documents_intake_adoption_guard
  BEFORE UPDATE OF library_id, collection_id, document_number, status ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_intake_adoption_guard();

REVOKE ALL ON FUNCTION documents_intake_adoption_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION documents_intake_adoption_guard() FROM anon;
GRANT EXECUTE ON FUNCTION documents_intake_adoption_guard() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION adopt_intake_document(
  p_doc uuid, p_library uuid, p_collection uuid, p_new_number text DEFAULT NULL, p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_doc     documents%ROWTYPE;
  v_lib_org uuid;
  v_keys    text[];
  v_col     record;
  v_number  text;
  v_key     text;
  v_email   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to adopt a document into the controlled register.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_doc FROM documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT is_org_controller(v_doc.org_id) THEN
    RAISE EXCEPTION 'Adopting into the controlled register moves the document between folders, which needs Admin or Document Control.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_doc.authored_by_link_id IS NULL THEN
    RAISE EXCEPTION 'Only a document that came in through a contractor link is adopted here.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_doc.current_version_id IS NULL OR v_doc.pending_version_id IS NOT NULL THEN
    RAISE EXCEPTION '% is still awaiting review — approve or reject its submission on the Intake tab before adopting it.',
      COALESCE(NULLIF(btrim(v_doc.document_number), ''), v_doc.title, 'This sheet') USING ERRCODE = 'check_violation';
  END IF;
  SELECT org_id, uniqueness_keys INTO v_lib_org, v_keys FROM libraries WHERE id = p_library;
  IF NOT FOUND OR v_lib_org IS DISTINCT FROM v_doc.org_id THEN
    RAISE EXCEPTION 'The destination library is not in this workspace.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_collection IS NOT NULL THEN
    SELECT org_id, library_id INTO v_col FROM collections WHERE id = p_collection;
    IF NOT FOUND OR v_col.org_id IS DISTINCT FROM v_doc.org_id OR v_col.library_id IS DISTINCT FROM p_library THEN
      RAISE EXCEPTION 'The destination folder is not in that library.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_number := COALESCE(NULLIF(btrim(p_new_number), ''), v_doc.document_number);
  -- INTK-5: lib/uniqueness.ts's key for the DESTINATION library — written
  -- only when every part of its tuple is filled (a sheet with no sheet
  -- value gets NULL, the column's opt-out; never a partial key).
  SELECT CASE WHEN bool_or(p.v = '') THEN NULL ELSE string_agg(p.v, '::' ORDER BY p.ord) END
    INTO v_key
    FROM (SELECT k.ord,
                 lower(btrim(COALESCE(CASE k.key
                                         WHEN 'documentNumber' THEN v_number
                                         WHEN 'title' THEN v_doc.title
                                         WHEN 'rev' THEN v_doc.rev
                                         WHEN 'status' THEN v_doc.status
                                         ELSE v_doc.metadata->>k.key
                                       END, ''), E' \t\n\r\f')) AS v
            FROM unnest(CASE WHEN v_keys IS NULL OR cardinality(v_keys) = 0
                             THEN ARRAY['documentNumber']::text[] ELSE v_keys END)
                 WITH ORDINALITY AS k(key, ord)) p;
  -- The move: trg_documents_intake_adoption_guard applies the cross-library
  -- number rule, the partial unique index the in-library key, the move guard
  -- the controller tier, the register rail the renumber.
  UPDATE documents
     SET library_id = p_library,
         collection_id = p_collection,
         uniqueness_key = v_key,
         document_number = v_number,
         updated_at = NOW()
   WHERE id = p_doc;
  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
  VALUES ('TRANSITION_IN', 'document', p_doc::text, v_doc.org_id, v_uid, v_email,
          COALESCE(p_details, '{}'::jsonb) || jsonb_build_object(
            'before', jsonb_build_object('number', v_doc.document_number, 'libraryId', v_doc.library_id, 'collectionId', v_doc.collection_id),
            'after', jsonb_build_object('number', v_number, 'libraryId', p_library, 'collectionId', p_collection),
            'uniquenessKey', v_key,
            'via', 'adopt_intake_document'));
  RETURN jsonb_build_object('ok', true, 'uniquenessKey', v_key, 'number', v_number);
END;
$$;

COMMENT ON FUNCTION adopt_intake_document(uuid, uuid, uuid, text, jsonb) IS
  'INTK-16: adopt an approved intake-born document into the controlled register — the caller must be an org controller; the destination library and folder must be the document''s org''s; the uniqueness key is computed here (lib/uniqueness.ts, complete tuple only); the cross-library number rule is trg_documents_intake_adoption_guard''s; writes the move and its TRANSITION_IN audit row.';

REVOKE ALL ON FUNCTION adopt_intake_document(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION adopt_intake_document(uuid, uuid, uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION adopt_intake_document(uuid, uuid, uuid, text, jsonb) TO authenticated;

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_proc.prosrc is verbatim.
SELECT 'no intake link stores a usable token (every token NULL, every link hashed)' AS check,
       (NOT EXISTS (SELECT 1 FROM project_intake_links WHERE token IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM project_intake_links WHERE token_hash IS NULL)) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'CHECK project_intake_links_no_plain_token (token IS NULL) is installed and validated',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'project_intake_links_no_plain_token'
                  AND conrelid = 'public.project_intake_links'::regclass AND convalidated
                  AND pg_get_constraintdef(oid) LIKE '%token IS NULL%'),
       NULL::text
UNION ALL
SELECT 'token_hash is unique (partial index) — the lookup key',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE tablename = 'project_intake_links' AND indexname = 'project_intake_links_token_hash_key'
                  AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%(token_hash)%'),
       NULL::text
UNION ALL
SELECT 'the hash trigger fires BEFORE INSERT OR UPDATE, hashes a written token with sha256 and nulls it, and refuses a direct hash write',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_project_intake_links_hash_token' AND NOT t.tgisinternal
                  AND t.tgrelid = 'public.project_intake_links'::regclass
                  AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16)
       AND (SELECT prosrc LIKE '%NEW.token_hash := encode(sha256(convert_to(NEW.token, ''UTF8'')), ''hex'');%'
                   AND prosrc LIKE '%NEW.token := NULL;%'
                   AND prosrc LIKE '%changes only by re-issuing it%'
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'project_intake_links_hash_token'),
       NULL::text
UNION ALL
SELECT 'the database''s sha256 hex equals the routes'' (node:crypto sha256 hex of "abc")',
       encode(sha256(convert_to('abc', 'UTF8')), 'hex') = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
       NULL::text
UNION ALL
SELECT 'the adoption guard fires BEFORE UPDATE OF library_id, collection_id, document_number, status — SECURITY DEFINER, search_path pinned, the stored authorship and the SAF-12 rule in its body',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_documents_intake_adoption_guard' AND NOT t.tgisinternal
                  AND t.tgrelid = 'public.documents'::regclass AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF library_id, collection_id, document_number, status ON %')
       AND (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
                   AND prosrc LIKE '%IF COALESCE(OLD.authored_by_link_id, NEW.authored_by_link_id) IS NULL THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%IF OLD.status IS NOT NULL AND OLD.status NOT IN (''Archived'', ''Superseded'') THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%AND (v_decides OR d.library_id IS DISTINCT FROM NEW.library_id)%'
                   AND prosrc LIKE '%AND d.collection_id IS DISTINCT FROM OLD.collection_id%'
              FROM pg_proc WHERE proname = 'documents_intake_adoption_guard'),
       NULL::text
UNION ALL
SELECT 'authorship is fixed: trg_documents_authorship_fixed fires BEFORE INSERT OR UPDATE OF authored_by_link_id and refuses a signed-in session''s write (the door and the restore exempt)',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_documents_authorship_fixed' AND NOT t.tgisinternal
                  AND t.tgrelid = 'public.documents'::regclass
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF authored_by_link_id ON %')
       AND (SELECT array_to_string(proconfig, ',') LIKE '%search_path=public%'
                   AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%IF NEW.authored_by_link_id IS NOT NULL THEN%'
                   AND prosrc LIKE '%ELSIF NEW.authored_by_link_id IS DISTINCT FROM OLD.authored_by_link_id THEN%'
              FROM pg_proc WHERE proname = 'documents_authorship_fixed'),
       NULL::text
UNION ALL
SELECT 'adopt_intake_document: SECURITY DEFINER, search_path pinned, refuses a NULL uid, controller-only, writes its audit row',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%IF v_uid IS NULL THEN%RAISE EXCEPTION%'
               AND prosrc LIKE '%IF NOT is_org_controller(v_doc.org_id) THEN%'
               AND prosrc LIKE '%INSERT INTO audit_logs%''TRANSITION_IN''%'
          FROM pg_proc WHERE proname = 'adopt_intake_document' AND pronargs = 5),
       NULL::text
UNION ALL
SELECT 'adopt_intake_document is executable by authenticated, never by anon (DRLS-16); the guard, authorship and hash trigger functions are not anon''s either',
       (has_function_privilege('authenticated', 'adopt_intake_document(uuid,uuid,uuid,text,jsonb)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'adopt_intake_document(uuid,uuid,uuid,text,jsonb)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'documents_intake_adoption_guard()', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'documents_authorship_fixed()', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'project_intake_links_hash_token()', 'EXECUTE')),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j11a_inventory
UNION ALL
SELECT 'AFTER: intake links hashed (token_hash set)', NULL::boolean,
       (SELECT COUNT(*)::text FROM project_intake_links WHERE token_hash IS NOT NULL);
