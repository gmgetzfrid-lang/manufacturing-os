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
//
// The integrator's rule R2 at the N17 merge (DEC-90): a door that opens
// rosters for MANY documents in one action passes `notifyPush: false` (bell
// and email only); a single-document door keeps pushing. The census at the
// end pins it over every caller of the roster openers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

describe("R2 (the integrator at the N17 merge, DEC-90) — one rule everywhere: a door that opens rosters for many documents in one action sends bell and email only", () => {
  it("openReviewRoster with notifyPush: false (a set rev-up's submission) writes every roster row and bell row as before and sends no push request", async () => {
    seedDraft();
    await openReviewRoster({ ...rosterInput(), notifyPush: false });
    expect(T("document_review_signoffs").map((r) => r.reviewer_user_id).sort()).toEqual(["rev1", "rev2"]);
    expect(notified().filter((n) => n.kind === "review_requested").map((n) => n.user).sort()).toEqual(["rev1", "rev2"]);
    expect(state.audited.find((a) => a.action === "REVIEW_REQUESTED")).toBeTruthy();
    expect(pushed()).toEqual([]);
  });

  it("recomputeDocumentAck with notifyPush: false: the roster and bell rows as before, no push; with a server sender, the sender is handed to the push leg (OS-16)", async () => {
    seedIssuedDocument();
    await recomputeDocumentAck({ orgId: ORG, documentId: "d1", actorId: "ctl1", actorName: "Cass", notifyPush: false });
    expect(notified()).toHaveLength(3);
    expect(pushed()).toEqual([]);
    // a server sender (R4) reaches pushAfterBellRows as its second argument
    state.db = newFakeDb(); state.log = [];
    seedIssuedDocument();
    const sender = vi.fn(async () => undefined);
    const { pushAfterBellRows } = await import("@/lib/notify/dispatch");
    vi.mocked(pushAfterBellRows).mockClear();
    await recomputeDocumentAck({ orgId: ORG, documentId: "d1", actorId: "ctl1", actorName: "Cass", serverPush: sender });
    expect(vi.mocked(pushAfterBellRows)).toHaveBeenCalledWith({ orgId: ORG, kind: "ack_requested", resourceId: "d1", recipients: ["u1", "u2", "u3"] }, sender);
  });

  it("census: every caller of a roster opener is classified — the multi-document doors pass notifyPush: false, the single-document doors push, the helpers relay what they were given; a NEW caller fails here until it is classified", () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "__tests__" && !n.startsWith(".")) walk(p); }
        else if (/\.tsx?$/.test(n) && !n.endsWith(".d.ts")) files.push(p);
      }
    };
    for (const d of ["app", "components", "lib", "hooks"]) walk(join(root, d));
    // the functions that open (or lead to) a read-&-understood or sign-off roster
    const OPENERS = [
      "recomputeDocumentAck", "onDocumentIssuedAck", "startIssuedDocumentClocks", "startClocksForIssuedDocuments",
      "createDocumentWithFile", "recordStatusIssue", "changeDocumentStatus", "runPostPublishSideEffects",
      "revUpDocument", "submitForReview", "openReviewRoster",
    ];
    const callRe = new RegExp(`(?<!function\\s)(?<![\\w.])(${OPENERS.join("|")})\\(`, "g");
    const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const argsAt = (t: string, open: number) => {
      let depth = 0;
      for (let i = open; i < t.length; i += 1) {
        if (t[i] === "(") depth += 1;
        else if (t[i] === ")") { depth -= 1; if (depth === 0) return t.slice(open, i + 1); }
      }
      return t.slice(open);
    };
    type Kind = "multi" | "single" | "relay";
    const found: string[] = [];
    for (const f of files) {
      const text = stripComments(readFileSync(f, "utf8"));
      const rel = relative(root, f).split("\\").join("/");
      for (const m of text.matchAll(callRe)) {
        const args = argsAt(text, (m.index ?? 0) + m[1].length);
        let kind: Kind;
        if (/notifyPush === false \? \{ notifyPush: false \}|opts\?\.notifyPush === false/.test(args)) kind = "relay";
        else if (/(?<!\?\s*\{\s*)notifyPush:\s*false\b/.test(args)) kind = "multi";
        else if (args === "(common)" && /const common = \{[\s\S]*?\bnotifyPush: false,[\s\S]*?\};/.test(text)) kind = "multi";
        else {
          expect(args, `${rel} ${m[1]}: a caller names notifyPush only as false (multi) or as a relay`).not.toMatch(/notifyPush/);
          kind = "single";
        }
        found.push(`${rel} | ${m[1]} | ${kind}`);
      }
    }
    // Each door, classified once (the record: audit-reports/notifications/07-os-notifications-and-nudges.md OS-14, R2)
    const DOORS: Array<[file: string, callee: string, kind: Kind, door: string]> = [
      // multi-document doors — bell and email only
      ["lib/acknowledgments.ts", "recomputeDocumentAck", "multi", "setAckPolicy at library / folder level (every issued document it covers)"],
      ["app/(protected)/documents/[libraryId]/page.tsx", "startIssuedDocumentClocks", "multi", "the library's multi-file upload (uploadOne, per staged file)"],
      ["components/documents/BulkEditModal.tsx", "changeDocumentStatus", "multi", "the bulk status editor"],
      ["lib/documentLifecycle/split.ts", "startClocksForIssuedDocuments", "multi", "a split (every new sheet)"],
      ["lib/documentLifecycle/setRevUp.ts", "revUpDocument", "multi", "a set rev-up (each sheet published)"],
      ["lib/documentLifecycle/setRevUp.ts", "submitForReview", "multi", "a set rev-up (each sheet sent to sign-off)"],
      ["lib/outputTemplates.ts", "createDocumentWithFile", "multi", "the output-template filing run (Drafts today: no roster)"],
      // single-document doors — push
      ["lib/acknowledgments.ts", "recomputeDocumentAck", "single", "setAckPolicy at document level"],
      ["app/(protected)/documents/[libraryId]/page.tsx", "changeDocumentStatus", "single", "the document's metadata save"],
      ["app/(protected)/documents/[libraryId]/page.tsx", "changeDocumentStatus", "single", "the document's metadata save to a retired status (document-control P28, PROD-17: no roster opens for a retirement)"],
      ["components/documents/DocumentLinkPicker.tsx", "createDocumentWithFile", "single", "a document created from the link picker"],
      ["lib/documentLifecycle/merge.ts", "startClocksForIssuedDocuments", "single", "a merge's one created target"],
      ["lib/documentLifecycle/merge.ts", "revUpDocument", "single", "a merge's extended target"],
      ["components/documents/RevUpModal.tsx", "revUpDocument", "single", "a rev-up"],
      ["components/documents/RevUpModal.tsx", "submitForReview", "single", "a submission for sign-off"],
      ["components/projects/IntakePanel.tsx", "openReviewRoster", "single", "an intake submission sent to its reviewers"],
      ["components/requests/PublishNewDocumentModal.tsx", "createDocumentWithFile", "single", "a drafting request's deliverable published as one new document (drafting-flow DF-P15, DCW-4)"],
      ["lib/revisions.ts", "recordStatusIssue", "single", "an un-archive into an issue status"],
      ["lib/revisions.ts", "runPostPublishSideEffects", "single", "a revert"],
      ["lib/reviewControl.ts", "runPostPublishSideEffects", "single", "a reviewed revision finalized"],
      ["app/api/intake/upload/route.ts", "runPostPublishSideEffects", "single", "the intake link's auto-publish (server sender — OS-16)"],
      // helpers — relay the caller's notifyPush
      ["lib/acknowledgments.ts", "recomputeDocumentAck", "relay", "onDocumentIssuedAck"],
      ["lib/revisions.ts", "onDocumentIssuedAck", "relay", "startIssuedDocumentClocks"],
      ["lib/postPublish.ts", "onDocumentIssuedAck", "relay", "runPostPublishSideEffects"],
      ["lib/revisions.ts", "startIssuedDocumentClocks", "relay", "createDocumentWithFile"],
      ["lib/revisions.ts", "startIssuedDocumentClocks", "relay", "recordStatusIssue"],
      ["lib/documentLifecycle/common.ts", "startIssuedDocumentClocks", "relay", "startClocksForIssuedDocuments"],
      ["lib/revisions.ts", "recordStatusIssue", "relay", "changeDocumentStatus"],
      ["lib/revisions.ts", "runPostPublishSideEffects", "relay", "revUpDocument"],
      ["lib/revisions.ts", "openReviewRoster", "relay", "submitForReview"],
    ];
    expect(found.sort()).toEqual(DOORS.map(([f, c, k]) => `${f} | ${c} | ${k}`).sort());
    // the intake door hands the pipeline its server sender, with the actor as the writer (R4)
    expect(readFileSync(join(root, "app/api/intake/upload/route.ts"), "utf8")).toMatch(/serverPush: afterResponsePush\(link\.created_by \? String\(link\.created_by\) : null, "intake\/upload"\)/);
  });
});
