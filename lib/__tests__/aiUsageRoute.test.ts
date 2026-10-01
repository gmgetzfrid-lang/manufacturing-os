// intelligence Round G — I-05: /api/ai/usage.
//
//   GOV-10  setting caps is the `ai.manage_caps` capability (default Admin)
//           read from the org's policy — Doc Control is refused unless
//           granted; nobody raises their OWN cap — by an override, by
//           clearing one, or by raising the workspace default they follow
//           (they are held where they were); every change notifies the
//           other holders and the person whose cap moved
//   GOV-4   an unreadable cap table refuses (503) — the team view and the
//           audit's "previous figure" never fall back to $10
//   GOV-3   a $0 cap reads `locked`, 100% — what the server enforces
//   GOV-4   an unreadable ledger answers 503, never $0.00
//   GOV-1   the meter carries every op, broken out per feature

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { code?: string; message: string } | undefined>,
  seq: 0,
}));

vi.mock("@/lib/supabaseAdmin", () => {
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
      const err = db.errors[`${table}:${action}`] ?? (limited ? undefined : db.errors[`${table}:${action}:nolimit`]);
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
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
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

const ORG = "o1";
const ADMIN = "u-admin", ADMIN2 = "u-admin2", DOC = "u-doc", ENG = "u-eng";
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
    // A single holder at $10 of $10, no personal override, raises the default to $10,000.
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== ADMIN2);
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }];
    db.tables.ai_usage_events = [spend(ADMIN, "knowledgeAsk", 10)];
    expect((await get(ADMIN)).json.selfFollowsDefault).toBe(true);
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
