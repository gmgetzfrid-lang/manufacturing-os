-- ─────────────────────────────────────────────────────────────────────────────
-- 20261212 — intelligence Round G, I-12 DOCUMENT ACL BOUNDARY: the KACL-5
-- source-key index, and node_visible honouring an explicit read deny for
-- every subject and on every visibility — SELF-GATED on drop boxes (DEC-90
-- ruling R2, the integrator, 2026-10-14).
--
-- WHAT APPLIES WHEN (read this first):
--   1. ALWAYS, on every paste — the KACL-5 index
--      document_versions_source_file_key_idx. It is a standalone
--      CREATE INDEX IF NOT EXISTS placed before the transaction, and nothing
--      after it raises on purpose (the gate below decides with a NOTICE,
--      never an error), so whatever the gate decides the index is there when
--      the paste completes. (The SQL editor sends a paste as ONE message, so
--      a statement that ERRORED later — none is expected — would roll the
--      whole paste back, the index included: re-paste.) The index is the
--      I-12 deploy's ONLY prerequisite.
--   2. ONLY WHEN every drop-box precondition count is 0 — node_visible/6 is
--      re-created with the deny binding (DACL-12 c1, IEDGE-12 c2, below).
--      With any precondition count above 0 the file RAISEs a NOTICE and
--      leaves node_visible/6 exactly as it was (20261203's on a first paste):
--      the deny binding does not apply at the database, nothing else
--      changes, and every drop box keeps taking uploads. Lifting this gate —
--      making drop-box uploads keep working WITH the deny binding (an
--      uploader rule at insert, or a server-side insert), then re-creating
--      node_visible without the gate — is intelligence I-30's (NODE_VISIBLE
--      ALLOW-LIST, DROP BOXES AND INHERITED GRANTS).
--   3. ALWAYS — the counts-only inventory (DEC-30): the precondition counts,
--      what the binding would touch, DACL-9's and DACL-10's counts. Captured
--      before the transaction and reported in the one result set; it changes
--      no row.
--   The app behaves correctly in both outcomes: it already refuses a read
--   the index denies (lib/permissions canReadNode — the library page, the AI
--   seam, the bytes door), with or without the binding at the database.
--   A RE-PASTE never takes an applied binding away: with a precondition
--   count above 0 it leaves node_visible/6 as it is, whichever body it has.
--
--   DACL-12 c1  node_visible() consulted only USER-scoped deny entries: a
--           deny of read / discover whose subject is a ROLE, a TEAM or the
--           WORKSPACE never bound at the database, so a member holding any
--           allow on a private / hidden row read it through PostgREST while
--           the app (lib/acl evaluateRules — a deny of an action wins, OWN-8)
--           refused it. With the binding, the deny check names the caller by
--           uid, by ANY held role (role ∪ roles, as the allow branch already
--           does), by each of their teams in the node's org, and by the
--           node's org, BEFORE any allow is read.
--   IEDGE-12 c2 / DACL-1 (read-time half)  a NORMAL-visibility row opened
--           before node_visible looked at its acl_index, so a document whose
--           chain-resolved index (DEC-10: rebuilt from the WHOLE chain at
--           save, at a folder move and nightly) carries an explicit READ deny
--           naming the caller came back to a direct PostgREST read — and
--           through doc_is_visible its document_versions.file_url — while the
--           AI seam and the bytes door (lib/permissions canReadNode, this
--           package) refused it. With the binding, a normal row whose index
--           carries any read deny entry is judged: controller, then effective
--           owner, then the deny check; a caller the deny does not name keeps
--           the row (normal stays open — the fail-safe default). FAST PATH: a
--           normal row whose index has no non-empty deny.<subject>.read list
--           returns true from a jsonb test alone, with no table read, exactly
--           as before; the member / team reads run only for the rows a read
--           deny names someone on.
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
--   ⚠ WRITES TOO — why the binding is gated (I-12 third review fix,
--           reproduced on PostgreSQL 16; ruled under DEC-90, R2).
--           documents_acl_select and collections_acl_select are RESTRICTIVE
--           policies for SELECT, so the binding also applies wherever
--           PostgreSQL checks SELECT policies on a write: INSERT ... RETURNING
--           (PostgREST's insert(...).select()) and the existing rows an
--           UPDATE or DELETE with a filter can reach. With the binding, a
--           member a row's read deny names can no longer insert such a row
--           and read it back, nor update it; and a folder whose index denies
--           them read is no longer listed to them, so they cannot reach it.
--           The database admits an upload unless an upload deny names the
--           member, and the library page's upload (app/(protected)
--           /documents/[libraryId]/page.tsx uploadOne) writes acl_index from
--           the chain (with the library's default visibility) whenever the
--           library has a default new-document ACL, then inserts with
--           .select("id").single() — so with the binding a "drop box" (a
--           library or folder that denies a role READ and lets it UPLOAD)
--           would stop taking that role's uploads (ERROR: new
--           row violates row-level security policy "documents_acl_select",
--           raised after the file is already in storage), and its folder
--           would disappear for them.
--           The same insert without RETURNING succeeds.
--           Ruling R2: a drop box is a legitimate, common pattern and must
--           keep working, so the re-creation runs only where the live data
--           holds none. THE PRECONDITION (section 0; each count
--           must be 0; where the code leaves a doubt, the predicate counts):
--             P1 normal documents whose acl_index denies READ to a subject
--                (user, role, team or org) the same index does not deny
--                UPLOAD;
--             P2 private / hidden (any visibility but normal / NULL)
--                documents whose acl_index denies read or discover to a
--                ROLE, TEAM or ORG the same index does not deny upload — the
--                binding newly refuses those subjects there (a user-scoped
--                deny already bound in 20261203, so it is not counted);
--             P3 / P4 the same two tests on folders (collections) — a folder
--                the binding hides cannot be uploaded into;
--             P5 libraries whose own ACL has a rule denying read (or, for a
--                role / team / org, discover) to a subject no deny-upload
--                rule of that same ACL names, or whose default new-document
--                ACL has such a rule at all (an upload writes it into the
--                new row's index; the subject's right to upload is decided
--                by the containers, not by that ACL, so nothing excludes
--                it). A library's own rules reach every folder's index at
--                the next rebuild and every new row's;
--             P6 folders whose own ACL has a rule denying read (or, for a
--                role / team / org, discover) to a subject no deny-upload
--                rule of that same ACL names.
--             Why "the same ACL": a node's deny-upload and deny-read rules
--             reach an index together or not at all (an inherit:false node
--             below clears both), so only an upload deny on the SAME node
--             proves the subject cannot upload wherever its read deny
--             applies. An expired rule is counted (it may not have expired
--             in an index built earlier), and the app's further requirement
--             that the uploader hold an upload allow is not applied — both
--             err toward counting.
--   KACL-5 (index)  /api/storage/download-url resolves EVERY org-key sign
--           (each viewer open, thumbnail and download) by
--           document_versions.file_url (indexed since 20260827) AND by
--           source_file_key, which no migration indexed — a sequential scan
--           of document_versions on every sign. This script adds the partial
--           index document_versions_source_file_key_idx (rows with a source
--           key only), standalone and before the transaction (item 1 above).
--           The route behaves the same before and after; only the cost of its
--           second lookup changes. CREATE INDEX (not CONCURRENTLY — the SQL
--           editor runs one transaction) holds writes to document_versions
--           while it builds, until the paste commits (seconds).
--   DACL-9 (inventory only)  the app's evaluateAclChain and
--           buildAclIndexFromChain used to reset the merged rules on the node
--           below a non-inheriting one too, dropping that node's own rules.
--           A non-inheriting library's or folder's DENIES now reach the
--           folders and documents below it that carry their own ACL — in the
--           app at once, in acl_index at the next rebuild (DEC-10); that
--           narrows. Its GRANTS are still dropped there (I-12 third review
--           fix): carrying them to the descendants that inherit is the
--           correct semantics (DEC-90 ruling R3, 2026-10-14: the admin
--           configured them), and it is carried by intelligence I-30
--           together with the acl_index rebuild, sized by this inventory's
--           DACL-9 counts (upper bounds). This branch keeps the narrowing
--           half only; this script changes nothing for it.
--   DACL-10 (inventory only)  the I-12 app change binds a legacy library's
--           read lists (read_access ∪ visible_to ∪ write_access ∪
--           admin_access) at the library page, the AI seam and the bytes door
--           wherever the library's own ACL says nothing — including an ACL
--           that is NULL, where base left the contents open everywhere but
--           the home page's card. Ruled by the integrator under DEC-90 (R1,
--           2026-10-14): the binding STAYS (fail-safe — an admin's stated
--           restriction is honoured; controllers (DEC-43), the owner and
--           deeper grants keep access); the end state is intelligence I-31
--           (the lists retired into libraries.acl). The DACL-10 counts are
--           informational: read "members the lists leave out" before the
--           I-12 deploy.
--
--   What this does NOT change (recorded on DACL-1 / DACL-6 / DACL-10, with
--   the inventory below):
--     · a normal row stays open to a member the index does not deny — the
--       app's allow-list on a chain that "says something" (DACL-6 c3) is not
--       mirrored at the database: acl_subject_in_bucket ignores the orgs
--       bucket (the library wizard's "Everyone" grant), so an allow-list here
--       would lock every member out of every "Everyone" library (the
--       allow-list, with the orgs bucket added and counts first, is
--       intelligence I-30's — DEC-90 ruling R5);
--     · the allow on a private / hidden row stays "any allowed action"
--       (DACL-12 c2): RLS answers "may this row be listed", which the app
--       grants on discover OR read (canDiscover / canWithAclChain); per-action
--       read-vs-discover stays in the app layer, as R&P DOCACL-5 recorded;
--     · libraries carry no RESTRICTIVE policy (DACL-10 c1; DEC-90 ruling R6:
--       none is added — the lists are retired into libraries.acl by
--       intelligence I-31).
--   With the binding, a folder whose index carries a read deny for a subject
--   it also allows to discover is hidden from that subject at the database
--   (the app would list its name): the same under-disclosure the user-scoped
--   deny already had; never a grant.
--
--   node_visible(text, jsonb, uuid, uuid, uuid, uuid) is re-created (when the
--   gate allows) from its NEWEST definition (20261203, found by scanning —
--   lib/__tests__/intelRoundGNodeVisibleDeny.test.ts diffs against it line
--   by line); the definition is the text EXECUTEd inside the gate's DO
--   block, unchanged. The 3-arg wrapper delegates to it and is untouched;
--   both keep SET search_path = public. CREATE OR REPLACE keeps the
--   function's grants: a policy written for every role calls it, so its
--   EXECUTE is deliberately left as it is (20261203's recorded exception to
--   DRLS-16 — a REVOKE FROM
--   PUBLIC / anon here could make a policy that judges documents for that
--   role raise instead of filtering). It reads only its arguments, the
--   caller's own org_members / team_members rows and the two SECURITY
--   DEFINER helpers it already called.
--
-- Pre-apply inventory (DEC-30, aggregate counts only, BEFORE the
-- transaction; `pre` marks the six precondition counts): P1–P6 above, the
-- private / hidden rows a role / team / org deny would bind on, the normal
-- rows whose index carries a read deny (judged with the binding), the
-- libraries whose uploads write the chain-resolved index, the normal rows
-- whose index says something without a deny (unchanged; DACL-1 / DACL-6's
-- remaining gap), the document_versions rows the new index covers, DACL-9's
-- non-inheriting nodes and the descendants with their own ACL below them,
-- and DACL-10's ACL-NULL legacy libraries and the members their lists leave
-- out. Never a customer row. A pre-apply snapshot of node_visible/6's body
-- hash (one md5, a catalog read) lets the result say the body was left
-- untouched when the gate held it back.
--
-- BEFORE THE PASTE the app already refuses these rows (canReadNode, the
-- library page, the AI seam, the bytes door). AFTER IT, when the binding
-- applied, a direct PostgREST read refuses them too: a member the deny
-- names stops seeing a row the UI already hid from them — and
-- can no longer write it back or upload into
-- it (WRITES TOO, above), which is why the binding applies only where no
-- drop box exists; no other member, and no controller or effective owner,
-- sees any change. When the gate held it back, the database answers
-- exactly as before the paste. NARROWS (or changes nothing but the index).
-- ⚠ THE GATE IS DECIDED AT PASTE TIME. Once the binding applied, a drop box
-- an admin configures LATER does not take its uploader's rows (the
-- INSERT ... RETURNING above) until intelligence I-30 lifts the gate; a
-- re-paste then holds the gate (NOTICE) but never removes the binding
-- (re-paste 20261203's node_visible — the ROLLBACK below — to restore the
-- old behaviour). Pinned in lib/__tests__/rls/intelI12DropBoxGate.test.ts.
--
-- PASTE FACTS.
--   ORDER: after 20261203 (it carries that file's org-scoped team lookup).
--   No other pending file is needed (20260823 added
--   document_versions.source_file_key long ago).
--   DEPLOY GATE: Paste it BEFORE the I-12
--   branch deploys. The prerequisite is the index only: from that deploy
--   the bytes door looks up source_file_key on every org-key sign (each
--   viewer open, thumbnail and download), a sequential scan of
--   document_versions until the index exists. Whether the binding applied
--   does not gate the deploy (the app refuses denied reads either way).
--   Read the DACL-10 "members the lists leave out" count before the deploy
--   (informational, DEC-90 R1).
--   EXPECTED RESULT (one result set, 33 rows: check, ok, n):
--     10 probes (n NULL). Binding APPLIED (every precondition count 0 — a
--     fresh install, or a live database with no drop box): every probe ok =
--     true. Binding HELD BACK (a precondition count above 0; a NOTICE says
--     how many): the gate probe ok = false, the three probes of the new body
--     ok = NULL (not applicable), every other probe ok = true — "node_visible
--     /6 is what the gate decided" then proves the body is byte-for-byte what
--     it was before the paste.
--     23 count rows (ok NULL): the six precondition counts (each 0 when the
--     binding applied; their sum is the NOTICE's number otherwise), then the
--     seventeen inventory counts.
--   WHAT TO SEND BACK: the 33 rows (or at least the gate row, the six
--   precondition rows, and the DACL-9 and DACL-10 rows) and any NOTICE.
--   ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe (CREATE
--   INDEX IF NOT EXISTS; the gate re-checks the live data; a re-paste never
--   removes an applied binding).
--
-- ROLLBACK: re-paste 20261203's node_visible (section 3 of that file) —
-- only needed when the binding applied; the index may stay (it only speeds a
-- lookup) or be dropped with
-- DROP INDEX IF EXISTS document_versions_source_file_key_idx.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory and the drop-box precondition (counts only) ─────
-- `pre` marks a precondition count (P1–P6 in the header): node_visible/6 is
-- re-created only when every one of them is 0.
DROP TABLE IF EXISTS pg_temp.intel_i12_20261212_inventory;
CREATE TEMP TABLE intel_i12_20261212_inventory (ord int, check_name text, n bigint, pre boolean);
INSERT INTO intel_i12_20261212_inventory
SELECT 1, 'precondition P1 (expect 0 for the binding to apply): normal documents whose acl_index denies READ to a subject (user, role, team or org) the same index does not deny UPLOAD — a drop box''s rows',
       COUNT(*), true FROM documents
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj),
                      jsonb_array_elements_text(CASE WHEN jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                                                     THEN acl_index->'deny'->s.subj->'read' ELSE '[]'::jsonb END) x(id)
                WHERE NOT COALESCE((acl_index->'deny'->s.subj->'upload') ? x.id, false))
UNION ALL
SELECT 2, 'precondition P2 (expect 0): private / hidden documents whose acl_index denies read or discover to a ROLE, TEAM or ORG the same index does not deny UPLOAD (the binding newly refuses them there; a user-scoped deny already bound)',
       COUNT(*), true FROM documents
 WHERE NOT (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['roles', 'teams', 'orgs']) s(subj), unnest(ARRAY['read', 'discover']) a(act),
                      jsonb_array_elements_text(CASE WHEN jsonb_typeof(acl_index->'deny'->s.subj->a.act) = 'array'
                                                     THEN acl_index->'deny'->s.subj->a.act ELSE '[]'::jsonb END) x(id)
                WHERE NOT COALESCE((acl_index->'deny'->s.subj->'upload') ? x.id, false))
UNION ALL
SELECT 3, 'precondition P3 (expect 0): normal folders whose acl_index denies READ to a subject the same index does not deny UPLOAD (with the binding the folder is no longer listed to that subject, nor is the way to upload into it)',
       COUNT(*), true FROM collections
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj),
                      jsonb_array_elements_text(CASE WHEN jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                                                     THEN acl_index->'deny'->s.subj->'read' ELSE '[]'::jsonb END) x(id)
                WHERE NOT COALESCE((acl_index->'deny'->s.subj->'upload') ? x.id, false))
UNION ALL
SELECT 4, 'precondition P4 (expect 0): private / hidden folders whose acl_index denies read or discover to a ROLE, TEAM or ORG the same index does not deny UPLOAD',
       COUNT(*), true FROM collections
 WHERE NOT (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['roles', 'teams', 'orgs']) s(subj), unnest(ARRAY['read', 'discover']) a(act),
                      jsonb_array_elements_text(CASE WHEN jsonb_typeof(acl_index->'deny'->s.subj->a.act) = 'array'
                                                     THEN acl_index->'deny'->s.subj->a.act ELSE '[]'::jsonb END) x(id)
                WHERE NOT COALESCE((acl_index->'deny'->s.subj->'upload') ? x.id, false))
UNION ALL
SELECT 5, 'precondition P5 (expect 0): libraries whose own ACL denies read (or, to a role / team / org, discover) to a subject no deny-upload rule of that ACL names, or whose default new-document ACL denies either at all (the next upload writes it into the new row''s index; the folders below take the library''s rules at their next index rebuild)',
       COUNT(*), true FROM libraries l
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.acl->'rules') = 'array' THEN l.acl->'rules' ELSE '[]'::jsonb END) r
                WHERE r->>'effect' = 'deny' AND jsonb_typeof(r->'actions') = 'array'
                  AND ((r->'actions') ? 'read' OR ((r->'actions') ? 'discover' AND r->'subject'->>'type' IN ('role', 'team', 'org')))
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l.acl->'rules') u
                                   WHERE u->>'effect' = 'deny' AND jsonb_typeof(u->'actions') = 'array' AND (u->'actions') ? 'upload'
                                     AND u->'subject'->>'type' IS NOT DISTINCT FROM r->'subject'->>'type'
                                     AND u->'subject'->>'id' IS NOT DISTINCT FROM r->'subject'->>'id'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.default_new_acl->'rules') = 'array' THEN l.default_new_acl->'rules' ELSE '[]'::jsonb END) r
                WHERE r->>'effect' = 'deny' AND jsonb_typeof(r->'actions') = 'array'
                  AND ((r->'actions') ? 'read' OR ((r->'actions') ? 'discover' AND r->'subject'->>'type' IN ('role', 'team', 'org'))))
UNION ALL
SELECT 6, 'precondition P6 (expect 0): folders whose own ACL denies read (or, to a role / team / org, discover) to a subject no deny-upload rule of that ACL names (an upload into it, or below it, writes that deny into the new row''s index; the folder''s own index carries it at its next rebuild)',
       COUNT(*), true FROM collections c
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.acl->'rules') = 'array' THEN c.acl->'rules' ELSE '[]'::jsonb END) r
                WHERE r->>'effect' = 'deny' AND jsonb_typeof(r->'actions') = 'array'
                  AND ((r->'actions') ? 'read' OR ((r->'actions') ? 'discover' AND r->'subject'->>'type' IN ('role', 'team', 'org')))
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c.acl->'rules') u
                                   WHERE u->>'effect' = 'deny' AND jsonb_typeof(u->'actions') = 'array' AND (u->'actions') ? 'upload'
                                     AND u->'subject'->>'type' IS NOT DISTINCT FROM r->'subject'->>'type'
                                     AND u->'subject'->>'id' IS NOT DISTINCT FROM r->'subject'->>'id'))
UNION ALL
SELECT 7, 'before: private / hidden documents whose acl_index denies read or discover to a ROLE, TEAM or ORG (with the binding the deny binds at the database)',
       COUNT(*), false FROM documents
 WHERE visibility IN ('private', 'hidden') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['roles', 'teams', 'orgs']) s(subj), unnest(ARRAY['read', 'discover']) a(act)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->a.act) = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->a.act) > 0)
UNION ALL
SELECT 8, 'before: private / hidden folders whose acl_index denies read or discover to a ROLE, TEAM or ORG',
       COUNT(*), false FROM collections
 WHERE visibility IN ('private', 'hidden') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['roles', 'teams', 'orgs']) s(subj), unnest(ARRAY['read', 'discover']) a(act)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->a.act) = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->a.act) > 0)
UNION ALL
SELECT 9, 'before: normal-visibility documents whose acl_index denies READ to someone (judged with the binding; refused to the named only)',
       COUNT(*), false FROM documents
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0)
UNION ALL
SELECT 10, 'before: normal-visibility folders whose acl_index denies READ to someone',
       COUNT(*), false FROM collections
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0)
UNION ALL
SELECT 11, 'WRITES TOO: libraries with a default ACL for new documents (an upload into them writes the chain-resolved acl_index at insert and reads the row back)',
       COUNT(*), false FROM libraries WHERE jsonb_typeof(default_new_acl) = 'object'
UNION ALL
SELECT 12, 'before: normal-visibility documents with an acl_index and no read deny (unchanged — open at the database, an allow-list in the app; DACL-1 / DACL-6 residual, intelligence I-30)',
       COUNT(*), false FROM documents
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                    WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                      AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0)
UNION ALL
SELECT 13, 'KACL-5: document_versions rows with a source_file_key (the rows the new partial index covers)',
       COUNT(*), false FROM document_versions WHERE source_file_key IS NOT NULL
UNION ALL
SELECT 14, 'DACL-9: libraries whose own ACL sets inherit = false (their DENIES now reach the folders and documents below that carry their own ACL; their grants are carried by intelligence I-30 with the acl_index rebuild — DEC-90 R3)',
       COUNT(*), false FROM libraries WHERE acl->>'inherit' = 'false'
UNION ALL
SELECT 15, 'DACL-9: folders whose own ACL sets inherit = false',
       COUNT(*), false FROM collections WHERE acl->>'inherit' = 'false'
UNION ALL
SELECT 16, 'DACL-9: of those libraries and folders, the ones with a descendant folder or document carrying its own ACL',
       (SELECT COUNT(*) FROM libraries l WHERE l.acl->>'inherit' = 'false'
           AND (EXISTS (SELECT 1 FROM collections c WHERE c.library_id = l.id AND c.acl IS NOT NULL)
             OR EXISTS (SELECT 1 FROM documents d WHERE d.library_id = l.id AND d.acl IS NOT NULL)))
     + (SELECT COUNT(*) FROM collections f WHERE f.acl->>'inherit' = 'false'
           AND (EXISTS (SELECT 1 FROM collections c WHERE f.id = ANY(c.path_ids) AND c.id <> f.id AND c.acl IS NOT NULL)
             OR EXISTS (SELECT 1 FROM documents d JOIN collections dc ON dc.id = d.collection_id
                         WHERE d.acl IS NOT NULL AND (dc.id = f.id OR f.id = ANY(dc.path_ids))))), false
UNION ALL
SELECT 17, 'DACL-9: folders and documents carrying their own ACL below a non-inheriting library or folder (upper bound of the rows intelligence I-30''s grant half widens; their denies narrow at the deploy and in acl_index at the next rebuild)',
       (SELECT COUNT(*) FROM collections c WHERE c.acl IS NOT NULL
           AND (EXISTS (SELECT 1 FROM libraries l WHERE l.id = c.library_id AND l.acl->>'inherit' = 'false')
             OR EXISTS (SELECT 1 FROM collections f WHERE f.acl->>'inherit' = 'false' AND f.id = ANY(c.path_ids) AND f.id <> c.id)))
     + (SELECT COUNT(*) FROM documents d LEFT JOIN collections dc ON dc.id = d.collection_id WHERE d.acl IS NOT NULL
           AND (EXISTS (SELECT 1 FROM libraries l WHERE l.id = d.library_id AND l.acl->>'inherit' = 'false')
             OR EXISTS (SELECT 1 FROM collections f WHERE f.acl->>'inherit' = 'false'
                         AND (f.id = dc.id OR f.id = ANY(dc.path_ids))))), false
UNION ALL
SELECT 18, 'DACL-9: of those descendants, private / hidden ones (where acl_index also decides who the database lists them to)',
       (SELECT COUNT(*) FROM collections c WHERE c.acl IS NOT NULL AND c.visibility IN ('private', 'hidden')
           AND (EXISTS (SELECT 1 FROM libraries l WHERE l.id = c.library_id AND l.acl->>'inherit' = 'false')
             OR EXISTS (SELECT 1 FROM collections f WHERE f.acl->>'inherit' = 'false' AND f.id = ANY(c.path_ids) AND f.id <> c.id)))
     + (SELECT COUNT(*) FROM documents d LEFT JOIN collections dc ON dc.id = d.collection_id
         WHERE d.acl IS NOT NULL AND d.visibility IN ('private', 'hidden')
           AND (EXISTS (SELECT 1 FROM libraries l WHERE l.id = d.library_id AND l.acl->>'inherit' = 'false')
             OR EXISTS (SELECT 1 FROM collections f WHERE f.acl->>'inherit' = 'false'
                         AND (f.id = dc.id OR f.id = ANY(dc.path_ids))))), false
UNION ALL
SELECT 19, 'DACL-10: libraries whose ACL is NULL while read_access is restricted (neither "ALL" nor NULL) — base left their contents open everywhere but the home card; the I-12 deploy binds their role lists (ruled under DEC-90, R1, 2026-10-14: the binding stays)',
       COUNT(*), false FROM libraries l
 WHERE (l.acl IS NULL OR l.acl = 'null'::jsonb)
   AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb
UNION ALL
SELECT 20, 'DACL-10: documents filed in those libraries (by documents.library_id)',
       COUNT(*), false FROM documents d JOIN libraries l ON l.id = d.library_id
 WHERE (l.acl IS NULL OR l.acl = 'null'::jsonb)
   AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb
UNION ALL
SELECT 21, 'DACL-10: (library, member) pairs where an active non-controller member, not the library''s owner, holds no role in its read_access / visible_to / write_access / admin_access (upper bound of who loses its documents at the deploy — a deeper folder or document grant still admits them)',
       COUNT(*), false FROM libraries l JOIN org_members m ON m.org_id = l.org_id AND m.status = 'active'
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
SELECT 22, 'DACL-10: of those pairs, distinct members — "members the lists leave out" (informational; read it before the I-12 deploy, DEC-90 R1)',
       COUNT(DISTINCT (m.org_id, m.uid)), false FROM libraries l JOIN org_members m ON m.org_id = l.org_id AND m.status = 'active'
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
SELECT 23, 'DACL-10: libraries whose ACL has no rule and normal visibility while read_access is restricted (base closed their contents at the library page and the AI seam to every non-controller a deeper grant did not name; the deploy opens them to the listed roles)',
       COUNT(*), false FROM libraries l
 WHERE jsonb_typeof(l.acl) = 'object'
   AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(l.acl->'rules') = 'array' THEN l.acl->'rules' END), 0) = 0
   AND COALESCE(l.acl->>'visibility', 'normal') NOT IN ('private', 'hidden')
   AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb;

-- The body node_visible/6 has before this paste (one md5 of the catalog's
-- prosrc), so the result can say it was left untouched when the gate held
-- the binding back.
DROP TABLE IF EXISTS pg_temp.intel_i12_20261212_before;
CREATE TEMP TABLE intel_i12_20261212_before AS
SELECT md5(p.prosrc) AS body_md5 FROM pg_proc p
 WHERE p.proname = 'node_visible' AND p.pronargs = 6 AND p.pronamespace = 'public'::regnamespace;

-- ── 0b. KACL-5: the native-source lookup the bytes door makes on every sign ─
-- Standalone, before the transaction: it applies on every paste, whatever the
-- gate below decides (header, item 1).
CREATE INDEX IF NOT EXISTS document_versions_source_file_key_idx
  ON document_versions (source_file_key) WHERE source_file_key IS NOT NULL;

BEGIN;

-- ── 1. node_visible: deny for every subject, on every visibility — GATED ───
-- R2 (DEC-90, 2026-10-14): only when every precondition count is 0.
-- Otherwise a NOTICE, and node_visible/6 is left exactly as it is.
-- Body from 20261203 (its newest definition). Changes: the normal fast path
-- reads the index's read-deny lists; the deny check names user, every held
-- role, team and org, and runs before the allow; a normal row the deny does
-- not name returns true after it; on a normal row the controller check and
-- the ownership cascade wait until the deny names the caller (cost — see the
-- header).
DO $gate$
DECLARE
  v_blockers bigint;
BEGIN
  SELECT COALESCE(SUM(n), 0) INTO v_blockers FROM intel_i12_20261212_inventory WHERE pre;
  IF v_blockers = 0 THEN
    EXECUTE $node_visible$
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
$node_visible$;
  ELSE
    RAISE NOTICE '20261212 left node_visible/6 unchanged: % drop-box precondition row(s) are not 0 (DEC-90 ruling R2), so the deny binding does not apply; the index was created. Read the precondition rows of the result; lifting this gate is intelligence I-30''s.', v_blockers;
  END IF;
END
$gate$;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- Probes carry ok, n NULL; count rows carry n, ok NULL. Binding applied:
-- every probe true. Held back: the gate probe false, the three probes of the
-- new body NULL (not applicable), every other probe true.
SELECT 'KACL-5: document_versions_source_file_key_idx exists on document_versions (source_file_key), partial on source_file_key IS NOT NULL — created before the transaction, on every paste whatever the gate decides' AS check,
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'document_versions'
                  AND indexname = 'document_versions_source_file_key_idx'
                  AND indexdef LIKE '%(source_file_key)%' AND indexdef LIKE '%WHERE (source_file_key IS NOT NULL)%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'R2 gate (DEC-90, drop boxes): every precondition count is 0, so node_visible/6 was re-created with the deny binding — false: it was left untouched (a NOTICE gave the count; read the precondition rows); lifting the gate is intelligence I-30''s',
       (SELECT COALESCE(SUM(i.n), 0) = 0 FROM intel_i12_20261212_inventory i WHERE i.pre),
       NULL
UNION ALL
SELECT 'node_visible/6 is what the gate decided: applied — the binding''s body (normal read-deny limb, every-subject deny); held back — its body is byte-for-byte what it was before this paste',
       CASE WHEN (SELECT COALESCE(SUM(i.n), 0) = 0 FROM intel_i12_20261212_inventory i WHERE i.pre)
            THEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                            AND prosrc LIKE '%IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (%'
                            AND prosrc LIKE '%(p_acl_index->''deny''->''roles''->a.act) ? r%')
            ELSE (SELECT md5(p.prosrc) FROM pg_proc p
                   WHERE p.proname = 'node_visible' AND p.pronargs = 6 AND p.pronamespace = 'public'::regnamespace)
                 IS NOT DISTINCT FROM (SELECT b.body_md5 FROM intel_i12_20261212_before b) END,
       NULL
UNION ALL
SELECT 'node_visible/6 (either body): SECURITY DEFINER, search_path pinned; controller via is_org_controller before the owner branch; every held role; team lookup org-scoped (ORG-13)',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6 AND prosecdef
                  AND proconfig @> ARRAY['search_path=public']
                  AND prosrc LIKE '%IF is_org_controller(p_org) THEN%'
                  AND position('is_org_controller(p_org)' in prosrc) < position('user_is_effective_owner(p_owner' in prosrc)
                  AND prosrc LIKE '%FROM unnest(v_roles) r%'
                  AND prosrc LIKE '%FROM team_members WHERE uid = auth.uid() AND org_id = p_org;%'),
       NULL
UNION ALL
SELECT 'node_visible/6 (binding applied; NULL when held back): the deny check names user, every held role, team and org (DACL-12 c1), and runs before the allow',
       CASE WHEN (SELECT COALESCE(SUM(i.n), 0) = 0 FROM intel_i12_20261212_inventory i WHERE i.pre) THEN
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%(p_acl_index->''deny''->''users''->a.act) ? v_uid%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''orgs''->a.act) ? p_org::text%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''roles''->a.act) ? r%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''teams''->a.act) ? t%'
                  AND position('''deny''->''teams''' in prosrc) < position('acl_subject_in_bucket(p_acl_index->''allow''' in prosrc)) END,
       NULL
UNION ALL
SELECT 'node_visible/6 (binding applied; NULL when held back): a normal row reads its index''s read-deny lists before opening (IEDGE-12 c2), with no table read on the fast path',
       CASE WHEN (SELECT COALESCE(SUM(i.n), 0) = 0 FROM intel_i12_20261212_inventory i WHERE i.pre) THEN
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (%'
                  AND position('IF v_normal AND (p_acl_index IS NULL' in prosrc) < position('is_org_controller(p_org)' in prosrc)) END,
       NULL
UNION ALL
SELECT 'node_visible/6 (binding applied; NULL when held back): on a normal row the controller check and the ownership cascade run only after the deny names the caller (cost); a private / hidden row keeps the controller-first order',
       CASE WHEN (SELECT COALESCE(SUM(i.n), 0) = 0 FROM intel_i12_20261212_inventory i WHERE i.pre) THEN
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%IF NOT v_normal THEN%IF is_org_controller(p_org) THEN%'
                  AND prosrc LIKE '%IF v_normal THEN%IF is_org_controller(p_org) THEN%RETURN COALESCE(user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()), false);%'
                  AND position('FROM team_members WHERE uid = auth.uid() AND org_id = p_org;' in prosrc)
                      < position('RETURN COALESCE(user_is_effective_owner(' in prosrc)) END,
       NULL
UNION ALL
SELECT 'node_visible/3 and /6 both carry SET search_path = public; the 3-arg wrapper still delegates',
       (SELECT COUNT(*) = 2 FROM pg_proc WHERE proname = 'node_visible' AND pronargs IN (3, 6)
          AND proconfig @> ARRAY['search_path=public'])
       AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 3
                      AND prosrc LIKE '%node_visible(p_visibility, p_acl_index, p_org, NULL::uuid, NULL::uuid, NULL::uuid)%'),
       NULL
UNION ALL
SELECT 'behaviour (no session, either body): a normal row with no index is open; a normal row whose read deny names nobody here is open; a private row with no index is closed',
       node_visible('normal', NULL::jsonb, '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL)
       AND node_visible('normal', '{"deny":{"users":{"read":["00000000-0000-0000-0000-0000000000aa"]}}}'::jsonb,
                        '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL)
       AND NOT node_visible('private', NULL::jsonb, '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL),
       NULL
UNION ALL
SELECT 'documents_acl_select and collections_acl_select still call the 6-arg node_visible',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE schemaname = 'public' AND policyname IN ('documents_acl_select', 'collections_acl_select')
           AND permissive = 'RESTRICTIVE' AND qual LIKE '%node_visible(visibility, acl_index, org_id, owner_user_id,%'),
       NULL
UNION ALL
SELECT check_name, NULL, n::text FROM (SELECT check_name, n FROM intel_i12_20261212_inventory ORDER BY ord) i;
