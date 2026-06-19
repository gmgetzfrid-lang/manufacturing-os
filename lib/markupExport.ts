// lib/markupExport.ts
//
// Bake per-page fabric markups into a PDF. Shared so the book viewer can flatten
// several sheets' annotations for a drafting request, using the same approach as
// the single viewer's "Download w/ Markup" (minus any uncontrolled stamping —
// that stays a concern of the download path).
//
// Browser-only (fabric needs a <canvas>); import from client components.

import * as fabric from "fabric";
import { PDFDocument } from "pdf-lib";

type CanvasJson = { objects?: unknown[]; [k: string]: unknown };

/**
 * Flatten `pageStates` (normalized fabric JSON at scale 1.0, keyed by 1-based
 * page number) onto a copy of `pdfBytes` and return the new PDF bytes. Pages
 * with no objects are left untouched.
 */
export async function bakeMarkupIntoPdf(
  pdfBytes: Uint8Array,
  pageStates: Record<number, object>,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  for (const [k, st] of Object.entries(pageStates)) {
    const pn = parseInt(k, 10);
    if (!Number.isFinite(pn) || pn < 1 || pn > pages.length) continue;
    const state = st as CanvasJson;
    if (!Array.isArray(state.objects) || state.objects.length === 0) continue;

    const page = pages[pn - 1];
    const { width, height } = page.getSize();
    const el = window.document.createElement("canvas");
    const sc = new fabric.StaticCanvas(el, { width: 1000, height: 1000 });
    try {
      await sc.loadFromJSON(state);
      sc.setDimensions({ width, height });
      sc.renderAll();
      const png = sc.toDataURL({ format: "png", multiplier: 2 });
      const pngBytes = await fetch(png).then((r) => r.arrayBuffer());
      const img = await pdfDoc.embedPng(pngBytes);
      page.drawImage(img, { x: 0, y: 0, width, height });
    } finally {
      sc.dispose();
    }
  }

  return pdfDoc.save();
}
