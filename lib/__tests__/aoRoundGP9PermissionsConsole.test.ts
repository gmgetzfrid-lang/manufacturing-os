// admin-and-org Round G — package P9 (permissions console truth and access
// recertification). The non-rendered pins:
//
//   ALOG-2 / RET-4   20261188: access_recertification_events ends with a
//                    member SELECT, an INSERT bound to performed_by =
//                    auth.uid() for the library's owner or a controller (also
//                    RESTRICTIVE), and RESTRICTIVE no-UPDATE / no-DELETE —
//                    proved by replaying schema.sql and every numbered
//                    migration at test time; the file has the DEC-30 shape.
//
//   AUTHZ-7 / ALOG-1 the cached loader on a failed read serves the LAST GOOD
//                    entry (stale) or, with none, says `unreadable` (DEC-89
//                    item 3, ratified DEC-90 A26); a healthy org's answers do
//                    not change; lib/holds.ts assertHoldCapability fails
//                    closed.
//   ALOG-12          the route refuses a save whose version is not the stored
//                    row's (409 policy_changed) — nothing written, no audit.
//   WF-10            no server-side authority decision reads the cached
//                    loader (census); the strict loader is never cached.
//   ORG-14           qualitySignOffEligible mirrors quality_signer_eligible.
//   ALOG-9 / ALOG-14 / QUAL-14  the token vocabulary is declared once; the
//                    explorer derives its capability and admin rows; the
//                    editor's split/join carries project-scoped rules.
//
// The rendered pins (the console components, jsdom) live in
// aoRoundGP9ConsoleRendered.test.ts and aoRoundGP9RecertModalRendered.test.ts;
// the recertification writes in accessRecert.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// ── a PostgREST stand-in (projection, filters, update/insert, injected errors) ──
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** table -> error returned by every read of it */
  readError: {} as Record<string, { message: string; code?: string } | undefined>,
  /** throw from the next org_configurations read */
  throwRead: false,
  calls: [] as Array<{ table: string; kind: string }>,
  rpcError: null as null | { message: string; code?: string },
  /** the browser client's getUser error (an auth-server blip) */
  authError: null as null | { message: string },
}));
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let cols: string[] | null = null;
  let op: { kind: "update"; patch: Row } | { kind: "insert"; row: Row } | null = null;
  let returning = false;
  const rows = () => (db.tables[name] ??= []);
  const project = (r: Row): Row => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r });
  const run = () => {
    db.calls.push({ table: name, kind: op?.kind ?? "select" });
    if (op?.kind === "insert") { rows().push({ ...op.row }); return { data: null, error: null }; }
    if (!op && db.readError[name]) return { data: null, error: db.readError[name] };
    if (!op && name === "org_configurations" && db.throwRead) { db.throwRead = false; throw new Error("socket hang up"); }
    const hit = rows().filter((r) => filters.every((f) => f(r)));
    if (op?.kind === "update") {
      for (const r of hit) Object.assign(r, op.patch);
      return { data: returning ? hit.map(project) : null, error: null };
    }
    return { data: hit.map(project), error: null };
  };
  const q = {
    select(c?: string) {
      if (op) returning = true;
      cols = c && c.trim() !== "*" ? c.split(",").map((x) => x.trim()) : null;
      return q;
    },
    eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
    is(k: string, v: unknown) { filters.push((r) => (r[k] ?? null) === v); return q; },
    in(k: string, vs: unknown[]) { filters.push((r) => vs.includes(r[k])); return q; },
    order() { return q; },
    update(patch: Row) { op = { kind: "update", patch }; return q; },
    insert(row: Row) { op = { kind: "insert", row }; return q; },
    maybeSingle() {
      try {
        const out = run();
        return Promise.resolve({ data: (out.data as Row[] | null)?.[0] ?? null, error: out.error });
      } catch (e) { return Promise.reject(e); }
    },
    single() { return q.maybeSingle(); },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve().then(run).then(resolve, reject);
    },
  };
  return q;
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => (db.user ? { data: { user: db.user }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (t: string) => table(t),
    rpc: async () => ({ data: false, error: db.rpcError }),
  },
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => table(t),
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: db.authError ? null : db.user }, error: db.authError }),
    },
  },
}));
vi.mock("@/lib/audit", () => ({ logHoldEvent: vi.fn(async () => undefined), logAuditAction: vi.fn(async () => undefined) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));

import {
  CAPABILITY_DEFS, loadCapabilityPolicyEntry, loadCapabilityPolicy, loadCapabilityPolicyStrict, __resetCapabilityPolicyCache,
  policyAllows, parseStoredCapabilityPolicy, qualitySignOffEligible, samePolicyVersion, POLICY_CHANGED, SERVER_CACHE_TTL_MS,
  type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import { POST as policyRoute } from "@/app/api/admin/capability-policy/route";
import { openHold, releaseHold, updateHoldExpectedRelease } from "@/lib/holds";
import { POLICY_TOKENS, DORMANT_ROLES } from "@/lib/roleCapabilities";
import { POLICY_TOKENS as EDITOR_TOKENS, tokensOutsideGrid, splitPolicyForEditor, joinPolicyFromEditor } from "@/components/permissions/CapabilityPolicyEditor";
import { EXPLORER_COLUMNS, SURFACE_ROWS, SNAPSHOT_ROWS, explorerRows, capabilityRow, COMPOSED, composedAllows, STANDING } from "@/components/permissions/PermissionsExplorer";
import { WorkflowEngine } from "@/lib/workflow";
import type { Ticket, Role } from "@/types/schema";
import { adminSurface } from "@/lib/adminSurfaces";
import { MANAGEMENT_ROLES } from "@/lib/managementRoles";
import { ALL_ROLES } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
// ═══════════════════════════════════════════════════════════════════════════
// AUTHZ-7 done-when 3 / ALOG-1 done-when 2 — DEC-89 item 3 (DEC-90 A26)
// ═══════════════════════════════════════════════════════════════════════════
const stored = (caps: CapabilityPolicy["caps"], updated_at = "2026-10-01T00:00:00+00:00", grants: unknown[] = []) =>
  ({ org_id: "o1", key: "capability_policy", data: { caps, grants }, updated_at });

describe("AUTHZ-7 / ALOG-1 — the cached loader on a failed read: last good entry, else `unreadable`", () => {
  beforeEach(() => {
    __resetCapabilityPolicyCache();
    db.tables = {}; db.readError = {}; db.throwRead = false; db.calls = []; db.user = null; db.rpcError = null;
  });
  afterEach(() => vi.useRealTimers());

  it("a healthy read answers exactly as before — no marker; 'nothing stored' is a good read (the defaults ARE the org's policy)", async () => {
    db.tables.org_configurations = [stored({ "holds.open": ["Admin"] })];
    const e = await loadCapabilityPolicyEntry("o1", { from: table } as never);
    expect(e).toEqual({ policy: parseStoredCapabilityPolicy({ caps: { "holds.open": ["Admin"] } }), version: "2026-10-01T00:00:00+00:00" });
    __resetCapabilityPolicyCache();
    db.tables.org_configurations = [];
    expect(await loadCapabilityPolicyEntry("o2", { from: table } as never)).toEqual({ policy: { caps: {}, grants: [] }, version: null });
  });

  it("no last good entry: the answer is marked `unreadable` with the error, its policy is {} (the shipped defaults), and nothing is cached", async () => {
    db.readError.org_configurations = { message: "upstream timeout" };
    const e = await loadCapabilityPolicyEntry("o1", { from: table } as never);
    expect(e).toEqual({ policy: {}, version: null, unreadable: "upstream timeout" });
    db.readError = {};
    db.tables.org_configurations = [stored({ "holds.open": ["Admin"] })];
    expect((await loadCapabilityPolicyEntry("o1", { from: table } as never)).unreadable).toBeUndefined();
  });

  it("a thrown read is the same: `unreadable`, never a silent default", async () => {
    db.throwRead = true;
    expect(await loadCapabilityPolicyEntry("o1", { from: table } as never)).toEqual({ policy: {}, version: null, unreadable: "socket hang up" });
  });

  it("a failed REFRESH serves the last good entry (stale), keeps its old stamp so the next call reads again, and a good read replaces it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    db.tables.org_configurations = [stored({ "holds.open": ["Admin"] })];
    await loadCapabilityPolicyEntry("o1", { from: table } as never);
    vi.setSystemTime(new Date(Date.now() + SERVER_CACHE_TTL_MS + 1));
    db.readError.org_configurations = { message: "connection reset" };
    const stale = await loadCapabilityPolicyEntry("o1", { from: table } as never);
    expect(stale.stale).toBe(true);
    expect(stale.staleError).toBe("connection reset");
    expect(stale.unreadable).toBeUndefined();
    expect(stale.policy.caps?.["holds.open"]).toEqual(["Admin"]); // NOT the shipped "*"
    // the stale serve did not refresh the stamp: the next call reads again
    const before = db.calls.length;
    await loadCapabilityPolicyEntry("o1", { from: table } as never);
    expect(db.calls.length).toBe(before + 1);
    db.readError = {};
    db.tables.org_configurations = [stored({ "holds.open": ["Admin", "DocCtrl"] }, "2026-10-07T09:00:00+00:00")];
    const fresh = await loadCapabilityPolicyEntry("o1", { from: table } as never);
    expect(fresh.stale).toBeUndefined();
    expect(fresh.policy.caps?.["holds.open"]).toEqual(["Admin", "DocCtrl"]);
  });

  it("loadCapabilityPolicy (non-authoritative readers) keeps its documented contract: the last good copy, else the shipped defaults", async () => {
    db.readError.org_configurations = { message: "boom" };
    expect(await loadCapabilityPolicy("o9", { from: table } as never)).toEqual({});
    const cp = src("lib/capabilityPolicy.ts");
    expect(cp).toContain("The policy alone — for NON-AUTHORITATIVE readers only");
  });

  it("the strict loader is unchanged and never cached (every server authority decision reads it fresh)", async () => {
    db.tables.org_configurations = [stored({ "holds.open": ["Admin"] })];
    const a = await loadCapabilityPolicyStrict("o1", { from: table } as never);
    expect(a.ok).toBe(true);
    db.tables.org_configurations = [stored({ "holds.open": ["DocCtrl"] }, "2026-10-02T00:00:00+00:00")];
    const b = await loadCapabilityPolicyStrict("o1", { from: table } as never);
    expect(b.ok && b.policy.caps?.["holds.open"]).toEqual(["DocCtrl"]);
    db.readError.org_configurations = { message: "down" };
    expect(await loadCapabilityPolicyStrict("o1", { from: table } as never)).toEqual({ ok: false, error: "down" });
  });
});

describe("AUTHZ-7 — lib/holds.ts assertHoldCapability fails CLOSED (DEC-89 item 3)", () => {
  const base = { orgId: "o1", documentId: "d1", reason: "Client Review", openedBy: "u1" };
  beforeEach(() => {
    __resetCapabilityPolicyCache();
    db.tables = { org_members: [{ org_id: "o1", uid: "u1", role: "Viewer", roles: ["Viewer"], status: "active" }] };
    db.readError = {}; db.throwRead = false; db.calls = []; db.user = { id: "u1" }; db.authError = null;
    // the insert is the first write after the check: stop the flow there
    db.readError.document_holds = undefined;
  });
  const reachedInsert = () => db.calls.some((c) => c.table === "document_holds" && c.kind === "insert");

  it("regression: a healthy read with the shipped default (everyone) lets a Viewer through to the insert, as before", async () => {
    db.tables.org_configurations = [];
    await openHold(base).catch(() => undefined);
    expect(reachedInsert()).toBe(true);
  });
  it("regression: a narrowed policy refuses with the same Action-permissions sentence", async () => {
    db.tables.org_configurations = [stored({ "holds.open": ["Admin"] })];
    await expect(openHold(base)).rejects.toThrow(/Your role isn't allowed to place holds\. An Admin can change this under Admin → Permissions → Action permissions\./);
    expect(reachedInsert()).toBe(false);
  });
  it("an unreadable policy with no last good copy REFUSES (it used to fail open on the defaults) and writes nothing", async () => {
    db.readError.org_configurations = { message: "upstream timeout" };
    await expect(openHold(base)).rejects.toThrow(/^The hold was not placed: your permission to place holds could not be checked \(the workspace's permission policy could not be read: upstream timeout\)\. Try again in a moment\.$/);
    expect(reachedInsert()).toBe(false);
  });
  it("a failed refresh is decided on the LAST GOOD copy — a narrowing is not undone by a database blip", async () => {
    // lib/holds.ts runs in the browser, where the loader keeps a copy (a
    // server process with no client never caches — WF-10 done-when 3).
    const g = globalThis as { window?: unknown };
    g.window = {};
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
      db.tables.org_configurations = [stored({ "holds.open": ["Admin"] })];
      await loadCapabilityPolicyEntry("o1"); // the browser's copy
      vi.setSystemTime(new Date(Date.now() + 61_000));
      db.readError.org_configurations = { message: "blip" };
      await expect(openHold(base)).rejects.toThrow(/Your role isn't allowed to place holds/);
      expect(reachedInsert()).toBe(false);
      // and a last good copy that ADMITS still admits during the blip
      __resetCapabilityPolicyCache();
      db.readError = {};
      db.tables.org_configurations = [stored({ "holds.open": ["*"] })];
      await loadCapabilityPolicyEntry("o1");
      vi.setSystemTime(new Date(Date.now() + 61_000));
      db.readError.org_configurations = { message: "blip" };
      await openHold(base).catch(() => undefined);
      expect(reachedInsert()).toBe(true);
    } finally { vi.useRealTimers(); delete g.window; }
  });
  it("an unreadable membership refuses too; a missing one holds no role (DEC-91 — no placeholder Viewer)", async () => {
    db.tables.org_configurations = [];
    db.readError.org_members = { message: "permission denied" };
    await expect(openHold(base)).rejects.toThrow(/The hold was not placed: .*your membership could not be read: permission denied/);
    db.readError = {};
    db.tables.org_members = [];
    await expect(openHold(base)).rejects.toThrow(/Your role isn't allowed to place holds/);
    expect(reachedInsert()).toBe(false);
  });
  // ── review fix: the two paths that still skipped the client gate ──
  const inBrowser = async (fn: () => Promise<void>) => {
    const g = globalThis as { window?: unknown };
    g.window = {};
    try { await fn(); } finally { delete g.window; }
  };
  const openRow = () => ({ id: "h1", org_id: "o1", document_id: "d1", reason: "Client Review", opened_by: "u0", opened_at: "2026-10-01T00:00:00Z", released_at: null, expected_release_at: null });
  const reachedUpdate = () => db.calls.some((c) => c.table === "document_holds" && c.kind === "update");
  it("in the browser, a session that cannot be read REFUSES (it used to return before the check); nothing is written", async () => {
    db.tables.org_configurations = [];
    await inBrowser(async () => {
      db.authError = { message: "auth server unavailable" };
      await expect(openHold(base)).rejects.toThrow(/^The hold was not placed: your permission to place holds could not be checked \(your session could not be read: auth server unavailable\)\. Try again in a moment\.$/);
      db.authError = null; db.user = null;
      await expect(openHold(base)).rejects.toThrow(/^The hold was not placed: .*\(no signed-in session was found\)/);
    });
    expect(reachedInsert()).toBe(false);
  });
  it("regression: with no window (a server / cron caller, no person) the gate is left to the database, as before", async () => {
    db.tables.org_configurations = [stored({ "holds.open": ["Admin"] })];
    db.user = null;
    await openHold(base).catch(() => undefined);
    expect(reachedInsert()).toBe(true);
  });
  it("release: a hold row that cannot be read refuses before any write (the gate needs its org); a missing row says what the update would", async () => {
    db.tables.org_configurations = [];
    db.tables.document_holds = [openRow()];
    db.readError.document_holds = { message: "statement timeout" };
    await expect(releaseHold({ holdId: "h1", releasedBy: "u1", releasedReason: "cleared" }))
      .rejects.toThrow(/^The hold was not released: the hold could not be read to check your permission \(statement timeout\)\. Try again in a moment\.$/);
    expect(reachedUpdate()).toBe(false);
    db.readError = {};
    db.tables.document_holds = [];
    await expect(releaseHold({ holdId: "h1", releasedBy: "u1", releasedReason: "cleared" })).rejects.toThrow(/^Hold already released or not found\.$/);
    expect(reachedUpdate()).toBe(false);
  });
  it("re-date: the same checked read, and a check that did not run says the DATE was not changed — not 'not released'", async () => {
    db.tables.document_holds = [openRow()];
    db.readError.document_holds = { message: "statement timeout" };
    await expect(updateHoldExpectedRelease("h1", null))
      .rejects.toThrow(/^The hold's expected date was not changed: the hold could not be read to check your permission \(statement timeout\)/);
    db.readError = {};
    db.readError.org_configurations = { message: "upstream timeout" };
    await expect(updateHoldExpectedRelease("h1", null))
      .rejects.toThrow(/^The hold's expected date was not changed: your permission to re-date holds \(the release permission\) could not be checked \(the workspace's permission policy could not be read: upstream timeout\)\. Try again in a moment\.$/);
    expect(reachedUpdate()).toBe(false);
    // release keeps its own sentence on the same fault
    await expect(releaseHold({ holdId: "h1", releasedBy: "u1", releasedReason: "cleared" }))
      .rejects.toThrow(/^The hold was not released: your permission to release holds could not be checked/);
    expect(reachedUpdate()).toBe(false);
    // and a healthy read re-dates as before
    db.readError = {};
    db.tables.org_configurations = [];
    await updateHoldExpectedRelease("h1", null).catch(() => undefined);
    expect(reachedUpdate()).toBe(true);
  });
  it("source: the fail-open swallow is gone", () => {
    const h = src("lib/holds.ts");
    expect(h).not.toMatch(/fail open — matches historical behavior/);
    expect(h).not.toMatch(/\?\? "Viewer";\s*\n\s*const extra = \(member\?\.roles/);
    expect(h).toContain("throw unchecked(msg || \"the check failed\");");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ALOG-12 done-when 1 — the route refuses a save from a stale grid
// ═══════════════════════════════════════════════════════════════════════════
describe("ALOG-12 — a save carries its loaded version; a stale one is refused 409 policy_changed", () => {
  const post = (body: Record<string, unknown>) => policyRoute(new NextRequest("http://localhost/api/admin/capability-policy", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const V = "2026-10-01T00:00:00+00:00";
  beforeEach(() => {
    __resetCapabilityPolicyCache();
    db.user = { id: "a1", email: "a@x" }; db.readError = {}; db.throwRead = false; db.calls = []; db.rpcError = null;
    db.tables = {
      org_members: [{ org_id: "o1", uid: "a1", role: "Admin", roles: ["Admin"], email: "a@x", status: "active" }],
      org_configurations: [stored({ "ticket.assign": ["Admin"] }, V)],
    };
  });
  const audits = () => (db.tables.audit_logs ?? []).filter((r) => r.action === "CAPABILITY_POLICY_CHANGED");

  it("the version it loaded → saved (200) and audited", async () => {
    const res = await post({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin", "DocCtrl"] }, version: V });
    expect(res.status).toBe(200);
    expect(audits()).toHaveLength(1);
  });
  it("the same instant spelled the other way (ISO Z) is the same version", async () => {
    expect(samePolicyVersion("2026-10-01T00:00:00.000Z", V)).toBe(true);
    expect((await post({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] }, version: "2026-10-01T00:00:00.000Z" })).status).toBe(200);
  });
  it("a stale version (another admin saved since) → 409 policy_changed, nothing written, no audit row", async () => {
    const res = await post({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Viewer", "Admin"] }, version: "2026-09-30T00:00:00+00:00" });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe(POLICY_CHANGED);
    expect(j.error).toMatch(/changed by someone else since you opened them/);
    expect((db.tables.org_configurations[0].data as CapabilityPolicy).caps?.["ticket.assign"]).toEqual(["Admin"]);
    expect(audits()).toHaveLength(0);
    expect(db.calls.some((c) => c.table === "org_configurations" && c.kind === "update")).toBe(false);
  });
  it("version null (the grid loaded when nothing was stored) while a row now exists → 409", async () => {
    const res = await post({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] }, version: null });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(POLICY_CHANGED);
  });
  it("version null with nothing stored → the first INSERT goes through", async () => {
    db.tables.org_configurations = [];
    expect((await post({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] }, version: null })).status).toBe(200);
    expect(db.tables.org_configurations).toHaveLength(1);
  });
  it("a body without the key (a bundle from before this change, mid-deploy) keeps today's behaviour", async () => {
    expect((await post({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] } })).status).toBe(200);
  });
  it("a malformed version is a 400, never a silent overwrite", async () => {
    expect((await post({ op: "save", orgId: "o1", caps: {}, version: 7 })).status).toBe(400);
  });
  it("grants are not version-checked (they never republish the grid) and the CAS 409 now carries the code too", async () => {
    db.tables.org_members.push({ org_id: "o1", uid: "v1", role: "Drafter", roles: ["Drafter"], status: "active" });
    expect((await post({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.assign" })).status).toBe(200);
    const r = src("app/api/admin/capability-policy/route.ts");
    expect(r).toContain('return changed("The policy changed while you were editing — reload and try again");');
    expect(r).toContain("const CONTROLLER_ROLES = ALL_ROLES.filter((r) => isControllerRole(r));");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WF-10 done-when 1 — no server-side authority decision reads a cached policy
// ═══════════════════════════════════════════════════════════════════════════
const walk = (dir: string): string[] => readdirSync(join(process.cwd(), dir)).flatMap((f) => {
  if (f === "__tests__" || f === "node_modules") return [];
  const rel = `${dir}/${f}`;
  return statSync(join(process.cwd(), rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
});

describe("WF-10 — a revocation binds on the very next server-side decision", () => {
  const CACHED = /\bloadCapabilityPolicy(?:Entry)?\s*\(/;
  it("no route under app/api reads the cached loader", () => {
    const offenders = walk("app/api").filter((f) => CACHED.test(src(f)));
    expect(offenders).toEqual([]);
  });
  it("every server-side authority decision reads the strict (fresh, never cached) loader", () => {
    for (const f of ["app/api/tickets/workflow-action/route.ts", "lib/adminGate.ts", "lib/transmittals.ts", "app/api/ai/usage/route.ts"]) {
      expect(src(f), f).toMatch(/loadCapabilityPolicyStrict\(/);
      expect(src(f), f).not.toMatch(CACHED);
    }
  });
  it("the cached loader's other callers are browser code or lib/holds.ts (client gate + hold audience)", () => {
    const callers = [...walk("app"), ...walk("lib"), ...walk("components"), ...walk("hooks")]
      .filter((f) => f !== "lib/capabilityPolicy.ts" && CACHED.test(src(f)));
    for (const f of callers) {
      const client = /^\s*["']use client["']/.test(src(f)) || f.startsWith("hooks/");
      expect(client || f === "lib/holds.ts", f).toBe(true);
    }
  });
  it("fix pass 2: in lib/holds.ts (browser AND server — scanStaleHolds runs in the maintenance cron) each cached-loader call sits in one of the three named functions, none of them a server authority decision", () => {
    const h = src("lib/holds.ts");
    const fnAt = (i: number) => [...h.slice(0, i).matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].pop()?.[1];
    const sites = [...h.matchAll(new RegExp(CACHED.source, "g"))].map((m) => fnAt(m.index!));
    expect(sites.length).toBeGreaterThan(0);
    // assertHoldCapability: the browser client gate (fails closed);
    // notifyHoldChange / scanStaleHolds: the notification AUDIENCE only.
    for (const fn of sites) expect(["assertHoldCapability", "notifyHoldChange", "scanStaleHolds"], String(fn)).toContain(fn);
    expect(new Set(sites)).toEqual(new Set(["assertHoldCapability", "notifyHoldChange", "scanStaleHolds"]));
    // scanStaleHolds is the server caller (the maintenance cron) — audience only, no authority.
    expect(src("app/api/cron/maintenance/route.ts")).toMatch(/scanStaleHolds/);
  });
  it("the module says so", () => {
    expect(src("lib/capabilityPolicy.ts")).toContain("WF-10 (admin-and-org Round G, P9): no server-side AUTHORITY decision reads");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ORG-14 — the simulator's quality sign-off is quality_signer_eligible's rule
// ═══════════════════════════════════════════════════════════════════════════
describe("ORG-14 — qualitySignOffEligible against quality_signer_eligible (20261136)", () => {
  const scoped: CapabilityPolicy = { caps: { "quality.sign_off": [{ tokens: [] }, { tokens: ["Safety"], when: { projectId: ["p1"] } }] }, grants: [] };
  const p1 = { id: "p1", ownerUserId: "own", visibility: "public" };
  const p2 = { id: "p2", ownerUserId: "own2", visibility: "public" };
  it("a controller (by the collection), the owner, a project-scoped grantee and an ungranted member", () => {
    expect(qualitySignOffEligible({ policy: scoped, uid: "adm", roles: ["Manager", "DocCtrl"], project: p1 })).toEqual({ eligible: true, via: "controller" });
    expect(qualitySignOffEligible({ policy: scoped, uid: "own", roles: ["Drafter"], project: p1 })).toEqual({ eligible: true, via: "owner" });
    expect(qualitySignOffEligible({ policy: scoped, uid: "saf", roles: ["Requester", "Safety"], project: p1 })).toEqual({ eligible: true, via: "capability" });
    expect(qualitySignOffEligible({ policy: scoped, uid: "saf", roles: ["Requester", "Safety"], project: p2 })).toEqual({ eligible: false, via: null });
    expect(qualitySignOffEligible({ policy: scoped, uid: "eng", roles: ["Engineer-2"], project: p1 })).toEqual({ eligible: false, via: null });
  });
  it("a grantee who cannot see a private project is not eligible there; a project member is", () => {
    const priv = { id: "p1", ownerUserId: "own", visibility: "private", memberIds: ["saf2"] };
    expect(qualitySignOffEligible({ policy: scoped, uid: "saf", roles: ["Safety"], project: priv }).eligible).toBe(false);
    expect(qualitySignOffEligible({ policy: scoped, uid: "saf2", roles: ["Safety"], project: priv }).eligible).toBe(true);
  });
  it("a personal grant (org-wide, WF-13 row 6) counts on every project they can see", () => {
    const granted: CapabilityPolicy = { caps: {}, grants: [{ cap: "quality.sign_off", uid: "rev", expiresAt: null }] };
    expect(qualitySignOffEligible({ policy: granted, uid: "rev", roles: ["Viewer"], project: p2 }).via).toBe("capability");
  });
  it("the SQL it mirrors has the same three disjuncts and the same visibility rule", () => {
    const m = src("supabase/migrations/20261136_prj_roundG_quality_signoff.sql");
    const eligible = m.slice(m.indexOf("CREATE OR REPLACE FUNCTION quality_signer_eligible"), m.indexOf("COMMENT ON FUNCTION quality_signer_eligible"));
    expect(eligible).toContain("is_org_controller_for(p_org, p_uid)");
    expect(eligible).toContain("p.owner_user_id::text = p_uid::text");
    expect(eligible).toContain("quality_signoff_granted_for(p_org, p_project, p_uid)");
    const granted = m.slice(m.indexOf("CREATE OR REPLACE FUNCTION quality_signoff_granted_for"), m.indexOf("COMMENT ON FUNCTION quality_signoff_granted_for"));
    expect(granted).toContain("p.visibility IS DISTINCT FROM 'private'");
    expect(granted).toContain("pm.user_id::text = p_uid::text");
    expect(granted).toContain("org_capability_allows_for(p_org, 'quality.sign_off', p_uid, jsonb_build_object('projectId', p_project::text))");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ALOG-9 residual — one declaration of the role vocabulary; nothing hidden
// ═══════════════════════════════════════════════════════════════════════════
describe("ALOG-9 — the console's role literals resolve to one declaration, and an out-of-grid token is named", () => {
  it("POLICY_TOKENS is declared once, in lib/roleCapabilities.ts; the editor re-exports the same list", () => {
    expect(EDITOR_TOKENS).toBe(POLICY_TOKENS);
    const decls = [...walk("app"), ...walk("lib"), ...walk("components"), ...walk("hooks")]
      .filter((f) => /\bconst POLICY_TOKENS\b/.test(src(f)));
    expect(decls).toEqual(["lib/roleCapabilities.ts"]);
    for (const r of DORMANT_ROLES) expect(POLICY_TOKENS).toContain(r);
  });
  it("MGMT derives from MANAGEMENT_ROLES; the page's ADMIN_ROLES is the registry's permissions.writes (pinned equal by SURF-9); the route derives the tier", () => {
    expect(src("lib/capabilityPolicy.ts")).toContain("const MGMT = [...MANAGEMENT_ROLES];");
    expect(MANAGEMENT_ROLES).toEqual(["Admin", "Manager", "Supervisor"]);
    // The admin pages spell their own action set and roundE_D_rolesAdmin's
    // SURF-9 test holds each one equal to ADMIN_SURFACES — the declaration.
    const page = src("app/(protected)/admin/permissions/page.tsx");
    const m = /const ADMIN_ROLES = new Set\((\[[^\]]*\])\);/.exec(page)!;
    expect(new Set(JSON.parse(m[1]) as string[])).toEqual(new Set(adminSurface("permissions")!.writes));
    expect(src("app/api/admin/capability-policy/route.ts")).toContain("const CONTROLLER_ROLES = ALL_ROLES.filter((r) => isControllerRole(r));");
  });
  it("a stored token with no grid column is reported (it stays live in the evaluator)", () => {
    expect(tokensOutsideGrid(["Admin", "Engineer-2", "*", "Typo"])).toEqual(["Engineer-2", "Typo"]);
    expect(policyAllows({ caps: { "ticket.assign": ["Engineer-2"] } }, "ticket.assign", "Engineer-2")).toBe(true);
    expect(src("components/permissions/CapabilityPolicyEditor.tsx")).toContain("Also stored, no column here:");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ALOG-14 — the explorer's rows come from the code and the stored policy
// ═══════════════════════════════════════════════════════════════════════════
describe("ALOG-14 — the permissions explorer tells the truth", () => {
  const rows = explorerRows({});
  const row = (cap: string) => rows.find((r) => r.cap === cap)!;
  const col = (label: string) => EXPLORER_COLUMNS.findIndex((c) => c.label === label);
  it("the columns are the role model, every role exactly once", () => {
    const all = EXPLORER_COLUMNS.flatMap((c) => [...c.roles]);
    expect(new Set(all)).toEqual(new Set(ALL_ROLES));
    expect(all.length).toBe(ALL_ROLES.length);
  });
  it("done-when 1: every registered capability is a row computed from CAPABILITY_DEFS + the stored policy", () => {
    for (const d of CAPABILITY_DEFS) expect(rows.some((r) => r.key === `cap:${d.id}` && r.source === "policy"), d.id).toBe(true);
    // a stored narrowing moves the row (it could not, as a literal)
    const narrowed = capabilityRow(CAPABILITY_DEFS.find((d) => d.id === "holds.open")!, { caps: { "holds.open": ["Admin"] } });
    expect(narrowed.cells[col("Viewer")].v).toBe("-");
    expect(narrowed.cells[col("Admin")].v).toBe("y");
    expect(row("Place a hold").cells[col("Viewer")].v).toBe("y"); // shipped default: everyone
  });
  it("done-when 2, row by row: each mismatch is now the server's answer", () => {
    // (1) Audit log → admin.audit_view, the policy the database reads (20261063); /activity said apart
    expect(row("Audit log").source).toBe("policy");
    expect(row("Audit log").cells.map((c) => c.v).join("")).toBe("yyyy------y-");
    expect(SNAPSHOT_ROWS.some((r) => r.cap === "Document-level activity history (/activity)" && r.m === "yyyyyyyyyyyy")).toBe(true);
    // (2) "Release stale checkouts (/admin/holds)" is gone: the page releases HOLDS (holds.release); another's checkout is checkout.force_release
    expect(rows.some((r) => /Release stale checkouts/.test(r.cap))).toBe(false);
    expect(row("Force-release a checkout").cells[col("DocCtrl")].v).toBe("y");
    expect(row("Force-release a checkout").cells[col("Manager")].v).toBe("-");
    // (3) Operational scope and (4) Equipment / asset admin: DocCtrl can — from the registry the pages are pinned to
    expect(row("Operational scope (edit)").cells[col("DocCtrl")].v).toBe("y");
    expect(row("Equipment / asset admin pages (edit)").cells[col("DocCtrl")].v).toBe("y");
    // (5) user management split: adding a member is Admin + DocCtrl; changing roles is the users surface's writes
    expect(SNAPSHOT_ROWS.find((r) => r.cap === "Add a member (invite)")!.m).toBe("yy----------");
    expect(row("Change member roles, suspend or restore members").cells.map((c) => c.v).join("")).toBe("y-y---------");
    // (6) recertification: the owner (◐) plus the controllers, and nobody else — as 20261188 admits
    expect(SNAPSHOT_ROWS.find((r) => r.cap === "Access recertification reviews")!.m).toBe("yycccccccccc");
  });
  // ── review fix: the rows the rewrite itself got wrong, pinned to the SQL ──
  const newestDefining = (re: RegExp) => readdirSync(join(process.cwd(), "supabase/migrations"))
    .filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort()
    .filter((f) => re.test(src(`supabase/migrations/${f}`))).pop()!;
  const cells = (cap: string) => row(cap).cells.map((c) => c.v).join("");
  it("library ownership is the 20261077 §2 guard: controllers, the current owner, or a Manage Permissions grant — not Admin only", () => {
    // The newest definition of the guard is the one the row describes.
    expect(newestDefining(/CREATE OR REPLACE FUNCTION enforce_library_sensitive_columns\(\)/)).toBe("20261077_dc_roundF_records_rails.sql");
    const guard = src("supabase/migrations/20261077_dc_roundF_records_rails.sql");
    expect(guard).toMatch(/IF \(NEW\.owner_user_id\s+IS DISTINCT FROM OLD\.owner_user_id[\s\S]*?OR NEW\.owner_team_id IS DISTINCT FROM OLD\.owner_team_id/);
    expect(guard).toMatch(/IF NOT is_org_controller\(OLD\.org_id\)\s+AND OLD\.owner_user_id::text IS DISTINCT FROM auth\.uid\(\)::text\s+AND NOT can_manage_node\(OLD\.acl_index, OLD\.org_id\) THEN\s+RAISE EXCEPTION 'Not permitted to change this library''s ownership/);
    // libraries' one policy is org membership (schema.sql) — the guard decides.
    expect(src("supabase/schema.sql")).toMatch(/CREATE POLICY "libraries_org_access" ON libraries FOR ALL\s+USING \(org_id IN \(SELECT my_org_ids\(\)\)\);/);
    expect(cells("Reassign library ownership / owning team")).toBe("yycccccccccc");
    expect(row("Reassign library ownership / owning team").cells[col("Viewer")].why).toMatch(/current owner, or with a Manage Permissions grant/);
    // The old row that said only an Admin could reassign library ownership is gone.
    expect(rows.some((r) => /supervisor or library ownership/.test(r.cap))).toBe(false);
  });
  it("a department's supervisor is the teams guard AND the teams write policy (20261046): Admin, or DocCtrl held with Manager", () => {
    expect(newestDefining(/FUNCTION teams_guard_supervisor_change\(\)/)).toBe("20261046_rp_phase6_sweep_authority_by_collection.sql");
    expect(newestDefining(/POLICY teams_admin_write ON teams/)).toBe("20261046_rp_phase6_sweep_authority_by_collection.sql");
    const m = src("supabase/migrations/20261046_rp_phase6_sweep_authority_by_collection.sql");
    expect(m).toMatch(/IF NEW\.supervisor_user_id IS DISTINCT FROM OLD\.supervisor_user_id\s+AND NOT is_org_controller\(OLD\.org_id\) THEN/);
    expect(m).toMatch(/CREATE POLICY teams_admin_write ON teams FOR ALL\s+USING \(caller_holds_any_role\(org_id, ARRAY\['Admin','Manager'\]::text\[\]\)\)/);
    expect(cells("Change a department's supervisor")).toBe("y-----------");
    expect(row("Change a department's supervisor").cells[col("Admin")].why).toMatch(/Document Control held together with Manager/);
  });
  it("creating teams and their membership is Admin or Manager — the registry's entry, and the same two the teams write policy admits", () => {
    const t = row("Create teams & manage team membership");
    expect(t.source).toBe("surface");
    expect(new Set(adminSurface("teams")!.entry as string[])).toEqual(new Set(["Admin", "Manager"]));
    expect(cells("Create teams & manage team membership")).toBe("y-y---------");
    const m = src("supabase/migrations/20261046_rp_phase6_sweep_authority_by_collection.sql");
    expect(m).toMatch(/CREATE POLICY team_members_admin_write ON team_members FOR ALL\s+USING \(caller_holds_any_role\(org_id, ARRAY\['Admin','Manager'\]::text\[\]\)\)/);
    expect(t.note).toMatch(/20261046/);
    expect(rows.some((r) => r.cap === "Teams & team members")).toBe(false);
  });
  it("removing a member is Admin only (revoke_member 'remove', newest body 20261161); suspend / restore stays Admin + Manager with the Admin-row rule said", () => {
    const newest = newestDefining(/CREATE OR REPLACE FUNCTION (public\.)?revoke_member\(/);
    expect(newest).toBe("20261161_notif_roundG_read_scope.sql");
    const fn = src(`supabase/migrations/${newest}`);
    expect(fn).toMatch(/IF p_mode = 'remove' THEN\s+IF NOT EXISTS \(SELECT 1 FROM org_members me WHERE me\.uid = v_actor AND me\.org_id = v_member\.org_id\s+AND me\.status = 'active' AND \(me\.role = 'Admin' OR me\.roles && ARRAY\['Admin'\]::text\[\]\)\) THEN\s+RAISE EXCEPTION 'Only an Admin can remove a member from the workspace\.';/);
    expect(fn).toMatch(/IF NOT is_org_admin_or_manager\(v_member\.org_id\) THEN\s+RAISE EXCEPTION 'Only an Admin or Manager can suspend or restore a member\.';/);
    expect(fn).toContain("RAISE EXCEPTION 'Only an Admin can suspend or restore an Admin.';");
    expect(src("supabase/migrations/20261042_rp_phase6_revocation_and_succession.sql"))
      .toMatch(/CREATE POLICY org_members_delete ON org_members\s+FOR DELETE[\s\S]*?AND \(me\.role = 'Admin' OR me\.roles && ARRAY\['Admin'\]::text\[\]\)/);
    expect(cells("Remove a member from the workspace")).toBe("y-----------");
    expect(SNAPSHOT_ROWS.find((r) => r.cap === "Remove a member from the workspace")).toBeDefined();
    const users = row("Change member roles, suspend or restore members");
    expect(users.source).toBe("surface");
    expect(new Set(adminSurface("users")!.writes)).toEqual(new Set(["Admin", "Manager"]));
    expect(users.note).toMatch(/Only an Admin can grant the Admin role or suspend \/ restore an Admin; removing a member is Admin-only/);
    // the Admin-row half is the org_members UPDATE policy's (20260817): only an Admin writes a row that holds Admin
    expect(src("supabase/migrations/20260817_org_members_escalation_and_config.sql"))
      .toMatch(/CREATE POLICY org_members_update ON org_members\s+FOR UPDATE\s+USING \(is_org_admin_or_manager\(org_id\)\)\s+WITH CHECK \(\s+is_org_admin_or_manager\(org_id\)\s+AND \(\s+NOT \(role = 'Admin' OR roles && ARRAY\['Admin'\]::text\[\]\)\s+OR is_org_admin\(org_id\)/);
    expect(newestDefining(/POLICY org_members_update ON org_members/)).toBe("20260817_org_members_escalation_and_config.sql");
    expect(rows.some((r) => /suspend or remove members/.test(r.cap))).toBe(false);
  });
  // ── fix pass 2 (blocker): composed authority — the engine admits other
  // capabilities' holders at a row's stage; the row must say so ──
  it("the four ticket rows the engine composes with ticket.manage show management as able (the old literal matrix had it right)", () => {
    expect(cells("Direct engineering approval")).toBe("y-yy-y------");
    expect(cells("Engineering scope review")).toBe("ycyycycccccc");
    expect(cells("Final engineering approval")).toBe("ycyycycccccc");
    expect(cells("Requester review")).toBe("ycyycycycccc");
    expect(row("Direct engineering approval").cells[col("Manager")].why).toBe("Via Management override (ticket.manage)");
    expect(row("Requester review").cells[col("Engineer 1-4")].why).toMatch(/co-review on the requester's behalf, via Direct engineering approval/i);
    // identity-only stays identity-only where no composed authority reaches
    expect(row("Final engineering approval").cells[col("DocCtrl")]).toEqual({ v: "c", why: STANDING["ticket.final_approve"]!.anyone });
    // reopen: a Requester-review holder reopens a ticket with no requester (◐, said)
    expect(row("Reopen closed tickets").cells[col("Requester")].why).toMatch(/On a ticket with no requester: via Requester review/);
  });
  // The parity pin: for each composed row, the stage it describes is built
  // as a synthetic ticket and the engine (lib/workflow.ts getActions — what
  // the workflow route enforces) is asked, per role, whether that role is
  // offered the stage's action. The cell must agree, column by column, for
  // the shipped defaults AND for a narrowed policy.
  const tk = (over: Partial<Ticket>): Ticket => ({
    id: "t1", orgId: "o1", status: "PENDING_REVIEW", requesterId: "req", requesterRole: "Requester", requestType: "New Drawing", unit: "U1",
    assignedDrafterId: "dr", assignedEngineerId: null, attachments: [], ...over,
  } as unknown as Ticket);
  // Every live ticket row is pinned (the rows with no composition too), so a
  // future composition in the engine fails here until the matrix says it.
  const STAGES: Array<{ cap: string; label: string; ticket: Ticket; action: string; conditionalOnly?: boolean }> = [
    { cap: "ticket.manage", label: "Management override", ticket: tk({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }), action: "cancel_request" },
    { cap: "ticket.assign", label: "Assign drafters", ticket: tk({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }), action: "assign" },
    { cap: "ticket.self_assign", label: "Self-assign drafting work", ticket: tk({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }), action: "self_assign" },
    { cap: "ticket.draft_work", label: "Do drafting work", ticket: tk({ status: "DRAFTING", assignedDrafterId: null }), action: "save_progress" },
    { cap: "ticket.force_close", label: "Force close", ticket: tk({ status: "DRAFTING" }), action: "close_ticket" },
    { cap: "ticket.reassign_engineer", label: "Reassign engineer reviewer", ticket: tk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "eng" }), action: "reassign_engineer" },
    { cap: "ticket.eng_review", label: "Engineering scope review", ticket: tk({ status: "PENDING_ENG_TEAM", assignedEngineerId: null }), action: "approve_team" },
    { cap: "ticket.direct_approve", label: "Direct engineering approval", ticket: tk({ status: "PENDING_REVIEW" }), action: "approve_draft_ifc" },
    { cap: "ticket.direct_approve", label: "Direct engineering approval", ticket: tk({ status: "FINAL_DRAFT" }), action: "reject_final" },
    { cap: "ticket.final_approve", label: "Final engineering approval", ticket: tk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: null }), action: "engineer_approve_final" },
    { cap: "ticket.requester_review", label: "Requester review", ticket: tk({ status: "PENDING_REVIEW", requesterId: undefined }), action: "request_revision" },
    { cap: "ticket.requester_review", label: "Requester review", ticket: tk({ status: "FINAL_DRAFT", requesterId: undefined }), action: "reject_final" },
    { cap: "ticket.reopen", label: "Reopen closed tickets", ticket: tk({ status: "CLOSED" }), action: "reopen_ticket" },
    { cap: "ticket.reopen", label: "Reopen closed tickets", ticket: tk({ status: "CLOSED", requesterId: undefined }), action: "reopen_ticket", conditionalOnly: true },
  ];
  const NARROWED: CapabilityPolicy = { caps: {
    "ticket.manage": ["Admin"],
    "ticket.direct_approve": ["DocCtrl", "Engineer-2"],
    "ticket.eng_review": ["Drafter"],
    "ticket.final_approve": [],
    "ticket.requester_review": ["Viewer", "Supervisor"],
    "ticket.reopen": ["Auditor"],
  } };
  for (const [name, policy] of [["the shipped defaults", {}], ["a narrowed policy", NARROWED]] as Array<[string, CapabilityPolicy]>) {
    it(`parity with the engine, per role column — ${name}`, () => {
      // every composition the matrix claims is exercised against the engine here
      for (const cap of Object.keys(COMPOSED)) expect(STAGES.some((x) => x.cap === cap), cap).toBe(true);
      const rs = explorerRows(policy);
      for (const st of STAGES) {
        const r = rs.find((x) => x.cap === st.label)!;
        EXPLORER_COLUMNS.forEach(({ label, roles }, i) => {
          const offered = roles.filter((role) => WorkflowEngine.getActions(st.ticket, role as Role, "actor", policy, { userRoles: [role as Role] })
            .some((a) => a.action === st.action));
          const cell = r.cells[i];
          const where = `${st.label} @ ${st.ticket.status}${st.ticket.requesterId ? "" : " (no requester)"} — ${label}`;
          if (st.conditionalOnly) {
            // the conditional stage: anyone the engine admits there is never shown as unable
            if (offered.length > 0) expect(cell.v, where).not.toBe("-");
            return;
          }
          if (offered.length === roles.length) expect(cell.v, where).toBe("y");
          else if (offered.length > 0) expect(cell.v, where).toBe("c");
          else expect(cell.v, where).not.toBe("y");
        });
      }
    });
  }
  it("the narrowed policy moves the composed cells too (a partial column, a removed manager)", () => {
    const rs = explorerRows(NARROWED);
    const c = (label: string) => rs.find((x) => x.cap === label)!.cells.map((x) => x.v).join("");
    // Admin via ticket.manage; DocCtrl by the row; Engineer-2 only; Manager / Supervisor no longer manage.
    expect(c("Direct engineering approval")).toBe("yy---c------");
    expect(rs.find((x) => x.cap === "Direct engineering approval")!.cells[col("Engineer 1-4")].why).toBe("Only Engineer-2 in this column");
    // Requester review: Supervisor and Viewer by the row; Admin via manage; DocCtrl / Engineer-2 via co-review.
    expect(c("Requester review")).toBe("yycycccccccy");
  });
  it("View-as answers through the same composition (composedAllows)", () => {
    expect(composedAllows({}, "ticket.direct_approve", "Manager", ["Manager"])).toEqual({ ok: true, via: "via Management override (ticket.manage)", conditional: null });
    expect(composedAllows({}, "ticket.direct_approve", "Engineer-3", ["Engineer-3"])).toEqual({ ok: true, via: null, conditional: null });
    expect(composedAllows({}, "ticket.direct_approve", "Drafter", ["Drafter"])).toEqual({ ok: false, via: null, conditional: null });
    expect(composedAllows({}, "ticket.reopen", "Requester", ["Requester"]).conditional).toMatch(/no requester/);
    expect(composedAllows(NARROWED, "ticket.eng_review", "Manager", ["Manager"]).ok).toBe(false);
    expect(src("components/permissions/ViewAsSimulator.tsx")).toContain("const answer = composedAllows(policy, d.id, who.role, who.roles, who.uid, resource);");
  });
  it("standing holders are shown: Admin / DocCtrl always sign off quality records; anyone else is ◐ (project owner)", () => {
    const q = row("Sign off quality records");
    expect(q.cells[col("Admin")].v).toBe("y");
    expect(q.cells[col("DocCtrl")].v).toBe("y");
    expect(q.cells[col("Drafter")]).toMatchObject({ v: "c" });
  });
  it("every admin-surface row reads a registry field that exists", () => {
    for (const s of SURFACE_ROWS) {
      const surf = adminSurface(s.key);
      expect(surf, s.key).not.toBeNull();
      expect(s.use === "writes" ? surf!.writes : surf!.entry, `${s.key}.${s.use}`).toBeDefined();
    }
  });
  it("done-when 3: the hand-maintained rows are a labelled, dated snapshot and none duplicates a derived row", () => {
    const derived = new Set(rows.filter((r) => r.source !== "snapshot").map((r) => r.cap));
    for (const r of SNAPSHOT_ROWS) expect(derived.has(r.cap), r.cap).toBe(false);
    const e = src("components/permissions/PermissionsExplorer.tsx");
    expect(e).toContain("Documentation snapshot — hand-maintained; rows marked SNAPSHOT were checked against the code on ${SNAPSHOT_REVIEWED}, rows marked NOT RE-CHECKED were not");
    expect(e).toContain(">SNAPSHOT</span>");
    expect(e).toContain(">NOT RE-CHECKED</span>");
    expect(e).not.toContain("Derived from a code audit of every enforcement point");
  });
  // ── fix pass 2 (major): the review date is carried only by rows checked
  // against the code that day; the rest say they were not re-checked ──
  const CHECKED = [
    "Edit document metadata", "Access recertification reviews", "Document-level activity history (/activity)",
    "Add a member (invite)", "Remove a member from the workspace", "Change a department's supervisor",
    "Reassign library ownership / owning team", "Per-library permission (ACL) drawer",
  ];
  it("exactly the rows checked against the code carry the review date; every other snapshot row is marked NOT RE-CHECKED", () => {
    expect(SNAPSHOT_ROWS.filter((r) => r.checked).map((r) => r.cap).sort()).toEqual([...CHECKED].sort());
    for (const r of rows.filter((x) => x.source === "snapshot")) expect(!!r.unchecked, r.cap).toBe(!CHECKED.includes(r.cap));
  });
  it("the ACL drawer row is the drawer's delegation contract (DEL-1 / GAP-3) and the library guard — owners and Manage Permissions holders, not controllers only", () => {
    const drawer = src("components/permissions/PermissionDrawer.tsx");
    expect(drawer).toContain("delegationOnly?: boolean;");
    expect(drawer).toContain('const DELEGABLE_ACTIONS: PermissionAction[] = ["discover", "read", "download", "upload", "createFolder", "editMetadata", "write", "publish"];');
    expect(drawer).toMatch(/if \(delegationOnly\) \{[\s\S]*?if \(effect !== "allow"\)[\s\S]*?if \(illegal\.length\)[\s\S]*?if \(!exp\)/);
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toContain("const libraryDelegationAuthority = !!uid && !!library?.ownerUserId && library.ownerUserId === uid;");
    expect(page).toContain("delegationOnly={!isController && libraryDelegationAuthority}");
    expect(page).toContain("delegationOnly={!isController && drawerDelegationAuthority}");
    expect(page).toMatch(/const drawerDelegationAuthority = \(\(\) => \{[\s\S]*?if \(ownerId && ownerId === uid\) return true;[\s\S]*?canWithAclChain\(\{ principal, action: "managePermissions"/);
    // the database: a change to libraries.acl is the 20261077 §2 guard's — controller, owner, or can_manage_node
    expect(newestDefining(/CREATE OR REPLACE FUNCTION enforce_library_sensitive_columns\(\)/)).toBe("20261077_dc_roundF_records_rails.sql");
    expect(src("supabase/migrations/20261077_dc_roundF_records_rails.sql"))
      .toMatch(/OR NEW\.acl\s+IS DISTINCT FROM OLD\.acl[\s\S]*?IF NOT is_org_controller\(OLD\.org_id\)\s+AND OLD\.owner_user_id::text IS DISTINCT FROM auth\.uid\(\)::text\s+AND NOT can_manage_node\(OLD\.acl_index, OLD\.org_id\) THEN/);
    expect(cells("Per-library permission (ACL) drawer")).toBe("yycccccccccc");
    const why = row("Per-library permission (ACL) drawer").cells[col("Drafter")].why!;
    expect(why).toMatch(/allow rules only, never Admin or Manage Permissions, each with an expiry/);
    expect(why).toMatch(/Manage Permissions grant holder/);
  });
  it("document metadata: the editor is the controllers'; the inline title rename and the database admit anyone not denied — said, not shown as Admin / DocCtrl only", () => {
    expect(src("components/documents/MetadataEditor.tsx")).toContain('const canEdit = heldRoles.some((r) => r === "Admin" || r === "DocCtrl");');
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toMatch(/key: "renameTitle", label: "Rename title"/);
    expect(page).toMatch(/const saveInlineTitle = async \(docId: string, value: string\) => \{[\s\S]*?\.from\("documents"\)\s*\.update\(\{ title,/);
    expect(src("supabase/schema.sql")).toMatch(/CREATE POLICY "documents_org_access" ON documents FOR ALL\s+USING \(org_id IN \(SELECT my_org_ids\(\)\)\);/);
    expect(src("supabase/migrations/20260901_db_hard_enforcement.sql")).toMatch(/CREATE POLICY documents_deny_write_guard ON documents\s+AS RESTRICTIVE FOR UPDATE[\s\S]*?acl_index_denies\(acl_index, org_id, auth\.uid\(\), 'editMetadata'\)/);
    expect(cells("Edit document metadata")).toBe("yycccccccccc");
    expect(row("Edit document metadata").warn).toMatch(/documents_org_access admits any member's update/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// QUAL-14 — the editor carries a project-scoped rule
// ═══════════════════════════════════════════════════════════════════════════
describe("QUAL-14 — split/join carry project-scoped rules on a project-scoped capability only", () => {
  it("a projectId rule on quality.sign_off is an editable project row and round-trips to the same answers", () => {
    const stored: CapabilityPolicy = { caps: { "quality.sign_off": [{ tokens: [] }, { tokens: ["Safety"], when: { projectId: ["p1", "p2"] } }] } };
    const s = splitPolicyForEditor(stored);
    expect(s.projectOverrides["quality.sign_off"]).toEqual([{ projectId: "p1", tokens: ["Safety"] }, { projectId: "p2", tokens: ["Safety"] }]);
    expect(s.opaque["quality.sign_off"]).toBeUndefined();
    const j = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides);
    for (const p of ["p1", "p2", "p3", undefined]) {
      expect(policyAllows({ caps: j }, "quality.sign_off", "Safety", ["Safety"], "x", p ? { projectId: p } : undefined))
        .toBe(policyAllows(stored, "quality.sign_off", "Safety", ["Safety"], "x", p ? { projectId: p } : undefined));
    }
  });
  it("legacy three-argument joins are byte-identical (no project rows)", () => {
    const legacy: CapabilityPolicy = { caps: { "ticket.assign": ["Admin", "DocCtrl"] } };
    const s = splitPolicyForEditor(legacy);
    expect(joinPolicyFromEditor(s.base, s.overrides, s.opaque)).toEqual(joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides));
  });
});
