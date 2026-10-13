// notifications Round G — N14 RAW-INSERT TAIL, integrator fix pass (DELIV-7
// done-when 1, the re-review's minor 5): a step-6 scan stamps a row's
// cooldown only when every notice it sent for that row LANDED. A notice that
// was dead-lettered is sent again on the next run — to its recipient only:
// whoever already got that row's notices does not get a second copy.
//
// Driven through the REAL scans (lib/acknowledgments, lib/reviewControl,
// lib/reviewCycles, lib/accessRecert, lib/effectiveDate, lib/retention), the
// REAL lib/complianceNotify / lib/inAppNotifications / lib/audit / lib/ownership,
// inside lib/complianceNotifyScope's collector (the cron's service-role scan),
// on a filter-aware in-memory client whose bell inserts are refused for the
// recipients a test names.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** a notifications insert addressed to one of these is refused */
  failBellFor: new Set<string>(),
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
      const at = new Date().toISOString();
      for (const r of rows) (db.tables[table] ??= []).push({ id: `${table}-${++db.seq}`, created_at: at, timestamp: at, ...r });
      return { data: null, error: null, count: rows.length };
    }
    if (update) {
      const hit = matching();
      for (const r of hit) Object.assign(r, update);
      return { data: hit.map((r) => ({ id: r.id })), error: null };
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

import { __setComplianceRetrySleep, __resetComplianceBreaker, NOTIFICATION_DEAD_LETTER } from "@/lib/complianceNotify";
import { runComplianceScan } from "@/lib/complianceNotifyScope";
import { scanAndNotifyAcks } from "@/lib/acknowledgments";
import { scanReviews } from "@/lib/reviewControl";
import { scanAndNotifyReviews } from "@/lib/reviewCycles";
import { scanAccessRecerts } from "@/lib/accessRecert";
import { scanEffectiveDates } from "@/lib/effectiveDate";
import { scanRetention } from "@/lib/retention";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 13, 3, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const daysBefore = (n: number) => iso(T0 - n * DAY);

/** One cron run of one scan (the service-role scan context), on day `day`
 *  after T0. Answers the run's error lines. */
async function cronRun(label: string, fn: (orgId: string) => Promise<number>, day: number): Promise<string[]> {
  vi.setSystemTime(T0 + day * DAY);
  const errors: string[] = [];
  await runComplianceScan(`${label}@o1`, () => fn("o1"), errors, null);
  return errors;
}
const bells = (kind?: string) => (db.tables.notifications ?? []).filter((n) => !kind || n.kind === kind);
const bellsTo = (uid: string, kind?: string) => bells(kind).filter((n) => n.user_id === uid);
const deadLetters = () => (db.tables.audit_logs ?? []).filter((a) => a.action === NOTIFICATION_DEAD_LETTER);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  db.seq = 0;
  db.failBellFor = new Set();
  db.tables = {
    org_members: [
      { uid: "ctrl", org_id: "o1", status: "active", role: "DocCtrl", roles: ["DocCtrl"], display_name: "Cal" },
      { uid: "own", org_id: "o1", status: "active", role: "Engineer-1", roles: ["Engineer-1"], display_name: "Olive" },
      { uid: "asg", org_id: "o1", status: "active", role: "Engineer-1", roles: ["Engineer-1"], display_name: "Ash" },
      { uid: "rev", org_id: "o1", status: "active", role: "Engineer-1", roles: ["Engineer-1"], display_name: "Rae" },
    ],
    libraries: [{ id: "L", org_id: "o1", name: "Drawings", owner_user_id: null, owner_name: null, owner_team_id: null, review_policy: null, review_control: null, retention_policy: null }],
    collections: [],
    teams: [],
    notifications: [],
    audit_logs: [],
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

describe("DELIV-7 dw1 residual — read-understood (lib/acknowledgments.ts scanAndNotifyAcks)", () => {
  const seed = () => {
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, document_number: "P-1", title: null, name: null, owner_user_id: "own", owner_name: "Olive" }];
    db.tables.document_acknowledgments = [{ id: "a1", org_id: "o1", status: "pending", document_id: "d1", assignee_user_id: "asg", assignee_name: "Ash", revision_label: "C", notified_at: daysBefore(8), assigned_at: daysBefore(40) }];
  };
  const stamp = () => db.tables.document_acknowledgments[0].notified_at;

  it("REGRESSION: every notice lands — the reminder and both escalations once each, and the row's cooldown is stamped", async () => {
    seed();
    expect(await cronRun("read-understood", scanAndNotifyAcks, 0)).toEqual([]);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);
    expect(bellsTo("own", "ack_overdue")).toHaveLength(1);
    expect(bellsTo("ctrl", "ack_overdue")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0));
  });

  it("an escalation that dead-letters leaves the cooldown unstamped; the next run sends it to that recipient ONLY — the others keep exactly one", async () => {
    seed();
    db.failBellFor.add("ctrl");
    const errors = await cronRun("read-understood", scanAndNotifyAcks, 0);
    expect(errors).toHaveLength(1);
    expect(deadLetters()).toHaveLength(1);
    expect(stamp()).toBe(daysBefore(8));                       // not stamped: the next run retries
    db.failBellFor.clear();
    expect(await cronRun("read-understood", scanAndNotifyAcks, 1)).toEqual([]);
    expect(bellsTo("ctrl", "ack_overdue")).toHaveLength(1);    // the lost notice, sent again
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);   // no second copy
    expect(bellsTo("own", "ack_overdue")).toHaveLength(1);     // no second copy
    expect(stamp()).toBe(iso(T0 + DAY));                       // every notice landed: stamped
    await cronRun("read-understood", scanAndNotifyAcks, 2);    // within the cooldown: nothing
    expect(bells()).toHaveLength(3);
  });

  it("the assignee's own reminder dead-letters: the next run re-sends the reminder only", async () => {
    seed();
    db.failBellFor.add("asg");
    await cronRun("read-understood", scanAndNotifyAcks, 0);
    expect(stamp()).toBe(daysBefore(8));
    db.failBellFor.clear();
    await cronRun("read-understood", scanAndNotifyAcks, 1);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);
    expect(bells("ack_overdue")).toHaveLength(2);              // own + ctrl, once each (day 0)
  });

  it("a retry that fails again is retried again — and a recipient the retry reached is not sent a third copy", async () => {
    seed();
    db.failBellFor = new Set(["ctrl", "own"]);
    await cronRun("read-understood", scanAndNotifyAcks, 0);
    db.failBellFor = new Set(["ctrl"]);
    await cronRun("read-understood", scanAndNotifyAcks, 1);    // own lands; ctrl lost again
    expect(stamp()).toBe(daysBefore(8));
    db.failBellFor.clear();
    await cronRun("read-understood", scanAndNotifyAcks, 2);
    expect(bellsTo("own", "ack_overdue")).toHaveLength(1);
    expect(bellsTo("ctrl", "ack_overdue")).toHaveLength(1);
    expect(bellsTo("asg", "ack_requested")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0 + 2 * DAY));
  });
});

describe("DELIV-7 dw1 residual — pre-publish-review (lib/reviewControl.ts scanReviews)", () => {
  const seed = () => {
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, review_control: null, owner_user_id: "own", owner_name: "Olive" }];
    db.tables.document_review_signoffs = [{ id: "s1", org_id: "o1", status: "pending", document_id: "d1", document_version_id: "v1", reviewer_user_id: "rev", reviewer_name: "Rae", revision_label: "B", slot: "primary", activated: true, notified_at: daysBefore(6), assigned_at: daysBefore(30) }];
  };
  const stamp = () => db.tables.document_review_signoffs[0].notified_at;

  it("REGRESSION: all land — once each, stamped", async () => {
    seed();
    await cronRun("pre-publish-review", scanReviews, 0);
    expect(bellsTo("rev", "review_requested")).toHaveLength(1);
    expect(bellsTo("own", "review_overdue")).toHaveLength(1);
    expect(bellsTo("ctrl", "review_overdue")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0));
  });

  it("the reviewer's reminder dead-letters: unstamped, and the next run sends it to the reviewer only", async () => {
    seed();
    db.failBellFor.add("rev");
    await cronRun("pre-publish-review", scanReviews, 0);
    expect(stamp()).toBe(daysBefore(6));
    db.failBellFor.clear();
    await cronRun("pre-publish-review", scanReviews, 1);
    expect(bellsTo("rev", "review_requested")).toHaveLength(1);
    expect(bells("review_overdue")).toHaveLength(2);
    expect(stamp()).toBe(iso(T0 + DAY));
  });
});

describe("DELIV-7 dw1 residual — review-cycles (lib/reviewCycles.ts scanAndNotifyReviews)", () => {
  const seed = () => {
    db.tables.documents = [{ id: "d2", org_id: "o1", library_id: "L", collection_id: null, document_number: "P-2", title: null, name: null, review_policy: null, next_review_date: "2026-01-01", review_notified_at: daysBefore(9), owner_user_id: "own", owner_name: "Olive" }];
  };
  const stamp = () => db.tables.documents[0].review_notified_at;

  it("REGRESSION: the owner's notice and the controller's escalation once each, stamped", async () => {
    seed();
    await cronRun("review-cycles", scanAndNotifyReviews, 0);
    expect(bellsTo("own", "review_due")).toHaveLength(1);
    expect(bellsTo("ctrl", "owner_behind")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0));
  });

  it("the owner's notice dead-letters: unstamped; the next run sends it to the owner only", async () => {
    seed();
    db.failBellFor.add("own");
    await cronRun("review-cycles", scanAndNotifyReviews, 0);
    expect(stamp()).toBe(daysBefore(9));
    db.failBellFor.clear();
    await cronRun("review-cycles", scanAndNotifyReviews, 1);
    expect(bellsTo("own", "review_due")).toHaveLength(1);
    expect(bellsTo("ctrl", "owner_behind")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0 + DAY));
  });
});

describe("DELIV-7 dw1 residual — access-recert (lib/accessRecert.ts scanAccessRecerts)", () => {
  const seed = () => {
    db.tables.libraries.push({ id: "L2", org_id: "o1", name: "Specs", next_recertification_date: "2026-09-01", recert_notified_at: daysBefore(10), owner_user_id: "own" });
  };
  const stamp = () => db.tables.libraries.find((l) => l.id === "L2")!.recert_notified_at;

  it("REGRESSION: the owner and the controller once each, stamped", async () => {
    seed();
    await cronRun("access-recert", scanAccessRecerts, 0);
    expect(bellsTo("own", "access_recert_due")).toHaveLength(1);
    expect(bellsTo("ctrl", "access_recert_due")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0));
  });

  it("the controller's notice dead-letters: unstamped; the next run sends it to the controller only", async () => {
    seed();
    db.failBellFor.add("ctrl");
    await cronRun("access-recert", scanAccessRecerts, 0);
    expect(stamp()).toBe(daysBefore(10));
    db.failBellFor.clear();
    await cronRun("access-recert", scanAccessRecerts, 1);
    expect(bellsTo("own", "access_recert_due")).toHaveLength(1);
    expect(bellsTo("ctrl", "access_recert_due")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0 + DAY));
  });
});

describe("DELIV-7 dw1 residual — effective-dates (lib/effectiveDate.ts scanEffectiveDates, a one-shot notice)", () => {
  const seed = () => {
    db.tables.documents = [{ id: "d3", org_id: "o1", library_id: "L", collection_id: null, document_number: "P-3", title: null, name: null, rev: "D", effective_date: "2026-10-01", effective_notified_at: null, owner_user_id: "own", owner_name: "Olive", current_version_id: "v3" }];
    db.tables.document_versions = [{ id: "v3", effective_date: "2026-10-01" }];
    db.tables.document_acknowledgments = [{ id: "a3", org_id: "o1", document_id: "d3", assignee_user_id: "asg", status: "acknowledged" }];
  };
  const stamp = () => db.tables.documents[0].effective_notified_at;

  it("REGRESSION: the owner and the roster once each; the watermark set", async () => {
    seed();
    await cronRun("effective-dates", scanEffectiveDates, 0);
    expect(bellsTo("own", "effective_now")).toHaveLength(1);
    expect(bellsTo("asg", "effective_now")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0));
  });

  it("a recipient's 'now in effect' dead-letters: the watermark stays unset; the next run tells that recipient only", async () => {
    seed();
    db.failBellFor.add("asg");
    await cronRun("effective-dates", scanEffectiveDates, 0);
    expect(stamp()).toBeNull();
    db.failBellFor.clear();
    await cronRun("effective-dates", scanEffectiveDates, 1);
    expect(bellsTo("own", "effective_now")).toHaveLength(1);
    expect(bellsTo("asg", "effective_now")).toHaveLength(1);
    expect(stamp()).toBe(iso(T0 + DAY));
  });
});

describe("DELIV-7 dw1 residual — retention (lib/retention.ts scanRetention, stamped with the flag before it notifies)", () => {
  const seed = () => {
    db.tables.documents = [{ id: "d4", org_id: "o1", library_id: "L", collection_id: null, document_number: "P-4", title: null, name: null, retention_until: "2026-01-01", retention_policy: null, retention_notified_at: null, disposition_state: null, legal_hold: false, owner_user_id: "own", owner_name: "Olive" }];
  };
  const doc = () => db.tables.documents[0];

  it("REGRESSION: flagged, the owner and the controller once each, stamped", async () => {
    seed();
    await cronRun("retention", scanRetention, 0);
    expect(doc().disposition_state).toBe("eligible");
    expect(bellsTo("own", "retention_eligible")).toHaveLength(1);
    expect(bellsTo("ctrl", "retention_eligible")).toHaveLength(1);
    expect(doc().retention_notified_at).toBe(iso(T0));
  });

  it("the owner's notice dead-letters: the flag stays, the stamp is put back, and the next run tells the owner only", async () => {
    seed();
    db.failBellFor.add("own");
    await cronRun("retention", scanRetention, 0);
    expect(doc().disposition_state).toBe("eligible");
    expect(doc().retention_notified_at).toBeNull();
    db.failBellFor.clear();
    await cronRun("retention", scanRetention, 1);
    expect(bellsTo("own", "retention_eligible")).toHaveLength(1);
    expect(bellsTo("ctrl", "retention_eligible")).toHaveLength(1);
    expect(doc().retention_notified_at).toBe(iso(T0 + DAY));
  });
});
