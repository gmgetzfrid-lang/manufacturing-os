// admin-and-org Round G — P5, the integrator's fix pass at the merge
// (2026-10-20, DEC-90: industry practice, fail-safe, no regression).
//
//   ruling 1  the two public doors match a typed workspace name LITERALLY:
//             "%", "*", "_cme refining" never match "Acme Refining"; "Acm%"
//             is not "Acme"; every real name still matches in any letter case
//             with surrounding whitespace (lib/identity.ts findOrgByTypedName).
//   ruling 2  enforceOrgAccess with the switch OFF writes its "would refuse"
//             line at most once per workspace per hour per process, the next
//             line counting the calls not logged; ON is unchanged.
//   ruling 3  ORG-24: request-access answers "no such workspace", "already
//             asked" and "recorded" with the same body, after the same five
//             awaited round trips, the Admins' notice after the response, and
//             never sooner than REQUEST_ACCESS_MIN_RESPONSE_MS — on every path.
//
// The orgs table here is evaluated the way PostgREST + PostgreSQL would:
// PostgREST turns every `*` in an ilike value into `%`; ILIKE reads `%`, `_`
// and the `\` escape. So a test that passes the typed text as the pattern
// (the code before this fix) matches "Acme Refining" for "%" and fails here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Op = [string, unknown[]];

const st = vi.hoisted(() => ({
  orgRows: [] as Array<{ id: string; name: string }>,
  windowCount: 0,
  windowFails: false,
  pendingFor: new Set<string>(),
  recentCount: 1,
  insertFails: false,
  latencyMs: 0,
  awaited: [] as string[],
  after: [] as Array<() => unknown>,
  ilikeOnOrgs: [] as string[],
  inserts: [] as Array<{ table: string; row: unknown }>,
}));

/** PostgREST's ilike: `*` → `%`, then PostgreSQL ILIKE with `\` as escape. */
function pgrestIlike(pattern: string, value: string): boolean {
  const p = pattern.replace(/\*/g, "%");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) { re += p[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"); continue; }
    if (c === "%") { re += "[\\s\\S]*"; continue; }
    if (c === "_") { re += "[\\s\\S]"; continue; }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

function opArgs(ops: Op[], name: string): unknown[] | undefined {
  return ops.find(([m]) => m === name)?.[1];
}

function compute(table: string, ops: Op[]): { label: string; result: { data: unknown; error: unknown; count?: number | null } } {
  const has = (m: string) => ops.some(([x]) => x === m);
  const head = !!(opArgs(ops, "select")?.[1] as { head?: boolean } | undefined)?.head;
  if (table === "orgs") {
    if (has("insert")) return { label: "orgs:insert", result: { data: { id: "org-new" }, error: null } };
    const [, pattern] = (opArgs(ops, "ilike") ?? ["name", ""]) as [string, string];
    st.ilikeOnOrgs.push(pattern);
    const rows = st.orgRows.filter((r) => pgrestIlike(pattern, r.name));
    if (has("maybeSingle")) {
      return rows.length > 1
        ? { label: "orgs:lookup", result: { data: null, error: { code: "PGRST116", message: "multiple rows" } } }
        : { label: "orgs:lookup", result: { data: rows[0] ?? null, error: null } };
    }
    const n = (opArgs(ops, "limit")?.[0] as number | undefined) ?? rows.length;
    return { label: "orgs:lookup", result: { data: rows.slice(0, n), error: null } };
  }
  if (table === "signup_attempts") {
    if (has("insert")) return { label: "signup_attempts:insert", result: { data: null, error: null } };
    return st.windowFails
      ? { label: "signup_attempts:count", result: { data: null, error: { code: "08006", message: "connection failure" }, count: null } }
      : { label: "signup_attempts:count", result: { data: null, error: null, count: st.windowCount } };
  }
  if (table === "access_requests") {
    if (has("insert")) {
      st.inserts.push({ table, row: opArgs(ops, "insert")?.[0] });
      return st.insertFails
        ? { label: "access_requests:insert", result: { data: null, error: { message: "duplicate key value" } } }
        : { label: "access_requests:insert", result: { data: { id: "r-new" }, error: null } };
    }
    if (head) return { label: "access_requests:count", result: { data: null, error: null, count: st.recentCount } };
    const orgEq = ops.find(([m, a]) => m === "eq" && a[0] === "org_id")?.[1][1] as string;
    return { label: "access_requests:duplicate", result: { data: st.pendingFor.has(orgEq) ? [{ id: "r1", status: "pending" }] : [], error: null } };
  }
  if (table === "users") return { label: "users:lookup", result: { data: [], error: null } };
  if (table === "org_members") {
    if (has("insert")) { st.inserts.push({ table, row: opArgs(ops, "insert")?.[0] }); return { label: "org_members:insert", result: { data: null, error: null } }; }
    return { label: "org_members:read", result: { data: [{ uid: "admin1", email: "admin1@acme.test" }], error: null } };
  }
  return { label: `${table}:other`, result: { data: null, error: null } };
}

async function settle(table: string, ops: Op[]) {
  if (st.latencyMs > 0) await new Promise((r) => setTimeout(r, st.latencyMs));
  const { label, result } = compute(table, ops);
  st.awaited.push(label);
  return result;
}

function chain(table: string): unknown {
  const ops: Op[] = [];
  const self: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => settle(table, ops).then(ok, bad);
      return (...args: unknown[]) => {
        ops.push([prop, args]);
        return prop === "maybeSingle" || prop === "single" ? settle(table, ops) : self;
      };
    },
  });
  return self;
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (table: string) => chain(table),
    auth: { admin: { createUser: async () => ({ data: { user: { id: "uid-new" } }, error: null }), deleteUser: async () => ({ data: null, error: null }) } },
    rpc: async () => ({ data: { told: 1, already: 0 }, error: null }),
  },
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { st.after.push(fn); },
}));
vi.mock("@/lib/notify/recipients", () => ({ resolveRoleRecipients: vi.fn(async () => ["admin1"]) }));
vi.mock("@/lib/inAppNotifications", () => ({
  notifyMany: vi.fn(async () => undefined),
  notifyBatchWithReason: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/lib/notifications", () => ({ queueEmail: vi.fn(async () => undefined) }));

import { POST as requestAccess } from "@/app/api/auth/request-access/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { REQUEST_ACCESS_ACKNOWLEDGEMENT, PUBLIC_DOOR_MAX_PER_HOUR } from "@/lib/publicDoorLimiter";
import { REQUEST_ACCESS_MIN_RESPONSE_MS, requestAccessTiming } from "@/lib/accessRequestOutcome";
import { likeLiteral, findOrgByTypedName } from "@/lib/identity";
import { notifyMany } from "@/lib/inAppNotifications";
import { queueEmail } from "@/lib/notifications";
import { enforceOrgAccess, resetWouldRefuseLogForTests, WOULD_REFUSE_LOG_TTL_MS } from "@/lib/serverAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const ACME = { id: "org-acme", name: "Acme Refining" };
const post = (url: string, body: Record<string, unknown>) => new NextRequest(url, {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify(body),
});
const ask = (orgName: string, extra: Record<string, unknown> = {}) =>
  requestAccess(post("http://localhost/api/auth/request-access", { displayName: "Greg", email: "Greg@Corp.com", orgName, ...extra }));
const join_ = (companyName: string) =>
  signup(post("http://localhost/api/auth/signup", { email: "Greg@Corp.com", password: "hunter22", displayName: "Greg", companyName }));
const ACK = { ok: true, message: REQUEST_ACCESS_ACKNOWLEDGEMENT };
const accessInserts = () => st.inserts.filter((i) => i.table === "access_requests");

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  st.orgRows = [ACME];
  st.windowCount = 0;
  st.windowFails = false;
  st.pendingFor = new Set();
  st.recentCount = 1;
  st.insertFails = false;
  st.latencyMs = 0;
  st.awaited = [];
  st.after = [];
  st.ilikeOnOrgs = [];
  st.inserts = [];
  vi.mocked(notifyMany).mockClear();
  vi.mocked(queueEmail).mockClear();
  // the door-logic suites below run without the floor; the ORG-24 suite sets it
  requestAccessTiming.floorMs = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  requestAccessTiming.floorMs = REQUEST_ACCESS_MIN_RESPONSE_MS;
  vi.useRealTimers();
  warn.mockRestore();
});

describe("ruling 1 — a typed workspace name is matched literally at both public doors", () => {
  it("likeLiteral escapes \\, % and _ (the emailLikePattern rule)", () => {
    expect(likeLiteral("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
    expect(likeLiteral("Acme Refining")).toBe("Acme Refining");
  });

  for (const probe of ["%", "*", "_cme refining", "acme%", "Acme Refinin_", "*Refining", "%cme r*"]) {
    it(`request-access with "${probe}": no access_requests row, nobody told, the same neutral answer`, async () => {
      const res = await ask(probe);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ACK);
      expect(accessInserts()).toHaveLength(0);
      expect(st.after).toHaveLength(0);
      expect(notifyMany).not.toHaveBeenCalled();
      expect(queueEmail).not.toHaveBeenCalled();
      // what reached PostgREST holds no live wildcard and no `*`
      for (const p of st.ilikeOnOrgs) expect(p).not.toContain("*");
    });
  }

  it("the old code's own probe proves the fake: the raw text as a pattern WOULD match", () => {
    expect(pgrestIlike("%", "Acme Refining")).toBe(true);
    expect(pgrestIlike("*", "Acme Refining")).toBe(true);
    expect(pgrestIlike("_cme refining", "Acme Refining")).toBe(true);
    expect(pgrestIlike(likeLiteral("_cme refining"), "Acme Refining")).toBe(false);
  });

  it("signup: 'Acm%' is not 'Acme' — no 409, the workspace is created", async () => {
    st.orgRows = [{ id: "org-acme", name: "Acme" }];
    const res = await join_("Acm%");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orgId: "org-new", userId: "uid-new" });
    expect(st.ilikeOnOrgs[0]).toBe("Acm\\%");
  });

  it("signup: 'acme refining ' still finds 'Acme Refining' (409, the name as typed)", async () => {
    const res = await join_("acme refining ");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('An organization named "acme refining" already exists. If you belong to this organization, use "Request Access" instead.');
  });

  it("REGRESSION: every exact name, any letter case, surrounding whitespace, still records the request for that workspace", async () => {
    for (const typed of ["Acme Refining", "acme refining", "  ACME REFINING  ", "\tAcMe ReFiNiNg\n"]) {
      st.inserts = [];
      st.after = [];
      const res = await ask(typed);
      expect(await res.json()).toEqual(ACK);
      expect(accessInserts(), typed).toHaveLength(1);
      expect(accessInserts()[0].row).toMatchObject({ org_id: "org-acme", org_name: "Acme Refining", email: "greg@corp.com", status: "pending" });
      expect(st.after).toHaveLength(1);
    }
  });

  it("a real name holding LIKE metacharacters matches itself and only itself", async () => {
    st.orgRows = [{ id: "o1", name: "R_D 100% Ltd" }, { id: "o2", name: "RxD 100% Ltd" }, { id: "o3", name: "R_D 1000 Ltd" }];
    expect(await findOrgByTypedName(supabaseAdmin, " r_d 100% ltd ")).toEqual({ id: "o1", name: "R_D 100% Ltd" });
    expect(await findOrgByTypedName(supabaseAdmin, "rxd 100% LTD")).toEqual({ id: "o2", name: "RxD 100% Ltd" });
  });

  it("a name holding `*` is compared exactly (case-insensitive), never as a wildcard", async () => {
    st.orgRows = [{ id: "o1", name: "R*Tech" }, { id: "o2", name: "RxTech" }];
    expect(await findOrgByTypedName(supabaseAdmin, "  r*tech ")).toEqual({ id: "o1", name: "R*Tech" });
    st.orgRows = [{ id: "o2", name: "RxTech" }, { id: "o3", name: "Rocket Tech" }];
    expect(await findOrgByTypedName(supabaseAdmin, "R*Tech")).toBeNull();
    expect(await findOrgByTypedName(supabaseAdmin, "*")).toBeNull();
    expect(st.ilikeOnOrgs.every((p) => !p.includes("*"))).toBe(true);
    // the request door files the star-named workspace's request exactly as before
    st.orgRows = [{ id: "o1", name: "R*Tech" }];
    await ask("r*TECH");
    expect(accessInserts()[0].row).toMatchObject({ org_id: "o1", org_name: "R*Tech" });
  });

  it("an empty or whitespace name finds nothing and reads nothing", async () => {
    expect(await findOrgByTypedName(supabaseAdmin, "   ")).toBeNull();
    expect(st.ilikeOnOrgs).toHaveLength(0);
  });
});

describe("ruling 3 — ORG-24: the request door's answer does not depend on whether the workspace exists", () => {
  /** Runs one request under fake time; answers when it resolved (ms after start) and its body. */
  async function timed(run: () => Promise<Response>): Promise<{ at: number; status: number; body: string }> {
    const t0 = Date.now();
    let at = -1;
    const p = run().then((r) => { at = Date.now() - t0; return r; });
    await vi.advanceTimersByTimeAsync(REQUEST_ACCESS_MIN_RESPONSE_MS - 1);
    expect(at, "answered before the floor").toBe(-1);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await p;
    return { at, status: res.status, body: await res.text() };
  }

  it("the floor is 600 ms and is what the door applies", () => {
    expect(REQUEST_ACCESS_MIN_RESPONSE_MS).toBe(600);
    requestAccessTiming.floorMs = REQUEST_ACCESS_MIN_RESPONSE_MS;
    expect(requestAccessTiming.floorMs).toBe(600);
  });

  it("unknown / duplicate / recorded: identical status and body, the same five awaited round trips, every one answered at exactly the floor — at a pessimistic 80 ms per round trip", async () => {
    vi.useFakeTimers();
    requestAccessTiming.floorMs = REQUEST_ACCESS_MIN_RESPONSE_MS;
    st.latencyMs = 80;
    const runs: Record<string, { at: number; status: number; body: string; awaited: string[]; after: number; told: number }> = {};
    for (const [label, prep] of [
      ["unknown", () => { st.orgRows = []; }],
      ["duplicate", () => { st.orgRows = [ACME]; st.pendingFor = new Set([ACME.id]); }],
      ["recorded", () => { st.orgRows = [ACME]; st.pendingFor = new Set(); }],
    ] as const) {
      prep();
      st.awaited = [];
      st.after = [];
      vi.mocked(notifyMany).mockClear();
      const r = await timed(() => ask("Acme Refining"));
      runs[label] = { ...r, awaited: [...st.awaited], after: st.after.length, told: vi.mocked(notifyMany).mock.calls.length };
    }
    const { unknown, duplicate, recorded } = runs;
    expect([unknown.status, duplicate.status, recorded.status]).toEqual([200, 200, 200]);
    expect(new Set([unknown.body, duplicate.body, recorded.body]).size).toBe(1);
    expect(JSON.parse(recorded.body)).toEqual(ACK);
    expect([unknown.at, duplicate.at, recorded.at]).toEqual([600, 600, 600]);
    const shape = ["signup_attempts:count", "signup_attempts:insert", "orgs:lookup", "access_requests:duplicate"];
    expect(unknown.awaited).toEqual([...shape, "access_requests:count"]);
    expect(duplicate.awaited).toEqual([...shape, "access_requests:count"]);
    expect(recorded.awaited).toEqual([...shape, "access_requests:insert"]);
    // the response is sent before the notice: nothing was told while answering
    expect([unknown.told, duplicate.told, recorded.told]).toEqual([0, 0, 0]);
    expect([unknown.after, duplicate.after, recorded.after]).toEqual([0, 0, 1]);
  });

  it("the notice scheduled by the recorded request runs after the response and reaches the Admins", async () => {
    const res = await ask("Acme Refining");
    expect(await res.json()).toEqual(ACK);
    expect(notifyMany).not.toHaveBeenCalled();
    expect(st.after).toHaveLength(1);
    await st.after[0]();
    expect(notifyMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyMany).mock.calls[0][0]).toMatchObject({ orgId: "org-acme", userIds: ["admin1"], kind: "access_request_pending", title: "Greg asked to join Acme Refining" });
    expect(queueEmail).toHaveBeenCalledTimes(1);
  });

  it("the floor is applied on every path — missing fields, the window spent, the window uncountable, a recording fault, and each outcome at no latency", async () => {
    vi.useFakeTimers();
    requestAccessTiming.floorMs = REQUEST_ACCESS_MIN_RESPONSE_MS;
    const at: Record<string, number> = {};
    at.missing = (await timed(() => requestAccess(post("http://localhost/api/auth/request-access", { displayName: "Greg" })))).at;
    st.windowCount = PUBLIC_DOOR_MAX_PER_HOUR;
    const limited = await timed(() => ask("Acme Refining"));
    expect(limited.status).toBe(429);
    at.limited = limited.at;
    st.windowCount = 0;
    st.windowFails = true;
    const unchecked = await timed(() => ask("Acme Refining"));
    expect(unchecked.status).toBe(503);
    at.unchecked = unchecked.at;
    st.windowFails = false;
    st.insertFails = true;
    const fault = await timed(() => ask("Acme Refining"));
    expect(fault.status).toBe(500);
    at.fault = fault.at;
    st.insertFails = false;
    st.orgRows = [];
    at.unknown = (await timed(() => ask("Acme Refining"))).at;
    st.orgRows = [ACME];
    st.pendingFor = new Set([ACME.id]);
    at.duplicate = (await timed(() => ask("Acme Refining"))).at;
    st.pendingFor = new Set();
    at.recorded = (await timed(() => ask("Acme Refining"))).at;
    expect(at).toEqual({ missing: 600, limited: 600, unchecked: 600, fault: 600, unknown: 600, duplicate: 600, recorded: 600 });
  });

  it("source: after() carries the notice and the floor wraps the whole handler", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("app/api/auth/request-access/route.ts", "utf8");
    expect(route).toMatch(/import \{ NextRequest, NextResponse, after \} from "next\/server";/);
    expect(route).toMatch(/const startedAt = Date\.now\(\);\n\s+const res = await answer\(req\);\n\s+await holdUntilFloor\(startedAt\);\n\s+return res;/);
    expect(route).toContain("await noticeAfterResponse(() => notifyAccessRequest({");
    expect(route).not.toMatch(/await notifyAccessRequest\(/);
  });
});

describe("ruling 2 — the switch-off 'would refuse' line, once per workspace per hour", () => {
  const lapsed = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { subscription_status: "canceled", trial_ends_at: null }, error: null }) }) }) }),
  } as never;
  const prev = process.env.SUBSCRIPTION_ENFORCE;
  beforeEach(() => { resetWouldRefuseLogForTests(); delete process.env.SUBSCRIPTION_ENFORCE; });
  afterEach(() => { if (prev === undefined) delete process.env.SUBSCRIPTION_ENFORCE; else process.env.SUBSCRIPTION_ENFORCE = prev; });
  const lines = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("would refuse"));

  it("two OFF calls for one lapsed workspace log once; another workspace logs its own line; neither is refused", async () => {
    expect(await enforceOrgAccess(lapsed, "org-a", "storage/upload-url")).toBeNull();
    expect(await enforceOrgAccess(lapsed, "org-a", "storage/multipart")).toBeNull();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^\[storage\/upload-url\] subscription gate would refuse org org-a \(SUBSCRIPTION_ENFORCE off\): This workspace's subscription was canceled/);
    expect(await enforceOrgAccess(lapsed, "org-b", "create-user")).toBeNull();
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toMatch(/^\[create-user\] subscription gate would refuse org org-b /);
  });

  it("after the hour the next line is written and counts the calls not logged", async () => {
    vi.useFakeTimers();
    await enforceOrgAccess(lapsed, "org-a", "storage/upload-url");
    await enforceOrgAccess(lapsed, "org-a", "storage/upload-url");
    await enforceOrgAccess(lapsed, "org-a", "storage/upload-url");
    vi.advanceTimersByTime(WOULD_REFUSE_LOG_TTL_MS - 1);
    await enforceOrgAccess(lapsed, "org-a", "storage/upload-url");
    expect(lines()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await enforceOrgAccess(lapsed, "org-a", "storage/upload-url");
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toMatch(/\(3 more would-refuse call\(s\) for this workspace were not logged since the last line\)$/);
    expect(WOULD_REFUSE_LOG_TTL_MS).toBe(3_600_000);
  });

  it("ON path unchanged: every call answers the 402, none is throttled or logged as would-refuse", async () => {
    process.env.SUBSCRIPTION_ENFORCE = "true";
    for (let i = 0; i < 3; i++) {
      const gate = await enforceOrgAccess(lapsed, "org-a", "storage/upload-url");
      expect(gate?.status).toBe(402);
      expect(gate?.error).toMatch(/^This workspace's subscription was canceled, so adding members and uploading new files are paused/);
    }
    expect(lines()).toHaveLength(0);
  });
});
