// @vitest-environment jsdom
//
// document-control Round F wave 2 — P13 STATUS-TRANSITION: REV-15's remainder,
// the wizard half. A split / merge that completed with follow-up steps
// outstanding (complianceClockWarnings — a sheet's review clock or roster did
// not fully start) shows them before the wizard closes, instead of closing as
// if everything landed; onSuccess runs only when the user dismisses it. With
// nothing outstanding the wizard closes as before. (Harness: the HLD-2 wizard
// tests' mocks, dcRoundFHeldWizards.test.ts.)

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

async function splitToConfirm(onSuccess: () => void = () => {}) {
  await act(async () => {
    root.render(React.createElement(SplitWizard, {
      doc: SOURCE, libraryId: "lib", orgId: "o", actorUserId: "me", actorRole: s.activeRole,
      onCancel: () => {}, onSuccess,
    }));
  });
  await tick();
  for (const f of Array.from(host.querySelectorAll<HTMLInputElement>('input[type="file"]'))) await act(async () => setFile(f, "sheet.pdf"));
  await click(button("Next"));
  await click(button("Next"));
  await act(async () => setValue(host.querySelector("textarea")!, "declutter"));
  await tick();
}

async function mergeToConfirm(onSuccess: () => void = () => {}) {
  s.searchRows = [OTHER];
  await act(async () => {
    root.render(React.createElement(MergeWizard, {
      sourceDoc: SOURCE, libraryId: "lib", orgId: "o", actorUserId: "me", actorRole: s.activeRole,
      onCancel: () => {}, onSuccess,
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


const WARN = "The review clock / acknowledgment roster of document d-2 did not start (review policy unreadable); Document Control can set it from the document.";

describe("REV-15 remainder — the Split wizard shows complianceClockWarnings", () => {
  it("outstanding follow-ups are listed and onSuccess waits for Done", async () => {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    s.splitDocument.mockResolvedValueOnce({ newDocumentIds: ["d-1", "d-2"], complianceClockWarnings: [WARN] });
    const onSuccess = vi.fn();
    await splitToConfirm(onSuccess);
    await click(button("Confirm Split"));
    await tick();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(text()).toMatch(/The split is done — 1 follow-up step did not complete/);
    expect(text()).toMatch(/The split stands and is not rolled back — do not run it again/);
    const items = Array.from(host.querySelectorAll('[data-testid="lifecycle-follow-ups"] li')).map((li) => li.textContent);
    expect(items).toEqual([WARN]);
    await click(button("Done"));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
  it("nothing outstanding: the wizard closes at once, as before", async () => {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    s.splitDocument.mockResolvedValueOnce({ newDocumentIds: ["d-1"], complianceClockWarnings: [] });
    const onSuccess = vi.fn();
    await splitToConfirm(onSuccess);
    await click(button("Confirm Split"));
    await tick();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="lifecycle-follow-ups"]')).toBeNull();
  });
});

describe("REV-15 remainder — the Merge wizard shows complianceClockWarnings", () => {
  it("outstanding follow-ups are listed and onSuccess waits for Done", async () => {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    s.mergeDocuments.mockResolvedValueOnce({ targetDocumentId: "t-1", complianceClockWarnings: [WARN, WARN.replace("d-2", "t-1")] });
    const onSuccess = vi.fn();
    await mergeToConfirm(onSuccess);
    await click(button("Confirm Merge"));
    await tick();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(text()).toMatch(/The merge is done — 2 follow-up steps did not complete/);
    expect(host.querySelectorAll('[data-testid="lifecycle-follow-ups"] li')).toHaveLength(2);
    await click(button("Done"));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
  it("nothing outstanding (or a result without the field): the wizard closes at once", async () => {
    s.roles = ["DocCtrl"]; s.activeRole = "DocCtrl";
    const onSuccess = vi.fn();
    await mergeToConfirm(onSuccess);
    await click(button("Confirm Merge"));
    await tick();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
