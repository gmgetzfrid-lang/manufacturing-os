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
//     merging a document already retired (its status read fresh before the
//     write) recalls nothing again; a refused write recalls nothing; a
//     rolled-back split recalls nothing.
//   · CENSUS (fix pass): recallOnRetirement is called from exactly the four
//     doors above and nowhere else — the status editors (the library page,
//     BulkEditModal) are PROD-17 residual doors and do not call it, so a
//     door that later routes a retirement through changeDocumentStatus or
//     archiveDocument cannot also send a second recall unnoticed.

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

import { archiveDocument, supersedeDocument, changeDocumentStatus } from "@/lib/revisions";
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

  it("archiving a document already retired (Superseded, Void — read with the legal hold, just before the write) recalls nothing again; the archive itself is unchanged", async () => {
    for (const [id, status] of [["p104", "Superseded"], ["p105", "Void"]] as const) {
      const d = seedDoc(id, { status });
      await expect(archiveDocument({ doc: asRecord({ ...d, status: "Issued" }), reason: "tidy", orgId: ORG, actorUserId: ME })).resolves.toBeUndefined();
      expect(docRow(id).status).toBe("Archived");
    }
    expect(audit("ARCHIVE_DOC")).toHaveLength(2);
    await settle();
    expect(recall).not.toHaveBeenCalled();
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
      });
    });
  }

  it("a re-save of a document already retired (Void → Void, Archived → Void) recalls nothing again", async () => {
    seedDoc("s2", { status: "Void" });
    seedDoc("s3", { status: "Archived" });
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s2", toStatus: "Void", door: "metadata", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    expect(await changeDocumentStatus({ orgId: ORG, documentId: "s3", toStatus: "Void", door: "bulk", actorUserId: ME })).toEqual(NO_STATUS_ISSUE);
    await settle();
    expect(recall).not.toHaveBeenCalled();
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
    expect(recall.mock.calls[0][0]).toMatchObject({ documentId: "s6", docLabel: "S6", libraryId: LIB, newStatus: "Void" });
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
      }]);
    }
    expect(notifyPackagesOfRetirement).not.toHaveBeenCalled();
  });

  it("a source already retired before the split / merge (its status read fresh before the flip) is not recalled again; the live one is", async () => {
    const v = seedDoc("rv", { status: "Void" });
    const r = await splitDocument({ source: asRecord({ ...v, status: "Issued" }), libraryId: LIB, targets: [target("RV1"), target("RV2")], reason: "declutter", orgId: ORG, actorUserId: ME });
    expect(r.supersededSourceId).toBe("rv");
    const a = seedDoc("ra", { status: "Superseded" }); const b = seedDoc("rb");
    const m = await mergeDocuments({
      sources: [asRecord({ ...a, status: "Issued" }), asRecord(b)],
      target: { kind: "create_new", documentNumber: "R-NEW", title: "merged", assetTags: [], file: pdf("r.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    expect(m.supersededSourceIds.sort()).toEqual(["ra", "rb"]);
    await settle();
    expect(recallsFor("rv")).toHaveLength(0);
    expect(recallsFor("ra")).toHaveLength(0);
    expect(recallsFor("rb")).toHaveLength(1);
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
  const callSites = (): Record<string, number> => {
    const sites: Record<string, number> = {};
    for (const f of sources) {
      const code = readFileSync(f, "utf8");
      const n = (code.match(/\brecallOnRetirement\(/g) ?? []).length
        - (code.match(/export function recallOnRetirement\(/g) ?? []).length;
      if (n > 0) sites[relative(ROOT, f).split("\\").join("/")] = n;
    }
    return sites;
  };

  it("exactly the four doors: archiveDocument and changeDocumentStatus (lib/revisions.ts), the split, the merge", () => {
    expect(callSites()).toEqual({
      "lib/revisions.ts": 2,
      "lib/documentLifecycle/split.ts": 1,
      "lib/documentLifecycle/merge.ts": 1,
    });
  });

  it("the status editors call it nowhere (PROD-17 residual doors: the bulk editor's and the metadata editor's bare writes recall nothing)", () => {
    const bulk = readFileSync(join(ROOT, "components/documents/BulkEditModal.tsx"), "utf8");
    expect(bulk).not.toMatch(/recallOnRetirement|recallRetiredDocument/);
    const page = readFileSync(join(ROOT, "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
    expect(page).not.toMatch(/recallOnRetirement/);
  });
});
