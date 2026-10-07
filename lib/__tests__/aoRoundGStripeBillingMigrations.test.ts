// admin-and-org Round G, package P4 — shape tests over the two one-paste
// migrations (DEC-30: a guard, a TEMP inventory of counts before ONE
// transaction, ONE final (check, ok, n) SELECT) and over what they rely on.
//
//   20261175 (migration A) — the stripe_events ledger and the per-customer
//     stripe_event_locks (BILL-4) and the UNIQUE partial index on
//     orgs(stripe_customer_id) (BILL-6 / ORG-9 / BILL-8), built only in the
//     world with no duplicates.
//   20261176 (migration B) — the BEFORE UPDATE guard on orgs that refuses a
//     member's change to the six billing columns (BILL-2 / ORG-9 / BILL-6);
//     orgs_admin_write (20261046) is not re-created; a canceled workspace's
//     plan is cleared, counted before and probed after (BILL-3).
//
// Neither file re-creates an existing object: the table, the index, the
// function and the trigger are new, and no earlier migration defines any of
// them or any other trigger on orgs (scanned below), so there is no earlier
// body to carry byte for byte. Both were pasted on PostgreSQL 16 against the
// real definitions they touch (schema.sql's orgs and audit_logs, 20260601,
// 20261045's caller_holds_any_role, 20261046's orgs_admin_write): every probe
// true (A's unique-index probe false only in the duplicates world, as
// designed), both re-runs idempotent, an Admin's numbering save passes and
// each billing column change is refused 42501 (recorded in 04-billing.md).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const MIGRATIONS = join(root, "supabase", "migrations");
const numbered = readdirSync(MIGRATIONS).filter((n) => /^\d{8}.*\.sql$/.test(n)).sort();
const A_FILE = "20261175_ao_roundG_stripe_events_ledger.sql";
const B_FILE = "20261176_ao_roundG_orgs_billing_columns_guard.sql";
const load = (f: string) => {
  const raw = readFileSync(join(MIGRATIONS, f), "utf8");
  const sql = raw.replace(/--[^\n]*/g, "");
  return {
    raw, sql,
    ddl: sql.slice(sql.indexOf("\nBEGIN;"), sql.indexOf("\nCOMMIT;")),
    tail: sql.slice(sql.indexOf("\nCOMMIT;") + "\nCOMMIT;".length),
    inventory: sql.slice(sql.indexOf("CREATE TEMP TABLE"), sql.indexOf("\nBEGIN;")),
  };
};
const A = load(A_FILE);
const B = load(B_FILE);
const BILLING = ["subscription_status", "subscribed_plan", "trial_ends_at", "current_period_end", "stripe_customer_id", "stripe_subscription_id"];
const others = numbered.filter((f) => f !== A_FILE && f !== B_FILE).map((f) => ({ f, sql: readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "") }));

describe("20261175 / 20261176 — numbering and the one-paste shape (DEC-30)", () => {
  it("each is the only file at its reserved number", () => {
    expect(numbered.filter((f) => f.startsWith("20261175"))).toEqual([A_FILE]);
    expect(numbered.filter((f) => f.startsWith("20261176"))).toEqual([B_FILE]);
  });

  for (const [name, m, tempName] of [[A_FILE, A, "_ao_g75_before"], [B_FILE, B, "_ao_g76_before"]] as const) {
    it(`${name}: guard, TEMP inventory before ONE transaction, then ONE final (check, ok, n) SELECT ending the file`, () => {
      const guard = m.sql.indexOf("RAISE EXCEPTION '2026117");
      const temp = m.sql.indexOf(`CREATE TEMP TABLE ${tempName}`);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(temp);
      expect(temp).toBeLessThan(m.sql.indexOf("\nBEGIN;"));
      expect(m.sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(m.sql.match(/^COMMIT;$/gm)).toHaveLength(1);
      const finalSelect = m.tail.slice(m.tail.lastIndexOf("\nSELECT '")).trim();
      expect(finalSelect).toMatch(/^SELECT '[^']+' AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
      expect(finalSelect).toMatch(new RegExp(`UNION ALL SELECT inventory, NULL, n FROM ${tempName};$`));
      expect(finalSelect.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((x) => x.trim()).length).toBe(1);
      expect(m.raw).toMatch(/APPLIED BY HAND \(DEC-30\)/);
      expect(m.raw).toMatch(/WHEN TO PASTE: either order with the P4 deploy is safe, and either order\s+-- with 2026117[56]\./);
      expect(m.raw).toMatch(/ROLLBACK:/);
    });

    it(`${name}: the inventory is aggregate counts only — never a row, never a customer id`, () => {
      const parts = m.inventory.split(/UNION ALL/);
      expect(parts.length).toBeGreaterThanOrEqual(5);
      for (const sel of parts) expect(sel).toMatch(/COUNT\(\*\)/);
      expect(m.inventory).not.toMatch(/SELECT \*|row_to_json|json_agg|string_agg|array_agg|to_jsonb\(/i);
      expect(m.inventory).not.toMatch(/SELECT\s+(o\.)?stripe_customer_id\s*(,|AS|::)/i);
    });
  }
});

describe("20261175 — the Stripe event ledger and one workspace per customer", () => {
  it("stripe_events: the event id is the primary key; the outcome is checked against exactly the outcomes the webhook records", () => {
    expect(A.ddl).toMatch(/CREATE TABLE IF NOT EXISTS stripe_events \(\s+id\s+TEXT PRIMARY KEY,\s+type\s+TEXT NOT NULL,\s+event_created\s+TIMESTAMPTZ,\s+subscription_id TEXT,\s+customer_id\s+TEXT,\s+org_id\s+UUID,\s+outcome\s+TEXT NOT NULL CHECK \(outcome IN \('applied', 'stale', 'unresolved', 'superseded', 'ignored'\)\),\s+received_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)\s+\);/);
    const route = readFileSync(join(root, "app", "api", "stripe", "webhook", "route.ts"), "utf8");
    const recorded = new Set(Array.from(route.matchAll(/settle\("(\w+)"/g), (x) => x[1]));
    expect([...recorded].sort()).toEqual(["applied", "ignored", "stale", "superseded", "unresolved"]);
    expect(route).toMatch(/type Outcome = "applied" \| "duplicate" \| "stale" \| "unresolved" \| "superseded" \| "ignored";/);
    // the webhook's reads match the index: by id, and by (subscription_id, outcome in the
    // ordering set, event_created >) — a newer subscription event applied or superseded,
    // a newer invoice event applied
    expect(A.ddl).toMatch(/CREATE INDEX IF NOT EXISTS stripe_events_subscription_order_idx\s+ON stripe_events \(subscription_id, event_created DESC\)\s+WHERE outcome IN \('applied', 'superseded'\);/);
    expect(route).toMatch(/const ORDERING_OUTCOMES = \["applied", "superseded"\] as const;/);
    expect(route).toMatch(/\.eq\("subscription_id", subscriptionId\)\.in\("outcome", ORDERING_OUTCOMES\)\.like\("type", "customer\.subscription\.%"\)\.gt\("event_created", createdIso\)\.limit\(1\)/);
    expect(route).toMatch(/\.eq\("subscription_id", subscriptionId\)\.eq\("outcome", "applied"\)\.like\("type", "invoice\.%"\)\.gt\("event_created", createdIso\)\.limit\(1\)/);
    // second review fix pass: an incomplete snapshot counts a same-second snapshot as
    // newer (gte); a recorded deletion, at any time, holds back every non-ended snapshot —
    // both read the same index (subscription_id, over applied and superseded rows)
    expect(route).toMatch(/\.eq\("subscription_id", subscriptionId\)\.in\("outcome", ORDERING_OUTCOMES\)\.like\("type", "customer\.subscription\.%"\)\.gte\("event_created", createdIso\)\.limit\(1\)/);
    expect(route).toMatch(/\.eq\("subscription_id", subscriptionId\)\.in\("outcome", ORDERING_OUTCOMES\)\.eq\("type", "customer\.subscription\.deleted"\)\.limit\(1\)/);
    expect(A.tail).toMatch(/indexname = 'stripe_events_subscription_order_idx'[\s\S]*indexdef LIKE '%WHERE \(outcome = ANY \(ARRAY\[%applied%superseded%'/);
    expect(route).toMatch(/const LEDGER_MIGRATION = "20261175_ao_roundG_stripe_events_ledger\.sql";/);
  });

  it("service role only: RLS on, no policy, every client role's privilege revoked", () => {
    expect(A.ddl).toMatch(/ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;/);
    expect(A.ddl).toMatch(/REVOKE ALL ON stripe_events FROM PUBLIC, anon, authenticated;/);
    expect(A.ddl).toMatch(/GRANT SELECT, INSERT ON stripe_events TO service_role;/);
    expect(A.sql).not.toMatch(/CREATE POLICY/i);
    expect(A.tail).toMatch(/NOT EXISTS \(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stripe_events'\)/);
  });

  it("two worlds: the unique index is built only when no customer id is shared at paste time; nothing is rewritten", () => {
    expect(A.ddl).toMatch(/IF NOT EXISTS \(SELECT 1 FROM orgs WHERE stripe_customer_id IS NOT NULL\s+GROUP BY stripe_customer_id HAVING COUNT\(\*\) > 1\) THEN\s+CREATE UNIQUE INDEX IF NOT EXISTS orgs_stripe_customer_unique\s+ON orgs \(stripe_customer_id\) WHERE stripe_customer_id IS NOT NULL;\s+ELSE\s+RAISE NOTICE/);
    expect(A.sql).not.toMatch(/^\s*(UPDATE|DELETE FROM)\s+orgs\b/im);
    expect(A.sql).not.toMatch(/DROP INDEX[^;]*orgs_stripe_customer_idx/i);
    expect(A.tail).toMatch(/indexdef LIKE 'CREATE UNIQUE INDEX%\(stripe_customer_id\)%WHERE \(stripe_customer_id IS NOT NULL\)%'/);
    expect(A.tail).toMatch(/after: Stripe customer ids still claimed by more than one workspace/);
  });

  it("stripe_event_locks: one row per customer (lock_for the primary key), service role may read, insert and delete; RLS on, no policy", () => {
    expect(A.ddl).toMatch(/CREATE TABLE IF NOT EXISTS stripe_event_locks \(\s+lock_for\s+TEXT PRIMARY KEY,\s+event_id\s+TEXT NOT NULL,\s+locked_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)\s+\);/);
    expect(A.ddl).toMatch(/ALTER TABLE stripe_event_locks ENABLE ROW LEVEL SECURITY;/);
    expect(A.ddl).toMatch(/REVOKE ALL ON stripe_event_locks FROM PUBLIC, anon, authenticated;/);
    expect(A.ddl).toMatch(/GRANT SELECT, INSERT, DELETE ON stripe_event_locks TO service_role;/);
    expect(A.tail).toMatch(/pg_get_constraintdef\(oid\) = 'PRIMARY KEY \(lock_for\)'/);
    expect(A.tail).toMatch(/NOT EXISTS \(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stripe_event_locks'\)/);
    expect(A.tail).toMatch(/has_table_privilege\('service_role', 'public\.stripe_event_locks', 'DELETE'\)/);
    // the route writes the columns the table has, and its lease is the header's
    const route = readFileSync(join(root, "app", "api", "stripe", "webhook", "route.ts"), "utf8");
    expect(route).toMatch(/\.from\("stripe_event_locks"\)\.insert\(\{ lock_for: key, event_id: eventId \}\)/);
    expect(route).toMatch(/\.from\("stripe_event_locks"\)\.delete\(\)\.eq\("lock_for", key\)\.lt\("locked_at", lapsed\)/);
    expect(route).toMatch(/\.from\("stripe_event_locks"\)\.delete\(\)\.eq\("lock_for", key\)\.eq\("event_id", eventId\)/);
    expect(route).toMatch(/const LOCK_LEASE_MS = 60_000;/);
    expect(A.raw).toMatch(/A row older\s+--\s+than 60 seconds belongs to a run that died/);
  });

  it("no earlier migration defines stripe_events, stripe_event_locks or the unique index", () => {
    for (const { f, sql } of others) {
      expect(sql, f).not.toMatch(/\bstripe_events\b/);
      expect(sql, f).not.toMatch(/\bstripe_event_locks\b/);
      expect(sql, f).not.toMatch(/orgs_stripe_customer_unique/);
    }
  });
});

describe("20261176 — the orgs billing-columns guard", () => {
  const fn = B.ddl.slice(B.ddl.indexOf("CREATE OR REPLACE FUNCTION orgs_billing_columns_guard()"), B.ddl.indexOf("$$;") + 3);

  it("SECURITY INVOKER, search_path pinned, the service-role / no-request idiom of 20261121, every billing column compared, refusal 42501", () => {
    expect(fn).toMatch(/^CREATE OR REPLACE FUNCTION orgs_billing_columns_guard\(\)\nRETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS \$\$/);
    expect(fn).toMatch(/IF auth\.role\(\) IS NULL OR auth\.role\(\) = 'service_role' THEN\s+RETURN NEW;\s+END IF;/);
    const compared = Array.from(fn.matchAll(/NEW\.(\w+) IS DISTINCT FROM OLD\.(\w+)/g), (x) => { expect(x[1]).toBe(x[2]); return x[1]; });
    expect(compared).toEqual(BILLING);
    expect(fn).toMatch(/USING ERRCODE = 'insufficient_privilege';/);
    expect(fn).not.toMatch(/NEW\.\w+ := OLD/); // pinned by refusal, never silently reset
    // the idiom is the one the newest guard of this shape uses
    expect(readFileSync(join(MIGRATIONS, "20261121_intel_roundG_semantic_layer.sql"), "utf8")).toMatch(/IF auth\.role\(\) IS NULL OR auth\.role\(\) = 'service_role' THEN\s+RETURN NEW;/);
  });

  it("the six columns are exactly the billing columns 20260601 added to orgs", () => {
    const billing = readFileSync(join(MIGRATIONS, "20260601_billing.sql"), "utf8");
    const added = Array.from(billing.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g), (x) => x[1]);
    expect(added).toEqual(BILLING);
  });

  it("DRLS-16: EXECUTE revoked from PUBLIC, anon and authenticated; the trigger is BEFORE UPDATE FOR EACH ROW on orgs", () => {
    expect(B.ddl).toMatch(/REVOKE ALL ON FUNCTION orgs_billing_columns_guard\(\) FROM PUBLIC, anon, authenticated;/);
    expect(B.ddl).toMatch(/DROP TRIGGER IF EXISTS trg_orgs_billing_columns_guard ON orgs;\s+CREATE TRIGGER trg_orgs_billing_columns_guard\s+BEFORE UPDATE ON orgs\s+FOR EACH ROW EXECUTE FUNCTION orgs_billing_columns_guard\(\);/);
  });

  it("orgs_admin_write is not re-created or dropped (20261046 stays the newest definition); no policy, grant or column change", () => {
    expect(B.sql).not.toMatch(/(CREATE|DROP|ALTER)\s+POLICY/i);
    expect(B.sql).not.toMatch(/^\s*GRANT\s/m);
    expect(B.sql).not.toMatch(/ALTER TABLE\s+orgs/i);
    const definers = others.filter(({ sql }) => /CREATE POLICY\s+"?orgs_admin_write"?/i.test(sql)).map(({ f }) => f);
    expect(definers).toEqual(["20261046_rp_phase6_sweep_authority_by_collection.sql"]);
    expect(B.tail).toMatch(/policyname = 'orgs_admin_write'\s+AND cmd = 'UPDATE' AND qual LIKE '%caller_holds_any_role\(%'/);
  });

  it("it is the first trigger on orgs: no earlier migration (or schema.sql) defines one, or the guard function", () => {
    const schema = readFileSync(join(root, "supabase", "schema.sql"), "utf8").replace(/--[^\n]*/g, "");
    for (const { f, sql } of [...others, { f: "schema.sql", sql: schema }]) {
      expect(sql, f).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER[^;]*\bON\s+(public\.)?orgs\b/i);
      expect(sql, f).not.toMatch(/orgs_billing_columns_guard/);
    }
  });

  it("BILL-3: inside the transaction, before the trigger, the plan is cleared on canceled workspaces only — counted before, probed after", () => {
    const backfill = /UPDATE orgs SET subscribed_plan = NULL\n WHERE subscription_status = 'canceled' AND subscribed_plan IS NOT NULL;/;
    expect(B.ddl).toMatch(backfill);
    expect(B.ddl.search(backfill)).toBeLessThan(B.ddl.indexOf("CREATE TRIGGER trg_orgs_billing_columns_guard"));
    // the only orgs UPDATE outside the always-rolled-back self-test
    expect(B.ddl.match(/^\s*UPDATE orgs\b/gm)).toHaveLength(1);
    expect(B.inventory).toMatch(/'canceled_with_plan'[\s\S]*cleared by this paste \(BILL-3\)'[\s\S]*\(SELECT COUNT\(\*\) FROM orgs WHERE subscription_status = 'canceled' AND subscribed_plan IS NOT NULL\)::text/);
    expect(B.tail).toMatch(/NOT EXISTS \(SELECT 1 FROM orgs WHERE subscription_status = 'canceled' AND subscribed_plan IS NOT NULL\), NULL/);
  });

  it("the self-test runs after COMMIT, in subtransactions it always rolls back, and feeds two probes", () => {
    const selfTest = B.tail.slice(0, B.tail.lastIndexOf("\nSELECT '"));
    expect(selfTest).toMatch(/PERFORM set_config\('request\.jwt\.claims', '\{"role":"authenticated"\}', true\);/);
    expect(selfTest).toMatch(/UPDATE orgs SET subscribed_plan = COALESCE\(subscribed_plan, ''\) \|\| '-p4-self-test' WHERE id = v_org;\s+RAISE EXCEPTION 'P4_SELFTEST_ROLLBACK';\s+EXCEPTION\s+WHEN insufficient_privilege THEN v_refused := true;/);
    expect(selfTest).toMatch(/UPDATE orgs SET subscription_status = subscription_status, name = name WHERE id = v_org;\s+v_passed := true;\s+RAISE EXCEPTION 'P4_SELFTEST_ROLLBACK';/);
    expect(selfTest).toMatch(/PERFORM set_config\('request\.jwt\.claims', '', true\);/);
    expect(B.tail).toMatch(/\(SELECT ok FROM _ao_g76_selftest WHERE k = 'refused'\)/);
    expect(B.tail).toMatch(/\(SELECT ok FROM _ao_g76_selftest WHERE k = 'passed'\)/);
  });
});
