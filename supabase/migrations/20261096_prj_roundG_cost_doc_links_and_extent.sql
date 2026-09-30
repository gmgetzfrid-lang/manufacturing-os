-- 20261096_prj_roundG_cost_doc_links_and_extent.sql
--
-- projects Round G — J4 BID-TAB-AND-REGISTRY (projects-and-cost COST-13,
-- COST-3, COST-12; projects-tab BID-12 and the MON-7 dw4 backfill).
--
-- WHAT:
--   1. cost_documents.pages_total / pages_read — how much of a quote or
--      invoice the model actually saw (COST-13). Written by
--      app/api/projects/cost-docs from now on; every EXISTING row stays
--      NULL, which the review screen renders as "read extent unknown" —
--      never as "complete".
--   2. cost_documents.company_id — the EXPLICIT Known Companies link a
--      human sets on the bid row (BID-12 / COST-3): the do-not-use flag
--      renders from this, not from re-deriving a name match on every
--      render. party_id stays as it is.
--   3. companies.quality_manual_pages_read / _total — the read extent
--      behind a confirmed quality-manual score (COST-3 dw3). Existing
--      scores stay NULL = unknown.
--   4. One-off backfill of project_parties.company_id (COST-12 / MON-7
--      dw4): a party with no link whose NORMALISED name (case, punctuation,
--      whitespace, trailing legal suffix — the same rule as
--      lib/bidTab.normalizeCompanyName) matches EXACTLY ONE company in
--      its org is linked. Ambiguous names (two companies normalise alike)
--      are left alone. EVERY decision is recorded first, one audit_logs
--      row per party (action PROJECT_PARTY_COMPANY_BACKFILLED, outcome
--      'linked' with the company chosen, or 'ambiguous'), and the UPDATE
--      is driven from exactly those rows — so the matches can be listed
--      (the review query at the foot of this file) and undone (the revert
--      statement there). The result set below carries counts only; the
--      party and company names stay in the database.
--
-- NOT widening: no policy, grant or function changes. DEC-30 inventories
-- (aggregate counts only, captured BEFORE the transaction) are returned
-- with the verification probes:
--   * cost_documents whose currency is not a known ISO-4217 code (COST-8
--     route limb: the parse route now stores NULL for anything else);
--   * project_parties with company_id and NULL contract_value, and vice
--     versa (COST-12's mutually-exclusive writers);
--   * cost_documents that will carry pages_total NULL after apply (every
--     row that exists today — 'read extent unknown');
--   * quote links with no expiry (INTK-12): the app now requires one on
--     creation. Existing links are NOT backfilled here — the default
--     (created_at + 90 days) is BLOCKED until the 'active in the last 30
--     days' count below is 0; the UPDATE to run then is at the foot of
--     this file, commented out.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run
-- it once (a second run is safe: the temp tables are dropped first, and a
-- party this backfill already decided is never touched again). The final
-- SELECT is the only result set shown — probe rows must read ok = true;
-- inventory rows carry ok NULL and a count in n. Then paste the review
-- query at the foot to see which party was linked to which company.

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
DROP TABLE IF EXISTS pg_temp.prj_g_inventory;
CREATE TEMP TABLE prj_g_inventory AS
SELECT 'inventory: cost_documents with a non-ISO-4217 currency (route now stores NULL for these)' AS inventory,
       COUNT(*)::text AS n
  FROM cost_documents
 WHERE currency IS NOT NULL
   AND upper(trim(currency)) NOT IN (
    'AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BGN','BHD','BIF','BMD','BND','BOB','BRL','BSD','BTN','BWP','BYN','BZD',
    'CAD','CDF','CHF','CLP','CNY','COP','CRC','CUP','CVE','CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP','GBP','GEL','GHS','GIP','GMD',
    'GNF','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR','KMF','KPW','KRW','KWD','KYD','KZT',
    'LAK','LBP','LKR','LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR',
    'NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD','SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD','SSP',
    'STN','SVC','SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX','USD','UYU','UZS','VES','VND','VUV','WST','XAF','XCD','XOF',
    'XPF','YER','ZAR','ZMW','ZWG','ZWL')
UNION ALL
SELECT 'inventory: project_parties with company_id but NULL contract_value', COUNT(*)::text
  FROM project_parties WHERE company_id IS NOT NULL AND contract_value IS NULL
UNION ALL
SELECT 'inventory: project_parties with contract_value but NULL company_id', COUNT(*)::text
  FROM project_parties WHERE contract_value IS NOT NULL AND company_id IS NULL
UNION ALL
SELECT 'inventory: cost_documents rows that will read "extent unknown" (pages_total NULL) after apply', COUNT(*)::text
  FROM cost_documents
UNION ALL
SELECT 'inventory: quote links with no expiry (not revoked)', COUNT(*)::text
  FROM project_intake_links WHERE purpose = 'quote' AND expires_at IS NULL AND revoked_at IS NULL
UNION ALL
SELECT 'inventory: quote links with no expiry used in the last 30 days (must be 0 before the commented backfill runs)', COUNT(*)::text
  FROM project_intake_links
 WHERE purpose = 'quote' AND expires_at IS NULL AND revoked_at IS NULL
   AND last_used_at IS NOT NULL AND last_used_at > NOW() - INTERVAL '30 days';

-- Normalised-name matches for the party backfill (same rule as
-- lib/bidTab.normalizeCompanyName): unique matches are linked, ambiguous
-- ones are counted and left alone. Punctuation becomes a space and the
-- string is collapsed and TRIMMED before the legal-suffix strip, so
-- "Gulf Mechanical, Inc." and "Apex Co." lose their suffix exactly as the
-- TypeScript rule drops them (pinned by a port of this expression in
-- lib/__tests__/prjRoundGMigrations.test.ts).
DROP TABLE IF EXISTS pg_temp.prj_g_party_match;
CREATE TEMP TABLE prj_g_party_match AS
WITH norm AS (
  SELECT id, org_id, project_id,
         trim(regexp_replace(regexp_replace(
           trim(regexp_replace(regexp_replace(lower(replace(name, '&', ' and ')), '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g')),
           '(\s+(inc|incorporated|llc|ltd|limited|co|corp|corporation|company|gmbh|plc|lp|llp|pty|sa|ag|bv|nv|srl|sarl|pte|pllc|pc))+$', ''),
           '^the\s+', '')) AS key
    FROM project_parties
   WHERE company_id IS NULL
), cnorm AS (
  SELECT id, org_id,
         trim(regexp_replace(regexp_replace(
           trim(regexp_replace(regexp_replace(lower(replace(name, '&', ' and ')), '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g')),
           '(\s+(inc|incorporated|llc|ltd|limited|co|corp|corporation|company|gmbh|plc|lp|llp|pty|sa|ag|bv|nv|srl|sarl|pte|pllc|pc))+$', ''),
           '^the\s+', '')) AS key
    FROM companies
)
SELECT n.id AS party_id, n.org_id, n.project_id, n.key,
       MIN(c.id::text)::uuid AS company_id,
       COUNT(c.id) AS matches,
       -- Decided by an earlier run of this backfill (linked, left alone,
       -- or linked and since reverted): never touched again.
       EXISTS (SELECT 1 FROM audit_logs a
                WHERE a.action = 'PROJECT_PARTY_COMPANY_BACKFILLED' AND a.resource_id = n.id::text) AS decided_before
  FROM norm n
  JOIN cnorm c ON c.org_id = n.org_id AND c.key = n.key AND c.key <> ''
 GROUP BY n.id, n.org_id, n.project_id, n.key;

INSERT INTO prj_g_inventory (inventory, n)
SELECT 'inventory: project_parties linked to a company by unique normalised name (backfilled below)', COUNT(*)::text
  FROM prj_g_party_match WHERE matches = 1 AND NOT decided_before
UNION ALL
SELECT 'inventory: project_parties whose name matches MORE THAN ONE company (left unlinked)', COUNT(*)::text
  FROM prj_g_party_match WHERE matches > 1 AND NOT decided_before;

BEGIN;

-- ── 1. read extent on cost_documents (COST-13) ──────────────────────────
ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS pages_total INT;
ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS pages_read  INT;
COMMENT ON COLUMN cost_documents.pages_total IS 'True page count of the stored file at the last AI read; NULL = unknown (read before this column existed), never "complete".';
COMMENT ON COLUMN cost_documents.pages_read  IS 'Pages the model actually saw at the last AI read (capped by the route). pages_read < pages_total = a truncated read.';

-- ── 2. explicit registry link (BID-12 / COST-3) ─────────────────────────
ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS cost_documents_company_idx ON cost_documents (company_id) WHERE company_id IS NOT NULL;
COMMENT ON COLUMN cost_documents.company_id IS 'Known Companies registry row this bidder was explicitly linked to on the bid row; outranks any name match. party_id is unchanged.';

-- ── 3. quality-manual read extent (COST-3 dw3) ──────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quality_manual_pages_read  INT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quality_manual_pages_total INT;

-- ── 4. one-off party → company backfill (COST-12 / MON-7 dw4) ───────────
-- Record, then apply, in ONE statement: every decision becomes an audit
-- row (the org's own trail, where a controller can see it), and the
-- UPDATE links exactly the parties those rows say 'linked'. A party this
-- backfill has already recorded (an earlier run, or a link reverted since)
-- is never recorded or linked again.
WITH recorded AS (
  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
  SELECT 'PROJECT_PARTY_COMPANY_BACKFILLED', m.party_id::text, 'project_party', m.org_id, NULL, NULL,
         jsonb_build_object(
           'migration', '20261096',
           'outcome', CASE WHEN m.matches = 1 THEN 'linked' ELSE 'ambiguous' END,
           'companyId', CASE WHEN m.matches = 1 THEN m.company_id END,
           'matchedKey', m.key, 'matches', m.matches, 'projectId', m.project_id)
    FROM prj_g_party_match m
   WHERE NOT m.decided_before
  RETURNING resource_id, details
)
UPDATE project_parties p
   SET company_id = (r.details->>'companyId')::uuid
  FROM recorded r
 WHERE r.details->>'outcome' = 'linked' AND p.id::text = r.resource_id AND p.company_id IS NULL;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'cost_documents.pages_total exists' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cost_documents' AND column_name = 'pages_total') AS ok, NULL::text AS n
UNION ALL SELECT 'cost_documents.pages_read exists',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cost_documents' AND column_name = 'pages_read'), NULL
UNION ALL SELECT 'cost_documents.company_id exists with FK to companies (ON DELETE SET NULL)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.cost_documents'::regclass AND contype = 'f'
                  AND confrelid = 'public.companies'::regclass AND confdeltype = 'n'
                  AND pg_get_constraintdef(oid) ILIKE '%(company_id)%'), NULL
UNION ALL SELECT 'cost_documents_company_idx exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'cost_documents_company_idx'), NULL
UNION ALL SELECT 'companies.quality_manual_pages_read exists',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'quality_manual_pages_read'), NULL
UNION ALL SELECT 'companies.quality_manual_pages_total exists',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'quality_manual_pages_total'), NULL
UNION ALL SELECT 'no party from the unique-match set is still unlinked',
       NOT EXISTS (SELECT 1 FROM prj_g_party_match m JOIN project_parties p ON p.id = m.party_id
                    WHERE m.matches = 1 AND NOT m.decided_before AND p.company_id IS NULL), NULL
UNION ALL SELECT 'every party this backfill linked has its PROJECT_PARTY_COMPANY_BACKFILLED audit row (list them with the review query at the foot)',
       NOT EXISTS (SELECT 1 FROM prj_g_party_match m JOIN project_parties p ON p.id = m.party_id
                    WHERE m.matches = 1 AND NOT m.decided_before AND p.company_id = m.company_id
                      AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action = 'PROJECT_PARTY_COMPANY_BACKFILLED'
                                        AND a.resource_id = m.party_id::text AND a.details->>'outcome' = 'linked')), NULL
UNION ALL SELECT 'inventory: backfill audit rows, outcome linked (all runs)', NULL::boolean, COUNT(*)::text
  FROM audit_logs WHERE action = 'PROJECT_PARTY_COMPANY_BACKFILLED' AND details->>'outcome' = 'linked'
UNION ALL SELECT 'inventory: backfill audit rows, outcome ambiguous — left unlinked (all runs)', NULL::boolean, COUNT(*)::text
  FROM audit_logs WHERE action = 'PROJECT_PARTY_COMPANY_BACKFILLED' AND details->>'outcome' = 'ambiguous'
UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_inventory;

-- ── Backfill review — paste on its own to LIST the matches ──────────────
-- One row per party the backfill decided: linked (and to which company)
-- or left alone as ambiguous. Run it in the SQL editor after the file.
--
-- SELECT a.details->>'outcome' AS outcome, p.name AS party, a.resource_id AS party_id,
--        c.name AS company, a.details->>'companyId' AS company_id,
--        a.details->>'matchedKey' AS matched_key, a.details->>'matches' AS matches, a."timestamp" AS recorded_at
--   FROM audit_logs a
--   LEFT JOIN project_parties p ON p.id::text = a.resource_id
--   LEFT JOIN companies c ON c.id::text = a.details->>'companyId'
--  WHERE a.action = 'PROJECT_PARTY_COMPANY_BACKFILLED'
--  ORDER BY 1, 2;
--
-- ── Backfill revert — undo a wrong link (or all of them) ────────────────
-- Unlinks only a party whose link is still the one the backfill set, and
-- records the undo. Add  AND a.resource_id = '<party id>'  to undo one.
--
-- WITH undone AS (
--   UPDATE project_parties p SET company_id = NULL
--     FROM audit_logs a
--    WHERE a.action = 'PROJECT_PARTY_COMPANY_BACKFILLED' AND a.details->>'outcome' = 'linked'
--      AND a.resource_id = p.id::text AND p.company_id::text = a.details->>'companyId'
--   RETURNING p.id, p.org_id, a.details->>'companyId' AS company_id
-- )
-- INSERT INTO audit_logs (action, resource_id, resource_type, org_id, details)
-- SELECT 'PROJECT_PARTY_COMPANY_BACKFILL_REVERTED', id::text, 'project_party', org_id,
--        jsonb_build_object('migration', '20261096', 'companyId', company_id)
--   FROM undone;

-- ── INTK-12 expiry backfill — BLOCKED until the 'used in the last 30 days'
-- inventory row above reads 0 (a link in active bidding must not be cut
-- off). Then run exactly this, once:
--
-- UPDATE project_intake_links
--    SET expires_at = created_at + INTERVAL '90 days'
--  WHERE purpose = 'quote' AND expires_at IS NULL AND revoked_at IS NULL;
