// document-control Round F wave 2 — P13 STATUS-TRANSITION (REV-18): the app
// half, driven end to end against the in-memory PostgREST
// (helpers/fakeSupabase) with the real lib/revisions.ts and the real
// finalizeReviewedRevision.
//
//   * addendum 1 — a rev-up that ISSUES the document for the first time (its
//     first file onto a pointerless register row, or the publish of a Draft:
//     revUpDocument writes Issued) asks the creation gate BEFORE anything is
//     uploaded, in the rev-up's own words; the Minor / Correction hatch does
//     not open it; a controller proceeds; a policy that does not require
//     sign-off is untouched; an Issued document with a current revision is
//     not asked at all (an ordinary revision through the gate).
//   * the regression check of the legitimate status writers that this
//     package's rule binds: the documents table carries a TRANSCRIPTION of
//     20261144's guard (a beforeUpdate hook — not the SQL, which was run on a
//     throwaway PostgreSQL 16 and is recorded in REV-18), and the real app
//     writers run against it: a reviewed promote of a Draft, an unarchive, a
//     split / merge source restore, each passes or surfaces its refusal.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";
import { isControlledIssueStatus } from "@/lib/issueStatus";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  rpc: vi.fn(),
  roles: ["Engineer"] as string[],
  reviewMode: "none" as string,
  reviewThrows: false,
  canControl: false,
  isOwner: true,
  /** the session uid the transcribed guard sees (null = the service role) */
  uid: "u1" as string | null,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return { ...base, rpc: (...a: unknown[]) => state.rpc(...a) };
  },
}));
vi.mock("@/lib/storage", () => ({
  uploadToPath: vi.fn(async (_f: File, path: string) => ({ url: `r2://${path}`, size: 3 })),
  makeLibraryStoragePath: (o: { filename: string }) => `org/lib/${o.filename}`,
  uniqueUploadName: (name: string) => `u_${name}`,
}));
vi.mock("@/lib/principal", () => ({
  resolveActorPrincipal: vi.fn(async (i: { uid: string; orgId?: string }) => ({
    uid: i.uid, orgId: i.orgId, role: state.roles[0], roles: state.roles,
  })),
}));
vi.mock("@/lib/documentGuards", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/documentGuards")>();
  return { ...real, resolveCanControlLibrary: vi.fn(async () => state.canControl) };
});
vi.mock("@/lib/ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ownership")>();
  return { ...real, isEffectiveOwnerOfDocument: vi.fn(async () => state.isOwner) };
});
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return {
    ...real,
    effectiveReviewControlForDocument: vi.fn(async () => {
      if (state.reviewThrows) throw new Error("policy unreadable");
      return { mode: state.reviewMode };
    }),
  };
});
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/checkoutEpisodes", () => ({
  getActiveEpisode: vi.fn(async () => null),
  postEpisodeSystemMessage: vi.fn(async () => {}),
}));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({
  runPostPublishSideEffects: vi.fn(async () => {}),
  notifyPackagesOfRetirement: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));

import { revUpDocument, unarchiveDocument } from "@/lib/revisions";
import { finalizeReviewedRevision, effectiveReviewControlForDocument } from "@/lib/reviewControl";
import { restoreSupersededSource } from "@/lib/documentLifecycle/common";
import { uploadToPath } from "@/lib/storage";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const pdf = (n: string) => new File([new Uint8Array([1, 2, 3])], n, { type: "application/pdf" });

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: LIB, document_number: id.toUpperCase(), title: id, rev: "0", revision: "0",
    status: "Draft", current_version_id: `${id}-v0`, pending_version_id: null, checked_out_by: null, owner_user_id: ME,
    ...extra,
  };
  T("documents").push(d);
  if (d.current_version_id) T("document_versions").push({ id: d.current_version_id, org_id: ORG, record_id: id, revision_label: "0", superseded_at: null });
  return d;
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: LIB, documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id ?? undefined, collectionId: null, reviewControl: d.review_control ?? null,
}) as unknown as DocumentRecord;
const revUp = (d: Row, changeType = "Minor") => revUpDocument({
  doc: asRecord(d), libraryId: LIB, file: pdf("x.pdf"), revisionLabel: "1", changeLog: "narrative", changeType: changeType as never,
  orgId: ORG, actorUserId: ME, expectedBaseVersionId: (d.current_version_id as string | null) ?? null,
});
const published = () => state.rpc.mockResolvedValue({ data: { status: "published", version: { id: "new-v", record_id: "x", revision_label: "1" } }, error: null });

// ── A transcription of 20261144's guard (status-only and pointer writes) ────
const HOLD_ISSUE = "Document has an active hold; release the hold before issuing it.";
const UNREVIEWED = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";
const NO_AUTHORITY = "You do not have authority to publish revisions in this library.";
const HOLD_PUBLISH = "Document has an active hold; release the hold before publishing a new revision.";
function transcribedGuard(next: Row, old: Row): Row {
  if (!state.uid) return next; // the service role: today's treatment, untouched
  const controller = state.roles.some((r) => r === "Admin" || r === "DocCtrl");
  const issuing = next.current_version_id != null && !isControlledIssueStatus(old.status as string | null) && isControlledIssueStatus(next.status as string | null);
  const advancing0 = next.current_version_id !== old.current_version_id
    || (next.status === "Superseded" && (old.status ?? "") !== "Superseded")
    || (["Superseded", "Archived", "Void"].includes(String(old.status)) && next.status !== old.status)
    || (next.status === "Archived" && (old.status ?? "") !== "Archived");
  const newDoor = issuing && !advancing0;
  if (!advancing0 && !issuing) return next;
  const held = T("document_holds").some((h) => h.document_id === next.id && h.released_at == null);
  if (issuing) {
    if (newDoor && held) throw { code: "23514", message: HOLD_ISSUE };
    const require = state.reviewMode === "require" || (next.review_control as { mode?: string } | null)?.mode === "require";
    const rows = T("document_review_signoffs").filter((s) => s.document_version_id === next.current_version_id && s.slot === "primary");
    const complete = rows.length > 0 && rows.every((s) => s.status === "signed" && s.signature_id != null);
    if (!controller && require && !complete) throw { code: "23514", message: UNREVIEWED };
  }
  if (controller) return next;
  if (!(state.canControl || next.owner_user_id === state.uid)) throw { code: "23514", message: NO_AUTHORITY };
  if (held) throw { code: "23514", message: HOLD_PUBLISH };
  return next;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.beforeUpdate!.documents = (next, old) => transcribedGuard(next, old);
  state.rpc.mockReset();
  state.roles = ["Engineer"];
  state.reviewMode = "none";
  state.reviewThrows = false;
  state.canControl = false;
  state.isOwner = true;
  state.uid = ME;
});

// ─── Addendum 1: the rev-up's first issue ──────────────────────────────────
describe("REV-18 addendum 1 — a rev-up that issues the document for the first time asks the creation gate up front", () => {
  it("the FIRST file onto a pointerless register row (a CSV import) in a require library: refused before anything is uploaded or published, in the rev-up's words — a Minor change does not exempt it", async () => {
    state.reviewMode = "require";
    const d = seedDoc("csv1", { current_version_id: null, status: "Issued" });
    published();
    await expect(revUp(d, "Minor")).rejects.toThrow(/CSV1 has no current revision, so Rev 1 would be its first controlled issue — a first issue is not a revision through the review gate, so a Minor or Correction change doesn't exempt it\. Nothing was uploaded\. Choose Major and submit it for review, or ask Document Control/);
    expect(uploadToPath).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
    // never the creation flow's sentence
    await expect(revUp(d, "Correction")).rejects.not.toThrow(/create it as a Draft/i);
  });

  it("a Draft with a current revision (the publish writes Issued): refused up front in a require library — the second door of REV-18's mechanism", async () => {
    state.reviewMode = "require";
    const d = seedDoc("dr1");
    published();
    await expect(revUp(d, "Minor")).rejects.toThrow(/DR1 is not issued yet \(Draft\), so publishing Rev 1 makes it a controlled issue for the first time/);
    expect(uploadToPath).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("a document-level 'require' in a library that does not require it refuses too (read as the database reads it — DEC-44 (P13))", async () => {
    state.reviewMode = "none";
    const d = seedDoc("dr2", { review_control: { mode: "require" } });
    published();
    await expect(revUp(d)).rejects.toThrow(/This library requires reviewer sign-off, and DR2 is not issued yet/);
    expect(uploadToPath).not.toHaveBeenCalled();
  });

  it("a controller proceeds (the publish is made; the database admits a controller too)", async () => {
    state.reviewMode = "require";
    state.roles = ["Manager", "DocCtrl"];
    const d = seedDoc("dr3");
    published();
    await expect(revUp(d)).resolves.toBeTruthy();
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect((state.rpc.mock.calls[0][1] as Record<string, unknown>).p_new_status).toBe("Issued");
  });

  it("a library that does not require sign-off is untouched: a Draft's Minor rev-up and a pointerless row's first file publish as before", async () => {
    state.reviewMode = "none";
    published();
    await expect(revUp(seedDoc("dr4"))).resolves.toBeTruthy();
    await expect(revUp(seedDoc("csv2", { current_version_id: null, status: "Issued" }))).resolves.toBeTruthy();
    state.reviewMode = "publisher_choice";
    await expect(revUp(seedDoc("dr5"))).resolves.toBeTruthy();
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });

  it("an Issued document with a current revision is an ordinary revision through the gate: the creation gate is not asked at all", async () => {
    state.reviewMode = "require";
    const d = seedDoc("is1", { status: "Issued" });
    published();
    await expect(revUp(d, "Minor")).resolves.toBeTruthy();
    expect(effectiveReviewControlForDocument).not.toHaveBeenCalled();
  });

  it("an unreadable policy refuses (RG-6) — in the rev-up's words, nothing uploaded", async () => {
    state.reviewThrows = true;
    const d = seedDoc("dr6");
    await expect(revUp(d)).rejects.toThrow(/Couldn't verify the review policy for DR6 — nothing was uploaded or published: policy unreadable/);
    expect(uploadToPath).not.toHaveBeenCalled();
  });

  it("a branch publish moves neither the pointer nor the status, so it is not asked", async () => {
    state.reviewMode = "require";
    const d = seedDoc("br1");
    state.rpc.mockResolvedValue({ data: { status: "branched", version: { id: "b-v", record_id: "br1", revision_label: "1" } }, error: null });
    await revUpDocument({
      doc: asRecord(d), libraryId: LIB, file: pdf("x.pdf"), revisionLabel: "1", changeLog: "n", changeType: "Minor" as never,
      orgId: ORG, actorUserId: ME, asBranch: true, branchReason: "parallel work",
    }).catch(() => {});
    expect(effectiveReviewControlForDocument).not.toHaveBeenCalled();
  });
});

// ─── Regression: the legitimate status writers against the transcribed rule ─
describe("REV-18 regression — the legitimate status writers pass the issue rule, or surface its refusal", () => {
  function seedReviewedDraft(docId: string, signed: boolean) {
    docRow(docId).pending_version_id = `${docId}-v1A`;
    T("document_versions").push({ id: `${docId}-v1A`, org_id: ORG, record_id: docId, revision_label: "1A", base_rev: "1", review_state: "in_review", superseded_at: null, supersedes_version_id: `${docId}-v0` });
    T("document_review_signoffs").push({
      id: `${docId}-s1`, document_id: docId, document_version_id: `${docId}-v1A`, reviewer_user_id: "r1", slot: "primary",
      status: signed ? "signed" : "pending", signature_id: signed ? "sig1" : null,
    });
  }

  it("finalizeReviewedRevision promoting a REVIEWED draft onto a Draft document in a require library, by its owner: published (Draft -> Issued with a complete roster)", async () => {
    state.reviewMode = "require";
    seedDoc("fz1");
    seedReviewedDraft("fz1", true);
    const r = await finalizeReviewedRevision({ orgId: ORG, documentId: "fz1", actorId: ME });
    expect(r).toEqual({ published: true });
    expect(docRow("fz1").status).toBe("Issued");
    expect(docRow("fz1").current_version_id).toBe("fz1-v1A");
  });

  it("finalizeReviewedRevision with the roster incomplete never reaches the write (its own completion check) — unchanged", async () => {
    state.reviewMode = "require";
    seedDoc("fz2");
    seedReviewedDraft("fz2", false);
    const r = await finalizeReviewedRevision({ orgId: ORG, documentId: "fz2", actorId: ME });
    expect(r.published).toBe(false);
    expect(docRow("fz2").status).toBe("Draft");
  });

  it("unarchiveDocument by the owner in a library that does not require sign-off: restored to Issued as before", async () => {
    const d = seedDoc("ua1", { status: "Archived" });
    await unarchiveDocument({ doc: asRecord(d), reason: "restored", orgId: ORG, actorUserId: ME });
    expect(docRow("ua1").status).toBe("Issued");
  });

  it("unarchiveDocument of an UNREVIEWED revision in a require library by a non-controller owner: refused, and the refusal reaches the caller (thrown, the dialog shows it); a controller restores it", async () => {
    state.reviewMode = "require";
    const d = seedDoc("ua2", { status: "Archived" });
    await expect(unarchiveDocument({ doc: asRecord(d), reason: "restored", orgId: ORG, actorUserId: ME })).rejects.toThrow(UNREVIEWED);
    expect(docRow("ua2").status).toBe("Archived");
    state.roles = ["Admin"];
    await unarchiveDocument({ doc: asRecord(d), reason: "restored", orgId: ORG, actorUserId: ME });
    expect(docRow("ua2").status).toBe("Issued");
  });

  it("a split / merge source's compensation (Superseded -> its prior status) passes for the owner in a library that does not require sign-off; in a require library a non-controller's refused restore THROWS (withCompensation reports it for Document Control) — never a silent success", async () => {
    seedDoc("sp1", { status: "Superseded" });
    await restoreSupersededSource("sp1", "Issued", [], { orgId: ORG, actorUserId: ME });
    expect(docRow("sp1").status).toBe("Issued");
    state.reviewMode = "require";
    seedDoc("sp2", { status: "Superseded" });
    await expect(restoreSupersededSource("sp2", "Issued", [], { orgId: ORG, actorUserId: ME })).rejects.toThrow(/source sp2 is still Superseded — restore it to Issued/);
  });

  it("the service role (no session uid) keeps today's treatment: a status-only issue is not decided by the rule", async () => {
    state.uid = null;
    state.reviewMode = "require";
    const d = seedDoc("svc1", { status: "Archived" });
    T("document_holds").push({ id: "h1", document_id: "svc1", released_at: null });
    await unarchiveDocument({ doc: asRecord(d), reason: "restore job", orgId: ORG, actorUserId: ME });
    expect(docRow("svc1").status).toBe("Issued");
  });
});
