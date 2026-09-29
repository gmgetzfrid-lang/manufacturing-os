// lib/pdfPageCount.ts — SERVER-ONLY. How many pages does a stored PDF have?
//
// The page renderer (lib/knowledgePageRender) returns only the pages it
// rendered, capped, so a caller cannot tell an 8-page quote from a 30-page
// one read to page 8 (COST-13). This reads the document's true page count
// so the row can record "read pages 1–8 of 30" and the reviewer is told.
// Unknown (unreadable file, render failure) is returned as null and is
// recorded as null — never as "all pages".

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";

export async function countPdfPages(fileKey: string): Promise<number | null> {
  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: fileKey }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const n = Number(pdf.numPages);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
