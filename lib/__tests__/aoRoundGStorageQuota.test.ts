// admin-and-org Round G, package P6 — storage quota, platform ceiling, and
// roles-and-permissions SURF-19's storage / restore limbs.
//
//   * SURF-19: the storage and restore routes ask lib/adminGate.ts with a
//     surface and an INTENT ("write" holds a mutating route to the surface's
//     writes set). Who each route admits is pinned BEFORE (the constants the
//     routes spelled at base f5073fc) and AFTER (the real handlers, every
//     role and some collections), and a registry change moves the answer.
//   * BILL-5 (DEC-44 (A&O P6)): no org role may write the deployment-wide
//     plan ceiling — only a platform operator; the deployment's figures are
//     the operator's, or the sole workspace's on a single-workspace server.
//   * BILL-7: a ceiling or quota change writes an audit row with old and new.
//   * BILL-12: a workspace's usage is measured under its own key prefix, and
//     the platform watchdog tells only who may see the deployment's figures.
//   * BILL-13: the bucket walk stops on a deadline and says it is partial.
//   * BILL-11: the alert copy says the quota is advisory.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ALL_ROLES } from "@/types/schema";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  actor: null as null | { userId: string; roles: string[] } | { error: string; status: number },
  rows: {} as Record<string, Row[]>,
  /** `${table}.${op}` (op: select | insert | upsert) → the error that op answers */
  errors: {} as Record<string, { message: string; code?: string }>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rpcs: [] as string[],
  objects: [] as Array<{ Key: string; Size: number; LastModified?: Date }>,
  pageSize: 1000,
  hangAfterPages: Number.POSITIVE_INFINITY,
  /** A list request under exactly this prefix never answers (until aborted). */
  hangPrefix: null as string | null,
  pagesServed: 0,
  r2Calls: [] as Array<{ name: string; input: Row; hadSignal: boolean }>,
}));

function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op = "select";
  let head = false;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const result = () => {
    const err = state.errors[`${table}.${op}`] ?? null;
    if (err) return { data: null, error: err, count: null };
    if (op !== "select") return { data: null, error: null, count: null };
    return head ? { data: null, error: null, count: rows().length } : { data: rows(), error: null, count: rows().length };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (["insert", "upsert", "update", "delete"].includes(prop)) op = prop;
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
        if (prop === "in") filters.push((r) => (args[1] as unknown[]).includes(r[String(args[0])]));
        if (prop === "maybeSingle" || prop === "single") {
          const r = result();
          return Promise.resolve({ data: r.error ? null : (rows()[0] ?? null), error: r.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const adminClient = {
  from: (t: string) => chain(t),
  rpc: async (fn: string) => { state.rpcs.push(fn); return { data: [], error: null }; },
};

async function r2Send(cmd: { constructor?: { name?: string }; input?: Row }, opts?: { abortSignal?: AbortSignal }) {
  const name = cmd?.constructor?.name ?? "";
  state.r2Calls.push({ name, input: cmd?.input ?? {}, hadSignal: !!opts?.abortSignal });
  if (name !== "ListObjectsV2Command") return {};
  if (state.pagesServed >= state.hangAfterPages || (state.hangPrefix !== null && cmd.input?.Prefix === state.hangPrefix)) {
    state.pagesServed++;
    return new Promise((_resolve, reject) => {
      opts?.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
    });
  }
  state.pagesServed++;
  const prefix = String(cmd.input?.Prefix ?? "");
  const all = state.objects.filter((o) => o.Key.startsWith(prefix));
  const start = Number(cmd.input?.ContinuationToken ?? 0);
  const next = start + state.pageSize;
  return { Contents: all.slice(start, next), IsTruncated: next < all.length, NextContinuationToken: next < all.length ? String(next) : undefined };
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async (_req: Request, orgId: string, allowed: string[]) => {
    const a = state.actor;
    if (!a) return { error: "Missing access token", status: 401 };
    if ("error" in a) return a;
    if (!a.roles.some((r) => allowed.includes(r))) return { error: "Insufficient role", status: 403 };
    return { userId: a.userId, email: `${a.userId}@x.io`, orgId, role: a.roles[0] ?? "", roles: a.roles, admin: adminClient };
  }),
  callerScopedClient: vi.fn(),
}));
vi.mock("@/lib/r2", () => ({ R2_BUCKET: "test-bucket", r2: { send: (cmd: never, opts: never) => r2Send(cmd, opts) } }));

import { adminSurface } from "@/lib/adminSurfaces";
import { authorizeAdminSurface, adminSurfaceWriteAllows, writesDeniedMessage } from "@/lib/adminGate";
import { measureR2Usage, runPlatformStorageAlerts, PLATFORM_OPERATORS_KEY, platformOperatorSql, storageScopeFor } from "@/lib/storageUsage";
import { runStorageAlerts, quotaWalkOrder, fairShareDeadline } from "@/lib/storageAlerts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as statsRoute from "@/app/api/admin/storage-stats/route";
import * as archiveSettingsRoute from "@/app/api/admin/archive-settings/route";
import * as shedRoute from "@/app/api/admin/shed/route";
import * as shedCommitRoute from "@/app/api/admin/shed/commit/route";
import * as archivesRoute from "@/app/api/admin/archives/route";
import * as orphansRoute from "@/app/api/admin/orphans/route";
import * as ticketShedRoute from "@/app/api/admin/ticket-shed/route";
import * as ticketShedCommitRoute from "@/app/api/admin/ticket-shed/commit/route";
import * as ticketShedRestoreRoute from "@/app/api/admin/ticket-shed/restore/route";
import * as restoreBeginRoute from "@/app/api/admin/restore/begin/route";
import * as restoreApplyTableRoute from "@/app/api/admin/restore/apply-table/route";
import * as restorePreviewRoute from "@/app/api/admin/restore/preview/route";

const O1 = "11111111-1111-4111-8111-111111111111";
const O2 = "22222222-2222-4222-8222-222222222222";
const OP = "99999999-9999-4999-8999-999999999999";

const get = (path: string) => new NextRequest(`http://x${path}${path.includes("?") ? "&" : "?"}orgId=${O1}`, { headers: { authorization: "Bearer t" } });
const postJson = (path: string, body: Row, method = "POST") => new NextRequest(`http://x${path}?orgId=${O1}&confirm=true`, {
  method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: O1, ...body }),
});

beforeEach(() => {
  state.actor = null; state.rows = {}; state.errors = {}; state.calls = []; state.rpcs = [];
  state.objects = []; state.pageSize = 1000; state.hangAfterPages = Number.POSITIVE_INFINITY; state.hangPrefix = null; state.pagesServed = 0; state.r2Calls = [];
});

// ── SURF-19: the gate's write intent ────────────────────────────────────────
describe("SURF-19 — lib/adminGate.ts holds a mutating route to the surface's writes set", () => {
  const storage = adminSurface("storage")!;
  const restore = adminSurface("restore")!;
  const gate = (surface: string, intent?: "enter" | "write") => authorizeAdminSurface(get("/api/x"), O1, surface, intent);

  it("enter (the default) is the entry rule, as before: Manager may open storage", async () => {
    state.actor = { userId: "m", roles: ["Manager"] };
    expect("error" in (await gate("storage"))).toBe(false);
  });
  it("write: Admin and DocCtrl pass (admittedRole = the writes role held); Manager is refused with the writes message; Drafter with the entry message", async () => {
    state.actor = { userId: "a", roles: ["Admin"] };
    expect(await gate("storage", "write")).toMatchObject({ userId: "a", admittedRole: "Admin" });
    state.actor = { userId: "d", roles: ["Viewer", "DocCtrl"] }; // by the collection
    expect(await gate("storage", "write")).toMatchObject({ admittedRole: "DocCtrl" });
    state.actor = { userId: "m", roles: ["Manager"] };
    expect(await gate("storage", "write")).toEqual({ error: "Changes on Storage & Backup are limited to Admin and Document Control.", status: 403 });
    state.actor = { userId: "r", roles: ["Drafter"] };
    expect(await gate("storage", "write")).toEqual({ error: storage.denied, status: 403 });
  });
  it("a surface with no writes set is held to its entry alone (restore: Admin)", async () => {
    expect(restore.writes).toBeUndefined();
    state.actor = { userId: "a", roles: ["Admin"] };
    expect(await gate("restore", "write")).toMatchObject({ admittedRole: "Admin" });
    state.actor = { userId: "d", roles: ["DocCtrl"] };
    expect(await gate("restore", "write")).toEqual({ error: restore.denied, status: 403 });
  });
  it("the pure pieces", () => {
    expect(adminSurfaceWriteAllows(storage, ["DocCtrl"])).toBe(true);
    expect(adminSurfaceWriteAllows(storage, ["Manager", " "])).toBe(false);
    expect(adminSurfaceWriteAllows(storage, [])).toBe(false);
    expect(adminSurfaceWriteAllows(restore, [])).toBe(true); // no writes set: the entry rule decides
    expect(writesDeniedMessage({ label: "Teams", writes: ["Admin", "DocCtrl", "Manager"] })).toBe("Changes on Teams are limited to Admin, Document Control and Manager.");
  });
});

// ── SURF-19: every converted route admits exactly the set it admitted before ─
// BEFORE: the constants these handlers spelled at base f5073fc (SURF-19's
// census; lib/__tests__/roundE_D_rolesAdmin.test.ts pinned them equal to the
// registry). AFTER: the real handler, called as each role and collection.
const CONTROLLERS = ["Admin", "DocCtrl"];
type Route = { name: string; before: string[]; call: () => Promise<Response> };
const ROUTES: Route[] = [
  { name: "storage-stats GET", before: ["Admin", "Manager", "DocCtrl"], call: () => statsRoute.GET(get("/api/admin/storage-stats")) },
  { name: "storage-stats POST", before: CONTROLLERS, call: () => statsRoute.POST(postJson("/api/admin/storage-stats", { r2LimitBytes: 1, dbLimitBytes: 1 })) },
  { name: "archive-settings GET", before: CONTROLLERS, call: () => archiveSettingsRoute.GET(get("/api/admin/archive-settings")) },
  { name: "archive-settings PUT", before: CONTROLLERS, call: () => archiveSettingsRoute.PUT(postJson("/api/admin/archive-settings", { naming: "n" }, "PUT")) },
  { name: "shed GET", before: CONTROLLERS, call: () => shedRoute.GET(get("/api/admin/shed?keep=5")) },
  { name: "shed POST", before: CONTROLLERS, call: () => shedRoute.POST(postJson("/api/admin/shed", { keep: 5 })) },
  { name: "shed/commit POST", before: CONTROLLERS, call: () => shedCommitRoute.POST(postJson("/api/admin/shed/commit", { archiveId: "MOS-X" })) },
  { name: "archives GET", before: CONTROLLERS, call: () => archivesRoute.GET(get("/api/admin/archives")) },
  { name: "orphans GET", before: CONTROLLERS, call: () => orphansRoute.GET(get("/api/admin/orphans")) },
  { name: "orphans POST", before: CONTROLLERS, call: () => orphansRoute.POST(postJson("/api/admin/orphans", {})) },
  { name: "ticket-shed GET", before: CONTROLLERS, call: () => ticketShedRoute.GET(get("/api/admin/ticket-shed?days=90")) },
  { name: "ticket-shed POST", before: CONTROLLERS, call: () => ticketShedRoute.POST(postJson("/api/admin/ticket-shed", { days: 90 })) },
  { name: "ticket-shed/commit POST", before: CONTROLLERS, call: () => ticketShedCommitRoute.POST(postJson("/api/admin/ticket-shed/commit", { archiveId: "MOS-X" })) },
  { name: "ticket-shed/restore POST", before: CONTROLLERS, call: () => ticketShedRestoreRoute.POST(postJson("/api/admin/ticket-shed/restore", {})) },
  { name: "restore/begin POST", before: ["Admin"], call: () => restoreBeginRoute.POST(postJson("/api/admin/restore/begin", {})) },
  { name: "restore/apply-table POST", before: ["Admin"], call: () => restoreApplyTableRoute.POST(postJson("/api/admin/restore/apply-table", {})) },
  { name: "restore/preview POST", before: ["Admin"], call: () => restorePreviewRoute.POST(postJson("/api/admin/restore/preview", {})) },
];
const GATE_REFUSALS = new Set([
  "Insufficient role", adminSurface("storage")!.denied, writesDeniedMessage(adminSurface("storage")!), adminSurface("restore")!.denied,
]);
async function admitted(route: Route, roles: string[]): Promise<boolean> {
  state.actor = { userId: OP, roles };
  try {
    const res = await route.call();
    if (res.status !== 403) return true;
    const body = await res.clone().json().catch(() => ({})) as { error?: string };
    return !GATE_REFUSALS.has(body.error ?? "");
  } catch {
    return true; // past the gate: a downstream step on the bare mock threw
  }
}
const COLLECTIONS: string[][] = [
  ...(ALL_ROLES as string[]).map((r) => [r]),
  ["Viewer", "DocCtrl"], ["Manager", "Drafter"], ["Requester", "Admin"], ["Auditor", "Manager"], ["Ghost"],
];

describe("SURF-19 — every converted route answers exactly the roles it answered before (BEFORE = base constants, AFTER = the real handler)", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const route of ROUTES) {
    it(route.name, async () => {
      for (const roles of COLLECTIONS) {
        const expected = roles.some((r) => route.before.includes(r));
        expect(await admitted(route, roles), `${route.name} as ${roles.join("+")}`).toBe(expected);
      }
    });
  }

  it("a registry change moves the route's answer (the registry is the only place the set is spelled)", async () => {
    const storage = adminSurface("storage")! as { writes?: string[] };
    const restore = adminSurface("restore")! as { entry: string[] | "*" };
    const shedGet = ROUTES.find((r) => r.name === "shed GET")!;
    const begin = ROUTES.find((r) => r.name === "restore/begin POST")!;
    expect(await admitted(shedGet, ["Manager"])).toBe(false);
    expect(await admitted(begin, ["DocCtrl"])).toBe(false);
    const [w, e] = [storage.writes, restore.entry];
    storage.writes = ["Admin", "DocCtrl", "Manager"];
    restore.entry = ["Admin", "DocCtrl"];
    try {
      expect(await admitted(shedGet, ["Manager"])).toBe(true);
      expect(await admitted(begin, ["DocCtrl"])).toBe(true);
    } finally {
      storage.writes = w;
      restore.entry = e;
    }
    expect(await admitted(shedGet, ["Manager"])).toBe(false);
  });
});

// ── BILL-5 / BILL-7: the plan ceiling is a platform operator's ──────────────
describe("BILL-5 — no org role writes the deployment-wide ceiling; a platform operator does, audited (BILL-7)", () => {
  const ceilingPost = (body: Row = { r2LimitBytes: 5 * 1024 ** 3, dbLimitBytes: 600 * 1024 ** 2 }) =>
    statsRoute.POST(postJson("/api/admin/storage-stats", body));
  const upserts = () => state.calls.filter((c) => c.table === "platform_settings" && c.method === "upsert");

  it("REPRODUCED: a DocCtrl of one of two workspaces (allowed before) is refused 403 — the global row is never written", async () => {
    state.rows.orgs = [{ id: O1 }, { id: O2 }];
    state.actor = { userId: "dc-b", roles: ["DocCtrl"] };
    const res = await ceilingPost();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ operatorRequired: true });
    expect(upserts()).toEqual([]);
  });
  it("an Admin of the ONLY workspace is refused too (the ceiling is a platform operator's, whatever the org count — DEC-44 (A&O P6))", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.actor = { userId: "adm", roles: ["Admin"] };
    expect((await ceilingPost()).status).toBe(403);
    expect(upserts()).toEqual([]);
  });
  it("a Manager never reaches the operator rule: the writes set refuses first", async () => {
    state.actor = { userId: "m", roles: ["Manager"] };
    expect((await ceilingPost()).status).toBe(403);
    expect(state.calls.some((c) => c.table === "platform_settings")).toBe(false);
  });
  it("an operator (who holds the storage writes set) saves it: the upsert, then an audit row with the old and new values", async () => {
    state.rows.platform_settings = [
      { key: PLATFORM_OPERATORS_KEY, value: { uids: [OP] } },
      { key: "storage_limits", value: { r2Bytes: 10, dbBytes: 20 } },
    ];
    state.actor = { userId: OP, roles: ["Viewer", "Admin"] };
    const res = await ceilingPost({ r2LimitBytes: 30, dbLimitBytes: 40 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(upserts()[0].args[0]).toMatchObject({ key: "storage_limits", value: { r2Bytes: 30, dbBytes: 40 }, updated_by: OP });
    const audit = state.calls.find((c) => c.table === "audit_logs" && c.method === "insert")!.args[0];
    expect(audit).toEqual({
      action: "PLATFORM_STORAGE_LIMITS_CHANGED", resource_id: "storage_limits", resource_type: "platform_settings", org_id: O1,
      user_id: OP, user_email: `${OP}@x.io`, user_role: "Admin",
      details: { scope: "deployment", before: { r2Bytes: 10, dbBytes: 20, source: "settings" }, after: { r2Bytes: 30, dbBytes: 40 } },
    });
  });
  it("an unreadable operator list is a 503 — nothing saved (fail closed)", async () => {
    state.errors["platform_settings.select"] = { message: "boom" };
    state.actor = { userId: OP, roles: ["Admin"] };
    expect((await ceilingPost()).status).toBe(503);
    expect(upserts()).toEqual([]);
  });
  it("a refused audit row is said on the answer (the change itself landed)", async () => {
    state.rows.platform_settings = [{ key: PLATFORM_OPERATORS_KEY, value: { uids: [OP] } }];
    state.errors["audit_logs.insert"] = { message: "rls" };
    state.actor = { userId: OP, roles: ["DocCtrl"] };
    const res = await ceilingPost({ r2LimitBytes: 30, dbLimitBytes: 40 });
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toMatch(/audit record of the change was refused \(rls\)/);
  });
  it("the registration SQL the page shows is idempotent and names only a well-formed uid", () => {
    const sql = platformOperatorSql(OP);
    expect(sql).toMatch(/^INSERT INTO platform_settings \(key, value\) VALUES \('platform_operators', '\{"uids": \[\]\}'::jsonb\) ON CONFLICT \(key\) DO NOTHING; /);
    expect(sql).toContain(`jsonb_build_array('${OP}'::text)`);
    expect(sql).toContain(`NOT (COALESCE(value->'uids', '[]'::jsonb) ? '${OP}')`);
    expect(platformOperatorSql("x'; DROP TABLE orgs; --")).not.toContain("DROP");
  });
});

describe("BILL-5 Done-when 2 / BILL-12 — what the stats GET returns depends on who may see the deployment", () => {
  beforeEach(() => {
    state.objects = [
      { Key: `orgs/${O1}/libraries/l/a.pdf`, Size: 100 },
      { Key: `orgs/${O1}/knowledge/k/b.pdf`, Size: 50 },
      { Key: `orgs/${O2}/libraries/l/secret.pdf`, Size: 10_000 },
      { Key: "diagnostics/probe.bin", Size: 7 },
    ];
  });
  const stats = async () => (await statsRoute.GET(get("/api/admin/storage-stats"))).json();

  it("REPRODUCED: on a shared server a Manager (non-operator) gets only this workspace — no tables, no bucket total, no ceilings", async () => {
    state.rows.orgs = [{ id: O1 }, { id: O2 }];
    state.actor = { userId: "m", roles: ["Manager"] };
    const body = await stats();
    expect(body.scope).toBe("workspace");
    expect(body.platformOperator).toBe(false);
    expect([body.db, body.r2Real, body.r2Estimate, body.freeTier, body.dedup]).toEqual([null, null, null, null, null]);
    expect(body.workspace.files).toMatchObject({ bytes: 150, objects: 2, truncated: false });
    // the walk was scoped to the workspace's own prefix, and no deployment aggregate ran
    expect(state.r2Calls.every((c) => c.input.Prefix === `orgs/${O1}/`)).toBe(true);
    expect(state.rpcs).toEqual([]);
    // the AI count is this workspace's
    expect(state.calls.filter((c) => c.table === "ai_usage_events" && c.method === "eq" && c.args[0] === "org_id" && c.args[1] === O1)).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("10000");
  });
  it("the sole workspace on its server sees the deployment's figures (its own), labelled, with its workspace total from the same walk", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.actor = { userId: "m", roles: ["Manager"] };
    const body = await stats();
    expect(body.scope).toBe("deployment");
    expect(body.db).not.toBeNull();
    expect(body.r2Real.bytes).toBe(10_157);
    expect(body.r2Real.org).toBeUndefined(); // the per-org total never rides on the deployment figure
    expect(body.workspace.files).toMatchObject({ bytes: 150, objects: 2 });
    expect(state.r2Calls.filter((c) => c.name === "ListObjectsV2Command")).toHaveLength(1); // one pass
    expect(state.rpcs).toContain("mfg_table_stats");
  });
  it("on a shared server, a platform operator sees the deployment", async () => {
    state.rows.orgs = [{ id: O1 }, { id: O2 }];
    state.rows.platform_settings = [{ key: PLATFORM_OPERATORS_KEY, value: { uids: [OP] } }];
    state.actor = { userId: OP, roles: ["DocCtrl"] };
    const body = await stats();
    expect(body).toMatchObject({ scope: "deployment", platformOperator: true, operatorSql: null });
  });
  it("storageScopeFor fails closed: an unreadable operator list or orgs table is the workspace scope", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.errors["orgs.select"] = { message: "boom" };
    state.errors["platform_settings.select"] = { message: "boom" };
    expect(await storageScopeFor(adminClient as never, O1, OP)).toMatchObject({ scope: "workspace", operator: false, soleTenant: false });
  });
});

// ── BILL-7: the quota change is audited ─────────────────────────────────────
describe("BILL-7 — archive-settings PUT records old and new values", () => {
  const put = (body: Row) => archiveSettingsRoute.PUT(postJson("/api/admin/archive-settings", body, "PUT"));
  const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as Row);
  beforeEach(() => {
    state.rows.archive_settings = [{ org_id: O1, location_hint: "\\\\srv\\mos", naming: null, quota_bytes: 100 }];
    state.actor = { userId: "dc", roles: ["DocCtrl"] };
  });

  it("REPRODUCED: raising the quota writes STORAGE_QUOTA_CHANGED naming the actor, before and after", async () => {
    const res = await put({ quotaBytes: 200 });
    expect(res.status).toBe(200);
    expect(audits()).toEqual([{
      action: "STORAGE_QUOTA_CHANGED", resource_id: O1, resource_type: "archive_settings", org_id: O1,
      user_id: "dc", user_email: "dc@x.io", user_role: "DocCtrl",
      details: { changes: { quota_bytes: { before: 100, after: 200 } } },
    }]);
  });
  it("clearing the quota is a change too; the location alone is ARCHIVE_SETTINGS_CHANGED; an unchanged save writes no row", async () => {
    await put({ quotaBytes: null });
    expect(audits()[0]).toMatchObject({ action: "STORAGE_QUOTA_CHANGED", details: { changes: { quota_bytes: { before: 100, after: null } } } });
    state.calls = [];
    await put({ locationHint: "/Volumes/B" });
    expect(audits()[0]).toMatchObject({ action: "ARCHIVE_SETTINGS_CHANGED", details: { changes: { location_hint: { before: "\\\\srv\\mos", after: "/Volumes/B" } } } });
    state.calls = [];
    await put({ quotaBytes: 100 });
    expect(audits()).toEqual([]);
  });
  it("a refused audit row is said (warning); an unreadable prior row refuses the change (500, no upsert)", async () => {
    state.errors["audit_logs.insert"] = { message: "rls" };
    expect(await (await put({ quotaBytes: 300 })).json()).toMatchObject({ ok: true, warning: expect.stringMatching(/refused \(rls\)/) });
    delete state.errors["audit_logs.insert"];
    state.calls = [];
    state.errors["archive_settings.select"] = { message: "boom" };
    expect((await put({ quotaBytes: 300 })).status).toBe(500);
    expect(state.calls.some((c) => c.table === "archive_settings" && c.method === "upsert")).toBe(false);
  });
});

// ── BILL-13: the walk has a deadline ────────────────────────────────────────
describe("BILL-13 — measureR2Usage stops in time and says it is partial, never throws for time", () => {
  beforeEach(() => {
    state.objects = Array.from({ length: 5 }, (_, i) => ({ Key: `orgs/${O1}/libraries/l/${i}.pdf`, Size: 10 }));
    state.pageSize = 2;
  });
  it("a finished walk: not truncated, stoppedBy null", async () => {
    expect(await measureR2Usage({ deadlineMs: Date.now() + 5_000 })).toMatchObject({ bytes: 50, objects: 5, truncated: false, stoppedBy: null });
  });
  it("a deadline already past: no request, truncated by deadline", async () => {
    expect(await measureR2Usage({ deadlineMs: Date.now() - 1 })).toMatchObject({ bytes: 0, objects: 0, truncated: true, stoppedBy: "deadline" });
    expect(state.r2Calls).toEqual([]);
  });
  it("a request that outlives the deadline is aborted: what was measured comes back, truncated by deadline", async () => {
    state.hangAfterPages = 1;
    const r = await measureR2Usage({ deadlineMs: Date.now() + 40 });
    expect(r).toMatchObject({ bytes: 20, objects: 2, truncated: true, stoppedBy: "deadline" });
    expect(state.r2Calls.every((c) => c.hadSignal)).toBe(true);
  });
  it("the page cap still truncates (stoppedBy pages), and the original numeric signature still works", async () => {
    expect(await measureR2Usage(2)).toMatchObject({ objects: 4, truncated: true, stoppedBy: "pages" });
  });
  it("a prefix walk and an org total during a whole walk", async () => {
    state.objects.push({ Key: `orgs/${O2}/x/y.pdf`, Size: 1000 });
    expect(await measureR2Usage({ prefix: `orgs/${O2}/` })).toMatchObject({ bytes: 1000, objects: 1 });
    expect((await measureR2Usage({ orgTotalFor: O1 })).org).toMatchObject({ bytes: 50, objects: 5 });
  });
  it("storage-stats declares a maxDuration covering its walk budget", () => {
    expect(statsRoute.maxDuration).toBe(60);
  });
});

// ── BILL-12 / BILL-11: the two alerting paths ───────────────────────────────
describe("BILL-12 — each workspace is measured under its own prefix; BILL-11 — the copy says the quota is advisory", () => {
  const inserts = () => state.calls.filter((c) => c.table === "notifications" && c.method === "insert").map((c) => c.args[0] as Row);

  it("REPRODUCED: another tenant's 8 GB upload no longer pushes this workspace into critical", async () => {
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 1000 }];
    state.rows.org_members = [{ org_id: O1, uid: "a1", status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/libraries/l/a.pdf`, Size: 200 }, { Key: `orgs/${O2}/scan.e57`, Size: 8_000_000 }];
    const r = await runStorageAlerts(adminClient as never);
    expect(r).toEqual({ alerts: 0, orgsChecked: 1, unmeasured: 0 }); // 20%: fine
    expect(state.r2Calls.map((c) => c.input.Prefix)).toEqual([`orgs/${O1}/`]);
    expect(inserts()).toEqual([]);
  });
  it("its own files over the limit alert its admins, saying the limit is advisory and what was measured", async () => {
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 1000 }];
    state.rows.org_members = [{ org_id: O1, uid: "a1", status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/libraries/l/a.pdf`, Size: 950 }];
    expect((await runStorageAlerts(adminClient as never)).alerts).toBe(1);
    const row = inserts()[0];
    expect(row).toMatchObject({ org_id: O1, user_id: "a1", kind: "storage_alert", title: "Storage critical — 95% full" });
    expect(String(row.body)).toMatch(/files are at 95% of the storage limit an admin set .*measured under this workspace only\)\. The limit is advisory: uploads are not blocked when it is reached\./);
  });
  it("a workspace not measured within the budget is counted, never reported fine or alerted", async () => {
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 1000 }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 999 }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runStorageAlerts(adminClient as never, { budgetMs: 0 })).toEqual({ alerts: 0, orgsChecked: 0, unmeasured: 1 });
    // fix pass: the count reaches the log, not only the return value
    expect(warn.mock.calls.some((c) => String(c[0]).includes("[storage-alerts] 1 of 1 workspace(s) with a storage limit were not measured in time"))).toBe(true);
    warn.mockRestore();
  });

  it("fix pass, REPRODUCED: one workspace whose walk never answers no longer leaves every other workspace unmeasured", async () => {
    const O3 = "33333333-3333-4333-8333-333333333333";
    // The stuck workspace is FIRST in the order the database returns, as at
    // base, where it used the whole shared budget and every later walk
    // started past the deadline.
    state.rows.archive_settings = [{ org_id: O2, quota_bytes: 1000 }, { org_id: O1, quota_bytes: 1000 }, { org_id: O3, quota_bytes: 1000 }];
    state.rows.org_members = [{ org_id: O1, uid: "a1", status: "active" }, { org_id: O3, uid: "a3", status: "active" }];
    state.hangPrefix = `orgs/${O2}/`;
    state.objects = [{ Key: `orgs/${O1}/a.pdf`, Size: 950 }, { Key: `orgs/${O3}/b.pdf`, Size: 100 }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runStorageAlerts(adminClient as never, { budgetMs: 300 });
    warn.mockRestore();
    // whatever today's rotation, the stuck walk gets only its share
    expect(r).toEqual({ alerts: 1, orgsChecked: 2, unmeasured: 1 });
    expect(inserts().map((x) => [x.org_id, x.user_id, x.title])).toEqual([[O1, "a1", "Storage critical — 95% full"]]);
    expect(new Set(state.r2Calls.map((c) => c.input.Prefix))).toEqual(new Set([`orgs/${O1}/`, `orgs/${O2}/`, `orgs/${O3}/`]));
  });

  it("the walk order is by org id, rotated one place a day; each walk's deadline is an equal share of the time left", () => {
    const rows = [{ org_id: "c" }, { org_id: "a" }, { org_id: "b" }];
    expect(quotaWalkOrder(rows, 0).map((r) => r.org_id)).toEqual(["a", "b", "c"]);
    expect(quotaWalkOrder(rows, 1).map((r) => r.org_id)).toEqual(["b", "c", "a"]);
    expect(quotaWalkOrder(rows, 2).map((r) => r.org_id)).toEqual(["c", "a", "b"]);
    expect(quotaWalkOrder(rows, 3).map((r) => r.org_id)).toEqual(["a", "b", "c"]);
    expect(quotaWalkOrder([], 5)).toEqual([]);
    // every workspace is first once in n days
    expect(new Set([0, 1, 2].map((d) => quotaWalkOrder(rows, d)[0].org_id))).toEqual(new Set(["a", "b", "c"]));
    expect(fairShareDeadline(1000, 46_000, 3)).toBe(16_000);
    expect(fairShareDeadline(1000, 46_000, 1)).toBe(46_000);
    expect(fairShareDeadline(50_000, 46_000, 3)).toBe(46_000); // past the shared deadline: no extension
  });

  it("the maintenance cron adds the unmeasured count to its errors (where an operator reads it)", () => {
    const cron = readFileSync(join(process.cwd(), "app/api/cron/maintenance/route.ts"), "utf8");
    expect(cron).toContain("const { alerts, unmeasured } = await runStorageAlerts(sb);");
    expect(cron).toContain("if (unmeasured > 0) result.errors.push(`storage-alerts: ${unmeasured} workspace(s) with a storage limit were not measured in time; none was reported fine`);");
  });

  it("the platform watchdog on a SHARED server tells the platform operators only — in the workspaces they belong to", async () => {
    state.rows.orgs = [{ id: O1 }, { id: O2 }];
    state.rows.platform_settings = [{ key: PLATFORM_OPERATORS_KEY, value: { uids: [OP] } }];
    state.rows.org_members = [
      { org_id: O1, uid: OP, status: "active" }, { org_id: O1, uid: "tenant-admin", status: "active" }, { org_id: O2, uid: "other-admin", status: "active" },
    ];
    state.objects = [{ Key: `orgs/${O2}/big`, Size: Math.round(9.6 * 1024 ** 3) }];
    const { alerts, route } = await runPlatformStorageAlerts(adminClient as never);
    expect(route).toBe("operators");
    expect(alerts).toBe(1);
    expect(inserts().map((r) => [r.org_id, r.user_id, r.kind])).toEqual([[O1, OP, "storage_platform_r2"]]);
    const body = String(inserts()[0].body);
    expect(body).not.toMatch(/before uploads start failing/);
    expect(body).toMatch(/the whole deployment\)\. This app does not stop uploads at the ceiling/);
  });
  it("a shared server with no operator tells nobody (route none, said in the log) — never every tenant's admins", async () => {
    state.rows.orgs = [{ id: O1 }, { id: O2 }];
    state.rows.org_members = [{ org_id: O1, uid: "tenant-admin", status: "active" }];
    state.objects = [{ Key: `orgs/${O2}/big`, Size: Math.round(9.6 * 1024 ** 3) }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { alerts, route } = await runPlatformStorageAlerts(adminClient as never);
    expect([alerts, route]).toEqual([0, "none"]);
    expect(inserts()).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no platform operator"))).toBe(true);
    warn.mockRestore();
  });
  it("the cron's platform walk carries a deadline (BILL-13)", async () => {
    state.rows.orgs = [{ id: O1 }];
    await runPlatformStorageAlerts(adminClient as never);
    expect(state.r2Calls.filter((c) => c.name === "ListObjectsV2Command").every((c) => c.hadSignal)).toBe(true);
  });
});

describe("SURF-19 fix pass — the registry says what the gate does with `writes`", () => {
  it("lib/adminSurfaces.ts no longer calls `writes` documentation the gate does not enforce", () => {
    const src = readFileSync(join(process.cwd(), "lib/adminSurfaces.ts"), "utf8");
    expect(src).not.toMatch(/`writes` is documentation/);
    expect(src).not.toMatch(/NOT by the entry gate/);
    expect(src).toMatch(/it is ENFORCED server-side: lib\/adminGate\.ts authorizeAdminSurface\(…,\n\/\/ "write"\)/);
  });
});
