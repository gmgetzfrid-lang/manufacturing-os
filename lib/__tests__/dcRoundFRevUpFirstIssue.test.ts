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
  /** a table whose reads answer this error (a column the database lacks) */
  readError: null as null | { table: string; error: { code: string; message: string } },
  /** ONE read — a table and its exact select list — answers this (the live
   *  read revUpDocument makes before it uploads, not every read of the table) */
  selectAnswer: null as null | { table: string; columns: string; answer: { data: unknown; error: unknown } },
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    const from = (t: string) => {
      const re = state.readError;
      if (re && re.table === t) {
        const answer = { data: null, error: re.error };
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "is", "order", "limit"]) chain[m] = () => chain;
        chain.maybeSingle = async () => answer;
        chain.single = async () => answer;
        return chain;
      }
      const sa = state.selectAnswer;
      if (sa && sa.table === t) {
        const real = base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        return new Proxy(real, {
          get(target, prop: string) {
            if (prop !== "select") return target[prop];
            return (cols: unknown, ...rest: unknown[]) => {
              if (cols !== sa.columns) return target.select(cols, ...rest);
              const chain: Record<string, unknown> = {};
              for (const m of ["eq", "in", "is", "order", "limit"]) chain[m] = () => chain;
              chain.maybeSingle = async () => sa.answer;
              chain.single = async () => sa.answer;
              return chain;
            };
          },
        });
      }
      return base.from(t);
    };
    return { ...base, from, rpc: (...a: unknown[]) => state.rpc(...a) };
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
  submitForReview, describeFirstIssue, describeRetiredRevUp, unarchiveRestoreDefault, describeControllerOnlyFirstIssue,
} from "@/lib/revisions";
import { RETIRED_NOT_ISSUED_STAMP } from "@/lib/issueStatus";
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
  // P13 second review fix: a status-only exit into an issue from a retirement that took away NO issue is the new door too.
  const notIssuedExit = next.current_version_id === old.current_version_id && RETIRED.includes(String(old.status))
    && old.retired_issue_status === "not-issued" && old.retired_issue_version_id == null;
  const newDoor = issuing && (!advancing0 || notIssuedExit);
  // P13 review fix: the retirement stamp (written only here) and the put-back it allows.
  const restoring = issuing && RETIRED.includes(String(old.status)) && old.retired_issue_version_id != null
    && next.current_version_id === old.retired_issue_version_id && next.current_version_id === old.current_version_id;
  if (RETIRED.includes(String(next.status))) {
    if (RETIRED.includes(String(old.status))) {
      next.retired_issue_status = old.retired_issue_status ?? null; next.retired_issue_version_id = old.retired_issue_version_id ?? null;
    } else if (old.current_version_id != null && isControlledIssueStatus(old.status as string | null)) {
      next.retired_issue_status = old.status; next.retired_issue_version_id = old.current_version_id;
    } else {
      next.retired_issue_status = "not-issued"; next.retired_issue_version_id = null;
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
  state.readError = null;
  state.selectAnswer = null;
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

  it("a document-level 'require' in a library that does not require it refuses too (read as the database reads it — DEC-71)", async () => {
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
    expect(docRow("ar2")).toMatchObject({ retired_issue_status: "not-issued", retired_issue_version_id: null });
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
    // the document's own 'require' (read from the row) binds in a 'none' library — DEC-71
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

// ─── P13 second review fix ──────────────────────────────────────────────────
describe("P13 second review fix (major) — a retirement that took away no issue is no detour past the hold", () => {
  const update = (id: string, patch: Row) => supabase.from("documents").update(patch).eq("id", id);
  beforeEach(() => { state.reviewMode = "require"; state.roles = ["Manager", "DocCtrl"]; });

  it("the reviewer's case: a controller's held, never-issued Draft taken through Void / Archived / Superseded and then made Issued by a status edit — refused over the hold, as the direct Draft -> Issued is", async () => {
    for (const via of ["Void", "Archived", "Superseded"]) {
      const id = `hd-${via}`;
      seedDoc(id);
      T("document_holds").push({ id: `h-${id}`, document_id: id, released_at: null });
      expect((await update(id, { status: via })).error).toBeNull();
      expect(docRow(id)).toMatchObject({ status: via, retired_issue_status: RETIRED_NOT_ISSUED_STAMP, retired_issue_version_id: null });
      const { error } = await update(id, { status: "Issued" });
      expect(error?.message, via).toBe(HOLD_ISSUE);
      expect(docRow(id).status).toBe(via);
    }
    seedDoc("hd-direct");
    T("document_holds").push({ id: "h-direct", document_id: "hd-direct", released_at: null });
    expect((await update("hd-direct", { status: "Issued" })).error?.message).toBe(HOLD_ISSUE);
  });

  it("what keeps its rule: the put-back of an ISSUE over a hold (a controller), the same detour with no hold, a pointer move with the status (the pointer gate), and a retirement before 20261144 (no stamp)", async () => {
    seedDoc("pb1", { status: "Issued" });
    T("document_holds").push({ id: "h-pb1", document_id: "pb1", released_at: null });
    expect((await update("pb1", { status: "Archived" })).error).toBeNull();
    expect(docRow("pb1").retired_issue_version_id).toBe("pb1-v0");
    expect((await update("pb1", { status: "Issued" })).error).toBeNull();

    seedDoc("nh1");
    expect((await update("nh1", { status: "Void" })).error).toBeNull();
    expect((await update("nh1", { status: "Issued" })).error).toBeNull();

    seedDoc("pm1");
    T("document_holds").push({ id: "h-pm1", document_id: "pm1", released_at: null });
    T("document_versions").push({ id: "pm1-v1", org_id: ORG, record_id: "pm1", revision_label: "1", superseded_at: null });
    expect((await update("pm1", { status: "Archived" })).error).toBeNull();
    expect((await update("pm1", { status: "Issued", current_version_id: "pm1-v1" })).error).toBeNull();

    seedDoc("lg1", { status: "Void" }); // retired before the paste: no stamp
    T("document_holds").push({ id: "h-lg1", document_id: "lg1", released_at: null });
    expect((await update("lg1", { status: "Issued" })).error).toBeNull();
  });

  it("a pointer moved while retired keeps the marker, and a later status-only exit is still the new door; a caller cannot write the marker away", async () => {
    seedDoc("mk1");
    T("document_holds").push({ id: "h-mk1", document_id: "mk1", released_at: null });
    T("document_versions").push({ id: "mk1-v1", org_id: ORG, record_id: "mk1", revision_label: "1", superseded_at: null });
    await update("mk1", { status: "Void" });
    await update("mk1", { current_version_id: "mk1-v1" });
    await update("mk1", { retired_issue_status: null });
    expect(docRow("mk1")).toMatchObject({ retired_issue_status: RETIRED_NOT_ISSUED_STAMP, current_version_id: "mk1-v1" });
    expect((await update("mk1", { status: "Issued" })).error?.message).toBe(HOLD_ISSUE);
  });

  it("the marker is the SQL's: the guard and the INSERT trigger write exactly RETIRED_NOT_ISSUED_STAMP", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261144_dc_roundF_status_issue_transition.sql"), "utf8");
    expect(sql.match(new RegExp(`NEW\\.retired_issue_status := '${RETIRED_NOT_ISSUED_STAMP}';`, "g"))).toHaveLength(2);
    expect(sql).toContain(`AND OLD.retired_issue_status = '${RETIRED_NOT_ISSUED_STAMP}'`);
  });
});

describe("P13 second review fix — a controller's direct first issue is RECORDED on REV_UP (DEC-63 §2), as the merge door records it", () => {
  const revUpEvent = () => T("audit_logs").filter((r) => r.action === "REV_UP").pop()?.details as Record<string, unknown> | undefined;

  it("a controller's Minor rev-up of a Draft in a require library: REV_UP carries the policy decision — a first issue made without the required sign-off", async () => {
    state.reviewMode = "require";
    state.roles = ["Manager", "DocCtrl"];
    published();
    await revUp(seedDoc("rc1"));
    expect(revUpEvent()).toMatchObject({
      changeType: "Minor",
      firstIssueWithoutSignOff: true,
      reviewPolicy: "require — Rev 1 is RC1's FIRST controlled issue, published WITHOUT the sign-off the policy requires, by controller u1 (DEC-63 §2)",
    });
    // a register row's first file by a controller is the same record
    await revUp(seedDoc("rc2", { current_version_id: null, status: "Issued" }));
    expect(revUpEvent()).toMatchObject({ firstIssueWithoutSignOff: true });
  });

  it("nothing is added where no sign-off was skipped: a library that does not require it, or an ordinary revision of an Issued document", async () => {
    published();
    state.roles = ["Manager", "DocCtrl"];
    state.reviewMode = "none";
    await revUp(seedDoc("rc3"));
    expect(revUpEvent()).not.toHaveProperty("reviewPolicy");
    expect(revUpEvent()).not.toHaveProperty("firstIssueWithoutSignOff");
    state.reviewMode = "require";
    state.roles = ["Engineer"];
    await revUp(seedDoc("rc4", { status: "Issued" }));
    expect(revUpEvent()).not.toHaveProperty("reviewPolicy");
  });
});

describe("P13 second review fix — a RETIRED document is not revised: every rev-up door refuses it up front (never a review that can't land)", () => {
  it("firstIssueGateForRevUp answers `retired` (no first issue, no policy read) for Superseded / Void / Archived, trimmed; describeFirstIssue never calls it \"not issued yet\"", async () => {
    state.reviewMode = "require";
    const actor = { orgId: ORG, actorUserId: ME };
    for (const st of ["Superseded", "Void", "Archived", " Void "]) {
      const id = `rt-${st.trim()}-${st.length}`;
      seedDoc(id, { status: st });
      expect(await firstIssueGateForRevUp({ doc: asRecord(docRow(id)), libraryId: LIB, actor }))
        .toMatchObject({ retired: true, firstIssue: false, mustReview: false, requiresSignOff: false });
    }
    expect(effectiveReviewControlForDocument).not.toHaveBeenCalled();
    expect(describeFirstIssue("D1", { hasCurrentRevision: true, status: "Void", retired: true }, "2")).toBe("D1 is Void (retired), so Rev 2 can't be published onto it until it is restored");
    expect(describeRetiredRevUp("D1", "Archived")).toMatch(/^D1 is Archived, and a retired document isn't revised — a review of it could never be published[\s\S]*Restore it first \(un-archive it, or ask Document Control to un-void it or reverse the supersession\)/);
  });

  it("revUpDocument refuses a retired document before anything is uploaded — for a controller too, in any library", async () => {
    published();
    for (const [st, mode, roles] of [["Void", "require", ["Engineer"]], ["Archived", "none", ["Manager", "DocCtrl"]], ["Superseded", "require", ["Admin"]]] as const) {
      state.reviewMode = mode;
      state.roles = [...roles];
      const d = seedDoc(`rr-${st}`, { status: st });
      await expect(revUp(d, "Minor")).rejects.toThrow(new RegExp(`RR-${st.toUpperCase()} is ${st}, and a retired document isn't revised[\\s\\S]*Nothing was uploaded\\.`));
    }
    expect(uploadToPath).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("submitForReview refuses a retired document before anything is uploaded (finalizeReviewedRevision would refuse it: the draft would be stranded)", async () => {
    state.reviewMode = "require";
    const d = seedDoc("sr1", { status: "Void" });
    await expect(submitForReview({
      doc: asRecord(d), libraryId: LIB, file: pdf("x.pdf"), revisionLabel: "1", changeLog: "narrative", changeType: "Major" as never,
      orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/SR1 is Void, and a retired document isn't revised[\s\S]*Nothing was uploaded or submitted\./);
    expect(uploadToPath).not.toHaveBeenCalled();
    expect(docRow("sr1").pending_version_id).toBeNull();
    expect(T("document_versions").filter((v) => v.record_id === "sr1")).toHaveLength(1);
  });

  it("setLevelRevUp puts a retired sheet in `failed` with what to do — never sent to review, never published; the other sheets proceed", async () => {
    state.reviewMode = "require";
    state.canControl = true;
    published();
    const issued = seedDoc("sv1", { status: "Issued" });
    const voided = seedDoc("sv2", { status: "Void" });
    const r = await setLevelRevUp({
      setId: "set9", sheets: [issued, voided].map((d) => ({ doc: asRecord(d), file: pdf(`${d.id}.pdf`), revisionLabel: "1" })),
      libraryId: LIB, sharedChangeLog: "bump", changeType: "Major" as never, orgId: ORG, actorUserId: ME,
    });
    expect(r.sentForReview).toBe(1); // the Issued sheet's Major change
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ documentId: "sv2" });
    expect(r.failed[0].error).toMatch(/SV2 is Void, and a retired document isn't revised[\s\S]*It was not published or submitted\./);
    expect(docRow("sv2").pending_version_id).toBeNull();
  });

  it("mergeDocuments into a retired target with a rev-up is refused in its gate — no source is superseded, nothing is published", async () => {
    state.reviewMode = "none";
    state.canControl = true;
    published();
    const t = seedDoc("rmt", { status: "Archived" });
    const a = seedDoc("rms", { status: "Issued" });
    await expect(mergeDocuments({
      sources: [asRecord(t), asRecord(a)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp: { file: pdf("m.pdf"), revisionLabel: "1", changeLog: "merged", changeType: "Major" as never }, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/RMT is Archived, and a retired document isn't revised[\s\S]*Nothing was merged\./);
    expect(docRow("rms").status).toBe("Issued");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("RevUpModal asks the same gate and refuses a retired document up front (pinned)", () => {
    const m = readFileSync(join(process.cwd(), "components/documents/RevUpModal.tsx"), "utf8");
    expect(m).toContain("setRetiredRefusal(first.retired ? describeRetiredRevUp(");
    expect(m).toContain("if (!asBranch && retiredRefusal) return setError(retiredRefusal);");
    expect(m).toContain("disabled={submitting || !file || !policyResolved || !!retiredRefusal}");
    expect(m).toContain("{effMode !== \"none\" && !retiredRefusal && (");
  });
});

describe("P13 second review fix — the un-archive dialog's default restore status comes from the guard's stamp (unarchiveRestoreDefault)", () => {
  beforeEach(() => { state.reviewMode = "require"; state.canControl = true; state.isOwner = false; });

  it("an archived ISSUE comes back Issued (and its put-back is admitted); an archived Draft comes back a Draft (and stays a Draft); anything unrecorded keeps the default every un-archive had before — Issued (third review fix)", async () => {
    seedDoc("ud1", { status: "Issued" });
    await archiveDocument({ doc: asRecord(docRow("ud1")), reason: "tidy", orgId: ORG, actorUserId: ME });
    expect(await unarchiveRestoreDefault("ud1")).toEqual({ status: "Issued", basis: "issued" });
    await unarchiveDocument({ doc: asRecord(docRow("ud1")), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    expect(docRow("ud1").status).toBe("Issued");

    seedDoc("ud2", { status: "Draft" });
    await archiveDocument({ doc: asRecord(docRow("ud2")), reason: "tidy", orgId: ORG, actorUserId: ME });
    expect(await unarchiveRestoreDefault("ud2")).toEqual({ status: "Draft", basis: "not-issued" });
    await unarchiveDocument({ doc: asRecord(docRow("ud2")), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    expect(docRow("ud2").status).toBe("Draft"); // the dead end the review found: the Draft restore is open to the publisher

    seedDoc("ud3", { status: "Archived" }); // archived before 20261144 (or by the service role): no stamp
    expect(await unarchiveRestoreDefault("ud3")).toEqual({ status: "Issued", basis: "unknown" });
    // a register row (no current revision): a 'not-issued' stamp cannot tell an Issued row from a Draft one, and restoring it issues no revision
    seedDoc("ud4", { status: "Archived", current_version_id: null, retired_issue_status: "not-issued", retired_issue_version_id: null });
    expect(await unarchiveRestoreDefault("ud4")).toEqual({ status: "Issued", basis: "unknown" });
    // the stamped revision is no longer current (a pointer moved while archived): not known to be the issue — the database decides
    seedDoc("ud5", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "other" });
    expect(await unarchiveRestoreDefault("ud5")).toEqual({ status: "Issued", basis: "unknown" });
    expect(await unarchiveRestoreDefault("missing")).toEqual({ status: "Issued", basis: "unknown" });
  });

  it("the reviewer's scenario: a legacy archive (no stamp) of an Issued document in a library that does not require sign-off, restored by a publisher with the dialog's default — Issued, as before P13", async () => {
    state.reviewMode = "none";
    seedDoc("ud7", { status: "Archived", owner_user_id: "someone-else" });
    const d = await unarchiveRestoreDefault("ud7");
    expect(d.status).toBe("Issued");
    await unarchiveDocument({ doc: asRecord(docRow("ud7")), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: d.status });
    expect(docRow("ud7").status).toBe("Issued");
    // and in a require library the database still decides it (unstamped: the require limb), the Draft restore still open
    state.reviewMode = "require";
    seedDoc("ud8", { status: "Archived", owner_user_id: "someone-else" });
    await expect(unarchiveDocument({ doc: asRecord(docRow("ud8")), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: (await unarchiveRestoreDefault("ud8")).status }))
      .rejects.toThrow(UNREVIEWED);
    expect(docRow("ud8").status).toBe("Archived");
    await unarchiveDocument({ doc: asRecord(docRow("ud8")), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    expect(docRow("ud8").status).toBe("Draft");
  });

  it("a database without the stamp (before 20261144 — the app deployed ahead of the paste) or an unreadable row: unknown, Issued — the default before 20261144, never a silent Draft", async () => {
    seedDoc("ud6", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "ud6-v0" });
    expect(await unarchiveRestoreDefault("ud6")).toEqual({ status: "Issued", basis: "issued" }); // readable: the stamp decides
    state.readError = { table: "documents", error: { code: "42703", message: "column documents.retired_issue_status does not exist" } };
    expect(await unarchiveRestoreDefault("ud6")).toEqual({ status: "Issued", basis: "unknown" });
  });
});

describe("P13 third review fix — unarchiveDocument is a checked write", () => {
  const unarchiveEvents = () => T("audit_logs").filter((r) => r.action === "ARCHIVE_DOC" && (r.details as Record<string, unknown>)?.action === "unarchive");

  it("a restore the database filters to zero rows (no edit access) is refused — the document stays Archived and no un-archive event is written", async () => {
    seedDoc("rc1", { status: "Archived" });
    state.db.refuseWrites.add("documents");
    await expect(unarchiveDocument({ doc: asRecord(docRow("rc1")), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" }))
      .rejects.toThrow(/The document was NOT restored — you don't have authority to change it, or it is no longer visible to you\. Nothing was changed\./);
    expect(docRow("rc1").status).toBe("Archived");
    expect(unarchiveEvents()).toHaveLength(0);
  });

  it("a refused restore keeps the guard's sentence (the dialog recognises it) and writes no event; a landed one records the status it restored to", async () => {
    state.reviewMode = "require";
    seedDoc("rc2", { status: "Archived" });
    await expect(unarchiveDocument({ doc: asRecord(docRow("rc2")), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" }))
      .rejects.toThrow(`The document was NOT restored (${UNREVIEWED}) — nothing was changed.`);
    expect(unarchiveEvents()).toHaveLength(0);
    await unarchiveDocument({ doc: asRecord(docRow("rc2")), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    expect(docRow("rc2").status).toBe("Draft");
    expect(unarchiveEvents()).toHaveLength(1);
    expect(unarchiveEvents()[0].details).toMatchObject({ action: "unarchive", restoredStatus: "Draft", reason: "back" });
    // no restoreStatus: Issued, as before — recorded as such
    state.reviewMode = "none";
    seedDoc("rc3", { status: "Archived" });
    await unarchiveDocument({ doc: asRecord(docRow("rc3")), reason: "", orgId: ORG, actorUserId: ME });
    expect(docRow("rc3").status).toBe("Issued");
    expect(unarchiveEvents()[1].details).toMatchObject({ restoredStatus: "Issued", reason: "Restored from archive" });
  });
});

// ─── P13 final review fix ───────────────────────────────────────────────────
describe("P13 final review fix — a first issue only a controller can make is refused up front by every door, never sent to a review with no reviewers", () => {
  // The chain requires sign-off; the document's OWN policy is 'none'. DEC-71: that 'none' is not honoured for a first issue — but submitForReview
  // opens the roster from the policy that resolves for the document (its own
  // 'none' wins: no reviewers), so the in-review draft could never be published.
  const OWN_NONE = { review_control: { mode: "none" } };
  const CONTROLLER_ONLY = /Only Document Control can issue (\S+): this library requires reviewer sign-off for its first issue, but its own review policy is none, so a review would have no reviewers and could never be published\. Ask Document Control to issue it, or to change its review policy\./;
  beforeEach(() => { state.reviewMode = "require"; });

  it("firstIssueGateForRevUp answers controllerOnly for a non-controller only — and only where the document's own 'none' meets a chain that requires sign-off", async () => {
    const actor = { orgId: ORG, actorUserId: ME };
    seedDoc("co1", OWN_NONE); // a Draft
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("co1")), libraryId: LIB, actor }))
      .toMatchObject({ firstIssue: true, requiresSignOff: true, mustReview: true, controllerOnly: true });
    seedDoc("co2", { ...OWN_NONE, current_version_id: null, status: "Issued" }); // a register row's first file
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("co2")), libraryId: LIB, actor })).toMatchObject({ controllerOnly: true });
    // a controller issues it directly (DEC-63 §2) — never controller-only
    state.roles = ["Manager", "DocCtrl"];
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("co1")), libraryId: LIB, actor }))
      .toMatchObject({ firstIssue: true, requiresSignOff: true, mustReview: false, controllerOnly: false });
    state.roles = ["Engineer"];
    // no own policy (the chain's roster), the document's own 'require' in a 'none' library, an issued document, a retired one: not controller-only
    seedDoc("co3");
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("co3")), libraryId: LIB, actor })).toMatchObject({ mustReview: true, controllerOnly: false });
    seedDoc("co4", { ...OWN_NONE, status: "Issued" });
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("co4")), libraryId: LIB, actor })).toMatchObject({ firstIssue: false, controllerOnly: false });
    seedDoc("co5", { ...OWN_NONE, status: "Void" });
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("co5")), libraryId: LIB, actor })).toMatchObject({ retired: true, controllerOnly: false });
    state.reviewMode = "none";
    seedDoc("co6", { review_control: { mode: "require" } });
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("co6")), libraryId: LIB, actor })).toMatchObject({ mustReview: true, controllerOnly: false });
    expect(describeControllerOnlyFirstIssue("P-1")).toMatch(CONTROLLER_ONLY);
  });

  it("revUpDocument refuses it in the shared sentence, before anything is uploaded — never \"submit it for review\"; a controller publishes it", async () => {
    published();
    const d = seedDoc("cr1", OWN_NONE);
    const e = (await revUp(d, "Major").catch((err) => err)) as Error;
    expect(e.message).toMatch(CONTROLLER_ONLY);
    expect(e.message).toMatch(/^Only Document Control can issue CR1: [\s\S]* Nothing was uploaded\.$/);
    expect(e.message).not.toMatch(/submit it for review/i);
    expect(uploadToPath).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
    state.roles = ["Admin"];
    await expect(revUp(d, "Major")).resolves.toBeTruthy();
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it("setLevelRevUp puts such a sheet in `failed` with the sentence — no in-review draft is opened for it; the other sheets proceed", async () => {
    state.canControl = true;
    published();
    const issued = seedDoc("cs1", { status: "Issued" });
    const draft = seedDoc("cs2", OWN_NONE);
    const r = await setLevelRevUp({
      setId: "set-co", sheets: [issued, draft].map((d) => ({ doc: asRecord(d), file: pdf(`${d.id}.pdf`), revisionLabel: "1" })),
      libraryId: LIB, sharedChangeLog: "bump", changeType: "Minor" as never, orgId: ORG, actorUserId: ME,
    });
    expect(r).toMatchObject({ succeeded: 1, sentForReview: 0 });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ documentId: "cs2" });
    expect(r.failed[0].error).toMatch(CONTROLLER_ONLY);
    expect(r.failed[0].error).toMatch(/It was not published or submitted\.$/);
    expect(docRow("cs2").pending_version_id).toBeNull(); // before the fix: an in-review draft that could never be published
    expect(T("document_versions").filter((v) => v.record_id === "cs2")).toHaveLength(1);
  });

  it("mergeDocuments refuses such a target in its gate — not \"submit the merged revision for review first\" — before any source is superseded", async () => {
    state.canControl = true;
    published();
    const t = seedDoc("cm1", OWN_NONE);
    const a = seedDoc("cm2", { status: "Issued" });
    const e = (await mergeDocuments({
      sources: [asRecord(t), asRecord(a)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp: { file: pdf("m.pdf"), revisionLabel: "1", changeLog: "merged", changeType: "Major" as never }, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME,
    }).catch((err) => err)) as Error;
    expect(e.message).toMatch(CONTROLLER_ONLY);
    expect(e.message).toMatch(/Nothing was merged\.$/);
    expect(e.message).not.toMatch(/Submit the merged revision for review/);
    expect(docRow("cm2").status).toBe("Issued");
    expect(T("document_supersessions")).toHaveLength(0);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("P13 final review fix — revUpDocument's live read fails closed (it feeds the first-issue and retired refusals)", () => {
  const LIVE = "current_version_id, status, review_control";

  it("a read error refuses before anything is uploaded, in the gate's words — never the caller's cached row (which here says Issued over a live Draft in a require library)", async () => {
    state.reviewMode = "require";
    published();
    const d = seedDoc("lr1"); // live: a Draft — a first issue the engineer may not publish
    const cached = { ...asRecord(d), status: "Issued" } as DocumentRecord;
    state.selectAnswer = { table: "documents", columns: LIVE, answer: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } };
    await expect(revUpDocument({
      doc: cached, libraryId: LIB, file: pdf("x.pdf"), revisionLabel: "1", changeLog: "narrative", changeType: "Minor" as never,
      orgId: ORG, actorUserId: ME, expectedBaseVersionId: "lr1-v0",
    })).rejects.toThrow("Couldn't verify the review policy for LR1 — nothing was uploaded or published: canceling statement due to statement timeout");
    expect(uploadToPath).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("no row (deleted, or no longer visible) is not found — refused, never a publish decided on the cached row", async () => {
    published();
    const d = seedDoc("lr2", { status: "Issued" });
    state.selectAnswer = { table: "documents", columns: LIVE, answer: { data: null, error: null } };
    await expect(revUp(d, "Minor")).rejects.toThrow("Couldn't verify the review policy for LR2 — nothing was uploaded or published: the document was not found.");
    expect(uploadToPath).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
    // the same document, read: published as before
    state.selectAnswer = null;
    await expect(revUp(d, "Minor")).resolves.toBeTruthy();
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
});
