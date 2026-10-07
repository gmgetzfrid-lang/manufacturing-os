// intelligence Round G — I-05: /api/ai/usage.
//
//   GOV-10  setting caps is the `ai.manage_caps` capability (default Admin)
//           read from the org's policy — Doc Control is refused unless
//           granted; nobody raises their OWN cap while another person holds
//           the capability — by an override, by clearing one, or by raising
//           the workspace default they follow (they are held where they
//           were); a SOLE holder has nobody to ask, so their raise goes
//           through, audited soleHolder; every change notifies the other
//           holders and, for one person's cap, that person — named in the
//           notice (the hold a default raise writes is told with it, fix
//           pass 12); the target is the
//           uid the DATABASE returns, so the caller's own uid in another
//           spelling (upper case, braces, no hyphens) is still their own;
//           a sole holder's own raise is refused unless its audit row is
//           written first
//   GOV-15  a cap change is ONE transaction — ai_cap_change (20261173)
//           locks, decides, writes and audits; the route maps its answer
//           (the same answers and notices), and a holder's own self-clear
//           that is not a raise is allowed there. Until it is pasted the
//           change runs app-side: today's sequential path (the T1–T10
//           matrix, unchanged), with no re-read and no put-back; there a
//           self-clear stays refused while another holder exists
//   GOV-4   an unreadable cap table refuses (503) — the team view and the
//           audit's "previous figure" never fall back to $10
//   GOV-3   a $0 cap reads `locked`, 100% — what the server enforces
//   GOV-4   an unreadable ledger answers 503, never $0.00; a team ledger
//           that can't be summed leaves the viewer's own meter and the
//           editor up (`teamUnavailable`, fix pass 12)
//   GOV-1   the meter carries every op, broken out per feature
//   GOV-3   a client reading the meter (getAiUsage) sees a lock as a
//           refusal, never "no cap" (aiUsageLockedReason)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { code?: string; message: string } | undefined>,
  seq: 0,
  /** The browser session's bearer for lib/knowledge's client calls. */
  sessionToken: "",
  /** Awaited before each query runs — a test that interleaves two requests
   *  holds one at a chosen step (GOV-10 at write time). */
  hook: null as null | ((q: { table: string; action: string; payload: unknown }) => Promise<void> | void),
  /** Called once a query has run. */
  after: null as null | ((q: { table: string; action: string; payload: unknown }) => void),
  /** GOV-15: `supabaseAdmin.rpc` — null answers as a database without
   *  20261173 does (PGRST202), so the route takes the app-side path; a test
   *  of the function path sets it. */
  rpc: null as null | ((fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: db.sessionToken } } }) } },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));

vi.mock("@/lib/supabaseAdmin", () => {
  // uuid columns compare as Postgres does: any spelling uuid_in accepts
  // (upper case, braces, no hyphens) matches the stored lowercase value.
  const uuidKey = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const braced = /^\{(.*)\}$/.exec(v);
    const body = braced ? braced[1] : v;
    return /^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(body) ? body.replace(/-/g, "").toLowerCase() : null;
  };
  const same = (a: unknown, b: unknown) => {
    const ka = uuidKey(a), kb = uuidKey(b);
    return ka !== null && kb !== null ? ka === kb : a === b;
  };
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let action: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let range: [number, number] | null = null;
    let one = false;
    let limited = false;
    /** `.select()` after a write: the rows it wrote come back. */
    let returning = false;
    /** `.select(cols, { count: "exact" })`: the matching rows' count comes back. */
    let wantCount = false;
    const orders: Array<{ col: string; asc: boolean }> = [];
    const exec = () => {
      // `table:select:nolimit` fails only the reads that are not .limit()ed —
      // the team view and the route's own default / override reads, never
      // getCapUsd's two bound reads.
      // `table:select:many` fails only the list reads (never a maybeSingle) —
      // the holder roster, never authMember's own-membership read.
      const err = db.errors[`${table}:${action}`] ?? (limited ? undefined : db.errors[`${table}:${action}:nolimit`])
        ?? (one ? undefined : db.errors[`${table}:${action}:many`]);
      if (err) return { data: null, error: err };
      const rows = (db.tables[table] ??= []);
      if (action === "insert") {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        // ai_usage_limits' unique indexes (20260916): one default per org,
        // one override per (org, user) — a second insert is refused 23505.
        if (table === "ai_usage_limits" && list.some((p) => rows.some((r) => same(r.org_id, p.org_id) && ((r.user_id ?? null) === null
          ? (p.user_id ?? null) === null : same(r.user_id, p.user_id))))) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"ai_usage_limits_user_idx\"" } };
        }
        // audit_logs stamps `timestamp` (its column default), which the
        // route reads for the caller's own writes since a request began.
        const stamp = table === "audit_logs" ? { timestamp: new Date().toISOString() } : {};
        const added = list.map((p) => ({ id: `r${++db.seq}`, created_at: new Date().toISOString(), ...stamp, ...p }));
        rows.push(...added);
        return { data: returning ? added.map((r) => ({ id: r.id })) : null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      // An update or a delete answers the rows it matched (what `.select()` after it returns).
      if (action === "update") { for (const r of hit) Object.assign(r, payload); return { data: hit.map((r) => ({ id: r.id ?? null })), error: null }; }
      if (action === "delete") { db.tables[table] = rows.filter((r) => !hit.includes(r)); return { data: hit.map((r) => ({ id: r.id ?? null })), error: null }; }
      let sorted = hit;
      for (const o of [...orders].reverse()) {
        sorted = [...sorted].sort((a, b) => (String(a[o.col]) < String(b[o.col]) ? -1 : String(a[o.col]) > String(b[o.col]) ? 1 : 0) * (o.asc ? 1 : -1));
      }
      const out = range ? sorted.slice(range[0], range[1] + 1) : sorted;
      return { data: one ? (out[0] ?? null) : out, error: null, ...(wantCount ? { count: hit.length } : {}) };
    };
    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string }) => {
        if (action !== "select") returning = true;
        if (opts?.count === "exact") wantCount = true;
        return b;
      },
      insert: (p: Row | Row[]) => { action = "insert"; payload = p; return b; },
      update: (p: Row) => { action = "update"; payload = p; return b; },
      delete: () => { action = "delete"; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => same(r[c], v)); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; },
      gt: (c: string, v: unknown) => {
        filters.push((r) => (typeof r[c] === "number" && typeof v === "number" ? (r[c] as number) > v : String(r[c]) > String(v)));
        return b;
      },
      order: (col: string, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return b; },
      range: (a: number, z: number) => { range = [a, z]; return b; },
      limit: () => { limited = true; return b; },
      single: () => { one = true; return b; },
      maybeSingle: () => { one = true; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => (async () => {
        if (db.hook) await db.hook({ table, action, payload });
        const out = exec();
        db.after?.({ table, action, payload });
        return out;
      })().then(res, rej),
    };
    return b;
  }
  return {
    supabaseAdmin: {
      auth: { getUser: vi.fn(async (t: string) => ({ data: { user: { id: t } }, error: null })) },
      from: (t: string) => builder(t),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        db.rpcCalls.push({ fn, args });
        if (db.rpc) return db.rpc(fn, args);
        return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
      },
    },
  };
});

import { GET, POST } from "@/app/api/ai/usage/route";
import { getAiUsage, aiUsageLockedReason } from "@/lib/knowledge";

const ORG = "o1";
// Real uuids: the route refuses a userId that is not one (GOV-10).
const ADMIN = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", ADMIN2 = "b1ffcd88-8d1a-4ef8-bb6d-6bb9bd380a22";
const DOC = "c2aade77-7e2b-4ef8-bb6d-6bb9bd380a33", ENG = "d3bbef66-6f3c-4ef8-bb6d-6bb9bd380a44";
const get = async (who: string) => { const r = await GET(new NextRequest(`https://app/api/ai/usage?orgId=${ORG}`, { headers: { authorization: `Bearer ${who}` } })); return { status: r.status, json: await r.json() as Row }; };
const post = async (who: string, body: Row) => {
  const r = await POST(new NextRequest("https://app/api/ai/usage", { method: "POST", headers: { authorization: `Bearer ${who}`, "content-type": "application/json" }, body: JSON.stringify({ orgId: ORG, ...body }) }));
  return { status: r.status, json: await r.json() as Row };
};
const spend = (uid: string, op: string, usd: number): Row => ({ id: `s${++db.seq}`, created_at: new Date().toISOString(), org_id: ORG, user_id: uid, op, model: "m", input_tokens: 10, output_tokens: 1, est_cost_usd: usd, ok: true });
const notices = () => db.tables.notifications ?? [];
/** An AI_CAP_CHANGED row's details as most tests assert them: the id that
 *  pairs a row written before its change with its companion (`writeId`)
 *  and the person's override row a change wrote (`limitRowId`) are asserted
 *  where they matter (GOV-10, fix pass 10), not on every row. */
const plainDetails = (d: unknown): Row => Object.fromEntries(Object.entries((d ?? {}) as Row).filter(([k]) => k !== "writeId" && k !== "limitRowId"));

beforeEach(() => {
  db.seq = 0;
  db.errors = {};
  db.hook = null;
  db.after = null;
  db.rpc = null;
  db.rpcCalls = [];
  db.tables = {
    org_members: [
      { org_id: ORG, uid: ADMIN, role: "Admin", roles: ["Admin"], status: "active", display_name: "Ada" },
      { org_id: ORG, uid: ADMIN2, role: "Manager", roles: ["Manager", "Admin"], status: "active", display_name: "Bea" },
      { org_id: ORG, uid: DOC, role: "DocCtrl", roles: ["DocCtrl"], status: "active", display_name: "Dot" },
      { org_id: ORG, uid: ENG, role: "Engineer", roles: ["Engineer"], status: "active", display_name: "Eve" },
    ],
    org_configurations: [],
    ai_usage_events: [],
    ai_usage_limits: [],
    audit_logs: [],
    notifications: [],
  };
});

describe("GOV-10 — cap changes are the ai.manage_caps capability, never the controller literal", () => {
  it("Doc Control (a controller) is refused by default; the refusal names the permission", async () => {
    const r = await post(DOC, { capUsd: 500 });
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/Manage AI spend caps/);
    expect(db.tables.ai_usage_limits).toHaveLength(0);
  });

  it("an Admin — by the held collection too — may set the default; Doc Control may once the policy grants it", async () => {
    expect((await post(ADMIN2, { capUsd: 25 })).status).toBe(200);
    db.tables.org_configurations = [{ org_id: ORG, key: "capability_policy", data: { caps: { "ai.manage_caps": ["Admin", "DocCtrl"] } } }];
    expect((await post(DOC, { capUsd: 30 })).status).toBe(200);
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === null)?.monthly_cap_usd).toBe(30);
  });

  it("a per-person grant admits an Engineer", async () => {
    db.tables.org_configurations = [{ org_id: ORG, key: "capability_policy", data: { grants: [{ cap: "ai.manage_caps", uid: ENG }] } }];
    expect((await post(ENG, { capUsd: 12, userId: DOC })).status).toBe(200);
  });

  it("a policy that cannot be read refuses the change (503), never falls back to defaults", async () => {
    db.errors["org_configurations:select"] = { message: "statement timeout" };
    expect((await post(ADMIN, { capUsd: 20 })).status).toBe(503);
  });

  it("nobody raises their OWN cap — not by an override, not by clearing one onto a higher default; lowering is fine", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
    const up = await post(ADMIN, { capUsd: 10000, userId: ADMIN });
    expect(up.status).toBe(403);
    expect(String(up.json.error)).toMatch(/can't raise your own/);
    expect((await post(ADMIN, { capUsd: null, userId: ADMIN })).status).toBe(403);
    expect((await post(ADMIN, { capUsd: 5, userId: ADMIN })).status).toBe(200);
    // another holder can raise it
    expect((await post(ADMIN2, { capUsd: 40, userId: ADMIN })).status).toBe(200);
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === ADMIN)?.monthly_cap_usd).toBe(40);
  });

  it("raising the workspace default you follow does NOT raise your own cap — you are held where you were (the finding's own scenario)", async () => {
    // A holder at $10 of $10, no personal override, raises the default to
    // $10,000 — another Admin (ADMIN2) holds the capability, so a raise of
    // ADMIN's own cap is theirs to make.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.tables.ai_usage_events = [spend(ADMIN, "knowledgeAsk", 10)];
    // selfUserId: the editor's own row, offered no figure the server refuses (fix pass 7)
    expect((await get(ADMIN)).json).toMatchObject({ selfFollowsDefault: true, soleCapsHolder: false, selfUserId: ADMIN });
    const r = await post(ADMIN, { capUsd: 10000 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, capUsd: 10000, selfHeldAtUsd: 10 });
    // everyone else follows the new default; the setter's own cap is still $10
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === null)?.monthly_cap_usd).toBe(10000);
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === ADMIN)?.monthly_cap_usd).toBe(10);
    const mine = (await get(ADMIN)).json;
    expect(mine).toMatchObject({ capUsd: 10, percent: 100, selfFollowsDefault: false });
    expect((await get(ENG)).json).toMatchObject({ capUsd: 10000 });
    // the raise is recorded BEFORE it is made (fix pass 10: the re-reads
    // read it back), then the hold, before the default moves
    const audits = db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED");
    expect(audits.map((a) => plainDetails(a.details))).toEqual([
      { capUsd: 10000, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
    ]);
    // GOV-15: no writeId — the record a default raise wrote first existed only for the race reader
    expect((audits[0].details as Row).writeId).toBeUndefined();
    // and the hold cannot be undone by the holder: clearing it onto the $10,000 default is a self-raise
    expect((await post(ADMIN, { capUsd: null, userId: ADMIN })).status).toBe(403);
    expect((await post(ADMIN, { capUsd: 500, userId: ADMIN })).status).toBe(403);
    expect(r.json.soleHolder).toBeUndefined();
  });

  it("a SOLE holder (the only Admin; nobody else granted it) has nobody to ask: their own raise goes through, audited soleHolder and said", async () => {
    // The deadlock this closes: $10 default, a self-override refused, a
    // default raise pinning them at $10, clearing the pin refused — capped
    // for good, with no in-app remedy in a one-person workspace.
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== ADMIN2);
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    expect((await get(ADMIN)).json).toMatchObject({ selfFollowsDefault: true, soleCapsHolder: true });

    // raising the default they follow: not held — they follow it like everyone else
    const def = await post(ADMIN, { capUsd: 50 });
    expect(def.status).toBe(200);
    expect(def.json).toMatchObject({ ok: true, capUsd: 50, soleHolder: true });
    expect(def.json.selfHeldAtUsd).toBeUndefined();
    expect(db.tables.ai_usage_limits.some((l) => l.user_id === ADMIN)).toBe(false);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 50 });

    // an override of their own, and clearing it onto a higher default
    const own = await post(ADMIN, { capUsd: 75, userId: ADMIN });
    expect(own.status).toBe(200);
    expect(own.json.soleHolder).toBe(true);
    await post(ADMIN, { capUsd: 5, userId: ADMIN }); // lowering is not a self-raise
    const cleared = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ cleared: true, soleHolder: true });

    const audits = db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED").map((a) => plainDetails(a.details));
    expect(audits).toEqual([
      { capUsd: 50, previousCapUsd: 10, soleHolder: true },
      { targetUserId: ADMIN, capUsd: 75, previousCapUsd: 50, soleHolder: true },
      { targetUserId: ADMIN, capUsd: 5, previousCapUsd: 75 },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 5, soleHolder: true },
    ]);
  });

  it("a one-person workspace is a sole holder too; a second holder brings the ban back", async () => {
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid === ADMIN);
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    expect((await post(ADMIN, { capUsd: 50, userId: ADMIN })).status).toBe(200);
    // grant the capability to a second member (by person): the ban is back
    db.tables.org_members.push({ org_id: ORG, uid: ENG, role: "Engineer", roles: ["Engineer"], status: "active", display_name: "Eve" });
    db.tables.org_configurations = [{ org_id: ORG, key: "capability_policy", data: { grants: [{ cap: "ai.manage_caps", uid: ENG }] } }];
    const r = await post(ADMIN, { capUsd: 100, userId: ADMIN });
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/another person with the “Manage AI spend caps” permission has to/);
    // a holder who is not active does not count as a second signature
    db.tables.org_members.find((m) => m.uid === ENG)!.status = "removed";
    expect((await post(ADMIN, { capUsd: 100, userId: ADMIN })).status).toBe(200);
  });

  it("a holder roster that cannot be read refuses a self-raise (503) — never 'nobody else'", async () => {
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== ADMIN2);
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.errors["org_members:select:many"] = { message: "statement timeout" };
    const own = await post(ADMIN, { capUsd: 50, userId: ADMIN });
    expect(own.status).toBe(503);
    expect(String(own.json.error)).toMatch(/Couldn't check who else manages AI caps/);
    expect((await post(ADMIN, { capUsd: 50 })).status).toBe(503); // the default raise they follow
    expect(db.tables.ai_usage_limits).toEqual([{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }]);
    expect(db.tables.audit_logs).toHaveLength(0);
    // a change that is not a self-raise does not need the roster's answer
    expect((await post(ADMIN, { capUsd: 5 })).status).toBe(200);
  });

  it("only a setter who FOLLOWS the default is held, and only when it goes up; a hold that cannot be written changes nothing", async () => {
    // ADMIN has an override of their own: raising the default does not touch it
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 50 }];
    const up = await post(ADMIN, { capUsd: 20 });
    expect(up.status).toBe(200);
    expect(up.json.selfHeldAtUsd).toBeUndefined();
    expect(db.tables.ai_usage_limits).toHaveLength(2);
    // ADMIN2 follows the default; lowering it holds nobody
    const down = await post(ADMIN2, { capUsd: 5 });
    expect(down.status).toBe(200);
    expect(db.tables.ai_usage_limits.some((l) => l.user_id === ADMIN2)).toBe(false);
    // raising it while the hold cannot be written: refused, the default untouched
    db.errors["ai_usage_limits:insert"] = { message: "permission denied" };
    const r = await post(ADMIN2, { capUsd: 40 });
    expect(r.status).toBe(500);
    expect(String(r.json.error)).toMatch(/default was not raised/);
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === null)?.monthly_cap_usd).toBe(5);
  });

  it("every change is audited with the previous figure and notifies the other holders and the person whose cap moved", async () => {
    await post(ADMIN, { capUsd: 0, userId: ENG });
    const audit = db.tables.audit_logs.at(-1)!;
    expect(audit).toMatchObject({ action: "AI_CAP_CHANGED", user_id: ADMIN });
    expect(audit.details).toMatchObject({ targetUserId: ENG, capUsd: 0, previousCapUsd: 10 });
    const to = notices().map((n) => n.user_id).sort();
    expect(to).toEqual([ADMIN2, ENG].sort()); // the other Admin and the target — never the actor, never Doc Control
    const mine = notices().find((n) => n.user_id === ENG)!;
    expect(mine.title).toBe("Your monthly AI cap changed");
    expect(String(mine.body)).toMatch(/from \$10 to \$0 \(locked\)/);
  });
});

describe("GOV-10 — a request that changes nothing is answered, audited and told as nothing (fix pass 11, sequential)", () => {
  const capDetails = () => db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED").map((a) => plainDetails(a.details));
  const limitsOf = (uid: string | null) => db.tables.ai_usage_limits.filter((l) => (l.user_id ?? null) === uid).map((l) => l.monthly_cap_usd);

  it("clearing an override that is not there (a panel opened before another holder cleared it) is 200 unchanged — no audit row, no notice", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: ENG, monthly_cap_usd: 25, updated_by: ADMIN }];
    // ADMIN2 clears it first: a real change, audited and told
    const first = await post(ADMIN2, { capUsd: null, userId: ENG });
    expect(first.json).toMatchObject({ ok: true, cleared: true });
    // ADMIN's panel still shows the override, and clears it again
    const r = await post(ADMIN, { capUsd: null, userId: ENG });
    expect(r.status).toBe(200);
    // was: { ok: true, cleared: true }, an AI_CAP_CHANGED `cleared` row "from $10", and
    // "Your monthly AI cap changed … from $10 to the workspace default" to ENG and ADMIN2
    expect(r.json).toEqual({ ok: true, cleared: false, unchanged: true });
    expect(db.tables.ai_usage_limits).toEqual([]);
    expect(capDetails()).toEqual([{ targetUserId: ENG, cleared: true, previousCapUsd: 25 }]);
    // (fix pass 12: the notice names whose cap it is)
    expect(notices().filter((n) => n.user_id === ENG).map((n) => n.body)).toEqual([
      "Bea changed Eve's monthly AI cap from $25 to the workspace default.",
    ]);
    expect(notices().some((n) => n.actor_user_id === ADMIN)).toBe(false);
  });

  it("a person's cap set to the figure their override already holds is 200 unchanged — nothing written, audited or told (a lock re-applied included)", async () => {
    for (const figure of [25, 0]) {
      db.tables.ai_usage_limits = [{ id: "row-eng", org_id: ORG, user_id: ENG, monthly_cap_usd: figure, updated_by: ADMIN2, updated_at: "2026-09-01T00:00:00.000Z" }];
      db.tables.audit_logs = [];
      db.tables.notifications = [];
      const r = await post(ADMIN, { capUsd: figure, userId: ENG });
      expect(r.status, String(figure)).toBe(200);
      // was: 200 { ok: true, capUsd } and "changed a person's monthly AI cap from $25 to $25"
      expect(r.json).toEqual({ ok: true, capUsd: figure, locked: figure === 0, unchanged: true });
      expect(db.tables.ai_usage_limits).toEqual([{ id: "row-eng", org_id: ORG, user_id: ENG, monthly_cap_usd: figure, updated_by: ADMIN2, updated_at: "2026-09-01T00:00:00.000Z" }]);
      expect(capDetails()).toEqual([]);
      expect(notices()).toEqual([]);
    }
    // a different figure is still a change
    const r = await post(ADMIN, { capUsd: 30, userId: ENG });
    expect(r.json.unchanged).toBeUndefined();
    expect(capDetails()).toEqual([{ targetUserId: ENG, capUsd: 30, previousCapUsd: 0 }]);
  });

  it("the default set to the figure it already has is 200 unchanged — with a stored row and with none (the $10 it reads as); no hold, no audit row, no notice", async () => {
    for (const stored of [10, null] as const) {
      db.tables.ai_usage_limits = stored === null ? [] : [{ org_id: ORG, user_id: null, monthly_cap_usd: stored, updated_by: ADMIN2 }];
      db.tables.audit_logs = [];
      db.tables.notifications = [];
      const r = await post(ADMIN, { capUsd: 10 });
      expect(r.status, String(stored)).toBe(200);
      // was: "Ada changed the workspace's default monthly AI cap from $10 to $10" to every other holder
      expect(r.json).toEqual({ ok: true, capUsd: 10, locked: false, unchanged: true });
      expect(db.tables.ai_usage_limits).toEqual(stored === null ? [] : [{ org_id: ORG, user_id: null, monthly_cap_usd: 10, updated_by: ADMIN2 }]);
      expect(capDetails()).toEqual([]);
      expect(notices()).toEqual([]);
    }
    // a workspace already locked, locked again
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 0, updated_by: ADMIN2 }];
    expect((await post(ADMIN, { capUsd: 0 })).json).toEqual({ ok: true, capUsd: 0, locked: true, unchanged: true });
    expect(capDetails()).toEqual([]);
  });

  it("a person who follows the default, given its figure as their own, IS a change — written, audited pinnedAtDefault and told as that, never 'from $10 to $10'", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10, updated_by: ADMIN2 }];
    const r = await post(ADMIN, { capUsd: 10, userId: ENG });
    expect(r.status).toBe(200);
    // fix pass 12: the answer says it too, so the setter's panel can
    expect(r.json).toEqual({ ok: true, capUsd: 10, locked: false, pinnedAtDefault: true });
    expect(limitsOf(ENG)).toEqual([10]);
    expect(capDetails()).toEqual([{ targetUserId: ENG, capUsd: 10, previousCapUsd: 10, pinnedAtDefault: true }]);
    const toEng = notices().find((n) => n.user_id === ENG)!;
    expect(toEng.title).toBe("Your monthly AI cap changed");
    expect(toEng.body).toBe("Ada set Eve's monthly AI cap to $10 — the figure of the workspace default it followed until now — so a change to the default no longer moves it.");
    expect(toEng.metadata).toMatchObject({ targetUserId: ENG, capUsd: 10, previousCapUsd: 10, pinnedAtDefault: true });
    expect(notices().map((n) => n.user_id).sort()).toEqual([ADMIN2, ENG].sort());
    // and it is what it says: the default moves, ENG stays
    await post(ADMIN2, { capUsd: 20 });
    expect((await get(ENG)).json).toMatchObject({ capUsd: 10 });
  });

  it("a SOLE holder's clear, recorded first, that finds no override to remove writes its record's not-applied companion and answers unchanged", async () => {
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== ADMIN2);
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 },
      { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 5, updated_by: ADMIN }];
    // the override is gone by the time the delete runs
    db.hook = ({ table, action }) => {
      if (table === "ai_usage_limits" && action === "delete") {
        db.hook = null;
        db.tables.ai_usage_limits = db.tables.ai_usage_limits.filter((l) => l.user_id !== ADMIN);
      }
    };
    const r = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, cleared: false, unchanged: true });
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 5, soleHolder: true },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 5, soleHolder: true, notApplied: true, error: "there was no override to clear" },
    ]);
    expect(notices()).toEqual([]);
  });

  it("a change to the default tells the other holders only — the members who follow it are not told one by one (GOV-10 done-when 4, restated)", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10, updated_by: ADMIN2 },
      { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10, updated_by: ADMIN2 }];
    expect((await post(ADMIN, { capUsd: 5 })).status).toBe(200);
    expect(notices().map((n) => n.user_id)).toEqual([ADMIN2]);
    expect(notices()[0].body).toBe("Ada changed the workspace's default monthly AI cap from $10 to $5.");
    expect((await get(ENG)).json).toMatchObject({ capUsd: 5 });
  });
});

describe("GOV-10 — every change to one person's cap is told, the hold a default raise writes included; notices name whose cap it is (fix pass 12, sequential)", () => {
  const capDetails = () => db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED").map((a) => plainDetails(a.details));
  const limitsOf = (uid: string | null) => db.tables.ai_usage_limits.filter((l) => (l.user_id ?? null) === uid).map((l) => l.monthly_cap_usd);

  it("the hold a default raise writes for its setter is told to the other holders — it moves the setter off the default, as a pin at its figure does (the twelfth review's major)", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10, updated_by: ADMIN2 }];
    const r = await post(ADMIN, { capUsd: 20 });
    expect(r.json).toMatchObject({ ok: true, capUsd: 20, selfHeldAtUsd: 10 });
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect(capDetails()).toEqual([
      { capUsd: 20, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
    ]);
    // was: "Ada changed the workspace's default monthly AI cap from $10 to $20." — the hold untold
    expect(notices().map((n) => [n.user_id, n.title, n.body])).toEqual([[
      ADMIN2, "A monthly AI cap changed",
      "Ada changed the workspace's default monthly AI cap from $10 to $20; Ada's own cap stays at $10 as a personal cap, so a change to the default no longer moves it.",
    ]]);
    expect(notices()[0].metadata).toMatchObject({ targetUserId: null, capUsd: 20, previousCapUsd: 10, heldSelfAtUsd: 10 });
    // what the notice says is what happens: Bea lowers the default, Eve follows it, Ada does not
    await post(ADMIN2, { capUsd: 5 });
    expect((await get(ENG)).json.capUsd).toBe(5);
    expect((await get(ADMIN)).json.capUsd).toBe(10);
  });

  it("the hold on unlocking a locked workspace is told at $0 (locked); a default raise that writes no hold (a setter with an override, or a sole holder) says none", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 0, updated_by: ADMIN2 }];
    expect((await post(ADMIN, { capUsd: 10 })).json).toMatchObject({ selfHeldAtUsd: 0 });
    expect(notices().at(-1)!.body).toBe("Ada changed the workspace's default monthly AI cap from $0 (locked) to $10; Ada's own cap stays at $0 (locked) as a personal cap, so a change to the default no longer moves it.");
    // ADMIN now has an override (the hold): their next raise writes none
    db.tables.notifications = [];
    expect((await post(ADMIN, { capUsd: 30 })).json.selfHeldAtUsd).toBeUndefined();
    expect(notices().map((n) => n.body)).toEqual(["Ada changed the workspace's default monthly AI cap from $10 to $30."]);
    expect((notices()[0].metadata as Row).heldSelfAtUsd).toBeUndefined();
    // a sole holder follows the default (no hold) — and there is nobody to tell
    db.tables.org_members[1].roles = ["Manager"];
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.tables.notifications = [];
    expect((await post(ADMIN, { capUsd: 40 })).json).toMatchObject({ soleHolder: true });
    expect(limitsOf(ADMIN)).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it("a notice names whose cap changed — the person by name, the actor's own as 'their own' — and the person's own title stays 'Your'", async () => {
    db.tables.org_configurations = [{ org_id: ORG, key: "capability_policy", data: { caps: { "ai.manage_caps": ["Admin", "DocCtrl"] } } }];
    // Bea raises Dot's cap (the review's scenario): Ada is told who
    await post(ADMIN2, { capUsd: 10000, userId: DOC });
    expect(notices().map((n) => [n.user_id, n.title, n.body]).sort()).toEqual([
      [ADMIN, "A monthly AI cap changed", "Bea changed Dot's monthly AI cap from $10 to $10000."],
      [DOC, "Your monthly AI cap changed", "Bea changed Dot's monthly AI cap from $10 to $10000."],
    ].sort());
    // a clear names them too
    db.tables.notifications = [];
    await post(ADMIN2, { capUsd: null, userId: DOC });
    expect(notices().find((n) => n.user_id === ADMIN)!.body).toBe("Bea changed Dot's monthly AI cap from $10000 to the workspace default.");
    // the actor's own cap: "their own", never their name as a stranger's
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: ADMIN, monthly_cap_usd: 40, updated_by: ADMIN2 }];
    db.tables.notifications = [];
    expect((await post(ADMIN, { capUsd: 5, userId: ADMIN })).status).toBe(200);
    expect(notices().find((n) => n.user_id === ADMIN2)!.body).toBe("Ada changed their own monthly AI cap from $40 to $5.");
    // no display name: the email; neither: "a person's"
    db.tables.notifications = [];
    db.tables.org_members.find((m) => m.uid === ENG)!.display_name = null;
    db.tables.org_members.find((m) => m.uid === ENG)!.email = "eve@example.com";
    await post(ADMIN, { capUsd: 25, userId: ENG });
    expect(notices().find((n) => n.user_id === ADMIN2)!.body).toBe("Ada changed eve@example.com's monthly AI cap from $10 to $25.");
    db.tables.notifications = [];
    db.tables.org_members.find((m) => m.uid === ENG)!.email = null;
    await post(ADMIN, { capUsd: 30, userId: ENG });
    expect(notices().find((n) => n.user_id === ENG)!.body).toBe("Ada changed a person's monthly AI cap from $25 to $30.");
  });

  it("clearing your OWN override when you have none is 200 unchanged — nothing audited or told, never a 403 naming an override that is not there; with one it is still refused (the twelfth review's minor)", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10, updated_by: ADMIN2 }];
    const none = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect(none.status).toBe(200);
    // was: 403 "You can't clear your own monthly AI cap override…"
    expect(none.json).toEqual({ ok: true, cleared: false, unchanged: true });
    expect(capDetails()).toEqual([]);
    expect(notices()).toEqual([]);
    // an override of their own (one another holder set): still refused while another holder exists
    db.tables.ai_usage_limits.push({ org_id: ORG, user_id: ADMIN, monthly_cap_usd: 50, updated_by: ADMIN2 });
    const some = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect(some.status).toBe(403);
    expect(String(some.json.error)).toMatch(/can't clear your own monthly AI cap override/);
    expect(limitsOf(ADMIN)).toEqual([50]);
    // an override that cannot be read is never "none": 503, nothing changed
    db.errors["ai_usage_limits:select:nolimit"] = { message: "connection reset" };
    const unread = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect(unread.status).toBe(503);
    expect(String(unread.json.error)).toMatch(/Couldn't read your own cap override, so nothing was changed: connection reset/);
    expect(limitsOf(ADMIN)).toEqual([50]);
    expect(capDetails()).toEqual([]);
  });
});

describe("GOV-4 / GOV-1 — a team ledger that can't be summed leaves the viewer's own meter and the editor up (fix pass 12)", () => {
  it("past the read ceiling (100,000 rows this month, org-wide) the GET answers 200 with the viewer's own figures and says the team view is unavailable — never a 503 for the whole dialog, never $0.00 a person", async () => {
    const at = new Date().toISOString();
    db.tables.ai_usage_events = Array.from({ length: 100_000 }, (_, i) => ({
      id: `x${i}`, created_at: at, org_id: ORG, user_id: ENG, op: "knowledgeEmbed", model: "m", input_tokens: 1, output_tokens: 0, est_cost_usd: 0.0001, ok: true,
    }));
    db.tables.ai_usage_events.push({ ...spend(ADMIN, "knowledgeAsk", 2.5), created_at: at });
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50 }];
    const r = await get(ADMIN);
    // was: 503 "the usage ledger holds more than 100000 rows this month" — no meter, no editor
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ spentUsd: 2.5, capUsd: 50, canManageCaps: true, orgCapUsd: 50, selfUserId: ADMIN, soleCapsHolder: false });
    expect(r.json.team).toBeUndefined();
    expect(String(r.json.teamUnavailable)).toBe("the usage ledger holds more than 100000 rows this month");
    expect(r.json.usageUnavailable).toBeUndefined();
  }, 30_000);

  it("an outage between the viewer's own read and the team's is said the same way; the viewer's OWN unreadable ledger is still a 503", async () => {
    db.tables.ai_usage_events = [spend(ADMIN, "knowledgeAsk", 1), spend(ENG, "knowledgeAsk", 3)];
    let reads = 0;
    db.hook = ({ table, action }) => {
      // the viewer's own read is one select (its exact count says it holds
      // every row); the team read is the next
      if (table === "ai_usage_events" && action === "select" && ++reads > 1) db.errors["ai_usage_events:select"] = { message: "connection reset" };
    };
    const r = await get(ADMIN);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ spentUsd: 1, canManageCaps: true, orgCapUsd: 10 });
    expect(r.json.team).toBeUndefined();
    expect(r.json.teamUnavailable).toBe("couldn't read the usage ledger: connection reset");
    db.hook = null;
    const own = await get(ADMIN);
    expect(own.status).toBe(503);
    expect(own.json.usageUnavailable).toBe(true);
  });
});

describe("integrator, I-05 final review — the GET says what was spent and whose list it couldn't read", () => {
  it("GOV-3: a locked member who spent nothing reads spentUsd 0 — the lock floor the server gates on is never sent as money", async () => {
    db.tables.ai_usage_events = [];
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 0 }];
    const r = await get(ENG);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ spentUsd: 0, capUsd: 0, locked: true, percent: 100 });
    // a locked member who DID spend this month still reads what they spent
    db.tables.ai_usage_events = [spend(ENG, "knowledgeAsk", 1.25)];
    const spent = await get(ENG);
    expect(spent.json).toMatchObject({ spentUsd: 1.25, capUsd: 0, locked: true, percent: 100 });
  });

  it("GOV-4: a member list that can't be read is said as teamUnavailable — never 200 with an empty team; the viewer's own meter and the default's editor stay", async () => {
    db.tables.ai_usage_events = [spend(ADMIN, "knowledgeAsk", 1), spend(ENG, "knowledgeAsk", 3)];
    db.errors["org_members:select:many"] = { message: "connection reset" };
    const r = await get(ADMIN);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ spentUsd: 1, canManageCaps: true, orgCapUsd: 10 });
    expect(r.json.team).toBeUndefined();
    expect(r.json.soleCapsHolder).toBeUndefined();
    expect(r.json.teamUnavailable).toBe("the member list can't be read (connection reset)");
  });
});

describe("GOV-10 — the sequential matrix: the reviewer's flows T1–T10, each request finished before the next (committed in fix pass 12)", () => {
  const limitsOf = (uid: string | null) => db.tables.ai_usage_limits.filter((l) => (l.user_id ?? null) === uid).map((l) => l.monthly_cap_usd);
  const capDetails = () => db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED").map((a) => plainDetails(a.details));
  const told = () => notices().map((n) => [n.user_id, n.title, n.body]);

  it("T1–T3: a non-sole holder who follows the default raises it (held, told), is cleared by another holder, raises again (held at the new figure), then lowers it (no hold)", async () => {
    let r = await post(ADMIN, { capUsd: 20 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 20, locked: false, selfHeldAtUsd: 10 }]);
    expect([limitsOf(null), limitsOf(ADMIN)]).toEqual([[20], [10]]);
    expect(capDetails()).toEqual([{ capUsd: 20, previousCapUsd: 10 }, { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true }]);
    expect(told()).toEqual([[ADMIN2, "A monthly AI cap changed",
      "Ada changed the workspace's default monthly AI cap from $10 to $20; Ada's own cap stays at $10 as a personal cap, so a change to the default no longer moves it."]]);
    // T2: another holder clears the hold; ADMIN follows $20; a second raise holds them at $20
    r = await post(ADMIN2, { capUsd: null, userId: ADMIN });
    expect([r.status, r.json]).toEqual([200, { ok: true, cleared: true }]);
    expect(limitsOf(ADMIN)).toEqual([]);
    expect((await get(ADMIN)).json.capUsd).toBe(20);
    r = await post(ADMIN, { capUsd: 30 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 30, locked: false, selfHeldAtUsd: 20 }]);
    expect([limitsOf(null), limitsOf(ADMIN)]).toEqual([[30], [20]]);
    // T3: lowering the default holds nobody; ADMIN keeps their own $20
    r = await post(ADMIN, { capUsd: 15 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 15, locked: false }]);
    expect([limitsOf(null), limitsOf(ADMIN)]).toEqual([[15], [20]]);
    expect(capDetails().slice(-2)).toEqual([{ targetUserId: ADMIN, capUsd: 20, previousCapUsd: 20, heldOnDefaultRaise: true }, { capUsd: 15, previousCapUsd: 30 }]);
  });

  it("T4: another member's override — set, raise, lower, lock, unlock, clear, clear again (unchanged) — each audited and told to both, by name", async () => {
    const steps: Array<[Row, number[], number, Row]> = [
      [{ capUsd: 25, userId: ENG }, [25], 25, { ok: true, capUsd: 25, locked: false }],
      [{ capUsd: 40, userId: ENG }, [40], 40, { ok: true, capUsd: 40, locked: false }],
      [{ capUsd: 5, userId: ENG }, [5], 5, { ok: true, capUsd: 5, locked: false }],
      [{ capUsd: 0, userId: ENG }, [0], 0, { ok: true, capUsd: 0, locked: true }],
      [{ capUsd: 10, userId: ENG }, [10], 10, { ok: true, capUsd: 10, locked: false }],
      [{ capUsd: null, userId: ENG }, [], 10, { ok: true, cleared: true }],
      [{ capUsd: null, userId: ENG }, [], 10, { ok: true, cleared: false, unchanged: true }],
    ];
    for (const [body, rows, cap, answer] of steps) {
      const r = await post(ADMIN, body);
      expect([r.status, r.json], JSON.stringify(body)).toEqual([200, answer]);
      expect(limitsOf(ENG)).toEqual(rows);
      expect((await get(ENG)).json).toMatchObject({ capUsd: cap, locked: cap === 0 });
    }
    expect(capDetails()).toEqual([
      { targetUserId: ENG, capUsd: 25, previousCapUsd: 10 },
      { targetUserId: ENG, capUsd: 40, previousCapUsd: 25 },
      { targetUserId: ENG, capUsd: 5, previousCapUsd: 40 },
      { targetUserId: ENG, capUsd: 0, previousCapUsd: 5 },
      { targetUserId: ENG, capUsd: 10, previousCapUsd: 0 },
      { targetUserId: ENG, cleared: true, previousCapUsd: 10 },
    ]);
    const bodies = ["$10 to $25", "$25 to $40", "$40 to $5", "$5 to $0 (locked)", "$0 (locked) to $10", "$10 to the workspace default"]
      .map((ft) => `Ada changed Eve's monthly AI cap from ${ft}.`);
    expect(told()).toEqual(bodies.flatMap((b) => [[ADMIN2, "A monthly AI cap changed", b], [ENG, "Your monthly AI cap changed", b]]));
  });

  it("T5: one of several holders, on an override another holder set — lowering is theirs, a raise and a clear are not, a lock stays theirs to lift; a default raise leaves the locked override alone", async () => {
    expect((await post(ADMIN2, { capUsd: 60, userId: ADMIN })).json).toEqual({ ok: true, capUsd: 60, locked: false });
    const steps: Array<[Row, number, number[]]> = [
      [{ capUsd: 55, userId: ADMIN }, 200, [55]],
      [{ capUsd: 58, userId: ADMIN }, 403, [55]],
      [{ capUsd: null, userId: ADMIN }, 403, [55]],
      [{ capUsd: 0, userId: ADMIN }, 200, [0]],
      [{ capUsd: 5, userId: ADMIN }, 403, [0]],
    ];
    for (const [body, status, rows] of steps) {
      const r = await post(ADMIN, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      if (status === 403) expect(String(r.json.error)).toMatch(body.capUsd === null ? /can't clear your own monthly AI cap override/ : /can't raise your own monthly AI cap/);
      expect(limitsOf(ADMIN)).toEqual(rows);
    }
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, capUsd: 60, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 55, previousCapUsd: 60 },
      { targetUserId: ADMIN, capUsd: 0, previousCapUsd: 55 },
    ]);
    const r = await post(ADMIN, { capUsd: 100 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 100, locked: false }]);
    expect([limitsOf(null), limitsOf(ADMIN)]).toEqual([[100], [0]]);
  });

  it("T6: a sole holder raises their own cap, clears it (a lowering), lowers it by insert, clears onto a higher default, and raises the default they follow — each said, none told", async () => {
    db.tables.org_members[1].roles = ["Manager"];
    const steps: Array<[Row, Row, number[]]> = [
      [{ capUsd: 50, userId: ADMIN }, { ok: true, capUsd: 50, locked: false, soleHolder: true }, [50]],
      [{ capUsd: null, userId: ADMIN }, { ok: true, cleared: true }, []],
      [{ capUsd: 5, userId: ADMIN }, { ok: true, capUsd: 5, locked: false }, [5]],
      [{ capUsd: null, userId: ADMIN }, { ok: true, cleared: true, soleHolder: true }, []],
      [{ capUsd: 30 }, { ok: true, capUsd: 30, locked: false, soleHolder: true }, []],
    ];
    for (const [body, answer, rows] of steps) {
      const r = await post(ADMIN, body);
      expect([r.status, r.json], JSON.stringify(body)).toEqual([200, answer]);
      expect(limitsOf(ADMIN)).toEqual(rows);
    }
    expect(limitsOf(null)).toEqual([30]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 30, soleCapsHolder: true, selfFollowsDefault: true });
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, capUsd: 50, previousCapUsd: 10, soleHolder: true },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 50 },
      { targetUserId: ADMIN, capUsd: 5, previousCapUsd: 10 },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 5, soleHolder: true },
      { capUsd: 30, previousCapUsd: 10, soleHolder: true },
    ]);
    expect(notices()).toEqual([]);
  });

  it("T7: Doc Control sees the team read-only and is refused a change; a member sees only their own meter", async () => {
    const d = await get(DOC);
    expect(d.status).toBe(200);
    expect(d.json.canManageCaps).toBe(false);
    expect(Array.isArray(d.json.team)).toBe(true);
    expect(d.json.soleCapsHolder).toBeUndefined();
    const p = await post(DOC, { capUsd: 50 });
    expect(p.status).toBe(403);
    expect(String(p.json.error)).toMatch(/Manage AI spend caps/);
    const e = await get(ENG);
    expect(e.status).toBe(200);
    for (const key of ["team", "orgCapUsd", "selfUserId", "selfFollowsDefault", "soleCapsHolder", "teamUnavailable"]) expect(e.json[key], key).toBeUndefined();
    expect(e.json).toMatchObject({ canManageCaps: false, capUsd: 10, locked: false });
  });

  it("T8: a non-sole holder who follows the default locks the workspace, then unlocks it — held at $0 (told), until another holder lifts them", async () => {
    let r = await post(ADMIN, { capUsd: 0 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 0, locked: true }]);
    expect(limitsOf(null)).toEqual([0]);
    expect((await get(ADMIN)).json.locked).toBe(true);
    expect((await get(ENG)).json.locked).toBe(true);
    r = await post(ADMIN, { capUsd: 10 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 10, locked: false, selfHeldAtUsd: 0 }]);
    expect([limitsOf(null), limitsOf(ADMIN)]).toEqual([[10], [0]]);
    expect((await get(ADMIN)).json.locked).toBe(true);
    expect((await get(ENG)).json.capUsd).toBe(10);
    expect(capDetails()).toEqual([
      { capUsd: 0, previousCapUsd: 10 },
      { capUsd: 10, previousCapUsd: 0 },
      { targetUserId: ADMIN, capUsd: 0, previousCapUsd: 0, heldOnDefaultRaise: true },
    ]);
    expect(told().at(-1)).toEqual([ADMIN2, "A monthly AI cap changed",
      "Ada changed the workspace's default monthly AI cap from $0 (locked) to $10; Ada's own cap stays at $0 (locked) as a personal cap, so a change to the default no longer moves it."]);
    r = await post(ADMIN2, { capUsd: 10, userId: ADMIN });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 10, locked: false }]);
    expect(limitsOf(ADMIN)).toEqual([10]);
  });

  it("T9: a holder who follows the default pins themselves at its figure (said and told as that), lowers it, then raises the default with no hold", async () => {
    let r = await post(ADMIN, { capUsd: 10, userId: ADMIN });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 10, locked: false, pinnedAtDefault: true }]);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect(told()).toEqual([[ADMIN2, "A monthly AI cap changed",
      "Ada set their own monthly AI cap to $10 — the figure of the workspace default it followed until now — so a change to the default no longer moves it."]]);
    r = await post(ADMIN, { capUsd: 8, userId: ADMIN });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 8, locked: false }]);
    expect(limitsOf(ADMIN)).toEqual([8]);
    r = await post(ADMIN, { capUsd: 50 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 50, locked: false }]);
    expect([limitsOf(null), limitsOf(ADMIN)]).toEqual([[50], [8]]);
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, pinnedAtDefault: true },
      { targetUserId: ADMIN, capUsd: 8, previousCapUsd: 10 },
      { capUsd: 50, previousCapUsd: 10 },
    ]);
  });

  it("T10: clearing a member's override when there is none is unchanged — nothing audited, nobody told", async () => {
    const r = await post(ADMIN, { capUsd: null, userId: ENG });
    expect([r.status, r.json]).toEqual([200, { ok: true, cleared: false, unchanged: true }]);
    expect(capDetails()).toEqual([]);
    expect(notices()).toEqual([]);
  });
});

describe("GOV-3 — the meter says what the server enforces", () => {
  it("a $0 cap reads locked, 0, 100% — and 0 is accepted as the lock, not as 'no cap'", async () => {
    expect((await post(ADMIN, { capUsd: 0, userId: ENG })).status).toBe(200);
    const r = await get(ENG);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ capUsd: 0, locked: true, percent: 100, canManageCaps: false });
  });

  it("an ordinary month reads its real percent and is not locked", async () => {
    db.tables.ai_usage_events = [spend(ENG, "knowledgeAsk", 2.5)];
    expect((await get(ENG)).json).toMatchObject({ spentUsd: 2.5, capUsd: 10, locked: false, percent: 25 });
  });

  it("out-of-range caps are refused with a sentence that says what 0 means", async () => {
    const r = await post(ADMIN, { capUsd: -1 });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/0 locks AI/);
    expect((await post(ADMIN, { capUsd: 10001 })).status).toBe(400);
  });
});

describe("GOV-4 — an unreadable cap table refuses; nobody is shown, or audited from, a $10 that isn't there", () => {
  it("the team view answers 503 usageUnavailable instead of everyone 'on the $10 default'", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: ENG, monthly_cap_usd: 0 }, { org_id: ORG, user_id: null, monthly_cap_usd: 50 }];
    db.errors["ai_usage_limits:select:nolimit"] = { message: "canceling statement due to statement timeout" };
    const r = await get(ADMIN);
    expect(r.status).toBe(503);
    expect(r.json.usageUnavailable).toBe(true);
    expect(r.json.team).toBeUndefined();
    expect(String(r.json.error)).toMatch(/statement timeout/);
  });

  it("setting the default refuses (503) when the previous default cannot be read — no row, no audit 'from $10'", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50 }];
    db.errors["ai_usage_limits:select:nolimit"] = { message: "connection reset" };
    const r = await post(ADMIN, { capUsd: 20 });
    expect(r.status).toBe(503);
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === null)?.monthly_cap_usd).toBe(50);
    expect(db.tables.audit_logs).toHaveLength(0);
    expect(notices()).toHaveLength(0);
  });

  it("clearing an override refuses (503) when the default it would fall back to cannot be read (the self-raise test reads it)", async () => {
    // A SOLE holder clearing their own: with another holder, clearing your
    // own override is refused before anything is read (GOV-10, write time).
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== ADMIN2);
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
    db.errors["ai_usage_limits:select:nolimit"] = { message: "connection reset" };
    expect((await post(ADMIN, { capUsd: null, userId: ADMIN })).status).toBe(503);
    expect(db.tables.ai_usage_limits).toHaveLength(2);
  });
});

describe("GOV-4 / GOV-1 — the meter is every op, and an unreadable ledger is said", () => {
  it("a ledger read error answers 503 usageUnavailable — not $0.00 of $10.00", async () => {
    db.errors["ai_usage_events:select"] = { message: "connection reset" };
    const r = await get(ENG);
    expect(r.status).toBe(503);
    expect(r.json.usageUnavailable).toBe(true);
  });

  it("the member's figure and the team table carry every op, broken out per feature", async () => {
    db.tables.ai_usage_events = [spend(ENG, "knowledgeAsk", 1), spend(ENG, "knowledgeEmbed", 2), spend(ENG, "drawingLocate", 3)];
    const mine = (await get(ENG)).json;
    expect(mine.spentUsd).toBe(6);
    expect((mine.byOp as Record<string, { spentUsd: number }>).knowledgeEmbed.spentUsd).toBe(2);
    expect(mine.team).toBeUndefined();
    // Doc Control still SEES the team (a controller) but may not edit it
    const doc = (await get(DOC)).json;
    expect(doc.canManageCaps).toBe(false);
    const row = (doc.team as Row[]).find((t) => t.userId === ENG)!;
    expect(row).toMatchObject({ spentUsd: 6, calls: 3 });
    expect((await get(ADMIN)).json.canManageCaps).toBe(true);
  });
});

describe("GOV-10 — the target is the uid the DATABASE returns: your own uid in any spelling is still your own", () => {
  // Every spelling Postgres's uuid input accepts for the same id.
  const spellings = (uid: string) => [
    uid.toUpperCase(),
    `{${uid}}`,
    uid.replace(/-/g, ""),
    `{${uid.toUpperCase().replace(/-/g, "")}}`,
  ];

  it("raising or clearing your own cap under another spelling is refused 403 while another holder exists — nothing written, nobody told (the review's scenario)", async () => {
    const before = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
    db.tables.ai_usage_limits = before.map((r) => ({ ...r }));
    for (const spelled of spellings(ADMIN)) {
      const up = await post(ADMIN, { capUsd: 10000, userId: spelled });
      expect(up.status, spelled).toBe(403);
      expect(String(up.json.error)).toMatch(/can't raise your own/);
      // clearing the $10 override onto the $50 default is a raise too
      expect((await post(ADMIN, { capUsd: null, userId: spelled })).status, spelled).toBe(403);
    }
    expect(db.tables.ai_usage_limits).toEqual(before);
    expect(db.tables.audit_logs).toHaveLength(0);
    expect(notices()).toHaveLength(0);
  });

  it("the uuid columns match any spelling (as Postgres's do), and every write, audit row and notice carries the canonical uid", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
    // another holder may raise ADMIN's cap, whatever the spelling: it lands on ADMIN's own row
    const r = await post(ADMIN2, { capUsd: 40, userId: ADMIN.toUpperCase() });
    expect(r.status).toBe(200);
    expect(db.tables.ai_usage_limits).toEqual([expect.objectContaining({ user_id: ADMIN, monthly_cap_usd: 40 })]);
    expect(plainDetails(db.tables.audit_logs.at(-1)!.details)).toEqual({ targetUserId: ADMIN, capUsd: 40, previousCapUsd: 10 });
    expect(notices().map((n) => [n.user_id, n.title])).toEqual([[ADMIN, "Your monthly AI cap changed"]]);
    // lowering your own cap under a braced spelling is allowed — it updates
    // the canonical row (never a second one) and you are not told about it
    const down = await post(ADMIN, { capUsd: 5, userId: `{${ADMIN.toUpperCase()}}` });
    expect(down.status).toBe(200);
    expect(db.tables.ai_usage_limits).toEqual([expect.objectContaining({ user_id: ADMIN, monthly_cap_usd: 5 })]);
    expect(plainDetails(db.tables.audit_logs.at(-1)!.details)).toEqual({ targetUserId: ADMIN, capUsd: 5, previousCapUsd: 40 });
    expect(notices().map((n) => n.user_id)).toEqual([ADMIN, ADMIN2]);
  });

  it("a SOLE holder raising their own cap under another spelling is audited soleHolder with the canonical uid and sent no notice about it", async () => {
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== ADMIN2);
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    const r = await post(ADMIN, { capUsd: 75, userId: ADMIN.replace(/-/g, "").toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.json.soleHolder).toBe(true);
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === ADMIN)?.monthly_cap_usd).toBe(75);
    expect(db.tables.audit_logs.map((a) => plainDetails(a.details))).toEqual([{ targetUserId: ADMIN, capUsd: 75, previousCapUsd: 10, soleHolder: true }]);
    expect(notices()).toHaveLength(0);
  });

  it("a userId that is not a uuid is refused (400) before any lookup", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
    for (const bad of ["not-a-uuid", ADMIN.slice(0, -1), `${ADMIN}0`, `{${ADMIN}`, `${ADMIN}}`, `${ADMIN.slice(0, 5)}-${ADMIN.slice(5).replace(/-/g, "")}`, `${ADMIN.slice(0, -1)}g`]) {
      const r = await post(ADMIN2, { capUsd: 40, userId: bad });
      expect(r.status, bad).toBe(400);
      expect(String(r.json.error)).toMatch(/workspace member's id/);
    }
    expect(db.tables.ai_usage_limits).toEqual([{ org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }]);
    expect(db.tables.audit_logs).toHaveLength(0);
  });
});

describe("GOV-10 — a SOLE holder's own raise is recorded before it is made", () => {
  beforeEach(() => {
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== ADMIN2);
  });

  it("an audit row that cannot be written refuses the raise (503) on all three paths — the stored caps are unchanged", async () => {
    db.errors["audit_logs:insert"] = { message: "new row violates check constraint" };
    // an override of their own
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 5 }];
    const own = await post(ADMIN, { capUsd: 75, userId: ADMIN });
    expect(own.status).toBe(503);
    expect(String(own.json.error)).toMatch(/audit record .* so nothing was changed: new row violates check constraint/);
    // clearing it onto the higher default
    expect((await post(ADMIN, { capUsd: null, userId: ADMIN })).status).toBe(503);
    expect(db.tables.ai_usage_limits).toEqual([{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 5 }]);
    // raising the default they follow
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    expect((await post(ADMIN, { capUsd: 50 })).status).toBe(503);
    expect(db.tables.ai_usage_limits).toEqual([{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }]);
    expect(notices()).toHaveLength(0);
    // a change that is not their own raise is not held to it (its audit row stays best-effort, as before)
    expect((await post(ADMIN, { capUsd: 3, userId: ENG })).status).toBe(200);
    expect((await post(ADMIN, { capUsd: 5 })).status).toBe(200);
  });

  it("the record is written first; a save that then fails is recorded as not applied", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 5 }];
    db.errors["ai_usage_limits:update"] = { message: "permission denied" };
    const up = await post(ADMIN, { capUsd: 75, userId: ADMIN });
    expect(up.status).toBe(500);
    db.errors["ai_usage_limits:delete"] = { message: "permission denied" };
    expect((await post(ADMIN, { capUsd: null, userId: ADMIN })).status).toBe(500);
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === ADMIN)?.monthly_cap_usd).toBe(5);
    expect(db.tables.audit_logs.map((a) => plainDetails(a.details))).toEqual([
      { targetUserId: ADMIN, capUsd: 75, previousCapUsd: 5, soleHolder: true },
      { targetUserId: ADMIN, capUsd: 75, previousCapUsd: 5, soleHolder: true, notApplied: true, error: "permission denied" },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 5, soleHolder: true },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 5, soleHolder: true, notApplied: true, error: "permission denied" },
    ]);
    expect(notices()).toHaveLength(0);
  });
});

describe("GOV-15 — app-side, until 20261173 is pasted: the sequential path, with no race machinery", () => {
  const limitsOf = (uid: string | null) => db.tables.ai_usage_limits.filter((l) => (l.user_id ?? null) === uid).map((l) => l.monthly_cap_usd);
  const capDetails = () => db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED").map((a) => a.details as Row);

  it("the route asks ai_cap_change first, with the uid the database returned and the roster's answer; PGRST202 (or 42883 naming it) is the app-side path, said once in the server log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
      const r = await post(ADMIN, { capUsd: 25, userId: ENG.toUpperCase() });
      expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 25, locked: false }]);
      expect(db.rpcCalls).toEqual([{ fn: "ai_cap_change", args: {
        p_org_id: ORG, p_actor: ADMIN, p_target: ENG, p_cap_usd: 25, p_clear: false, p_other_holders: true,
      } }]);
      expect(limitsOf(ENG)).toEqual([25]);
      // Postgres' own "function does not exist" naming it is the same path
      db.rpc = async () => ({ data: null, error: { code: "42883", message: "function ai_cap_change(uuid, uuid, uuid, numeric, boolean, boolean) does not exist" } });
      expect((await post(ADMIN, { capUsd: null, userId: ENG })).json).toEqual({ ok: true, cleared: true });
      // …but a 42883 raised INSIDE a deployed body is a failure, never the app-side path
      db.rpc = async () => ({ data: null, error: { code: "42883", message: "function hashtext(integer) does not exist" } });
      const failed = await post(ADMIN, { capUsd: 30, userId: ENG });
      expect(failed.status).toBe(500);
      expect(String(failed.json.error)).toMatch(/Couldn't save the cap: function hashtext/);
      expect(limitsOf(ENG)).toEqual([]);
      // said in the server log: pinned in a fresh server process by the next test
    } finally {
      warn.mockRestore();
    }
  });

  it("…and SAID: in a fresh server process the first app-side cap change logs the warning exactly once, with its message; the next says nothing more", async () => {
    // was: "at most once" over a module that earlier tests had already
    // taken down the app-side path, which held with no warning at all
    vi.resetModules();
    const { POST: freshPOST } = await import("@/app/api/ai/usage/route");
    const postFresh = async (who: string, body: Row) => {
      const r = await freshPOST(new NextRequest("https://app/api/ai/usage", { method: "POST", headers: { authorization: `Bearer ${who}`, "content-type": "application/json" }, body: JSON.stringify({ orgId: ORG, ...body }) }));
      return { status: r.status, json: await r.json() as Row };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
      expect(await postFresh(ADMIN, { capUsd: 25, userId: ENG })).toEqual({ status: 200, json: { ok: true, capUsd: 25, locked: false } });
      expect(await postFresh(ADMIN, { capUsd: 30, userId: ENG })).toEqual({ status: 200, json: { ok: true, capUsd: 30, locked: false } });
      // both asked the function first, and both were answered PGRST202
      expect(db.rpcCalls.map((c) => c.fn)).toEqual(["ai_cap_change", "ai_cap_change"]);
      expect(warn.mock.calls).toEqual([[
        "AI cap changes are running app-side: migration 20261173 (ai_cap_change) is not applied, so two cap changes in flight at once are not serialised. Paste it in the Supabase SQL editor.",
      ]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("nothing is read back or put back after a write (GOV-15 deletes the re-read): a default raise reads no cap after its default write, and its rows carry no writeId / limitRowId", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    const after: string[] = [];
    let wrote = false;
    db.after = ({ table, action }) => {
      if (table === "ai_usage_limits" && action === "update") wrote = true;
      else if (wrote) after.push(`${table}:${action}`);
    };
    const r = await post(ADMIN, { capUsd: 40 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 40, locked: false, selfHeldAtUsd: 10 }]);
    // only the two audit rows and the notice follow the default's write
    expect(after).toEqual(["audit_logs:insert", "audit_logs:insert", "notifications:insert"]);
    expect(capDetails()).toEqual([
      { capUsd: 40, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
    ]);
    for (const d of capDetails()) {
      expect(d.writeId).toBeUndefined();
      expect(d.limitRowId).toBeUndefined();
    }
  });

  it("clearing your own override stays refused here while another holder exists — even when it would LOWER your cap (there is no lock on this path); a lower figure is set directly", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 5 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
    const r = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/set a lower figure for yourself directly/);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect(db.tables.audit_logs).toHaveLength(0);
    expect((await post(ADMIN, { capUsd: 5, userId: ADMIN })).status).toBe(200);
    expect(limitsOf(ADMIN)).toEqual([5]);
    // another holder may clear it
    expect((await post(ADMIN2, { capUsd: null, userId: ADMIN })).status).toBe(200);
    expect(limitsOf(ADMIN)).toEqual([]);
  });

  it("a default write that fails after the hold was written takes the hold back out: 500, the setter still follows the default, nothing audited or told", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.errors["ai_usage_limits:update"] = { message: "canceling statement due to statement timeout" };
    const r = await post(ADMIN, { capUsd: 50 });
    expect(r.status).toBe(500);
    expect(String(r.json.error)).toMatch(/Couldn't save the cap: canceling statement/);
    expect([limitsOf(null), limitsOf(ADMIN)]).toEqual([[10], []]);
    expect(capDetails()).toEqual([]);
    expect(notices()).toHaveLength(0);
  });

  it("…and a hold that cannot be taken back out stays: said in the answer, audited holdKept, and told to the other holders", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.errors["ai_usage_limits:update"] = { message: "statement timeout" };
    db.errors["ai_usage_limits:delete"] = { message: "permission denied" };
    const r = await post(ADMIN, { capUsd: 50 });
    expect(r.status).toBe(500);
    expect(r.json.holdKept).toBe(true);
    expect(String(r.json.error)).toMatch(/Your own cap stays held at \$10: it could not be taken back out \(permission denied\)/);
    expect([limitsOf(null), limitsOf(ADMIN)]).toEqual([[10], [10]]);
    expect(capDetails()).toEqual([{
      targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true, defaultNotRaised: true,
      holdKept: "it could not be taken back out (permission denied)", error: "statement timeout",
    }]);
    expect(notices().map((n) => [n.user_id, n.title])).toEqual([[ADMIN2, "A monthly AI cap is still held"]]);
  });

  // Restored by I-18's completion (2026-10-07): two sequential expectations
  // of the tenth review's S3 test (fix pass 11), which df24894 deleted with
  // the race describe they sat in. They are sequential (one request, a log
  // that refuses), so they hold on this path exactly as before.
  it("the tenth review's S3, sequential part (fix pass 11): a raise of the default whose row the log refuses still goes ahead (as at 052271b), never a 503 — with an override of one's own, and held while following the default; the other holder is told all the same", async () => {
    for (const own of [45, null] as const) {
      db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 40, updated_by: ADMIN2 }];
      if (own !== null) db.tables.ai_usage_limits.push({ org_id: ORG, user_id: ADMIN, monthly_cap_usd: own, updated_by: ADMIN });
      db.tables.audit_logs = [];
      db.tables.notifications = [];
      db.errors["audit_logs:insert"] = { message: "audit write timed out" };
      const r = await post(ADMIN, { capUsd: 100 });
      delete db.errors["audit_logs:insert"];
      expect(r.status, String(own)).toBe(200);
      expect(r.json).toMatchObject({ ok: true, capUsd: 100 });
      expect(limitsOf(null)).toEqual([100]);
      // the follower is still held where they were; the one with an override keeps it
      expect(limitsOf(ADMIN)).toEqual(own === null ? [40] : [own]);
      if (own === null) expect(r.json).toMatchObject({ selfHeldAtUsd: 40 });
      // the log refused every row, as at 052271b; the other holder is told all the same
      expect(db.tables.audit_logs).toHaveLength(0);
      expect(notices().filter((n) => n.user_id === ADMIN2).map((n) => n.title)).toContain("A monthly AI cap changed");
    }
  });

  it("…and a row the log refuses once is tried again after the raise has landed: the raise is in the log once", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 40, updated_by: ADMIN2 },
      { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 45, updated_by: ADMIN }];
    db.tables.audit_logs = [];
    let refused = 0;
    db.hook = ({ table, action }) => {
      if (table === "audit_logs" && action === "insert" && refused === 0) { refused = 1; db.errors["audit_logs:insert"] = { message: "audit write timed out" }; }
    };
    db.after = ({ table, action }) => { if (table === "audit_logs" && action === "insert") delete db.errors["audit_logs:insert"]; };
    const r = await post(ADMIN, { capUsd: 100 });
    db.hook = null;
    db.after = null;
    expect(r.status).toBe(200);
    expect(capDetails()).toEqual([{ capUsd: 100, previousCapUsd: 40 }]);
  });

  it("an update that matches no row (the row went between the read and the write) is never a 200: 409, nothing audited or told", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: ENG, monthly_cap_usd: 25 }];
    db.hook = ({ table, action }) => {
      if (table === "ai_usage_limits" && action === "update") { db.hook = null; db.tables.ai_usage_limits = []; }
    };
    const r = await post(ADMIN, { capUsd: 0, userId: ENG });
    expect(r.status).toBe(409);
    expect(r.json.conflict).toBe(true);
    expect(capDetails()).toEqual([]);
    expect(notices()).toHaveLength(0);
  });
});

describe("GOV-15 — through ai_cap_change (20261173 pasted): one transaction decides, writes and audits; the route maps its answer", () => {
  /** ai_cap_change's answer, as PostgreSQL 16 returned it for the matrix's
   *  flows (scratch harness, recorded in GOV-15's resolution). */
  const fnAnswer = (over: Row): Row => ({
    outcome: "changed", cleared: false, cap_usd: null, previous_cap_usd: 10, sole_holder: false,
    pinned_at_default: false, held_self_at_usd: null, audit_retry: [], ...over,
  });
  const answering = (...answers: Row[]) => {
    const queue = [...answers];
    db.rpc = async () => ({ data: queue.shift() ?? null, error: null });
  };
  const told = () => notices().map((n) => [n.user_id, n.title, n.body]);

  it("T1 through the function: the default raise with its hold — the same answer and notice, and the route writes no cap row and no audit row of its own", async () => {
    answering(fnAnswer({ cap_usd: 20, held_self_at_usd: 10 }));
    const r = await post(ADMIN, { capUsd: 20 });
    expect([r.status, r.json]).toEqual([200, { ok: true, capUsd: 20, locked: false, selfHeldAtUsd: 10 }]);
    expect(db.rpcCalls[0].args).toEqual({ p_org_id: ORG, p_actor: ADMIN, p_target: null, p_cap_usd: 20, p_clear: false, p_other_holders: true });
    expect(told()).toEqual([[ADMIN2, "A monthly AI cap changed",
      "Ada changed the workspace's default monthly AI cap from $10 to $20; Ada's own cap stays at $10 as a personal cap, so a change to the default no longer moves it."]]);
    expect(db.tables.ai_usage_limits).toEqual([]);
    expect(db.tables.audit_logs).toEqual([]);
  });

  it("T4 / T10 through the function: a person's cap, a clear, a clear of nothing — answered and told as before", async () => {
    answering(fnAnswer({ cap_usd: 25 }), fnAnswer({ cleared: true, previous_cap_usd: 25 }), { outcome: "unchanged", cleared: false });
    expect((await post(ADMIN, { capUsd: 25, userId: ENG })).json).toEqual({ ok: true, capUsd: 25, locked: false });
    expect((await post(ADMIN, { capUsd: null, userId: ENG })).json).toEqual({ ok: true, cleared: true });
    expect((await post(ADMIN, { capUsd: null, userId: ENG })).json).toEqual({ ok: true, cleared: false, unchanged: true });
    expect(db.rpcCalls.map((c) => c.args.p_clear)).toEqual([false, true, true]);
    expect(told()).toEqual(["$10 to $25", "$25 to the workspace default"].flatMap((ft) => [
      [ADMIN2, "A monthly AI cap changed", `Ada changed Eve's monthly AI cap from ${ft}.`],
      [ENG, "Your monthly AI cap changed", `Ada changed Eve's monthly AI cap from ${ft}.`],
    ]));
  });

  it("T5 through the function: a holder's own self-clear that is NOT a raise is allowed again (GOV-15 done-when 3) — answered and told as a clear", async () => {
    answering(fnAnswer({ cleared: true, previous_cap_usd: 55 }));
    const r = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect([r.status, r.json]).toEqual([200, { ok: true, cleared: true }]);
    expect(db.rpcCalls[0].args).toMatchObject({ p_target: ADMIN, p_clear: true, p_cap_usd: null, p_other_holders: true });
    expect(told()).toEqual([[ADMIN2, "A monthly AI cap changed", "Ada changed their own monthly AI cap from $55 to the workspace default."]]);
  });

  it("T6 / T9 through the function: a sole holder's raise is said (nobody to tell); a pin at the default's figure is said and told as that", async () => {
    db.tables.org_members[1].roles = ["Manager"];
    answering(fnAnswer({ cap_usd: 50, sole_holder: true }));
    expect((await post(ADMIN, { capUsd: 50, userId: ADMIN })).json).toEqual({ ok: true, capUsd: 50, locked: false, soleHolder: true });
    expect(db.rpcCalls[0].args.p_other_holders).toBe(false);
    expect(notices()).toEqual([]);
    db.tables.org_members[1].roles = ["Manager", "Admin"];
    answering(fnAnswer({ cap_usd: 10, pinned_at_default: true }));
    expect((await post(ADMIN, { capUsd: 10, userId: ADMIN })).json).toEqual({ ok: true, capUsd: 10, locked: false, pinnedAtDefault: true });
    expect(told()).toEqual([[ADMIN2, "A monthly AI cap changed",
      "Ada set their own monthly AI cap to $10 — the figure of the workspace default it followed until now — so a change to the default no longer moves it."]]);
  });

  it("its refusals are the sentences the app-side path answers (a self-clear only when it would raise the cap), and nothing is told", async () => {
    answering({ outcome: "refused", reason: "self_raise" });
    let r = await post(ADMIN, { capUsd: 9999, userId: ADMIN });
    expect([r.status, r.json.error]).toEqual([403, "You can't raise your own monthly AI cap — another person with the “Manage AI spend caps” permission has to."]);
    answering({ outcome: "refused", reason: "self_clear" });
    r = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/can't clear your own monthly AI cap override .* the workspace default is higher, so clearing it would raise your cap/);
    answering({ outcome: "refused", reason: "sole_audit_failed", error: "new row violates check constraint" });
    r = await post(ADMIN, { capUsd: 75, userId: ADMIN });
    expect([r.status, r.json.error]).toEqual([503, "Couldn't write the audit record that raising your own cap without a second signature needs, so nothing was changed: new row violates check constraint"]);
    expect(notices()).toEqual([]);
  });

  it("a roster that cannot be read is passed as NULL — refused (503, its reason) only where the decision needs it", async () => {
    db.errors["org_members:select:many"] = { message: "statement timeout" };
    answering({ outcome: "refused", reason: "roster_unreadable" });
    const r = await post(ADMIN, { capUsd: 50, userId: ADMIN });
    expect([r.status, r.json.error]).toEqual([503, "Couldn't check who else manages AI caps, so nothing was changed: statement timeout"]);
    expect(db.rpcCalls[0].args.p_other_holders).toBeNull();
    answering(fnAnswer({ cap_usd: 5 }));
    expect((await post(ADMIN, { capUsd: 5 })).status).toBe(200);
  });

  it("a row the log refused inside the transaction is tried again once the change has landed (best-effort, as every change's row is)", async () => {
    const row = { targetUserId: ENG, capUsd: 3, previousCapUsd: 10 };
    answering(fnAnswer({ cap_usd: 3, audit_retry: [row] }));
    expect((await post(ADMIN, { capUsd: 3, userId: ENG })).status).toBe(200);
    expect(db.tables.audit_logs.map((a) => [a.action, a.user_id, a.details])).toEqual([["AI_CAP_CHANGED", ADMIN, row]]);
  });

  it("a function that errors rolled its transaction back: 500, nothing written app-side, nobody told — and an invalid figure never reaches it", async () => {
    db.rpc = async () => ({ data: null, error: { code: "40P01", message: "deadlock detected" } });
    const r = await post(ADMIN, { capUsd: 40 });
    expect([r.status, r.json.error]).toEqual([500, "Couldn't save the cap: deadlock detected"]);
    expect(db.tables.ai_usage_limits).toEqual([]);
    expect(db.tables.audit_logs).toEqual([]);
    expect(notices()).toEqual([]);
    db.rpcCalls = [];
    expect((await post(ADMIN, { capUsd: 10001 })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });
});

describe("GOV-3 — a client reading the meter sees a lock as a refusal, never 'no cap'", () => {
  beforeEach(() => {
    // lib/knowledge's getAiUsage, answered by the real GET above
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const r = await GET(new NextRequest(`https://app${url}`, { headers: init?.headers ?? {} }));
      return { ok: r.ok, status: r.status, json: async () => r.json() } as unknown as Response;
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a locked member's summary carries locked and capUsd 0, and aiUsageLockedReason says the lock — where a `cap > 0 && spent >= cap` check passes it", async () => {
    expect((await post(ADMIN, { capUsd: 0, userId: ENG })).status).toBe(200);
    db.sessionToken = ENG;
    const usage = await getAiUsage(ORG);
    expect(usage).toMatchObject({ capUsd: 0, locked: true });
    expect(usage.spentUsd.toFixed(2)).toBe("0.00");
    // the shape a re-index guard used to read a $0 cap as no limit
    const cap = Number(usage.capUsd) || 0;
    expect(cap > 0 && usage.spentUsd >= cap).toBe(false);
    expect(aiUsageLockedReason(usage)).toBe("your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it");
    // capUsd 0 alone is the lock too; an ordinary cap is not
    expect(aiUsageLockedReason({ capUsd: 0 })).not.toBeNull();
    db.sessionToken = DOC;
    const open = await getAiUsage(ORG);
    expect(open).toMatchObject({ capUsd: 10, locked: false });
    expect(aiUsageLockedReason(open)).toBeNull();
  });
});
