-- ─────────────────────────────────────────────────────────────────────────────
-- projects Round G — J3 MONEY-LEDGER: the financial rails at the database.
--
--   COST-10 (PT REL-9 "never delete"): lib/costs.ts has always SAID financial
--     records are never deleted, and every cost-table write policy was FOR ALL,
--     which grants DELETE. `enforce_cost_ledger_delete_guard` is a BEFORE
--     DELETE trigger on cost_entries, change_orders, cost_documents and
--     cost_accounts (shape of 20260826's legal-hold guard) that refuses every
--     DELETE except two audited purge paths: the project purge RPC, which sets
--     `app.record_purge = 'project:<id>'` for the project it is tearing down
--     (the GUC contract shared with projects-and-cost PC-2 — whichever lands
--     first defines it, the other reuses it), and the service role, whose
--     delete is written to audit_logs FIRST. Note the cascade: deleting a
--     project through PostgREST now fails while it has cost rows — that is
--     the rail; the purge RPC is the door.
--   PT MON-8 dw3 / REL-4: CHECK constraints on cost_documents.status and kind,
--     NOT VALID so a live row outside the set never aborts the apply — new
--     writes are bound immediately; the inventory below counts the old ones.
--   COST-9 backfill: cost_entries.source_document_id was never written. Where
--     an entry's reference matches EXACTLY ONE cost document in its project
--     (commitment ↔ awarded quote, actual ↔ posted invoice) the link is set;
--     ambiguous matches are counted and left alone.
--   PT MON-1 / COST-11 dw3: `cost_ledger_orphans` — the two orphan states the
--     claim-then-post design can produce (awarded/posted paper with no posted
--     entry; an approved change order with no linked entry). security_invoker,
--     so it answers under the caller's own RLS. lib/costDocs.listLedgerOrphans
--     asks the same question from the app and repairCostDoc is the audited
--     repair.
--
-- DEC-30: the inventory is captured BEFORE the transaction (temp table,
-- aggregate counts only — never customer rows) and reported with the probes
-- in the ONE final result set the SQL editor shows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE prj_g_money_inventory AS
SELECT 'inventory (before): awarded/posted documents with no posted cost entry linked to them (MON-1 damage already done + COST-9 unlinked)' AS check,
       (SELECT COUNT(*) FROM cost_documents d
         WHERE d.status IN ('awarded', 'posted')
           AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.source_document_id = d.id AND e.status = 'posted'))::text AS n
UNION ALL
SELECT 'inventory (before): approved change orders with posted_entry_id NULL',
       (SELECT COUNT(*) FROM change_orders WHERE status = 'approved' AND posted_entry_id IS NULL)::text
UNION ALL
SELECT 'inventory (before): cost_documents rows with a status outside the CHECK set',
       (SELECT COUNT(*) FROM cost_documents WHERE status NOT IN ('draft', 'parsed', 'awarded', 'declined', 'posted', 'void'))::text
UNION ALL
SELECT 'inventory (before): cost_documents rows with a kind outside the CHECK set',
       (SELECT COUNT(*) FROM cost_documents WHERE kind NOT IN ('quote', 'invoice', 'po'))::text
UNION ALL
SELECT 'inventory (before): award/invoice-posted entries with source_document_id NULL (COST-9 backfill candidates)',
       (SELECT COUNT(*) FROM cost_entries
         WHERE source_document_id IS NULL AND status = 'posted'
           AND (description LIKE 'Award — %' OR description LIKE 'Invoice — %'))::text
UNION ALL
SELECT 'inventory (before): of those, matched to exactly ONE document by reference (backfilled below)',
       (SELECT COUNT(*) FROM cost_entries e
         WHERE e.source_document_id IS NULL AND e.status = 'posted'
           AND (e.description LIKE 'Award — %' OR e.description LIKE 'Invoice — %')
           AND (SELECT COUNT(*) FROM cost_documents d
                 WHERE d.project_id = e.project_id
                   AND e.reference = COALESCE(d.doc_number, d.file_name)
                   AND ((e.entry_type = 'commitment' AND d.kind = 'quote' AND d.status = 'awarded')
                     OR (e.entry_type = 'actual' AND d.kind = 'invoice' AND d.status = 'posted'))) = 1)::text
UNION ALL
SELECT 'inventory (before): change orders decided by their proposer (COST-6 — informational, flagged in the UI, never rewritten)',
       (SELECT COUNT(*) FROM change_orders WHERE decided_by IS NOT NULL AND decided_by = created_by)::text;

BEGIN;

-- ── 1. COST-10: never delete — the database holds the line ─────────────────
CREATE OR REPLACE FUNCTION enforce_cost_ledger_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purge text := current_setting('app.record_purge', true);
  -- The JWT role claim, read from the request settings the auth schema's
  -- helper reads (spelled out so the authority census never mistakes it for
  -- a headline org_members read).
  v_jwt_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
BEGIN
  -- The audited project purge sets the GUC for the ONE project it tears down.
  IF v_purge IS NOT NULL AND OLD.project_id IS NOT NULL
     AND v_purge = 'project:' || OLD.project_id::text THEN
    RETURN OLD;
  END IF;
  -- A service-role path may purge a row, and the purge is audited FIRST.
  IF v_jwt_role = 'service_role' THEN
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details)
    VALUES ('COST_ROW_PURGED', 'cost', OLD.id::text, OLD.org_id, auth.uid(),
            jsonb_build_object('table', TG_TABLE_NAME, 'project_id', OLD.project_id, 'path', 'service_role'));
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Financial records are never deleted — void the % row instead. (COST-10, 20261093)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION enforce_cost_ledger_delete_guard() IS
  'COST-10: BEFORE DELETE guard on the money tables. Refuses every DELETE except the project purge (app.record_purge = project:<id>) and the service role, which is audited first (COST_ROW_PURGED).';

DROP TRIGGER IF EXISTS trg_cost_entries_delete_guard ON cost_entries;
CREATE TRIGGER trg_cost_entries_delete_guard
  BEFORE DELETE ON cost_entries
  FOR EACH ROW
  EXECUTE FUNCTION enforce_cost_ledger_delete_guard();

DROP TRIGGER IF EXISTS trg_change_orders_delete_guard ON change_orders;
CREATE TRIGGER trg_change_orders_delete_guard
  BEFORE DELETE ON change_orders
  FOR EACH ROW
  EXECUTE FUNCTION enforce_cost_ledger_delete_guard();

DROP TRIGGER IF EXISTS trg_cost_documents_delete_guard ON cost_documents;
CREATE TRIGGER trg_cost_documents_delete_guard
  BEFORE DELETE ON cost_documents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_cost_ledger_delete_guard();

DROP TRIGGER IF EXISTS trg_cost_accounts_delete_guard ON cost_accounts;
CREATE TRIGGER trg_cost_accounts_delete_guard
  BEFORE DELETE ON cost_accounts
  FOR EACH ROW
  EXECUTE FUNCTION enforce_cost_ledger_delete_guard();

-- ── 2. MON-8 / REL-4: the database rejects an unmapped status or kind ──────
DO $$ BEGIN
  ALTER TABLE cost_documents ADD CONSTRAINT cost_documents_status_check
    CHECK (status IN ('draft', 'parsed', 'awarded', 'declined', 'posted', 'void')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE cost_documents ADD CONSTRAINT cost_documents_kind_check
    CHECK (kind IN ('quote', 'invoice', 'po')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. COST-9: link the paper to the money where the match is unambiguous ──
UPDATE cost_entries e
   SET source_document_id = (
     SELECT d.id FROM cost_documents d
      WHERE d.project_id = e.project_id
        AND e.reference = COALESCE(d.doc_number, d.file_name)
        AND ((e.entry_type = 'commitment' AND d.kind = 'quote' AND d.status = 'awarded')
          OR (e.entry_type = 'actual' AND d.kind = 'invoice' AND d.status = 'posted')))
 WHERE e.source_document_id IS NULL AND e.status = 'posted'
   AND (e.description LIKE 'Award — %' OR e.description LIKE 'Invoice — %')
   AND (SELECT COUNT(*) FROM cost_documents d
         WHERE d.project_id = e.project_id
           AND e.reference = COALESCE(d.doc_number, d.file_name)
           AND ((e.entry_type = 'commitment' AND d.kind = 'quote' AND d.status = 'awarded')
             OR (e.entry_type = 'actual' AND d.kind = 'invoice' AND d.status = 'posted'))) = 1;

-- ── 4. MON-1 / COST-11: the reconciliation view ────────────────────────────
CREATE OR REPLACE VIEW cost_ledger_orphans WITH (security_invoker = true) AS
SELECT 'cost_document'::text AS kind, d.id, d.org_id, d.project_id, d.status,
       COALESCE(d.vendor_name, d.file_name, d.id::text) AS label, d.total_amount AS amount
  FROM cost_documents d
 WHERE d.status IN ('awarded', 'posted')
   AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.source_document_id = d.id AND e.status = 'posted')
UNION ALL
SELECT 'change_order'::text, c.id, c.org_id, c.project_id, c.status,
       c.co_number || ' — ' || c.title, c.amount
  FROM change_orders c
 WHERE c.status = 'approved' AND c.posted_entry_id IS NULL;

COMMENT ON VIEW cost_ledger_orphans IS
  'MON-1 / COST-11: awarded/posted cost documents with no posted entry linked to them, and approved change orders with no posted_entry_id. Repair through lib/costDocs.repairCostDoc (audited), never a delete.';

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. Inventory rows are aggregate counts
--    only (n), captured BEFORE the transaction; the two "after" rows show what
--    the backfill left.
SELECT 'delete guard is SECURITY DEFINER with search_path pinned to public' AS check,
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'enforce_cost_ledger_delete_guard' AND pronargs = 0) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'delete guard honours ONLY the purge GUC and the audited service-role path',
       (SELECT prosrc LIKE '%app.record_purge%' AND prosrc LIKE '%service_role%' AND prosrc LIKE '%COST_ROW_PURGED%'
          FROM pg_proc WHERE proname = 'enforce_cost_ledger_delete_guard' AND pronargs = 0),
       NULL
UNION ALL
SELECT 'BEFORE DELETE triggers on all four money tables',
       (SELECT COUNT(*) = 4 FROM pg_trigger t
         WHERE NOT t.tgisinternal
           AND t.tgname IN ('trg_cost_entries_delete_guard', 'trg_change_orders_delete_guard',
                            'trg_cost_documents_delete_guard', 'trg_cost_accounts_delete_guard')),
       NULL
UNION ALL
SELECT 'cost_documents.status and .kind carry CHECK constraints',
       (SELECT COUNT(*) = 2 FROM pg_constraint
         WHERE contype = 'c' AND conname IN ('cost_documents_status_check', 'cost_documents_kind_check')),
       NULL
UNION ALL
SELECT 'cost_ledger_orphans view exists',
       (SELECT COUNT(*) = 1 FROM pg_views WHERE viewname = 'cost_ledger_orphans'),
       NULL
UNION ALL
SELECT "check", NULL::boolean, n FROM prj_g_money_inventory
UNION ALL
SELECT 'inventory (after): award/invoice-posted entries still unlinked (ambiguous or no matching document — left for hand repair)', NULL,
       (SELECT COUNT(*) FROM cost_entries
         WHERE source_document_id IS NULL AND status = 'posted'
           AND (description LIKE 'Award — %' OR description LIKE 'Invoice — %'))::text
UNION ALL
SELECT 'inventory (after): rows in cost_ledger_orphans (the repair path population)', NULL,
       (SELECT COUNT(*) FROM cost_ledger_orphans)::text;
