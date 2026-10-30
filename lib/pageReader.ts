// lib/pageReader.ts — SERVER-ONLY. The app's one way to read PDF pages.
//
// Every feature that reads a document (quality manuals, checklists, quotes
// and invoices, process flow diagrams) used to render its pages and pay the
// model to look at them, even when the knowledge index had already read
// those exact pages. This is the one door, cheapest first, per page:
//
//   1. a STORED reading — the knowledge index's text for the same file,
//      matched by file key or by the bytes' hash (a vision transcript paid
//      for once is used everywhere);
//   2. the PDF's own TEXT LAYER — free;
//   3. a rendered IMAGE for the model — only when 1 and 2 come up empty,
//      or always when the task needs layout (flow arrows, table columns).
//
// Whatever text is found rides along as context, so even an image read is
// cheaper and better grounded.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import type { AiCallImage } from "@/lib/ai/providerCall";

const RENDER_WIDTH = 1400;
/** A page with at least this much stored or text-layer text is read as text. */
export const READABLE_PAGE_CHARS = 400;
const PAGE_CONTEXT_CAP = 6_000;
const TOTAL_CONTEXT_CAP = 40_000;

export interface PageRead {
  page: number;
  text: string | null;
  /** Where the text came from: the knowledge index, the PDF itself, or nowhere. */
  textFrom: "stored" | "text-layer" | null;
  image: (AiCallImage & { page: number }) | null;
}

export interface PagesRead {
  pages: PageRead[];
  /** Images to attach to the model call, in page order. */
  images: Array<AiCallImage & { page: number }>;
  stored: number;
  textLayer: number;
  rendered: number;
}

/** Stored readings for these pages of this file, from any knowledge copy of
 *  the same file key or the same bytes. */
async function storedReadings(orgId: string, fileKey: string, pages: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const ids = new Set<string>();
    const { data: byKey } = await supabaseAdmin.from("knowledge_documents").select("id, file_hash").eq("org_id", orgId).eq("file_key", fileKey).eq("status", "ready").limit(5);
    const hashes = new Set<string>();
    for (const k of (byKey as Array<{ id: string; file_hash: string | null }> | null) ?? []) { ids.add(k.id); if (k.file_hash) hashes.add(k.file_hash); }
    const { data: ver } = await supabaseAdmin.from("document_versions").select("file_hash").eq("org_id", orgId).eq("file_url", fileKey).not("file_hash", "is", null).limit(1);
    for (const v of (ver as Array<{ file_hash: string }> | null) ?? []) hashes.add(v.file_hash);
    if (hashes.size) {
      const { data: twins } = await supabaseAdmin.from("knowledge_documents").select("id").eq("org_id", orgId).in("file_hash", [...hashes]).eq("status", "ready").limit(5);
      for (const t of (twins as Array<{ id: string }> | null) ?? []) ids.add(t.id);
    }
    if (!ids.size) return out;
    const { data: chunks } = await supabaseAdmin.from("knowledge_chunks").select("document_id, page, seq, content").in("document_id", [...ids]).in("page", pages).order("seq", { ascending: true }).limit(4000);
    const byDocPage = new Map<string, string[]>();
    for (const c of (chunks as Array<{ document_id: string; page: number; content: string }> | null) ?? []) {
      const k = `${c.document_id}:${c.page}`;
      byDocPage.set(k, [...(byDocPage.get(k) ?? []), c.content]);
    }
    for (const p of pages) {
      // The fullest reading wins: a vision transcript beats a thin text pass.
      let best = "";
      for (const id of ids) { const t = (byDocPage.get(`${id}:${p}`) ?? []).join("\n"); if (t.length > best.length) best = t; }
      if (best) out.set(p, best);
    }
  } catch { /* no index: fall through to the PDF itself */ }
  return out;
}

/** Read pages of a stored PDF, cheapest first. `images: "always"` attaches
 *  every page as an image (layout tasks); `"unread"` only the pages no text
 *  could be found for. Never throws: a page that cannot be read comes back
 *  empty. */
export async function readPages(input: {
  orgId: string;
  fileKey: string;
  pages: number[];
  maxPages: number;
  images: "always" | "unread";
}): Promise<PagesRead> {
  const wanted = [...new Set(input.pages.filter((p) => Number.isInteger(p) && p >= 1))].slice(0, input.maxPages);
  const res: PagesRead = { pages: [], images: [], stored: 0, textLayer: 0, rendered: 0 };
  if (!wanted.length) return res;
  const stored = await storedReadings(input.orgId, input.fileKey, wanted);

  let pdf: Awaited<ReturnType<typeof import("unpdf")["getDocumentProxy"]>> | null = null;
  let render: typeof import("unpdf")["renderPageAsImage"] | null = null;
  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: input.fileKey }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const m = await import("unpdf");
    pdf = await m.getDocumentProxy(bytes);
    render = m.renderPageAsImage;
  } catch { /* unreadable file: stored readings are all there is */ }

  for (const p of wanted) {
    if (pdf && p > pdf.numPages) continue;
    let text: string | null = stored.get(p) ?? null;
    let textFrom: PageRead["textFrom"] = text ? "stored" : null;
    if ((!text || text.length < READABLE_PAGE_CHARS) && pdf) {
      try {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const layer = (content.items as Array<{ str?: string; hasEOL?: boolean }>).map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ").trim();
        if (layer.length > (text?.length ?? 0)) { text = layer; textFrom = "text-layer"; }
      } catch { /* keep what we have */ }
    }
    const readable = !!text && text.length >= READABLE_PAGE_CHARS;
    let image: PageRead["image"] = null;
    if (pdf && render && (input.images === "always" || !readable)) {
      try {
        const img = await render(pdf, p, { width: RENDER_WIDTH, canvasImport: () => import("@napi-rs/canvas") });
        image = { page: p, mediaType: "image/png", base64: Buffer.from(img as ArrayBuffer).toString("base64") };
      } catch { /* skip */ }
    }
    if (textFrom === "stored") res.stored++;
    if (textFrom === "text-layer") res.textLayer++;
    if (image) { res.rendered++; res.images.push(image); }
    if (text || image) res.pages.push({ page: p, text, textFrom, image });
  }
  return res;
}

/** The text found, as a block for the model's user turn. Pages sent as text
 *  only are marked so the model treats them as the document itself. */
export function pagesAsText(r: PagesRead): string {
  let total = 0;
  const parts: string[] = [];
  for (const p of r.pages) {
    if (!p.text) continue;
    const body = p.text.slice(0, PAGE_CONTEXT_CAP);
    if (total + body.length > TOTAL_CONTEXT_CAP) break;
    total += body.length;
    parts.push(`=== PAGE ${p.page}${p.image ? " (also attached as an image)" : ""} ===\n${body}`);
  }
  return parts.length ? `\n\nTEXT OF THE PAGES (already read from the document - treat it as the document itself):\n${parts.join("\n\n")}` : "";
}

/** "3 pages from earlier reads, 2 from the PDF's text, 1 by image". */
export function pagesReadSummary(r: PagesRead): string {
  const bits: string[] = [];
  if (r.stored) bits.push(`${r.stored} from earlier reads`);
  if (r.textLayer) bits.push(`${r.textLayer} from the PDF's text`);
  if (r.rendered) bits.push(`${r.rendered} as images`);
  return bits.join(", ");
}
