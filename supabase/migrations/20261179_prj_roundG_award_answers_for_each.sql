-- 20261179_prj_roundG_award_answers_for_each.sql
--
-- projects Round G — J14 PROJECTS FOLLOW-UPS. The two database halves of
-- projects-tab MON-12 that 20261157 left (both owned by J14 in the record),
-- in one paste. The numbers below are the body's section numbers (the
-- `-- ── n.` headings), which the records cite.
--
-- WHAT:
--   1. MON-12 done-when 1 / projects-and-cost COST-3 residual 3 — an award
--      answers for EVERY flagged company, each with its own reason.
--      20261157's `cost_doc_company_barred` names ONE company — the first of
--      its order (the document's own link; else the contractor's company
--      when flagged; else ANY do-not-use row the stored vendor name
--      normalises to; else the company the quote binds to, on its own
--      flag) — so a flagged contractor (an inactive one included) hid the
--      stored vendor name's do-not-use look-alike, and a look-alike hid the
--      bound company's own `inactive` flag: `award_quote`'s
--      COST_DOC_AWARD_OVERRIDE never recorded them. J14's decision (of the
--      two the record offered): return every flagged company the award
--      answers for, each with its own override — never reorder the first
--      answer (the rail, the refusal and the lib's prompt keep naming the
--      same company they named). `cost_doc_companies_barred` (new, SECURITY
--      INVOKER, the same four arguments) returns them as a JSON array:
--      `cost_doc_company_barred`'s answer first; then, unless the
--      document's own link to a company of its org decides (a person's
--      choice on the bid row — it decides alone, as before), the stored
--      vendor name's do-not-use look-alike (the same row the first answer
--      would have named — exact name, then id) and the company the quote
--      binds to (`cost_doc_company_behind` without the link) when flagged,
--      each once. `cost_doc_company_barred` is NOT re-created (its body,
--      its order and its single answer are unchanged); the new function
--      calls it. lib/costDocs.ts `companyBehind` returns the same list
--      (`also`), and the bid tab asks the list.
--   2. `award_quote` re-created from its NEWEST definition (20261157 §3;
--      the shape test finds it by scanning the sequence) with two
--      arguments added, both DEFAULT NULL, and nothing of its body lost:
--        * `p_override_company uuid` — the company the caller's reason was
--          typed for. When given, an award whose first answer under the
--          lock is another company is refused (`company_moved`) and writes
--          nothing — a link, contractor or vendor name moved between the
--          bid tab's last question and this lock never goes with a reason
--          typed for the earlier answer (J12 fix pass 8's residual).
--        * `p_also_overrides jsonb` — `[{companyId, reason}]`, one typed
--          reason for each OTHER company of section 1's list. A company of
--          the list with no reason refuses the award (`company_flagged`,
--          `also: true`, naming it) and writes nothing; each one given is
--          recorded under its own COST_DOC_AWARD_OVERRIDE row (`also:
--          true`) in the award's own transaction, and COST_DOC_AWARDED
--          names them (`alsoOverridden`). A reason for a company not on
--          the list is ignored (nothing is recorded for it).
--      The five-argument signature is DROPPED first, so PostgREST never
--      sees two candidates (PGRST203) — a call with the five named
--      arguments (the app before J14) resolves to the new function, its
--      two new arguments NULL, and behaves as before for a quote that
--      answers for one company.
--   3. MON-12 done-when 1, the two-step write — the rail on a MOVE.
--      `enforce_cost_document_company_move` (BEFORE UPDATE ON
--      cost_documents, SECURITY DEFINER, search_path pinned, EXECUTE
--      revoked from PUBLIC, anon and authenticated): a signed-in write to
--      an OPEN quote (draft / parsed) that changes its company link
--      (`company_id`, read through to_jsonb — a database without
--      20261096's column is not broken, which is also why the trigger has
--      no column list), its contractor (`party_id`) or its vendor name is
--      refused when a flagged company the quote answered for (section 1's
--      list, read as the definer) is not on the list the moved row answers
--      for — unless the write runs inside `relink_cost_document` (below),
--      which sets the transaction-local `app.cost_doc_relink_override` to
--      that one document's id after a typed reason. Passes: the service
--      role (auth.uid() NULL — the AI read route fills a missing vendor
--      name as the service role; restores; the SQL editor); a decided
--      quote (the award rail and the decided-bid rules judge those); a
--      move that leaves no flagged company behind (linking a bid to the
--      flagged company itself, or between unflagged ones); the company's
--      or the contractor's own delete (FK ON DELETE SET NULL, one trigger
--      level down — 20261157 §5's pattern).
--   4. `relink_cost_document(p_doc, p_company, p_reason)` (SECURITY
--      INVOKER — the caller's own RLS; search_path pinned; NULL auth.uid()
--      refused; EXECUTE revoked from PUBLIC and anon): the bid row's
--      company picker (components/projects/cost/QuotesPanel.tsx
--      `linkCompany`) moved onto the server. Locks the quote; refuses a
--      decided one, a company of another org, a database without
--      20261096's column (`no_column` — the picker says so); computes the
--      flagged companies the move leaves (section 1's list before, minus
--      after) and, when there are any and no reason was typed, answers
--      `reason_required` naming them and writes nothing; otherwise moves
--      the link under the GUC and writes COST_DOC_COMPANY_LINKED (the
--      picker's own row, with `overrideDoNotUse` naming the first company
--      left and `leaving` naming each, the reason, `viaRpc: true`) in the
--      same transaction — so the move and its record land together or not
--      at all.
--
-- NOT a widening: section 1 is read-only; section 2 refuses more (a moved
-- answer, a missing reason) and records more; section 3 refuses a write
-- RLS allowed; section 4 does what the picker did, under the caller's own
-- RLS, and records it in the same transaction. The DEC-30 inventory
-- (aggregate counts only, never rows) is captured BEFORE the transaction
-- and returned with the probes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (idempotent). The final SELECT is the only result set shown — probe
-- rows must read ok = true; inventory rows carry ok NULL and a count in n.
--
-- PASTE ORDER: after 20261157 (the guard below refuses otherwise — section
-- 1 calls its functions and section 2 re-creates its award_quote) AND only
-- once the app carrying J14 is deployed. The app before J14 moves a bid off
-- a flagged company by writing `company_id` directly (the typed reason only
-- in its audit row): section 3 would refuse that reasoned move until the
-- J14 app, which moves it through relink_cost_document, is live. The app
-- before J14 also never sends `p_also_overrides`, so an award of a quote
-- that answers for a second flagged company would be refused (it names the
-- company; the J12 panel then stops) — another reason to deploy first.
-- The J14 app runs before this paste: relink_cost_document and
-- cost_doc_companies_barred missing (42883 / PGRST202) → the picker's
-- direct write and the bid tab's one-company question, as today; an award
-- call with the new arguments answered PGRST202 → the five-argument call,
-- as today, the lib recording the other companies' overrides itself.
-- 20261157 is unpasted (HOLD) today, so this file pastes after it, in the
-- same window or later.

DO $$
BEGIN
  IF to_regprocedure('public.cost_doc_company_barred(uuid,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.cost_doc_company_behind(uuid,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.company_name_key(text)') IS NULL
     OR (to_regprocedure('public.award_quote(uuid,uuid,numeric,text,numeric)') IS NULL
         AND to_regprocedure('public.award_quote(uuid,uuid,numeric,text,numeric,uuid,jsonb)') IS NULL) THEN
    RAISE EXCEPTION 'Apply 20261157_prj_roundG_server_remainders.sql first — this file calls its registry functions and re-creates its award_quote. Nothing was changed.';
  END IF;
END $$;

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
-- Set-based, read ONCE each (never a function call per quote per registry
-- row): every do-not-use registry row's name key per org (20261157's
-- company_name_key — the guard above found it), indexed; every exact
-- (case-insensitive) name per org with how many rows carry it — the
-- binding. Each open quote is then judged as section 1 judges it: its own
-- link to a company of its org decides alone; else the contractor's company
-- when flagged, the stored name's do-not-use look-alike (the exact name,
-- then id) and the company it binds to (the contractor's, else one exact
-- name) when flagged — counted once each. The scratch run checked these
-- counts against section 1's function applied per quote.
DROP TABLE IF EXISTS pg_temp.prj_g_j14_dnu;
CREATE TEMP TABLE prj_g_j14_dnu AS
  SELECT c.org_id, c.id, lower(c.name) AS lname, company_name_key(c.name) AS k
    FROM companies c
   WHERE c.status = 'do_not_use';
CREATE INDEX ON prj_g_j14_dnu (org_id, k);

DROP TABLE IF EXISTS pg_temp.prj_g_j14_inventory;
CREATE TEMP TABLE prj_g_j14_inventory AS
WITH
prj_g_j14_exact AS MATERIALIZED (
  SELECT c.org_id, lower(c.name) AS n, COUNT(*) AS hits,
         (array_agg(c.id))[1] AS id, (array_agg(c.status))[1] AS status
    FROM companies c
   GROUP BY c.org_id, lower(c.name)
),
prj_g_j14_quotes AS MATERIALIZED (
  SELECT d.org_id, d.vendor_name,
         lc.id AS link_id, lc.status AS link_status,
         pc.id AS c_id, pc.status AS c_status,
         CASE WHEN x.hits = 1 THEN x.id END AS x_id,
         CASE WHEN x.hits = 1 THEN x.status END AS x_status,
         company_name_key(d.vendor_name) AS k
    FROM cost_documents d
    LEFT JOIN companies lc ON lc.id = NULLIF(to_jsonb(d) ->> 'company_id', '')::uuid AND lc.org_id = d.org_id
    LEFT JOIN project_parties pp ON pp.id = d.party_id
    LEFT JOIN companies pc ON pc.id = pp.company_id AND pc.org_id = d.org_id
    LEFT JOIN prj_g_j14_exact x ON x.org_id = d.org_id AND x.n = lower(btrim(d.vendor_name)) AND btrim(d.vendor_name) <> ''
   WHERE d.kind = 'quote' AND d.status IN ('draft', 'parsed')
),
prj_g_j14_counted AS MATERIALIZED (
  SELECT CASE
           WHEN q.link_id IS NOT NULL THEN (q.link_status IN ('do_not_use', 'inactive'))::int
           ELSE (SELECT COUNT(DISTINCT s.v) FROM (VALUES
                   (CASE WHEN q.c_status IN ('do_not_use', 'inactive') THEN q.c_id END),
                   (la.id),
                   (CASE WHEN q.c_id IS NULL AND q.x_status IN ('do_not_use', 'inactive') THEN q.x_id END)) s(v))
         END AS flagged
    FROM prj_g_j14_quotes q
    LEFT JOIN LATERAL (
      SELECT f.id FROM prj_g_j14_dnu f
       WHERE f.org_id = q.org_id AND f.k = q.k AND q.k <> ''
       ORDER BY (f.lname = lower(btrim(q.vendor_name))) DESC NULLS LAST, f.id
       LIMIT 1) la ON true
)
SELECT 'inventory (MON-12 / COST-3): open quotes (draft / parsed) that answer for MORE than one flagged company (an award now needs a typed reason for each, each recorded under its own override row, section 2)' AS inventory, COUNT(*)::text AS n
  FROM prj_g_j14_counted WHERE flagged > 1
UNION ALL
SELECT 'inventory (MON-12): open quotes that answer for at least one flagged company (moving their company link, contractor or vendor name away from it now needs a typed reason, through the bid row''s picker — section 3)', COUNT(*)::text
  FROM prj_g_j14_counted WHERE flagged > 0
UNION ALL
SELECT 'inventory: other BEFORE UPDATE row triggers on cost_documents (they run beside section 3''s; 20261157''s award rail is one)', COUNT(*)::text
  FROM pg_trigger t
 WHERE NOT t.tgisinternal
   AND t.tgrelid = 'public.cost_documents'::regclass
   AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
   AND t.tgname <> 'trg_cost_documents_company_move'
UNION ALL
SELECT 'inventory: award_quote signatures before this paste (1 = 20261157''s five-argument one, dropped and re-created with seven; 0 on a re-run)', COUNT(*)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'award_quote' AND p.pronargs = 5;

BEGIN;

-- ── 1. every flagged company an award answers for (MON-12 / COST-3) ──────
-- cost_doc_company_barred's single answer FIRST (unchanged — the rail, the
-- refusal and the lib's prompt keep naming it), then — unless the
-- document's own link to a company of its org decides alone — the stored
-- vendor name's do-not-use look-alike (cost_doc_company_barred's own
-- order: the exact name, then id) and the company the quote binds to
-- (cost_doc_company_behind without the link: the contractor's link, else
-- one exact name) when flagged, each once. lib/costDocs.ts companyBehind's
-- `barred` + `also` is the same list. An empty array: no override needed.
-- SECURITY INVOKER, as 20261157's two functions: called by award_quote it
-- reads what the caller may read; called by the rail (a definer) it reads
-- as the owner.
CREATE OR REPLACE FUNCTION public.cost_doc_companies_barred(p_org uuid, p_company uuid, p_party uuid, p_vendor text)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_list jsonb := '[]'::jsonb;
  v_first jsonb;
  v_look jsonb;
  v_bound jsonb;
  v_key text;
BEGIN
  v_first := cost_doc_company_barred(p_org, p_company, p_party, p_vendor);
  IF v_first IS NOT NULL THEN v_list := jsonb_build_array(v_first); END IF;
  -- The document's own link to a company of its org decides alone.
  IF p_company IS NOT NULL AND EXISTS (SELECT 1 FROM companies c WHERE c.id = p_company AND c.org_id = p_org) THEN
    RETURN v_list;
  END IF;
  -- The stored vendor name's do-not-use look-alike, in
  -- cost_doc_company_barred's own order (the exact name, then id).
  v_key := company_name_key(p_vendor);
  IF v_key <> '' THEN
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_look
      FROM companies c
     WHERE c.org_id = p_org AND c.status = 'do_not_use'
       AND company_name_key(c.name) = v_key
     ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, c.id
     LIMIT 1;
    IF v_look IS NOT NULL AND NOT v_list @> jsonb_build_array(jsonb_build_object('id', v_look -> 'id')) THEN
      v_list := v_list || jsonb_build_array(v_look);
    END IF;
  END IF;
  -- The company the quote binds to (its contractor's link, else one exact
  -- name), on its own flag.
  v_bound := cost_doc_company_behind(p_org, NULL, p_party, p_vendor);
  IF v_bound ->> 'status' IN ('do_not_use', 'inactive')
     AND NOT v_list @> jsonb_build_array(jsonb_build_object('id', v_bound -> 'id')) THEN
    v_list := v_list || jsonb_build_array(v_bound);
  END IF;
  RETURN v_list;
END;
$$;

COMMENT ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) IS
  'MON-12 / COST-3 (20261179): every flagged company a cost document''s award answers for, as a JSON array — cost_doc_company_barred''s answer first, then (unless the document''s own link to a company of its org decides alone) the stored vendor name''s do-not-use look-alike and the bound company when flagged, each once (lib/costDocs.ts companyBehind barred + also). Empty: no override needed. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) TO authenticated, service_role;

-- ── 2. award_quote, re-created from 20261157 §3 with two arguments ───────
-- The five-argument signature goes first: two candidates would make
-- PostgREST refuse a call that matches both (PGRST203).
DROP FUNCTION IF EXISTS public.award_quote(uuid, uuid, numeric, text, numeric);

CREATE OR REPLACE FUNCTION public.award_quote(
  p_doc uuid,
  p_cost_account uuid,
  p_expected_total numeric,
  p_override_reason text DEFAULT NULL,
  p_confirmed_total numeric DEFAULT NULL,
  p_override_company uuid DEFAULT NULL,
  p_also_overrides jsonb DEFAULT NULL
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
  v_pages_read numeric;
  v_pages_total numeric;
  v_company jsonb;
  v_barred jsonb;
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
  v_also jsonb := '[]'::jsonb;
  v_also_one jsonb;
  v_also_reason text;
  v_also_given jsonb := '[]'::jsonb;
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

  -- The registry (MON-12): the company the quote binds to is what the award
  -- records; the company it answers for (its own link, else its
  -- contractor's company when flagged, else ANY do-not-use row its vendor
  -- name normalises to, else the bound company's own flag — the rail's own
  -- rule) needs the typed reason.
  v_company := cost_doc_company_behind(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name);
  v_barred := cost_doc_company_barred(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name);
  v_flagged := v_barred IS NOT NULL AND v_barred ->> 'status' IN ('do_not_use', 'inactive');
  IF v_flagged AND v_override IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'company_flagged', 'company', v_barred);
  END IF;
  -- J14 (MON-12, 20261179): the reason was typed for ONE company. When the
  -- caller names it, a link, contractor or vendor name that moved since it
  -- asked (the answer under this lock is another company) is refused, never
  -- recorded against the new company with a reason typed for the old.
  IF v_flagged AND p_override_company IS NOT NULL AND (v_barred ->> 'id') IS DISTINCT FROM p_override_company::text THEN
    RETURN jsonb_build_object('ok', false, 'code', 'company_moved', 'company', v_barred, 'expected', p_override_company);
  END IF;
  -- J14 (MON-12 / COST-3, 20261179): every OTHER flagged company the award
  -- answers for (cost_doc_companies_barred after its first — the stored
  -- vendor name's do-not-use look-alike behind a flagged contractor, the
  -- bound company's own flag behind a look-alike) needs its own typed
  -- reason, given by its id, and is recorded under its own override row.
  v_also := COALESCE(cost_doc_companies_barred(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name), '[]'::jsonb) - 0;
  FOR v_also_one IN SELECT e FROM jsonb_array_elements(v_also) e LOOP
    SELECT NULLIF(btrim(COALESCE(g ->> 'reason', '')), '') INTO v_also_reason
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_also_overrides) = 'array' THEN p_also_overrides ELSE '[]'::jsonb END) g
     WHERE g ->> 'companyId' = v_also_one ->> 'id' AND NULLIF(btrim(COALESCE(g ->> 'reason', '')), '') IS NOT NULL
     LIMIT 1;
    IF v_also_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'company_flagged', 'company', v_also_one, 'also', true);
    END IF;
    v_also_given := v_also_given || jsonb_build_array(v_also_one || jsonb_build_object('reason', v_also_reason));
  END LOOP;

  -- The read extent (COST-13 — lib/costDocs.ts extentRefusal): a figure the
  -- caller says was typed from the paper must be the total, in whole units;
  -- an AI-read total from a truncated read, or one of unknown extent once
  -- 20261096 records the extent, posts only with that figure. So the
  -- award's record never claims a confirmation that did not happen.
  IF p_confirmed_total IS NOT NULL AND round(p_confirmed_total) <> round(v_total) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'confirm_mismatch', 'total', v_total, 'confirmed', p_confirmed_total);
  END IF;
  IF p_confirmed_total IS NULL AND v_extracted IS NOT NULL AND (v_raw ? 'pages_read' OR v_raw ? 'pages_total') THEN
    v_pages_read := CASE WHEN jsonb_typeof(v_raw -> 'pages_read') = 'number' THEN (v_raw ->> 'pages_read')::numeric END;
    v_pages_total := CASE WHEN jsonb_typeof(v_raw -> 'pages_total') = 'number' THEN (v_raw ->> 'pages_total')::numeric END;
    IF v_pages_read IS NULL OR v_pages_total IS NULL OR v_pages_read < v_pages_total THEN
      RETURN jsonb_build_object('ok', false, 'code', 'extent', 'total', v_total, 'pagesRead', v_pages_read, 'pagesTotal', v_pages_total);
    END IF;
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

  -- 3. The override, on the record by the id of the company it overrode.
  IF v_flagged THEN
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
    VALUES ('COST_DOC_AWARD_OVERRIDE', 'cost', p_doc::text, v_doc.org_id, v_uid, v_email,
            jsonb_build_object('companyId', v_barred ->> 'id', 'companyName', v_barred ->> 'name',
                               'companyStatus', v_barred ->> 'status', 'reason', v_override));
  END IF;
  -- 3b. Each other company the award answered for, under its own override row (J14).
  FOR v_also_one IN SELECT e FROM jsonb_array_elements(v_also_given) e LOOP
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
    VALUES ('COST_DOC_AWARD_OVERRIDE', 'cost', p_doc::text, v_doc.org_id, v_uid, v_email,
            jsonb_build_object('companyId', v_also_one ->> 'id', 'companyName', v_also_one ->> 'name',
                               'companyStatus', v_also_one ->> 'status', 'reason', v_also_one ->> 'reason', 'also', true));
  END LOOP;

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
            'alsoOverridden', (SELECT COALESCE(jsonb_agg(e ->> 'id'), '[]'::jsonb) FROM jsonb_array_elements(v_also_given) e),
            'pagesRead', v_raw -> 'pages_read', 'pagesTotal', v_raw -> 'pages_total',
            'totalConfirmed', p_confirmed_total IS NOT NULL, 'oneTransaction', true));

  RETURN jsonb_build_object(
    'ok', true, 'entryId', v_entry, 'total', v_total,
    'rivals', cardinality(v_rival_ids), 'declined', v_declined, 'ungroupedOpen', v_ungrouped,
    'company', v_company, 'override', v_flagged, 'also', v_also_given);
END;
$$;

COMMENT ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric, uuid, jsonb) IS
  'GAP-406 (20261157; MON-12 / COST-3, 20261179): claim + commitment + override records + rival decline + COST_DOC_AWARDED in ONE transaction, under the caller''s own RLS and rails (SECURITY INVOKER). Re-checked under the lock first: status, budget line, currency, the total the caller checked, the registry gate (cost_doc_company_barred — and, when p_override_company is given, that it is still the company the reason was typed for), a typed reason for every other flagged company of cost_doc_companies_barred (p_also_overrides, each recorded under its own override row), and COST-13''s confirmed figure and read extent. A refusal before the claim returns {ok:false, code} and writes nothing; any failure after it raises and rolls the award back. NULL auth.uid() refused.';

REVOKE ALL ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric, uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric, uuid, jsonb) TO authenticated;

-- ── 3. MON-12: an open quote is not moved off a flagged company without a reason ──
-- No column list on the trigger: `company_id` is 20261096's, read through
-- to_jsonb so a database without it is not broken; every other update
-- leaves at the first test that finds none of the three changed.
CREATE OR REPLACE FUNCTION public.enforce_cost_document_company_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_company uuid := NULLIF(to_jsonb(OLD) ->> 'company_id', '')::uuid;
  v_new_company uuid := NULLIF(to_jsonb(NEW) ->> 'company_id', '')::uuid;
  v_before jsonb;
  v_after jsonb;
  v_left jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass: the AI read route, restores, the SQL editor
  IF OLD.kind IS DISTINCT FROM 'quote' OR OLD.status NOT IN ('draft', 'parsed') THEN RETURN NEW; END IF;   -- open quotes only
  IF NEW.party_id IS NOT DISTINCT FROM OLD.party_id
     AND NEW.vendor_name IS NOT DISTINCT FROM OLD.vendor_name
     AND v_new_company IS NOT DISTINCT FROM v_old_company THEN
    RETURN NEW;
  END IF;
  -- The company's or the contractor's own delete: its FK ON DELETE SET NULL, one trigger level down.
  IF pg_trigger_depth() > 1
     AND ((v_new_company IS NULL AND v_old_company IS NOT NULL) OR (NEW.party_id IS NULL AND OLD.party_id IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  -- relink_cost_document set this for this one document, after a typed reason.
  IF COALESCE(current_setting('app.cost_doc_relink_override', true), '') = NEW.id::text THEN RETURN NEW; END IF;
  v_before := cost_doc_companies_barred(OLD.org_id, v_old_company, OLD.party_id, OLD.vendor_name);
  IF jsonb_array_length(v_before) = 0 THEN RETURN NEW; END IF;
  v_after := cost_doc_companies_barred(NEW.org_id, v_new_company, NEW.party_id, NEW.vendor_name);
  SELECT e INTO v_left
    FROM jsonb_array_elements(v_before) e
   WHERE NOT v_after @> jsonb_build_array(jsonb_build_object('id', e -> 'id'))
   LIMIT 1;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION '% is flagged % in the company registry — moving this quote''s company link, contractor or vendor name away from it needs a typed reason, recorded on the audit trail (the company picker on the bid row asks for one); nothing was changed. (MON-12, 20261179)',
      v_left ->> 'name', CASE v_left ->> 'status' WHEN 'do_not_use' THEN 'DO NOT USE' ELSE 'inactive' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_cost_document_company_move() IS
  'MON-12 (20261179): a signed-in write to an open quote that moves its company link, contractor or vendor name so that a flagged company it answered for (cost_doc_companies_barred, read as the definer) no longer answers is refused, unless relink_cost_document set app.cost_doc_relink_override to the document id after a typed reason. The service role, a decided quote and the company''s or contractor''s own delete (FK SET NULL one level down) pass.';

REVOKE ALL ON FUNCTION public.enforce_cost_document_company_move() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_cost_document_company_move() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_cost_document_company_move() FROM authenticated;

DROP TRIGGER IF EXISTS trg_cost_documents_company_move ON cost_documents;
CREATE TRIGGER trg_cost_documents_company_move
  BEFORE UPDATE ON cost_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cost_document_company_move();

-- ── 4. the bid row's company picker, on the server (MON-12) ──────────────
CREATE OR REPLACE FUNCTION public.relink_cost_document(p_doc uuid, p_company uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := NULLIF(auth.jwt() ->> 'email', '');
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_doc record;
  v_raw jsonb;
  v_prev uuid;
  v_before jsonb;
  v_after jsonb;
  v_leaving jsonb;
  v_moved integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to link a bidder to a company; nothing was changed. (MON-12, 20261179)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The quote, locked for this move (RLS: only a caller who may update it finds it).
  SELECT * INTO v_doc FROM cost_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  v_raw := to_jsonb(v_doc);
  IF NOT (v_raw ? 'company_id') THEN RETURN jsonb_build_object('ok', false, 'code', 'no_column'); END IF;   -- 20261096 not applied
  IF v_doc.kind IS DISTINCT FROM 'quote' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_quote'); END IF;
  IF v_doc.status NOT IN ('draft', 'parsed') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'decided', 'status', v_doc.status);
  END IF;
  IF p_company IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p_company AND c.org_id = v_doc.org_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'company');
  END IF;
  v_prev := NULLIF(v_raw ->> 'company_id', '')::uuid;
  IF v_prev IS NOT DISTINCT FROM p_company THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'leaving', '[]'::jsonb);
  END IF;

  -- The flagged companies the move leaves behind (section 1's list, before
  -- minus after): each needs the typed reason.
  v_before := cost_doc_companies_barred(v_doc.org_id, v_prev, v_doc.party_id, v_doc.vendor_name);
  v_after := cost_doc_companies_barred(v_doc.org_id, p_company, v_doc.party_id, v_doc.vendor_name);
  SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) INTO v_leaving
    FROM jsonb_array_elements(v_before) e
   WHERE NOT v_after @> jsonb_build_array(jsonb_build_object('id', e -> 'id'));
  IF jsonb_array_length(v_leaving) > 0 AND v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'reason_required', 'leaving', v_leaving);
  END IF;

  -- The move: the rail (section 3) reads the override for this document only.
  PERFORM set_config('app.cost_doc_relink_override', p_doc::text, true);
  UPDATE cost_documents SET company_id = p_company
   WHERE id = p_doc AND status IN ('draft', 'parsed');
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  PERFORM set_config('app.cost_doc_relink_override', '', true);
  IF v_moved = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'refused'); END IF;

  -- Its record, in the same transaction (the picker's own action and shape).
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
  VALUES ('COST_DOC_COMPANY_LINKED', 'cost', p_doc::text, v_doc.org_id, v_uid, v_email,
          jsonb_build_object('companyId', p_company, 'previousCompanyId', v_prev, 'vendor', v_doc.vendor_name, 'viaRpc', true)
          || CASE WHEN jsonb_array_length(v_leaving) > 0 THEN jsonb_build_object(
               'overrideDoNotUse', jsonb_build_object('companyId', v_leaving -> 0 ->> 'id', 'company', v_leaving -> 0 ->> 'name',
                                                      'companyStatus', v_leaving -> 0 ->> 'status', 'reason', v_reason),
               'leaving', v_leaving, 'reason', v_reason)
             ELSE '{}'::jsonb END);

  RETURN jsonb_build_object('ok', true, 'leaving', v_leaving);
END;
$$;

COMMENT ON FUNCTION public.relink_cost_document(uuid, uuid, text) IS
  'MON-12 (20261179): the bid row''s company picker on the server — locks an open quote, refuses a company of another org, answers reason_required (writing nothing) when the move leaves a flagged company (cost_doc_companies_barred before minus after) and no reason was typed, else moves company_id under app.cost_doc_relink_override and writes COST_DOC_COMPANY_LINKED in the same transaction. SECURITY INVOKER; NULL auth.uid() refused.';

REVOKE ALL ON FUNCTION public.relink_cost_document(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.relink_cost_document(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.relink_cost_document(uuid, uuid, text) TO authenticated;

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_proc.prosrc is verbatim.
SELECT 'MON-12 / COST-3: cost_doc_companies_barred is SECURITY INVOKER with search_path pinned, puts cost_doc_company_barred''s answer first, lets the document''s own link decide alone, then adds the stored name''s do-not-use look-alike and the bound company''s flag once each; not executable by anon' AS check,
       (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%v_first := cost_doc_company_barred(p_org, p_company, p_party, p_vendor);%'
               AND prosrc LIKE '%IF p_company IS NOT NULL AND EXISTS (SELECT 1 FROM companies c WHERE c.id = p_company AND c.org_id = p_org) THEN%'
               AND prosrc LIKE '%ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, c.id%'
               AND prosrc LIKE '%v_bound := cost_doc_company_behind(p_org, NULL, p_party, p_vendor);%'
          FROM pg_proc WHERE proname = 'cost_doc_companies_barred' AND pronargs = 4)
       AND NOT has_function_privilege('anon', 'public.cost_doc_companies_barred(uuid,uuid,uuid,text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.cost_doc_companies_barred(uuid,uuid,uuid,text)', 'EXECUTE') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'MON-12 / COST-3: a quote of no org and no name answers for nobody (an empty list, never NULL)',
       cost_doc_companies_barred('00000000-0000-0000-0000-000000000000', NULL, NULL, NULL) = '[]'::jsonb
       AND cost_doc_companies_barred('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', NULL, 'x') = '[]'::jsonb,
       NULL::text
UNION ALL
SELECT 'GAP-406 / MON-12: award_quote has ONE signature (seven arguments, the two new ones DEFAULT NULL) — SECURITY INVOKER, search_path pinned, NULL auth.uid() refused; refuses a moved answer and a missing reason for any other flagged company before the claim, and records each under its own override row',
       (SELECT COUNT(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'award_quote')
       AND (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%' AND pronargdefaults = 4
                   AND prosrc LIKE '%IF v_uid IS NULL THEN%' AND prosrc LIKE '%FOR UPDATE;%'
                   AND prosrc LIKE '%v_barred := cost_doc_company_barred(%'
                   AND prosrc LIKE '%''code'', ''company_moved''%'
                   AND prosrc LIKE '%v_also := COALESCE(cost_doc_companies_barred(%'
                   AND prosrc LIKE '%''company_flagged'', ''company'', v_also_one, ''also'', true%'
                   AND strpos(prosrc, '''company_moved''') < strpos(prosrc, 'SET status = ''awarded''')
                   AND strpos(prosrc, '''also'', true);') < strpos(prosrc, 'SET status = ''awarded''')
                   AND prosrc LIKE '%''COST_DOC_AWARD_OVERRIDE''%''also'', true));%'
                   AND prosrc LIKE '%''alsoOverridden''%'
                   AND prosrc LIKE '%INSERT INTO cost_entries%' AND prosrc LIKE '%SET status = ''declined''%'
                   AND prosrc LIKE '%''COST_DOC_AWARDED''%'
              FROM pg_proc WHERE proname = 'award_quote' AND pronargs = 7),
       NULL::text
UNION ALL
SELECT 'GAP-406: anon cannot execute award_quote; authenticated can (DRLS-16)',
       NOT has_function_privilege('anon', 'public.award_quote(uuid,uuid,numeric,text,numeric,uuid,jsonb)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.award_quote(uuid,uuid,numeric,text,numeric,uuid,jsonb)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'MON-12: the move rail is a SECURITY DEFINER trigger function with search_path pinned, revoked from anon and authenticated; it judges open quotes by cost_doc_companies_barred before and after, reads the relink override for the one document, and lets the service role and an FK SET NULL one level down through',
       (SELECT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
               AND prosrc LIKE '%OLD.status NOT IN (''draft'', ''parsed'')%'
               AND prosrc LIKE '%app.cost_doc_relink_override%'
               AND prosrc LIKE '%v_before := cost_doc_companies_barred(OLD.org_id, v_old_company, OLD.party_id, OLD.vendor_name);%'
               AND prosrc LIKE '%v_after := cost_doc_companies_barred(NEW.org_id, v_new_company, NEW.party_id, NEW.vendor_name);%'
               AND prosrc LIKE '%pg_trigger_depth() > 1%'
          FROM pg_proc WHERE proname = 'enforce_cost_document_company_move' AND pronargs = 0)
       AND NOT has_function_privilege('anon', 'public.enforce_cost_document_company_move()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.enforce_cost_document_company_move()', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'MON-12: trg_cost_documents_company_move fires BEFORE UPDATE on cost_documents, for each row',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.cost_documents'::regclass AND t.tgname = 'trg_cost_documents_company_move'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE ON public.cost_documents FOR EACH ROW%'),
       NULL::text
UNION ALL
SELECT 'MON-12: relink_cost_document is SECURITY INVOKER with search_path pinned, refuses a NULL auth.uid(), locks the quote, answers reason_required before it moves anything, moves under the relink override and records COST_DOC_COMPANY_LINKED in the same body; anon cannot execute it, authenticated can',
       (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%IF v_uid IS NULL THEN%' AND prosrc LIKE '%FOR UPDATE;%'
               AND prosrc LIKE '%''code'', ''reason_required''%'
               AND strpos(prosrc, '''reason_required''') < strpos(prosrc, 'UPDATE cost_documents SET company_id')
               AND prosrc LIKE '%PERFORM set_config(''app.cost_doc_relink_override'', p_doc::text, true);%'
               AND prosrc LIKE '%''COST_DOC_COMPANY_LINKED''%'
          FROM pg_proc WHERE proname = 'relink_cost_document' AND pronargs = 3)
       AND NOT has_function_privilege('anon', 'public.relink_cost_document(uuid,uuid,text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.relink_cost_document(uuid,uuid,text)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'MON-12: 20261157''s award rail and the one-company gate are untouched (cost_doc_company_barred still answers one company; the rail still judges it)',
       (SELECT prosrc LIKE '%v_company := cost_doc_company_barred(NEW.org_id,%'
          FROM pg_proc WHERE proname = 'enforce_cost_document_award_registry' AND pronargs = 0)
       AND (SELECT prorettype = 'jsonb'::regtype FROM pg_proc WHERE proname = 'cost_doc_company_barred' AND pronargs = 4),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j14_inventory;
