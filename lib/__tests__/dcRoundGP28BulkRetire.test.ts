// @vitest-environment jsdom
//
// document-control Round G — P28 STATUS-DOOR REMAINDERS: the bulk editor's
// Superseded / Archived (notifications PROD-17, open door (2)).
//
//   A bulk status change to a RETIRED status keeps each row's bare checked
//   write — written exactly as before — and is now a retirement: the rows'
//   statuses are read ONCE, fresh, before the apply (never the page's copy),
//   and ONE batched recall goes after it (lib/staleCopies.ts
//   recallRetiredBatch, fired, never awaited) for every row the change
//   retired: recallCopyHolders only for a row that took away a controlled
//   issue (DEC-90 R1), a row already Superseded or Archived left out, a
//   refused row left out. A failed read leaves the priors unknown, which
//   recalls. A change that retires nothing reads nothing and recalls nothing.
//
// Rendered (jsdom) against the in-memory PostgREST with the REAL
// BulkEditModal and lib/revisions.ts; lib/staleCopies.ts is a spy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  refuse: {} as Record<string, string>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return { ...real, rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }) };
  },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), makeLibraryStoragePath: vi.fn(), uniqueUploadName: (n: string) => n }));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "DocCtrl", roles: ["DocCtrl"] })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({
  recallRetiredDocument: vi.fn(async () => 0),
  recallRetiredBatch: vi.fn(async () => 0),
  withdrawRetirementRecall: vi.fn(async () => 0),
}));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "ctl1", userEmail: "cara@example.com", activeRole: "DocCtrl" }) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import BulkEditModal from "@/components/documents/BulkEditModal";
import { recallRetiredBatch, recallRetiredDocument, withdrawRetirementRecall } from "@/lib/staleCopies";
import type { DocumentRecord, LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "o1";
const ME = "ctl1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const batch = vi.mocked(recallRetiredBatch);

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
    status: "Issued", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null, metadata: {},
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`, ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v2`, org_id: ORG, record_id: id, revision_label: "2" });
  return d;
}
const asRecord = (d: Row, status?: string) => ({
  id: d.id, documentNumber: d.document_number, title: d.title, rev: d.rev, status: status ?? d.status,
  metadata: d.metadata ?? {}, libraryId: "lib1", currentVersionId: (d.current_version_id as string | null) ?? undefined,
}) as unknown as DocumentRecord;
const LIB = { id: "lib1", orgId: ORG, customColumns: [{ key: "area", label: "Area", type: "text" }], uniquenessKeys: ["documentNumber", "status"] } as unknown as LibraryConfig;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.refuse = {};
  state.db.beforeUpdate!.documents = (next) => {
    const r = state.refuse[String(next.id)];
    if (r) throw { code: "42501", message: r };
    return next;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const labelled = (label: string) => {
  const l = Array.from(host.querySelectorAll("label")).find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`no label "${label}"`);
  return l.parentElement!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
};
async function apply(docs: DocumentRecord[], value: string, field?: string) {
  await act(async () => {
    root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library: LIB, actorUserId: ME, onApplied: () => {} }));
  });
  if (field) await act(async () => setValue(labelled("Field to change") as HTMLSelectElement, field));
  const v = labelled("New value");
  await act(async () => setValue(v, value));
  await act(async () => { button(`Apply to ${docs.length}`).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
const reads = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "select" && c.args[0] === "id, status");
const writes = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "update");

describe("PROD-17 (P28) — the bulk editor's Superseded / Archived: one fresh read, the same writes, ONE batched recall", () => {
  for (const to of ["Archived", "Superseded"]) {
    it(`Issued / Draft / already-${to} rows set to ${to}: each row written once as before; one read; one batched recall — the Issued row recalls its copy holders, the Draft row tells its watchers only, the already-${to} row is left out`, async () => {
      const a = seedDoc("a1");
      const b = seedDoc("a2", { status: "Draft" });
      const c = seedDoc("a3", { status: to });
      await apply([asRecord(a), asRecord(b), asRecord(c)], to);
      expect(host.textContent).toMatch(/Applied to 3 documents\./);
      // REGRESSION: one bare UPDATE per row, carrying the status and the recomputed key, nothing else written
      expect(writes()).toHaveLength(3);
      for (const id of ["a1", "a2", "a3"]) expect(docRow(id)).toMatchObject({ status: to, updated_by: ME });
      expect(recallRetiredDocument).not.toHaveBeenCalled();
      expect(withdrawRetirementRecall).not.toHaveBeenCalled();
      // the fresh read, once, before the writes
      expect(reads()).toHaveLength(1);
      const readAt = state.db.calls.indexOf(reads()[0]);
      expect(readAt).toBeLessThan(state.db.calls.indexOf(writes()[0]));
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0][0]).toEqual({
        orgId: ORG, newStatus: to, actorUserId: ME, actorName: "cara@example.com",
        docs: [
          { documentId: "a1", libraryId: "lib1", docLabel: "A1", recallCopyHolders: true },
          { documentId: "a2", libraryId: "lib1", docLabel: "A2", recallCopyHolders: false },
        ],
      });
    });
  }

  it("the fresh read decides over the page's copy: a row the page shows Draft that is Issued in the database recalls its copy holders", async () => {
    const a = seedDoc("f1");
    await apply([asRecord(a, "Draft")], "Archived");
    expect(batch.mock.calls[0][0].docs).toEqual([{ documentId: "f1", libraryId: "lib1", docLabel: "F1", recallCopyHolders: true }]);
  });

  it("a read that fails leaves the priors unknown, which recalls (a second recall over none); the writes go as before", async () => {
    const a = seedDoc("g1", { status: "Draft" });
    state.db.selectErrors!.documents = (cols) => (cols === "id, status" ? { message: "503" } : null);
    await apply([asRecord(a)], "Archived");
    expect(docRow("g1").status).toBe("Archived");
    expect(batch.mock.calls[0][0].docs).toEqual([{ documentId: "g1", libraryId: "lib1", docLabel: "G1", recallCopyHolders: true }]);
  });

  it("a refused row is named as before and left out of the recall", async () => {
    const a = seedDoc("h1");
    const b = seedDoc("h2");
    state.refuse.h2 = "new row violates row-level security policy";
    await apply([asRecord(a), asRecord(b)], "Archived");
    expect(host.textContent).toMatch(/H2/);
    expect(batch.mock.calls[0][0].docs.map((d) => d.documentId)).toEqual(["h1"]);
  });

  it("every row refused: no recall at all", async () => {
    const a = seedDoc("j1");
    state.refuse.j1 = "refused";
    await apply([asRecord(a)], "Archived");
    expect(batch).not.toHaveBeenCalled();
  });

  it("REGRESSION: a change that retires nothing (Draft; a custom field) reads nothing and recalls nothing", async () => {
    const a = seedDoc("k1");
    await apply([asRecord(a)], "Draft");
    expect(reads()).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    await apply([asRecord(seedDoc("k2"))], "North", "custom:area");
    expect(reads()).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
  });

  it("DIST-16: a retired row put back to Issued goes through changeDocumentStatus, which withdraws the recall standing on it (fired, never awaited)", async () => {
    const a = seedDoc("p1", { status: "Archived" });
    await apply([asRecord(a)], "Issued");
    expect(docRow("p1").status).toBe("Issued");
    expect(withdrawRetirementRecall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withdrawRetirementRecall).mock.calls[0][0]).toMatchObject({ orgId: ORG, documentId: "p1", restoredStatus: "Issued", door: "put_back", actorUserId: ME });
    expect(batch).not.toHaveBeenCalled();
  });
});
