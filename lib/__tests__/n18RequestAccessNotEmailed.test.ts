// notifications Round G — N18 DELIVERY RECORD, drafting-flow EVID-9 dw2,
// DEC-90 ruling (2) "pinned per producer" — the access-request door (fix
// pass 2, after review: this producer had no after-paste pin).
//
// POST /api/auth/request-access tells the workspace's Admins by bell and by
// email (notifications N8 PROD-2). Here the email leg runs through the REAL
// lib/notifications.ts queueEmail on the service role (runWithServerClient
// binds the shared client to supabaseAdmin), over an in-memory stand-in that
// answers email_gate() and transcribes email_notifications' status CHECK:
// before 20261258 a not_emailed row is refused (23514); after it, accepted.
// Only the bell writer (notifyMany) is a recorder.
//
//   * after the paste, an Admin whose own preference turns email off keeps
//     the bell row exactly as before, gets NO queued email, and leaves ONE
//     not_emailed record; every other Admin is queued exactly as before;
//   * before the paste, the same request is today's path: the same bell
//     row, the other Admins queued, nothing at all for the opted-out one;
//   * with no opt-outs, nothing changes and no record is written.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetDeliveryRecordLatches } from "@/lib/deliveryRecordLatch";
import { NextRequest } from "next/server";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  bells: [] as Array<Record<string, unknown>>,
  pasted258: false,
  /** uid → their own preference turns email off (email_gate() answers false) */
  off: new Set<string>(),
  gateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    const base = makeFakeSupabase(s.db);
    return {
      ...base,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "email_gate") {
          s.gateCalls.push(args);
          return { data: !s.off.has(String(args.p_to_user)), error: null };
        }
        return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
      },
    };
  },
}));
vi.mock("@/lib/inAppNotifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyMany: vi.fn(async (p: Record<string, unknown>) => { s.bells.push(p); return { sent: (p.userIds as string[]).length, failed: 0 }; }),
}));

import { POST as requestAccess } from "@/app/api/auth/request-access/route";
import { requestAccessTiming } from "@/lib/accessRequestOutcome";

const ORG = "org1";
const member = (uid: string, roles: string[]) => ({ id: `m-${uid}`, org_id: ORG, uid, role: roles[0], roles, status: "active", email: `${uid}@acme.test` });

beforeEach(() => {
  requestAccessTiming.floorMs = 0;   // ORG-24's floor is pinned in aoRoundGP5FixPass.test.ts
  s.db = newFakeDb();
  s.bells = [];
  s.pasted258 = false;
  resetDeliveryRecordLatches();
  s.off = new Set();
  s.gateCalls = [];
  s.db.tables.orgs = [{ id: ORG, name: "Acme Refining" }];
  s.db.tables.org_members = [member("admin1", ["Admin"]), member("mgr-adm", ["Manager", "Admin"]), member("eng", ["Engineer"])];
  s.db.tables.access_requests = [];
  s.db.tables.signup_attempts = [];
  s.db.tables.email_notifications = [];
  // email_notifications_status_check: before 20261258 it has no 'not_emailed'
  s.db.beforeInsert!.email_notifications = (row: Row) => {
    if (row.status === "not_emailed" && !s.pasted258) {
      throw { code: "23514", message: 'new row for relation "email_notifications" violates check constraint "email_notifications_status_check"' };
    }
    return row;
  };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

const ask = () => requestAccess(new NextRequest("https://app/api/auth/request-access", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ displayName: "Greg", email: "Greg@Corp.com", orgName: "acme refining" }),
}));
const mail = () => (s.db.tables.email_notifications ?? []).map((m) => `${m.to_user_id}:${m.status}`).sort();
const bellFor = () => s.bells.map((b) => ({ kind: b.kind, userIds: [...(b.userIds as string[])].sort(), title: b.title, link: b.link }));

describe("EVID-9 dw2 (N18) — the access-request door: who is told is unchanged; an opted-out Admin is recorded once the paste is in", () => {
  it("after 20261258: admin1 turned email off — same bell row, no queued email for them, ONE not_emailed record; mgr-adm queued as before", async () => {
    s.pasted258 = true;
    s.off.add("admin1");
    const res = await ask();
    expect(res.status).toBe(200);
    expect(bellFor()).toEqual([{ kind: "access_request_pending", userIds: ["admin1", "mgr-adm"], title: "Greg asked to join Acme Refining", link: "/admin/users" }]);
    expect(mail()).toEqual(["admin1:not_emailed", "mgr-adm:queued"]);
    const rows = s.db.tables.email_notifications;
    expect(rows.filter((m) => m.to_user_id === "admin1")).toHaveLength(1);
    expect(rows.filter((m) => m.to_user_id === "admin1" && m.status === "queued")).toEqual([]);
    const rec = rows.find((m) => m.to_user_id === "admin1")!;
    const reqId = s.db.tables.access_requests[0].id;
    expect(rec).toMatchObject({ org_id: ORG, to_email: "admin1@acme.test", subject: "Access request waiting for review", event_type: "assignment" });
    expect(rec.metadata).toEqual({ accessRequestId: reqId, not_emailed: { byTheirChoice: true, reason: "preference" } });
    const queued = rows.find((m) => m.to_user_id === "mgr-adm")!;
    expect(queued).toMatchObject({ subject: rec.subject, body_text: rec.body_text, metadata: { accessRequestId: reqId } });
    // the gate was asked once per Admin, about this event (no resource → no repeat leg)
    expect(s.gateCalls.map((c) => c.p_to_user).sort()).toEqual(["admin1", "mgr-adm"]);
  });

  it("BEFORE 20261258: the same request — the same bell row, mgr-adm queued, and nothing for admin1 at all (today's path)", async () => {
    s.off.add("admin1");
    const res = await ask();
    expect(res.status).toBe(200);
    expect(bellFor()).toEqual([{ kind: "access_request_pending", userIds: ["admin1", "mgr-adm"], title: "Greg asked to join Acme Refining", link: "/admin/users" }]);
    expect(mail()).toEqual(["mgr-adm:queued"]);
  });

  it("REGRESSION (no opt-outs), after the paste: both Admins queued, no record written", async () => {
    s.pasted258 = true;
    await ask();
    expect(bellFor()[0].userIds).toEqual(["admin1", "mgr-adm"]);
    expect(mail()).toEqual(["admin1:queued", "mgr-adm:queued"]);
  });
});
