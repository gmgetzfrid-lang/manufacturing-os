// notifications Round G — N15: DELIV-16's remainders.
//
//   · the browser writer learns whether ITS OWN notice to another member
//     landed — notification_i_wrote (20261206) — and retries on that answer;
//     before the paste (PGRST202) it keeps today's path: no retry, a dead
//     letter that says why;
//   · a server writer with no scan scope and no session (a route on the
//     service role — the intake door) reads its row back and retries;
//   · REGRESSION: a notice that lands first time is written once, with no
//     read-back.
//
// Driven through the REAL lib/complianceNotify, lib/inAppNotifications and
// lib/audit on a fake shared client.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  failNotifications: [] as Array<{ code?: string; message: string }>,
  lostResponses: [] as Array<{ message: string }>,
  inserts: [] as Array<{ table: string; row: Row }>,
  sessionUid: null as string | null,
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  rpcMissing: false,
  window: false,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: async (row: Row) => {
        db.inserts.push({ table, row });
        if (table === "notifications" && db.failNotifications.length > 0) return { error: db.failNotifications.shift() };
        if (table === "notifications" && db.sessionUid && row.actor_user_id == null) row = { ...row, actor_user_id: db.sessionUid };
        (db.rows[table] ??= []).push(row);
        if (table === "notifications" && db.lostResponses.length > 0) return { error: db.lostResponses.shift() };
        return { error: null };
      },
      select: () => {
        const preds: Array<(r: Row) => boolean> = [];
        const q = {
          eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return q; },
          is: (c: string, v: unknown) => { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
          gte: () => q,
          limit: async (n: number) => ({ data: (db.rows[table] ?? []).filter((r) => preds.every((p) => p(r))).slice(0, n).map(() => ({ id: "n" })), error: null }),
        };
        return q;
      },
    }),
    rpc: async (fn: string, args: Row) => {
      db.rpcCalls.push({ fn, args });
      if (db.rpcMissing) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.notification_i_wrote" } };
      // the function: a row THIS caller wrote to p_user of p_kind / p_title / p_resource_id
      const hit = (db.rows.notifications ?? []).some((r) => r.org_id === args.p_org && r.user_id === args.p_user && r.kind === args.p_kind
        && r.title === args.p_title && (r.resource_id ?? null) === (args.p_resource_id ?? null) && r.actor_user_id === db.sessionUid);
      return { data: hit, error: null };
    },
    auth: { getSession: async () => ({ data: { session: db.sessionUid ? { user: { id: db.sessionUid } } : null }, error: null }) },
  },
}));

import { notifyCompliance, __setComplianceRetrySleep, __resetComplianceBreaker, NOTIFICATION_DEAD_LETTER } from "@/lib/complianceNotify";

const NOTICE = {
  orgId: "org-1", userId: "u-assignee", kind: "ack_requested" as const,
  title: "Please acknowledge: P-101 Rev C", body: "Read and acknowledge.",
  link: "/documents/lib-1?doc=d-1", resourceType: "document", resourceId: "d-1",
  actorUserId: "u-publisher", actorName: "Pat",
};
const bell = () => db.rows.notifications ?? [];
const deadLetters = () => (db.rows.audit_logs ?? []).filter((a) => a.action === NOTIFICATION_DEAD_LETTER);

beforeEach(() => {
  db.rows = {}; db.failNotifications = []; db.lostResponses = []; db.inserts = []; db.sessionUid = null; db.rpcCalls = []; db.rpcMissing = false;
  __setComplianceRetrySleep(async () => undefined);
  __resetComplianceBreaker();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); __setComplianceRetrySleep(null); });

describe("DELIV-16 (N15) — a browser's notice to ANOTHER member is retried on notification_i_wrote's answer", () => {
  it("a transient failure: the read-back says it did not land, the retry lands — ONE row, no dead letter", async () => {
    vi.stubGlobal("window", {});
    db.sessionUid = "u-publisher";
    db.failNotifications.push({ message: "fetch failed" });
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bell()).toHaveLength(1);
    expect(deadLetters()).toHaveLength(0);
    expect(db.rpcCalls[0]).toMatchObject({ fn: "notification_i_wrote", args: { p_org: "org-1", p_user: "u-assignee", p_kind: "ack_requested", p_title: NOTICE.title, p_resource_id: "d-1" } });
  });

  it("a lost answer after the commit: the read-back finds the row — no second copy, no dead letter", async () => {
    vi.stubGlobal("window", {});
    db.sessionUid = "u-publisher";
    db.lostResponses.push({ message: "fetch failed" });
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bell()).toHaveLength(1);
    expect(db.inserts.filter((i) => i.table === "notifications")).toHaveLength(1);
    expect(deadLetters()).toHaveLength(0);
  });

  it("before 20261206 is pasted (PGRST202): today's path — no retry, a dead letter that says why", async () => {
    vi.stubGlobal("window", {});
    db.sessionUid = "u-publisher";
    db.rpcMissing = true;
    db.failNotifications.push({ message: "fetch failed" });
    expect(await notifyCompliance(NOTICE)).toBe(false);
    expect(db.inserts.filter((i) => i.table === "notifications")).toHaveLength(1);
    expect(deadLetters()).toHaveLength(1);
    expect(String((deadLetters()[0].details as Row).error)).toMatch(/notification_i_wrote, 20261206\) failed or is not deployed/);
  });

  it("REGRESSION: a notice that lands first time is written once and nothing is read back", async () => {
    vi.stubGlobal("window", {});
    db.sessionUid = "u-publisher";
    expect(await notifyCompliance(NOTICE)).toBe(true);
    expect(bell()).toHaveLength(1);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("a browser with no session still is not retried (no read-back is possible)", async () => {
    vi.stubGlobal("window", {});
    db.failNotifications.push({ message: "fetch failed" });
    expect(await notifyCompliance(NOTICE)).toBe(false);
    expect(String((deadLetters()[0].details as Row).error)).toMatch(/a browser with no session/);
  });
});

describe("DELIV-16 (N15) — a server writer with no scan scope and no session (the intake door, on the service role) retries", () => {
  it("a transient failure lands on the retry — one row", async () => {
    const intake = { ...NOTICE, kind: "intake_submission" as const, actorUserId: undefined, actorName: "Acme" };
    db.failNotifications.push({ message: "fetch failed" });
    expect(await notifyCompliance(intake)).toBe(true);
    expect(bell()).toHaveLength(1);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("a lost answer after the commit is found by the table read-back — no second copy", async () => {
    const intake = { ...NOTICE, kind: "doc_superseded" as const, actorUserId: undefined, actorName: "Acme" };
    db.lostResponses.push({ message: "fetch failed" });
    expect(await notifyCompliance(intake)).toBe(true);
    expect(db.inserts.filter((i) => i.table === "notifications")).toHaveLength(1);
  });
});
