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
--      are left alone and counted below.
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
-- it once. The final SELECT is the only result set shown — probe rows must
-- read ok = true; inventory rows carry ok NULL and a count in n.

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
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
SELECT n.id AS party_id,
       MIN(c.id::text)::uuid AS company_id,
       COUNT(c.id) AS matches
  FROM norm n
  JOIN cnorm c ON c.org_id = n.org_id AND c.key = n.key AND c.key <> ''
 GROUP BY n.id;

INSERT INTO prj_g_inventory (inventory, n)
SELECT 'inventory: project_parties linked to a company by unique normalised name (backfilled below)', COUNT(*)::text
  FROM prj_g_party_match WHERE matches = 1
UNION ALL
SELECT 'inventory: project_parties whose name matches MORE THAN ONE company (left unlinked)', COUNT(*)::text
  FROM prj_g_party_match WHERE matches > 1;

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
UPDATE project_parties p
   SET company_id = m.company_id
  FROM prj_g_party_match m
 WHERE m.party_id = p.id AND m.matches = 1 AND p.company_id IS NULL;

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
       NOT EXISTS (SELECT 1 FROM prj_g_party_match m JOIN project_parties p ON p.id = m.party_id WHERE m.matches = 1 AND p.company_id IS NULL), NULL
UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_inventory;

-- ── INTK-12 expiry backfill — BLOCKED until the 'used in the last 30 days'
-- inventory row above reads 0 (a link in active bidding must not be cut
-- off). Then run exactly this, once:
--
-- UPDATE project_intake_links
--    SET expires_at = created_at + INTERVAL '90 days'
--  WHERE purpose = 'quote' AND expires_at IS NULL AND revoked_at IS NULL;
