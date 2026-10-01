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
//           written first
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
        for (const p of list) rows.push({ id: `r${++db.seq}`, created_at: new Date().toISOString(), ...p });
        return { data: null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (action === "update") { for (const r of hit) Object.assign(r, payload); return { data: null, error: null }; }
      if (action === "delete") { db.tables[table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
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
      order: () => b,
      range: (a: number, z: number) => { range = [a, z]; return b; },
      limit: () => { limited = true; return b; },
      single: () => { one = true; return b; },
      maybeSingle: () => { one = true; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
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
    expect((await get(ADMIN)).json).toMatchObject({ selfFollowsDefault: true, soleCapsHolder: false });
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
