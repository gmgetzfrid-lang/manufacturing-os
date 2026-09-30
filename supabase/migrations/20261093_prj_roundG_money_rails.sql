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
--     delete is written to audit_logs FIRST. An FK CASCADE from the parent's
--     own delete passes: when the row's project (or org) is already gone in
--     the trigger's snapshot, the delete is the parent's, and whether a
--     project that holds money may be deleted at all is the PROJECT's rail
--     (J8 / PC-2: the projects BEFORE DELETE guard + delete_project_record).
--     So the app's existing Delete-project action keeps working exactly as
--     before this migration, while a direct DELETE on a cost row — its
--     project still present — is refused.
--   COST-10 / COST-6 (verification fix): a VOID cost entry stays void.
--     `enforce_cost_entry_void_terminal` is a BEFORE UPDATE trigger on
--     cost_entries that refuses, for a signed-in caller (auth.uid() set),
--     any update that takes a void entry out of void. The app's only
--     cost_entries update is lib/costs.voidEntry (posted → void); nothing in
--     the app un-voids an entry, and un-voiding one brought a reversed
--     change order's money back onto the ledger without a new decision. The
--     service role (auth.uid() IS NULL — a restore) keeps its pass. Other
--     columns of an entry are not pinned here.
--   PT MON-8 dw3 / REL-4: CHECK constraints on cost_documents.status and kind,
--     NOT VALID so a live row outside the set never aborts the apply — new
--     writes are bound immediately; the inventory below counts the old ones.
--   COST-9 backfill: cost_entries.source_document_id was never written. Where
--     an award/invoice-shaped entry's reference matches EXACTLY ONE cost
--     document in its project (commitment ↔ awarded quote, actual ↔ posted
--     invoice) the link is set — in ANY status: an award entry a controller
--     voided by hand (the documented correction) is the document's too, and
--     linking it keeps the document from ever being offered a re-post.
--     Ambiguous matches are counted and left alone.
--   PT MON-1 / COST-11 dw3: `cost_ledger_orphans` — the two orphan states the
--     claim-then-post design can produce: awarded/posted paper whose money is
--     on the ledger nowhere (no entry links to it, in any status, AND no
--     unlinked entry of its award/invoice shape stands for it — the
--     backfill's ambiguous residue is attended, never re-posted), and an
--     approved change order whose linked entry is missing or void (the base's
--     only unwind was voiding that entry by hand). security_invoker, so it
--     answers under the caller's own RLS. lib/costDocs.listLedgerOrphans asks
--     the same question from the app — and shows nothing until this view
--     exists; repairCostDoc / repairChangeOrder are the audited repairs.
--
-- DEC-30: the inventory is captured BEFORE the transaction (temp table,
-- aggregate counts only — never customer rows) and reported with the probes
-- in the ONE final result set the SQL editor shows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE prj_g_money_inventory AS
SELECT 'inventory (before): awarded/posted documents with no cost entry linked to them (MON-1 damage already done + COST-9 unlinked)' AS check,
       (SELECT COUNT(*) FROM cost_documents d
         WHERE d.status IN ('awarded', 'posted')
           AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.source_document_id = d.id))::text AS n
UNION ALL
SELECT 'inventory (before): approved change orders with posted_entry_id NULL',
       (SELECT COUNT(*) FROM change_orders WHERE status = 'approved' AND posted_entry_id IS NULL)::text
UNION ALL
SELECT 'inventory (before): approved change orders whose posted_entry_id points at a void or missing entry (hand-voided — they stop revising the budget)',
       (SELECT COUNT(*) FROM change_orders c
         WHERE c.status = 'approved' AND c.posted_entry_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.id = c.posted_entry_id AND e.status = 'posted'))::text
UNION ALL
SELECT 'inventory (before): cost_documents rows with a status outside the CHECK set',
       (SELECT COUNT(*) FROM cost_documents WHERE status NOT IN ('draft', 'parsed', 'awarded', 'declined', 'posted', 'void'))::text
UNION ALL
SELECT 'inventory (before): cost_documents rows with a kind outside the CHECK set',
       (SELECT COUNT(*) FROM cost_documents WHERE kind NOT IN ('quote', 'invoice', 'po'))::text
UNION ALL
SELECT 'inventory (before): award/invoice-shaped entries (any status) with source_document_id NULL (COST-9 backfill candidates)',
       (SELECT COUNT(*) FROM cost_entries
         WHERE source_document_id IS NULL
           AND (description LIKE 'Award — %' OR description LIKE 'Invoice — %'))::text
UNION ALL
SELECT 'inventory (before): of those, matched to exactly ONE document by reference (backfilled below)',
       (SELECT COUNT(*) FROM cost_entries e
         WHERE e.source_document_id IS NULL
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
  -- An FK cascade from the parent's own delete: the parent row is already
  -- gone in this snapshot. The parent's delete rail decides (the project
  -- purge / the projects guard); a direct DELETE still sees its project.
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
     OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Financial records are never deleted — void the % row instead. (COST-10, 20261093)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION enforce_cost_ledger_delete_guard() IS
  'COST-10: BEFORE DELETE guard on the money tables. Refuses every direct DELETE except the project purge (app.record_purge = project:<id>) and the service role, which is audited first (COST_ROW_PURGED); an FK cascade from the parent project/org delete passes (the parent''s rail decides).';

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

-- ── 1b. a void cost entry stays void (signed-in callers) ───────────────────
CREATE OR REPLACE FUNCTION enforce_cost_entry_void_terminal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- The service role (auth.uid() IS NULL) keeps its pass.
  IF auth.uid() IS NOT NULL AND OLD.status = 'void' AND NEW.status IS DISTINCT FROM 'void' THEN
    RAISE EXCEPTION 'A void cost entry stays void: post a new entry instead. (COST-10, 20261093)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_cost_entry_void_terminal() IS
  'COST-10 / COST-6: BEFORE UPDATE guard on cost_entries. A signed-in caller never takes a void entry out of void (the app only ever voids: lib/costs.voidEntry); the service role keeps its pass.';

DROP TRIGGER IF EXISTS trg_cost_entries_void_terminal ON cost_entries;
CREATE TRIGGER trg_cost_entries_void_terminal
  BEFORE UPDATE ON cost_entries
  FOR EACH ROW
  EXECUTE FUNCTION enforce_cost_entry_void_terminal();

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
--    Any status: a hand-voided award entry is still the document's.
UPDATE cost_entries e
   SET source_document_id = (
     SELECT d.id FROM cost_documents d
      WHERE d.project_id = e.project_id
        AND e.reference = COALESCE(d.doc_number, d.file_name)
        AND ((e.entry_type = 'commitment' AND d.kind = 'quote' AND d.status = 'awarded')
          OR (e.entry_type = 'actual' AND d.kind = 'invoice' AND d.status = 'posted')))
 WHERE e.source_document_id IS NULL
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
   AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.source_document_id = d.id)
   AND NOT EXISTS (
     SELECT 1 FROM cost_entries e
      WHERE e.source_document_id IS NULL
        AND e.project_id = d.project_id
        AND btrim(e.reference) = btrim(COALESCE(d.doc_number, d.file_name))
        AND ((d.kind = 'quote' AND e.entry_type = 'commitment' AND e.description LIKE 'Award — %')
          OR (d.kind IN ('invoice', 'po') AND e.entry_type = 'actual' AND e.description LIKE 'Invoice — %')))
UNION ALL
SELECT 'change_order'::text, c.id, c.org_id, c.project_id, c.status,
       c.co_number || ' — ' || c.title, c.amount
  FROM change_orders c
 WHERE c.status = 'approved'
   AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.id = c.posted_entry_id AND e.status = 'posted');

COMMENT ON VIEW cost_ledger_orphans IS
  'MON-1 / COST-11: awarded/posted cost documents whose money is on the ledger nowhere (no entry links to them in any status, and no unlinked entry of their award/invoice shape stands for them), and approved change orders whose linked entry is missing or void. Repair through lib/costDocs.repairCostDoc / lib/changeOrders.repairChangeOrder (audited), never a delete.';

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
SELECT 'delete guard honours ONLY the purge GUC, the audited service-role path and a parent''s FK cascade',
       (SELECT prosrc LIKE '%app.record_purge%' AND prosrc LIKE '%service_role%' AND prosrc LIKE '%COST_ROW_PURGED%'
               AND prosrc LIKE '%NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)%'
          FROM pg_proc WHERE proname = 'enforce_cost_ledger_delete_guard' AND pronargs = 0),
       NULL
UNION ALL
SELECT 'a void cost entry stays void for a signed-in caller: SECURITY DEFINER guard with search_path pinned, BEFORE UPDATE row trigger on cost_entries',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%auth.uid() IS NOT NULL AND OLD.status = ''void'' AND NEW.status IS DISTINCT FROM ''void''%'
          FROM pg_proc WHERE proname = 'enforce_cost_entry_void_terminal' AND pronargs = 0)
       AND (SELECT COUNT(*) = 1 FROM pg_trigger t
             WHERE NOT t.tgisinternal AND t.tgname = 'trg_cost_entries_void_terminal'
               AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 1) = 1),
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
SELECT 'cost_ledger_orphans view exists, attends legacy unlinked entries and lists void-entry change orders',
       (SELECT COUNT(*) = 1 FROM pg_views WHERE viewname = 'cost_ledger_orphans'
           AND definition LIKE '%source_document_id IS NULL%'
           AND definition LIKE '%Award — %'
           AND definition LIKE '%posted_entry_id%'),
       NULL
UNION ALL
SELECT "check", NULL::boolean, n FROM prj_g_money_inventory
UNION ALL
SELECT 'inventory (after): award/invoice-shaped entries still unlinked (ambiguous or no matching document — attended by the view, left for hand repair)', NULL,
       (SELECT COUNT(*) FROM cost_entries
         WHERE source_document_id IS NULL
           AND (description LIKE 'Award — %' OR description LIKE 'Invoice — %'))::text
UNION ALL
SELECT 'inventory (after): rows in cost_ledger_orphans (the repair path population)', NULL,
       (SELECT COUNT(*) FROM cost_ledger_orphans)::text;
