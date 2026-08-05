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
import { PDFJS_VERBOSITY } from "@/lib/pdfjsConfig";

export type { TitleBlockGuess } from "@/lib/titleBlockHeuristics";
export { guessFromText } from "@/lib/titleBlockHeuristics";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const NOTHING: TitleBlockGuess = { confidence: 0 };

/** A malformed or pathological PDF can leave getDocument/getTextContent
 *  pending forever. This is a nice-to-have enrichment pass running in front of
 *  a person who is trying to upload — it gets ten seconds, then it's nothing. */
export const TITLE_BLOCK_TIMEOUT_MS = 10_000;

/** Read a PDF file's first page text and guess its title-block facts.
 *  Never throws, never hangs; empty guess on any failure, timeout, or non-PDF.
 *
 *  `signal` aborts a read whose answer nobody wants any more — the staging
 *  modal closed, or a second batch of files replaced the first. Without it a
 *  stale pass keeps parsing dozens of drawings in the background, competing
 *  with the upload the user is now waiting on. */
export async function readTitleBlock(file: File, signal?: AbortSignal): Promise<TitleBlockGuess> {
  if (signal?.aborted) return NOTHING;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) return NOTHING;
  // Cap the read: title blocks live on page 1; huge files parse slowly.
  if (file.size > 40 * 1024 * 1024) return NOTHING;

  // Shared between the read and its abandonment: the loading task has to be
  // destroyed even if we stopped waiting BEFORE it existed, or a timed-out
  // read leaves a pdf.js worker document parsing a 40MB drawing forever.
  const held: { task: { destroy(): Promise<void> } | null; abandoned: boolean } =
    { task: null, abandoned: false };
  const release = () => {
    held.abandoned = true;
    const t = held.task;
    held.task = null;
    if (t) void t.destroy().catch(() => undefined);
  };

  const read = (async (): Promise<TitleBlockGuess> => {
    const data = await file.arrayBuffer();
    if (held.abandoned) return NOTHING;
    const task = pdfjs.getDocument({ data: new Uint8Array(data), verbosity: PDFJS_VERBOSITY });
    held.task = task;
    // Racing: if we were abandoned while getDocument was being constructed,
    // tear it down now rather than leaving it running unreferenced.
    if (held.abandoned) { void task.destroy().catch(() => undefined); return NOTHING; }
    const doc = await task.promise;
    if (held.abandoned) return NOTHING;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? (it as { str: string }).str : ""))
      .join(" ");
    return guessFromText(text);
  })().catch(() => NOTHING);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<TitleBlockGuess>((resolve) => {
    timer = setTimeout(() => resolve(NOTHING), TITLE_BLOCK_TIMEOUT_MS);
    signal?.addEventListener("abort", () => resolve(NOTHING), { once: true });
  });

  try {
    return await Promise.race([read, giveUp]);
  } finally {
    clearTimeout(timer);
    release();
  }
}
