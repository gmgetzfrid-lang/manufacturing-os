// drafting-flow Round G, DF-P12 — DCW-4's document-control limb: a NEW
// document published from a drafting ticket ("Publish as a new document in
// <library>") carries the ticket as its provenance.
//
//   createDocumentWithFile (lib/revisions.ts) takes an optional
//   relatedTicketId: checked to be a ticket of the workspace BEFORE anything
//   is written, recorded on the first version (document_versions.
//   related_ticket_id — what /api/tickets/handback's proof reads, as
//   revUpDocument records a revision's; GAP-6 / DEC-22, provenance only,
//   DEC-23) and on the DOCUMENT_CREATED row. Additive: every existing caller
//   passes none, and then the insert payloads and the audit details are
//   exactly as before (pinned).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  rpc: vi.fn(),
  inserts: [] as Array<{ table: string; row: Row }>,
  ticketReadError: null as null | { message: string },
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => {
        const b = base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t === "tickets" && state.ticketReadError) {
          const err = { data: null, error: state.ticketReadError };
          const chain: Record<string, unknown> = {};
          const h: ProxyHandler<Record<string, unknown>> = { get: (_x, p: string) => (p === "maybeSingle" ? () => Promise.resolve(err) : () => new Proxy(chain, h)) };
          return new Proxy(chain, h);
        }
        return new Proxy(b, {
          get(target, p: string) {
            if (p === "insert") return (row: Row) => { state.inserts.push({ table: t, row }); return target.insert(row); };
            return target[p];
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
  resolveActorPrincipal: vi.fn(async (i: { uid: string; orgId?: string }) => ({ uid: i.uid, orgId: i.orgId, role: "DocCtrl", roles: ["DocCtrl"] })),
}));
vi.mock("@/lib/documentGuards", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/documentGuards")>();
  return { ...real, resolveCanControlLibrary: vi.fn(async () => true) };
});
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/unitCodeClient", () => ({ requestUnitCodeDecode: vi.fn(async () => ({ note: null, results: [] })) }));

import { createDocumentWithFile } from "@/lib/revisions";

const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const TICKET = "77777777-7777-7777-7777-777777777777";
const T = (t: string) => (state.db.tables[t] ??= []);
const pdf = (n: string) => new File([new Uint8Array([1, 2, 3])], n, { type: "application/pdf" });

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.rpc.mockReset();
  state.inserts = [];
  state.ticketReadError = null;
  T("tickets").push({ id: TICKET, org_id: ORG, ticket_id: "KE-9" });
  T("tickets").push({ id: "88888888-8888-8888-8888-888888888888", org_id: "other-org", ticket_id: "KE-X" });
});

describe("DCW-4 (DF-P12) — createDocumentWithFile records the drafting ticket a new document delivers", () => {
  it("REGRESSION: with no relatedTicketId the version insert and the creation audit row are exactly as before (no new key anywhere, no ticket read)", async () => {
    const d = await createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "N-1", file: pdf("n.pdf"), status: "Draft", actorUserId: ME });
    const ver = state.inserts.find((i) => i.table === "document_versions")!.row;
    expect(Object.keys(ver).sort()).toEqual(["change_log", "created_at", "created_by", "created_by_name", "file_hash", "file_type", "file_url", "org_id", "record_id", "released_at", "revision_label", "size"]);
    const created = T("audit_logs").find((r) => r.action === "DOCUMENT_CREATED")!;
    expect(Object.keys(created.details as Row).sort()).toEqual(["documentNumber", "fileHash", "initialStatus", "reviewPolicy", "reviewPolicyMode", "revisionLabel", "versionId"]);
    expect(d.creationAuditError).toBeNull();
  });
  it("with a ticket of this workspace: the first version and the DOCUMENT_CREATED row carry it", async () => {
    const d = await createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "N-2", file: pdf("n.pdf"), status: "Issued", actorUserId: ME, relatedTicketId: TICKET });
    const ver = T("document_versions").find((v) => v.record_id === d.documentId)!;
    expect(ver.related_ticket_id).toBe(TICKET);
    const created = T("audit_logs").find((r) => r.action === "DOCUMENT_CREATED" && r.resource_id === d.documentId)!;
    expect((created.details as Row).relatedTicketId).toBe(TICKET);
  });
  it("a ticket of another workspace, a malformed id, or an unreadable ticket refuses BEFORE anything is written", async () => {
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "N-3", file: pdf("n.pdf"), status: "Draft", actorUserId: ME, relatedTicketId: "88888888-8888-8888-8888-888888888888" }))
      .rejects.toThrow(/not one of this workspace's/);
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "N-4", file: pdf("n.pdf"), status: "Draft", actorUserId: ME, relatedTicketId: "KE-9" }))
      .rejects.toThrow(/not identified correctly/);
    state.ticketReadError = { message: "timeout" };
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "N-5", file: pdf("n.pdf"), status: "Draft", actorUserId: ME, relatedTicketId: TICKET }))
      .rejects.toThrow(/Couldn't confirm the drafting request/);
    expect(T("documents")).toEqual([]);
    expect(state.inserts.filter((i) => i.table === "documents" || i.table === "document_versions")).toEqual([]);
  });
  it("every existing caller passes no relatedTicketId (unchanged), and the input is optional", () => {
    for (const f of ["components/documents/DocumentLinkPicker.tsx", "lib/outputTemplates.ts"]) {
      const s = readFileSync(join(process.cwd(), f), "utf8");
      expect(s, f).toContain("createDocumentWithFile({");
      expect(s, f).not.toContain("relatedTicketId");
    }
    const rev = readFileSync(join(process.cwd(), "lib/revisions.ts"), "utf8");
    expect(rev).toContain("  relatedTicketId?: string | null;\n}): Promise<{ documentId: string; status: CreationStatus; reviewPolicy: string | null; creationAuditError: string | null }> {");
  });
});
