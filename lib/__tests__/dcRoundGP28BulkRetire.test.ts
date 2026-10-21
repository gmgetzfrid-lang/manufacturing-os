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
//   recalls. A change that retires nothing recalls nothing (since P34's
//   review fix 3 a status change reads the statuses once, for a row it moves
//   out of Archived; a custom-field change reads nothing).
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
  emits: [] as Array<Record<string, unknown>>,
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
// DIST-16 (P28 fix pass): the bulk put-back's withdrawal is the REAL
// withdrawRetirementBatch (only the dispatcher's emit is a spy), so the
// test counts what a holder is actually sent.
vi.mock("@/lib/staleCopies", async () => {
  const real = await vi.importActual<typeof import("@/lib/staleCopies")>("@/lib/staleCopies");
  return {
    recallRetiredDocument: vi.fn(async () => 0),
    recallRetiredBatch: vi.fn(async () => 0),
    withdrawRetirementRecall: vi.fn(async () => 0),
    withdrawRetirementBatch: vi.fn(real.withdrawRetirementBatch),
  };
});
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (p: Record<string, unknown>) => { state.emits.push(p); }) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "ctl1", userEmail: "cara@example.com", activeRole: "DocCtrl" }) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import BulkEditModal from "@/components/documents/BulkEditModal";
import { recallRetiredBatch, recallRetiredDocument, withdrawRetirementRecall, withdrawRetirementBatch } from "@/lib/staleCopies";
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
  state.emits = [];
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
async function apply(docs: DocumentRecord[], value: string, field?: string, reason = "Obsolete unit") {
  await act(async () => {
    root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library: LIB, actorUserId: ME, onApplied: () => {} }));
  });
  if (field) await act(async () => setValue(labelled("Field to change") as HTMLSelectElement, field));
  const v = labelled("New value");
  await act(async () => setValue(v, value));
  // REV-31 (the P28 integrator fix pass): a change to Archived asks one reason for the apply —
  // (document-control P31) so does a change to Superseded
  if (value === "Archived" && !field && reason) await act(async () => setValue(labelled("Reason for archiving") as HTMLInputElement, reason));
  if (value === "Superseded" && !field && reason) await act(async () => setValue(labelled("Reason for superseding") as HTMLInputElement, reason));
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
      // DIST-16 done-when 2 (the P28 integrator fix pass): every retired row goes with its prior as
      // retiredFrom — the already-retired row is no longer left out here; its recall record decides
      expect(batch.mock.calls[0][0]).toEqual({
        orgId: ORG, newStatus: to, actorUserId: ME, actorName: "cara@example.com",
        docs: [
          { documentId: "a1", libraryId: "lib1", docLabel: "A1", recallCopyHolders: true, retiredFrom: "Issued" },
          { documentId: "a2", libraryId: "lib1", docLabel: "A2", recallCopyHolders: false, retiredFrom: "Draft" },
          { documentId: "a3", libraryId: "lib1", docLabel: "A3", recallCopyHolders: false, retiredFrom: to },
        ],
      });
    });
  }

  it("the fresh read decides over the page's copy: a row the page shows Draft that is Issued in the database recalls its copy holders", async () => {
    const a = seedDoc("f1");
    await apply([asRecord(a, "Draft")], "Archived");
    expect(batch.mock.calls[0][0].docs).toEqual([{ documentId: "f1", libraryId: "lib1", docLabel: "F1", recallCopyHolders: true, retiredFrom: "Issued" }]);
  });

  it("a read that fails leaves the priors unknown, which recalls (a second recall over none); the writes go as before", async () => {
    const a = seedDoc("g1", { status: "Draft" });
    state.db.selectErrors!.documents = (cols) => (cols === "id, status" ? { message: "503" } : null);
    await apply([asRecord(a)], "Archived");
    expect(docRow("g1").status).toBe("Archived");
    expect(batch.mock.calls[0][0].docs).toEqual([{ documentId: "g1", libraryId: "lib1", docLabel: "G1", recallCopyHolders: true, retiredFrom: null }]);
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

  it("REGRESSION: a change that retires nothing (Draft; a custom field) recalls nothing; a custom field reads nothing", async () => {
    const a = seedDoc("k1");
    await apply([asRecord(a)], "Draft");
    // P34 review fix 3 (REV-34 (b)): a status change reads the rows' statuses
    // once (a row moved out of Archived has its archive columns cleared); a
    // row that was not Archived is written exactly as before.
    expect(reads()).toHaveLength(1);
    expect(writes()).toHaveLength(1);
    expect(Object.keys(writes()[0].args[0] as Row)).not.toContain("archived_at");
    expect(batch).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    await apply([asRecord(seedDoc("k2"))], "North", "custom:area");
    // the custom-field change adds no read (the one above is the Draft change's)
    expect(reads()).toHaveLength(1);
    expect(batch).not.toHaveBeenCalled();
  });

  it("DIST-16 (P28 fix pass): a retired row put back to Issued goes through changeDocumentStatus with no withdrawal of its own; ONE batched withdrawal goes after the apply", async () => {
    const a = seedDoc("p1", { status: "Archived" });
    await apply([asRecord(a)], "Issued");
    expect(docRow("p1").status).toBe("Issued");
    expect(withdrawRetirementRecall).not.toHaveBeenCalled();
    expect(withdrawRetirementBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withdrawRetirementBatch).mock.calls[0][0]).toEqual({
      orgId: ORG, door: "put_back", actorUserId: ME, actorName: "cara@example.com",
      docs: [{ documentId: "p1", libraryId: "lib1", docLabel: "P1", restoredStatus: "Issued" }],
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("DIST-16 (P28 fix pass): 2 Archived rows set to Issued, one holder recalled on both — exactly ONE withdrawal emit for that holder (never one preference-exempt notice per row); each document's withdrawal recorded", async () => {
    const a = seedDoc("q1", { status: "Archived" });
    const b = seedDoc("q2", { status: "Archived" });
    for (const [id, at] of [["q1", "2026-10-19T09:00:00.000Z"], ["q2", "2026-10-19T09:00:01.000Z"]]) {
      T("audit_logs").push({ id: `a-${id}`, org_id: ORG, action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: id, timestamp: at, details: { retirement: true, newStatus: "Archived", recipientCount: 1, recipients: ["fitter9"] } });
      // the recall named a copy holder the download record bears out (P28 second fix pass)
      T("download_audits").push({ document_id: id, user_id: "fitter9", version_id: `${id}-v2`, created_at: at });
    }
    await apply([asRecord(a), asRecord(b)], "Issued");
    expect(host.textContent).toMatch(/Applied to 2 documents\./);
    expect(withdrawRetirementRecall).not.toHaveBeenCalled();
    expect(withdrawRetirementBatch).toHaveBeenCalledTimes(1);
    const w = state.emits.filter((e) => e.kind === "library_doc_revised");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ category: "recall", audience: { involved: ["fitter9"] }, actorUserId: ME, metadata: { recallWithdrawn: true, documentIds: ["q1", "q2"], door: "put_back" } });
    const recorded = T("audit_logs").filter((r) => r.action === "DISTRIBUTION_RECALL" && (r.details as Record<string, unknown>).recallWithdrawn === true);
    expect(recorded.map((r) => r.resource_id).sort()).toEqual(["q1", "q2"]);
  });

  it("DIST-16 (P28 second fix pass): the pre-apply status read fails — every written row's prior is UNKNOWN, so each is a put-back candidate; a recalled Archived row set to Issued is withdrawn", async () => {
    const rows = ["u1", "u2", "u3"].map((id) => seedDoc(id, { status: "Archived" }));
    T("audit_logs").push({ id: "a-u2", org_id: ORG, action: "DISTRIBUTION_RECALL", resource_type: "document", resource_id: "u2", timestamp: "2026-10-19T09:00:00.000Z", details: { retirement: true, newStatus: "Archived", recipientCount: 1, recipients: ["fitter9"] } });
    T("download_audits").push({ document_id: "u2", user_id: "fitter9", version_id: "u2-v2", created_at: "2026-10-01T09:00:00.000Z" });
    state.db.selectErrors!.documents = (cols) => (cols === "id, status" ? { message: "503" } : null);
    await apply(rows.map((r) => asRecord(r)), "Issued");
    for (const id of ["u1", "u2", "u3"]) expect(docRow(id).status).toBe("Issued");
    expect(reads()).toHaveLength(1);
    expect(withdrawRetirementBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withdrawRetirementBatch).mock.calls[0][0].docs.map((d) => d.documentId)).toEqual(["u1", "u2", "u3"]);
    const w = state.emits.filter((e) => e.kind === "library_doc_revised");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ category: "recall", audience: { involved: ["fitter9"] }, resource: { type: "document", id: "u2" }, metadata: { recallWithdrawn: true, door: "put_back" } });
  });

  it("DIST-16 (P28 fix pass): a row already Issued re-saved as Issued is no put-back candidate; a Draft row issued is one (the record decides — nothing stands, nothing sent)", async () => {
    const a = seedDoc("r1");
    const b = seedDoc("r2", { status: "Draft" });
    await apply([asRecord(a), asRecord(b)], "Issued");
    expect(vi.mocked(withdrawRetirementBatch).mock.calls[0][0].docs.map((d) => d.documentId)).toEqual(["r2"]);
    expect(state.emits.filter((e) => e.kind === "library_doc_revised")).toHaveLength(0);
  });
});

// ─── REV-31 (document-control P28, the integrator's fix pass at the merge, DEC-90) ──
describe("REV-31 (P28 integrator fix pass) — the bulk editor's Archived does what the Archive dialog does around each archive", () => {
  const archiveDocs = () => T("audit_logs").filter((r) => r.action === "ARCHIVE_DOC");

  it("one reason for the apply: each written row carries the archive columns in its same write, and gets its draft voided, its links revoked and an ARCHIVE_DOC record; a refused row gets none of it; the recall is the one batch, as before", async () => {
    const a = seedDoc("v1", { pending_version_id: "v1-v3" });
    T("document_versions").push({ id: "v1-v3", org_id: ORG, record_id: "v1", revision_label: "3", superseded_at: null });
    T("document_shares").push({ id: "sh1", document_id: "v1", org_id: ORG, revoked_at: null, expires_at: null });
    const b = seedDoc("v2", { status: "Draft" });
    const c = seedDoc("v3");
    state.refuse.v3 = "new row violates row-level security policy";
    await apply([asRecord(a), asRecord(b), asRecord(c)], "Archived", undefined, "  Superseded by the 2027 set ");
    expect(host.textContent).toMatch(/Applied to 2 documents\./);
    // REGRESSION: one write per row, as before — now carrying the archive columns
    expect(writes()).toHaveLength(3 + 1); // three row writes and v1's draft pointer release
    for (const id of ["v1", "v2"]) expect(docRow(id)).toMatchObject({ status: "Archived", archived_by: ME, archive_reason: "Superseded by the 2027 set", updated_by: ME });
    expect(docRow("v3").status).toBe("Issued");
    expect(docRow("v1").pending_version_id).toBeNull();
    expect(T("document_shares")[0].revoked_at).toBeTruthy();
    expect(archiveDocs().map((r) => [r.resource_id, (r.details as Row).reason, (r.details as Row).via, (r.details as Row).action]).sort()).toEqual([
      ["v1", "Superseded by the 2027 set", "bulk_edit", "archive"],
      ["v2", "Superseded by the 2027 set", "bulk_edit", "archive"],
    ]);
    expect((archiveDocs().find((r) => r.resource_id === "v1")!.details as Row)).toMatchObject({ pendingDraftVoided: "v1-v3", revokedShareLinks: 1, versionId: "v1-v2" });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0].docs.map((d) => d.documentId)).toEqual(["v1", "v2"]);
    expect(host.querySelector('[data-testid="bulk-archive-follow-ups"]')).toBeNull();
  });

  it("Apply waits for the reason; the ARCHIVE reason is asked only for Archived — Superseded and the other statuses write exactly as before (no archive columns, no ARCHIVE_DOC; Superseded asks its own reason since P31 — dcRoundGP31BulkSupersede.test.ts)", async () => {
    const a = seedDoc("x1");
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs: [asRecord(a)], library: LIB, actorUserId: ME, onApplied: () => {} }));
    });
    await act(async () => setValue(labelled("New value"), "Archived"));
    expect(button("Apply to 1").disabled).toBe(true);
    await act(async () => setValue(labelled("Reason for archiving") as HTMLInputElement, "   "));
    expect(button("Apply to 1").disabled).toBe(true);
    await act(async () => setValue(labelled("Reason for archiving") as HTMLInputElement, "tidy"));
    expect(button("Apply to 1").disabled).toBe(false);
    await act(async () => setValue(labelled("New value"), "Superseded"));
    expect(Array.from(host.querySelectorAll("label")).some((l) => l.textContent?.trim() === "Reason for archiving")).toBe(false);
    // P31 final fix pass: the reason typed for Archived does not carry over —
    // Superseded waits for its own (dcRoundGP31BulkSupersede.test.ts).
    expect(button("Apply to 1").disabled).toBe(true);
    await act(async () => setValue(labelled("Reason for superseding") as HTMLInputElement, "replaced"));
    await act(async () => { button("Apply to 1").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(docRow("x1").status).toBe("Superseded");
    expect(docRow("x1")).not.toHaveProperty("archive_reason");
    expect(docRow("x1")).not.toHaveProperty("archived_at");
    expect(archiveDocs()).toEqual([]);
  });

  it("a duty that did not complete is said after the apply, its row named; the archive stands", async () => {
    const a = seedDoc("y1");
    T("document_shares").push({ id: "sh2", document_id: "y1", org_id: ORG, revoked_at: null, expires_at: null });
    state.db.beforeUpdate!.document_shares = () => { throw { code: "42501", message: "permission denied" }; };
    await apply([asRecord(a)], "Archived");
    expect(docRow("y1").status).toBe("Archived");
    const box = host.querySelector('[data-testid="bulk-archive-follow-ups"]');
    expect(box?.textContent).toMatch(/1 archived row — follow-up steps did not complete/);
    expect(box?.textContent).toMatch(/Y1 — its share links could not be revoked \(permission denied\); 1 share link is still live on it/);
    expect(archiveDocs()).toHaveLength(1);
  });
});
