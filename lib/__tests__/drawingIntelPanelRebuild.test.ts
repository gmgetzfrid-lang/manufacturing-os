// @vitest-environment jsdom
//
// intelligence Round G (I-07) review fix pass 2 — the Drawing intelligence
// panel's "Rebuild index" as RENDERED (ING-12). Its loop follows the route's
// cursor; a round that fails must not discard what the earlier rounds did:
// those documents ARE queued and re-indexing, so the toast says both, and
// the page is told to refresh whenever anything was queued.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ui = vi.hoisted(() => ({ showToast: vi.fn(), appConfirm: vi.fn(async () => true), getDrawingIntel: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: ui.showToast }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: ui.appConfirm }));
vi.mock("@/lib/knowledge", () => ({
  getDrawingIntel: ui.getDrawingIntel, downloadEquipmentRegister: vi.fn(), recordDrawingAudit: vi.fn(),
}));

import DrawingIntelPanel from "@/components/knowledge/DrawingIntelPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INTEL = {
  sheetCount: 8, readyCount: 8, suggestions: [],
  census: { totalDistinct: 1, totalOccurrences: 1, categories: [], unknownPrefixes: [] },
  audit: { resolved: 0, totalRefs: 0, seriesInScope: [], missingInSeries: [], outOfScope: [], oneWay: [] },
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  ui.showToast.mockReset();
  ui.getDrawingIntel.mockResolvedValue(INTEL);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function pressRebuild(onRebuilt: () => void) {
  await act(async () => {
    root.render(React.createElement(DrawingIntelPanel, { orgId: "o1", libraryId: "kl-1", isController: true, refreshKey: 0, onRebuilt }));
  });
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Rebuild index"));
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("the panel's rebuild keeps what earlier rounds did when a later round fails (review fix pass 2)", () => {
  it("round 1 queues six, round 2 fails: the toast says both, and the page refreshes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { ok: true, docs: 6, busy: [], errors: [], remaining: 2, cursor: "r-5" }))
      .mockResolvedValueOnce(json(500, { ok: false, docs: 0, busy: [], errors: ["D7.pdf: boom"], remaining: 2, cursor: "r-5", error: "The rebuild failed: D7.pdf: boom" }));
    vi.stubGlobal("fetch", fetchMock);
    const onRebuilt = vi.fn();
    await pressRebuild(onRebuilt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ action: "rebuild", cursor: "r-5" });
    const titles = ui.showToast.mock.calls.map((c) => c[0].title as string);
    expect(titles).toContainEqual(expect.stringMatching(/stopped part-way \(The rebuild failed: D7\.pdf: boom\) — 6 document\(s\) already queued are re-indexing/));
    expect(titles).toContainEqual(expect.stringMatching(/Part of the rebuild failed: D7\.pdf: boom/));
    expect(onRebuilt).toHaveBeenCalledTimes(1);
  });

  it("a network failure after a good round still reports the queued documents", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { ok: true, docs: 6, busy: [], errors: [], remaining: 2, cursor: "r-5" }))
      .mockRejectedValueOnce(new Error("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const onRebuilt = vi.fn();
    await pressRebuild(onRebuilt);
    expect(ui.showToast.mock.calls.map((c) => c[0].title)).toContainEqual(expect.stringMatching(/Failed to fetch\) — 6 document\(s\) already queued/));
    expect(onRebuilt).toHaveBeenCalledTimes(1);
  });

  it("a first round that fails with nothing queued is just the error — no refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(500, { ok: false, docs: 0, busy: [], errors: ["x"], remaining: 0, cursor: null, error: "The rebuild failed: x" })));
    const onRebuilt = vi.fn();
    await pressRebuild(onRebuilt);
    expect(ui.showToast.mock.calls.map((c) => c[0])).toContainEqual(expect.objectContaining({ type: "error", title: "The rebuild failed: x" }));
    expect(onRebuilt).not.toHaveBeenCalled();
  });
});
