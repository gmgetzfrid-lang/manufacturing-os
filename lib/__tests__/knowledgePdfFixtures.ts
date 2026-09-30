// Real PDFs for the ingestion tests (intelligence Round G, I-06): written
// with pdf-lib and read back by the production path (unpdf's text layer),
// so what the tests chunk is what a real upload would produce.

import { PDFDocument, StandardFonts } from "pdf-lib";

/** One page: lines drawn top-down, each line a list of cells at x
 *  positions (a single cell = an ordinary line). `null` = a blank page with
 *  no text layer at all (what an SHX drawing or a scan looks like). */
export type PageSpec = Array<string | Array<[number, string]>> | null;

export async function makePdf(pages: PageSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage([612, 792]);
    if (!spec) continue;
    let y = 740;
    for (const line of spec) {
      const cells: Array<[number, string]> = typeof line === "string" ? [[60, line]] : line;
      for (const [x, text] of cells) page.drawText(text, { x, y, size: 10, font });
      y -= 16;
      if (y < 40) break;
    }
  }
  return doc.save();
}

/** A drawing-like sheet whose text layer carries its tags (no vision). */
export const drawingSheet = (sheet: number, tags: string[]): PageSpec => [
  `DRAWING NO: 025-PID-0101  SHEET: ${sheet} OF 3  REV: 3`,
  ...tags.map((t) => `${t} PROCESS EQUIPMENT ITEM`),
  "SEE DWG 025-PID-0102 FOR CONTINUATION",
];

/** A prose page long enough to chunk and never taken for a drawing. */
export const prosePage = (topic: string): PageSpec => [
  `The ${topic} requirements apply to every flanged joint in this service.`,
  "Bolting shall be tightened in a star pattern in three passes.",
  "Gaskets shall be new and of the type listed in the line class.",
  "Records of the tightening shall be kept with the joint register.",
];
