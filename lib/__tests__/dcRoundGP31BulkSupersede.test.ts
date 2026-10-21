// @vitest-environment jsdom
//
// document-control Round G — P31 RETIREMENT DOOR PARITY (REV-31's remainder,
// DEC-31; ruled under DEC-90): the bulk editor's Superseded does what
// supersedeDocument does around a supersession — its three retirement duties
// (draft void, link revoke, record; not its pre-write gates, REV-33, or its
// ack closure and personal notices, REV-34).
//
//   One reason for the apply ("Reason for superseding" — Apply waits for it);
//   each row's write EXACTLY as before (the status, the recomputed key,
//   updated_at / updated_by — no supersession column); for every row the
//   change RETIRED (its fresh prior not Superseded, or unread), after the
//   apply: the review draft voided, the live share links revoked and the
//   SUPERSEDE_DOC record with the reason and `retiredFrom`
//   (lib/revisions.ts finishRetirementDuties); a row already Superseded, a
//   refused row and a change to a non-retired status get no new duty; the ONE
//   batched recall as before; a duty that did not complete is listed.
//
// Rendered (jsdom) against the in-memory PostgREST with the REAL
// BulkEditModal and lib/revisions.ts; lib/staleCopies.ts is a spy (the
// harness of dcRoundGP28BulkRetire.test.ts).

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
import { recallRetiredBatch } from "@/lib/staleCopies";
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
const writes = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "update");

const supersedeDocs = () => T("audit_logs").filter((r) => r.action === "SUPERSEDE_DOC");
function seedDraftAndShare(id: string) {
  docRow(id).pending_version_id = `${id}-v3`;
  T("document_versions").push({ id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null });
  T("document_review_signoffs").push({ id: `${id}-so`, document_version_id: `${id}-v3`, status: "pending" });
  T("document_shares").push({ id: `${id}-sh`, document_id: id, org_id: ORG, revoked_at: null, expires_at: null });
}
const statusWrites = () => writes().filter((c) => "status" in (c.args[0] as Row));

describe("REV-31 (P31) — the bulk editor's Superseded does supersedeDocument's three retirement duties (draft void, link revoke, record)", () => {
  it("one reason for the apply; each row written EXACTLY as before (same columns); the Issued and Draft rows (retired by it) get the draft voided, the links revoked and a SUPERSEDE_DOC with the reason and retiredFrom; the row already Superseded and the refused row get none; one batched recall as before", async () => {
    const a = seedDoc("s1"); seedDraftAndShare("s1");
    const b = seedDoc("s2", { status: "Draft" });
    const c = seedDoc("s3", { status: "Superseded" }); seedDraftAndShare("s3");
    const d = seedDoc("s4"); seedDraftAndShare("s4");
    state.refuse.s4 = "new row violates row-level security policy";
    await apply([asRecord(a), asRecord(b), asRecord(c), asRecord(d)], "Superseded", undefined, "  Replaced by the 2027 set ");
    expect(host.textContent).toMatch(/Applied to 3 documents\./);
    // REGRESSION: one write per row with exactly the columns it carried before
    expect(statusWrites()).toHaveLength(4);
    for (const w of statusWrites()) expect(Object.keys(w.args[0] as Row).sort()).toEqual(["status", "uniqueness_key", "updated_at", "updated_by"]);
    for (const id of ["s1", "s2", "s3"]) {
      expect(docRow(id)).toMatchObject({ status: "Superseded", updated_by: ME });
      expect(docRow(id)).not.toHaveProperty("supersession_reason");
      expect(docRow(id)).not.toHaveProperty("superseded_by_user");
    }
    expect(docRow("s4").status).toBe("Issued");
    // the duties: the retired rows only
    expect(docRow("s1").pending_version_id).toBeNull();
    expect(docRow("s3").pending_version_id).toBe("s3-v3");
    expect(docRow("s4").pending_version_id).toBe("s4-v3");
    expect(T("document_shares").map((r) => [r.id, !!r.revoked_at])).toEqual([["s1-sh", true], ["s3-sh", false], ["s4-sh", false]]);
    expect(supersedeDocs().map((r) => [r.resource_id, (r.details as Row).reason, (r.details as Row).via, (r.details as Row).retiredFrom]).sort()).toEqual([
      ["s1", "Replaced by the 2027 set", "bulk_edit", "Issued"],
      ["s2", "Replaced by the 2027 set", "bulk_edit", "Draft"],
    ]);
    expect(supersedeDocs().find((r) => r.resource_id === "s1")!.details).toMatchObject({ pendingDraftVoided: "s1-v3", revokedShareLinks: 1, replacementDocNumbers: [], mocReference: null, versionId: "s1-v2" });
    expect(supersedeDocs()[0]).toMatchObject({ user_id: ME, user_email: "cara@example.com", user_role: "DocCtrl" });
    // the recall: the one batch, exactly as P28 sends it
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0].docs.map((x) => [x.documentId, x.retiredFrom])).toEqual([["s1", "Issued"], ["s2", "Draft"], ["s3", "Superseded"]]);
    expect(host.querySelector('[data-testid="bulk-archive-follow-ups"]')).toBeNull();
  });

  it("Apply waits for the reason (\"Reason for superseding\"); the reason is the one the apply records", async () => {
    const a = seedDoc("w1");
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs: [asRecord(a)], library: LIB, actorUserId: ME, onApplied: () => {} }));
    });
    await act(async () => setValue(labelled("New value"), "Superseded"));
    expect(button("Apply to 1").disabled).toBe(true);
    await act(async () => setValue(labelled("Reason for superseding") as HTMLInputElement, "  "));
    expect(button("Apply to 1").disabled).toBe(true);
    await act(async () => setValue(labelled("Reason for superseding") as HTMLInputElement, "Withdrawn"));
    expect(button("Apply to 1").disabled).toBe(false);
    expect(host.textContent).toMatch(/Superseding retires each row: its review draft is voided, its live share links revoked/);
    // P31 fix pass: the copy holders are recalled only out of a controlled issue.
    expect(host.textContent).toMatch(/its copy holders recalled if it was issued, and its watchers told/);
    expect(host.textContent).not.toMatch(/its copy holders recalled and its watchers told/);
    await act(async () => { button("Apply to 1").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(supersedeDocs().map((r) => (r.details as Row).reason)).toEqual(["Withdrawn"]);
  });

  it("a prior the fresh read cannot give: the row's duties run (fail-safe), the record saying the prior is unknown", async () => {
    const a = seedDoc("u1", { status: "Superseded" });
    state.db.selectErrors!.documents = (cols) => (cols === "id, status" ? { message: "503" } : null);
    await apply([asRecord(a)], "Superseded", undefined, "r");
    expect(supersedeDocs().map((r) => r.details)).toEqual([expect.objectContaining({ retiredFrom: null, priorStatusUnknown: true })]);
  });

  it("a duty that did not complete is listed after the apply, its row named; the supersession stands", async () => {
    const a = seedDoc("f1"); seedDraftAndShare("f1");
    state.db.beforeUpdate!.document_shares = () => { throw { code: "42501", message: "permission denied" }; };
    await apply([asRecord(a)], "Superseded", undefined, "r");
    expect(docRow("f1").status).toBe("Superseded");
    const box = host.querySelector('[data-testid="bulk-archive-follow-ups"]');
    expect(box?.textContent).toMatch(/1 superseded row — follow-up steps did not complete/);
    expect(box?.textContent).toMatch(/The supersession stands and is not rolled back/);
    expect(box?.textContent).toMatch(/F1 — its share links could not be revoked \(permission denied\); 1 share link is still live on it/);
    expect(supersedeDocs()).toHaveLength(1);
  });

  it("REGRESSION — Archived keeps P28's duties (now with retiredFrom on its record); Draft / Issued / a custom field ask no reason and write no retirement record", async () => {
    const a = seedDoc("r1");
    await apply([asRecord(a)], "Archived", undefined, "tidy");
    expect(T("audit_logs").filter((r) => r.action === "ARCHIVE_DOC").map((r) => r.details)).toEqual([expect.objectContaining({ reason: "tidy", via: "bulk_edit", action: "archive", retiredFrom: "Issued" })]);
    for (const [value, field] of [["Draft", undefined], ["North", "custom:area"]] as const) {
      await act(async () => root.unmount());
      root = createRoot(host);
      const d = seedDoc(`r-${value}`);
      await act(async () => {
        root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs: [asRecord(d)], library: LIB, actorUserId: ME, onApplied: () => {} }));
      });
      if (field) await act(async () => setValue(labelled("Field to change") as HTMLSelectElement, field));
      await act(async () => setValue(labelled("New value"), value));
      expect(Array.from(host.querySelectorAll("label")).some((l) => /^Reason for/.test(l.textContent?.trim() ?? ""))).toBe(false);
      await act(async () => { button("Apply to 1").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await settle();
    }
    expect(T("audit_logs").filter((r) => ["SUPERSEDE_DOC", "VOID_DOC"].includes(String(r.action)))).toEqual([]);
    expect(T("audit_logs").filter((r) => r.action === "ARCHIVE_DOC")).toHaveLength(1);
  });
});
