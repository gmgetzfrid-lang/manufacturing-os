// @vitest-environment jsdom
//
// document-control Round F wave 3 — P15 SURFACE REMAINDERS, third review fix:
// HLD-1 limb 2, DRIVEN. FullScreenViewer's markup export (downloadWithMarkup)
// stamps through the lib/downloads.ts hold stamp — the gate's read when the
// copy is taken, the ON HOLD watermark and the hold line leading the footer —
// as the plain download and print do. The earlier test re-implemented the
// composition; this renders the real FullScreenViewer (jsdom; react-pdf and
// fabric stubbed, pdf-lib real), clicks "Download w/ Markup", confirms the
// uncontrolled copy, and asserts what the REAL applyStampToPdfDoc call was
// given (spied) with the document's hold read answering held, held under a
// custom ("Other") reason, unreadable and clear.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PDFDocument } from "pdf-lib";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  holds: { data: [] as Row[], error: null as { message: string } | null },
  holdReads: 0,
  stamp: vi.fn(async (..._a: unknown[]) => undefined),
  audit: vi.fn(async (..._a: unknown[]) => ({ recorded: true })),
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const c: Row = {};
    const h: ProxyHandler<Row> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void) => {
            if (table === "document_holds") { s.holdReads++; res(s.holds); } else res({ data: [], error: null });
          };
        }
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/stamping", () => ({ applyStampToPdfDoc: (...a: unknown[]) => s.stamp(...a), downloadStampedPdf: vi.fn(), stampPdf: vi.fn() }));
vi.mock("@/lib/downloads", async (orig) => ({
  ...(await orig<typeof import("@/lib/downloads")>()),
  logDownloadAudit: (...a: unknown[]) => s.audit(...a),
  downloadDocumentPdf: vi.fn(),
  printDocumentPdf: vi.fn(),
}));
vi.mock("@/lib/markupExport", () => ({ bakeMarkupIntoDoc: vi.fn(async () => undefined), bakeMarkupIntoPdf: vi.fn(async () => undefined) }));
vi.mock("@/lib/draftHandoff", () => ({ stashDraft: vi.fn() }));
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn() }));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
vi.mock("@/components/assets/EquipmentTagsStrip", () => ({ default: () => null }));
vi.mock("@/components/documents/CompareRevisionsModal", () => ({ default: () => null }));
vi.mock("@/components/archive/BackupViewer", () => ({ default: () => null }));
vi.mock("@/components/ui/QrBadge", () => ({ default: () => null }));

import FullScreenViewer from "@/components/viewers/FullScreenViewer";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let PDF: Uint8Array;
let host: HTMLDivElement;
let root: Root;
const quiet: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(async () => {
  if (!PDF) { const d = await PDFDocument.create(); d.addPage([400, 300]); PDF = await d.save(); }
  s.holds = { data: [], error: null };
  s.holdReads = 0;
  s.stamp.mockClear();
  s.audit.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF.slice().buffer, { status: 200 })));
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:markup"), revokeObjectURL: vi.fn() });
  // jsdom does not navigate; the anchor click that saves the file is a no-op
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  quiet.push(vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  quiet.length = 0;
});

const DOC = {
  id: "doc-1", orgId: "org1", libraryId: "lib1", documentNumber: "P-101", title: "Overhead P&ID", rev: "C",
  status: "Issued", currentVersionId: "v3", checkedOutBy: null,
} as unknown as DocumentRecord;

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

async function exportMarkup(opts: { document?: DocumentRecord; currentUserId?: string } = { document: DOC, currentUserId: "u1" }) {
  await act(async () => {
    root.render(React.createElement(FullScreenViewer, {
      isOpen: true, onClose: () => {}, url: "https://files.example/p101.pdf", title: "Overhead P&ID", docNumber: "P-101", rev: "C",
      document: opts.document, currentUserId: opts.currentUserId, currentUserEmail: "dana@x.io",
    }));
  });
  await settle();
  const btn = host.querySelector('[data-test="download-with-markup-btn"]') as HTMLButtonElement;
  expect(btn.disabled).toBe(false);
  await click(btn);
  await settle();
  // a document record + user: the uncontrolled-copy confirmation first
  const confirm = button("Download stamped markup");
  if (confirm) await click(confirm);
  for (let i = 0; i < 5 && s.stamp.mock.calls.length === 0; i++) await settle();
}
const stamped = () => {
  expect(s.stamp).toHaveBeenCalledTimes(1);
  const [doc, opts] = s.stamp.mock.calls[0] as [unknown, { watermarkText: string; footerNotice: string }];
  expect(doc).toBeInstanceOf(PDFDocument);
  return opts;
};
const MARKUP = "P-101 Rev C WITH MARKUPS at time of export — markups are not part of the controlled revision.";

describe("HLD-1 limb 2 (driven) — the markup export carries the lib/downloads.ts hold stamp", () => {
  it("a HELD document's redlined export says ON HOLD — the watermark and the footer's lead line — read when the copy is taken", async () => {
    s.holds = { data: [{ id: "h1", reason: "Client Review", notes: null, opened_at: null, opened_by_name: null }], error: null };
    await exportMarkup();
    expect(s.holdReads).toBe(1);
    const o = stamped();
    expect(o.watermarkText).toBe("ON HOLD — DO NOT USE");
    expect(o.footerNotice).toBe(`ON HOLD at time of issue (Client Review) — work from this document is stopped until Document Control releases the hold. ${MARKUP}`);
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ state: "uncontrolled" }));
  });

  it("a custom (Other) hold: the paper that leaves the org says the category, never the private description (by decision, VFY-6)", async () => {
    s.holds = { data: [{ id: "h2", reason: "Other", notes: "waiting on vendor weld map", opened_at: null, opened_by_name: null }], error: null };
    await exportMarkup();
    const o = stamped();
    expect(o.watermarkText).toBe("ON HOLD — DO NOT USE");
    expect(o.footerNotice).toBe(`ON HOLD at time of issue (Other) — work from this document is stopped until Document Control releases the hold. ${MARKUP}`);
    expect(o.footerNotice).not.toContain("weld map");
  });

  it("an UNREADABLE hold state is a hold (fail closed)", async () => {
    s.holds = { data: [], error: { message: "permission denied" } };
    await exportMarkup();
    const o = stamped();
    expect(o.watermarkText).toBe("UNCONTROLLED — HOLD STATUS UNKNOWN");
    expect(o.footerNotice).toMatch(/^HOLD STATUS UNKNOWN at time of issue — treat this document as ON HOLD until Document Control confirms otherwise\. P-101 Rev C WITH MARKUPS/);
  });

  it("REGRESSION: a document that is not held is stamped exactly as before — the review watermark and the markup footer alone", async () => {
    await exportMarkup();
    expect(s.holdReads).toBe(1);
    const o = stamped();
    expect(o.watermarkText).toBe("UNCONTROLLED — FOR REVIEW ONLY");
    expect(o.footerNotice).toBe(MARKUP);
  });

  it("REGRESSION: the ad-hoc viewer (no document record) reads no hold and is stamped as before", async () => {
    await exportMarkup({ document: undefined, currentUserId: undefined });
    expect(s.holdReads).toBe(0);
    const o = stamped();
    expect(o.watermarkText).toBe("UNCONTROLLED — FOR REVIEW ONLY");
    expect(o.footerNotice).toBe(MARKUP);
  });
});
