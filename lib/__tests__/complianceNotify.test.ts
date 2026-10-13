// notifications Round G — N14 RAW-INSERT TAIL: a compliance notice's bell
// row is retried, and dead-lettered when it never lands (DELIV-16; DELIV-7
// done-when 1 — the compliance producers' notices surface a refused write).
//
// Driven through the REAL lib/inAppNotifications (notify / notifyWithReason)
// and lib/audit on a fake shared client whose notifications inserts fail on
// demand. The cron's half (the scan's shortfall reported in the run's
// errors) is in lib/__tests__/maintenanceDrain.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  /** the next N notifications inserts fail with these errors, in order */
  failNotifications: [] as Array<{ code?: string; message: string }>,
  failAudit: null as null | { message: string },
  inserts: [] as Array<{ table: string; row: Row }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: async (row: Row) => {
        db.inserts.push({ table, row });
        if (table === "notifications" && db.failNotifications.length > 0) return { error: db.failNotifications.shift() };
        if (table === "audit_logs" && db.failAudit) return { error: db.failAudit };
        (db.rows[table] ??= []).push(row);
        return { error: null };
      },
    }),
  },
}));

import {
  notifyCompliance, drainComplianceShortfall, __setComplianceRetrySleep,
  COMPLIANCE_NOTIFY_ATTEMPTS, COMPLIANCE_RETRY_BACKOFF_MS, NOTIFICATION_DEAD_LETTER,
} from "@/lib/complianceNotify";

const NOTICE = {
  orgId: "org-1", userId: "u-assignee", kind: "ack_requested" as const,
  title: "Please acknowledge: P-101 Rev C", body: "Read and acknowledge the issued revision.",
  link: "/documents/lib-1?doc=d-1", resourceType: "document", resourceId: "d-1",
  actorUserId: "u-publisher", actorName: "Pat Publisher",
};
const ROW = {
  org_id: "org-1", user_id: "u-assignee", kind: "ack_requested",
  title: "Please acknowledge: P-101 Rev C", body: "Read and acknowledge the issued revision.",
  link: "/documents/lib-1?doc=d-1", resource_type: "document", resource_id: "d-1",
  actor_user_id: "u-publisher", actor_name: "Pat Publisher", metadata: null,
};
const bellAttempts = () => db.inserts.filter((i) => i.table === "notifications");
let slept: number[];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.rows = {}; db.failNotifications = []; db.failAudit = null; db.inserts = [];
  slept = [];
  __setComplianceRetrySleep(async (ms) => { slept.push(ms); });
  drainComplianceShortfall();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { __setComplianceRetrySleep(null); vi.restoreAllMocks(); });

describe("DELIV-16 — a compliance bell row that fails to land is retried", () => {
  it("REGRESSION: a row that lands first time is written once — the same row notify() writes, no wait, nothing dead-lettered", async () => {
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bellAttempts()).toHaveLength(1);
    expect(db.rows.notifications).toEqual([ROW]);
    expect(slept).toEqual([]);
    expect(db.rows.audit_logs).toBeUndefined();
    expect(drainComplianceShortfall()).toEqual([]);
  });

  it("the done-when: an insert that fails ONCE lands on the retry — the identical row, after the first backoff", async () => {
    db.failNotifications = [{ code: "08006", message: "connection reset" }];
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bellAttempts().map((a) => a.row)).toEqual([ROW, ROW]);
    expect(db.rows.notifications).toEqual([ROW]);              // one row landed, not two
    expect(slept).toEqual([COMPLIANCE_RETRY_BACKOFF_MS[0]]);
    expect(db.rows.audit_logs).toBeUndefined();
    expect(drainComplianceShortfall()).toEqual([]);
  });

  it("two failures, then it lands on the third attempt; the waits back off (250 ms, then 1 s)", async () => {
    db.failNotifications = [{ message: "timeout" }, { message: "timeout" }];
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bellAttempts()).toHaveLength(COMPLIANCE_NOTIFY_ATTEMPTS);
    expect(slept).toEqual([250, 1000]);
    expect(db.rows.notifications).toEqual([ROW]);
  });

  it("every attempt fails: false, a legible warning line, ONE dead-letter audit row naming the kind, the recipient and the error, and one shortfall entry", async () => {
    db.failNotifications = [{ message: "a" }, { message: "b" }, { code: "P0001", message: "notification cap reached" }];
    expect(await notifyCompliance(NOTICE)).toBe(false);
    expect(bellAttempts()).toHaveLength(3);
    expect(db.rows.notifications).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[compliance-notify] ack_requested to u-assignee in org-1 was not written after 3 attempts — dead-lettered to the audit log: notification cap reached");
    expect(db.rows.audit_logs).toEqual([expect.objectContaining({
      action: NOTIFICATION_DEAD_LETTER, org_id: "org-1", resource_type: "document", resource_id: "d-1",
      user_id: "u-publisher",                                   // the writer, never the recipient
      details: {
        kind: "ack_requested", recipient: "u-assignee", error: "notification cap reached", attempts: 3,
        title: "Please acknowledge: P-101 Rev C", link: "/documents/lib-1?doc=d-1", resourceType: "document", resourceId: "d-1",
      },
    })]);
    expect(drainComplianceShortfall()).toEqual([{ orgId: "org-1", userId: "u-assignee", kind: "ack_requested", error: "notification cap reached" }]);
    expect(drainComplianceShortfall()).toEqual([]);             // drained once
  });

  it("a server notice (no actor — the cron) dead-letters as the system; a dead letter that fails too is logged, never thrown", async () => {
    db.failNotifications = [{ message: "x" }, { message: "y" }, { message: "z" }];
    db.failAudit = { message: "audit refused" };
    const { actorUserId: _a, actorName: _n, ...serverNotice } = NOTICE;
    await expect(notifyCompliance({ ...serverNotice, kind: "review_due" })).resolves.toBe(false);
    const audit = db.inserts.find((i) => i.table === "audit_logs")!.row;
    expect(audit.user_id).toBeNull();
    expect(audit.metadata).toMatchObject({ actor_kind: "system", actor_label: "system" });
    expect(console.error).toHaveBeenCalledWith("[compliance-notify] the dead letter for review_due to u-assignee was not written either: audit refused");
  });

  it("the shortfall the cron reads is bounded (the browser never drains it)", async () => {
    for (let i = 0; i < 205; i++) {
      db.failNotifications.push({ message: `e${i}a` }, { message: `e${i}b` }, { message: `e${i}c` });
      await notifyCompliance({ ...NOTICE, userId: `u-${i}` });
    }
    const lost = drainComplianceShortfall();
    expect(lost).toHaveLength(200);
    expect(lost[0].userId).toBe("u-5");                          // the newest kept
    expect(lost.at(-1)!.userId).toBe("u-204");
  });
});

describe("DELIV-16 / DELIV-7 dw1 — which producers write through it", () => {
  const ROOT = process.cwd();
  const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
  const PRODUCERS = ["lib/reviewCycles.ts", "lib/acknowledgments.ts", "lib/reviewControl.ts", "lib/effectiveDate.ts", "lib/retention.ts", "lib/accessRecert.ts", "lib/ownership.ts"];

  it("the compliance producers' bell notices are notifyCompliance (imported as notify, so the actor census still reads every call), and none keeps the bare insert", () => {
    for (const f of PRODUCERS) {
      const s = src(f);
      expect(s, f).toContain('import { notifyCompliance as notify } from "@/lib/complianceNotify";');
      expect(s, f).not.toMatch(/import \{[^}]*\bnotify\b[^}]*\} from "@\/lib\/inAppNotifications"/);
      expect(s, f).toMatch(/\bnotify\(\{/);
    }
  });

  it("the cron reads each scan's shortfall into the run's errors — never a silent success", () => {
    const cron = src("app/api/cron/maintenance/route.ts");
    expect(cron).toMatch(/result\.complianceNotices \+= await fn\(org\.id\);[\s\S]*?const lost = drainComplianceShortfall\(\);\s+if \(lost\.length > 0\) \{\s+result\.errors\.push\(`\$\{name\}@\$\{org\.id\}: \$\{lost\.length\} compliance notice\(s\) were not written/);
  });
});
