// @vitest-environment jsdom
//
// document-control Round F wave 2 — P3 LIFECYCLE, review fix 4 (HLD-2): the
// Split and Merge wizards AS RENDERED over a source under an active
// stop-work hold. A controller must tick "Proceed over the active hold"
// before Confirm enables; the hold carry is locked on and the operation is
// called with `force: true`. Anyone else is refused before submit and is
// never told to release the hold (releasing it in order to split is how the
// hold would be laundered away). A source with no hold passes no force.
// The reverse dialog asks the same explicit decision when the reversal would
// park a held document, and passes `force`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  roles: ["Engineer"] as string[],
  activeRole: "Engineer" as string,
  holds: {} as Record<string, Array<{ id: string; reason: string }>>,
  holdsFail: false,
  searchRows: [] as Array<Record<string, unknown>>,
  splitDocument: vi.fn(async (..._a: unknown[]) => ({})),
  mergeDocuments: vi.fn(async (..._a: unknown[]) => ({})),
  reverseSplit: vi.fn(async (..._a: unknown[]) => ({ reversedDocIds: [], preservedAsSuperseded: 0, warnings: [] })),
  reverseMerge: vi.fn(async (..._a: unknown[]) => ({ reversedDocIds: [], preservedAsSuperseded: 0, warnings: [] })),
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: s.searchRows, error: null });
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: null, error: null });
        return () => new Proxy({}, h);
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: () => chain(), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("@/lib/documentLifecycle", () => ({
  splitDocument: (...a: unknown[]) => s.splitDocument(...a),
  mergeDocuments: (...a: unknown[]) => s.mergeDocuments(...a),
  reverseSplit: (...a: unknown[]) => s.reverseSplit(...a),
  reverseMerge: (...a: unknown[]) => s.reverseMerge(...a),
  reverseRenumber: vi.fn(),
  LEGACY_RESTORE_STATUSES: ["Issued", "Draft", "In Review", "Void"],
  reversalNeedsLegacyStatus: () => false,
}));
vi.mock("@/lib/holds", () => ({
  listActiveHoldsForDocument: vi.fn(async (id: string) => {
    if (s.holdsFail) throw new Error("holds unreadable");
    return (s.holds[id] ?? []).map((h) => ({ ...h, orgId: "o", documentId: id }));
  }),
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ roles: s.roles, activeRole: s.activeRole }),
}));
vi.mock("@/lib/inputValidation", () => ({
  checkForDuplicate: vi.fn(async () => ({ isDuplicate: false })),
  translatePostgresError: (e: unknown) => ({ heading: "Error", message: (e as Error).message }),
}));

import SplitWizard from "@/components/documents/lifecycle/SplitWizard";
import MergeWizard from "@/components/documents/lifecycle/MergeWizard";
import ReverseConfirmModal, { documentsReversalParks } from "@/components/documents/lifecycle/ReverseConfirmModal";
import type { TimelineEvent } from "@/lib/timeline";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.roles = ["Engineer"]; s.activeRole = "Engineer";
  s.holds = {}; s.holdsFail = false; s.searchRows = [];
  s.splitDocument.mockClear(); s.mergeDocuments.mockClear(); s.reverseSplit.mockClear(); s.reverseMerge.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const buttons = () => Array.from(host.querySelectorAll("button"));
const button = (text: string) => {
  const b = buttons().find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
};
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
function setFile(el: HTMLInputElement, name: string) {
  Object.defineProperty(el, "files", { value: [new File(["%PDF"], name, { type: "application/pdf" })], configurable: true });
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
const text = () => host.textContent ?? "";

const SOURCE: DocumentRecord = { id: "p101", documentNumber: "P-101", title: "Overhead P&ID", rev: "3", libraryId: "lib", assetTags: [] } as unknown as DocumentRecord;
const OTHER = { id: "p102", document_number: "P-102", title: "Overhead P&ID sheet 2", library_id: "lib", org_id: "o" };

async function splitToConfirm() {
  await act(async () => {
    root.render(React.createElement(SplitWizard, {
      doc: SOURCE, libraryId: "lib", orgId: "o", actorUserId: "me", actorRole: s.activeRole,
      onCancel: () => {}, onSuccess: () => {},
    }));
  });
  await tick();
  for (const f of Array.from(host.querySelectorAll<HTMLInputElement>('input[type="file"]'))) await act(async () => setFile(f, "sheet.pdf"));
  await click(button("Next"));
  await click(button("Next"));
  await act(async () => setValue(host.querySelector("textarea")!, "declutter"));
  await tick();
}

async function mergeToConfirm() {
  s.searchRows = [OTHER];
  await act(async () => {
    root.render(React.createElement(MergeWizard, {
      sourceDoc: SOURCE, libraryId: "lib", orgId: "o", actorUserId: "me", actorRole: s.activeRole,
      onCancel: () => {}, onSuccess: () => {},
    }));
  });
  await act(async () => setValue(host.querySelector<HTMLInputElement>('input[placeholder^="Search other documents"]')!, "P-1"));
  await tick(260);
  await click(button("P-102"));
  await click(button("Next"));
  await act(async () => setFile(host.querySelector<HTMLInputElement>('input[type="file"]')!, "merged.pdf"));
  await click(button("Next"));
  await act(async () => setValue(host.querySelector("textarea")!, "combine"));
  await tick();
}

const ackBox = () => Array.from(host.querySelectorAll("label")).find((l) => l.textContent?.includes("Proceed over the active hold"))?.querySelector("input") as HTMLInputElement | undefined;
const holdCarryBox = () => Array.from(host.querySelectorAll("label")).find((l) => l.textContent?.startsWith("Active holds"))?.querySelector("input") as HTMLInputElement;

describe("HLD-2 (review fix 4) — the Split wizard over a held source", () => {
  it("a controller must acknowledge; the hold carry is locked on and the split passes force: true", async () => {
    s.roles = ["Manager", "DocCtrl"]; s.activeRole = "Manager"; // additive DocCtrl, headline Manager
    s.holds.p101 = [{ id: "h1", reason: "Awaiting Engineering" }];
    await splitToConfirm();
    expect(text()).toMatch(/Proceed over the active hold on P-101 \(Awaiting Engineering\)\. It is carried to every new sheet\./);
    expect(text()).not.toMatch(/release it|Release it before publishing a new revision/i);
    expect(button("Confirm Split").disabled).toBe(true);
    expect(holdCarryBox().checked).toBe(true);
    expect(holdCarryBox().disabled).toBe(true);
    await click(ackBox()!);
    expect(button("Confirm Split").disabled).toBe(false);
    await click(button("Confirm Split"));
    expect(s.splitDocument).toHaveBeenCalledTimes(1);
    expect(s.splitDocument.mock.calls[0][0]).toMatchObject({ force: true, copyHolds: true, reason: "declutter" });
  });
  it("a non-controller is refused before submit — told only Doc Control can, and never to release the hold", async () => {
    s.holds.p101 = [{ id: "h1", reason: "Awaiting Engineering" }];
    await splitToConfirm();
    expect(text()).toMatch(/Only Doc Control or an Admin can split a held document/);
    expect(text()).toMatch(/Do not release the hold to get past this/);
    expect(text()).not.toMatch(/Release it before publishing a new revision/);
    expect(ackBox()).toBeUndefined();
    expect(button("Confirm Split").disabled).toBe(true);
    await click(button("Confirm Split"));
    expect(s.splitDocument).not.toHaveBeenCalled();
  });
  it("a source with no hold passes no force and leaves the carry toggle alone", async () => {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    await splitToConfirm();
    expect(ackBox()).toBeUndefined();
    expect(holdCarryBox().disabled).toBe(false);
    await click(button("Confirm Split"));
    expect(s.splitDocument.mock.calls[0][0]).toMatchObject({ force: undefined, copyHolds: true });
  });
  it("unreadable holds do not unlock a force: the split runs without it, so the operation's own gate decides", async () => {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    s.holdsFail = true;
    await splitToConfirm();
    expect(text()).toMatch(/Couldn't check for active holds \(holds unreadable\)/);
    await click(button("Confirm Split"));
    expect(s.splitDocument.mock.calls[0][0]).toMatchObject({ force: undefined });
  });
});

describe("HLD-2 (review fix 4) — the Merge wizard over a held source", () => {
  it("a controller acknowledges a hold on ANY absorbed source; the merge passes force: true with the carry locked on", async () => {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    s.holds.p102 = [{ id: "h2", reason: "Client Review" }];
    await mergeToConfirm();
    expect(text()).toMatch(/Proceed over the active hold on P-102 \(Client Review\)\. It is carried to the merge target\./);
    expect(button("Confirm Merge").disabled).toBe(true);
    expect(holdCarryBox().checked).toBe(true);
    expect(holdCarryBox().disabled).toBe(true);
    await click(ackBox()!);
    await click(button("Confirm Merge"));
    expect(s.mergeDocuments).toHaveBeenCalledTimes(1);
    expect(s.mergeDocuments.mock.calls[0][0]).toMatchObject({ force: true, copyHolds: true });
  });
  it("a non-controller is refused before submit, never told to release the hold", async () => {
    s.holds.p101 = [{ id: "h1", reason: "Awaiting Engineering" }];
    await mergeToConfirm();
    expect(text()).toMatch(/Only Doc Control or an Admin can merge a held document/);
    expect(text()).not.toMatch(/Release it before publishing a new revision/);
    expect(button("Confirm Merge").disabled).toBe(true);
  });
  it("no held source: no acknowledgement, no force", async () => {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    await mergeToConfirm();
    expect(ackBox()).toBeUndefined();
    await click(button("Confirm Merge"));
    expect(s.mergeDocuments.mock.calls[0][0]).toMatchObject({ force: undefined });
  });
});

describe("HLD-2 / REV-12 (review fix 4) — the reverse dialog over a held document it would park", () => {
  const splitEvent = { id: "audit:ev1", action: "DOC_SPLIT", summary: "Split P-101", timestamp: "2026-09-01T10:00:00Z", details: { replacementDocIds: ["p101a", "p101b"], priorStatus: "Issued" } } as unknown as TimelineEvent;
  async function openReverse(event: TimelineEvent) {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    await act(async () => {
      root.render(React.createElement(ReverseConfirmModal, { event, orgId: "o", actorUserId: "me", onCancel: () => {}, onSuccess: () => {} }));
    });
    await tick();
    await act(async () => setValue(host.querySelector("textarea")!, "wrong split"));
    await tick();
  }
  it("documentsReversalParks: a split's sheets; a merge's target unless it was an existing (kept) document", () => {
    expect(documentsReversalParks("DOC_SPLIT", { replacementDocIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(documentsReversalParks("DOC_MERGED", { mergedIntoDocumentId: "t", targetWasNewlyCreated: true })).toEqual(["t"]);
    expect(documentsReversalParks("DOC_MERGED", { mergedIntoDocumentId: "t" })).toEqual(["t"]); // legacy: the lib may infer it parks
    expect(documentsReversalParks("DOC_MERGED", { mergedIntoDocumentId: "t", targetWasNewlyCreated: false })).toEqual([]);
    expect(documentsReversalParks("DOC_RENUMBERED", {})).toEqual([]);
  });
  it("a held sheet: Confirm waits for the acknowledgement, then the reversal passes force: true", async () => {
    s.holds.p101a = [{ id: "h9", reason: "Awaiting Engineering" }];
    await openReverse(splitEvent);
    expect(text()).toMatch(/Proceed over the active hold \(Awaiting Engineering\) on the split's sheets this reversal parks\. It is carried back onto the restored source\./);
    expect(button("Confirm Reverse").disabled).toBe(true);
    await click(ackBox()!);
    expect(button("Confirm Reverse").disabled).toBe(false);
    await click(button("Confirm Reverse"));
    expect(s.reverseSplit.mock.calls[0][0]).toMatchObject({ splitAuditEventId: "ev1", force: true });
  });
  it("no held sheet: no acknowledgement, no force", async () => {
    await openReverse(splitEvent);
    expect(ackBox()).toBeUndefined();
    await click(button("Confirm Reverse"));
    expect(s.reverseSplit.mock.calls[0][0]).toMatchObject({ force: undefined });
  });
});
