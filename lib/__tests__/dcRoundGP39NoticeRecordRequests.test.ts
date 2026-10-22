// document-control Round G — P39 NOTICE RECORD REQUESTS (DIST-20; DIST-19's
// remaining done-whens; drafting-flow EVID-8's document half).
//
// Driven through the REAL request paths (lib/distributionAcks requestAcks /
// renudgeUnacked / scanDistributionAcks, lib/acknowledgments
// recomputeDocumentAck / nudgeAcknowledgment, lib/reviewControl
// openReviewRoster / activateAlternate), the REAL lib/documentNoticeRecord,
// lib/inAppNotifications, lib/complianceNotify, lib/notify/dispatch and
// lib/audit, on a filter-aware in-memory client — and the REAL route
// (app/api/documents/notice-record) with the caller's checks stood in.
//
// Pinned:
//   · every request and every manual reminder / activation is ONE
//     document_notice_events row per person once its bell row LANDED
//     (delivered / reminded / alternate_activated), naming that bell row
//     (notification_id) and dated when it landed; a refused bell row leaves
//     none; a repeat writes nothing twice; the scans' rows name their bell
//     rows too (DIST-19 residual (c));
//   · REGRESSION (DEC-90 ruling (1)): the same bells, stamps and audit rows
//     whether the record is written, refused or not in the database; a record
//     failure never fails the action (deferred to the audit log and replayed
//     by the source's scan, as P38);
//   · notifyChecked's contract is unchanged; the id comes back additively;
//   · the browser path: the notices go to the route, which builds every row
//     from the bell row it reads itself — never from what the body claims;
//   · the distribution nag's cooldown reads the record ONLY once 20261257 is
//     in place: a manual re-nudge (now a reminded row) still holds the robot's
//     nudge for one cooldown, after its bell row is purged; before the paste
//     (or a refused / capped read) the bell rows count, exactly as today.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[] | undefined>,
  failBellFor: new Set<string>(),
  /** the next N bell inserts fail with a transient error (a statement timeout) */
  transientBellFailures: 0,
  noticeError: null as null | { code?: string; message: string },
  /** reads of each table so far */
  reads: {} as Record<string, number>,
  refuseReadOf: new Set<string>(),
  session: null as null | { access_token: string; user: { id: string } },
  /** 20261160 pasted: a browser's bell row with no actor is stamped with its writer */
  stampActor: null as null | string,
  seq: 0,
}));

const unq = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);
function parseOr(expr: string, all = false): (r: Row) => boolean {
  const parts = expr.split(/,(?![^(]*\))/);
  const preds = parts.map((p) => {
    let m: RegExpExecArray | null;
    if ((m = /^and\((.*)\)$/.exec(p))) return parseOr(m[1], true);
    if ((m = /^(\w+)\.eq\.(.+)$/.exec(p))) { const col = m[1]; const v = unq(m[2]); return (r: Row) => r[col] != null && String(r[col]) === v; }
    if ((m = /^(\w+)\.lt\.(.+)$/.exec(p))) { const col = m[1]; const v = unq(m[2]); return (r: Row) => r[col] != null && String(r[col]) < v; }
    return () => false;
  });
  return all ? (r) => preds.every((p) => p(r)) : (r) => preds.some((p) => p(r));
}

function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let update: Row | null = null;
  let insert: Row[] | null = null;
  let upsertIgnore = false;
  const orders: Array<{ col: string; asc: boolean }> = [];
  let limit = Infinity;
  const matching = () => {
    let rows = (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const { col, asc } of orders) {
          const x = String(a[col]); const y = String(b[col]);
          if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
    }
    return rows.slice(0, limit);
  };
  const run = (): { data: unknown; error: unknown; count?: number } => {
    if (insert) {
      const rows = insert;
      if (table === "notifications" && db.transientBellFailures > 0) {
        db.transientBellFailures -= 1;
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }
      if (table === "notifications" && rows.some((r) => db.failBellFor.has(String(r.user_id)))) {
        return { data: null, error: { code: "42501", message: "permission denied for table notifications" } };
      }
      if (table === "notifications" && rows.some((r) => r.id != null && (db.tables.notifications ?? []).some((x) => x.id === r.id))) {
        return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "notifications_pkey"' } };
      }
      if (table === "document_notice_events") {
        if (db.tables.document_notice_events === undefined) return { data: null, error: { code: "42P01", message: 'relation "public.document_notice_events" does not exist' } };
        if (db.noticeError) return { data: null, error: db.noticeError };
      }
      const at = new Date().toISOString();
      const t = (db.tables[table] ??= []);
      if (table === "notifications" && db.stampActor) for (const r of rows) if (r.actor_user_id == null) r.actor_user_id = db.stampActor;
      for (const r of rows) {
        if (upsertIgnore && r.id != null && t.some((x) => x.id === r.id)) continue;
        // a stored row's id is a UUID, as the column's default makes it
        t.push({ id: `00000000-0000-4000-a000-${String(++db.seq).padStart(12, "0")}`, created_at: at, timestamp: at, ...r });
      }
      return { data: null, error: null, count: rows.length };
    }
    if (update) {
      const hit = matching();
      for (const r of hit) Object.assign(r, update);
      return { data: hit, error: null };
    }
    db.reads[table] = (db.reads[table] ?? 0) + 1;
    if (db.refuseReadOf.has(table)) return { data: null, error: { code: "42501", message: `permission denied for table ${table}` } };
    if (table === "document_notice_events" && db.tables[table] === undefined) return { data: null, error: { code: "42P01", message: 'relation "public.document_notice_events" does not exist' } };
    return { data: matching(), error: null };
  };
  const self: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => { try { resolve(run()); } catch (e) { reject(e); } };
      return (...args: unknown[]) => {
        const [col, a1, a2] = args as [string, unknown, unknown];
        switch (prop) {
          case "eq": preds.push((r) => r[col] === a1); break;
          case "neq": preds.push((r) => r[col] !== a1); break;
          case "in": preds.push((r) => (a1 as unknown[]).includes(r[col])); break;
          case "is": preds.push((r) => (a1 === null ? r[col] == null : r[col] === a1)); break;
          case "lte": preds.push((r) => r[col] != null && String(r[col]) <= String(a1)); break;
          case "lt": preds.push((r) => r[col] != null && String(r[col]) < String(a1)); break;
          case "gte": preds.push((r) => r[col] != null && String(r[col]) >= String(a1)); break;
          case "not": if (a1 === "is") preds.push((r) => !(a2 === null ? r[col] == null : r[col] === a2)); else if (a1 === "eq") preds.push((r) => r[col] !== a2); break;
          case "or": preds.push(parseOr(String(col))); break;
          case "order": orders.push({ col, asc: (a1 as { ascending?: boolean } | undefined)?.ascending !== false }); break;
          case "limit": limit = Number(col); break;
          case "update": update = args[0] as Row; break;
          case "insert": insert = (Array.isArray(args[0]) ? args[0] : [args[0]]) as Row[]; break;
          case "upsert":
            insert = (Array.isArray(args[0]) ? args[0] : [args[0]]) as Row[];
            upsertIgnore = (args[1] as { ignoreDuplicates?: boolean } | undefined)?.ignoreDuplicates === true;
            break;
          case "select": break;
          case "maybeSingle": case "single": { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }); }
        }
        return new Proxy(self, h);
      };
    },
  };
  return new Proxy(self, h);
}
const memoryClient = { from: (t: string) => chain(t) };

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: db.session }, error: null }) },
  },
}));

// The route's caller checks, stood in (lib/serverAuth.ts is the shared gate,
// pinned elsewhere): who the caller is, and whether their own session reads
// the document.
const auth = vi.hoisted(() => ({
  actor: null as null | { userId: string; email: string },
  status: 401,
  unreadable: new Set<string>(),
}));
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: async () => (auth.actor
    ? { userId: auth.actor.userId, email: auth.actor.email, orgId: "o1", role: "Viewer", roles: ["Viewer"], admin: { from: (t: string) => chain(t) } }
    : { error: "Unauthorized", status: auth.status }),
  callerScopedClient: () => ({
    from: (t: string) => {
      const c = chain(t) as unknown as { eq: (k: string, v: unknown) => unknown };
      if (t !== "documents") return c;
      // the documents policies, ACL included: an unreadable document reads as no row
      return {
        select: () => ({
          eq: (_k: string, v: unknown) => ({
            maybeSingle: async () => (auth.unreadable.has(String(v))
              ? { data: null, error: null }
              : { data: (db.tables.documents ?? []).find((d) => d.id === v) ?? null, error: null }),
          }),
        }),
      };
    },
  }),
}));
vi.mock("@/lib/serverClientScope", () => ({ runWithServerClient: (_c: unknown, fn: () => Promise<unknown>) => fn() }));

import { NextRequest } from "next/server";
import { __setComplianceRetrySleep, __resetComplianceBreaker, notifyCompliance } from "@/lib/complianceNotify";
import { afterResponseNoticeRecord } from "@/lib/noticeRecordAfterResponse";
import { runComplianceScan } from "@/lib/complianceNotifyScope";
import { notifyChecked, notifyCheckedId, notifyWithReason, newNotificationId } from "@/lib/inAppNotifications";
import { recomputeDocumentAck, nudgeAcknowledgment, scanAndNotifyAcks, setAckPolicy } from "@/lib/acknowledgments";
import { openReviewRoster, activateAlternate, scanReviews } from "@/lib/reviewControl";
import { requestAcks, renudgeUnacked, scanDistributionAcks, type DistributionAck } from "@/lib/distributionAcks";
import {
  COOLDOWN_NOTICE_PAGES, COOLDOWN_NOTICE_ROWS, DOCUMENT_NOTICE_RECORD_DEFERRED, NOTICE_KEEPALIVE_MAX_BODY, NOTICE_RECORD_ROUTE,
  NOTICE_SINCE_MARGIN_MS, NOTICE_VERIFY_WINDOW_MS, REQUEST_BATCH_MAX, REQUEST_NOTICE_MAX, __settleNoticeRecords,
  bellKindsFor, deferredNoticeRow, noticeRecordBodies, noticeRow, parseRequestNoticeBatch, parseRequestNoticeBody, recentDistributionNotices, recordRequestNotices, requestNoticeDetails, requestNoticeId, verifiedRequestRows,
} from "@/lib/documentNoticeRecord";
import { POST } from "@/app/api/documents/notice-record/route";

// ids as UUIDs (the route and the builder take only UUIDs)
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = U(9);
const DOC = U(1);
const VER = U(2);
const LIB = U(3);
const CTRL = U(10);
const OWN = U(11);
const ASG = U(12);
const REV = U(13);
const ALT = U(14);
const OTHER = U(15);

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const daysBefore = (n: number) => iso(T0 - n * DAY);

const bells = (kind?: string) => (db.tables.notifications ?? []).filter((n) => !kind || n.kind === kind);
const bellsTo = (uid: string, kind?: string) => bells(kind).filter((n) => n.user_id === uid);
const events = (kind?: string) => (db.tables.document_notice_events ?? []).filter((e) => !kind || e.kind === kind);
const audits = (action: string) => (db.tables.audit_logs ?? []).filter((a) => a.action === action);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  db.seq = 0;
  db.noticeError = null;
  db.reads = {};
  db.refuseReadOf = new Set();
  db.failBellFor = new Set();
  db.transientBellFailures = 0;
  db.session = null;
  db.stampActor = null;
  auth.actor = null;
  auth.status = 401;
  auth.unreadable = new Set();
  db.tables = {
    org_members: [CTRL, OWN, ASG, REV, ALT, OTHER].map((uid, i) => ({ uid, org_id: ORG, status: "active", role: i === 0 ? "DocCtrl" : "Engineer-1", roles: i === 0 ? ["DocCtrl"] : ["Engineer-1"], display_name: `M${i}`, email: `m${i}@x.test` })),
    libraries: [{ id: LIB, org_id: ORG, name: "Drawings", owner_user_id: null, owner_name: null, owner_team_id: null, review_control: null, ack_policy: null }],
    documents: [{ id: DOC, org_id: ORG, library_id: LIB, collection_id: null, status: "Issued", current_version_id: VER, document_number: "P-1", title: null, name: null, ack_policy: { enabled: true, assigneeIds: [ASG, REV] }, owner_user_id: OWN, owner_name: "Olive", review_control: null }],
    document_versions: [{ id: VER, document_id: DOC, version_label: "C", rev_label: "C", content_hash: "h", created_by: OWN }],
    collections: [],
    teams: [],
    notifications: [],
    audit_logs: [],
    document_notice_events: [],
    document_acknowledgments: [],
    document_review_signoffs: [],
    distribution_acks: [],
  };
  __setComplianceRetrySleep(async () => undefined);
  __resetComplianceBreaker();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  __setComplianceRetrySleep(null);
  __resetComplianceBreaker();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── the bell row's id (DIST-19 residual (c)) ────────────────────────────────

describe("lib/inAppNotifications — the bell row's id, additively", () => {
  const input = { orgId: ORG, userId: ASG, kind: "ack_requested" as const, title: "T", resourceType: "document", resourceId: DOC };

  it("REGRESSION: without an id, notifyChecked answers a boolean and the row carries the column's default, exactly as before", async () => {
    expect(await notifyChecked(input)).toBe(true);
    expect(await notifyWithReason(input)).toEqual({ ok: true });
    expect(bells().every((b) => String(b.id).startsWith("00000000-0000-4000-a000-"))).toBe(true);   // the default's
  });

  it("with an id the row is written under it and the answer carries it; notifyCheckedId chooses one when the input names none", async () => {
    const id = newNotificationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await notifyWithReason({ ...input, id })).toEqual({ ok: true, id });
    expect(bells()[0].id).toBe(id);
    const chosen = await notifyCheckedId(input);
    expect(chosen).toMatch(/^[0-9a-f-]{36}$/);
    expect(bells().map((b) => b.id)).toContain(chosen);
  });

  it("a retry of the same id is the row already there (23505 on notifications_pkey) — answered as landed, never a second copy; without an id a unique refusal stays a refusal", async () => {
    const id = newNotificationId();
    await notifyWithReason({ ...input, id });
    expect(await notifyWithReason({ ...input, id })).toEqual({ ok: true, id });
    expect(bells()).toHaveLength(1);
    db.failBellFor.add(ASG);
    expect(await notifyCheckedId(input)).toBeNull();
  });

  it("merge-time fix — notification_id never names a bell row that did not land: the first insert fails and a same-title sibling exists — the read-back matches the writer's id, so the sibling is not taken for it (refused for good: not landed; a transient failure: retried under the same id, which lands)", async () => {
    // a sibling: same person, kind, title, resource and (no) actor, written since the attempt began
    const sibling = { id: U(6100), org_id: ORG, user_id: ASG, kind: "ack_requested", title: "T", resource_type: "document", resource_id: DOC, actor_user_id: null, created_at: iso(T0) };
    db.tables.notifications = [{ ...sibling }];
    db.failBellFor.add(ASG);
    const id = newNotificationId();
    expect(await notifyCompliance({ ...input, id })).toBe(false);          // before the fix: true, by the sibling
    expect(bells().map((b) => b.id)).toEqual([sibling.id]);
    // a transient failure: the retry under the same id lands — the id names a real row
    db.failBellFor.clear();
    db.transientBellFailures = 1;
    const id2 = newNotificationId();
    expect(await notifyCompliance({ ...input, id: id2 })).toBe(true);
    expect(bells().map((b) => b.id)).toEqual([sibling.id, id2]);
    // without an id: exactly as before (the sibling settles it)
    db.transientBellFailures = 1;
    expect(await notifyCompliance(input)).toBe(true);
    expect(bells()).toHaveLength(2);
  });

  it("merge-time fix — the scan writes no record row naming a bell row that never landed: its reminder refused, a same-title sibling present", async () => {
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending", notified_at: daysBefore(9), assigned_at: daysBefore(9) }];
    db.tables.notifications = [{ id: U(6101), org_id: ORG, user_id: ASG, kind: "ack_requested", title: "Reminder — acknowledge P-1 Rev C", resource_type: "document", resource_id: DOC, actor_user_id: null, created_at: iso(T0) }];
    db.failBellFor.add(ASG);
    await runComplianceScan(`read-understood@${ORG}`, () => scanAndNotifyAcks(ORG), [], null);
    expect(events("reminded")).toEqual([]);                                // not "landed" by the sibling
    const ids = new Set(bells().map((b) => b.id));
    for (const e of events()) expect(e.notification_id == null || ids.has(e.notification_id)).toBe(true);
    expect(events().map((e) => e.notification_id)).not.toContain(U(6101));
  });
});

// ── the builder: every row from the bell row that landed ───────────────────

describe("verifiedRequestRows — a request path's row is built from the bell row it reads, never from the caller's word", () => {
  const bell = (over: Row = {}): Row => ({ id: U(500 + db.seq++), org_id: ORG, user_id: ASG, kind: "ack_requested", resource_type: "document", resource_id: DOC, actor_user_id: CTRL, actor_name: "Cal", metadata: { ackRequest: true }, created_at: iso(T0 - 60_000), ...over });
  const ackRow = (over: Row = {}): Row => ({ id: U(900), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: ASG, ...over });
  const input = (notices: Array<Record<string, unknown>>, over: Row = {}) => ({ orgId: ORG, documentId: DOC, source: "distribution_ack" as const, versionId: VER, notices: notices as never, ...over });
  const writer = { uid: CTRL, name: "cal@x.test" };

  it("named by id: the row names that bell row, is dated when it landed, takes the obligation row's id and label, and its id is the bell id's (version 8)", async () => {
    const b = bell();
    db.tables.notifications = [b];
    db.tables.distribution_acks = [ackRow()];
    const { rows, unmatched } = await verifiedRequestRows(memoryClient, input([{ kind: "delivered", recipient: ASG, notificationId: b.id }]), writer, T0);
    expect(unmatched).toBe(0);
    expect(rows).toEqual([{
      id: requestNoticeId(String(b.id)), org_id: ORG, document_id: DOC, version_id: VER, revision_label: "C",
      source: "distribution_ack", source_id: U(900), kind: "delivered", recipient: ASG, subject_user_id: ASG,
      notification_id: b.id, actor_name: "cal@x.test", details: { byMember: true }, noticed_at: b.created_at,
    }]);
    expect(rows[0].id).not.toBe(b.id);
    expect(rows[0].id.charAt(14)).toBe("8");
  });

  it("refuses a bell row that is not this notice's: another document, another person, another kind, another writer, too old, dated ahead, already taken", async () => {
    db.tables.distribution_acks = [ackRow()];
    const cases: Row[] = [
      bell({ resource_id: U(77) }), bell({ user_id: OTHER }), bell({ kind: "doc_recalled" }), bell({ actor_user_id: OTHER }),
      bell({ created_at: iso(T0 - NOTICE_VERIFY_WINDOW_MS - 1000) }), bell({ created_at: iso(T0 + 5 * 60_000) }), bell({ resource_type: "ticket" }),
    ];
    for (const b of cases) {
      db.tables.notifications = [b];
      const r = await verifiedRequestRows(memoryClient, input([{ kind: "delivered", recipient: ASG, notificationId: b.id }]), writer, T0);
      expect(r, JSON.stringify(b)).toEqual({ rows: [], unmatched: 1 });
    }
  });

  it("a distribution notice only takes an ackRequest bell row; a read-&-understood notice only one without it", async () => {
    db.tables.distribution_acks = [ackRow()];
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending" }];
    const plain = bell({ metadata: null });
    const flagged = bell();
    db.tables.notifications = [plain, flagged];
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "delivered", recipient: ASG, notificationId: plain.id }]), writer, T0)).rows).toEqual([]);
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "delivered", recipient: ASG, notificationId: flagged.id }], { source: "acknowledgment" }), writer, T0)).rows).toEqual([]);
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "delivered", recipient: ASG, notificationId: plain.id }], { source: "acknowledgment" }), writer, T0)).rows).toHaveLength(1);
  });

  it("named by no id (an emit() fan-out): the newest bell row THIS writer wrote since the action began — never an older one, never another writer's; each bell row taken once", async () => {
    db.tables.distribution_acks = [ackRow()];
    const older = bell({ created_at: iso(T0 - 10 * 60_000) });
    const others = bell({ actor_user_id: OTHER, created_at: iso(T0 - 30_000) });
    db.tables.notifications = [older, others];
    const since = iso(T0 - 2 * 60_000);
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG }], { since }), writer, T0)).rows).toEqual([]);
    const mine = bell({ created_at: iso(T0 - 20_000) });
    db.tables.notifications.push(mine);
    const r = await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG }, { kind: "reminded", recipient: ASG }], { since }), writer, T0);
    expect(r.rows.map((x) => x.notification_id)).toEqual([mine.id]);
    expect(r.unmatched).toBe(1);
  });

  it("no obligation row (or one that is not the named one), no row; a refused read throws (the caller says it, nothing is written)", async () => {
    const b = bell();
    db.tables.notifications = [b];
    db.tables.distribution_acks = [ackRow({ recipient_user_id: OTHER })];
    expect(await verifiedRequestRows(memoryClient, input([{ kind: "delivered", recipient: ASG, notificationId: b.id }]), writer, T0)).toEqual({ rows: [], unmatched: 1 });
    db.tables.distribution_acks = [ackRow()];
    expect(await verifiedRequestRows(memoryClient, input([{ kind: "delivered", recipient: ASG, notificationId: b.id, sourceId: U(999) }]), writer, T0)).toEqual({ rows: [], unmatched: 1 });
    db.refuseReadOf.add("notifications");
    await expect(verifiedRequestRows(memoryClient, input([{ kind: "delivered", recipient: ASG, notificationId: b.id }]), writer, T0)).rejects.toThrow(/bell rows could not be read/);
  });

  it("the server path writes once; a repeat writes nothing twice (the row id is the bell row's)", async () => {
    const b = bell({ actor_user_id: null });
    db.tables.notifications = [b];
    db.tables.distribution_acks = [ackRow()];
    expect(await recordRequestNotices(input([{ kind: "delivered", recipient: ASG, notificationId: b.id }]))).toBe("written");
    expect(await recordRequestNotices(input([{ kind: "delivered", recipient: ASG, notificationId: b.id }]))).toBe("written");
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ actor_name: "Cal", details: {} });   // a server notice with no actor is not a member's
  });

  it("the bell kinds a notice may be are the ones its path writes today", () => {
    expect(bellKindsFor("distribution_ack", "delivered")).toEqual(["ack_requested"]);
    expect(bellKindsFor("acknowledgment", "reminded")).toEqual(["ack_requested"]);
    expect(bellKindsFor("review_signoff", "delivered")).toEqual(["review_requested"]);
    expect(bellKindsFor("review_signoff", "alternate_activated")).toEqual(["review_alternate_activated"]);
    expect(bellKindsFor("distribution_ack", "alternate_activated")).toEqual([]);
  });

  // ── P39 fix pass ──
  it("a browser clock running FAST never loses the notice: a `since` later than the server's clock is ignored and the whole window is searched", async () => {
    db.tables.distribution_acks = [ackRow()];
    // the shop-floor PC is 2 minutes fast: since = server now + 2 min; the bell row landed 1 s ago (database time)
    const b = bell({ created_at: iso(T0 - 1000) });
    db.tables.notifications = [b];
    const r = await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG }], { since: iso(T0 + 2 * 60_000) }), writer, T0);
    expect(r).toMatchObject({ unmatched: 0, rows: [expect.objectContaining({ notification_id: b.id })] });
    // a since just behind the server's clock is trusted, with NOTICE_SINCE_MARGIN_MS of room
    const r2 = await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG }], { since: iso(T0 - 1000 + NOTICE_SINCE_MARGIN_MS - 1) }), writer, T0 + NOTICE_SINCE_MARGIN_MS);
    expect(r2.rows.map((x) => x.notification_id)).toEqual([b.id]);
  });

  it("a bell row with no actor (a scan's own notice) is taken only on the server path with no writer — never for a member", async () => {
    db.tables.distribution_acks = [ackRow()];
    const scans = bell({ actor_user_id: null, actor_name: "System", metadata: { ackRequest: true, autoNag: true } });
    db.tables.notifications = [scans];
    expect(await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: scans.id, details: { manual: true } }]), { uid: ASG, name: "a" }, T0)).toEqual({ rows: [], unmatched: 1 });
    expect(await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: scans.id, details: { manual: true } }]), writer, T0)).toEqual({ rows: [], unmatched: 1 });
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: scans.id }]), { uid: null, name: null }, T0)).rows).toHaveLength(1);
  });

  it("a bell row already on the record under a scan's row is never recorded a second time; a repeat of this request's own row is left to ON CONFLICT", async () => {
    db.tables.distribution_acks = [ackRow()];
    const b = bell();
    db.tables.notifications = [b];
    db.tables.document_notice_events = [{ id: U(7001), org_id: ORG, document_id: DOC, source: "distribution_ack", kind: "reminded", recipient: ASG, notification_id: b.id, noticed_at: b.created_at }];
    expect(await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: b.id }]), writer, T0)).toEqual({ rows: [], unmatched: 1 });
    db.tables.document_notice_events = [{ id: requestNoticeId(String(b.id)), org_id: ORG, document_id: DOC, source: "distribution_ack", kind: "reminded", recipient: ASG, notification_id: b.id, noticed_at: b.created_at }];
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: b.id }]), writer, T0)).rows).toHaveLength(1);
    // before 20261257 the check reads nothing (nothing would be written either); a refused read throws
    db.tables.document_notice_events = undefined;
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: b.id }]), writer, T0)).rows).toHaveLength(1);
    db.tables.document_notice_events = [];
    db.refuseReadOf.add("document_notice_events");
    await expect(verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: b.id }]), writer, T0)).rejects.toThrow(/record could not be read/);
  });

  it("what the caller claims is bounded: the subject is the recipient, and the details are `manual` alone on a reminder or activation (none on a request)", async () => {
    db.tables.distribution_acks = [ackRow(), ackRow({ id: U(902), recipient_user_id: OTHER })];
    const b = bell();
    db.tables.notifications = [b];
    expect(await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, subject: OTHER, notificationId: b.id }]), writer, T0)).toEqual({ rows: [], unmatched: 1 });
    const r = await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: b.id, details: { manual: true, escalated: true, ageDays: 999 } }]), writer, T0);
    expect(r.rows[0]).toMatchObject({ subject_user_id: ASG, details: { manual: true, byMember: true } });
    expect(Object.keys(r.rows[0].details).sort()).toEqual(["byMember", "manual"]);
    expect(requestNoticeDetails("delivered", { manual: true })).toEqual({});
    expect(requestNoticeDetails("alternate_activated", { manual: true, cause: "x" })).toEqual({ manual: true });
    expect(requestNoticeDetails("reminded", { manual: "yes" })).toEqual({});
  });

  // ── P39 second fix pass: the obligation's own state ──
  it("a distribution or read-&-understood notice only for an open obligation: never a chase of a confirmation already given, a waived or a voided roster row", async () => {
    const b = bell();
    db.tables.notifications = [b];
    db.tables.distribution_acks = [ackRow({ acknowledged_at: iso(T0 - DAY) })];
    expect(await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: b.id, details: { manual: true } }]), writer, T0)).toEqual({ rows: [], unmatched: 1 });
    db.tables.distribution_acks = [ackRow({ acknowledged_at: null })];
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: b.id, details: { manual: true } }]), writer, T0)).rows).toHaveLength(1);
    const plain = bell({ metadata: null });
    db.tables.notifications = [plain];
    for (const status of ["acknowledged", "waived", "void"]) {
      db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status }];
      expect(await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: plain.id, details: { manual: true } }], { source: "acknowledgment" }), writer, T0), status).toEqual({ rows: [], unmatched: 1 });
    }
    // a pending row on the current revision is taken even when the person has a completed row on an older one
    db.tables.document_acknowledgments = [
      { id: U(903), org_id: ORG, document_id: DOC, document_version_id: U(3), revision_label: "B", assignee_user_id: ASG, status: "acknowledged" },
      { id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending" },
    ];
    const r = await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: plain.id, details: { manual: true } }], { source: "acknowledgment", versionId: null }), writer, T0);
    expect(r.rows.map((x) => x.source_id)).toEqual([U(901)]);
  });

  it("a review notice only for an unsigned, active sign-off on the draft under review; an activation only of an ALTERNATE slot already activated — never once the record holds that activation under another row", async () => {
    const REVIEW = { source: "review_signoff" as const, versionId: null };
    const signoff = (over: Row = {}): Row => ({ id: U(700), org_id: ORG, document_id: DOC, document_version_id: VER, reviewer_user_id: ALT, revision_label: "2A", slot: "alternate", activated: true, status: "pending", ...over });
    const act = bell({ user_id: ALT, kind: "review_alternate_activated", metadata: null });
    const req = bell({ user_id: ALT, kind: "review_requested", metadata: null });
    db.tables.notifications = [act, req];
    const activation = [{ kind: "alternate_activated", recipient: ALT, sourceId: U(700), notificationId: act.id, details: { manual: true } }];
    const request = [{ kind: "delivered", recipient: ALT, notificationId: req.id }];
    const run = (notices: Array<Record<string, unknown>>) => verifiedRequestRows(memoryClient, input(notices, REVIEW), writer, T0);
    // no draft under review (published, withdrawn) — nothing
    db.tables.document_review_signoffs = [signoff()];
    expect(await run(activation)).toEqual({ rows: [], unmatched: 1 });
    db.tables.documents![0].pending_version_id = VER;
    for (const [why, over] of [
      ["not activated", { activated: false }], ["a primary slot", { slot: "primary" }], ["signed", { status: "signed" }],
      ["on an older revision", { document_version_id: U(3) }], ["withdrawn", { status: "void" }],
    ] as const) {
      db.tables.document_review_signoffs = [signoff(over)];
      expect(await run(activation), why).toEqual({ rows: [], unmatched: 1 });
    }
    // a request: an active primary (or an activated alternate) still unsigned on the draft
    db.tables.document_review_signoffs = [signoff({ slot: "primary", activated: true })];
    expect((await run(request)).rows).toHaveLength(1);
    db.tables.document_review_signoffs = [signoff({ slot: "alternate", activated: false })];
    expect(await run(request)).toEqual({ rows: [], unmatched: 1 });
    // the activation the sign-off row shows: recorded once
    db.tables.document_review_signoffs = [signoff()];
    const ok = await run(activation);
    expect(ok.rows).toEqual([expect.objectContaining({ kind: "alternate_activated", source_id: U(700), notification_id: act.id, actor_name: "cal@x.test" })]);
    // already on the record under another row (the timeout scan's): never a second, manual one
    db.tables.document_notice_events = [{ id: U(7100), org_id: ORG, document_id: DOC, source: "review_signoff", source_id: U(700), kind: "alternate_activated", recipient: ALT, notification_id: U(7101), noticed_at: iso(T0 - DAY) }];
    expect(await run(activation)).toEqual({ rows: [], unmatched: 1 });
    // a repeat of this request's own row is left to ON CONFLICT
    db.tables.document_notice_events = [{ ...ok.rows[0] }];
    expect((await run(activation)).rows).toHaveLength(1);
    // a refused record read throws (nothing written); before 20261257 the check reads nothing
    db.tables.document_notice_events = undefined;
    expect((await run(activation)).rows).toHaveLength(1);
    db.tables.document_notice_events = [];
    db.refuseReadOf.add("documents");
    await expect(run(activation)).rejects.toThrow(/document could not be read/);
  });

  it("the row's actor_name is the VERIFIED writer's, never the bell row's free text; only a server notice with no writer takes the bell row's", async () => {
    db.tables.distribution_acks = [ackRow()];
    const forged = bell({ actor_name: "Jane Smith (Document Control)" });
    db.tables.notifications = [forged];
    const viaRoute = await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: forged.id, details: { manual: true } }]), writer, T0);
    expect(viaRoute.rows[0].actor_name).toBe("cal@x.test");
    const unnamed = await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: forged.id }]), { uid: CTRL, name: null }, T0);
    expect(unnamed.rows[0].actor_name).toBeNull();                         // a writer with no name kept: none, never the bell row's
    const server = bell({ actor_user_id: null, actor_name: "Cal" });
    db.tables.notifications = [server];
    expect((await verifiedRequestRows(memoryClient, input([{ kind: "reminded", recipient: ASG, notificationId: server.id }]), { uid: null, name: null }, T0)).rows[0].actor_name).toBe("Cal");
  });
});

// ── the request paths, on the server path (the cron, a service-role route) ──

describe("DIST-20 — every request and manual reminder is a row on the record once its bell row landed", () => {
  it("recomputeDocumentAck (the read-&-understood request): one delivered row per assignee whose bell row landed, naming it; a refused bell row leaves none; bells and roster exactly as before", async () => {
    db.failBellFor.add(REV);
    await recomputeDocumentAck({ orgId: ORG, documentId: DOC, actorId: CTRL, actorName: "Cal" });
    expect(db.tables.document_acknowledgments!.map((a) => a.assignee_user_id).sort()).toEqual([ASG, REV].sort());
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);
    expect(bellsTo(REV, "ack_requested")).toHaveLength(0);
    expect(events()).toHaveLength(1);
    const ackRowId = db.tables.document_acknowledgments!.find((a) => a.assignee_user_id === ASG)!.id;
    expect(events()[0]).toMatchObject({
      kind: "delivered", source: "acknowledgment", source_id: ackRowId, recipient: ASG, subject_user_id: ASG,
      version_id: VER, notification_id: bellsTo(ASG)[0].id, noticed_at: bellsTo(ASG)[0].created_at, details: { byMember: true },
    });
    expect(audits("ACK_REQUESTED")).toHaveLength(1);
  });

  it("nudgeAcknowledgment (the manual re-send): a reminded row (manual) naming its bell row and roster row; notified_at still overwritten exactly as before", async () => {
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending", notified_at: daysBefore(9) }];
    await nudgeAcknowledgment({ orgId: ORG, rosterId: U(901) });
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);
    expect(db.tables.document_acknowledgments![0].notified_at).toBe(iso(T0));
    expect(events()).toEqual([expect.objectContaining({ kind: "reminded", source_id: U(901), recipient: ASG, notification_id: bellsTo(ASG)[0].id, details: { manual: true } })]);
  });

  it("openReviewRoster (the review request): one delivered row per primary whose bell row landed; the inactive alternate none", async () => {
    db.tables.documents![0].pending_version_id = VER;     // the draft under review
    await openReviewRoster({
      orgId: ORG, documentId: DOC, libraryId: LIB, versionId: VER, revisionLabel: "2A", contentHash: "h",
      control: { mode: "require", reviewerIds: [REV], alternateIds: [ALT], alternateBacks: { [ALT]: `person:${REV}` } } as never,
      actorId: CTRL, actorName: "Cal",
    });
    const signoffs = db.tables.document_review_signoffs!;
    expect(signoffs.map((s) => `${s.reviewer_user_id}:${s.slot}`).sort()).toEqual([`${ALT}:alternate`, `${REV}:primary`].sort());
    expect(events()).toEqual([expect.objectContaining({
      kind: "delivered", source: "review_signoff", recipient: REV, subject_user_id: REV, version_id: VER, revision_label: "2A",
      source_id: signoffs.find((s) => s.reviewer_user_id === REV)!.id, notification_id: bellsTo(REV, "review_requested")[0].id,
    })]);
    expect(audits("REVIEW_REQUESTED")).toHaveLength(1);
  });

  it("the manual activateAlternate: an alternate_activated row (manual) naming its bell row; its audit row exactly as before (no cause); the scan's activation recorded once, by the scan", async () => {
    db.tables.documents![0].pending_version_id = VER;     // the draft under review
    db.tables.document_review_signoffs = [{ id: U(700), org_id: ORG, document_id: DOC, document_version_id: VER, reviewer_user_id: ALT, revision_label: "2A", slot: "alternate", activated: false, status: "pending", assigned_at: daysBefore(9) }];
    const act = await activateAlternate({ orgId: ORG, documentId: DOC, libraryId: LIB, signoffId: U(700), actorId: CTRL });
    expect(act).toMatchObject({ reviewerUserId: ALT, noticeLanded: true, notificationId: bellsTo(ALT)[0].id });
    expect(audits("REVIEW_ALTERNATE_ACTIVATED")[0].details).toEqual({ signoffId: U(700) });
    expect(events()).toEqual([expect.objectContaining({ kind: "alternate_activated", source_id: U(700), recipient: ALT, notification_id: bellsTo(ALT)[0].id, details: { manual: true, byMember: true } })]);
    // the scan's (cause given): this function writes no row; the scan writes its own, once
    db.tables.document_notice_events = [];
    db.tables.notifications = [];
    db.tables.document_review_signoffs[0].activated = false;
    const errors: string[] = [];
    await runComplianceScan(`pre-publish-review@${ORG}`, () => scanReviews(ORG), errors, null);
    expect(events("alternate_activated")).toHaveLength(1);
    expect(events("alternate_activated")[0]).toMatchObject({ details: { cause: "review_timeout" }, notification_id: bellsTo(ALT)[0].id });
  });

  it("requestAcks: a delivered row per new recipient and a reminded row (manual) per recipient already asked; notify:false (the recall close-out) writes none", async () => {
    db.tables.distribution_acks = [{ id: U(800), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: REV, requested_by: CTRL, requested_at: daysBefore(5), acknowledged_at: null }];
    const r = await requestAcks({ orgId: ORG, documentId: DOC, libraryId: LIB, docLabel: "P-1", versionId: VER, revLabel: "C", recipients: [{ uid: ASG }, { uid: REV }], actorUserId: CTRL, actorName: "Cal" });
    expect(r).toEqual({ requested: 1, reminded: 1 });
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);
    expect(bellsTo(REV, "ack_requested")).toHaveLength(1);
    expect(events().map((e) => `${e.kind}:${e.recipient}`).sort()).toEqual([`delivered:${ASG}`, `reminded:${REV}`].sort());
    expect(events().find((e) => e.kind === "reminded")).toMatchObject({ source_id: U(800), details: { manual: true, byMember: true }, notification_id: bellsTo(REV)[0].id });
    db.tables.document_notice_events = [];
    await requestAcks({ orgId: ORG, documentId: DOC, docLabel: "P-1", versionId: VER, revLabel: "C", recipients: [{ uid: OTHER }], actorUserId: CTRL, actorName: "Cal", notify: false });
    expect(events()).toEqual([]);
  });

  it("renudgeUnacked: a reminded row (manual) per pending recipient whose bell row landed", async () => {
    db.tables.distribution_acks = [
      { id: U(801), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: ASG, acknowledged_at: null },
      { id: U(802), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: REV, acknowledged_at: null },
    ];
    const acks: DistributionAck[] = db.tables.distribution_acks.map((a) => ({ id: String(a.id), documentId: DOC, versionId: VER, revLabel: "C", recipientUserId: String(a.recipient_user_id), recipientEmail: null, requestedByName: null, requestedAt: daysBefore(5), acknowledgedAt: null }));
    db.failBellFor.add(REV);
    expect(await renudgeUnacked({ orgId: ORG, documentId: DOC, libraryId: LIB, docLabel: "P-1", revLabel: "C", acks, actorUserId: CTRL, actorName: "Cal" })).toBe(2);
    expect(events()).toEqual([expect.objectContaining({ kind: "reminded", source_id: U(801), recipient: ASG, details: { manual: true, byMember: true } })]);
  });

  it("REGRESSION: a record write that fails never fails the action — refused twice, the rows go to one deferred audit row (system actor) and the source's scan writes them with the same ids; before 20261257 nothing is written and the action is exactly as today", async () => {
    db.noticeError = { code: "57014", message: "canceling statement due to statement timeout" };
    await nudgeAcknowledgment({ orgId: ORG, rosterId: "none" });            // no roster row: nothing at all, as before
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending", notified_at: daysBefore(9), assigned_at: daysBefore(9) }];
    await expect(nudgeAcknowledgment({ orgId: ORG, rosterId: U(901) })).resolves.toBeUndefined();
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);
    expect(events()).toEqual([]);
    const kept = audits(DOCUMENT_NOTICE_RECORD_DEFERRED);
    expect(kept).toHaveLength(1);
    expect(kept[0].user_id).toBeNull();
    const keptRow = (kept[0].details as { rows: Row[] }).rows[0];
    // (on the server path a manual re-send names no actor; in the browser the route adds byMember)
    expect(keptRow).toMatchObject({ kind: "reminded", notification_id: bellsTo(ASG)[0].id, details: { manual: true } });
    // the replay rebuilds it: a manual notice is not the System's (no name kept)
    expect(deferredNoticeRow(keptRow, ORG, "acknowledgment", String(kept[0].timestamp))?.actor_name).toBeNull();
    db.noticeError = null;
    vi.setSystemTime(T0 + DAY);
    await runComplianceScan(`read-understood@${ORG}`, () => scanAndNotifyAcks(ORG), [], null);
    expect(events("reminded").map((e) => e.id)).toContain(keptRow.id);
    // before the paste: the action is exactly as today, nothing written or deferred
    db.tables.document_notice_events = undefined;
    db.tables.audit_logs = [];
    await nudgeAcknowledgment({ orgId: ORG, rosterId: U(901) });
    expect(audits(DOCUMENT_NOTICE_RECORD_DEFERRED)).toEqual([]);
    expect(bellsTo(ASG, "ack_requested").length).toBeGreaterThanOrEqual(2);
  });
});

// ── the browser path and the route ─────────────────────────────────────────

describe("DIST-20 — in the browser the notices go to POST /api/documents/notice-record, which verifies and builds every row itself", () => {
  const req = (body: unknown, raw?: string) => new NextRequest("http://localhost/api/documents/notice-record", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: raw ?? JSON.stringify(body),
  });
  const seedBell = (over: Row = {}): Row => {
    const b = { id: U(600 + db.seq++), org_id: ORG, user_id: ASG, kind: "ack_requested", resource_type: "document", resource_id: DOC, actor_user_id: CTRL, actor_name: "Cal", metadata: null, created_at: iso(T0 - 30_000), ...over };
    db.tables.notifications!.push(b);
    return b;
  };
  const body = (notices: Array<Record<string, unknown>>, over: Row = {}) => ({ orgId: ORG, documentId: DOC, source: "acknowledgment", versionId: VER, notices, ...over });

  it("the browser STARTS the post (its own session as the bearer) and returns at once (queued) — it never throws: a refusal or an unreachable route is said, and the action stands", async () => {
    vi.stubGlobal("window", {});
    db.session = { access_token: "tok", user: { id: CTRL } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 201 }); }));
    const input = { orgId: ORG, documentId: DOC, source: "acknowledgment" as const, versionId: VER, notices: [{ kind: "delivered" as const, recipient: ASG, notificationId: U(42) }] };
    expect(await recordRequestNotices(input)).toBe("queued");
    await __settleNoticeRecords();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(NOTICE_RECORD_ROUTE);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(calls[0].init.keepalive).toBe(true);                            // it outlives a page closed after the click
    expect(JSON.parse(String(calls[0].init.body))).toEqual(input);         // one document: the single-input shape, as before
    expect(events()).toEqual([]);                                          // the browser never writes the record
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 }));
    vi.stubGlobal("fetch", refused);
    expect(await recordRequestNotices(input)).toBe("queued");
    await __settleNoticeRecords();
    expect(refused).toHaveBeenCalledTimes(1);                              // a refusal is not repeated
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(/did not take 1 notice\(s\) \(nope\)/);
    const offline = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", offline);
    await expect(recordRequestNotices(input)).resolves.toBe("queued");
    await __settleNoticeRecords();
    expect(offline).toHaveBeenCalledTimes(2);                              // unreachable: sent once more, then said
    let n = 0;
    const flaky = vi.fn(async (_u: string, init: RequestInit) => { void init; return ++n === 1 ? new Response("{}", { status: 503 }) : new Response("{}", { status: 201 }); });
    vi.stubGlobal("fetch", flaky);
    await recordRequestNotices(input);
    await __settleNoticeRecords();
    expect(flaky).toHaveBeenCalledTimes(2);                                // a 5xx then a landing: taken
    expect((flaky.mock.calls[1][1] as RequestInit).keepalive).toBe(false); // the repeat goes without keepalive
    db.session = null;
    warn.mockClear();
    await recordRequestNotices(input);
    await __settleNoticeRecords();
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(/no signed-in session/);
  });

  it("merge-time fix: a large set is split into bodies within keepalive's limit — every body at most NOTICE_KEEPALIVE_MAX_BODY and REQUEST_NOTICE_MAX notices, sent with keepalive one after another; nothing lost", async () => {
    vi.stubGlobal("window", {});
    db.session = { access_token: "tok", user: { id: CTRL } };
    const seen: Array<{ keepalive: boolean | undefined; size: number; notices: number }> = [];
    let inFlightNow = 0;
    let maxInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      inFlightNow += 1; maxInFlight = Math.max(maxInFlight, inFlightNow);
      await Promise.resolve();
      inFlightNow -= 1;
      seen.push({ keepalive: init.keepalive, size: String(init.body).length, notices: JSON.parse(String(init.body)).notices.length });
      return new Response("{}", { status: 201 });
    }));
    const notices = Array.from({ length: REQUEST_NOTICE_MAX + 5 }, (_, i) => ({ kind: "delivered" as const, recipient: U(2000 + i), notificationId: U(9000 + i) }));
    await recordRequestNotices({ orgId: ORG, documentId: DOC, source: "distribution_ack", notices });
    await __settleNoticeRecords();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((s) => s.keepalive === true && s.size <= NOTICE_KEEPALIVE_MAX_BODY && s.notices <= REQUEST_NOTICE_MAX)).toBe(true);
    expect(seen.reduce((s, x) => s + x.notices, 0)).toBe(REQUEST_NOTICE_MAX + 5);
    expect(maxInFlight).toBe(1);                                           // one keepalive body of an action in flight at a time
  });

  it("noticeRecordBodies: one document is the single-input shape, several are one { batch } body when they fit; a body is never empty and never past the limits", () => {
    const one = { orgId: ORG, documentId: DOC, source: "acknowledgment" as const, versionId: VER, notices: [{ kind: "delivered" as const, recipient: ASG }] };
    expect(noticeRecordBodies([one]).map((b) => JSON.parse(b))).toEqual([one]);
    const two = { ...one, documentId: U(77), notices: [{ kind: "delivered" as const, recipient: REV }] };
    expect(noticeRecordBodies([one, { ...one, notices: [] }, two]).map((b) => JSON.parse(b))).toEqual([{ batch: [one, two] }]);
    const many = Array.from({ length: REQUEST_BATCH_MAX + 3 }, (_, i) => ({ ...one, documentId: U(5000 + i) }));
    const bodies = noticeRecordBodies(many).map((b) => JSON.parse(b) as { batch?: unknown[] });
    expect(bodies.every((b) => !b.batch || (b.batch.length > 0 && b.batch.length <= REQUEST_BATCH_MAX))).toBe(true);
    expect(bodies.reduce((s, b) => s + (b.batch ? b.batch.length : 1), 0)).toBe(REQUEST_BATCH_MAX + 3);
    expect(noticeRecordBodies([])).toEqual([]);
  });

  it("the route takes a { batch } body: every document's rows from its own bell rows; a document the caller cannot read refuses the whole request (403); mixed workspaces or too many notices are a 400", async () => {
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    const DOC2 = U(77);
    db.tables.documents!.push({ ...db.tables.documents![0], id: DOC2 });
    db.tables.document_acknowledgments = [
      { id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending" },
      { id: U(902), org_id: ORG, document_id: DOC2, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending" },
    ];
    const b1 = seedBell();
    const b2 = seedBell({ resource_id: DOC2 });
    const batch = { batch: [body([{ kind: "delivered", recipient: ASG, notificationId: b1.id }]), body([{ kind: "delivered", recipient: ASG, notificationId: b2.id }], { documentId: DOC2 })] };
    auth.unreadable.add(DOC2);
    expect((await POST(req(batch))).status).toBe(403);
    expect(events()).toEqual([]);
    auth.unreadable.clear();
    const res = await POST(req(batch));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, rows: 2, unmatched: 0, outcome: "written" });
    expect(events().map((e) => `${e.document_id}:${e.notification_id}`).sort()).toEqual([`${DOC}:${b1.id}`, `${DOC2}:${b2.id}`].sort());
    expect((await POST(req({ batch: [body([{ kind: "delivered", recipient: ASG }]), body([{ kind: "delivered", recipient: ASG }], { orgId: U(88) })] }))).status).toBe(400);
    expect((await POST(req({ batch: [] }))).status).toBe(400);
    expect(parseRequestNoticeBatch({ batch: Array.from({ length: 2 }, () => body(Array.from({ length: REQUEST_NOTICE_MAX }, () => ({ kind: "delivered", recipient: ASG })))) }))
      .toEqual({ error: `at most ${REQUEST_NOTICE_MAX} notices a request` });
  });

  it("merge-time fix — REGRESSION (DEC-90: bookkeeping never delays a user's action): requestAcks, renudgeUnacked, recomputeDocumentAck, nudgeAcknowledgment, openReviewRoster and the manual activateAlternate each resolve before a never-answering record route; the record still lands when the route answers", async () => {
    vi.stubGlobal("window", {});
    db.session = { access_token: "tok", user: { id: CTRL } };
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    db.stampActor = CTRL;                                                  // 20261160 pasted (the nudge's re-send names its writer)
    db.tables.documents![0].pending_version_id = VER;
    let open: () => void = () => undefined;
    let gate = new Promise<void>((r) => { open = r; });
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url !== NOTICE_RECORD_ROUTE) return new Response("{}", { status: 200 });
      posts.push(String(init.body));
      await gate;                                                          // the route does not answer until opened
      return POST(new NextRequest(`http://localhost${url}`, { method: "POST", headers: init.headers as Record<string, string>, body: String(init.body) }));
    }));
    const returnsFirst = async (action: () => Promise<unknown>) => Promise.race([
      action().then(() => "returned"),
      new Promise((r) => setTimeout(() => r("waited on the record"), 2_000)),
    ]);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const landsWhenAnswered = async (label: string, action: () => Promise<unknown>, expectRows: number) => {
      db.tables.document_notice_events = [];
      posts.length = 0;
      gate = new Promise<void>((r) => { open = r; });
      expect(await returnsFirst(action), label).toBe("returned");
      await tick(); await tick();
      expect(posts.length, label).toBe(1);                                 // the post was started …
      expect(events(), label).toEqual([]);                                 // … and is still unanswered
      open();
      await __settleNoticeRecords();
      expect(events(), label).toHaveLength(expectRows);                    // the record lands once the route answers
    };

    await landsWhenAnswered("recomputeDocumentAck", () => recomputeDocumentAck({ orgId: ORG, documentId: DOC, actorId: CTRL, actorName: "Cal" }), 2);
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending", notified_at: daysBefore(9) }];
    await landsWhenAnswered("nudgeAcknowledgment", () => nudgeAcknowledgment({ orgId: ORG, rosterId: U(901) }), 1);
    db.tables.distribution_acks = [{ id: U(800), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: REV, requested_by: CTRL, requested_at: daysBefore(5), acknowledged_at: null }];
    await landsWhenAnswered("requestAcks", () => requestAcks({ orgId: ORG, documentId: DOC, libraryId: LIB, docLabel: "P-1", versionId: VER, revLabel: "C", recipients: [{ uid: ASG }, { uid: REV }], actorUserId: CTRL, actorName: "Cal" }), 2);
    vi.setSystemTime(T0 + 60_000);                                          // a later click: its own bell rows
    const acks: DistributionAck[] = db.tables.distribution_acks.map((a) => ({ id: String(a.id), documentId: DOC, versionId: VER, revLabel: "C", recipientUserId: String(a.recipient_user_id), recipientEmail: null, requestedByName: null, requestedAt: daysBefore(5), acknowledgedAt: null }));
    await landsWhenAnswered("renudgeUnacked", () => renudgeUnacked({ orgId: ORG, documentId: DOC, libraryId: LIB, docLabel: "P-1", revLabel: "C", acks, actorUserId: CTRL, actorName: "Cal" }), 2);
    await landsWhenAnswered("openReviewRoster", () => openReviewRoster({
      orgId: ORG, documentId: DOC, libraryId: LIB, versionId: VER, revisionLabel: "2A", contentHash: "h",
      control: { mode: "require", reviewerIds: [REV], alternateIds: [ALT], alternateBacks: { [ALT]: `person:${REV}` } } as never,
      actorId: CTRL, actorName: "Cal",
    }), 1);
    const altRow = db.tables.document_review_signoffs!.find((s) => s.reviewer_user_id === ALT)!;
    await landsWhenAnswered("activateAlternate", () => activateAlternate({ orgId: ORG, documentId: DOC, libraryId: LIB, signoffId: String(altRow.id), actorId: CTRL }), 1);
    expect(events()[0]).toMatchObject({ kind: "alternate_activated", details: { manual: true, byMember: true } });
  });

  it("merge-time fix: setAckPolicy gathers the save's notices and posts ONCE, after the last recompute and without waiting on it — the record still lands for every document", async () => {
    vi.stubGlobal("window", {});
    db.session = { access_token: "tok", user: { id: CTRL } };
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    const DOC2 = U(77);
    const VER2 = U(78);
    db.tables.documents!.push({ ...db.tables.documents![0], id: DOC2, current_version_id: VER2, document_number: "P-2", ack_policy: null });
    db.tables.documents![0].ack_policy = null;
    db.tables.document_versions!.push({ id: VER2, document_id: DOC2, version_label: "A", rev_label: "A", content_hash: "h2", created_by: OWN });
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => { open = r; });
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url !== NOTICE_RECORD_ROUTE) return new Response("{}", { status: 200 });
      posts.push(String(init.body));
      await gate;
      return POST(new NextRequest(`http://localhost${url}`, { method: "POST", headers: init.headers as Record<string, string>, body: String(init.body) }));
    }));
    await setAckPolicy({ level: "library", id: LIB, orgId: ORG, policy: { enabled: true, assigneeIds: [ASG, REV] } as never, actorId: CTRL, actorName: "Cal" });
    expect(bells("ack_requested")).toHaveLength(4);                       // the bell rows exactly as before: two documents, two people
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toHaveLength(1);                                         // ONE post for the whole save
    expect((JSON.parse(posts[0]) as { batch: Array<{ documentId: string }> }).batch.map((b) => b.documentId).sort()).toEqual([DOC, DOC2].sort());
    expect(events()).toEqual([]);
    open();
    await __settleNoticeRecords();
    expect(posts).toHaveLength(1);
    expect(events().map((e) => `${e.document_id}:${e.recipient}`).sort()).toEqual([`${DOC}:${ASG}`, `${DOC}:${REV}`, `${DOC2}:${ASG}`, `${DOC2}:${REV}`].sort());
  });

  it("merge-time fix: a SERVER route a person waits on (the intake door) hands a scheduler — recomputeDocumentAck returns before the record write runs, and the write lands when the scheduler runs it; without one a server caller awaits it, as before", async () => {
    const jobs: Array<() => Promise<unknown>> = [];
    await recomputeDocumentAck({ orgId: ORG, documentId: DOC, actorId: null, actorName: null, serverRecord: (job) => { jobs.push(job); } });
    expect(bells("ack_requested")).toHaveLength(2);
    expect(jobs).toHaveLength(1);
    expect(events()).toEqual([]);                                          // nothing waited on the record
    await jobs[0]();
    expect(events()).toHaveLength(2);
    // the intake door's wiring: postPublish carries the scheduler to the roster
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(read("app/api/intake/upload/route.ts")).toContain('serverRecord: afterResponseNoticeRecord("intake/upload"),');
    expect(read("lib/postPublish.ts")).toContain("...(input.serverRecord ? { serverRecord: input.serverRecord } : {}),");
    expect(read("lib/acknowledgments.ts")).toContain("...(input.serverRecord ? { serverRecord: input.serverRecord } : {}),");
  });

  it("afterResponseNoticeRecord: outside a request (after() cannot schedule) the job is started without being awaited, and never throws", async () => {
    const ran = vi.fn(async () => { throw new Error("boom"); });
    expect(() => afterResponseNoticeRecord("test")(ran)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("the route: a signed-in member who can read the document gets the rows the bell rows prove — a landed request is recorded, dated when it landed", async () => {
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending" }];
    const b = seedBell();
    const res = await POST(req(body([{ kind: "delivered", recipient: ASG, notificationId: b.id }])));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, rows: 1, unmatched: 0, outcome: "written" });
    expect(events()).toEqual([expect.objectContaining({ id: requestNoticeId(String(b.id)), notification_id: b.id, noticed_at: b.created_at, source_id: U(901), details: { byMember: true } })]);
  });

  it("the route records nothing the bell rows do not prove: a notice naming someone else's bell row, a bell row another member wrote, or one that never landed", async () => {
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending" }];
    const theirs = seedBell({ actor_user_id: OTHER });
    const toSomeoneElse = seedBell({ user_id: OTHER });
    const res = await POST(req(body([
      { kind: "delivered", recipient: ASG, notificationId: theirs.id },
      { kind: "delivered", recipient: ASG, notificationId: toSomeoneElse.id },
      { kind: "delivered", recipient: ASG, notificationId: U(4040) },
    ])));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: 0, unmatched: 3, outcome: "none" });
    expect(events()).toEqual([]);
  });

  it("P39 fix pass: through the route a member can neither re-record a scan's own bell row (no actor), nor dress up kind details or a colleague as the subject", async () => {
    auth.actor = { userId: ASG, email: "ash@x.test" };
    db.tables.document_acknowledgments = [
      { id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending" },
      { id: U(902), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: OTHER, status: "pending" },
    ];
    const scanReminder = seedBell({ actor_user_id: null, actor_name: null });           // the read-&-understood scan's reminder to ASG
    const own = seedBell({ actor_user_id: ASG, user_id: ASG });
    const res = await POST(req(body([
      { kind: "reminded", recipient: ASG, notificationId: scanReminder.id, details: { manual: true } },
      { kind: "delivered", recipient: ASG, subject: OTHER, notificationId: own.id },
    ])));
    expect(await res.json()).toMatchObject({ rows: 0, unmatched: 2 });
    const res2 = await POST(req(body([{ kind: "delivered", recipient: ASG, notificationId: own.id, details: { manual: true, ageDays: 500 } }])));
    expect(res2.status).toBe(201);
    expect(events()).toEqual([expect.objectContaining({ kind: "delivered", subject_user_id: ASG, details: { byMember: true } })]);
  });

  it("P39 fix pass: a re-nudge from a browser whose clock runs 2 minutes fast is still recorded (the emit fan-out, matched by writer and window)", async () => {
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    db.tables.distribution_acks = [{ id: U(801), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: ASG, acknowledged_at: null }];
    const b = seedBell({ metadata: { ackRequest: true }, created_at: iso(T0 - 1000) });
    const res = await POST(req(body([{ kind: "reminded", recipient: ASG, sourceId: U(801), details: { manual: true } }], { source: "distribution_ack", versionId: null, since: iso(T0 + 2 * 60_000) })));
    expect(res.status).toBe(201);
    expect(events()).toEqual([expect.objectContaining({ kind: "reminded", notification_id: b.id, details: { manual: true, byMember: true } })]);
  });

  it("P39 second fix pass — REGRESSION (the review's scenario): a Viewer who plants a review_alternate_activated bell row to a reviewer gets NO alternate_activated row — not for a sign-off on an old revision, not for an alternate never activated", async () => {
    auth.actor = { userId: OTHER, email: "viewer@x.test" };
    db.tables.documents![0].pending_version_id = VER;
    db.tables.document_review_signoffs = [
      // REV's completed sign-off on an older revision
      { id: U(710), org_id: ORG, document_id: DOC, document_version_id: U(3), reviewer_user_id: REV, revision_label: "1", slot: "primary", activated: true, status: "signed" },
      // ALT, a standby alternate on the draft under review, never activated
      { id: U(711), org_id: ORG, document_id: DOC, document_version_id: VER, reviewer_user_id: ALT, revision_label: "2A", slot: "alternate", activated: false, status: "pending" },
    ];
    const toRev = seedBell({ user_id: REV, kind: "review_alternate_activated", actor_user_id: OTHER, actor_name: "Document Control" });
    const toAlt = seedBell({ user_id: ALT, kind: "review_alternate_activated", actor_user_id: OTHER, actor_name: "Document Control" });
    const res = await POST(req(body([
      { kind: "alternate_activated", recipient: REV, notificationId: toRev.id, details: { manual: true } },
      { kind: "alternate_activated", recipient: ALT, notificationId: toAlt.id, details: { manual: true } },
    ], { source: "review_signoff", versionId: null })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: 0, unmatched: 2, outcome: "none" });
    expect(events()).toEqual([]);
    expect(db.tables.document_review_signoffs.map((r) => r.activated)).toEqual([true, false]);   // nothing changed, nothing claimed
  });

  it("P39 second fix pass: through the route a forged bell actor_name never reaches the record — the row names the verified caller; a chase of a confirmation already given is refused", async () => {
    auth.actor = { userId: ASG, email: "ash@x.test" };
    db.tables.distribution_acks = [
      { id: U(801), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: REV, acknowledged_at: null },
      { id: U(802), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: OTHER, acknowledged_at: iso(T0 - DAY) },
    ];
    const forged = seedBell({ user_id: REV, actor_user_id: ASG, actor_name: "Jane Smith (Document Control)", metadata: { ackRequest: true } });
    const done = seedBell({ user_id: OTHER, actor_user_id: ASG, metadata: { ackRequest: true } });
    const res = await POST(req(body([
      { kind: "reminded", recipient: REV, notificationId: forged.id, details: { manual: true } },
      { kind: "reminded", recipient: OTHER, notificationId: done.id, details: { manual: true } },
    ], { source: "distribution_ack" })));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ rows: 1, unmatched: 1 });
    expect(events()).toEqual([expect.objectContaining({ recipient: REV, actor_name: "ash@x.test", details: { manual: true, byMember: true } })]);
    expect(JSON.stringify(events())).not.toContain("Jane Smith");
  });

  it("P39 second fix pass — the browser re-send of nudgeAcknowledgment, through the route: NOT recorded until 20261160 is pasted (its bell row names no actor, ruling R3 at the N17 merge), recorded once the rail stamps the writer", async () => {
    vi.stubGlobal("window", {});
    db.session = { access_token: "tok", user: { id: CTRL } };
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (url === NOTICE_RECORD_ROUTE
      ? POST(new NextRequest(`http://localhost${url}`, { method: "POST", headers: init.headers as Record<string, string>, body: String(init.body) }))
      : new Response("{}", { status: 200 }))));
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending", notified_at: daysBefore(9) }];
    // before 20261160: the bell row lands with no actor; the route takes only the caller's own rows
    await nudgeAcknowledgment({ orgId: ORG, rosterId: U(901) });
    await __settleNoticeRecords();
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);
    expect(bellsTo(ASG, "ack_requested")[0].actor_user_id ?? null).toBeNull();
    expect(db.tables.document_acknowledgments[0].notified_at).toBe(iso(T0));   // the re-send itself exactly as before
    expect(events()).toEqual([]);                                           // the stated gap (DIST-20 done-when 1, not held for this path)
    // once 20261160 is pasted the rail stamps the writer as the actor: the same call is recorded, no code change
    db.stampActor = CTRL;
    await nudgeAcknowledgment({ orgId: ORG, rosterId: U(901) });
    await __settleNoticeRecords();
    expect(events()).toEqual([expect.objectContaining({
      kind: "reminded", source: "acknowledgment", source_id: U(901), recipient: ASG, actor_name: "cal@x.test",
      notification_id: bellsTo(ASG, "ack_requested")[1].id, details: { manual: true, byMember: true },
    })]);
  });

  it("the route refuses: no session (401), a document the caller cannot read (403), a malformed or oversized body (400 / 413)", async () => {
    expect((await POST(req(body([{ kind: "delivered", recipient: ASG }])))).status).toBe(401);
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    auth.unreadable.add(DOC);
    expect((await POST(req(body([{ kind: "delivered", recipient: ASG }])))).status).toBe(403);
    auth.unreadable.clear();
    expect((await POST(req(null, "{not json"))).status).toBe(400);
    expect((await POST(req(body([{ kind: "escalated", recipient: ASG }])))).status).toBe(400);   // a scan's kind is not a request's
    expect((await POST(req(body([{ kind: "delivered", recipient: "nobody" }])))).status).toBe(400);
    expect(await POST(req(body([])))).toHaveProperty("status", 400);
    expect(await POST(req(null, "x".repeat(70_000)))).toHaveProperty("status", 413);
    expect(events()).toEqual([]);
  });

  it("the route before 20261257: 200, outcome missing, nothing written or deferred (today's path)", async () => {
    auth.actor = { userId: CTRL, email: "cal@x.test" };
    db.tables.document_acknowledgments = [{ id: U(901), org_id: ORG, document_id: DOC, document_version_id: VER, revision_label: "C", assignee_user_id: ASG, status: "pending" }];
    db.tables.document_notice_events = undefined;
    const b = seedBell();
    const res = await POST(req(body([{ kind: "delivered", recipient: ASG, notificationId: b.id }])));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "missing" });
    expect(audits(DOCUMENT_NOTICE_RECORD_DEFERRED)).toEqual([]);
  });

  it("parseRequestNoticeBody keeps only numbers and booleans in details (never free text)", () => {
    const parsed = parseRequestNoticeBody(body([{ kind: "reminded", recipient: ASG, details: { manual: true, note: "free text", n: 3 } }]));
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) expect(parsed.notices[0].details).toEqual({ manual: true, n: 3 });
  });
});

// ── the distribution nag reads the record only (DIST-20 done-when 3) ───────

describe("DIST-20 — scanDistributionAcks's cooldown reads the record ONLY once 20261257 is in place", () => {
  const seed = () => {
    db.tables.distribution_acks = [
      { id: U(801), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: ASG, recipient_email: "a@x.test", requested_by: OWN, requested_by_name: "Olive", requested_at: daysBefore(5), acknowledged_at: null },
      { id: U(802), org_id: ORG, document_id: DOC, version_id: VER, rev_label: "C", recipient_user_id: REV, recipient_email: "r@x.test", requested_by: OWN, requested_by_name: "Olive", requested_at: daysBefore(5), acknowledged_at: null },
    ];
  };
  const run = async (day: number) => {
    vi.setSystemTime(T0 + day * DAY);
    const errors: string[] = [];
    await runComplianceScan(`distribution-acks@${ORG}`, () => scanDistributionAcks(ORG), errors, null);
    return errors;
  };
  const acksOf = () => db.tables.distribution_acks!.map((a) => ({ id: String(a.id), documentId: DOC, versionId: VER, revLabel: "C", recipientUserId: String(a.recipient_user_id), recipientEmail: null, requestedByName: null, requestedAt: String(a.requested_at), acknowledgedAt: null }));

  it("REGRESSION: a controller's manual re-nudge still holds the robot's nudge for one cooldown — from the record, even after its bell row is purged — and the robot nudges again once the window has passed", async () => {
    seed();
    await renudgeUnacked({ orgId: ORG, documentId: DOC, libraryId: LIB, docLabel: "P-1", revLabel: "C", acks: acksOf().slice(0, 1), actorUserId: CTRL, actorName: "Cal" });
    expect(events("reminded").map((e) => e.recipient)).toEqual([ASG]);
    db.tables.notifications = [];                                          // purged (or dismissed)
    await run(1);
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(0);                 // held by the manual re-nudge on the record
    expect(bellsTo(REV, "ack_requested")).toHaveLength(1);                 // the other recipient: nudged, as today
    db.reads = {};
    await run(4);                                                          // the window has passed (and moved past the cutover)
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);
    expect(db.reads.notifications ?? 0).toBe(0);                           // the cooldown read the record alone
  });

  it("a manual REQUEST (delivered) holds the robot's nudge too, as its bell row did", async () => {
    seed();
    db.tables.document_notice_events!.push({ id: U(3000), org_id: ORG, document_id: DOC, source: "distribution_ack", source_id: U(801), kind: "delivered", recipient: ASG, noticed_at: daysBefore(1) });
    const got = await recentDistributionNotices(ORG, daysBefore(3));
    expect(got).toEqual({ reminded: new Set([`${ASG}:${DOC}`]), escalated: new Set(), complete: true, cutover: null });
    await run(0);
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(0);
  });

  it("P39 fix pass — REGRESSION across the transition: a manual re-nudge sent from the app BEFORE P39 (a bell row, on no record) still holds the robot's nudge for its one cooldown after the deploy and the paste; a bell row after the cutover that is not on the record holds nothing; past the cutover no bell row is read", async () => {
    seed();
    // day 0: the P38 app re-nudges ASG — a bell row only
    db.tables.notifications = [{ id: U(6000), org_id: ORG, user_id: ASG, kind: "ack_requested", resource_type: "document", resource_id: DOC, actor_user_id: CTRL, metadata: { ackRequest: true }, created_at: iso(T0) }];
    // day 1: P39 deployed and 20261257 pasted; the first scan reads a complete record with no row for ASG
    await run(1);
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);                 // held by the pre-P39 re-nudge: no double nudge
    expect(bellsTo(REV, "ack_requested")).toHaveLength(1);                 // REV nudged — the workspace's first P39 notice (the cutover)
    // a forged ackRequest bell row to REV after the cutover holds nothing once REV's own window has passed
    db.tables.notifications.push({ id: U(6001), org_id: ORG, user_id: REV, kind: "ack_requested", resource_type: "document", resource_id: DOC, actor_user_id: ASG, metadata: { ackRequest: true }, created_at: iso(T0 + 3.5 * DAY) });
    db.reads = {};
    await run(4.5);
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(2);                 // ASG's window (from day 0) has passed: nudged
    expect(bellsTo(REV, "ack_requested")).toHaveLength(3);                 // the forged row held nothing
    expect(db.reads.notifications ?? 0).toBe(0);                           // the window starts after the cutover: the record alone
  });

  it("REGRESSION: before 20261257 (or a refused read) the bell rows count, exactly as today — a manual re-nudge's bell row holds the nudge", async () => {
    seed();
    db.tables.document_notice_events = undefined;
    db.tables.notifications = [{ id: "n0", org_id: ORG, user_id: ASG, kind: "ack_requested", resource_id: DOC, metadata: { ackRequest: true }, created_at: daysBefore(1) }];
    await run(0);
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);                 // only the manual one
    expect(bellsTo(REV, "ack_requested")).toHaveLength(1);
    db.tables.document_notice_events = [];
    db.refuseReadOf.add("document_notice_events");
    db.tables.notifications = [{ id: "n1", org_id: ORG, user_id: ASG, kind: "ack_requested", resource_id: DOC, metadata: { ackRequest: true }, created_at: iso(T0 + 2 * DAY) }];
    await run(2);
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);
  });

  it("a read stopped at its page cap is not complete: the bell rows count as well (the union only ever withholds more)", async () => {
    seed();
    for (let i = 0; i < COOLDOWN_NOTICE_PAGES * COOLDOWN_NOTICE_ROWS + 1; i += 1) {
      db.tables.document_notice_events!.push({ id: `e-${String(i).padStart(6, "0")}`, org_id: ORG, document_id: `dx-${i}`, source: "distribution_ack", kind: "reminded", recipient: `u-${i}`, noticed_at: iso(T0 - DAY + i) });
    }
    db.tables.notifications = [{ id: "n0", org_id: ORG, user_id: ASG, kind: "ack_requested", resource_id: DOC, metadata: { ackRequest: true }, created_at: daysBefore(1) }];
    const got = await recentDistributionNotices(ORG, daysBefore(3));
    expect(got?.complete).toBe(false);
    await run(0);
    expect(bellsTo(ASG, "ack_requested")).toHaveLength(1);                 // held by the bell row, as before
  });

  it("the nag's own nudge and escalation name the bell rows they landed as (DIST-19 residual (c)); one nudge per cooldown read from the record", async () => {
    seed();
    db.tables.distribution_acks!.forEach((a) => { a.requested_at = daysBefore(12); });
    await run(0);
    for (const e of events("reminded")) expect(bells().map((b) => b.id)).toContain(e.notification_id);
    const esc = bells("ack_overdue")[0];
    expect(events("escalated").every((e) => e.notification_id === esc.id)).toBe(true);
    db.tables.notifications = [];
    await run(1);
    expect(bells()).toHaveLength(0);
  });
});

// ── pins ────────────────────────────────────────────────────────────────────

describe("DIST-20 — pins", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("notifyChecked keeps its boolean contract; the id is additive (notifyWithReason's `id`, notifyCheckedId)", () => {
    const src = read("lib/inAppNotifications.ts");
    expect(src).toContain("export async function notifyChecked(input: NotificationInput, client?: NotifyClient): Promise<boolean> {\n  return (await notifyWithReason(input, client)).ok;\n}");
    expect(src).toContain("export async function notifyCheckedId(input: NotificationInput, client?: NotifyClient): Promise<string | null> {");
  });
  it("each path records AFTER everything it already did (the bell rows, the stamp, the audit row are unchanged and come first)", () => {
    const ack = read("lib/acknowledgments.ts");
    expect(ack.indexOf('await supabase.from("document_acknowledgments").update({ notified_at: new Date().toISOString() }).eq("id", input.rosterId);'))
      .toBeLessThan(ack.indexOf('notices: [{ kind: "reminded", recipient: r.assignee_user_id as string, sourceId: input.rosterId'));
    const rc = read("lib/reviewControl.ts");
    expect(rc.indexOf('action: "REVIEW_REQUESTED"')).toBeLessThan(rc.indexOf('source: "review_signoff", versionId: input.versionId'));
    expect(rc.indexOf('action: "REVIEW_ALTERNATE_ACTIVATED"')).toBeLessThan(rc.indexOf('notices: [{ kind: "alternate_activated"'));
    const da = read("lib/distributionAcks.ts");
    expect(da.indexOf("metadata: { ackRequest: true },\n  });\n  // DIST-20 (P39)")).toBeGreaterThan(0);
  });
  it("P39 second fix pass: nudgeAcknowledgment's bell row and its caller are unchanged (ruling R3 at the N17 merge: the re-send names no actor) — its record row waits for 20261160", () => {
    expect(read("components/documents/AckSection.tsx")).toContain("await nudgeAcknowledgment({ orgId, rosterId });");
    const ack = read("lib/acknowledgments.ts");
    const at = ack.search(/\bfunction nudgeAcknowledgment\(/);
    expect(ack.slice(at, ack.indexOf("\n}\n", at))).not.toMatch(/actorUserId/);
  });
  it("the manual activation's caller and audit row are exactly as before", () => {
    expect(read("components/documents/ReviewGateSection.tsx")).toContain("await activateAlternate({ orgId, documentId: doc.id, libraryId: doc.libraryId, signoffId, actorId: uid });");
    expect(read("lib/reviewControl.ts")).toContain("details: input.cause ? { signoffId: input.signoffId, cause: input.cause } : { signoffId: input.signoffId }");
  });
  it("a scan row's builder still defaults to no notification id and the System as actor", () => {
    expect(noticeRow({ org_id: "o", document_id: "d", version_id: null, revision_label: null, source: "acknowledgment", source_id: null, kind: "reminded", recipient: "u", subject_user_id: "u" }))
      .toMatchObject({ actor_name: "System", notification_id: null });
  });
});
