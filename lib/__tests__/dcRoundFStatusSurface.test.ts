// document-control Round F wave 3 — P25 STATUS-SURFACE FOLLOW-UPS: the app
// half of REV-26, REV-27, REV-28 (option (a)) and REV-29, driven end to end
// against the in-memory PostgREST (helpers/fakeSupabase) with the real
// lib/revisions.ts, lib/documentLifecycle (merge, setRevUp, common, reverse).
//
//   REV-26  a move INTO Issued / Locked out of an issue status no gate reads
//           as in force (an existing IFC row; NULL; a variant) is an issue
//           and is recorded as one (isEntryIntoForce): DOCUMENT_ISSUED with
//           entryIntoForce, putBack false, the acknowledgment roster opened,
//           the review clock NOT reset. Driven for the status editors in
//           dcRoundFStatusIssueRecord / dcRoundFBulkStatusIssue /
//           dcRoundFStatusIntoForce; the predicate and the un-archive here.
//   REV-27  putBackFromRetirementStamp answers the guard's v_restoring FOR
//           THE TARGET; unarchiveRestoreDefault reads a stamp outside the
//           in-force pair as `not-in-force`; unarchiveDocument admits the
//           archive's own stamped status (and nothing else beside the three).
//   REV-28  (a) a rev-up of a document in such a status is a first issue —
//           firstIssueGateForRevUp, its refusal, setLevelRevUp's and the
//           merge's routing — the same rule as 20261193's block (parity
//           pinned over every status the editors / import produce); every
//           rev-up of a document in force answers exactly as before.
//   REV-29  a NULL prior status is put back as NULL — through the rollback
//           doors (20261192), with today's path on an older body
//           (olderBodyStatus) and the direct write when the function is
//           absent — and a reversal restores a recorded NULL as NULL.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

type RpcAnswer = { data: unknown; error: { code?: string; message: string } | null };
const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  publish: vi.fn(),
  roles: ["Engineer"] as string[],
  reviewMode: "none" as string,
  canControl: false,
  /** How the database answers put_back_retired_issue / restore_reversed_source:
   *  "192" — 20261192's bodies (a rollback / an event-naming reversal takes a NULL);
   *  "old" — 20261165's / 20261164's (a blank status refused before any write);
   *  "absent" — no function (PGRST202). */
  doors: "192" as "192" | "old" | "absent",
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

const PB_BLANK = "put_back_retired_issue: name the status to put the document back to.";
const RR_BLANK = "restore_reversed_source: name the status to restore the document to.";

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    const writeDoc = async (id: string, payload: Row): Promise<RpcAnswer> => {
      const docs = base.from("documents") as unknown as { update: (p: Row) => { eq: (k: string, v: unknown) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> } } };
      const r = await docs.update(payload).eq("id", id).select("id");
      if (r.error) return { data: null, error: r.error as { code?: string; message: string } };
      return { data: ((r.data as unknown[] | null) ?? []).length === 0 ? "no_match" : "restored", error: null };
    };
    return {
      ...base,
      rpc: async (fn: string, args: Record<string, unknown>): Promise<RpcAnswer> => {
        state.rpcCalls.push({ fn, args });
        if (fn === "publish_revision") return state.publish(args);
        if (fn !== "put_back_retired_issue" && fn !== "restore_reversed_source") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
        if (state.doors === "absent") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
        const blank = !String(args.p_status ?? "").trim();
        if (fn === "put_back_retired_issue") {
          if (blank && (state.doors === "old" || args.p_via === "unarchive")) return { data: null, error: { code: "23514", message: PB_BLANK } };
          return writeDoc(String(args.p_document_id), args.p_via === "unarchive"
            ? { status: args.p_status, archived_at: null, archived_by: null, archive_reason: null }
            : { status: args.p_status, superseded_at: args.p_superseded_at ?? null, superseded_by_user: args.p_superseded_by_user ?? null, supersession_reason: args.p_supersession_reason ?? null, supersession_moc: args.p_supersession_moc ?? null });
        }
        if (blank && (state.doors === "old" || args.p_reversal_of == null)) return { data: null, error: { code: "23514", message: RR_BLANK } };
        return writeDoc(String(args.p_document_id), { status: args.p_status, superseded_at: null, superseded_by_user: null, supersession_reason: null, supersession_moc: null });
      },
    };
  },
}));
vi.mock("@/lib/storage", () => ({
  uploadToPath: vi.fn(async (_f: File, path: string) => ({ url: `r2://${path}`, size: 3 })),
  makeLibraryStoragePath: (o: { filename: string }) => `org/lib/${o.filename}`,
  uniqueUploadName: (name: string) => `u_${name}`,
}));
vi.mock("@/lib/principal", () => ({
  resolveActorPrincipal: vi.fn(async (i: { uid: string; orgId?: string }) => ({ uid: i.uid, orgId: i.orgId, role: state.roles[0], roles: state.roles })),
}));
vi.mock("@/lib/documentGuards", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/documentGuards")>();
  return { ...real, resolveCanControlLibrary: vi.fn(async () => state.canControl) };
});
vi.mock("@/lib/ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ownership")>();
  return { ...real, isEffectiveOwnerOfDocument: vi.fn(async () => true) };
});
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: state.reviewMode })) };
});
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));

import {
  revUpDocument, firstIssueGateForRevUp, describeFirstIssue, isEntryIntoForce, putBackFromRetirementStamp,
  unarchiveDocument, unarchiveRestoreDefault, unarchiveStampedRestoreStatus, putBackRetiredIssue, describePutBackStatus,
  supersedeDocument, PUT_BACK_BLANK_STATUS_REFUSAL,
} from "@/lib/revisions";
import { isControlledIssueStatus, isRetiredStatus } from "@/lib/issueStatus";
import { isUnguardedEntryIntoForce, BULK_EDIT_STATUS_OPTIONS, METADATA_EDITOR_STATUS_OPTIONS, IMPORT_STATUSES, RETIRED_STATUS_OPTIONS } from "@/lib/documentStatusOptions";
import { IN_FORCE_STATUSES } from "@/lib/verifyVerdict";
import { effectiveReviewControlForDocument } from "@/lib/reviewControl";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { mergeDocuments } from "@/lib/documentLifecycle/merge";
import { setLevelRevUp } from "@/lib/documentLifecycle/setRevUp";
import { markSupersededAndLink, withCompensation, restoreSupersededSource } from "@/lib/documentLifecycle/common";
import { reverseSplit, reverseMerge, reversalNeedsLegacyStatus, recordsPriorStatus, RESTORE_BLANK_STATUS_REFUSAL } from "@/lib/documentLifecycle/reverse";
import { uploadToPath } from "@/lib/storage";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const pdf = (n: string) => new File([new Uint8Array([1, 2, 3])], n, { type: "application/pdf" });
const issuedRecords = () => T("audit_logs").filter((a) => a.action === "DOCUMENT_ISSUED");

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: LIB, document_number: id.toUpperCase(), title: id, rev: "0", revision: "0",
    status: "IFC", current_version_id: `${id}-v0`, pending_version_id: null, checked_out_by: null, owner_user_id: ME,
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`,
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
const published = () => state.publish.mockResolvedValue({ data: { status: "published", version: { id: "new-v", record_id: "x", revision_label: "1" } }, error: null });
const actor = { orgId: ORG, actorUserId: ME };

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.publish.mockReset();
  state.roles = ["Engineer"];
  state.reviewMode = "none";
  state.canControl = false;
  state.doors = "192";
  state.rpcCalls = [];
});

/** Every status the editors offer or show, the import can write, and the variants the gates compare exactly. */
const UNIVERSE: Array<string | null> = [...new Set<string | null>([
  ...BULK_EDIT_STATUS_OPTIONS, ...METADATA_EDITOR_STATUS_OPTIONS, ...IMPORT_STATUSES, ...RETIRED_STATUS_OPTIONS,
  "In Review", "IFC", "ifc", "issued", "ISSUED", "locked", " Issued", "Issued ", "Approved for Construction", "IFA", "", "   ", null,
])];

// ─── REV-28 (a): a rev-up of a document no gate reads as in force is a first issue ───
describe("REV-28 (a) — firstIssueGateForRevUp: a document in an issue status no gate reads as in force is a FIRST issue; one in force is not", () => {
  const M193 = readFileSync(join(process.cwd(), "supabase/migrations/20261193_dc_roundF_ifc_rev_up_first_issue.sql"), "utf8");
  const BLOCK = M193.slice(M193.indexOf("      IF OLD.current_version_id IS NOT NULL AND v_intake_link IS NULL\n         AND COALESCE(is_controlled_issue_status(OLD.status)"), M193.indexOf("      -- SEC-13 (projects Round G): an EXTERNAL submission"));
  /** 20261193's block, transcribed (its in-force pair read from the SQL): does it refuse the pointer move? */
  const pair = (() => {
    const lists = [...BLOCK.matchAll(/IN \(([^)]*)\)/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
    expect(lists).toHaveLength(2);
    expect(lists[0]).toEqual(lists[1]);
    return new Set(lists[0]);
  })();
  const sqlBlockRefuses = (old: { current: string | null; status: string | null }, nextStatus: string | null, ctx: { controller: boolean; require: boolean; intake?: boolean }) =>
    old.current !== null && !ctx.intake
    && (isControlledIssueStatus(old.status) && !pair.has(old.status ?? "") && nextStatus !== null && pair.has(nextStatus))
    && !ctx.controller && ctx.require;

  it("the block's in-force pair is lib/verifyVerdict.ts IN_FORCE_STATUSES, and its sentence is the require limb's (ISSUE_REFUSAL.unreviewed)", async () => {
    expect([...pair]).toEqual([...IN_FORCE_STATUSES]);
    const { ISSUE_REFUSAL } = await import("@/lib/issueStatus");
    expect(BLOCK).toContain(ISSUE_REFUSAL.unreviewed.replace(/'/g, "''"));
    expect(BLOCK).toContain("'This library requires reviewer sign-off, so a revision that was not reviewed can''t be made a controlled issue; submit it for review, or ask Document Control.'");
  });

  it("PARITY over every status with a current revision: the app's gate (a non-controller, under require) says a rev-up must be reviewed EXACTLY when 20261193's block refuses its 'Issued' write — for the retired ones, the app refuses up front (no first issue), and the guard's other rules decide", async () => {
    state.reviewMode = "require";
    for (const status of UNIVERSE) {
      const g = await firstIssueGateForRevUp({ doc: { id: "x", collectionId: null, currentVersionId: "v", status, reviewControl: null } as never, libraryId: LIB, actor, live: { current: "v", status } });
      if (g.retired) { expect(isRetiredStatus(status), String(status)).toBe(true); continue; }
      const sql = sqlBlockRefuses({ current: "v", status }, "Issued", { controller: false, require: true });
      // a status the database does not count as an issue (Draft / In Review) is REV-17 / 20261144's first issue already
      if (!isControlledIssueStatus(status)) { expect(g.firstIssue, String(status)).toBe(true); expect(sql).toBe(false); continue; }
      expect(g.mustReview, JSON.stringify(status)).toBe(sql);
      expect(g.firstIssue, JSON.stringify(status)).toBe(!IN_FORCE_STATUSES.has(status ?? ""));
    }
  });

  it("the block binds only what the decision names: Document Control, a policy that does not require sign-off, an external submission, a pointerless row (REV-17's), and a write that stays out of force pass", () => {
    const ifc = { current: "v", status: "IFC" };
    expect(sqlBlockRefuses(ifc, "Issued", { controller: false, require: true })).toBe(true);
    expect(sqlBlockRefuses(ifc, "Locked", { controller: false, require: true })).toBe(true);
    expect(sqlBlockRefuses({ current: "v", status: null }, "Issued", { controller: false, require: true })).toBe(true);
    expect(sqlBlockRefuses(ifc, "Issued", { controller: true, require: true })).toBe(false);
    expect(sqlBlockRefuses(ifc, "Issued", { controller: false, require: false })).toBe(false);
    expect(sqlBlockRefuses(ifc, "Issued", { controller: false, require: true, intake: true })).toBe(false);
    expect(sqlBlockRefuses({ current: null, status: "IFC" }, "Issued", { controller: false, require: true })).toBe(false);
    expect(sqlBlockRefuses(ifc, "IFC", { controller: false, require: true })).toBe(false);
    expect(sqlBlockRefuses(ifc, " Issued", { controller: false, require: true })).toBe(false);
    for (const s of ["Issued", "Locked"]) expect(sqlBlockRefuses({ current: "v", status: s }, "Issued", { controller: false, require: true }), s).toBe(false);
  });

  it("the gate reads the LIVE row: IFC, NULL, a variant and a library's own status are first issues (the policy read); Issued and Locked are not (no policy read) — REGRESSION", async () => {
    state.reviewMode = "require";
    for (const status of ["IFC", null, "issued", " Issued", "Approved for Construction"]) {
      vi.mocked(effectiveReviewControlForDocument).mockClear();
      seedDoc(`g-${String(status)}`, { status });
      const g = await firstIssueGateForRevUp({ doc: asRecord(docRow(`g-${String(status)}`)), libraryId: LIB, actor });
      expect(g, String(status)).toMatchObject({ firstIssue: true, requiresSignOff: true, mustReview: true, hasCurrentRevision: true, status });
      expect(effectiveReviewControlForDocument).toHaveBeenCalled();
    }
    for (const status of ["Issued", "Locked"]) {
      vi.mocked(effectiveReviewControlForDocument).mockClear();
      seedDoc(`g-${status}`, { status });
      expect(await firstIssueGateForRevUp({ doc: asRecord(docRow(`g-${status}`)), libraryId: LIB, actor }), status).toMatchObject({ firstIssue: false, mustReview: false });
      expect(effectiveReviewControlForDocument).not.toHaveBeenCalled();
    }
    state.roles = ["Manager", "DocCtrl"];
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("g-IFC")), libraryId: LIB, actor })).toMatchObject({ firstIssue: true, requiresSignOff: true, mustReview: false });
    state.roles = ["Engineer"];
    state.reviewMode = "none";
    expect(await firstIssueGateForRevUp({ doc: asRecord(docRow("g-IFC")), libraryId: LIB, actor })).toMatchObject({ firstIssue: true, requiresSignOff: false, mustReview: false });
  });

  it("describeFirstIssue names it as what it is — never \"not issued yet\"", () => {
    expect(describeFirstIssue("P-1", { hasCurrentRevision: true, status: "IFC" }, "B")).toBe('P-1 is "IFC" — not a status any gate reads as in force — so publishing Rev B puts it in force for the first time');
    expect(describeFirstIssue("P-1", { hasCurrentRevision: true, status: null }, "B")).toBe("P-1 is in no status — not a status any gate reads as in force — so publishing Rev B puts it in force for the first time");
    // unchanged for a Draft and a pointerless row
    expect(describeFirstIssue("P-1", { hasCurrentRevision: true, status: "Draft" }, "B")).toBe("P-1 is not issued yet (Draft), so publishing Rev B makes it a controlled issue for the first time");
    expect(describeFirstIssue("P-1", { hasCurrentRevision: false, status: "Issued" }, "B")).toBe("P-1 has no current revision, so Rev B would be its first controlled issue");
  });
});

describe("REV-28 (a) — every rev-up door routes the IFC document's rev-up as a first issue before anything is written", () => {
  it("revUpDocument: a non-controller's Minor (and Correction) rev-up of an IFC document in a require library is refused up front — nothing uploaded, nothing published", async () => {
    state.reviewMode = "require";
    const d = seedDoc("if1");
    published();
    for (const ct of ["Minor", "Correction"]) {
      await expect(revUp(d, ct)).rejects.toThrow(/^This library requires reviewer sign-off, and IF1 is "IFC" — not a status any gate reads as in force — so publishing Rev 1 puts it in force for the first time — a first issue is not a revision through the review gate, so a Minor or Correction change doesn't exempt it\. Nothing was uploaded\./);
    }
    expect(uploadToPath).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
    expect(docRow("if1").status).toBe("IFC");
  });

  it("revUpDocument: Document Control's rev-up of it proceeds — recorded on REV_UP as a first issue made without the required sign-off (DEC-63 §2) — and so does anyone's in a library that does not require sign-off (nothing recorded)", async () => {
    const revUpEvent = () => T("audit_logs").filter((r) => r.action === "REV_UP").pop()?.details as Record<string, unknown> | undefined;
    published();
    state.reviewMode = "require";
    state.roles = ["Manager", "DocCtrl"];
    await expect(revUp(seedDoc("if2"))).resolves.toBeTruthy();
    expect(revUpEvent()).toMatchObject({ firstIssueWithoutSignOff: true, reviewPolicy: "require — Rev 1 is IF2's FIRST controlled issue, published WITHOUT the sign-off the policy requires, by controller u1 (DEC-63 §2)" });
    state.roles = ["Engineer"];
    state.reviewMode = "none";
    await expect(revUp(seedDoc("if3"))).resolves.toBeTruthy();
    expect(revUpEvent()?.firstIssueWithoutSignOff).toBeUndefined();
    expect(state.publish).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION — an Issued or Locked document's Minor rev-up in a require library is an ordinary revision through the gate (RG-7's hatch): published, no policy read", async () => {
    state.reviewMode = "require";
    published();
    for (const status of ["Issued", "Locked"]) await expect(revUp(seedDoc(`in-${status}`, { status }), "Minor"), status).resolves.toBeTruthy();
    expect(state.publish).toHaveBeenCalledTimes(2);
    expect(effectiveReviewControlForDocument).not.toHaveBeenCalled();
  });

  it("setLevelRevUp: a Minor set bump in a require library publishes the Issued sheet and sends the IFC sheet to REVIEW (never a direct publish the database would refuse)", async () => {
    state.reviewMode = "require";
    state.canControl = true;
    published();
    const issued = seedDoc("st1", { status: "Issued" });
    const ifc = seedDoc("st2", { status: "IFC" });
    const r = await setLevelRevUp({
      setId: "set1", sheets: [issued, ifc].map((d) => ({ doc: asRecord(d), file: pdf(`${d.id}.pdf`), revisionLabel: "1" })), libraryId: LIB,
      sharedChangeLog: "bump", changeType: "Minor" as never, orgId: ORG, actorUserId: ME,
    });
    expect(r).toMatchObject({ succeeded: 1, sentForReview: 1, failed: [] });
    expect((state.publish.mock.calls[0][0] as Record<string, unknown>).p_doc).toBe("st1");
    expect(docRow("st2").status).toBe("IFC");
    expect(T("document_versions").find((v) => v.id === docRow("st2").pending_version_id)).toMatchObject({ review_state: "in_review" });
  });

  it("mergeDocuments into an IFC target with a Minor rev-up in a require library: refused in its gate — no source superseded, nothing published", async () => {
    state.reviewMode = "require";
    state.canControl = true;
    published();
    const t = seedDoc("mt1", { status: "IFC" });
    const a = seedDoc("ms1", { status: "Issued" });
    await expect(mergeDocuments({
      sources: [asRecord(t), asRecord(a)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, revUp: { file: pdf("m.pdf"), revisionLabel: "1", changeLog: "merged", changeType: "Minor" as never }, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME,
    })).rejects.toThrow(/MT1 requires reviewer sign-off for this revision — a merge can't publish it unreviewed \(MT1 is "IFC" — not a status any gate reads as in force — so publishing Rev 1 puts it in force for the first time; a Minor or Correction change doesn't exempt a first issue\)\. Nothing was merged\./);
    expect(docRow("ms1").status).toBe("Issued");
    expect(state.publish).not.toHaveBeenCalled();
  });
});

// ─── REV-26 / REV-27: the predicate, the put-back's target, the un-archive ───
describe("REV-26 / REV-27 — isEntryIntoForce and putBackFromRetirementStamp answer for the write's target", () => {
  const row = (status: string | null, stamp: string | null = null, stampedVersion: string | null = null, current: string | null = "v1") =>
    ({ status, currentVersionId: current, retiredIssueStatus: stamp, retiredIssueVersionId: stampedVersion });

  it("isEntryIntoForce: a move INTO Issued / Locked out of a status no gate reads as in force — directly (isUnguardedEntryIntoForce) or out of a retirement stamped with it, its revision current", () => {
    expect(isEntryIntoForce(row("IFC"), "Issued")).toBe(true);
    expect(isEntryIntoForce(row(null), "Locked")).toBe(true);
    expect(isEntryIntoForce(row("issued"), "Issued")).toBe(true);
    expect(isEntryIntoForce(row("Archived", "IFC", "v1"), "Issued")).toBe(true);
    expect(isEntryIntoForce(row("Void", null, "v1"), "Locked")).toBe(true);
    // not one
    expect(isEntryIntoForce(row("Issued"), "Locked")).toBe(false);
    expect(isEntryIntoForce(row("IFC"), "Draft")).toBe(false);
    expect(isEntryIntoForce(row("IFC"), " Issued")).toBe(false);
    expect(isEntryIntoForce(row("IFC", null, null, null), "Issued")).toBe(false);
    expect(isEntryIntoForce(row("Draft"), "Issued")).toBe(false); // a REV-18 issue (a new one), not this
    expect(isEntryIntoForce(row("Archived", "Issued", "v1"), "Issued")).toBe(false);
    expect(isEntryIntoForce(row("Archived", "IFC", "v0"), "Issued")).toBe(false); // the stamp names another revision (P20's limb)
    expect(isEntryIntoForce(row("Archived", "IFC", "v1"), "IFC")).toBe(false);
    // the direct move IS lib/documentStatusOptions.ts isUnguardedEntryIntoForce (with a current revision)
    for (const from of UNIVERSE) for (const to of ["Issued", "Locked", "IFC", "Draft"]) {
      if (isRetiredStatus(from)) continue;
      expect(isEntryIntoForce(row(from), to), `${JSON.stringify(from)} -> ${to}`).toBe(isUnguardedEntryIntoForce({ fromStatus: from, toStatus: to, hasCurrentRevision: true }));
    }
  });

  it("putBackFromRetirementStamp: for an IFC-stamped retirement, Issued is NOT a put-back (false) and IFC is (true); an Issued stamp is put back into Issued (true); without a target, the answer it always gave", () => {
    expect(putBackFromRetirementStamp(row("Archived", "IFC", "v1"), "Issued")).toBe(false);
    expect(putBackFromRetirementStamp(row("Archived", "IFC", "v1"), "Locked")).toBe(false);
    expect(putBackFromRetirementStamp(row("Archived", "IFC", "v1"), "IFC")).toBe(true);
    expect(putBackFromRetirementStamp(row("Archived", "Issued", "v1"), "Issued")).toBe(true);
    expect(putBackFromRetirementStamp(row("Archived", "IFC", "v1"))).toBe(true);
    expect(putBackFromRetirementStamp(row("Archived", "IFC", "v0"), "Issued")).toBeNull();
    expect(putBackFromRetirementStamp(row("Draft"), "Issued")).toBe(false);
  });

  it("unarchiveStampedRestoreStatus / unarchiveRestoreDefault: an archive stamped IFC is `not-in-force` and comes back as IFC; a NULL or blank stamp as a Draft; an Issued stamp as Issued (`issued`) — REGRESSION for the rest", async () => {
    expect(unarchiveStampedRestoreStatus({ currentVersionId: "v1", retiredIssueStatus: "IFC", retiredIssueVersionId: "v1" })).toBe("IFC");
    expect(unarchiveStampedRestoreStatus({ currentVersionId: "v1", retiredIssueStatus: "Issued", retiredIssueVersionId: "v1" })).toBeNull();
    expect(unarchiveStampedRestoreStatus({ currentVersionId: "v1", retiredIssueStatus: null, retiredIssueVersionId: "v1" })).toBeNull();
    expect(unarchiveStampedRestoreStatus({ currentVersionId: "v1", retiredIssueStatus: "Draft", retiredIssueVersionId: "v1" })).toBeNull();
    expect(unarchiveStampedRestoreStatus({ currentVersionId: "v1", retiredIssueStatus: "IFC", retiredIssueVersionId: "v0" })).toBeNull();
    seedDoc("a1", { status: "Archived", retired_issue_status: "IFC", retired_issue_version_id: "a1-v0" });
    seedDoc("a2", { status: "Archived", retired_issue_status: null, retired_issue_version_id: "a2-v0" });
    seedDoc("a3", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "a3-v0" });
    seedDoc("a4", { status: "Archived", retired_issue_status: "not-issued", retired_issue_version_id: null });
    seedDoc("a5", { status: "Archived" });
    expect(await unarchiveRestoreDefault("a1")).toEqual({ status: "IFC", basis: "not-in-force", stampedStatus: "IFC", stampedRestore: "IFC" });
    expect(await unarchiveRestoreDefault("a2")).toEqual({ status: "Draft", basis: "not-in-force", stampedStatus: null, stampedRestore: null });
    expect(await unarchiveRestoreDefault("a3")).toEqual({ status: "Issued", basis: "issued" });
    expect(await unarchiveRestoreDefault("a4")).toEqual({ status: "Draft", basis: "not-issued" });
    expect(await unarchiveRestoreDefault("a5")).toEqual({ status: "Issued", basis: "unknown" });
  });

  it("unarchiveDocument admits the archive's own stamped status (read now), and nothing else beside the three", async () => {
    seedDoc("u1", { status: "Archived", retired_issue_status: "IFC", retired_issue_version_id: "u1-v0" });
    seedDoc("u2", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "u2-v0" });
    await expect(unarchiveDocument({ doc: asRecord(docRow("u1")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Approved" })).rejects.toThrow('Cannot restore to "Approved" — choose Issued, Draft or In Review.');
    await expect(unarchiveDocument({ doc: asRecord(docRow("u2")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "IFC" })).rejects.toThrow('Cannot restore to "IFC" — choose Issued, Draft or In Review.');
    expect(docRow("u2").status).toBe("Archived");
    const out = await unarchiveDocument({ doc: asRecord(docRow("u1")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "IFC" });
    expect(docRow("u1").status).toBe("IFC");
    // the put-back of what it was: recorded, its clocks kept (nothing restarted)
    expect(out).toMatchObject({ issued: true, putBack: true });
    expect(issuedRecords()[0].details).toMatchObject({ door: "unarchive", fromStatus: "Archived", toStatus: "IFC", putBack: true, reviewClockReset: false, acknowledgmentRosterOpened: false });
    expect(onDocumentIssuedAck).not.toHaveBeenCalled();
  });

  it("REV-26 / REV-27: unarchiveDocument of an IFC-stamped archive INTO Issued is a first entry into force — recorded (entryIntoForce, putBack false), the roster opened, the review clock NOT reset", async () => {
    seedDoc("u3", { status: "Archived", retired_issue_status: "IFC", retired_issue_version_id: "u3-v0" });
    const out = await unarchiveDocument({ doc: asRecord(docRow("u3")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    expect(docRow("u3").status).toBe("Issued");
    expect(out).toMatchObject({ issued: true, putBack: false, entryIntoForce: true });
    expect(issuedRecords()[0].details).toMatchObject({ door: "unarchive", fromStatus: "Archived", toStatus: "Issued", putBack: false, entryIntoForce: true, reviewClockReset: false, acknowledgmentRosterOpened: true });
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(1);
  });
});

// ─── REV-29: a NULL prior status is put back as NULL ───────────────────────
describe("REV-29 — putBackRetiredIssue: a NULL is asked for; an older body's blank-status refusal takes today's path (olderBodyStatus); the un-archive never retries", () => {
  const sup = (id: string) => seedDoc(id, { status: "Superseded", superseded_by_user: ME, retired_issue_status: null, retired_issue_version_id: `${id}-v0` });

  it("after 20261192: landed as NULL — what it was; one call", async () => {
    sup("r1");
    expect(await putBackRetiredIssue({ documentId: "r1", status: null, door: "supersede_rollback", olderBodyStatus: "Issued" })).toEqual({ kind: "landed", recorded: false });
    expect(docRow("r1").status).toBeNull();
    expect(state.rpcCalls.map((c) => c.args.p_status)).toEqual([null]);
  });

  it("before 20261192 (the older body refuses the NULL in its blank-status sentence, before any write): put back as 'Issued' — today's path — and said so (putBackAs)", async () => {
    state.doors = "old";
    sup("r2");
    expect(await putBackRetiredIssue({ documentId: "r2", status: null, door: "lifecycle_rollback", olderBodyStatus: "Issued" })).toEqual({ kind: "landed", recorded: false, putBackAs: "Issued" });
    expect(docRow("r2").status).toBe("Issued");
    expect(state.rpcCalls.map((c) => c.args.p_status)).toEqual([null, "Issued"]);
    expect(PUT_BACK_BLANK_STATUS_REFUSAL).toBe(PB_BLANK);
  });

  it("no retry without olderBodyStatus, for a status that is not NULL, or for any other refusal", async () => {
    state.doors = "old";
    sup("r3");
    expect(await putBackRetiredIssue({ documentId: "r3", status: null, door: "unarchive" })).toEqual({ kind: "refused", reason: PB_BLANK });
    expect(await putBackRetiredIssue({ documentId: "r3", status: "", door: "supersede_rollback", olderBodyStatus: "Issued" })).toEqual({ kind: "refused", reason: PB_BLANK });
    expect(state.rpcCalls).toHaveLength(2);
    expect(docRow("r3").status).toBe("Superseded");
  });

  it("with no function (before 20261165): absent — the caller's direct write puts back the NULL", async () => {
    state.doors = "absent";
    expect(await putBackRetiredIssue({ documentId: "r4", status: null, door: "supersede_rollback", olderBodyStatus: "Issued" })).toEqual({ kind: "absent" });
  });

  it("describePutBackStatus names a NULL or blank status as what it is, never as Issued", () => {
    expect(describePutBackStatus(null)).toBe("no status (the status it had)");
    expect(describePutBackStatus("  ")).toBe("an empty status (the status it had)");
    expect(describePutBackStatus("IFC")).toBe("IFC");
  });
});

describe("REV-29 — the real rollbacks put a NULL-status document back as NULL (after 20261192), as 'Issued' on an older body, NULL by the direct write with no function", () => {
  const supersede = (id: string, replacements: string[]) =>
    supersedeDocument({ doc: asRecord(docRow(id)), replacementDocNumbers: replacements, libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME });

  for (const [doors, expected, said] of [["192", null, "no status \\(the status it had\\)"], ["old", "Issued", "Issued"], ["absent", null, "no status \\(the status it had\\)"]] as const) {
    it(`undoFailedSupersede (doors: ${doors}) — back to ${String(expected)}, and the sentence says so`, async () => {
      state.doors = doors;
      seedDoc("n1", { status: null }); seedDoc("n1a");
      state.db.refuseWrites.add("document_supersessions");
      await expect(supersede("n1", ["N1A"])).rejects.toThrow(new RegExp(`The document is back to ${said}\\. Fix the cause and supersede it again\\.$`));
      expect(docRow("n1")).toMatchObject({ status: expected, supersession_reason: null });
    });

    it(`markSupersededAndLink + restoreSupersededSource (doors: ${doors}) — the event's priorStatus is NULL; the source back to ${String(expected)}`, async () => {
      state.doors = doors;
      seedDoc("n2", { status: null }); seedDoc("n2a");
      let recorded: string | null | undefined;
      await expect(withCompensation(async (register) => {
        const r = await markSupersededAndLink({ sourceDocId: "n2", replacementDocIds: ["n2a"], reason: "split", actor: { orgId: ORG, actorUserId: ME }, register, label: "N2" });
        recorded = r.priorStatus;
        throw new Error("a later step failed");
      })).rejects.toThrow("a later step failed (the operation was rolled back — no partial changes were kept).");
      expect(recorded).toBeNull();
      expect(docRow("n2").status).toBe(expected);
    });
  }

  it("restoreSupersededSource's refusal names what the source had", async () => {
    state.doors = "192";
    seedDoc("n3", { status: "Superseded" });
    state.db.refuseWrites.add("documents");
    await expect(restoreSupersededSource("n3", null, [], { orgId: ORG, actorUserId: ME })).rejects.toThrow(/^source n3 is still Superseded — restore it to no status \(the status it had\) \(/);
  });
});

describe("REV-29 — a reversal restores a recorded NULL as NULL (never guessed, never asked for)", () => {
  function seedSplit(prefix: string, details: Row) {
    seedDoc(prefix, { status: "Superseded", superseded_at: "2025-09-01T10:00:00Z", supersession_reason: "split", rev: "3" });
    for (const x of ["a", "b"]) seedDoc(`${prefix}${x}`, { status: "Issued" });
    T("document_supersessions").push(
      { id: `l-${prefix}a`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}a`, reason: "split", created_by: ME, created_at: "2025-09-01T10:00:00Z" },
      { id: `l-${prefix}b`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}b`, reason: "split", created_by: ME, created_at: "2025-09-01T10:00:00Z" },
    );
    T("audit_logs").push({ id: `ev-${prefix}`, org_id: ORG, action: "DOC_SPLIT", resource_id: prefix, timestamp: "2025-09-01T10:00:00Z", details: { replacementDocIds: [`${prefix}a`, `${prefix}b`], auditAt: "2025-09-01T10:00:00Z", ...details } });
  }
  beforeEach(() => { state.roles = ["DocCtrl"]; state.canControl = true; });

  it("recordsPriorStatus / reversalNeedsLegacyStatus: a NULL (or blank) recorded is a record; a key the event does not carry is a legacy event", () => {
    expect(recordsPriorStatus({ priorStatus: null }, "priorStatus")).toBe(true);
    expect(recordsPriorStatus({ priorStatus: "" }, "priorStatus")).toBe(true);
    expect(recordsPriorStatus({ priorStatus: "IFC" }, "priorStatus")).toBe(true);
    expect(recordsPriorStatus({}, "priorStatus")).toBe(false);
    expect(recordsPriorStatus({ priorStatus: 3 }, "priorStatus")).toBe(false);
    expect(reversalNeedsLegacyStatus("DOC_SPLIT", { priorStatus: null })).toBe(false);
    expect(reversalNeedsLegacyStatus("DOC_SPLIT", {})).toBe(true);
    expect(reversalNeedsLegacyStatus("DOC_MERGED", { mergeSiblings: ["a", "b"], priorStatuses: { a: null, b: "Issued" } })).toBe(false);
    expect(reversalNeedsLegacyStatus("DOC_MERGED", { mergeSiblings: ["a", "b"], priorStatuses: { a: "Issued" } })).toBe(true);
  });

  it("after 20261192: the source comes back with no status, through restore_reversed_source naming the event; the reversal records NULL, 'recorded'", async () => {
    seedSplit("s1", { priorStatus: null });
    await reverseSplit({ splitAuditEventId: "ev-s1", reason: "wrong split", orgId: ORG, actorUserId: ME, force: true });
    expect(docRow("s1").status).toBeNull();
    expect(state.rpcCalls.filter((c) => c.fn === "restore_reversed_source").map((c) => c.args)).toEqual([{ p_document_id: "s1", p_status: null, p_reversal_of: "ev-s1", p_reason: "wrong split" }]);
    const rev = T("audit_logs").find((a) => a.action === "DOC_SPLIT_REVERSED")!;
    expect(rev.details).toMatchObject({ restoredStatus: null, restoredStatusSource: "recorded" });
  });

  it("before 20261192: a NULL is restored as 'Issued' (today's path — the reversal of an event recorded before P25 did the same) and recorded as what was restored", async () => {
    state.doors = "old";
    seedSplit("s2", { priorStatus: null });
    await reverseSplit({ splitAuditEventId: "ev-s2", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect(docRow("s2").status).toBe("Issued");
    expect(state.rpcCalls.filter((c) => c.fn === "restore_reversed_source").map((c) => c.args.p_status)).toEqual([null, "Issued"]);
    expect(T("audit_logs").find((a) => a.action === "DOC_SPLIT_REVERSED")!.details).toMatchObject({ restoredStatus: "Issued", restoredStatusSource: "recorded" });
  });

  it("before 20261192: an EMPTY status recorded is refused with a sentence naming 20261192 — nothing changed", async () => {
    state.doors = "old";
    seedSplit("s3", { priorStatus: "" });
    await expect(reverseSplit({ splitAuditEventId: "ev-s3", reason: "r", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/s3 had an empty status, which this database's restore_reversed_source cannot put back until database update 20261192 is applied — nothing was changed\. Apply 20261192, then reverse again\./);
    expect(docRow("s3").status).toBe("Superseded");
    for (const x of ["s3a", "s3b"]) expect(docRow(x).status).toBe("Issued");
    expect(RESTORE_BLANK_STATUS_REFUSAL).toBe(RR_BLANK);
  });

  it("with no function: the direct write restores the NULL", async () => {
    state.doors = "absent";
    seedSplit("s4", { priorStatus: null });
    await reverseSplit({ splitAuditEventId: "ev-s4", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect(docRow("s4").status).toBeNull();
  });

  it("REGRESSION — a recorded status restores as before, and a legacy event (no key) still needs the status named", async () => {
    seedSplit("s5", { priorStatus: "IFC" });
    await reverseSplit({ splitAuditEventId: "ev-s5", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect(docRow("s5").status).toBe("IFC");
    seedSplit("s6", {});
    await expect(reverseSplit({ splitAuditEventId: "ev-s6", reason: "r", orgId: ORG, actorUserId: ME, force: true })).rejects.toThrow();
    expect(docRow("s6").status).toBe("Superseded");
  });

  it("reverseMerge: a sibling recorded NULL comes back with no status; the other as recorded", async () => {
    for (const s of ["1", "2"]) seedDoc(`m${s}`, { status: "Superseded" });
    seedDoc("mt", { status: "Issued" });
    T("document_supersessions").push(
      { id: "l-m1", org_id: ORG, superseded_doc_id: "m1", replacement_doc_id: "mt", created_by: ME },
      { id: "l-m2", org_id: ORG, superseded_doc_id: "m2", replacement_doc_id: "mt", created_by: ME },
    );
    T("audit_logs").push({ id: "ev-m", org_id: ORG, action: "DOC_MERGED", resource_id: "m1", timestamp: "2025-09-03T00:00:00Z", details: { mergedIntoDocumentId: "mt", mergeSiblings: ["m1", "m2"], targetWasNewlyCreated: true, priorStatuses: { m1: null, m2: "Issued" }, auditAt: "2025-09-03T00:00:00Z" } });
    await reverseMerge({ mergeAuditEventId: "ev-m", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect([docRow("m1").status, docRow("m2").status]).toEqual([null, "Issued"]);
  });
});
