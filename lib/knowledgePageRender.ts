// lib/knowledgePageRender.ts — SERVER-ONLY. Render specific PDF pages to
// PNG images for the "deep read" answer pass.
//
// The text layer loses what standards actually print: formulas typeset as
// figures, multi-column stress tables (B31.3 Table A-1), charts. Rendering
// the top-cited pages and attaching them to the answer call lets the model
// READ THE PAGE AS PRINTED — table lookups and formula transcription work
// from pixels, not from scrambled extraction order.
//
// Bounded hard: at most MAX_PAGES pages per ask at a fixed width — image
// input costs tokens on the asker's key, so the page count is a cap, not a
// suggestion.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import type { AiCallImage } from "@/lib/ai/providerCall";

export const MAX_DEEP_READ_PAGES = 4;
const RENDER_WIDTH = 1400;          // readable table text, modest tokens

/** Render the requested pages of a stored PDF to PNG images. Silently
 *  returns fewer (or zero) images on any render failure — deep read is an
 *  enhancement, never a reason an answer fails. */
export async function renderKnowledgePages(
  fileKey: string,
  pages: number[],
): Promise<Array<AiCallImage & { page: number }>> {
  const wanted = [...new Set(pages)].slice(0, MAX_DEEP_READ_PAGES);
  if (wanted.length === 0) return [];
  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: fileKey }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const out: Array<AiCallImage & { page: number }> = [];
    for (const page of wanted) {
      if (page < 1 || page > pdf.numPages) continue;
      try {
        const img = await renderPageAsImage(pdf, page, {
          width: RENDER_WIDTH,
          canvasImport: () => import("@napi-rs/canvas"),
        });
        out.push({
          page,
          mediaType: "image/png",
          base64: Buffer.from(img as ArrayBuffer).toString("base64"),
        });
      } catch { /* skip this page */ }
    }
    return out;
  } catch {
    return [];
  }
}
