-- 20261177_ao_roundG_platform_operators.sql
--
-- admin-and-org Round G, package P6 — BILL-5 (DEC-44 (A&O P6), provisional
-- number): the hosting-plan storage ceiling is ONE deployment-wide row
-- (platform_settings key 'storage_limits') that bands every workspace on the
-- server, and /api/admin/storage-stats POST let an Admin or DocCtrl of ANY
-- org overwrite it. The app now lets only a PLATFORM OPERATOR write it, and
-- shows the deployment's figures (every table, the whole bucket, the plan
-- ceilings) only to an operator or to the sole workspace of a
-- single-workspace server. This file gives the operator list its home and
-- re-asserts that no client role can reach the table that holds it.
--
-- WHY HERE: an operator is a uid listed in platform_settings under the key
-- 'platform_operators' ({"uids": [...]}) — the table 20260920 created
-- service-role only (RLS on, no policy, every privilege revoked from public,
-- anon and authenticated). No app route writes that row, so no org role,
-- Admin included, can make anyone an operator: only the deployment's owner,
-- in this SQL editor. (A table of its own would have needed a place in every
-- table census the app keeps; this one is already classified — not exported,
-- lib/exportTables.ts EXPORT_EXCLUDED_TABLES.platform_settings.)
--
-- WHAT:
--   1. platform_settings: RLS on; ALL revoked from public, anon and
--      authenticated (both as 20260920 left them — re-asserted in case a
--      grant was added by hand since). No policy is created: with RLS on and
--      no policy, a client role is refused even if a grant came back.
--   2. The 'platform_operators' row, seeded as {"uids": []} when absent
--      (ON CONFLICT DO NOTHING: a re-paste never clears a registered list).
--   3. A table comment naming both keys.
--   Nothing else: no function, policy, trigger or index; the 'storage_limits'
--   row is not touched.
--
-- WIDENING? No — it lets nobody do anything new. The operator list starts
-- empty; until a uid is added, NOBODY can change the plan ceilings from the
-- app (the storage page says so and shows the line below with the member's
-- own id). The before-apply inventory counts what is there (aggregate counts
-- only; it is dropped and re-captured on every paste).
--
-- TO REGISTER AN OPERATOR (after the paste; replace the address, run once):
--   UPDATE platform_settings
--      SET value = jsonb_build_object('uids', COALESCE(value->'uids', '[]'::jsonb) || jsonb_build_array(u.id::text)),
--          updated_at = now()
--     FROM auth.users u
--    WHERE platform_settings.key = 'platform_operators' AND u.email = 'you@example.com'
--      AND NOT (COALESCE(platform_settings.value->'uids', '[]'::jsonb) ? u.id::text);
-- "UPDATE 0" means the address matched no user (or is already listed).
-- To remove one: UPDATE platform_settings SET value = jsonb_build_object('uids',
--   COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(value->'uids') x WHERE x <> to_jsonb('<uid>'::text)), '[]'::jsonb))
--   WHERE key = 'platform_operators';
--
-- NEEDS 20260920 (platform_settings). Pasted without it, this file stops at
-- the first statement and says so; nothing is changed.
--
-- WHEN TO PASTE: either order with the app is safe. Before the paste the app
-- reads no operator row and treats nobody as an operator (fail closed): the
-- ceilings cannot be changed from the app, every workspace still sees its
-- own files, and a single-workspace server still sees its own deployment
-- figures. After it, the same, until a uid is registered. The code before
-- this fix never reads the row, so pasting first changes nothing for it.
--
-- ROLLBACK:
--   DELETE FROM platform_settings WHERE key = 'platform_operators';
-- (The revoke and RLS are 20260920's own state; leave them.) The app keeps
-- working: with no row, nobody is an operator.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count). Until it is pasted, behaviour is unchanged.

DO $$
BEGIN
  IF to_regclass('public.platform_settings') IS NULL THEN
    RAISE EXCEPTION '20261177 needs 20260920 (platform_settings) — paste 20260920_per_user_keys_real_limits.sql first. Nothing was changed.';
  END IF;
END $$;

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ao_g77_before;
CREATE TEMP TABLE _ao_g77_before AS
SELECT 'rows' AS k,
       'inventory: platform_settings rows before this paste' AS inventory,
       (SELECT COUNT(*) FROM platform_settings)::text AS n
UNION ALL
SELECT 'limits',
       'inventory: a storage_limits row was set before this paste (1 = set from the storage page, 0 = env / free-tier defaults) — not touched',
       (SELECT COUNT(*) FROM platform_settings WHERE key = 'storage_limits')::text
UNION ALL
SELECT 'operators_row',
       'inventory: the platform_operators row already present before this paste (0 = a first apply, 1 = a re-run)',
       (SELECT COUNT(*) FROM platform_settings WHERE key = 'platform_operators')::text
UNION ALL
SELECT 'operators',
       'inventory: operator uids registered before this paste (kept on a re-run)',
       (SELECT COUNT(*) FROM platform_settings p, jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.value->'uids') = 'array' THEN p.value->'uids' ELSE '[]'::jsonb END) e
         WHERE p.key = 'platform_operators')::text
UNION ALL
SELECT 'client_priv',
       'inventory: client roles (public, anon, authenticated) holding any privilege on platform_settings before this paste (0 = as 20260920 left it)',
       (SELECT COUNT(*) FROM (VALUES ('public'), ('anon'), ('authenticated')) r(role), (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
         WHERE has_table_privilege(r.role, 'public.platform_settings', p.priv))::text
UNION ALL
SELECT 'policies',
       'inventory: policies on platform_settings before this paste (0 = as 20260920 left it; this file creates none and drops none)',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'platform_settings')::text;

BEGIN;

-- ── 1. the table stays service-role only ─────────────────────────────────
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_settings FROM public, anon, authenticated;

-- ── 2. the operator list's home (empty; never cleared by a re-paste) ─────
INSERT INTO platform_settings (key, value)
VALUES ('platform_operators', '{"uids": []}'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE platform_settings IS
  'Deployment-wide settings, service-role only (no client role, no policy). storage_limits: the hosting-plan ceilings, written only by a platform operator (/api/admin/storage-stats POST). platform_operators: {"uids": [...]}, the operators, written only in the SQL editor (BILL-5, 20261177).';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'platform_settings: RLS on' AS check,
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.platform_settings')), false) AS ok,
       NULL::text AS n
UNION ALL SELECT 'platform_settings: no client role (public, anon, authenticated) holds SELECT, INSERT, UPDATE or DELETE',
       NOT EXISTS (SELECT 1 FROM (VALUES ('public'), ('anon'), ('authenticated')) r(role), (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
                    WHERE has_table_privilege(r.role, 'public.platform_settings', p.priv)), NULL
UNION ALL SELECT 'platform_settings: no policy (RLS refuses a client role even if a grant came back)',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'platform_settings'), NULL
UNION ALL SELECT 'platform_settings: the service role may read and write it',
       has_table_privilege('service_role', 'public.platform_settings', 'SELECT')
       AND has_table_privilege('service_role', 'public.platform_settings', 'INSERT')
       AND has_table_privilege('service_role', 'public.platform_settings', 'UPDATE'), NULL
UNION ALL SELECT 'the platform_operators row exists and its uids is a JSON array',
       EXISTS (SELECT 1 FROM platform_settings WHERE key = 'platform_operators' AND jsonb_typeof(value->'uids') = 'array'), NULL
UNION ALL SELECT 'the storage_limits row is untouched (present exactly as before this paste)',
       (SELECT COUNT(*) FROM platform_settings WHERE key = 'storage_limits')::text = (SELECT n FROM _ao_g77_before WHERE k = 'limits'), NULL
UNION ALL SELECT 'a re-paste kept the registered operators (none dropped)',
       (SELECT COUNT(*) FROM platform_settings p, jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.value->'uids') = 'array' THEN p.value->'uids' ELSE '[]'::jsonb END) e
         WHERE p.key = 'platform_operators')::text = (SELECT n FROM _ao_g77_before WHERE k = 'operators'), NULL
UNION ALL SELECT 'after: platform operators registered (0 until you run the line in this file''s header — until then nobody can change the plan ceilings from the app)', NULL,
       (SELECT COUNT(*) FROM platform_settings p, jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.value->'uids') = 'array' THEN p.value->'uids' ELSE '[]'::jsonb END) e
         WHERE p.key = 'platform_operators')::text
UNION ALL SELECT 'after: workspaces on this server (1 = single-workspace: its members still see the server''s figures; 2+ = only an operator does)', NULL,
       (SELECT COUNT(*) FROM orgs)::text
UNION ALL SELECT inventory, NULL, n FROM _ao_g77_before;
