-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-34) — DOCUMENT EDGE READ RAILS: the last
-- document-linked table reads only rows whose documents the reader can see.
--
-- DACL-11 asked for a RESTRICTIVE read rail on every table that names a
-- controlled document, so a member who cannot open a document cannot learn
-- that it exists, its UUID or what it is linked to. Four of the five tables
-- already carry one:
--   * entity_mentions            — entity_mentions_source_readable (20261120):
--                                  the document AND the mirror it is read
--                                  through (whose source document is gated by
--                                  20261120's knowledge_documents_select);
--   * document_related_resources — document_related_resources_read_endpoints
--                                  (20261126): both ends, document_id and
--                                  target_document_id (a url row has none);
--   * document_assets, project_documents — 20261170.
-- Each is an EXISTS on documents under the CALLER's RLS — the documents read
-- decision itself (membership + documents_acl_select → node_visible), never a
-- copy of it — and is ANDed with every permissive policy, so no write grant
-- re-opens a read. The first two apply to every role (PUBLIC ⊇ authenticated);
-- they are NOT re-created here: re-creating them TO authenticated would only
-- take the rail away from the other roles. The probes below confirm each.
--
-- What this file changes — one policy:
--   document_supersessions_documents_readable — RESTRICTIVE FOR SELECT TO
--   authenticated: a lineage row (which drawing replaces which) is readable
--   only while BOTH its documents are readable by the caller — the shape of
--   20261170's two rails, on both document columns.
--
-- Decided with document control's lineage readers (lib/documentLifecycle/**,
-- lib/revisions.ts, lib/search.ts; DACL-11 Partial 2026-10-02 handed it here):
--   * split / merge / supersede (markSupersededAndLink, writeSupersessionLineage,
--     supersedeDocument and their compensations) read, write and remove only
--     pairs between the source the actor has open and replacements the actor
--     resolved under their own RLS or just created — both ends readable, so
--     the rail returns every row they read today;
--   * the reversal (deleteLineage) is Document Control only
--     (isControllerPrincipal) and DELETE is controller-only (20261131);
--     node_visible returns true for a controller on every document, so a
--     controller reads, and deletes, exactly today's rows;
--   * the related panel / relationship graph (findRelatedDocuments) resolves
--     every row's other end through documents under the caller's RLS, so a
--     row the rail hides was never shown — the panel is unchanged;
--   * the org graph (lib/orgGraph.ts, client and /api/graph) reads the table
--     under the caller's RLS: a row naming a document the reader cannot see
--     was counted as a link "leading off the map" (or, in a unit scope, as
--     "N more this way" on the visible node) — existence leaked through an
--     edge count. With the rail it is not returned, so it is not counted; a
--     reader who can see both documents (every controller) gets today's map.
-- No lineage screen loses a row a person can legitimately see today.
--
-- NARROWS: a member who cannot read one of a supersession's documents no
-- longer reads that row. WIDENS nothing. The service role (every server route
-- that reads with it, exports, the restore) bypasses RLS and reads as before.
--
-- The app does not change and works before and after this paste: it never
-- needed a hidden row (above). Before the paste it reads today's rows.
--
-- Requires 20260526 (the table), 20261120 and 20261126 (the two rails this
-- file confirms) and 20261170 (the two it confirms too) — all earlier in the
-- paste order. Works with either read policy on document_supersessions: the
-- member-wide document_supersessions_select of 20261131 or, before it, the
-- FOR ALL document_supersessions_member_all of 20260615 (a RESTRICTIVE policy
-- is ANDed with whichever is there). Paste order: after 20261258 (no object of
-- 20261259 / 20261260 is touched — any order with them works). Deploy order:
-- none — no app change. Pre-apply inventory (DEC-30, inventory-first): a TEMP
-- TABLE captured before the transaction, aggregate counts only — per table,
-- the rows a rail hides from at least one member. Single paste: inventory →
-- BEGIN/DDL/COMMIT → ONE SELECT (check text, ok boolean, n text). Idempotent:
-- a re-paste drops and re-creates the one policy.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
-- "Restricted" = a private / hidden document (only controllers, its effective
-- owner and its grantees read it). A NORMAL document whose index carries a
-- read deny is counted apart: it is hidden only from the members the deny
-- names, and only where node_visible binds that deny (intelligence I-30).
CREATE TEMP TABLE IF NOT EXISTS _intel_g261_before AS
WITH restricted AS (
  SELECT d.id FROM documents d
   WHERE d.visibility IN ('private', 'hidden') OR COALESCE(d.is_private, false)
), denied AS (
  SELECT d.id FROM documents d
   WHERE NOT (d.visibility IN ('private', 'hidden') OR COALESCE(d.is_private, false))
     AND d.acl_index IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                  WHERE jsonb_typeof(d.acl_index -> 'deny' -> s.subj -> 'read') = 'array'
                    AND jsonb_array_length(d.acl_index -> 'deny' -> s.subj -> 'read') > 0)
)
SELECT 'document_supersessions rows' AS what, COUNT(*) AS n FROM document_supersessions
UNION ALL
SELECT 'document_supersessions rows naming a private / hidden document on either side (the NEW rail: readable from now on only by members who can read both documents)', COUNT(*)
  FROM document_supersessions s
 WHERE s.superseded_doc_id IN (SELECT id FROM restricted) OR s.replacement_doc_id IN (SELECT id FROM restricted)
UNION ALL
SELECT 'document_supersessions rows naming a normal document with a read deny on either side (the NEW rail hides them only from the members the deny names, where node_visible binds it — I-30)', COUNT(*)
  FROM document_supersessions s
 WHERE s.superseded_doc_id IN (SELECT id FROM denied) OR s.replacement_doc_id IN (SELECT id FROM denied)
UNION ALL
SELECT 'document_related_resources rows naming a private / hidden document at either end (already hidden by 20261126''s rail — unchanged here)', COUNT(*)
  FROM document_related_resources r
 WHERE r.document_id IN (SELECT id FROM restricted) OR r.target_document_id IN (SELECT id FROM restricted)
UNION ALL
SELECT 'entity_mentions rows on a private / hidden document, directly or through its mirror (already hidden by 20261120''s rail — unchanged here)', COUNT(*)
  FROM entity_mentions e
 WHERE e.document_id IN (SELECT id FROM restricted)
    OR EXISTS (SELECT 1 FROM knowledge_documents k
                WHERE k.id = e.knowledge_document_id AND k.source_document_id IN (SELECT id FROM restricted))
UNION ALL
SELECT 'active members outside the controller tier (Admin, DocCtrl) — the only readers the new rail can narrow; a controller reads every document', COUNT(*)
  FROM org_members m
 WHERE m.status = 'active'
   AND NOT (m.role IN ('Admin', 'DocCtrl') OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl']::text[]);

BEGIN;

-- ── DACL-11: a lineage row is readable only with both of its documents ─────
-- RESTRICTIVE: ANDed with every permissive policy. The EXISTS runs under the
-- CALLER's RLS on documents, so it is the documents read decision itself.
ALTER TABLE document_supersessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_supersessions_documents_readable ON document_supersessions;
CREATE POLICY document_supersessions_documents_readable ON document_supersessions
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_supersessions.superseded_doc_id)
         AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_supersessions.replacement_doc_id));

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'DACL-11: document_supersessions rows are readable only with BOTH their documents (RESTRICTIVE SELECT TO authenticated, EXISTS on documents for superseded_doc_id and replacement_doc_id)' AS "check",
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'document_supersessions' AND policyname = 'document_supersessions_documents_readable'
                  AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE'
                  AND roles = ARRAY['authenticated']::name[]
                  AND qual LIKE '%FROM documents d%'
                  AND qual LIKE '%d.id = document_supersessions.superseded_doc_id%'
                  AND qual LIKE '%d.id = document_supersessions.replacement_doc_id%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'document_supersessions: it is the only RESTRICTIVE policy there, and members still read (a permissive SELECT — 20261131 — or, before it, the FOR ALL member policy)',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE tablename = 'document_supersessions' AND permissive = 'RESTRICTIVE')
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE tablename = 'document_supersessions' AND permissive = 'PERMISSIVE'
                      AND cmd IN ('SELECT', 'ALL') AND qual LIKE '%org_members%'),
       NULL
UNION ALL
SELECT 'entity_mentions_source_readable (20261120) is in place: RESTRICTIVE SELECT on the document AND the mirror — paste 20261120 first if false',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'entity_mentions' AND policyname = 'entity_mentions_source_readable'
                  AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE'
                  AND qual LIKE '%d.id = entity_mentions.document_id%'
                  AND qual LIKE '%k.id = entity_mentions.knowledge_document_id%'),
       NULL
UNION ALL
SELECT 'document_related_resources_read_endpoints (20261126) is in place: RESTRICTIVE SELECT on both ends — paste 20261126 first if false',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'document_related_resources' AND policyname = 'document_related_resources_read_endpoints'
                  AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE'
                  AND qual LIKE '%d.id = document_related_resources.document_id%'
                  AND qual LIKE '%d.id = document_related_resources.target_document_id%'),
       NULL
UNION ALL
SELECT 'document_assets_document_readable and project_documents_document_readable (20261170) are in place — paste 20261170 first if false',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE ((tablename = 'document_assets' AND policyname = 'document_assets_document_readable')
                OR (tablename = 'project_documents' AND policyname = 'project_documents_document_readable'))
           AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE'
           AND qual LIKE '%FROM documents d%'),
       NULL
UNION ALL
SELECT 'row-level security is on for all five document-linked tables',
       (SELECT COUNT(*) = 5 FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity
           AND c.relname IN ('document_supersessions', 'entity_mentions', 'document_related_resources', 'document_assets', 'project_documents')),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g261_before;
