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
//           written first; the ban holds at WRITE time — every write that
//           can RAISE your own cap (a default raise, taking a hold back out,
//           your own override inserted while you follow the default, read
//           against the default before and after) is read again with who
//           wrote the row: a rise on your own write is put back DOWN, never
//           over a figure set since (the other holders told), a rise another
//           holder signed stands (a trim of your own raise — this request's
//           or another of yours since it began — is not theirs), and so does
//           your own lowering of one; a raise of the default is recorded
//           before it is made; one that
//           cannot be read back is said (503), never a plain 200; a default
//           lowering is not re-read; a hold is written at the lower figure
//           read, and one that stays (or was changed by someone else) is
//           said and told; an update that matches no row is never a 200
//           (another person's override taken out meanwhile is inserted)
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
      const out = range ? hit.slice(range[0], range[1] + 1) : hit;
      return { data: one ? (out[0] ?? null) : out, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => { if (action !== "select") returning = true; return b; },
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
    expect(typeof (audits[0].details as Row).writeId).toBe("string");
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
      if (table === "ai_usage_events" && action === "select" && ++reads > 2) db.errors["ai_usage_events:select"] = { message: "connection reset" };
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

describe("GOV-10 — the ban holds at WRITE time: two requests at once never raise your own cap", () => {
  const limitsOf = (uid: string | null) => db.tables.ai_usage_limits.filter((l) => (l.user_id ?? null) === uid).map((l) => l.monthly_cap_usd);
  const capDetails = () => db.tables.audit_logs.filter((a) => a.action === "AI_CAP_CHANGED").map((a) => plainDetails(a.details));

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

    // The clear never deletes. Fix pass 12: a clear that finds no override
    // of the caller's own changes nothing and answers `unchanged` — in this
    // interleaving it reads before the hold is written; one that finds the
    // hold is refused 403. (Which of the two a request in flight sees is
    // GOV-15's; neither writes.)
    if (clear.status === 200) {
      expect(clear.json).toEqual({ ok: true, cleared: false, unchanged: true });
    } else {
      expect(clear.status).toBe(403);
      expect(String(clear.json.error)).toMatch(/can't clear your own monthly AI cap override while another person has the “Manage AI spend caps” permission/);
    }
    expect(deletes).toBe(0);
    expect(raise.status).toBe(200);
    expect(raise.json).toMatchObject({ ok: true, capUsd: 100, selfHeldAtUsd: 10 });
    // What is stored is what the answers say: the default moved, ADMIN did not.
    expect(limitsOf(null)).toEqual([100]);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 10, selfFollowsDefault: false });
    expect((await get(ENG)).json).toMatchObject({ capUsd: 100 });
    expect(capDetails()).toEqual([
      { capUsd: 100, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
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
      { capUsd: 100, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { targetUserId: ADMIN, cleared: true, previousCapUsd: 10 },
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
    // the raise's own record (written first) and its not-applied companion
    expect(capDetails()).toEqual([
      { capUsd: 50, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { capUsd: 50, previousCapUsd: 10, notApplied: true, error: "canceling statement due to statement timeout" },
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
      { capUsd: 50, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { capUsd: 60, previousCapUsd: 10 },
      { capUsd: 50, previousCapUsd: 10, notApplied: true, error: "the cap changed while this was being saved" },
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
      { capUsd: 50, previousCapUsd: 10 },
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, heldOnDefaultRaise: true },
      { capUsd: 8, previousCapUsd: 10 },
      { capUsd: 50, previousCapUsd: 10, notApplied: true, error: "the cap changed while this was being saved" },
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
    // nothing put back, and no hold row says it came out (only the raise's
    // own record says it did not land)
    expect(capDetails().some((d) => (d as Row).compensated || ((d as Row).notApplied && (d as Row).targetUserId))).toBe(false);
    expect(capDetails()).toContainEqual({ capUsd: 50, previousCapUsd: 10, notApplied: true, error: "the cap changed while this was being saved" });
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
    expect(capDetails().find((d) => (d as Row).heldOnDefaultRaise)).toEqual({ targetUserId: ADMIN, capUsd: 5, previousCapUsd: 5, heldOnDefaultRaise: true });
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
      // the default's own figure, as ADMIN's own: a pin, said as one (fix pass 11)
      { targetUserId: ADMIN, capUsd: 10, previousCapUsd: 10, pinnedAtDefault: true },
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
    expect(r.json.selfCapSetByAnother).toBe(true);
    expect(String(r.json.error)).toMatch(/and your cap was changed again before your new override could be taken back out: it now reads \$3, a figure another person who manages AI caps set, so it was left as it now stands/);
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

  // ── The ninth review ─────────────────────────────────────────────────
  // An update that matches no row is never a 200; an override that changed
  // before it came out is read with who wrote it; a default the caller's own
  // OTHER request raised, trimmed by another holder, is not theirs.

  it("the ninth review's lock: another holder locks you while your own new override is taken back out — their update finds the row gone, so the lock is written as an insert: you end locked, as their 200, audit row and notice say", async () => {
    // $50 default by ADMIN2. ADMIN "lowers" to $45 by insert; ADMIN2 lowers
    // the default to $40 right after it, so ADMIN's override comes back out.
    // ADMIN2 locks ADMIN in that window: their existence read sees the $45
    // row, ADMIN's guarded delete runs, and then their update runs.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    let phase = 0;
    let lock: Promise<{ status: number; json: Row }> | null = null;
    let atUpdate!: () => void;
    const reachedUpdate = new Promise<void>((r) => { atUpdate = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    db.hook = async ({ table, action, payload }) => {
      if (table !== "ai_usage_limits") return;
      if (action === "update" && (payload as Row).monthly_cap_usd === 0) { atUpdate(); await gate; return; }
      if (phase === 0 && action === "insert" && (payload as Row).user_id === ADMIN) { phase = 1; return; }
      if (phase === 1 && action === "select") { phase = 2; expect((await post(ADMIN2, { capUsd: 40 })).status).toBe(200); phase = 3; return; }
      if (phase === 3 && action === "delete") { phase = 4; lock = post(ADMIN2, { capUsd: 0, userId: ADMIN }); await reachedUpdate; }
    };
    db.after = ({ table, action }) => { if (phase === 4 && table === "ai_usage_limits" && action === "delete") { phase = 5; release(); } };
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    const locked = await lock!;
    db.hook = null; db.after = null;
    expect(phase).toBe(5);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, capUsd: 45 });
    // was: 200 { capUsd: 0, locked: true } while ADMIN read $40, unlocked
    expect(locked.status).toBe(200);
    expect(locked.json).toMatchObject({ ok: true, capUsd: 0, locked: true });
    expect(limitsOf(ADMIN)).toEqual([0]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 0, locked: true });
    // "from" is the cap ADMIN was on when the lock was inserted — the $40
    // default, read again — never the $45 override read before it came out
    // (the tenth review's minor; this said 45)
    expect(capDetails()).toContainEqual({ targetUserId: ADMIN, capUsd: 0, previousCapUsd: 40 });
    expect(notices().some((n) => n.user_id === ADMIN && n.title === "Your monthly AI cap changed"
      && (n.metadata as Row).capUsd === 0 && (n.metadata as Row).previousCapUsd === 40 && /from \$40 to \$0 \(locked\)/.test(String(n.body)))).toBe(true);
  });

  it("…and another person's override cleared between your read and your update: your figure is written as an insert, never a 200 over nothing; one another request inserted first is a 409 and theirs stands", async () => {
    const seed = () => [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ENG, monthly_cap_usd: 30, updated_by: ADMIN2 }];
    db.tables.ai_usage_limits = seed();
    let step = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update" || step !== 0) return;
      step = 1;
      expect((await post(ADMIN2, { capUsd: null, userId: ENG })).status).toBe(200);
    };
    const r = await post(ADMIN, { capUsd: 0, userId: ENG });
    db.hook = null;
    expect(step).toBe(1);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, capUsd: 0, locked: true });
    // was: 200 with ENG on the $10 default
    expect(limitsOf(ENG)).toEqual([0]);
    expect((await get(ENG)).json).toMatchObject({ capUsd: 0, locked: true });

    db.tables.ai_usage_limits = seed();
    db.tables.audit_logs = [];
    step = 0;
    db.hook = async ({ table, action, payload }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "update") { step = 1; expect((await post(ADMIN2, { capUsd: null, userId: ENG })).status).toBe(200); }
      else if (step === 1 && action === "insert" && (payload as Row).monthly_cap_usd === 0) { step = 2; expect((await post(ADMIN2, { capUsd: 7, userId: ENG })).status).toBe(200); }
    };
    const lost = await post(ADMIN, { capUsd: 0, userId: ENG });
    db.hook = null;
    expect(step).toBe(2);
    expect(lost.status).toBe(409);
    expect(lost.json.conflict).toBe(true);
    expect(String(lost.json.error)).toMatch(/That cap changed while you were saving it .* so nothing was changed/);
    expect(limitsOf(ENG)).toEqual([7]);
    expect(capDetails().some((d) => (d as Row).capUsd === 0)).toBe(false);
  });

  it("the ninth review's own second write: your own other request moves your new override before it is taken back out — read with who wrote it, put back at the default (409 compensated, told), never left above it as another holder's", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    let phase = 0;
    let second: { status: number; json: Row } | null = null;
    db.hook = async ({ table, action, payload }) => {
      if (table !== "ai_usage_limits") return;
      if (phase === 0 && action === "insert" && (payload as Row).user_id === ADMIN) { phase = 1; return; }
      if (phase === 1 && action === "select") { phase = 2; expect((await post(ADMIN2, { capUsd: 40 })).status).toBe(200); phase = 3; return; }
      if (phase === 3 && action === "delete") { phase = 4; second = await post(ADMIN, { capUsd: 44, userId: ADMIN }); }
    };
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase).toBe(4);
    expect(second!.status).toBe(200);
    // was: 409 overrideChanged "another cap change has changed your cap since", ADMIN left at $44 over ADMIN2's $40
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, overrideChanged: true, compensated: true, capUsd: 45, selfCapUsd: 40 });
    expect(r.json.selfCapSetByAnother).toBeUndefined();
    expect(String(r.json.error)).toMatch(/and your cap was changed again before your new override could be taken back out: it read \$44, above that default, on a change of your own — so it was put back at \$40\./);
    expect(limitsOf(null)).toEqual([40]);
    expect(limitsOf(ADMIN)).toEqual([40]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 40 });
    expect(capDetails().slice(-2)).toEqual([
      { targetUserId: ADMIN, capUsd: 45, previousCapUsd: 50, defaultNowUsd: 40, overrideChanged: true },
      { targetUserId: ADMIN, capUsd: 40, previousCapUsd: 44, compensated: true },
    ]);
    const told = notices().find((n) => n.user_id === ADMIN2 && n.title === "A monthly AI cap was put back")!;
    expect(told).toBeDefined();
    expect(told.metadata).toMatchObject({ targetUserId: ADMIN, capUsd: 40, previousCapUsd: 44, putBack: true });
  });

  it("the ninth review's trim before your override comes out: your own default raise, then another holder's trim of it, both before the delete — the trim is not theirs (your own write since this request began is read from the log), so you are put back at the default you were taken back to", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    let phase = 0;
    const log: Array<{ status: number; json: Row }> = [];
    db.hook = async ({ table, action, payload }) => {
      if (table !== "ai_usage_limits") return;
      if (phase === 0 && action === "insert" && (payload as Row).user_id === ADMIN) { phase = 1; return; }
      if (phase === 1 && action === "select") { phase = 2; log.push(await post(ADMIN2, { capUsd: 40 })); phase = 3; return; }
      if (phase === 3 && action === "delete") {
        phase = 4;
        log.push(await post(ADMIN, { capUsd: 100 })); // ADMIN's $45 override still stands: no hold
        log.push(await post(ADMIN2, { capUsd: 90 })); // a trim of ADMIN's raise
      }
    };
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase).toBe(4);
    expect(log.map((l) => l.status)).toEqual([200, 200, 200]);
    // was: 409 selfCapUsd 90 selfCapSetByAnother — ADMIN at $90 from $50, on their own raise
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, capUsd: 45, selfCapUsd: 40 });
    expect(r.json.selfCapSetByAnother).toBeUndefined();
    expect(String(r.json.error)).toMatch(/Taking it out let your own cap rise to \$90 — another change landed at the same time — so it was put back at \$40\./);
    expect(limitsOf(null)).toEqual([90]);
    expect(limitsOf(ADMIN)).toEqual([40]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 40 });
    expect((await get(ENG)).json).toMatchObject({ capUsd: 90 });
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 40, previousCapUsd: 90, compensated: true });
  });

  it("…and the same on a hold's removal: your own second default raise, then another holder's trim, both before the hold comes out — put back where you started; a raise of yours from before this request began does not count", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10, updated_by: ADMIN2 }];
    let step = 0;
    const log: Array<{ status: number; json: Row }> = [];
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "update") { step = 1; log.push(await post(ADMIN2, { capUsd: 8 })); }
      else if (step === 1 && action === "delete") {
        step = 2;
        log.push(await post(ADMIN, { capUsd: 100 })); // finds the hold: writes none of its own
        log.push(await post(ADMIN2, { capUsd: 90 })); // a trim of ADMIN's raise
      }
    };
    const r = await post(ADMIN, { capUsd: 50 });
    db.hook = null;
    expect(step).toBe(2);
    expect(log.map((l) => l.status)).toEqual([200, 200, 200]);
    // was: 409 selfCapUsd 90 selfCapSetByAnother — ADMIN at $90 from $10
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, selfCapUsd: 10 });
    expect(r.json.selfCapSetByAnother).toBeUndefined();
    expect(String(r.json.error)).toMatch(/Taking your hold back out let your own cap rise to \$90 — another change landed at the same time — so it was put back at \$10\./);
    expect(limitsOf(null)).toEqual([90]);
    expect(limitsOf(ADMIN)).toEqual([10]);
    expect(capDetails().at(-1)).toEqual({ targetUserId: ADMIN, capUsd: 10, previousCapUsd: 90, compensated: true });

    // A raise of ADMIN's from an hour ago is not "since this request
    // began": ANOTHER holder's raise in the window is theirs and stands.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10, updated_by: ADMIN2 }];
    db.tables.audit_logs = [{
      id: "old", action: "AI_CAP_CHANGED", resource_type: "ai_usage_limit", resource_id: ORG, org_id: ORG, user_id: ADMIN,
      details: { capUsd: 1000, previousCapUsd: 10 }, timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    }];
    step = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "update") { step = 1; expect((await post(ADMIN2, { capUsd: 8 })).status).toBe(200); }
      else if (step === 1 && action === "delete") { step = 2; expect((await post(ADMIN2, { capUsd: 60 })).status).toBe(200); }
    };
    const theirs = await post(ADMIN, { capUsd: 50 });
    db.hook = null;
    expect(step).toBe(2);
    expect(theirs.status).toBe(409);
    expect(theirs.json).toMatchObject({ conflict: true, selfCapUsd: 60, selfCapSetByAnother: true });
    expect(theirs.json.compensated).toBeUndefined();
    expect(limitsOf(ADMIN)).toEqual([]);
  });

  // ── The tenth review ─────────────────────────────────────────────────
  // Your own LOWERING of a figure another holder signed is not a self-raise;
  // your own default lowerings are not "own raises"; a default raise is
  // recorded before it is made; a fallback insert says the figure it
  // replaced.

  /** The overrideChanged interleaving: $50 default by ADMIN2; ADMIN "lowers"
   *  to $45 by insert; ADMIN2 lowers the default to $40 right after it, so
   *  ADMIN's override comes back out; `atDelete` runs just before that
   *  guarded delete. */
  const beforeOverrideComesOut = (atDelete: () => Promise<void>) => {
    let phase = 0;
    db.hook = async ({ table, action, payload }) => {
      if (table !== "ai_usage_limits") return;
      if (phase === 0 && action === "insert" && (payload as Row).user_id === ADMIN) { phase = 1; return; }
      if (phase === 1 && action === "select") { phase = 2; expect((await post(ADMIN2, { capUsd: 40 })).status).toBe(200); phase = 3; return; }
      if (phase === 3 && action === "delete") { phase = 4; await atDelete(); }
    };
    return () => phase;
  };

  it("the tenth review's S4: another holder raises your new override, you lower it a little, and the stale request's re-read leaves it — your own lowering of their signed figure stands, never put back below it", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    const log: Array<{ status: number; json: Row }> = [];
    const phase = beforeOverrideComesOut(async () => {
      log.push(await post(ADMIN2, { capUsd: 60, userId: ADMIN })); // signed by ADMIN2
      log.push(await post(ADMIN, { capUsd: 55, userId: ADMIN }));  // ADMIN's own lowering of it
    });
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase()).toBe(4);
    expect(log.map((l) => l.status)).toEqual([200, 200]);
    // was: 409 compensated "it read $55, above that default, on a change of your own — so it was put back at $40"
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, overrideChanged: true, capUsd: 45, selfCapUsd: 55, selfCapSetByAnother: true, selfCapOwnLowering: true });
    expect(r.json.compensated).toBeUndefined();
    expect(String(r.json.error)).toMatch(/: it now reads \$55, your own lowering of a figure another person who manages AI caps set, so it was left as it now stands/);
    expect(String(r.json.error)).not.toMatch(/on a change of your own/);
    expect(limitsOf(ADMIN)).toEqual([55]);
    expect((await get(ADMIN)).json).toMatchObject({ capUsd: 55 });
    expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);
    expect(notices().some((n) => n.title === "A monthly AI cap was put back")).toBe(false);
    // ADMIN2's change names the override row it wrote — the row ADMIN then lowered
    const signed = db.tables.audit_logs.find((a) => a.user_id === ADMIN2 && (a.details as Row).capUsd === 60)!;
    expect((signed.details as Row).limitRowId).toBe(db.tables.ai_usage_limits.find((l) => l.user_id === ADMIN)!.id);
  });

  it("…but a figure another holder set on an EARLIER override of yours, cleared since, is not one you lowered: your own figure above the default is put back", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    // In this request's window: ADMIN2 set $60 on an override of ADMIN's
    // that was then cleared (another row).
    const now = new Date().toISOString();
    db.tables.audit_logs = [
      { id: "a1", action: "AI_CAP_CHANGED", resource_type: "ai_usage_limit", resource_id: ORG, org_id: ORG, user_id: ADMIN2, timestamp: now,
        details: { targetUserId: ADMIN, capUsd: 60, previousCapUsd: 50, limitRowId: "r-earlier" } },
      { id: "a2", action: "AI_CAP_CHANGED", resource_type: "ai_usage_limit", resource_id: ORG, org_id: ORG, user_id: ADMIN2, timestamp: now,
        details: { targetUserId: ADMIN, cleared: true, previousCapUsd: 60 } },
    ];
    let second: { status: number; json: Row } | null = null;
    const phase = beforeOverrideComesOut(async () => { second = await post(ADMIN, { capUsd: 44, userId: ADMIN }); });
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase()).toBe(4);
    expect(second!.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, overrideChanged: true, compensated: true, selfCapUsd: 40 });
    expect(r.json.selfCapSetByAnother).toBeUndefined();
    expect(limitsOf(ADMIN)).toEqual([40]);
  });

  it("the tenth review's S5: held on your default raise, another holder raises you and you lower it a little — the raise's re-read leaves your lowering of their figure (200, said as yours), never put back at the hold", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 10, updated_by: ADMIN2 }];
    let step = 0;
    const log: Array<{ status: number; json: Row }> = [];
    db.hook = async ({ table, action, payload }) => {
      if (table !== "ai_usage_limits") return;
      if (step === 0 && action === "update" && (payload as Row).monthly_cap_usd === 100) { step = 1; return; }
      if (step === 1 && action === "select") {
        step = 2;
        log.push(await post(ADMIN2, { capUsd: 60, userId: ADMIN }));
        log.push(await post(ADMIN, { capUsd: 55, userId: ADMIN }));
      }
    };
    const r = await post(ADMIN, { capUsd: 100 });
    db.hook = null;
    expect(step).toBe(2);
    expect(log.map((l) => l.status)).toEqual([200, 200]);
    // was: 409 compensated "your own cap rose to $55 … put back at $10"
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, capUsd: 100, selfCapUsd: 55, selfCapSetByAnother: true, selfCapOwnLowering: true });
    expect(r.json.selfHeldAtUsd).toBeUndefined();
    expect(limitsOf(ADMIN)).toEqual([55]);
    expect(capDetails().some((d) => (d as Row).compensated)).toBe(false);
  });

  it("the tenth review's S1: your own default LOWERING is not an own raise — another holder's figure below it but above where you started stands; your lowering of their raise stands too", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    const log: Array<{ status: number; json: Row }> = [];
    let phase = beforeOverrideComesOut(async () => {
      log.push(await post(ADMIN2, { capUsd: 80 })); // ADMIN2 raises the default (ADMIN still has the $45 override)
      log.push(await post(ADMIN, { capUsd: 70 }));  // ADMIN LOWERS it (no hold: a lowering)
      log.push(await post(ADMIN2, { capUsd: 65 })); // ADMIN2 lowers it again
    });
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase()).toBe(4);
    expect(log.map((l) => l.status)).toEqual([200, 200, 200]);
    // was: 409 compensated, ADMIN put back at $40 ("put back from $65 … raise it again")
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, selfCapUsd: 65, selfCapSetByAnother: true });
    expect(r.json.selfCapOwnLowering).toBeUndefined();
    expect(String(r.json.error)).toMatch(/Your own cap now reads \$65 — a figure another person who manages AI caps set\./);
    expect(limitsOf(ADMIN)).toEqual([]);
    expect(capDetails().some((d) => (d as Row).compensated && !(d as Row).overrideRemoved)).toBe(false);

    // Without ADMIN2's last trim: ADMIN follows $70 — their own lowering of
    // ADMIN2's signed $80 — and it stands.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    db.tables.audit_logs = [];
    log.length = 0;
    phase = beforeOverrideComesOut(async () => {
      log.push(await post(ADMIN2, { capUsd: 80 }));
      log.push(await post(ADMIN, { capUsd: 70 }));
    });
    const own = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase()).toBe(4);
    expect(own.status).toBe(409);
    expect(own.json).toMatchObject({ compensated: true, selfCapUsd: 70, selfCapSetByAnother: true, selfCapOwnLowering: true });
    expect(String(own.json.error)).toMatch(/Your own cap now reads \$70 — your own lowering of a figure another person who manages AI caps set\./);
    expect(limitsOf(null)).toEqual([70]);
    expect(limitsOf(ADMIN)).toEqual([]);
  });

  it("…and the default's history is read in order: another holder's raise BEFORE your own raise in the window does not make your raise theirs — put back", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    let phase = 0;
    const log: Array<{ status: number; json: Row }> = [];
    db.hook = async ({ table, action, payload }) => {
      if (table !== "ai_usage_limits") return;
      if (phase === 0 && action === "insert" && (payload as Row).user_id === ADMIN) { phase = 1; return; }
      if (phase === 1 && action === "select") {
        phase = 2;
        log.push(await post(ADMIN2, { capUsd: 120 })); // signed, then taken back down
        log.push(await post(ADMIN2, { capUsd: 40 }));
        phase = 3;
        return;
      }
      if (phase === 3 && action === "delete") { phase = 4; log.push(await post(ADMIN, { capUsd: 100 })); } // ADMIN's own raise
    };
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase).toBe(4);
    expect(log.map((l) => l.status)).toEqual([200, 200, 200]);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, compensated: true, selfCapUsd: 40 });
    expect(r.json.selfCapSetByAnother).toBeUndefined();
    expect(String(r.json.error)).toMatch(/Taking it out let your own cap rise to \$100 .* so it was put back at \$40\./);
    expect(limitsOf(null)).toEqual([100]);
    expect(limitsOf(ADMIN)).toEqual([40]);
  });

  it("the tenth review's S3, restated in fix pass 11: a raise of the default is recorded BEFORE it is made when the log takes it — but that row is no control, so one the log refuses still goes ahead (as at 052271b), never a 503; only a sole holder's own raise is refused unrecorded", async () => {
    // A holder with an override of their own, and one who follows the default (held).
    for (const own of [45, null] as const) {
      db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 40, updated_by: ADMIN2 }];
      if (own !== null) db.tables.ai_usage_limits.push({ org_id: ORG, user_id: ADMIN, monthly_cap_usd: own, updated_by: ADMIN });
      db.tables.audit_logs = [];
      db.tables.notifications = [];
      db.errors["audit_logs:insert"] = { message: "audit write timed out" };
      const r = await post(ADMIN, { capUsd: 100 });
      delete db.errors["audit_logs:insert"];
      // was (fix pass 10): 503 "Couldn't write the audit record a raise of the workspace default needs…", nothing changed
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

    // A refused record whose retry after the change lands: the raise is in the log once.
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

    // GOV-15 (two requests in flight; out of this package's scope since the
    // integrator's decision): an own raise the log refused is invisible to
    // the re-read, so another holder's trim of it reads as their figure.
    // Pinned so the transaction that closes it flips this expectation.
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    db.tables.audit_logs = [];
    const log: Array<{ status: number; json: Row }> = [];
    const phase = beforeOverrideComesOut(async () => {
      db.errors["audit_logs:insert"] = { message: "audit write timed out" };
      log.push(await post(ADMIN, { capUsd: 100 }));
      delete db.errors["audit_logs:insert"];
      log.push(await post(ADMIN2, { capUsd: 90 }));
    });
    const raced = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase()).toBe(4);
    expect(log.map((l) => l.status)).toEqual([200, 200]);
    expect(limitsOf(null)).toEqual([90]);
    expect(raced.json).toMatchObject({ selfCapUsd: 90, selfCapSetByAnother: true });
  });

  it("…and a raise of yours that did NOT land is not an own raise: its record and its not-applied companion share a writeId, and another holder's raise below it stands", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    const log: Array<{ status: number; json: Row }> = [];
    const phase = beforeOverrideComesOut(async () => {
      db.errors["ai_usage_limits:update"] = { message: "canceling statement due to statement timeout" };
      log.push(await post(ADMIN, { capUsd: 100 })); // fails after its record
      delete db.errors["ai_usage_limits:update"];
      log.push(await post(ADMIN2, { capUsd: 90 }));
    });
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase()).toBe(4);
    expect(log.map((l) => l.status)).toEqual([500, 200]);
    const raised = db.tables.audit_logs.filter((a) => a.user_id === ADMIN && (a.details as Row).capUsd === 100 && !(a.details as Row).targetUserId);
    expect(raised.map((a) => plainDetails(a.details))).toEqual([
      { capUsd: 100, previousCapUsd: 40 },
      { capUsd: 100, previousCapUsd: 40, notApplied: true, error: "canceling statement due to statement timeout" },
    ]);
    expect((raised[0].details as Row).writeId).toBe((raised[1].details as Row).writeId);
    // was (counting the failed raise as ADMIN's own): ADMIN2's $90 put back at $40
    expect(r.json).toMatchObject({ selfCapUsd: 90, selfCapSetByAnother: true });
    expect(capDetails().some((d) => (d as Row).compensated && !(d as Row).overrideRemoved)).toBe(false);
    expect(limitsOf(ADMIN)).toEqual([]);
  });

  it("the tenth review's S2: a change to another person's cap that finds their override gone is audited and told FROM the cap they were on then (read again), never the override that was cleared; one that cannot be read again changes nothing (503)", async () => {
    const seed = () => [{ org_id: ORG, user_id: null, monthly_cap_usd: 10 }, { org_id: ORG, user_id: ENG, monthly_cap_usd: 30, updated_by: ADMIN2 }];
    db.tables.ai_usage_limits = seed();
    let step = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update" || step !== 0) return;
      step = 1;
      expect((await post(ADMIN2, { capUsd: null, userId: ENG })).status).toBe(200);
    };
    const r = await post(ADMIN, { capUsd: 20, userId: ENG });
    db.hook = null;
    expect(step).toBe(1);
    expect(r.status).toBe(200);
    expect(limitsOf(ENG)).toEqual([20]);
    // was: { capUsd: 20, previousCapUsd: 30 } and "from $30 to $20" while ENG was on the $10 default
    const audit = db.tables.audit_logs.at(-1)!;
    expect(plainDetails(audit.details)).toEqual({ targetUserId: ENG, capUsd: 20, previousCapUsd: 10 });
    expect((audit.details as Row).limitRowId).toBe(db.tables.ai_usage_limits.find((l) => l.user_id === ENG)!.id);
    const told = notices().filter((n) => n.user_id === ENG).at(-1)!;
    expect(String(told.body)).toMatch(/from \$10 to \$20/);

    db.tables.ai_usage_limits = seed();
    db.tables.audit_logs = [];
    db.tables.notifications = [];
    step = 0;
    db.hook = async ({ table, action }) => {
      if (table !== "ai_usage_limits" || action !== "update" || step !== 0) return;
      step = 1;
      expect((await post(ADMIN2, { capUsd: null, userId: ENG })).status).toBe(200);
      db.errors["ai_usage_limits:select"] = { message: "connection reset" };
    };
    const blind = await post(ADMIN, { capUsd: 20, userId: ENG });
    db.hook = null;
    delete db.errors["ai_usage_limits:select"];
    expect(blind.status).toBe(503);
    expect(String(blind.json.error)).toMatch(/That person's cap changed while you were saving it, and it can't be read again now, so nothing was changed/);
    expect(limitsOf(ENG)).toEqual([]);
    expect(capDetails().some((d) => (d as Row).capUsd === 20)).toBe(false);
    expect(notices().some((n) => (n.metadata as Row).capUsd === 20)).toBe(false);
  });

  it("the tenth review's wording: an override of yours that changed before it came out, left above the default because nobody else manages AI caps now, is said as that — never 'no higher than that default'", async () => {
    db.tables.ai_usage_limits = [{ org_id: ORG, user_id: null, monthly_cap_usd: 50, updated_by: ADMIN2 }];
    let second: { status: number; json: Row } | null = null;
    const phase = beforeOverrideComesOut(async () => {
      second = await post(ADMIN, { capUsd: 44, userId: ADMIN });
      // ADMIN2 is no longer an active member: ADMIN is now the sole holder
      db.tables.org_members.find((m) => m.uid === ADMIN2)!.status = "removed";
    });
    const r = await post(ADMIN, { capUsd: 45, userId: ADMIN });
    db.hook = null;
    expect(phase()).toBe(4);
    expect(second!.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ conflict: true, overrideChanged: true, selfCapUsd: 44 });
    expect(String(r.json.error)).toMatch(/: it now reads \$44, above that default, but nobody else manages AI caps now, so it was left as it now stands\./);
    expect(String(r.json.error)).not.toMatch(/no higher than that default/);
    expect(limitsOf(ADMIN)).toEqual([44]);
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
