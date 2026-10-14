// document-control Round G — P26 STATUS-DOOR FOLLOW-UPS (notifications
// PROD-17, the remaining retirement doors). Driven against the in-memory
// PostgREST (helpers/fakeSupabase) with the real lib/revisions.ts,
// lib/documentLifecycle/*, lib/audit.ts and (for the chain tests) the real
// lib/staleCopies.ts — only the dispatcher's emit() is a spy.
//
//   · archiveDocument, changeDocumentStatus into Superseded / Void /
//     Archived, splitDocument and mergeDocuments each call
//     recallRetiredDocument ONCE per retired document (a merge: once per
//     absorbed source), with the newStatus, and with personallyToldElsewhere
//     saying which personal notices the door sent (archive / status change:
//     neither; split / merge: the checkout holder, no package owner).
//   · The copy holders' doc_recalled and its DISTRIBUTION_RECALL row go
//     first, the watchers' doc_retired after; neither is awaited by the door
//     — a recall or an FYI that never finishes does not delay it.
//   · REGRESSION: every door returns what it returned, writes the records
//     it wrote and sends the personal notices it sent; supersede still sends
//     exactly one recall; a status change that retires nothing (or a re-save
//     of a retired document) recalls nothing; archiving, splitting or
//     merging a document already Superseded or Archived (its status read
//     fresh before the write) sends nothing again (skipsRetirementRecall);
//     a refused write recalls nothing; a rolled-back split recalls nothing.
//   · fix pass 4 (the integrator's ruling under DEC-90, 2026-10-14): the
//     copy holders are recalled only when the retirement takes away a
//     controlled issue (recallsCopyHolders = lib/issueStatus.ts
//     isControlledIssueStatus of the prior status). A Draft, In Review or
//     Void document archived, split, merged or moved into a retired status
//     gets the watchers' FYI only — no doc_recalled, no DISTRIBUTION_RECALL
//     row — and that FYI is the one an issued document's watchers get; an
//     Issued one recalls exactly once.
//   · A recall that never starts (a failed module load, a throw past
//     recallRetiredDocument) is logged as an error (fix pass 2; fix pass 4:
//     console.error). Only that: a recall whose download_audits read fails
//     is silent inside lib/staleCopies.ts (notifications DELIV-17, assigned
//     to document-control P28).
//   · CENSUS (fix pass): recallOnRetirement is called from exactly the four
//     doors above and nowhere else — the status editors (the library page,
//     BulkEditModal) are PROD-17 residual doors and do not call it — and
//     (fix pass 3) recallRetiredDocument is called directly only from
//     lib/revisions.ts, twice: inside recallOnRetirement and by
//     supersedeDocument. A new call site of either, anywhere in app/,
//     components/ or lib/, fails a census: no door can add a second
//     recall unnoticed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

type RecallInput = Record<string, unknown>;

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  rpc: vi.fn(),
  roles: ["DocCtrl"] as string[],
  /** true: the real recallRetiredDocument runs (the chain tests). */
  realRecall: false,
  /** the stand-in recall when realRecall is false. */
  recallImpl: null as null | ((i: RecallInput) => Promise<unknown>),
  /** emit() payloads, in order. */
  emits: [] as Array<Record<string, unknown>>,
  /** kind → emit never resolves for it. */
  stallKind: null as null | string,
  /** table → the next plain read fails. */
  failRead: null as null | ((table: string) => boolean),
  zeroUpdate: null as null | ((table: string, patch: Row) => boolean),
}));

function wrap(table: string, inner: Record<string, (...a: unknown[]) => unknown>): unknown {
  let op = "select";
  let patch: Row = {};
  const failed = () => ({ data: null, error: { message: `${table} read failed` } });
  const wrapper: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") {
        if (op === "select" && state.failRead?.(table)) return (resolve: (v: unknown) => void) => resolve(failed());
        if (op === "update" && state.zeroUpdate?.(table, patch)) return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => (inner.then as unknown as (a: unknown, b: unknown) => void)(resolve, reject);
      }
      return (...args: unknown[]) => {
        if (["update", "delete", "insert", "upsert"].includes(prop)) op = prop;
        if (prop === "update") patch = (args[0] ?? {}) as Row;
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
      from: (t: string) => wrap(t, base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>),
      // Databases before the recorded doors (PGRST202): the direct writes, as the Round F lifecycle tests pin.
      rpc: (...a: unknown[]) => (["finalize_reviewed_promote", "restore_reversed_source", "put_back_retired_issue", "document_status_issue_recorded_by_database"].includes(a[0] as string)
        ? Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${String(a[0])}` } })
        : state.rpc(...a)),
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
  return { ...real, resolveCanControlLibrary: vi.fn(async () => true) };
});
vi.mock("@/lib/ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ownership")>();
  return { ...real, isEffectiveOwnerOfDocument: vi.fn(async () => false) };
});
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
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
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/unitCodeClient", () => ({ requestUnitCodeDecode: vi.fn(async () => ({ note: null })) }));
vi.mock("@/lib/notify/dispatch", () => ({
  emit: vi.fn((p: Record<string, unknown>) => {
    state.emits.push(p);
    return state.stallKind === p.kind ? new Promise(() => {}) : Promise.resolve();
  }),
}));
vi.mock("@/lib/staleCopies", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/staleCopies")>();
  return {
    ...real,
    recallRetiredDocument: vi.fn((i: RecallInput) => (state.realRecall
      ? real.recallRetiredDocument(i as Parameters<typeof real.recallRetiredDocument>[0])
      : (state.recallImpl ?? (async () => 0))(i))),
  };
});

import { archiveDocument, supersedeDocument, changeDocumentStatus, skipsRetirementRecall, recallsCopyHolders } from "@/lib/revisions";
import { splitDocument } from "@/lib/documentLifecycle/split";
import { mergeDocuments } from "@/lib/documentLifecycle/merge";
import { recallRetiredDocument } from "@/lib/staleCopies";
import { notify } from "@/lib/inAppNotifications";
import { notifyPackagesOfRetirement } from "@/lib/postPublish";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const T = (t: string) => (state.db.tables[t] ??= []);
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const recall = vi.mocked(recallRetiredDocument);
const NO_STATUS_ISSUE = { issued: false, putBack: false, complianceClockErrors: [], recordError: null };

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: LIB, document_number: id.toUpperCase(), title: id, rev: "3", revision: "3",
    status: "Issued", current_version_id: `${id}-v3`, pending_version_id: null, checked_out_by: null, checked_out_by_name: null,
    ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null });
  return d;
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: LIB, documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id, collectionId: null,
}) as unknown as DocumentRecord;
const pdf = (n: string) => new File([new Uint8Array([1, 2, 3])], n, { type: "application/pdf" });
const target = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
/** the background recall chain (a dynamic import, then the call) settles */
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 1)); };
const recallsFor = (docId: string) => recall.mock.calls.map((c) => c[0] as RecallInput).filter((i) => i.documentId === docId);

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.rpc.mockReset();
  state.roles = ["DocCtrl"];
  state.realRecall = false;
  state.recallImpl = null;
  state.emits = [];
  state.stallKind = null;
  state.failRead = null;
  state.zeroUpdate = null;
});

// ─── archiveDocument ────────────────────────────────────────────────────
describe("PROD-17 (P26) — an archive recalls the copies and tells the watchers, once", () => {
  it("one recall: Archived, the label and library, neither personal notice sent elsewhere — and the archive's own record is unchanged", async () => {
    const d = seedDoc("p101");
    const out = await archiveDocument({ doc: asRecord(d), reason: "Obsolete unit", orgId: ORG, actorUserId: ME, actorEmail: "dana@x" });
    expect(out).toBeUndefined();
    await settle();
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0][0]).toEqual({
      orgId: ORG, documentId: "p101", libraryId: LIB, docLabel: "P101", newStatus: "Archived", replacementNote: null,
      actorUserId: ME, actorName: "dana@x",
      personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
      recallCopyHolders: true,
    });
    // regression: the status, the ARCHIVE_DOC record and no personal notice, as before
    expect(docRow("p101").status).toBe("Archived");
    expect(audit("ARCHIVE_DOC")).toHaveLength(1);
    expect(audit("ARCHIVE_DOC")[0].details).toMatchObject({ reason: "Obsolete unit", action: "archive" });
    expect(notify).not.toHaveBeenCalled();
    expect(notifyPackagesOfRetirement).not.toHaveBeenCalled();
  });

  it("a recall that never finishes does not hold the archive", async () => {
    state.recallImpl = () => new Promise(() => {});
    const d = seedDoc("p102");
    await expect(archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME })).resolves.toBeUndefined();
    await settle();
    expect(recall).toHaveBeenCalledTimes(1);
  });

  it("archiving a document already Superseded or Archived (read with the legal hold, just before the write) recalls nothing again; the archive itself is unchanged", async () => {
    for (const [id, status] of [["p104", "Superseded"], ["p107", "Archived"]] as const) {
      const d = seedDoc(id, { status });
      await expect(archiveDocument({ doc: asRecord({ ...d, status: "Issued" }), reason: "tidy", orgId: ORG, actorUserId: ME })).resolves.toBeUndefined();
      expect(docRow(id).status).toBe("Archived");
    }
    expect(audit("ARCHIVE_DOC")).toHaveLength(2);
    await settle();
    expect(recall).not.toHaveBeenCalled();
  });

  it("fix pass 2 / fix pass 4: archiving a VOIDED document tells its watchers (no live door that writes Void tells them) — and recalls no copy holder: Void is not a controlled issue (DEC-90 ruling)", async () => {
    const d = seedDoc("p105", { status: "Void" });
    await expect(archiveDocument({ doc: asRecord(d), reason: "tidy", orgId: ORG, actorUserId: ME, actorEmail: "dana@x" })).resolves.toBeUndefined();
    expect(docRow("p105").status).toBe("Archived");
    expect(audit("ARCHIVE_DOC")).toHaveLength(1);
    await settle();
    expect(recallsFor("p105")).toEqual([{
      orgId: ORG, documentId: "p105", libraryId: LIB, docLabel: "P105", newStatus: "Archived", replacementNote: null,
      actorUserId: ME, actorName: "dana@x",
      personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
      recallCopyHolders: false,
    }]);
  });

  it("the row read just before the archive says Issued though the caller's copy says Superseded: the archive recalls (the fresh read decides)", async () => {
    const d = seedDoc("p106");
    await archiveDocument({ doc: asRecord({ ...d, status: "Superseded" }), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    expect(recallsFor("p106")).toHaveLength(1);
  });

  it("a refused archive recalls nobody", async () => {
    const d = seedDoc("p103");
    state.zeroUpdate = (t, p) => t === "documents" && p.status === "Archived";
    await expect(archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME })).rejects.toThrow(/NOT archived/);
    await settle();
    expect(recall).not.toHaveBeenCalled();
  });
});

// ─── changeDocumentStatus ───────────────────────────────────────────────
describe("PROD-17 (P26) — a status change that retires the document recalls and tells the watchers, once", () => {
  for (const toStatus of ["Void", "Archived", "Superseded"]) {
    it(`Issued → ${toStatus}: one recall (${toStatus}), the label read from the row, the outcome unchanged`, async () => {
      seedDoc("s1");
      const out = await changeDocumentStatus({ orgId: ORG, documentId: "s1", toStatus, door: "metadata", actorUserId: ME, actorEmail: "dana@x" });
      expect(out).toEqual(NO_STATUS_ISSUE);
      expect(docRow("s1").status).toBe(toStatus);
      await settle();
      expect(recall).toHaveBeenCalledTimes(1);
      expect(recall.mock.calls[0][0]).toEqual({
        orgId: ORG, documentId: "s1", libraryId: LIB, docLabel: "S1", newStatus: toStatus, replacementNote: null,
        actorUserId: ME, actorName: "dana@x",
        personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
        recallCopyHolders: true,
      });
    });
  }

  it("a re-save of a document already retired (Void → Void, Archived → Void, Superseded → Archived) recalls nothing again", async () => {
    seedDoc("s2", { status: "Void" });
    seedDoc("s3", { status: "Archived" });
    seedDoc("s3b", { status: "Superseded" });
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s2", toStatus: "Void", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s3", toStatus: "Void", door: "bulk", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s3b", toStatus: "Archived", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    await settle();
    expect(recall).not.toHaveBeenCalled();
  });

  it("fix pass 2 / fix pass 4: a move out of Void into another retired status (Void → Archived, Void → Superseded) tells the watchers — and recalls no copy holder (Void is not a controlled issue)", async () => {
    seedDoc("s9", { status: "Void" });
    seedDoc("s10", { status: "Void" });
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s9", toStatus: "Archived", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s10", toStatus: " Superseded ", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    await settle();
    expect(recallsFor("s9")).toHaveLength(1);
    expect(recallsFor("s9")[0]).toMatchObject({ newStatus: "Archived", docLabel: "S9", recallCopyHolders: false });
    expect(recallsFor("s10")).toHaveLength(1);
    expect(recallsFor("s10")[0]).toMatchObject({ newStatus: "Superseded", recallCopyHolders: false });
  });

  it("regression: a change that retires nothing recalls nothing and returns what it returned (Issued → Draft; Draft → Issued is still the recorded issue)", async () => {
    seedDoc("s4");
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s4", toStatus: "Draft", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    const issued = await changeDocumentStatus({ orgId: ORG, documentId: "s4", toStatus: "Issued", door: "metadata", actorUserId: ME });
    expect(issued.issued).toBe(true);
    expect(audit("DOCUMENT_ISSUED")).toHaveLength(1);
    await settle();
    expect(recall).not.toHaveBeenCalled();
  });

  it("a refused status write recalls nobody", async () => {
    seedDoc("s5");
    state.zeroUpdate = (t, p) => t === "documents" && p.status === "Void";
    await expect(changeDocumentStatus({ orgId: ORG, documentId: "s5", toStatus: "Void", door: "metadata", actorUserId: ME })).rejects.toThrow(/status was NOT changed/);
    await settle();
    expect(recall).not.toHaveBeenCalled();
  });

  it("the pre-write read failed (was it retired already? unknown): the recall still goes — a second recall over none — with the label read again off the door's path", async () => {
    seedDoc("s6");
    let n = 0;
    state.failRead = (t) => t === "documents" && ++n === 1;
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s6", toStatus: "Void", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    await settle();
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0][0]).toMatchObject({ documentId: "s6", docLabel: "S6", libraryId: LIB, newStatus: "Void", recallCopyHolders: true });
  });

  it("no label can be read at all: the recall still goes, naming \"A document\"", async () => {
    seedDoc("s7");
    state.failRead = (t) => t === "documents";
    await changeDocumentStatus({ orgId: ORG, documentId: "s7", toStatus: "Void", door: "metadata", actorUserId: ME });
    await settle();
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0][0]).toMatchObject({ documentId: "s7", docLabel: "A document", libraryId: null, newStatus: "Void" });
  });

  it("a recall that never finishes does not hold the status change", async () => {
    state.recallImpl = () => new Promise(() => {});
    seedDoc("s8");
    await expect(changeDocumentStatus({ orgId: ORG, documentId: "s8", toStatus: "Void", door: "metadata", actorUserId: ME })).resolves.toEqual(NO_STATUS_ISSUE);
    // the recall was started all the same (fix pass 2: a door that dropped it would fail here)
    await settle();
    expect(recallsFor("s8")).toHaveLength(1);
  });

  it("fix pass 2 / fix pass 4: a recall that never starts is logged as an error (console.error, as the file's other dropped retirement duties) — and the door returns as before", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      state.recallImpl = () => Promise.reject(new Error("chunk load failed"));
      seedDoc("s11");
      await expect(changeDocumentStatus({ orgId: ORG, documentId: "s11", toStatus: "Void", door: "metadata", actorUserId: ME })).resolves.toEqual(NO_STATUS_ISSUE);
      await settle();
      expect(recallsFor("s11")).toHaveLength(1);
      const logged = error.mock.calls.filter((c) => String(c[0]).includes("PROD-17"));
      expect(logged).toHaveLength(1);
      expect(logged[0][0]).toBe("[revisions] PROD-17: the retirement recall of document s11 did not run");
      expect((logged[0][1] as Error).message).toBe("chunk load failed");
    } finally {
      error.mockRestore();
    }
  });
});

// ─── split / merge ──────────────────────────────────────────────────────
describe("PROD-17 (P26) — a split or merge retiring its sources recalls each one, once", () => {
  it("split: one recall for the source (Superseded, its replacements named), the checkout holder told by the split and left out of the FYI, no package owner — the split's result and holder notice unchanged", async () => {
    const c = seedDoc("c", { checked_out_by: "u2", checked_out_by_name: "Sam" });
    const r = await splitDocument({ source: asRecord(c), libraryId: LIB, targets: [target("C1"), target("C2")], reason: "declutter", orgId: ORG, actorUserId: ME, actorEmail: "dana@x" });
    expect(r.supersededSourceId).toBe("c");
    expect(r.newDocumentIds).toHaveLength(2);
    expect(docRow("c").status).toBe("Superseded");
    await settle();
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0][0]).toEqual({
      orgId: ORG, documentId: "c", libraryId: LIB, docLabel: "C", newStatus: "Superseded", replacementNote: "Replaced by C1, C2.",
      actorUserId: ME, actorName: "dana@x",
      personallyToldElsewhere: { checkoutHolder: true, packageOwners: false },
      recallCopyHolders: true,
    });
    // regression: the holder's own notice, exactly as before; no package notice
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0][0]).toMatchObject({ userId: "u2", kind: "revision_published_over_checkout" });
    expect(notifyPackagesOfRetirement).not.toHaveBeenCalled();
    expect(audit("DOC_SPLIT")).toHaveLength(1);
  });

  it("split: a recall that never finishes does not hold the split; a split that rolls back recalls nobody", async () => {
    state.recallImpl = () => new Promise(() => {});
    const a = seedDoc("a");
    await expect(splitDocument({ source: asRecord(a), libraryId: LIB, targets: [target("A1"), target("A2")], reason: "declutter", orgId: ORG, actorUserId: ME })).resolves.toMatchObject({ supersededSourceId: "a" });
    // the stalled recall was started (fix pass 2: checked before the counts are cleared)
    await settle();
    expect(recallsFor("a")).toHaveLength(1);
    vi.clearAllMocks();
    const b = seedDoc("b");
    state.zeroUpdate = (t, p) => t === "documents" && p.status === "Superseded";
    await expect(splitDocument({ source: asRecord(b), libraryId: LIB, targets: [target("B1"), target("B2")], reason: "declutter", orgId: ORG, actorUserId: ME })).rejects.toThrow();
    await settle();
    expect(recallsFor("b")).toHaveLength(0);
  });

  it("merge into a new document: one recall per absorbed source, each naming the target; result unchanged", async () => {
    const a = seedDoc("g1"); const b = seedDoc("g2");
    const r = await mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "G-NEW", title: "merged", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    expect(r.supersededSourceIds.sort()).toEqual(["g1", "g2"]);
    await settle();
    expect(recall).toHaveBeenCalledTimes(2);
    for (const id of ["g1", "g2"]) {
      expect(recallsFor(id)).toEqual([{
        orgId: ORG, documentId: id, libraryId: LIB, docLabel: id.toUpperCase(), newStatus: "Superseded", replacementNote: "Replaced by G-NEW.",
        actorUserId: ME, actorName: ME,
        personallyToldElsewhere: { checkoutHolder: true, packageOwners: false },
        recallCopyHolders: true,
      }]);
    }
    expect(notifyPackagesOfRetirement).not.toHaveBeenCalled();
  });

  it("a source already Superseded before the split / merge (its status read fresh before the flip) is not recalled again; the live one is", async () => {
    const s0 = seedDoc("rs", { status: "Superseded" });
    const r = await splitDocument({ source: asRecord({ ...s0, status: "Issued" }), libraryId: LIB, targets: [target("RS1"), target("RS2")], reason: "declutter", orgId: ORG, actorUserId: ME });
    expect(r.supersededSourceId).toBe("rs");
    const a = seedDoc("ra", { status: "Superseded" }); const b = seedDoc("rb");
    const m = await mergeDocuments({
      sources: [asRecord({ ...a, status: "Issued" }), asRecord(b)],
      target: { kind: "create_new", documentNumber: "R-NEW", title: "merged", assetTags: [], file: pdf("r.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    expect(m.supersededSourceIds.sort()).toEqual(["ra", "rb"]);
    await settle();
    expect(recallsFor("rs")).toHaveLength(0);
    expect(recallsFor("ra")).toHaveLength(0);
    expect(recallsFor("rb")).toHaveLength(1);
  });

  it("fix pass 2 / fix pass 4: a VOID source split or merged tells its watchers — and recalls no copy holder (Void is not a controlled issue); the live source beside it does", async () => {
    const v = seedDoc("rv", { status: "Void" });
    const r = await splitDocument({ source: asRecord(v), libraryId: LIB, targets: [target("RV1"), target("RV2")], reason: "declutter", orgId: ORG, actorUserId: ME });
    expect(r.supersededSourceId).toBe("rv");
    const w = seedDoc("rw", { status: "Void" }); const x = seedDoc("rx");
    const m = await mergeDocuments({
      sources: [asRecord(w), asRecord(x)],
      target: { kind: "create_new", documentNumber: "W-NEW", title: "merged", assetTags: [], file: pdf("w.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    expect(m.supersededSourceIds.sort()).toEqual(["rw", "rx"]);
    await settle();
    expect(recallsFor("rv")).toHaveLength(1);
    expect(recallsFor("rv")[0]).toMatchObject({ newStatus: "Superseded", replacementNote: "Replaced by RV1, RV2.", recallCopyHolders: false });
    expect(recallsFor("rw")).toHaveLength(1);
    expect(recallsFor("rw")[0]).toMatchObject({ recallCopyHolders: false });
    expect(recallsFor("rx")).toHaveLength(1);
    expect(recallsFor("rx")[0]).toMatchObject({ recallCopyHolders: true });
  });

  it("merge extending an existing document: the kept target is never recalled; the absorbed source is, once", async () => {
    const t = seedDoc("t1"); const a = seedDoc("a1");
    await mergeDocuments({
      sources: [asRecord(t), asRecord(a)],
      target: { kind: "extend_existing", target: asRecord(t), libraryId: LIB, assetTagsUnion: [] },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    await settle();
    expect(recallsFor("t1")).toHaveLength(0);
    expect(recallsFor("a1")).toHaveLength(1);
    expect(recallsFor("a1")[0]).toMatchObject({ replacementNote: "Replaced by T1.", newStatus: "Superseded" });
  });
});

// ─── supersede (regression) ─────────────────────────────────────────────
describe("REGRESSION — supersede still sends exactly its one recall, with its defaults", () => {
  it("one recall, Superseded, no personallyToldElsewhere (both personal notices are its own)", async () => {
    const a = seedDoc("x1"); seedDoc("x2");
    const r = await supersedeDocument({ doc: asRecord(a), replacementDocNumbers: ["X2"], libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME });
    expect(r).toEqual({ resolvedReplacementIds: ["x2"], unresolvedDocNumbers: [] });
    await settle();
    expect(recall).toHaveBeenCalledTimes(1);
    const arg = recall.mock.calls[0][0] as RecallInput;
    expect(arg).toMatchObject({ documentId: "x1", newStatus: "Superseded", replacementNote: "Replaced by X2." });
    expect(arg.personallyToldElsewhere).toBeUndefined();
    // fix pass 4: supersede's call is untouched — no copy-holder flag, so the default (recall) holds
    expect(arg).not.toHaveProperty("recallCopyHolders");
    expect(notifyPackagesOfRetirement).toHaveBeenCalledTimes(1);
  });
});

// ─── the chain, through the real recallRetiredDocument ───────────────────
describe("PROD-17 (P26) — through the real recall: the copy holders first, the watchers after, nothing awaited by the door", () => {
  const seedCopies = (docId: string, users: string[]) => {
    for (const u of users) T("download_audits").push({ document_id: docId, user_id: u, version_id: `${docId}-v3`, created_at: new Date().toISOString() });
  };

  it("a Void status change: doc_recalled to the copy holder, then its DISTRIBUTION_RECALL row, then doc_retired to the followers minus the copy holder — the checkout holder kept (this door told them nothing)", async () => {
    state.realRecall = true;
    seedDoc("v1", { checked_out_by: "u9" });
    seedCopies("v1", ["u3"]);
    await changeDocumentStatus({ orgId: ORG, documentId: "v1", toStatus: "Void", door: "metadata", actorUserId: ME, actorEmail: "dana@x" });
    await settle();
    expect(state.emits.map((e) => e.kind)).toEqual(["doc_recalled", "doc_retired"]);
    expect(state.emits[0]).toMatchObject({ audience: { involved: ["u3"] }, title: "V1 is now Void — your copy is dead paper" });
    expect(state.emits[1]).toMatchObject({
      category: "watched", title: "V1 was retired (Void)", emailOnlyWithBell: true,
      audience: { followers: true, exclude: ["u3"] },
    });
    expect(audit("DISTRIBUTION_RECALL")).toHaveLength(1);
    expect(audit("DISTRIBUTION_RECALL")[0].details).toMatchObject({ retirement: true, newStatus: "Void", recipients: ["u3"] });
  });

  it("a split: the checkout holder the split told is left out of the watchers' FYI", async () => {
    state.realRecall = true;
    const c = seedDoc("k", { checked_out_by: "u2" });
    await splitDocument({ source: asRecord(c), libraryId: LIB, targets: [target("K1"), target("K2")], reason: "declutter", orgId: ORG, actorUserId: ME });
    await settle();
    const fyi = state.emits.filter((e) => e.kind === "doc_retired");
    expect(fyi).toHaveLength(1);
    expect(fyi[0]).toMatchObject({ title: "K was retired (Superseded)", audience: { followers: true, exclude: ["u2"] } });
    // nobody held a copy: no recall notice and no recall row, only the FYI
    expect(state.emits.filter((e) => e.kind === "doc_recalled")).toHaveLength(0);
  });

  it("an FYI that never finishes (a hung discover check): the archive returns, the recall and its row already landed", async () => {
    state.realRecall = true;
    state.stallKind = "doc_retired";
    const d = seedDoc("h1");
    seedCopies("h1", ["u4"]);
    await expect(archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME })).resolves.toBeUndefined();
    await settle();
    expect(state.emits.map((e) => e.kind)).toEqual(["doc_recalled", "doc_retired"]);
    expect(audit("DISTRIBUTION_RECALL")).toHaveLength(1);
  });

  it("a recall notice that never finishes: the merge returns all the same", async () => {
    state.realRecall = true;
    state.stallKind = "doc_recalled";
    const a = seedDoc("m1"); const b = seedDoc("m2");
    seedCopies("m1", ["u5"]);
    await expect(mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "M-NEW", title: "merged", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    })).resolves.toMatchObject({ supersededSourceIds: ["m1", "m2"] });
    // fix pass 2: the recall was sent — one per source; m1's notice to its
    // copy holder is the one that stalls, so its audit row never lands
    await settle();
    expect(recallsFor("m1")).toHaveLength(1);
    expect(recallsFor("m2")).toHaveLength(1);
    expect(state.emits.filter((e) => e.kind === "doc_recalled").map((e) => e.audience)).toEqual([{ involved: ["u5"] }]);
    expect(audit("DISTRIBUTION_RECALL")).toHaveLength(0);
  });
});

// ─── fix pass 4: a document never issued gets the watchers' FYI only ─────
describe("PROD-17 (P26 fix pass 4, DEC-90 ruling) — a never-issued document recalls no copy holder; an issued one recalls exactly once", () => {
  const seedCopies = (docId: string, users: string[]) => {
    for (const u of users) T("download_audits").push({ document_id: docId, user_id: u, version_id: `${docId}-v3`, created_at: new Date().toISOString() });
  };
  const fyiFor = (label: string) => state.emits.filter((e) => e.kind === "doc_retired" && String(e.title).startsWith(`${label} `));
  const recalledFor = (label: string) => state.emits.filter((e) => e.kind === "doc_recalled" && String(e.title).startsWith(`${label} `));

  it("recallsCopyHolders is lib/issueStatus.ts isControlledIssueStatus of the prior status: an issue (or no status read) recalls; Draft, In Review and the retired statuses do not", () => {
    for (const s of ["Issued", "IFC", "Locked", "For Construction", " Issued ", "", null, undefined]) expect(recallsCopyHolders(s)).toBe(true);
    for (const s of ["Draft", "In Review", " Draft ", "Void", " Void ", "Superseded", "Archived"]) expect(recallsCopyHolders(s)).toBe(false);
  });

  it("archive: a Draft or In Review row passes recallCopyHolders: false; an Issued one true — each door still sends exactly one call", async () => {
    for (const [id, status] of [["n1", "Draft"], ["n2", "In Review"], ["n3", "Issued"]] as const) {
      const d = seedDoc(id, { status });
      await expect(archiveDocument({ doc: asRecord(d), reason: "tidy", orgId: ORG, actorUserId: ME })).resolves.toBeUndefined();
      expect(docRow(id).status).toBe("Archived");
    }
    expect(audit("ARCHIVE_DOC")).toHaveLength(3);
    await settle();
    expect(recall).toHaveBeenCalledTimes(3);
    expect(recallsFor("n1")).toEqual([expect.objectContaining({ newStatus: "Archived", recallCopyHolders: false })]);
    expect(recallsFor("n2")).toEqual([expect.objectContaining({ newStatus: "Archived", recallCopyHolders: false })]);
    expect(recallsFor("n3")).toEqual([expect.objectContaining({ newStatus: "Archived", recallCopyHolders: true })]);
  });

  it("status change: Draft → Void and In Review → Archived pass recallCopyHolders: false; the outcome is unchanged", async () => {
    seedDoc("n4", { status: "Draft" });
    seedDoc("n5", { status: "In Review" });
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "n4", toStatus: "Void", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "n5", toStatus: "Archived", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    await settle();
    expect(recallsFor("n4")).toEqual([expect.objectContaining({ newStatus: "Void", recallCopyHolders: false })]);
    expect(recallsFor("n5")).toEqual([expect.objectContaining({ newStatus: "Archived", recallCopyHolders: false })]);
  });

  it("split and merge: a Draft / In Review source passes recallCopyHolders: false, an Issued source beside it true — one call per source, results unchanged", async () => {
    const d = seedDoc("nd", { status: "Draft" });
    const r = await splitDocument({ source: asRecord(d), libraryId: LIB, targets: [target("ND1"), target("ND2")], reason: "declutter", orgId: ORG, actorUserId: ME });
    expect(r.supersededSourceId).toBe("nd");
    expect(docRow("nd").status).toBe("Superseded");
    const a = seedDoc("nr", { status: "In Review" }); const b = seedDoc("ni");
    const m = await mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "N-NEW", title: "merged", assetTags: [], file: pdf("n.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    expect(m.supersededSourceIds.sort()).toEqual(["ni", "nr"]);
    await settle();
    expect(recall).toHaveBeenCalledTimes(3);
    expect(recallsFor("nd")).toEqual([expect.objectContaining({ newStatus: "Superseded", replacementNote: "Replaced by ND1, ND2.", recallCopyHolders: false })]);
    expect(recallsFor("nr")).toEqual([expect.objectContaining({ newStatus: "Superseded", replacementNote: "Replaced by N-NEW.", recallCopyHolders: false })]);
    expect(recallsFor("ni")).toEqual([expect.objectContaining({ newStatus: "Superseded", replacementNote: "Replaced by N-NEW.", recallCopyHolders: true })]);
  });

  it("through the real recall: archiving a Draft that people downloaded sends no doc_recalled and writes no DISTRIBUTION_RECALL; its watchers get the same FYI an Issued archive's watchers get", async () => {
    state.realRecall = true;
    const draft = seedDoc("dr", { status: "Draft" });
    seedCopies("dr", ["u3", "u4"]);
    const issued = seedDoc("is");
    await archiveDocument({ doc: asRecord(draft), reason: "abandoned", orgId: ORG, actorUserId: ME, actorEmail: "dana@x" });
    await archiveDocument({ doc: asRecord(issued), reason: "obsolete", orgId: ORG, actorUserId: ME, actorEmail: "dana@x" });
    await settle();
    // the recall was sent for both (a door that dropped it would fail here)
    expect(recallsFor("dr")).toHaveLength(1);
    expect(recallsFor("is")).toHaveLength(1);
    // the never-issued Draft: no copy holder told, nothing on the audit trail
    expect(recalledFor("DR")).toHaveLength(0);
    expect(audit("DISTRIBUTION_RECALL")).toHaveLength(0);
    // the watchers' FYI: one each, the same shape — the Draft's copy holders are not left out of it (they were told nothing else)
    const fyiDraft = fyiFor("DR"); const fyiIssued = fyiFor("IS");
    expect(fyiDraft).toHaveLength(1);
    expect(fyiIssued).toHaveLength(1);
    const shape = (e: Record<string, unknown>, label: string, id: string) => ({
      ...e, title: String(e.title).replace(label, "<doc>"), body: String(e.body).split(label).join("<doc>"),
      link: String(e.link).replace(id, "<id>"), resource: { ...(e.resource as Row), id: "<id>" },
    });
    expect(shape(fyiDraft[0], "DR", "dr")).toEqual(shape(fyiIssued[0], "IS", "is"));
    expect(fyiDraft[0]).toMatchObject({
      orgId: ORG, category: "watched", kind: "doc_retired", title: "DR was retired (Archived)",
      body: "dana@x retired DR (archived); there is no current revision to work from.",
      link: `/documents/${LIB}?doc=dr`, resource: { type: "document", id: "dr" }, actorUserId: ME, actorName: "dana@x",
      audience: { followers: true, exclude: [] },
      metadata: { retirement: true, followerNotice: true, newStatus: "Archived" },
      emailOnlyWithBell: true,
    });
  });

  it("through the real recall: an Issued document archived with copy holders recalls exactly once — one doc_recalled, one DISTRIBUTION_RECALL — then the FYI minus the holders", async () => {
    state.realRecall = true;
    const d = seedDoc("iq");
    seedCopies("iq", ["u3", "u4", "u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "obsolete", orgId: ORG, actorUserId: ME });
    await settle();
    expect(recallsFor("iq")).toHaveLength(1);
    expect(state.emits.map((e) => e.kind)).toEqual(["doc_recalled", "doc_retired"]);
    expect(recalledFor("IQ")).toHaveLength(1);
    expect(recalledFor("IQ")[0]).toMatchObject({ audience: { involved: ["u3", "u4"] } });
    expect(audit("DISTRIBUTION_RECALL")).toHaveLength(1);
    expect(audit("DISTRIBUTION_RECALL")[0].details).toMatchObject({ retirement: true, newStatus: "Archived", recipientCount: 2, recipients: ["u3", "u4"] });
    expect(fyiFor("IQ")[0]).toMatchObject({ audience: { followers: true, exclude: ["u3", "u4"] } });
  });

  it("through the real recall: a Draft split and an In Review source merged beside an Issued one — only the Issued source's holders are recalled, once; every source's watchers get the FYI", async () => {
    state.realRecall = true;
    const d = seedDoc("sd", { status: "Draft" });
    seedCopies("sd", ["u5"]);
    await splitDocument({ source: asRecord(d), libraryId: LIB, targets: [target("SD1"), target("SD2")], reason: "declutter", orgId: ORG, actorUserId: ME });
    const a = seedDoc("mr", { status: "In Review" }); const b = seedDoc("mi");
    seedCopies("mr", ["u6"]);
    seedCopies("mi", ["u7"]);
    await mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "MX", title: "merged", assetTags: [], file: pdf("mx.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    await settle();
    expect(recallsFor("sd")).toHaveLength(1);
    expect(recallsFor("mr")).toHaveLength(1);
    expect(recallsFor("mi")).toHaveLength(1);
    const recalled = state.emits.filter((e) => e.kind === "doc_recalled");
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ title: "MI is now Superseded — your copy is dead paper", audience: { involved: ["u7"] } });
    expect(audit("DISTRIBUTION_RECALL")).toHaveLength(1);
    expect(audit("DISTRIBUTION_RECALL")[0].details).toMatchObject({ recipients: ["u7"] });
    expect(fyiFor("SD")).toHaveLength(1);
    expect(fyiFor("SD")[0]).toMatchObject({ title: "SD was retired (Superseded)", audience: { followers: true, exclude: [] } });
    expect(fyiFor("MR")).toHaveLength(1);
    expect(fyiFor("MR")[0]).toMatchObject({ audience: { followers: true, exclude: [] } });
    expect(fyiFor("MI")).toHaveLength(1);
    expect(fyiFor("MI")[0]).toMatchObject({ audience: { followers: true, exclude: ["u7"] } });
  });
});

// ─── fix pass 2: which prior status skips the recall ────────────────────
describe("PROD-17 (P26 fix pass 2) — skipsRetirementRecall", () => {
  it("only a Superseded or Archived prior skips; Void, a status not retired, and an unread status (null) recall", () => {
    expect(skipsRetirementRecall("Superseded")).toBe(true);
    expect(skipsRetirementRecall(" Archived ")).toBe(true);
    expect(skipsRetirementRecall("Void")).toBe(false);
    expect(skipsRetirementRecall(" Void ")).toBe(false);
    for (const s of ["Issued", "Draft", "In Review", "IFC", "", null, undefined]) expect(skipsRetirementRecall(s)).toBe(false);
  });
});

// ─── CENSUS (fix pass): one recall per retirement ───────────────────────
describe("PROD-17 (P26 fix pass) — census: who calls recallOnRetirement", () => {
  const ROOT = join(__dirname, "..", "..");
  function walk(dir: string, out: string[]): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }
  const sources = ["app", "components", "lib"].flatMap((d) => walk(join(ROOT, d), []));
  /** Call sites of `name(` per file, its own definition (`definition`) not counted. */
  const callSitesOf = (name: string, definition: RegExp): Record<string, number> => {
    const call = new RegExp(`\\b${name}\\(`, "g");
    const sites: Record<string, number> = {};
    for (const f of sources) {
      const code = readFileSync(f, "utf8");
      const n = (code.match(call) ?? []).length - (code.match(definition) ?? []).length;
      if (n > 0) sites[relative(ROOT, f).split("\\").join("/")] = n;
    }
    return sites;
  };
  const callSites = () => callSitesOf("recallOnRetirement", /export function recallOnRetirement\(/g);

  it("exactly the four doors: archiveDocument and changeDocumentStatus (lib/revisions.ts), the split, the merge", () => {
    expect(callSites()).toEqual({
      "lib/revisions.ts": 2,
      "lib/documentLifecycle/split.ts": 1,
      "lib/documentLifecycle/merge.ts": 1,
    });
  });

  it("fix pass 3: recallRetiredDocument is called directly only from lib/revisions.ts — once inside recallOnRetirement, once by supersedeDocument", () => {
    const direct = callSitesOf("recallRetiredDocument", /export async function recallRetiredDocument\(/g);
    expect(direct).toEqual({ "lib/revisions.ts": 2 });
    // and those two are the ones named: the forward in recallOnRetirement and supersede's own
    const revisions = readFileSync(join(ROOT, "lib/revisions.ts"), "utf8");
    const body = (fn: RegExp) => {
      const start = revisions.search(fn);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = revisions.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
      return revisions.slice(start, next < 0 ? undefined : start + 1 + next);
    };
    expect(body(/export function recallOnRetirement\(/).match(/\brecallRetiredDocument\(/g)).toHaveLength(1);
    expect(body(/export async function supersedeDocument\(/).match(/\brecallRetiredDocument\(/g)).toHaveLength(1);
  });

  it("the status editors call it nowhere (PROD-17 residual doors: the bulk editor's and the metadata editor's bare writes recall nothing)", () => {
    const bulk = readFileSync(join(ROOT, "components/documents/BulkEditModal.tsx"), "utf8");
    expect(bulk).not.toMatch(/recallOnRetirement|recallRetiredDocument/);
    const page = readFileSync(join(ROOT, "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
    expect(page).not.toMatch(/recallOnRetirement/);
  });
});
