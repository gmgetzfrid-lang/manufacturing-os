// Document-control Round F — P5 HOLDS: hold integrity, the shared hold gate,
// the hold card / verify payload, the aging sweep, and the two migrations.
//
//   HLD-1   lib/holdGate.ts assertNotOnHold — one read, one decision, one
//           refusal, FAIL CLOSED; requestAcks (distribution-ack assignment)
//           refuses on a held document; 20261074 label rails at the database.
//   HLD-5   20261073 document_holds guard: identity pinned, no resurrection,
//           reason required, session-attributed, DB-written audit row that the
//           app does not duplicate (release_recorded_at).
//   HLD-7   held_rev_label captured at open; /api/verify-hold publishes the
//           reason only as its predefined category and reports heldRev.
//   HLD-8   holdControlsFor — a UserGrant lights the Release control; the
//           queue's row link carries ?doc=.
//   HLD-9   org-agreement guard + INSERT policy binding (byte-faithful to the
//           live 20260901 policy plus one conjunct).
//   HLD-10  releaseHold requires a reason; the opener is told; the audience is
//           policy-derived; a failed emit is logged.
//   HLD-14  expected-release date from the picker; scanStaleHolds rides the
//           maintenance cron and nudges once.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// ─── In-memory PostgREST engine (the sweepRoundD3 Proxy-chain shape) ─────────
const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  readErrors: {} as Record<string, string>,
  /** Simulates a BEFORE trigger: mutate the row about to be written. */
  onWrite: null as null | ((table: string, op: string, row: Record<string, unknown>) => void),
}));
type Filter = { kind: string; col: string; val: unknown };
function matches(r: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = r[f.col];
    switch (f.kind) {
      case "eq": return v === f.val;
      case "is": return f.val === null ? v === null || v === undefined : v === f.val;
      case "not-is": return f.val === null ? !(v === null || v === undefined) : v !== f.val;
      case "lt": return typeof v === "string" && v < String(f.val);
      case "gte": return typeof v === "string" && v >= String(f.val);
      case "in": return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
      case "contains": {
        const want = f.val as Record<string, unknown>;
        const have = (v ?? {}) as Record<string, unknown>;
        return Object.entries(want).every(([k, x]) => have[k] === x);
      }
      default: return true;
    }
  });
}
function chain(table: string) {
  const filters: Filter[] = [];
  let op: "select" | "insert" | "update" | "upsert" = "select";
  let payload: unknown = null;
  let single = false;
  const resolve = () => {
    if (state.readErrors[table]) return { data: null, error: { message: state.readErrors[table] } };
    const all = (state.rows[table] ??= []);
    if (op === "insert" || op === "upsert") {
      const rows = (Array.isArray(payload) ? payload : [payload]) as Array<Record<string, unknown>>;
      const inserted = rows.map((r) => ({ id: `${table}-${all.length + 1}`, ...r }));
      for (const r of inserted) { state.onWrite?.(table, op, r); all.push(r); }
      return single ? { data: inserted[0], error: null } : { data: inserted, error: null };
    }
    if (op === "update") {
      const hit = all.filter((r) => matches(r, filters));
      for (const r of hit) { Object.assign(r, payload as Record<string, unknown>); state.onWrite?.(table, op, r); }
      if (single) return hit[0] ? { data: hit[0], error: null } : { data: null, error: { message: "0 rows" } };
      return { data: hit, error: null };
    }
    const hit = all.filter((r) => matches(r, filters));
    return single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => void) => res(resolve());
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "insert") { op = "insert"; payload = args[0]; }
        if (prop === "upsert") { op = "upsert"; payload = args[0]; }
        if (prop === "update") { op = "update"; payload = args[0]; }
        if (prop === "eq") filters.push({ kind: "eq", col: String(args[0]), val: args[1] });
        if (prop === "is") filters.push({ kind: "is", col: String(args[0]), val: args[1] });
        if (prop === "lt") filters.push({ kind: "lt", col: String(args[0]), val: args[1] });
        if (prop === "gte") filters.push({ kind: "gte", col: String(args[0]), val: args[1] });
        if (prop === "in") filters.push({ kind: "in", col: String(args[0]), val: args[1] });
        if (prop === "contains") filters.push({ kind: "contains", col: String(args[0]), val: args[1] });
        if (prop === "not") filters.push({ kind: "not-is", col: String(args[0]), val: args[2] });
        if (prop === "single" || prop === "maybeSingle") { single = true; return Promise.resolve(resolve()); }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    from: (t: string) => chain(t),
  },
  __setServerSupabaseClient: () => undefined,
  __resetServerSupabaseClient: () => undefined,
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
const audit = vi.hoisted(() => ({ logHoldEvent: vi.fn(async (_p: Record<string, unknown>) => undefined) }));
vi.mock("@/lib/audit", () => ({ logHoldEvent: audit.logHoldEvent }));
const dispatch = vi.hoisted(() => ({ emit: vi.fn(async (_p: Record<string, unknown>) => undefined) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: dispatch.emit }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));

import {
  decideHoldGate, holdRefusalMessage, assertNotOnHold, readActiveHolds, HoldBlockedError, isHoldBlockedError,
} from "@/lib/holdGate";
import {
  publicHoldReason, PUBLIC_HOLD_REASON_FALLBACK, PREDEFINED_HOLD_REASONS, holdControlsFor, holdPoolFromMembers,
  expectedReleaseIso, releaseHold, openHold, scanStaleHolds, HOLD_AGING_DAYS,
} from "@/lib/holds";
import { requestAcks } from "@/lib/distributionAcks";
import { __resetCapabilityPolicyCache, type CapabilityPolicy } from "@/lib/capabilityPolicy";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

const DOC = "22222222-2222-2222-2222-222222222222";
const HOLD = "33333333-3333-3333-3333-333333333333";
const openHoldRow = (over: Record<string, unknown> = {}) => ({
  id: HOLD, org_id: "o1", document_id: DOC, reason: "Client Review", notes: null, expected_release_at: null,
  opened_by: "opener", opened_by_name: "Opal Opener", opened_at: "2026-09-01T00:00:00.000Z",
  released_by: null, released_by_name: null, released_at: null, released_reason: null, ...over,
});
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  state.rows = {}; state.calls = []; state.readErrors = {}; state.onWrite = null;
  audit.logHoldEvent.mockClear(); dispatch.emit.mockClear();
  __resetCapabilityPolicyCache();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
});
afterEach(() => { warnSpy?.mockRestore(); warnSpy = null; });

// ─── HLD-1: the shared gate ──────────────────────────────────────────────────
describe("HLD-1 — lib/holdGate.ts: one read, one decision, fail closed", () => {
  const hold = { id: HOLD, reason: "Client Review", openedAt: null, openedByName: null };
  it("decideHoldGate: no holds pass; holds block with the shared sentence; an unreadable set BLOCKS", () => {
    expect(decideHoldGate({ readable: true, holds: [] })).toEqual({ blocked: false, holds: [] });
    const d = decideHoldGate({ readable: true, holds: [hold, { ...hold, id: "h2", reason: "Missing Vendor Data" }] }, "sending a transmittal");
    expect(d.blocked).toBe(true);
    if (d.blocked) {
      expect(d.unreadable).toBe(false);
      expect(d.message).toBe("Document has an active holds (Client Review, Missing Vendor Data); release the holds before sending a transmittal.");
    }
    expect(holdRefusalMessage([hold])).toBe("Document has an active hold (Client Review); release the hold.");
    const u = decideHoldGate({ readable: false, error: "boom" }, "requesting confirmations");
    expect(u.blocked).toBe(true);
    if (u.blocked) { expect(u.unreadable).toBe(true); expect(u.message).toMatch(/treated as held — retry requesting confirmations/); }
  });
  it("assertNotOnHold throws HoldBlockedError (code on_hold) on a held document and on a read error; passes a clean one; takes an injected client", async () => {
    state.rows.document_holds = [openHoldRow(), openHoldRow({ id: "released", released_at: "2026-09-02T00:00:00Z", reason: "Old" })];
    await expect(assertNotOnHold(DOC, { action: "disposing" })).rejects.toMatchObject({ code: "on_hold", unreadable: false, holds: [{ id: HOLD, reason: "Client Review" }] });
    await expect(assertNotOnHold("other-doc")).resolves.toBeUndefined();
    state.readErrors.document_holds = "permission denied";
    const err = await assertNotOnHold(DOC).catch((e) => e as HoldBlockedError);
    expect(isHoldBlockedError(err)).toBe(true);
    expect((err as HoldBlockedError).unreadable).toBe(true);
    // an injected client (a route's service-role client) is used instead of the shared one
    const seen: string[] = [];
    const client = { from: (t: string) => { seen.push(t); return chain(t); } } as unknown as Parameters<typeof readActiveHolds>[1];
    state.readErrors = {};
    const read = await readActiveHolds(DOC, client);
    expect(seen).toEqual(["document_holds"]);
    expect(read.readable && read.holds.map((h) => h.id)).toEqual([HOLD]);
    // the read is scoped to UNRELEASED holds of THIS document
    const q = state.calls.filter((c) => c.table === "document_holds");
    expect(q.some((c) => c.method === "eq" && c.args[0] === "document_id" && c.args[1] === DOC)).toBe(true);
    expect(q.some((c) => c.method === "is" && c.args[0] === "released_at" && c.args[1] === null)).toBe(true);
  });
  it("requestAcks refuses an acknowledgment assignment against a held document before any row is written; the recall close-out (notify:false) proceeds", async () => {
    state.rows.document_holds = [openHoldRow()];
    const input = {
      orgId: "o1", documentId: DOC, libraryId: "lib", docLabel: "P-101", versionId: "v5", revLabel: "5",
      recipients: [{ uid: "u1", email: "u1@x.io" }], actorUserId: "dc", actorName: "Doc Control",
    };
    await expect(requestAcks(input)).rejects.toMatchObject({ code: "on_hold" });
    expect(state.calls.filter((c) => c.table === "distribution_acks")).toHaveLength(0);
    expect(dispatch.emit).not.toHaveBeenCalled();
    // fail closed on an unreadable hold set
    state.readErrors.document_holds = "timeout";
    await expect(requestAcks(input)).rejects.toMatchObject({ code: "on_hold", unreadable: true });
    state.readErrors = {};
    // DIST-10 recall close-out: the record of a recall already sent, not an assignment
    const r = await requestAcks({ ...input, notify: false });
    expect(r).toEqual({ requested: 1, reminded: 0 });
    expect(state.rows.distribution_acks).toHaveLength(1);
    // an un-held document is assigned as before
    state.rows.document_holds = [];
    state.rows.distribution_acks = [];
    await expect(requestAcks(input)).resolves.toEqual({ requested: 1, reminded: 0 });
    expect(dispatch.emit).toHaveBeenCalledTimes(1);
  });
});

// ─── HLD-10 / HLD-5: the release ──────────────────────────────────────────────
describe("HLD-10 / HLD-5 — releaseHold: reason required, DB-written audit not duplicated, opener told", () => {
  const release = (over: Record<string, unknown> = {}) => releaseHold({
    holdId: HOLD, releasedBy: "rel", releasedByName: "Rae Releaser", releasedByEmail: "rae@x.io", releasedByRole: "Drafter",
    releasedReason: "Vendor data received", ...over,
  } as Parameters<typeof releaseHold>[0]);
  it("refuses a blank reason before touching the database (mirrors revertToVersion)", async () => {
    state.rows.document_holds = [openHoldRow()];
    await expect(release({ releasedReason: "   " })).rejects.toThrow(/release reason is required/);
    await expect(release({ releasedReason: undefined })).rejects.toThrow(/release reason is required/);
    expect(state.calls).toHaveLength(0);
    expect(state.rows.document_holds[0].released_at).toBeNull();
  });
  it("pre-20261073 database: the app writes HOLD_RELEASED itself and the opener is in the audience", async () => {
    state.rows.document_holds = [openHoldRow()];
    state.rows.org_members = [{ uid: "adm", role: "Admin", roles: ["Admin"], org_id: "o1", status: "active" }];
    const out = await release();
    expect(out.releasedReason).toBe("Vendor data received");
    expect(out.releasedAt).toBeTruthy();
    expect(audit.logHoldEvent).toHaveBeenCalledTimes(1);
    expect(audit.logHoldEvent.mock.calls[0][0]).toMatchObject({ type: "HOLD_RELEASED", holdId: HOLD, userId: "rel", details: { releasedReason: "Vendor data received" } });
    // the CAS predicate survives: id + released_at IS NULL
    const upd = state.calls.filter((c) => c.table === "document_holds" && ["update", "eq", "is"].includes(c.method));
    expect(upd.some((c) => c.method === "is" && c.args[0] === "released_at" && c.args[1] === null)).toBe(true);
    await vi.waitFor(() => expect(dispatch.emit).toHaveBeenCalledTimes(1));
    const e = dispatch.emit.mock.calls[0][0] as { kind: string; audience: { involved?: string[]; followers?: boolean; roles?: string[] } };
    expect(e.kind).toBe("hold_released");
    expect(e.audience.involved).toContain("opener");
    expect(e.audience.involved).toContain("adm");
    expect(e.audience.followers).toBe(true);
    expect(e.audience.roles).toBeUndefined();
  });
  it("20261073 database: the guard stamps release_recorded_at and the app writes NO second audit row; the guard's attribution wins", async () => {
    state.rows.document_holds = [openHoldRow()];
    state.onWrite = (table, op, row) => {
      if (table === "document_holds" && op === "update" && row.released_at) {
        row.released_by = "session-uid"; row.released_by_name = "From Membership"; row.release_recorded_at = "2026-09-23T00:00:00Z";
      }
    };
    const out = await release();
    expect(audit.logHoldEvent).not.toHaveBeenCalled();
    expect(out.releasedBy).toBe("session-uid");
    expect(out.releasedByName).toBe("From Membership");
  });
  it("a failed announcement is logged, never silently swallowed", async () => {
    state.rows.document_holds = [openHoldRow()];
    dispatch.emit.mockRejectedValueOnce(new Error("smtp down"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await release();
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(String((warnSpy as ReturnType<typeof vi.spyOn>).mock.calls[0][0])).toMatch(/hold_released notification failed/);
  });
  it("openHold passes the picker's expected release date through and never sends the DB-derived columns", async () => {
    const out = await openHold({ orgId: "o1", documentId: DOC, reason: "Client Review", expectedReleaseAt: "2026-10-01T23:59:59.999Z", openedBy: "opener" });
    const ins = state.calls.find((c) => c.table === "document_holds" && c.method === "insert");
    expect(ins?.args[0]).toMatchObject({ expected_release_at: "2026-10-01T23:59:59.999Z", reason: "Client Review" });
    expect(ins?.args[0]).not.toHaveProperty("held_rev_label");
    expect(out.heldRevLabel).toBeNull();
    expect(audit.logHoldEvent.mock.calls[0][0]).toMatchObject({ type: "HOLD_OPENED" });
  });
});

// ─── HLD-8 / HLD-10: authority and audience from the policy ──────────────────
describe("HLD-8 / HLD-10 — holdControlsFor and the policy-derived audience", () => {
  it("a UserGrant for holds.release lights the Release control; a narrowed role list hides it from the un-granted", () => {
    const narrowed: CapabilityPolicy = {
      caps: { "holds.release": ["Admin", "DocCtrl"], "holds.open": ["Admin", "DocCtrl", "Engineer"] },
      grants: [{ cap: "holds.release", uid: "coordinator", expiresAt: null }],
    };
    expect(holdControlsFor(narrowed, "Viewer", [], "coordinator")).toEqual({ canOpen: false, canRelease: true });
    expect(holdControlsFor(narrowed, "Viewer", [], "someone-else")).toEqual({ canOpen: false, canRelease: false });
    // the additive collection counts, never the headline alone
    expect(holdControlsFor(narrowed, "Manager", ["DocCtrl"], "m1")).toEqual({ canOpen: true, canRelease: true });
    expect(holdControlsFor(narrowed, "Engineer-2", null, "e2")).toEqual({ canOpen: true, canRelease: false });
    // shipped default ('*') admits everyone — the UI no longer blocks people the policy allows
    expect(holdControlsFor({}, "Viewer", [], "v1")).toEqual({ canOpen: true, canRelease: true });
    // an expired grant is dead
    const expired: CapabilityPolicy = { ...narrowed, grants: [{ cap: "holds.release", uid: "coordinator", expiresAt: "2020-01-01T00:00:00Z" }] };
    expect(holdControlsFor(expired, "Viewer", [], "coordinator").canRelease).toBe(false);
  });
  it("the audience is the policy's release pool: named roles (tokens expanded) + grants; the wildcard default falls back to controllers", () => {
    const members = [
      { uid: "adm", role: "Admin", roles: ["Admin"] },
      { uid: "dc-additive", role: "Manager", roles: ["Manager", "DocCtrl"] },
      { uid: "eng", role: "Engineer-2", roles: ["Engineer-2"] },
      { uid: "viewer", role: "Viewer", roles: [] },
      { uid: "mgr", role: "Manager", roles: ["Manager"] },
    ];
    expect(holdPoolFromMembers({}, members).sort()).toEqual(["adm", "dc-additive"]);
    expect(holdPoolFromMembers({ caps: { "holds.release": ["*"] } }, members).sort()).toEqual(["adm", "dc-additive"]);
    expect(holdPoolFromMembers({ caps: { "holds.release": ["Manager", "Engineer"] } }, members).sort()).toEqual(["dc-additive", "eng", "mgr"]);
    expect(holdPoolFromMembers({ caps: { "holds.release": [] } }, members).sort()).toEqual(["adm", "dc-additive"]);
    const g: CapabilityPolicy = { caps: { "holds.release": ["Admin"] }, grants: [
      { cap: "holds.release", uid: "coordinator", expiresAt: null },
      { cap: "holds.release", uid: "gone", expiresAt: "2020-01-01T00:00:00Z" },
      { cap: "holds.open", uid: "opener-only", expiresAt: null },
    ] };
    expect(holdPoolFromMembers(g, members).sort()).toEqual(["adm", "coordinator"]);
    // no literal controller list survives in the notify path
    expect(src("lib/holds.ts")).not.toMatch(/roles: \["Admin", "DocCtrl"\]/);
  });
});

// ─── HLD-7: the public payload and the held revision ─────────────────────────
describe("HLD-7 — publicHoldReason and /api/verify-hold", () => {
  it("publicHoldReason returns a predefined category verbatim and 'On hold' for operator text", () => {
    for (const r of PREDEFINED_HOLD_REASONS) expect(publicHoldReason(r)).toBe(r);
    expect(publicHoldReason("Hold per legal — Aug 12 release incident, do not distribute")).toBe(PUBLIC_HOLD_REASON_FALLBACK);
    expect(publicHoldReason(null)).toBe("On hold");
    expect(publicHoldReason("  Client Review ")).toBe("Client Review");
  });
  async function verify(id = HOLD) {
    const { GET } = await import("@/app/api/verify-hold/route");
    const u = new URL("https://app/api/verify-hold"); u.searchParams.set("id", id);
    const res = await GET(new NextRequest(u));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  it("a custom reason is published as 'On hold'; heldRev is the rev the hold stopped, docRev the document now; notes and names are withheld", async () => {
    state.rows.document_holds = [openHoldRow({ reason: "Hold per legal — incident, do not distribute", notes: "waiting on legal", held_rev_label: "3" })];
    state.rows.documents = [{ id: DOC, document_number: "P-2201", title: "Compressor", name: "c", rev: "5" }];
    const { status, body } = await verify();
    expect(status).toBe(200);
    expect(body).toMatchObject({ active: true, reason: "On hold", docLabel: "P-2201", docRev: "5", heldRev: "3" });
    expect(body).not.toHaveProperty("notes");
    expect(body).not.toHaveProperty("openedByName");
    expect(Object.keys(body).sort()).toEqual(["active", "checkedAt", "docLabel", "docRev", "heldRev", "openedAt", "reason", "releasedAt"]);
  });
  it("a predefined reason passes through; a pre-migration row (no held_rev_label) reports heldRev null, never the current rev", async () => {
    state.rows.document_holds = [openHoldRow({ released_at: "2026-09-10T00:00:00Z" })];
    state.rows.documents = [{ id: DOC, document_number: "P-2201", rev: "5" }];
    const { body } = await verify();
    expect(body).toMatchObject({ active: false, reason: "Client Review", heldRev: null, docRev: "5" });
    expect((await verify("not-a-uuid")).status).toBe(400);
  });
});

// ─── HLD-14: expected release + the aging sweep ──────────────────────────────
describe("HLD-14 — expectedReleaseIso and scanStaleHolds", () => {
  it("expectedReleaseIso: a picker date becomes the END of that local day; blank / malformed / impossible → undefined", () => {
    expect(expectedReleaseIso("2026-10-01")).toBe(new Date(2026, 9, 1, 23, 59, 59, 999).toISOString());
    expect(expectedReleaseIso("")).toBeUndefined();
    expect(expectedReleaseIso(undefined)).toBeUndefined();
    expect(expectedReleaseIso("next friday")).toBeUndefined();
    expect(expectedReleaseIso("2026-02-31")).toBeUndefined();
  });
  it("nudges the opener + the release pool once per late or aged hold, skips young and already-nudged ones", async () => {
    const now = new Date("2026-09-23T03:00:00.000Z");
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86400_000).toISOString();
    state.rows.document_holds = [
      openHoldRow({ id: "late", expected_release_at: daysAgo(3), opened_at: daysAgo(10) }),
      openHoldRow({ id: "aged", opened_at: daysAgo(HOLD_AGING_DAYS + 5), reason: "Missing Vendor Data" }),
      openHoldRow({ id: "young", opened_at: daysAgo(2) }),
      openHoldRow({ id: "future", expected_release_at: daysAgo(-5), opened_at: daysAgo(60) }),
      openHoldRow({ id: "done", expected_release_at: daysAgo(30), released_at: daysAgo(1) }),
      openHoldRow({ id: "other-org", org_id: "o2", expected_release_at: daysAgo(30) }),
      openHoldRow({ id: "nudged", expected_release_at: daysAgo(9), opened_at: daysAgo(20) }),
    ];
    state.rows.notifications = [{ id: "n1", kind: "hold_opened", metadata: { staleHoldId: "nudged", escalation: true } }];
    state.rows.documents = [{ id: DOC, document_number: "P-101", library_id: "lib-1" }];
    state.rows.org_members = [{ uid: "adm", role: "Admin", roles: ["Admin"], org_id: "o1", status: "active" }, { uid: "opener", role: "Drafter", roles: ["Drafter"], org_id: "o1", status: "active" }];
    expect(await scanStaleHolds("o1", now)).toBe(2);
    expect(dispatch.emit).toHaveBeenCalledTimes(2);
    const emitted = dispatch.emit.mock.calls.map((c) => c[0] as { title: string; kind: string; category: string; link?: string; audience: { involved?: string[] }; metadata?: { staleHoldId?: string } });
    const ids = emitted.map((e) => e.metadata?.staleHoldId).sort();
    expect(ids).toEqual(["aged", "late"]);
    for (const e of emitted) {
      expect(e.kind).toBe("hold_opened");
      expect(e.category).toBe("sla");
      expect(e.audience.involved).toEqual(expect.arrayContaining(["opener", "adm"]));
      expect(e.link).toBe(`/documents/lib-1?doc=${DOC}`);
    }
    expect(emitted.find((e) => e.metadata?.staleHoldId === "late")?.title).toMatch(/past its expected release — P-101 \(Client Review\)/);
    expect(emitted.find((e) => e.metadata?.staleHoldId === "aged")?.title).toMatch(new RegExp(`Hold open ${HOLD_AGING_DAYS + 5} days — P-101 \\(Missing Vendor Data\\)`));
    // idempotent: a second run the same day nudges nothing new
    state.rows.notifications.push({ id: "n2", kind: "hold_opened", metadata: { staleHoldId: "late" } }, { id: "n3", kind: "hold_opened", metadata: { staleHoldId: "aged" } });
    dispatch.emit.mockClear();
    expect(await scanStaleHolds("o1", now)).toBe(0);
    expect(dispatch.emit).not.toHaveBeenCalled();
  });
  it("rides the EXISTING maintenance route as a compliance scan — no third vercel.json cron", () => {
    const route = src("app/api/cron/maintenance/route.ts");
    expect(route).toMatch(/\["hold-aging", scanStaleHolds\],/);
    expect(route).toMatch(/import \{ scanStaleHolds \} from "@\/lib\/holds";/);
    const crons = JSON.parse(src("vercel.json")) as { crons: Array<{ path: string }> };
    expect(crons.crons.map((c) => c.path).sort()).toEqual(["/api/cron/maintenance", "/api/data-export/run-scheduled"]);
    // the HoldStrip header no longer claims a dead indicator ships unqualified
    const strip = src("components/documents/HoldStrip.tsx");
    expect(strip).toMatch(/scanStaleHolds\) nudges the opener/);
    expect(strip).toMatch(/expectedReleaseAt: expectedReleaseIso\(expectedDate\),/);
  });
});

// ─── HLD-8 / HLD-10: the two surfaces, by source ──────────────────────────────
describe("HLD-8 / HLD-10 — the inspector strip and the queue read the policy, link to the document, require a reason", () => {
  it("no literal role list decides the controls on either surface; both go through holdControlsFor", () => {
    const page = src("app/(protected)/admin/holds/page.tsx");
    const strip = src("components/documents/HoldStrip.tsx");
    expect(page).not.toMatch(/ADMIN_ROLES/);
    expect(page).not.toMatch(/new Set\(\["Admin"/);
    expect(page).toMatch(/holdControlsFor\(policy, activeRole, roles, uid\)\.canRelease/);
    expect(strip).toMatch(/holdControlsFor\(policy, userRole, heldRoleCollection, userId\)/);
    expect(strip).not.toMatch(/activeRole === 'Admin'/);
    // fail closed until the policy is read
    expect(page).toMatch(/policy \? holdControlsFor\(.*\)\.canRelease : false/);
    expect(strip).toMatch(/: \{ canOpen: false, canRelease: false \};/);
  });
  it("the queue row deep-links to the held document with ?doc= (the notification's link shape)", () => {
    const page = src("app/(protected)/admin/holds/page.tsx");
    expect(page).toMatch(/href=\{`\/documents\/\$\{meta\.libraryId\}\?doc=\$\{h\.documentId\}`\}/);
    expect(page).not.toMatch(/href=\{`\/documents\/\$\{meta\.libraryId\}`\}/);
  });
  it("both release controls stay disabled until a reason is typed and pass it through as required", () => {
    const page = src("app/(protected)/admin/holds/page.tsx");
    const strip = src("components/documents/HoldStrip.tsx");
    for (const s of [page, strip]) {
      expect(s).toMatch(/placeholder="Why is this hold being released\? \(required\)"/);
      expect(s).not.toMatch(/Resolution \(optional\)/);
      expect(s).toMatch(/disabled=\{busy \|\| !releaseReady\}/);
    }
    expect(page).toMatch(/const releasedReason = releaseDraft\.trim\(\);\s*\n\s*if \(!releasedReason\) return;/);
    expect(strip).toMatch(/const releasedReason = releaseReasonDraft\.trim\(\);\s*\n\s*if \(!releasedReason\) return;/);
  });
});

// ─── Migrations ──────────────────────────────────────────────────────────────
describe("20261073 — document_holds integrity (HLD-5 / HLD-9 / HLD-7)", () => {
  const m73 = mig("20261073_dc_roundF_document_holds_integrity.sql");
  const m01 = mig("20260901_db_hard_enforcement.sql");
  it("the INSERT policy is the live 20260901 body plus exactly one org-binding conjunct (3-argument entry point kept)", () => {
    const live = between(m01, "CREATE POLICY document_holds_insert ON", ");");
    const next = between(m73, "CREATE POLICY document_holds_insert ON", ");");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual(["  AND org_id = (SELECT d.org_id FROM documents d WHERE d.id = document_holds.document_id)"]);
    expect(next).toMatch(/org_capability_allows\(org_id, 'holds\.open', auth\.uid\(\)\)/);
    expect(m73).toMatch(/DROP POLICY IF EXISTS document_holds_insert ON document_holds;/);
    // the UPDATE / SELECT / DELETE policies are not touched
    expect(m73).not.toMatch(/CREATE POLICY document_holds_(update|select|delete)/);
  });
  it("HLD-5 guard: identity pinned for everyone, no resurrection, release record frozen, reason required, session-attributed, DB-written audit row + release_recorded_at", () => {
    const fn = between(m73, "CREATE OR REPLACE FUNCTION enforce_document_hold_guard()", "DROP TRIGGER IF EXISTS trg_document_hold_guard");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    for (const col of ["org_id", "document_id", "reason", "opened_by", "opened_by_name", "opened_at", "held_rev_label", "held_version_id"]) {
      expect(fn, col).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
    expect(fn).toMatch(/Hold rows are immutable in identity/);
    expect(fn).toMatch(/IF OLD\.released_at IS NOT NULL THEN\s*\n\s*IF NEW\.released_at IS NULL THEN\s*\n\s*RAISE EXCEPTION 'A released hold cannot be reopened; place a new hold instead\.'/);
    expect(fn).toMatch(/The release record of a hold cannot be rewritten\./);
    expect(fn).toMatch(/Release attribution can only be written by releasing the hold\./);
    expect(fn).toMatch(/IF NULLIF\(btrim\(NEW\.released_reason\), ''\) IS NULL THEN\s*\n\s*RAISE EXCEPTION 'A release reason is required/);
    // service role: must name a releaser, keeps its own attribution + audit row
    expect(fn).toMatch(/IF v_actor IS NULL THEN[\s\S]*?IF NEW\.released_by IS NULL THEN[\s\S]*?RETURN NEW;/);
    // signed-in: the session, not the payload
    expect(fn).toMatch(/NEW\.released_by := v_actor;\s*\n\s*NEW\.released_at := now\(\);/);
    expect(fn).toMatch(/COALESCE\(NULLIF\(btrim\(m\.display_name\), ''\), m\.email\)/);
    // DEC-2: the audit row records the collection, never the headline alone
    expect(fn).toMatch(/array_to_string\(COALESCE\(NULLIF\(m\.roles, '\{\}'::text\[\]\), ARRAY\[m\.role\]\), ','\)/);
    expect(fn).not.toMatch(/m\.email, m\.role\b/);
    expect(fn).toMatch(/INSERT INTO audit_logs \(action, resource_id, resource_type, org_id, user_id, user_email, user_role, details\)\s*\n\s*VALUES \('HOLD_RELEASED', NEW\.document_id::text, 'document', NEW\.org_id, v_actor, v_email, v_role,/);
    expect(fn).toMatch(/'source', 'document_holds_guard'/);
    expect(fn).toMatch(/NEW\.release_recorded_at := now\(\);\s*\n\s*RETURN NEW;/);
    // the identity block precedes every RETURN NEW — nobody skips it
    expect(fn.indexOf("Hold rows are immutable in identity")).toBeLessThan(fn.indexOf("RETURN NEW"));
    expect(m73).toMatch(/CREATE TRIGGER trg_document_hold_guard\s*\n\s*BEFORE UPDATE ON document_holds\s*\n\s*FOR EACH ROW EXECUTE FUNCTION enforce_document_hold_guard\(\);/);
    // DEC-25: origin_ticket_id is NOT pinned; notes / expected_release_at stay editable on an open hold
    expect(fn).not.toMatch(/NEW\.origin_ticket_id/);
    expect(fn).not.toMatch(/NEW\.notes/);
    expect(fn).not.toMatch(/NEW\.expected_release_at/);
  });
  it("HLD-9 guard: BEFORE INSERT, org must equal the document's (everyone), held rev / version derived from the document, never born recorded", () => {
    const fn = between(m73, "CREATE OR REPLACE FUNCTION enforce_document_hold_org_guard()", "DROP TRIGGER IF EXISTS trg_document_hold_org_guard");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/SELECT d\.org_id, d\.rev, d\.current_version_id\s*\n\s*INTO v_doc_org, v_doc_rev, v_doc_ver\s*\n\s*FROM documents d WHERE d\.id = NEW\.document_id;/);
    expect(fn).toMatch(/IF NEW\.org_id IS DISTINCT FROM v_doc_org THEN\s*\n\s*RAISE EXCEPTION 'A hold must carry the org of the document it holds\.'/);
    expect(fn).toMatch(/IF NEW\.held_rev_label IS NULL THEN NEW\.held_rev_label := v_doc_rev; END IF;/);
    expect(fn).toMatch(/IF NEW\.held_version_id IS NULL THEN NEW\.held_version_id := v_doc_ver; END IF;/);
    expect(fn).toMatch(/NEW\.release_recorded_at := NULL;/);
    expect(fn).not.toMatch(/auth\.uid\(\)/);
    expect(m73).toMatch(/CREATE TRIGGER trg_document_hold_org_guard\s*\n\s*BEFORE INSERT ON document_holds\s*\n\s*FOR EACH ROW EXECUTE FUNCTION enforce_document_hold_org_guard\(\);/);
    // the new columns, additive and idempotent; held_version_id deliberately carries no FK (a SET NULL cascade would trip the identity pin)
    expect(m73).toMatch(/ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS held_rev_label TEXT;/);
    expect(m73).toMatch(/ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS held_version_id UUID;\n/);
    expect(m73).toMatch(/ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS release_recorded_at TIMESTAMPTZ;/);
  });
  it("one paste: inventory temp table before BEGIN, one final SELECT with the fixed (check, ok, n) shape, aggregate counts only", () => {
    expect(m73.indexOf("CREATE TEMP TABLE IF NOT EXISTS _dc_f73_before")).toBeLessThan(m73.indexOf("BEGIN;"));
    expect(m73.indexOf("BEGIN;")).toBeLessThan(m73.indexOf("COMMIT;"));
    const tail = m73.slice(m73.indexOf("COMMIT;"));
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    expect((tail.match(/^UNION ALL$/gm) ?? []).length).toBe(7);
    expect(tail).toMatch(/SELECT 'inventory \(before apply\): ' \|\| what, NULL::boolean, n::text FROM _dc_f73_before/);
    expect(tail).not.toMatch(/SELECT uid|SELECT id,|SELECT \*/);
    const inv = between(m73, "CREATE TEMP TABLE IF NOT EXISTS _dc_f73_before", "BEGIN;");
    expect(inv).toMatch(/h\.org_id IS DISTINCT FROM d\.org_id/);
    expect((inv.match(/COUNT\(\*\)/g) ?? []).length).toBe(4);
    // probes never LIKE a bare cast on a deparsed policy
    expect(tail).toMatch(/with_check LIKE '%d\.id = document_holds\.document_id%'/);
  });
  it("the service-role ticket close gate still satisfies the guard: it names its actor and always supplies a reason", () => {
    const route = src("app/api/tickets/workflow-action/route.ts");
    expect(route).toMatch(/released_by: caller\.id/);
    expect(route).toMatch(/released_reason: reason \|\| `Released on \$\{newStatus === "CANCELED" \? "cancellation" : "close"\} of ticket/);
    expect(route).toMatch(/action: "HOLD_RELEASED"/);
  });
});

describe("20261074 — held-document label rails (HLD-1 database half)", () => {
  const m74 = mig("20261074_dc_roundF_held_document_label_rails.sql");
  it("documents rail: bare rev/revision rewrite on a held document refused for a non-controller; publish-shaped writes and the service role pass", () => {
    const fn = between(m74, "CREATE OR REPLACE FUNCTION enforce_document_hold_label_guard()", "DROP TRIGGER IF EXISTS trg_document_hold_label_guard");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF v_actor IS NULL THEN\s*\n\s*RETURN NEW;/);
    expect(fn).toMatch(/IF NEW\.current_version_id IS DISTINCT FROM OLD\.current_version_id THEN\s*\n\s*RETURN NEW;/);
    expect(fn).toMatch(/IF NEW\.rev IS NOT DISTINCT FROM OLD\.rev AND NEW\.revision IS NOT DISTINCT FROM OLD\.revision THEN\s*\n\s*RETURN NEW;/);
    expect(fn).toMatch(/IF is_org_controller\(NEW\.org_id\) THEN\s*\n\s*RETURN NEW;/);
    expect(fn).toMatch(/h\.document_id = NEW\.id AND h\.released_at IS NULL/);
    expect(fn).toMatch(/release the hold before changing its revision label\./);
    expect(m74).toMatch(/CREATE TRIGGER trg_document_hold_label_guard\s*\n\s*BEFORE UPDATE OF rev, revision ON documents/);
  });
  it("document_versions rail: revision_label rewrite on a version of a held document refused for a non-controller", () => {
    const fn = between(m74, "CREATE OR REPLACE FUNCTION enforce_version_hold_label_guard()", "DROP TRIGGER IF EXISTS trg_version_hold_label_guard");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF NEW\.revision_label IS NOT DISTINCT FROM OLD\.revision_label THEN\s*\n\s*RETURN NEW;/);
    expect(fn).toMatch(/SELECT d\.org_id INTO v_org FROM documents d WHERE d\.id = NEW\.record_id;/);
    expect(fn).toMatch(/IF v_org IS NULL OR is_org_controller\(v_org\) THEN\s*\n\s*RETURN NEW;/);
    expect(fn).toMatch(/h\.document_id = NEW\.record_id AND h\.released_at IS NULL/);
    expect(m74).toMatch(/CREATE TRIGGER trg_version_hold_label_guard\s*\n\s*BEFORE UPDATE OF revision_label ON document_versions/);
  });
  it("does NOT re-create the publish guard (P4 owns that body) and keeps the one-paste shape", () => {
    expect(m74).not.toMatch(/FUNCTION enforce_document_publish_guard/);
    expect(m74.indexOf("CREATE TEMP TABLE IF NOT EXISTS _dc_f74_before")).toBeLessThan(m74.indexOf("BEGIN;"));
    const tail = m74.slice(m74.indexOf("COMMIT;"));
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    expect((tail.match(/^UNION ALL$/gm) ?? []).length).toBe(4);
    expect(tail).toMatch(/prosrc LIKE '%\(NEW\.status = ''Archived'' AND COALESCE\(OLD\.status, ''''\) <> ''Archived''\)%'/);
  });
  it("the app path this rail closes is still the bare rewrite: correctRevisionLabel updates the version label, then the document label without current_version_id", () => {
    const rev = src("lib/revisions.ts");
    expect(rev).toMatch(/\.from\("document_versions"\)\s*\n\s*\.update\(\{ revision_label: check\.label \}\)/);
    expect(rev).toMatch(/\.update\(\{ rev: check\.label, revision: check\.label, updated_at: new Date\(\)\.toISOString\(\), updated_by: actorUserId \}\)/);
  });
});
