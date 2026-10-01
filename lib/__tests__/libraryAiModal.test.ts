// @vitest-environment jsdom
//
// intelligence Round G — I-05 HUB-1 (CRITICAL): Library AI setup's
// "This is a drawing set — enable Drawing Intelligence" checkbox was held in
// local state and dropped by save(), so no library could ever show the
// Drawing Intelligence panel. The modal as RENDERED: tick the box, Save, and
// the payload handed to saveLibraryAiFeatures carries drawingIntel: true.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const kn = vi.hoisted(() => ({
  saveLibraryAiFeatures: vi.fn(async () => undefined),
  saveLibraryAiInstructions: vi.fn(async () => undefined),
  setLibraryLinks: vi.fn(async () => undefined),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@/lib/knowledge", () => ({
  listKnowledgeLibraries: vi.fn(async () => []),
  listLibraryLinks: vi.fn(async () => []),
  listKnowledgeDocuments: vi.fn(async () => []),
  setLibraryLinks: kn.setLibraryLinks,
  saveLibraryAiInstructions: kn.saveLibraryAiInstructions,
  saveLibraryAiFeatures: kn.saveLibraryAiFeatures,
}));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: toast.showToast }) }));

import LibraryAiModal from "@/components/knowledge/LibraryAiModal";
import type { KnowledgeLibrary } from "@/lib/knowledge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const libraryOf = (aiFeatures: KnowledgeLibrary["aiFeatures"]): KnowledgeLibrary => ({
  id: "lib-1", orgId: "o1", name: "P&IDs", aiFeatures,
} as unknown as KnowledgeLibrary);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  kn.saveLibraryAiFeatures.mockClear();
  toast.showToast.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open(library: KnowledgeLibrary) {
  await act(async () => {
    root.render(React.createElement(LibraryAiModal, {
      library, orgId: "o1", open: true, onClose: () => undefined, onSaved: () => undefined,
    }));
  });
  await act(async () => { await Promise.resolve(); });
}

const checkboxLabelled = (text: string): HTMLInputElement => {
  const label = [...host.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(text));
  const input = label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  expect(input, `checkbox "${text}"`).not.toBeNull();
  return input!;
};

async function clickSave() {
  const save = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Save setup"));
  await act(async () => { save?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}

describe("HUB-1 done-when 2 — a partial payload can never erase a stored key", () => {
  it("every stored key the modal does not render is carried forward; a cleared field is cleared", async () => {
    await open(libraryOf({ drawingIntel: true, decoder: "20 = Crude", futureToggle: true } as unknown as KnowledgeLibrary["aiFeatures"]));
    const ta = [...host.querySelectorAll("textarea")].find((t) => t.value === "20 = Crude") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(ta, "   "); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    await clickSave();
    const payload = (kn.saveLibraryAiFeatures.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(payload.futureToggle).toBe(true);
    expect(payload.drawingIntel).toBe(true);
    // cleared → undefined, which the JSON body drops: the replace removes it
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty("decoder");
  });
});

describe("HUB-1 — the Drawing Intelligence checkbox survives Save", () => {
  it("ticking the box and saving hands drawingIntel: true to saveLibraryAiFeatures", async () => {
    await open(libraryOf({}));
    const box = checkboxLabelled("This is a drawing set — enable Drawing Intelligence");
    expect(box.checked).toBe(false);
    await act(async () => { box.click(); });
    expect(box.checked).toBe(true);
    await clickSave();
    expect(kn.saveLibraryAiFeatures).toHaveBeenCalledTimes(1);
    const [libraryId, payload] = kn.saveLibraryAiFeatures.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(libraryId).toBe("lib-1");
    expect(payload.drawingIntel).toBe(true);
  });

  it("an enabled library that is saved untouched stays enabled; unticking turns it off", async () => {
    await open(libraryOf({ drawingIntel: true }));
    await clickSave();
    expect((kn.saveLibraryAiFeatures.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].drawingIntel).toBe(true);

    kn.saveLibraryAiFeatures.mockClear();
    await open(libraryOf({ drawingIntel: true }));
    const box = checkboxLabelled("This is a drawing set — enable Drawing Intelligence");
    await act(async () => { box.click(); });
    await clickSave();
    expect((kn.saveLibraryAiFeatures.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].drawingIntel).toBe(false);
  });
});
