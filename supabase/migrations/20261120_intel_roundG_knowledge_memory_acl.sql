-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-02) — the knowledge memory ACL: who may read a
-- stored answer, a mirrored document's row, and a mention's sentence.
--
-- The ask route answers every question under the ASKER's own ACL
-- (excludedDocIds, lib/knowledgeAccess.ts) and then stores the answer, its
-- verbatim quotes and its citations in knowledge_questions. Three tables have
-- published what that per-asker filter produced to every active member:
--
--   1. ASK-1 / KACL-1 / IRLS-1 / IEDGE-5 — knowledge_questions_select
--      (20260911:146-150) was "any active member of the org". It becomes the
--      ASKER, or a controller (DEC-43: controllers read all memory), still
--      only while an active member. Everyone else reads stored answers only
--      through /api/knowledge/history, which re-filters every row's citations
--      through loadPrincipal + readableControlledDocIds for the CURRENT reader
--      and withholds a whole row (and every later turn of its conversation)
--      when any cited source is not readable to them — an answer is as
--      restricted as its most restricted source.
--   2. KACL-7 — knowledge_documents_select (20260911:124-128) showed every
--      mirror's number, title, revision, page count and file key to every
--      member. A MIRROR row (source_document_id IS NOT NULL) is now visible
--      only when its controlled document's row is visible to the caller under
--      the documents RLS (documents_org_access + the documents_acl_select
--      node_visible overlay): a positive EXISTS through that RLS, so a
--      document the caller cannot see hides its mirror. Upload rows stay
--      org-readable by design. Controllers keep every row through
--      knowledge_documents_write (FOR ALL, is_org_controller).
--   3. The 20260917 chunk lockdown, re-stated so that 2 cannot open it.
--      20260917's knowledge_chunks_select hid a mirror's chunks with
--      NOT EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id =
--      knowledge_chunks.document_id AND d.source_document_id IS NOT NULL).
--      That subquery runs under the CALLER's RLS on knowledge_documents: once
--      2 hides a mirror row from a member, the NOT EXISTS finds no row, is
--      TRUE, and every chunk of that mirror — the full text of a private or
--      hidden controlled document — becomes member-readable (reproduced on a
--      scratch PostgreSQL 16). The policy is re-created here, in the same
--      transaction, with the same rule written POSITIVELY: a member reads a
--      chunk only when its document is an UPLOAD row they can see
--      (EXISTS … AND d.source_document_id IS NULL). A row hidden by RLS now
--      fails closed. For every row a member could read before, the answer is
--      the same (upload chunks yes, mirror chunks no); a chunk whose document
--      row is gone is now hidden too. Controllers keep every chunk through
--      knowledge_chunks_write (FOR ALL, is_org_controller), as before.
--   4. IEDGE-6 / IRLS-9 — entity_mentions_read (20260929:73-76) published the
--      proving sentence (context_snippet) of every mention to every member. A
--      RESTRICTIVE SELECT overlay now requires the mentioned document to be
--      readable — directly (document_id, under the documents RLS) and through
--      the mirror hop (knowledge_document_id, under the knowledge_documents
--      RLS above) — both positive EXISTS, so a row hidden by RLS fails
--      closed. RESTRICTIVE, so the FOR ALL write policy (Manager and
--      Supervisor hold it) cannot re-open reads.
--   5. IEDGE-6 done-when 2 — entity_mentions_total_for_asset(org, asset): the
--      org-wide COUNT of an asset's mentions for an active member, so the
--      equipment hub can say "N further mentions are in documents you don't
--      have access to" instead of silently omitting them. A count only — no
--      document, page or sentence.
--
-- A mirror or a mention is now exactly as visible as its controlled
-- document's own row at the database. Restrictions the app enforces on a
-- NORMAL-visibility row (an allow-list ACL, a role / team deny — DACL-6 /
-- DACL-12; a private draft's creator-only rule) are enforced by the app and by
-- /api/knowledge/history, not by these policies; they tighten here
-- automatically when the documents predicate does (I-12), because every
-- clause below evaluates THROUGH the documents RLS rather than beside it.
--
-- NARROWS (members lose org-wide reads of other people's answers, of mirrors
-- of documents they cannot see, and of mentions in them); nobody gains —
-- which holds only because 3 is in the same paste: every policy that reads
-- one of the tables narrowed here must test it POSITIVELY. A NOT EXISTS over
-- a table whose rows RLS now hides turns every hidden row into a pass; after
-- this paste no live policy does that (a probe below checks every policy in
-- the database, and lib/__tests__/knowledgeMemoryAcl.test.ts replays every
-- migration's policies to the same end).
-- Pre-apply inventory (DEC-30) is captured into a TEMP TABLE before the
-- transaction: aggregate counts only. Single paste: inventory →
-- BEGIN/DDL/COMMIT → ONE SELECT (check text, ok boolean, n text) — the editor
-- shows only the last result. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g20_before AS
SELECT 'knowledge_questions rows (stored answers)' AS what, COUNT(*) AS n
  FROM knowledge_questions
UNION ALL
SELECT 'knowledge_questions rows citing a mirror whose controlled document is private, hidden or a private draft (were readable org-wide)', COUNT(*)
  FROM knowledge_questions q
 WHERE EXISTS (
   SELECT 1
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.citations) = 'array' THEN q.citations ELSE '[]'::jsonb END) c
     JOIN knowledge_documents k ON k.id::text = c->>'documentId'
     JOIN documents d ON d.id = k.source_document_id
    WHERE d.visibility IN ('private', 'hidden') OR COALESCE(d.is_private, false) OR d.scope = 'private')
UNION ALL
SELECT 'knowledge_questions rows citing a knowledge document that no longer exists (withheld from non-controllers by /api/knowledge/history)', COUNT(*)
  FROM knowledge_questions q
 WHERE EXISTS (
   SELECT 1
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.citations) = 'array' THEN q.citations ELSE '[]'::jsonb END) c
    WHERE jsonb_typeof(c) = 'object' AND c ? 'documentId'
      AND NOT EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.id::text = c->>'documentId'))
UNION ALL
SELECT 'active members who are not controllers (their read of knowledge_questions narrows to their own rows)', COUNT(*)
  FROM org_members
 WHERE status = 'active'
   AND NOT (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
UNION ALL
SELECT 'knowledge_documents mirror rows (source_document_id set)', COUNT(*)
  FROM knowledge_documents WHERE source_document_id IS NOT NULL
UNION ALL
SELECT 'mirror rows whose controlled document is private or hidden (now hidden from members who cannot see that document)', COUNT(*)
  FROM knowledge_documents k JOIN documents d ON d.id = k.source_document_id
 WHERE d.visibility IN ('private', 'hidden')
UNION ALL
SELECT 'mirror rows whose controlled document no longer exists (now visible to controllers only)', COUNT(*)
  FROM knowledge_documents k
 WHERE k.source_document_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = k.source_document_id)
UNION ALL
SELECT 'knowledge_chunks of mirrors of private or hidden documents (closed to members before and after: the 20260917 NOT EXISTS would have opened them once their mirror row is hidden, so it is re-created as a positive test)', COUNT(*)
  FROM knowledge_chunks c
  JOIN knowledge_documents k ON k.id = c.document_id
  JOIN documents d ON d.id = k.source_document_id
 WHERE d.visibility IN ('private', 'hidden')
UNION ALL
SELECT 'entity_mentions rows', COUNT(*) FROM entity_mentions
UNION ALL
SELECT 'entity_mentions rows on a private or hidden document, directly or through its mirror (now hidden from members who cannot see it)', COUNT(*)
  FROM entity_mentions m
 WHERE EXISTS (SELECT 1 FROM documents d WHERE d.id = m.document_id AND d.visibility IN ('private', 'hidden'))
    OR EXISTS (SELECT 1 FROM knowledge_documents k JOIN documents d ON d.id = k.source_document_id
                WHERE k.id = m.knowledge_document_id AND d.visibility IN ('private', 'hidden'));

BEGIN;

-- ── 1. ASK-1 / KACL-1 / IRLS-1 / IEDGE-5: a stored answer is the asker's ───
-- Same policy name; the 20260911 membership clause is kept verbatim and the
-- author-or-controller clause is ANDed to it (DEC-43: controllers read all
-- memory; is_org_controller reads the role collection and pins search_path).
DROP POLICY IF EXISTS knowledge_questions_select ON knowledge_questions;
CREATE POLICY knowledge_questions_select ON knowledge_questions FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_questions.org_id
          AND uid = auth.uid() AND status = 'active')
  AND (knowledge_questions.user_id = auth.uid() OR is_org_controller(knowledge_questions.org_id))
);
-- Inserts happen server-side (service role) from /api/knowledge/ask; reads
-- by anyone but the asker and controllers go through /api/knowledge/history.

-- ── 2. KACL-7: a mirror row is as visible as its controlled document ───────
-- The EXISTS runs under the CALLER's RLS on documents, so it is the documents
-- read decision itself (membership + node_visible), not a copy of it.
DROP POLICY IF EXISTS knowledge_documents_select ON knowledge_documents;
CREATE POLICY knowledge_documents_select ON knowledge_documents FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_documents.org_id
          AND uid = auth.uid() AND status = 'active')
  AND (knowledge_documents.source_document_id IS NULL
       OR EXISTS (SELECT 1 FROM documents d WHERE d.id = knowledge_documents.source_document_id))
);

-- ── 3. The 20260917 chunk lockdown, as a positive test ─────────────────────
-- 20260917 wrote "no mirror row for this chunk" (NOT EXISTS). Under the
-- caller's RLS that is also true of a mirror row section 2 now HIDES, which
-- would open the full text of every private / hidden document's mirror to
-- members. Same rule, written as "an upload row the caller can see": the
-- membership clause and the subquery are 20260917's, NOT EXISTS → EXISTS and
-- IS NOT NULL → IS NULL.
DROP POLICY IF EXISTS knowledge_chunks_select ON knowledge_chunks;
CREATE POLICY knowledge_chunks_select ON knowledge_chunks FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_chunks.org_id
          AND uid = auth.uid() AND status = 'active')
  AND EXISTS (
    SELECT 1 FROM knowledge_documents d
    WHERE d.id = knowledge_chunks.document_id
      AND d.source_document_id IS NULL
  )
);

-- ── 4. IEDGE-6 / IRLS-9: a mention's sentence needs its document readable ──
-- RESTRICTIVE: ANDed with every permissive policy, including the FOR ALL
-- entity_mentions_write (Admin, DocCtrl, Manager, Supervisor), so no write
-- grant re-opens a read. Both hops evaluate under the caller's RLS.
DROP POLICY IF EXISTS entity_mentions_source_readable ON entity_mentions;
CREATE POLICY entity_mentions_source_readable ON entity_mentions AS RESTRICTIVE FOR SELECT USING (
  (entity_mentions.document_id IS NULL
   OR EXISTS (SELECT 1 FROM documents d WHERE d.id = entity_mentions.document_id))
  AND (entity_mentions.knowledge_document_id IS NULL
       OR EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.id = entity_mentions.knowledge_document_id))
);

-- ── 5. IEDGE-6: the hub may say how many mentions it is not showing ────────
-- A count for an active member of the org; 0 for anyone else. Never a
-- document, a page or a sentence.
CREATE OR REPLACE FUNCTION entity_mentions_total_for_asset(p_org_id uuid, p_asset_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM org_members
                  WHERE org_id = p_org_id AND uid = auth.uid() AND status = 'active')
    THEN (SELECT COUNT(*) FROM entity_mentions WHERE org_id = p_org_id AND asset_id = p_asset_id)
    ELSE 0
  END;
$$;
REVOKE ALL ON FUNCTION entity_mentions_total_for_asset(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION entity_mentions_total_for_asset(uuid, uuid) TO authenticated;

COMMIT;

-- ── Verification (read-only) — every probe true; inventory rows carry n ─────
SELECT 'knowledge_questions: the only read policy is the asker or a controller, while an active member' AS "check",
       (SELECT COUNT(*) = 1 FROM pg_policies
         WHERE tablename = 'knowledge_questions' AND cmd IN ('SELECT', 'ALL'))
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE tablename = 'knowledge_questions' AND policyname = 'knowledge_questions_select'
                      AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'
                      AND qual LIKE '%org_members%'
                      AND qual LIKE '%user_id = auth.uid()%'
                      AND qual LIKE '%is_org_controller(%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'knowledge_documents_select: an upload row is org-readable, a mirror row needs its controlled document visible to the caller',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'knowledge_documents' AND policyname = 'knowledge_documents_select'
                  AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'
                  AND qual LIKE '%org_members%'
                  AND qual LIKE '%source_document_id IS NULL%'
                  AND qual LIKE '%FROM documents d%'
                  AND qual LIKE '%d.id = knowledge_documents.source_document_id%'),
       NULL
UNION ALL
SELECT 'knowledge_documents: the only other read-capable policy is the controller write policy (DEC-43)',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename = 'knowledge_documents' AND cmd IN ('SELECT', 'ALL'))
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE tablename = 'knowledge_documents' AND policyname = 'knowledge_documents_write'
                      AND cmd = 'ALL' AND qual LIKE '%is_org_controller(org_id)%'),
       NULL
UNION ALL
SELECT 'entity_mentions_source_readable: RESTRICTIVE SELECT — the document (direct) and the mirror (hop) must be readable',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'entity_mentions' AND policyname = 'entity_mentions_source_readable'
                  AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
                  AND qual LIKE '%d.id = entity_mentions.document_id%'
                  AND qual LIKE '%k.id = entity_mentions.knowledge_document_id%'),
       NULL
UNION ALL
SELECT 'entity_mentions_total_for_asset: SECURITY DEFINER, search_path pinned, a count for active members only',
       (SELECT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%status = ''active''%'
               AND prosrc LIKE '%SELECT COUNT(*) FROM entity_mentions WHERE org_id = p_org_id AND asset_id = p_asset_id%'
          FROM pg_proc WHERE proname = 'entity_mentions_total_for_asset'),
       NULL
UNION ALL
SELECT 'knowledge_chunks_select: a member reads a chunk only when its document is an UPLOAD row they can see (a positive EXISTS: a mirror row hidden by RLS keeps its chunks closed), and knowledge_chunks_write is the only other read-capable policy',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'knowledge_chunks' AND policyname = 'knowledge_chunks_select'
                  AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'
                  AND qual LIKE '%org_members%'
                  AND qual LIKE '%FROM knowledge_documents d%'
                  AND qual LIKE '%d.id = knowledge_chunks.document_id%'
                  AND qual LIKE '%d.source_document_id IS NULL%'
                  AND qual NOT LIKE '%IS NOT NULL%'
                  AND qual !~ 'NOT \(?EXISTS')
       AND (SELECT COUNT(*) = 2 FROM pg_policies
             WHERE tablename = 'knowledge_chunks' AND cmd IN ('SELECT', 'ALL')),
       NULL
UNION ALL
SELECT 'no policy in the database tests NOT EXISTS over knowledge_documents, knowledge_questions or entity_mentions (a row this paste hides would open another table''s row)',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE COALESCE(qual, '') || ' ' || COALESCE(with_check, '')
                          ~ 'NOT \(?EXISTS \( *SELECT[^()]*FROM (public\.)?(knowledge_documents|knowledge_questions|entity_mentions)\M'),
       NULL
UNION ALL
SELECT 'documents_acl_select (RESTRICTIVE node_visible) is installed — the predicate the mirror and mention policies read through',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'documents' AND policyname = 'documents_acl_select'
                  AND permissive = 'RESTRICTIVE' AND qual LIKE '%node_visible(%'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g20_before;
