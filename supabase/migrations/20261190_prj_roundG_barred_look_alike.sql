-- 20261190_prj_roundG_barred_look_alike.sql
--
-- projects Round G — J17 BARRED LOOK-ALIKE. projects-and-cost COST-3
-- residual 2, the Apex ruling (DEC-90 A21, ratified by the integrator under
-- the user's delegation, 2026-10-07): a do-not-use registry row whose
-- normalised name LEADS the bid's vendor name ("Apex Industrial" against
-- "Apex Industrial Services, LLC") flags the bid at the do-not-use GATE —
-- the award answers for it, with a typed reason — and NEVER binds it. The
-- numbers below are the body's section numbers (the `-- ── n.` headings),
-- which the records cite.
--
-- WHAT:
--   1. `cost_doc_company_barred` re-created from its NEWEST definition
--      (20261157 section 1; the shape test finds it by scanning the
--      sequence) with ONE change: the stored vendor name's do-not-use
--      look-alike is any do_not_use row of the org whose name key
--      (`company_name_key`, unchanged) EQUALS the vendor name's key — as
--      before — or LEADS it: whole words, in order (`n.k = v_key OR
--      starts_with(v_key, n.k || ' ')`; "apex industrial" leads "apex
--      industrial services"; "apex ind" does not lead "apex industrial",
--      a later word or a longer registry name never leads). Of several,
--      the exact name first (as before), then the LONGEST key — an equal
--      key before any leading one, so every bid that answered for a
--      look-alike before this file names the same company after it — then
--      the id (as before). Nothing else in the body changes: the
--      document's own link decides, a flagged contractor answers first, the
--      bound company's own flag comes last.
--   2. `cost_doc_companies_barred` re-created from its NEWEST definition
--      (20261179 section 1) with the same one change to its look-alike
--      query, so the list keeps naming the row its first answer names.
--   NOT re-created (each calls these two by name, so each reads the new
--   rule from the paste on — plpgsql resolves a call when it runs):
--   `company_name_key` (the key; unchanged), `cost_doc_company_behind`
--   (the BINDING — the links, then ONE exact name; a leading name never
--   binds, and COST_DOC_AWARDED's companyId is unchanged), 20261157's award
--   rail and 20261179's `award_quote`, move rail and `relink_cost_document`.
--   The app's twins (the same rule, the same order): lib/bidTab.ts
--   `companyKeyLeads` / `companyCandidatesByName` / `barredCompanyFor`
--   (the bid tab's chip, its prompts and the contractor link's check) and
--   lib/costDocs.ts `flaggedLookAlike` (`awardQuote`'s gate); the binding's
--   `matchCompanyByName` / `companiesNamedAlike` stay exact.
--   A ONE-word registry name ("Apex") leads every vendor name that begins
--   with that word — broad, and accepted by the ruling because the answer
--   is a typed reason, never a refusal without one: `award_quote` awards
--   with the reason (its override row names the company), and
--   `relink_cost_document` moves the bid's link off it with a reason. As
--   for every flagged company since 20261179, a signed-in move of the
--   bid's contractor or vendor name away from it is refused outright: the
--   way through is to link the bid to its real company first (the bid
--   row's picker, with its reason).
--
-- NOT a widening: both functions answer for MORE companies; nothing is
-- granted, and every refusal they feed already has its typed-reason path.
-- The DEC-30 inventory (aggregate counts only, never rows) is captured
-- BEFORE the transaction and returned with the probes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (idempotent). The final SELECT is the only result set shown — probe
-- rows must read ok = true; inventory rows carry ok NULL and a count in n.
--
-- PASTE ORDER: after 20261157 AND 20261179 (the guard below refuses
-- otherwise — section 1 re-creates 20261157's function and section 2
-- 20261179's). Both are unpasted today (20261157 is HOLD), so this file
-- pastes after 20261179, in the same window. Deploy order: the app carrying
-- J17 first is recommended; either order works, because this file adds no
-- function and changes no signature (no new 42883 / PGRST202 path):
--   * the J17 app before this paste (20261157 and 20261179 applied): the
--     lib and the bid tab read leading names, the database does not yet —
--     the lib refuses the award without a reason (needsOverride), the bid
--     tab asks for it after the click and records its intent row before
--     money moves, and award_quote then awards with the reason but records
--     no COST_DOC_AWARD_OVERRIDE for a company it does not see. Paste
--     promptly.
--   * this paste before the J17 app (the J14 app live): the database names
--     the leading-name look-alike; the J14 bid tab asks the database's list
--     (cost_doc_companies_barred) for its reasons and award_quote records
--     them; the J14 picker moves a link through relink_cost_document, which
--     asks for the reason.
--   * before 20261157 (today): the J17 app's client sequence and its
--     fallbacks read the leading names on their own.

DO $$
BEGIN
  IF to_regprocedure('public.cost_doc_company_barred(uuid,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.cost_doc_company_behind(uuid,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.company_name_key(text)') IS NULL
     OR to_regprocedure('public.cost_doc_companies_barred(uuid,uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261157_prj_roundG_server_remainders.sql and then 20261179_prj_roundG_award_answers_for_each.sql first — this file re-creates their gate functions. Nothing was changed.';
  END IF;
END $$;

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
-- Set-based, read ONCE each: every do-not-use registry row's name key per
-- org (20261157's company_name_key — the guard above found it), indexed;
-- each quote's name key split once into its proper leading words ("apex
-- industrial services" → "apex", "apex industrial"), each looked up in the
-- keys by equality, the longest first, then the lowest id — section 1's
-- order (a longer leading key is a longer string). A quote is counted when
-- its award answers for one more company from this paste on: no link to a
-- company of its own org stands (a person's link decides alone), no
-- do-not-use key EQUALS its key (that look-alike it answered for already),
-- a do-not-use key LEADS it, and that row is not the contractor's flagged
-- company (which it answered for already). Counts only, never rows.
DROP TABLE IF EXISTS pg_temp.prj_g_j17_dnu;
CREATE TEMP TABLE prj_g_j17_dnu AS
  SELECT c.org_id, c.id, company_name_key(c.name) AS k
    FROM companies c
   WHERE c.status = 'do_not_use';
CREATE INDEX ON prj_g_j17_dnu (org_id, k);
ANALYZE prj_g_j17_dnu;

DROP TABLE IF EXISTS pg_temp.prj_g_j17_inventory;
CREATE TEMP TABLE prj_g_j17_inventory AS
WITH
prj_g_j17_quotes AS MATERIALIZED (
  SELECT d.id, d.org_id, d.status, company_name_key(d.vendor_name) AS k, pc.id AS contractor_flagged
    FROM cost_documents d
    LEFT JOIN project_parties pp ON pp.id = d.party_id
    LEFT JOIN companies pc ON pc.id = pp.company_id AND pc.org_id = d.org_id AND pc.status IN ('do_not_use', 'inactive')
   WHERE d.kind = 'quote'
     AND NOT EXISTS (SELECT 1 FROM companies lc
                      WHERE lc.id = NULLIF(to_jsonb(d) ->> 'company_id', '')::uuid AND lc.org_id = d.org_id)
),
prj_g_j17_leads AS MATERIALIZED (
  -- each quote's proper leading words, computed once per quote, BEFORE the
  -- lookup (so the lookup is one equality join on (org, key), never a
  -- product of quotes and registry rows)
  SELECT q.id, q.org_id, q.status, q.contractor_flagged, w.n AS words,
         array_to_string((string_to_array(q.k, ' '))[1:w.n], ' ') AS lead
    FROM prj_g_j17_quotes q
    CROSS JOIN LATERAL generate_series(1, cardinality(string_to_array(q.k, ' ')) - 1) AS w(n)
   WHERE q.k <> ''
     AND NOT EXISTS (SELECT 1 FROM prj_g_j17_dnu e WHERE e.org_id = q.org_id AND e.k = q.k)
),
prj_g_j17_leading AS MATERIALIZED (
  SELECT DISTINCT ON (l.id) l.id, l.status, l.contractor_flagged, f.id AS look_id, l.words
    FROM prj_g_j17_leads l
    JOIN prj_g_j17_dnu f ON f.org_id = l.org_id AND f.k = l.lead
   ORDER BY l.id, l.words DESC, f.id
),
prj_g_j17_changed AS MATERIALIZED (
  SELECT l.status, l.words FROM prj_g_j17_leading l WHERE l.look_id IS DISTINCT FROM l.contractor_flagged
)
SELECT 'inventory (COST-3 / DEC-90 A21): open quotes (draft / parsed) whose award now answers for one more company — a do-not-use registry row whose name LEADS their vendor name (no person''s link of their org, no do-not-use row of their own name key, not their contractor''s flagged company): an award needs a typed reason for it, recorded under its own override row; moving their company link away from it needs a typed reason through the bid row''s picker; their contractor or vendor name cannot be moved away from it' AS inventory, COUNT(*)::text AS n
  FROM prj_g_j17_changed WHERE status IN ('draft', 'parsed')
UNION ALL
SELECT 'inventory (COST-3 / DEC-90 A21): of those open quotes, the ones whose leading do-not-use name is ONE word (the broad flag — a typed reason each)', COUNT(*)::text
  FROM prj_g_j17_changed WHERE status IN ('draft', 'parsed') AND words = 1
UNION ALL
SELECT 'inventory (COST-3 / DEC-90 A21): decided quotes (awarded / declined / void) that now answer the same way (kept as they are — nothing is reopened; their company link, contractor or vendor name cannot be moved away from it, 20261179 section 3)', COUNT(*)::text
  FROM prj_g_j17_changed WHERE status NOT IN ('draft', 'parsed')
UNION ALL
SELECT 'inventory (COST-3 / DEC-90 A21): do-not-use registry rows whose name key is ONE word (each now flags every bid whose vendor name begins with that word)', COUNT(*)::text
  FROM prj_g_j17_dnu WHERE k <> '' AND strpos(k, ' ') = 0;

BEGIN;

-- ── 1. the company an award must ANSWER FOR (MON-12 / COST-3) ────────────
-- 20261157 section 1's body, with the look-alike query reading a LEADING
-- name too (COST-3 residual 2; DEC-90 A21): the document's own link (a
-- person's choice on the bid row) decides, flagged or not; its contractor's
-- link answers for that company's own flag, and an unflagged one never
-- hides a do-not-use look-alike; each link only to a company of the
-- document's org. Then ANY do_not_use row of the org whose name key equals
-- the vendor name's or leads it (whole words — lib/bidTab.ts
-- companyKeyLeads; DEC-48's gate flags do-not-use look-alikes only): the
-- exact name first, so the refusal names the company the quote binds to
-- when that one is barred; then the longest key, so an equal key comes
-- before a leading one and the closest leading name before a shorter one;
-- then by id — the order of lib/costDocs.ts flaggedLookAlike and
-- lib/bidTab.ts barredCompanyFor, so the lib's prompt and the override row
-- name the same company; the bid tab's award prompt and intent row call
-- this function itself (components/projects/cost/QuotesPanel.tsx
-- companyAwardAnswersFor). Else the company it binds to
-- (cost_doc_company_behind: its contractor's link, else one exact name),
-- when that one is itself flagged — a leading name never binds. Returns the
-- flagged company, or NULL when the award needs no override. SECURITY
-- INVOKER: called by award_quote it reads what the caller may read; called
-- by the rails (definers) it reads as the owner.
CREATE OR REPLACE FUNCTION public.cost_doc_company_barred(p_org uuid, p_company uuid, p_party uuid, p_vendor text)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_party_company uuid;
  v_key text;
BEGIN
  IF p_company IS NOT NULL THEN
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
      FROM companies c WHERE c.id = p_company AND c.org_id = p_org;
    IF v_row IS NOT NULL THEN
      RETURN CASE WHEN v_row ->> 'status' IN ('do_not_use', 'inactive') THEN v_row END;
    END IF;
  END IF;
  IF p_party IS NOT NULL THEN
    SELECT pp.company_id INTO v_party_company FROM project_parties pp WHERE pp.id = p_party;
    IF v_party_company IS NOT NULL THEN
      SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
        FROM companies c WHERE c.id = v_party_company AND c.org_id = p_org;
      -- A flagged contractor company answers; an unflagged one falls through.
      IF v_row ->> 'status' IN ('do_not_use', 'inactive') THEN RETURN v_row; END IF;
    END IF;
  END IF;
  v_key := company_name_key(p_vendor);
  IF v_key <> '' THEN
    -- A do-not-use row whose name key equals the vendor name's, or LEADS it
    -- (whole words — COST-3 residual 2, DEC-90 A21; 20261190).
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row
      FROM companies c
      CROSS JOIN LATERAL (SELECT company_name_key(c.name) AS k) n
     WHERE c.org_id = p_org AND c.status = 'do_not_use'
       AND n.k <> '' AND (n.k = v_key OR starts_with(v_key, n.k || ' '))
     ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, length(n.k) DESC, c.id
     LIMIT 1;
    IF v_row IS NOT NULL THEN RETURN v_row; END IF;
  END IF;
  -- No do-not-use look-alike: the company the quote binds to (its
  -- contractor's link, else one exact name) answers for its own flag.
  v_row := cost_doc_company_behind(p_org, NULL, p_party, p_vendor);
  RETURN CASE WHEN v_row ->> 'status' IN ('do_not_use', 'inactive') THEN v_row END;
END;
$$;

COMMENT ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) IS
  'MON-12 (20261157; COST-3 / DEC-90 A21, 20261190): the do-not-use / inactive company a cost document''s award must answer for — its own registry link (decides, flagged or not), else its contractor''s when that company is flagged (an unflagged one never hides a look-alike), else ANY do_not_use registry row of the org whose name key equals or LEADS its vendor name''s (company_name_key, whole words; DEC-48; exact name first, then the longest key, then id), else the company it binds to (the contractor''s link, else one exact name) when that one is flagged; NULL when no override is needed. A leading name never binds. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) TO authenticated, service_role;

-- ── 2. every flagged company an award answers for (MON-12 / COST-3) ──────
-- 20261179 section 1's body, with the same look-alike query as section 1
-- above, so its list keeps naming the row the first answer names:
-- cost_doc_company_barred's single answer FIRST, then — unless the
-- document's own link to a company of its org decides alone — the stored
-- vendor name's do-not-use look-alike (equal or leading key; the exact
-- name, then the longest key, then id) and the company the quote binds to
-- (cost_doc_company_behind without the link) when flagged, each once.
-- lib/costDocs.ts companyBehind's `barred` + `also` is the same list. An
-- empty array: no override needed. SECURITY INVOKER, as section 1.
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
  -- cost_doc_company_barred's own order (the exact name, then the longest
  -- key, then id); a name key that LEADS the vendor's counts (whole words —
  -- COST-3 residual 2, DEC-90 A21; 20261190).
  v_key := company_name_key(p_vendor);
  IF v_key <> '' THEN
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_look
      FROM companies c
      CROSS JOIN LATERAL (SELECT company_name_key(c.name) AS k) n
     WHERE c.org_id = p_org AND c.status = 'do_not_use'
       AND n.k <> '' AND (n.k = v_key OR starts_with(v_key, n.k || ' '))
     ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, length(n.k) DESC, c.id
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
  'MON-12 / COST-3 (20261179; DEC-90 A21, 20261190): every flagged company a cost document''s award answers for, as a JSON array — cost_doc_company_barred''s answer first, then (unless the document''s own link to a company of its org decides alone) the stored vendor name''s do-not-use look-alike (a name key equal to or LEADING the vendor name''s) and the bound company when flagged, each once (lib/costDocs.ts companyBehind barred + also). Empty: no override needed. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_proc.prosrc is verbatim.
SELECT 'COST-3 (DEC-90 A21): cost_doc_company_barred answers for a do-not-use row whose name key equals or LEADS the vendor name''s (whole words), the exact name first, then the longest key, then id, before the bound company''s own flag; SECURITY INVOKER with search_path pinned; anon cannot execute it, authenticated can' AS check,
       (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%CROSS JOIN LATERAL (SELECT company_name_key(c.name) AS k) n%'
               AND prosrc LIKE '%AND n.k <> '''' AND (n.k = v_key OR starts_with(v_key, n.k || '' ''))%'
               AND prosrc LIKE '%ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, length(n.k) DESC, c.id%'
               AND prosrc NOT LIKE '%AND company_name_key(c.name) = v_key%'
               AND strpos(prosrc, 'starts_with(v_key') < strpos(prosrc, 'v_row := cost_doc_company_behind(p_org, NULL, p_party, p_vendor);')
          FROM pg_proc WHERE proname = 'cost_doc_company_barred' AND pronargs = 4)
       AND NOT has_function_privilege('anon', 'public.cost_doc_company_barred(uuid,uuid,uuid,text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.cost_doc_company_barred(uuid,uuid,uuid,text)', 'EXECUTE') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'COST-3 (DEC-90 A21): cost_doc_companies_barred puts cost_doc_company_barred''s answer first, lets the document''s own link decide alone, then adds the stored name''s do-not-use look-alike by the same leading-name query and the bound company''s flag, each once; SECURITY INVOKER with search_path pinned; anon cannot execute it, authenticated can',
       (SELECT NOT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%v_first := cost_doc_company_barred(p_org, p_company, p_party, p_vendor);%'
               AND prosrc LIKE '%IF p_company IS NOT NULL AND EXISTS (SELECT 1 FROM companies c WHERE c.id = p_company AND c.org_id = p_org) THEN%'
               AND prosrc LIKE '%CROSS JOIN LATERAL (SELECT company_name_key(c.name) AS k) n%'
               AND prosrc LIKE '%AND n.k <> '''' AND (n.k = v_key OR starts_with(v_key, n.k || '' ''))%'
               AND prosrc LIKE '%ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, length(n.k) DESC, c.id%'
               AND prosrc NOT LIKE '%AND company_name_key(c.name) = v_key%'
               AND prosrc LIKE '%v_bound := cost_doc_company_behind(p_org, NULL, p_party, p_vendor);%'
          FROM pg_proc WHERE proname = 'cost_doc_companies_barred' AND pronargs = 4)
       AND NOT has_function_privilege('anon', 'public.cost_doc_companies_barred(uuid,uuid,uuid,text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.cost_doc_companies_barred(uuid,uuid,uuid,text)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'COST-3 (DEC-90 A21): the leading-name test the two functions run, on company_name_key''s keys, gives lib/bidTab.ts companyKeyLeads''s answers — whole words, one direction, an empty key leads nothing — and the key itself is unchanged',
       (SELECT bool_and((company_name_key(t.r) <> '' AND (company_name_key(t.r) = company_name_key(t.v) OR starts_with(company_name_key(t.v), company_name_key(t.r) || ' '))) = t.want)
          FROM (VALUES ('Apex Industrial', 'Apex Industrial Services, LLC', true),
                       ('Apex Industrial, Inc.', 'The Apex Industrial Services Co.', true),
                       ('Apex Industrial', 'Apex Industrial Inc', true),
                       ('Apex, LLC', 'Apex Plumbing', true),
                       ('Apex Ind', 'Apex Industrial', false),
                       ('Ace', 'Acme Corp', false),
                       ('Industrial Services', 'Apex Industrial Services', false),
                       ('Apex Industrial Services Group', 'Apex Industrial Services', false),
                       ('---', 'Apex', false)) AS t(r, v, want))
       AND company_name_key('Apex Industrial Services, LLC') = 'apex industrial services'
       AND company_name_key('Apex Industrial') = 'apex industrial',
       NULL::text
UNION ALL
SELECT 'COST-3 (DEC-90 A21): a quote of no org answers for nobody, whatever its name (both functions run after the re-create)',
       cost_doc_company_barred('00000000-0000-0000-0000-000000000000', NULL, NULL, 'Apex Industrial Services, LLC') IS NULL
       AND cost_doc_companies_barred('00000000-0000-0000-0000-000000000000', NULL, NULL, 'Apex Industrial Services, LLC') = '[]'::jsonb
       AND cost_doc_companies_barred('00000000-0000-0000-0000-000000000000', NULL, NULL, NULL) = '[]'::jsonb,
       NULL::text
UNION ALL
SELECT 'COST-3 (DEC-90 A21): the BINDING is untouched — cost_doc_company_behind still binds the links, then ONE exact case-insensitive name, never a leading name',
       (SELECT prosrc LIKE '%lower(c.name) = lower(btrim(p_vendor))%'
               AND prosrc LIKE '%IF v_n <> 1 THEN RETURN NULL; END IF;%'
               AND prosrc NOT LIKE '%starts_with%'
               AND prosrc NOT LIKE '%company_name_key%'
          FROM pg_proc WHERE proname = 'cost_doc_company_behind' AND pronargs = 4),
       NULL::text
UNION ALL
SELECT 'COST-3 (DEC-90 A21): the award rail, award_quote, the move rail and relink_cost_document still call the two gate functions by name (not re-created here; they read the leading-name rule from this paste on)',
       (SELECT prosrc LIKE '%v_company := cost_doc_company_barred(NEW.org_id,%'
          FROM pg_proc WHERE proname = 'enforce_cost_document_award_registry' AND pronargs = 0)
       AND (SELECT prosrc LIKE '%v_barred := cost_doc_company_barred(%' AND prosrc LIKE '%v_also := COALESCE(cost_doc_companies_barred(%'
              FROM pg_proc WHERE proname = 'award_quote' AND pronargs = 7)
       AND (SELECT prosrc LIKE '%v_before := cost_doc_companies_barred(OLD.org_id%' AND prosrc LIKE '%v_after := cost_doc_companies_barred(NEW.org_id%'
              FROM pg_proc WHERE proname = 'enforce_cost_document_company_move' AND pronargs = 0)
       AND (SELECT prosrc LIKE '%cost_doc_companies_barred(v_doc.org_id, v_prev,%' AND prosrc LIKE '%cost_doc_companies_barred(v_doc.org_id, p_company,%'
              FROM pg_proc WHERE proname = 'relink_cost_document' AND pronargs = 3),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j17_inventory;
