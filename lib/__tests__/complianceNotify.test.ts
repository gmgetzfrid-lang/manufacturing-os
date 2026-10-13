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
  /** the browser's signed-in member (null: the service role — no session) */
  sessionUid: null as string | null,
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
    auth: {
      getSession: async () => ({ data: { session: db.sessionUid ? { user: { id: db.sessionUid } } : null }, error: null }),
    },
  },
}));

import {
  notifyCompliance, __setComplianceRetrySleep, __setComplianceRetryClock, __resetComplianceBreaker,
  COMPLIANCE_NOTIFY_ATTEMPTS, COMPLIANCE_RETRY_BACKOFF_MS, NOTIFICATION_DEAD_LETTER,
  BREAKER_DEAD_LETTERS, BREAKER_WINDOW_MS, SCOPE_LOST_MAX, DETERMINISTIC_REFUSAL,
} from "@/lib/complianceNotify";
import { runComplianceScan } from "@/lib/complianceNotifyScope";

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
const { actorUserId: _a, actorName: _n, ...ACTORLESS } = NOTICE;
const bellAttempts = () => db.inserts.filter((i) => i.table === "notifications");
const deadLetters = () => (db.rows.audit_logs ?? []).filter((a) => a.action === NOTIFICATION_DEAD_LETTER);
/** the fake clock: a backoff's wait advances it */
let clock: number;
let slept: number[];
let warn: ReturnType<typeof vi.spyOn>;
/** every notice of `n` fails every attempt with `message` */
const failAll = (n: number, message: string) => { for (let i = 0; i < n * COMPLIANCE_NOTIFY_ATTEMPTS; i++) db.failNotifications.push({ message }); };

beforeEach(() => {
  db.rows = {}; db.failNotifications = []; db.failAudit = null; db.inserts = []; db.sessionUid = null;
  slept = [];
  clock = Date.UTC(2026, 9, 13, 3, 0, 0);
  __setComplianceRetryClock(() => clock);
  __setComplianceRetrySleep(async (ms) => { slept.push(ms); clock += ms; });
  __resetComplianceBreaker();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { __setComplianceRetrySleep(null); __setComplianceRetryClock(null); __resetComplianceBreaker(); vi.restoreAllMocks(); });

describe("DELIV-16 — a compliance bell row that fails to land is retried", () => {
  it("REGRESSION: a row that lands first time is written once — the same row notify() writes, no wait, nothing dead-lettered", async () => {
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bellAttempts()).toHaveLength(1);
    expect(db.rows.notifications).toEqual([ROW]);
    expect(slept).toEqual([]);
    expect(db.rows.audit_logs).toBeUndefined();
  });

  it("the done-when: an insert that fails ONCE lands on the retry — the identical row, retried at once (the retry reads the refusal's text)", async () => {
    db.failNotifications = [{ code: "08006", message: "connection reset" }];
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bellAttempts().map((a) => a.row)).toEqual([ROW, ROW]);
    expect(db.rows.notifications).toEqual([ROW]);              // one row landed, not two
    expect(COMPLIANCE_RETRY_BACKOFF_MS[0]).toBe(0);
    expect(slept).toEqual([]);
    expect(db.rows.audit_logs).toBeUndefined();
  });

  it("two transient failures, then it lands on the third attempt, after a 1 s wait", async () => {
    db.failNotifications = [{ message: "timeout" }, { message: "timeout" }];
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bellAttempts()).toHaveLength(COMPLIANCE_NOTIFY_ATTEMPTS);
    expect(slept).toEqual([1000]);
    expect(db.rows.notifications).toEqual([ROW]);
  });

  it("every attempt fails: false, a legible warning line, ONE dead-letter audit row naming the kind, the recipient and the error", async () => {
    db.failNotifications = [{ message: "a" }, { message: "b" }, { code: "57014", message: "canceling statement due to statement timeout" }];
    expect(await notifyCompliance(NOTICE)).toBe(false);
    expect(bellAttempts()).toHaveLength(3);
    expect(db.rows.notifications).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[compliance-notify] ack_requested to u-assignee in org-1 was not written after 3 attempts — dead-lettered to the audit log: canceling statement due to statement timeout");
    expect(db.rows.audit_logs).toEqual([expect.objectContaining({
      action: NOTIFICATION_DEAD_LETTER, org_id: "org-1", resource_type: "document", resource_id: "d-1",
      user_id: "u-publisher",                                   // the writer, never the recipient
      details: {
        kind: "ack_requested", recipient: "u-assignee", error: "canceling statement due to statement timeout", attempts: 3,
        title: "Please acknowledge: P-101 Rev C", link: "/documents/lib-1?doc=d-1", resourceType: "document", resourceId: "d-1",
      },
    })]);
  });

  it("a server notice (no actor, no session — the cron) dead-letters as the system; a dead letter that fails too is logged, never thrown", async () => {
    failAll(1, "x");
    db.failAudit = { message: "audit refused" };
    await expect(notifyCompliance({ ...ACTORLESS, kind: "review_due" })).resolves.toBe(false);
    const audit = db.inserts.find((i) => i.table === "audit_logs")!.row;
    expect(audit.user_id).toBeNull();
    expect(audit.metadata).toMatchObject({ actor_kind: "system", actor_label: "system" });
    expect(console.error).toHaveBeenCalledWith("[compliance-notify] the dead letter for review_due to u-assignee was not written either: audit refused");
  });

  it("fix pass (major 2): a BROWSER notice that names no actor (ack_unsatisfiable at publish, review_overdue from the reviewer contingency) dead-letters as the signed-in member — the audit insert policy (user_id = auth.uid()) admits it", async () => {
    db.sessionUid = "u-session-publisher";
    failAll(1, "y");
    expect(await notifyCompliance({ ...ACTORLESS, kind: "ack_unsatisfiable" })).toBe(false);
    expect(deadLetters()).toEqual([expect.objectContaining({ user_id: "u-session-publisher", metadata: null })]);
    // an actor the producer names still wins over the session
    failAll(1, "y");
    await notifyCompliance(NOTICE);
    expect(deadLetters()[1].user_id).toBe("u-publisher");
  });

  it("the dead letter's writer is read only when a notice fails: a landed notice never reads the session", async () => {
    const getSession = vi.fn(async () => ({ data: { session: null } }));
    const { supabase } = await import("@/lib/supabase");
    vi.spyOn(supabase.auth, "getSession").mockImplementation(getSession as never);
    await notifyCompliance(ACTORLESS);
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("fix pass (major 1) — the retry is bounded: a systematic refusal cannot starve the cron", () => {
  it("(a) a refusal that cannot change (a policy, the rail, a constraint, a rate limit) is dead-lettered after the immediate retry that reads it — no wait, no third attempt", async () => {
    for (const message of [
      "new row violates row-level security policy for table \"notifications\"",
      "permission denied for table notifications",
      "notifications: unknown kind ack_unsatisfiable",
      "notifications: rate limit — 60 of the same notification to one person per minute",
      "new row for relation \"notifications\" violates check constraint \"notifications_kind_check\"",
      "invalid input syntax for type uuid: \"x\"",
    ]) expect(message, message).toMatch(DETERMINISTIC_REFUSAL);
    db.failNotifications = [{ message: "first" }, { code: "42501", message: "new row violates row-level security policy for table \"notifications\"" }];
    expect(await notifyCompliance(NOTICE)).toBe(false);
    expect(bellAttempts()).toHaveLength(2);
    expect(slept).toEqual([]);
    expect(deadLetters()[0].details).toMatchObject({ attempts: 2, error: expect.stringContaining("row-level security") });
    // transient text is not taken for a deterministic refusal
    for (const message of ["connection reset", "fetch failed", "canceling statement due to statement timeout"]) expect(message).not.toMatch(DETERMINISTIC_REFUSAL);
  });

  it("(a) 100 notices refused deterministically: the run waits 0 ms on them", async () => {
    failAll(100, "notifications: kind ack_requested is written only by the server");
    for (let i = 0; i < 100; i++) await notifyCompliance({ ...NOTICE, userId: `u-${i}` });
    expect(slept).toEqual([]);
    expect(deadLetters()).toHaveLength(100);
  });

  it("(b) the breaker: 100 notices failing TRANSIENTLY under the fake clock finish within 6 s of waits (unbounded: 100 s) — after 5 consecutive dead letters each gets its single attempt, until a write lands", async () => {
    failAll(100, "connection reset");
    const t0 = clock;
    for (let i = 0; i < 100; i++) await notifyCompliance({ ...NOTICE, userId: `u-${i}` });
    expect(clock - t0).toBeLessThanOrEqual(6_000);
    expect(slept).toEqual(Array(BREAKER_DEAD_LETTERS).fill(1000));
    expect(bellAttempts()).toHaveLength(BREAKER_DEAD_LETTERS * 3 + (100 - BREAKER_DEAD_LETTERS));
    expect(deadLetters()).toHaveLength(100);                    // every lost notice is still dead-lettered
    expect(deadLetters().at(-1)!.details).toMatchObject({ attempts: 1, error: expect.stringMatching(/not retried: the last \d+ compliance notices were dead-lettered within 60 s of each other/) });
    expect(deadLetters()[BREAKER_DEAD_LETTERS].details).toMatchObject({ attempts: 1, error: expect.stringContaining("not retried: the last 5 compliance notices") });
    // a write that lands closes it: the next failure is retried again
    db.failNotifications = [];
    expect(await notifyCompliance(NOTICE)).toBe(true);
    db.failNotifications = [{ message: "blip" }];
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bellAttempts().slice(-2)).toHaveLength(2);
  });

  it("(b) dead letters further apart than the window do not open it", async () => {
    for (let i = 0; i < BREAKER_DEAD_LETTERS + 2; i++) {
      failAll(1, "connection reset");
      await notifyCompliance(NOTICE);
      clock += BREAKER_WINDOW_MS + 1;
    }
    expect(slept).toEqual(Array(BREAKER_DEAD_LETTERS + 2).fill(1000));
    expect(bellAttempts()).toHaveLength((BREAKER_DEAD_LETTERS + 2) * 3);
  });

  it("(c) inside a cron scan, no wait is slept past the run's retry deadline — before it the full retry, at it one attempt", async () => {
    const errors: string[] = [];
    failAll(3, "connection reset");
    await runComplianceScan("review-cycles@org-1", async () => {
      await notifyCompliance({ ...NOTICE, userId: "u-early" });  // deadline 5 s away: the full retry
      await notifyCompliance({ ...NOTICE, userId: "u-near" });   // 0.5 s left: the immediate retry, not the 1 s wait
      clock += 1000;
      await notifyCompliance({ ...NOTICE, userId: "u-late" });   // past it: the single attempt
      return 3;
    }, errors, clock + 1500);
    expect(slept).toEqual([1000]);
    expect(deadLetters().map((d) => (d.details as Row).attempts)).toEqual([3, 2, 1]);
    expect(String((deadLetters()[2].details as Row).error)).toContain("past the run's retry deadline");
  });

  it("(c) 100 transient failures in a scan already past its deadline: 0 ms of waits", async () => {
    failAll(100, "connection reset");
    __resetComplianceBreaker();
    await runComplianceScan("retention@org-1", async () => {
      for (let i = 0; i < 100; i++) await notifyCompliance({ ...NOTICE, userId: `u-${i}` });
      return 100;
    }, [], clock - 1);
    expect(slept).toEqual([]);
    expect(bellAttempts()).toHaveLength(100);
  });
});

describe("fix pass (minor 1) — the cron's shortfall is scoped to the scan's own async context", () => {
  it("a scan's dead letters are ONE line under its label, counted exactly; the entries kept are bounded", async () => {
    const errors: string[] = [];
    failAll(SCOPE_LOST_MAX + 5, "notifications: unknown kind ack_requested");
    const n = await runComplianceScan("read-understood@org-1", async () => {
      for (let i = 0; i < SCOPE_LOST_MAX + 5; i++) await notifyCompliance({ ...NOTICE, userId: `u-${i}` });
      return SCOPE_LOST_MAX + 5;
    }, errors, null);
    expect(n).toBe(SCOPE_LOST_MAX + 5);
    expect(errors).toEqual([`read-understood@org-1: ${SCOPE_LOST_MAX + 5} compliance notice(s) were not written (dead-lettered to the audit log; the scan's count still includes them) — e.g. ack_requested to u-0: notifications: unknown kind ack_requested`]);
  });

  it("a notice another request loses meanwhile (same instance, outside the scan's context) is not attributed to the scan", async () => {
    const errors: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const scan = runComplianceScan("access-recert@org-1", async () => { await gate; await notifyCompliance(NOTICE); return 1; }, errors, null);
    failAll(1, "permission denied for table notifications");
    await notifyCompliance({ ...NOTICE, userId: "u-other-request" }); // a concurrent server request
    release();
    await scan;                                                       // the scan's own notice lands
    expect(errors).toEqual([]);
    expect(deadLetters()).toHaveLength(1);                            // the other request's notice is still dead-lettered
  });

  it("a scan that throws still reports what it lost, and the throw reaches the caller's own line", async () => {
    const errors: string[] = [];
    failAll(1, "permission denied for table notifications");
    await expect(runComplianceScan("effective-dates@org-1", async () => { await notifyCompliance(NOTICE); throw new Error("scan read failed"); }, errors, null)).rejects.toThrow("scan read failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^effective-dates@org-1: 1 compliance notice\(s\) were not written/);
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

  it("the cron runs each scan in its own collector, with the retry deadline that keeps the digest's time — ONE line in the step-6 loop (an integrator merge item)", () => {
    const cron = src("app/api/cron/maintenance/route.ts");
    expect(cron).toContain('import { runComplianceScan } from "@/lib/complianceNotifyScope";');
    expect(cron).toContain("result.complianceNotices += await runComplianceScan(`${name}@${org.id}`, () => fn(org.id), result.errors, runEnd - DIGEST_FLOOR_MS - AFTER_DIGEST_RESERVE_MS);");
    expect(cron).not.toContain("drainComplianceShortfall");
    // the browser bundle never imports the scope (node:async_hooks)
    expect(src("lib/complianceNotify.ts")).not.toMatch(/from "node:async_hooks"|from "@\/lib\/complianceNotifyScope"/);
  });
});
