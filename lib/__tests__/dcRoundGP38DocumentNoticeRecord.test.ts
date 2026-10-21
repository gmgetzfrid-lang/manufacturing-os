// document-control Round G — P38 DOCUMENT NOTICE RECORD (DIST-19, the
// document half of drafting-flow EVID-8).
//
// Driven through the REAL scans (lib/reviewControl scanReviews,
// lib/acknowledgments scanAndNotifyAcks, lib/distributionAcks
// scanDistributionAcks), the REAL lib/documentNoticeRecord, lib/complianceNotify,
// lib/inAppNotifications, lib/audit and lib/ownership, inside
// lib/complianceNotifyScope's collector (the cron's service-role scan), on a
// filter-aware in-memory client.
//
// Pinned:
//   · every notice that LANDED is one append-only document_notice_events row
//     (reminded / escalated / alternate_activated); a dead-lettered notice
//     leaves none, and its retry on the next run adds exactly its own row;
//   · REGRESSION (DEC-90 ruling (2)): notified_at is stamped exactly as
//     before — same condition, same moment — and the same bells go out,
//     whether the record is written, refused, or not in the database at all;
//   · a refused record write never fails the scan: it is kept in one
//     DOCUMENT_NOTICE_RECORD_DEFERRED audit row and the next run writes the
//     same rows (same ids — never a second copy);
//   · before 20261257 (42P01 / PGRST205): nothing written, nothing deferred,
//     one line in the run's report;
//   · the timeout activation's audit row names the silence that caused it,
//     with the system actor; the manual activation's row is as before;
//   · the distribution nag counts its own nudges from the record (a purged
//     bell row no longer re-opens the cooldown) and still from the bell rows
//     (a manual re-nudge still counts): one nudge per cooldown;
//   · merge-time fix pass: the deferred audit row (every member reads
//     audit_logs) holds only ids, kind, source, noticed_at and numeric /
//     enum details — never a not_emailed reason, never the revision label
//     (the replay re-reads it); the cooldown read is keyset-paged past
//     PostgREST's max-rows (1000), and a refused page falls back exactly as
//     today; a replayed row refused for good (23503 / 22P02) is dropped and
//     said in one line, never "retried on the next run".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failBellFor: new Set<string>(),
  /** the next document_notice_events writes answer this error (null: they land) */
  noticeError: null as null | { code?: string; message: string },
  /** a document_notice_events write naming one of these ids is refused with that SQLSTATE */
  refuseNoticeIds: new Map<string, string>(),
  noticeWrites: 0,
  /** document_notice_events reads so far; a read past `failNoticeReadAfter` is refused */
  noticeReads: 0,
  failNoticeReadAfter: null as null | number,
  /** PostgREST's max-rows: no read answers more rows than this */
  maxRows: Infinity,
  /** a read of one of these tables is refused (42501) */
  refuseReadOf: new Set<string>(),
  seq: 0,
}));

const REFUSAL_TEXT: Record<string, string> = {
  "23503": 'insert or update on table "document_notice_events" violates foreign key constraint',
  "22P02": 'invalid input syntax for type uuid',
  "57014": "canceling statement due to statement timeout",
};

const unq = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);
function parseOr(expr: string, all = false): (r: Row) => boolean {
  const parts = expr.split(/,(?![^(]*\))(?![^{]*\})/);
  const preds = parts.map((p) => {
    let m: RegExpExecArray | null;
    if ((m = /^and\((.*)\)$/.exec(p))) return parseOr(m[1], true);
    if ((m = /^(\w+)\.eq\.(.+)$/.exec(p))) { const col = m[1]; const v = unq(m[2]); return (r: Row) => r[col] != null && String(r[col]) === v; }
    if ((m = /^(\w+)\.in\.\(([^)]*)\)$/.exec(p))) { const list = m[2].split(","); const col = m[1]; return (r: Row) => list.includes(String(r[col])); }
    if ((m = /^(\w+)\.ov\.\{([^}]*)\}$/.exec(p))) { const list = m[2].split(","); const col = m[1]; return (r: Row) => Array.isArray(r[col]) && (r[col] as string[]).some((x) => list.includes(x)); }
    if ((m = /^(\w+)\.is\.null$/.exec(p))) { const col = m[1]; return (r: Row) => r[col] == null; }
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
    return rows.slice(0, Math.min(limit, db.maxRows));
  };
  const run = (): { data: unknown; error: unknown; count?: number } => {
    if (insert) {
      const rows = insert;
      if (table === "notifications" && rows.some((r) => db.failBellFor.has(String(r.user_id)))) {
        return { data: null, error: { code: "42501", message: "permission denied for table notifications" } };
      }
      if (table === "document_notice_events") {
        db.noticeWrites += 1;
        if (db.noticeError) return { data: null, error: db.noticeError };
        const bad = rows.find((r) => db.refuseNoticeIds.has(String(r.id)));
        if (bad) {
          const code = db.refuseNoticeIds.get(String(bad.id))!;
          return { data: null, error: { code, message: `${REFUSAL_TEXT[code] ?? "refused"} (row ${String(bad.id)})` } };
        }
      }
      const at = new Date().toISOString();
      const t = (db.tables[table] ??= []);
      for (const r of rows) {
        if (upsertIgnore && r.id != null && t.some((x) => x.id === r.id)) continue; // ON CONFLICT (id) DO NOTHING
        t.push({ id: `${table}-${++db.seq}`, created_at: at, timestamp: at, ...r });
      }
      return { data: null, error: null, count: rows.length };
    }
    if (update) {
      const hit = matching();
      for (const r of hit) Object.assign(r, update);
      return { data: hit, error: null };
    }
    if (db.refuseReadOf.has(table)) return { data: null, error: { code: "42501", message: `permission denied for table ${table}` } };
    if (table === "document_notice_events") {
      db.noticeReads += 1;
      if (db.failNoticeReadAfter != null && db.noticeReads > db.failNoticeReadAfter) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    }
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
          case "not":
            if (a1 === "is") preds.push((r) => !(a2 === null ? r[col] == null : r[col] === a2));
            break;
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

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  },
}));

import { __setComplianceRetrySleep, __resetComplianceBreaker } from "@/lib/complianceNotify";
import { runComplianceScan } from "@/lib/complianceNotifyScope";
import { scanAndNotifyAcks } from "@/lib/acknowledgments";
import { scanReviews } from "@/lib/reviewControl";
import { scanDistributionAcks } from "@/lib/distributionAcks";
import {
  COOLDOWN_NOTICE_PAGES, COOLDOWN_NOTICE_ROWS, DEFERRED_NOTICE_PAGES, DEFERRED_NOTICE_ROWS, DOCUMENT_NOTICE_RECORD_DEFERRED,
  deferrableDetails, deferredNoticeRow, deferredPayloadRow, isMissingNoticeSchema, noticeRecorder, noticeRow,
  recentDistributionNotices, replayDeferredNotices,
} from "@/lib/documentNoticeRecord";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 21, 3, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const daysBefore = (n: number) => iso(T0 - n * DAY);

async function cronRun(label: string, fn: (orgId: string) => Promise<number>, day: number): Promise<string[]> {
  vi.setSystemTime(T0 + day * DAY);
  const errors: string[] = [];
  await runComplianceScan(`${label}@o1`, () => fn("o1"), errors, null);
  return errors;
}
const bells = (kind?: string) => (db.tables.notifications ?? []).filter((n) => !kind || n.kind === kind);
const bellsTo = (uid: string, kind?: string) => bells(kind).filter((n) => n.user_id === uid);
const events = (kind?: string) => (db.tables.document_notice_events ?? []).filter((e) => !kind || e.kind === kind);
const audits = (action: string) => (db.tables.audit_logs ?? []).filter((a) => a.action === action);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  db.seq = 0;
  db.noticeWrites = 0;
  db.noticeError = null;
  db.refuseNoticeIds = new Map();
  db.noticeReads = 0;
  db.failNoticeReadAfter = null;
  db.maxRows = 1000;                                                       // PostgREST's default max-rows
  db.refuseReadOf = new Set();
  db.failBellFor = new Set();
  db.tables = {
    org_members: [
      { uid: "ctrl", org_id: "o1", status: "active", role: "DocCtrl", roles: ["DocCtrl"], display_name: "Cal" },
      { uid: "own", org_id: "o1", status: "active", role: "Engineer-1", roles: ["Engineer-1"], display_name: "Olive" },
      { uid: "asg", org_id: "o1", status: "active", role: "Engineer-1", roles: ["Engineer-1"], display_name: "Ash" },
      { uid: "rev", org_id: "o1", status: "active", role: "Engineer-1", roles: ["Engineer-1"], display_name: "Rae" },
      { uid: "alt", org_id: "o1", status: "active", role: "Engineer-1", roles: ["Engineer-1"], display_name: "Alma" },
    ],
    libraries: [{ id: "L", org_id: "o1", name: "Drawings", owner_user_id: null, owner_name: null, owner_team_id: null, review_control: null }],
    collections: [],
    teams: [],
    notifications: [],
    audit_logs: [],
    document_notice_events: [],
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
});

const seedReview = () => {
  db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, review_control: null, owner_user_id: "own", owner_name: "Olive" }];
  db.tables.document_review_signoffs = [{ id: "s1", org_id: "o1", status: "pending", document_id: "d1", document_version_id: "v1", reviewer_user_id: "rev", reviewer_name: "Rae", revision_label: "C", slot: "primary", activated: true, notified_at: daysBefore(6), assigned_at: daysBefore(9) }];
};
const reviewStamp = () => db.tables.document_review_signoffs[0].notified_at;

describe("DIST-19 — the review-reminder scan (lib/reviewControl.ts scanReviews)", () => {
  it("every notice landed: one reminded row for the reviewer and one escalated row per escalation, all naming the revision; notified_at stamped exactly as before", async () => {
    seedReview();
    expect(await cronRun("pre-publish-review", scanReviews, 0)).toEqual([]);
    expect(bellsTo("rev", "review_requested")).toHaveLength(1);
    expect(bells("review_overdue")).toHaveLength(2);
    expect(reviewStamp()).toBe(iso(T0));
    expect(events("reminded")).toEqual([expect.objectContaining({
      org_id: "o1", document_id: "d1", version_id: "v1", revision_label: "C", source: "review_signoff", source_id: "s1",
      recipient: "rev", subject_user_id: "rev", actor_name: "System", notification_id: null, noticed_at: iso(T0),
    })]);
    expect(events("escalated").map((e) => e.recipient).sort()).toEqual(["ctrl", "own"]);
    expect(events("escalated").every((e) => e.subject_user_id === "rev" && e.source_id === "s1")).toBe(true);
  });

  it("the failure scenario (reminded three times, escalated once past the timeout, then purged): the record keeps every reminder; notified_at still shows only the last", async () => {
    seedReview();
    db.tables.document_review_signoffs[0].notified_at = null;
    db.tables.document_review_signoffs[0].assigned_at = daysBefore(3);
    for (const day of [0, 2, 5, 10]) await cronRun("pre-publish-review", scanReviews, day);   // day 2: inside the 5-day cooldown
    db.tables.notifications = [];                                          // the bell purge
    expect(reviewStamp()).toBe(iso(T0 + 10 * DAY));                       // one watermark, as before
    expect(events("reminded").map((e) => e.noticed_at)).toEqual([iso(T0), iso(T0 + 5 * DAY), iso(T0 + 10 * DAY)]);
    expect(events("escalated").map((e) => `${e.recipient}@${e.noticed_at}`).sort()).toEqual([`ctrl@${iso(T0 + 5 * DAY)}`, `ctrl@${iso(T0 + 10 * DAY)}`, `own@${iso(T0 + 5 * DAY)}`, `own@${iso(T0 + 10 * DAY)}`]);
  });

  it("a dead-lettered escalation leaves no row and no stamp; the next run's retry adds exactly that recipient's row", async () => {
    seedReview();
    db.failBellFor.add("ctrl");
    await cronRun("pre-publish-review", scanReviews, 0);
    expect(reviewStamp()).toBe(daysBefore(6));
    expect(events().map((e) => `${e.kind}:${e.recipient}`).sort()).toEqual(["escalated:own", "reminded:rev"]);
    db.failBellFor.clear();
    await cronRun("pre-publish-review", scanReviews, 1);
    expect(reviewStamp()).toBe(iso(T0 + DAY));
    expect(events().map((e) => `${e.kind}:${e.recipient}`).sort()).toEqual(["escalated:ctrl", "escalated:own", "reminded:rev"]);
  });

  it("an alternate activated on timeout: its notice is an alternate_activated row, and the activation's audit row names the silence with the system actor", async () => {
    seedReview();
    db.tables.document_review_signoffs.push({ id: "s2", org_id: "o1", status: "pending", document_id: "d1", document_version_id: "v1", reviewer_user_id: "alt", reviewer_name: "Alma", revision_label: "C", slot: "alternate", activated: false, notified_at: null, assigned_at: daysBefore(9) });
    await cronRun("pre-publish-review", scanReviews, 0);
    expect(db.tables.document_review_signoffs[1].activated).toBe(true);
    expect(events("alternate_activated")).toEqual([expect.objectContaining({ recipient: "alt", subject_user_id: "alt", source_id: "s2", version_id: "v1" })]);
    const audit = audits("REVIEW_ALTERNATE_ACTIVATED");
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBeNull();
    expect(audit[0].metadata).toMatchObject({ actor_kind: "system" });
    expect(audit[0].details).toEqual({ signoffId: "s2", cause: { reason: "review_timeout", timeoutDays: 7, ageDays: 9, documentVersionId: "v1" } });
  });
});

describe("DIST-19 — the acknowledgment scan (lib/acknowledgments.ts scanAndNotifyAcks)", () => {
  const seed = () => {
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, document_number: "P-1", title: null, name: null, owner_user_id: "own", owner_name: "Olive" }];
    db.tables.document_acknowledgments = [{ id: "a1", org_id: "o1", status: "pending", document_id: "d1", document_version_id: "v1", assignee_user_id: "asg", assignee_name: "Ash", revision_label: "C", notified_at: daysBefore(8), assigned_at: daysBefore(40) }];
  };
  it("the reminder and both escalations are rows on the record; the cooldown is stamped exactly as before", async () => {
    seed();
    expect(await cronRun("read-understood", scanAndNotifyAcks, 0)).toEqual([]);
    expect(db.tables.document_acknowledgments[0].notified_at).toBe(iso(T0));
    expect(events().map((e) => `${e.kind}:${e.recipient}:${e.subject_user_id}:${e.source}:${e.version_id}`).sort()).toEqual([
      "escalated:ctrl:asg:acknowledgment:v1", "escalated:own:asg:acknowledgment:v1", "reminded:asg:asg:acknowledgment:v1",
    ]);
  });
});

describe("DIST-19 — a record write that fails never fails the scan or changes who is reminded", () => {
  it("refused twice: bells and stamp exactly as with a healthy record; the rows are kept in one deferred audit row; the next run writes them with the same ids, once", async () => {
    seedReview();
    db.noticeError = { code: "57014", message: "canceling statement due to statement timeout" };
    const errors = await cronRun("pre-publish-review", scanReviews, 0);
    expect(bells()).toHaveLength(3);
    expect(reviewStamp()).toBe(iso(T0));
    expect(events()).toHaveLength(0);
    expect(db.noticeWrites).toBe(2);                                       // tried, retried once
    const deferred = audits(DOCUMENT_NOTICE_RECORD_DEFERRED);
    expect(deferred).toHaveLength(1);
    expect(deferred[0].user_id).toBeNull();
    const kept = (deferred[0].details as { rows: Row[] }).rows;
    expect(kept).toHaveLength(3);
    expect(errors.join(" ")).toMatch(/kept in the audit log; the next run writes them/);

    db.noticeError = null;
    await cronRun("pre-publish-review", scanReviews, 1);                  // inside the cooldown: no new notice
    expect(bells()).toHaveLength(3);
    expect(events().map((e) => e.id).sort()).toEqual(kept.map((r) => r.id).sort());
    expect(events().every((e) => e.noticed_at === iso(T0))).toBe(true);    // when it landed, not when it was replayed
    await cronRun("pre-publish-review", scanReviews, 2);                  // replayed again: never a second copy
    expect(events()).toHaveLength(3);
  });

  it("before 20261257 (42P01): the scan reminds and stamps as before, defers nothing, and says so once", async () => {
    seedReview();
    db.noticeError = { code: "42P01", message: 'relation "public.document_notice_events" does not exist' };
    const errors = await cronRun("pre-publish-review", scanReviews, 0);
    expect(bells()).toHaveLength(3);
    expect(reviewStamp()).toBe(iso(T0));
    expect(audits(DOCUMENT_NOTICE_RECORD_DEFERRED)).toHaveLength(0);
    expect(db.noticeWrites).toBe(1);
    expect(errors.join(" ").match(/not in this database yet/g)).toHaveLength(1);
  });

  it("PGRST205 reads as the record missing too; another refusal does not", () => {
    expect(isMissingNoticeSchema({ code: "PGRST205", message: "Could not find the table 'public.document_notice_events' in the schema cache" })).toBe(true);
    expect(isMissingNoticeSchema({ code: "PGRST204", message: "Could not find the 'noticed_at' column of 'document_notice_events' in the schema cache" })).toBe(true);
    expect(isMissingNoticeSchema({ code: "42501", message: "permission denied for table document_notice_events" })).toBe(false);
    expect(isMissingNoticeSchema(null)).toBe(false);
  });

  it("P38 fix pass: a 42P01 / PGRST205 naming ANOTHER relation is not the record missing — the rows are deferred, not dropped", async () => {
    expect(isMissingNoticeSchema({ code: "42P01", message: 'relation "public.document_versions" does not exist' })).toBe(false);
    expect(isMissingNoticeSchema({ code: "PGRST205", message: "Could not find the table 'public.orgs' in the schema cache" })).toBe(false);
    seedReview();
    db.noticeError = { code: "42P01", message: 'relation "public.some_other_table" does not exist' };
    const errors = await cronRun("pre-publish-review", scanReviews, 0);
    expect(errors.join(" ")).not.toMatch(/not in this database yet/);
    expect(audits(DOCUMENT_NOTICE_RECORD_DEFERRED)).toHaveLength(1);
    expect(db.noticeWrites).toBe(2);
  });
});

describe("DIST-19 — the distribution-ack nag (lib/distributionAcks.ts scanDistributionAcks)", () => {
  const seed = () => {
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", document_number: "P-1", title: null, name: null, current_version_id: "v1", status: "Issued" }];
    db.tables.distribution_acks = [
      { id: "k1", org_id: "o1", document_id: "d1", version_id: "v1", rev_label: "C", recipient_user_id: "asg", recipient_email: "ash@x.com", requested_by: "own", requested_by_name: "Olive", requested_at: daysBefore(12), acknowledged_at: null },
      { id: "k2", org_id: "o1", document_id: "d1", version_id: "v1", rev_label: "C", recipient_user_id: "rev", recipient_email: "rae@x.com", requested_by: "own", requested_by_name: "Olive", requested_at: daysBefore(12), acknowledged_at: null },
    ];
  };

  it("each nudge that landed is a reminded row; the escalation is one escalated row per silent recipient it names", async () => {
    seed();
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(events("reminded").map((e) => `${e.recipient}:${e.source_id}:${e.version_id}`).sort()).toEqual(["asg:k1:v1", "rev:k2:v1"]);
    expect(events("escalated").map((e) => `${e.recipient}:${e.subject_user_id}:${e.source_id}`).sort()).toEqual(["own:asg:k1", "own:rev:k2"]);
  });

  it("one nudge per cooldown, read from the record: the bell rows purged the next day, nobody is nudged or escalated again inside the window", async () => {
    seed();
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(bells()).toHaveLength(3);
    db.tables.notifications = [];                                          // purged (or dismissed)
    await cronRun("distribution-acks", scanDistributionAcks, 1);
    expect(bells()).toHaveLength(0);
    await cronRun("distribution-acks", scanDistributionAcks, 4);          // the window has passed: nudged again
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);
    expect(bellsTo("own", "ack_overdue")).toHaveLength(1);
  });

  it("REGRESSION: a manual re-nudge (a bell row, not on the record) still holds the robot's nudge inside the window", async () => {
    seed();
    db.tables.notifications = [{ id: "n0", org_id: "o1", user_id: "asg", kind: "ack_requested", resource_id: "d1", metadata: { ackRequest: true }, created_at: daysBefore(1) }];
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);              // only the manual one
    expect(bellsTo("rev", "ack_requested")).toHaveLength(1);
  });

  it("REGRESSION: before 20261257 the nag counts from the bell rows alone and nudges exactly as before", async () => {
    seed();
    db.noticeError = { code: "42P01", message: 'relation "public.document_notice_events" does not exist' };
    db.tables.document_notice_events = undefined as unknown as Row[];
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(bells("ack_requested")).toHaveLength(2);
    expect(bells("ack_overdue")).toHaveLength(1);
    await cronRun("distribution-acks", scanDistributionAcks, 1);          // the bell rows are the watermark, as today
    expect(bells()).toHaveLength(3);
  });

  it("a dead-lettered nudge leaves no row, so the next run nudges that recipient again (DELIV-7 dw1 unchanged)", async () => {
    seed();
    db.failBellFor.add("rev");
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(events("reminded").map((e) => e.recipient)).toEqual(["asg"]);
    db.failBellFor.clear();
    await cronRun("distribution-acks", scanDistributionAcks, 1);
    expect(bellsTo("rev", "ack_requested")).toHaveLength(1);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);
  });
});

describe("DIST-19 (P38 fix pass) — the replay trusts only the recorder's own system rows", () => {
  const seedAcks = () => {
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", document_number: "P-1", title: null, name: null, current_version_id: "v1", status: "Issued" }];
    db.tables.distribution_acks = [
      { id: "k1", org_id: "o1", document_id: "d1", version_id: "v1", rev_label: "C", recipient_user_id: "asg", recipient_email: "ash@x.com", requested_by: "own", requested_by_name: "Olive", requested_at: daysBefore(12), acknowledged_at: null },
    ];
  };
  const keptRow = (over: Row = {}): Row => ({
    id: "f1", org_id: "o1", document_id: "d1", version_id: "v1", revision_label: "C", source: "distribution_ack", source_id: "k1",
    kind: "reminded", recipient: "asg", subject_user_id: "asg", notification_id: null, actor_name: "System", details: {}, noticed_at: daysBefore(5), ...over,
  });
  const deferredAudit = (id: string, userId: string | null, rows: Row[], at = daysBefore(5), source = "distribution_ack"): Row => ({
    id, org_id: "o1", action: DOCUMENT_NOTICE_RECORD_DEFERRED, resource_type: "document", resource_id: "d1", user_id: userId, timestamp: at,
    details: { source, error: "x", rows },
  });

  it("a deferred row a MEMBER wrote (user_id set — the audit_logs_insert path) is never replayed: no planted notice, and the nag still nudges", async () => {
    seedAcks();
    db.tables.audit_logs.push(deferredAudit("a-forged", "asg", [
      keptRow({ id: "forged-r", noticed_at: "2099-01-01T00:00:00.000Z" }),
      keptRow({ id: "forged-e", kind: "escalated", recipient: "own", noticed_at: "2099-01-01T00:00:00.000Z" }),
    ], daysBefore(1)));
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(events().some((e) => String(e.id).startsWith("forged"))).toBe(false);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);
    expect(bellsTo("own", "ack_overdue")).toHaveLength(1);
  });

  it("a system row's future noticed_at is clamped to when the audit row kept it, so it never withholds a nudge", async () => {
    seedAcks();
    db.tables.audit_logs.push(deferredAudit("a-sys", null, [keptRow({ id: "sys-r", noticed_at: "2099-01-01T00:00:00.000Z" })], daysBefore(5)));
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(events().find((e) => e.id === "sys-r")?.noticed_at).toBe(daysBefore(5));
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);              // 5 days ago is outside the 3-day window
  });

  it("the cooldown read never counts a record row dated in the future", async () => {
    seedAcks();
    db.tables.document_notice_events.push({ ...keptRow({ id: "planted", noticed_at: "2099-01-01T00:00:00.000Z" }) });
    expect(await recentDistributionNotices("o1", daysBefore(3))).toEqual({ reminded: new Set(), escalated: new Set() });
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);
  });

  it("each row is rebuilt from the columns only: extra keys (a forged created_at) dropped; a bad kind, another workspace or another source skipped and said; the rest written", async () => {
    seedAcks();
    db.tables.audit_logs.push(deferredAudit("a-mixed", null, [
      keptRow({ id: "ok-1", created_at: "2001-01-01T00:00:00.000Z", bogus: "x" }),
      keptRow({ id: "bad-kind", kind: "deleted" }),
      keptRow({ id: "other-org", org_id: "o2" }),
      keptRow({ id: "other-src", source: "acknowledgment" }),
      "not a row" as unknown as Row,
    ]));
    const errors = await cronRun("distribution-acks", scanDistributionAcks, 0);
    const ok1 = events().find((e) => e.id === "ok-1");
    expect(ok1).toBeDefined();
    expect(ok1).not.toHaveProperty("bogus");
    expect(ok1?.created_at).toBe(iso(T0));                                // the database's own clock, not the row's
    expect(events().map((e) => e.id)).not.toEqual(expect.arrayContaining(["bad-kind"]));
    expect(events().some((e) => ["bad-kind", "other-org", "other-src"].includes(String(e.id)))).toBe(false);
    expect(errors.join(" ")).toMatch(/4 deferred document notice record row\(s\) were not replayed/);
    expect(deferredNoticeRow(keptRow(), "o1", "distribution_ack", "not a time")).toBeNull();
  });

  it("a row the database refuses (a transient refusal) is skipped and said; the rest of its chunk and the next chunks are still written", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => keptRow({ id: `r-${String(i).padStart(3, "0")}` }));
    db.tables.audit_logs.push(deferredAudit("a-big", null, rows));
    db.refuseNoticeIds.set("r-010", "57014");
    vi.setSystemTime(T0);
    const errors: string[] = [];
    let written = 0;
    await runComplianceScan("replay@o1", async () => { written = await replayDeferredNotices("o1", "distribution_ack"); return written; }, errors, null);
    expect(written).toBe(249);
    expect(events()).toHaveLength(249);
    expect(events().some((e) => e.id === "r-010")).toBe(false);
    expect(errors.join(" ")).toMatch(/1 deferred document notice record row\(s\) could not be written \(canceling statement due to statement timeout \(row r-010\)\) — skipped this run and retried on the next/);
    expect(errors.join(" ")).not.toMatch(/dropped/);
  });

  it("merge-time fix pass: a row refused for good (23503 — its document or workspace gone; 22P02 — not a valid id) is dropped, said in ONE line per run, never 'retried on the next run'; a transient refusal still is", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => keptRow({ id: `r-${String(i).padStart(3, "0")}` }));
    db.tables.audit_logs.push(deferredAudit("a-gone", null, rows));
    for (const id of ["r-010", "r-011", "r-012"]) db.refuseNoticeIds.set(id, "23503");
    db.refuseNoticeIds.set("r-020", "22P02");
    db.refuseNoticeIds.set("r-030", "57014");
    const run = async () => {
      const errors: string[] = [];
      let written = 0;
      await runComplianceScan("replay@o1", async () => { written = await replayDeferredNotices("o1", "distribution_ack"); return written; }, errors, null);
      return { errors, written };
    };
    vi.setSystemTime(T0);
    const first = await run();
    expect(first.written).toBe(245);
    const dropLines = first.errors.filter((l) => /dropped/.test(l));
    expect(dropLines).toHaveLength(1);
    expect(dropLines[0]).toMatch(/4 deferred document notice record row\(s\) were dropped — refused for good \(23503: /);
    expect(dropLines[0]).not.toMatch(/retried/);
    const transient = first.errors.filter((l) => /retried on the next/.test(l));
    expect(transient).toHaveLength(1);
    expect(transient[0]).toMatch(/^replay@o1: 1 deferred document notice record row\(s\) could not be written \(canceling statement/);
    expect(first.errors).toHaveLength(2);                                  // never a line per row
    // the next run: the written rows are skipped (ON CONFLICT), the dropped ones said once again — one line, not four
    const second = await run();
    expect(second.errors.filter((l) => /dropped/.test(l))).toHaveLength(1);
    expect(second.errors.filter((l) => /retried on the next/.test(l))).toHaveLength(1);
    expect(events()).toHaveLength(245);
  });

  it("the audit read is keyset-paged past one page, and says so when it stops at the page cap", async () => {
    const at = (i: number) => iso(T0 - 2 * DAY + i * 1000);
    const n = DEFERRED_NOTICE_ROWS + 3;
    for (let i = 0; i < n; i += 1) db.tables.audit_logs.push(deferredAudit(`a-${String(i).padStart(5, "0")}`, null, [keptRow({ id: `p-${i}` })], at(i)));
    vi.setSystemTime(T0);
    let errors: string[] = [];
    await runComplianceScan("replay@o1", () => replayDeferredNotices("o1", "distribution_ack"), errors, null);
    expect(events()).toHaveLength(n);                                     // the oldest three, on page two, too
    expect(errors.join(" ")).not.toMatch(/read up to/);

    db.tables.document_notice_events = [];
    db.tables.audit_logs = [];
    const many = DEFERRED_NOTICE_ROWS * DEFERRED_NOTICE_PAGES + 1;
    for (let i = 0; i < many; i += 1) db.tables.audit_logs.push(deferredAudit(`b-${String(i).padStart(5, "0")}`, null, [keptRow({ id: `q-${i}` })], iso(T0 - 2 * DAY + i)));
    errors = [];
    await runComplianceScan("replay@o1", () => replayDeferredNotices("o1", "distribution_ack"), errors, null);
    expect(events()).toHaveLength(many - 1);
    expect(errors.join(" ")).toMatch(new RegExp(`read up to ${DEFERRED_NOTICE_ROWS * DEFERRED_NOTICE_PAGES} audit rows`));
  });
});

describe("DIST-19 (merge-time fix pass) — the deferred audit row carries only what a replay needs (every member reads audit_logs)", () => {
  const base = { org_id: "o1", document_id: "d1", version_id: "v1", revision_label: "C", source: "review_signoff" as const, source_id: "s1", recipient: "rev", subject_user_id: "rev" };

  it("a not_emailed row's deferred payload has no reason (a string, or any other type); no free text at all; numbers, booleans and the one enum value kept", () => {
    const ne = noticeRow({ ...base, kind: "not_emailed", details: { reason: "prefers the weekly digest", channel: "email", attempts: 2, muted: true } });
    const p = deferredPayloadRow(ne);
    expect(p.details).toEqual({ attempts: 2, muted: true });
    expect(p.details).not.toHaveProperty("reason");
    expect(JSON.stringify(p)).not.toMatch(/digest/);
    expect(deferrableDetails("not_emailed", { reason: 3 })).toEqual({});
    expect(deferrableDetails("not_emailed", { reason: { why: "x" } })).toEqual({});
    // the payload: ids, kind, source, noticed_at — never the revision label or the actor
    expect(Object.keys(p).sort()).toEqual(["details", "document_id", "id", "kind", "noticed_at", "notification_id", "org_id", "recipient", "source", "source_id", "subject_user_id", "version_id"]);
    // what the scans write survives: their numbers, and cause only as the enum value
    expect(deferrableDetails("alternate_activated", { cause: "review_timeout", timeoutDays: 7, ageDays: 9 })).toEqual({ cause: "review_timeout", timeoutDays: 7, ageDays: 9 });
    expect(deferrableDetails("alternate_activated", { cause: "anything else", note: "free text", list: [1], nested: { a: 1 }, nan: Number.NaN })).toEqual({});
  });

  it("the recorder's deferred audit row holds the minimal payload (a not_emailed reason never reaches audit_logs), and a replay rebuilds the row with the obligation's revision label", async () => {
    seedReview();
    db.noticeError = { code: "57014", message: "canceling statement due to statement timeout" };
    const errors: string[] = [];
    await runComplianceScan("pre-publish-review@o1", async () => {
      const rec = noticeRecorder();
      await rec.record([
        noticeRow({ ...base, kind: "reminded", details: { ageDays: 9 } }),
        noticeRow({ ...base, kind: "not_emailed", details: { reason: "prefers the weekly digest" } }),
      ]);
      return 0;
    }, errors, null);
    const deferred = audits(DOCUMENT_NOTICE_RECORD_DEFERRED);
    expect(deferred).toHaveLength(1);
    const text = JSON.stringify(deferred[0]);
    expect(text).not.toMatch(/digest/);
    expect(text).not.toMatch(/revision_label/);
    const kept = (deferred[0].details as { rows: Row[] }).rows;
    expect(kept.map((r) => r.details)).toEqual([{ ageDays: 9 }, {}]);

    db.noticeError = null;
    vi.setSystemTime(T0 + 1000);
    await runComplianceScan("replay@o1", () => replayDeferredNotices("o1", "review_signoff"), [], null);
    expect(events().map((e) => `${e.kind}:${e.revision_label}:${e.actor_name}`).sort()).toEqual(["not_emailed:C:System", "reminded:C:System"]);
    expect(events().find((e) => e.kind === "not_emailed")?.details).toEqual({});   // the reason is not on the record either — said in DIST-19
  });

  it("the scan's own deferred rows (refused twice) carry no revision label; the next run's replay writes the label the scan would have", async () => {
    seedReview();
    db.noticeError = { code: "57014", message: "canceling statement due to statement timeout" };
    await cronRun("pre-publish-review", scanReviews, 0);
    const kept = (audits(DOCUMENT_NOTICE_RECORD_DEFERRED)[0].details as { rows: Row[] }).rows;
    expect(kept.every((r) => !("revision_label" in r) && !("actor_name" in r))).toBe(true);
    db.noticeError = null;
    await cronRun("pre-publish-review", scanReviews, 1);
    expect(events()).toHaveLength(3);
    expect(events().every((e) => e.revision_label === "C" && e.actor_name === "System")).toBe(true);
  });

  it("a refused label read writes nothing this run (the rows stay deferred) and says so", async () => {
    seedReview();
    db.tables.audit_logs.push({ id: "a-1", org_id: "o1", action: DOCUMENT_NOTICE_RECORD_DEFERRED, resource_type: "document", resource_id: "d1", user_id: null, timestamp: daysBefore(1),
      details: { source: "review_signoff", error: "x", rows: [deferredPayloadRow(noticeRow({ ...base, kind: "reminded", noticedAt: daysBefore(1) }))] } });
    db.refuseReadOf.add("document_review_signoffs");
    const errors: string[] = [];
    let written = -1;
    await runComplianceScan("replay@o1", async () => { written = await replayDeferredNotices("o1", "review_signoff"); return written; }, errors, null);
    expect(written).toBe(0);
    expect(events()).toHaveLength(0);
    expect(errors.join(" ")).toMatch(/revision labels of 1 deferred document notice record row\(s\) could not be read \(permission denied/);
  });
});

describe("DIST-19 (merge-time fix pass) — the nag's cooldown read of the record is keyset-paged past PostgREST's max-rows", () => {
  const seedOne = () => {
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", document_number: "P-1", title: null, name: null, current_version_id: "v1", status: "Issued" }];
    db.tables.distribution_acks = [
      { id: "k1", org_id: "o1", document_id: "d1", version_id: "v1", rev_label: "C", recipient_user_id: "asg", recipient_email: "ash@x.com", requested_by: "own", requested_by_name: "Olive", requested_at: daysBefore(5), acknowledged_at: null },
    ];
  };
  // n reminded rows for other people inside the window, each newer than the target (so the target is the LAST row newest-first)
  const fill = (n: number) => {
    for (let i = 0; i < n; i += 1) {
      db.tables.document_notice_events.push({ id: `e-${String(i).padStart(6, "0")}`, org_id: "o1", document_id: `dx-${i}`, source: "distribution_ack", kind: "reminded", recipient: `u-${i}`, noticed_at: iso(T0 - DAY + i * 10) });
    }
  };
  const target = () => db.tables.document_notice_events.push({ id: "e-target", org_id: "o1", document_id: "d1", source: "distribution_ack", kind: "reminded", recipient: "asg", noticed_at: daysBefore(2) });

  it("with more than 1000 rows in the window, every one is counted: the target (the oldest) still holds the nudge after its bell row is purged", async () => {
    seedOne();
    fill(1500);
    target();
    const got = await recentDistributionNotices("o1", daysBefore(3));
    expect(got?.reminded.size).toBe(1501);
    expect(got?.reminded.has("asg:d1")).toBe(true);
    expect(db.noticeReads).toBe(3);                                       // 1000, 501, then the empty page
    db.noticeReads = 0;
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(0);             // one nudge per cooldown, past 1000 rows
  });

  it("a server max-rows LOWER than the page size never ends the read early (only an empty page ends it)", async () => {
    db.maxRows = 300;
    fill(1200);
    target();
    const got = await recentDistributionNotices("o1", daysBefore(3));
    expect(got?.reminded.size).toBe(1201);
  });

  it("REGRESSION: a read refused on a later page falls back exactly as today — null, the nag counts from the bell rows alone", async () => {
    seedOne();
    fill(1500);
    target();
    db.failNoticeReadAfter = 1;
    expect(await recentDistributionNotices("o1", daysBefore(3))).toBeNull();
    db.noticeReads = 0;
    await cronRun("distribution-acks", scanDistributionAcks, 0);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);             // no bell row in the window: nudged, as today
    // and with the bell row present, held, as today
    db.tables.notifications = [{ id: "n0", org_id: "o1", user_id: "asg", kind: "ack_requested", resource_id: "d1", metadata: { ackRequest: true }, created_at: iso(T0) }];
    db.noticeReads = 0;
    await cronRun("distribution-acks", scanDistributionAcks, 1);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);
  });

  it("the page cap: it stops after COOLDOWN_NOTICE_PAGES pages, says so in the run's line, and answers what it read (the union only ever withholds more than the bell rows alone)", async () => {
    fill(COOLDOWN_NOTICE_PAGES * COOLDOWN_NOTICE_ROWS + 5);
    const errors: string[] = [];
    let got: Awaited<ReturnType<typeof recentDistributionNotices>> = null;
    await runComplianceScan("distribution-acks@o1", async () => { got = await recentDistributionNotices("o1", daysBefore(3)); return 0; }, errors, null);
    expect(got!.reminded.size).toBe(COOLDOWN_NOTICE_PAGES * COOLDOWN_NOTICE_ROWS);
    expect(errors.join(" ")).toMatch(new RegExp(`stopped at ${COOLDOWN_NOTICE_PAGES * COOLDOWN_NOTICE_ROWS} rows \\(${COOLDOWN_NOTICE_PAGES} pages\\) — the window's older notices were counted from the bell rows alone, as before`));
  });
});

describe("DIST-19 — pins", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("notified_at is written exactly as before: the same statement, under the same every-notice-landed condition, in both scans", () => {
    expect(read("lib/reviewControl.ts")).toContain(`      if (landed.every(Boolean)) {
        await supabase.from("document_review_signoffs").update({ notified_at: new Date().toISOString() }).eq("id", r.id as string);
      }`);
    expect(read("lib/acknowledgments.ts")).toContain(`    if (landed.every(Boolean)) {
      await supabase.from("document_acknowledgments").update({ notified_at: new Date().toISOString() }).eq("id", r.id as string);
    }`);
  });
  it("the manual activation's audit row is exactly as before (no cause)", () => {
    expect(read("lib/reviewControl.ts")).toContain("details: input.cause ? { signoffId: input.signoffId, cause: input.cause } : { signoffId: input.signoffId }");
    expect(read("components/documents/ReviewGateSection.tsx")).toContain("await activateAlternate({ orgId, documentId: doc.id, libraryId: doc.libraryId, signoffId, actorId: uid });");
  });
  it("a row is built with a fresh id, the System as actor and no notification id", () => {
    const r = noticeRow({ org_id: "o", document_id: "d", version_id: null, revision_label: null, source: "acknowledgment", source_id: null, kind: "reminded", recipient: "u", subject_user_id: "u" });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r).toMatchObject({ actor_name: "System", notification_id: null, details: {} });
    const { id: _id, ...rest } = r;
    void _id;
    expect(noticeRow(rest).id).not.toBe(r.id);
  });
});
