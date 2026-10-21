// notifications Round G — N18 DELIVERY RECORD: drafting-flow EVID-9 dw4 and
// EVID-13 dw4 (DEC-90 ruling (4)) — one server function answers "what
// reached this person about this item" across every channel and status,
// read-only, for the person themselves or an Admin.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { freshState, makeSupabase, resetState, type MemoryState } from "./helpers/memoryDb";

const auth = vi.hoisted(() => ({
  actor: { userId: "u-self", email: "self@x.io", orgId: "o1", role: "Engineer", roles: ["Engineer"] } as Record<string, unknown>,
  admin: null as unknown,
  error: null as null | { error: string; status: number },
}));
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => (auth.error ? auth.error : { ...auth.actor, admin: auth.admin })),
}));

import { noticeTrailFor } from "@/lib/noticeTrail";
import { GET } from "@/app/api/notifications/trail/route";

const ORG = "o1";
const BOB = "0b0b0b0b-0000-4000-8000-000000000001";
const DOC = "3f2b8c14-9d7a-4e11-b0f3-5a6c9e2d4188";
let state: MemoryState;
let sb: ReturnType<typeof makeSupabase>;

beforeEach(() => {
  state = freshState();
  resetState(state);
  sb = makeSupabase(state);
  auth.admin = sb;
  auth.error = null;
  auth.actor = { userId: BOB, email: "bob@x.io", orgId: ORG, role: "Engineer", roles: ["Engineer"] };
});

const seed = () => {
  state.tables.notifications = [
    { id: "n1", org_id: ORG, user_id: BOB, resource_id: DOC, kind: "review_requested", title: "Review DWG-1042", created_at: "2026-10-01T09:00:00Z", read_at: null, metadata: null },
    { id: "n2", org_id: ORG, user_id: BOB, resource_id: DOC, kind: "ticket_status", title: "Approved", created_at: "2026-10-02T09:00:00Z", read_at: null, metadata: { action: "approve", superseded_at: "2026-10-03T09:00:00Z" } },
    { id: "n3", org_id: ORG, user_id: BOB, resource_id: DOC, kind: "ticket_comment", title: "Comment", created_at: "2026-10-04T09:00:00Z", read_at: "2026-10-04T10:00:00Z", metadata: null },
    // someone else's row, another item's row: never in Bob's trail
    { id: "x1", org_id: ORG, user_id: "someone-else", resource_id: DOC, kind: "ticket_comment", title: "Not Bob", created_at: "2026-10-01T09:00:00Z", read_at: null },
    { id: "x2", org_id: ORG, user_id: BOB, resource_id: "other-item", kind: "ticket_comment", title: "Other", created_at: "2026-10-01T09:00:00Z", read_at: null },
  ];
  state.tables.email_notifications = [
    { id: "e1", org_id: ORG, to_user_id: BOB, resource_id: DOC, event_type: "assignment", subject: "Review DWG-1042", status: "sent", attempt_count: 1, sent_at: "2026-10-01T09:00:05Z", created_at: "2026-10-01T09:00:01Z", delivery_status: "delivered", delivered_at: "2026-10-01T09:00:09Z" },
    { id: "e2", org_id: ORG, to_user_id: BOB, resource_id: DOC, event_type: "ticket_status_changed", subject: "Approved", status: "not_emailed", attempt_count: 0, created_at: "2026-10-02T09:00:01Z" },
    { id: "e3", org_id: ORG, to_user_id: BOB, resource_id: DOC, event_type: "comment_mention", subject: "Comment", status: "sent", attempt_count: 1, sent_at: "2026-10-04T09:00:05Z", created_at: "2026-10-04T09:00:01Z", delivery_status: "bounced", bounced_at: "2026-10-04T09:01:00Z", delivery_detail: "Mailbox full" },
  ];
};

describe("noticeTrailFor — one answer across bell, email and the request record", () => {
  it("each notice with its own columns: unopened / retired unopened / opened; delivered / not emailed by choice / bounced", async () => {
    seed();
    const t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.entries.map((e) => `${e.channel}:${e.id}:${e.state}`)).toEqual([
      "bell:n1:unopened", "email:e1:delivered", "bell:n2:retired_unopened", "email:e2:not_emailed_by_choice", "bell:n3:opened", "email:e3:bounced",
    ]);
    const n2 = t.entries.find((e) => e.id === "n2")!;
    expect(n2).toMatchObject({ seenAt: null, supersededAt: "2026-10-03T09:00:00Z" });
    expect(t.entries.find((e) => e.id === "n3")!.seenAt).toBe("2026-10-04T10:00:00Z");
    expect(t.entries.find((e) => e.id === "e1")).toMatchObject({ sentAt: "2026-10-01T09:00:05Z", deliveredAt: "2026-10-01T09:00:09Z", providerOutcome: "delivered" });
    expect(t.entries.find((e) => e.id === "e2")).toMatchObject({ byTheirChoice: true, sentAt: null });
    expect(t.entries.find((e) => e.id === "e3")).toMatchObject({ bouncedAt: "2026-10-04T09:01:00Z", providerDetail: "Mailbox full" });
    expect(t.summary).toMatchObject({ toldInApp: 3, opened: true, emailAttempted: 2, emailReached: 1, bestEmail: "delivered", bounced: true, notEmailedByChoice: true, emailNeverAttempted: false });
    expect(t.legs).toEqual({ bell: "read", email: "read", requestRecord: "read", acted: "read" });
    // only Bob's rows about this item
    expect(t.entries.some((e) => e.id.startsWith("x"))).toBe(false);
  });

  it("acted on: the person's first audit row on the item at or after the first notice; told, never opened, never acted on = never responded", async () => {
    state.tables.notifications = [{ id: "n1", org_id: ORG, user_id: BOB, resource_id: DOC, kind: "review_requested", title: "Review", created_at: "2026-10-01T09:00:00Z", read_at: null }];
    let t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.summary).toMatchObject({ actedAt: null, neverResponded: true, emailNeverAttempted: true });
    state.tables.audit_logs = [{ id: "a1", org_id: ORG, user_id: BOB, resource_id: DOC, created_at: "2026-10-02T08:00:00Z" }];
    t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.summary).toMatchObject({ actedAt: "2026-10-02T08:00:00Z", neverResponded: false });
  });

  it("an email that never reached the person is not 'told': a dead-letter-only item and a bounce-only item are attempted, not reached, and never 'never responded'", async () => {
    const only = (row: Record<string, unknown>) => {
      state.tables.notifications = [];
      state.tables.email_notifications = [{ id: "e9", org_id: ORG, to_user_id: BOB, resource_id: DOC, event_type: "assignment", subject: "Review", created_at: "2026-10-01T09:00:01Z", ...row }];
      return noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    };
    // dead-lettered: five failed attempts, never handed to the provider
    let t = await only({ status: "failed", attempt_count: 5, error_message: "Resend 422: invalid address" });
    expect(t.entries.map((e) => e.state)).toEqual(["failed"]);
    expect(t.summary).toMatchObject({ toldInApp: 0, emailAttempted: 1, emailReached: 0, neverResponded: false, emailNeverAttempted: false });
    // retrying: not reached either
    t = await only({ status: "failed", attempt_count: 2 });
    expect(t.summary).toMatchObject({ emailAttempted: 1, emailReached: 0, neverResponded: false });
    // bounced: handed to the provider and refused
    t = await only({ status: "sent", attempt_count: 1, sent_at: "2026-10-01T09:00:05Z", delivery_status: "bounced", bounced_at: "2026-10-01T09:01:00Z", delivery_detail: "Mailbox full" });
    expect(t.entries.map((e) => e.state)).toEqual(["bounced"]);
    expect(t.summary).toMatchObject({ toldInApp: 0, emailAttempted: 1, emailReached: 0, bounced: true, neverResponded: false });
    // provider failed: refused too
    t = await only({ status: "sent", attempt_count: 1, sent_at: "2026-10-01T09:00:05Z", delivery_status: "failed" });
    expect(t.summary).toMatchObject({ emailAttempted: 1, emailReached: 0, neverResponded: false });
    // REGRESSION: an email that reached the provider and was not refused, never opened or acted on, is still "never responded"
    for (const reachedRow of [
      { status: "sent", attempt_count: 1, sent_at: "2026-10-01T09:00:05Z" },
      { status: "sent", attempt_count: 1, sent_at: "2026-10-01T09:00:05Z", delivery_status: "delivered", delivered_at: "2026-10-01T09:00:09Z" },
      { status: "sent", attempt_count: 1, sent_at: "2026-10-01T09:00:05Z", delivery_status: "delayed" },
      { status: "sent", attempt_count: 1, sent_at: "2026-10-01T09:00:05Z", delivery_status: "complained", complained_at: "2026-10-01T09:05:00Z" },
    ]) {
      t = await only(reachedRow);
      expect(t.summary, JSON.stringify(reachedRow)).toMatchObject({ emailAttempted: 1, emailReached: 1, neverResponded: true });
    }
  });

  it("a request's own notice record (20261255): delivered / warned / not emailed — whether by their choice, never the preference itself", async () => {
    state.tables.ticket_notice_events = [
      { id: "t1", org_id: ORG, recipient: BOB, ticket_id: DOC, kind: "delivered", created_at: "2026-10-01T09:00:00Z", details: {} },
      { id: "t2", org_id: ORG, recipient: BOB, ticket_id: DOC, kind: "not_emailed", created_at: "2026-10-01T09:00:01Z", details: { reason: "they turned email off", byTheirChoice: true } },
      { id: "t3", org_id: ORG, recipient: BOB, ticket_id: DOC, kind: "not_emailed", created_at: "2026-10-01T09:00:02Z", details: { reason: "no address on record", byTheirChoice: false } },
      { id: "t4", org_id: ORG, recipient: BOB, ticket_id: DOC, kind: "warned", created_at: "2026-10-02T09:00:00Z", details: {} },
    ];
    const t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.entries.map((e) => `${e.id}:${e.state}:${e.byTheirChoice}`)).toEqual(["t1:delivered_in_app:null", "t2:not_emailed_by_choice:true", "t3:not_emailed:false", "t4:warned:null"]);
    expect(JSON.stringify(t)).not.toMatch(/turned email off|no address on record/);
    expect(t.summary.toldInApp).toBe(1);
    expect(t.summary.emailNeverAttempted).toBe(false);
  });

  it("a consent window's notice is counted once: its bell row and the 'delivered' event naming that row are one notice (20261255 open_consent_window)", async () => {
    state.tables.notifications = [
      { id: "b1", org_id: ORG, user_id: BOB, resource_id: DOC, kind: "ticket_status", title: "Your consent is asked", created_at: "2026-10-01T09:00:00Z", read_at: null, metadata: { action: "consent_window_opened" } },
    ];
    state.tables.ticket_notice_events = [
      { id: "t1", org_id: ORG, recipient: BOB, ticket_id: DOC, kind: "delivered", notification_id: "b1", created_at: "2026-10-01T09:00:00Z", details: {} },
    ];
    const t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.entries.map((e) => `${e.channel}:${e.id}`)).toEqual(["bell:b1", "request_record:t1"]);
    expect(t.entries.find((e) => e.id === "t1")!.notificationId).toBe("b1");
    expect(t.summary.toldInApp).toBe(1);
    // a delivered event whose bell row is not in the trail still counts (once)
    state.tables.ticket_notice_events.push({ id: "t2", org_id: ORG, recipient: BOB, ticket_id: DOC, kind: "delivered", notification_id: "gone", created_at: "2026-10-05T09:00:00Z", details: {} });
    expect((await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC })).summary.toldInApp).toBe(2);
  });

  it("a not-emailed record that was NOT their choice (no address on record) is no email attempt: emailNeverAttempted stays true", async () => {
    state.tables.ticket_notice_events = [
      { id: "t1", org_id: ORG, recipient: BOB, ticket_id: DOC, kind: "delivered", created_at: "2026-10-01T09:00:00Z", details: {} },
      { id: "t3", org_id: ORG, recipient: BOB, ticket_id: DOC, kind: "not_emailed", created_at: "2026-10-01T09:00:02Z", details: { reason: "no address on record", byTheirChoice: false } },
    ];
    const t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.summary).toMatchObject({ emailNeverAttempted: true, notEmailedByChoice: false });
    expect(JSON.stringify(t)).not.toMatch(/no address on record/);
  });

  it("BEFORE 20261258 (the delivery columns missing — 42703): the emails are read with today's columns and the gap is said", async () => {
    seed();
    state.readError.email_notifications = { code: "42703", message: 'column email_notifications.delivery_status does not exist' };
    state.onRead = (t) => { if (t === "email_notifications") delete state.readError.email_notifications; };
    const t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.legs.email).toBe("read");
    expect(t.entries.filter((e) => e.channel === "email")).toHaveLength(3);
    expect(t.notes.join(" ")).toMatch(/20261258 is not applied/);
    const selects = state.calls.filter((c) => c.table === "email_notifications" && c.method === "select").map((c) => String(c.args[0]));
    expect(selects[0]).toContain("delivery_status");
    expect(selects[1]).not.toContain("delivery_status");
  });

  it("BEFORE 20261255 (no request record — 42P01): that leg is absent, the rest answers", async () => {
    seed();
    state.readError.ticket_notice_events = { code: "42P01", message: 'relation "public.ticket_notice_events" does not exist' };
    const t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.legs.requestRecord).toBe("absent");
    expect(t.entries).toHaveLength(6);
    expect(t.notes).toContain("The request's own notice record is not installed yet (migration 20261255 is not applied).");
  });

  it("a leg that fails otherwise is 'unavailable' and said — never shown as nothing", async () => {
    seed();
    state.readError.notifications = { code: "57014", message: "statement timeout" };
    const t = await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(t.legs.bell).toBe("unavailable");
    expect(t.notes.join(" ")).toMatch(/in-app notices could not be read: statement timeout/);
  });

  it("read-only: it never writes", async () => {
    seed();
    await noticeTrailFor(sb, { orgId: ORG, userId: BOB, resourceId: DOC });
    expect(state.writes).toEqual([]);
    expect(state.calls.some((c) => ["insert", "update", "delete", "upsert", "rpc"].includes(c.method))).toBe(false);
  });
});

describe("GET /api/notifications/trail — the person themselves or an Admin", () => {
  const get = (q: string) => GET(new NextRequest(`http://x/api/notifications/trail?${q}`, { headers: { authorization: "Bearer t" } }));

  it("the person asks about themselves (userId omitted): their own trail", async () => {
    seed();
    const res = await get(`orgId=${ORG}&resourceId=${DOC}`);
    expect(res.status).toBe(200);
    const json = await res.json() as { userId: string; entries: unknown[] };
    expect(json.userId).toBe(BOB);
    expect(json.entries).toHaveLength(6);
  });

  it("another member asking about Bob: 403, nothing read", async () => {
    seed();
    auth.actor = { userId: "0c0c0c0c-0000-4000-8000-000000000002", email: "c@x.io", orgId: ORG, role: "Manager", roles: ["Manager", "DocCtrl"] };
    const res = await get(`orgId=${ORG}&resourceId=${DOC}&userId=${BOB}`);
    expect(res.status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("an Admin — by the held collection, the headline another role — sees Bob's trail", async () => {
    seed();
    auth.actor = { userId: "0d0d0d0d-0000-4000-8000-000000000003", email: "d@x.io", orgId: ORG, role: "Engineer", roles: ["Engineer", "Admin"] };
    const res = await get(`orgId=${ORG}&resourceId=${DOC}&userId=${BOB}`);
    expect(res.status).toBe(200);
    expect((await res.json() as { userId: string }).userId).toBe(BOB);
  });

  it("not an active member: the gate's answer; no resourceId or a malformed userId: 400", async () => {
    auth.error = { error: "Not a member of this org", status: 403 };
    expect((await get(`orgId=${ORG}&resourceId=${DOC}`)).status).toBe(403);
    auth.error = null;
    expect((await get(`orgId=${ORG}`)).status).toBe(400);
    expect((await get(`orgId=${ORG}&resourceId=${DOC}&userId=not-a-uuid`)).status).toBe(400);
  });
});
