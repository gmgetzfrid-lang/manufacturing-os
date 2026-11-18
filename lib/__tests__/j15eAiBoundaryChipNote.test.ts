// @vitest-environment jsdom
//
// projects-joint J15e (projects-tab SAF-22, review L4) — the AI boundary chip
// shows the exclusion route's `warning` as a non-blocking note: the document
// is held back and its indexed copy removed (the chip flips), but the entity
// mentions recorded against it could not be cleared. A change with no warning
// shows no note, as before; a failed change still shows `failed`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ answer: null as null | Record<string, unknown>, fail: null as null | Error }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const q: Record<string, unknown> = {};
    const self = new Proxy(q, {
      get(_t, prop: string) {
        if (prop === "maybeSingle") return async () => ({ data: table === "documents" ? { ai_excluded: false, collection_id: null } : null, error: null });
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: table === "knowledge_sources" ? [{ source_type: "library", source_id: "l1" }] : [], error: null });
        return () => self;
      },
    });
    return self;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/knowledge", () => ({
  setDocumentAiExclusion: vi.fn(async () => { if (h.fail) throw h.fail; return h.answer; }),
}));

import AiBoundaryChip from "@/components/documents/AiBoundaryChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); h.answer = null; h.fail = null; });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function toggle(): Promise<void> {
  await act(async () => { root.render(React.createElement(AiBoundaryChip, { documentId: "d1", libraryId: "l1", orgId: "o1", canManage: true })); });
  const button = host.querySelector("button") as HTMLButtonElement;
  expect(button.textContent).toContain("AI-readable");
  await act(async () => { button.click(); });
}

describe("AiBoundaryChip — the exclusion's warning is a non-blocking note (SAF-22 L4)", () => {
  it("a warning: the chip flips to held back and shows the note with the sentence", async () => {
    const warning = "The document is held back and its indexed copy removed, but the entity mentions recorded against it could not be cleared: You don't have permission to do this.";
    h.answer = { excluded: true, purged: 1, warning };
    await toggle();
    expect(host.querySelector("button")!.textContent).toContain("Held from AI");
    const note = host.querySelector('[data-testid="ai-boundary-note"]') as HTMLElement;
    expect(note).toBeTruthy();
    expect(note.getAttribute("title")).toBe(warning);
  });
  it("regression: no warning, no note", async () => {
    h.answer = { excluded: true, purged: 1 };
    await toggle();
    expect(host.querySelector("button")!.textContent).toContain("Held from AI");
    expect(host.querySelector('[data-testid="ai-boundary-note"]')).toBeNull();
  });
  it("regression: a failed change shows `failed` and does not flip", async () => {
    h.fail = new Error("The document was removed meanwhile, so what the AI may read was not changed. Reload and try again.");
    await toggle();
    expect(host.querySelector("button")!.textContent).toContain("AI-readable");
    expect(host.textContent).toContain("failed");
  });
});
