// lib/__tests__/stripeWebhook.test.ts
//
// admin-and-org Round G, package P4 — the Stripe webhook, entitlement and the
// orgs billing columns.
//
//   BILL-9  the webhook's audit rows are machine rows (DEC-87 §2: user_id
//           NULL, user_email system:stripe-webhook, user_role system), every
//           one CHECKED: a refused row answers non-2xx so Stripe retries.
//   BILL-4  every orgs write is checked (non-2xx on failure); the
//           stripe_events ledger dedupes on Stripe's event id and refuses to
//           apply a subscription snapshot older than a newer one recorded for
//           that subscription (recorded, not applied), while one older only
//           than an applied invoice event still writes its plan and period
//           but not its status; one event per customer runs at a time
//           (stripe_event_locks); an invoice moves only the workspace's
//           current subscription, a failed one only demotes.
//   BILL-1  incomplete / unknown statuses map to a non-access value and never
//           write a plan; every status string is pinned.
//   BILL-3  customer.subscription.deleted clears subscribed_plan (Done-when
//           1 is XEDGE-14's price-derived plan, kept).
//   BILL-6  an ambiguous customer match answers non-2xx (Stripe retries, the
//           operator sees it) instead of dropping the event; the portal
//           refuses a customer another workspace's metadata names.
//   BILL-8  checkout refuses (409) a second live subscription; the customer
//           write is checked; customer creation carries an idempotency key.
//
// REGRESSION FIRST: every legitimate flow (checkout for a trial workspace,
// the portal, each event the route handled before for the workspace's own
// subscription) writes the orgs row exactly as it did.
//
// The database is a small in-memory stand-in (vi.hoisted `state.tables`),
// faithful where the routes depend on it: eq / neq / is / gt / lt / in /
// like / or filters, order + limit, maybeSingle's PGRST116 on more than one
// row, filtered deletes, missing stripe_events / stripe_event_locks tables
// answered PGRST205 (the world before 20261175 is pasted),
// stripe_events.id and stripe_event_locks.lock_for UNIQUE (23505), the lock's
// locked_at default, and injected write errors. Every await on it yields, so
// two deliveries run with Promise.all interleave as concurrent requests do.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
type Err = { code: string; message: string };

const state = vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_PRICE_STARTER = "price_s";
  process.env.STRIPE_PRICE_GROWTH = "price_g";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  return {
    event: null as unknown,
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    ledger: true,
    writeError: null as null | ((table: string, op: string, payload: unknown) => { code: string; message: string } | null),
    readError: null as null | ((table: string) => { code: string; message: string } | null),
    log: [] as Array<{ table: string; op: string; payload: unknown }>,
    roles: ["Admin"] as string[],
    stripeCalls: [] as Array<{ m: string; args: unknown[] }>,
    customers: {} as Record<string, Record<string, unknown>>,
    subscriptions: {} as Record<string, Record<string, unknown>>,
    stripeError: null as null | ((m: string) => Error | null),
  };
});

// ── the in-memory database ───────────────────────────────────────────────
function rowsOf(table: string): Row[] { return (state.tables[table] ??= []); }
function missingLedger(table: string): Err | null {
  return (table === "stripe_events" || table === "stripe_event_locks") && !state.ledger
    ? { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` }
    : null;
}
/** PostgREST like: % any run, _ any one character, everything else literal. */
function likeRe(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${body}$`);
}
function orTerm(term: string): (r: Row) => boolean {
  const m = /^(\w+)\.(eq|is)\.(.*)$/.exec(term.trim());
  if (!m) throw new Error(`unsupported or() term ${term}`);
  const [, col, op, rawV] = m;
  const v = rawV.startsWith('"') && rawV.endsWith('"') ? rawV.slice(1, -1) : rawV;
  if (op === "is") return (r) => (r[col] ?? null) === null && v === "null";
  return (r) => r[col] !== null && r[col] !== undefined && String(r[col]) === v;
}
function from(table: string) {
  let op = "select"; let payload: unknown; let returning = false; let single = false; let maybe = false;
  let limit: number | null = null;
  const orders: Array<{ col: string; asc: boolean }> = [];
  const filters: Array<(r: Row) => boolean> = [];
  const b: Record<string, unknown> = {
    select: () => { if (op !== "select") returning = true; return b; },
    insert: (p: unknown) => { op = "insert"; payload = p; return b; },
    upsert: (p: unknown) => { op = "upsert"; payload = p; return b; },
    update: (p: unknown) => { op = "update"; payload = p; return b; },
    delete: () => { op = "delete"; return b; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] !== undefined && r[c] !== null && String(r[c]) === String(v)); return b; },
    neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== undefined && r[c] !== null && String(r[c]) !== String(v)); return b; },
    is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
    gt: (c: string, v: unknown) => { filters.push((r) => r[c] !== null && r[c] !== undefined && String(r[c]) > String(v)); return b; },
    lt: (c: string, v: unknown) => { filters.push((r) => r[c] !== null && r[c] !== undefined && String(r[c]) < String(v)); return b; },
    in: (c: string, vs: readonly unknown[]) => { filters.push((r) => r[c] !== null && r[c] !== undefined && vs.map(String).includes(String(r[c]))); return b; },
    like: (c: string, p: string) => { const re = likeRe(p); filters.push((r) => typeof r[c] === "string" && re.test(r[c] as string)); return b; },
    or: (expr: string) => { const fs = expr.split(",").map(orTerm); filters.push((r) => fs.some((f) => f(r))); return b; },
    order: (c: string, o?: { ascending?: boolean }) => { orders.push({ col: c, asc: o?.ascending !== false }); return b; },
    limit: (n: number) => { limit = n; return b; },
    maybeSingle: () => { maybe = true; return b; },
    single: () => { single = true; return b; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      try { res(exec()); } catch (e) { rej(e); }
    },
  };
  function exec(): { data: unknown; error: Err | null } {
    state.log.push({ table, op, payload });
    const missing = missingLedger(table);
    if (missing) return { data: null, error: missing };
    const all = rowsOf(table);
    if (op === "select") {
      const injected = state.readError?.(table);
      if (injected) return { data: null, error: injected };
      let hit = all.filter((r) => filters.every((f) => f(r)));
      for (const o of [...orders].reverse()) hit = [...hit].sort((x, y) => (String(x[o.col]) < String(y[o.col]) ? -1 : String(x[o.col]) > String(y[o.col]) ? 1 : 0) * (o.asc ? 1 : -1));
      if (limit !== null) hit = hit.slice(0, limit);
      if (maybe || single) {
        if (hit.length > 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        if (single && hit.length === 0) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        return { data: hit[0] ? { ...hit[0] } : null, error: null };
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    const injected = state.writeError?.(table, op, payload);
    if (injected) return { data: null, error: injected };
    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
      if (table === "stripe_events") {
        for (const r of list) if (all.some((x) => x.id === r.id)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "stripe_events_pkey"' } };
      }
      if (table === "stripe_event_locks") {
        for (const r of list) if (all.some((x) => x.lock_for === r.lock_for)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "stripe_event_locks_pkey"' } };
      }
      const defaults: Row = table === "stripe_event_locks" ? { locked_at: new Date().toISOString() } : {};
      for (const r of list) all.push({ ...defaults, ...r });
      return { data: returning ? list.map((r) => ({ ...r })) : null, error: null };
    }
    if (op === "update") {
      const hit = all.filter((r) => filters.every((f) => f(r)));
      for (const r of hit) Object.assign(r, payload as Row);
      return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    if (op === "delete") {
      const hit = all.filter((r) => filters.every((f) => f(r)));
      state.tables[table] = all.filter((r) => !hit.includes(r));
      return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    return { data: null, error: null };
  }
  return b;
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from }) }));
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string, allowed: string[]) => {
    if (!orgId) return { error: "orgId is required", status: 400 };
    if (!state.roles.some((r) => allowed.includes(r))) return { error: "Insufficient role", status: 403 };
    return { userId: "u-admin", email: "admin@acme.com", orgId, role: state.roles[0], roles: [...state.roles], admin: { from } };
  }),
}));
vi.mock("@/lib/stripe", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/stripe")>();
  const call = (m: string, fn: (...a: unknown[]) => unknown) => async (...args: unknown[]) => {
    state.stripeCalls.push({ m, args });
    const err = state.stripeError?.(m);
    if (err) throw err;
    return fn(...args);
  };
  const stripe = {
    webhooks: { constructEvent: (b: string, sig: string) => { if (sig !== "sig") throw new Error("No signatures found matching the expected signature"); return b && b !== "{}" ? JSON.parse(b) : state.event; } },
    customers: {
      create: call("customers.create", (p) => {
        const id = `cus_new_${state.stripeCalls.filter((c) => c.m === "customers.create").length}`;
        state.customers[id] = { id, ...(p as Row) };
        return state.customers[id];
      }),
      retrieve: call("customers.retrieve", (id) => {
        const c = state.customers[String(id)];
        if (!c) { const e = new Error(`No such customer: '${String(id)}'`) as Error & { code?: string; statusCode?: number }; e.code = "resource_missing"; e.statusCode = 404; throw e; }
        return c;
      }),
    },
    subscriptions: {
      retrieve: call("subscriptions.retrieve", (id) => {
        const s = state.subscriptions[String(id)];
        if (!s) { const e = new Error(`No such subscription: '${String(id)}'`) as Error & { code?: string; statusCode?: number }; e.code = "resource_missing"; e.statusCode = 404; throw e; }
        return s;
      }),
    },
    checkout: { sessions: { create: call("checkout.sessions.create", () => ({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" })) } },
    billingPortal: { sessions: { create: call("billingPortal.sessions.create", () => ({ id: "bps_1", url: "https://billing.stripe.test/bps_1" })) } },
  };
  return { ...real, getStripe: () => stripe, isStripeConfigured: () => true };
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  mapStripeStatus, ACCESS_STATUSES, LIVE_STRIPE_STATUSES, BILLED_STRIPE_STATUSES, PLAN_HOLDING_STRIPE_STATUSES, UNSTARTED_STRIPE_STATUSES,
  holdsLiveSubscription, hasAccess, type SubscriptionStatus,
} from "@/lib/subscription";
import { customerIdempotencyKey } from "@/lib/stripe";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";
import { POST as portalPOST } from "@/app/api/stripe/portal/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const T0 = 1_800_000_000;

const deliver = (sig = "sig") => webhookPOST(new NextRequest("https://app/api/stripe/webhook", {
  method: "POST", headers: { "stripe-signature": sig }, body: "{}",
}));
/** One delivery of a given event (the body carries it), for concurrent runs. */
const deliverEvent = (event: unknown) => webhookPOST(new NextRequest("https://app/api/stripe/webhook", {
  method: "POST", headers: { "stripe-signature": "sig" }, body: JSON.stringify(event),
}));
const post = (url: string, body: unknown) => new NextRequest(`https://app${url}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json", origin: "https://app" }, body: JSON.stringify(body),
});

function subEvent(type: string, o: { id?: string; created?: number; sub?: string; status?: string; price?: string | null; metadata?: Record<string, string>; customer?: string } = {}) {
  return {
    id: o.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    type,
    created: o.created ?? T0,
    data: {
      object: {
        id: o.sub ?? "sub_1",
        object: "subscription",
        status: o.status ?? "active",
        customer: o.customer ?? "cus_1",
        metadata: o.metadata ?? { org_id: ORG, plan: "starter" },
        items: { data: o.price === null ? [] : [{ price: { id: o.price ?? "price_g" } }] },
        current_period_end: T0 + 30 * 86400,
      },
    },
  };
}
function invEvent(type: string, o: { id?: string; created?: number; sub?: string | null; customer?: string; attempt?: number } = {}) {
  return {
    id: o.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    type,
    created: o.created ?? T0,
    data: { object: { id: "in_1", object: "invoice", customer: o.customer ?? "cus_1", subscription: o.sub === undefined ? "sub_1" : o.sub, attempt_count: o.attempt ?? 1 } },
  };
}
const org = (id = ORG) => rowsOf("orgs").find((r) => r.id === id)!;
const audits = (action?: string) => rowsOf("audit_logs").filter((r) => !action || r.action === action);

function seed(over: Row = {}) {
  state.tables = {
    orgs: [{
      id: ORG, name: "Acme", subscription_status: "trialing", subscribed_plan: null,
      trial_ends_at: "2099-01-01T00:00:00.000Z", current_period_end: null,
      stripe_customer_id: "cus_1", stripe_subscription_id: null, ...over,
    }],
    audit_logs: [],
    stripe_events: [],
  };
}

beforeEach(() => {
  state.ledger = true; state.writeError = null; state.readError = null; state.log = [];
  state.roles = ["Admin"]; state.stripeCalls = []; state.stripeError = null;
  state.customers = { cus_1: { id: "cus_1", metadata: { org_id: ORG } } };
  state.subscriptions = {};
  seed();
});

// ─── REGRESSION FIRST: the legitimate flows, exactly as before ───────────

describe("regression — every legitimate webhook event for the workspace's own subscription writes orgs as before", () => {
  it("subscription.created (active, Growth price) → active, growth, the subscription id and the period end", async () => {
    state.event = subEvent("customer.subscription.created");
    const res = await deliver();
    expect(res.status).toBe(200);
    expect(org()).toMatchObject({
      subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1",
      current_period_end: new Date((T0 + 30 * 86400) * 1000).toISOString(),
    });
  });

  it("subscription.updated (past_due) → past_due, plan and subscription id kept current", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.updated", { status: "past_due" });
    expect((await deliver()).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
  });

  it("subscription.updated from the portal (Starter price, stale Growth metadata) → starter (XEDGE-14 kept)", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.updated", { price: "price_s", metadata: { org_id: ORG, plan: "growth" } });
    expect((await deliver()).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "active", subscribed_plan: "starter" });
  });

  it("subscription.deleted for the current subscription → canceled, subscription id cleared", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.deleted", { status: "canceled" });
    expect((await deliver()).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "canceled", stripe_subscription_id: null });
  });

  it("invoice.payment_succeeded for the current subscription → active (resolved by customer)", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_succeeded");
    expect((await deliver()).status).toBe(200);
    expect(org().subscription_status).toBe("active");
  });

  it("invoice.payment_failed → past_due (resolved by customer)", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_failed", { attempt: 2 });
    expect((await deliver()).status).toBe(200);
    expect(org().subscription_status).toBe("past_due");
  });

  it("an event type the route does not handle answers 200 and writes nothing; a bad signature is 400", async () => {
    state.event = { id: "evt_x", type: "charge.refunded", created: T0, data: { object: {} } };
    expect((await deliver()).status).toBe(200);
    expect(state.log.filter((l) => l.op !== "select")).toEqual([]);
    expect((await deliver("forged")).status).toBe(400);
  });
});

describe("regression — checkout and the portal for a workspace with no live subscription", () => {
  it("a trial workspace with no customer: the customer is created, recorded on the org, and the session is minted with the org's metadata", async () => {
    seed({ stripe_customer_id: null });
    const res = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://checkout.stripe.test/cs_1");
    const created = state.stripeCalls.find((c) => c.m === "customers.create")!;
    expect(created.args[0]).toMatchObject({ email: "admin@acme.com", metadata: { org_id: ORG, signup_user_id: "u-admin" } });
    expect(org().stripe_customer_id).toBe("cus_new_1");
    const session = state.stripeCalls.find((c) => c.m === "checkout.sessions.create")!.args[0] as Row;
    expect(session).toMatchObject({ customer: "cus_new_1", mode: "subscription", line_items: [{ price: "price_g", quantity: 1 }], subscription_data: { metadata: { org_id: ORG, plan: "growth" } } });
    expect(audits("STRIPE_CHECKOUT_CREATED")).toHaveLength(1);
    expect(audits("STRIPE_CHECKOUT_CREATED")[0]).toMatchObject({ user_id: "u-admin", org_id: ORG });
  });

  it("a workspace with a customer and a canceled subscription reuses the customer and subscribes again", async () => {
    seed({ subscription_status: "canceled", stripe_subscription_id: null });
    const res = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "starter" }));
    expect(res.status).toBe(200);
    expect(state.stripeCalls.some((c) => c.m === "customers.create")).toBe(false);
    expect((state.stripeCalls.find((c) => c.m === "checkout.sessions.create")!.args[0] as Row).customer).toBe("cus_1");
  });

  it("the portal opens for the workspace's own customer", async () => {
    const res = await portalPOST(post("/api/stripe/portal", { orgId: ORG }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://billing.stripe.test/bps_1");
    expect((state.stripeCalls.find((c) => c.m === "billingPortal.sessions.create")!.args[0] as Row).customer).toBe("cus_1");
  });

  it("a Viewer is refused checkout and the portal (the role constant is unchanged)", async () => {
    state.roles = ["Viewer"];
    expect((await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }))).status).toBe(403);
    expect((await portalPOST(post("/api/stripe/portal", { orgId: ORG }))).status).toBe(403);
  });
});

// ─── reproductions (fail on f5073fc) ─────────────────────────────────────

describe("BILL-9 — the webhook's audit rows are checked machine rows (DEC-87 §2)", () => {
  it("subscription.created writes user_id NULL, user_email system:stripe-webhook, user_role system", async () => {
    state.event = subEvent("customer.subscription.created");
    await deliver();
    const row = audits("STRIPE_CUSTOMER_SUBSCRIPTION_CREATED")[0];
    expect(row).toMatchObject({ user_id: null, user_email: "system:stripe-webhook", user_role: "system", org_id: ORG, resource_type: "org", resource_id: ORG });
    expect((row.details as Row).channel).toBe("stripe-webhook");
  });

  it("a refused audit row answers non-2xx so Stripe retries", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.writeError = (t) => (t === "audit_logs" ? { code: "22P02", message: "invalid input syntax for type uuid" } : null);
    state.event = invEvent("invoice.payment_failed");
    const res = await deliver();
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("BILL-4 — checked writes, a ledger and an ordering guard", () => {
  it("a refused orgs update answers non-2xx", async () => {
    state.writeError = (t, op) => (t === "orgs" && op === "update" ? { code: "XX000", message: "db down" } : null);
    state.event = subEvent("customer.subscription.updated");
    expect((await deliver()).status).toBeGreaterThanOrEqual(500);
  });

  it("the same event delivered twice is applied once", async () => {
    state.event = subEvent("customer.subscription.created", { id: "evt_dup" });
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);
    expect(audits("STRIPE_CUSTOMER_SUBSCRIPTION_CREATED")).toHaveLength(1);
  });

  it("an older updated (active) delivered after the deleted is recorded, not applied: the org stays canceled", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.deleted", { id: "evt_del", created: T0 + 200, status: "canceled" });
    expect((await deliver()).status).toBe(200);
    state.event = subEvent("customer.subscription.updated", { id: "evt_old", created: T0 + 100, status: "active" });
    expect((await deliver()).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "canceled", stripe_subscription_id: null });
  });

  it("invoice.payment_succeeded for another subscription or a one-off invoice does not promote", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_succeeded", { sub: "sub_other" });
    expect((await deliver()).status).toBe(200);
    expect(org().subscription_status).toBe("past_due");
    state.event = invEvent("invoice.payment_succeeded", { sub: null });
    expect((await deliver()).status).toBe(200);
    expect(org().subscription_status).toBe("past_due");
  });
});

describe("BILL-1 — an unpaid or unknown status never grants access", () => {
  // A workspace already on the subscription (the row the old code wrote:
  // trialing with the subscription id) — the map's value is what is stored.
  it("incomplete (first payment never completed) is stored as a non-access status and writes no plan", async () => {
    seed({ subscription_status: "trialing", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.created", { status: "incomplete" });
    expect((await deliver()).status).toBe(200);
    expect(org().subscription_status).not.toBe("trialing");
    expect(["canceled", "unpaid", "paused"]).toContain(org().subscription_status);
    expect(org().subscribed_plan).toBeNull();
  });

  it("an unknown future status maps to a non-access status, never trialing", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      state.event = subEvent("customer.subscription.updated", { status: "some_future_status" });
      expect((await deliver()).status).toBe(200);
      expect(["canceled", "unpaid", "paused"]).toContain(org().subscription_status);
    } finally { warn.mockRestore(); }
  });
});

describe("BILL-3 — cancellation clears the plan", () => {
  it("subscription.deleted clears subscribed_plan", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.deleted", { status: "canceled" });
    await deliver();
    expect(org().subscribed_plan).toBeNull();
  });
});

describe("cross-subscription — a subscription the workspace is not on cannot take its access away", () => {
  it("deleted for an old subscription leaves the workspace on its current one untouched", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_new" });
    state.event = subEvent("customer.subscription.deleted", { sub: "sub_old", status: "canceled" });
    expect((await deliver()).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_new" });
  });
});

describe("BILL-6 — an ambiguous customer is surfaced; the portal checks whose customer it is", () => {
  it("two workspaces claiming one customer: the invoice event answers non-2xx and writes nothing", async () => {
    seed({ subscription_status: "active", stripe_subscription_id: "sub_1" });
    rowsOf("orgs").push({ id: OTHER, name: "Beta", subscription_status: "trialing", stripe_customer_id: "cus_1", stripe_subscription_id: null });
    state.event = invEvent("invoice.payment_failed");
    const res = await deliver();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/More than one workspace claims Stripe customer cus_1; nothing was written/);
    expect(org().subscription_status).toBe("active");
    expect(org(OTHER).subscription_status).toBe("trialing");
  });

  it("the portal refuses a customer whose metadata names another workspace", async () => {
    state.customers.cus_1 = { id: "cus_1", metadata: { org_id: OTHER } };
    const res = await portalPOST(post("/api/stripe/portal", { orgId: ORG }));
    expect(res.status).toBe(409);
    expect(state.stripeCalls.some((c) => c.m === "billingPortal.sessions.create")).toBe(false);
  });
});

describe("BILL-8 — one live subscription per workspace; the customer write is checked and idempotent", () => {
  it("checkout refuses 409 when the workspace already has a live subscription", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.subscriptions.sub_1 = { id: "sub_1", status: "past_due" };
    const res = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
    expect(res.status).toBe(409);
    expect(state.stripeCalls.some((c) => c.m === "checkout.sessions.create")).toBe(false);
  });

  it("a refused customer-id write answers non-2xx and mints no checkout session", async () => {
    seed({ stripe_customer_id: null });
    state.writeError = (t, op) => (t === "orgs" && op === "update" ? { code: "XX000", message: "db down" } : null);
    const res = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(state.stripeCalls.some((c) => c.m === "checkout.sessions.create")).toBe(false);
  });

  it("customer creation carries an idempotency key derived from the org id", async () => {
    seed({ stripe_customer_id: null });
    await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
    const created = state.stripeCalls.find((c) => c.m === "customers.create")!;
    expect((created.args[1] as { idempotencyKey?: string } | undefined)?.idempotencyKey).toContain(ORG);
  });
});

// ─── BILL-1 Done-when 3: every Stripe status, one unknown, the stored value ─

const STRIPE_STATUSES: Array<[string, SubscriptionStatus, boolean]> = [
  // [Stripe status, stored orgs.subscription_status, plan written]
  ["active", "active", true],
  ["trialing", "trialing", true],
  ["past_due", "past_due", true],
  ["canceled", "canceled", false],
  ["incomplete_expired", "canceled", false],
  ["unpaid", "unpaid", false],
  ["paused", "paused", false],
  ["incomplete", "unpaid", false],
  ["a_status_stripe_adds_later", "unpaid", false],
];
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("BILL-1 — the status map (lib/subscription.ts mapStripeStatus)", () => {
  it("maps each Stripe status as the table says; incomplete and unknown never to active or trialing", () => {
    for (const [stripe, stored] of STRIPE_STATUSES) expect(mapStripeStatus(stripe).status, stripe).toBe(stored);
    expect(mapStripeStatus("a_status_stripe_adds_later").known).toBe(false);
    expect(mapStripeStatus(undefined)).toEqual({ status: "unpaid", known: false });
    expect(mapStripeStatus("incomplete").known).toBe(true);
    for (const s of ["incomplete", "incomplete_expired", "unpaid", "nope"]) {
      expect(["active", "trialing"]).not.toContain(mapStripeStatus(s).status);
      expect(hasAccess({ status: mapStripeStatus(s).status }), s).toBe(false);
    }
  });

  it("every value the map can store is one the orgs CHECK constraint allows (20260601, never altered since)", () => {
    const billing = src("supabase/migrations/20260601_billing.sql");
    const m = /subscription_status TEXT NOT NULL DEFAULT 'trialing'\s+CHECK \(subscription_status IN \(([^)]*)\)\)/.exec(billing);
    expect(m).not.toBeNull();
    const allowed = m![1].split(",").map((x) => x.trim().replace(/'/g, ""));
    for (const [, stored] of STRIPE_STATUSES) expect(allowed, stored).toContain(stored);
    // no later migration re-defines the constraint
    const dir = join(process.cwd(), "supabase", "migrations");
    const later = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f) && f > "20260601_billing.sql")
      .filter((f) => /CHECK\s*\(\s*subscription_status\s+IN|CONSTRAINT\s+\w*subscription_status\w*/i.test(readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "")));
    expect(later).toEqual([]);
  });

  it("the sets agree with hasAccess: ACCESS_STATUSES are exactly the statuses hasAccess admits (trial clock aside)", () => {
    for (const s of ["trialing", "active", "past_due", "canceled", "unpaid", "paused"] as SubscriptionStatus[]) {
      expect(ACCESS_STATUSES.has(s), s).toBe(hasAccess({ status: s, trialEndsAt: "2999-01-01T00:00:00.000Z" }));
    }
    expect([...PLAN_HOLDING_STRIPE_STATUSES].sort()).toEqual(["active", "past_due", "trialing"]);
    expect([...LIVE_STRIPE_STATUSES].sort()).toEqual(["active", "past_due", "paused", "trialing", "unpaid"]);
    // review fix pass: a paused subscription raises no invoice and the portal cannot resume it
    expect([...BILLED_STRIPE_STATUSES].sort()).toEqual(["active", "past_due", "trialing", "unpaid"]);
    expect([...UNSTARTED_STRIPE_STATUSES].sort()).toEqual(["incomplete", "incomplete_expired"]);
    expect(holdsLiveSubscription({ status: "past_due", stripeSubscriptionId: "sub_1" })).toBe(true);
    expect(holdsLiveSubscription({ status: "unpaid", stripeSubscriptionId: "sub_1" })).toBe(true);
    expect(holdsLiveSubscription({ status: "paused", stripeSubscriptionId: "sub_1" })).toBe(false);
    expect(holdsLiveSubscription({ status: "canceled", stripeSubscriptionId: "sub_1" })).toBe(false);
    expect(holdsLiveSubscription({ status: "trialing", stripeSubscriptionId: null })).toBe(false);
    expect(holdsLiveSubscription(null)).toBe(false);
  });

  it.each(STRIPE_STATUSES)("through the webhook: Stripe %s is stored as %s (plan written: %s)", async (stripe, stored, planWritten) => {
    // the workspace is on the subscription (a subscription that never started,
    // or an unknown status, changes only such a workspace: DEC-44 (A&O P4) §6)
    seed({ subscription_status: "active", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.updated", { status: stripe });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try { expect((await deliver()).status).toBe(200); } finally { warn.mockRestore(); }
    expect(org().subscription_status).toBe(stored);
    expect(org().subscribed_plan).toBe(planWritten ? "growth" : null);
    const row = audits("STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED")[0];
    expect((row.details as Row).stripe_status).toBe(stripe);
    expect((row.details as Row).mapped_status).toBe(stored);
    if (stripe === "a_status_stripe_adds_later") expect((row.details as Row).status_unknown).toBe(true);
    if (!planWritten) expect((row.details as Row).plan).toBeNull();
  });
});

describe("BILL-1 / DEC-44 (A&O P4) §6 — a declined first checkout leaves the app's trial running; a retry that pays takes over; the old one's expiry changes nothing", () => {
  it("incomplete → superseded (trial kept); its first failed invoice ignored; sub_2 active → active growth; sub_1 incomplete_expired later → superseded", async () => {
    // review fix pass: on f5073fc+P4 the workspace read "unpaid", then "canceled" with the trial lost
    state.event = subEvent("customer.subscription.created", { id: "evt_a", created: T0, sub: "sub_1", status: "incomplete" });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "superseded" });
    expect(org()).toMatchObject({ subscription_status: "trialing", subscribed_plan: null, stripe_subscription_id: null, trial_ends_at: "2099-01-01T00:00:00.000Z" });
    // the first invoice's payment_failed for sub_1 does not hand out past_due (an access status)
    state.event = invEvent("invoice.payment_failed", { id: "evt_b", created: T0 + 1, sub: "sub_1" });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "ignored" });
    expect(org().subscription_status).toBe("trialing");
    // the admin tries another card: a second subscription, paid
    state.event = subEvent("customer.subscription.created", { id: "evt_c", created: T0 + 60, sub: "sub_2", status: "active" });
    expect((await deliver()).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_2" });
    // 23 hours later Stripe expires sub_1
    state.event = subEvent("customer.subscription.updated", { id: "evt_d", created: T0 + 82_800, sub: "sub_1", status: "incomplete_expired" });
    const res = await deliver();
    expect(await res.json()).toMatchObject({ received: true, outcome: "superseded" });
    expect(org()).toMatchObject({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_2" });
    expect(rowsOf("stripe_events").map((e) => [e.id, e.outcome])).toEqual([
      ["evt_a", "superseded"], ["evt_b", "ignored"], ["evt_c", "applied"], ["evt_d", "superseded"],
    ]);
  });

  it("with no retry: incomplete then incomplete_expired leave the app's trial exactly as it was", async () => {
    state.event = subEvent("customer.subscription.created", { id: "evt_a", created: T0, sub: "sub_1", status: "incomplete" });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "superseded" });
    state.event = subEvent("customer.subscription.updated", { id: "evt_b", created: T0 + 82_800, sub: "sub_1", status: "incomplete_expired" });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "superseded" });
    expect(org()).toMatchObject({ subscription_status: "trialing", subscribed_plan: null, stripe_subscription_id: null, trial_ends_at: "2099-01-01T00:00:00.000Z" });
    expect(audits()).toEqual([]);
  });

  it("an unknown status for a subscription the workspace is not on changes nothing, and is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      state.event = subEvent("customer.subscription.updated", { sub: "sub_x", status: "a_status_stripe_adds_later" });
      expect(await (await deliver()).json()).toMatchObject({ outcome: "superseded" });
      expect(org()).toMatchObject({ subscription_status: "trialing", stripe_subscription_id: null });
      expect(warn.mock.calls.some((c) => /unknown Stripe status "a_status_stripe_adds_later"/.test(String(c[0])))).toBe(true);
    } finally { warn.mockRestore(); }
  });
});

describe("BILL-4 — an invoice is correlated in either Stripe API shape", () => {
  it("a payload in the 2025-03+ shape (parent.subscription_details.subscription) promotes the current subscription, as the old shape does", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = {
      id: "evt_basil", type: "invoice.payment_succeeded", created: T0,
      data: { object: { id: "in_2", object: "invoice", customer: "cus_1", parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } }, attempt_count: 1 } },
    };
    expect(await (await deliver()).json()).toEqual({ received: true, outcome: "applied" });
    expect(org().subscription_status).toBe("active");
    expect((audits("STRIPE_INVOICE_PAYMENT_SUCCEEDED")[0].details as Row).subscription_id).toBe("sub_1");
  });
});

describe("BILL-4 — the ledger in both worlds", () => {
  it("an applied event is recorded with its id, type, created time, subscription, customer, workspace and outcome", async () => {
    state.event = subEvent("customer.subscription.created", { id: "evt_rec", created: T0 + 5 });
    await deliver();
    expect(rowsOf("stripe_events")).toEqual([{
      id: "evt_rec", type: "customer.subscription.created", event_created: new Date((T0 + 5) * 1000).toISOString(),
      subscription_id: "sub_1", customer_id: "cus_1", org_id: ORG, outcome: "applied",
    }]);
    // the duplicate answers 200 with no second write to orgs, audit_logs or the ledger
    // (the only writes are the customer lock's insert and release)
    state.log = [];
    expect(await (await deliver()).json()).toEqual({ received: true, outcome: "duplicate" });
    expect(state.log.filter((l) => l.op !== "select" && l.table !== "stripe_event_locks")).toEqual([]);
    expect(rowsOf("stripe_event_locks")).toEqual([]);
  });

  it("a stale event is recorded as stale and writes nothing to orgs or audit_logs", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.updated", { id: "evt_new", created: T0 + 100, status: "past_due" });
    await deliver();
    state.log = [];
    state.event = subEvent("customer.subscription.updated", { id: "evt_old", created: T0 + 50, status: "active" });
    expect(await (await deliver()).json()).toEqual({ received: true, outcome: "stale" });
    expect(org().subscription_status).toBe("past_due");
    expect(state.log.filter((l) => l.op !== "select").map((l) => `${l.table}:${l.op}`)).toEqual(["stripe_event_locks:insert", "stripe_events:insert", "stripe_event_locks:delete"]);
    expect(rowsOf("stripe_events").find((e) => e.id === "evt_old")).toMatchObject({ outcome: "stale", org_id: null });
    // an event in the same second as the last applied one is not "older": applied
    state.event = subEvent("customer.subscription.updated", { id: "evt_same", created: T0 + 100, status: "active" });
    expect(await (await deliver()).json()).toEqual({ received: true, outcome: "applied" });
    expect(org().subscription_status).toBe("active");
  });

  it("before 20261175 is pasted (no stripe_events table): every event is applied as before, the audit row says the ledger is absent", async () => {
    state.ledger = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      state.event = subEvent("customer.subscription.created", { id: "evt_x" });
      expect((await deliver()).status).toBe(200);
      expect(org()).toMatchObject({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
      expect((audits("STRIPE_CUSTOMER_SUBSCRIPTION_CREATED")[0].details as Row).ledger).toBe("absent");
      expect(warn.mock.calls.some((c) => /stripe_events ledger is absent \(20261175_ao_roundG_stripe_events_ledger\.sql not pasted\)/.test(String(c[0])))).toBe(true);
      // and Postgres's own spelling of the missing table is recognised too
      state.ledger = true;
      state.readError = (t) => (t === "stripe_events" ? { code: "42P01", message: 'relation "stripe_events" does not exist' } : null);
      state.event = subEvent("customer.subscription.updated", { id: "evt_y", status: "past_due" });
      expect((await deliver()).status).toBe(200);
      expect(org().subscription_status).toBe("past_due");
    } finally { warn.mockRestore(); }
  });

  it("a ledger read or write that fails for another reason answers non-2xx (Stripe retries)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.readError = (t) => (t === "stripe_events" ? { code: "57014", message: "canceling statement due to statement timeout" } : null);
      state.event = subEvent("customer.subscription.updated");
      expect((await deliver()).status).toBe(500);
      expect(org().subscription_status).toBe("trialing");
      state.readError = null;
      state.writeError = (t, op) => (t === "stripe_events" && op === "insert" ? { code: "XX000", message: "disk full" } : null);
      const res = await deliver();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/not recorded in the Stripe event ledger \(disk full\)/);
    } finally { err.mockRestore(); }
  });

  it("an event for a customer no workspace holds is recorded unresolved and answers 200, as before", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      state.event = invEvent("invoice.payment_failed", { id: "evt_u", customer: "cus_nobody" });
      expect(await (await deliver()).json()).toEqual({ received: true, outcome: "unresolved" });
      expect(rowsOf("stripe_events")[0]).toMatchObject({ id: "evt_u", outcome: "unresolved", customer_id: "cus_nobody", org_id: null });
    } finally { warn.mockRestore(); }
  });
});

describe("BILL-9 — every handled event writes its machine row; a refused one is retried", () => {
  it("deleted, payment_succeeded and payment_failed rows are machine rows naming the event", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_succeeded", { id: "evt_ok", created: T0 + 1 });
    await deliver();
    state.event = invEvent("invoice.payment_failed", { id: "evt_fail", created: T0 + 2, attempt: 3 });
    await deliver();
    state.event = subEvent("customer.subscription.deleted", { id: "evt_del", created: T0 + 3, status: "canceled" });
    await deliver();
    const rows = audits();
    expect(rows.map((r) => r.action)).toEqual(["STRIPE_INVOICE_PAYMENT_SUCCEEDED", "STRIPE_INVOICE_PAYMENT_FAILED", "STRIPE_CUSTOMER_SUBSCRIPTION_DELETED"]);
    for (const r of rows) expect(r).toMatchObject({ user_id: null, user_email: "system:stripe-webhook", user_role: "system", org_id: ORG, resource_type: "org" });
    expect(rows.map((r) => (r.details as Row).event_id)).toEqual(["evt_ok", "evt_fail", "evt_del"]);
    expect(rows[1].details).toMatchObject({ channel: "stripe-webhook", attempt: 3, subscription_id: "sub_1", invoice_id: "in_1" });
    expect(rows[2].details).toMatchObject({ plan_cleared: true });
    expect(org()).toMatchObject({ subscription_status: "canceled", subscribed_plan: null, stripe_subscription_id: null });
  });

  it("the retry after a refused audit row applies the event again and writes the row (the ledger was not written)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.writeError = (t) => (t === "audit_logs" ? { code: "XX000", message: "audit down" } : null);
      state.event = subEvent("customer.subscription.created", { id: "evt_retry" });
      const first = await deliver();
      expect(first.status).toBe(500);
      expect((await first.json()).error).toMatch(/its audit row was not \(audit down\); Stripe will retry/);
      expect(rowsOf("stripe_events")).toEqual([]);
      state.writeError = null;
      expect((await deliver()).status).toBe(200);
      expect(audits("STRIPE_CUSTOMER_SUBSCRIPTION_CREATED")).toHaveLength(1);
      expect(rowsOf("stripe_events")).toHaveLength(1);
    } finally { err.mockRestore(); }
  });

  it("no audit insert in the webhook names a person or the string 'stripe' (source pin)", () => {
    const w = src("app/api/stripe/webhook/route.ts");
    expect(w).not.toMatch(/user_id: "stripe"/);
    expect(w).not.toMatch(/user_email: "stripe-webhook"/);
    expect(w).toMatch(/const STRIPE_WEBHOOK_ACTOR = \{ email: "system:stripe-webhook", role: "system" \} as const;/);
    expect(w.match(/from\("audit_logs"\)\.insert\(/g)).toHaveLength(1);
    expect(w).toMatch(/user_id: null,\n\s+user_email: STRIPE_WEBHOOK_ACTOR\.email,\n\s+user_role: STRIPE_WEBHOOK_ACTOR\.role,/);
  });
});

describe("BILL-6 — the portal's ownership check, and its regressions", () => {
  it("a customer with no org metadata (made before checkout stamped it) opens, as before", async () => {
    state.customers.cus_1 = { id: "cus_1", metadata: {} };
    expect((await portalPOST(post("/api/stripe/portal", { orgId: ORG }))).status).toBe(200);
  });

  it("a deleted or unknown customer is refused 409; a Stripe outage is 502; none mints a session", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.customers.cus_1 = { id: "cus_1", deleted: true };
      expect((await portalPOST(post("/api/stripe/portal", { orgId: ORG }))).status).toBe(409);
      delete state.customers.cus_1;
      expect((await portalPOST(post("/api/stripe/portal", { orgId: ORG }))).status).toBe(409);
      state.customers.cus_1 = { id: "cus_1", metadata: { org_id: ORG } };
      state.stripeError = (m) => (m === "customers.retrieve" ? new Error("Stripe is down") : null);
      expect((await portalPOST(post("/api/stripe/portal", { orgId: ORG }))).status).toBe(502);
      expect(state.stripeCalls.some((c) => c.m === "billingPortal.sessions.create")).toBe(false);
    } finally { err.mockRestore(); }
  });

  it("a workspace with no customer is told to subscribe first, as before (400, no Stripe call)", async () => {
    seed({ stripe_customer_id: null });
    expect((await portalPOST(post("/api/stripe/portal", { orgId: ORG }))).status).toBe(400);
    expect(state.stripeCalls).toEqual([]);
  });
});

describe("BILL-8 — the checkout refusal is confirmed with Stripe; the trial path makes no extra call", () => {
  it("a trial workspace (no subscription id) never asks Stripe about a subscription", async () => {
    await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
    expect(state.stripeCalls.map((c) => c.m)).toEqual(["checkout.sessions.create"]);
  });

  it("a row that says live but Stripe says ended (canceled, incomplete_expired, incomplete, or gone) or paused does not block", async () => {
    for (const status of ["canceled", "incomplete_expired", "incomplete", "paused", null]) {
      seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
      state.subscriptions = status ? { sub_1: { id: "sub_1", status } } : {};
      state.stripeCalls = [];
      const res = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
      expect(res.status, String(status)).toBe(200);
    }
  });

  it("every billed Stripe status is refused 409 with the portal pointer; a Stripe outage is 502; nothing is minted", async () => {
    for (const status of ["active", "trialing", "past_due"]) {
      seed({ subscription_status: mapStripeStatus(status).status, stripe_subscription_id: "sub_1" });
      state.subscriptions = { sub_1: { id: "sub_1", status } };
      const res = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
      expect(res.status, status).toBe(409);
      expect((await res.json()).error).toMatch(/already has a subscription .*Manage subscription \/ payment.*bill the workspace twice/);
    }
    // unpaid: Stripe raises its invoices without charging them — refused, without "billed twice"
    seed({ subscription_status: "unpaid", stripe_subscription_id: "sub_1" });
    state.subscriptions = { sub_1: { id: "sub_1", status: "unpaid" } };
    const unpaid = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
    expect(unpaid.status).toBe(409);
    const unpaidError = (await unpaid.json()).error as string;
    expect(unpaidError).toMatch(/already has a subscription \(unpaid\).*keeps raising its invoices without charging them.*Manage subscription \/ payment.*pay the open invoice/);
    expect(unpaidError).not.toMatch(/bill the workspace twice/);
    seed({ subscription_status: "past_due", stripe_subscription_id: "sub_1" });
    state.stripeError = (m) => (m === "subscriptions.retrieve" ? new Error("Stripe is down") : null);
    expect((await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }))).status).toBe(502);
    expect(state.stripeCalls.some((c) => c.m === "checkout.sessions.create")).toBe(false);
  });

  it("the idempotency key is the org's own, so two clicks get one customer", () => {
    expect(customerIdempotencyKey(ORG)).toBe(`org-customer:${ORG}`);
    expect(customerIdempotencyKey(OTHER)).not.toBe(customerIdempotencyKey(ORG));
  });

  it("a refused org read is a 500, never 'Org not found'; a refused checkout audit row is said in the answer", async () => {
    state.readError = (t) => (t === "orgs" ? { code: "XX000", message: "db down" } : null);
    expect((await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }))).status).toBe(500);
    expect((await portalPOST(post("/api/stripe/portal", { orgId: ORG }))).status).toBe(500);
    state.readError = null;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.writeError = (t) => (t === "audit_logs" ? { code: "XX000", message: "audit down" } : null);
      const res = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ url: "https://checkout.stripe.test/cs_1", warning: expect.stringMatching(/audit down/) });
    } finally { err.mockRestore(); }
  });
});

// ─── P4 review fix pass: each reproduction failed on the first P4 commits ──

const PERIOD = (t: number) => new Date((t + 30 * 86400) * 1000).toISOString();
function subAt(type: string, o: Parameters<typeof subEvent>[1] & { periodFrom?: number }) {
  const e = subEvent(type, o);
  if (o.periodFrom !== undefined) (e.data.object as Row).current_period_end = o.periodFrom + 30 * 86400;
  return e;
}

describe("BILL-4 (review blocker) — an applied invoice event holds back only the status of an older subscription event", () => {
  it("portal upgrade: invoice.payment_succeeded (T+2) applied first, then subscription.updated (T, Growth price) → growth and its period end; the invoice's status kept", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "starter", stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_succeeded", { id: "evt_inv", created: T0 + 2 });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
    expect(org().subscription_status).toBe("active");
    state.event = subAt("customer.subscription.updated", { id: "evt_up", created: T0, status: "past_due", price: "price_g", periodFrom: T0 });
    expect(await (await deliver()).json()).toEqual({ received: true, outcome: "applied" });
    expect(org()).toMatchObject({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1", current_period_end: PERIOD(T0) });
    const row = audits("STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED")[0];
    expect(row.details).toMatchObject({ plan: "growth", stripe_status: "past_due", status_held: "a newer invoice event set the status" });
    expect(rowsOf("stripe_events").map((e) => [e.id, e.outcome])).toEqual([["evt_inv", "applied"], ["evt_up", "applied"]]);
  });

  it("renewal retried after a 500: the subscription.updated (T) lands after the renewal invoice's payment_succeeded (T+1) and still advances the period end", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1", current_period_end: PERIOD(T0 - 30 * 86400) });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.writeError = (t) => (t === "audit_logs" ? { code: "XX000", message: "audit down" } : null);
      const renewal = subAt("customer.subscription.updated", { id: "evt_renew", created: T0, status: "active", price: "price_g", periodFrom: T0 });
      state.event = renewal;
      expect((await deliver()).status).toBe(500);
      state.writeError = null;
      state.event = invEvent("invoice.payment_succeeded", { id: "evt_paid", created: T0 + 1 });
      expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
      state.event = renewal;   // Stripe's retry
      expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
      expect(org()).toMatchObject({ subscription_status: "active", current_period_end: PERIOD(T0) });
    } finally { err.mockRestore(); }
  });

  it("a newer SUBSCRIPTION event still makes an older one stale; an invoice event older than an applied subscription event is stale", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      state.event = subAt("customer.subscription.updated", { id: "evt_new", created: T0 + 10, status: "past_due", price: "price_g", periodFrom: T0 + 10 });
      await deliver();
      state.event = subAt("customer.subscription.updated", { id: "evt_old", created: T0 + 5, status: "active", price: "price_s", periodFrom: T0 });
      expect(await (await deliver()).json()).toMatchObject({ outcome: "stale" });
      expect(org()).toMatchObject({ subscription_status: "past_due", subscribed_plan: "growth", current_period_end: PERIOD(T0 + 10) });
      state.event = invEvent("invoice.payment_succeeded", { id: "evt_old_inv", created: T0 + 6 });
      expect(await (await deliver()).json()).toMatchObject({ outcome: "stale" });
      expect(org().subscription_status).toBe("past_due");
    } finally { warn.mockRestore(); }
  });

  it("an ended subscription's status is final: deleted (T) after an applied invoice event (T+5) still cancels and clears the plan", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_succeeded", { id: "evt_inv", created: T0 + 5 });
    await deliver();
    state.event = subEvent("customer.subscription.deleted", { id: "evt_del", created: T0, status: "canceled" });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
    expect(org()).toMatchObject({ subscription_status: "canceled", subscribed_plan: null, stripe_subscription_id: null });
  });
});

describe("BILL-4 / DEC-44 (A&O P4) §1 (review major) — a failed payment only demotes; a paid one never revives a canceled workspace", () => {
  it("final dunning step, same second, subscription.updated (unpaid) first: the payment_failed is superseded and the workspace stays unpaid", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.updated", { id: "evt_unpaid", created: T0 + 10, status: "unpaid" });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
    state.event = invEvent("invoice.payment_failed", { id: "evt_fail", created: T0 + 10, attempt: 4 });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "superseded" });
    expect(org().subscription_status).toBe("unpaid");
    expect(hasAccess({ status: org().subscription_status as SubscriptionStatus })).toBe(false);
    expect(audits("STRIPE_INVOICE_PAYMENT_FAILED")).toEqual([]);
  });

  it("the same pair, payment_failed first: past_due, then the same-second subscription.updated makes it unpaid", async () => {
    seed({ subscription_status: "past_due", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_failed", { id: "evt_fail", created: T0 + 10, attempt: 4 });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
    state.event = subEvent("customer.subscription.updated", { id: "evt_unpaid", created: T0 + 10, status: "unpaid" });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
    expect(org().subscription_status).toBe("unpaid");
  });

  it("payment_failed still demotes active and trialing; payment_succeeded still lifts unpaid, but never a canceled row", async () => {
    for (const from of ["active", "trialing"]) {
      seed({ subscription_status: from, subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
      state.event = invEvent("invoice.payment_failed");
      expect(await (await deliver()).json(), from).toMatchObject({ outcome: "applied" });
      expect(org().subscription_status, from).toBe("past_due");
    }
    seed({ subscription_status: "unpaid", subscribed_plan: null, stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_succeeded");
    expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
    expect(org().subscription_status).toBe("active");
    // a subscription that ended through customer.subscription.updated keeps its id on the row
    seed({ subscription_status: "canceled", subscribed_plan: null, stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_succeeded");
    expect(await (await deliver()).json()).toMatchObject({ outcome: "superseded" });
    expect(org().subscription_status).toBe("canceled");
  });
});

describe("BILL-4 (review minor) — a superseded subscription event orders the subscription's older events", () => {
  it("on sub_B: sub_A deleted (T+20) superseded; a late sub_A updated (active, T+5) is stale; sub_B's unpaid then applies", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_B" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      state.event = subEvent("customer.subscription.deleted", { id: "evt_a_del", created: T0 + 20, sub: "sub_A", status: "canceled" });
      expect(await (await deliver()).json()).toMatchObject({ outcome: "superseded" });
      state.event = subEvent("customer.subscription.updated", { id: "evt_a_old", created: T0 + 5, sub: "sub_A", status: "active" });
      expect(await (await deliver()).json()).toMatchObject({ outcome: "stale" });
      expect(org()).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_B" });
      state.event = subEvent("customer.subscription.updated", { id: "evt_b_unpaid", created: T0 + 30, sub: "sub_B", status: "unpaid" });
      expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
      expect(org()).toMatchObject({ subscription_status: "unpaid", stripe_subscription_id: "sub_B" });
    } finally { warn.mockRestore(); }
  });

  it("a superseded INVOICE event orders nothing: an older subscription event for that subscription still applies", async () => {
    seed({ subscription_status: "unpaid", subscribed_plan: null, stripe_subscription_id: "sub_1" });
    state.event = invEvent("invoice.payment_failed", { id: "evt_fail", created: T0 + 10 });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "superseded" });
    state.event = subEvent("customer.subscription.updated", { id: "evt_up", created: T0 + 5, status: "active" });
    expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
    expect(org()).toMatchObject({ subscription_status: "active", subscribed_plan: "growth" });
  });
});

describe("BILL-4 (review minor) — one event per Stripe customer at a time (stripe_event_locks)", () => {
  it("BILL-4's scenario delivered concurrently: deleted (T2) and a late updated (active, T1) run at once — the workspace ends canceled", async () => {
    for (const order of ["deleted first", "updated first"] as const) {
      seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
      const del = subEvent("customer.subscription.deleted", { id: "evt_del", created: T0 + 200, status: "canceled" });
      const upd = subEvent("customer.subscription.updated", { id: "evt_upd", created: T0 + 100, status: "active" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const runs = order === "deleted first" ? [deliverEvent(del), deliverEvent(upd)] : [deliverEvent(upd), deliverEvent(del)];
        const statuses = (await Promise.all(runs)).map((r) => r.status);
        expect(statuses, order).toEqual([200, 200]);
      } finally { warn.mockRestore(); }
      expect(org(), order).toMatchObject({ subscription_status: "canceled", subscribed_plan: null, stripe_subscription_id: null });
      expect(rowsOf("stripe_event_locks"), order).toEqual([]);
    }
  });

  it("the lock is the customer's: each delivery inserts it first and deletes only its own when done", async () => {
    state.event = subEvent("customer.subscription.created", { id: "evt_1" });
    await deliver();
    const lockOps = state.log.filter((l) => l.table === "stripe_event_locks" && l.op !== "select");
    expect(lockOps.map((l) => l.op)).toEqual(["insert", "delete"]);
    expect(lockOps[0].payload).toEqual({ lock_for: "cus_1", event_id: "evt_1" });
    expect(state.log.findIndex((l) => l.table === "stripe_event_locks")).toBe(0);
    expect(rowsOf("stripe_event_locks")).toEqual([]);
  });

  it("a lock another delivery holds is waited on, then 503 (Stripe retries) with nothing written; a lapsed lock (a run that died) is broken", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.tables.stripe_event_locks = [{ lock_for: "cus_1", event_id: "evt_other", locked_at: new Date().toISOString() }];
      state.event = subEvent("customer.subscription.created", { id: "evt_wait" });
      const res = await deliver();
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/Another event for this Stripe customer is being applied; this one was not applied\. Stripe will retry it\./);
      expect(org().subscription_status).toBe("trialing");
      expect(rowsOf("stripe_events")).toEqual([]);
      expect(rowsOf("stripe_event_locks")).toEqual([expect.objectContaining({ event_id: "evt_other" })]);
      // the same lock, two minutes old: broken, and the event applies
      state.tables.stripe_event_locks = [{ lock_for: "cus_1", event_id: "evt_dead", locked_at: new Date(Date.now() - 120_000).toISOString() }];
      expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
      expect(org().subscription_status).toBe("active");
      expect(rowsOf("stripe_event_locks")).toEqual([]);
    } finally { err.mockRestore(); }
  }, 10_000);

  it("a lock write refused for another reason answers 500 and applies nothing; a refused release is logged, the event stands", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.writeError = (t, op) => (t === "stripe_event_locks" && op === "insert" ? { code: "XX000", message: "db down" } : null);
      state.event = subEvent("customer.subscription.created", { id: "evt_x" });
      expect((await deliver()).status).toBe(500);
      expect(org().subscription_status).toBe("trialing");
      state.writeError = (t, op) => (t === "stripe_event_locks" && op === "delete" ? { code: "XX000", message: "db down" } : null);
      expect(await (await deliver()).json()).toMatchObject({ outcome: "applied" });
      expect(err.mock.calls.some((c) => /the Stripe event lock for cus_1 was not released \(db down\); it lapses after 60 s/.test(String(c[0])))).toBe(true);
    } finally { err.mockRestore(); }
  });
});

describe("BILL-3 (review minor) — an ended subscription clears the plan whichever event ends it", () => {
  it("customer.subscription.updated with status canceled clears subscribed_plan", async () => {
    seed({ subscription_status: "active", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.updated", { status: "canceled" });
    expect((await deliver()).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "canceled", subscribed_plan: null });
    expect(audits("STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED")[0].details).toMatchObject({ plan_cleared: true });
  });

  it("a legacy incomplete row (stored trialing + growth by the old code) that expires is canceled with no plan", async () => {
    seed({ subscription_status: "trialing", subscribed_plan: "growth", stripe_subscription_id: "sub_1" });
    state.event = subEvent("customer.subscription.updated", { status: "incomplete_expired" });
    expect((await deliver()).status).toBe(200);
    expect(org()).toMatchObject({ subscription_status: "canceled", subscribed_plan: null });
  });
});

describe("BILL-8 (review minor) — a paused workspace may subscribe again", () => {
  it("a row on a paused subscription: checkout makes no subscription call and mints the session", async () => {
    seed({ subscription_status: "paused", subscribed_plan: null, stripe_subscription_id: "sub_1" });
    state.subscriptions = { sub_1: { id: "sub_1", status: "paused" } };
    const res = await checkoutPOST(post("/api/stripe/checkout", { orgId: ORG, plan: "growth" }));
    expect(res.status).toBe(200);
    expect(state.stripeCalls.map((c) => c.m)).toEqual(["checkout.sessions.create"]);
  });
});

// ─── REGRESSION: every orgs write in the app, and whose session makes it ──
//
// Migration B (20261176) refuses a change to a billing column unless the
// request runs as the service role. This census pins every orgs write in
// app/, lib/, components/ and hooks/: the service-role ones may name billing
// columns; the one made with a member's session (the browser client) must
// not — so it still succeeds after the paste (exercised on PostgreSQL 16:
// the numbering save updates 1 row with the guard installed).

describe("every orgs write in the app — after 20261176 a member's own write still succeeds", () => {
  const BILLING = ["subscription_status", "subscribed_plan", "trial_ends_at", "current_period_end", "stripe_customer_id", "stripe_subscription_id"];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "__tests__") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  const files = ["app", "lib", "components", "hooks"].flatMap((d) => walk(join(process.cwd(), d)));

  it("the census: exactly these files write orgs (update / upsert / insert / delete)", () => {
    const writers: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const re = /\.from\(\s*["']orgs["']\s*\)([\s\S]{0,200})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const op = /^\s*\.(update|upsert|insert|delete)\(/.exec(m[1]);
        if (op) writers.push(`${f.slice(process.cwd().length + 1)}:${op[1]}`);
      }
    }
    expect(writers.sort()).toEqual([
      "app/(protected)/admin/settings/page.tsx:update",   // member session (browser client)
      "app/api/admin/restore/begin/route.ts:update",      // service role: name
      "app/api/auth/signup/route.ts:delete",              // service role
      "app/api/auth/signup/route.ts:insert",              // service role (an INSERT — the BEFORE UPDATE guard never sees it)
      "app/api/stripe/checkout/route.ts:update",          // service role: stripe_customer_id
      "app/api/stripe/webhook/route.ts:update",           // service role: the billing columns
    ]);
  });

  it("the member-session write (the ticket-numbering save) names no billing column", () => {
    const page = src("app/(protected)/admin/settings/page.tsx");
    expect(page).toMatch(/import \{ supabase \} from "@\/lib\/supabase";/);
    const m = /supabase\.from\("orgs"\)\.update\(\{([\s\S]*?)\}\)\.eq\("id", activeOrgId\)/.exec(page);
    expect(m).not.toBeNull();
    expect(m![1].match(/\b(\w+):/g)!.map((k) => k.slice(0, -1))).toEqual(["ticket_prefix", "ticket_record_code", "ticket_number_pad"]);
    for (const col of BILLING) expect(m![1]).not.toContain(col);
  });

  it("the service-role writers use the service-role client", () => {
    expect(src("app/api/stripe/webhook/route.ts")).toMatch(/createClient\(supabaseUrl, serviceRoleKey/);
    expect(src("app/api/stripe/checkout/route.ts")).toMatch(/await auth\.admin\n\s+\.from\("orgs"\)\n\s+\.update\(\{ stripe_customer_id: customerId \}\)/);
    expect(src("app/api/admin/restore/begin/route.ts")).toMatch(/sb\.from\("orgs"\)\.update\(\{ name: /);
    expect(src("app/api/auth/signup/route.ts")).toMatch(/supabaseAdmin\s*\n\s*\.from\("orgs"\)\s*\n\s*\.insert\(/);
  });
});

describe("SURF-19's stripe limb stays A&O P5's — the role constants are untouched", () => {
  it("checkout and portal keep their ADMIN_ROLES constant", () => {
    for (const f of ["app/api/stripe/checkout/route.ts", "app/api/stripe/portal/route.ts"]) {
      expect(src(f)).toMatch(/const ADMIN_ROLES = \["Admin", "Manager"\];/);
      expect(src(f)).not.toMatch(/authorizeAdminSurface/);
    }
  });
});
