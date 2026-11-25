"use client";

// lib/readSheet.ts - a kit sheet opened in the browser with pdf.js: its
// pages drawn on a canvas, and the words printed on them with where they
// sit (PDF points, origin bottom-left), for lib/formLabels to read. A
// scanned sheet has no words: `words` is 0 and the screen says so.

import type { PageText, TextBit } from "@/lib/formLabels";

export interface SheetDoc {
  pages: number;
  text: PageText[];
  /** Words found on all pages (0: a scan or a picture). */
  words: number;
  /** Draws page i to fit maxW x maxH; returns its size in points and the scale used. */
  draw: (i: number, canvas: HTMLCanvasElement, maxW: number, maxH: number) => Promise<{ w: number; h: number; scale: number }>;
  /** Page i as a picture at `dpi`, for reading a scan's words. */
  image: (i: number, dpi?: number) => Promise<HTMLCanvasElement>;
}

type PdfPage = {
  view: number[];
  getViewport: (o: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }>;
  render: (o: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
};

export async function openSheet(bytes: Uint8Array, maxPages = 8): Promise<SheetDoc> {
  const { pdfjs } = await import("react-pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const { PDFJS_VERBOSITY } = await import("@/lib/pdfjsConfig");
  // pdf.js keeps the buffer: hand it a copy so the caller's stays usable.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: PDFJS_VERBOSITY }).promise;
  const pages: PdfPage[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) pages.push((await doc.getPage(i)) as unknown as PdfPage);
  const text: PageText[] = [];
  let words = 0;
  for (const pg of pages) {
    const [x0, y0, x1, y1] = pg.view;
    const bits: TextBit[] = [];
    try {
      const tc = await pg.getTextContent();
      for (const it of tc.items) {
        const str = String(it.str ?? "");
        const t = it.transform;
        if (!str.trim() || !t || t.length < 6) continue;
        const h = Math.abs(it.height || Math.hypot(t[2], t[3])) || 10;
        bits.push({ str, x: t[4] - x0, y: t[5] - y0, w: Math.abs(it.width ?? str.length * h * 0.5), h });
      }
    } catch { /* a page whose words can't be read: none */ }
    words += bits.length;
    text.push({ width: x1 - x0, height: y1 - y0, bits });
  }
  return {
    pages: pages.length,
    text,
    words,
    draw: async (i, canvas, maxW, maxH) => {
      const pg = pages[Math.max(0, Math.min(pages.length - 1, i))];
      const base = pg.getViewport({ scale: 1 });
      const scale = Math.max(0.2, Math.min(maxW / base.width, maxH / base.height, 2));
      const vp = pg.getViewport({ scale });
      // Sharp on a high-density screen.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.ceil(vp.width * dpr);
      canvas.height = Math.ceil(vp.height * dpr);
      canvas.style.width = `${Math.ceil(vp.width)}px`;
      const hi = pg.getViewport({ scale: scale * dpr });
      await pg.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: hi }).promise;
      return { w: base.width, h: base.height, scale };
    },
    image: async (i, dpi = 200) => {
      const pg = pages[Math.max(0, Math.min(pages.length - 1, i))];
      // Big enough to read, small enough for a phone's memory.
      const base = pg.getViewport({ scale: 1 });
      const scale = Math.min(dpi / 72, 3400 / Math.max(base.width, base.height));
      const vp = pg.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
      return c;
    },
  };
}
