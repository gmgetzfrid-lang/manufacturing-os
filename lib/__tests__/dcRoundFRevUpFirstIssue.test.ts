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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

import {
  revUpDocument, unarchiveDocument, archiveDocument, supersedeDocument, firstIssueGateForRevUp,
} from "@/lib/revisions";
import { finalizeReviewedRevision, effectiveReviewControlForDocument, effectiveModeForRevUp } from "@/lib/reviewControl";
import { restoreSupersededSource } from "@/lib/documentLifecycle/common";
import { mergeDocuments } from "@/lib/documentLifecycle/merge";
import { setLevelRevUp } from "@/lib/documentLifecycle/setRevUp";
import { supabase } from "@/lib/supabase";
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
const RETIRED = ["Superseded", "Archived", "Void"];
function transcribedGuard(next: Row, old: Row): Row {
  if (!state.uid) return next; // the service role: today's treatment, untouched (no stamp written or cleared)
  const controller = state.roles.some((r) => r === "Admin" || r === "DocCtrl");
  const issuing = next.current_version_id != null && !isControlledIssueStatus(old.status as string | null) && isControlledIssueStatus(next.status as string | null);
  const advancing0 = next.current_version_id !== old.current_version_id
    || (next.status === "Superseded" && (old.status ?? "") !== "Superseded")
    || (RETIRED.includes(String(old.status)) && next.status !== old.status)
    || (next.status === "Archived" && (old.status ?? "") !== "Archived");
  const newDoor = issuing && !advancing0;
  // P13 review fix: the retirement stamp (written only here) and the put-back it allows.
  const restoring = issuing && RETIRED.includes(String(old.status)) && old.retired_issue_version_id != null
    && next.current_version_id === old.retired_issue_version_id && next.current_version_id === old.current_version_id;
  if (RETIRED.includes(String(next.status))) {
    if (RETIRED.includes(String(old.status))) {
      next.retired_issue_status = old.retired_issue_status ?? null; next.retired_issue_version_id = old.retired_issue_version_id ?? null;
    } else if (old.current_version_id != null && isControlledIssueStatus(old.status as string | null)) {
      next.retired_issue_status = old.status; next.retired_issue_version_id = old.current_version_id;
    } else {
      next.retired_issue_status = null; next.retired_issue_version_id = null;
    }
  } else {
    next.retired_issue_status = null; next.retired_issue_version_id = null;
  }
  if (!advancing0 && !issuing) return next;
  const held = T("document_holds").some((h) => h.document_id === next.id && h.released_at == null);
  if (issuing) {
    if (newDoor && held) throw { code: "23514", message: HOLD_ISSUE };
    const require = state.reviewMode === "require" || (next.review_control as { mode?: string } | null)?.mode === "require";
    const rows = T("document_review_signoffs").filter((s) => s.document_version_id === next.current_version_id && s.slot === "primary");
    const complete = rows.length > 0 && rows.every((s) => s.status === "signed" && s.signature_id != null);
    if (!controller && !restoring && require && !complete) throw { code: "23514", message: UNREVIEWED };
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

// ─── P13 review fix 2: a put-back of the retired issue is not a new issue ──
describe("P13 review fix — the require limb spares the put-back of the issue a retirement took away (the retirement stamp, 20261144)", () => {
  beforeEach(() => {
    state.reviewMode = "require";
    state.canControl = true; // a library publisher …
    state.isOwner = false;   // … who is not the owner, and not a controller (Engineer)
  });

  it("the reviewer's case: a publisher supersedes an Issued document whose revision was published unreviewed (a Minor), the lineage write fails, and undoFailedSupersede PUTS IT BACK to Issued — before the fix it stayed Superseded with no successor", async () => {
    seedDoc("su1", { status: "Issued", owner_user_id: "someone-else" });
    seedDoc("rep1", { status: "Issued", document_number: "REP1" });
    state.db.refuseWrites.add("document_supersessions");
    await expect(supersedeDocument({
      doc: asRecord(docRow("su1")), replacementDocNumbers: ["REP1"], libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/Nothing was superseded: [\s\S]*The document is back to Issued\./);
    expect(docRow("su1").status).toBe("Issued");
    expect(docRow("su1").retired_issue_version_id).toBeNull();
  });

  it("a split / merge source flipped by the saga is put back by restoreSupersededSource (the stamp is the guard's: Issued, its current revision)", async () => {
    seedDoc("sp3", { status: "Issued", owner_user_id: "someone-else" });
    const { error } = await supabase.from("documents").update({ status: "Superseded" }).eq("id", "sp3");
    expect(error).toBeNull();
    expect(docRow("sp3")).toMatchObject({ status: "Superseded", retired_issue_status: "Issued", retired_issue_version_id: "sp3-v0" });
    await restoreSupersededSource("sp3", "Issued", [], { orgId: ORG, actorUserId: ME });
    expect(docRow("sp3").status).toBe("Issued");
  });

  it("archive then un-archive of an unreviewed Issued document by the publisher: restored; a Draft archived the same way is NOT issued by its un-archive (the stamp says it was no issue)", async () => {
    seedDoc("ar1", { status: "Issued", owner_user_id: "someone-else" });
    await archiveDocument({ doc: asRecord(docRow("ar1")), reason: "tidy", orgId: ORG, actorUserId: ME });
    expect(docRow("ar1").retired_issue_status).toBe("Issued");
    await unarchiveDocument({ doc: asRecord(docRow("ar1")), reason: "back", orgId: ORG, actorUserId: ME });
    expect(docRow("ar1").status).toBe("Issued");

    seedDoc("ar2", { status: "Draft", owner_user_id: "someone-else" });
    await archiveDocument({ doc: asRecord(docRow("ar2")), reason: "tidy", orgId: ORG, actorUserId: ME });
    expect(docRow("ar2").retired_issue_status).toBeNull();
    await expect(unarchiveDocument({ doc: asRecord(docRow("ar2")), reason: "back", orgId: ORG, actorUserId: ME })).rejects.toThrow(UNREVIEWED);
    expect(docRow("ar2").status).toBe("Archived");
  });

  it("a caller cannot write the stamp: a forged stamp on an archived Draft is overwritten, and the put-back of a DIFFERENT revision than the stamped one is a new issue", async () => {
    seedDoc("fg1", { status: "Draft", owner_user_id: "someone-else" });
    await archiveDocument({ doc: asRecord(docRow("fg1")), reason: "tidy", orgId: ORG, actorUserId: ME });
    await supabase.from("documents").update({ retired_issue_status: "Issued", retired_issue_version_id: "fg1-v0" }).eq("id", "fg1");
    expect(docRow("fg1").retired_issue_version_id).toBeNull();
    await expect(unarchiveDocument({ doc: asRecord(docRow("fg1")), reason: "back", orgId: ORG, actorUserId: ME })).rejects.toThrow(UNREVIEWED);

    seedDoc("fg2", { status: "Issued", owner_user_id: "someone-else" });
    await supabase.from("documents").update({ status: "Superseded" }).eq("id", "fg2");
    T("document_versions").push({ id: "fg2-v1", org_id: ORG, record_id: "fg2", revision_label: "1", superseded_at: null });
    await supabase.from("documents").update({ current_version_id: "fg2-v1" }).eq("id", "fg2");
    expect(docRow("fg2").retired_issue_version_id).toBe("fg2-v0");
    await expect(restoreSupersededSource("fg2", "Issued", [], { orgId: ORG, actorUserId: ME })).rejects.toThrow(/still Superseded/);
  });
});

// ─── P13 review fix 1 / minor 4: every rev-up door asks the first issue up front
describe("P13 review fix — the first issue is answered by effectiveModeForRevUp for every rev-up door, before anything is written", () => {
  const C = (mode: string) => ({ mode }) as never;

  it("effectiveModeForRevUp: a first issue the actor may not make unreviewed answers 'require' whatever the change type or the document's own policy; otherwise unchanged", () => {
    for (const changeType of ["Minor", "Correction", "Major", null]) {
      expect(effectiveModeForRevUp({ control: C("require"), changeType, firstIssueMustReview: true })).toBe("require");
      expect(effectiveModeForRevUp({ control: C("none"), changeType, firstIssueMustReview: true })).toBe("require");
    }
    expect(effectiveModeForRevUp({ control: C("require"), changeType: "Minor", firstIssueMustReview: false })).toBe("none");
    expect(effectiveModeForRevUp({ control: C("require"), changeType: "Minor" })).toBe("none");
    expect(effectiveModeForRevUp({ control: C("publisher_choice"), changeType: "Major" })).toBe("publisher_choice");
  });

  it("firstIssueGateForRevUp reads the LIVE pointer, status and document policy: an issued document is no first issue (no policy read); a Draft or a pointerless row is; under require only a controller is spared review", async () => {
    state.reviewMode = "require";
    seedDoc("g1", { status: "Issued" });
    const actor = { orgId: ORG, actorUserId: ME };
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("g1")), libraryId: LIB, actor })).toMatchObject({ firstIssue: false, mustReview: false });
    expect(effectiveReviewControlForDocument).not.toHaveBeenCalled();
    // the caller's copy says Issued, the row is a Draft: the row decides
    const stale = asRecord(docRow("g1"));
    docRow("g1").status = "Draft";
    expect(await firstIssueGateForRevUp({ doc: stale, libraryId: LIB, actor })).toMatchObject({ firstIssue: true, requiresSignOff: true, mustReview: true, status: "Draft" });
    seedDoc("g2", { current_version_id: null, status: "Issued" });
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("g2")), libraryId: LIB, actor })).toMatchObject({ firstIssue: true, hasCurrentRevision: false, mustReview: true });
    state.roles = ["Manager", "DocCtrl"];
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("g2")), libraryId: LIB, actor })).toMatchObject({ firstIssue: true, requiresSignOff: true, mustReview: false });
    state.roles = ["Engineer"];
    state.reviewMode = "none";
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("g2")), libraryId: LIB, actor })).toMatchObject({ firstIssue: true, requiresSignOff: false, mustReview: false });
    // the document's own 'require' (read from the row) binds in a 'none' library — DEC-44 (P13)
    docRow("g2").review_control = { mode: "require" };
    expect(await firstIssueGateForRevUp({ doc: { ...asRecord(docRow("g2")), reviewControl: null } as DocumentRecord, libraryId: LIB, actor })).toMatchObject({ mustReview: true });
  });

  describe("mergeDocuments into an existing target with a rev-up", () => {
    const revUp = (changeType = "Minor") => ({ file: pdf("merged.pdf"), revisionLabel: "1", changeLog: "merged content", changeType: changeType as never });
    const supersededWrites = () => state.db.calls
      .filter((c) => c.table === "documents" && c.method === "update" && (c.args[0] as Row)?.status === "Superseded");
    const merge = (t: Row, sources: Row[], changeType = "Minor") => mergeDocuments({
      sources: [asRecord(t), ...sources.map(asRecord)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp: revUp(changeType), assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    beforeEach(() => {
      state.reviewMode = "require";
      state.canControl = true;
      state.isOwner = false;
      published();
    });

    it("the reviewer's case: a publisher merges two Issued sources into a DRAFT target with a Minor rev-up in a require library — refused BEFORE anything is written: no source is superseded, nothing is published", async () => {
      const t = seedDoc("mt1", { status: "Draft" });
      const a = seedDoc("ms1", { status: "Issued" });
      const b = seedDoc("ms2", { status: "Issued" });
      const e = (await merge(t, [a, b]).catch((err) => err)) as Error;
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toMatch(/MT1 requires reviewer sign-off for this revision — a merge can't publish it unreviewed \(MT1 is not issued yet \(Draft\), so publishing Rev 1 makes it a controlled issue for the first time; a Minor or Correction change doesn't exempt a first issue\)\. Nothing was merged\./);
      expect(docRow("ms1").status).toBe("Issued");
      expect(docRow("ms2").status).toBe("Issued");
      expect(T("document_supersessions")).toHaveLength(0);
      expect(supersededWrites()).toEqual([]); // never flipped (not flipped and put back)
      expect(state.rpc).not.toHaveBeenCalled();
      expect(uploadToPath).not.toHaveBeenCalled();
    });

    it("a pointerless target (a register row) is a first issue too — refused up front", async () => {
      const t = seedDoc("mt2", { status: "Issued", current_version_id: null });
      const a = seedDoc("ms3", { status: "Issued" });
      await expect(merge(t, [a])).rejects.toThrow(/MT2 has no current revision, so Rev 1 would be its first controlled issue/);
      expect(docRow("ms3").status).toBe("Issued");
      expect(supersededWrites()).toEqual([]); // never flipped (not flipped and put back)
      expect(state.rpc).not.toHaveBeenCalled();
    });

    it("a controller's merge into a Draft target proceeds (the database admits a controller's first issue) and is RECORDED as made without the required sign-off", async () => {
      state.roles = ["Manager", "DocCtrl"];
      const t = seedDoc("mt3", { status: "Draft" });
      const a = seedDoc("ms4", { status: "Issued" });
      await merge(t, [a]);
      expect(state.rpc).toHaveBeenCalledTimes(1);
      expect(docRow("ms4").status).toBe("Superseded");
      const ev = T("audit_logs").find((r) => r.action === "CREATED_FROM_MERGE");
      expect((ev!.details as Record<string, unknown>).reviewPolicy).toBe("require — the merged revision is MT3's FIRST issue, published WITHOUT the sign-off the policy requires, by controller u1 (DEC-63 §2)");
    });

    it("an ISSUED target keeps the Minor hatch (an ordinary revision through the gate): the merge proceeds for the publisher, as before", async () => {
      const t = seedDoc("mt4", { status: "Issued" });
      const a = seedDoc("ms5", { status: "Issued" });
      await merge(t, [a]);
      expect(state.rpc).toHaveBeenCalledTimes(1);
      expect(docRow("ms5").status).toBe("Superseded");
    });
  });

  it("setLevelRevUp: a Minor set bump in a require library publishes the Issued sheets and sends the not-yet-issued ones to REVIEW — never to `failed` for a direct publish revUpDocument would refuse; a controller's Draft sheet publishes directly", async () => {
    state.reviewMode = "require";
    state.canControl = true;
    published();
    const issued = seedDoc("st1", { status: "Issued" });
    const draft = seedDoc("st2", { status: "Draft" });
    const sheets = [issued, draft].map((d) => ({ doc: asRecord(d), file: pdf(`${d.id}.pdf`), revisionLabel: "1" }));
    const r = await setLevelRevUp({
      setId: "set1", sheets, libraryId: LIB, sharedChangeLog: "bump", changeType: "Minor" as never, orgId: ORG, actorUserId: ME,
    });
    expect(r.failed.filter((f) => /first controlled issue|is not issued yet/.test(f.error))).toEqual([]);
    expect(r.succeeded).toBe(1);
    expect((state.rpc.mock.calls[0][1] as Record<string, unknown>).p_doc).toBe("st1");
    // the Draft went to review: an in-review draft on its pending pointer; the document stays a Draft until it is approved
    expect(r).toMatchObject({ succeeded: 1, sentForReview: 1, failed: [] });
    expect(docRow("st2").status).toBe("Draft");
    expect(T("document_versions").find((v) => v.id === docRow("st2").pending_version_id)).toMatchObject({ review_state: "in_review" });

    state.rpc.mockClear();
    state.roles = ["Manager", "DocCtrl"];
    const draft2 = seedDoc("st3", { status: "Draft" });
    const r2 = await setLevelRevUp({
      setId: "set2", sheets: [{ doc: asRecord(draft2), file: pdf("st3.pdf"), revisionLabel: "1" }], libraryId: LIB,
      sharedChangeLog: "bump", changeType: "Minor" as never, orgId: ORG, actorUserId: ME,
    });
    expect(r2).toMatchObject({ succeeded: 1, sentForReview: 0, failed: [] });
  });

  it("RevUpModal asks the same gate and routes a first issue it may not publish to review (pinned)", () => {
    const m = readFileSync(join(process.cwd(), "components/documents/RevUpModal.tsx"), "utf8");
    expect(m).toContain("const first = await firstIssueGateForRevUp({");
    expect(m).toContain("setFirstIssueMustReview(first.mustReview)");
    expect(m).toContain("const effMode = effectiveModeForRevUp({ control: reviewControl ?? { mode: \"none\" }, changeType, firstIssueMustReview });");
    expect(m).toContain('const willReview = effMode === "require" || (effMode === "publisher_choice" && routeThroughReview);');
  });
});
