// notifications Round G, N4 — the reconcile pass (NEDGE-18, TRAIL-9, DEC-81 §2).
//
//   * reconcileClassOf: which condition retires which row; every other row
//     is left alone (it stays until its recipient reads it, as before).
//   * retireStaleAlerts (lib/notificationReconcileServer.ts): reads each id
//     back as the CALLER's own unread, unsuperseded row in the org, re-checks
//     its condition against the database, and marks only the gone ones
//     metadata.superseded_at — never read_at, never another column, never
//     another person's row; a check that cannot be read keeps the row.
//   * POST /api/notifications/reconcile: a signed-in, active member only.
//
// The database is an in-memory fake that applies the filters the code sends
// (eq / is / in / range), so "another person's row is not touched" is the
// filter doing it, not the fake assuming it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileClassOf, RECONCILE_MAX_IDS } from "@/lib/notificationReconcile";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is" | "in"; col: string; val: unknown };

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  fail: new Set<string>(),
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Array<{ op: string; col: string; val: unknown }> }>,
}));

function pick(row: Row, col: string): unknown {
  const m = col.match(/^(\w+)->>(\w+)$/);
  if (m) {
    const obj = row[m[1]] as Record<string, unknown> | null | undefined;
    const v = obj ? obj[m[2]] : undefined;
    return v === undefined || v === null ? null : String(v);
  }
  return row[col] ?? null;
}
function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = pick(row, f.col);
    if (f.op === "eq") return v === f.val;
    if (f.op === "is") return f.val === null ? v === null : v === f.val;
    if (f.op === "in") return (f.val as unknown[]).includes(v);
    return true;
  });
}
function from(table: string) {
  const filters: Filter[] = [];
  let patch: Record<string, unknown> | null = null;
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.update = (p: Record<string, unknown>) => { patch = p; return q; };
  for (const op of ["eq", "is", "in"] as const) q[op] = (col: string, val: unknown) => { filters.push({ op, col, val }); return q; };
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
    const run = () => {
      if (db.fail.has(table)) return { data: null, error: { message: `${table} refused` } };
      const rows = (db.tables[table] ?? []).filter((r) => matches(r, filters));
      if (patch) {
        db.updates.push({ table, patch, filters: [...filters] });
        for (const r of rows) Object.assign(r, patch);
        return { data: rows.map((r) => ({ id: r.id })), error: null };
      }
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    return Promise.resolve(run()).then(ok, ko);
  };
  return q;
}
const fakeDb = { from };

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const notif = (n: number, over: Row): Row => ({
  id: id(n), org_id: ORG, user_id: U, kind: "ticket_status", resource_type: "ticket", resource_id: null,
  metadata: null, read_at: null, ...over,
});

beforeEach(() => {
  db.tables = {};
  db.fail = new Set();
  db.updates = [];
});

describe("reconcileClassOf — which condition retires which row", () => {
  it("names the nine classes, and leaves every other row alone", () => {
    const r = (kind: string, resourceType: string | null, resourceId: string | null, metadata: Row | null) => reconcileClassOf({ kind, resourceType, resourceId, metadata });
    expect(r("ticket_status", "ticket", "t", { action: "assign", status: "DRAFTING" })).toBe("workflow");
    expect(r("hold_opened", "document", "d", null)).toBe("hold");
    expect(r("hold_opened", "document", "d", { staleHoldId: "h", staleFor: "age", escalation: true })).toBe("hold");
    expect(r("branch_open", "document", "d", { branchId: "b" })).toBe("branch");
    expect(r("branch_open", "document", "d", null)).toBe(null);
    expect(r("checkout_released", "document", "d", { staleSessionId: "s", escalation: true })).toBe("stale_checkout");
    expect(r("checkout_released", "document", "d", null)).toBe(null);
    expect(r("ack_requested", "document", "d", { ackRequest: true })).toBe("ack");
    expect(r("review_requested", "document", "d", null)).toBe("review");
    expect(r("review_invalidated", "document", "d", null)).toBe("review");
    expect(r("access_recert_due", "library", "l", null)).toBe("recert");
    expect(r("ack_overdue", "document", "d", null)).toBe("ack_escalation");
    expect(r("review_overdue", "document", "d", null)).toBe("review_escalation");
    // everything else: no condition retires it (it stays until read)
    for (const k of ["ticket_comment", "ticket_mention", "hold_released", "branch_resolved", "doc_superseded", "effective_now", "checkout_conflict", "overlap_advisory"]) {
      expect(r(k, "document", "d", null), k).toBe(null);
    }
    // a ticket activity row (metadata.activity + status, no action) is not a workflow alert — as on DF-P1
    expect(r("ticket_comment", "ticket", "t", { activity: "attach", status: "DRAFTING" })).toBe(null);
  });
});

describe("retireStaleAlerts — the server re-checks, then marks only the gone ones", () => {
  it("workflow: a ticket that moved on or left the workspace is retired; a live one, and a non-ticket id, are kept", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    db.tables.tickets = [
      { id: id(101), org_id: ORG, status: "DRAFTING" },
      { id: id(102), org_id: ORG, status: "PENDING_REVIEW" },
    ];
    db.tables.notifications = [
      notif(1, { resource_id: id(101), metadata: { action: "assign", status: "DRAFTING", extra: "kept" } }),
      notif(2, { resource_id: id(102), metadata: { action: "assign", status: "DRAFTING", extra: "kept" } }),
      notif(3, { resource_id: id(103), metadata: { action: "assign", status: "DRAFTING" } }),
      notif(4, { resource_id: "not-a-ticket-id", metadata: { action: "assign", status: "DRAFTING" } }),
    ];
    const now = new Date("2026-10-13T12:00:00Z");
    const a = await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [id(1), id(2), id(3), id(4)], now });
    expect(a.retired.sort()).toEqual([id(2), id(3)]);
    expect(a.kept).toBe(1);
    expect(a.failed).toBe(1); // the non-ticket id: unreadable → kept
    const n2 = db.tables.notifications.find((r) => r.id === id(2))!;
    expect(n2.metadata).toEqual({ action: "assign", status: "DRAFTING", extra: "kept", superseded_at: now.toISOString() });
    expect(n2.read_at).toBe(null);
    // the mark writes metadata only, guarded on the caller's own unread, unsuperseded row in the org
    for (const u of db.updates) {
      expect(Object.keys(u.patch)).toEqual(["metadata"]);
      expect(u.filters).toEqual(expect.arrayContaining([
        { op: "eq", col: "user_id", val: U }, { op: "eq", col: "org_id", val: ORG },
        { op: "is", col: "read_at", val: null }, { op: "is", col: "metadata->>superseded_at", val: null },
      ]));
    }
  });

  it("another person's row, a read row, an already superseded row and a row of another org are never touched", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    db.tables.tickets = [];
    const gone = { action: "assign", status: "DRAFTING" };
    db.tables.notifications = [
      notif(1, { user_id: OTHER, resource_id: id(101), metadata: gone }),
      notif(2, { read_at: "2026-10-12T00:00:00Z", resource_id: id(101), metadata: gone }),
      notif(3, { resource_id: id(101), metadata: { ...gone, superseded_at: "2026-10-12T00:00:00Z" } }),
      notif(4, { org_id: OTHER, resource_id: id(101), metadata: gone }),
    ];
    const before = JSON.stringify(db.tables.notifications);
    const a = await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [id(1), id(2), id(3), id(4)] });
    expect(a).toEqual({ retired: [], kept: 0, failed: 0 });
    expect(JSON.stringify(db.tables.notifications)).toBe(before);
    expect(db.updates).toEqual([]);
  });

  it("a check that cannot be read retires nothing (a failed read proves nothing)", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    db.fail.add("tickets");
    db.tables.notifications = [notif(1, { resource_id: id(101), metadata: { action: "assign", status: "DRAFTING" } })];
    const a = await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [id(1)] });
    expect(a).toEqual({ retired: [], kept: 0, failed: 1 });
    expect(db.updates).toEqual([]);
  });

  it("TRAIL-9: hold_opened is retired once no hold is open on the document; an aging nudge once ITS hold is released", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    const D1 = id(201), D2 = id(202), H_OPEN = id(301), H_DONE = id(302);
    db.tables.document_holds = [
      { id: H_OPEN, org_id: ORG, document_id: D1, released_at: null },
      { id: H_DONE, org_id: ORG, document_id: D2, released_at: "2026-10-12T00:00:00Z" },
    ];
    db.tables.notifications = [
      notif(1, { kind: "hold_opened", resource_type: "document", resource_id: D1 }),           // still held → kept
      notif(2, { kind: "hold_opened", resource_type: "document", resource_id: D2 }),           // released → retired
      notif(3, { kind: "hold_opened", resource_type: "document", resource_id: D2, metadata: { staleHoldId: H_DONE, staleFor: "age", escalation: true } }), // its hold released
      notif(4, { kind: "hold_opened", resource_type: "document", resource_id: D1, metadata: { staleHoldId: H_OPEN, staleFor: "age", escalation: true } }), // its hold open
      notif(5, { kind: "hold_released", resource_type: "document", resource_id: D2 }),         // the release notice itself stays
    ];
    const a = await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [1, 2, 3, 4, 5].map(id) });
    expect(a.retired.sort()).toEqual([id(2), id(3)]);
    expect(a.kept).toBe(3);
  });

  it("TRAIL-9 / DEC-81 Risk: branch_open is retired once its branch is resolved; a stale-checkout escalation once its session ended", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    const B_OPEN = id(401), B_DONE = id(402), S_ACTIVE = id(501), S_ENDED = id(502);
    db.tables.revision_branches = [
      { id: B_OPEN, org_id: ORG, resolved_at: null },
      { id: B_DONE, org_id: ORG, resolved_at: "2026-10-12T00:00:00Z" },
    ];
    db.tables.checkout_sessions = [
      { id: S_ACTIVE, org_id: ORG, status: "active" },
      { id: S_ENDED, org_id: ORG, status: "checked_in" },
    ];
    db.tables.notifications = [
      notif(1, { kind: "branch_open", resource_type: "document", resource_id: id(9), metadata: { branchId: B_OPEN } }),
      notif(2, { kind: "branch_open", resource_type: "document", resource_id: id(9), metadata: { branchId: B_DONE } }),
      notif(3, { kind: "branch_open", resource_type: "document", resource_id: id(9), metadata: { branchId: id(499) } }), // unknown branch: not proven resolved
      notif(4, { kind: "checkout_released", resource_type: "document", resource_id: id(9), metadata: { staleSessionId: S_ACTIVE, escalation: true } }),
      notif(5, { kind: "checkout_released", resource_type: "document", resource_id: id(9), metadata: { staleSessionId: S_ENDED, escalation: true } }),
    ];
    const a = await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [1, 2, 3, 4, 5].map(id) });
    expect(a.retired.sort()).toEqual([id(2), id(5)]);
    expect(a.kept).toBe(2);
    expect(a.failed).toBe(1);
  });

  it("DEC-81 §2: ack_requested is retired once nothing is owed on the document — roster or binding distribution confirmation", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    const D_ROSTER = id(601), D_DIST = id(602), D_DONE = id(603), D_OLDVER = id(604), D_RETIRED = id(605);
    db.tables.document_acknowledgments = [
      { org_id: ORG, assignee_user_id: U, document_id: D_ROSTER, status: "pending" },
      { org_id: ORG, assignee_user_id: U, document_id: D_DONE, status: "acknowledged" },
      { org_id: ORG, assignee_user_id: OTHER, document_id: D_DONE, status: "pending" }, // someone else's owed ack
    ];
    db.tables.distribution_acks = [
      { org_id: ORG, recipient_user_id: U, document_id: D_DIST, version_id: "v2", acknowledged_at: null },
      { org_id: ORG, recipient_user_id: U, document_id: D_OLDVER, version_id: "v1", acknowledged_at: null },  // not the current version
      { org_id: ORG, recipient_user_id: U, document_id: D_RETIRED, version_id: "v1", acknowledged_at: null }, // document retired
    ];
    db.tables.documents = [
      { id: D_ROSTER, org_id: ORG, current_version_id: "v1", status: "Issued" },
      { id: D_DIST, org_id: ORG, current_version_id: "v2", status: "Issued" },
      { id: D_DONE, org_id: ORG, current_version_id: "v1", status: "Issued" },
      { id: D_OLDVER, org_id: ORG, current_version_id: "v2", status: "Issued" },
      { id: D_RETIRED, org_id: ORG, current_version_id: "v1", status: "Superseded" },
    ];
    db.tables.notifications = [D_ROSTER, D_DIST, D_DONE, D_OLDVER, D_RETIRED].map((d, i) =>
      notif(i + 1, { kind: "ack_requested", resource_type: "document", resource_id: d, metadata: { ackRequest: true } }));
    const a = await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [1, 2, 3, 4, 5].map(id) });
    expect(a.retired.sort()).toEqual([id(3), id(4), id(5)]);
    expect(a.kept).toBe(2);
  });

  it("DEC-81 §2: review_requested / review_invalidated are retired once no sign-off is owed on the draft in review; access_recert_due once not due", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    const D_OWED = id(701), D_SIGNED = id(702), D_PUBLISHED = id(703), L_DUE = id(801), L_CURRENT = id(802);
    db.tables.document_review_signoffs = [
      { org_id: ORG, reviewer_user_id: U, document_id: D_OWED, document_version_id: "draft-1", status: "pending" },
      { org_id: ORG, reviewer_user_id: U, document_id: D_SIGNED, document_version_id: "draft-2", status: "signed" },
      { org_id: ORG, reviewer_user_id: U, document_id: D_PUBLISHED, document_version_id: "draft-3", status: "pending" }, // its draft is gone
    ];
    db.tables.documents = [
      { id: D_OWED, org_id: ORG, pending_version_id: "draft-1" },
      { id: D_SIGNED, org_id: ORG, pending_version_id: "draft-2" },
      { id: D_PUBLISHED, org_id: ORG, pending_version_id: null },
    ];
    const soon = new Date(); soon.setDate(soon.getDate() + 5);
    const later = new Date(); later.setDate(later.getDate() + 200);
    db.tables.libraries = [
      { id: L_DUE, org_id: ORG, next_recertification_date: soon.toISOString().slice(0, 10) },
      { id: L_CURRENT, org_id: ORG, next_recertification_date: later.toISOString().slice(0, 10) },
    ];
    db.tables.notifications = [
      notif(1, { kind: "review_requested", resource_type: "document", resource_id: D_OWED }),
      notif(2, { kind: "review_requested", resource_type: "document", resource_id: D_SIGNED }),
      notif(3, { kind: "review_invalidated", resource_type: "document", resource_id: D_PUBLISHED }),
      notif(4, { kind: "access_recert_due", resource_type: "library", resource_id: L_DUE }),
      notif(5, { kind: "access_recert_due", resource_type: "library", resource_id: L_CURRENT }),
    ];
    const a = await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [1, 2, 3, 4, 5].map(id) });
    expect(a.retired.sort()).toEqual([id(2), id(3), id(5)]);
    expect(a.kept).toBe(2);
  });

  it("DEC-81 §2: an ack_overdue copy is retired once NOBODY owes on the document; a review_overdue copy once no draft is in review", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    const D_OWED = id(901), D_CLEAR = id(902), D_DIST = id(903), D_DRAFT = id(904), D_NODRAFT = id(905);
    db.tables.document_acknowledgments = [
      { org_id: ORG, assignee_user_id: OTHER, document_id: D_OWED, status: "pending" },   // someone else still owes
      { org_id: ORG, assignee_user_id: OTHER, document_id: D_CLEAR, status: "acknowledged" },
    ];
    db.tables.distribution_acks = [
      { org_id: ORG, recipient_user_id: OTHER, document_id: D_DIST, version_id: "v1", acknowledged_at: null },
    ];
    db.tables.documents = [
      { id: D_OWED, org_id: ORG, current_version_id: "v1", status: "Issued", pending_version_id: null },
      { id: D_CLEAR, org_id: ORG, current_version_id: "v1", status: "Issued", pending_version_id: null },
      { id: D_DIST, org_id: ORG, current_version_id: "v1", status: "Issued", pending_version_id: null },
      { id: D_DRAFT, org_id: ORG, current_version_id: "v1", status: "Issued", pending_version_id: "draft-9" },
      { id: D_NODRAFT, org_id: ORG, current_version_id: "v1", status: "Issued", pending_version_id: null },
    ];
    db.tables.notifications = [
      notif(1, { kind: "ack_overdue", resource_type: "document", resource_id: D_OWED }),
      notif(2, { kind: "ack_overdue", resource_type: "document", resource_id: D_CLEAR }),
      notif(3, { kind: "ack_overdue", resource_type: "document", resource_id: D_DIST }),
      notif(4, { kind: "review_overdue", resource_type: "document", resource_id: D_DRAFT }),
      notif(5, { kind: "review_overdue", resource_type: "document", resource_id: D_NODRAFT }),
      notif(6, { kind: "review_overdue", resource_type: "document", resource_id: id(999) }), // unreadable document: kept
    ];
    const a = await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [1, 2, 3, 4, 5, 6].map(id) });
    expect(a.retired.sort()).toEqual([id(2), id(5)]);
    expect(a.kept).toBe(3);
    expect(a.failed).toBe(1);
  });

  it("rows no condition retires are counted kept and untouched; at most RECONCILE_MAX_IDS ids are read", async () => {
    const { retireStaleAlerts } = await import("@/lib/notificationReconcileServer");
    db.tables.notifications = [notif(1, { kind: "ticket_comment", resource_id: id(101) }), notif(2, { kind: "effective_now", resource_type: "document", resource_id: id(9) })];
    expect(await retireStaleAlerts(fakeDb, { orgId: ORG, uid: U, ids: [id(1), id(2)] })).toEqual({ retired: [], kept: 2, failed: 0 });
    expect(db.updates).toEqual([]);
    expect(RECONCILE_MAX_IDS).toBe(200);
  });
});

// ── the route ───────────────────────────────────────────────────────────────
const route = vi.hoisted(() => ({ user: null as null | { id: string }, member: null as null | Row, memberError: null as null | { message: string }, calls: [] as unknown[] }));
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => (route.user ? { data: { user: route.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (table: string) => {
      if (table === "org_members") {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: route.member, error: route.memberError });
        return q;
      }
      return from(table);
    },
  },
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));

const post = async (body: unknown, auth = "Bearer tok") => {
  const { POST } = await import("@/app/api/notifications/reconcile/route");
  const req = { headers: { get: (k: string) => (k === "authorization" ? auth : null) }, json: async () => body };
  return POST(req as never) as unknown as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;
};

describe("POST /api/notifications/reconcile — a signed-in, active member, about their own rows", () => {
  beforeEach(() => { route.user = { id: U }; route.member = { uid: U }; route.memberError = null; });

  it("401 without a token, 400 without orgId / ids, 403 for a non-member, 503 when membership cannot be read", async () => {
    expect((await post({ orgId: ORG, ids: [] }, "")).status).toBe(401);
    route.user = null;
    expect((await post({ orgId: ORG, ids: [] })).status).toBe(401);
    route.user = { id: U };
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ orgId: ORG })).status).toBe(400);
    expect((await post({ orgId: ORG, ids: Array.from({ length: RECONCILE_MAX_IDS + 1 }, (_, i) => id(i)) })).status).toBe(400);
    route.member = null;
    expect((await post({ orgId: ORG, ids: [id(1)] })).status).toBe(403);
    route.memberError = { message: "down" };
    expect((await post({ orgId: ORG, ids: [id(1)] })).status).toBe(503);
  });

  it("retires the caller's gone rows and answers which", async () => {
    db.tables.tickets = [];
    db.tables.notifications = [notif(1, { resource_id: id(101), metadata: { action: "assign", status: "DRAFTING" } })];
    const res = await post({ orgId: ORG, ids: [id(1)] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retired: [id(1)], kept: 0, failed: 0 });
  });
});
