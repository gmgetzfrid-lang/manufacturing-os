// Scanned pages into one PDF: each page on US letter (portrait, or
// landscape when the scan is wider than tall), the image fitted inside a
// quarter-inch margin and centered, the way a copier lays it out.

import { PDFDocument } from "pdf-lib";

const LETTER_W = 612; // 8.5 in, in points
const LETTER_H = 792; // 11 in
const MARGIN = 18; // 0.25 in

export async function pagesToPdf(pages: Array<{ jpeg: Uint8Array; w: number; h: number }>): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error("No pages to put in the PDF");
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const image = await doc.embedJpg(p.jpeg);
    const landscape = p.w > p.h;
    const W = landscape ? LETTER_H : LETTER_W;
    const H = landscape ? LETTER_W : LETTER_H;
    const page = doc.addPage([W, H]);
    const scale = Math.min((W - 2 * MARGIN) / p.w, (H - 2 * MARGIN) / p.h);
    const dw = p.w * scale;
    const dh = p.h * scale;
    page.drawImage(image, { x: (W - dw) / 2, y: (H - dh) / 2, width: dw, height: dh });
  }
  return doc.save();
}
