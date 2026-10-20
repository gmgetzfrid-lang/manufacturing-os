-- ─────────────────────────────────────────────────────────────────────────────
-- 20261228 — intelligence Round G, I-31 LEGACY LISTS INTO THE ACL: each legacy
-- library's role lists are written into libraries.acl ONCE, as exactly the
-- rung the app already evaluates for it, so one model decides who reads a
-- library (intelligence DACL-10 criterion 1, database half; DEC-90 rulings R1
-- and R6; admin-and-org ALOG-13).
--
-- THE STATE BEFORE. A legacy library is one whose ACL says nothing (NULL, JSON
-- null, or an object with no rule and a normal visibility — lib/acl
-- aclSaysSomething) while its read_access is restricted (neither "ALL" nor
-- NULL). Since intelligence I-12 (DEC-90 R1) the app does not leave such a
-- library open: lib/libraryAccess legacyLibraryAcl synthesizes its library
-- rung from the role lists — an allow of discover / read / download to every
-- role in read_access ∪ visible_to ∪ write_access ∪ admin_access, in that
-- order, each role once; a list naming NO role stands for a private rung with
-- no grant (hidden when the library's visibility column is hidden) — and the
-- library page, the AI seam, the bytes door, the notification discover check
-- and the checklist's reader all evaluate under that rung
-- (effectiveLibraryAcl / effectiveLibraryAclFromRow).
--
-- WHAT THIS FILE DOES. For every legacy library, and no other row:
--   * libraries.acl := that rung, exactly — { "inherit": true, "visibility":
--     <the rung's visibility>, "rules": [ { "effect": "allow", "subject":
--     { "type": "role", "id": <role> }, "actions": ["discover", "read",
--     "download"] } … ] } — the object legacyLibraryAcl returns for the row,
--     built here from the same columns by the same rules (role elements kept
--     as given, scalars deduplicated by value at their first place, the four
--     lists in the order above; a read_access that is not an array but is
--     restricted names no role, as the pages read it);
--   * libraries.acl_index := the index lib/acl buildAclIndexFromChain([acl])
--     writes for that ACL (NULL for a rung with no grant) — the column the
--     wizard and the nightly rebuild keep beside the ACL (DB-5). No decision
--     reads a library's index for READ: the publish evaluators and
--     can_manage_node look for publish / admin / managePermissions, which the
--     rung never grants, and documents_deny_upload_guard looks at denies,
--     which it never writes — so every one of them answers as before;
--   * one NODE_ACL_CHANGED audit row per library written (system actor, the
--     ACL and index before and after, reason legacy_lists_into_acl) — the
--     permission drawer's record of an ACL change, so the write is
--     reconstructable and reversible.
-- The lists themselves (read_access / visible_to / write_access /
-- admin_access) and the visibility column are NOT changed: the documents
-- home's card still reads read_access / visible_to, and the app keeps its
-- legacy rung as a FALLBACK (DEC-90's I-31 ruling (2)) for any library whose
-- ACL says nothing while its lists restrict — before this paste that is every
-- legacy library, after it none. Its deletion is the integrator's, after this
-- file's paste-back reads 0 such libraries (DEC-31).
--
-- NO ONE'S ACCESS THROUGH THE LIBRARY RUNG CHANGES AT THE PASTE (on an app
-- carrying the I-31 deploy — PASTE FACTS). After it, lib/acl aclSaysSomething
-- is true for every written row (a rule, or a private / hidden visibility),
-- so legacyLibraryAcl returns undefined and effectiveLibraryAcl returns the
-- ACL — the same object it synthesized before. Controllers (DEC-43) and the
-- library's owner keep their short-circuits; a deeper folder or document
-- grant still merges in; a library whose read_access is "ALL" or NULL (the
-- Everyone case) and a library whose ACL already says something are not
-- touched. Proven member by member on PostgreSQL 16
-- (lib/__tests__/rls/intelI31LegacyListsAcl.test.ts) and in the default
-- suite (lib/__tests__/intelI31LegacyListsAcl.test.ts) for every reader that
-- takes the rung — the library page's per-row decision, its card, content
-- reads (the AI seam, the bytes door), publish, the drawer's authority, and
-- (since the I-31 merge, DACL-13 R1) the ticket triage readers: the app's
-- answer before the paste equals its answer after. The database's LISTING
-- of private / hidden rows moves after it, as ACCEPTED under DACL-13 R2
-- (WHAT WIDENS AFTER THE PASTE).
--
-- THE TICKET TRIAGE READERS TAKE THE RUNG (DACL-13 R1 — ruled by the
-- integrator at the I-31 merge, 2026-10-20, DEC-90 — and built in the I-31
-- deploy, so they do not change at the paste). The triage library picker
-- (components/requests/LibraryPicker → lib/ticketLibrary offerableLibraries)
-- and its server check (app/api/tickets/workflow-action, assign /
-- request_eng_review — the check and its history label, libraryLabelForTicket)
-- read the rung's columns (lib/libraryAccess LIBRARY_RUNG_COLUMNS) and
-- decide on the EFFECTIVE ACL (effectiveLibraryAclFromRow's reading), so a
-- triager outside a legacy library's lists is not offered it, and a request
-- naming it is refused 400, from the I-31 deploy on — before the paste as
-- after it (inventory rows 13 / 14 bound the (library, member) pairs and
-- members). On a PRE-I-31 app those readers decide on the raw ACL, so there
-- they WOULD move at the paste from "open to every member" to the lists'
-- answer — one more reason the deploy goes first (PASTE FACTS).
--
-- WHAT STILL READS THE RAW ACL (said, not hidden; none is an access door).
--   * the ticket close notice's library label (app/api/tickets/
--     workflow-action's close path, libraryLabelForTicket over a row read
--     without the lists): a written library is named "the target library"
--     instead of by its name from the paste on — a name withheld, never one
--     shown (fail-safe);
--   * the View-as simulator, the access-recertification report and the
--     Permissions console show the rung's grants (they become accurate);
--   * the acl_index builders — next paragraph.
--
-- WHAT WIDENS AFTER THE PASTE (said, not hidden — ACCEPTED: DACL-13 R2,
-- ruled by the integrator at the I-31 merge, 2026-10-20, DEC-90). Folders,
-- documents and document sets carry a chain-resolved acl_index the APP
-- builds from the library's ACL down (DEC-10). This file does not touch
-- them. From the paste on, every private / hidden row in a written library
-- whose acl_index is built or rebuilt takes the library's rung — at once on
-- upload, folder create, move or drawer save, and for existing rows at the
-- latest at the next nightly rebuild (lib/aclIndexRebuild — automatic, no
-- one has to act) — so the database returns it to the roles the lists name
-- (node_visible's allow branch), and the library page's listing and
-- database-backed searches show it to them, where before only controllers,
-- the owner and explicit grantees saw it listed (16 (member, row) pairs on
-- the PG16 fixture). The database converges to the answer the app's doors
-- (the AI seam, the bytes door) already give those roles: it adds nothing
-- the app does not already show them. Inventory row 12 is up to that many
-- rows (an upper bound: rows below a non-inheriting node do not widen). A
-- NORMAL row stays open at the database until intelligence I-30 (DEC-90 R5),
-- as today.
--
-- NOT DONE HERE. No RESTRICTIVE policy on libraries (DEC-90 R6). node_visible,
-- acl_index_denies and the deny binding are not touched (intelligence I-30).
-- No function, policy or trigger is created or re-created.
--
-- APP BEFORE AND AFTER THE PASTE. Before: the app's fallback rung decides
-- each legacy library (I-12). After: the ACL decides it, with the same answer
-- for every reader that takes the rung — the ticket triage readers included
-- (DACL-13 R1); the raw-ACL displays above and the private / hidden listing
-- (DACL-13 R2, accepted) are the answers that move.
-- No column, function or table is added, so no 42703 / 42883 / 42P01 /
-- PGRST202 / PGRST204 / PGRST205 can arise from it. Idempotent: a re-paste
-- finds no legacy library and writes nothing.
--
-- PASTE FACTS.
--   ORDER: no prerequisite beyond the base schema (libraries.acl / acl_index /
--   visibility / owner_user_id and the four lists, audit_logs). Either order
--   with 20261212 (read its DACL-10 rows first if not yet pasted: they are the
--   "before" picture of the libraries this file writes; pasted after this
--   file they read 0) and with 20261224.
--   DEPLOY — HARD PREREQUISITE: deploy I-31 FIRST, then paste. The I-31
--   deploy carries the ticket triage readers on the rung (DACL-13 R1): on a
--   pre-I-31 app the picker and the workflow-action library check read the
--   raw ACL and would change at the paste (a triager outside the lists
--   loses a written library at the paste instead of at the deploy). It also
--   carries the library page's controller-first canPublish
--   (app/(protected)/documents/[libraryId]/page.tsx: isControllerPrincipal
--   before canPublishViaIndex). On an older app the page answers publish
--   from canPublishViaIndex(library.aclIndex) whenever the index is
--   non-null, and that evaluator has no controller short-circuit: the
--   read-only rung index this file writes (and the nightly rebuild rewrites
--   from the new ACL anyway) grants Admin / DocCtrl nothing, so a paste on a
--   pre-I-31 app HIDES Publish / Revert from controllers on every written
--   library's page until the I-31 deploy lands. (I-31 includes I-12, the
--   app's legacy rung: pasted on an app older than I-12 this file would also
--   close those libraries' contents to members outside the lists at the
--   paste instead of at the deploy — the change R1 ruled.)
--   RULING: none outstanding. DACL-13 was ruled by the integrator at the
--   I-31 merge (2026-10-20, DEC-90): R1 — the ticket triage readers take the
--   rung, built in the I-31 deploy (no paste gate); R2 — the private /
--   hidden listing that follows the paste is accepted (WHAT WIDENS AFTER
--   THE PASTE).
--   ONE RESULT SET: probes first (ok true on a correct paste), then the
--   counts-only inventory captured before the transaction and the counts of
--   what the transaction wrote.
--
-- ROLLBACK (by hand; restores what each library had, from this file's audit
-- rows — the rung's readers answer the same either way, the fallback rung
-- returning; the raw-ACL displays above return to the empty ACL's picture;
-- jsonb_build_object stored a SQL NULL before-value as JSON null, which
-- NULLIF turns back into NULL; an ACL that was JSON null comes back as SQL
-- NULL, which every reader reads the same):
--   UPDATE libraries l SET acl = NULLIF(a.details->'before'->'acl', 'null'::jsonb),
--          acl_index = NULLIF(a.details->'before'->'acl_index', 'null'::jsonb)
--     FROM audit_logs a
--    WHERE a.action = 'NODE_ACL_CHANGED' AND a.resource_type = 'library'
--      AND a.user_email = 'system:migration-20261228'
--      AND a.resource_id = l.id::text AND l.acl = a.details->'after'->'acl';
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. the rung each library's lists stand for (a session view, no data) ────
-- lib/libraryAccess effectiveLibraryAclFromRow → legacyLibraryAcl, and
-- lib/acl buildAclIndexFromChain over it, as SQL.
CREATE OR REPLACE TEMP VIEW intel_i31_20261228_rung AS
WITH lib AS (
  SELECT l.id, l.org_id, l.owner_user_id, l.visibility, l.acl, l.acl_index,
         l.read_access, l.visible_to, l.write_access, l.admin_access,
         -- lib/acl aclSaysSomething: a rule, or a hidden / private visibility.
         COALESCE(jsonb_typeof(l.acl) = 'object'
                  AND ((jsonb_typeof(l.acl->'rules') = 'array' AND jsonb_array_length(l.acl->'rules') > 0)
                       OR l.acl->>'visibility' IN ('hidden', 'private')), false) AS acl_says_something,
         -- restricted: neither "ALL" nor NULL (JSON null is NULL to the app).
         (l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb
          AND l.read_access <> '"ALL"'::jsonb) AS restricted
    FROM libraries l
), elems AS (
  -- read_access, visible_to, write_access, admin_access, in that order; a
  -- list that is not an array names no role (lib/libraryAccess toRoles).
  SELECT lib.id, s.src, e.ord, e.elem
    FROM lib
   CROSS JOIN LATERAL (VALUES (1, lib.read_access), (2, lib.visible_to),
                              (3, lib.write_access), (4, lib.admin_access)) s(src, list)
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.list) = 'array' THEN s.list ELSE '[]'::jsonb END)
                      WITH ORDINALITY e(elem, ord)
), firsts AS (
  -- new Set([...]): a scalar once, at its first place; an object or array
  -- element is its own entry (a JS Set keys those by identity).
  SELECT DISTINCT ON (id, CASE WHEN jsonb_typeof(elem) IN ('object', 'array') THEN jsonb_build_array(src, ord) ELSE elem END)
         id, src, ord, elem
    FROM elems
   ORDER BY id, CASE WHEN jsonb_typeof(elem) IN ('object', 'array') THEN jsonb_build_array(src, ord) ELSE elem END, src, ord
), roles AS (
  SELECT id, jsonb_agg(elem ORDER BY src, ord) AS ids, COUNT(*) AS n FROM firsts GROUP BY id
), rung AS (
  SELECT lib.*,
         COALESCE(roles.ids, '[]'::jsonb) AS role_ids,
         COALESCE(roles.n, 0) AS role_count,
         (NOT lib.acl_says_something AND lib.restricted) AS to_write
    FROM lib LEFT JOIN roles ON roles.id = lib.id
)
SELECT r.*,
       jsonb_build_object(
         'inherit', true,
         'visibility', CASE WHEN r.role_count = 0
                            THEN CASE WHEN r.visibility = 'hidden' THEN 'hidden' ELSE 'private' END
                            ELSE COALESCE(r.visibility, 'normal') END,
         'rules', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                     'effect', 'allow',
                                     'subject', jsonb_build_object('type', 'role', 'id', x.elem),
                                     'actions', '["discover", "read", "download"]'::jsonb) ORDER BY x.ord)
                              FROM jsonb_array_elements(r.role_ids) WITH ORDINALITY x(elem, ord)), '[]'::jsonb)
       ) AS rung_acl,
       CASE WHEN r.role_count = 0 THEN NULL ELSE jsonb_build_object(
         'allow', jsonb_build_object(
           'roles', jsonb_build_object('discover', r.role_ids, 'read', r.role_ids, 'download', r.role_ids,
                                       'upload', '[]'::jsonb, 'createFolder', '[]'::jsonb, 'editMetadata', '[]'::jsonb,
                                       'write', '[]'::jsonb, 'publish', '[]'::jsonb, 'managePermissions', '[]'::jsonb,
                                       'admin', '[]'::jsonb),
           'users', '{"discover": [], "read": [], "download": [], "upload": [], "createFolder": [], "editMetadata": [], "write": [], "publish": [], "managePermissions": [], "admin": []}'::jsonb,
           'teams', '{"discover": [], "read": [], "download": [], "upload": [], "createFolder": [], "editMetadata": [], "write": [], "publish": [], "managePermissions": [], "admin": []}'::jsonb,
           'orgs', '{"discover": [], "read": [], "download": [], "upload": [], "createFolder": [], "editMetadata": [], "write": [], "publish": [], "managePermissions": [], "admin": []}'::jsonb),
         'deny', jsonb_build_object(
           'roles', '{"discover": [], "read": [], "download": [], "upload": [], "createFolder": [], "editMetadata": [], "write": [], "publish": [], "managePermissions": [], "admin": []}'::jsonb,
           'users', '{"discover": [], "read": [], "download": [], "upload": [], "createFolder": [], "editMetadata": [], "write": [], "publish": [], "managePermissions": [], "admin": []}'::jsonb,
           'teams', '{"discover": [], "read": [], "download": [], "upload": [], "createFolder": [], "editMetadata": [], "write": [], "publish": [], "managePermissions": [], "admin": []}'::jsonb,
           'orgs', '{"discover": [], "read": [], "download": [], "upload": [], "createFolder": [], "editMetadata": [], "write": [], "publish": [], "managePermissions": [], "admin": []}'::jsonb)
       ) END AS rung_index
  FROM rung r;

-- ── 0b. pre-apply inventory (DEC-30: aggregate counts only, never a row) ─────
DROP TABLE IF EXISTS pg_temp.intel_i31_20261228_inventory;
CREATE TEMP TABLE intel_i31_20261228_inventory (ord int, check_name text, n bigint, h text);
INSERT INTO intel_i31_20261228_inventory (ord, check_name, n)
SELECT 1, 'before: libraries (every workspace)', COUNT(*) FROM intel_i31_20261228_rung
UNION ALL
SELECT 2, 'before: libraries whose read_access is restricted (neither "ALL" nor NULL)', COUNT(*)
  FROM intel_i31_20261228_rung WHERE restricted
UNION ALL
SELECT 3, 'before: of those, libraries whose ACL is NULL (or JSON null) — the app''s legacy rung decides them',
       COUNT(*) FROM intel_i31_20261228_rung WHERE restricted AND (acl IS NULL OR acl = 'null'::jsonb)
UNION ALL
SELECT 4, 'before: of those, libraries whose ACL is present but says nothing (no rule, normal visibility) — the legacy rung decides them too',
       COUNT(*) FROM intel_i31_20261228_rung WHERE to_write AND acl IS NOT NULL AND acl <> 'null'::jsonb
UNION ALL
SELECT 5, 'before: libraries this paste writes (rows 3 + 4: their role lists become their ACL, exactly the rung the app evaluates today)',
       COUNT(*) FROM intel_i31_20261228_rung WHERE to_write
UNION ALL
SELECT 6, 'before: of those, libraries whose lists name no role (written as a private — or hidden — ACL with no grant: controllers and the owner keep them, as today)',
       COUNT(*) FROM intel_i31_20261228_rung WHERE to_write AND role_count = 0
UNION ALL
SELECT 7, 'before: role grants this paste writes (one allow of discover / read / download per role, summed over those libraries)',
       COALESCE(SUM(role_count), 0) FROM intel_i31_20261228_rung WHERE to_write
UNION ALL
SELECT 8, 'before: libraries whose read_access is restricted and whose ACL already says something (not touched: the ACL is the model already)',
       COUNT(*) FROM intel_i31_20261228_rung WHERE restricted AND acl_says_something
UNION ALL
SELECT 9, 'before: libraries whose read_access is "ALL" or NULL (not touched: the Everyone case, as today)',
       COUNT(*) FROM intel_i31_20261228_rung WHERE NOT restricted
UNION ALL
SELECT 10, 'before: documents filed in the libraries this paste writes', COUNT(*)
  FROM documents d JOIN intel_i31_20261228_rung r ON r.id = d.library_id WHERE r.to_write
UNION ALL
SELECT 11, 'before: folders in the libraries this paste writes', COUNT(*)
  FROM collections c JOIN intel_i31_20261228_rung r ON r.id = c.library_id WHERE r.to_write
UNION ALL
SELECT 12, 'before: private / hidden documents, folders and document sets in them — up to this many rows (an upper bound: rows below a non-inheriting node do not widen) that the database returns to the roles the lists name once their acl_index is built or rebuilt (at once on upload, folder create, move or drawer save; existing rows at the latest at the next nightly rebuild) — the app''s AI seam and bytes door already let those roles read them (DACL-13 R2, accepted); nothing else moves at the database',
       (SELECT COUNT(*) FROM documents d JOIN intel_i31_20261228_rung r ON r.id = d.library_id
         WHERE r.to_write AND r.role_count > 0 AND d.visibility IN ('private', 'hidden'))
     + (SELECT COUNT(*) FROM collections c JOIN intel_i31_20261228_rung r ON r.id = c.library_id
         WHERE r.to_write AND r.role_count > 0 AND c.visibility IN ('private', 'hidden'))
     + (SELECT COUNT(*) FROM document_sets s JOIN intel_i31_20261228_rung r ON r.id = s.library_id
         WHERE r.to_write AND r.role_count > 0 AND s.visibility IN ('private', 'hidden'))
UNION ALL
SELECT 13, 'before: (library, member) pairs the lists leave out (active, non-controller, not the owner, no role in any list) — refused by the app today and after the paste alike (a deeper grant still admits them)',
       COUNT(*) FROM intel_i31_20261228_rung r JOIN org_members m ON m.org_id = r.org_id AND m.status = 'active'
 WHERE r.to_write
   AND NOT (m.role IN ('Admin', 'DocCtrl') OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl']::text[])
   AND r.owner_user_id IS DISTINCT FROM m.uid
   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) hr(rl)
                    WHERE r.role_ids @> jsonb_build_array(hr.rl))
UNION ALL
SELECT 14, 'before: of those pairs, distinct members',
       COUNT(DISTINCT (m.org_id, m.uid)) FROM intel_i31_20261228_rung r JOIN org_members m ON m.org_id = r.org_id AND m.status = 'active'
 WHERE r.to_write
   AND NOT (m.role IN ('Admin', 'DocCtrl') OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl']::text[])
   AND r.owner_user_id IS DISTINCT FROM m.uid
   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) hr(rl)
                    WHERE r.role_ids @> jsonb_build_array(hr.rl));
-- Fingerprints (md5 of catalog text and of the columns this file must not
-- change), compared by the probes — never shown.
INSERT INTO intel_i31_20261228_inventory (ord, check_name, h)
SELECT 90, 'fingerprint: node_visible / acl_index_denies bodies',
       md5(COALESCE((SELECT string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ',' ORDER BY p.oid::regprocedure::text)
                       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                        AND p.proname IN ('node_visible', 'acl_index_denies')), ''))
UNION ALL
SELECT 91, 'fingerprint: the role lists and visibility of every library',
       md5(COALESCE((SELECT string_agg(l.id::text || ':' || COALESCE(l.read_access::text, '~') || ':' || COALESCE(l.visible_to::text, '~')
                                       || ':' || COALESCE(l.write_access::text, '~') || ':' || COALESCE(l.admin_access::text, '~')
                                       || ':' || COALESCE(l.visibility, '~'), ',' ORDER BY l.id)
                       FROM libraries l), ''))
UNION ALL
SELECT 93, 'fingerprint: the row-level-security policies on libraries',
       md5(COALESCE((SELECT string_agg(policyname || ':' || permissive || ':' || cmd || ':' || COALESCE(qual, '~') || ':' || COALESCE(with_check, '~'), ',' ORDER BY policyname)
                       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'libraries'), ''))
UNION ALL
SELECT 92, 'fingerprint: the ACL and index of every library this paste does not write',
       md5(COALESCE((SELECT string_agg(r.id::text || ':' || COALESCE(r.acl::text, '~') || ':' || COALESCE(r.acl_index::text, '~'), ',' ORDER BY r.id)
                       FROM intel_i31_20261228_rung r WHERE NOT r.to_write), ''));

BEGIN;

-- ── 1. the lists into the ACL (only rows the legacy rung decides) ───────────
-- The row is re-checked as it is locked: its ACL still says nothing, its
-- list still restricts, and its lists and visibility are the ones the rung
-- was computed from — a concurrent edit is never overwritten.
WITH written AS (
  UPDATE libraries l
     SET acl = r.rung_acl, acl_index = r.rung_index
    FROM intel_i31_20261228_rung r
   WHERE r.id = l.id AND r.to_write
     AND NOT COALESCE(jsonb_typeof(l.acl) = 'object'
                      AND ((jsonb_typeof(l.acl->'rules') = 'array' AND jsonb_array_length(l.acl->'rules') > 0)
                           OR l.acl->>'visibility' IN ('hidden', 'private')), false)
     AND l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb AND l.read_access <> '"ALL"'::jsonb
     AND l.read_access IS NOT DISTINCT FROM r.read_access AND l.visible_to IS NOT DISTINCT FROM r.visible_to
     AND l.write_access IS NOT DISTINCT FROM r.write_access AND l.admin_access IS NOT DISTINCT FROM r.admin_access
     AND l.visibility IS NOT DISTINCT FROM r.visibility
  RETURNING l.id, l.org_id, r.acl AS before_acl, r.acl_index AS before_index, l.acl AS after_acl, l.acl_index AS after_index
), audited AS (
  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details, metadata)
  SELECT 'NODE_ACL_CHANGED', w.id::text, 'library', w.org_id, NULL, 'system:migration-20261228', 'system',
         jsonb_build_object('before', jsonb_build_object('acl', w.before_acl, 'acl_index', w.before_index),
                            'after', jsonb_build_object('acl', w.after_acl, 'acl_index', w.after_index),
                            'reason', 'legacy_lists_into_acl', 'migration', '20261228',
                            'note', 'The library''s read_access / visible_to / write_access / admin_access lists written into its ACL as the rung the app already evaluated for it; every reader that takes the rung answers as before.'),
         jsonb_build_object('actor_kind', 'system')
    FROM written w
  RETURNING 1
)
INSERT INTO intel_i31_20261228_inventory (ord, check_name, n)
SELECT 50, 'this paste: libraries written', (SELECT COUNT(*) FROM written)
UNION ALL
SELECT 51, 'this paste: NODE_ACL_CHANGED audit rows written (one per library)', (SELECT COUNT(*) FROM audited);
-- This transaction's clock (the audit rows' timestamp default), so the probes
-- can tell this paste's rows from an earlier paste's — never shown.
INSERT INTO intel_i31_20261228_inventory (ord, check_name, h) VALUES (52, 'fingerprint: this paste''s transaction time', now()::text);

COMMIT;

-- ── 2. one result set: probes, then the inventory ───────────────────────────
SELECT 'every library the legacy rung decided is now decided by its ACL: libraries whose ACL says nothing while read_access is restricted = 0 (a re-paste writes nothing; the app''s fallback rung is retired once this reads true)' AS check,
       (SELECT COUNT(*) = 0 FROM intel_i31_20261228_rung WHERE to_write) AS ok, NULL::text AS n
UNION ALL
SELECT 'every library this paste wrote holds exactly the rung its unchanged lists stand for (acl and acl_index), and has its audit row',
       (SELECT COUNT(*) FROM intel_i31_20261228_rung r
         WHERE r.restricted AND r.acl = r.rung_acl AND r.acl_index IS NOT DISTINCT FROM r.rung_index)
         >= (SELECT n FROM intel_i31_20261228_inventory WHERE ord = 50)
       AND (SELECT n FROM intel_i31_20261228_inventory WHERE ord = 50) = (SELECT n FROM intel_i31_20261228_inventory WHERE ord = 51),
       NULL
UNION ALL
SELECT 'no legacy library was left behind: this paste wrote every library the inventory counted (row 5; true unless a library was edited during the paste)',
       (SELECT n FROM intel_i31_20261228_inventory WHERE ord = 50) = (SELECT n FROM intel_i31_20261228_inventory WHERE ord = 5),
       NULL
UNION ALL
SELECT 'the role lists and the visibility column of every library are unchanged (the documents home''s card reads them as before)',
       (SELECT h FROM intel_i31_20261228_inventory WHERE ord = 91)
         = md5(COALESCE((SELECT string_agg(l.id::text || ':' || COALESCE(l.read_access::text, '~') || ':' || COALESCE(l.visible_to::text, '~')
                                           || ':' || COALESCE(l.write_access::text, '~') || ':' || COALESCE(l.admin_access::text, '~')
                                           || ':' || COALESCE(l.visibility, '~'), ',' ORDER BY l.id)
                           FROM libraries l), '')),
       NULL
UNION ALL
SELECT 'no other library''s ACL or index changed',
       (SELECT h FROM intel_i31_20261228_inventory WHERE ord = 92)
         = md5(COALESCE((SELECT string_agg(r.id::text || ':' || COALESCE(r.acl::text, '~') || ':' || COALESCE(r.acl_index::text, '~'), ',' ORDER BY r.id)
                           FROM intel_i31_20261228_rung r
                          WHERE NOT EXISTS (SELECT 1 FROM audit_logs a
                                             WHERE a.action = 'NODE_ACL_CHANGED' AND a.resource_type = 'library'
                                               AND a.user_email = 'system:migration-20261228' AND a.resource_id = r.id::text
                                               AND a."timestamp" = (SELECT h::timestamptz FROM intel_i31_20261228_inventory WHERE ord = 52))), '')),
       NULL
UNION ALL
SELECT 'node_visible and acl_index_denies are untouched (intelligence I-30 owns them and the deny binding)',
       (SELECT h FROM intel_i31_20261228_inventory WHERE ord = 90)
         = md5(COALESCE((SELECT string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ',' ORDER BY p.oid::regprocedure::text)
                           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                            AND p.proname IN ('node_visible', 'acl_index_denies')), '')),
       NULL
UNION ALL
SELECT 'no RESTRICTIVE read policy on libraries (DEC-90 R6) and the policies on libraries are the ones before the paste: every member reads the library rows as before',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'libraries'
                    AND permissive = 'RESTRICTIVE' AND cmd IN ('SELECT', 'ALL'))
       AND (SELECT h FROM intel_i31_20261228_inventory WHERE ord = 93)
         = md5(COALESCE((SELECT string_agg(policyname || ':' || permissive || ':' || cmd || ':' || COALESCE(qual, '~') || ':' || COALESCE(with_check, '~'), ',' ORDER BY policyname)
                           FROM pg_policies WHERE schemaname = 'public' AND tablename = 'libraries'), '')),
       NULL
UNION ALL
SELECT 'after: libraries whose ACL is exactly the rung their lists stand for', NULL,
       (SELECT COUNT(*) FROM intel_i31_20261228_rung r WHERE r.restricted AND r.acl = r.rung_acl)::text
UNION ALL
SELECT 'after: libraries whose ACL says nothing while read_access is restricted (the fallback rung''s cases — expect 0)', NULL,
       (SELECT COUNT(*) FROM intel_i31_20261228_rung WHERE to_write)::text
UNION ALL
SELECT check_name, NULL, n::text FROM (SELECT check_name, n FROM intel_i31_20261228_inventory WHERE h IS NULL ORDER BY ord) i;
