// intelligence Round G — I-05: /api/ai/usage.
//
//   GOV-10  setting caps is the `ai.manage_caps` capability (default Admin)
//           read from the org's policy — Doc Control is refused unless
//           granted; nobody raises their OWN cap while another person holds
//           the capability — by an override, by clearing one, or by raising
//           the workspace default they follow (they are held where they
//           were); a SOLE holder has nobody to ask, so their raise goes
//           through, audited soleHolder; every change notifies the other
//           holders and the person whose cap moved; the target is the
//           uid the DATABASE returns, so the caller's own uid in another
//           spelling (upper case, braces, no hyphens) is still their own;
//           a sole holder's own raise is refused unless its audit row is
//           written first; the ban holds at WRITE time — every write that
//           can RAISE your own cap (a default raise, taking a hold back out,
//           your own override inserted while you follow the default, read
//           against the default before and after) is read again with who
//           wrote the row: a rise on your own write is put back DOWN, never
//           over a figure set since (the other holders told), a rise another
//           holder signed stands (a trim of your own raise is not theirs),
//           one that cannot be read back is said (503), never a plain 200; a
//           default lowering is not re-read; a hold is written at the lower
//           figure read, and one that stays (or was changed by someone else)
//           is said and told
//   GOV-4   an unreadable cap table refuses (503) — the team view and the
//           audit's "previous figure" never fall back to $10
//   GOV-3   a $0 cap reads `locked`, 100% — what the server enforces
//   GOV-4   an unreadable ledger answers 503, never $0.00
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
        for (const p of list) rows.push({ id: `r${++db.seq}`, created_at: new Date().toISOString(), ...p });
        return { data: null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      // An update or a delete answers the rows it matched (what `.select()` after it returns).
      if (action === "update") { for (const r of hit) Object.assign(r, payload); return { data: hit.map((r) => ({ id: r.id ?? null })), error: null }; }
      if (action === "delete") { db.tables[table] = rows.filter((r) => !hit.includes(r)); return { data: hit.map((r) => ({ id: r.id ?? null })), error: null }; }
      const out = range ? hit.slice(range[0], range[1] + 1) : hit;
      return { data: one ? (out[0] ?? null) : out, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row | Row[]) => { action = "insert"; payload = p; return b; },
      update: (p: Row) => { action = "update"; payload = p; return b; },
      delete: () => { action = "delete"; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => same(r[c], v)); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; },
      gt: (c: string, v: unknown) => { filters.push((r) => Number(r[c]) > Number(v)); return b; },
      order: () => b,
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

beforeEach(() => {
  db.seq = 0;
  db.errors = {};
  db.hook = null;
  db.after = null;
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
    // the hold is audited, before the default's own row
    const audits = db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED");
    expect(audits.map((a) => a.details)).toEqual([
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { capUsd: 10000, previousCapUsd: 10 },
    ]);
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

    const audits = db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED").map((a) => a.details);
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
    expect(db.tables.audit_logs.at(-1)!.details).toEqual({ targetUserId: ADMIN, capUsd: 40, previousCapUsd: 10 });
    expect(notices().map((n) => [n.user_id, n.title])).toEqual([[ADMIN, "Your monthly AI cap changed"]]);
    // lowering your own cap under a braced spelling is allowed — it updates
    // the canonical row (never a second one) and you are not told about it
    const down = await post(ADMIN, { capUsd: 5, userId: `{${ADMIN.toUpperCase()}}` });
    expect(down.status).toBe(200);
    expect(db.tables.ai_usage_limits).toEqual([expect.objectContaining({ user_id: ADMIN, monthly_cap_usd: 5 })]);
    expect(db.tables.audit_logs.at(-1)!.details).toEqual({ targetUserId: ADMIN, capUsd: 5, previousCapUsd: 40 });
    expect(notices().map((n) => n.user_id)).toEqual([ADMIN, ADMIN2]);
  });

  it("a SOLE holder raising their own cap under another spelling is audited soleHolder with the canonical uid and sent no notice about it", async () => {
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== ADMIN2);
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    const r = await post(ADMIN, { capUsd: 75, userId: ADMIN.replace(/-/g, "").toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.json.soleHolder).toBe(true);
    expect(db.tables.ai_usage_limits.find((l) => l.user_id === ADMIN)?.monthly_cap_usd).toBe(75);
    expect(db.tables.audit_logs.map((a) => a.details)).toEqual([{ targetUserId: ADMIN, capUsd: 75, previousCapUsd: 10, soleHolder: true }]);
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
    expect(db.tables.audit_logs.map((a) => a.details)).toEqual([
      { targetUserId: ADMIN, capUsd: 75, previousCapUsd: 5, soleHolder: true },
      { targetUserId: ADMIN, capUsd: 75, previousCapUsd: 5, soleHolder: true, notApplied: true, error: "permission denied" },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 5, soleHolder: true },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 5, soleHolder: true, notApplied: true, error: "permission denied" },
    ]);
    expect(notices()).toHaveLength(0);
  });
});

describe("GOV-10 — the ban holds at WRITE time: two requests at once never raise your own cap", () => {
  const limitsOf = (uid: string | null) => db.tables.ai_usage_limits.filter((l) => (l.user_id ?? null) === uid).map((l) => l.monthly_cap_usd);
  const capDetails = () => db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED").map((a) => a.details);

  it("the review's race: clearing your own override at the moment you raise the default you follow — the clear is refused, the hold stays, and both answers match what is stored", async () => {
    // $10 default, ADMIN follows it, ADMIN2 also holds ai.manage_caps.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    // The interleaving that used to win: the clear's delete is held until the
    // raise has written ADMIN's hold, and the raise's default write is held
    // until the clear reaches its delete (or is answered without one).
    let pinWritten!: () => void;
    const pinned = new Promise<void>((r) => { pinWritten = r; });
    let clearAtDelete!: () => void;
    const atDelete = new Promise<void>((r) => { clearAtDelete = r; });
    let clearAnswered!: () => void;
    const answered = new Promise<void>((r) => { clearAnswered = r; });
    let deletes = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (action === "delete") { deletes += 1; clearAtDelete(); await pinned; }
      if (action === "update") await Promise.race([atDelete, answered]);
    };
    db.after = ({ table, action }) => { if (table === "ai_usage_limits" && action === "insert") pinWritten(); };

    const [raise, clear] = await Promise.all([
      post(ADMIN, { capUsd: 100 }),
      post(ADMIN, { capUsd: null, userId: ADMIN }).finally(() => clearAnswered()),
    ]);
    db.hook = null;
    db.after = null;

    expect(clear.status).toBe(403);
    expect(String(clear.json.error)).toMatch(/can't clear your own monthly AI cap override while another person has the “Manage AI spend caps” permission/);
    expect(deletes).toBe(0);
    expect(raise.status).toBe(200);
    expect(raise.json).toMatchObject({ ok: true, capUsd: 100, selfHeldAtUsd: 10 });
    // What is stored is what the answers say: the default moved, ADMIN did not.
    expect(limitsOf(null)).toEqual([100]);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10, selfFollowsDefault: false });
    expect((await get(ENG)).json).toMatchObject({ capUsd: 100 });
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { capUsd: 100, previousCapUsd: 10 },
    ]);
  });

  it("clearing your own override is refused while another holder exists even when it would LOWER your cap — a lower figure is set directly", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 5 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
    const r = await post(ADMIN, { capUsd: null, userId: ADMIN });
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/set a lower figure for yourself directly/);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect(db.tables.audit_logs).toHaveLength(0);
    // the lower figure, set directly
    expect((await post(ADMIN, { capUsd: 5, userId: ADMIN })).status).toBe(200);
    expect(limitsOf(ADMIN)).toEqual([5]);
    // another holder may clear it
    expect((await post(ADMIN2, { capUsd: null, userId: ADMIN })).status).toBe(200);
    expect(limitsOf(ADMIN)).toEqual([]);
  });

  it("a hold another change takes out between the hold and the default write: the re-read finds your cap risen, puts it back, audits it compensated, and answers 409", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let other: { status: number; json: Row } | null = null;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      // ADMIN's hold is written; before the default moves, another holder
      // clears it (a change of theirs, by design allowed).
      other = await post(ADMIN2, { capUsd: null, userId: ADMIN });
    };
    const r = await post(ADMIN, { capUsd: 100 });
    expect(other!.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, capUsd: 100, selfCapUsd: 10 });
    expect(String(r.json.error)).toMatch(/The default monthly cap is now \$100, but your own cap rose to \$100 while it was being saved .* put back at \$10/);
    expect(r.json.selfHeldAtUsd).toBeUndefined();
    expect(limitsOf(null)).toEqual([100]);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10 });
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 10 },
      { capUsd: 100, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 100, compensated: true },
    ]);
    // The put-back is a cap change too: the other holder — whose clear it
    // undid — is told (GOV-10 done-when 4).
    const putBack = notices().filter((n) => n.user_id === ADMIN2 && (n.metadata as Row).putBack === true);
    expect(putBack).toHaveLength(1);
    expect(putBack[0].title).toBe("A monthly AI cap was put back");
    expect(String(putBack[0].body)).toMatch(/^Ada's own monthly AI cap was put back from \$100 to \$10: a cap change of theirs and another change landed at the same moment/);
  });

  it("the default changed underneath a 'lowering' (another holder lowered it further): the guarded write matches nothing — 409, nothing changed, nobody raised", async () => {
    // ADMIN follows a $100 default. ADMIN2 lowers it to $10 while ADMIN's
    // request, which read $100, "lowers" it to $99 — written over ADMIN2's
    // figure that would have raised everyone, ADMIN included, back up.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 100 }];
    let other: { status: number; json: Row } | null = null;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      other = await post(ADMIN2, { capUsd: 10 });
    };
    const r = await post(ADMIN, { capUsd: 99 });
    expect(other!.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json.conflict).toBe(true);
    expect(String(r.json.error)).toMatch(/The workspace default changed while you were saving it .* nothing was changed/);
    expect(limitsOf(null)).toEqual([10]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10 });
    expect(capDetails()).toEqual([{ capUsd: 10, previousCapUsd: 100 }]); // ADMIN2's alone
  });

  it("your own override changed underneath your own 'lowering': the guarded write matches nothing — 409, the other holder's figure stands", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 50 }];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      expect((await post(ADMIN2, { capUsd: 5, userId: ADMIN })).status).toBe(200);
    };
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toMatch(/That cap changed while you were saving it/);
    expect(limitsOf(ADMIN)).toEqual([5]);
    expect(capDetails()).toEqual([{ targetUserId: ADMIN, capUsd: 5, previousCapUsd: 50 }]);
  });

  it("a default write that fails after the hold was written takes the hold back out — the setter still follows the default, and the log says the hold was not applied", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.errors["ai_usage_limits:update"] = { message: "canceling statement due to statement timeout" };
    const r = await post(ADMIN, { capUsd: 50 });
    expect(r.status).toBe(500);
    expect(String(r.json.error)).toMatch(/Couldn't save the cap: canceling statement/);
    expect(limitsOf(ADMIN)).toEqual([]);
    expect(limitsOf(null)).toEqual([10]);
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true, notApplied: true, error: "canceling statement due to statement timeout" },
    ]);
    delete db.errors["ai_usage_limits:update"];
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10, selfFollowsDefault: true });
    expect(notices()).toHaveLength(0);
  });

  it("…and so does a default write that finds the default changed (409); a hold another request wrote first is the same conflict", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      // the other holder lowers it first (no hold for a lowering)
      expect((await post(ADMIN2, { capUsd: 8 })).status).toBe(200);
    };
    const r = await post(ADMIN, { capUsd: 50 });
    expect(r.status).toBe(409);
    expect(limitsOf(ADMIN)).toEqual([]);
    expect(limitsOf(null)).toEqual([8]);
    expect(capDetails().at(-1)).toMatchObject({ targetUserId: ADMIN, heldOnDefaultRaise: true, notApplied: true });
    // the unique index's refusal of a hold: the same conflict, nothing changed
    db.errors["ai_usage_limits:insert"] = { code: "23505", message: "duplicate key value violates unique constraint \"ai_usage_limits_user_idx\"" };
    const dup = await post(ADMIN, { capUsd: 50 });
    expect(dup.status).toBe(409);
    expect(limitsOf(null)).toEqual([8]);
  });

  it("the sixth review's race: two default raises by the same holder — the loser keeps its hold, because the winner wrote none of its own and counts on it", async () => {
    // $10 default, ADMIN follows it, ADMIN2 also holds ai.manage_caps.
    // POST1 ($50) writes ADMIN's $10 hold. POST2 ($60), from the same
    // holder, reads ADMIN's row after the hold (so writes no hold of its
    // own), and finishes its default write and its re-read ($10, the hold)
    // before POST1's guarded default write — which then matches nothing.
    // Taking the hold back out at that point used to leave ADMIN on $60.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let second: { status: number; json: Row } | null = null;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      second = await post(ADMIN, { capUsd: 60 });
    };
    const first = await post(ADMIN, { capUsd: 50 });
    expect(second!.status).toBe(200);
    expect(first.status).toBe(409);
    expect(first.json).toMatchObject({ conflict: true, holdKept: true });
    expect(String(first.json.error)).toMatch(/so it was not changed\. Your own cap stays held at \$10: the default now reads \$60, and nobody raises their own cap\./);
    // What is stored: the default moved (POST2), ADMIN did not.
    expect(limitsOf(null)).toEqual([60]);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10, selfFollowsDefault: false });
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { capUsd: 60, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true, defaultNotRaised: true, holdKept: "the default now reads $60", error: "the cap changed while this was being saved" },
    ]);
  });

  it("taking a hold back out is re-read: the default raised by the setter's OWN other request between the check and the delete — put back, audited compensated with the figure it replaced, the other holder told", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let step = 0;
    let second: { status: number; json: Row } | null = null;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "update") {
        // ADMIN's default write is about to land: ADMIN2 lowers it first, so it finds the default changed.
        step = 1;
        expect((await post(ADMIN2, { capUsd: 8 })).status).toBe(200);
      } else if (step === 1 && action === "delete") {
        // The default ($8) is no higher than the hold, so it comes out — but ADMIN's own second raise lands just before.
        step = 2;
        second = await post(ADMIN, { capUsd: 60 });
      }
    };
    const r = await post(ADMIN, { capUsd: 50 });
    db.hook = null;
    expect(step).toBe(2);
    // the second raise found the hold, wrote none of its own, and counted on it
    expect(second!.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, selfCapUsd: 10 });
    expect(String(r.json.error)).toMatch(/so it was not changed\. Taking your hold back out let your own cap rise to \$60 — another change landed at the same time — so it was put back at \$10\./);
    expect(limitsOf(null)).toEqual([60]);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10 });
    expect(capDetails()).toEqual([
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { capUsd: 8, previousCapUsd: 10 },
      { capUsd: 60, previousCapUsd: 8 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true, notApplied: true, error: "the cap changed while this was being saved" },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 60, compensated: true },
    ]);
    const told = notices().find((n) => n.user_id === ADMIN2 && n.title === "A monthly AI cap was put back")!;
    expect(told).toBeDefined();
    expect(told.metadata).toMatchObject({ targetUserId: ADMIN, capUsd: 10, previousCapUsd: 60, putBack: true });
    // the actor is never sent their own put-back
    expect(notices().some((n) => n.user_id === ADMIN && (n.metadata as Row).putBack === true)).toBe(false);
  });

  it("…but a default ANOTHER holder raised between the check and the delete is theirs: it stands, said in the answer, nothing put back", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let step = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "update") {
        step = 1;
        expect((await post(ADMIN2, { capUsd: 8 })).status).toBe(200);
      } else if (step === 1 && action === "delete") {
        step = 2;
        expect((await post(ADMIN2, { capUsd: 60 })).status).toBe(200);
      }
    };
    const r = await post(ADMIN, { capUsd: 50 });
    db.hook = null;
    expect(step).toBe(2);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, selfCapUsd: 60 });
    expect(r.json.compensated).toBeUndefined();
    expect(String(r.json.error)).toMatch(/so it was not changed\. Your hold was taken back out, so your own cap now reads \$60 — a figure another person who manages AI caps set\./);
    expect(limitsOf(ADMIN)).toEqual([]);
    expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);
    expect(notices().some((n) => n.title === "A monthly AI cap was put back")).toBe(false);
  });

  it("the seventh review's P1: another holder changes the hold before it is taken out — the delete matches nothing, nothing is re-read or put back, and their figure stands (audited holdChanged)", async () => {
    // $10 default, ADMIN follows it. ADMIN raises it to $50 (a $10 hold).
    // ADMIN2 lowers the default to $8 (ADMIN's write conflicts; 8 ≤ 10 sends
    // ADMIN to the delete), and just before the delete raises ADMIN's
    // override to $30. The put-back used to undo that signed $30.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let step = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "update") {
        step = 1;
        expect((await post(ADMIN2, { capUsd: 8 })).status).toBe(200);
      } else if (step === 1 && action === "delete") {
        step = 2;
        expect((await post(ADMIN2, { capUsd: 30, userId: ADMIN })).status).toBe(200);
      }
    };
    const r = await post(ADMIN, { capUsd: 50 });
    db.hook = null;
    expect(step).toBe(2);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, holdChanged: true });
    expect(r.json.compensated).toBeUndefined();
    expect(String(r.json.error)).toMatch(/so it was not changed\. Your hold had been changed by another cap change in the meantime, so it was left as it now stands\./);
    expect(String(r.json.error)).not.toMatch(/rise to \$30/);
    expect(limitsOf(ADMIN)).toEqual([30]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 30 });
    expect(capDetails().at(-1)).toEqual({
      targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true, defaultNotRaised: true, holdChanged: true,
      error: "the cap changed while this was being saved",
    });
    expect(capDetails().some((d) => (d as Row).compensated || (d as Row).notApplied)).toBe(false);
    expect(notices().some((n) => n.title === "A monthly AI cap was put back")).toBe(false);
  });

  it("a raise of your cap another holder signs while your default raise lands stands — the re-read reads who wrote it, and never undoes it", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      // ADMIN's $10 hold is written; ADMIN2 raises ADMIN to $30 before the default moves.
      expect((await post(ADMIN2, { capUsd: 30, userId: ADMIN })).status).toBe(200);
    };
    const r = await post(ADMIN, { capUsd: 100 });
    expect(r.status).toBe(200);
    // The eighth review: a cap that ROSE to another holder's figure is said
    // as theirs (`selfCapSetByAnother`), never as held where it was.
    expect(r.json).toMatchObject({ ok: true, capUsd: 100, selfCapUsd: 30, selfCapSetByAnother: true });
    expect(r.json.selfHeldAtUsd).toBeUndefined();
    expect(limitsOf(ADMIN)).toEqual([30]);
    expect(limitsOf(null)).toEqual([100]);
    expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);
  });

  it("the seventh review's P2: a default LOWERING cannot raise you, so it is not re-read — another holder's raise of your override, and the lock they put on after it, both stand", async () => {
    // ADMIN has a $10 override; the default is $50. ADMIN lowers the default
    // to $20; during that write ADMIN2 raises ADMIN's override to $100, then
    // locks ADMIN at $0. The put-back used to write $10 over the lock.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
    let reads = -1;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      expect((await post(ADMIN2, { capUsd: 100, userId: ADMIN })).status).toBe(200);
      expect((await post(ADMIN2, { capUsd: 0, userId: ADMIN })).status).toBe(200);
      reads = 0;
    };
    db.after = ({ table, action }) => { if (reads >= 0 && table === "ai_usage_limits" && action === "select") reads += 1; };
    const r = await post(ADMIN, { capUsd: 20 });
    db.after = null;
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, capUsd: 20 });
    expect(reads).toBe(0); // nothing re-read after the write
    expect(limitsOf(null)).toEqual([20]);
    expect(limitsOf(ADMIN)).toEqual([0]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 0, locked: true });
    expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);
    expect(notices().some((n) => n.title === "A monthly AI cap was put back")).toBe(false);
    // …and a lowering of one's own override is not re-read either
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 50 }];
    reads = -1;
    db.after = ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (action === "update" && reads < 0) {
        reads = 0;
        // ADMIN2's raise lands right behind ADMIN's own lowering
        Object.assign(db.tables.ai_usage_limits.find((l) => l.user_id === ADMIN)!, { monthly_cap_usd: 100, updated_by: ADMIN2 });
      } else if (action === "select" && reads >= 0) reads += 1;
    };
    const own = await post(ADMIN, { capUsd: 40, userId: ADMIN });
    db.after = null;
    expect(own.status).toBe(200);
    expect(reads).toBe(0);
    expect(limitsOf(ADMIN)).toEqual([100]);
  });

  it("the put-back only ever lowers, and never over a figure set since: a lock another holder puts on between the re-read and the put-back survives (its insert loses the unique index, and the guarded retry finds the lock)", async () => {
    // As above: another holder clears ADMIN's hold before the default write,
    // so ADMIN's own raise lifts them and the re-read finds it. Just before
    // the put-back's write, ADMIN2 locks ADMIN at $0.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let step = 0;
    db.hook = async ({ table, action, payload }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "update") {
        step = 1;
        expect((await post(ADMIN2, { capUsd: null, userId: ADMIN })).status).toBe(200);
      } else if (step === 1 && action === "insert" && (payload as Row).updated_by === ADMIN) {
        step = 2;
        expect((await post(ADMIN2, { capUsd: 0, userId: ADMIN })).status).toBe(200);
      }
    };
    const r = await post(ADMIN, { capUsd: 100 });
    db.hook = null;
    expect(step).toBe(2);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, capUsd: 100, selfHeldAtUsd: 0 });
    expect(limitsOf(ADMIN)).toEqual([0]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 0, locked: true });
    expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);

    // A row with no recorded writer that rose underneath (a direct edit): put
    // back from the figure actually replaced — and, guarded by that figure,
    // never over a lock that lands between its read and its write.
    for (const lockFirst of [false, true]) {
      db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 10 }];
      db.tables.audit_logs = [];
      let n = 0;
      db.hook = async ({ table, action }) => {
        if (table !== "ai_usage_limits" || action !== "update") return;
        n += 1;
        if (n === 1) Object.assign(db.tables.ai_usage_limits.find((l) => l.user_id === ADMIN)!, { monthly_cap_usd: 100 });
        if (n === 2 && lockFirst) expect((await post(ADMIN2, { capUsd: 0, userId: ADMIN })).status).toBe(200);
      };
      const raised = await post(ADMIN, { capUsd: 50 });
      db.hook = null;
      if (lockFirst) {
        expect(raised.status).toBe(200);
        expect(limitsOf(ADMIN)).toEqual([0]);
        expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);
      } else {
        expect(raised.status).toBe(409);
        expect(raised.json).toMatchObject({ compensated: true, selfCapUsd: 10 });
        expect(limitsOf(ADMIN)).toEqual([10]);
        expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 10, previousCapUsd: 100, compensated: true });
      }
    }
  });

  it("a put-back that cannot be written is said to the other holders as well as in the answer", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      expect((await post(ADMIN2, { capUsd: null, userId: ADMIN })).status).toBe(200);
      // ADMIN's own default write lands; the put-back after it does not
      db.after = ({ table: t, action: a }) => {
        if (t === "ai_usage_limits" && a === "update") { db.after = null; db.errors["ai_usage_limits:insert"] = { message: "permission denied" }; }
      };
    };
    const r = await post(ADMIN, { capUsd: 100 });
    delete db.errors["ai_usage_limits:insert"];
    expect(r.status).toBe(500);
    expect(String(r.json.error)).toMatch(/could not be put back at \$10 \(permission denied\)\. Tell another person who manages AI caps\./);
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 10, previousCapUsd: 100, compensated: true, notApplied: true, error: "permission denied" });
    const told = notices().find((n) => n.user_id === ADMIN2 && n.title === "A monthly AI cap could not be put back")!;
    expect(told).toBeDefined();
    expect(String(told.body)).toMatch(/Ada's own monthly AI cap rose from \$10 to \$100 .* could not be put back \(permission denied\)/);
  });

  it("the seventh review's P3: a hold whose delete fails stays — said in the answer (never 'nothing was changed'), audited holdKept, and told to the other holders", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      expect((await post(ADMIN2, { capUsd: 5 })).status).toBe(200);
      db.errors["ai_usage_limits:delete"] = { message: "canceling statement due to statement timeout" };
    };
    const r = await post(ADMIN, { capUsd: 50 });
    delete db.errors["ai_usage_limits:delete"];
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, holdKept: true });
    expect(String(r.json.error)).toMatch(/so it was not changed\. Your own cap stays held at \$10: it could not be taken back out \(canceling statement due to statement timeout\), so you no longer follow the workspace default/);
    expect(String(r.json.error)).not.toMatch(/nothing was changed/);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect(capDetails().at(-1)).toMatchObject({ targetUserId: ADMIN, defaultNotRaised: true, holdKept: "canceling statement due to statement timeout" });
    const told = notices().find((n) => n.user_id === ADMIN2 && n.title === "A monthly AI cap is still held")!;
    expect(told).toBeDefined();
    expect(String(told.body)).toMatch(/^Ada's own monthly AI cap stays held at \$10: a raise of the workspace default by them did not land, and the hold it wrote stays — it could not be taken back out/);
    expect(told.metadata).toMatchObject({ targetUserId: ADMIN, holdKept: "it could not be taken back out (canceling statement due to statement timeout)" });
  });

  it("the seventh review's P4: the hold is written at the LOWER of the default and the setter's own cap as read — the default lowered between the two reads, then unreadable: the kept hold is the lower figure, never a rise, and is told", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let lowered = false;
    db.after = ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (!lowered && action === "select") {
        // right after the first default read: ADMIN2's lowering lands (a new
        // row version — the route's copy of the one it read stays as read)
        lowered = true;
        db.tables.ai_usage_limits = db.tables.ai_usage_limits.map((l) => (l.user_id === null ? { ...l, monthly_cap_usd: 5, updated_by: ADMIN2 } : l));
      } else if (action === "update") {
        // the default write (guarded on $10) finds $5; the default then can't be read
        db.errors["ai_usage_limits:select:nolimit"] = { message: "connection reset" };
      }
    };
    const r = await post(ADMIN, { capUsd: 50 });
    db.after = null;
    delete db.errors["ai_usage_limits:select:nolimit"];
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, holdKept: true });
    expect(String(r.json.error)).toMatch(/Your own cap stays held at \$5: the default cap can't be read \(connection reset\)/);
    // was: a $10 hold — ADMIN raised from $5 to $10 by their own request
    expect(limitsOf(ADMIN)).toEqual([5]);
    expect(capDetails()[0]).toEqual({ targetUserId: ADMIN, capUsd: 5, previousCapUsd: 5, heldOnDefaultRaise: true });
    expect(notices().some((n) => n.user_id === ADMIN2 && n.title === "A monthly AI cap is still held")).toBe(true);
  });

  it("a cap that cannot be read back after the write is never a plain 200: audited unverified, said (503), and the other holders asked to check", async () => {
    // Another holder clears ADMIN's hold between the hold and the default
    // write; ADMIN's re-read then fails (twice).
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      expect((await post(ADMIN2, { capUsd: null, userId: ADMIN })).status).toBe(200);
    };
    db.after = ({ table, action }) => {
      if (table === "ai_usage_limits" && action === "update") db.errors["ai_usage_limits:select"] = { message: "canceling statement due to statement timeout" };
    };
    const r = await post(ADMIN, { capUsd: 100 });
    db.after = null;
    delete db.errors["ai_usage_limits:select"];
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ saved: true, unverified: true, capUsd: 100 });
    expect(r.json.selfHeldAtUsd).toBeUndefined();
    expect(String(r.json.error)).toMatch(/^The default monthly cap is now \$100, but your own cap could not be read back afterwards, so nobody has checked that it did not rise with the change/);
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, previousCapUsd: 10, unverified: true });
    expect(notices().some((n) => n.user_id === ADMIN2 && n.title === "A monthly AI cap needs checking")).toBe(true);
  });

  it("…and after a hold is taken back out: a re-read that fails answers 503 unverified, not 'nothing was changed'", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update") return;
      db.hook = null;
      expect((await post(ADMIN2, { capUsd: 8 })).status).toBe(200);
    };
    db.after = ({ table, action }) => {
      if (table === "ai_usage_limits" && action === "delete") db.errors["ai_usage_limits:select"] = { message: "canceling statement due to statement timeout" };
    };
    const r = await post(ADMIN, { capUsd: 50 });
    db.after = null;
    delete db.errors["ai_usage_limits:select"];
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ conflict: true, unverified: true });
    expect(String(r.json.error)).toMatch(/so it was not changed\. Your own cap could not be read back after your hold was taken out/);
    expect(limitsOf(ADMIN)).toEqual([]);
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, previousCapUsd: 10, unverified: true });
  });

  // ── The eighth review ────────────────────────────────────────────────
  // Setting your own cap while you follow the default is an INSERT that no
  // figure guards: the default is read before it and again after it.

  it("the eighth review's (a): your own override set while you follow the default, with a workspace lock landing before its insert — read back against the default, taken back out (409), and you are locked with everyone else", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let other: { status: number; json: Row } | null = null;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "insert") return;
      db.hook = null;
      other = await post(ADMIN2, { capUsd: 0 });
    };
    const r = await post(ADMIN, { capUsd: 10, userId: ADMIN });
    expect(other!.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, capUsd: 10, selfCapUsd: 0 });
    expect(String(r.json.error)).toMatch(/^Your own cap was set to \$10, but the workspace default you follow fell to \$0 \(locked\) while it was being saved .*, so your new override was taken back out and you follow the default again\./);
    // was: ADMIN's override at $10, the workspace locked, both answered 200
    expect(limitsOf(ADMIN)).toEqual([]);
    expect(limitsOf(null)).toEqual([0]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 0, locked: true, selfFollowsDefault: true });
    expect((await get(ENG)).json).toMatchObject({ capUsd: 0, locked: true });
    expect(capDetails()).toEqual([
      { capUsd: 0, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 0, previousCapUsd: 10, compensated: true, overrideRemoved: true },
    ]);
    const told = notices().find((n) => n.user_id === ADMIN2 && n.title === "A monthly AI cap was put back")!;
    expect(told).toBeDefined();
    expect(told.metadata).toMatchObject({ targetUserId: ADMIN, capUsd: 0, previousCapUsd: 10, putBack: true, overrideRemoved: true });
    expect(String(told.body)).toMatch(/^Ada's own monthly AI cap was set to \$10 by them while the workspace default they followed fell to \$0 \(locked\)/);
    expect(notices().some((n) => n.user_id === ADMIN && (n.metadata as Row).putBack === true)).toBe(false);
  });

  it("the eighth review's (b): a 'lowering' of your own cap by insert while another holder lowers the default further — taken back out, you follow their figure; one that lands before the insert is refused outright (409, nothing written)", async () => {
    // after the default read, before the insert
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 100 }];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "insert") return;
      db.hook = null;
      expect((await post(ADMIN2, { capUsd: 10 })).status).toBe(200);
    };
    const r = await post(ADMIN, { capUsd: 99, userId: ADMIN });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, capUsd: 99, selfCapUsd: 10 });
    // was: ADMIN at $99 against everyone's $10, answered 200
    expect(limitsOf(ADMIN)).toEqual([]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10 });
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 10, previousCapUsd: 99, compensated: true, overrideRemoved: true });

    // before the default read (the fourth cap read: two by getCapUsd, the row's existence, the default)
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 100 }];
    db.tables.audit_logs = [];
    let reads = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "select") return;
      reads += 1;
      if (reads === 4) { db.hook = null; expect((await post(ADMIN2, { capUsd: 10 })).status).toBe(200); }
    };
    const early = await post(ADMIN, { capUsd: 99, userId: ADMIN });
    expect(early.status).toBe(409);
    expect(String(early.json.error)).toMatch(/That cap changed while you were saving it .* so nothing was changed/);
    expect(limitsOf(ADMIN)).toEqual([]);
    expect(capDetails()).toEqual([{ capUsd: 10, previousCapUsd: 100 }]); // ADMIN2's alone
  });

  it("the eighth review's (c): another holder clears your override while you 'lower' it — the lowering decided from your $50 finds you on the $10 default: refused (409), nothing written, never left at $45", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ADMIN, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    let reads = 0;
    let clear: { status: number; json: Row } | null = null;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "select") return;
      reads += 1;
      // after getCapUsd read $50, before the row's existence is read
      if (reads === 3) { db.hook = null; clear = await post(ADMIN2, { capUsd: null, userId: ADMIN }); }
    };
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    expect(clear!.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json.conflict).toBe(true);
    expect(String(r.json.error)).toMatch(/That cap changed while you were saving it .* so nothing was changed/);
    expect(limitsOf(ADMIN)).toEqual([]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10, selfFollowsDefault: true });
    expect(capDetails()).toEqual([{ targetUserId: ADMIN, cleared: true, previousCapUsd: 50 }]);
  });

  it("…your own override that another holder changes before it is taken back out is theirs: it stands (409 overrideChanged); a default that cannot be read back after the insert is 503 unverified, never a plain 200", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let step = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "insert") { step = 1; expect((await post(ADMIN2, { capUsd: 0 })).status).toBe(200); }
      else if (step === 1 && action === "delete") { step = 2; expect((await post(ADMIN2, { capUsd: 3, userId: ADMIN })).status).toBe(200); }
    };
    const r = await post(ADMIN, { capUsd: 8, userId: ADMIN });
    db.hook = null;
    expect(step).toBe(2);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, overrideChanged: true, capUsd: 8, selfCapUsd: 3 });
    expect(r.json.compensated).toBeUndefined();
    expect(String(r.json.error)).toMatch(/and another cap change has changed your cap since, so it was left as it now stands/);
    expect(limitsOf(ADMIN)).toEqual([3]);
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 8, previousCapUsd: 10, defaultNowUsd: 0, overrideChanged: true });
    expect(notices().some((n) => n.title === "A monthly AI cap was put back")).toBe(false);

    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.tables.audit_logs = [];
    db.tables.notifications = [];
    db.after = ({ table, action }) => {
      if (table === "ai_usage_limits" && action === "insert") db.errors["ai_usage_limits:select:nolimit"] = { message: "connection reset" };
    };
    const blind = await post(ADMIN, { capUsd: 5, userId: ADMIN });
    db.after = null;
    delete db.errors["ai_usage_limits:select:nolimit"];
    expect(blind.status).toBe(503);
    expect(blind.json).toMatchObject({ saved: true, unverified: true, capUsd: 5 });
    expect(String(blind.json.error)).toMatch(/^Your own cap is now \$5, but the workspace default could not be read back afterwards/);
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 5, previousCapUsd: 10, unverified: true, error: "connection reset" });
    expect(notices().some((n) => n.user_id === ADMIN2 && n.title === "A monthly AI cap needs checking")).toBe(true);
  });

  it("…taking your own override back out is re-read like a hold's removal: the default raised by your OWN other request just before the delete is put back at the figure you were taken back to", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let step = 0;
    let second: { status: number; json: Row } | null = null;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "insert") { step = 1; expect((await post(ADMIN2, { capUsd: 5 })).status).toBe(200); }
      else if (step === 1 && action === "delete") {
        // ADMIN's override ($8) still stands, so this raise holds nobody
        step = 2;
        second = await post(ADMIN, { capUsd: 50 });
      }
    };
    const r = await post(ADMIN, { capUsd: 8, userId: ADMIN });
    db.hook = null;
    expect(step).toBe(2);
    expect(second!.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, capUsd: 8, selfCapUsd: 5 });
    expect(String(r.json.error)).toMatch(/so your new override was taken back out .* Taking it out let your own cap rise to \$50 — another change landed at the same time — so it was put back at \$5\./);
    expect(limitsOf(null)).toEqual([50]);
    expect(limitsOf(ADMIN)).toEqual([5]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 5 });
    expect(capDetails().slice(-2)).toEqual([
      { targetUserId: ADMIN, capUsd: 5, previousCapUsd: 8, compensated: true, overrideRemoved: true },
      { targetUserId: ADMIN, capUsd: 5, previousCapUsd: 50, compensated: true },
    ]);
  });

  it("the eighth review's put-back: a figure written to the default between the put-back's read and its insert is never written over — a lock leaves you locked, another holder's raise stands as theirs, a trim leaves the put-back from the trimmed figure", async () => {
    // $10 default, ADMIN follows it and raises it to $100; ADMIN2 clears the
    // hold before the default write, so the re-read finds ADMIN at $100 on
    // their own write and puts them back. Just before the put-back's insert,
    // ADMIN2 writes the default again.
    for (const [figure, expected] of [[0, "lock"], [200, "theirs"], [90, "trim"]] as const) {
      db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
      db.tables.audit_logs = [];
      db.tables.notifications = [];
      let step = 0;
      db.hook = async ({ table, action, payload }) => {
        if (table !== "ai_usage_limits") return;
        if (step === 0 && action === "update") {
          step = 1;
          expect((await post(ADMIN2, { capUsd: null, userId: ADMIN })).status).toBe(200);
        } else if (step === 1 && action === "insert" && (payload as Row).user_id === ADMIN) {
          step = 2;
          expect((await post(ADMIN2, { capUsd: figure })).status).toBe(200);
        }
      };
      const r = await post(ADMIN, { capUsd: 100 });
      db.hook = null;
      expect(step, expected).toBe(2);
      expect(limitsOf(null), expected).toEqual([figure]);
      if (expected === "lock") {
        // was: ADMIN's $10 put-back over the lock, audited as replacing $100
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ ok: true, capUsd: 100, selfHeldAtUsd: 0 });
        expect(limitsOf(ADMIN)).toEqual([]);
        expect((await get(ADMIN)).json).toMatchObject({ capUsd: 0, locked: true });
        expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);
        expect(notices().some((n) => n.title === "A monthly AI cap was put back")).toBe(false);
      } else if (expected === "theirs") {
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ ok: true, capUsd: 100, selfCapUsd: 200, selfCapSetByAnother: true });
        expect(r.json.selfHeldAtUsd).toBeUndefined();
        expect(limitsOf(ADMIN)).toEqual([]);
        expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);
      } else {
        expect(r.status).toBe(409);
        expect(r.json).toMatchObject({ conflict: true, compensated: true, selfCapUsd: 10 });
        expect(limitsOf(ADMIN)).toEqual([10]);
        // the figure actually replaced: the trimmed $90, not the $100 first read
        expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 10, previousCapUsd: 90, compensated: true });
      }
    }
  });

  it("the eighth review's trim: another holder TRIMS the default your own raise lifted you to — the rise is still yours, and it is put back (their trim stands for everyone else); a default they wrote at or above your raise is theirs", async () => {
    // The reviewer's interleaving: ADMIN2 clears ADMIN's hold before the
    // default write, then trims the default to $90 before ADMIN's re-read.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    let phase = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (phase === 0 && action === "update") { phase = 1; expect((await post(ADMIN2, { capUsd: null, userId: ADMIN })).status).toBe(200); phase = 2; return; }
      if (phase === 3 && action === "select") { phase = 4; expect((await post(ADMIN2, { capUsd: 90 })).status).toBe(200); }
    };
    db.after = ({ table, action }) => { if (phase === 2 && table === "ai_usage_limits" && action === "update") phase = 3; };
    const r = await post(ADMIN, { capUsd: 100 });
    db.hook = null; db.after = null;
    expect(phase).toBe(4);
    // was: 200 selfHeldAtUsd 90 — ADMIN at $90 from $10, through their own raise
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, capUsd: 100, selfCapUsd: 10 });
    expect(String(r.json.error)).toMatch(/your own cap rose to \$90 while it was being saved .* so it was put back at \$10/);
    expect(limitsOf(null)).toEqual([90]);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect((await get(ENG)).json).toMatchObject({ capUsd: 90 });
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 10, previousCapUsd: 90, compensated: true });

    // The re-read itself sees the other holder's figure: below the raise it
    // is a trim (put back); at or above it, their own raise (it stands).
    for (const [figure, theirs] of [[90, false], [100, true], [150, true]] as const) {
      db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
      db.tables.audit_logs = [];
      let s = 0;
      db.hook = async ({ table, action }) => {
        if (table !== "ai_usage_limits" || action !== "update" || s !== 0) return;
        s = 1;
        expect((await post(ADMIN2, { capUsd: null, userId: ADMIN })).status).toBe(200);
      };
      db.after = ({ table, action }) => {
        if (s !== 1 || table !== "ai_usage_limits" || action !== "update") return;
        s = 2;
        Object.assign(db.tables.ai_usage_limits.find((l) => l.user_id === null)!, { monthly_cap_usd: figure, updated_by: ADMIN2 });
      };
      const again = await post(ADMIN, { capUsd: 100 });
      db.hook = null; db.after = null;
      expect(s, String(figure)).toBe(2);
      if (theirs) {
        expect(again.status, String(figure)).toBe(200);
        expect(again.json).toMatchObject({ selfCapUsd: figure, selfCapSetByAnother: true });
        expect(limitsOf(ADMIN)).toEqual([]);
      } else {
        expect(again.status, String(figure)).toBe(409);
        expect(again.json).toMatchObject({ compensated: true, selfCapUsd: 10 });
        expect(limitsOf(ADMIN)).toEqual([10]);
        expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 10, previousCapUsd: figure, compensated: true });
      }
    }
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
