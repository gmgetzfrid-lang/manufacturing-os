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
//     (a manual re-nudge still counts): one nudge per cooldown.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failBellFor: new Set<string>(),
  /** the next document_notice_events writes answer this error (null: they land) */
  noticeError: null as null | { code?: string; message: string },
  noticeWrites: 0,
  seq: 0,
}));

function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(/,(?![^(]*\))(?![^{]*\})/);
  const preds = parts.map((p) => {
    let m: RegExpExecArray | null;
    if ((m = /^(\w+)\.in\.\(([^)]*)\)$/.exec(p))) { const list = m[2].split(","); const col = m[1]; return (r: Row) => list.includes(String(r[col])); }
    if ((m = /^(\w+)\.ov\.\{([^}]*)\}$/.exec(p))) { const list = m[2].split(","); const col = m[1]; return (r: Row) => Array.isArray(r[col]) && (r[col] as string[]).some((x) => list.includes(x)); }
    if ((m = /^(\w+)\.is\.null$/.exec(p))) { const col = m[1]; return (r: Row) => r[col] == null; }
    if ((m = /^(\w+)\.lt\.(.+)$/.exec(p))) { const col = m[1]; const v = m[2]; return (r: Row) => r[col] != null && String(r[col]) < v; }
    return () => false;
  });
  return (r) => preds.some((p) => p(r));
}

function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let update: Row | null = null;
  let insert: Row[] | null = null;
  let upsertIgnore = false;
  let order: { col: string; asc: boolean } | null = null;
  let limit = Infinity;
  const matching = () => {
    let rows = (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (order) { const { col, asc } = order; rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)); }
    return rows.slice(0, limit);
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
          case "order": order = { col, asc: (a1 as { ascending?: boolean } | undefined)?.ascending !== false }; break;
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
import { DOCUMENT_NOTICE_RECORD_DEFERRED, isMissingNoticeSchema, noticeRow } from "@/lib/documentNoticeRecord";

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
