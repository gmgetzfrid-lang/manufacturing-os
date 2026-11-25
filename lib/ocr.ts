"use client";

// lib/ocr.ts - reading the words on a scanned page (a picture, no text in
// the PDF) with tesseract.js, served from /public/ocr (scripts/
// copy-ocr-files.mjs), never a CDN. The words come back like pdf.js's
// (lib/readSheet), in PDF points with the origin bottom-left, so
// lib/formLabels reads a scan the same way it reads a typed sheet.

import type { TextBit } from "@/lib/formLabels";

type OcrWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
type OcrBlock = { paragraphs: Array<{ lines: Array<{ words: OcrWord[] }> }> };

/** The words on an image of a page `pageW` x `pageH` points. `onProgress`
 *  gets 0..1 while it reads. */
export async function ocrWords(image: HTMLCanvasElement, pageW: number, pageH: number, onProgress?: (p: number) => void): Promise<TextBit[]> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: "/ocr/worker.min.js",
    corePath: "/ocr",
    langPath: "/ocr",
    gzip: true,
    // The data is served by the app: nothing to cache in the browser's database.
    cacheMethod: "none",
    logger: (m: { status: string; progress: number }) => { if (m.status === "recognizing text") onProgress?.(m.progress); },
  });
  try {
    const { data } = await worker.recognize(image, {}, { blocks: true });
    const sx = image.width / pageW;
    const sy = image.height / pageH;
    const out: TextBit[] = [];
    for (const b of (data.blocks ?? []) as unknown as OcrBlock[]) {
      for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
        const t = w.text.trim();
        if (!t || w.confidence < 45) continue;
        const h = (w.bbox.y1 - w.bbox.y0) / sy;
        out.push({ str: t, x: w.bbox.x0 / sx, y: pageH - w.bbox.y1 / sy, w: (w.bbox.x1 - w.bbox.x0) / sx, h });
      }
    }
    return out;
  } finally {
    await worker.terminate();
  }
}
