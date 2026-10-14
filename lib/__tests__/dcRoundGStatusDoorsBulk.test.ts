// @vitest-environment jsdom
//
// document-control Round G — P26 STATUS-DOOR FOLLOW-UPS (notifications
// PROD-17): the bulk editor's retirement door.
//
//   The bulk editor writes a status that issues nothing (Superseded,
//   Archived, Draft, In Review) with its bare checked write, not through
//   changeDocumentStatus. A row that write RETIRES — into Superseded /
//   Archived out of a status the page shows live — now recalls its copy
//   holders and tells its watchers through lib/revisions.ts
//   recallOnRetirement: once per row, never awaited, with the checkout
//   holder and the package owners kept in the watchers' audience (this
//   editor tells neither).
//
//   REGRESSION: every row is written exactly as before (one UPDATE, the same
//   columns), the modal says what it said, a row that retires nothing — or
//   one the page already shows retired — recalls nothing, a refused row
//   recalls nothing, and a recall that never finishes does not hold the
//   apply.
//
// Rendered (jsdom) against the in-memory PostgREST with the REAL
// BulkEditModal and lib/revisions.ts; lib/staleCopies.ts recallRetiredDocument
// is the spy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  updatePayloads: [] as Array<Record<string, unknown>>,
  /** documentId → the UPDATE matches no row (a refusal the database filtered) */
  zeroRow: new Set<string>(),
  recallImpl: null as null | (() => Promise<unknown>),
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return {
      ...real,
      rpc: (fn: string) => Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
      from: (t: string) => {
        const b = real.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "documents") return b;
        return new Proxy(b, {
          get(target, prop: string) {
            if (prop !== "update") return target[prop];
            return (payload: Record<string, unknown>) => {
              state.updatePayloads.push(payload);
              const q = target.update(payload) as Record<string, (...a: unknown[]) => unknown>;
              return new Proxy(q, {
                get(qt, qp: string) {
                  if (qp !== "eq") return qt[qp];
                  return (col: string, val: unknown) => (col === "id" && state.zeroRow.has(String(val))
                    ? { select: async () => ({ data: [], error: null }) }
                    : qt.eq(col, val));
                },
              });
            };
          },
        });
      },
    };
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
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(() => (state.recallImpl ?? (async () => 0))()) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "ctl1", userEmail: "cara@example.com", activeRole: "DocCtrl" }) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import BulkEditModal from "@/components/documents/BulkEditModal";
import { recallRetiredDocument } from "@/lib/staleCopies";
import type { DocumentRecord, LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "o1";
const ME = "ctl1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const recall = vi.mocked(recallRetiredDocument);
const recallsFor = (id: string) => recall.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((i) => i.documentId === id);

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
    status: "Issued", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null, metadata: {},
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`, ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: d.current_version_id, org_id: ORG, record_id: id, revision_label: "2" });
  return d;
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, documentNumber: d.document_number, title: d.title, rev: d.rev, status: d.status,
  metadata: d.metadata ?? {}, libraryId: "lib1", currentVersionId: (d.current_version_id as string | null) ?? undefined,
}) as unknown as DocumentRecord;
const LIB = { id: "lib1", orgId: ORG, customColumns: [], uniquenessKeys: ["documentNumber"] } as unknown as LibraryConfig;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.updatePayloads = [];
  state.zeroRow = new Set();
  state.recallImpl = null;
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
function setValue(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
const labelled = (label: string) => {
  const l = Array.from(host.querySelectorAll("label")).find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`no label "${label}"`);
  return l.parentElement!.querySelector("select") as HTMLSelectElement;
};
async function applyStatus(docs: DocumentRecord[], value: string) {
  const onApplied = vi.fn();
  await act(async () => {
    root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library: LIB, actorUserId: ME, onApplied }));
  });
  await act(async () => setValue(labelled("New value"), value));
  await act(async () => { button(`Apply to ${docs.length}`).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  return onApplied;
}

describe("PROD-17 (P26) — the bulk editor's retirement door recalls each retired row once", () => {
  for (const status of ["Archived", "Superseded"]) {
    it(`Issued rows set to ${status}: each written once, exactly as before, and recalled once (${status}, its label and library, neither personal notice sent by this door)`, async () => {
      const a = seedDoc("a1");
      const b = seedDoc("a2", { status: "Draft" });
      const onApplied = await applyStatus([asRecord(a), asRecord(b)], status);
      expect(host.textContent).toMatch(/Applied to 2 documents\./);
      expect(onApplied).toHaveBeenCalledTimes(1);
      // regression: one bare UPDATE per row, the columns it always wrote
      expect(state.updatePayloads).toHaveLength(2);
      for (const p of state.updatePayloads) expect(Object.keys(p).sort()).toEqual(["status", "updated_at", "updated_by"]);
      for (const id of ["a1", "a2"]) expect(docRow(id)).toMatchObject({ status, updated_by: ME });
      await settle();
      expect(recall).toHaveBeenCalledTimes(2);
      expect(recallsFor("a1")).toEqual([{
        orgId: ORG, documentId: "a1", libraryId: "lib1", docLabel: "A1", newStatus: status, replacementNote: null,
        actorUserId: ME, actorName: "cara@example.com",
        personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
      }]);
      expect(recallsFor("a2")).toHaveLength(1);
    });
  }

  it("a row this page already shows retired (Superseded → Archived) is written and recalls nothing again; the live row beside it does", async () => {
    const a = seedDoc("b1", { status: "Superseded" });
    const b = seedDoc("b2");
    await applyStatus([asRecord(a), asRecord(b)], "Archived");
    expect(host.textContent).toMatch(/Applied to 2 documents\./);
    expect(docRow("b1").status).toBe("Archived");
    await settle();
    expect(recallsFor("b1")).toHaveLength(0);
    expect(recallsFor("b2")).toHaveLength(1);
  });

  it("regression: a change that retires nothing (Issued → Draft / In Review) recalls nothing and is written as before", async () => {
    const a = seedDoc("c1");
    await applyStatus([asRecord(a)], "Draft");
    expect(docRow("c1").status).toBe("Draft");
    await act(async () => root.unmount());
    root = createRoot(host);
    const b = seedDoc("c2");
    await applyStatus([asRecord(b)], "In Review");
    expect(docRow("c2").status).toBe("In Review");
    await settle();
    expect(recall).not.toHaveBeenCalled();
  });

  it("a refused row (the database matched none) recalls nothing; the row written beside it is recalled", async () => {
    const a = seedDoc("d1");
    const b = seedDoc("d2");
    state.zeroRow.add("d1");
    await applyStatus([asRecord(a), asRecord(b)], "Archived");
    expect(host.textContent).toMatch(/no edit access to this document/);
    await settle();
    expect(recallsFor("d1")).toHaveLength(0);
    expect(recallsFor("d2")).toHaveLength(1);
  });

  it("a recall that never finishes does not hold the apply", async () => {
    state.recallImpl = () => new Promise(() => {});
    const a = seedDoc("e1");
    const onApplied = await applyStatus([asRecord(a)], "Archived");
    expect(host.textContent).toMatch(/Applied to 1 document/);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledTimes(1);
  });
});
