// document-control Round F wave 2 — P3 LIFECYCLE: the app half, driven end to
// end against an in-memory PostgREST (helpers/fakeSupabase) with the real
// lib/revisions.ts, lib/documentLifecycle/*, lib/documentGuards.ts,
// lib/holdGate.ts, lib/audit.ts and the real finalizeReviewedRevision.
//
//   REV-6   every retirement path voids the in-flight review draft (checked),
//           and a later last-signature cannot publish it
//   REV-8   no legacy fallback: a transient miss is retried against the RPC,
//           a persistent one publishes NOTHING
//   REV-10  archive / split / merge (and a reversal's parking) revoke live
//           share links, the count on the audit event
//   REV-11  creation status is a deliberate choice; issuing takes authority
//           and a policy that does not require sign-off; split refuses in a
//           require-mode library
//   REV-12  the prior status is recorded fresh and restored exactly; a legacy
//           event is refused rather than guessed; work is counted from the
//           operation's own instant
//   REV-13  revert reconciles the effective date
//   REV-14 / DRLS-13  lineage is a checked upsert; a re-run adds the new pair;
//           an unresolved replacement refuses before any write
//   HLD-2   split / merge run the supersede gate (lock + hold); holds carry
//           BEFORE the supersession and a failed carry rolls back
//   DCK-8   the override reason is required (>= 5) and travels to the RPC
//   HLD-1   correctRevisionLabel / renumberDocument refuse a held document
//
// Review fix 2: the split / merge / supersede saga — a source's restore is
// registered BEFORE its flip (a refused flip or lineage write puts it back);
// nothing irreversible (the review void, the share revocation) runs before
// the last step that can still roll back; an extended merge target's rev-up
// runs last and the target is never superseded; a controller may issue in a
// require-mode library (recorded); the facility-less calendar is UTC-12; a
// legacy reversal is named in the dialog; reverseRenumber takes renumber's
// gate; unconfirmed read-backs never read as clean.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  rpc: vi.fn(),
  canControl: true,
  isOwner: false,
  roles: ["Engineer"] as string[],
  reviewMode: "none" as string,
  reviewThrows: false,
  /** table → true when THIS plain read (a select, not a write's returning)
   *  must answer with an error — evaluated when the read is awaited. */
  failRead: null as null | ((table: string) => boolean),
}));

/** Wrap a fake builder so a plain read can be made to fail (a PostgREST
 *  error on the select); writes and their returning selects pass through. */
function readFailable(table: string, inner: Record<string, (...a: unknown[]) => unknown>): unknown {
  let op = "select";
  const failed = () => ({ data: null, error: { message: `${table} read failed` } });
  const wrapper: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") {
        if (op === "select" && state.failRead?.(table)) return (resolve: (v: unknown) => void) => resolve(failed());
        return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => (inner.then as unknown as (a: unknown, b: unknown) => void)(resolve, reject);
      }
      return (...args: unknown[]) => {
        if (["update", "delete", "insert", "upsert"].includes(prop)) op = prop;
        if (prop === "maybeSingle" || prop === "single") {
          if (op === "select" && state.failRead?.(table)) return Promise.resolve(failed());
          return inner[prop](...args);
        }
        inner[prop](...args);
        return wrapper;
      };
    },
  });
  return wrapper;
}

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => readFailable(t, base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>),
      rpc: (...a: unknown[]) => state.rpc(...a),
    };
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
  archiveDocument, supersedeDocument, revertToVersion, revUpDocument, createDocumentWithFile,
  correctRevisionLabel, authorizePublish, voidPendingDraft, UnresolvedReplacementsError,
  PublishContractUnavailableError, PUBLISH_RPC_RETRY_MS, OVERRIDE_REASON_MIN, CREATION_STATUSES,
  PendingDraftVoidError,
} from "@/lib/revisions";
import { finalizeReviewedRevision } from "@/lib/reviewControl";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { splitDocument } from "@/lib/documentLifecycle/split";
import { mergeDocuments } from "@/lib/documentLifecycle/merge";
import {
  reverseSplit, reverseMerge, reverseRenumber, operationInstant, PriorStatusUnknownError, reversalNeedsLegacyStatus,
} from "@/lib/documentLifecycle/reverse";
import {
  markSupersededAndLink, completeSourceRetirement, restoreSupersededSource, copyActiveHoldsToDoc, createNewDocWithFirstVersion,
  withCompensation, type Compensation,
} from "@/lib/documentLifecycle/common";
import { renumberDocument } from "@/lib/documentLifecycle/renumber";
import { isHoldBlockedError } from "@/lib/holdGate";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const T = (t: string) => (state.db.tables[t] ??= []);
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: LIB, document_number: id.toUpperCase(), title: id, rev: "3", revision: "3",
    status: "Issued", current_version_id: `${id}-v3`, pending_version_id: null, checked_out_by: null, checked_out_by_name: null,
    ...extra,
  };
  (state.db.tables.documents ??= []).push(d);
  (state.db.tables.document_versions ??= []).push({ id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null });
  return d;
}
function seedDraft(docId: string) {
  docRow(docId).pending_version_id = `${docId}-v4A`;
  T("document_versions").push({ id: `${docId}-v4A`, org_id: ORG, record_id: docId, revision_label: "4A", base_rev: "4", review_state: "in_review", superseded_at: null, supersedes_version_id: `${docId}-v3` });
  (state.db.tables.document_review_signoffs ??= []).push(
    { id: `${docId}-s1`, document_id: docId, document_version_id: `${docId}-v4A`, reviewer_user_id: "r1", status: "signed", slot: "primary" },
    { id: `${docId}-s2`, document_id: docId, document_version_id: `${docId}-v4A`, reviewer_user_id: "r2", status: "pending", slot: "primary" },
  );
}
function seedShare(docId: string, id: string, revoked = false) {
  (state.db.tables.document_shares ??= []).push({ id, document_id: docId, org_id: ORG, revoked_at: revoked ? "2026-01-01" : null });
}
function seedHold(docId: string, reason = "Awaiting Engineering") {
  (state.db.tables.document_holds ??= []).push({ id: `h-${docId}-${reason}`, org_id: ORG, document_id: docId, reason, notes: null, expected_release_at: null, released_at: null, opened_at: "2026-09-01" });
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: LIB, documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id, collectionId: null,
}) as unknown as DocumentRecord;
const pdf = (n: string) => new File([new Uint8Array([1, 2, 3])], n, { type: "application/pdf" });

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.rpc.mockReset();
  state.canControl = true;
  state.isOwner = false;
  state.roles = ["Engineer"];
  state.reviewMode = "none";
  state.reviewThrows = false;
  state.failRead = null;
  PUBLISH_RPC_RETRY_MS.value = 0;
});

/** Fail the nth plain read of `table` (1-based), counted from now. */
function failNthRead(table: string, nth: number) {
  let n = 0;
  state.failRead = (t) => t === table && ++n === nth;
}
const ACTOR = { orgId: ORG, actorUserId: ME };
const reviewUntouched = (id: string) => {
  expect(docRow(id).pending_version_id).toBe(`${id}-v4A`);
  expect(T("document_versions").find((v) => v.id === `${id}-v4A`)!.superseded_at).toBeNull();
  expect(T("document_review_signoffs").filter((x) => x.document_id === id).map((x) => x.status).sort()).toEqual(["pending", "signed"]);
};

// ─── REV-6 ────────────────────────────────────────────────────────────────
describe("REV-6 — retirement voids the in-flight review draft; a later last signature cannot publish it", () => {
  it("archive: roster voided, draft retired, pointer released — then finalize finds nothing to promote and the document stays Archived", async () => {
    const d = seedDoc("p101"); seedDraft("p101");
    await archiveDocument({ doc: asRecord(d), reason: "Incident review", orgId: ORG, actorUserId: ME });
    expect(docRow("p101").status).toBe("Archived");
    expect(docRow("p101").pending_version_id).toBeNull();
    expect(T("document_versions").find((v) => v.id === "p101-v4A")!.superseded_at).toBeTruthy();
    expect(T("document_review_signoffs").every((s) => s.status === "void")).toBe(true);
    expect(audit("ARCHIVE_DOC")[0].details).toMatchObject({ pendingDraftVoided: "p101-v4A" });
    // the second reviewer "signs from her inbox" → auto-finalize
    const r = await finalizeReviewedRevision({ orgId: ORG, documentId: "p101", actorId: "r2" });
    expect(r.published).toBe(false);
    expect(docRow("p101").status).toBe("Archived");
    expect(docRow("p101").current_version_id).toBe("p101-v3");
  });

  it("supersede and split void the draft the same way — but only AFTER the retirement (status and lineage) has landed", async () => {
    const a = seedDoc("a"); seedDraft("a");
    seedDoc("b");
    await supersedeDocument({ doc: asRecord(a), replacementDocNumbers: ["B"], libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME });
    expect(docRow("a").pending_version_id).toBeNull();
    expect(audit("SUPERSEDE_DOC")[0].details).toMatchObject({ pendingDraftVoided: "a-v4A", pendingDraftVoidProblem: null });
    // order: the status flip and the lineage upsert BEFORE the roster void
    const order = state.db.calls
      .filter((c) => (c.table === "documents" && c.method === "update") || (c.table === "document_supersessions" && c.method === "upsert") || (c.table === "document_review_signoffs" && c.method === "update"))
      .map((c) => c.table === "document_review_signoffs" ? "void" : c.table === "document_supersessions" ? "lineage" : ((c.args[0] as Row).status === "Superseded" ? "flip" : "other"));
    expect(order.indexOf("flip")).toBeLessThan(order.indexOf("void"));
    expect(order.indexOf("lineage")).toBeLessThan(order.indexOf("void"));

    const c = seedDoc("c"); seedDraft("c");
    const t = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
    await splitDocument({ source: asRecord(c), libraryId: LIB, targets: [t("C1"), t("C2")], reason: "declutter", orgId: ORG, actorUserId: ME });
    expect(docRow("c").pending_version_id).toBeNull();
    expect(T("document_versions").find((v) => v.id === "c-v4A")!.superseded_at).toBeTruthy();
    expect(audit("DOC_SPLIT")[0].details).toMatchObject({ pendingDraftVoided: "c-v4A", pendingDraftVoidProblem: null, priorStatus: "Issued" });
    const fin = await finalizeReviewedRevision({ orgId: ORG, documentId: "c", actorId: "r2" });
    expect(fin.published).toBe(false);
    expect(docRow("c").status).toBe("Superseded");
  });

  it("archive voids the draft only AFTER its own write committed: a roster void refused then is on the ARCHIVE_DOC record (checked, never swallowed) and the draft still cannot publish", async () => {
    const d = seedDoc("p102"); seedDraft("p102");
    state.db.refuseWrites.add("document_review_signoffs");
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    expect(docRow("p102").status).toBe("Archived");
    expect(audit("ARCHIVE_DOC")[0].details).toMatchObject({
      pendingDraftVoided: null,
      pendingDraftVoidProblem: expect.stringMatching(/could be voided|could not be voided/),
    });
    const r = await finalizeReviewedRevision({ orgId: ORG, documentId: "p102", actorId: "r2" });
    expect(r.published).toBe(false);
    expect(docRow("p102").status).toBe("Archived");
  });

  // The reviewer's blocker: a REFUSED archive must change nothing — an
  // in-flight review's signatures cannot be un-voided (20261070).
  const untouched = (id: string) => {
    expect(docRow(id).status).toBe("Issued");
    expect(docRow(id).pending_version_id).toBe(`${id}-v4A`);
    expect(T("document_versions").find((v) => v.id === `${id}-v4A`)!.superseded_at).toBeNull();
    expect(T("document_review_signoffs").filter((x) => x.document_id === id).map((x) => x.status).sort()).toEqual(["pending", "signed"]);
    expect(audit("ARCHIVE_DOC")).toHaveLength(0);
  };
  // enforce_document_retention_guard (20261077), transcribed: a legal hold
  // refuses the archive for everyone, controllers included.
  const retentionGuard = (next: Row, old: Row) => {
    if (old.legal_hold && next.status === "Archived" && old.status !== "Archived") {
      throw { code: "23514", message: "This document is under legal hold and cannot be archived." };
    }
    return next;
  };

  it("archive of a document under LEGAL HOLD with a signed review is refused BEFORE anything — sign-offs, draft and pointer untouched (a controller too)", async () => {
    state.roles = ["Manager", "DocCtrl"];
    state.db.beforeUpdate!.documents = retentionGuard;
    const d = seedDoc("lh1", { legal_hold: true }); seedDraft("lh1");
    await expect(archiveDocument({ doc: asRecord(d), reason: "records", orgId: ORG, actorUserId: ME })).rejects.toThrow(/under legal hold and cannot be archived/);
    untouched("lh1");
  });

  it("archive by a non-controller publisher while an operational hold is open is refused BEFORE anything; a controller may archive through it, as the database allows", async () => {
    const d = seedDoc("oh1"); seedDraft("oh1"); seedHold("oh1");
    const e = await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME }).catch((err) => err);
    expect(isHoldBlockedError(e)).toBe(true);
    untouched("oh1");
    state.roles = ["DocCtrl"];
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    expect(docRow("oh1").status).toBe("Archived");
    expect(docRow("oh1").pending_version_id).toBeNull();
  });

  it("archive without publish authority (and not the owner) is refused BEFORE anything", async () => {
    state.canControl = false; state.isOwner = false;
    const d = seedDoc("na1"); seedDraft("na1");
    await expect(archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME })).rejects.toThrow(/NOT archived — archiving takes publish authority/);
    untouched("na1");
  });

  it("a database refusal the pre-gate could not foresee still destroys nothing: the archive is written first and the review voided only after it lands", async () => {
    state.db.beforeUpdate!.documents = (next, old) => {
      if (next.status === "Archived" && old.status !== "Archived") throw { code: "23514", message: "some other guard said no" };
      return next;
    };
    const d = seedDoc("db1"); seedDraft("db1");
    await expect(archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME })).rejects.toThrow(/NOT archived \(some other guard said no\) — nothing was changed/);
    untouched("db1");
  });

  it("revert (after its publish committed) voids the draft and records it; revUp does the same on the REV_UP record", async () => {
    const d = seedDoc("r1"); seedDraft("r1");
    T("document_versions").push({ id: "r1-v2", org_id: ORG, record_id: "r1", revision_label: "2", review_state: null, superseded_at: "2026-01-01" });
    state.rpc.mockImplementation(async () => ({ data: { status: "published", version: { id: "r1-v5", record_id: "r1", revision_label: "4" } }, error: null }));
    await revertToVersion({
      doc: asRecord(d), libraryId: LIB, orgId: ORG, actorUserId: ME, reason: "bad line class",
      targetVersion: { id: "r1-v2", revisionLabel: "2", fileUrl: "k", reviewState: null } as unknown as DocumentVersion,
    });
    expect(docRow("r1").pending_version_id).toBeNull();
    expect(audit("REVERT")[0].details).toMatchObject({ pendingDraftVoided: "r1-v4A", pendingDraftVoidProblem: null });
  });

  it("voidPendingDraft is a no-op on a document with no draft", async () => {
    seedDoc("n1");
    await expect(voidPendingDraft("n1")).resolves.toBeNull();
  });
});

// ─── REV-8 ────────────────────────────────────────────────────────────────
describe("REV-8 — no unguarded fallback", () => {
  const revUpInput = (d: Row) => ({
    doc: asRecord(d), libraryId: LIB, file: pdf("x.pdf"), revisionLabel: "4", changeLog: "narrative",
    orgId: ORG, actorUserId: ME, expectedBaseVersionId: d.current_version_id as string,
  });
  it("a miss that survives the one retry publishes NOTHING and says so", async () => {
    const d = seedDoc("m1");
    state.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function publish_revision" } });
    await expect(revUpDocument(revUpInput(d))).rejects.toBeInstanceOf(PublishContractUnavailableError);
    expect(state.rpc).toHaveBeenCalledTimes(2);
    expect(T("document_versions").filter((v) => v.record_id === "m1")).toHaveLength(1); // only the seeded v3
    expect(docRow("m1").current_version_id).toBe("m1-v3");
    expect(audit("REV_UP")).toHaveLength(0);
  });
  it("a transient miss is retried against the RPC — never downgraded", async () => {
    const d = seedDoc("m2");
    state.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "schema cache" } })
      .mockResolvedValueOnce({ data: { status: "published", version: { id: "m2-v4", record_id: "m2", revision_label: "4" } }, error: null });
    const r = await revUpDocument(revUpInput(d));
    expect(r.newVersion.id).toBe("m2-v4");
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });
  it("the legacy three-step path, its 60-second tab flag and the revert legacy branch are gone from the source", () => {
    const r = src("lib/revisions.ts");
    expect(r).not.toMatch(/legacyRevUpAfterUpload|publishRpcUnavailable|markPublishRpcMissing|publishRpcMissingUntil|legacyBody/);
    expect(r).not.toMatch(/Pre-migration fallback/);
  });
});

// ─── DCK-8 (app half) ─────────────────────────────────────────────────────
describe("DCK-8 — a publish over another user's checkout states why, and the reason travels to the database", () => {
  it("a missing or short reason is refused before anything is uploaded", async () => {
    seedDoc("k1", { checked_out_by: "someone", checked_out_by_name: "Sam" });
    await expect(authorizePublish({ documentId: "k1", libraryId: LIB, orgId: ORG, actorUserId: ME })).rejects.toThrow(/reason is required/);
    await expect(authorizePublish({ documentId: "k1", libraryId: LIB, orgId: ORG, actorUserId: ME, overrideReason: "abc" }))
      .rejects.toThrow(new RegExp(`at least ${OVERRIDE_REASON_MIN} characters`));
    // a non-controller's force is not a way round the reason
    await expect(authorizePublish({ documentId: "k1", libraryId: LIB, orgId: ORG, actorUserId: ME, force: true })).rejects.toThrow(/reason is required/);
    // a controller's explicit force is
    state.roles = ["Manager", "DocCtrl"];
    await expect(authorizePublish({ documentId: "k1", libraryId: LIB, orgId: ORG, actorUserId: ME, force: true })).resolves.toBeTruthy();
  });
  it("revUp names p_override_reason ONLY when it overrides a lock (an ordinary publish is the same call on either side of 20261130)", async () => {
    const d = seedDoc("k2", { checked_out_by: "someone" });
    state.rpc.mockResolvedValue({ data: { status: "published", version: { id: "k2-v4", record_id: "k2", revision_label: "4" } }, error: null });
    await revUpDocument({ doc: asRecord(d), libraryId: LIB, file: pdf("x.pdf"), revisionLabel: "4", changeLog: "n", orgId: ORG, actorUserId: ME, expectedBaseVersionId: "k2-v3", overrideReason: "  field walkdown found a clash  " });
    const args = state.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_override_lock).toBe(true);
    expect(args.p_override_reason).toBe("field walkdown found a clash");

    const e = seedDoc("k3");
    state.rpc.mockClear();
    await revUpDocument({ doc: asRecord(e), libraryId: LIB, file: pdf("x.pdf"), revisionLabel: "4", changeLog: "n", orgId: ORG, actorUserId: ME, expectedBaseVersionId: "k3-v3" });
    const args2 = state.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args2.p_override_lock).toBe(false);
    expect("p_override_reason" in args2).toBe(false);
  });
  it("before 20261130 is pasted an override publish is refused with the deploy-order message, not published", async () => {
    const d = seedDoc("k4", { checked_out_by: "someone" });
    state.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.publish_revision(p_override_reason, …)" } });
    await expect(revUpDocument({ doc: asRecord(d), libraryId: LIB, file: pdf("x.pdf"), revisionLabel: "4", changeLog: "n", orgId: ORG, actorUserId: ME, expectedBaseVersionId: "k4-v3", overrideReason: "urgent field fix" }))
      .rejects.toThrow(/needs migration 20261130/);
  });
});

// ─── REV-10 ───────────────────────────────────────────────────────────────
describe("REV-10 (lifecycle half) — archive / split / merge revoke live share links, durably", () => {
  it("archive revokes the live links only (an already-revoked row is not touched) and records the count", async () => {
    const d = seedDoc("s1"); seedShare("s1", "sh1"); seedShare("s1", "sh2"); seedShare("s1", "sh3", true);
    await archiveDocument({ doc: asRecord(d), reason: "retired", orgId: ORG, actorUserId: ME });
    expect(T("document_shares").filter((s) => s.revoked_at && s.revoked_by === ME).map((s) => s.id).sort()).toEqual(["sh1", "sh2"]);
    expect(T("document_shares").find((s) => s.id === "sh3")!.revoked_by).toBeUndefined();
    expect(audit("ARCHIVE_DOC")[0].details).toMatchObject({ revokedShareLinks: 2, shareRevokeError: null });
  });
  it("split / merge revoke the source's links once the retirement has landed; a refusal is on the record, not swallowed", async () => {
    const s2 = seedDoc("s2"); seedShare("s2", "shx");
    const t = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
    await splitDocument({ source: asRecord(s2), libraryId: LIB, targets: [t("S2A"), t("S2B")], reason: "split", orgId: ORG, actorUserId: ME });
    expect(T("document_shares")[0].revoked_at).toBeTruthy();
    expect(audit("DOC_SPLIT")[0].details).toMatchObject({ revokedShareLinks: 1, shareRevokeError: null });

    seedDoc("s3"); seedShare("s3", "shy");
    const retired = await withCompensation(async (register) => markSupersededAndLink({ sourceDocId: "s3", replacementDocIds: ["s2"], reason: "x", actor: ACTOR, register, label: "s3" }));
    expect(T("document_shares").find((x) => x.id === "shy")!.revoked_at).toBeNull(); // not before completion
    state.db.refuseWrites.add("document_shares");
    await completeSourceRetirement({ source: retired, replacementDocIds: ["s2"], reason: "x", actor: ACTOR, sourceAuditAction: "DOC_SPLIT" });
    expect(audit("DOC_SPLIT")[1].details).toMatchObject({ revokedShareLinks: 0 });
  });
  it("supersede re-points DIST-1's revoke at the same shared helper", () => {
    const r = src("lib/revisions.ts");
    const sup = r.slice(r.indexOf("export async function supersedeDocument("));
    expect(sup).toMatch(/const shares = await revokeLiveSharesForDocument\(doc\.id, actorUserId\);/);
    expect(src("lib/documentLifecycle/common.ts")).toMatch(/revokeLiveSharesForDocument\(source\.sourceDocId, actor\.actorUserId\)/);
  });
});

// ─── REV-14 / DRLS-13 (writers) ───────────────────────────────────────────
describe("REV-14 / DRLS-13 — lineage is a checked upsert on the pair", () => {
  it("re-running a supersede with an ADDED replacement records the new pair (the existing one no longer sinks the batch)", async () => {
    const d = seedDoc("p1"); seedDoc("p1a"); seedDoc("p1b");
    await supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P1A"], libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME });
    await supersedeDocument({ doc: asRecord(docRow("p1")), replacementDocNumbers: ["P1A", "P1B"], libraryId: LIB, reason: "and B", orgId: ORG, actorUserId: ME });
    const pairs = T("document_supersessions").map((r) => `${r.superseded_doc_id}->${r.replacement_doc_id}`).sort();
    expect(pairs).toEqual(["p1->p1a", "p1->p1b"]);
    const up = state.db.calls.filter((c) => c.table === "document_supersessions" && c.method === "upsert");
    expect(up.length).toBe(2);
    expect(up[0].args[1]).toEqual({ onConflict: "superseded_doc_id,replacement_doc_id", ignoreDuplicates: true });
  });
  it("an unresolved replacement refuses the WHOLE supersede before anything is written", async () => {
    const d = seedDoc("p2"); seedDoc("p2a");
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P2A", "NOPE"], libraryId: LIB, reason: "r", orgId: ORG, actorUserId: ME }))
      .rejects.toBeInstanceOf(UnresolvedReplacementsError);
    expect(docRow("p2").status).toBe("Issued");
    expect(T("document_supersessions")).toHaveLength(0);
  });
  it("a refused lineage write puts the document BACK — nothing superseded, status and supersession fields restored — and says so (never a success, never a Superseded record the Inspector can no longer re-run)", async () => {
    const d = seedDoc("p3"); seedDoc("p3a");
    state.db.refuseWrites.add("document_supersessions");
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P3A"], libraryId: LIB, reason: "r", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/^Nothing was superseded: The replacement links could not be recorded \(.*\)\. The document is back to Issued\..*supersede it again\.$/);
    expect(docRow("p3")).toMatchObject({ status: "Issued", superseded_at: null, supersession_reason: null });
    expect(audit("SUPERSEDE_DOC")).toHaveLength(0);
  });
  it("an INCOMPLETE lineage (a pair silently dropped) is undone too: the pair this attempt did write is removed", async () => {
    const d = seedDoc("p4"); seedDoc("p4a"); seedDoc("p4b");
    state.db.beforeInsert!.document_supersessions = (row) => (row.replacement_doc_id === "p4b" ? null : row);
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P4A", "P4B"], libraryId: LIB, reason: "r", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/Nothing was superseded: 1 of 2 replacement link\(s\) were not recorded.*back to Issued/);
    expect(docRow("p4").status).toBe("Issued");
    expect(T("document_supersessions")).toHaveLength(0);
  });
  it("a re-run on an already-Superseded document whose ADDED link fails keeps its first supersession (fields and existing pair)", async () => {
    const d = seedDoc("p5"); seedDoc("p5a"); seedDoc("p5b");
    await supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P5A"], libraryId: LIB, reason: "first", orgId: ORG, actorUserId: ME });
    const first = { ...docRow("p5") };
    state.db.beforeInsert!.document_supersessions = (row) => (row.replacement_doc_id === "p5b" ? null : row);
    await expect(supersedeDocument({ doc: asRecord(docRow("p5")), replacementDocNumbers: ["P5A", "P5B"], libraryId: LIB, reason: "second", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/back to Superseded/);
    expect(docRow("p5")).toMatchObject({ status: "Superseded", superseded_at: first.superseded_at, supersession_reason: "first" });
    expect(T("document_supersessions").map((r) => `${r.superseded_doc_id}->${r.replacement_doc_id}`)).toEqual(["p5->p5a"]);
  });
  it("split / merge get a neutral lineage message (their rollback states the outcome), never the old 're-run' advice", () => {
    const r = src("lib/revisions.ts");
    expect(r).not.toMatch(/re-running is safe/);
    expect(r).toMatch(/export class SupersessionLineageError extends Error/);
  });
  it("the modal warns when no replacement is named, and treats an unresolved number as a refusal", () => {
    const m = src("components/documents/SupersedeModal.tsx");
    expect(m).toMatch(/No replacement named\./);
    expect(m).toMatch(/replacements\.length === 0 &&/);
    expect(m).toMatch(/e instanceof UnresolvedReplacementsError/);
    expect(src("lib/revisions.ts")).not.toMatch(/from\("document_supersessions"\)\.insert\(/);
  });
});

// ─── REV-12 ───────────────────────────────────────────────────────────────
describe("REV-12 — reversal restores the status the source actually held", () => {
  it("the DOC_SPLIT event records the FRESH prior status and the operation's instant", async () => {
    seedDoc("v1", { status: "Void" }); seedDoc("v1a");
    const comps: Compensation[] = [];
    const retired = await markSupersededAndLink({ sourceDocId: "v1", replacementDocIds: ["v1a"], reason: "s", actor: ACTOR, register: (c) => comps.push(c), label: "v1" });
    expect(retired.priorStatus).toBe("Void");
    expect(comps).toHaveLength(1); // its restore, registered before the flip
    await completeSourceRetirement({ source: retired, replacementDocIds: ["v1a"], reason: "s", actor: ACTOR, sourceAuditAction: "DOC_SPLIT" });
    const det = audit("DOC_SPLIT")[0].details as Record<string, unknown>;
    expect(det.priorStatus).toBe("Void");
    expect(det.auditAt).toBe(retired.auditAt);
  });
  it("reverseSplit puts a Void source back to Void (never Issued) and counts work from the split's instant", async () => {
    state.roles = ["DocCtrl"];
    seedDoc("v2", { status: "Superseded" }); seedDoc("v2a"); seedDoc("v2b");
    T("document_supersessions").push({ id: "l1", superseded_doc_id: "v2", replacement_doc_id: "v2a" }, { id: "l2", superseded_doc_id: "v2", replacement_doc_id: "v2b" });
    (state.db.tables.audit_logs ??= []).push({ id: "ev1", action: "DOC_SPLIT", resource_id: "v2", timestamp: "2026-09-01T10:00:00Z", details: { replacementDocIds: ["v2a", "v2b"], priorStatus: "Void", auditAt: "2026-09-01T10:00:00Z" } });
    await reverseSplit({ splitAuditEventId: "ev1", reason: "wrong split", orgId: ORG, actorUserId: ME });
    expect(docRow("v2").status).toBe("Void");
    expect(docRow("v2a").status).toBe("Superseded");
    expect(T("document_supersessions")).toHaveLength(0);
    const gt = state.db.calls.find((c) => c.table === "audit_logs" && c.method === "gt");
    expect(gt!.args).toEqual(["timestamp", "2026-09-01T10:00:00Z"]);
    expect(audit("DOC_SPLIT_REVERSED")[0].details).toMatchObject({ restoredStatus: "Void", restoredStatusSource: "recorded" });
  });
  it("a legacy split (no recorded prior status) is REFUSED — nothing moves — unless the status is named explicitly", async () => {
    state.roles = ["DocCtrl"];
    seedDoc("v3", { status: "Superseded" }); seedDoc("v3a");
    (state.db.tables.audit_logs ??= []).push({ id: "ev2", action: "DOC_SPLIT", resource_id: "v3", timestamp: "2026-05-01T00:00:00Z", details: { replacementDocIds: ["v3a"] } });
    await expect(reverseSplit({ splitAuditEventId: "ev2", reason: "r", orgId: ORG, actorUserId: ME })).rejects.toBeInstanceOf(PriorStatusUnknownError);
    expect(docRow("v3").status).toBe("Superseded");
    expect(docRow("v3a").status).toBe("Issued");
    await reverseSplit({ splitAuditEventId: "ev2", reason: "r", orgId: ORG, actorUserId: ME, legacyRestoreStatus: "Draft" });
    expect(docRow("v3").status).toBe("Draft");
    await expect(reverseSplit({ splitAuditEventId: "ev2", reason: "r", orgId: ORG, actorUserId: ME, legacyRestoreStatus: "Anything" })).rejects.toThrow(/Cannot restore/);
  });
  it("reverseMerge restores EACH sibling to the status it held, from any one DOC_MERGED event", async () => {
    state.roles = ["Admin"];
    seedDoc("m1", { status: "Superseded" }); seedDoc("m2", { status: "Superseded" }); seedDoc("mt");
    (state.db.tables.audit_logs ??= []).push({ id: "ev3", action: "DOC_MERGED", resource_id: "m1", timestamp: "2026-09-02T00:00:00Z", details: { mergedIntoDocumentId: "mt", mergeSiblings: ["m1", "m2"], targetWasNewlyCreated: true, priorStatus: "Issued", priorStatuses: { m1: "Issued", m2: "Void" }, auditAt: "2026-09-02T00:00:00Z" } });
    await reverseMerge({ mergeAuditEventId: "ev3", reason: "r", orgId: ORG, actorUserId: ME });
    expect(docRow("m1").status).toBe("Issued");
    expect(docRow("m2").status).toBe("Void");
    expect(docRow("mt").status).toBe("Superseded");
  });
  it("reverseMerge parks the merged target FIRST: a refused park leaves every source Superseded and the lineage intact (never sources and target live at once) — and destroys no signature on it", async () => {
    state.roles = ["Admin"];
    seedDoc("m3", { status: "Superseded" }); seedDoc("m4", { status: "Superseded" }); seedDoc("mt2"); seedDraft("mt2");
    T("document_supersessions").push({ id: "lm3", superseded_doc_id: "m3", replacement_doc_id: "mt2" }, { id: "lm4", superseded_doc_id: "m4", replacement_doc_id: "mt2" });
    (state.db.tables.audit_logs ??= []).push({ id: "ev5", action: "DOC_MERGED", resource_id: "m3", timestamp: "2026-09-03T00:00:00Z", details: { mergedIntoDocumentId: "mt2", mergeSiblings: ["m3", "m4"], targetWasNewlyCreated: true, priorStatuses: { m3: "Issued", m4: "Issued" }, auditAt: "2026-09-03T00:00:00Z" } });
    state.db.beforeUpdate!.documents = (next, old) => {
      if (old.id === "mt2" && next.status === "Superseded") throw { code: "23514", message: "park refused" };
      return next;
    };
    await expect(reverseMerge({ mergeAuditEventId: "ev5", reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/could not be parked as Superseded \(park refused\)/);
    expect(docRow("m3").status).toBe("Superseded");
    expect(docRow("m4").status).toBe("Superseded");
    expect(docRow("mt2").status).toBe("Issued");
    expect(T("document_supersessions")).toHaveLength(2);
    reviewUntouched("mt2");
  });
  it("a parked sheet's review is voided only AFTER the park lands; a void refused then is on the reversal's record", async () => {
    state.roles = ["DocCtrl"];
    seedDoc("v5", { status: "Superseded" }); seedDoc("v5a"); seedDraft("v5a");
    T("document_supersessions").push({ id: "l5", superseded_doc_id: "v5", replacement_doc_id: "v5a" });
    (state.db.tables.audit_logs ??= []).push({ id: "ev6", action: "DOC_SPLIT", resource_id: "v5", timestamp: "2026-09-01T10:00:00Z", details: { replacementDocIds: ["v5a"], priorStatus: "Issued", auditAt: "2026-09-01T10:00:00Z" } });
    state.db.refuseWrites.add("document_review_signoffs");
    await reverseSplit({ splitAuditEventId: "ev6", reason: "r", orgId: ORG, actorUserId: ME });
    expect(docRow("v5a").status).toBe("Superseded");
    expect(docRow("v5").status).toBe("Issued");
    expect(audit("DOC_SPLIT_REVERSED")[0].details).toMatchObject({ pendingDraftVoidProblems: [expect.stringMatching(/^v5a: .*(could be voided|could not be voided)/)] });
  });
  it("reversal is a Document Control / Admin act (it deletes supersession rows the database reserves to them)", async () => {
    seedDoc("v4", { status: "Superseded" }); seedDoc("v4a");
    (state.db.tables.audit_logs ??= []).push({ id: "ev4", action: "DOC_SPLIT", resource_id: "v4", timestamp: "t", details: { replacementDocIds: ["v4a"], priorStatus: "Issued", auditAt: "t" } });
    await expect(reverseSplit({ splitAuditEventId: "ev4", reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/Document Control or an Admin/);
    expect(docRow("v4a").status).toBe("Issued");
  });
  it("operationInstant never falls back to the epoch", () => {
    expect(operationInstant({ details: { auditAt: "A" }, timestamp: "B" })).toBe("A");
    expect(operationInstant({ details: {}, timestamp: "B" })).toBe("B");
    expect(() => operationInstant({ details: null, timestamp: null })).toThrow();
    expect(src("lib/documentLifecycle/reverse.ts")).not.toMatch(/1970-01-01T00:00:00Z"/);
    expect(src("lib/documentLifecycle/reverse.ts")).not.toMatch(/status: "Issued"/);
  });
  it("a compensation that cannot restore or clean up THROWS (withCompensation reports it) instead of calling the rollback clean", async () => {
    seedDoc("c9", { status: "Superseded" });
    T("document_supersessions").push({ id: "lx", superseded_doc_id: "c9", replacement_doc_id: "c9a" });
    state.db.refuseWrites.add("document_supersessions");
    await expect(restoreSupersededSource("c9", "Issued", ["c9a"], { orgId: ORG, actorUserId: ME })).rejects.toThrow(/could not be removed/);
  });
});

// ─── HLD-2 + REV-11 (split / merge) ───────────────────────────────────────
describe("HLD-2 — split / merge run the supersede gate, and holds carry BEFORE the supersession", () => {
  const target = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
  it("a held source is refused for a non-controller before anything is written", async () => {
    const s = seedDoc("h1"); seedHold("h1");
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [target("H1A"), target("H1B")], reason: "declutter", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/active hold/);
    expect(T("documents")).toHaveLength(1);
    expect(docRow("h1").status).toBe("Issued");
  });
  it("a controller's explicit force proceeds: every new sheet carries the hold, placed BEFORE the source is superseded", async () => {
    state.roles = ["DocCtrl"];
    const s = seedDoc("h2"); seedHold("h2");
    const r = await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [target("H2A"), target("H2B")], reason: "declutter", orgId: ORG, actorUserId: ME, force: true });
    expect(r.holdsCopied).toBe(2);
    for (const id of r.newDocumentIds) expect(T("document_holds").some((h) => h.document_id === id && h.released_at == null)).toBe(true);
    const order = state.db.calls.filter((c) => (c.table === "document_holds" && c.method === "insert") || (c.table === "documents" && c.method === "update"))
      .map((c) => c.table === "document_holds" ? "hold" : ((c.args[0] as Row).status === "Superseded" ? "supersede" : "other"));
    expect(order.lastIndexOf("hold")).toBeLessThan(order.indexOf("supersede"));
    expect(docRow("h2").status).toBe("Superseded");
  });
  it("copyHolds:false is refused while the source has an active hold", async () => {
    state.roles = ["DocCtrl"];
    const s = seedDoc("h3"); seedHold("h3");
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [target("H3A"), target("H3B")], reason: "x", orgId: ORG, actorUserId: ME, force: true, copyHolds: false }))
      .rejects.toThrow(/must carry it onto every new sheet/);
    expect(T("documents")).toHaveLength(1);
  });
  it("a hold that fails to carry rolls the WHOLE split back — the source is never superseded, the new sheets are archived", async () => {
    state.roles = ["DocCtrl"];
    const s = seedDoc("h4"); seedHold("h4");
    let n = 0;
    state.db.beforeInsert!.document_holds = (row) => { if (++n === 2) throw { code: "42501", message: "hold insert refused" }; return row; };
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [target("H4A"), target("H4B")], reason: "x", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/could not be carried over/);
    expect(docRow("h4").status).toBe("Issued");
    const created = T("documents").filter((d) => d.id !== "h4");
    expect(created.every((d) => d.status === "Archived")).toBe(true);
    expect(T("document_holds").filter((h) => h.document_id !== "h4").every((h) => h.released_at)).toBe(true);
  });
  it("copyActiveHoldsToDoc throws on a refused insert instead of returning a smaller count", async () => {
    seedDoc("h5"); seedHold("h5");
    state.db.beforeInsert!.document_holds = () => { throw { message: "refused" }; };
    await expect(copyActiveHoldsToDoc({ sourceDocId: "h5", targetDocId: "t5", originLabel: "x", actor: { orgId: ORG, actorUserId: ME } })).rejects.toThrow(/could not be carried over/);
    expect(src("lib/documentLifecycle/common.ts")).not.toMatch(/if \(!error && insertedHold\)/);
  });
  it("a carry that fails PART-WAY on one target releases the holds it already placed there before throwing (the caller never got their ids)", async () => {
    seedDoc("h6"); seedHold("h6", "Awaiting Engineering"); seedHold("h6", "Field verification");
    state.db.beforeInsert!.document_holds = (row) => { if (row.reason === "Field verification") throw { code: "42501", message: "refused" }; return row; };
    await expect(copyActiveHoldsToDoc({ sourceDocId: "h6", targetDocId: "t6", originLabel: "Sheet 1 (split)", actor: { orgId: ORG, actorUserId: ME } }))
      .rejects.toThrow(/"Field verification" hold could not be carried over.*The 1 hold\(s\) already carried onto it were released\./);
    const onTarget = T("document_holds").filter((h) => h.document_id === "t6");
    expect(onTarget).toHaveLength(1);
    expect(onTarget[0].released_at).toBeTruthy();
  });
  it("…and when that release is refused too, the error names the hold left open", async () => {
    seedDoc("h7"); seedHold("h7", "A"); seedHold("h7", "B");
    state.db.beforeInsert!.document_holds = (row) => { if (row.reason === "B") throw { message: "refused" }; return row; };
    state.db.beforeUpdate!.document_holds = () => { throw { message: "release refused" }; };
    await expect(copyActiveHoldsToDoc({ sourceDocId: "h7", targetDocId: "t7", originLabel: "x", actor: { orgId: ORG, actorUserId: ME } }))
      .rejects.toThrow(/carried-over hold\(s\) on a rolled-back document are still open/);
  });
  it("merge gates EVERY source (a held second source refuses the merge before the target is created)", async () => {
    const a = seedDoc("g1"); const b = seedDoc("g2"); seedHold("g2");
    await expect(mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "G-NEW", title: "merged", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/active hold/);
    expect(T("documents").some((d) => d.document_number === "G-NEW")).toBe(false);
  });
  it("merge records every source's prior status on the DOC_MERGED events and carries holds before superseding", async () => {
    state.roles = ["DocCtrl"];
    const a = seedDoc("g3"); const b = seedDoc("g4", { status: "Draft" }); seedHold("g4");
    const r = await mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "G-NEW2", title: "merged", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME, force: true,
    });
    expect(r.holdsCopied).toBe(1);
    for (const ev of audit("DOC_MERGED")) expect((ev.details as Record<string, unknown>).priorStatuses).toEqual({ g3: "Issued", g4: "Draft" });
  });
});

describe("REV-11 — creation status is a deliberate choice; issuing is a publish", () => {
  it("split in a library whose policy REQUIRES sign-off is refused before anything is created; an unreadable policy refuses too", async () => {
    const s = seedDoc("q1");
    state.reviewMode = "require";
    const t = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [t("Q1A"), t("Q1B")], reason: "x", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/requires reviewer sign-off/);
    state.reviewMode = "none"; state.reviewThrows = true;
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [t("Q1A"), t("Q1B")], reason: "x", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/Couldn't verify the review policy/);
    expect(T("documents")).toHaveLength(1);
  });
  it("a split in a publisher_choice library proceeds and RECORDS why its sheets were not routed through review", async () => {
    const s = seedDoc("q2");
    state.reviewMode = "publisher_choice";
    const t = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
    await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [t("Q2A"), t("Q2B")], reason: "x", orgId: ORG, actorUserId: ME });
    const created = audit("CREATED_FROM_SPLIT");
    expect(created).toHaveLength(2);
    expect(created[0].details).toMatchObject({ initialStatus: "Issued", reviewPolicy: expect.stringMatching(/^publisher_choice/) });
  });
  it("a split without publish authority (and not the owner) is refused by the gate", async () => {
    const s = seedDoc("q3");
    state.canControl = false; state.isOwner = false;
    const t = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [t("Q3A"), t("Q3B")], reason: "x", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/authority to publish/);
  });
  it("createDocumentWithFile: a Draft starts no compliance clock; an Issued document takes publish authority and a permissive policy", async () => {
    expect([...CREATION_STATUSES]).toEqual(["Draft", "Issued"]);
    const d = await createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "L-1", file: pdf("l.pdf"), status: "Draft", actorUserId: ME });
    expect(docRow(d.documentId).status).toBe("Draft");
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(onDocumentIssuedAck).not.toHaveBeenCalled();

    state.canControl = false;
    state.rpc.mockResolvedValue({ data: false, error: null }); // not the folder / library owner either
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "L-2", file: pdf("l.pdf"), status: "Issued", actorUserId: ME }))
      .rejects.toThrow(/authority to issue/);
    expect(T("documents").some((r) => r.document_number === "L-2")).toBe(false);
    expect(state.rpc).toHaveBeenCalledWith("user_is_effective_owner", { p_doc_owner: null, p_collection: null, p_library: LIB, p_uid: ME });
    // the library's effective owner may issue (the rung the publish guard reads)
    state.rpc.mockResolvedValue({ data: true, error: null });
    const owned = await createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "L-2B", file: pdf("l.pdf"), status: "Issued", actorUserId: ME });
    expect(docRow(owned.documentId).status).toBe("Issued");
    vi.mocked(onDocumentIssued).mockClear();

    state.canControl = true; state.reviewMode = "require";
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "L-3", file: pdf("l.pdf"), status: "Issued", actorUserId: ME }))
      .rejects.toThrow(/requires reviewer sign-off/);

    state.reviewMode = "none";
    const ok = await createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "L-4", file: pdf("l.pdf"), status: "Issued", actorUserId: ME });
    expect(docRow(ok.documentId)).toMatchObject({ status: "Issued", rev: "0", revision: "0" });
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
  });
  it("a refused first pointer write is an error, never a created document with no file", async () => {
    state.db.beforeUpdate!.documents = () => { throw { code: "23514", message: "You do not have authority to publish revisions in this library." }; };
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "L-5", file: pdf("l.pdf"), status: "Draft", actorUserId: ME }))
      .rejects.toThrow(/file could not be attached/);
  });
  it("a split / merge sheet whose first revision cannot be made current (a zero-row answer) is an error, never a created sheet with no file", async () => {
    state.db.beforeInsert!.document_versions = (row) => { state.db.refuseWrites.add("documents"); return row; };
    await expect(createNewDocWithFirstVersion({
      orgId: ORG, libraryId: LIB, documentNumber: "Z-1", title: "z", initialRevLabel: "0", changeLog: "", assetTags: [], file: pdf("z.pdf"),
      actor: { orgId: ORG, actorUserId: ME }, initialStatus: "Draft", creationAuditAction: "CREATED_FROM_SPLIT", creationDetails: {},
    })).rejects.toThrow(/Z-1 was created but its first revision could not be made current/);
    expect(audit("CREATED_FROM_SPLIT")).toHaveLength(0);
  });
  it("the link picker files a Draft unless the uploader chooses to issue; split / merge pass the status explicitly", () => {
    const p = src("components/documents/DocumentLinkPicker.tsx");
    expect(p).toMatch(/useState<CreationStatus>\("Draft"\)/);
    expect(p).toMatch(/status: fileAs,/);
    expect(src("lib/documentLifecycle/common.ts")).toMatch(/status: input\.initialStatus,/);
    expect(src("lib/documentLifecycle/common.ts")).not.toMatch(/status: "Issued",/);
    expect(src("lib/revisions.ts")).not.toMatch(/status: input\.status \?\? "Issued"/);
  });
});

// ─── REV-13 ───────────────────────────────────────────────────────────────
describe("REV-13 — a revert reconciles the document's effective date with the version now in force", () => {
  it("the withdrawn revision's future date is cleared and watermarked, so the scan can never announce it", async () => {
    const d = seedDoc("e1", { effective_date: "2026-12-01", effective_notified_at: null });
    T("document_versions").push({ id: "e1-v2", org_id: ORG, record_id: "e1", revision_label: "2", review_state: null, superseded_at: "x" });
    state.rpc.mockResolvedValue({ data: { status: "published", version: { id: "e1-v5", record_id: "e1", revision_label: "4" } }, error: null });
    T("document_versions").push({ id: "e1-v5", org_id: ORG, record_id: "e1", revision_label: "4" });
    await revertToVersion({ doc: asRecord(d), libraryId: LIB, orgId: ORG, actorUserId: ME, reason: "defective", targetVersion: { id: "e1-v2", revisionLabel: "2", fileUrl: "k", reviewState: null } as unknown as DocumentVersion });
    expect(docRow("e1").effective_date).toBeNull();
    expect(docRow("e1").effective_notified_at).toBeTruthy();
    expect(audit("REVERT")[0].details).toMatchObject({ effectiveDateReconcileError: null });
  });
});

// ─── HLD-1 call sites owned here ──────────────────────────────────────────
describe("HLD-1 — correctRevisionLabel and renumberDocument call the shared hold gate", () => {
  it("a held document's label is not corrected — refused before any write", async () => {
    const d = seedDoc("x1"); seedHold("x1");
    const e = await correctRevisionLabel({ doc: asRecord(d), versionId: "x1-v3", newLabel: "3A", libraryId: LIB, orgId: ORG, actorUserId: ME }).catch((err) => err);
    expect(isHoldBlockedError(e)).toBe(true);
    expect(T("document_versions").find((v) => v.id === "x1-v3")!.revision_label).toBe("3");
  });
  it("a held document is not renumbered", async () => {
    const d = seedDoc("x2"); seedHold("x2");
    const e = await renumberDocument({ doc: asRecord(d), newDocumentNumber: "X-2B", reason: "typo", orgId: ORG, actorUserId: ME }).catch((err) => err);
    expect(isHoldBlockedError(e)).toBe(true);
    expect(docRow("x2").document_number).toBe("X2");
  });
});

// ─── Review fix 2: the saga ────────────────────────────────────────────────
describe("REV-14 / REV-6 / HLD-2 — a split / merge that rolls back leaves NOTHING behind: the source is back, its review and links untouched", () => {
  const sheet = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
  const newDocs = (except: string[]) => T("documents").filter((d) => !except.includes(d.id as string));

  it("the reviewer's blocker: split, lineage write REFUSED → the source is back to its prior status (not Superseded), its replacements archived, no DOC_SPLIT, the review and share links untouched", async () => {
    const s = seedDoc("b1", { status: "Draft" }); seedDraft("b1"); seedShare("b1", "shb1");
    state.db.refuseWrites.add("document_supersessions");
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("B1A"), sheet("B1B")], reason: "declutter", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/replacement links could not be recorded[\s\S]*rolled back/);
    expect(docRow("b1")).toMatchObject({ status: "Draft", superseded_at: null, supersession_reason: null });
    expect(newDocs(["b1"]).every((d) => d.status === "Archived")).toBe(true);
    expect(audit("DOC_SPLIT")).toHaveLength(0);
    reviewUntouched("b1");
    expect(T("document_shares").find((x) => x.id === "shb1")!.revoked_at).toBeNull();
  });

  it("split, lineage INCOMPLETE (one pair silently dropped) → rolled back the same way, the pair it did write removed", async () => {
    state.roles = ["DocCtrl"]; // lineage DELETE is Document Control's at the database
    const s = seedDoc("b2"); seedDraft("b2");
    let n = 0;
    state.db.beforeInsert!.document_supersessions = (row) => (++n === 2 ? null : row);
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("B2A"), sheet("B2B")], reason: "x", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/1 of 2 replacement link\(s\) were not recorded[\s\S]*rolled back/);
    expect(docRow("b2").status).toBe("Issued");
    expect(T("document_supersessions")).toHaveLength(0);
    reviewUntouched("b2");
  });

  it("split whose SOURCE FLIP is refused → nothing to restore (the flip never landed), sheets archived, review untouched", async () => {
    const s = seedDoc("b3"); seedDraft("b3");
    state.db.beforeUpdate!.documents = (next, old) => {
      if (old.id === "b3" && next.status === "Superseded") throw { code: "23514", message: "guard said no" };
      return next;
    };
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("B3A"), sheet("B3B")], reason: "x", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/guard said no[\s\S]*rolled back — no partial changes were kept/);
    expect(docRow("b3").status).toBe("Issued");
    reviewUntouched("b3");
  });

  it("merge: the SECOND source's flip is refused → the first source is restored to the status it held, its review and links untouched, the target archived, no DOC_MERGED", async () => {
    const a = seedDoc("c1", { status: "Draft" }); seedDraft("c1"); seedShare("c1", "shc1");
    const b = seedDoc("c2");
    state.db.beforeUpdate!.documents = (next, old) => {
      if (old.id === "c2" && next.status === "Superseded") throw { code: "23514", message: "second refused" };
      return next;
    };
    await expect(mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "C-NEW", title: "m", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/second refused[\s\S]*rolled back/);
    expect(docRow("c1")).toMatchObject({ status: "Draft", superseded_at: null });
    expect(docRow("c2").status).toBe("Issued");
    expect(T("documents").find((d) => d.document_number === "C-NEW")!.status).toBe("Archived");
    expect(audit("DOC_MERGED")).toHaveLength(0);
    reviewUntouched("c1");
    expect(T("document_shares").find((x) => x.id === "shc1")!.revoked_at).toBeNull();
  });

  it("merge: the second source's LINEAGE is refused → BOTH sources restored (the failing one too — its restore was registered before its flip)", async () => {
    state.roles = ["DocCtrl"];
    const a = seedDoc("c3"); const b = seedDoc("c4"); seedDraft("c4");
    state.db.beforeInsert!.document_supersessions = (row) => {
      if (row.superseded_doc_id === "c4") throw { code: "42501", message: "lineage refused" };
      return row;
    };
    await expect(mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "C-NEW2", title: "m", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/lineage refused/);
    expect(docRow("c3").status).toBe("Issued");
    expect(docRow("c4").status).toBe("Issued");
    expect(T("document_supersessions")).toHaveLength(0);
    reviewUntouched("c4");
  });

  it("a compensation that could not put a source back is NAMED (never 'no partial changes were kept')", async () => {
    const s = seedDoc("b4");
    state.db.refuseWrites.add("document_supersessions");
    state.db.beforeUpdate!.documents = (next, old) => {
      if (old.id === "b4" && old.status === "Superseded" && next.status === "Issued") throw { code: "23514", message: "restore refused" };
      return next;
    };
    const e = (await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("B4A"), sheet("B4B")], reason: "x", orgId: ORG, actorUserId: ME }).catch((err) => err)) as Error;
    expect(e.message).toMatch(/some cleanup steps failed/);
    expect(e.message).toMatch(/restore source B4 from Superseded: source b4 is still Superseded — restore it to Issued \(restore refused\)/);
    expect(e.message).not.toMatch(/no partial changes were kept/);
  });
});

describe("Merge into an EXISTING target — the target is kept (never superseded), its rev-up runs LAST, and a failure before or in it publishes nothing", () => {
  const revUp = { file: pdf("merged.pdf"), revisionLabel: "4", changeLog: "merged content" };

  it("the wizard lists the target among the sources: it is KEPT — the others are superseded into it, it stays Issued with no self-link, and the DOC_MERGED records name only the absorbed sources", async () => {
    const t = seedDoc("t1"); const a = seedDoc("a1"); const b = seedDoc("b1x");
    state.rpc.mockImplementation(async () => {
      state.db.calls.push({ table: "rpc", method: "publish_revision", args: [] });
      return { data: { status: "published", version: { id: "t1-v4", record_id: "t1", revision_label: "4" } }, error: null };
    });
    const r = await mergeDocuments({
      sources: [asRecord(t), asRecord(a), asRecord(b)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    expect(docRow("t1").status).toBe("Issued");
    expect(docRow("a1").status).toBe("Superseded");
    expect(docRow("b1x").status).toBe("Superseded");
    expect(T("document_supersessions").some((l) => l.superseded_doc_id === "t1")).toBe(false);
    expect(r.supersededSourceIds.sort()).toEqual(["a1", "b1x"]);
    expect(audit("DOC_MERGED").map((e) => e.resource_id).sort()).toEqual(["a1", "b1x"]);
    for (const ev of audit("DOC_MERGED")) expect((ev.details as Record<string, unknown>).mergeSiblings).toEqual(["a1", "b1x"]);
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect((state.rpc.mock.calls[0][1] as Record<string, unknown>).p_doc).toBe("t1");
    // the rev-up ran LAST: after every source flip and lineage write
    const idx = (pred: (c: { table: string; method: string; args: unknown[] }) => boolean) => state.db.calls.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);
    const publishAt = idx((c) => c.table === "rpc")[0];
    const flips = idx((c) => c.table === "documents" && c.method === "update" && (c.args[0] as Row).status === "Superseded");
    const lineage = idx((c) => c.table === "document_supersessions" && c.method === "upsert");
    expect(Math.max(...flips, ...lineage)).toBeLessThan(publishAt);
  });

  it("the reviewer's case: a source's lineage is refused BEFORE the rev-up → nothing was published (the contract is never called), the sources are back", async () => {
    state.roles = ["DocCtrl"];
    const t = seedDoc("t2"); const a = seedDoc("a2");
    state.db.refuseWrites.add("document_supersessions");
    await expect(mergeDocuments({
      sources: [asRecord(t), asRecord(a)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/rolled back/);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(docRow("t2").current_version_id).toBe("t2-v3");
    expect(docRow("a2").status).toBe("Issued");
  });

  it("the rev-up itself is refused (last step) → the sources are restored and the carried holds released; nothing was published", async () => {
    state.roles = ["DocCtrl"];
    const t = seedDoc("t3"); const a = seedDoc("a3"); seedHold("a3");
    state.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "contract refused" } });
    await expect(mergeDocuments({
      sources: [asRecord(t), asRecord(a)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME, force: true,
    })).rejects.toThrow(/contract refused[\s\S]*rolled back/);
    expect(docRow("a3").status).toBe("Issued");
    expect(docRow("t3")).toMatchObject({ status: "Issued", current_version_id: "t3-v3" });
    expect(T("document_holds").filter((h) => h.document_id === "t3").every((h) => h.released_at)).toBe(true);
    expect(audit("DOC_MERGED")).toHaveLength(0);
  });

  it("holds carried by a controller's forced merge do not block the target's rev-up (the force rides along only then); without carried holds it is never forced", async () => {
    state.roles = ["DocCtrl"];
    const t = seedDoc("t4"); const a = seedDoc("a4"); seedHold("a4");
    state.rpc.mockResolvedValue({ data: { status: "published", version: { id: "t4-v4", record_id: "t4", revision_label: "4" } }, error: null });
    await mergeDocuments({
      sources: [asRecord(t), asRecord(a)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME, force: true,
    });
    expect((state.rpc.mock.calls[0][1] as Record<string, unknown>).p_force).toBe(true);
    expect(docRow("a4").status).toBe("Superseded");

    state.rpc.mockClear();
    const t5 = seedDoc("t5"); const a5 = seedDoc("a5");
    state.rpc.mockResolvedValue({ data: { status: "published", version: { id: "t5-v4", record_id: "t5", revision_label: "4" } }, error: null });
    await mergeDocuments({
      sources: [asRecord(t5), asRecord(a5)],
      target: { kind: "extend_existing", target: asRecord(t5), libraryId: LIB, revUp, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME, force: true,
    });
    expect((state.rpc.mock.calls[0][1] as Record<string, unknown>).p_force).toBe(false);
  });

  it("the target's own gate is asked BEFORE anything is written: a held target refuses the rev-up merge with nothing changed", async () => {
    state.roles = ["DocCtrl"];
    const t = seedDoc("t6"); const a = seedDoc("a6"); seedHold("t6");
    await expect(mergeDocuments({
      sources: [asRecord(t), asRecord(a)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME, force: true,
    })).rejects.toThrow(/active hold/);
    expect(docRow("a6").status).toBe("Issued");
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("REV-6 — supersede voids the review only once the supersession has landed", () => {
  it("a refused lineage write puts the document back AND leaves its review and share links untouched", async () => {
    const d = seedDoc("sv1"); seedDoc("sv1a"); seedDraft("sv1"); seedShare("sv1", "shs1");
    state.db.refuseWrites.add("document_supersessions");
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["SV1A"], libraryId: LIB, reason: "r", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/^Nothing was superseded: .*back to Issued\. Fix the cause and supersede it again\.$/);
    expect(docRow("sv1").status).toBe("Issued");
    reviewUntouched("sv1");
    expect(T("document_shares").find((x) => x.id === "shs1")!.revoked_at).toBeNull();
  });
  it("a refused status write voids nothing", async () => {
    const d = seedDoc("sv2"); seedDraft("sv2");
    state.db.beforeUpdate!.documents = (next, old) => {
      if (old.id === "sv2" && next.status === "Superseded") throw { code: "23514", message: "no" };
      return next;
    };
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: [], libraryId: LIB, reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/no/);
    reviewUntouched("sv2");
  });
  it("a void refused after the supersession landed is on the SUPERSEDE_DOC record, and the draft still cannot publish", async () => {
    const d = seedDoc("sv3"); seedDraft("sv3");
    state.db.refuseWrites.add("document_review_signoffs");
    await supersedeDocument({ doc: asRecord(d), replacementDocNumbers: [], libraryId: LIB, reason: "r", orgId: ORG, actorUserId: ME });
    expect(audit("SUPERSEDE_DOC")[0].details).toMatchObject({ pendingDraftVoided: null, pendingDraftVoidProblem: expect.stringMatching(/voided/) });
    const fin = await finalizeReviewedRevision({ orgId: ORG, documentId: "sv3", actorId: "r2" });
    expect(fin.published).toBe(false);
  });
});

describe("REV-11 (review fix 2) — a controller may issue in a require-mode library, recorded; authority on every first revision and every target library", () => {
  const sheet = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
  it("split in a require-mode library: refused for a publisher who is not a controller; Doc Control proceeds and every sheet records the decision and who made it", async () => {
    state.reviewMode = "require";
    const s = seedDoc("rq1");
    await expect(splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("RQ1A"), sheet("RQ1B")], reason: "x", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/requires reviewer sign-off[\s\S]*ask Document Control/);
    state.roles = ["Manager", "DocCtrl"];
    await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("RQ1A"), sheet("RQ1B")], reason: "x", orgId: ORG, actorUserId: ME });
    const created = audit("CREATED_FROM_SPLIT");
    expect(created).toHaveLength(2);
    for (const c of created) expect((c.details as Record<string, unknown>).reviewPolicy).toBe(`require — issued WITHOUT the sign-off the policy requires, by controller ${ME} (Doc Control / Admin decision; a first issue is outside the database's revision gate, RG-7)`);
  });
  it("createDocumentWithFile: an Admin issues in a require-mode library and gets the recorded decision back", async () => {
    state.reviewMode = "require"; state.roles = ["Admin"];
    const r = await createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "RQ-2", file: pdf("l.pdf"), status: "Issued", actorUserId: ME });
    expect(r.reviewPolicy).toMatch(/^require — issued WITHOUT the sign-off the policy requires, by controller u1/);
  });
  it("a DRAFT creation is checked for the first-pointer authority too: refused before any insert, never a document row with no file", async () => {
    state.canControl = false;
    state.rpc.mockResolvedValue({ data: false, error: null });
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "DR-1", file: pdf("l.pdf"), status: "Draft", actorUserId: ME }))
      .rejects.toThrow(/don't have authority to add documents to this library[\s\S]*Nothing was created/);
    expect(T("documents")).toHaveLength(0);
    expect(T("document_versions")).toHaveLength(0);
    // the folder / library owner may file one
    state.rpc.mockResolvedValue({ data: true, error: null });
    const ok = await createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "DR-2", file: pdf("l.pdf"), status: "Draft", actorUserId: ME });
    expect(docRow(ok.documentId).status).toBe("Draft");
  });
  it("a create_new merge into ANOTHER library takes authority there (the new document is born owned by the actor, so the database would admit it); within the sources' library the sources' gate stands", async () => {
    state.canControl = false; state.isOwner = true; // owner of the sources, no library authority
    state.rpc.mockResolvedValue({ data: false, error: null });
    const a = seedDoc("x1"); const b = seedDoc("x2");
    await expect(mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "X-NEW", title: "m", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: "lib2" },
      reason: "combine", orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/authority to issue documents in the library X-NEW would be created in/);
    expect(T("documents").some((d) => d.document_number === "X-NEW")).toBe(false);
    expect(state.rpc).toHaveBeenCalledWith("user_is_effective_owner", { p_doc_owner: null, p_collection: null, p_library: "lib2", p_uid: ME });
    await mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "X-SAME", title: "m", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    expect(docRow("x1").status).toBe("Superseded");
  });
  it("split sheets landing in another library than the source's take authority there too", async () => {
    state.canControl = false; state.isOwner = true;
    state.rpc.mockResolvedValue({ data: false, error: null });
    const s = seedDoc("x3");
    await expect(splitDocument({ source: asRecord(s), libraryId: "lib2", targets: [sheet("X3A"), sheet("X3B")], reason: "x", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/library the split sheets would land in/);
    expect(T("documents")).toHaveLength(1);
  });
});

describe("DCK-8 (review fix 2) — the 5-character override minimum binds publish_revision callers only", () => {
  it("a split over a foreign checkout with a short reason passes the gate (the reason is the message the holder is shown); a blank one is refused in the operation's own words", async () => {
    const s = seedDoc("o1", { checked_out_by: "someone", checked_out_by_name: "Sam" });
    await expect(authorizePublish({ documentId: "o1", libraryId: LIB, orgId: ORG, actorUserId: ME, overrideReason: "dup", operation: "split" })).resolves.toBeTruthy();
    await expect(authorizePublish({ documentId: "o1", libraryId: LIB, orgId: ORG, actorUserId: ME, overrideReason: " ", operation: "merge" }))
      .rejects.toThrow("A reason is required to merge a document another user has checked out.");
    await expect(authorizePublish({ documentId: "o1", libraryId: LIB, orgId: ORG, actorUserId: ME, overrideReason: "dup" }))
      .rejects.toThrow(new RegExp(`at least ${OVERRIDE_REASON_MIN} characters`));
    const t = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
    await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [t("O1A"), t("O1B")], reason: "dup", orgId: ORG, actorUserId: ME });
    expect(docRow("o1").status).toBe("Superseded");
  });
});

describe("Unconfirmed read-backs never read as clean", () => {
  it("voidPendingDraft: a refused pointer release whose re-read FAILS throws (it used to report the draft voided)", async () => {
    seedDoc("rb1"); seedDraft("rb1");
    state.db.refuseWrites.add("documents"); // the pointer release answers zero rows
    failNthRead("documents", 2); // 1 = the initial pointer read, 2 = the confirmation re-read
    await expect(voidPendingDraft("rb1")).rejects.toBeInstanceOf(PendingDraftVoidError);
    state.failRead = null;
    await expect(voidPendingDraft("rb1")).rejects.toThrow(/still points at it \(the write was refused\)/);
  });
  it("restoreSupersededSource: a lineage removal whose read-back fails is UNCONFIRMED, never a clean rollback", async () => {
    seedDoc("rb2", { status: "Superseded" });
    T("document_supersessions").push({ id: "lrb2", superseded_doc_id: "rb2", replacement_doc_id: "rb2a" });
    state.db.refuseWrites.add("document_supersessions"); // the DELETE answers with no error and removes nothing
    failNthRead("document_supersessions", 1);
    await expect(restoreSupersededSource("rb2", "Issued", ["rb2a"], ACTOR)).rejects.toThrow(/could not be confirmed \(document_supersessions read failed\)/);
  });
  it("a reversal's lineage removal whose read-back fails throws with the rows possibly left", async () => {
    state.roles = ["DocCtrl"];
    seedDoc("rb3", { status: "Superseded" }); seedDoc("rb3a");
    T("document_supersessions").push({ id: "lrb3", superseded_doc_id: "rb3", replacement_doc_id: "rb3a" });
    (state.db.tables.audit_logs ??= []).push({ id: "evrb", action: "DOC_SPLIT", resource_id: "rb3", timestamp: "t", details: { replacementDocIds: ["rb3a"], priorStatus: "Issued", auditAt: "t" } });
    state.db.refuseWrites.add("document_supersessions");
    failNthRead("document_supersessions", 1);
    await expect(reverseSplit({ splitAuditEventId: "evrb", reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/could not be confirmed[\s\S]*some may remain/);
  });
});

describe("reverseRenumber takes renumberDocument's gate (OWN-19 authority, HLD-1 hold) and checks its write", () => {
  const seedRenumber = (id: string) => {
    seedDoc(id, { document_number: `${id.toUpperCase()}-NEW` });
    (state.db.tables.audit_logs ??= []).push({ id: `ev-${id}`, action: "DOC_RENUMBERED", resource_id: id, timestamp: "t", details: { previousDocumentNumber: `${id.toUpperCase()}-OLD`, newDocumentNumber: `${id.toUpperCase()}-NEW` } });
  };
  it("a held document's renumber is not reversed — refused before any write", async () => {
    seedRenumber("rn1"); seedHold("rn1");
    const e = await reverseRenumber({ renumberAuditEventId: "ev-rn1", reason: "r", orgId: ORG, actorUserId: ME }).catch((err) => err);
    expect(isHoldBlockedError(e)).toBe(true);
    expect(docRow("rn1").document_number).toBe("RN1-NEW");
    expect(audit("DOC_RENUMBER_REVERSED")).toHaveLength(0);
  });
  it("without authority (and not the owner) it is refused", async () => {
    seedRenumber("rn2");
    state.canControl = false; state.isOwner = false;
    await expect(reverseRenumber({ renumberAuditEventId: "ev-rn2", reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/authority to renumber/);
    expect(docRow("rn2").document_number).toBe("RN2-NEW");
  });
  it("a zero-row answer is a refusal, never DOC_RENUMBER_REVERSED", async () => {
    seedRenumber("rn3");
    state.db.refuseWrites.add("documents");
    await expect(reverseRenumber({ renumberAuditEventId: "ev-rn3", reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/the write was refused/);
    expect(audit("DOC_RENUMBER_REVERSED")).toHaveLength(0);
  });
  it("with authority and no hold it reverses", async () => {
    seedRenumber("rn4");
    await reverseRenumber({ renumberAuditEventId: "ev-rn4", reason: "r", orgId: ORG, actorUserId: ME });
    expect(docRow("rn4").document_number).toBe("RN4-OLD");
    expect(audit("DOC_RENUMBER_REVERSED")).toHaveLength(1);
  });
});

describe("REV-16 — a legacy split / merge is reversible from the dialog with an explicitly named status", () => {
  it("reversalNeedsLegacyStatus: true only where the event recorded no prior status", () => {
    expect(reversalNeedsLegacyStatus("DOC_SPLIT", { replacementDocIds: ["a"] })).toBe(true);
    expect(reversalNeedsLegacyStatus("DOC_SPLIT", { priorStatus: "Issued" })).toBe(false);
    expect(reversalNeedsLegacyStatus("DOC_MERGED", { mergeSiblings: ["a", "b"] })).toBe(true);
    expect(reversalNeedsLegacyStatus("DOC_MERGED", { mergeSiblings: ["a", "b"], priorStatuses: { a: "Issued" } })).toBe(true);
    expect(reversalNeedsLegacyStatus("DOC_MERGED", { mergeSiblings: ["a", "b"], priorStatuses: { a: "Issued", b: "Void" } })).toBe(false);
    expect(reversalNeedsLegacyStatus("DOC_MERGED", { priorStatus: "Issued" })).toBe(false);
    expect(reversalNeedsLegacyStatus("DOC_RENUMBERED", {})).toBe(false);
    expect(reversalNeedsLegacyStatus("DOC_SPLIT", null)).toBe(true);
  });
  it("the dialog shows the validated picker (nothing pre-selected), requires a choice, and passes it as legacyRestoreStatus; it no longer promises 'Issued'", () => {
    const m = src("components/documents/lifecycle/ReverseConfirmModal.tsx");
    expect(m).toMatch(/const needsLegacyStatus = reversalNeedsLegacyStatus\(event\.action, event\.details \?\? null\);/);
    expect(m).toMatch(/const valid = reason\.trim\(\)\.length > 0 && \(!needsLegacyStatus \|\| legacyStatus !== ""\);/);
    expect(m).toMatch(/LEGACY_RESTORE_STATUSES\.map\(/);
    expect(m).toMatch(/<option value="">Choose the status it held before the/);
    expect((m.match(/actorRole, legacyRestoreStatus,/g) ?? []).length).toBe(2);
    expect(m).not.toMatch(/will return to "Issued" status/);
  });
  it("the reverse affordance is offered only to the population the reversal admits (Admin / DocCtrl)", () => {
    const h = src("components/documents/HistoryDrawer.tsx");
    expect(h).toMatch(/const isReverseAuthorized = hasAnyRole\(\["Admin", "DocCtrl"\]\);/);
    expect(h).toMatch(/onReverseRequest=\{isReverseAuthorized \? /);
  });
});
