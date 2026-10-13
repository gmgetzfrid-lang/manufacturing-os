// admin-and-org Round G — package P7: ALOG-8's purge / archive-cancel sites
// and roles-and-permissions SURF-19's purge / archive-cancel limb.
//
//   * SURF-19: both routes ask lib/adminGate.ts authorizeAdminSurface(req,
//     orgId, "storage", "write") instead of spelling PURGE_ROLES / SHED_ROLES.
//     Who each handler admits is pinned BEFORE (the constant ["Admin",
//     "DocCtrl"] they spelled at base 6503ea7) and AFTER (the real handler,
//     every role and some collections), and a registry change moves it.
//   * ALOG-8: a refused audit insert on a purge or an archive cancel is
//     observable in the answer (auditError) and logged — never a silent
//     success; archive-cancel's unlinks, counts and catalog removal are
//     checked writes. Both rows record the role the surface admitted the
//     actor by (DEC-87 §3).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ALL_ROLES } from "@/types/schema";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  actor: null as null | { userId: string; roles: string[] },
  rows: {} as Record<string, Row[]>,
  /** `${table}.${op}` → the error that op answers (op: select | insert | update | delete). */
  errors: {} as Record<string, { message: string; code?: string }>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

function chain(table: string) {
  let op = "select";
  let head = false;
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const result = () => {
    const err = state.errors[`${table}.${op}`] ?? null;
    if (err) return { data: null, error: err, count: null };
    if (op === "insert" || op === "delete") return { data: null, error: null, count: null };
    if (op === "update") return { data: rows().map((r) => ({ id: r.id })), error: null, count: null };
    return head ? { data: null, error: null, count: rows().length } : { data: rows(), error: null, count: rows().length };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (["insert", "update", "delete"].includes(prop)) op = prop;
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
        if (prop === "is") filters.push((r) => (r[String(args[0])] ?? null) === args[1]);
        if (prop === "not") filters.push((r) => (r[String(args[0])] ?? null) !== null);
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const adminClient = { from: (t: string) => chain(t), rpc: async () => ({ data: [] as Row[], error: null }) };

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async (_req: Request, orgId: string, allowed: string[]) => {
    const a = state.actor;
    if (!a) return { error: "Missing access token", status: 401 };
    if (!a.roles.some((r) => allowed.includes(r))) return { error: "Insufficient role", status: 403 };
    return { userId: a.userId, email: `${a.userId}@x.io`, orgId, role: a.roles[0] ?? "", roles: a.roles, admin: adminClient };
  }),
  callerScopedClient: vi.fn(),
}));
vi.mock("@/lib/ai/usageServer", () => ({ monthStartIso: () => "2026-10-01T00:00:00.000Z" }));

import { adminSurface } from "@/lib/adminSurfaces";
import { writesDeniedMessage } from "@/lib/adminGate";
import * as purgeRoute from "@/app/api/admin/purge/route";
import * as cancelRoute from "@/app/api/admin/archive-cancel/route";

const O1 = "11111111-1111-4111-8111-111111111111";
const get = (path: string) => new NextRequest(`http://x${path}${path.includes("?") ? "&" : "?"}orgId=${O1}`, { headers: { authorization: "Bearer t" } });
const post = (path: string, body: Row) => new NextRequest(`http://x${path}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: O1, ...body }),
});
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as Row);

beforeEach(() => { state.actor = null; state.rows = {}; state.errors = {}; state.calls = []; });

// ── SURF-19 ───────────────────────────────────────────────────────────────
const BEFORE = ["Admin", "DocCtrl"]; // PURGE_ROLES and SHED_ROLES at base 6503ea7
type Route = { name: string; call: () => Promise<Response> };
const ROUTES: Route[] = [
  { name: "purge GET (preview)", call: () => purgeRoute.GET(get("/api/admin/purge?days=90")) },
  { name: "purge POST", call: () => purgeRoute.POST(post("/api/admin/purge", { days: 90, confirm: true })) },
  { name: "archive-cancel POST", call: () => cancelRoute.POST(post("/api/admin/archive-cancel", { archiveId: "MOS-X" })) },
];
const COLLECTIONS: string[][] = [
  ...(ALL_ROLES as string[]).map((r) => [r]),
  ["Viewer", "DocCtrl"], ["Manager", "Drafter"], ["Requester", "Admin"], ["Auditor", "Manager"], ["Ghost"],
];
const GATE_REFUSALS = new Set(["Insufficient role", adminSurface("storage")!.denied, writesDeniedMessage(adminSurface("storage")!)]);
async function admitted(route: Route, roles: string[]): Promise<boolean> {
  state.actor = { userId: "u", roles };
  try {
    const res = await route.call();
    if (res.status !== 403) return true;
    const body = await res.clone().json().catch(() => ({})) as { error?: string };
    return !GATE_REFUSALS.has(body.error ?? "");
  } catch {
    return true;
  }
}

describe("SURF-19 (purge / archive-cancel limb) — the routes ask the gate; who they admit is unchanged", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const route of ROUTES) {
    it(`${route.name}: exactly the roles the constant admitted, by the full collection`, async () => {
      for (const roles of COLLECTIONS) {
        expect(await admitted(route, roles), `${route.name} as ${roles.join("+")}`).toBe(roles.some((r) => BEFORE.includes(r)));
      }
    });
  }
  it("a Manager (who may open Storage) is refused with the writes sentence", async () => {
    state.actor = { userId: "m", roles: ["Manager"] };
    const res = await purgeRoute.POST(post("/api/admin/purge", { days: 90, confirm: true }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Changes on Storage & Backup are limited to Admin and Document Control." });
  });
  it("a registry change moves both routes' answers (the registry is the only place the set is spelled)", async () => {
    const storage = adminSurface("storage")! as { writes?: string[] };
    expect(await admitted(ROUTES[1], ["Manager"])).toBe(false);
    expect(await admitted(ROUTES[2], ["Manager"])).toBe(false);
    const w = storage.writes;
    storage.writes = ["Admin", "DocCtrl", "Manager"];
    try {
      expect(await admitted(ROUTES[1], ["Manager"])).toBe(true);
      expect(await admitted(ROUTES[2], ["Manager"])).toBe(true);
    } finally { storage.writes = w; }
  });
});

// ── ALOG-8: purge ─────────────────────────────────────────────────────────
describe("ALOG-8 — a purge whose DATA_PURGE audit row is refused says so", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  it("regression: a purge that records lands its row (with the admitted role) and answers ok with no auditError", async () => {
    state.actor = { userId: "dc", roles: ["Viewer", "DocCtrl"] };
    const res = await purgeRoute.POST(post("/api/admin/purge", { days: 90, confirm: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.auditError).toBeUndefined();
    expect(audits()).toEqual([expect.objectContaining({ action: "DATA_PURGE", org_id: O1, user_id: "dc", user_role: "DocCtrl" })]);
  });
  it("a refused DATA_PURGE row is observable: the answer carries auditError and the server logs it", async () => {
    state.actor = { userId: "a", roles: ["Admin"] };
    state.errors["audit_logs.insert"] = { message: "insert refused" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await purgeRoute.POST(post("/api/admin/purge", { days: 90, confirm: true }));
    const body = await res.json();
    expect(body.auditError).toMatch(/its DATA_PURGE audit row was not written: insert refused/);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/DATA_PURGE audit row was not written/), "insert refused");
  });
});

// ── ALOG-8: archive-cancel ────────────────────────────────────────────────
describe("ALOG-8 — archive-cancel: checked writes, and a refused audit row is said", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const seed = () => {
    state.rows.tickets = [{ id: "t1", org_id: O1, archive_id: "MOS-X", archived_at: null }];
    state.rows.document_versions = [{ id: "v1", org_id: O1, archive_id: "MOS-X", archived_at: null }, { id: "v2", org_id: O1, archive_id: "MOS-X", archived_at: null }];
    state.rows.archives = [{ org_id: O1, archive_id: "MOS-X" }];
  };
  const cancel = () => cancelRoute.POST(post("/api/admin/archive-cancel", { archiveId: "MOS-X" }));

  it("regression: an abandoned produce is unlinked, its catalog removed, and the row records it (admitted role)", async () => {
    seed();
    state.actor = { userId: "a", roles: ["Admin"] };
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, archiveId: "MOS-X", ticketsUnlinked: 1, versionsUnlinked: 2, catalogRemoved: true });
    expect(audits()).toEqual([expect.objectContaining({
      action: "ARCHIVE_PRODUCE_CANCELED", org_id: O1, user_id: "a", user_role: "Admin",
      details: { archiveId: "MOS-X", ticketsUnlinked: 1, versionsUnlinked: 2, catalogRemoved: true },
    })]);
  });
  it("REPRODUCED at base: the audit insert sat in try/catch with no { error } — now a refused row is in the answer and logged", async () => {
    seed();
    state.actor = { userId: "a", roles: ["Admin"] };
    state.errors["audit_logs.insert"] = { message: "insert refused" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await (await cancel()).json();
    expect(body.ok).toBe(true);
    expect(body.auditError).toMatch(/discarded but its ARCHIVE_PRODUCE_CANCELED audit row was not written: insert refused/);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/ARCHIVE_PRODUCE_CANCELED audit row was not written/), "insert refused");
  });
  it("a refused ticket unlink answers 500 and changes nothing else", async () => {
    seed();
    state.actor = { userId: "a", roles: ["Admin"] };
    state.errors["tickets.update"] = { message: "denied" };
    const res = await cancel();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not be unlinked \(denied\)\. Nothing was changed\./);
    expect(state.calls.some((c) => c.table === "document_versions" && c.method === "update")).toBe(false);
    expect(state.calls.some((c) => c.table === "archives")).toBe(false);
  });
  it("P7 review: tickets unlinked, then the revisions' unlink refused — a partial ARCHIVE_PRODUCE_CANCELED row is written before the 500", async () => {
    seed();
    state.actor = { userId: "a", roles: ["Admin"] };
    state.errors["document_versions.update"] = { message: "transient" };
    const res = await cancel();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ticketsUnlinked: 1 });
    expect(body.error).toMatch(/only partly discarded: 1 ticket\(s\) were unlinked, but its revisions could not be \(transient\)\. Run Discard again\./);
    expect(body.auditError).toBeUndefined();
    expect(audits()).toEqual([expect.objectContaining({
      action: "ARCHIVE_PRODUCE_CANCELED", org_id: O1, user_id: "a", user_role: "Admin",
      details: { archiveId: "MOS-X", ticketsUnlinked: 1, versionsUnlinked: 0, partial: true, error: "transient" },
    })]);
    // the catalog is not touched on the partial path
    expect(state.calls.some((c) => c.table === "archives")).toBe(false);
  });
  it("P7 review: the partial row itself refused — the 500 also says the unlinked tickets were not recorded, and it is logged", async () => {
    seed();
    state.actor = { userId: "a", roles: ["Admin"] };
    state.errors["document_versions.update"] = { message: "transient" };
    state.errors["audit_logs.insert"] = { message: "insert refused" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await cancel();
    expect(res.status).toBe(500);
    expect((await res.json()).auditError).toMatch(/the 1 ticket\(s\) unlinked were not recorded: the ARCHIVE_PRODUCE_CANCELED audit row was not written: insert refused/);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/ARCHIVE_PRODUCE_CANCELED audit row was not written/), "insert refused");
  });
  it("P7 review: nothing unlinked before the revisions' refusal — nothing changed, so no row", async () => {
    seed();
    state.rows.tickets = [];
    state.actor = { userId: "a", roles: ["Admin"] };
    state.errors["document_versions.update"] = { message: "transient" };
    const res = await cancel();
    expect(res.status).toBe(500);
    expect(audits()).toEqual([]);
  });
  it("an unreadable committed count keeps the catalog row (never dropped on a guess) and says why", async () => {
    seed();
    state.actor = { userId: "a", roles: ["Admin"] };
    state.errors["tickets.select"] = { message: "timeout" };
    const body = await (await cancel()).json();
    expect(body.catalogRemoved).toBe(false);
    expect(body.catalogKept).toMatch(/could not be read \(timeout\)/);
    expect(state.calls.some((c) => c.table === "archives" && c.method === "delete")).toBe(false);
  });
  it("a refused catalog removal is said, and recorded in the row", async () => {
    seed();
    state.actor = { userId: "a", roles: ["Admin"] };
    state.errors["archives.delete"] = { message: "nope" };
    const body = await (await cancel()).json();
    expect(body.catalogRemoved).toBe(false);
    expect(body.catalogKept).toMatch(/could not be removed \(nope\)/);
    expect((audits()[0].details as Row).catalogKeptReason).toMatch(/nope/);
  });
});
