// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS: REV-19.
// An admitted status change that makes a document a controlled issue starts
// the compliance clocks (startIssuedDocumentClocks — the one path every
// creation door uses) and is RECORDED (DOCUMENT_ISSUED: the document, the
// revision, the status before and after, the door, the actor, the policy
// decision). The doors: unarchiveDocument (into an issue status) and
// changeDocumentStatus — THE status write for a status editor (the library
// page's metadata save and the bulk editor adopt it as their owners next
// touch those files). The put-back of the stamped issue (20261144's
// retirement stamp names the current revision) keeps the clocks it had.
//
// Driven against the in-memory PostgREST (helpers/fakeSupabase) with the real
// lib/revisions.ts and lib/reviewControl.ts; a BEFORE UPDATE hook clears the
// retirement stamp on any exit from a retirement, as the guard does, so the
// tests prove the stamp is read BEFORE the write.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  reviewMode: "none" as string,
  clockErrors: [] as string[],
  clockThrows: false,
  refuse: null as null | { code: string; message: string },
}));

vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(state.db); } }));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), makeLibraryStoragePath: vi.fn(), uniqueUploadName: (n: string) => n }));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "DocCtrl", roles: ["DocCtrl"] })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({
  onDocumentIssued: vi.fn(async (i: { writeErrors?: string[] }) => {
    if (state.clockThrows) throw new Error("review cycle table missing");
    i.writeErrors?.push(...state.clockErrors);
  }),
}));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: state.reviewMode })) };
});

import { changeDocumentStatus, unarchiveDocument, recordStatusIssue } from "@/lib/revisions";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { isIssueRefusal } from "@/lib/issueStatus";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const ME = "ctl1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const issued = () => T("audit_logs").filter((a) => a.action === "DOCUMENT_ISSUED");
const RETIRED = ["Superseded", "Archived", "Void"];

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
    status: "Draft", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null,
    retired_issue_status: null, retired_issue_version_id: null, ...extra,
  };
  T("documents").push(d);
  if (d.current_version_id) T("document_versions").push({ id: d.current_version_id, org_id: ORG, record_id: id, revision_label: "2" });
  return d;
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: "lib1", documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id ?? undefined, collectionId: null,
}) as unknown as DocumentRecord;

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.reviewMode = "none";
  state.clockErrors = [];
  state.clockThrows = false;
  state.refuse = null;
  // The guard's part this test needs: a refusal when asked, and the stamp
  // cleared on any write that leaves a retirement (20261144).
  state.db.beforeUpdate!.documents = (next) => {
    if (state.refuse) throw state.refuse;
    if (!RETIRED.includes(String(next.status))) { next.retired_issue_status = null; next.retired_issue_version_id = null; }
    return next;
  };
});

describe("REV-19 — changeDocumentStatus: the status editors' write, the clocks and the record", () => {
  it("Draft → Issued (with a current revision): one checked write, the clocks start through startIssuedDocumentClocks, and DOCUMENT_ISSUED names the document, revision, statuses, door, actor and decision", async () => {
    seedDoc("d1");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d1", toStatus: "Issued", door: "metadata", actorUserId: ME, actorEmail: "ctl@example.com", actorRole: "DocCtrl", patch: { title: "Pump P&ID" } });
    expect(out).toEqual({ issued: true, putBack: false, complianceClockErrors: [], recordError: null });
    expect(docRow("d1")).toMatchObject({ status: "Issued", title: "Pump P&ID", updated_by: ME });
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(1);
    expect(issued()).toHaveLength(1);
    expect(issued()[0]).toMatchObject({ resource_id: "d1", resource_type: "document", org_id: ORG, user_id: ME, user_email: "ctl@example.com" });
    expect(issued()[0].details).toMatchObject({
      door: "metadata", fromStatus: "Draft", toStatus: "Issued", versionId: "d1-v2", rev: "2", putBack: false,
      reviewPolicyMode: "none", rosterComplete: false, issuedWithoutSignOff: false, complianceClocksStarted: true, complianceClockErrors: null,
    });
  });

  it("DEC-63 §2: an issue under a policy that requires sign-off, made without a complete roster (only a controller gets it past the database), is recorded as such", async () => {
    state.reviewMode = "require";
    seedDoc("d2", { status: "In Review" });
    await changeDocumentStatus({ orgId: ORG, documentId: "d2", toStatus: "Issued", door: "bulk", actorUserId: ME });
    expect(issued()[0].details).toMatchObject({ door: "bulk", fromStatus: "In Review", reviewPolicyMode: "require", rosterComplete: false, issuedWithoutSignOff: true });
  });

  it("a write that is not an issue (Issued → Draft, Draft → In Review, a register row with no revision) starts no clock and writes no record — the write itself as before", async () => {
    seedDoc("a", { status: "Issued" });
    seedDoc("b");
    seedDoc("c", { current_version_id: null });
    for (const [id, to] of [["a", "Draft"], ["b", "In Review"], ["c", "Issued"]] as const) {
      expect(await changeDocumentStatus({ orgId: ORG, documentId: id, toStatus: to, door: "metadata", actorUserId: ME })).toEqual({ issued: false, putBack: false, complianceClockErrors: [], recordError: null });
      expect(docRow(id).status).toBe(to);
    }
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(issued()).toEqual([]);
  });

  it("a refusal is thrown in the database's own words (the editors recognise the issue rule), and nothing follows it", async () => {
    seedDoc("d3");
    state.refuse = { code: "23514", message: "Document has an active hold; release the hold before issuing it." };
    const err = await changeDocumentStatus({ orgId: ORG, documentId: "d3", toStatus: "Issued", door: "metadata", actorUserId: ME }).catch((e: Error) => e);
    expect((err as Error).message).toBe("Document has an active hold; release the hold before issuing it.");
    expect(isIssueRefusal((err as Error).message)).toBe(true);
    expect(docRow("d3").status).toBe("Draft");
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(issued()).toEqual([]);
  });

  it("a write that matched no row (a silent RLS refusal) is a refusal, never a silent success", async () => {
    seedDoc("d4");
    state.db.refuseWrites.add("documents");
    await expect(changeDocumentStatus({ orgId: ORG, documentId: "d4", toStatus: "Issued", door: "metadata", actorUserId: ME })).rejects.toThrow(/status was NOT changed/);
    expect(issued()).toEqual([]);
  });

  it("clocks that did not start are returned AND on the record; a start that throws is caught (the issue has landed)", async () => {
    seedDoc("d5");
    state.clockErrors = ["the review clock could not be reset to this issue (permission denied)"];
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d5", toStatus: "IFC", door: "metadata", actorUserId: ME });
    expect(out.complianceClockErrors).toEqual(["the review clock could not be reset to this issue (permission denied)"]);
    expect(issued()[0].details).toMatchObject({ toStatus: "IFC", complianceClockErrors: ["the review clock could not be reset to this issue (permission denied)"] });
    seedDoc("d6");
    state.clockThrows = true;
    const out2 = await changeDocumentStatus({ orgId: ORG, documentId: "d6", toStatus: "Issued", door: "metadata", actorUserId: ME });
    expect(out2.complianceClockErrors).toEqual(["the start failed (review cycle table missing)"]);
  });

  it("a record that cannot be written is returned (recordError) — the issue itself stands", async () => {
    seedDoc("d7");
    state.db.beforeInsert!.audit_logs = () => { throw { code: "42501", message: "permission denied for table audit_logs" }; };
    const out = await recordStatusIssue({ orgId: ORG, documentId: "d7", fromStatus: "Draft", toStatus: "Issued", versionId: "d7-v2", putBack: false, door: "metadata", actorUserId: ME });
    expect(out.issued).toBe(true);
    expect(out.recordError).toMatch(/permission denied/);
  });
});

describe("REV-19 — unarchiveDocument into an issue status", () => {
  const unarchive = (d: Row, restoreStatus: string) => unarchiveDocument({ doc: asRecord(d), reason: "restored", orgId: ORG, actorUserId: ME, restoreStatus });

  it("the put-back of the stamped issue (the stamp names the current revision): recorded as a put-back, the clocks it had are NOT restarted — the stamp read BEFORE the write clears it", async () => {
    const d = seedDoc("u1", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "u1-v2" });
    const out = await unarchive(d, "Issued");
    expect(out).toEqual({ issued: true, putBack: true, complianceClockErrors: [], recordError: null });
    expect(docRow("u1")).toMatchObject({ status: "Issued", retired_issue_version_id: null });
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(issued()[0].details).toMatchObject({ door: "unarchive", fromStatus: "Archived", toStatus: "Issued", putBack: true, complianceClocksStarted: false });
    // the un-archive's own record is unchanged
    expect(T("audit_logs").some((a) => a.action === "ARCHIVE_DOC")).toBe(true);
  });

  it("an un-archive that issues a revision the archive did not take away (no stamp: before 20261144 or the service role; or 'not-issued') starts the clocks and is recorded", async () => {
    const legacy = seedDoc("u2", { status: "Archived" });
    expect((await unarchive(legacy, "Issued")).putBack).toBe(false);
    const neverIssued = seedDoc("u3", { status: "Archived", retired_issue_status: "not-issued" });
    expect((await unarchive(neverIssued, "Issued")).putBack).toBe(false);
    expect(onDocumentIssued).toHaveBeenCalledTimes(2);
    expect(issued().map((a) => (a.details as Row).putBack)).toEqual([false, false]);
  });

  it("regression — an un-archive to Draft / In Review is not an issue: no clock, no DOCUMENT_ISSUED (the write and its ARCHIVE_DOC record as before)", async () => {
    const d = seedDoc("u4", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "u4-v2" });
    expect(await unarchive(d, "Draft")).toEqual({ issued: false, putBack: false, complianceClockErrors: [], recordError: null });
    expect(docRow("u4").status).toBe("Draft");
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(issued()).toEqual([]);
    expect(T("audit_logs").filter((a) => a.action === "ARCHIVE_DOC")).toHaveLength(1);
  });

  it("regression — a refused un-archive is thrown as before, with nothing recorded", async () => {
    const d = seedDoc("u5", { status: "Archived" });
    state.refuse = { code: "23514", message: "Document has an active hold; release the hold before issuing it." };
    await expect(unarchive(d, "Issued")).rejects.toThrow(/was NOT restored \(Document has an active hold/);
    expect(issued()).toEqual([]);
  });
});
