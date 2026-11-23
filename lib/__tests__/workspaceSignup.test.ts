import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// Stand-ins: the database, the sign-in accounts, and the payment service.
const db: Record<string, Array<Record<string, unknown>>> = {};
const accounts: Array<{ id: string; email: string; app_metadata: Record<string, unknown>; password?: string }> = [];
function query(table: string) {
  let rows = [...(db[table] ?? [])];
  let pending: Record<string, unknown> | null = null;
  let patch: Record<string, unknown> | null = null;
  const q: Record<string, unknown> = {};
  const run = () => {
    if (pending) {
      if (table === "orgs" && (db.orgs ?? []).some((o) => o.stripe_customer_id && o.stripe_customer_id === pending!.stripe_customer_id)) return { data: null, error: { message: "duplicate key orgs_stripe_customer_unique", code: "23505" } };
      const row = { id: `${table}-${(db[table] ?? []).length + 1}`, ...pending };
      (db[table] ??= []).push(row);
      return { data: [row], error: null };
    }
    if (patch) { rows.forEach((r) => Object.assign(r, patch)); return { data: rows, error: null }; }
    return { data: rows, error: null };
  };
  Object.assign(q, {
    select: () => q, limit: () => q,
    eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return q; },
    ilike: (k: string, v: string) => { rows = rows.filter((r) => String(r[k] ?? "").toLowerCase() === v.toLowerCase()); return q; },
    insert: (r: Record<string, unknown>) => { pending = r; return q; },
    update: (p: Record<string, unknown>) => { patch = p; return q; },
    single: () => Promise.resolve((() => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; })()),
    maybeSingle: () => Promise.resolve((() => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; })()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  });
  return q;
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => query(t),
    auth: { admin: {
      listUsers: async () => ({ data: { users: accounts }, error: null }),
      createUser: async (u: { email: string; app_metadata: Record<string, unknown> }) => {
        if (accounts.some((a) => a.email === u.email)) return { data: { user: null }, error: { message: "already registered" } };
        const a = { id: `acct-${accounts.length + 1}`, email: u.email, app_metadata: u.app_metadata };
        accounts.push(a);
        return { data: { user: a }, error: null };
      },
      getUserById: async (id: string) => ({ data: { user: accounts.find((a) => a.id === id) ?? null }, error: null }),
      updateUserById: async (id: string, p: { password: string; app_metadata: Record<string, unknown> }) => {
        const a = accounts.find((x) => x.id === id)!; a.password = p.password; a.app_metadata = p.app_metadata; return { error: null };
      },
    } },
  },
}));
const sessions: Record<string, Partial<Stripe.Checkout.Session>> = {};
const created: Array<Record<string, unknown>> = [];
vi.mock("@/lib/stripe", () => ({
  isStripeConfigured: () => true,
  getPriceIdForPlan: (p: string) => (p === "starter" ? "price_s" : p === "growth" ? "price_g" : null),
  getStripe: () => ({
    checkout: { sessions: {
      create: async (o: Record<string, unknown>) => { created.push(o); return { url: "https://pay.test/cs_test_1" }; },
      retrieve: async (id: string) => { const s = sessions[id]; if (!s) throw new Error("no such session"); return s; },
    } },
    subscriptions: { retrieve: async () => ({ status: "active", current_period_end: 1893456000 }) },
  }),
}));

const paid = (id: string, over: Partial<Stripe.Checkout.Session> = {}): Partial<Stripe.Checkout.Session> => ({
  id, status: "complete", payment_status: "paid", customer: "cus_1", subscription: "sub_1", created: Math.floor(Date.now() / 1000),
  metadata: { kind: "new_workspace", company: "Kern Energy", name: "Pat Lee", email: "pat@kern.test", plan: "growth" }, ...over,
});

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.orgs = []; db.org_members = []; db.users = []; db.audit_logs = [];
  accounts.length = 0; created.length = 0;
  for (const k of Object.keys(sessions)) delete sessions[k];
});

describe("a workspace starts only with a payment", () => {
  it("opening the payment page makes nothing, and refuses a taken name or email", async () => {
    const { startCheckout } = await import("@/lib/workspaceSignupServer");
    const r = await startCheckout({ company: "Kern Energy", name: "Pat Lee", email: " Pat@Kern.test ", plan: "growth", origin: "https://app.test" });
    expect(r.url).toContain("pay.test");
    expect(created[0].customer_email).toBe("pat@kern.test");
    expect(db.orgs).toEqual([]); expect(accounts).toEqual([]);

    db.orgs.push({ id: "o1", name: "Kern Energy" });
    await expect(startCheckout({ company: "kern energy", name: "Pat", email: "x@kern.test", plan: "growth", origin: "" })).rejects.toThrow(/already exists/);
    db.orgs = [];
    accounts.push({ id: "a0", email: "taken@kern.test", app_metadata: {} });
    await expect(startCheckout({ company: "Other", name: "Pat", email: "TAKEN@kern.test", plan: "growth", origin: "" })).rejects.toThrow(/already has an account/);
  });

  it("an unpaid or unrelated payment makes nothing", async () => {
    const { provisionWorkspace } = await import("@/lib/workspaceSignupServer");
    await expect(provisionWorkspace(paid("cs_test_a", { payment_status: "unpaid" }) as Stripe.Checkout.Session)).rejects.toThrow(/hasn't gone through/);
    await expect(provisionWorkspace(paid("cs_test_b", { metadata: { kind: "other" } }) as Stripe.Checkout.Session)).rejects.toThrow(/isn't for a new workspace/);
    expect(db.orgs).toEqual([]); expect(accounts).toEqual([]);
  });

  it("a paid one makes the workspace, its admin, membership and profile once, however often it runs", async () => {
    const { provisionWorkspace } = await import("@/lib/workspaceSignupServer");
    const s = paid("cs_test_c") as Stripe.Checkout.Session;
    const a = await provisionWorkspace(s);
    const b = await provisionWorkspace(s);
    expect(b).toEqual(a);
    expect(db.orgs).toHaveLength(1);
    expect(accounts).toHaveLength(1);
    expect(db.org_members).toEqual([expect.objectContaining({ uid: a.uid, org_id: a.orgId, role: "Admin", status: "active", email: "pat@kern.test" })]);
    expect(db.users).toEqual([expect.objectContaining({ id: a.uid, default_org_id: a.orgId })]);
  });

  it("the payer sets their first password once, and only within a week", async () => {
    const { setFirstPassword, finishState } = await import("@/lib/workspaceSignupServer");
    sessions.cs_test_d123456789 = paid("cs_test_d123456789");
    expect((await finishState("cs_test_d123456789")).needsPassword).toBe(true);
    await setFirstPassword("cs_test_d123456789", "Refinery-crude-unit-2026");
    expect((await finishState("cs_test_d123456789")).needsPassword).toBe(false);
    await expect(setFirstPassword("cs_test_d123456789", "Another-long-passphrase-9")).rejects.toThrow(/already set/);

    sessions.cs_test_e123456789 = paid("cs_test_e123456789", { customer: "cus_2", created: Math.floor(Date.now() / 1000) - 8 * 86400, metadata: { kind: "new_workspace", company: "Other Co", name: "Sam", email: "sam@other.test", plan: "starter" } });
    await expect(setFirstPassword("cs_test_e123456789", "Refinery-crude-unit-2026")).rejects.toThrow(/expired/);
    await expect(setFirstPassword("not-a-session", "Refinery-crude-unit-2026")).rejects.toThrow(/isn't right/);
  });
});
