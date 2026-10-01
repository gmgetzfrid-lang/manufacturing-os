-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-08) — conflict targets the API can use, the link
-- provenance set, and proposals only for documents you can read.
--
-- What this file changes (apply after 20261125):
--   1. LNK-3 / IRLS-2 / WIRE-2 — document_related_resources' only unique
--      index on the pair was PARTIAL (WHERE target_document_id IS NOT NULL),
--      which ON CONFLICT cannot infer through PostgREST: every "provable
--      connections apply themselves" batch answered 42P10. It is replaced by
--      a PLAIN unique index on (document_id, target_document_id). URL rows
--      (target_document_id NULL) stay unconstrained — NULLs are distinct in
--      a plain unique index, which is all the partial predicate ever did.
--      The partial index guaranteed the non-NULL pairs unique already, so
--      the new index cannot fail to build.
--   2. IRLS-4 / WIRE-2 — entity_mentions' only unique key was the
--      EXPRESSION (asset_id, COALESCE(knowledge_document_id, document_id),
--      page), which the indexer's ON CONFLICT (asset_id,
--      knowledge_document_id, page) could never infer: the mention engine
--      has never written a row. It becomes two indexes with the same
--      meaning: a PLAIN unique (asset_id, knowledge_document_id, page) — the
--      indexer's conflict target — and, for rows with no knowledge document
--      (a pin on a controlled document), a unique (asset_id, document_id,
--      page) over exactly those rows (never used as a conflict target). One
--      controlled document may be mirrored in several knowledge libraries
--      (20260919), so the document branch cannot be constrained for rows
--      that carry a knowledge document. Built only when no key is
--      duplicated today (the expression index makes that impossible — the
--      inventory proves it); otherwise the old index stays and the
--      inventory names the count. Nothing is rewritten or deleted.
--   3. LNK-9 — document_related_resources.origin is the declared set the
--      Related panel renders: 'human', 'system', 'proposed', 'shaped'
--      (lib/relatedResources.ts LINK_ORIGINS). The graph wizard's legacy
--      'user' becomes 'shaped' (backfilled, and normalised by a BEFORE
--      trigger so a backup taken before this file restores whole). The
--      CHECK is added NOT VALID — it binds every new row — and VALIDATEd
--      when no row outside the set remains (the inventory counts any).
--   4. LNK-4 — proposed_links rows were readable by every active member,
--      evidence and all, whatever the ACL says about the two documents. A
--      RESTRICTIVE SELECT policy now requires BOTH endpoints to be readable
--      by the caller — the subqueries run under the caller's own documents
--      RLS (documents_acl_select), the same predicate the documents list
--      uses. RESTRICTIVE because proposed_links_write is FOR ALL: its USING
--      would otherwise grant SELECT on every row to the writer tier. The
--      engine and the publish-time sweep run on the service role and are
--      unaffected. proposed_links_write / entity_mentions_write already read
--      the role collection (20261046, caller_holds_any_role) — verified
--      below, not re-created. entity_mentions_read belongs to another
--      package (I-02) and is not touched.
--   5. LNK-5 — a private connection skill is its author's draft and never
--      runs (DEC-62, 20261125). Proposals such a skill queued before this
--      round — some while a non-controller had published it, which
--      20261125 took back to private — still sat in the review queue with
--      the skill's name in their evidence. They are retired to 'stale' (not
--      dismissed: if a controller shares the skill, the next run re-derives
--      them). The inventory counts them; the retired rows keep their
--      evidence text, readable as before only by members who can read both
--      documents (4).
--   6. IRLS-15 — applied links (document_related_resources) were readable by
--      every active member whatever the ACL says about the documents they
--      connect, and since (1) the engine applies provable links there with
--      their evidence ("Off-page connector 44-098 continues onto
--      44-PID-013"). A RESTRICTIVE SELECT policy now requires the carrier
--      document AND, for a document link, the target document to be readable
--      by the caller — the same documents-RLS subqueries as (4). RESTRICTIVE
--      because document_related_resources_write is FOR ALL: its USING would
--      otherwise grant SELECT on every row to the writer tier. Both endpoints,
--      not only the carrier: a link to a document you cannot read says that
--      the relationship exists and what it is (a person's label usually names
--      the target), which is what (4) withholds for proposals. So a link this
--      document carries to a document the viewer cannot read is no longer
--      listed to them (before, the Related panel showed it as "restricted
--      document"); the inventory counts the links that touch a restricted
--      document. URL links (no target) need only the carrier. The engine,
--      the evidence audit and the publish sweep run on the service role and
--      are unaffected; a person's unpin of a link they cannot read matches
--      nothing (a checked write says so). Until this file is applied the
--      engine applies no provable link at all — they wait in the review
--      queue (lib/linkProposerServer.ts: no plain index, 42P10, means this
--      policy is not there either).
--
-- NARROWS (members lose proposals and applied links whose documents they
-- cannot read); nobody gains. Pre-apply inventory (DEC-30) is captured into a TEMP TABLE before
-- the transaction: aggregate counts only. Single paste: inventory ->
-- BEGIN/DDL/COMMIT -> ONE SELECT (check text, ok boolean, n text) — the
-- editor shows only the last result. Every function pins SET search_path =
-- public. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g26_before AS
SELECT 'document_related_resources rows with NULL target_document_id (URL links; unconstrained by the plain index, as before)' AS what, COUNT(*) AS n
  FROM document_related_resources WHERE target_document_id IS NULL
UNION ALL
SELECT 'of those, kind = ''document'' rows with no target (dangling; left as they are)', COUNT(*)
  FROM document_related_resources WHERE target_document_id IS NULL AND kind = 'document'
UNION ALL
SELECT 'document pairs linked in both directions (one relationship, two rows; the Related panel lists it once)', COUNT(*)
  FROM document_related_resources a
 WHERE a.target_document_id IS NOT NULL AND a.document_id < a.target_document_id
   AND EXISTS (SELECT 1 FROM document_related_resources b
                WHERE b.document_id = a.target_document_id AND b.target_document_id = a.document_id)
UNION ALL
SELECT 'document_related_resources rows with origin ''user'' (the graph wizard; become ''shaped'')', COUNT(*)
  FROM document_related_resources WHERE origin = 'user'
UNION ALL
SELECT 'document_related_resources rows with any other origin outside human/system/proposed/shaped (the CHECK stays NOT VALID while > 0)', COUNT(*)
  FROM document_related_resources WHERE origin NOT IN ('human', 'system', 'proposed', 'shaped', 'user')
UNION ALL
SELECT 'entity_mentions rows', COUNT(*) FROM entity_mentions
UNION ALL
SELECT 'entity_mentions rows sharing (asset, knowledge document, page) with another row (no plain index while > 0)', COUNT(*)
  FROM entity_mentions a
 WHERE a.knowledge_document_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM entity_mentions b
                WHERE b.asset_id = a.asset_id AND b.knowledge_document_id = a.knowledge_document_id
                  AND b.page = a.page AND b.id <> a.id)
UNION ALL
SELECT 'entity_mentions rows with no knowledge document sharing (asset, document, page) with another such row (no plain index while > 0)', COUNT(*)
  FROM entity_mentions a
 WHERE a.knowledge_document_id IS NULL
   AND EXISTS (SELECT 1 FROM entity_mentions b
                WHERE b.knowledge_document_id IS NULL AND b.asset_id = a.asset_id
                  AND b.document_id = a.document_id AND b.page = a.page AND b.id <> a.id)
UNION ALL
SELECT 'proposed_links rows in status ''stale'' (re-enter the queue when the next run re-derives them — DEC-62)', COUNT(*)
  FROM proposed_links WHERE status = 'stale'
UNION ALL
SELECT 'proposed_links pending rows from a connection skill that is private (retired to ''stale'' — LNK-5)', COUNT(*)
  FROM proposed_links p JOIN link_rules r ON r.org_id = p.org_id AND p.proposer = 'rule:' || r.id::text
 WHERE p.status = 'pending' AND r.visibility <> 'org'
UNION ALL
SELECT 'proposed_links rows waiting for review (now readable only by members who can read both documents)', COUNT(*)
  FROM proposed_links WHERE status = 'pending';

-- IRLS-15: who loses which applied links depends on each member's grants,
-- so the inventory counts the links that touch a document with restricted
-- visibility (anything but normal / unset — node_visible's open case): each
-- becomes readable only by members who can read both of its documents.
CREATE TEMP TABLE IF NOT EXISTS _intel_g26_links_before AS
SELECT 'document_related_resources links touching a document with restricted visibility (now readable only by members who can read the carrier and the target)' AS what, COUNT(*) AS n
  FROM document_related_resources l
 WHERE EXISTS (SELECT 1 FROM documents d
                WHERE d.id IN (l.document_id, l.target_document_id)
                  AND d.visibility IS NOT NULL AND d.visibility <> 'normal')
UNION ALL
SELECT 'of those, applied by the engine or approved from a proposal (origin system / proposed — they carry evidence)', COUNT(*)
  FROM document_related_resources l
 WHERE l.origin IN ('system', 'proposed')
   AND EXISTS (SELECT 1 FROM documents d
                WHERE d.id IN (l.document_id, l.target_document_id)
                  AND d.visibility IS NOT NULL AND d.visibility <> 'normal')
UNION ALL
SELECT 'of those, carried by an open document to a restricted one (no longer listed as "restricted document" to a member who cannot read the target)', COUNT(*)
  FROM document_related_resources l
  JOIN documents c ON c.id = l.document_id
  JOIN documents t ON t.id = l.target_document_id
 WHERE (c.visibility IS NULL OR c.visibility = 'normal')
   AND t.visibility IS NOT NULL AND t.visibility <> 'normal';

BEGIN;

-- ── 1. LNK-3 / IRLS-2: a plain conflict target for applied links ───────────
CREATE UNIQUE INDEX IF NOT EXISTS document_related_resources_doc_target_uniq
  ON document_related_resources (document_id, target_document_id);
DROP INDEX IF EXISTS document_related_resources_doc_target_idx;

-- ── 2. IRLS-4 / WIRE-2: plain keys for the mention engine ──────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM entity_mentions a
              WHERE a.knowledge_document_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM entity_mentions b
                             WHERE b.asset_id = a.asset_id AND b.knowledge_document_id = a.knowledge_document_id
                               AND b.page = a.page AND b.id <> a.id))
     OR EXISTS (SELECT 1 FROM entity_mentions a
                 WHERE a.knowledge_document_id IS NULL
                   AND EXISTS (SELECT 1 FROM entity_mentions b
                                WHERE b.knowledge_document_id IS NULL AND b.asset_id = a.asset_id
                                  AND b.document_id = a.document_id AND b.page = a.page AND b.id <> a.id)) THEN
    RAISE NOTICE 'entity_mentions carries duplicate keys — the plain indexes were not built; resolve the rows the inventory counts, then re-run this file.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_kdoc_page_uniq
      ON entity_mentions (asset_id, knowledge_document_id, page);
    CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_doc_page_uniq
      ON entity_mentions (asset_id, document_id, page)
      WHERE knowledge_document_id IS NULL;
    DROP INDEX IF EXISTS entity_mentions_unique_idx;
  END IF;
END $$;

-- ── 3. LNK-9: the declared provenance set ──────────────────────────────────
CREATE OR REPLACE FUNCTION document_related_resources_origin_normalize()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- The graph wizard wrote 'user' before 'shaped' was declared; a backup
  -- taken then restores as the value the panel understands.
  IF NEW.origin = 'user' THEN NEW.origin := 'shaped'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_related_resources_origin ON document_related_resources;
CREATE TRIGGER trg_document_related_resources_origin
  BEFORE INSERT OR UPDATE OF origin ON document_related_resources
  FOR EACH ROW EXECUTE FUNCTION document_related_resources_origin_normalize();

UPDATE document_related_resources SET origin = 'shaped' WHERE origin = 'user';

ALTER TABLE document_related_resources DROP CONSTRAINT IF EXISTS document_related_resources_origin_check;
ALTER TABLE document_related_resources
  ADD CONSTRAINT document_related_resources_origin_check
  CHECK (origin IN ('human', 'system', 'proposed', 'shaped')) NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM document_related_resources
                  WHERE origin NOT IN ('human', 'system', 'proposed', 'shaped')) THEN
    ALTER TABLE document_related_resources VALIDATE CONSTRAINT document_related_resources_origin_check;
  END IF;
END $$;

-- ── 4. LNK-4: a proposal is readable only with both of its documents ───────
DROP POLICY IF EXISTS proposed_links_read_endpoints ON proposed_links;
CREATE POLICY proposed_links_read_endpoints ON proposed_links
  AS RESTRICTIVE FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM documents d WHERE d.id = proposed_links.document_id)
    AND EXISTS (SELECT 1 FROM documents d WHERE d.id = proposed_links.target_document_id)
  );

-- ── 5. LNK-5: a private skill's opinions leave the review queue ────────────
UPDATE proposed_links p SET status = 'stale'
  FROM link_rules r
 WHERE p.status = 'pending' AND p.org_id = r.org_id
   AND p.proposer = 'rule:' || r.id::text AND r.visibility <> 'org';

-- ── 6. IRLS-15: an applied link is readable only with both of its documents ─
DROP POLICY IF EXISTS document_related_resources_read_endpoints ON document_related_resources;
CREATE POLICY document_related_resources_read_endpoints ON document_related_resources
  AS RESTRICTIVE FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM documents d WHERE d.id = document_related_resources.document_id)
    AND (document_related_resources.target_document_id IS NULL
         OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_related_resources.target_document_id))
  );

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'document_related_resources: a PLAIN unique index on (document_id, target_document_id) — the auto-apply conflict target' AS check,
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE tablename = 'document_related_resources'
                  AND indexname = 'document_related_resources_doc_target_uniq'
                  AND indexdef LIKE 'CREATE UNIQUE INDEX%(document_id, target_document_id)'
                  AND indexdef NOT LIKE '%WHERE%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'document_related_resources: the partial pair index is gone',
       NOT EXISTS (SELECT 1 FROM pg_indexes
                    WHERE tablename = 'document_related_resources'
                      AND indexname = 'document_related_resources_doc_target_idx'),
       NULL
UNION ALL
SELECT 'entity_mentions: PLAIN unique (asset_id, knowledge_document_id, page) — the indexer''s conflict target',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE tablename = 'entity_mentions' AND indexname = 'entity_mentions_kdoc_page_uniq'
                  AND indexdef LIKE 'CREATE UNIQUE INDEX%(asset_id, knowledge_document_id, page)'
                  AND indexdef NOT LIKE '%WHERE%'),
       NULL
UNION ALL
SELECT 'entity_mentions: rows with no knowledge document unique on (asset_id, document_id, page); the COALESCE index is gone',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE tablename = 'entity_mentions' AND indexname = 'entity_mentions_doc_page_uniq'
                  AND indexdef LIKE '%(asset_id, document_id, page) WHERE (knowledge_document_id IS NULL)')
       AND NOT EXISTS (SELECT 1 FROM pg_indexes
                        WHERE tablename = 'entity_mentions' AND indexname = 'entity_mentions_unique_idx'),
       NULL
UNION ALL
SELECT 'LNK-9: origin normaliser installed (''user'' -> ''shaped''), search_path pinned',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_related_resources_origin'
                AND tgrelid = 'document_related_resources'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%IF NEW.origin = ''user'' THEN NEW.origin := ''shaped''; END IF;%'
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'document_related_resources_origin_normalize'),
       NULL
UNION ALL
SELECT 'LNK-9: origin CHECK over human / system / proposed / shaped binds every new row',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'document_related_resources_origin_check'
                  AND conrelid = 'document_related_resources'::regclass
                  AND pg_get_constraintdef(oid) LIKE '%''human''%''system''%''proposed''%''shaped''%'),
       NULL
UNION ALL
SELECT 'LNK-4: proposed_links SELECT is RESTRICTIVE on both endpoints being readable (documents RLS)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'proposed_links' AND policyname = 'proposed_links_read_endpoints'
                  AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
                  AND qual LIKE '%FROM documents d%'
                  AND qual LIKE '%proposed_links.document_id%'
                  AND qual LIKE '%proposed_links.target_document_id%'),
       NULL
UNION ALL
SELECT 'proposed_links_read (membership) still present; proposed_links_write / entity_mentions_write read the role collection (20261046)',
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'proposed_links' AND policyname = 'proposed_links_read')
       AND (SELECT COUNT(*) = 2 FROM pg_policies
             WHERE (tablename, policyname) IN (('proposed_links', 'proposed_links_write'), ('entity_mentions', 'entity_mentions_write'))
               AND qual LIKE '%caller_holds_any_role(org_id%' AND with_check LIKE '%caller_holds_any_role(org_id%'
               -- a role literal deparses as "role = ANY (ARRAY[...])", never as "IN"
               AND qual NOT LIKE '%role = ANY%' AND with_check NOT LIKE '%role = ANY%'),
       NULL
UNION ALL
SELECT 'IRLS-15: document_related_resources SELECT is RESTRICTIVE on the carrier and (for a document link) the target being readable (documents RLS)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'document_related_resources' AND policyname = 'document_related_resources_read_endpoints'
                  AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
                  AND qual LIKE '%FROM documents d%'
                  AND qual LIKE '%d.id = document_related_resources.document_id%'
                  AND qual LIKE '%target_document_id IS NULL%'
                  AND qual LIKE '%d.id = document_related_resources.target_document_id%'),
       NULL
UNION ALL
SELECT 'document_related_resources_read (membership) and document_related_resources_write still present (the endpoints policy narrows them; it replaces neither)',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename = 'document_related_resources'
           AND policyname IN ('document_related_resources_read', 'document_related_resources_write')
           AND permissive = 'PERMISSIVE'),
       NULL
UNION ALL
SELECT 'LNK-5: no pending proposal comes from a private connection skill',
       NOT EXISTS (SELECT 1 FROM proposed_links p JOIN link_rules r ON r.org_id = p.org_id AND p.proposer = 'rule:' || r.id::text
                    WHERE p.status = 'pending' AND r.visibility <> 'org'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g26_before
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g26_links_before
UNION ALL
SELECT 'inventory (after): origin CHECK validated (true = every row inside the declared set)', NULL,
       COALESCE((SELECT convalidated FROM pg_constraint
                  WHERE conname = 'document_related_resources_origin_check'
                    AND conrelid = 'document_related_resources'::regclass), false)::text
UNION ALL
SELECT 'inventory (after): entity_mentions plain indexes built (true = the mention engine can write)', NULL,
       (to_regclass('public.entity_mentions_kdoc_page_uniq') IS NOT NULL)::text;
