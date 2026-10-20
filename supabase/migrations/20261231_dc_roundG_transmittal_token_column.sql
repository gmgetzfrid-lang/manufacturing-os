-- 20261231_dc_roundG_transmittal_token_column.sql
--
-- document-control Round G — package P29 TRANSMITTAL READ, DIST-18 limb (a),
-- under the integrator's rulings at the P27 merge (DEC-90 R2; 2026-10-20).
--
-- WHY:
--   transmittals_select (20260910_transmittal_portal.sql:33-37, the only
--   SELECT policy on the table) admits every active member of the org to the
--   whole row, and the table-level SELECT privilege Supabase grants every
--   table hands `authenticated` (and `anon`) every column — portal_token
--   included. The token is the recipient portal's whole credential:
--   GET /api/transmittal?token=…&file=<documentId> streams an item's as-sent
--   file and, without the page's member ticket, records the pull as the
--   outside recipient's. So any active member — a Viewer outside a listed
--   document's ACL included — could read a live link's token over REST
--   (`GET /rest/v1/transmittals?select=portal_token`) and download files
--   their ACL refuses (DIST-17's access-control door, DIST-18).
--
-- WHAT (one change — a column-level privilege, the 20261154 pattern; the
-- policies are not touched):
--   The table-level SELECT privilege on transmittals is revoked from PUBLIC,
--   anon and authenticated, and SELECT is granted back — to each of
--   authenticated and anon that could SELECT the table before this paste —
--   on EVERY column the table has at paste time except portal_token (the
--   list is read from the catalog, so a database with or without 20261133's
--   or 20261199's columns gets exactly its own columns). Every other column
--   stays readable exactly as today, through the same policy: a member reads
--   the items, the subject, the dates, the link's lifecycle; anon still reads
--   no row (no policy admits it) and its statements answer as before, 0 rows
--   rather than a refusal. INSERT, UPDATE
--   and DELETE privileges are not changed: the composer, the issue (the
--   database mints the token in the UPDATE itself), the void, the revoke and
--   the draft delete work as before. The service role keeps the whole table:
--   the recipient portal (/api/transmittal), the register route
--   (/api/transmittal/register, which hands the token only to someone who may
--   read every item — DIST-17 ruling 2), and the email, receipt and
--   stamp-check routes.
--   A client `select("*")` of transmittals is refused from now on (42501), as
--   is a write's `RETURNING *`: the app no longer sends either (document-
--   control P29 — the register, the Inspector's trail, getTransmittal, global
--   search and the evidence pack read through the register route; the
--   create, the issue's draft read and its read-back name their columns,
--   lib/transmittals TRANSMITTAL_CLIENT_COLUMNS).
--
-- WIDENING? No — it narrows what `authenticated` and `anon` may read (one
-- column, and never grants a role a column it could not read before). The
-- before-apply inventory (aggregate counts only, never a row) records how
-- many tokens members could read before this paste.
--
-- ORDER (DEC-30; the app must work before AND after):
--   DEPLOY FIRST, THEN PASTE. The P29 deploy already reads no token in the
--   browser and works on the database as it is today. Pasted before that
--   deploy, the old app's browser reads (`select("*")` in the Inspector's
--   trail, the evidence pack, and the create / issue read-backs) would be
--   refused with 42501. Needs 20260717 and 20260910 (it refuses, changing
--   nothing, without the table or the portal_token column). Either order
--   with every other pending paste: it re-creates no function, policy or
--   trigger. Idempotent: a re-paste answers every probe true.
--
-- TOKENS READ BEFORE THE PASTE STAY VALID (not closed by this file):
--   revoking the column privilege stops NEW reads of the token; it does not
--   invalidate a token a member already copied over REST. Such a token keeps
--   serving the as-sent files (each pull recorded as the recipient's) until
--   its link expires — issue + 90 days for a link issued with 20261133
--   live; a link issued before 20261133 has no expiry (portal_expires_at
--   NULL) — or a transmit authority revokes it or voids the transmittal.
--   Inventory row 4 counts the live links listing an item that is not
--   plainly open: the links whose token a member outside an item's ACL could
--   have read before this paste. After the paste, a Document Controller
--   reviews those links and decides, per link, whether to revoke it (the
--   outside recipient's emailed link then stops; a new transmittal re-sends
--   the files) or let it run to expiry. Tokens are NOT rotated here: that
--   would silently break every recipient's emailed link, so it is a ruling,
--   never automatic (DIST-18's record: the pre-paste residual, its owner).
--
-- A LATER MIGRATION THAT ADDS A COLUMN to transmittals must also
--   `GRANT SELECT (<column>) ON transmittals TO authenticated;` — the
--   column grant names columns, so a new column is unreadable by members
--   until it is granted (lib/__tests__/dcRoundGP29TransmittalRead.test.ts
--   refuses a later file that adds one without the grant). A later
--   `GRANT SELECT ON transmittals TO authenticated` (table level) re-opens
--   the token and must never be written.
--
-- ROLLBACK (restores the previous privileges exactly; the token is then
-- readable by every active member again):
--   GRANT SELECT ON transmittals TO anon, authenticated;
--
-- ⚠ APPLIED BY HAND (DEC-30). Paste the whole file once into the Supabase
-- SQL editor. The editor shows only the LAST result set — the final SELECT
-- carries every probe (ok true/false, n NULL) and the inventory counts
-- (ok NULL, n the count). Until it is pasted, the REST read still hands every
-- member the token (DIST-18 stays OPEN for that and for limb (b)).

-- ── Before-apply inventory (aggregate counts only, never a row) ──────────
-- The portal columns are read through to_jsonb so the inventory runs on a
-- database without 20261133's lifecycle columns (and says 0 without 20260910).
DROP TABLE IF EXISTS pg_temp._dc_g31_before;
CREATE TEMP TABLE _dc_g31_before AS
WITH tr AS (
  SELECT t.id, t.org_id, t.status, t.items,
         to_jsonb(t)->>'portal_token' AS tok,
         to_jsonb(t)->>'portal_revoked_at' AS revoked_at,
         to_jsonb(t)->>'portal_expires_at' AS expires_at
    FROM transmittals t
), live AS (
  SELECT * FROM tr
   WHERE status IN ('issued', 'acknowledged') AND tok IS NOT NULL AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at::timestamptz > now())
), restricted AS (
  SELECT DISTINCT l.id
    FROM live l
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.items) = 'array' THEN l.items ELSE '[]'::jsonb END) AS i(item)
    LEFT JOIN documents d ON d.id::text = i.item->>'documentId'
    LEFT JOIN libraries lb ON lb.id = d.library_id
   WHERE d.id IS NULL
      OR COALESCE(d.visibility, 'normal') <> 'normal' OR d.acl IS NOT NULL OR d.collection_id IS NOT NULL
      OR COALESCE(lb.visibility, 'normal') <> 'normal' OR lb.acl IS NOT NULL
)
SELECT 1 AS ord, 'inventory (before apply): transmittals (all)' AS inventory, COUNT(*)::text AS n FROM tr
UNION ALL
SELECT 2, 'inventory (before apply): transmittals with a portal token set (any state) — every one readable by every active member of its org before this paste',
       COUNT(*)::text FROM tr WHERE tok IS NOT NULL
UNION ALL
SELECT 3, 'inventory (before apply): of those, with a LIVE link (issued / acknowledged, not revoked, not expired) — a token that downloads the as-sent files',
       COUNT(*)::text FROM live
UNION ALL
SELECT 4, 'inventory (before apply): live links listing an item that is not plainly open (document private / hidden / ACL / in a folder, library private / hidden / ACL, or no document row) — DIST-18''s door',
       COUNT(*)::text FROM restricted
UNION ALL
SELECT 5, 'inventory (before apply): active members of an org holding a live link (who could read its token over REST before this paste)',
       COUNT(*)::text FROM org_members m
        WHERE m.status = 'active' AND EXISTS (SELECT 1 FROM live l WHERE l.org_id = m.org_id)
UNION ALL
SELECT 6, 'inventory (before apply): authenticated held table-level SELECT on transmittals (1 = yes; 0 = a re-paste)',
       (CASE WHEN has_table_privilege('authenticated', 'public.transmittals', 'SELECT') THEN 1 ELSE 0 END)::text
UNION ALL
SELECT 7, 'inventory (before apply): anon held table-level SELECT on transmittals (1 = yes; 0 = a re-paste or never granted)',
       (CASE WHEN has_table_privilege('anon', 'public.transmittals', 'SELECT') THEN 1 ELSE 0 END)::text
UNION ALL
SELECT 8, 'inventory (before apply): authenticated''s INSERT / UPDATE / DELETE on transmittals, as a 3-digit mask (1 = held) — the after-probe proves this paste left it as it was',
       (CASE WHEN has_table_privilege('authenticated', 'public.transmittals', 'INSERT') THEN '1' ELSE '0' END)
       || (CASE WHEN has_table_privilege('authenticated', 'public.transmittals', 'UPDATE') THEN '1' ELSE '0' END)
       || (CASE WHEN has_table_privilege('authenticated', 'public.transmittals', 'DELETE') THEN '1' ELSE '0' END)
UNION ALL
SELECT 9, 'inventory (before apply): authenticated could SELECT transmittals (table or column level; 1 = yes) — every column but portal_token is granted back exactly when so',
       (CASE WHEN has_any_column_privilege('authenticated', 'public.transmittals', 'SELECT') THEN 1 ELSE 0 END)::text
UNION ALL
SELECT 10, 'inventory (before apply): anon could SELECT transmittals (table or column level; 1 = yes) — every column but portal_token is granted back exactly when so (no policy admits anon to a row either way)',
       (CASE WHEN has_any_column_privilege('anon', 'public.transmittals', 'SELECT') THEN 1 ELSE 0 END)::text;

BEGIN;

DO $$
DECLARE
  v_cols text;
  v_auth boolean;
  v_anon boolean;
BEGIN
  IF to_regclass('public.transmittals') IS NULL THEN
    RAISE EXCEPTION '20261231 needs 20260717 (the transmittals table) — nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.transmittals'::regclass AND attname = 'portal_token'
                    AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION '20261231 needs 20260910 (transmittals.portal_token) — nothing was changed.';
  END IF;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.transmittals'::regclass
     AND attnum > 0 AND NOT attisdropped
     AND attname <> 'portal_token';

  -- Who could read the table before (table or column level — a re-paste
  -- finds the column grants of the first paste).
  v_auth := has_any_column_privilege('authenticated', 'public.transmittals', 'SELECT');
  v_anon := has_any_column_privilege('anon', 'public.transmittals', 'SELECT');

  -- Revoking the table-level privilege also revokes every column-level
  -- SELECT already granted (a re-paste starts from nothing); then each role
  -- that could read the table gets every column back but the token.
  REVOKE SELECT ON TABLE public.transmittals FROM PUBLIC, anon, authenticated;
  IF v_auth THEN
    EXECUTE format('GRANT SELECT (%s) ON TABLE public.transmittals TO authenticated', v_cols);
  END IF;
  IF v_anon THEN
    EXECUTE format('GRANT SELECT (%s) ON TABLE public.transmittals TO anon', v_cols);
  END IF;
END
$$;

COMMENT ON COLUMN transmittals.portal_token IS
  'The recipient portal''s credential (minted by the issue trigger). Never readable by a client role (20261231, DIST-18): the service role reads it — the portal, and the register route, which hands it only to someone who may read every item (DIST-17 ruling 2).';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'transmittals: RLS still on' AS "check",
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.transmittals')), false) AS ok,
       NULL::text AS n
UNION ALL SELECT 'transmittals_select is kept (20260910): one SELECT policy, bound to the caller''s active membership',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'transmittals' AND cmd = 'SELECT') = 1
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'transmittals' AND policyname = 'transmittals_select'
                      AND qual LIKE '%org_members%' AND qual LIKE '%auth.uid()%' AND qual LIKE '%active%'), NULL
UNION ALL SELECT 'authenticated, anon and PUBLIC hold no table-level SELECT on transmittals',
       NOT has_table_privilege('authenticated', 'public.transmittals', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.transmittals', 'SELECT')
       AND NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
                        WHERE c.oid = 'public.transmittals'::regclass AND a.grantee = 0 AND a.privilege_type = 'SELECT'), NULL
UNION ALL SELECT 'authenticated cannot SELECT portal_token (the REST read of the token is refused, 42501)',
       NOT has_column_privilege('authenticated', 'public.transmittals', 'portal_token', 'SELECT'), NULL
UNION ALL SELECT 'anon cannot SELECT portal_token',
       NOT has_column_privilege('anon', 'public.transmittals', 'portal_token', 'SELECT'), NULL
UNION ALL SELECT 'authenticated can SELECT every other column of transmittals exactly as before this paste (the items, subject, dates, link lifecycle)',
       NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'public.transmittals'::regclass AND attnum > 0 AND NOT attisdropped
                      AND attname <> 'portal_token'
                      AND has_column_privilege('authenticated', 'public.transmittals', attname, 'SELECT')
                          IS DISTINCT FROM ((SELECT b.n FROM _dc_g31_before b WHERE b.ord = 9) = '1')), NULL
UNION ALL SELECT 'anon can SELECT every other column of transmittals exactly as before this paste (still no row: no policy admits anon)',
       NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'public.transmittals'::regclass AND attnum > 0 AND NOT attisdropped
                      AND attname <> 'portal_token'
                      AND has_column_privilege('anon', 'public.transmittals', attname, 'SELECT')
                          IS DISTINCT FROM ((SELECT b.n FROM _dc_g31_before b WHERE b.ord = 10) = '1')), NULL
UNION ALL SELECT 'service_role keeps SELECT on the whole table, portal_token included (the portal, the register route, the email / receipt / stamp-check routes)',
       has_table_privilege('service_role', 'public.transmittals', 'SELECT')
       AND has_column_privilege('service_role', 'public.transmittals', 'portal_token', 'SELECT'), NULL
UNION ALL SELECT 'authenticated''s INSERT / UPDATE / DELETE on transmittals are as they were before this paste (the composer, issue, void, revoke and draft delete are unchanged)',
       ((CASE WHEN has_table_privilege('authenticated', 'public.transmittals', 'INSERT') THEN '1' ELSE '0' END)
        || (CASE WHEN has_table_privilege('authenticated', 'public.transmittals', 'UPDATE') THEN '1' ELSE '0' END)
        || (CASE WHEN has_table_privilege('authenticated', 'public.transmittals', 'DELETE') THEN '1' ELSE '0' END))
       = (SELECT b.n FROM _dc_g31_before b WHERE b.ord = 8), NULL
UNION ALL SELECT inventory, NULL, n FROM (SELECT inventory, n FROM _dc_g31_before ORDER BY ord) inv;
