// @vitest-environment jsdom
//
// document-control Round G — P34 STATUS EDITOR RETIREMENT PARITY II, the bulk
// editor (REV-33, REV-34 (c) / (d); ruled by the integrator at the P31 merge,
// 2026-10-21, DEC-90 — fail-safe, no regression).
//
//   A change to Superseded runs supersedeDocument's pre-write gates per row it
//   would retire: a drawing-class row needs the MOC reference ("MOC
//   reference", one for the apply) — refused and named without it, nothing
//   written for it; a row someone else has checked out is superseded over
//   their checkout with the reason (the holder told after the write); a row
//   under an active hold is refused whoever applies it — the editor is shown
//   only to controllers, and the database's guard lets a controller through
//   before its hold check (P34 review fix). A non-drawing, unlocked, unheld
//   row writes exactly as before. The MOC recorded is the one the row's gate
//   accepted — none on a row already Superseded. Each superseded row's
//   pending acks are closed; a row already Superseded gets the duties with a
//   record that claims no retirement (alreadyRetired), and no gate.
//
// Rendered (jsdom) against the in-memory PostgREST with the REAL
// BulkEditModal and lib/revisions.ts (the harness of
// dcRoundGP31BulkSupersede.test.ts); the class resolver is a stub.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  cls: {} as Record<string, string>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return { ...real, rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }) };
  },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), makeLibraryStoragePath: vi.fn(), uniqueUploadName: (n: string) => n }));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "DocCtrl", roles: ["DocCtrl"] })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => true) }));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({
  recallRetiredDocument: vi.fn(async () => 0), recallRetiredBatch: vi.fn(async () => 0),
  withdrawRetirementRecall: vi.fn(async () => 0), withdrawRetirementBatch: vi.fn(async () => 0),
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));
// P34 final fix pass: finishRetirementDuties closes a superseded row's acks through
// closeStaleAcksForDocumentChecked — the real statement, against this file's database.
vi.mock("@/lib/distributionAcks", async (importOriginal) => ({
  closeStaleAcksForDocument: vi.fn(async () => 0),
  closeStaleAcksForDocumentChecked: (await importOriginal<typeof import("@/lib/distributionAcks")>()).closeStaleAcksForDocumentChecked,
}));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async (d: { id?: string | null }) => state.cls[String(d.id)] ?? null) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "ctl1", userEmail: "cara@example.com", activeRole: "DocCtrl" }) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import BulkEditModal from "@/components/documents/BulkEditModal";
import { recallRetiredBatch } from "@/lib/staleCopies";
import { notifyPackagesOfRetirement } from "@/lib/postPublish";
import { notify } from "@/lib/inAppNotifications";
import { SUPERSEDE_MOC_REQUIRED } from "@/lib/revisions";
import { shareStatusRefusal } from "@/lib/shareRules";
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
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`, checked_out_by: null, checked_out_by_name: null, ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v2`, org_id: ORG, record_id: id, revision_label: "2" });
  return d;
}
function seedShare(id: string) {
  T("document_shares").push({ id: `${id}-sh`, document_id: id, org_id: ORG, revoked_at: null, expires_at: null });
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, documentNumber: d.document_number, title: d.title, rev: d.rev, status: d.status,
  metadata: d.metadata ?? {}, libraryId: "lib1", collectionId: null, currentVersionId: (d.current_version_id as string | null) ?? undefined,
}) as unknown as DocumentRecord;
const LIB = { id: "lib1", orgId: ORG, customColumns: [{ key: "area", label: "Area", type: "text" }], uniquenessKeys: ["documentNumber", "status"] } as unknown as LibraryConfig;

let host: HTMLDivElement;
let root: Root;
let errorSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.cls = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  errorSpy.mockRestore();
  infoSpy.mockRestore();
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
async function apply(docs: DocumentRecord[], value: string, opts: { reason?: string; moc?: string } = {}) {
  await act(async () => {
    root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library: LIB, actorUserId: ME, onApplied: () => {} }));
  });
  await act(async () => setValue(labelled("New value"), value));
  if (value === "Superseded") await act(async () => setValue(labelled("Reason for superseding") as HTMLInputElement, opts.reason ?? "Replaced by the 2027 set"));
  if (value === "Archived") await act(async () => setValue(labelled("Reason for archiving") as HTMLInputElement, opts.reason ?? "Tidy"));
  if (opts.moc !== undefined) await act(async () => setValue(labelled("MOC reference") as HTMLInputElement, opts.moc!));
  await act(async () => { button(`Apply to ${docs.length}`).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
const statusWrites = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "update" && "status" in (c.args[0] as Row));
const supersedeDocs = () => T("audit_logs").filter((r) => r.action === "SUPERSEDE_DOC");
const rec = (id: string) => supersedeDocs().find((r) => r.resource_id === id)?.details as Row | undefined;

describe("REV-33 (P34) — the bulk editor's Superseded takes supersedeDocument's pre-write gates, per row", () => {
  it("no MOC typed: the drawing-class row is refused and named, NOTHING written for it; the non-drawing row is written exactly as before; one batched recall for the written row only", async () => {
    const dwg = seedDoc("d1"); state.cls.d1 = "drawing"; seedShare("d1");
    const txt = seedDoc("p1");
    await apply([asRecord(dwg), asRecord(txt)], "Superseded");
    expect(host.textContent).toMatch(/Applied to 1 document\./);
    const refused = host.querySelector('[data-testid="bulk-refused-rows"]')!.textContent!;
    expect(refused).toContain(`D1 — not superseded, nothing was written for it — ${SUPERSEDE_MOC_REQUIRED}`);
    expect(docRow("d1").status).toBe("Issued");
    expect(T("document_shares")[0].revoked_at).toBeNull();
    expect(rec("d1")).toBeUndefined();
    // REGRESSION: the non-drawing row — one write, exactly the columns it carried before
    expect(statusWrites().map((c) => c.args[0] as Row).map((r) => Object.keys(r).sort())).toEqual([["status", "uniqueness_key", "updated_at", "updated_by"]]);
    expect(docRow("p1").status).toBe("Superseded");
    expect(rec("p1")).toMatchObject({ retiredFrom: "Issued", mocReference: null, via: "bulk_edit" });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0].docs.map((x) => x.documentId)).toEqual(["p1"]);
  });

  it("with the MOC typed: the drawing-class row is written as before and its SUPERSEDE_DOC carries the reference; the non-drawing rows (a procedure, an unresolvable class) record mocReference: null exactly as before (P34 final fix pass)", async () => {
    const dwg = seedDoc("d2"); state.cls.d2 = "drawing";
    const txt = seedDoc("p2");
    const proc = seedDoc("q2"); state.cls.q2 = "procedure";
    await apply([asRecord(dwg), asRecord(txt), asRecord(proc)], "Superseded", { moc: " MOC-2026-0142 " });
    expect(host.textContent).toMatch(/Applied to 3 documents\./);
    expect(host.querySelector('[data-testid="bulk-refused-rows"]')).toBeNull();
    for (const w of statusWrites()) expect(Object.keys(w.args[0] as Row).sort()).toEqual(["status", "uniqueness_key", "updated_at", "updated_by"]);
    expect(rec("d2")).toMatchObject({ mocReference: "MOC-2026-0142", retiredFrom: "Issued" });
    // REGRESSION (pin): a non-drawing row records no MOC, as before P34 — the typed one is the drawing rows'
    expect(rec("p2")).toMatchObject({ mocReference: null, retiredFrom: "Issued" });
    expect(rec("q2")).toMatchObject({ mocReference: null, retiredFrom: "Issued" });
    expect(docRow("d2")).not.toHaveProperty("supersession_moc");
  });

  it("P34 final fix pass — the MOC field's help says the one reference goes on every drawing-class row of this apply, and to split the apply for sheets under different MOCs", async () => {
    const dwg = seedDoc("d3"); state.cls.d3 = "drawing";
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs: [asRecord(dwg)], library: LIB, actorUserId: ME, onApplied: () => {} }));
    });
    await act(async () => setValue(labelled("New value"), "Superseded"));
    expect(host.textContent).not.toContain("recorded on each superseded document");
    expect(host.textContent).toContain("The one reference is recorded on every drawing-class document this apply supersedes — if the sheets belong to different MOCs, split the apply.");
  });

  it("a row someone else has checked out is superseded over their checkout with the reason: written, the holder told (the existing kind, with the reason), its pending acks closed", async () => {
    const l = seedDoc("k1", { checked_out_by: "eng9", checked_out_by_name: "Eli" });
    T("distribution_acks").push({ id: "ak1", document_id: "k1", version_id: "k1-v2", acknowledged_at: null, superseded_at: null });
    await apply([asRecord(l)], "Superseded", { reason: "Withdrawn" });
    expect(docRow("k1").status).toBe("Superseded");
    expect(vi.mocked(notify).mock.calls.map((c) => c[0] as unknown as Row)).toEqual([expect.objectContaining({
      userId: "eng9", kind: "revision_published_over_checkout", body: "Superseded by cara@example.com: Withdrawn", link: "/documents/lib1?doc=k1",
    })]);
    expect(T("distribution_acks")[0].superseded_at).toBeTruthy();
    expect(host.querySelector('[data-testid="bulk-archive-follow-ups"]')).toBeNull();
  });

  it("REV-35 (document-control P36): the row superseded over another person's checkout carries the duties' answer into the batched recall (its holder told → left out of its FYI); the row with no foreign checkout carries none (exactly as before); each superseded row's open packages' owners are told", async () => {
    const l = seedDoc("q1", { checked_out_by: "eng9", checked_out_by_name: "Eli" });
    const f = seedDoc("q2");
    await apply([asRecord(l), asRecord(f)], "Superseded", { reason: "Withdrawn" });
    expect(batch).toHaveBeenCalledTimes(1);
    const docs = batch.mock.calls[0][0].docs;
    const q1 = docs.find((d) => d.documentId === "q1")!;
    const q2 = docs.find((d) => d.documentId === "q2")!;
    expect(await q1.checkoutHolderTold).toBe(true);
    expect("checkoutHolderTold" in q2).toBe(false);
    const told = vi.mocked(notifyPackagesOfRetirement).mock.calls.map((c) => (c[0] as { documentId: string; newStatus: string }));
    expect(told).toHaveLength(2);
    expect(told).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: "q1", newStatus: "Superseded" }), expect.objectContaining({ documentId: "q2", newStatus: "Superseded" }),
    ]));
  });

  it("REV-35 (P36): the holder's notice could not be sent — the batched recall's answer for that row is false (they stay in its FYI)", async () => {
    vi.mocked(notify).mockResolvedValueOnce(false as never);
    const l = seedDoc("q3", { checked_out_by: "eng9", checked_out_by_name: "Eli" });
    await apply([asRecord(l)], "Superseded", { reason: "Withdrawn" });
    expect(await batch.mock.calls[0][0].docs[0].checkoutHolderTold).toBe(false);
  });

  it("P34 review fix — Document Control (a controller) applying Superseded: a row under an active hold is refused and named, NOTHING written for it (the Supersede dialog's refusal, worded for a supersession); the unheld row is written as before", async () => {
    const h = seedDoc("h1"); seedShare("h1");
    T("document_holds").push({ id: "h1-h", org_id: ORG, document_id: "h1", reason: "Safety review", released_at: null, opened_at: "2026-10-01" });
    const ok = seedDoc("h2");
    await apply([asRecord(h), asRecord(ok)], "Superseded", { moc: "MOC-2026-0142" });
    expect(host.textContent).toMatch(/Applied to 1 document\./);
    expect(host.querySelector('[data-testid="bulk-refused-rows"]')!.textContent).toContain(
      // P34 review fix 2: Document Control is told the paths that exist, never to ask itself.
      "H1 — not superseded, nothing was written for it — This document has an active hold (Safety review). A held document is not superseded from a status editor — once the hold is resolved, release it from the document's hold strip and set the status again; or, if the document is being replaced by a split or merge, run that instead (it proceeds over the hold and carries it to the new document).",
    );
    expect(host.querySelector('[data-testid="bulk-refused-rows"]')!.textContent).not.toContain("ask Document Control");
    expect(docRow("h1").status).toBe("Issued");
    expect(T("document_shares")[0].revoked_at).toBeNull();
    expect(rec("h1")).toBeUndefined();
    expect(statusWrites()).toHaveLength(1);
    expect(docRow("h2").status).toBe("Superseded");
    expect(batch.mock.calls[0][0].docs.map((x) => x.documentId)).toEqual(["h2"]);
  });

  it("P34 review fix — a hold state that cannot be read refuses the row (fail-closed), nothing written for it", async () => {
    const h = seedDoc("h3");
    state.db.selectErrors!.document_holds = () => ({ message: "503" });
    await apply([asRecord(h)], "Superseded");
    expect(host.querySelector('[data-testid="bulk-refused-rows"]')!.textContent).toContain(
      "H3 — not superseded, nothing was written for it — Couldn't read whether the document is checked out or on hold (503) — nothing was superseded.",
    );
    expect(docRow("h3").status).toBe("Issued");
    expect(statusWrites()).toEqual([]);
  });

  it("P34 review fix — the MOC typed for this apply is NOT written onto a row already Superseded (no gate ran; this apply did not supersede it); the row it did supersede carries it", async () => {
    const old = seedDoc("o1", { status: "Superseded" }); state.cls.o1 = "drawing";
    const now = seedDoc("o2"); state.cls.o2 = "drawing";
    await apply([asRecord(old), asRecord(now)], "Superseded", { moc: "MOC-2026-0142" });
    expect(rec("o1")).toMatchObject({ alreadyRetired: true, mocReference: null });
    expect(rec("o2")).toMatchObject({ retiredFrom: "Issued", mocReference: "MOC-2026-0142" });
  });

  it("REV-34 (d): a row already Superseded takes no gate (no MOC asked of a drawing, no retirement made) but gets the duties — its live link revoked, its acks closed — its record saying alreadyRetired; its holder is not told", async () => {
    const s = seedDoc("s1", { status: "Superseded", checked_out_by: "eng9" }); state.cls.s1 = "drawing"; seedShare("s1");
    T("distribution_acks").push({ id: "ak2", document_id: "s1", version_id: "s1-v2", acknowledged_at: null, superseded_at: null });
    await apply([asRecord(s)], "Superseded");
    expect(host.textContent).toMatch(/Applied to 1 document\./);
    expect(T("document_shares")[0].revoked_at).toBeTruthy();
    expect(T("distribution_acks")[0].superseded_at).toBeTruthy();
    expect(rec("s1")).toMatchObject({ alreadyRetired: true });
    expect(rec("s1")).not.toHaveProperty("retiredFrom");
    expect(notify).not.toHaveBeenCalled();
    expect(state.db.calls.some((c) => c.table === "documents" && c.method === "select" && c.args[0] === "checked_out_by, checked_out_by_name")).toBe(false);
  });

  it("the MOC field shows only for Superseded and is cleared with the reason when the status changes", async () => {
    const a = seedDoc("m1");
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs: [asRecord(a)], library: LIB, actorUserId: ME, onApplied: () => {} }));
    });
    const hasMoc = () => Array.from(host.querySelectorAll("label")).some((l) => l.textContent?.trim() === "MOC reference");
    expect(hasMoc()).toBe(false);
    await act(async () => setValue(labelled("New value"), "Superseded"));
    expect(hasMoc()).toBe(true);
    expect(host.textContent).toMatch(/A drawing-class document is superseded only with its MOC reference \(PSM, OSHA 1910\.119\(l\)\)/);
    await act(async () => setValue(labelled("MOC reference") as HTMLInputElement, "MOC-1"));
    await act(async () => setValue(labelled("New value"), "Archived"));
    expect(hasMoc()).toBe(false);
    await act(async () => setValue(labelled("New value"), "Superseded"));
    expect((labelled("MOC reference") as HTMLInputElement).value).toBe("");
  });

  it("REGRESSION — Archived runs no gate (a drawing row checked out by someone else is archived as before) and closes no acks; Draft writes as before", async () => {
    const a = seedDoc("r1", { checked_out_by: "eng9" }); state.cls.r1 = "drawing";
    T("distribution_acks").push({ id: "ak3", document_id: "r1", version_id: "r1-v2", acknowledged_at: null, superseded_at: null });
    await apply([asRecord(a)], "Archived");
    expect(docRow("r1")).toMatchObject({ status: "Archived", archive_reason: "Tidy" });
    expect(T("distribution_acks")[0].superseded_at).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    const b = seedDoc("r2"); state.cls.r2 = "drawing";
    await apply([asRecord(b)], "Draft");
    expect(docRow("r2").status).toBe("Draft");
    expect(T("audit_logs").filter((r) => ["SUPERSEDE_DOC", "VOID_DOC"].includes(String(r.action)))).toEqual([]);
  });
});

// P34 review fix 3 (REV-34 (b)): the bulk editor writes the archive columns on
// an archive (since P28); a row it moves OUT of Archived (its fresh prior) has
// them cleared in that row's same write, as unarchiveDocument does.
describe("P34 review fix 3 — the bulk editor clears the archive columns of a row it moves out of Archived", () => {
  const CLEARED = { archived_at: null, archived_by: null, archive_reason: null };
  const remount = async () => { await act(async () => root.unmount()); root = createRoot(host); };

  it("archived in the bulk editor, then set back to Issued in it: the restore's write (changeDocumentStatus) clears the archive columns, and the document can be shared again", async () => {
    seedDoc("x1");
    await apply([asRecord(docRow("x1"))], "Archived");
    expect(docRow("x1")).toMatchObject({ status: "Archived", archive_reason: "Tidy" });
    expect(shareStatusRefusal(docRow("x1"))).not.toBeNull();
    await remount();
    await apply([asRecord(docRow("x1"))], "Issued");
    expect(host.textContent).toMatch(/Applied to 1 document\./);
    expect(statusWrites()[1].args[0]).toMatchObject({ status: "Issued", ...CLEARED });
    expect(docRow("x1")).toMatchObject({ status: "Issued", ...CLEARED });
    expect(shareStatusRefusal(docRow("x1"))).toBeNull();
  });

  it("an Archived row set to Draft (the bare write) is cleared in its same write; an Issued row in the same apply is written exactly as before", async () => {
    const a = seedDoc("x2", { status: "Archived", archived_at: "2025-01-01", archived_by: "old", archive_reason: "first" });
    const b = seedDoc("x3");
    await apply([asRecord(a), asRecord(b)], "Draft");
    expect(host.textContent).toMatch(/Applied to 2 documents\./);
    const [wa, wb] = statusWrites().map((c) => c.args[0] as Row);
    expect(Object.keys(wa).sort()).toEqual(["archive_reason", "archived_at", "archived_by", "status", "uniqueness_key", "updated_at", "updated_by"]);
    expect(Object.keys(wb).sort()).toEqual(["status", "uniqueness_key", "updated_at", "updated_by"]);
    expect(docRow("x2")).toMatchObject({ status: "Draft", ...CLEARED });
    expect(docRow("x3")).toMatchObject({ status: "Draft" });
  });

  it("REGRESSION — a prior the read could not give: the row is written as before, its archive columns left as they are", async () => {
    const a = seedDoc("x4", { status: "Archived", archived_at: "2025-01-01", archived_by: "old", archive_reason: "first" });
    state.db.selectErrors!.documents = (cols) => (cols === "id, status" ? { message: "503" } : null);
    await apply([asRecord(a)], "Draft");
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual(["status", "uniqueness_key", "updated_at", "updated_by"]);
    expect(docRow("x4")).toMatchObject({ status: "Draft", archived_at: "2025-01-01", archived_by: "old", archive_reason: "first" });
  });
});
