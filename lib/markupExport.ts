// lib/markupExport.ts
//
// Bake per-page fabric markups into a PDF. Shared so the book viewer can flatten
// several sheets' annotations for a drafting request with the same code as the
// single viewer's "Download w/ Markup" (minus any uncontrolled stamping —
// that stays a concern of the download path).
//
// Browser-only (fabric needs a <canvas>); import from client components.

import * as fabric from "fabric";
import { PDFDocument, degrees } from "pdf-lib";
import { normalizeRotation, displaySize, displayToUser } from "@/lib/stampLayout";

type CanvasJson = { objects?: unknown[]; [k: string]: unknown };

/**
 * Flatten `pageStates` onto an already-loaded document, in place. The
 * single viewer's "Download w/ Markup" bakes and then stamps the same
 * PDFDocument; `bakeMarkupIntoPdf` wraps this for callers holding bytes.
 *
 * Markups are drawn over the page AS DISPLAYED — the viewers render a page's
 * own /Rotate — so the raster is sized to the displayed page and laid back
 * with the page's rotation: on a quarter-turned sheet the redlines land where
 * they were drawn, not 90° off on the unrotated MediaBox (PKG-13 / PHYS-12).
 * Pages with no objects are left untouched.
 */
export async function bakeMarkupIntoDoc(
  pdfDoc: PDFDocument,
  pageStates: Record<number, object>,
): Promise<void> {
  const pages = pdfDoc.getPages();

  for (const [k, st] of Object.entries(pageStates)) {
    const pn = parseInt(k, 10);
    if (!Number.isFinite(pn) || pn < 1 || pn > pages.length) continue;
    const state = st as CanvasJson;
    if (!Array.isArray(state.objects) || state.objects.length === 0) continue;

    const page = pages[pn - 1];
    const media = page.getSize();
    const rotation = normalizeRotation(page.getRotation().angle);
    const { width, height } = displaySize(media.width, media.height, rotation);
    const el = window.document.createElement("canvas");
    const sc = new fabric.StaticCanvas(el, { width: 1000, height: 1000 });
    try {
      await sc.loadFromJSON(state);
      sc.setDimensions({ width, height });
      sc.renderAll();
      const png = sc.toDataURL({ format: "png", multiplier: 2 });
      const pngBytes = await fetch(png).then((r) => r.arrayBuffer());
      const img = await pdfDoc.embedPng(pngBytes);
      const origin = displayToUser(0, 0, media.width, media.height, rotation);
      page.drawImage(img, { ...origin, width, height, rotate: degrees(rotation) });
    } finally {
      sc.dispose();
    }
  }
}

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
  await bakeMarkupIntoDoc(pdfDoc, pageStates);
  return pdfDoc.save();
}
