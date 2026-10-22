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
  /** the next N notifications inserts fail with these errors, in order
   *  (null: that insert is not failed here) */
  failNotifications: [] as Array<{ code?: string; message: string } | null>,
  failAudit: null as null | { message: string },
  inserts: [] as Array<{ table: string; row: Row }>,
  /** the browser's signed-in member (null: the service role — no session) */
  sessionUid: null as string | null,
  createdAt: new WeakMap<Row, string>(),
  /** the next N notifications inserts COMMIT, then answer this error (the
   *  response was lost: a reset or "fetch failed" after the commit) */
  lostResponses: [] as Array<{ message: string }>,
  /** the read-back of the bell rows fails with this error */
  failReadBack: null as null | { message: string },
  readBacks: 0,
  /** the fake clock's reading, for the rows' created_at */
  clockMs: 0,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: async (row: Row) => {
        db.inserts.push({ table, row });
        if (table === "notifications" && db.failNotifications.length > 0) {
          const f = db.failNotifications.shift();
          if (f) return { error: f };
        }
        if (table === "audit_logs" && db.failAudit) return { error: db.failAudit };
        // the insert rail (20261160) stamps a signed-in writer as the row's actor
        if (table === "notifications" && db.sessionUid && row.actor_user_id == null) row = { ...row, actor_user_id: db.sessionUid };
        // the primary key (after the rail — a queued failure above stands for a rail refusal)
        if (table === "notifications" && row.id != null && (db.rows.notifications ?? []).some((r) => r.id === row.id)) {
          return { error: { code: "23505", message: 'duplicate key value violates unique constraint "notifications_pkey"' } };
        }
        (db.rows[table] ??= []).push(row);
        if (table === "notifications") db.createdAt.set(row, new Date(db.clockMs).toISOString());
        if (table === "notifications" && db.lostResponses.length > 0) return { error: db.lostResponses.shift() };
        return { error: null };
      },
      // the read-back: select("id").eq(...)….is/eq(resource_id).gte("created_at", since).limit(1)
      select: () => {
        const preds: Array<(r: Row) => boolean> = [];
        const q = {
          eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return q; },
          is: (c: string, v: unknown) => { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
          gte: (c: string, v: string) => { preds.push((r) => c === "created_at" && (db.createdAt.get(r) ?? "") >= v); return q; },
          limit: async (n: number) => {
            db.readBacks += 1;
            if (db.failReadBack) return { data: null, error: db.failReadBack };
            // notifications_own_select: a signed-in browser reads only its own rows
            const visible = (db.rows[table] ?? []).filter((r) => !(table === "notifications" && db.sessionUid) || r.user_id === db.sessionUid);
            return { data: visible.filter((r) => preds.every((p) => p(r))).slice(0, n).map(() => ({ id: "n" })), error: null };
          },
        };
        return q;
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
/** Run `fn` inside a cron scan's collector — the service-role context, where
 *  a read-back of the bell rows is authoritative, so a failed notice is
 *  retried (integrator fix pass, re-review minor 3). */
async function inCron<T>(fn: () => Promise<T>, errors: string[] = [], deadlineMs: number | null = null, label = "test@org-1"): Promise<T> {
  let out!: T;
  await runComplianceScan(label, async () => { out = await fn(); return 0; }, errors, deadlineMs);
  return out;
}
/** every notice of `n` fails every attempt with `message` */
const failAll = (n: number, message: string) => { for (let i = 0; i < n * COMPLIANCE_NOTIFY_ATTEMPTS; i++) db.failNotifications.push({ message }); };

beforeEach(() => {
  db.rows = {}; db.failNotifications = []; db.failAudit = null; db.inserts = []; db.sessionUid = null;
  db.lostResponses = []; db.failReadBack = null; db.readBacks = 0; db.createdAt = new WeakMap();
  slept = [];
  clock = Date.UTC(2026, 9, 13, 3, 0, 0);
  __setComplianceRetryClock(() => { db.clockMs = clock; return clock; });
  db.clockMs = clock;
  __setComplianceRetrySleep(async (ms) => { slept.push(ms); clock += ms; db.clockMs = clock; });
  __resetComplianceBreaker();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { __setComplianceRetrySleep(null); __setComplianceRetryClock(null); __resetComplianceBreaker(); vi.restoreAllMocks(); });

describe("DELIV-16 — a compliance bell row that fails to land is retried", () => {
  it("REGRESSION: a row that lands first time is written once — the same row notify() writes, no wait, no read-back, nothing dead-lettered", async () => {
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(await inCron(() => notifyCompliance({ ...NOTICE, userId: "u-2" }))).toBe(true);
    expect(bellAttempts()).toHaveLength(2);
    expect(db.rows.notifications).toEqual([ROW, { ...ROW, user_id: "u-2" }]);
    expect(slept).toEqual([]);
    expect(db.readBacks).toBe(0);
    expect(db.rows.audit_logs).toBeUndefined();
  });

  it("the done-when: an insert that fails ONCE (and did not commit) lands on the retry — the identical row, retried at once after a read-back finds none", async () => {
    db.failNotifications = [{ code: "08006", message: "connection reset" }];
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(true);
    expect(bellAttempts().map((a) => a.row)).toEqual([ROW, ROW]);
    expect(db.rows.notifications).toEqual([ROW]);              // one row landed, not two
    expect(db.readBacks).toBe(1);
    expect(COMPLIANCE_RETRY_BACKOFF_MS[0]).toBe(0);
    expect(slept).toEqual([]);
    expect(db.rows.audit_logs).toBeUndefined();
  });

  it("two transient failures, then it lands on the third attempt, after a 1 s wait", async () => {
    db.failNotifications = [{ message: "timeout" }, { message: "timeout" }];
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(true);
    expect(bellAttempts()).toHaveLength(COMPLIANCE_NOTIFY_ATTEMPTS);
    expect(slept).toEqual([1000]);
    expect(db.rows.notifications).toEqual([ROW]);
  });

  it("every attempt fails: false, a legible warning line, ONE dead-letter audit row naming the kind, the recipient and the error", async () => {
    db.failNotifications = [{ message: "a" }, { message: "b" }, { code: "57014", message: "canceling statement due to statement timeout" }];
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(false);
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

  it("a scan's notice names its row: the dead letter carries the retry key the next run reads", async () => {
    failAll(1, "permission denied for table notifications");
    await inCron(() => notifyCompliance(NOTICE, { retryKey: "read-understood:a1" }));
    expect(deadLetters()[0].details).toMatchObject({ retryKey: "read-understood:a1" });
  });

  it("a server notice (no actor, no session — the cron) dead-letters as the system; a dead letter that fails too is logged, never thrown", async () => {
    failAll(1, "x");
    db.failAudit = { message: "audit refused" };
    await expect(inCron(() => notifyCompliance({ ...ACTORLESS, kind: "review_due" }))).resolves.toBe(false);
    const audit = db.inserts.find((i) => i.table === "audit_logs")!.row;
    expect(audit.user_id).toBeNull();
    expect(audit.metadata).toMatchObject({ actor_kind: "system", actor_label: "system" });
    expect(console.error).toHaveBeenCalledWith("[compliance-notify] the dead letter for review_due to u-assignee was not written either: audit refused");
  });

  it("fix pass (major 2): a BROWSER notice that names no actor (ack_unsatisfiable at publish, review_overdue from the reviewer contingency) dead-letters as the signed-in member — the audit insert policy (user_id = auth.uid()) admits it", async () => {
    db.sessionUid = "u-session-publisher";
    db.failNotifications = [{ message: "y" }];
    expect(await notifyCompliance({ ...ACTORLESS, kind: "ack_unsatisfiable" })).toBe(false);
    expect(deadLetters()).toEqual([expect.objectContaining({ user_id: "u-session-publisher", metadata: null })]);
    // an actor the producer names still wins over the session
    db.failNotifications = [{ message: "y" }];
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

describe("integrator fix pass (re-review minor 3) — a retry never writes a second copy of a row that landed", () => {
  it("the cron: the insert COMMITS but its answer is lost ('fetch failed') — the read-back finds the row, so it is not inserted again and nothing is dead-lettered", async () => {
    db.lostResponses = [{ message: "TypeError: fetch failed" }];
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(true);
    expect(db.rows.notifications).toEqual([ROW]);              // exactly one row
    expect(bellAttempts()).toHaveLength(1);
    expect(deadLetters()).toEqual([]);
  });

  it("the cron: the immediate retry's answer is lost too — the read-back before the third attempt finds it", async () => {
    db.failNotifications = [{ message: "connection reset" }];
    db.lostResponses = [];
    // attempt 1 refused; attempt 2 commits and its answer is lost
    const { supabase } = await import("@/lib/supabase");
    const from = supabase.from.bind(supabase);
    let n = 0;
    vi.spyOn(supabase, "from").mockImplementation(((t: string) => {
      const q = from(t) as unknown as Record<string, unknown>;
      if (t !== "notifications") return q;
      return { ...q, insert: async (row: Row) => { n += 1; if (n === 2) db.lostResponses.push({ message: "socket hang up" }); return (q.insert as (r: Row) => Promise<unknown>)(row); } };
    }) as never);
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(true);
    expect(db.rows.notifications).toEqual([ROW]);
    expect(bellAttempts()).toHaveLength(2);
    expect(slept).toEqual([]);                                  // found before the 1 s wait's insert
  });

  it("the BROWSER writing another member's row (ack_requested at publish), notification_i_wrote unavailable (this client has no rpc — before 20261206): it cannot read that row back, so a failed insert is NOT retried — the committed-but-lost row stays the only one, and the dead letter says why (N15: with 20261206 the retry is made — complianceRetryN15.test.ts)", async () => {
    db.sessionUid = "u-publisher";
    db.lostResponses = [{ message: "TypeError: Failed to fetch" }];
    expect(await notifyCompliance(NOTICE)).toBe(false);
    expect(db.rows.notifications).toEqual([ROW]);              // not two
    expect(bellAttempts()).toHaveLength(1);
    expect(db.readBacks).toBe(0);
    expect(deadLetters()[0].details).toMatchObject({ attempts: 1, error: expect.stringContaining("not retried: this writer's read-back of its own rows (notification_i_wrote, 20261206) failed or is not deployed") });
  });

  it("the BROWSER writing the signed-in member's OWN row reads it back: a lost answer is found; a refusal is retried", async () => {
    db.sessionUid = "u-assignee";
    db.lostResponses = [{ message: "TypeError: Failed to fetch" }];
    expect(await notifyCompliance(ACTORLESS)).toBe(true);
    expect(db.rows.notifications).toEqual([{ ...ROW, actor_user_id: "u-assignee", actor_name: null }]);
    db.failNotifications = [{ message: "connection reset" }];
    expect(await notifyCompliance({ ...ACTORLESS, title: "second" })).toBe(true);
    expect(db.rows.notifications).toHaveLength(2);
  });

  it("the cron's read-back never takes a row a member forged from a browser (stamped with its writer) for the server's notice: the retry is made", async () => {
    // a member's browser row: same org, recipient, kind, title and resource — but an actor
    (db.rows.notifications ??= []).push({ ...ROW, actor_user_id: "u-forger" });
    db.createdAt.set(db.rows.notifications[0], new Date(clock).toISOString());
    db.failNotifications = [{ message: "connection reset" }];
    expect(await inCron(() => notifyCompliance(ACTORLESS))).toBe(true);
    expect(db.rows.notifications).toEqual([{ ...ROW, actor_user_id: "u-forger" }, { ...ROW, actor_user_id: null, actor_name: null }]);
  });

  it("a read-back that fails cannot rule a landed row out: no retry, and the dead letter says so", async () => {
    db.failNotifications = [{ message: "connection reset" }];
    db.failReadBack = { message: "statement timeout" };
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(false);
    expect(bellAttempts()).toHaveLength(1);
    expect(String(deadLetters()[0].details && (deadLetters()[0].details as Row).error)).toContain("not retried: the read-back that would rule out a landed row failed");
  });

  it("an older identical row outside the read-back window does not count as this one", async () => {
    await inCron(() => notifyCompliance(NOTICE));                // lands at `clock`
    clock += 10 * 60_000;
    db.failNotifications = [{ message: "connection reset" }];
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(true);
    expect(db.rows.notifications).toHaveLength(2);              // the retry wrote the new one
  });
});

describe("document-control P39 merge-time fix — a notice under a writer-chosen id is settled by that id only", () => {
  const ID = "11111111-2222-4333-8444-555555555555";
  const ROW_ID = { ...ROW, id: ID };

  it("the cron: a same-title sibling written since the attempt began does not settle a failed insert (the read-back matches the id) — the retry under the id lands", async () => {
    (db.rows.notifications ??= []).push({ ...ROW, actor_user_id: null, actor_name: null });
    db.createdAt.set(db.rows.notifications[0], new Date(clock).toISOString());
    db.failNotifications = [{ message: "connection reset" }];
    expect(await inCron(() => notifyCompliance({ ...ACTORLESS, id: ID }))).toBe(true);
    expect(db.rows.notifications.map((r) => r.id ?? null)).toEqual([null, ID]);
  });

  it("the cron: a failed id read-back is not retried, and the dead letter names THAT read", async () => {
    db.failNotifications = [{ message: "connection reset" }];
    db.failReadBack = { message: "statement timeout" };
    expect(await inCron(() => notifyCompliance({ ...NOTICE, id: ID }))).toBe(false);
    expect(deadLetters()[0].details).toMatchObject({ attempts: 1, error: expect.stringContaining("the read-back of the row under the notice's own id (the notifications table) failed") });
  });

  it("REGRESSION (review): the BROWSER writing ANOTHER member's row under an id — attempts 1 and 2 fail, attempt 3 COMMITS but its answer is lost: the final probe under the same id answers 23505, so it is landed, not dead-lettered, and there is one row", async () => {
    db.sessionUid = "u-publisher";
    db.failNotifications = [{ message: "connection reset" }, { message: "connection reset" }];
    db.lostResponses = [{ message: "TypeError: Failed to fetch" }];
    expect(await notifyCompliance({ ...NOTICE, id: ID })).toBe(true);
    expect(db.rows.notifications).toEqual([ROW_ID]);           // one row: the probe wrote no copy
    expect(bellAttempts()).toHaveLength(4);                    // three attempts and the probe
    expect(deadLetters()).toEqual([]);
  });

  it("the same, the probe refused at a rate cap (20261160's rail runs before the primary key): dead-lettered, the error saying the outcome is unknown — never a second copy", async () => {
    db.sessionUid = "u-publisher";
    db.failNotifications = [{ message: "connection reset" }, { message: "connection reset" }, null, { message: "notifications: rate limit — 60 of the same notification to one person per minute" }];
    db.lostResponses = [{ message: "TypeError: Failed to fetch" }];
    expect(await notifyCompliance({ ...NOTICE, id: ID })).toBe(false);
    expect(db.rows.notifications).toEqual([ROW_ID]);
    expect(deadLetters()[0].details).toMatchObject({ error: expect.stringContaining("the final check — a probe insert under the notice's own id — answered \"notifications: rate limit") });
    expect(String(deadLetters()[0].details && (deadLetters()[0].details as { error: string }).error)).toContain("whether the last attempt landed is unknown");
  });

  it("the BROWSER writing another member's row under an id is retried (it cannot read the row, and a retry cannot copy it): a transient failure lands on the retry; a row that never landed is dead-lettered after the probe lands nothing", async () => {
    db.sessionUid = "u-publisher";
    db.failNotifications = [{ message: "connection reset" }];
    expect(await notifyCompliance({ ...NOTICE, id: ID })).toBe(true);
    expect(db.rows.notifications).toEqual([ROW_ID]);
    db.rows.notifications = [];
    db.inserts = [];
    db.failNotifications = [{ message: "connection reset" }, { message: "connection reset" }, { message: "connection reset" }, { message: "connection reset" }];
    expect(await notifyCompliance({ ...NOTICE, id: ID })).toBe(false);
    expect(db.rows.notifications ?? []).toEqual([]);
    expect(bellAttempts()).toHaveLength(4);
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
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(false);
    expect(bellAttempts()).toHaveLength(2);
    expect(slept).toEqual([]);
    expect(deadLetters()[0].details).toMatchObject({ attempts: 2, error: expect.stringContaining("row-level security") });
    // transient text is not taken for a deterministic refusal
    for (const message of ["connection reset", "fetch failed", "canceling statement due to statement timeout"]) expect(message).not.toMatch(DETERMINISTIC_REFUSAL);
  });

  it("(a) 100 notices refused deterministically: the run waits 0 ms on them", async () => {
    failAll(100, "notifications: kind ack_requested is written only by the server");
    await inCron(async () => { for (let i = 0; i < 100; i++) await notifyCompliance({ ...NOTICE, userId: `u-${i}` }); });
    expect(slept).toEqual([]);
    expect(deadLetters()).toHaveLength(100);
  });

  it("(b) the breaker: 100 notices failing TRANSIENTLY under the fake clock finish within 6 s of waits (unbounded: 100 s) — after 5 consecutive dead letters each gets its single attempt, until a write lands", async () => {
    failAll(100, "connection reset");
    const t0 = clock;
    await inCron(async () => { for (let i = 0; i < 100; i++) await notifyCompliance({ ...NOTICE, userId: `u-${i}` }); });
    expect(clock - t0).toBeLessThanOrEqual(6_000);
    expect(slept).toEqual(Array(BREAKER_DEAD_LETTERS).fill(1000));
    expect(bellAttempts()).toHaveLength(BREAKER_DEAD_LETTERS * 3 + (100 - BREAKER_DEAD_LETTERS));
    expect(deadLetters()).toHaveLength(100);                    // every lost notice is still dead-lettered
    expect(deadLetters().at(-1)!.details).toMatchObject({ attempts: 1, error: expect.stringMatching(/not retried: the last \d+ compliance notices in this workspace were dead-lettered within 60 s of each other/) });
    expect(deadLetters()[BREAKER_DEAD_LETTERS].details).toMatchObject({ attempts: 1, error: expect.stringContaining("not retried: the last 5 compliance notices") });
    // a write that lands closes it: the next failure is retried again
    db.failNotifications = [];
    expect(await inCron(() => notifyCompliance(NOTICE))).toBe(true);
    db.failNotifications = [{ message: "blip" }];
    expect(await inCron(() => notifyCompliance({ ...NOTICE, title: "after" }))).toBe(true);
    expect(bellAttempts().slice(-2)).toHaveLength(2);
  });

  it("(b) dead letters further apart than the window do not open it", async () => {
    for (let i = 0; i < BREAKER_DEAD_LETTERS + 2; i++) {
      failAll(1, "connection reset");
      await inCron(() => notifyCompliance(NOTICE));
      clock += BREAKER_WINDOW_MS + 1;
    }
    expect(slept).toEqual(Array(BREAKER_DEAD_LETTERS + 2).fill(1000));
    expect(bellAttempts()).toHaveLength((BREAKER_DEAD_LETTERS + 2) * 3);
  });

  it("(b) re-review minor 4: the breaker is per workspace — org A's run of dead letters does not stop org B's retry on the same instance", async () => {
    failAll(BREAKER_DEAD_LETTERS + 1, "connection reset");
    await inCron(async () => { for (let i = 0; i < BREAKER_DEAD_LETTERS + 1; i++) await notifyCompliance({ ...NOTICE, orgId: "org-A", userId: `u-${i}` }); });
    expect(deadLetters().at(-1)!.details).toMatchObject({ attempts: 1 });   // A's breaker is open
    db.failNotifications = [{ message: "canceling statement due to statement timeout" }];
    expect(await inCron(() => notifyCompliance({ ...NOTICE, orgId: "org-B" }))).toBe(true);   // B is retried
    expect((db.rows.notifications ?? []).filter((r) => r.org_id === "org-B")).toHaveLength(1);
    // and A's stays open for A
    failAll(1, "connection reset");
    await inCron(() => notifyCompliance({ ...NOTICE, orgId: "org-A", userId: "u-late" }));
    expect(deadLetters().at(-1)!.details).toMatchObject({ attempts: 1, error: expect.stringContaining("not retried: the last") });
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

  it("a scan's lost notices that name their row say the next run sends them again", async () => {
    const errors: string[] = [];
    failAll(2, "permission denied for table notifications");
    await runComplianceScan("access-recert@org-1", async () => {
      await notifyCompliance({ ...NOTICE, userId: "u-1" }, { retryKey: "access-recert:L1" });
      await notifyCompliance({ ...NOTICE, userId: "u-2" });
      return 1;
    }, errors, null);
    expect(errors).toEqual(["access-recert@org-1: 2 compliance notice(s) were not written (dead-lettered to the audit log; the next run sends 1 of them again; the scan's count still includes them) — e.g. ack_requested to u-1: permission denied for table notifications"]);
  });

  it("re-review DELIV-7 (counting): the run's tally says how many bell notices were attempted, delivered and dead-lettered", async () => {
    const tally = { attempted: 0, delivered: 0, deadLettered: 0 };
    failAll(1, "permission denied for table notifications");
    await runComplianceScan("review-cycles@org-1", async () => {
      await notifyCompliance({ ...NOTICE, userId: "u-1" });                 // lost
      await notifyCompliance({ ...NOTICE, userId: "u-2" });                 // lands
      await notifyCompliance({ ...NOTICE, userId: "u-3" });                 // lands
      return 1;
    }, [], null, tally);
    expect(tally).toEqual({ attempted: 3, delivered: 2, deadLettered: 1 });
  });

  it("a notice another request loses meanwhile (same instance, outside the scan's context) is not attributed to the scan", async () => {
    const errors: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const scan = runComplianceScan("access-recert@org-1", async () => { await gate; await notifyCompliance(NOTICE); return 1; }, errors, null);
    // a concurrent server request (N15: a server writer with no session reads
    // its row back and retries once; a deterministic refusal then dead-letters)
    db.failNotifications = [{ message: "permission denied for table notifications" }, { message: "permission denied for table notifications" }];
    await notifyCompliance({ ...NOTICE, userId: "u-other-request" });
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

  it("re-review minor 5: the six step-6 scans in N14's files read their retry plan and stamp a row only when every notice landed (lib/ownership.ts has no scan)", () => {
    const SCANS: Array<[string, string]> = [
      ["lib/reviewCycles.ts", "review-cycles"], ["lib/acknowledgments.ts", "read-understood"], ["lib/reviewControl.ts", "pre-publish-review"],
      ["lib/effectiveDate.ts", "effective-dates"], ["lib/retention.ts", "retention"], ["lib/accessRecert.ts", "access-recert"],
    ];
    for (const [f, scan] of SCANS) {
      const s = src(f);
      expect(s, f).toContain(`await loadScanRetryPlan(orgId, "${scan}", `);
      expect(s, f).toContain("landed.every(Boolean)");
      expect(s, f).toContain("{ retryKey }");
    }
    // the scan labels the cron reports under are the retry keys' prefixes
    const cron = src("app/api/cron/maintenance/route.ts");
    for (const [, scan] of SCANS) expect(cron).toContain(`["${scan}", `);
  });

  it("the cron runs each scan in its own collector, with the retry deadline that keeps the digest's time — ONE line in the step-6 loop (an integrator merge item)", () => {
    const cron = src("app/api/cron/maintenance/route.ts");
    expect(cron).toContain('import { runComplianceScan } from "@/lib/complianceNotifyScope";');
    expect(cron).toContain("result.complianceNotices += await runComplianceScan(`${name}@${org.id}`, () => fn(org.id), result.errors, runEnd - DIGEST_FLOOR_MS - AFTER_DIGEST_RESERVE_MS, result.complianceBellNotices);");
    expect(cron).toContain("complianceBellNotices: { attempted: 0, delivered: 0, deadLettered: 0 },");
    expect(cron).not.toContain("drainComplianceShortfall");
    // the browser bundle never imports the scope (node:async_hooks)
    expect(src("lib/complianceNotify.ts")).not.toMatch(/from "node:async_hooks"|from "@\/lib\/complianceNotifyScope"/);
  });
});
