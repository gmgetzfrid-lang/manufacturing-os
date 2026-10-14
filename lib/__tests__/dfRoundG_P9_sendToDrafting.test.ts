// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — HAND-8: FullScreenViewer's
// "Send to Drafting", AS RENDERED (react-pdf and fabric stubbed; the harness
// of dcRoundFP15MarkupExportRendered.test.ts).
//
// A requester who marked up a sheet and sends it to drafting used to get the
// clean original attached in silence when the markups could not be baked in
// (the bytes could not be fetched, or pdf-lib threw). Now the failure is SAID
// and they choose: send the clean sheet (the request says the markups are not
// attached) or cancel and stay.
//
// REGRESSION first: no markup → the original-attachment hand-off, unchanged;
// a bake that works → the marked-up sheet is the draft, unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  push: vi.fn(),
  confirm: vi.fn(),
  bake: vi.fn(),
  stash: vi.fn(),
  fetchOk: true,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: () => chain(), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn(), downloadStampedPdf: vi.fn(), stampPdf: vi.fn() }));
vi.mock("@/lib/downloads", async (orig) => ({
  ...(await orig<typeof import("@/lib/downloads")>()),
  logDownloadAudit: vi.fn(async () => ({ recorded: true })),
  downloadDocumentPdf: vi.fn(),
  printDocumentPdf: vi.fn(),
}));
vi.mock("@/lib/markupExport", () => ({ bakeMarkupIntoDoc: vi.fn(async () => undefined), bakeMarkupIntoPdf: (...a: unknown[]) => s.bake(...a) }));
vi.mock("@/lib/draftHandoff", () => ({ stashDraft: (...a: unknown[]) => s.stash(...a) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => undefined) }));
vi.mock("@/lib/revisions", () => ({ listVersions: vi.fn(async () => []) }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "" }));
vi.mock("@/lib/pdfjsConfig", () => ({ PDF_DOC_OPTIONS: {} }));
vi.mock("react-pdf", () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }));
vi.mock("react-pdf/dist/Page/AnnotationLayer.css", () => ({}));
vi.mock("react-pdf/dist/Page/TextLayer.css", () => ({}));
vi.mock("fabric", () => {
  class Canvas {
    isDrawingMode = false; selection = true; defaultCursor = "default"; hoverCursor = "move";
    on() {} off() {} dispose() {} requestRenderAll() {} add() {} remove() {} clear() {} calcOffset() {} setDimensions() {}
    discardActiveObject() {} setActiveObject() {}
    getActiveObject() { return null; }
    getActiveObjects() { return []; }
    toJSON() { return { objects: [] }; }
    async loadFromJSON() {}
  }
  class PencilBrush { color = ""; width = 1; }
  return { Canvas, PencilBrush };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: s.push }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(), appConfirm: (...a: unknown[]) => s.confirm(...a) }));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
vi.mock("@/components/assets/EquipmentTagsStrip", () => ({ default: () => null }));
vi.mock("@/components/documents/CompareRevisionsModal", () => ({ default: () => null }));
vi.mock("@/components/archive/BackupViewer", () => ({ default: () => null }));
vi.mock("@/components/ui/QrBadge", () => ({ default: () => null }));

import FullScreenViewer from "@/components/viewers/FullScreenViewer";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.push.mockReset(); s.confirm.mockReset(); s.bake.mockReset(); s.stash.mockReset();
  s.fetchOk = true;
  s.bake.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  s.stash.mockResolvedValue("draft-key-1");
  vi.stubGlobal("fetch", vi.fn(async () => (s.fetchOk ? new Response(new Uint8Array([37, 80, 68, 70]).buffer, { status: 200 }) : new Response("no", { status: 500 }))));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DOC = {
  id: "doc-1", orgId: "org1", libraryId: "lib1", documentNumber: "P-101", title: "Overhead P&ID", rev: "C",
  status: "Issued", currentVersionId: "v3", checkedOutBy: null,
} as unknown as DocumentRecord;
// A markup on page 2 (the live canvas is page 1, so the seeded state survives the capture).
const MARKED = { 2: { objects: [{ type: "path" }] } };

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function send(initialPageStates?: Record<number, object>) {
  await act(async () => {
    root.render(React.createElement(FullScreenViewer, {
      isOpen: true, onClose: () => {}, url: "https://files.example/p101.pdf", title: "Overhead P&ID", docNumber: "P-101", rev: "C",
      document: DOC, currentUserId: "u1", currentUserEmail: "rita@x.io", initialPageStates,
    }));
  });
  await settle();
  const btn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Send to Drafting")) as HTMLButtonElement;
  expect(btn.disabled).toBe(false);
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  return btn;
}
const pushedParams = () => {
  expect(s.push).toHaveBeenCalledTimes(1);
  const href = String(s.push.mock.calls[0][0]);
  expect(href.startsWith("/requests/new?")).toBe(true);
  return new URLSearchParams(href.slice("/requests/new?".length));
};

describe("HAND-8 — a markup that cannot be attached is said, never dropped in silence", () => {
  it("REGRESSION: no markup → the clean original is attached, no question asked", async () => {
    await send();
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.bake).not.toHaveBeenCalled();
    const p = pushedParams();
    expect(p.get("sourceFileUrl")).toBe("https://files.example/p101.pdf");
    expect(p.get("draft")).toBeNull();
    expect(p.get("description")).not.toMatch(/could NOT be attached/);
  });
  it("REGRESSION: a bake that works → the marked-up sheet is the draft, no question asked", async () => {
    await send(MARKED);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.bake).toHaveBeenCalledTimes(1);
    const p = pushedParams();
    expect(p.get("draft")).toBe("draft-key-1");
    expect(p.get("sourceFileUrl")).toBeNull();
    expect(p.get("description")).toMatch(/marked-up sheet attached/);
  });
  it("the sheet's bytes could not be fetched → asked; Cancel stays on the sheet and sends nothing", async () => {
    s.fetchOk = false;
    s.confirm.mockResolvedValue(false);
    const btn = await send(MARKED);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    const ask = s.confirm.mock.calls[0][0] as { title: string; message: string; confirmLabel: string };
    expect(ask.title).toBe("Your markups could not be attached");
    expect(ask.message).toMatch(/could not be fetched/);
    expect(ask.message).toMatch(/saved on this document/);
    expect(ask.confirmLabel).toBe("Send the clean sheet");
    expect(s.push).not.toHaveBeenCalled();
    expect(btn.disabled).toBe(false); // not stuck "sending"
  });
  it("the bake throws → asked; Send the clean sheet attaches the original and the request SAYS the markups are not attached", async () => {
    s.bake.mockRejectedValue(new Error("pdf-lib: invalid object ref"));
    s.confirm.mockResolvedValue(true);
    await send(MARKED);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect((s.confirm.mock.calls[0][0] as { message: string }).message).toMatch(/could not be baked/);
    const p = pushedParams();
    expect(p.get("draft")).toBeNull();
    expect(p.get("sourceFileUrl")).toBe("https://files.example/p101.pdf");
    expect(p.get("description")).toMatch(/markups could NOT be attached — the clean sheet is attached/);
  });
});
