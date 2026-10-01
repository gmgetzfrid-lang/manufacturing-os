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
//
// FLOW-13: the width is a parameter. The default stays RENDER_WIDTH (tuned
// for standards tables); a drawing reader passes DRAWING_RENDER_WIDTH, the
// width the vision ingester renders drawings at so small tags stay legible.
//
// PERF-6 (the renderer limb): pages render in parallel under a small cap,
// and every render in this process shares RENDER_SLOTS, so two reads at once
// hold at most RENDER_SLOTS page canvases between them, not one per page per
// read. The parsed document is destroyed when the read ends. A caller with a
// deadline (a route's maxDuration less its margin) passes `deadlineAt`: no
// page STARTS after it, so a long book ends with the pages that fit instead
// of a platform timeout. The shared slots are always given back: each render
// races a per-page timeout (a hung render is abandoned, its page counted
// failed, its slot released), a read waiting for a slot stops waiting at its
// deadline (its pages counted not started), and renderKnowledgePages gives a
// caller that names no deadline DEFAULT_RENDER_BUDGET_MS.
//
// FLOW-11: renderKnowledgePagesReport says what happened to every page asked
// for — rendered, outside the document, failed to render, or not started
// before the deadline — so a partial set is reported, never absorbed.
// renderKnowledgePages keeps the old contract (the images only; fewer or
// none on failure) for the callers that do not need the report.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import type { AiCallImage } from "@/lib/ai/providerCall";

export const MAX_DEEP_READ_PAGES = 6;
const RENDER_WIDTH = 1400;          // readable table text, modest tokens
/** The vision ingester's drawing width (lib/knowledgeIngest.ts: "small tags
 *  stay legible"). Drawing readers pass it. */
export const DRAWING_RENDER_WIDTH = 1800;
/** Page renders in flight in this process, across every read. */
export const RENDER_SLOTS = 2;
/** One page render longer than this is abandoned: the page is counted
 *  failed and its slot released, so a hung render never holds a slot. */
export const PAGE_RENDER_TIMEOUT_MS = 45_000;
/** renderKnowledgePages' deadline when its caller names none. */
export const DEFAULT_RENDER_BUDGET_MS = 60_000;

export type RenderedPage = AiCallImage & { page: number };

export interface PageRenderReport {
  /** Rendered pages, in the order they were asked for. */
  images: RenderedPage[];
  /** The document's page count; null when the file could not be opened. */
  numPages: number | null;
  /** Asked for, but past the document's last page. */
  outOfRange: number[];
  /** In range, but the render failed. */
  failed: number[];
  /** In range, but not started before the deadline. */
  notStarted: number[];
  /** The pixel width the pages were rendered at. */
  width: number;
  /** The file could not be fetched or opened (every page is missing). */
  openFailed: boolean;
}

export interface PageRenderOptions {
  maxPages?: number;
  width?: number;
  /** Renders this read runs at once (never more than RENDER_SLOTS). */
  concurrency?: number;
  /** Epoch ms; no page starts after it (nor waits for a slot past it). */
  deadlineAt?: number;
  /** Per-page render timeout (default PAGE_RENDER_TIMEOUT_MS). */
  pageTimeoutMs?: number;
}

// ── The process-wide render slots ───────────────────────────────────────────
/** setTimeout's ceiling: a longer delay would fire at once, not late. */
const MAX_TIMER_MS = 2 ** 31 - 1;
let inFlight = 0;
const waiting: Array<() => void> = [];
/** True when a slot is held; false when `deadlineAt` passed while waiting
 *  (the waiter is removed, so no released slot is ever handed to it). */
async function acquireSlot(deadlineAt?: number): Promise<boolean> {
  if (inFlight < RENDER_SLOTS) { inFlight += 1; return true; }
  // The releaser hands its slot straight to the first waiter (inFlight is
  // unchanged), so a newcomer can never slip in between and overfill.
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grant = () => { if (timer !== undefined) clearTimeout(timer); resolve(true); };
    waiting.push(grant);
    if (deadlineAt !== undefined) {
      timer = setTimeout(() => {
        const at = waiting.indexOf(grant);
        if (at >= 0) { waiting.splice(at, 1); resolve(false); }
      }, Math.min(MAX_TIMER_MS, Math.max(0, deadlineAt - Date.now())));
    }
  });
}
function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else inFlight -= 1;
}
/** A loader that runs once per process and shares its result — unless it
 *  FAILS: a rejected load is forgotten, so the next caller tries again
 *  rather than every later render (the ask route's deep read included)
 *  failing on one cold-start hiccup until the instance recycles. */
export function onceUnlessRejected<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => (cached ??= Promise.resolve().then(load).catch((e: unknown) => { cached = null; throw e; }));
}
// The PDF engine, loaded once per process and shared by every read.
const loadUnpdf = onceUnlessRejected(() => import("unpdf"));

/** For tests: renders holding a slot right now. */
export function rendersInFlight(): number { return inFlight; }
/** For tests: reads waiting for a slot right now. */
export function rendersWaiting(): number { return waiting.length; }

/** The render, or a rejection after `ms` — whichever comes first. An
 *  abandoned render's late failure is swallowed (the read is over). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => { /* abandoned: nobody is waiting for it */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("page render timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Render the requested pages of a stored PDF and say what became of each.
 *  Never throws. */
export async function renderKnowledgePagesReport(
  fileKey: string,
  pages: number[],
  opts: PageRenderOptions = {},
): Promise<PageRenderReport> {
  const width = opts.width ?? RENDER_WIDTH;
  const wanted = [...new Set(pages)].slice(0, opts.maxPages ?? MAX_DEEP_READ_PAGES);
  const report: PageRenderReport = {
    images: [], numPages: null, outOfRange: [], failed: [], notStarted: [], width, openFailed: false,
  };
  if (wanted.length === 0) return report;
  let pdf: { numPages: number; destroy?: () => Promise<void> | void } | null = null;
  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: fileKey }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const { getDocumentProxy, renderPageAsImage } = await loadUnpdf();
    const doc = await getDocumentProxy(bytes);
    pdf = doc;
    report.numPages = doc.numPages;
    const inRange = wanted.filter((p) => {
      if (p >= 1 && p <= doc.numPages) return true;
      report.outOfRange.push(p);
      return false;
    });
    const queue = [...inRange];
    const done = new Map<number, RenderedPage>();
    const pastDeadline = () => opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt;
    const worker = async () => {
      for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
        if (pastDeadline()) { report.notStarted.push(page); continue; }
        if (!(await acquireSlot(opts.deadlineAt))) { report.notStarted.push(page); continue; }
        try {
          if (pastDeadline()) { report.notStarted.push(page); continue; }
          const img = await withTimeout(renderPageAsImage(doc, page, {
            width,
            canvasImport: () => import("@napi-rs/canvas"),
          }), opts.pageTimeoutMs ?? PAGE_RENDER_TIMEOUT_MS);
          done.set(page, {
            page,
            mediaType: "image/png",
            base64: Buffer.from(img as ArrayBuffer).toString("base64"),
          });
        } catch {
          report.failed.push(page);
        } finally {
          releaseSlot();
        }
      }
    };
    const lanes = Math.max(1, Math.min(opts.concurrency ?? RENDER_SLOTS, RENDER_SLOTS, inRange.length || 1));
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    report.images = inRange.filter((p) => done.has(p)).map((p) => done.get(p) as RenderedPage);
    report.failed.sort((a, b) => a - b);
    report.notStarted.sort((a, b) => a - b);
    return report;
  } catch {
    report.openFailed = true;
    return report;
  } finally {
    if (pdf?.destroy) {
      try { await pdf.destroy(); } catch { /* the read is over either way */ }
    }
  }
}

/** Render the requested pages of a stored PDF to PNG images. Silently
 *  returns fewer (or zero) images on any render failure — deep read is an
 *  enhancement, never a reason an answer fails. A caller that names no
 *  deadline gets DEFAULT_RENDER_BUDGET_MS: no page starts, or waits for a
 *  slot, past it. */
export async function renderKnowledgePages(
  fileKey: string,
  pages: number[],
  maxPages = MAX_DEEP_READ_PAGES,
  deadlineAt: number = Date.now() + DEFAULT_RENDER_BUDGET_MS,
): Promise<Array<AiCallImage & { page: number }>> {
  return (await renderKnowledgePagesReport(fileKey, pages, { maxPages, deadlineAt })).images;
}
