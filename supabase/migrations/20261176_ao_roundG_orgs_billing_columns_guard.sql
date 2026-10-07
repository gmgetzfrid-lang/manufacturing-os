-- 20261176_ao_roundG_orgs_billing_columns_guard.sql
--
-- admin-and-org Round G, package P4 — migration B.
--   BILL-2 Done-when 1 / 2: "orgs has an explicit column grant (or a BEFORE
--     UPDATE trigger) so authenticated cannot write subscription_status,
--     subscribed_plan, trial_ends_at, current_period_end, stripe_customer_id
--     or stripe_subscription_id — only the service role can"; the billing
--     columns are pinned to their OLD values for non-service-role writers.
--   ORG-9 Done-when 1: "A RESTRICTIVE UPDATE policy (or a trigger) blocks
--     non-service-role writes to subscription_status / trial_ends_at /
--     subscribed_plan / stripe_customer_id / stripe_subscription_id".
--   BILL-6 Done-when 1: "stripe_customer_id is not writable by any client role".
--   BILL-3 Done-when 2 (the rows the old code left): a canceled workspace
--     keeps no plan.
--
-- WHY: orgs_admin_write (FOR UPDATE, USING only; schema.sql, re-created by
-- 20261046_rp_phase6_sweep_authority_by_collection.sql:136-138 on the role
-- collection) is the only write policy on orgs, and it tests only the row's
-- id. So any Admin could PATCH /rest/v1/orgs with
-- {"subscription_status":"active","subscribed_plan":"growth","trial_ends_at":null}
-- — the workspace read as a paying Growth customer forever (the cloud-backup
-- gate, hasAccess, org_has_active_subscription all read those columns) — or
-- point stripe_customer_id at another tenant's Stripe customer.
--
-- WHAT: one BEFORE UPDATE trigger on orgs, trg_orgs_billing_columns_guard →
-- orgs_billing_columns_guard(). When the request's JWT role (auth.role()) is
-- neither service_role nor absent, a change to any of the six billing columns
-- is REFUSED (42501, insufficient_privilege) — the columns are pinned by
-- refusal, never silently reset, so a forged write fails as a whole and the
-- caller is told. A member's update that leaves the six columns as they are
-- (the settings page's ticket numbering, admin/settings/page.tsx:110-114)
-- passes untouched; so does one that names a billing column with its current
-- value. The service role (the Stripe webhook, checkout's customer write,
-- restore) and a session with no request role (the SQL editor) pass.
--   orgs_admin_write is NOT changed: it stays as 20261046 left it, so who may
--   update an org row at all is exactly as before; this trigger narrows only
--   which columns a member may change. It is the first trigger on orgs (none
--   in schema.sql or any earlier migration).
--   SECURITY INVOKER (it reads only NEW, OLD and the request role) with
--   search_path pinned; EXECUTE revoked from PUBLIC, anon and authenticated
--   (the DRLS-16 rule — a trigger function's privilege is checked when the
--   trigger is created, never when it fires).
--   BILL-3: inside the same transaction, before the trigger, the plan is
--   cleared on every canceled workspace (subscription_status = 'canceled'
--   AND subscribed_plan IS NOT NULL). The webhook clears it on every write
--   that ends a subscription from P4 on, but a workspace the old code
--   canceled kept its plan and gets no further subscription event to clear
--   it, while the cloud-backup create gate (lib/exportEntitlement.ts
--   cloudBucketAllowed) reads the plan alone. A canceled workspace has no
--   access and no subscription paying for a plan, so the value is
--   unambiguous; the inventory counts the rows before, a probe says none is
--   left. Nothing else is rewritten.
--   After COMMIT a self-test runs inside a subtransaction that is always
--   rolled back: as a request carrying the authenticated role it tries one
--   billing change (must be refused) and one update that leaves the billing
--   columns alone (must pass). Nothing it writes survives; on a database with
--   no orgs row it reports n/a.
--
-- WIDENING? No — it takes a write away from members, and a plan away from
-- canceled workspaces. The before-apply inventory (aggregate counts only)
-- counts the row shapes a self-granted state leaves: "active" with no Stripe
-- subscription id and a trial with no end (reported, never rewritten), and a
-- plan on a canceled workspace (cleared, BILL-3, above).
--
-- WHEN TO PASTE: either order with the P4 deploy is safe, and either order
-- with 20261175. Every billing-column write the app makes, before and after
-- P4, runs as the service role (app/api/stripe/webhook, app/api/stripe/
-- checkout, app/api/auth/signup's insert — an INSERT, which this BEFORE
-- UPDATE trigger never sees); the only orgs update made with a member's
-- session (the ticket-numbering save) touches none of the six columns
-- (pinned in lib/__tests__/stripeWebhook.test.ts, "every orgs write").
-- Pasted before the deploy, a workspace the old webhook cancels in between
-- keeps its plan; paste again after the deploy (idempotent) to clear it.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_orgs_billing_columns_guard ON orgs;
--   DROP FUNCTION IF EXISTS orgs_billing_columns_guard();
-- The app keeps working; the columns are member-writable again. The plans
-- cleared on canceled workspaces are not restored (none was paid for).
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count). Until it is pasted, an Admin can still write
-- the billing columns.

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'orgs'
         AND column_name IN ('subscription_status', 'subscribed_plan', 'trial_ends_at', 'current_period_end', 'stripe_customer_id', 'stripe_subscription_id')) <> 6 THEN
    RAISE EXCEPTION '20261176 needs 20260601 (the orgs billing columns) — paste 20260601_billing.sql first. Nothing was changed.';
  END IF;
END $$;

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ao_g76_before;
CREATE TEMP TABLE _ao_g76_before AS
SELECT 'guard_present' AS k,
       'inventory: trg_orgs_billing_columns_guard present before this paste (0 = a first apply, 1 = a re-run)' AS inventory,
       (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'trg_orgs_billing_columns_guard' AND NOT tgisinternal)::text AS n
UNION ALL
SELECT 'orgs',
       'inventory: workspaces (orgs rows)',
       (SELECT COUNT(*) FROM orgs)::text
UNION ALL
SELECT 'active_no_sub',
       'inventory: workspaces "active" with no Stripe subscription id (the shape a self-granted status leaves, or an operator''s manual grant) — reported, never rewritten',
       (SELECT COUNT(*) FROM orgs WHERE subscription_status = 'active' AND stripe_subscription_id IS NULL)::text
UNION ALL
SELECT 'trial_no_end',
       'inventory: workspaces "trialing" with no trial end (open-ended free access) — reported, never rewritten',
       (SELECT COUNT(*) FROM orgs WHERE subscription_status = 'trialing' AND trial_ends_at IS NULL)::text
UNION ALL
SELECT 'canceled_with_plan',
       'inventory: canceled workspaces still carrying a plan before this paste (canceled before P4 cleared the plan on cancellation; the cloud-backup gate reads the plan) — cleared by this paste (BILL-3)',
       (SELECT COUNT(*) FROM orgs WHERE subscription_status = 'canceled' AND subscribed_plan IS NOT NULL)::text
UNION ALL
SELECT 'other_triggers',
       'inventory: other user triggers on orgs before this paste (0 expected: none is defined in schema.sql or the migration sequence)',
       (SELECT COUNT(*) FROM pg_trigger
         WHERE tgrelid = to_regclass('public.orgs') AND NOT tgisinternal AND tgname <> 'trg_orgs_billing_columns_guard')::text;

BEGIN;

-- ── BILL-3: a canceled workspace keeps no plan (counted before; probed after)
UPDATE orgs SET subscribed_plan = NULL
 WHERE subscription_status = 'canceled' AND subscribed_plan IS NOT NULL;

CREATE OR REPLACE FUNCTION orgs_billing_columns_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  -- auth.role() is the request's JWT role: 'service_role' for the server,
  -- 'authenticated' / 'anon' for a browser (also inside a SECURITY DEFINER
  -- function it calls), NULL for a session with no request (the SQL editor).
  IF auth.role() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
     OR NEW.subscribed_plan IS DISTINCT FROM OLD.subscribed_plan
     OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
     OR NEW.current_period_end IS DISTINCT FROM OLD.current_period_end
     OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
     OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
    RAISE EXCEPTION 'A workspace''s billing state (subscription status, plan, trial end, billing period, Stripe customer and subscription) is set only by Stripe through the server, not by a direct write. (BILL-2, 20261176)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION orgs_billing_columns_guard() IS
  'BILL-2 / ORG-9 / BILL-6 (admin-and-org P4, 20261176): BEFORE UPDATE guard on orgs. Refuses (42501) any change to subscription_status, subscribed_plan, trial_ends_at, current_period_end, stripe_customer_id or stripe_subscription_id unless the request runs as service_role (the Stripe webhook, checkout, restore); a session with no request role (the SQL editor) passes. orgs_admin_write is unchanged.';

REVOKE ALL ON FUNCTION orgs_billing_columns_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orgs_billing_columns_guard ON orgs;
CREATE TRIGGER trg_orgs_billing_columns_guard
  BEFORE UPDATE ON orgs
  FOR EACH ROW EXECUTE FUNCTION orgs_billing_columns_guard();

COMMIT;

-- ── Self-test (always rolled back; results kept for the final SELECT) ────
DROP TABLE IF EXISTS pg_temp._ao_g76_selftest;
CREATE TEMP TABLE _ao_g76_selftest (k text PRIMARY KEY, ok boolean);
DO $$
DECLARE
  v_org uuid;
  v_refused boolean := false;
  v_passed boolean := false;
BEGIN
  SELECT id INTO v_org FROM orgs ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN
    INSERT INTO _ao_g76_selftest VALUES ('refused', NULL), ('passed', NULL);
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  BEGIN
    UPDATE orgs SET subscribed_plan = COALESCE(subscribed_plan, '') || '-p4-self-test' WHERE id = v_org;
    RAISE EXCEPTION 'P4_SELFTEST_ROLLBACK';
  EXCEPTION
    WHEN insufficient_privilege THEN v_refused := true;
    WHEN raise_exception THEN v_refused := false;
  END;
  BEGIN
    UPDATE orgs SET subscription_status = subscription_status, name = name WHERE id = v_org;
    v_passed := true;
    RAISE EXCEPTION 'P4_SELFTEST_ROLLBACK';
  EXCEPTION
    WHEN raise_exception THEN NULL;
    WHEN insufficient_privilege THEN v_passed := false;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO _ao_g76_selftest VALUES ('refused', v_refused), ('passed', v_passed);
END $$;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'orgs_billing_columns_guard exists: SECURITY INVOKER, search_path pinned to public' AS check,
       EXISTS (SELECT 1 FROM pg_proc
                WHERE proname = 'orgs_billing_columns_guard' AND pronamespace = 'public'::regnamespace
                  AND NOT prosecdef AND proconfig @> ARRAY['search_path=public']) AS ok,
       NULL::text AS n
UNION ALL SELECT 'the guard compares all six billing columns with IS DISTINCT FROM and lets only service_role or no request role through',
       (SELECT prosrc LIKE '%IF auth.role() IS NULL OR auth.role() = ''service_role'' THEN%'
           AND prosrc LIKE '%NEW.subscription_status IS DISTINCT FROM OLD.subscription_status%'
           AND prosrc LIKE '%NEW.subscribed_plan IS DISTINCT FROM OLD.subscribed_plan%'
           AND prosrc LIKE '%NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at%'
           AND prosrc LIKE '%NEW.current_period_end IS DISTINCT FROM OLD.current_period_end%'
           AND prosrc LIKE '%NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id%'
           AND prosrc LIKE '%NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id%'
           AND prosrc LIKE '%USING ERRCODE = ''insufficient_privilege''%'
          FROM pg_proc WHERE proname = 'orgs_billing_columns_guard' AND pronamespace = 'public'::regnamespace), NULL
UNION ALL SELECT 'EXECUTE on the guard is revoked from PUBLIC, anon and authenticated (DRLS-16)',
       NOT has_function_privilege('anon', 'public.orgs_billing_columns_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.orgs_billing_columns_guard()', 'EXECUTE'), NULL
UNION ALL SELECT 'trg_orgs_billing_columns_guard: BEFORE UPDATE, FOR EACH ROW, on orgs, enabled',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_orgs_billing_columns_guard' AND t.tgrelid = to_regclass('public.orgs')
                  AND NOT t.tgisinternal AND t.tgenabled = 'O'
                  AND t.tgfoid = to_regprocedure('public.orgs_billing_columns_guard()')
                  AND (t.tgtype & 1) = 1      -- ROW
                  AND (t.tgtype & 2) = 2      -- BEFORE
                  AND (t.tgtype & 16) = 16    -- UPDATE
                  AND (t.tgtype & 4) = 0      -- not INSERT
                  AND (t.tgtype & 8) = 0), NULL  -- not DELETE
UNION ALL SELECT 'orgs_admin_write is kept as 20261046 left it (FOR UPDATE, by caller_holds_any_role)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'orgs' AND policyname = 'orgs_admin_write'
                  AND cmd = 'UPDATE' AND qual LIKE '%caller_holds_any_role(%'), NULL
UNION ALL SELECT 'BILL-3: no canceled workspace carries a plan (the inventory row counts the plans this paste cleared)',
       NOT EXISTS (SELECT 1 FROM orgs WHERE subscription_status = 'canceled' AND subscribed_plan IS NOT NULL), NULL
UNION ALL SELECT 'orgs: RLS still on',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.orgs')), false), NULL
UNION ALL SELECT 'self-test: a request with the authenticated role changing subscribed_plan is refused 42501 (NULL = no orgs row to test on; rolled back)',
       (SELECT ok FROM _ao_g76_selftest WHERE k = 'refused'), NULL
UNION ALL SELECT 'self-test: the same request updating the row with the billing columns left as they are passes (NULL = no orgs row; rolled back)',
       (SELECT ok FROM _ao_g76_selftest WHERE k = 'passed'), NULL
UNION ALL SELECT inventory, NULL, n FROM _ao_g76_before;
