// document-control Round G — P28 STATUS-DOOR REMAINDERS (notifications
// PROD-17's open doors, document-control DIST-16, notifications DELIV-17).
// Driven against the in-memory PostgREST (helpers/fakeSupabase) with the
// real lib/revisions.ts, lib/documentLifecycle/reverse.ts, lib/audit.ts and
// lib/staleCopies.ts — only the dispatcher's emit() is a spy.
//
//   · DELIV-17: recallRetiredDocument's download_audits read is checked and
//     retried once; a read that fails twice is logged (console.error) and
//     recorded as a recall that could not be computed (an unavailable
//     DISTRIBUTION_RECALL row), never the silent "nobody held a copy"; a
//     failure past the read is logged. REGRESSION: a read that succeeds sends
//     exactly today's recall, audit row and FYI.
//   · PROD-17 (the bulk doors): recallRetiredBatch sends each copy holder ONE
//     notice per apply, one DISTRIBUTION_RECALL per document, each
//     document's watchers their FYI; a one-document notice is
//     recallRetiredDocument's own, word for word; a never-issued document
//     recalls nobody.
//   · PROD-17 (a reversal's park): each parked sheet's retirement recall,
//     with the archive's rules.
//   · DIST-16: a restore (un-archive into an issue status, a reversed split
//     or merge, a status editor's put-back) sends the people the standing
//     retirement recall named ONE withdrawal (library_doc_revised — declared,
//     not compliance) naming the status and the recall's date, and records
//     it; nothing when no recall stands or the document is not back in force;
//     a record that cannot be read is logged and recorded, never guessed.
//   · supersede of a never-issued document recalls no copy holder (DEC-90 R1).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  roles: ["DocCtrl"] as string[],
  emits: [] as Array<Record<string, unknown>>,
  /** table → how many of its next plain reads fail (download_audits, audit_logs). */
  failReads: {} as Record<string, number>,
  /** table → its next plain reads THROW instead of answering. */
  throwReads: {} as Record<string, number>,
  /** kind → emit() rejects for it. */
  rejectKind: null as null | string,
  clock: 0,
}));

function wrap(table: string, inner: Record<string, (...a: unknown[]) => unknown>): unknown {
  let op = "select";
  const wrapper: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") {
        if (op === "select" && (state.throwReads[table] ?? 0) > 0) {
          state.throwReads[table] -= 1;
          return (_resolve: unknown, reject: (e: unknown) => void) => reject(new Error(`${table}: connection reset`));
        }
        if (op === "select" && (state.failReads[table] ?? 0) > 0) {
          state.failReads[table] -= 1;
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: `${table} read failed (503)` } });
        }
        return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => (inner.then as unknown as (a: unknown, b: unknown) => void)(resolve, reject);
      }
      return (...args: unknown[]) => {
        if (["update", "delete", "insert", "upsert"].includes(prop)) op = prop;
        if (prop === "maybeSingle" || prop === "single") return inner[prop](...args);
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
      // a database before the recorded doors (PGRST202): the direct writes
      rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
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
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/unitCodeClient", () => ({ requestUnitCodeDecode: vi.fn(async () => ({ note: null })) }));
vi.mock("@/lib/notify/dispatch", () => ({
  emit: vi.fn((p: Record<string, unknown>) => {
    state.emits.push(p);
    return state.rejectKind === p.kind ? Promise.reject(new Error("dispatch down")) : Promise.resolve();
  }),
}));

import { archiveDocument, unarchiveDocument, supersedeDocument, changeDocumentStatus } from "@/lib/revisions";
import { reverseSplit, reverseMerge } from "@/lib/documentLifecycle/reverse";
import { recallRetiredDocument, recallRetiredBatch, withdrawRetirementRecall, withdrawRetirementBatch } from "@/lib/staleCopies";
import { KIND_META } from "@/lib/notificationKinds";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const T = (t: string) => (state.db.tables[t] ??= []);
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const recallRows = () => audit("DISTRIBUTION_RECALL").map((r) => r.details as Record<string, unknown>);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const kinds = () => state.emits.map((e) => e.kind);
const ofKind = (k: string) => state.emits.filter((e) => e.kind === k);
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 1)); };

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: LIB, document_number: id.toUpperCase(), title: id, rev: "3", revision: "3",
    status: "Issued", current_version_id: `${id}-v3`, pending_version_id: null, checked_out_by: null, checked_out_by_name: null,
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`, legal_hold: false,
    ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null });
  return d;
}
const seedCopies = (docId: string, users: string[]) => {
  for (const u of users) T("download_audits").push({ document_id: docId, user_id: u, version_id: `${docId}-v3`, created_at: new Date().toISOString() });
};
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: LIB, documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id, collectionId: null,
}) as unknown as DocumentRecord;
const base = { orgId: ORG, libraryId: LIB, actorUserId: ME, actorName: "dana@x" };

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.roles = ["DocCtrl"];
  state.emits = [];
  state.failReads = {};
  state.throwReads = {};
  state.rejectKind = null;
  state.clock = 0;
  // the audit trail's timestamp column (a database default): strictly increasing, so "newest first" is defined
  state.db.beforeInsert!.audit_logs = (row) => ({ ...row, timestamp: row.timestamp ?? new Date(Date.UTC(2026, 9, 20, 8, 0, state.clock++)).toISOString() });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); warnSpy.mockRestore(); });

// ─── DELIV-17 ─────────────────────────────────────────────────────────────
describe("DELIV-17 — a retirement recall whose copy-holder read fails is never silent", () => {
  const input = { ...base, documentId: "d1", docLabel: "P-101", newStatus: "Archived", replacementNote: null };

  it("REGRESSION: a read that succeeds sends exactly today's recall, its audit row, then the watchers' FYI", async () => {
    seedCopies("d1", ["u3", "u4", "u3", ME]);
    expect(await recallRetiredDocument(input)).toBe(2);
    expect(kinds()).toEqual(["doc_recalled", "doc_retired"]);
    expect(state.emits[0]).toEqual({
      orgId: ORG, category: "recall", kind: "doc_recalled",
      title: "P-101 is now Archived — your copy is dead paper",
      body: "This document was retired (archived); there is no current revision to work from. Stop any work based on your copy and destroy old prints.",
      link: `/documents/${LIB}?doc=d1`, resource: { type: "document", id: "d1" },
      actorUserId: ME, actorName: "dana@x", audience: { involved: ["u3", "u4"] },
      metadata: { recall: true, retirement: true, newStatus: "Archived" },
    });
    expect(recallRows()).toEqual([{ retirement: true, newStatus: "Archived", recipientCount: 2, recipients: ["u3", "u4"], versionId: "" }]);
    expect(state.emits[1]).toMatchObject({ kind: "doc_retired", category: "watched", audience: { followers: true, exclude: ["u3", "u4"] }, emailOnlyWithBell: true });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a read that fails twice: logged as an error, recorded as a recall that could not be computed, no doc_recalled — the watchers' FYI still goes", async () => {
    seedCopies("d1", ["u3"]);
    state.failReads.download_audits = 2;
    expect(await recallRetiredDocument(input)).toBe(0);
    expect(kinds()).toEqual(["doc_retired"]);
    expect(ofKind("doc_retired")[0]).toMatchObject({ audience: { followers: true, exclude: [] } });
    expect(recallRows()).toEqual([{
      retirement: true, newStatus: "Archived", recipientCount: 0, recipients: [], unavailable: true,
      readError: "download_audits read failed (503)", versionId: "",
    }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/DELIV-17: the copy holders of document d1 could not be read.*retrying once/);
    expect(errorSpy.mock.calls.some((c: unknown[]) => /DELIV-17: the retirement recall of document d1 \(Archived\) could not be computed/.test(String(c[0])))).toBe(true);
  });

  it("a read that THROWS twice is the same: logged and recorded unavailable", async () => {
    state.throwReads.download_audits = 2;
    expect(await recallRetiredDocument(input)).toBe(0);
    expect(recallRows()[0]).toMatchObject({ unavailable: true, readError: "download_audits: connection reset" });
    expect(ofKind("doc_recalled")).toHaveLength(0);
  });

  it("a read that fails once and succeeds on the retry recalls the holders exactly once", async () => {
    seedCopies("d1", ["u3", "u4"]);
    state.failReads.download_audits = 1;
    expect(await recallRetiredDocument(input)).toBe(2);
    expect(ofKind("doc_recalled")).toHaveLength(1);
    expect(ofKind("doc_recalled")[0]).toMatchObject({ audience: { involved: ["u3", "u4"] } });
    expect(recallRows()).toHaveLength(1);
    expect(recallRows()[0]).toMatchObject({ recipients: ["u3", "u4"] });
    expect(recallRows()[0]).not.toHaveProperty("unavailable");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("a failure past the read (the recall's dispatch rejects) is logged, never a silent 0", async () => {
    seedCopies("d1", ["u3"]);
    state.rejectKind = "doc_recalled";
    expect(await recallRetiredDocument(input)).toBe(0);
    expect(errorSpy.mock.calls.some((c: unknown[]) => /DELIV-17: the retirement recall of document d1 \(Archived\) failed part-way/.test(String(c[0])))).toBe(true);
  });

  it("a never-issued document (recallCopyHolders: false) reads no copy holder at all — no retry, no unavailable row", async () => {
    state.failReads.download_audits = 5;
    await recallRetiredDocument({ ...input, recallCopyHolders: false });
    expect(state.failReads.download_audits).toBe(5);
    expect(recallRows()).toEqual([]);
    expect(kinds()).toEqual(["doc_retired"]);
  });
});

// ─── PROD-17: the bulk doors' batched recall ────────────────────────────
describe("PROD-17 (P28) — the bulk doors: one recall per holder per apply", () => {
  it("a holder of two archived documents gets ONE notice naming both; a holder of one gets recallRetiredDocument's notice word for word; each document its own record and FYI", async () => {
    seedCopies("b1", ["u3", "u4"]);
    seedCopies("b2", ["u3"]);
    const n = await recallRetiredBatch({
      orgId: ORG, newStatus: "Archived", actorUserId: ME, actorName: "dana@x",
      docs: [
        { documentId: "b1", libraryId: LIB, docLabel: "B-1", recallCopyHolders: true },
        { documentId: "b2", libraryId: LIB, docLabel: "B-2", recallCopyHolders: true },
      ],
    });
    expect(n).toBe(2);
    const recalls = ofKind("doc_recalled");
    expect(recalls).toHaveLength(2);
    const batched = recalls.find((e) => (e.audience as { involved: string[] }).involved.includes("u3"))!;
    expect(batched).toMatchObject({
      category: "recall", title: "2 documents you hold copies of are now Archived — your copies are dead paper",
      audience: { involved: ["u3"] }, resource: { type: "library", id: LIB }, link: `/documents/${LIB}`,
      metadata: { recall: true, retirement: true, newStatus: "Archived", documentIds: ["b1", "b2"] },
    });
    expect(String(batched.body)).toContain("B-1, B-2");
    const single = recalls.find((e) => (e.audience as { involved: string[] }).involved.includes("u4"))!;
    // the same notice the single-document door sends
    const ref = state.emits.length;
    state.db.tables.download_audits = [];
    seedCopies("b1", ["u4"]);
    await recallRetiredDocument({ ...base, documentId: "b1", docLabel: "B-1", newStatus: "Archived", replacementNote: null });
    expect(single).toEqual(state.emits[ref]);
    // one DISTRIBUTION_RECALL per document (before the reference run's), then each document's FYI minus its holders
    const rows = recallRows().slice(0, 2);
    expect(rows).toEqual([
      { retirement: true, newStatus: "Archived", recipientCount: 2, recipients: ["u3", "u4"], batch: true, versionId: "" },
      { retirement: true, newStatus: "Archived", recipientCount: 1, recipients: ["u3"], batch: true, versionId: "" },
    ]);
    const fyis = state.emits.slice(0, ref).filter((e) => e.kind === "doc_retired");
    expect(fyis.map((e) => [e.title, (e.audience as { exclude: string[] }).exclude])).toEqual([
      ["B-1 was retired (Archived)", ["u3", "u4"]],
      ["B-2 was retired (Archived)", ["u3"]],
    ]);
    // every recall and record before any FYI
    expect(state.emits.slice(0, ref).map((e) => e.kind)).toEqual(["doc_recalled", "doc_recalled", "doc_retired", "doc_retired"]);
  });

  it("a never-issued row recalls nobody (DEC-90 R1); a row whose holders cannot be read is recorded unavailable; the others are recalled", async () => {
    seedCopies("n1", ["u3"]);
    seedCopies("n2", ["u5"]);
    seedCopies("n3", ["u6"]);
    // n2's read fails twice (the batch reads n2 first: n1 is never-issued, not read)
    state.failReads.download_audits = 2;
    await recallRetiredBatch({
      orgId: ORG, newStatus: "Superseded", actorUserId: ME,
      docs: [
        { documentId: "n1", libraryId: LIB, docLabel: "N-1", recallCopyHolders: false },
        { documentId: "n2", libraryId: LIB, docLabel: "N-2", recallCopyHolders: true },
        { documentId: "n3", libraryId: LIB, docLabel: "N-3", recallCopyHolders: true },
      ],
    });
    expect(ofKind("doc_recalled").map((e) => (e.audience as { involved: string[] }).involved)).toEqual([["u6"]]);
    const rows = audit("DISTRIBUTION_RECALL");
    expect(rows.map((r) => [r.resource_id, (r.details as Record<string, unknown>).unavailable ?? false])).toEqual([["n2", true], ["n3", false]]);
    expect(ofKind("doc_retired")).toHaveLength(3);
  });
});

// ─── DIST-16: a restore withdraws the recall ───────────────────────────
describe("DIST-16 — a restore withdraws the retirement recall standing on the document", () => {
  it("archive then un-archive as Issued: the copy holders get ONE withdrawal (a declared, non-compliance kind) naming the status and the recall's date; it is recorded; the un-archive returns as before", async () => {
    const d = seedDoc("p101");
    seedCopies("p101", ["u3", "u4"]);
    await archiveDocument({ doc: asRecord(d), reason: "by mistake", orgId: ORG, actorUserId: ME, actorEmail: "dana@x" });
    await settle();
    expect(kinds()).toEqual(["doc_recalled", "doc_retired"]);
    const out = await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "oops", orgId: ORG, actorUserId: ME, actorEmail: "dana@x", restoreStatus: "Issued" });
    expect(out).toMatchObject({ issued: true });
    expect(docRow("p101").status).toBe("Issued");
    await settle();
    const w = ofKind("library_doc_revised");
    expect(w).toHaveLength(1);
    const recallAt = String(audit("DISTRIBUTION_RECALL")[0].timestamp).slice(0, 10);
    expect(w[0]).toMatchObject({
      category: "recall", resource: { type: "document", id: "p101" }, link: `/documents/${LIB}?doc=p101`,
      title: `P101 is back in force (Issued) — the recall of ${recallAt} (UTC) is withdrawn`,
      audience: { involved: ["u3", "u4"] }, actorUserId: ME,
      metadata: { recallWithdrawn: true, restoredStatus: "Issued", door: "unarchive" },
    });
    expect(String(w[0].body)).toMatch(/is withdrawn: the document is current again/);
    // P28 fix pass: the recall is named by the bell title the holder has
    expect(String(w[0].body)).toContain(`The notice of ${recallAt} (UTC) ("P101 is now Archived — your copy is dead paper") telling you to stop work`);
    expect(KIND_META.library_doc_revised.compliance).toBe(false);
    expect(KIND_META.library_doc_revised.actionRequired).toBe(false);
    expect(recallRows()[1]).toMatchObject({ recallWithdrawn: true, retirement: false, restoredStatus: "Issued", door: "unarchive", recipientCount: 2, recipients: ["u3", "u4"] });
  });

  it("no recall on record (a Draft archived: watchers only) — the un-archive sends no withdrawal", async () => {
    const d = seedDoc("dr", { status: "Draft" });
    seedCopies("dr", ["u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "y", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    await settle();
    expect(ofKind("doc_recalled")).toHaveLength(0);
    expect(ofKind("library_doc_revised")).toHaveLength(0);
  });

  it("an un-archive into Draft is not back in force: the recall stands, nothing is withdrawn", async () => {
    const d = seedDoc("p2");
    seedCopies("p2", ["u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "y", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    await settle();
    expect(ofKind("library_doc_revised")).toHaveLength(0);
  });

  it("a second archive / un-archive withdraws only the recall that stands since the first withdrawal", async () => {
    const d = seedDoc("p3");
    seedCopies("p3", ["u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "1", orgId: ORG, actorUserId: ME });
    await settle();
    await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "1", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    await settle();
    seedCopies("p3", ["u7"]);
    await archiveDocument({ doc: asRecord({ ...d, status: "Issued" }), reason: "2", orgId: ORG, actorUserId: ME });
    await settle();
    await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "2", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    await settle();
    expect(ofKind("library_doc_revised").map((e) => (e.audience as { involved: string[] }).involved)).toEqual([["u3"], ["u3", "u7"]]);
    // and a third un-archive-like put-back with nothing standing sends nothing
    await withdrawRetirementRecall({ orgId: ORG, documentId: "p3", restoredStatus: "Issued", door: "put_back", actorUserId: ME });
    expect(ofKind("library_doc_revised")).toHaveLength(2);
  });

  it("a status editor's put-back (Archived → Issued through changeDocumentStatus) withdraws; a re-save of an issued document does not", async () => {
    const d = seedDoc("p4");
    seedCopies("p4", ["u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    await changeDocumentStatus({ orgId: ORG, documentId: "p4", toStatus: "Issued", door: "metadata", actorUserId: ME, actorEmail: "dana@x" });
    await settle();
    expect(ofKind("library_doc_revised")).toHaveLength(1);
    expect(ofKind("library_doc_revised")[0]).toMatchObject({ metadata: { door: "put_back", restoredStatus: "Issued" }, audience: { involved: ["u3"] } });
    await changeDocumentStatus({ orgId: ORG, documentId: "p4", toStatus: "Issued", door: "metadata", actorUserId: ME });
    await settle();
    expect(ofKind("library_doc_revised")).toHaveLength(1);
  });

  it("supersede's recall is withdrawn by a put-back too", async () => {
    const a = seedDoc("s1"); seedDoc("s2");
    seedCopies("s1", ["u8"]);
    await supersedeDocument({ doc: asRecord(a), replacementDocNumbers: ["S2"], libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME });
    await settle();
    expect(ofKind("doc_recalled")).toHaveLength(1);
    await changeDocumentStatus({ orgId: ORG, documentId: "s1", toStatus: "Issued", door: "metadata", actorUserId: ME });
    await settle();
    expect(ofKind("library_doc_revised").map((e) => (e.audience as { involved: string[] }).involved)).toEqual([["u8"]]);
  });

  it("the recall record cannot be read: logged, recorded as a withdrawal that could not be computed, no notice — and the next restore still finds the recall", async () => {
    const d = seedDoc("p5");
    seedCopies("p5", ["u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    state.failReads.audit_logs = 1;
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "p5", restoredStatus: "Issued", door: "unarchive", actorUserId: ME })).toBe(0);
    expect(ofKind("library_doc_revised")).toHaveLength(0);
    expect(errorSpy.mock.calls.some((c: unknown[]) => /DIST-16: the recall record of document p5 could not be read/.test(String(c[0])))).toBe(true);
    expect(recallRows()[1]).toMatchObject({ withdrawalUnavailable: true, retirement: false });
    expect(recallRows()[1]).not.toHaveProperty("recallWithdrawn");
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "p5", restoredStatus: "Issued", door: "unarchive", actorUserId: ME })).toBe(1);
  });

  it("DIST-16 done-when 3: a Void that a recalled status change set, archived later, sends no second copy-holder recall (its watchers are told of each retirement)", async () => {
    seedDoc("v9");
    seedCopies("v9", ["u3"]);
    await changeDocumentStatus({ orgId: ORG, documentId: "v9", toStatus: "Void", door: "metadata", actorUserId: ME });
    await settle();
    await archiveDocument({ doc: asRecord({ ...docRow("v9"), status: "Void" }), reason: "tidy", orgId: ORG, actorUserId: ME });
    await settle();
    expect(ofKind("doc_recalled")).toHaveLength(1);
    expect(audit("DISTRIBUTION_RECALL")).toHaveLength(1);
    expect(ofKind("doc_retired").map((e) => e.title)).toEqual(["V9 was retired (Void)", "V9 was retired (Archived)"]);
  });

  it("an unavailable recall row (DELIV-17) names nobody, so nobody is sent a withdrawal for it", async () => {
    seedDoc("p6");
    state.failReads.download_audits = 2;
    await recallRetiredDocument({ ...base, documentId: "p6", docLabel: "P6", newStatus: "Archived", replacementNote: null });
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "p6", restoredStatus: "Issued", door: "unarchive", actorUserId: ME })).toBe(0);
    expect(ofKind("library_doc_revised")).toHaveLength(0);
  });

  it("P28 fix pass: archive, un-archive into Draft (nothing withdrawn), then a status editor saves it Issued — the recall is withdrawn then", async () => {
    const d = seedDoc("dr2");
    seedCopies("dr2", ["u3", "u4"]);
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "y", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    await settle();
    expect(ofKind("library_doc_revised")).toHaveLength(0);
    expect(docRow("dr2").status).toBe("Draft");
    await changeDocumentStatus({ orgId: ORG, documentId: "dr2", toStatus: "Issued", door: "metadata", actorUserId: ME, actorEmail: "dana@x" });
    await settle();
    const w = ofKind("library_doc_revised");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ audience: { involved: ["u3", "u4"] }, metadata: { recallWithdrawn: true, restoredStatus: "Issued", door: "put_back" } });
    // and a Draft → Issued with no recall on record sends nothing
    seedDoc("dr3", { status: "Draft" });
    await changeDocumentStatus({ orgId: ORG, documentId: "dr3", toStatus: "Issued", door: "metadata", actorUserId: ME });
    await settle();
    expect(ofKind("library_doc_revised")).toHaveLength(1);
  });

  it("P28 fix pass: changeDocumentStatus with withdrawRecall: false (the bulk editor) starts no withdrawal of its own", async () => {
    const d = seedDoc("wf");
    seedCopies("wf", ["u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    await changeDocumentStatus({ orgId: ORG, documentId: "wf", toStatus: "Issued", door: "bulk", actorUserId: ME, withdrawRecall: false });
    await settle();
    expect(ofKind("library_doc_revised")).toHaveLength(0);
  });

  it("P28 fix pass: the recall's date is the workspace's day — a recall at 00:30 UTC on the 21st reads as the 20th in America/Chicago, the zone named", async () => {
    seedDoc("tz1");
    seedCopies("tz1", ["u3"]);
    T("org_configurations").push({ id: "c1", org_id: ORG, key: "timezone", data: { timeZone: "America/Chicago" } });
    T("audit_logs").push({ id: "a-tz", org_id: ORG, action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: "tz1", timestamp: "2026-10-21T00:30:00.000Z", details: { retirement: true, newStatus: "Archived", recipientCount: 1, recipients: ["u3"] } });
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "tz1", docLabel: "TZ-1", libraryId: LIB, restoredStatus: "Issued", door: "unarchive", actorUserId: ME })).toBe(1);
    const w = ofKind("library_doc_revised")[0];
    expect(w.title).toBe("TZ-1 is back in force (Issued) — the recall of 2026-10-20 (America/Chicago) is withdrawn");
    expect(String(w.body)).toContain('The notice of 2026-10-20 (America/Chicago) ("TZ-1 is now Archived — your copy is dead paper")');
  });
});

// ─── DIST-16 (P28 second fix pass): a forged recall row drives nothing ─────
describe("DIST-16 (P28 second fix pass) — the withdrawal believes a recall row only as far as the download record bears it out", () => {
  const forge = (docId: string, details: Record<string, unknown>, at = "2026-10-19T09:00:00.000Z") =>
    T("audit_logs").push({ id: `f-${docId}-${at}`, org_id: ORG, user_id: "u9", action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: docId, timestamp: at, details });

  it("a member-inserted row naming every member, with free text as its status: an ordinary first issue (Draft → Issued) sends nothing, and the row is logged as not a recall", async () => {
    seedDoc("fg1", { status: "Draft" });
    seedCopies("fg1", ["u3"]);                    // one real puller; the row names others too
    forge("fg1", { retirement: true, recipients: ["u3", "u10", "u11", "u12"], newStatus: "Archived. Urgent: re-download from http://evil.example" });
    await changeDocumentStatus({ orgId: ORG, documentId: "fg1", toStatus: "Issued", door: "metadata", actorUserId: ME, actorEmail: "dana@x" });
    await settle();
    expect(docRow("fg1").status).toBe("Issued");
    expect(ofKind("library_doc_revised")).toHaveLength(0);
    expect(recallRows().some((d) => d.recallWithdrawn === true)).toBe(false);
    expect(warnSpy.mock.calls.some((c: unknown[]) => /DIST-16: a DISTRIBUTION_RECALL row on document fg1 .* names people with no download of it on record/.test(String(c[0])))).toBe(true);
  });

  it("a row naming only real pullers but carrying a non-retired status: the status is never quoted — no free text from the row reaches the notice", async () => {
    seedDoc("fg2");
    seedCopies("fg2", ["u3"]);
    forge("fg2", { retirement: true, recipients: ["u3"], newStatus: "Archived. Urgent: re-download from http://evil.example" });
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "fg2", docLabel: "FG-2", libraryId: LIB, restoredStatus: "Issued", door: "put_back", actorUserId: ME })).toBe(1);
    const w = ofKind("library_doc_revised")[0];
    expect(JSON.stringify(w)).not.toContain("evil.example");
    expect(String(w.body)).not.toContain("your copy is dead paper");
    expect(String(w.body)).toContain("The notice of 2026-10-19 (UTC) telling you to stop work");
  });

  it("a real recall and a later forged row naming a non-puller: only the real recall's people are told, dated by the real recall", async () => {
    const d = seedDoc("fg3");
    seedCopies("fg3", ["u3", "u4"]);
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    const realAt = String(audit("DISTRIBUTION_RECALL")[0].timestamp);
    forge("fg3", { retirement: true, recipients: ["u3", "u66"], newStatus: "Void" }, "2026-10-20T23:00:00.000Z");
    await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "y", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    await settle();
    const w = ofKind("library_doc_revised");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ audience: { involved: ["u3", "u4"] }, metadata: { withdrawsRecallAt: realAt } });
    expect(String(w[0].body)).toContain('("FG3 is now Archived — your copy is dead paper")');
  });

  it("the download record cannot be read: logged, recorded as a withdrawal that could not be computed, nobody told", async () => {
    seedDoc("fg4");
    seedCopies("fg4", ["u3"]);
    forge("fg4", { retirement: true, recipients: ["u3"], newStatus: "Archived" });
    state.failReads.download_audits = 1;
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "fg4", restoredStatus: "Issued", door: "unarchive", actorUserId: ME })).toBe(0);
    expect(ofKind("library_doc_revised")).toHaveLength(0);
    expect(errorSpy.mock.calls.some((c: unknown[]) => /DIST-16: the recall record of document fg4 could not be read.*download record could not be read/.test(String(c[0])))).toBe(true);
    expect(recallRows()[recallRows().length - 1]).toMatchObject({ withdrawalUnavailable: true });
  });

  it("a real recall naming 60 holders is read back in chunks under the gateway's in-list limit: all 60 are told", async () => {
    state.db.maxInList = 25;
    seedDoc("fg5");
    const many = Array.from({ length: 60 }, (_, i) => `h${i}`);
    seedCopies("fg5", many);
    forge("fg5", { retirement: true, recipients: many, newStatus: "Archived" });
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "fg5", restoredStatus: "Issued", door: "unarchive", actorUserId: ME })).toBe(60);
    expect((ofKind("library_doc_revised")[0].audience as { involved: string[] }).involved).toHaveLength(60);
  });

  it("RESIDUAL (recorded on DIST-16): a forged recallWithdrawn row still ends the read — it can only suppress a withdrawal, never send one", async () => {
    const d = seedDoc("fg6");
    seedCopies("fg6", ["u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    forge("fg6", { recallWithdrawn: true, retirement: false, recipients: [] }, "2026-10-20T23:00:00.000Z");
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "fg6", restoredStatus: "Issued", door: "unarchive", actorUserId: ME })).toBe(0);
    expect(ofKind("library_doc_revised")).toHaveLength(0);
  });

  it("the bulk batch reads through the same check: a forged row on one document sends nothing for it; the real one still goes", async () => {
    seedDoc("fg7"); seedDoc("fg8");
    seedCopies("fg7", ["u3"]); seedCopies("fg8", ["u4"]);
    forge("fg7", { retirement: true, recipients: ["u3", "u99"], newStatus: "Archived" });
    forge("fg8", { retirement: true, recipients: ["u4"], newStatus: "Archived" });
    expect(await withdrawRetirementBatch({ orgId: ORG, door: "put_back", actorUserId: ME, docs: [
      { documentId: "fg7", docLabel: "FG-7", restoredStatus: "Issued" },
      { documentId: "fg8", docLabel: "FG-8", restoredStatus: "Issued" },
    ] })).toBe(1);
    expect(ofKind("library_doc_revised").map((e) => (e.audience as { involved: string[] }).involved)).toEqual([["u4"]]);
  });
});

// ─── DIST-16 (P28 fix pass): a BULK put-back withdraws once per apply ──────
describe("DIST-16 (P28 fix pass) — withdrawRetirementBatch: one notice per person per apply, one record per document", () => {
  // a recall this system wrote names only people the document's download record names
  const recall = (docId: string, users: string[], at: string) => {
    seedCopies(docId, users);
    T("audit_logs").push({ id: `a-${docId}-${at}`, org_id: ORG, action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: docId, timestamp: at, details: { retirement: true, newStatus: "Archived", recipientCount: users.length, recipients: users } });
  };

  it("two restored documents, one person recalled on both and one on one: the first gets ONE notice naming both, the second the single door's notice word for word; each document gets its recallWithdrawn row", async () => {
    seedDoc("b1"); seedDoc("b2");
    recall("b1", ["u3", "u4"], "2026-10-19T09:00:00.000Z");
    recall("b2", ["u3"], "2026-10-19T09:00:01.000Z");
    const n = await withdrawRetirementBatch({
      orgId: ORG, door: "put_back", actorUserId: ME, actorName: "dana@x",
      docs: [
        { documentId: "b1", libraryId: LIB, docLabel: "B-1", restoredStatus: "Issued" },
        { documentId: "b2", libraryId: LIB, docLabel: "B-2", restoredStatus: "Issued" },
      ],
    });
    expect(n).toBe(2);
    const w = ofKind("library_doc_revised");
    expect(w).toHaveLength(2);
    const both = w.find((e) => (e.audience as { involved: string[] }).involved.includes("u3"))!;
    expect(both).toMatchObject({
      category: "recall", title: "2 documents you were recalled on are back in force — the recalls are withdrawn",
      audience: { involved: ["u3"] }, resource: { type: "library", id: LIB }, link: `/documents/${LIB}`,
      metadata: { recallWithdrawn: true, documentIds: ["b1", "b2"], door: "put_back" },
    });
    expect(String(both.body)).toContain("B-1 (Issued), B-2 (Issued)");
    const single = w.find((e) => (e.audience as { involved: string[] }).involved.includes("u4"))!;
    expect(single).toMatchObject({ title: "B-1 is back in force (Issued) — the recall of 2026-10-19 (UTC) is withdrawn", audience: { involved: ["u4"] }, resource: { type: "document", id: "b1" } });
    const rows = audit("DISTRIBUTION_RECALL").filter((r) => (r.details as Record<string, unknown>).recallWithdrawn === true);
    expect(rows.map((r) => [r.resource_id, (r.details as Record<string, unknown>).recipients, (r.details as Record<string, unknown>).batch])).toEqual([
      ["b1", ["u3", "u4"], true], ["b2", ["u3"], true],
    ]);
    // the next restore finds nothing standing
    expect(await withdrawRetirementRecall({ orgId: ORG, documentId: "b1", restoredStatus: "Issued", door: "put_back", actorUserId: ME })).toBe(0);
  });

  it("a document with no recall standing, or not in an issue status, sends nothing; a record that cannot be read is logged and recorded, the others still go", async () => {
    seedDoc("c1"); seedDoc("c2"); seedDoc("c3");
    recall("c2", ["u5"], "2026-10-19T09:00:00.000Z");
    expect(await withdrawRetirementBatch({ orgId: ORG, door: "put_back", actorUserId: ME, docs: [
      { documentId: "c1", docLabel: "C-1", restoredStatus: "Issued" },
      { documentId: "c2", docLabel: "C-2", restoredStatus: "Draft" },
    ] })).toBe(0);
    expect(ofKind("library_doc_revised")).toHaveLength(0);
    recall("c3", ["u6"], "2026-10-19T09:00:02.000Z");
    state.failReads.audit_logs = 1;
    expect(await withdrawRetirementBatch({ orgId: ORG, door: "put_back", actorUserId: ME, docs: [
      { documentId: "c2", docLabel: "C-2", restoredStatus: "Issued" },
      { documentId: "c3", docLabel: "C-3", restoredStatus: "Issued" },
    ] })).toBe(1);
    expect(errorSpy.mock.calls.some((c: unknown[]) => /DIST-16: the recall record of document c2 could not be read/.test(String(c[0])))).toBe(true);
    expect(ofKind("library_doc_revised").map((e) => (e.audience as { involved: string[] }).involved)).toEqual([["u6"]]);
    const c2rows = audit("DISTRIBUTION_RECALL").filter((r) => r.resource_id === "c2").map((r) => r.details as Record<string, unknown>);
    expect(c2rows[c2rows.length - 1]).toMatchObject({ withdrawalUnavailable: true, batch: true });
  });
});

// ─── the reversal doors ─────────────────────────────────────────────────
function seedSplit(prefix: string, sheetStatus = "Issued") {
  seedDoc(prefix, { status: "Superseded", superseded_at: "2026-09-01T10:00:00Z", supersession_reason: "split", retired_issue_status: "Issued", retired_issue_version_id: `${prefix}-v3` });
  for (const x of ["a", "b"]) seedDoc(`${prefix}${x}`, { status: sheetStatus });
  T("document_supersessions").push(
    { id: `l-${prefix}a`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}a`, reason: "split", created_by: ME, created_at: "2026-09-01T10:00:00Z" },
    { id: `l-${prefix}b`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}b`, reason: "split", created_by: ME, created_at: "2026-09-01T10:00:00Z" },
  );
  // the split's own recall of the source's copy holders (P26), on its record
  seedCopies(prefix, ["u3"]);
  T("audit_logs").push({ id: `rc-${prefix}`, action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: prefix, org_id: ORG, timestamp: "2026-09-01T10:00:01Z", details: { retirement: true, newStatus: "Superseded", recipientCount: 1, recipients: ["u3"] } });
  T("audit_logs").push({ id: `ev-${prefix}`, action: "DOC_SPLIT", resource_type: "document", resource_id: prefix, org_id: ORG, timestamp: "2026-09-01T10:00:00Z", details: { replacementDocIds: [`${prefix}a`, `${prefix}b`], priorStatus: "Issued", auditAt: "2026-09-01T10:00:00Z" } });
}

describe("PROD-17 + DIST-16 — a reversed split: the parked sheets are retired with their recall; the restored source's recall is withdrawn", () => {
  it("each parked Issued sheet: its copy holders recalled and its watchers told (Superseded, the reversal named); the source's split recall withdrawn as it comes back Issued; the reversal returns as before", async () => {
    seedSplit("k");
    seedCopies("ka", ["u5"]);
    const out = await reverseSplit({ splitAuditEventId: "ev-k", reason: "wrong split", orgId: ORG, actorUserId: ME, actorEmail: "dana@x" });
    expect(out).toMatchObject({ reversedDocIds: ["ka", "kb"], preservedAsSuperseded: 2 });
    expect(docRow("k").status).toBe("Issued");
    for (const s of ["ka", "kb"]) expect(docRow(s).status).toBe("Superseded");
    await settle();
    const recalled = ofKind("doc_recalled");
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ title: "KA is now Superseded — your copy is dead paper", audience: { involved: ["u5"] } });
    expect(String(recalled[0].body)).toContain("The split that created it was reversed.");
    expect(ofKind("doc_retired").map((e) => e.title).sort()).toEqual(["KA was retired (Superseded)", "KB was retired (Superseded)"]);
    const w = ofKind("library_doc_revised");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ resource: { id: "k" }, audience: { involved: ["u3"] }, metadata: { door: "split_reversed", restoredStatus: "Issued" } });
  });

  it("a parked sheet still in Draft gets its watchers' FYI and recalls no copy holder (DEC-90 R1)", async () => {
    seedSplit("q", "Draft");
    seedCopies("qa", ["u5"]);
    await reverseSplit({ splitAuditEventId: "ev-q", reason: "r", orgId: ORG, actorUserId: ME });
    await settle();
    expect(ofKind("doc_recalled")).toHaveLength(0);
    expect(ofKind("doc_retired")).toHaveLength(2);
  });

  it("a refused reversal (a restore that clashes) parks nothing and sends nothing", async () => {
    seedSplit("z");
    seedDoc("zlive", { uniqueness_key: "z-key" });     // a live document now carries the source's key
    await expect(reverseSplit({ splitAuditEventId: "ev-z", reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/Cannot reverse/);
    await settle();
    expect(state.emits).toEqual([]);
  });
});

describe("DIST-16 — a reversed merge withdraws each restored source's recall", () => {
  it("both sources come back Issued: the holders of each source's merge recall get its withdrawal; the parked new target is retired", async () => {
    for (const s of ["m1", "m2"]) seedDoc(s, { status: "Superseded" });
    seedDoc("mt");
    T("document_supersessions").push(
      { id: "l-m1", org_id: ORG, superseded_doc_id: "m1", replacement_doc_id: "mt", created_by: ME },
      { id: "l-m2", org_id: ORG, superseded_doc_id: "m2", replacement_doc_id: "mt", created_by: ME },
    );
    seedCopies("m1", ["u3"]);
    T("audit_logs").push({ id: "rc-m1", action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: "m1", org_id: ORG, timestamp: "2026-09-03T00:00:01Z", details: { retirement: true, newStatus: "Superseded", recipientCount: 1, recipients: ["u3"] } });
    T("audit_logs").push({ id: "ev-m", action: "DOC_MERGED", resource_type: "document", resource_id: "m1", org_id: ORG, timestamp: "2026-09-03T00:00:00Z", details: { mergedIntoDocumentId: "mt", mergeSiblings: ["m1", "m2"], targetWasNewlyCreated: true, priorStatuses: { m1: "Issued", m2: "Issued" }, auditAt: "2026-09-03T00:00:00Z" } });
    await reverseMerge({ mergeAuditEventId: "ev-m", reason: "wrong merge", orgId: ORG, actorUserId: ME });
    await settle();
    expect(ofKind("library_doc_revised").map((e) => [(e.resource as { id: string }).id, (e.audience as { involved: string[] }).involved])).toEqual([["m1", ["u3"]]]);
    expect(ofKind("doc_retired").map((e) => e.title)).toEqual(["MT was retired (Superseded)"]);
  });
});

// ─── supersede of a never-issued document (DEC-90 R1 at the P26 merge) ──
describe("PROD-17 (P28) — supersede recalls copy holders only for a document that was issued", () => {
  it("a Draft superseded: the watchers' FYI only — no doc_recalled, no DISTRIBUTION_RECALL; an Issued one recalls as before", async () => {
    const dr = seedDoc("dd", { status: "Draft" }); seedDoc("dd2");
    const is = seedDoc("ii"); seedDoc("ii2");
    seedCopies("dd", ["u3"]);
    seedCopies("ii", ["u4"]);
    await supersedeDocument({ doc: asRecord(dr), replacementDocNumbers: ["DD2"], libraryId: LIB, reason: "x", orgId: ORG, actorUserId: ME });
    await supersedeDocument({ doc: asRecord(is), replacementDocNumbers: ["II2"], libraryId: LIB, reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    expect(ofKind("doc_recalled").map((e) => (e.audience as { involved: string[] }).involved)).toEqual([["u4"]]);
    expect(audit("DISTRIBUTION_RECALL").map((r) => r.resource_id)).toEqual(["ii"]);
    expect(ofKind("doc_retired").map((e) => e.title).sort()).toEqual(["DD was retired (Superseded)", "II was retired (Superseded)"]);
  });

  it("REGRESSION: a re-run on a document already Superseded recalls as it always has", async () => {
    const a = seedDoc("rr", { status: "Superseded" }); seedDoc("rr2");
    seedCopies("rr", ["u3"]);
    await supersedeDocument({ doc: asRecord(a), replacementDocNumbers: ["RR2"], libraryId: LIB, reason: "again", orgId: ORG, actorUserId: ME });
    await settle();
    expect(ofKind("doc_recalled")).toHaveLength(1);
  });
});

// ─── the library page's doors (source-pinned; the page is too large to render here) ──
describe("PROD-17 (P28) — the library page's metadata save and bulk archive", () => {
  const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
  const slice = (from: string, to: string) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)));
  const save = slice("const saveMetadata = async", "const saveInlineDocNumber = async");
  const bulk = slice("const handleBulkArchive = async", "const handleStageSelected = ");

  it("a save to a retired status goes through changeDocumentStatus — the same one UPDATE (the payload as its patch), door metadata — before the issue branch and the bare write; it never calls the single-document recall itself", () => {
    // P28 second fix pass: a pre-actor edit of a document the page holds as already in that retired status falls through to the bare write
    const retired = save.indexOf("if (toStatus !== undefined && isRetiredStatus(toStatus) && !(retiredUnchanged && (!uid || !retireOrgId))) {");
    expect(save).toContain('const retiredUnchanged = toStatus !== undefined && (selectedDoc.status ?? "").trim() === toStatus.trim();');
    expect(retired).toBeGreaterThan(0);
    expect(retired).toBeLessThan(save.indexOf("if (toStatus !== undefined && isControlledIssueStatus(toStatus)) {"));
    expect(retired).toBeLessThan(save.indexOf('.from("documents").update(payload)'));
    const branch = save.slice(retired, save.indexOf("if (toStatus !== undefined && isControlledIssueStatus(toStatus)) {"));
    expect(branch).toMatch(/await changeDocumentStatus\(\{\s*orgId: retireOrgId, documentId: selectedDoc\.id, toStatus, door: "metadata",\s*actorUserId: uid, actorEmail: userEmail \?\? null, actorRole: activeRole \?\? null,\s*patch: payload,\s*(?:\/\/[^\n]*\n\s*)*heldStatus: selectedDoc\.status \?\? null,\s*\}\);/);
    // P28 fix pass: before the actor is known the save is refused (never the bare write that told nobody)
    expect(branch).toMatch(/if \(!uid \|\| !retireOrgId\) \{\s*throw new Error\(`Save refused — nothing was saved: this save writes the status \$\{toStatus\}, which can retire the document/);
    expect(branch).not.toContain("console.error(");
    expect(branch).toMatch(/\n\s*return;\n/);
    expect(save).not.toMatch(/\brecallOnRetirement\(|\brecallRetiredDocument\(/);
  });

  it("a retired save that matched no row keeps the bare write's sentence: the page's mapping matches changeDocumentStatus's zero-row refusal exactly", async () => {
    const m = /throw new Error\((\/\^The status was NOT changed[^/]*\/)\.test\(msg\)\s*\?\s*"(Save refused — nothing was saved: the database updated no document \(you may no longer have edit access to it\)\.)"/.exec(save);
    expect(m, "the mapping is in the retired branch").toBeTruthy();
    const pattern = new RegExp(m![1].slice(1, -1));
    // the bare write's own sentence, unchanged further down
    expect(save).toContain(`throw new Error("${m![2]}");`);
    seedDoc("zr");
    state.db.refuseWrites.add("documents");
    const err = await changeDocumentStatus({ orgId: ORG, documentId: "zr", toStatus: "Void", door: "metadata", actorUserId: ME }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pattern.test((err as Error).message)).toBe(true);
    await settle();
    expect(state.emits).toEqual([]);
  });

  it("the bulk archive: ONE fresh read gives each row's legal hold and status; the archive write is unchanged; one batched recall after it, the already-retired rows left out, copy holders only for a controlled issue", () => {
    expect(bulk).toContain('await supabase.from("documents").select("id, legal_hold, status").in("id", ids);');
    expect(bulk.match(/supabase\.from\("documents"\)\.select\(/g)).toHaveLength(1);
    expect(bulk).toContain("const held = new Set(readRows.filter((r) => r.legal_hold === true).map((r) => r.id));");
    expect(bulk).toMatch(/\.update\(\{\s*status: "Archived",\s*archived_at: now,\s*archived_by: uid \?\? null,\s*updated_at: now,\s*updated_by: uid \?\? null,\s*\}\)\.in\("id", targets\)\.select\("id"\);/);
    const at = bulk.indexOf("recallRetiredBatch({");
    expect(at).toBeGreaterThan(bulk.indexOf('.in("id", targets).select("id")'));
    expect(bulk).toContain(".filter((id) => !skipsRetirementRecall(priorStatusOf.get(id) ?? null))");
    expect(bulk).toContain("recallCopyHolders: recallsCopyHolders(priorStatusOf.get(id) ?? null)");
    expect(bulk).toMatch(/void import\("@\/lib\/staleCopies"\)\.then\(\(\{ recallRetiredBatch \}\) => recallRetiredBatch\(\{\s*orgId: recallOrg, newStatus: "Archived", actorUserId: uid,/);
    // P28 fix pass: refused before the read and the write while the actor or workspace is unknown
    const refuse = bulk.indexOf("if (!uid || !recallOrg) {");
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(bulk.indexOf('.select("id, legal_hold, status")'));
    expect(bulk.slice(refuse, bulk.indexOf("return;", refuse))).toContain("Archive refused — nothing was archived");
    expect(bulk).not.toContain("were archived before who is archiving them was known");
    expect(bulk).not.toMatch(/\brecallOnRetirement\(|\brecallRetiredDocument\(/);
  });
});
