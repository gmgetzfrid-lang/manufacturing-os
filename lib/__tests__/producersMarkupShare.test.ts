// notifications Round G — N8 PRODUCERS-FREE, review fix (PROD-14 / LIFE-8):
// one markup share is ONE markup_request bell row for the requester.
//
// On a share, resolveMarkupRequest posts the thread's markup_ref
// (lib/activityThread.ts postMarkupRef → notifyCheckoutActivity, which tells
// the thread's participants, the active holders and the document's
// subscribers "… requested markup on …"), and then sends its own resolution
// notice ("… shared their markups") to the requester. A requester who is a
// participant or a subscriber of that thread — the usual case — used to get
// both. Here the real thread code and the real dispatcher run over the
// in-memory PostgREST; the bell sink (notifyMany) is captured, so every bell
// row each person receives is counted.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  bells: [] as Array<{ kind: string; title: string; userIds: string[] }>,
}));

vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(s.db); } }));
vi.mock("@/lib/inAppNotifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyMany: vi.fn(async (p: { kind: string; title: string; userIds: string[]; actorUserId?: string }) => {
    s.bells.push({ kind: p.kind, title: p.title, userIds: p.userIds.filter((u) => u && u !== p.actorUserId) });
  }),
}));
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queueEmail: vi.fn(async () => undefined),
}));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: async () => null, isMissingEpisodeSchema: () => false }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/projects", () => ({ writeActivity: vi.fn(async () => undefined) }));

import { resolveMarkupRequest } from "@/lib/markupRequests";

const ORG = "o1";
const member = (uid: string) => ({ id: `m-${uid}`, org_id: ORG, uid, role: "Engineer", roles: ["Engineer"], status: "active", email: `${uid}@acme.test` });
/** notifyCheckoutActivity is fire-and-forget: let it finish. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const rowsFor = (uid: string, kind = "markup_request") => s.bells.filter((b) => b.kind === kind && b.userIds.includes(uid));

beforeEach(() => {
  s.db = newFakeDb();
  s.bells = [];
  s.db.tables.org_members = [member("asker"), member("holder"), member("watcher")];
  s.db.tables.documents = [{ id: "d1", org_id: ORG, library_id: "lib1", document_number: "P-101" }];
  s.db.tables.markup_requests = [{ id: "mr1", org_id: ORG, document_id: "d1", requested_by_user_id: "asker", requested_from_user_id: "holder", status: "open" }];
  // the requester is BOTH a thread participant and a subscriber of the document; a colleague watches it too
  s.db.tables.checkout_messages = [{ id: "c0", org_id: ORG, document_id: "d1", user_id: "asker", kind: "chat", text: "can I see?" }];
  s.db.tables.subscriptions = [
    { user_id: "asker", resource_type: "document", resource_id: "d1" },
    { user_id: "watcher", resource_type: "document", resource_id: "d1" },
  ];
  s.db.tables.checkout_sessions = [];
});

describe("a markup share: the requester gets one markup_request row, in the right words", () => {
  it("the requester (a thread participant and subscriber) gets ONLY the resolution notice; the thread's other watchers still get the thread's notice", async () => {
    await resolveMarkupRequest({ markupRequestId: "mr1", status: "shared", response: "attached", orgId: ORG, actorUserId: "holder", actorEmail: "holder@acme.test" });
    await settle();
    // REGRESSION: the share is recorded and the thread carries its markup_ref
    expect(s.db.tables.markup_requests[0].status).toBe("shared");
    expect(s.db.tables.checkout_messages.filter((m) => m.kind === "markup_ref")).toHaveLength(1);

    const asker = rowsFor("asker");
    expect(asker).toHaveLength(1);
    expect(asker[0].title).toBe("holder@acme.test shared their markups");
    // the thread's own notice still reaches its other watchers (unchanged wording — TAX-3 / TAX-4's)
    const watcher = rowsFor("watcher");
    expect(watcher).toHaveLength(1);
    expect(watcher[0].title).toBe("holder requested markup on P-101");
    // and nobody is told about their own act
    expect(rowsFor("holder")).toEqual([]);
  });

  it("a decline posts no markup_ref: the requester's one row is the resolution notice, as before", async () => {
    await resolveMarkupRequest({ markupRequestId: "mr1", status: "declined", response: "busy", orgId: ORG, actorUserId: "holder", actorEmail: "holder@acme.test" });
    await settle();
    expect(rowsFor("asker").map((b) => b.title)).toEqual(["holder@acme.test declined your markup request"]);
    expect(rowsFor("watcher")).toEqual([]);
  });
});
