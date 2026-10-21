// @vitest-environment jsdom
//
// intelligence Round G I-26 — GOV-9 criterion 4, the remaining consumers, as
// RENDERED: a title block read off an AI transcription is shown "AI-read,
// unconfirmed", never as an identity —
//   * the Drawing intelligence panel's per-sheet readout (the route's
//     `declaredAiRead`, app/api/knowledge/drawing/route.ts) and the audit's
//     record result (`identityAiRead`);
//   * the equipment table that rides an answer: a sheet number its title
//     block gave ("SHT n") on a sheet an AI transcribed. A page label ("p.N")
//     is not a title-block reading and carries no such mark.
// REGRESSION: a text layer's number reads exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const ui = vi.hoisted(() => ({ showToast: vi.fn(), getDrawingIntel: vi.fn(), recordDrawingAudit: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: ui.showToast }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));
vi.mock("@/lib/knowledge", () => ({ getDrawingIntel: ui.getDrawingIntel, downloadEquipmentRegister: vi.fn(), recordDrawingAudit: ui.recordDrawingAudit }));

import DrawingIntelPanel from "@/components/knowledge/DrawingIntelPanel";
import EquipmentTablePanel, { sheetFromTitleBlock } from "@/components/knowledge/EquipmentTablePanel";
import type { EquipmentTable } from "@/lib/knowledge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sheet = (id: string, declared: string, over: Record<string, unknown> = {}) => ({
  id, name: `${id}.pdf`, status: "ready", pages: 1, pagesIndexed: 1, gapPages: [], chars: 100, tags: 2, visionPages: 0,
  verdict: "text", looksLike: null, shxLike: false, declared, waiting: null, acceptedUnread: null, notCounted: false, error: null, ...over,
});
const INTEL = {
  sheetCount: 2, readyCount: 2, suggestions: [],
  census: { totalDistinct: 2, totalOccurrences: 2, categories: [], unknownPrefixes: [] },
  audit: { resolved: 0, totalRefs: 1, seriesInScope: [], missingInSeries: [], outOfScope: [], oneWay: [] },
  sheets: [
    sheet("v-201", "025-PID-0201", { verdict: "vision", visionPages: 1, declaredAiRead: true }),
    sheet("t-202", "025-PID-0202"),
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  ui.showToast.mockReset();
  ui.getDrawingIntel.mockResolvedValue(INTEL);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  await act(async () => {
    root.render(React.createElement(DrawingIntelPanel, { orgId: "o1", libraryId: "kl-1", isController: true, refreshKey: 0, onRebuilt: () => undefined }));
  });
  await act(async () => { await Promise.resolve(); });
}
const click = async (text: string) => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent?.includes(text));
  expect(b, text).toBeTruthy();
  await act(async () => { b!.click(); });
  await act(async () => { await Promise.resolve(); });
};

describe("GOV-9 criterion 4 — the Drawing intelligence panel", () => {
  it("the per-sheet readout marks an AI-read number 'AI-read, unconfirmed'; a text layer's reads as before", async () => {
    await mount();
    await click("What each document produced");
    const marks = host.querySelectorAll("[data-declared-ai-read='true']");
    expect(marks).toHaveLength(1);
    const row = marks[0].closest("li")!;
    expect(row.textContent).toContain("≡ 025-PID-0201 (AI-read, unconfirmed)");
    expect(marks[0].parentElement!.getAttribute("title")).toMatch(/AI model's transcription of this sheet's title block — a reading, not the sheet's identity/);
    const text = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes("025-PID-0202"))!;
    expect(text.textContent).not.toContain("AI-read, unconfirmed");
    expect(text.querySelector("[title='Read from this sheet\\'s own title block — the number its audit is recorded under']")).not.toBeNull();
  });

  it("recording the audit says which numbers it filed under were read off an AI transcription; none, nothing is said", async () => {
    ui.recordDrawingAudit.mockResolvedValueOnce({ recorded: 2, counts: { passed: 2 }, sheets: [], identityAiRead: ["025-PID-0201"] });
    await mount();
    await click("Record audit");
    const line = host.querySelector("[data-identity-ai-read='true']");
    expect(line?.textContent).toMatch(/Filed under 1 number read only off an AI\s+transcription of the title block — AI-read, unconfirmed \(025-PID-0201\s*\): check each against the drawing/);
    ui.recordDrawingAudit.mockResolvedValueOnce({ recorded: 2, counts: { passed: 2 }, sheets: [] });
    await click("Record audit");
    expect(host.querySelector("[data-identity-ai-read='true']")).toBeNull();
  });
});

describe("GOV-9 criterion 4 — the equipment table's sheet name", () => {
  const table = (sheets: EquipmentTable["categories"][number]["items"][number]["sheets"]): EquipmentTable => ({
    total: 1, truncated: false, filteredTo: null,
    categories: [{ prefix: "P", label: "Pumps", count: 1, items: [{ tag: "P-1", note: null, sheets }] }],
  });
  it("a title-block sheet number on an AI-transcribed sheet is marked unconfirmed; a page label and a text layer's are not", () => {
    const html = renderToStaticMarkup(React.createElement(EquipmentTablePanel, {
      onOpenTag: () => undefined,
      table: table([
        { documentId: "d1", documentName: "A.pdf", page: 3, sheetLabel: "SHT 3", viaVision: true },
        { documentId: "d2", documentName: "B.pdf", page: 2, sheetLabel: "p.2", viaVision: true },
        { documentId: "d3", documentName: "C.pdf", page: 1, sheetLabel: "SHT 1" },
      ]),
    }));
    expect(html.match(/data-sheet-ai-read="true"/g)).toHaveLength(1);
    expect(html).toMatch(/SHT 3<\/span><span data-sheet-ai-read="true"[^>]*>\(AI-read, unconfirmed\)/);
    // PR-4's own mark is unchanged beside it
    expect(html.match(/data-via-vision="true"/g)).toHaveLength(2);
  });
  it("sheetFromTitleBlock: 'SHT n' is a title-block reading, 'p.N' and nothing are not", () => {
    expect(sheetFromTitleBlock("SHT 3")).toBe(true);
    expect(sheetFromTitleBlock("p.12")).toBe(false);
    expect(sheetFromTitleBlock(undefined)).toBe(false);
  });
});
