-- 20261157_prj_roundG_server_remainders.sql
--
-- projects Round G — J12 SERVER REMAINDERS. Five database halves that the
-- merged packages left in the browser, in one paste:
--
-- WHAT:
--   1. MON-12 — the registry rail on an award. `enforce_cost_document_award_registry`
--      (BEFORE INSERT OR UPDATE OF status ON cost_documents, SECURITY DEFINER,
--      search_path pinned): a signed-in write that moves a quote to
--      `awarded` is refused when the company behind it is flagged
--      `do_not_use` or `inactive` in the Known Companies registry — unless
--      the award runs through `award_quote` with a typed reason, which sets
--      `app.cost_doc_award_override` to the document's id for that one
--      statement. "The company behind it" is resolved exactly as
--      lib/costDocs.ts `companyBehind` resolves it: the document's own
--      registry link (cost_documents.company_id, 20261096 — read through
--      to_jsonb so a database without the column is not broken), then its
--      contractor's (project_parties.company_id), then ONE exact
--      case-insensitive name match in the org. The rail reads the registry
--      as the definer (`cost_doc_company_behind` called from it runs as the
--      owner), so a row the caller cannot read does not slip past. The
--      service role (auth.uid() NULL — restores, server routes, the SQL
--      editor) keeps its pass, as every Round G rail does.
--   2. GAP-406 — the award as ONE transaction. `award_quote(p_doc,
--      p_cost_account, p_expected_total, p_override_reason,
--      p_confirmed_total)` (SECURITY INVOKER: every read and write is the
--      caller's own, under the same RLS and the same 20261093 / 20261103
--      rails as the app's client sequence — nothing is widened) locks the
--      quote, re-checks it (a quote, still draft / parsed, the budget line
--      on the same project and in the document's currency, the total the
--      caller checked, the registry), then CLAIMS it, posts the commitment
--      (lib/costs.ts addEntry's row, with its COST_ENTRY_POSTED audit row),
--      records the override (COST_DOC_AWARD_OVERRIDE), declines the open
--      rivals of the same RFQ group (compared by key — case-folded,
--      whitespace collapsed, lib/costDocs.ts rfqKey) and writes
--      COST_DOC_AWARDED. A failure at any step after the claim raises, so the
--      whole award rolls back — no awarded paper without its commitment.
--      A refusal BEFORE the claim returns {ok:false, code} and writes
--      nothing. A NULL auth.uid() is refused (DRLS-16); EXECUTE is revoked
--      from PUBLIC and anon. lib/costDocs.ts awardQuote calls it and falls
--      back to the client sequence while it is missing (42883 / PGRST202).
--   3. PERF-7 / DEC-52 item 10 — the assessment and the sweep apply in ONE
--      request. `apply_checklist_item_writes(p_checklist, p_writes)`
--      (SECURITY INVOKER) applies a list of machine writes to one
--      checklist's items, each guarded on the row's `updated_at` AS READ
--      (`IS NOT DISTINCT FROM` — the same optimistic guard as the client's
--      `.eq("updated_at", …)` / `.is("updated_at", null)`), each in its own
--      sub-transaction so one refused row never undoes the rest; it returns
--      the ids that landed, the ids the guard refused (changed by someone
--      else, or filtered by RLS) and the failures (id, SQLSTATE, message).
--      Only the machine actor's columns are written (status, applicability,
--      ai_rationale, evidence) and `updated_by_name` must be one of the two
--      machine names — every 20261091 rail still fires per row
--      (checklist_items_decision_rail bounds what each machine may write).
--      A NULL auth.uid() is refused; EXECUTE revoked from PUBLIC and anon.
--      lib/checklists.ts writeItemPatches calls it and falls back to the
--      batched single-row writes while it is missing.
--   4. MON-13 / DEC-76 item 3 — the contractor-link and item-contractor rules.
--        * `enforce_project_party_company_link` (BEFORE UPDATE OF company_id
--          ON project_parties): a contractor's Known Company link is set once
--          — a signed-in caller never re-points or clears a link that is set.
--          The company's own delete (its FK ON DELETE SET NULL, an UPDATE one
--          trigger level down) passes.
--        * `enforce_quality_item_contractor` (BEFORE UPDATE OF party_id ON
--          turnover_items and punch_items): an item's contractor changes only
--          while the item is undecided (turnover open / received; punch
--          open); an unassigned decided item may be named once, except a
--          REJECTED turnover item (no reopen — a wrong name could never be
--          corrected). The contractor's own delete (FK ON DELETE SET NULL,
--          one trigger level down) passes. The do-not-use REASON on a
--          look-alike link stays an app-level confirmation (lib/costs.ts),
--          as DEC-76 item 3 says.
--   5. SEC-21 — project audit rows written under another resource type
--      follow the project. `audit_row_project_ref_visible(action, type,
--      resource, details)` (SECURITY INVOKER, no SET clause, names
--      schema-qualified — 20261142's shape): a row that names its project in
--      `details.projectId` follows that project; an intake-link row
--      (`project_intake_link`) follows the link's project; a MILESTONE_* row
--      follows its milestone's project (`details.milestoneId`; a milestone
--      with no project is org-level, a project-typed row is SEC-20's), and a
--      milestone row whose milestone is gone or unreadable is the audit
--      roles' only. `audit_logs_admin_trail` is re-created from its NEWEST
--      definition (20261142) byte for byte with ONE added clause — the type /
--      action test inline, so a row of any other kind never calls the
--      function.
--
-- NOT a widening: every rule here refuses or narrows. The DEC-30 inventory
-- (aggregate counts only, never rows) is captured BEFORE the transaction and
-- returned with the probes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (idempotent). The final SELECT is the only result set shown — probe
-- rows must read ok = true; inventory rows carry ok NULL and a count in n.
-- Requires 20261013 (the registry and the quality tables), 20261091 (the
-- checklist rails), 20261093 (the money rails) and 20261142 (SEC-20's
-- overlay, which section 5 re-creates).

DO $$
BEGIN
  IF to_regprocedure('public.audit_row_project_visible(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261142_prj_roundG_project_audit_rows.sql first — section 5 re-creates its audit_logs_admin_trail. Nothing was changed.';
  END IF;
END $$;

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
DROP TABLE IF EXISTS pg_temp.prj_g_j12_inventory;
CREATE TEMP TABLE prj_g_j12_inventory AS
SELECT 'inventory (MON-12): open quotes (draft / parsed) whose contractor is linked to a do-not-use or inactive company (an award now needs the typed override, through award_quote)' AS inventory, COUNT(*)::text AS n
  FROM cost_documents d
  JOIN project_parties pp ON pp.id = d.party_id
  JOIN companies c ON c.id = pp.company_id
 WHERE d.kind = 'quote' AND d.status IN ('draft', 'parsed') AND c.status IN ('do_not_use', 'inactive')
UNION ALL
SELECT 'inventory (MON-12): awarded quotes whose contractor is linked to a do-not-use or inactive company (kept as they are — the rail binds the next award)', COUNT(*)::text
  FROM cost_documents d
  JOIN project_parties pp ON pp.id = d.party_id
  JOIN companies c ON c.id = pp.company_id
 WHERE d.kind = 'quote' AND d.status = 'awarded' AND c.status IN ('do_not_use', 'inactive')
UNION ALL
SELECT 'inventory (GAP-406): awarded / posted documents with no linked cost entry (the repair backlog — Repair on the Costs tab; this migration prevents new ones)', COUNT(*)::text
  FROM cost_documents d
 WHERE d.status IN ('awarded', 'posted')
   AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.source_document_id = d.id)
UNION ALL
SELECT 'inventory (MON-13): contractors with a Known Company link (now set once — never re-pointed or cleared by a signed-in caller)', COUNT(*)::text
  FROM project_parties WHERE company_id IS NOT NULL
UNION ALL
SELECT 'inventory (MON-13): decided turnover items (accepted / waived / rejected) with a contractor (now kept as recorded)', COUNT(*)::text
  FROM turnover_items WHERE status IN ('accepted', 'waived', 'rejected') AND party_id IS NOT NULL
UNION ALL
SELECT 'inventory (MON-13): rejected turnover items with no contractor (cannot be named until the resubmission is accepted)', COUNT(*)::text
  FROM turnover_items WHERE status = 'rejected' AND party_id IS NULL
UNION ALL
SELECT 'inventory (MON-13): decided punch items (done / void) with a contractor (now kept as recorded)', COUNT(*)::text
  FROM punch_items WHERE status IN ('done', 'void') AND party_id IS NOT NULL
UNION ALL
SELECT 'inventory: other BEFORE UPDATE row triggers on cost_documents / project_parties / turnover_items / punch_items (they run beside these rails)', COUNT(*)::text
  FROM pg_trigger t
 WHERE NOT t.tgisinternal
   AND t.tgrelid IN ('public.cost_documents'::regclass, 'public.project_parties'::regclass, 'public.turnover_items'::regclass, 'public.punch_items'::regclass)
   AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
   AND t.tgname NOT IN ('trg_cost_documents_award_registry', 'trg_project_parties_company_link',
                        'trg_turnover_items_contractor_fixed', 'trg_punch_items_contractor_fixed')
UNION ALL
SELECT 'inventory (SEC-21): MILESTONE_* audit rows not typed project whose milestone belongs to a PRIVATE project (now readable only by those who can see it, and the audit roles)', COUNT(*)::text
  FROM audit_logs a
  JOIN milestones m ON m.id::text = a.details ->> 'milestoneId'
  JOIN projects p ON p.id = m.project_id
 WHERE left(a.action, 10) = 'MILESTONE_' AND COALESCE(a.resource_type, '') <> 'project' AND p.visibility = 'private'
UNION ALL
SELECT 'inventory (SEC-21): MILESTONE_* audit rows not typed project whose milestone no longer exists (now readable only by the audit roles)', COUNT(*)::text
  FROM audit_logs a
 WHERE left(a.action, 10) = 'MILESTONE_' AND COALESCE(a.resource_type, '') <> 'project'
   AND NOT EXISTS (SELECT 1 FROM milestones m WHERE m.id::text = a.details ->> 'milestoneId')
UNION ALL
SELECT 'inventory (SEC-21): intake-link audit rows (project_intake_link) and INTAKE_* rows naming a PRIVATE project (now readable only by those who can see it, and the audit roles)', COUNT(*)::text
  FROM audit_logs a
  JOIN projects p ON p.id::text = COALESCE(a.details ->> 'projectId',
                                           (SELECT l.project_id::text FROM project_intake_links l WHERE l.id::text = a.resource_id))
 WHERE (a.resource_type = 'project_intake_link' OR left(a.action, 7) = 'INTAKE_') AND p.visibility = 'private';

BEGIN;

-- ── 1. the company behind a cost document (MON-12 / GAP-406) ─────────────
-- lib/costDocs.ts companyBehind, in SQL: the document's own registry link,
-- then its contractor's, then one exact case-insensitive name in the org.
-- SECURITY INVOKER: called by award_quote it reads what the caller may
-- read; called by the rail (a definer) it reads as the owner.
CREATE OR REPLACE FUNCTION public.cost_doc_company_behind(p_org uuid, p_company uuid, p_party uuid, p_vendor text)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_party_company uuid;
  v_n integer;
BEGIN
  IF p_company IS NOT NULL THEN
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
      FROM companies c WHERE c.id = p_company;
    IF v_row IS NOT NULL THEN RETURN v_row; END IF;
  END IF;
  IF p_party IS NOT NULL THEN
    SELECT pp.company_id INTO v_party_company FROM project_parties pp WHERE pp.id = p_party;
    IF v_party_company IS NOT NULL THEN
      SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
        FROM companies c WHERE c.id = v_party_company;
      IF v_row IS NOT NULL THEN RETURN v_row; END IF;
    END IF;
  END IF;
  IF NULLIF(btrim(COALESCE(p_vendor, '')), '') IS NULL THEN RETURN NULL; END IF;
  SELECT COUNT(*) INTO v_n FROM companies c
   WHERE c.org_id = p_org AND lower(c.name) = lower(btrim(p_vendor));
  IF v_n <> 1 THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
    FROM companies c WHERE c.org_id = p_org AND lower(c.name) = lower(btrim(p_vendor));
  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.cost_doc_company_behind(uuid, uuid, uuid, text) IS
  'MON-12 (20261157): the Known Company behind a cost document — its own registry link, then its contractor''s, then one exact case-insensitive name in the org (lib/costDocs.ts companyBehind). SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.cost_doc_company_behind(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_doc_company_behind(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cost_doc_company_behind(uuid, uuid, uuid, text) TO authenticated, service_role;

-- ── 2. MON-12: a do-not-use / inactive company is never awarded without the override ──
CREATE OR REPLACE FUNCTION public.enforce_cost_document_award_registry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass: restores, server routes, the SQL editor
  IF NEW.status IS DISTINCT FROM 'awarded' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'awarded' THEN RETURN NEW; END IF;   -- no move to awarded
  v_company := cost_doc_company_behind(NEW.org_id, NULLIF(to_jsonb(NEW) ->> 'company_id', '')::uuid, NEW.party_id, NEW.vendor_name);
  IF v_company IS NOT NULL AND v_company ->> 'status' IN ('do_not_use', 'inactive')
     AND COALESCE(current_setting('app.cost_doc_award_override', true), '') IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION '% is flagged % in the company registry — awarding it needs an explicit override with a reason, recorded on the audit trail (Award on the Costs tab asks for one); nothing was changed. (MON-12, 20261157)',
      v_company ->> 'name', CASE v_company ->> 'status' WHEN 'do_not_use' THEN 'DO NOT USE' ELSE 'inactive' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_cost_document_award_registry() IS
  'MON-12 (20261157): a signed-in move of a quote to awarded is refused while the company behind it (cost_doc_company_behind, read as the definer) is do_not_use or inactive, unless award_quote set app.cost_doc_award_override to the document id after a typed reason. The service role passes.';

REVOKE ALL ON FUNCTION public.enforce_cost_document_award_registry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_cost_document_award_registry() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_cost_document_award_registry() FROM authenticated;

DROP TRIGGER IF EXISTS trg_cost_documents_award_registry ON cost_documents;
CREATE TRIGGER trg_cost_documents_award_registry
  BEFORE INSERT OR UPDATE OF status ON cost_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cost_document_award_registry();

-- ── 3. GAP-406: the award as one transaction ─────────────────────────────
CREATE OR REPLACE FUNCTION public.award_quote(
  p_doc uuid,
  p_cost_account uuid,
  p_expected_total numeric,
  p_override_reason text DEFAULT NULL,
  p_confirmed_total numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := NULLIF(auth.jwt() ->> 'email', '');
  v_doc record;
  v_raw jsonb;
  v_account record;
  v_doc_currency text;
  v_account_currency text;
  v_extracted numeric;
  v_total numeric;
  v_company jsonb;
  v_flagged boolean := false;
  v_override text := NULLIF(btrim(COALESCE(p_override_reason, '')), '');
  v_claimed integer;
  v_entry uuid;
  v_reference text;
  v_description text;
  v_key text;
  v_rival_ids uuid[] := '{}';
  v_rival_names jsonb := '[]'::jsonb;
  v_declined integer := 0;
  v_ungrouped jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to award a quote; nothing was changed. (GAP-406, 20261157)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The quote, locked for this award (RLS: only a caller who may update it
  -- finds it).
  SELECT * INTO v_doc FROM cost_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  v_raw := to_jsonb(v_doc);
  IF v_doc.kind IS DISTINCT FROM 'quote' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_quote'); END IF;
  IF v_doc.status NOT IN ('draft', 'parsed') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'status', 'status', v_doc.status);
  END IF;

  -- The budget line: this project's, in the document's currency (COST-8 —
  -- lib/costDocs.ts normalizeCurrency; an account with no currency is USD).
  SELECT a.id, a.project_id, a.currency INTO v_account FROM cost_accounts a WHERE a.id = p_cost_account;
  IF NOT FOUND OR v_account.project_id IS DISTINCT FROM v_doc.project_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'account');
  END IF;
  v_doc_currency := upper(regexp_replace(COALESCE(v_doc.currency, ''), '\s+', '', 'g'));
  v_doc_currency := CASE WHEN v_doc_currency IN ('$', 'US$', 'USD$', '$US') THEN 'USD'
                         WHEN v_doc_currency ~ '^[A-Z]{3}$' THEN v_doc_currency END;
  v_account_currency := upper(regexp_replace(COALESCE(v_account.currency, ''), '\s+', '', 'g'));
  v_account_currency := COALESCE(CASE WHEN v_account_currency IN ('$', 'US$', 'USD$', '$US') THEN 'USD'
                                      WHEN v_account_currency ~ '^[A-Z]{3}$' THEN v_account_currency END, 'USD');
  IF v_doc_currency IS NOT NULL AND v_doc_currency <> v_account_currency THEN
    RETURN jsonb_build_object('ok', false, 'code', 'currency', 'docCurrency', v_doc_currency, 'accountCurrency', v_account_currency);
  END IF;

  -- The total that posts: the row's (AI-written or typed), else the
  -- extraction's — and it must be the one the caller checked.
  v_extracted := CASE WHEN jsonb_typeof(v_doc.parsed -> 'total') = 'number' AND (v_doc.parsed ->> 'total')::numeric > 0
                      THEN (v_doc.parsed ->> 'total')::numeric END;
  v_total := COALESCE(v_doc.total_amount, v_extracted);
  IF v_total IS NULL OR v_total <= 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'no_total'); END IF;
  IF p_expected_total IS NULL OR v_total <> p_expected_total THEN
    RETURN jsonb_build_object('ok', false, 'code', 'total_changed', 'total', v_total);
  END IF;

  -- The registry (MON-12): a flagged company needs the typed reason.
  v_company := cost_doc_company_behind(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name);
  v_flagged := v_company IS NOT NULL AND v_company ->> 'status' IN ('do_not_use', 'inactive');
  IF v_flagged AND v_override IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'company_flagged', 'company', v_company);
  END IF;

  -- 1. The claim. The registry rail reads the override for this document only.
  IF v_flagged THEN PERFORM set_config('app.cost_doc_award_override', p_doc::text, true); END IF;
  UPDATE cost_documents SET status = 'awarded', posted_at = now(), posted_by = v_uid
   WHERE id = p_doc AND status IN ('draft', 'parsed');
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  PERFORM set_config('app.cost_doc_award_override', '', true);
  IF v_claimed = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'refused'); END IF;

  -- From here every failure RAISES: the award rolls back whole.
  -- 2. The commitment — lib/costs.ts addEntry's row and its audit row.
  v_reference := NULLIF(btrim(COALESCE(v_doc.doc_number, v_doc.file_name, '')), '');
  v_description := btrim('Award — ' || COALESCE(v_doc.vendor_name, 'vendor')
    || CASE WHEN COALESCE(v_doc.rfq_group, '') <> '' THEN ' (' || v_doc.rfq_group || ')' ELSE '' END);
  INSERT INTO cost_entries (org_id, project_id, cost_account_id, party_id, entry_type, amount, entry_date,
                            description, reference, source_document_id, status, created_by, created_by_name)
  VALUES (v_doc.org_id, v_doc.project_id, p_cost_account, v_doc.party_id, 'commitment', v_total,
          (now() AT TIME ZONE 'UTC')::date, v_description, v_reference, p_doc, 'posted', v_uid,
          NULLIF(split_part(COALESCE(v_email, ''), '@', 1), ''))
  RETURNING id INTO v_entry;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
  VALUES ('COST_ENTRY_POSTED', 'cost', v_entry::text, v_doc.org_id, v_uid, v_email,
          jsonb_build_object('accountId', p_cost_account, 'type', 'commitment', 'amount', v_total,
                             'reference', v_reference, 'sourceDocumentId', p_doc));

  -- 3. The override, on the record by company id.
  IF v_flagged THEN
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
    VALUES ('COST_DOC_AWARD_OVERRIDE', 'cost', p_doc::text, v_doc.org_id, v_uid, v_email,
            jsonb_build_object('companyId', v_company ->> 'id', 'companyName', v_company ->> 'name',
                               'companyStatus', v_company ->> 'status', 'reason', v_override));
  END IF;

  -- 4. The rivals: every still-open quote of the same RFQ group (by key)
  --    becomes "not selected". An ungrouped award declines nothing; the open
  --    ungrouped quotes are named back to the caller.
  v_key := lower(btrim(regexp_replace(COALESCE(v_doc.rfq_group, ''), '\s+', ' ', 'g')));
  IF v_key <> '' THEN
    SELECT COALESCE(array_agg(c.id ORDER BY c.created_at, c.id), '{}'),
           COALESCE(jsonb_agg(COALESCE(c.vendor_name, c.id::text) ORDER BY c.created_at, c.id), '[]'::jsonb)
      INTO v_rival_ids, v_rival_names
      FROM cost_documents c
     WHERE c.project_id = v_doc.project_id AND c.id <> p_doc AND c.kind = 'quote'
       AND c.status IN ('draft', 'parsed')
       AND lower(btrim(regexp_replace(COALESCE(c.rfq_group, ''), '\s+', ' ', 'g'))) = v_key;
    IF cardinality(v_rival_ids) > 0 THEN
      UPDATE cost_documents SET status = 'declined'
       WHERE id = ANY (v_rival_ids) AND status IN ('draft', 'parsed');
      GET DIAGNOSTICS v_declined = ROW_COUNT;
    END IF;
  ELSE
    SELECT COALESCE(jsonb_agg(COALESCE(c.vendor_name, c.file_name, 'quote') ORDER BY c.created_at, c.id), '[]'::jsonb)
      INTO v_ungrouped
      FROM cost_documents c
     WHERE c.project_id = v_doc.project_id AND c.id <> p_doc AND c.kind = 'quote'
       AND c.status IN ('draft', 'parsed')
       AND lower(btrim(regexp_replace(COALESCE(c.rfq_group, ''), '\s+', ' ', 'g'))) = '';
  END IF;

  -- 5. The award, on the record.
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
  VALUES ('COST_DOC_AWARDED', 'cost', p_doc::text, v_doc.org_id, v_uid, v_email,
          jsonb_build_object(
            'vendor', v_doc.vendor_name, 'total', v_total, 'rfqGroup', v_doc.rfq_group,
            'rivalsConsidered', v_rival_names, 'rivalsDeclined', v_declined,
            'ungroupedLeftOpen', jsonb_array_length(v_ungrouped),
            'costAccountId', p_cost_account, 'postedEntryId', v_entry,
            'companyId', v_company ->> 'id', 'override', CASE WHEN v_flagged THEN v_override END,
            'pagesRead', v_raw -> 'pages_read', 'pagesTotal', v_raw -> 'pages_total',
            'totalConfirmed', p_confirmed_total IS NOT NULL, 'oneTransaction', true));

  RETURN jsonb_build_object(
    'ok', true, 'entryId', v_entry, 'total', v_total,
    'rivals', cardinality(v_rival_ids), 'declined', v_declined, 'ungroupedOpen', v_ungrouped,
    'company', v_company, 'override', v_flagged);
END;
$$;

COMMENT ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric) IS
  'GAP-406 (20261157): claim + commitment + override record + rival decline + COST_DOC_AWARDED in ONE transaction, under the caller''s own RLS and rails (SECURITY INVOKER). A refusal before the claim returns {ok:false, code} and writes nothing; any failure after it raises and rolls the award back. NULL auth.uid() refused.';

REVOKE ALL ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric) TO authenticated;

-- ── 4. PERF-7: the machine writes to a checklist's items in one request ──
CREATE OR REPLACE FUNCTION public.apply_checklist_item_writes(p_checklist uuid, p_writes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_write jsonb;
  v_id uuid;
  v_hit uuid;
  v_name text;
  v_landed jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to change checklist items; nothing was changed. (PERF-7, 20261157)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_writes IS NULL OR jsonb_typeof(p_writes) <> 'array' OR jsonb_array_length(p_writes) > 2000 THEN
    RAISE EXCEPTION 'apply_checklist_item_writes takes an array of at most 2000 item writes; nothing was changed.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR v_write IN SELECT value FROM jsonb_array_elements(p_writes) LOOP
    v_id := NULL;
    v_hit := NULL;
    BEGIN
      v_id := (v_write ->> 'id')::uuid;
      v_name := v_write ->> 'updated_by_name';
      IF v_name IS NULL OR v_name NOT IN ('evidence sweep', 'AI assessment') THEN
        RAISE EXCEPTION 'Only the evidence sweep and the AI assessment write through this call — a person''s decision is its own write; nothing was changed.'
          USING ERRCODE = 'check_violation';
      END IF;
      UPDATE checklist_items ci SET
        status = CASE WHEN v_write ? 'status' THEN v_write ->> 'status' ELSE ci.status END,
        applicability = CASE WHEN v_write ? 'applicability' THEN v_write ->> 'applicability' ELSE ci.applicability END,
        ai_rationale = CASE WHEN v_write ? 'ai_rationale' THEN v_write ->> 'ai_rationale' ELSE ci.ai_rationale END,
        evidence = CASE WHEN v_write ? 'evidence' THEN v_write -> 'evidence' ELSE ci.evidence END,
        updated_at = now(),
        updated_by = NULL,
        updated_by_name = v_name
       WHERE ci.id = v_id
         AND ci.checklist_id = p_checklist
         AND ci.updated_at IS NOT DISTINCT FROM NULLIF(v_write ->> 'expected_updated_at', '')::timestamptz
      RETURNING ci.id INTO v_hit;
      IF v_hit IS NULL THEN
        v_refused := v_refused || jsonb_build_array(v_id::text);
      ELSE
        v_landed := v_landed || jsonb_build_array(v_id::text);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || jsonb_build_array(jsonb_build_object(
        'id', COALESCE(v_id::text, v_write ->> 'id'), 'code', SQLSTATE, 'message', SQLERRM));
    END;
  END LOOP;
  RETURN jsonb_build_object('landed', v_landed, 'refused', v_refused, 'failed', v_failed);
END;
$$;

COMMENT ON FUNCTION public.apply_checklist_item_writes(uuid, jsonb) IS
  'PERF-7 / DEC-52 item 10 (20261157): the evidence sweep''s and the AI assessment''s writes to one checklist''s items in ONE request, each guarded on updated_at as read (IS NOT DISTINCT FROM) and in its own sub-transaction; returns {landed, refused, failed}. SECURITY INVOKER — RLS and every 20261091 rail apply per row. NULL auth.uid() refused.';

REVOKE ALL ON FUNCTION public.apply_checklist_item_writes(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_checklist_item_writes(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_checklist_item_writes(uuid, jsonb) TO authenticated;

-- ── 5. MON-13: the contractor-link and item-contractor rules ─────────────
CREATE OR REPLACE FUNCTION public.enforce_project_party_company_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass
  IF OLD.company_id IS NULL OR NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN RETURN NEW; END IF;
  -- The company's own delete: its FK ON DELETE SET NULL, one trigger level down.
  IF NEW.company_id IS NULL AND pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A contractor''s Known Company link is set once and never re-pointed or cleared — an award reads the company''s do-not-use flag through it; nothing was changed. (MON-13, 20261157)'
    USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION public.enforce_project_party_company_link() IS
  'MON-13 / DEC-76 item 3 (20261157): a signed-in caller never re-points or clears a contractor''s company link once it is set; the company''s delete (FK ON DELETE SET NULL, one trigger level down) and the service role pass.';

REVOKE ALL ON FUNCTION public.enforce_project_party_company_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_project_party_company_link() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_project_party_company_link() FROM authenticated;

DROP TRIGGER IF EXISTS trg_project_parties_company_link ON project_parties;
CREATE TRIGGER trg_project_parties_company_link
  BEFORE UPDATE OF company_id ON project_parties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_party_company_link();

CREATE OR REPLACE FUNCTION public.enforce_quality_item_contractor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_noun text := CASE TG_TABLE_NAME WHEN 'turnover_items' THEN 'turnover item' ELSE 'punch item' END;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass
  IF NEW.party_id IS NOT DISTINCT FROM OLD.party_id THEN RETURN NEW; END IF;
  -- The contractor's own delete: its FK ON DELETE SET NULL, one trigger level down.
  IF NEW.party_id IS NULL AND pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  -- Undecided: the contractor may be set and changed.
  IF (TG_TABLE_NAME = 'turnover_items' AND OLD.status IN ('open', 'received'))
     OR (TG_TABLE_NAME = 'punch_items' AND OLD.status = 'open') THEN
    RETURN NEW;
  END IF;
  IF OLD.party_id IS NOT NULL THEN
    RAISE EXCEPTION 'This % is decided (%) — its contractor stays as recorded; a standing decision never moves to another company''s record. Nothing was changed. (MON-13, 20261157)',
      v_noun, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'turnover_items' AND OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'A rejected turnover item''s contractor can''t be named — a rejection can''t be reopened, so a wrong name could never be corrected. Name the contractor once the resubmission is accepted; nothing was changed. (MON-13, 20261157)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;                                                 -- an unassigned decided item, named once
END;
$$;

COMMENT ON FUNCTION public.enforce_quality_item_contractor() IS
  'MON-13 / DEC-76 item 3 (20261157): a turnover or punch item''s contractor changes only while the item is undecided (turnover open / received; punch open); an unassigned decided item may be named once, never a rejected turnover item. The contractor''s delete (FK ON DELETE SET NULL, one trigger level down) and the service role pass.';

REVOKE ALL ON FUNCTION public.enforce_quality_item_contractor() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_quality_item_contractor() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_quality_item_contractor() FROM authenticated;

DROP TRIGGER IF EXISTS trg_turnover_items_contractor_fixed ON turnover_items;
CREATE TRIGGER trg_turnover_items_contractor_fixed
  BEFORE UPDATE OF party_id ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_quality_item_contractor();

DROP TRIGGER IF EXISTS trg_punch_items_contractor_fixed ON punch_items;
CREATE TRIGGER trg_punch_items_contractor_fixed
  BEFORE UPDATE OF party_id ON punch_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_quality_item_contractor();

-- ── 6. SEC-21: project audit rows written under another resource type ────
CREATE OR REPLACE FUNCTION public.audit_row_project_ref_visible(p_action text, p_type text, p_resource text, p_details jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    -- A row that names its project (the intake door's rows, the Intake and
    -- Costs tabs' link rows) follows that project.
    WHEN COALESCE(p_details ->> 'projectId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN public.project_visible_to_me((p_details ->> 'projectId')::uuid)
    -- An intake-link row names the link: the link's project.
    WHEN p_type = 'project_intake_link' THEN
      CASE WHEN COALESCE(p_resource, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false
           ELSE EXISTS (SELECT 1 FROM public.project_intake_links l
                         WHERE l.id = p_resource::uuid AND public.project_visible_to_me(l.project_id)) END
    -- A milestone row names its milestone (details.milestoneId): the
    -- milestone's project; a milestone with no project is org-level. A
    -- project-typed milestone row is a project row (SEC-20's clause decides).
    WHEN left(COALESCE(p_action, ''), 10) = 'MILESTONE_' THEN
      CASE WHEN p_type = 'project' THEN true
           WHEN COALESCE(p_details ->> 'milestoneId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false
           ELSE EXISTS (SELECT 1 FROM public.milestones m
                         WHERE m.id = (p_details ->> 'milestoneId')::uuid
                           AND (m.project_id IS NULL OR public.project_visible_to_me(m.project_id))) END
    -- Anything else (an INTAKE_ row that names no project): its own type's reach.
    ELSE true
  END;
$$;

COMMENT ON FUNCTION public.audit_row_project_ref_visible(text, text, text, jsonb) IS
  'SEC-21 (20261157): may the caller read an audit row about a project written under another resource type? details.projectId → that project; a project_intake_link row → the link''s project; a MILESTONE_* row → its milestone''s project (no project = org-level; a gone or unreadable milestone → not visible; a project-typed row → SEC-20 decides); else true. SECURITY INVOKER, no SET clause, names schema-qualified.';

REVOKE ALL ON FUNCTION public.audit_row_project_ref_visible(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_row_project_ref_visible(text, text, text, jsonb) TO anon, authenticated, service_role;

-- ── 7. the audit trail overlay: 20261142's body + the SEC-21 clause ──────
DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;
CREATE POLICY audit_logs_admin_trail ON audit_logs
  AS RESTRICTIVE FOR SELECT
  USING (
    org_capability_allows(org_id, 'admin.audit_view', auth.uid())
    OR NOT (
      COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
      OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
      OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
      OR action LIKE 'DATA_EXPORT%' OR action LIKE 'RESTORE_%' OR action LIKE 'PURGE_%'
    )
    -- SEC-20 (20261142): a row about a project, a cost record or a quality
    -- sign-off is the project's — readable when the caller can see the
    -- project. AND binds tighter than OR: an audit viewer reads every row;
    -- anyone else reads a row that is not the org-level trail AND whose
    -- project they can see. The type test is inline: a row of any other
    -- type never calls the function.
    AND (COALESCE(resource_type, '') NOT IN ('project', 'cost', 'project_checklist', 'turnover_item')
         OR audit_row_project_visible(resource_type, resource_id))
    -- SEC-21 (20261157): a row about a project written under another type —
    -- an intake-link row, an INTAKE_ row, a MILESTONE_ row — follows the
    -- project it names. The kind test is inline: no other row calls the
    -- function.
    AND ((COALESCE(resource_type, '') <> 'project_intake_link'
          AND left(COALESCE(action, ''), 10) <> 'MILESTONE_'
          AND left(COALESCE(action, ''), 7) <> 'INTAKE_')
         OR audit_row_project_ref_visible(action, resource_type, resource_id, details))
  );

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_policies.qual is DEPARSED; pg_proc.prosrc is verbatim.
SELECT 'MON-12: the registry rail is a SECURITY DEFINER trigger function with search_path pinned, EXECUTE revoked from anon and authenticated, reading the award override for the one document' AS check,
       (SELECT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%app.cost_doc_award_override%' AND prosrc LIKE '%''do_not_use'', ''inactive''%'
               AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
          FROM pg_proc WHERE proname = 'enforce_cost_document_award_registry' AND pronargs = 0)
       AND NOT has_function_privilege('anon', 'public.enforce_cost_document_award_registry()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.enforce_cost_document_award_registry()', 'EXECUTE') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'MON-12: trg_cost_documents_award_registry fires BEFORE INSERT OR UPDATE OF status on cost_documents',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.cost_documents'::regclass AND t.tgname = 'trg_cost_documents_award_registry'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF status ON public.cost_documents%'),
       NULL::text
UNION ALL
SELECT 'MON-12: cost_doc_company_behind resolves the document link, then the contractor link, then one exact name — SECURITY INVOKER, not executable by anon',
       (SELECT NOT prosecdef AND prosrc LIKE '%FROM project_parties pp WHERE pp.id = p_party%'
               AND prosrc LIKE '%IF v_n <> 1 THEN RETURN NULL; END IF;%'
          FROM pg_proc WHERE proname = 'cost_doc_company_behind' AND pronargs = 4)
       AND NOT has_function_privilege('anon', 'public.cost_doc_company_behind(uuid,uuid,uuid,text)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'GAP-406: award_quote is SECURITY INVOKER with search_path pinned, refuses a NULL auth.uid(), locks the quote, and claims + posts + records + declines in its one body',
       (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%IF v_uid IS NULL THEN%' AND prosrc LIKE '%FOR UPDATE;%'
               AND prosrc LIKE '%INSERT INTO cost_entries%' AND prosrc LIKE '%''COST_ENTRY_POSTED''%'
               AND prosrc LIKE '%''COST_DOC_AWARD_OVERRIDE''%' AND prosrc LIKE '%SET status = ''declined''%'
               AND prosrc LIKE '%''COST_DOC_AWARDED''%'
               AND strpos(prosrc, 'SET status = ''awarded''') < strpos(prosrc, 'INSERT INTO cost_entries')
          FROM pg_proc WHERE proname = 'award_quote' AND pronargs = 5),
       NULL::text
UNION ALL
SELECT 'GAP-406: anon cannot execute award_quote; authenticated can (DRLS-16)',
       NOT has_function_privilege('anon', 'public.award_quote(uuid,uuid,numeric,text,numeric)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.award_quote(uuid,uuid,numeric,text,numeric)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'PERF-7: apply_checklist_item_writes is SECURITY INVOKER with search_path pinned, refuses a NULL auth.uid(), keeps the per-row updated_at guard and writes only the machine actor''s rows',
       (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%IF auth.uid() IS NULL THEN%'
               AND prosrc LIKE '%ci.updated_at IS NOT DISTINCT FROM NULLIF(v_write ->> ''expected_updated_at'', '''')::timestamptz%'
               AND prosrc LIKE '%NOT IN (''evidence sweep'', ''AI assessment'')%'
               AND prosrc LIKE '%EXCEPTION WHEN OTHERS THEN%'
          FROM pg_proc WHERE proname = 'apply_checklist_item_writes' AND pronargs = 2)
       AND NOT has_function_privilege('anon', 'public.apply_checklist_item_writes(uuid,jsonb)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.apply_checklist_item_writes(uuid,jsonb)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'MON-13: trg_project_parties_company_link fires BEFORE UPDATE OF company_id; a set link is never re-pointed or cleared by a signed-in caller (the FK SET NULL one level down passes)',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.project_parties'::regclass AND t.tgname = 'trg_project_parties_company_link'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF company_id ON public.project_parties%')
       AND (SELECT prosrc LIKE '%IF NEW.company_id IS NULL AND pg_trigger_depth() > 1 THEN RETURN NEW; END IF;%'
              FROM pg_proc WHERE proname = 'enforce_project_party_company_link' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'MON-13: the item-contractor triggers fire BEFORE UPDATE OF party_id on turnover_items and punch_items; decided items keep their contractor, a rejected one is never named',
       (SELECT COUNT(*) = 2 FROM pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
           AND ((t.tgrelid = 'public.turnover_items'::regclass AND t.tgname = 'trg_turnover_items_contractor_fixed'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF party_id ON public.turnover_items%')
             OR (t.tgrelid = 'public.punch_items'::regclass AND t.tgname = 'trg_punch_items_contractor_fixed'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF party_id ON public.punch_items%')))
       AND (SELECT prosrc LIKE '%OLD.status IN (''open'', ''received'')%' AND prosrc LIKE '%OLD.status = ''rejected''%'
              FROM pg_proc WHERE proname = 'enforce_quality_item_contractor' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'SEC-21: audit_logs_admin_trail is still RESTRICTIVE SELECT with SEC-20''s clause and now gates intake-link, INTAKE_ and MILESTONE_ rows on audit_row_project_ref_visible, the kind test inline',
       (SELECT permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
               AND qual LIKE '%org_capability_allows(org_id, ''admin.audit_view''%'
               AND qual LIKE '%audit_row_project_visible(resource_type, resource_id)%'
               AND qual LIKE '%audit_row_project_ref_visible(action, resource_type, resource_id, details)%'
               AND qual LIKE '%project_intake_link%' AND qual LIKE '%MILESTONE_%' AND qual LIKE '%INTAKE_%'
          FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail'),
       NULL::text
UNION ALL
SELECT 'SEC-21: the base member policy and the insert policy are untouched (one permissive SELECT, one INSERT, one RESTRICTIVE overlay)',
       (SELECT COUNT(*) FILTER (WHERE permissive = 'PERMISSIVE' AND cmd = 'SELECT') = 1
               AND COUNT(*) FILTER (WHERE cmd = 'INSERT') = 1
               AND COUNT(*) FILTER (WHERE permissive = 'RESTRICTIVE') = 1
          FROM pg_policies WHERE tablename = 'audit_logs'),
       NULL::text
UNION ALL
SELECT 'SEC-21: audit_row_project_ref_visible is SECURITY INVOKER with no SET clause, its names schema-qualified, executable by every role that reads audit_logs',
       (SELECT NOT prosecdef AND proconfig IS NULL
               AND prosrc LIKE '%public.project_visible_to_me(l.project_id)%' AND prosrc LIKE '%public.milestones m%'
          FROM pg_proc WHERE proname = 'audit_row_project_ref_visible' AND pronargs = 4)
       AND has_function_privilege('anon', 'public.audit_row_project_ref_visible(text,text,text,jsonb)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.audit_row_project_ref_visible(text,text,text,jsonb)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'SEC-21: the test answers — another kind → visible; a milestone row naming no milestone, an unknown milestone or link, an unknown project → not (no session here, so no project is visible)',
       audit_row_project_ref_visible('DOCUMENT_UPLOADED', 'document', 'x', '{}'::jsonb)
       AND audit_row_project_ref_visible('INTAKE_LINKS_REVOKED_WITH_PROJECT', 'project', 'x', '{}'::jsonb)
       AND audit_row_project_ref_visible('MILESTONE_CREATED', 'project', '00000000-0000-0000-0000-000000000000', '{}'::jsonb)
       AND NOT audit_row_project_ref_visible('MILESTONE_CREATED', 'document', 'x', '{}'::jsonb)
       AND NOT audit_row_project_ref_visible('MILESTONE_COMPLETED', 'document', 'x', '{"milestoneId":"00000000-0000-0000-0000-000000000000"}'::jsonb)
       AND NOT audit_row_project_ref_visible('INTAKE_LINK_REVOKED', 'project_intake_link', 'not-a-uuid', '{}'::jsonb)
       AND NOT audit_row_project_ref_visible('INTAKE_LINK_REVOKED', 'project_intake_link', '00000000-0000-0000-0000-000000000000', '{}'::jsonb)
       AND NOT audit_row_project_ref_visible('INTAKE_REJECTED', 'document', 'x', '{"projectId":"00000000-0000-0000-0000-000000000000"}'::jsonb),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j12_inventory;
