// notifications Round G — N17 PUSH PRODUCERS AND SIGN-OUT: OS-14, the
// read-&-understood and sign-off rosters' requests reach the push channel
// after their bell rows land. The REAL lib/acknowledgments.ts and
// lib/reviewControl.ts run against the in-memory PostgREST; the bell writer
// (notifyCompliance) answers per recipient whether the row landed, and the
// push leg (lib/notify/dispatch.ts pushAfterBellRows — emit()'s own leg) is a
// spy that records WHEN it ran.
//
//   recomputeDocumentAck   (a revision issued / a policy saved) → one push
//                          request for the assignees whose ack_requested row
//                          landed, after every row was written.
//   nudgeAcknowledgment    (the roster panel's re-send) → a push once the
//                          reminder's row landed; none when it was refused.
//   openReviewRoster       (a draft submitted for sign-off) → one push request
//                          for the primaries whose review_requested row landed.
//   setAckPolicy           (library / folder level) → no push request at all
//                          (bounded: never one per issued document); the
//                          document level pushes as recomputeDocumentAck.
//   scanAndNotifyAcks      (the maintenance cron's daily reminders) → no push
//                          (DEC-108 §6: the cron only prunes).
//
// Fail-safe (DEC-90): a refused row is never pushed; a push leg that throws
// never fails the roster, its rows or its audit; every bell row as before.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  /** uids whose bell row is refused */
  refuse: new Set<string>(),
  log: [] as Array<{ what: "notify" | "push"; kind?: string; user?: string; input?: Record<string, unknown> }>,
  pushThrows: false,
  audited: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(state.db); } }));
vi.mock("@/lib/complianceNotify", () => ({
  notifyCompliance: vi.fn(async (n: { userId: string; kind: string }) => {
    state.log.push({ what: "notify", kind: n.kind, user: n.userId });
    return !state.refuse.has(n.userId);
  }),
  loadScanRetryPlan: vi.fn(async () => ({ unreadable: false, has: () => false, only: () => () => true })),
}));
vi.mock("@/lib/notify/dispatch", () => ({
  pushAfterBellRows: vi.fn(async (input: Record<string, unknown>) => {
    state.log.push({ what: "push", input });
    if (state.pushThrows) throw new Error("push leg exploded");
  }),
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Record<string, unknown>) => { state.audited.push(e); return { error: null }; }) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn() }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ownership")>();
  return {
    resolveEffectiveOwner: vi.fn(real.resolveEffectiveOwner),
    effectiveOwnerForDocument: vi.fn(async () => ({ userId: null, name: null })),
    getOrgControllers: vi.fn(async () => []),
    teamSupervisorMap: vi.fn(async () => new Map()),
  };
});

import { recomputeDocumentAck, nudgeAcknowledgment, scanAndNotifyAcks, setAckPolicy } from "@/lib/acknowledgments";
import { openReviewRoster } from "@/lib/reviewControl";
import type { ReviewControl } from "@/types/schema";

const ORG = "o1";
const T = (t: string) => (state.db.tables[t] ??= []);
const member = (uid: string, name: string, role = "Engineer") => ({ org_id: ORG, uid, display_name: name, email: `${uid}@x`, status: "active", role, roles: [role] });
const notified = () => state.log.filter((l) => l.what === "notify");
const pushed = () => state.log.filter((l) => l.what === "push").map((l) => l.input as { orgId: string; kind: string; resourceId: string; recipients: string[] });
const lastNotifyAt = () => state.log.map((l) => l.what).lastIndexOf("notify");
const firstPushAt = () => state.log.findIndex((l) => l.what === "push");

beforeEach(() => {
  state.db = newFakeDb();
  state.db.unique.document_review_signoffs = [["document_version_id", "reviewer_user_id"]];
  state.refuse = new Set();
  state.log = [];
  state.pushThrows = false;
  state.audited = [];
});

const ACK_POLICY = { enabled: true, assigneeIds: ["u1", "u2", "u3"], assigneeRoles: [], assigneeTeamIds: [], hardGate: false };
function seedIssuedDocument() {
  T("org_members").push(member("u1", "Una"), member("u2", "Udo"), member("u3", "Uma"), member("ctl1", "Cass", "DocCtrl"));
  T("libraries").push({ id: "L1", org_id: ORG, ack_policy: null });
  T("collections");
  T("documents").push({
    id: "d1", org_id: ORG, library_id: "L1", collection_id: null, status: "Issued", current_version_id: "v1",
    document_number: "P-100", title: null, name: null, ack_policy: ACK_POLICY, owner_user_id: null, owner_name: null,
  });
  T("document_versions").push({ id: "v1", record_id: "d1", revision_label: "2", file_hash: null });
  T("document_acknowledgments");
}

describe("OS-14 — the read-&-understood roster's requests reach the push leg after their bell rows land", () => {
  it("recomputeDocumentAck: every assignee gets their ack_requested row as before; ONE push request follows the last row, naming only the rows that landed", async () => {
    seedIssuedDocument();
    state.refuse.add("u2");
    await recomputeDocumentAck({ orgId: ORG, documentId: "d1", actorId: "ctl1", actorName: "Cass" });
    // REGRESSION: the roster and every bell attempt exactly as before
    expect(T("document_acknowledgments").map((r) => r.assignee_user_id).sort()).toEqual(["u1", "u2", "u3"]);
    expect(notified().map((n) => [n.kind, n.user]).sort()).toEqual([["ack_requested", "u1"], ["ack_requested", "u2"], ["ack_requested", "u3"]]);
    expect(state.audited.find((a) => a.action === "ACK_REQUESTED")).toBeTruthy();
    // the push: after the bell rows, for the landed rows only (u2's was refused)
    expect(pushed()).toEqual([{ orgId: ORG, kind: "ack_requested", resourceId: "d1", recipients: ["u1", "u3"] }]);
    expect(firstPushAt()).toBeGreaterThan(lastNotifyAt());
  });

  it("the actor who opened the roster is neither asked nor pushed (as before); no row landed → nothing is pushed", async () => {
    seedIssuedDocument();
    state.refuse = new Set(["u1", "u2", "u3"]);
    await recomputeDocumentAck({ orgId: ORG, documentId: "d1", actorId: "u3", actorName: "Uma" });
    expect(notified().map((n) => n.user).sort()).toEqual(["u1", "u2"]);
    expect(pushed()).toEqual([{ orgId: ORG, kind: "ack_requested", resourceId: "d1", recipients: [] }]);
  });

  it("a push leg that throws never fails the roster: the rows, the bell attempts and the audit stand", async () => {
    seedIssuedDocument();
    state.pushThrows = true;
    await expect(recomputeDocumentAck({ orgId: ORG, documentId: "d1", actorId: "ctl1" })).resolves.toBeUndefined();
    expect(T("document_acknowledgments")).toHaveLength(3);
    expect(notified()).toHaveLength(3);
    expect(state.audited.find((a) => a.action === "ACK_REQUESTED")).toBeTruthy();
  });

  it("nudgeAcknowledgment: the re-sent request is pushed once its row landed, after it; a refused row is not pushed; the watermark moves as before", async () => {
    seedIssuedDocument();
    T("document_acknowledgments").push({ id: "r1", org_id: ORG, document_id: "d1", document_version_id: "v1", assignee_user_id: "u1", revision_label: "2", status: "pending", notified_at: null });
    await nudgeAcknowledgment({ orgId: ORG, rosterId: "r1" });
    expect(notified().map((n) => [n.kind, n.user])).toEqual([["ack_requested", "u1"]]);
    expect(pushed()).toEqual([{ orgId: ORG, kind: "ack_requested", resourceId: "d1", recipients: ["u1"] }]);
    expect(firstPushAt()).toBeGreaterThan(lastNotifyAt());
    expect(T("document_acknowledgments")[0].notified_at).toBeTruthy();

    state.log = [];
    state.refuse.add("u1");
    T("document_acknowledgments")[0].notified_at = null;
    await nudgeAcknowledgment({ orgId: ORG, rosterId: "r1" });
    expect(notified()).toHaveLength(1);
    expect(pushed()).toEqual([]);
    expect(T("document_acknowledgments")[0].notified_at).toBeTruthy();
  });

  it("setAckPolicy over a whole library recomputes every issued document with its bell rows as before, and sends NO push request (bounded — never one per document)", async () => {
    T("org_members").push(member("u1", "Una"), member("u2", "Udo"), member("ctl1", "Cass", "DocCtrl"));
    T("libraries").push({ id: "L1", org_id: ORG, ack_policy: null });
    T("collections");
    T("document_acknowledgments");
    const N = 45;
    for (let i = 0; i < N; i++) {
      T("documents").push({
        id: `d${i}`, org_id: ORG, library_id: "L1", collection_id: null, status: "Issued", current_version_id: `v${i}`,
        document_number: `P-${i}`, title: null, name: null, ack_policy: null, owner_user_id: null, owner_name: null,
      });
      T("document_versions").push({ id: `v${i}`, record_id: `d${i}`, revision_label: "1", file_hash: null });
    }
    await setAckPolicy({ level: "library", id: "L1", orgId: ORG, policy: { ...ACK_POLICY, assigneeIds: ["u1", "u2"] }, actorId: "ctl1", actorName: "Cass" });
    // REGRESSION: every document's roster and bell rows, as before
    expect(T("document_acknowledgments")).toHaveLength(N * 2);
    expect(notified()).toHaveLength(N * 2);
    expect(notified().every((n) => n.kind === "ack_requested")).toBe(true);
    // the push leg is skipped for the bulk save
    expect(pushed()).toEqual([]);

    // a document-level save still pushes its one document's landed rows
    state.log = [];
    T("documents").push({
      id: "dx", org_id: ORG, library_id: "L1", collection_id: null, status: "Issued", current_version_id: "vx",
      document_number: "P-X", title: null, name: null, ack_policy: null, owner_user_id: null, owner_name: null,
    });
    T("document_versions").push({ id: "vx", record_id: "dx", revision_label: "1", file_hash: null });
    await setAckPolicy({ level: "document", id: "dx", orgId: ORG, policy: { ...ACK_POLICY, assigneeIds: ["u1"] }, actorId: "ctl1", actorName: "Cass" });
    expect(pushed()).toEqual([{ orgId: ORG, kind: "ack_requested", resourceId: "dx", recipients: ["u1"] }]);
  });

  it("scanAndNotifyAcks (the maintenance cron's daily reminder) never pushes — the cron only prunes (DEC-108 §6)", async () => {
    seedIssuedDocument();
    T("document_acknowledgments").push({ id: "r1", org_id: ORG, document_id: "d1", document_version_id: "v1", assignee_user_id: "u1", assignee_name: "Una", revision_label: "2", status: "pending", notified_at: null, assigned_at: new Date().toISOString() });
    expect(await scanAndNotifyAcks(ORG)).toBe(1);
    expect(notified().map((n) => [n.kind, n.user])).toEqual([["ack_requested", "u1"]]);
    expect(pushed()).toEqual([]);
  });
});

const PLAIN: ReviewControl = { mode: "require", reviewerIds: ["rev1", "rev2"] };
function seedDraft() {
  T("org_members").push(member("rev1", "Rita"), member("rev2", "Rob"), member("pub1", "Pat"));
  T("document_versions").push({ id: "v2A", created_by: "pub1", superseded_at: null });
  T("documents").push({ id: "d1", org_id: ORG, library_id: "lib1", pending_version_id: "v2A", owner_user_id: null, owner_name: null, collection_id: null });
  T("libraries").push({ id: "lib1", org_id: ORG, review_control: PLAIN, owner_user_id: null, owner_name: null, owner_team_id: null });
}
const rosterInput = () => ({
  orgId: ORG, documentId: "d1", libraryId: "lib1", versionId: "v2A", revisionLabel: "2A", contentHash: "h",
  control: PLAIN, actorId: "pub1", actorName: "Pat",
});

describe("OS-14 — the sign-off roster's requests reach the push leg after their bell rows land", () => {
  it("openReviewRoster: every primary gets review_requested as before; ONE push request follows the last row, naming only the rows that landed", async () => {
    seedDraft();
    state.refuse.add("rev2");
    await openReviewRoster(rosterInput());
    expect(T("document_review_signoffs").map((r) => r.reviewer_user_id).sort()).toEqual(["rev1", "rev2"]);
    expect(notified().filter((n) => n.kind === "review_requested").map((n) => n.user).sort()).toEqual(["rev1", "rev2"]);
    expect(state.audited.find((a) => a.action === "REVIEW_REQUESTED")).toBeTruthy();
    expect(pushed()).toEqual([{ orgId: ORG, kind: "review_requested", resourceId: "d1", recipients: ["rev1"] }]);
    const lastAsk = state.log.map((l) => (l.what === "notify" && l.kind === "review_requested" ? 1 : 0)).lastIndexOf(1);
    expect(firstPushAt()).toBeGreaterThan(lastAsk);
  });

  it("a push leg that throws never fails the roster: the submission stays in review with its rows and audit", async () => {
    seedDraft();
    state.pushThrows = true;
    await expect(openReviewRoster(rosterInput())).resolves.toBeUndefined();
    expect(T("document_review_signoffs")).toHaveLength(2);
    expect(T("documents")[0].pending_version_id).toBe("v2A");
    expect(state.audited.map((a) => a.action)).toContain("REVIEW_REQUESTED");
    expect(state.audited.map((a) => a.action)).not.toContain("REVIEW_ROSTER_FAILED");
  });
});
