-- ─────────────────────────────────────────────────────────────────────────────
-- 20261212 — intelligence Round G, I-12 DOCUMENT ACL BOUNDARY: node_visible
-- honours an explicit read deny for every subject, and on every visibility.
--
--   DACL-12 c1  node_visible() consulted only USER-scoped deny entries: a
--           deny of read / discover whose subject is a ROLE, a TEAM or the
--           WORKSPACE never bound at the database, so a member holding any
--           allow on a private / hidden row read it through PostgREST while
--           the app (lib/acl evaluateRules — a deny of an action wins, OWN-8)
--           refused it. The deny check now names the caller by uid, by ANY
--           held role (role ∪ roles, as the allow branch already does), by
--           each of their teams in the node's org, and by the node's org,
--           BEFORE any allow is read.
--   IEDGE-12 c2 / DACL-1 (read-time half)  a NORMAL-visibility row opened
--           before node_visible looked at its acl_index, so a document whose
--           chain-resolved index (DEC-10: rebuilt from the WHOLE chain at
--           save, at a folder move and nightly) carries an explicit READ deny
--           naming the caller came back to a direct PostgREST read — and
--           through doc_is_visible its document_versions.file_url — while the
--           AI seam and the bytes door (lib/permissions canReadNode, this
--           package) refused it. A normal row whose index carries any read
--           deny entry is now judged: controller, then effective owner, then
--           the deny check; a caller the deny does not name keeps the row
--           (normal stays open — the fail-safe default). FAST PATH: a normal
--           row whose index has no non-empty deny.<subject>.read list returns
--           true from a jsonb test alone, with no table read, exactly as
--           before; the member / team reads run only for the rows a read deny
--           names someone on.
--           Cost (I-12 second review fix): a library-wide read deny is
--           written into every document's chain-resolved index, so a normal
--           row reaching the judged branch is common. For such a row the
--           caller's roles and teams are read FIRST and a row the deny does
--           not name returns true at once; is_org_controller and the
--           ownership cascade run only for a row the deny names. Expected
--           cost per scanned row, for a member the deny does not name: two
--           index reads (their org_members row, their team_members rows —
--           both keyed by uid), where the first build ran four lookups (the
--           controller check, the member row, the cascade, the teams).
--           Private / hidden rows keep 20261203's order.
--   ⚠ WRITES TOO (I-12 third review fix — reproduced on PostgreSQL 16, the
--           run is on DACL-12). documents_acl_select and
--           collections_acl_select are RESTRICTIVE policies for SELECT, so
--           the new normal-row judgement also applies wherever PostgreSQL
--           checks SELECT policies on a write: INSERT ... RETURNING
--           (PostgREST's insert(...).select()) and the existing rows an
--           UPDATE or DELETE with a filter can reach. A member a normal row's
--           read deny names can therefore no longer insert such a row and
--           read it back, nor update it; and a normal FOLDER whose index
--           denies them read is no longer listed to them, so they cannot
--           reach it. The database admits an upload unless an upload deny
--           names the member, and the library page's upload (app/(protected)
--           /documents/[libraryId]/page.tsx uploadOne) writes acl_index from
--           the chain whenever the library has a default new-document ACL,
--           then inserts with .select("id").single() — so a "drop box" (a
--           library or folder that denies a role READ and lets it UPLOAD)
--           stops taking that role's uploads once this is pasted (ERROR: new
--           row violates row-level security policy "documents_acl_select",
--           raised after the file is already in storage), and its folder
--           disappears for them. The same insert without RETURNING succeeds.
--           Nothing in the app changes for it. The inventory counts what
--           this can touch (normal documents and folders whose index denies
--           read to a subject it does not deny upload, and the libraries
--           whose uploads write the index); if those are not zero, the
--           integrator decides before the paste whether such drop boxes are
--           in use (DEC-90) — keeping them working (an uploader-owner rule at
--           insert, or a server-side upload) is a separate change.
--   KACL-5 (index)  /api/storage/download-url resolves EVERY org-key sign
--           (each viewer open, thumbnail and download) by
--           document_versions.file_url (indexed since 20260827) AND by
--           source_file_key, which no migration indexed — a sequential scan
--           of document_versions on every sign. This script adds the partial
--           index document_versions_source_file_key_idx (rows with a source
--           key only). The route behaves the same before and after; only
--           the cost of its second lookup changes. CREATE INDEX (not
--           CONCURRENTLY — the SQL editor runs one transaction) holds writes
--           to document_versions for the seconds the build takes.
--   DACL-9 (inventory only)  the app's evaluateAclChain and
--           buildAclIndexFromChain used to reset the merged rules on the node
--           below a non-inheriting one too, dropping that node's own rules.
--           A non-inheriting library's or folder's DENIES now reach the
--           folders and documents below it that carry their own ACL — in the
--           app at once, in acl_index at the next rebuild (DEC-10); that
--           narrows. Its GRANTS are still dropped there (I-12 third review
--           fix): carrying them widens, and waits for the integrator's DEC-90
--           ruling. This script changes nothing for it; its inventory counts
--           the nodes and descendants concerned (upper bounds), so the
--           withheld widening half is sized for that ruling (DEC-30).
--   DACL-10 (inventory only)  the I-12 app change binds a legacy library's
--           read lists (read_access ∪ visible_to ∪ write_access ∪
--           admin_access) at the library page, the AI seam and the bytes door
--           wherever the library's own ACL says nothing — including an ACL
--           that is NULL, where base left the contents open everywhere but
--           the home page's card. That departs from the plan's DACL-10
--           default (retire the lists as enforcement) and needs the
--           integrator's DEC-90 ruling; the inventory counts the ACL-NULL
--           legacy libraries, their documents and the active non-controller
--           members their lists leave out (who lose those documents at the
--           deploy unless a deeper grant names them).
--
--   What this does NOT change (recorded on DACL-1 / DACL-6 / DACL-10, with
--   the inventory below):
--     · a normal row stays open to a member the index does not deny — the
--       app's allow-list on a chain that "says something" (DACL-6 c3) is not
--       mirrored at the database: acl_subject_in_bucket ignores the orgs
--       bucket (the library wizard's "Everyone" grant), so an allow-list here
--       would lock every member out of every "Everyone" library;
--     · the allow on a private / hidden row stays "any allowed action"
--       (DACL-12 c2): RLS answers "may this row be listed", which the app
--       grants on discover OR read (canDiscover / canWithAclChain); per-action
--       read-vs-discover stays in the app layer, as R&P DOCACL-5 recorded;
--     · libraries carry no RESTRICTIVE policy (DACL-10 c1).
--   A folder whose index carries a read deny for a subject it also allows to
--   discover is now hidden from that subject at the database (the app would
--   list its name): the same under-disclosure the user-scoped deny already
--   had; never a grant.
--
--   node_visible(text, jsonb, uuid, uuid, uuid, uuid) is re-created from its
--   NEWEST definition (20261203, found by scanning — lib/__tests__/
--   intelRoundGNodeVisibleDeny.test.ts diffs against it line by line). The
--   3-arg wrapper delegates to it and is untouched; both keep SET
--   search_path = public. CREATE OR REPLACE keeps the function's grants: a
--   policy written for every role calls it, so its
--   EXECUTE is deliberately left as it is (20261203's recorded exception to
--   DRLS-16 — a REVOKE FROM
--   PUBLIC / anon here could make a policy that judges documents for that
--   role raise instead of filtering). It reads only its arguments, the
--   caller's own org_members / team_members rows and the two SECURITY
--   DEFINER helpers it already called.
--
-- Pre-apply inventory (DEC-30, aggregate counts only, BEFORE the
-- transaction): the private / hidden rows a role / team / org deny will now
-- bind on, the normal rows whose index carries a read deny (newly judged),
-- of those the rows whose read deny names a subject the index does not deny
-- upload, and the libraries whose uploads write the chain-resolved index
-- (WRITES TOO), the normal rows whose index says something without a deny
-- (unchanged; DACL-1 / DACL-6's remaining gap), the document_versions rows
-- the new index covers, DACL-9's non-inheriting nodes and the descendants
-- with their own ACL below them, and DACL-10's ACL-NULL legacy libraries
-- (the app changes, sized here). Never a customer row.
--
-- BEFORE THE PASTE the app already refuses these rows (canReadNode, the
-- library page, the AI seam, the bytes door). AFTER IT a direct PostgREST
-- read refuses them too. A member the deny names stops seeing a row the UI
-- already hid from them — and can no longer write it back or upload into
-- it (WRITES TOO, above); no other member, and no controller or effective
-- owner, sees any change. NARROWS.
-- ORDER: after 20261203 (it carries that file's org-scoped team lookup).
-- No other pending file is needed (20260823 added
-- document_versions.source_file_key long ago). Paste it BEFORE the I-12
-- branch deploys (I-12 third review fix): from that deploy the bytes door
-- looks up source_file_key on every org-key sign (each viewer open,
-- thumbnail and download), a sequential scan of document_versions until
-- this index exists; and the DACL-9 / DACL-10 counts below are what the
-- integrator reads before the deploy. ⚠ APPLIED BY HAND (DEC-30).
-- One script; re-running is safe (CREATE INDEX IF NOT EXISTS).
--
-- ROLLBACK: re-paste 20261203's node_visible (section 3 of that file); the
-- index may stay (it only speeds a lookup) or be dropped with
-- DROP INDEX IF EXISTS document_versions_source_file_key_idx.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory (counts only) ────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS intel_i12_20261212_inventory (check_name text, n bigint);
TRUNCATE intel_i12_20261212_inventory;
INSERT INTO intel_i12_20261212_inventory
SELECT 'before: private / hidden documents whose acl_index denies read or discover to a ROLE, TEAM or ORG (the deny now binds at the database)',
       COUNT(*) FROM documents
 WHERE visibility IN ('private', 'hidden') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['roles', 'teams', 'orgs']) s(subj), unnest(ARRAY['read', 'discover']) a(act)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->a.act) = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->a.act) > 0)
UNION ALL
SELECT 'before: private / hidden folders whose acl_index denies read or discover to a ROLE, TEAM or ORG',
       COUNT(*) FROM collections
 WHERE visibility IN ('private', 'hidden') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['roles', 'teams', 'orgs']) s(subj), unnest(ARRAY['read', 'discover']) a(act)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->a.act) = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->a.act) > 0)
UNION ALL
SELECT 'before: normal-visibility documents whose acl_index denies READ to someone (newly judged; refused to the named only)',
       COUNT(*) FROM documents
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0)
UNION ALL
SELECT 'before: normal-visibility folders whose acl_index denies READ to someone',
       COUNT(*) FROM collections
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0)
UNION ALL
SELECT 'WRITES TOO: of those normal documents, the ones whose read deny names a subject the same index does not deny UPLOAD (after the paste a member it names can no longer insert such a row and read it back, nor update it)',
       COUNT(*) FROM documents
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj),
                      jsonb_array_elements_text(CASE WHEN jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                                                     THEN acl_index->'deny'->s.subj->'read' ELSE '[]'::jsonb END) x(id)
                WHERE NOT COALESCE((acl_index->'deny'->s.subj->'upload') ? x.id, false))
UNION ALL
SELECT 'WRITES TOO: of those normal folders, the ones whose read deny names a subject the same index does not deny UPLOAD (a drop box: after the paste the folder is no longer listed to that subject, nor is the way to upload into it)',
       COUNT(*) FROM collections
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj),
                      jsonb_array_elements_text(CASE WHEN jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                                                     THEN acl_index->'deny'->s.subj->'read' ELSE '[]'::jsonb END) x(id)
                WHERE NOT COALESCE((acl_index->'deny'->s.subj->'upload') ? x.id, false))
UNION ALL
SELECT 'WRITES TOO: libraries with a default ACL for new documents (an upload into them writes the chain-resolved acl_index at insert and reads the row back)',
       COUNT(*) FROM libraries WHERE jsonb_typeof(default_new_acl) = 'object'
UNION ALL
SELECT 'WRITES TOO: of those, libraries whose own ACL or default ACL has a rule that DENIES read (their uploads fail after the paste for the subjects it names; library-level rules only — a folder''s deny is in the rows above)',
       COUNT(*) FROM libraries l
 WHERE jsonb_typeof(l.default_new_acl) = 'object'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                 (CASE WHEN jsonb_typeof(l.acl->'rules') = 'array' THEN l.acl->'rules' ELSE '[]'::jsonb END)
              || (CASE WHEN jsonb_typeof(l.default_new_acl->'rules') = 'array' THEN l.default_new_acl->'rules' ELSE '[]'::jsonb END)) r
                WHERE r->>'effect' = 'deny' AND jsonb_typeof(r->'actions') = 'array' AND (r->'actions') ? 'read')
UNION ALL
SELECT 'before: normal-visibility documents with an acl_index and no read deny (unchanged — open at the database, an allow-list in the app; DACL-1 / DACL-6 residual)',
       COUNT(*) FROM documents
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                    WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                      AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0)
UNION ALL
SELECT 'KACL-5: document_versions rows with a source_file_key (the rows the new partial index covers)',
       COUNT(*) FROM document_versions WHERE source_file_key IS NOT NULL
UNION ALL
SELECT 'DACL-9: libraries whose own ACL sets inherit = false (their DENIES now reach the folders and documents below that carry their own ACL; their grants only after the DEC-90 ruling)',
       COUNT(*) FROM libraries WHERE acl->>'inherit' = 'false'
UNION ALL
SELECT 'DACL-9: folders whose own ACL sets inherit = false',
       COUNT(*) FROM collections WHERE acl->>'inherit' = 'false'
UNION ALL
SELECT 'DACL-9: of those libraries and folders, the ones with a descendant folder or document carrying its own ACL',
       (SELECT COUNT(*) FROM libraries l WHERE l.acl->>'inherit' = 'false'
           AND (EXISTS (SELECT 1 FROM collections c WHERE c.library_id = l.id AND c.acl IS NOT NULL)
             OR EXISTS (SELECT 1 FROM documents d WHERE d.library_id = l.id AND d.acl IS NOT NULL)))
     + (SELECT COUNT(*) FROM collections f WHERE f.acl->>'inherit' = 'false'
           AND (EXISTS (SELECT 1 FROM collections c WHERE f.id = ANY(c.path_ids) AND c.id <> f.id AND c.acl IS NOT NULL)
             OR EXISTS (SELECT 1 FROM documents d JOIN collections dc ON dc.id = d.collection_id
                         WHERE d.acl IS NOT NULL AND (dc.id = f.id OR f.id = ANY(dc.path_ids)))))
UNION ALL
SELECT 'DACL-9: folders and documents carrying their own ACL below a non-inheriting library or folder (upper bound of the rows the withheld grant half would widen; their denies narrow at the deploy and in acl_index at the next rebuild)',
       (SELECT COUNT(*) FROM collections c WHERE c.acl IS NOT NULL
           AND (EXISTS (SELECT 1 FROM libraries l WHERE l.id = c.library_id AND l.acl->>'inherit' = 'false')
             OR EXISTS (SELECT 1 FROM collections f WHERE f.acl->>'inherit' = 'false' AND f.id = ANY(c.path_ids) AND f.id <> c.id)))
     + (SELECT COUNT(*) FROM documents d LEFT JOIN collections dc ON dc.id = d.collection_id WHERE d.acl IS NOT NULL
           AND (EXISTS (SELECT 1 FROM libraries l WHERE l.id = d.library_id AND l.acl->>'inherit' = 'false')
             OR EXISTS (SELECT 1 FROM collections f WHERE f.acl->>'inherit' = 'false'
                         AND (f.id = dc.id OR f.id = ANY(dc.path_ids)))))
UNION ALL
SELECT 'DACL-9: of those descendants, private / hidden ones (where acl_index also decides who the database lists them to)',
       (SELECT COUNT(*) FROM collections c WHERE c.acl IS NOT NULL AND c.visibility IN ('private', 'hidden')
           AND (EXISTS (SELECT 1 FROM libraries l WHERE l.id = c.library_id AND l.acl->>'inherit' = 'false')
             OR EXISTS (SELECT 1 FROM collections f WHERE f.acl->>'inherit' = 'false' AND f.id = ANY(c.path_ids) AND f.id <> c.id)))
     + (SELECT COUNT(*) FROM documents d LEFT JOIN collections dc ON dc.id = d.collection_id
         WHERE d.acl IS NOT NULL AND d.visibility IN ('private', 'hidden')
           AND (EXISTS (SELECT 1 FROM libraries l WHERE l.id = d.library_id AND l.acl->>'inherit' = 'false')
             OR EXISTS (SELECT 1 FROM collections f WHERE f.acl->>'inherit' = 'false'
                         AND (f.id = dc.id OR f.id = ANY(dc.path_ids)))))
UNION ALL
SELECT 'DACL-10: libraries whose ACL is NULL while read_access is restricted (neither "ALL" nor NULL) — base left their contents open everywhere but the home card; the I-12 deploy binds their role lists (DEC-90 ruling needed)',
       COUNT(*) FROM libraries l
 WHERE (l.acl IS NULL OR l.acl = 'null'::jsonb)
   AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb
UNION ALL
SELECT 'DACL-10: documents filed in those libraries (by documents.library_id)',
       COUNT(*) FROM documents d JOIN libraries l ON l.id = d.library_id
 WHERE (l.acl IS NULL OR l.acl = 'null'::jsonb)
   AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb
UNION ALL
SELECT 'DACL-10: (library, member) pairs where an active non-controller member, not the library''s owner, holds no role in its read_access / visible_to / write_access / admin_access (upper bound of who loses its documents at the deploy — a deeper folder or document grant still admits them)',
       COUNT(*) FROM libraries l JOIN org_members m ON m.org_id = l.org_id AND m.status = 'active'
 WHERE (l.acl IS NULL OR l.acl = 'null'::jsonb)
   AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb
   AND NOT (m.role IN ('Admin', 'DocCtrl') OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl']::text[])
   AND l.owner_user_id IS DISTINCT FROM m.uid
   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) hr(r)
                    WHERE (jsonb_typeof(l.read_access) = 'array' AND l.read_access ? hr.r)
                       OR (jsonb_typeof(l.visible_to) = 'array' AND l.visible_to ? hr.r)
                       OR (jsonb_typeof(l.write_access) = 'array' AND l.write_access ? hr.r)
                       OR (jsonb_typeof(l.admin_access) = 'array' AND l.admin_access ? hr.r))
UNION ALL
SELECT 'DACL-10: of those pairs, distinct members',
       COUNT(DISTINCT (m.org_id, m.uid)) FROM libraries l JOIN org_members m ON m.org_id = l.org_id AND m.status = 'active'
 WHERE (l.acl IS NULL OR l.acl = 'null'::jsonb)
   AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb
   AND NOT (m.role IN ('Admin', 'DocCtrl') OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl']::text[])
   AND l.owner_user_id IS DISTINCT FROM m.uid
   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) hr(r)
                    WHERE (jsonb_typeof(l.read_access) = 'array' AND l.read_access ? hr.r)
                       OR (jsonb_typeof(l.visible_to) = 'array' AND l.visible_to ? hr.r)
                       OR (jsonb_typeof(l.write_access) = 'array' AND l.write_access ? hr.r)
                       OR (jsonb_typeof(l.admin_access) = 'array' AND l.admin_access ? hr.r))
UNION ALL
SELECT 'DACL-10: libraries whose ACL has no rule and normal visibility while read_access is restricted (base closed their contents at the library page and the AI seam to every non-controller a deeper grant did not name; the deploy opens them to the listed roles)',
       COUNT(*) FROM libraries l
 WHERE jsonb_typeof(l.acl) = 'object'
   AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(l.acl->'rules') = 'array' THEN l.acl->'rules' END), 0) = 0
   AND COALESCE(l.acl->>'visibility', 'normal') NOT IN ('private', 'hidden')
   AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb;

BEGIN;

-- ── 0b. KACL-5: the native-source lookup the bytes door makes on every sign ─
CREATE INDEX IF NOT EXISTS document_versions_source_file_key_idx
  ON document_versions (source_file_key) WHERE source_file_key IS NOT NULL;

-- ── 1. node_visible: deny for every subject, on every visibility ────────────
-- Body from 20261203 (its newest definition). Changes: the normal fast path
-- reads the index's read-deny lists; the deny check names user, every held
-- role, team and org, and runs before the allow; a normal row the deny does
-- not name returns true after it; on a normal row the controller check and
-- the ownership cascade wait until the deny names the caller (cost — see the
-- header).
CREATE OR REPLACE FUNCTION node_visible(
  p_visibility text,
  p_acl_index  jsonb,
  p_org        uuid,
  p_owner      uuid,
  p_collection uuid,
  p_library    uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   text := auth.uid()::text;
  v_role  text;
  v_roles text[];
  v_teams text[];
  v_normal boolean := (p_visibility IS NULL OR p_visibility = 'normal');
BEGIN
  -- Fail-safe: normal/unset visibility is open to org members — unless the
  -- row's chain-resolved acl_index carries an explicit READ deny (IEDGE-12 /
  -- DACL-1, intelligence I-12). Fast path: no non-empty deny.<subject>.read
  -- list means no table is read and the row is open, as before.
  IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (
       SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
        WHERE jsonb_typeof(p_acl_index->'deny'->s.subj->'read') = 'array'
          AND jsonb_array_length(p_acl_index->'deny'->s.subj->'read') > 0)) THEN
    RETURN true;
  END IF;

  -- Controllers always see everything. OWN-3/DEC-2: the controller tier is a
  -- property of the role COLLECTION (is_org_controller: role IN (...) OR
  -- roles && ARRAY[...]), so an additively-held DocCtrl sees a private library.
  -- A NORMAL row reaching here carries a read deny: its controller check and
  -- ownership cascade wait until that deny names the caller (below), so a
  -- member it does not name costs the member and team reads only.
  IF NOT v_normal THEN
    IF is_org_controller(p_org) THEN
      RETURN true;
    END IF;
  END IF;
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;
  IF v_role IS NOT NULL AND NOT (v_role = ANY(COALESCE(v_roles, '{}'::text[]))) THEN
    v_roles := array_append(v_roles, v_role);
  END IF;

  -- GAP-15/DEC-7: ownership carries read access. Placed after the controller
  -- short-circuit and before the acl_index check (the decision's ordering —
  -- an owner outranks a stray deny of their own document). The cascade
  -- (document → folder → library → team supervisor) is the same SECURITY
  -- DEFINER function the publish guard trusts, so no recursion.
  IF NOT v_normal THEN
    IF user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()) THEN
      RETURN true;
    END IF;
  END IF;

  -- Restricted with no grant table -> only controllers (already returned).
  IF p_acl_index IS NULL THEN
    RETURN false;
  END IF;

  SELECT array_agg(team_id::text) INTO v_teams
    FROM team_members WHERE uid = auth.uid() AND org_id = p_org;

  -- Explicit deny wins (DACL-12): a deny of read — or, on a hidden / private
  -- row, of discover — naming the caller by uid, by ANY held role, by a team
  -- or by the workspace refuses before any allow is read (lib/acl: a deny of
  -- an action wins, OWN-8).
  IF EXISTS (
       SELECT 1 FROM unnest(CASE WHEN v_normal THEN ARRAY['read'] ELSE ARRAY['read', 'discover'] END) a(act)
        WHERE (p_acl_index->'deny'->'users'->a.act) ? v_uid
           OR (p_acl_index->'deny'->'orgs'->a.act) ? p_org::text
           OR EXISTS (SELECT 1 FROM unnest(COALESCE(v_roles, '{}'::text[])) r
                       WHERE (p_acl_index->'deny'->'roles'->a.act) ? r)
           OR EXISTS (SELECT 1 FROM unnest(COALESCE(v_teams, '{}'::text[])) t
                       WHERE (p_acl_index->'deny'->'teams'->a.act) ? t)) THEN
    -- On a normal row the deny names the caller: a controller and the
    -- effective owner still read it (asked only now); anyone else does not.
    IF v_normal THEN
      IF is_org_controller(p_org) THEN
        RETURN true;
      END IF;
      RETURN COALESCE(user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()), false);
    END IF;
    RETURN false;
  END IF;

  -- A normal row the deny does not name stays open (the fail-safe default).
  IF v_normal THEN
    RETURN true;
  END IF;

  -- Any allow grant (any action) lets the row through; finer read-vs-
  -- discover distinctions stay in the app layer. CHAIN-1/ADD-1: a role
  -- subject matches ANY held role, not only the headline.
  RETURN acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams)
      OR (v_roles IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(v_roles) r
             WHERE acl_subject_in_bucket(p_acl_index->'allow', v_uid, r, NULL::text[])));
END;
$$;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'node_visible/6: SECURITY DEFINER, search_path pinned; controller via is_org_controller before the owner branch; every held role; team lookup org-scoped (ORG-13)' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6 AND prosecdef
                  AND proconfig @> ARRAY['search_path=public']
                  AND prosrc LIKE '%IF is_org_controller(p_org) THEN%'
                  AND position('is_org_controller(p_org)' in prosrc) < position('user_is_effective_owner(p_owner' in prosrc)
                  AND prosrc LIKE '%FROM unnest(v_roles) r%'
                  AND prosrc LIKE '%FROM team_members WHERE uid = auth.uid() AND org_id = p_org;%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'node_visible/6: the deny check names user, every held role, team and org (DACL-12 c1), and runs before the allow',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%(p_acl_index->''deny''->''users''->a.act) ? v_uid%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''orgs''->a.act) ? p_org::text%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''roles''->a.act) ? r%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''teams''->a.act) ? t%'
                  AND position('''deny''->''teams''' in prosrc) < position('acl_subject_in_bucket(p_acl_index->''allow''' in prosrc)),
       NULL
UNION ALL
SELECT 'node_visible/6: a normal row reads its index''s read-deny lists before opening (IEDGE-12 c2), with no table read on the fast path',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (%'
                  AND position('IF v_normal AND (p_acl_index IS NULL' in prosrc) < position('is_org_controller(p_org)' in prosrc)),
       NULL
UNION ALL
SELECT 'node_visible/3 and /6 both carry SET search_path = public; the 3-arg wrapper still delegates',
       (SELECT COUNT(*) = 2 FROM pg_proc WHERE proname = 'node_visible' AND pronargs IN (3, 6)
          AND proconfig @> ARRAY['search_path=public'])
       AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 3
                      AND prosrc LIKE '%node_visible(p_visibility, p_acl_index, p_org, NULL::uuid, NULL::uuid, NULL::uuid)%'),
       NULL
UNION ALL
SELECT 'behaviour (no session): a normal row with no index is open; a normal row whose read deny names nobody here is open; a private row with no index is closed',
       node_visible('normal', NULL::jsonb, '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL)
       AND node_visible('normal', '{"deny":{"users":{"read":["00000000-0000-0000-0000-0000000000aa"]}}}'::jsonb,
                        '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL)
       AND NOT node_visible('private', NULL::jsonb, '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL),
       NULL
UNION ALL
SELECT 'node_visible/6: on a normal row the controller check and the ownership cascade run only after the deny names the caller (cost); a private / hidden row keeps the controller-first order',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%IF NOT v_normal THEN%IF is_org_controller(p_org) THEN%'
                  AND prosrc LIKE '%IF v_normal THEN%IF is_org_controller(p_org) THEN%RETURN COALESCE(user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()), false);%'
                  AND position('FROM team_members WHERE uid = auth.uid() AND org_id = p_org;' in prosrc)
                      < position('RETURN COALESCE(user_is_effective_owner(' in prosrc)),
       NULL
UNION ALL
SELECT 'KACL-5: document_versions_source_file_key_idx exists on document_versions (source_file_key), partial on source_file_key IS NOT NULL',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'document_versions'
                  AND indexname = 'document_versions_source_file_key_idx'
                  AND indexdef LIKE '%(source_file_key)%' AND indexdef LIKE '%WHERE (source_file_key IS NOT NULL)%'),
       NULL
UNION ALL
SELECT 'documents_acl_select and collections_acl_select still call the 6-arg node_visible',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE schemaname = 'public' AND policyname IN ('documents_acl_select', 'collections_acl_select')
           AND permissive = 'RESTRICTIVE' AND qual LIKE '%node_visible(visibility, acl_index, org_id, owner_user_id,%'),
       NULL
UNION ALL
SELECT check_name, NULL, n::text FROM intel_i12_20261212_inventory;
