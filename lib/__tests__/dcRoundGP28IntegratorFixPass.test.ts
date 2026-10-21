// document-control Round G — P28 STATUS-DOOR REMAINDERS, the integrator's
// fix pass at the P28 merge (2026-10-21, DEC-90: fail-safe, no regression).
// Driven against the in-memory PostgREST (helpers/fakeSupabase) with the
// real lib/revisions.ts, lib/staleCopies.ts and lib/audit.ts — only the
// dispatcher's emit() is a spy.
//
//   · Ruling 1 — changeDocumentStatus's heldStatus only retries the read: a
//     read that fails twice leaves the prior UNKNOWN, and the copy holders
//     ARE recalled (P26's fail-safe), whatever the caller holds.
//   · Ruling 3 — the DIST-16 race: a recall finding its document back in
//     force before it sends sends nothing; one finding it back in force once
//     its row is written withdraws that recall (both orders, single and bulk).
//   · Ruling 4 — the bulk doors' watchers' FYI grouped per follower (one
//     notice per library naming the documents, namesDocuments for the
//     discover check); the single door's FYI unchanged byte for byte.
//   · Ruling 5 — a DISTRIBUTION_RECALL row reads as what its details say in
//     the audit viewer and the export; every other recall row as before.
//   · Ruling 6 — DIST-16 done-when 2: "already retired" from the record.
//   · Ruling 2 — REV-31: a bulk archive's duties (finishBulkArchive) and the
//     library page's bulk archive (handleBulkArchive, lifted from the page).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  roles: ["DocCtrl"] as string[],
  emits: [] as Array<Record<string, unknown>>,
  /** table → how many of its next plain reads fail. */
  failReads: {} as Record<string, number>,
  /** called with each emit() payload before it resolves (a restore landing mid-recall). */
  onEmit: null as null | ((p: Record<string, unknown>) => void),
  clock: 0,
}));

function wrap(table: string, inner: Record<string, (...a: unknown[]) => unknown>): unknown {
  let op = "select";
  const wrapper: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") {
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
    state.onEmit?.(p);
    return Promise.resolve();
  }),
}));

import { supabase } from "@/lib/supabase";
import { archiveDocument, unarchiveDocument, changeDocumentStatus, finishBulkArchive, recallsCopyHolders } from "@/lib/revisions";
import { recallRetiredDocument, recallRetiredBatch } from "@/lib/staleCopies";
import { auditRowLabel, prettyAuditAction } from "@/lib/auditActions";
import { buildAuditCsv, AUDIT_CSV_LINES_BEFORE_HEADER, type AuditExportRow } from "@/lib/auditLogExport";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const T = (t: string) => (state.db.tables[t] ??= []);
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const recallRows = (): Array<Record<string, unknown>> => audit("DISTRIBUTION_RECALL").map((r) => ({ doc: r.resource_id, ...(r.details as Record<string, unknown>) }));
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const kinds = () => state.emits.map((e) => e.kind);
const ofKind = (k: string) => state.emits.filter((e) => e.kind === k);
const settle = async () => { for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 1)); };

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
const follow = (docId: string, users: string[]) => {
  for (const u of users) T("subscriptions").push({ id: `s-${docId}-${u}`, resource_type: "document", resource_id: docId, user_id: u });
};
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: d.library_id ?? LIB, documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id, collectionId: null,
}) as unknown as DocumentRecord;
const base = { orgId: ORG, libraryId: LIB, actorUserId: ME, actorName: "dana@x" };

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.roles = ["DocCtrl"];
  state.emits = [];
  state.failReads = {};
  state.onEmit = null;
  state.clock = 0;
  state.db.beforeInsert!.audit_logs = (row) => ({ ...row, timestamp: row.timestamp ?? new Date(Date.UTC(2026, 9, 21, 8, 0, state.clock++)).toISOString() });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); warnSpy.mockRestore(); });

// ─── Ruling 1 ────────────────────────────────────────────────────────────
describe("ruling 1 (DEC-90) — heldStatus only retries the read; an unknown prior recalls", () => {
  const basisReads = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "select" && c.args[0] === "*");

  it("the basis read fails TWICE on a save the caller holds as already Archived: the copy holders ARE recalled and the watchers told", async () => {
    seedDoc("h1", { status: "Archived" });
    seedCopies("h1", ["u3", "u4"]);
    state.db.selectErrors!.documents = (cols) => (cols === "*" ? { message: "503 basis read" } : null);
    await changeDocumentStatus({ orgId: ORG, documentId: "h1", toStatus: "Archived", door: "metadata", actorUserId: ME, actorEmail: "dana@x", heldStatus: "Archived", patch: { title: "h1 fixed" } });
    await settle();
    expect(basisReads()).toHaveLength(2);
    expect(docRow("h1")).toMatchObject({ status: "Archived", title: "h1 fixed" });
    expect(kinds()).toEqual(["doc_recalled", "doc_retired"]);
    expect(ofKind("doc_recalled")[0]).toMatchObject({ audience: { involved: ["u3", "u4"] }, title: "H1 is now Archived — your copy is dead paper" });
    expect(recallRows()).toEqual([expect.objectContaining({ doc: "h1", retirement: true, recipients: ["u3", "u4"] })]);
  });

  it("the stale copy: the caller holds Archived, the row is Issued (put back elsewhere), the read fails twice — recalled and told", async () => {
    seedDoc("h2", { status: "Issued" });
    seedCopies("h2", ["u3"]);
    state.db.selectErrors!.documents = (cols) => (cols === "*" ? { message: "503 basis read" } : null);
    await changeDocumentStatus({ orgId: ORG, documentId: "h2", toStatus: "Archived", door: "metadata", actorUserId: ME, heldStatus: "Archived" });
    await settle();
    expect(kinds()).toEqual(["doc_recalled", "doc_retired"]);
  });

  it("REGRESSION: the retry that reads the row decides as the row says (Archived → Archived: no retirement, nothing sent)", async () => {
    seedDoc("h3", { status: "Archived" });
    seedCopies("h3", ["u3"]);
    let fails = 1;
    state.db.selectErrors!.documents = (cols) => (cols === "*" && fails-- > 0 ? { message: "503 basis read" } : null);
    await changeDocumentStatus({ orgId: ORG, documentId: "h3", toStatus: "Archived", door: "metadata", actorUserId: ME, heldStatus: "Archived" });
    await settle();
    expect(basisReads()).toHaveLength(2);
    expect(state.emits).toEqual([]);
  });

  it("source: the caller's held status no longer touches the copy-holder flag", () => {
    const src = readFileSync(join(process.cwd(), "lib/revisions.ts"), "utf8");
    expect(src).not.toContain("heldSameRetired");
    expect(src).toContain("recallCopyHolders: recallsCopyHolders(before.fromStatus),\n      retiredFrom: before.readFailed === true ? null : (before.fromStatus ?? null),");
  });
});

// ─── Ruling 3: the race ───────────────────────────────────────────────────
describe("ruling 3 (DIST-16 race) — a recall that finds its document back in force", () => {
  const input = (id: string) => ({ ...base, documentId: id, docLabel: id.toUpperCase(), newStatus: "Archived", replacementNote: null });

  it("order 1: the restore landed BEFORE the recall sends — nothing is sent (no recall, no FYI, no row), and it is logged", async () => {
    seedDoc("r1", { status: "Issued" });
    seedCopies("r1", ["u3"]);
    expect(await recallRetiredDocument(input("r1"))).toBe(0);
    expect(state.emits).toEqual([]);
    expect(recallRows()).toEqual([]);
    expect(warnSpy.mock.calls.some((c: unknown[]) => /DIST-16: document r1 was back in force \(Issued\) before its retirement recall \(Archived\) was sent/.test(String(c[0])))).toBe(true);
  });

  it("order 2: the restore lands WHILE the recall goes out (its own withdrawal read the record before the row) — the recall just sent is withdrawn once its row is written; no FYI follows", async () => {
    seedDoc("r2", { status: "Archived" });
    seedCopies("r2", ["u3", "u4"]);
    state.onEmit = (p) => { if (p.kind === "doc_recalled") docRow("r2").status = "Issued"; };
    expect(await recallRetiredDocument(input("r2"))).toBe(2);
    expect(kinds()).toEqual(["doc_recalled", "library_doc_revised"]);
    const w = ofKind("library_doc_revised")[0];
    expect(w).toMatchObject({
      category: "recall", audience: { involved: ["u3", "u4"] }, resource: { type: "document", id: "r2" },
      metadata: { recallWithdrawn: true, restoredStatus: "Issued", door: "restored_during_recall" },
    });
    expect(String(w.title)).toMatch(/^R2 is back in force \(Issued\) — the recall of .* is withdrawn$/);
    expect(String(w.body)).toMatch(/^Someone put R2 back in force as Issued\./);
    expect(recallRows().map((r) => [r.recallWithdrawn === true, r.recipients])).toEqual([[false, ["u3", "u4"]], [true, ["u3", "u4"]]]);
  });

  it("REGRESSION: a document still retired after the row — the recall and the FYI exactly as before, nothing withdrawn", async () => {
    seedDoc("r3", { status: "Archived" });
    seedCopies("r3", ["u3"]);
    expect(await recallRetiredDocument(input("r3"))).toBe(1);
    expect(kinds()).toEqual(["doc_recalled", "doc_retired"]);
    expect(recallRows()).toEqual([{ doc: "r3", retirement: true, newStatus: "Archived", recipientCount: 1, recipients: ["u3"], versionId: "" }]);
  });

  it("a status read that fails is not \"in force\": the recall goes", async () => {
    seedDoc("r4", { status: "Issued" });
    seedCopies("r4", ["u3"]);
    state.db.selectErrors!.documents = (cols) => (cols === "status" ? { message: "503" } : null);
    expect(await recallRetiredDocument(input("r4"))).toBe(1);
    expect(kinds()).toEqual(["doc_recalled", "doc_retired"]);
  });

  it("the bulk batch, both orders: b1 back in force before (nothing for it), b2 restored mid-send (withdrawn), b3 retired (recalled and told)", async () => {
    seedDoc("b1", { status: "Issued" }); seedCopies("b1", ["u3"]);
    seedDoc("b2", { status: "Archived" }); seedCopies("b2", ["u4"]);
    seedDoc("b3", { status: "Archived" }); seedCopies("b3", ["u5"]);
    state.onEmit = (p) => { if (p.kind === "doc_recalled" && (p.audience as { involved: string[] }).involved.includes("u4")) docRow("b2").status = "Issued"; };
    await recallRetiredBatch({
      orgId: ORG, newStatus: "Archived", actorUserId: ME, actorName: "dana@x",
      docs: ["b1", "b2", "b3"].map((id) => ({ documentId: id, libraryId: LIB, docLabel: id.toUpperCase(), recallCopyHolders: true })),
    });
    expect(ofKind("doc_recalled").map((e) => (e.audience as { involved: string[] }).involved)).toEqual([["u4"], ["u5"]]);
    expect(ofKind("library_doc_revised").map((e) => [(e.resource as { id: string }).id, (e.metadata as Record<string, unknown>).door])).toEqual([["b2", "restored_during_recall"]]);
    expect(ofKind("doc_retired").map((e) => (e.resource as { id: string }).id)).toEqual(["b3"]);
    expect(recallRows().filter((r) => r.doc === "b1")).toEqual([]);
  });
});

// ─── Ruling 4: the grouped FYI ───────────────────────────────────────────
describe("ruling 4 — the bulk doors' watchers' FYI grouped per follower", () => {
  const docs = (ids: string[], lib = LIB, recall = false) => ids.map((id) => ({ documentId: id, libraryId: lib, docLabel: id.toUpperCase(), recallCopyHolders: recall }));

  it("a follower of two retired documents of one library gets ONE notice naming both (on the library, namesDocuments); a follower of one keeps that document's own FYI; each document's FYI leaves the grouped followers out", async () => {
    follow("g1", ["u7", "u8", ME]);
    follow("g2", ["u7", "u9"]);
    follow("g3", ["u9"]);
    await recallRetiredBatch({ orgId: ORG, newStatus: "Archived", actorUserId: ME, actorName: "dana@x", docs: docs(["g1", "g2", "g3"]) });
    const fyi = ofKind("doc_retired");
    const own = fyi.filter((e) => (e.resource as { type: string }).type === "document");
    expect(own.map((e) => [(e.resource as { id: string }).id, (e.audience as { followers: boolean; exclude: string[] })])).toEqual([
      ["g1", { followers: true, exclude: ["u7"] }],
      ["g2", { followers: true, exclude: ["u7", "u9"] }],
      ["g3", { followers: true, exclude: ["u9"] }],
    ]);
    const grouped = fyi.filter((e) => (e.resource as { type: string }).type === "library");
    expect(grouped).toEqual([
      {
        orgId: ORG, category: "watched", kind: "doc_retired",
        title: "2 documents you follow were retired (Archived)",
        body: "dana@x retired these documents (archived); there is no current revision of them to work from: G1, G2.",
        link: `/documents/${LIB}`, resource: { type: "library", id: LIB },
        actorUserId: ME, actorName: "dana@x",
        audience: { involved: ["u7"] },
        metadata: { retirement: true, followerNotice: true, newStatus: "Archived", documentIds: ["g1", "g2"] },
        emailOnlyWithBell: true,
        namesDocuments: {
          ids: ["g1", "g2"],
          unnamed: {
            title: "Documents you follow were retired (Archived)",
            body: "dana@x retired documents you follow (archived); there is no current revision of them to work from. Open the library to see the ones you have access to.",
            link: `/documents/${LIB}`,
          },
        },
      },
      expect.objectContaining({ audience: { involved: ["u9"] }, metadata: expect.objectContaining({ documentIds: ["g2", "g3"] }) }),
    ]);
    // every recall and record first, then the documents' own FYI, then the grouped ones
    expect(kinds()).toEqual(["doc_retired", "doc_retired", "doc_retired", "doc_retired", "doc_retired"]);
  });

  it("a document's copy holder is not grouped for it (they were recalled); documents of different libraries are never grouped together", async () => {
    seedCopies("k1", ["u7"]);
    follow("k1", ["u7"]);
    follow("k2", ["u7"]);
    follow("k3", ["u8"]);
    follow("k4", ["u8"]);
    await recallRetiredBatch({
      orgId: ORG, newStatus: "Superseded", actorUserId: ME,
      docs: [...docs(["k1"], LIB, true), ...docs(["k2", "k3"]), ...docs(["k4"], "lib2")],
    });
    expect(ofKind("doc_retired").filter((e) => (e.resource as { type: string }).type === "library")).toEqual([]);
  });

  it("the follow list cannot be read: nobody is grouped — each document's own FYI goes to all its watchers, as before", async () => {
    follow("f1", ["u7"]); follow("f2", ["u7"]);
    state.failReads.subscriptions = 1;
    await recallRetiredBatch({ orgId: ORG, newStatus: "Archived", actorUserId: ME, docs: docs(["f1", "f2"]) });
    expect(ofKind("doc_retired").map((e) => [(e.resource as { type: string }).type, (e.audience as { exclude?: string[] }).exclude])).toEqual([["document", []], ["document", []]]);
  });

  it("PIN: the single door's FYI is byte for byte what it was — a document resource, followers: true, no namesDocuments", async () => {
    follow("s1", ["u7"]);
    await recallRetiredDocument({ ...base, documentId: "s1", docLabel: "S-1", newStatus: "Void", replacementNote: null });
    expect(state.emits).toEqual([{
      orgId: ORG, category: "watched", kind: "doc_retired",
      title: "S-1 was retired (Void)",
      body: "dana@x retired S-1 (void); there is no current revision to work from.",
      link: `/documents/${LIB}?doc=s1`, resource: { type: "document", id: "s1" },
      actorUserId: ME, actorName: "dana@x",
      audience: { followers: true, exclude: [] },
      metadata: { retirement: true, followerNotice: true, newStatus: "Void" },
      emailOnlyWithBell: true,
    }]);
  });
});

// ─── Ruling 5: the labels ─────────────────────────────────────────────────
describe("ruling 5 — a recall row's label follows its details (the audit viewer and the export)", () => {
  it("withdrawn / could not be computed / back in force / watchers only; every other recall row as before", () => {
    expect(auditRowLabel("DISTRIBUTION_RECALL", { recallWithdrawn: true, recipients: ["u3"] })).toBe("Recall withdrawn");
    expect(auditRowLabel("DISTRIBUTION_RECALL", { withdrawalUnavailable: true, readError: "503" })).toBe("Recall withdrawal could not be computed");
    expect(auditRowLabel("DISTRIBUTION_RECALL", { recallWithdrawn: true, returnedToForce: true, recipients: [] })).toBe("Back in force (no recall to withdraw)");
    expect(auditRowLabel("DISTRIBUTION_RECALL", { retirement: true, watchersOnly: true })).toBe("Retirement notice (watchers only)");
    // PIN: the recall rows that exist today
    for (const d of [{ retirement: true, recipients: ["u3"] }, { unavailable: true }, { source: "manual", currentRev: "B" }, null, undefined]) {
      expect(auditRowLabel("DISTRIBUTION_RECALL", d)).toBe(prettyAuditAction("DISTRIBUTION_RECALL"));
    }
    expect(prettyAuditAction("DISTRIBUTION_RECALL")).toBe("Distribution Recall");
    // a details flag on another action changes nothing
    expect(auditRowLabel("ARCHIVE_DOC", { recallWithdrawn: true })).toBe("Archive Doc");
  });

  it("the export's Action column reads the row's label; its Action code column keeps the action", () => {
    const row = (id: string, details: Record<string, unknown>): AuditExportRow => ({
      id, action: "DISTRIBUTION_RECALL", resourceType: "document", resourceId: "d1", orgId: ORG, userId: ME, userEmail: null, userRole: null, actorKind: "member", details, metadata: null, timestamp: "2026-10-21T08:00:00Z",
    });
    const csv = buildAuditCsv([row("a", { recallWithdrawn: true }), row("b", { retirement: true, recipients: ["u3"] })], new Map(), {
      orgId: ORG, filters: { range: "all", action: "ALL", resource: "ALL" } as never, exportedAtIso: "2026-10-21T09:00:00Z", rows: 2, complete: true, ceiling: 1000,
    });
    const lines = csv.split("\n").slice(AUDIT_CSV_LINES_BEFORE_HEADER + 1);
    expect(lines[0].startsWith("2026-10-21T08:00:00Z,Recall withdrawn,DISTRIBUTION_RECALL,")).toBe(true);
    expect(lines[1].startsWith("2026-10-21T08:00:00Z,Distribution Recall,DISTRIBUTION_RECALL,")).toBe(true);
  });

  it("source: the admin audit viewer's badge reads auditRowLabel(row.action, row.details)", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/audit/page.tsx"), "utf8");
    expect(page).toContain("{auditRowLabel(row.action, row.details)}");
    expect(page).not.toContain("{prettyAction(row.action)}");
  });
});

// ─── Ruling 6: DIST-16 done-when 2 ─────────────────────────────────────────
describe("ruling 6 (DIST-16 done-when 2) — \"already retired\" is decided from the recall record, not the prior status", () => {
  it("a Superseded document a door that told nobody retired (no notice on its record) is archived: its watchers are told once; a later retirement out of Archived sends nothing again", async () => {
    const d = seedDoc("x1", { status: "Superseded" });
    seedCopies("x1", ["u3"]);
    await archiveDocument({ doc: asRecord(d), reason: "tidy", orgId: ORG, actorUserId: ME, actorEmail: "dana@x" });
    await settle();
    expect(kinds()).toEqual(["doc_retired"]);
    expect(recallRows()).toEqual([expect.objectContaining({ doc: "x1", retirement: true, recipients: [], watchersOnly: true })]);
    await changeDocumentStatus({ orgId: ORG, documentId: "x1", toStatus: "Void", door: "metadata", actorUserId: ME });
    await settle();
    expect(kinds()).toEqual(["doc_retired"]);
  });

  it("a Draft archived (watchers told), un-archived into Draft (not back in force) and archived again: no second FYI; un-archived into Issued (the return to force recorded, nobody notified) and archived again: told again", async () => {
    const d = seedDoc("x2", { status: "Draft" });
    await archiveDocument({ doc: asRecord(d), reason: "a", orgId: ORG, actorUserId: ME });
    await settle();
    await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "b", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    await settle();
    await archiveDocument({ doc: asRecord({ ...d, status: "Draft" }), reason: "c", orgId: ORG, actorUserId: ME });
    await settle();
    expect(kinds()).toEqual(["doc_retired"]);
    await unarchiveDocument({ doc: asRecord({ ...d, status: "Archived" }), reason: "d", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    await settle();
    expect(ofKind("library_doc_revised")).toEqual([]);
    expect(recallRows().filter((r) => r.recallWithdrawn === true)).toEqual([
      expect.objectContaining({ doc: "x2", returnedToForce: true, recipients: [], restoredStatus: "Issued", door: "unarchive" }),
    ]);
    await archiveDocument({ doc: asRecord({ ...d, status: "Issued" }), reason: "e", orgId: ORG, actorUserId: ME });
    await settle();
    expect(kinds()).toEqual(["doc_retired", "doc_retired"]);
  });

  it("every first recall is still sent: an Issued document whose record still shows an old retirement notice (no return to force on record) recalls its copy holders and tells its watchers", async () => {
    const d = seedDoc("x3");
    seedCopies("x3", ["u3"]);
    T("audit_logs").push({ id: "old", org_id: ORG, action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: "x3", timestamp: "2026-06-01T00:00:00.000Z", details: { retirement: true, newStatus: "Archived", recipientCount: 1, recipients: ["u3"] } });
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    expect(kinds()).toEqual(["doc_recalled", "doc_retired"]);
  });

  it("the record cannot be read: the FYI goes (a second FYI over none), and it is logged", async () => {
    const d = seedDoc("x4", { status: "Void" });
    T("audit_logs").push({ id: "v", org_id: ORG, action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: "x4", timestamp: "2026-10-01T00:00:00.000Z", details: { retirement: true, newStatus: "Void", recipientCount: 0, recipients: [], watchersOnly: true } });
    state.failReads.audit_logs = 1;
    await archiveDocument({ doc: asRecord(d), reason: "x", orgId: ORG, actorUserId: ME });
    await settle();
    expect(kinds()).toEqual(["doc_retired"]);
    expect(warnSpy.mock.calls.some((c: unknown[]) => /DIST-16: the recall record of document x4 could not be read/.test(String(c[0])))).toBe(true);
  });

  it("the bulk batch reads the same record: a Superseded row with its notice standing is left out; one without is told", async () => {
    T("audit_logs").push({ id: "y", org_id: ORG, action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: "y1", timestamp: "2026-10-01T00:00:00.000Z", details: { retirement: true, newStatus: "Superseded", recipientCount: 0, recipients: [], watchersOnly: true } });
    await recallRetiredBatch({
      orgId: ORG, newStatus: "Archived", actorUserId: ME,
      docs: ["y1", "y2"].map((id) => ({ documentId: id, libraryId: LIB, docLabel: id.toUpperCase(), recallCopyHolders: recallsCopyHolders("Superseded"), retiredFrom: "Superseded" })),
    });
    expect(ofKind("doc_retired").map((e) => (e.resource as { id: string }).id)).toEqual(["y2"]);
  });

  it("census: no retirement door asks skipsRetirementRecall any more — only supersede", () => {
    for (const f of ["lib/documentLifecycle/split.ts", "lib/documentLifecycle/merge.ts", "lib/documentLifecycle/reverse.ts", "lib/retention.ts", "components/documents/BulkEditModal.tsx", "app/(protected)/documents/[libraryId]/page.tsx"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(/skipsRetirementRecall\(/);
    }
    const rev = readFileSync(join(process.cwd(), "lib/revisions.ts"), "utf8");
    expect(rev.match(/skipsRetirementRecall\(priorState/g)).toHaveLength(1);
    expect((rev.match(/\bskipsRetirementRecall\(/g) ?? []).length).toBe(2); // its definition and supersede
  });
});

// ─── Ruling 2: REV-31 ───────────────────────────────────────────────────
describe("ruling 2 (REV-31) — a bulk archive does what the Archive dialog does around each archive", () => {
  function seedDraftAndShare(id: string) {
    docRow(id).pending_version_id = `${id}-v4`;
    T("document_versions").push({ id: `${id}-v4`, org_id: ORG, record_id: id, revision_label: "4", superseded_at: null });
    T("document_review_signoffs").push({ id: `${id}-so`, document_version_id: `${id}-v4`, status: "pending" });
    T("document_shares").push({ id: `${id}-sh`, document_id: id, org_id: ORG, revoked_at: null, expires_at: null });
  }

  it("finishBulkArchive: each row's review draft voided, live share links revoked (SHARE_LINK_REVOKED), and an ARCHIVE_DOC record with the one reason and the door — nothing to say", async () => {
    seedDoc("a1", { status: "Archived" }); seedDraftAndShare("a1");
    seedDoc("a2", { status: "Archived" });
    const out = await finishBulkArchive({
      orgId: ORG, actorUserId: ME, actorEmail: "dana@x", actorRole: "DocCtrl", reason: "  Obsolete unit ", via: "bulk_archive",
      docs: [{ documentId: "a1", label: "A1", versionId: "a1-v3" }, { documentId: "a2", label: "A2", versionId: null }],
    });
    expect(out).toEqual({ problems: [] });
    expect(docRow("a1").pending_version_id).toBeNull();
    expect(T("document_review_signoffs")[0].status).toBe("void");
    expect(T("document_shares")[0]).toMatchObject({ revoked_by: ME });
    expect(audit("SHARE_LINK_REVOKED").map((r) => r.details)).toEqual([expect.objectContaining({ shareId: "a1-sh", via: "retirement" })]);
    const recs = audit("ARCHIVE_DOC").sort((x, y) => String(x.resource_id).localeCompare(String(y.resource_id)));
    expect(recs.map((r) => [r.resource_id, r.user_email, r.user_role])).toEqual([["a1", "dana@x", "DocCtrl"], ["a2", "dana@x", "DocCtrl"]]);
    expect(recs[0].details).toEqual({
      reason: "Obsolete unit", action: "archive", via: "bulk_archive",
      pendingDraftVoided: "a1-v4", pendingDraftVoidProblem: null,
      revokedShareLinks: 1, shareRevokeError: null, liveShareLinksLeft: 0, shareRevokeAuditError: null,
      versionId: "a1-v3",
    });
    expect(recs[1].details).toMatchObject({ reason: "Obsolete unit", pendingDraftVoided: null, revokedShareLinks: 0, versionId: "" });
    // the recall is not this function's: no notice at all
    expect(state.emits).toEqual([]);
  });

  it("a duty that does not complete is returned against its row — named, never skipped; the other rows complete", async () => {
    seedDoc("e1", { status: "Archived" }); seedDraftAndShare("e1");
    seedDoc("e2", { status: "Archived" });
    seedDoc("e3", { status: "Archived" });
    state.db.beforeUpdate!.document_shares = () => { throw { code: "42501", message: "permission denied for table document_shares" }; };
    state.db.beforeInsert!.audit_logs = (row) => {
      if (row.action === "ARCHIVE_DOC" && row.resource_id === "e2") throw { code: "42501", message: "audit insert refused" };
      return { ...row, timestamp: new Date(Date.UTC(2026, 9, 21, 8, 0, state.clock++)).toISOString() };
    };
    const out = await finishBulkArchive({
      orgId: ORG, actorUserId: ME, reason: "x", via: "bulk_edit",
      docs: ["e1", "e2", "e3"].map((id) => ({ documentId: id, label: id.toUpperCase() })),
    });
    expect(out.problems.map((p) => p.label)).toEqual(["E1", "E2"]);
    expect(out.problems[0].problems).toEqual([
      "its share links could not be revoked (permission denied for table document_shares)",
      "1 share link is still live on it (another person's — Document Control must revoke it)",
    ]);
    expect(out.problems[1].problems).toEqual(["its ARCHIVE_DOC record could not be written (audit insert refused), so the archive and its reason are not on its history"]);
    expect(audit("ARCHIVE_DOC").map((r) => r.resource_id).sort()).toEqual(["e1", "e3"]);
    expect(docRow("e1").pending_version_id).toBeNull();
  });

  // ── the library page's bulk archive, lifted from the page and run ──
  const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
  function liftBulkArchive(deps: Record<string, unknown>): () => Promise<void> {
    const start = page.indexOf("\n  const handleBulkArchive = async () => {");
    expect(start).toBeGreaterThan(0);
    const end = page.indexOf("\n  const ", start + 10);
    // the page's dynamic import of lib/staleCopies is handed in (a spy)
    const code = page.slice(start, end).replace('import("@/lib/staleCopies")', "__staleCopies()");
    const names = Object.keys(deps);
    const js = ts.transpileModule(`function factory({ ${names.join(", ")} }) {${code}\nreturn handleBulkArchive;\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    return (new Function(`${js}\nreturn factory;`)() as (d: Record<string, unknown>) => () => Promise<void>)(deps);
  }
  function run(ids: string[], reason: string | null) {
    const st = { prompts: [] as Array<Record<string, unknown>>, alerts: [] as Array<Record<string, unknown>>, docs: [] as Row[], selected: new Set(ids) };
    const batch = vi.fn(async (_i: Record<string, unknown>) => 0);
    const documents = ids.map((id) => ({ id, documentNumber: String(docRow(id).document_number), title: id, status: docRow(id).status, currentVersionId: docRow(id).current_version_id }));
    const fn = liftBulkArchive({
      selectedDocIds: new Set(ids), activeOrgId: ORG, library: { orgId: ORG }, uid: ME, userEmail: "dana@x", activeRole: "DocCtrl",
      supabase, documents, libraryId: LIB, recallsCopyHolders, finishBulkArchive,
      appPrompt: async (o: Record<string, unknown>) => { st.prompts.push(o); return reason; },
      appAlert: async (o: Record<string, unknown>) => { st.alerts.push(o); },
      setDocuments: () => {}, setSelectedDocIds: (s: Set<string>) => { st.selected = s; },
      __staleCopies: async () => ({ recallRetiredBatch: batch }),
    });
    return { st, batch, fn };
  }
  // the archive write (a draft void's pointer release is a documents update too)
  const bulkUpdates = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "update" && "status" in (c.args[0] as Row));

  it("one reason asked once; the SAME rows archived as before (the legal hold skipped), each carrying the reason; ONE batched recall with each row's prior; each archived row's draft voided, links revoked and ARCHIVE_DOC recorded", async () => {
    seedDoc("p1"); seedDraftAndShare("p1");
    seedDoc("p2", { legal_hold: true });
    seedDoc("p3", { status: "Draft" });
    const { st, batch, fn } = run(["p1", "p2", "p3"], "Obsolete unit");
    await fn();
    await settle();
    expect(st.prompts).toHaveLength(1);
    expect(st.prompts[0]).toMatchObject({ title: "Archive 3 documents?", required: true, placeholder: "Reason for archiving" });
    // REGRESSION pin: one update, the same targets, the same columns plus the reason
    expect(bulkUpdates()).toHaveLength(1);
    expect(Object.keys(bulkUpdates()[0].args[0] as Row).sort()).toEqual(["archive_reason", "archived_at", "archived_by", "status", "updated_at", "updated_by"]);
    expect(docRow("p1")).toMatchObject({ status: "Archived", archive_reason: "Obsolete unit", archived_by: ME });
    expect(docRow("p2").status).toBe("Issued");
    expect(docRow("p3")).toMatchObject({ status: "Archived", archive_reason: "Obsolete unit" });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toEqual({
      orgId: ORG, newStatus: "Archived", actorUserId: ME, actorName: "dana@x",
      docs: [
        { documentId: "p1", libraryId: LIB, docLabel: "P1", recallCopyHolders: true, retiredFrom: "Issued" },
        { documentId: "p3", libraryId: LIB, docLabel: "P3", recallCopyHolders: false, retiredFrom: "Draft" },
      ],
    });
    expect(docRow("p1").pending_version_id).toBeNull();
    expect(T("document_shares")[0].revoked_at).toBeTruthy();
    expect(audit("ARCHIVE_DOC").map((r) => [r.resource_id, (r.details as Row).reason, (r.details as Row).via]).sort()).toEqual([["p1", "Obsolete unit", "bulk_archive"], ["p3", "Obsolete unit", "bulk_archive"]]);
    // the person is told what they were told before (the legal hold), nothing more
    expect(st.alerts).toEqual([{ message: "Archived 2 of 3. 1 under legal hold were skipped.", tone: undefined }]);
  });

  it("Cancel archives nothing; a blank reason is refused, nothing written", async () => {
    seedDoc("q1");
    const a = run(["q1"], null);
    await a.fn();
    expect(bulkUpdates()).toEqual([]);
    expect(a.st.alerts).toEqual([]);
    const b = run(["q1"], "   ");
    await b.fn();
    expect(bulkUpdates()).toEqual([]);
    expect(b.st.alerts).toEqual([{ message: "Archive refused — nothing was archived: a reason is required.", tone: "danger" }]);
    expect(docRow("q1").status).toBe("Issued");
    expect(a.batch).not.toHaveBeenCalled();
  });

  it("a duty that did not complete is said, its row named (the archive stands)", async () => {
    seedDoc("w1"); seedDraftAndShare("w1");
    seedDoc("w2");
    state.db.beforeUpdate!.document_shares = () => { throw { code: "42501", message: "permission denied" }; };
    const { st, fn } = run(["w1", "w2"], "x");
    await fn();
    expect(docRow("w1").status).toBe("Archived");
    expect(st.alerts).toHaveLength(1);
    expect(st.alerts[0].tone).toBe("danger");
    expect(String(st.alerts[0].message)).toMatch(/^Archived 2 of 2\.\n\n1 archived document — follow-up steps did not complete \(the archive stands; do not archive again\):\nW1: its share links could not be revoked \(permission denied\); 1 share link is still live on it/);
  });
});
