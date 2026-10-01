// document-control Round F wave 2 — P13 STATUS-TRANSITION: REV-15's remainder.
// A split / merge sheet whose compliance clocks fail to start records WHY on a
// persisted event — a follow-up COMPLIANCE_CLOCKS_NOT_STARTED audit row on the
// sheet, naming the creation event it follows — without touching the saga's
// order (the creation event is still written inside the saga, the clocks still
// start after it committed). Driven end to end against the in-memory
// PostgREST (helpers/fakeSupabase) with the real split / merge / common.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  rpc: vi.fn(),
  roles: ["Engineer"] as string[],
  /** audit actions whose INSERT must be refused (a policy refusal) */
  refuseAudit: new Set<string>(),
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => {
        const b = base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "audit_logs") return b;
        return new Proxy(b, {
          get(target, prop: string) {
            if (prop === "insert") {
              return (row: Row) => state.refuseAudit.has(String(row.action))
                ? Promise.resolve({ data: null, error: { message: "new row violates row-level security policy" } })
                : target.insert(row);
            }
            return target[prop];
          },
        });
      },
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
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));

import { splitDocument } from "@/lib/documentLifecycle/split";
import { mergeDocuments } from "@/lib/documentLifecycle/merge";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const T = (t: string) => (state.db.tables[t] ??= []);
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const pdf = (n: string) => new File([new Uint8Array([1, 2, 3])], n, { type: "application/pdf" });
function seedDoc(id: string): Row {
  const d: Row = {
    id, org_id: ORG, library_id: LIB, document_number: id.toUpperCase(), title: id, rev: "3", revision: "3",
    status: "Issued", current_version_id: `${id}-v3`, pending_version_id: null, checked_out_by: null,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null });
  return d;
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: LIB, documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id, collectionId: null,
}) as unknown as DocumentRecord;
const sheet = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.rpc.mockReset();
  state.roles = ["Engineer"];
  state.refuseAudit = new Set();
  vi.mocked(onDocumentIssued).mockImplementation(async () => {});
  vi.mocked(onDocumentIssuedAck).mockImplementation(async () => {});
});

describe("REV-15 remainder — a sheet whose clocks fail to start records why on a persisted event", () => {
  it("split: a start that THREW is recorded on THAT sheet as COMPLIANCE_CLOCKS_NOT_STARTED, after its CREATED_FROM_SPLIT and after DOC_SPLIT; the other sheet gets no row; the split stands", async () => {
    const s = seedDoc("k1");
    vi.mocked(onDocumentIssued).mockImplementationOnce(async () => { throw new Error("review policy unreadable"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("K1A"), sheet("K1B")], reason: "declutter", orgId: ORG, actorUserId: ME, actorEmail: "me@x" });
    warn.mockRestore();
    const [first, second] = r.newDocumentIds;
    const rows = audit("COMPLIANCE_CLOCKS_NOT_STARTED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_id: first, resource_type: "document", org_id: ORG, user_id: ME, user_email: "me@x" });
    expect(rows[0].details).toEqual({
      followsUp: "CREATED_FROM_SPLIT", sourceDocId: "k1",
      complianceClockErrors: ["the start failed (review policy unreadable)"], startThrew: true,
    });
    // never rewrites the saga's order: the creation event and the split record precede it
    const log = T("audit_logs");
    const idx = (pred: (r: Row) => boolean) => log.findIndex(pred);
    const created = idx((x) => x.action === "CREATED_FROM_SPLIT" && x.resource_id === first);
    const split = idx((x) => x.action === "DOC_SPLIT");
    const follow = idx((x) => x.action === "COMPLIANCE_CLOCKS_NOT_STARTED");
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(split);
    expect(split).toBeLessThan(follow);
    expect(audit("CREATED_FROM_SPLIT").find((x) => x.resource_id === first)!.details).not.toHaveProperty("complianceClockErrors");
    expect(T("audit_logs").some((x) => x.action === "COMPLIANCE_CLOCKS_NOT_STARTED" && x.resource_id === second)).toBe(false);
    // the result still carries the warning for the wizard
    expect(r.complianceClockWarnings).toHaveLength(1);
    expect(T("documents").find((d) => d.id === "k1")!.status).toBe("Superseded");
  });

  it("split: write errors the helpers REPORT are recorded the same way (startThrew false, every error named)", async () => {
    const s = seedDoc("k2");
    let n = 0;
    vi.mocked(onDocumentIssued).mockImplementation(async (i) => { if (n++ === 1) i.writeErrors?.push("the next review date could not be saved (refused)"); });
    vi.mocked(onDocumentIssuedAck).mockImplementation(async (i) => { if (n === 2) i.writeErrors?.push("the acknowledgment roster could not be saved (refused)"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("K2A"), sheet("K2B")], reason: "x", orgId: ORG, actorUserId: ME });
    warn.mockRestore();
    const rows = audit("COMPLIANCE_CLOCKS_NOT_STARTED");
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(r.newDocumentIds[1]);
    expect(rows[0].details).toMatchObject({
      followsUp: "CREATED_FROM_SPLIT", startThrew: false,
      complianceClockErrors: ["the next review date could not be saved (refused)", "the acknowledgment roster could not be saved (refused)"],
    });
  });

  it("a clean split writes no follow-up row (nothing to say) and returns no warning", async () => {
    const s = seedDoc("k3");
    const r = await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("K3A"), sheet("K3B")], reason: "x", orgId: ORG, actorUserId: ME });
    expect(audit("COMPLIANCE_CLOCKS_NOT_STARTED")).toHaveLength(0);
    expect(r.complianceClockWarnings).toEqual([]);
  });

  it("a follow-up row the database refused is never silent: the sheet's warning says the record could not be written", async () => {
    const s = seedDoc("k4");
    state.refuseAudit.add("COMPLIANCE_CLOCKS_NOT_STARTED");
    vi.mocked(onDocumentIssued).mockImplementationOnce(async () => { throw new Error("certification event refused"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("K4A"), sheet("K4B")], reason: "x", orgId: ORG, actorUserId: ME });
    warn.mockRestore();
    expect(audit("COMPLIANCE_CLOCKS_NOT_STARTED")).toHaveLength(0);
    expect(r.complianceClockWarnings[0]).toMatch(/did not start \(certification event refused\); Document Control can set it from the document\. \(The record of this on the document could not be written either: new row violates row-level security policy\.\)/);
  });

  it("merge into a NEW target: the target's follow-up row follows CREATED_FROM_MERGE and names the absorbed sources", async () => {
    const a = seedDoc("m1"); const b = seedDoc("m2");
    vi.mocked(onDocumentIssued).mockImplementationOnce(async () => { throw new Error("review policy unreadable"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "M-NEW", title: "m", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME,
    });
    warn.mockRestore();
    const rows = audit("COMPLIANCE_CLOCKS_NOT_STARTED");
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(r.targetDocumentId);
    expect(rows[0].details).toMatchObject({ followsUp: "CREATED_FROM_MERGE", startThrew: true });
    expect([...(rows[0].details as { sourceDocIds: string[] }).sourceDocIds].sort()).toEqual(["m1", "m2"]);
    const log = T("audit_logs");
    expect(log.findIndex((x) => x.action === "CREATED_FROM_MERGE" && x.resource_id === r.targetDocumentId))
      .toBeLessThan(log.findIndex((x) => x.action === "COMPLIANCE_CLOCKS_NOT_STARTED"));
    expect(r.complianceClockWarnings).toHaveLength(1);
  });
});
