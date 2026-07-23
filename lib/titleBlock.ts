// lib/titleBlock.ts
//
// TITLE-BLOCK READER — the bulk-ingest unlock.
//
// Every plant has decades of flat-folder PDFs; the tool that swallows that
// folder in an afternoon wins by default. Filenames get most of the way
// (lib/filenameParser); this adds a second pass that READS THE DRAWING —
// first-page text via pdf.js — to find the drawing number and revision the
// title block actually declares. Heuristic, local, no AI dependency.
//
// Conservative by design: results carry a confidence and the staging modal
// only applies them where the user hasn't typed anything better. Failure of
// any kind returns an empty result — enrichment must never break staging.
//
// The pure text heuristics live in lib/titleBlockHeuristics.ts (unit-tested
// without the pdf.js browser runtime).

import { pdfjs } from "react-pdf";
import { guessFromText, type TitleBlockGuess } from "@/lib/titleBlockHeuristics";

export type { TitleBlockGuess } from "@/lib/titleBlockHeuristics";
export { guessFromText } from "@/lib/titleBlockHeuristics";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

/** Read a PDF file's first page text and guess its title-block facts.
 *  Never throws; empty guess on any failure or non-PDF. */
export async function readTitleBlock(file: File): Promise<TitleBlockGuess> {
  try {
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) return { confidence: 0 };
    // Cap the read: title blocks live on page 1; huge files parse slowly.
    if (file.size > 40 * 1024 * 1024) return { confidence: 0 };
    const data = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    try {
      const page = await doc.getPage(1);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => ("str" in it ? (it as { str: string }).str : ""))
        .join(" ");
      return guessFromText(text);
    } finally {
      void doc.destroy();
    }
  } catch {
    return { confidence: 0 };
  }
}
