-- 20261175_ao_roundG_stripe_events_ledger.sql
--
-- admin-and-org Round G, package P4 — migration A.
--   BILL-4 Done-when 2 / 3: "A stripe_events table records processed event
--     ids (unique) and the handler no-ops on a duplicate"; "Subscription-state
--     writes are guarded by the event's created timestamp" — read under a
--     per-customer lock (stripe_event_locks), so two deliveries Stripe makes
--     at once cannot both pass the guard.
--   BILL-6 Done-when 2 / ORG-9 Done-when 2 / BILL-8 Done-when 2: "A UNIQUE
--     index exists on orgs(stripe_customer_id) WHERE NOT NULL".
--
-- WHY: the Stripe webhook (app/api/stripe/webhook/route.ts) had no record of
-- the events it handled. Stripe delivers at least once and in no guaranteed
-- order, so a redelivered event was applied again and a late
-- customer.subscription.updated (status active) written over the canceled
-- state a newer customer.subscription.deleted had set — the workspace
-- resurrected as active on a subscription Stripe had ended. And orgs carried
-- only a NON-unique index on stripe_customer_id (20260601_billing.sql:31), so
-- two workspaces could claim one Stripe customer: the webhook's lookup by
-- customer then matched two rows and the event was dropped without a trace.
--
-- WHAT:
--   1. stripe_events — one row per Stripe event the webhook handled:
--        id             TEXT PRIMARY KEY  Stripe's event id (evt_…): the
--                                         duplicate guard.
--        type           TEXT NOT NULL     the event type.
--        event_created  TIMESTAMPTZ       Stripe's event.created: the
--                                         ordering key.
--        subscription_id TEXT             the subscription the event is about
--                                         (an invoice's subscription).
--        customer_id    TEXT
--        org_id         UUID              the workspace it resolved to (no
--                                         foreign key: deleting a workspace
--                                         never waits on its billing history).
--        outcome        TEXT NOT NULL     applied | stale (older than a newer
--                                         event recorded for its subscription:
--                                         recorded, not applied) | unresolved
--                                         (no workspace holds the customer) |
--                                         superseded (a subscription the
--                                         workspace is not on, or a status the
--                                         workspace is not in) | ignored (an
--                                         invoice that is not the current
--                                         subscription's).
--        received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
--      The webhook reads it by id (the primary key) and by "a newer event for
--      this subscription": a customer.subscription.* event applied or
--      superseded (a newer snapshot of the subscription — the older one is
--      stale), or an invoice.* event applied (a newer status — an older
--      subscription event still writes its plan, period end and id, not its
--      status) (stripe_events_subscription_order_idx). RLS is on with no
--      policy and every client role's privilege is revoked: only the service
--      role (the webhook) reads or writes it. No row is ever updated or
--      deleted by the app.
--   2. stripe_event_locks — one row per Stripe customer whose event the
--      webhook is applying right now:
--        lock_for   TEXT PRIMARY KEY   the event's customer id (its
--                                      subscription id if it names none).
--        event_id   TEXT NOT NULL      the delivery holding it.
--        locked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
--      The webhook inserts the row before it reads the ledger and deletes its
--      own row when done: a second delivery for the same customer is refused
--      23505 and waits (about 1.6 s, then 503 — Stripe retries). A row older
--      than 60 seconds belongs to a run that died and is deleted by the next
--      delivery. Service role only (SELECT, INSERT, DELETE); RLS on, no
--      policy. Empty whenever no delivery is running.
--   3. orgs_stripe_customer_unique — UNIQUE (stripe_customer_id) WHERE
--      stripe_customer_id IS NOT NULL. Two worlds (DEC-30): it is built only
--      when no two workspaces share a customer id at the moment of the paste;
--      otherwise it is NOT built, nothing is rewritten, and the final rows
--      count the duplicates (clear the stray ids — they are service-role-only
--      after 20261176 — and paste again). The non-unique
--      orgs_stripe_customer_idx (20260601) is kept.
--
-- WIDENING? No: two new service-role-only tables and a uniqueness rail. The
-- before-apply inventory (aggregate counts only, never a customer id) says
-- whether this is a first apply and how many workspaces share a customer.
--
-- WHEN TO PASTE: either order with the P4 deploy is safe, and either order
-- with 20261176.
--   - Before the paste, the new webhook finds no stripe_events or
--     stripe_event_locks table (PostgREST PGRST205 / Postgres 42P01) and
--     applies every event as the old code did — no duplicate, ordering or
--     one-at-a-time guard — logging that the ledger is absent and saying so
--     on each audit row (details.ledger = "absent").
--     Its other fixes (checked writes, machine audit rows, the status map,
--     the subscription guards) do not need this paste.
--   - Pasted before the deploy, the old webhook never reads the tables, and the
--     unique index refuses only a second workspace claiming a customer one
--     already holds (the old checkout's customer write ignores the refusal,
--     as it ignored every error; the new one answers 500).
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS orgs_stripe_customer_unique;
--   DROP TABLE IF EXISTS stripe_event_locks;
--   DROP TABLE IF EXISTS stripe_events;
-- The webhook keeps working (it treats the absent ledger as before the paste).
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count). Until it is pasted, behaviour is as above.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'orgs' AND column_name = 'stripe_customer_id') THEN
    RAISE EXCEPTION '20261175 needs 20260601 (orgs.stripe_customer_id) — paste 20260601_billing.sql first. Nothing was changed.';
  END IF;
END $$;

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ao_g75_before;
CREATE TEMP TABLE _ao_g75_before AS
SELECT 'ledger' AS k,
       'inventory: stripe_events present before this paste (0 = a first apply, 1 = a re-run)' AS inventory,
       (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
         WHERE s.nspname = 'public' AND c.relname = 'stripe_events' AND c.relkind = 'r')::text AS n
UNION ALL
SELECT 'locks',
       'inventory: stripe_event_locks present before this paste (0 = a first apply, 1 = a re-run)',
       (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
         WHERE s.nspname = 'public' AND c.relname = 'stripe_event_locks' AND c.relkind = 'r')::text
UNION ALL
SELECT 'unique_present',
       'inventory: orgs_stripe_customer_unique present before this paste (0 = a first apply or the duplicates world, 1 = a re-run)',
       (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
         WHERE s.nspname = 'public' AND c.relname = 'orgs_stripe_customer_unique' AND c.relkind = 'i')::text
UNION ALL
SELECT 'customers',
       'inventory: workspaces carrying a Stripe customer id',
       (SELECT COUNT(*) FROM orgs WHERE stripe_customer_id IS NOT NULL)::text
UNION ALL
SELECT 'dup_customers',
       'inventory: Stripe customer ids claimed by more than one workspace (0 = the unique index is built; otherwise it is not, and nothing is rewritten)',
       (SELECT COUNT(*) FROM (SELECT stripe_customer_id FROM orgs WHERE stripe_customer_id IS NOT NULL
                               GROUP BY stripe_customer_id HAVING COUNT(*) > 1) d)::text
UNION ALL
SELECT 'dup_orgs',
       'inventory: workspaces sharing their Stripe customer id with another workspace (the webhook answers 409 for these customers until they are cleared)',
       (SELECT COUNT(*) FROM orgs o
         WHERE o.stripe_customer_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM orgs x WHERE x.stripe_customer_id = o.stripe_customer_id AND x.id <> o.id))::text
UNION ALL
SELECT 'blank_customers',
       'inventory: workspaces whose Stripe customer id is an empty string (never written by the app — a hand edit; it counts as a value for uniqueness)',
       (SELECT COUNT(*) FROM orgs WHERE stripe_customer_id = '')::text;

BEGIN;

-- ── 1. the Stripe event ledger (BILL-4) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_events (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  event_created   TIMESTAMPTZ,
  subscription_id TEXT,
  customer_id     TEXT,
  org_id          UUID,
  outcome         TEXT NOT NULL CHECK (outcome IN ('applied', 'stale', 'unresolved', 'superseded', 'ignored')),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_events_subscription_order_idx
  ON stripe_events (subscription_id, event_created DESC)
  WHERE outcome IN ('applied', 'superseded');

ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stripe_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON stripe_events TO service_role;

COMMENT ON TABLE stripe_events IS
  'BILL-4 (admin-and-org P4, 20261175): one row per Stripe event the webhook handled, keyed on Stripe''s event id (a redelivery is a no-op). outcome: applied | stale (older than a newer event recorded for its subscription — recorded, not applied) | unresolved | superseded | ignored. Service role only.';

-- ── 2. one event per Stripe customer at a time (BILL-4) ──────────────────
CREATE TABLE IF NOT EXISTS stripe_event_locks (
  lock_for   TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  locked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE stripe_event_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stripe_event_locks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON stripe_event_locks TO service_role;

COMMENT ON TABLE stripe_event_locks IS
  'BILL-4 (admin-and-org P4, 20261175): the Stripe webhook applies one event per Stripe customer at a time. A delivery inserts its customer''s row (a second one is refused 23505 and waits, then answers 503) and deletes it when done; a row older than 60 seconds is a run that died and is broken by the next delivery. Service role only; empty while no delivery runs.';

-- ── 3. one workspace per Stripe customer (BILL-6 / ORG-9 / BILL-8) ───────
-- Two worlds (DEC-30): built only when no customer id is shared right now.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE stripe_customer_id IS NOT NULL
                  GROUP BY stripe_customer_id HAVING COUNT(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS orgs_stripe_customer_unique
      ON orgs (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
  ELSE
    RAISE NOTICE '20261175: orgs_stripe_customer_unique NOT built — some Stripe customer ids are claimed by more than one workspace (counted in the result). Clear the stray ids and paste again.';
  END IF;
END $$;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'stripe_events exists with its eight columns, id the primary key' AS check,
       (SELECT COUNT(*) = 8 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'stripe_events'
           AND column_name IN ('id', 'type', 'event_created', 'subscription_id', 'customer_id', 'org_id', 'outcome', 'received_at'))
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = to_regclass('public.stripe_events') AND contype = 'p'
                      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)') AS ok,
       NULL::text AS n
UNION ALL SELECT 'stripe_events.outcome is checked against the five outcomes',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = to_regclass('public.stripe_events') AND contype = 'c'
                  AND pg_get_constraintdef(oid) LIKE '%applied%stale%unresolved%superseded%ignored%'), NULL
UNION ALL SELECT 'the ordering index: (subscription_id, event_created DESC) over applied and superseded events',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'stripe_events' AND indexname = 'stripe_events_subscription_order_idx'
                  AND indexdef LIKE '%(subscription_id, event_created DESC)%' AND indexdef LIKE '%WHERE (outcome = ANY (ARRAY[%applied%superseded%'), NULL
UNION ALL SELECT 'stripe_events: RLS on, no policy (service role only)',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.stripe_events')), false)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stripe_events'), NULL
UNION ALL SELECT 'stripe_events: anon and authenticated hold no privilege on it',
       NOT has_table_privilege('anon', 'public.stripe_events', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.stripe_events', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.stripe_events', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.stripe_events', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.stripe_events', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.stripe_events', 'DELETE'), NULL
UNION ALL SELECT 'stripe_events: the service role may read and insert',
       has_table_privilege('service_role', 'public.stripe_events', 'SELECT')
       AND has_table_privilege('service_role', 'public.stripe_events', 'INSERT'), NULL
UNION ALL SELECT 'stripe_event_locks exists with its three columns, lock_for the primary key',
       (SELECT COUNT(*) = 3 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'stripe_event_locks'
           AND column_name IN ('lock_for', 'event_id', 'locked_at'))
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = to_regclass('public.stripe_event_locks') AND contype = 'p'
                      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (lock_for)'), NULL
UNION ALL SELECT 'stripe_event_locks: RLS on, no policy; anon and authenticated hold no privilege; the service role may read, insert and delete',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.stripe_event_locks')), false)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stripe_event_locks')
       AND NOT has_table_privilege('anon', 'public.stripe_event_locks', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.stripe_event_locks', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.stripe_event_locks', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.stripe_event_locks', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.stripe_event_locks', 'DELETE')
       AND has_table_privilege('service_role', 'public.stripe_event_locks', 'SELECT')
       AND has_table_privilege('service_role', 'public.stripe_event_locks', 'INSERT')
       AND has_table_privilege('service_role', 'public.stripe_event_locks', 'DELETE'), NULL
UNION ALL SELECT 'one workspace per Stripe customer: orgs_stripe_customer_unique is a UNIQUE partial index (false only in the world where duplicates remain — counted below; clear them and paste again)',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'orgs' AND indexname = 'orgs_stripe_customer_unique'
                  AND indexdef LIKE 'CREATE UNIQUE INDEX%(stripe_customer_id)%WHERE (stripe_customer_id IS NOT NULL)%'), NULL
UNION ALL SELECT 'orgs_stripe_customer_idx (20260601) is kept',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'orgs' AND indexname = 'orgs_stripe_customer_idx'), NULL
UNION ALL SELECT 'after: Stripe customer ids still claimed by more than one workspace (0 = the unique index is built)', NULL,
       (SELECT COUNT(*) FROM (SELECT stripe_customer_id FROM orgs WHERE stripe_customer_id IS NOT NULL
                               GROUP BY stripe_customer_id HAVING COUNT(*) > 1) d)::text
UNION ALL SELECT 'after: stripe_events rows (0 on a first apply; the webhook adds one per event it handles)', NULL,
       (SELECT COUNT(*) FROM stripe_events)::text
UNION ALL SELECT 'after: stripe_event_locks rows (0 while no delivery is running)', NULL,
       (SELECT COUNT(*) FROM stripe_event_locks)::text
UNION ALL SELECT inventory, NULL, n FROM _ao_g75_before;
