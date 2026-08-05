// lib/stamping.ts
//
// CONTENT-AWARE STAMPING — measured, never guessed.
//
// Every uncontrolled copy gets three marks; each one now proves it fits and
// avoids the drawing's own content, per page, whatever the sheet size or
// orientation:
//
//   * Diagonal watermark — font size computed from the MEASURED text width
//     so the rotated run always fits inside the page, centered. Long
//     user/email/date strings shrink (and finally truncate) instead of
//     running off the edge.
//   * Footer lines — word-wrapped to the page width (minus the QR plate
//     when they share an edge) and drawn on whichever horizontal band (top
//     or bottom) the page actually has free — title blocks usually own the
//     bottom, so busy bottoms push the footer up top.
//   * Verify-QR — placed in the EMPTIEST corner of each page, found by
//     rasterizing the page at thumbnail size (pdf.js) and comparing ink
//     density in the four corners. White backing plate, clamped on-page.
//
// The raster analysis is best-effort: no DOM, worker failure, or a page
// that won't render simply falls back to the historical bottom-right/bottom
// placements. The pure math lives in lib/stampLayout.ts (unit-tested).

import { PDFDocument, rgb, StandardFonts, degrees, PDFFont, PDFPage } from "pdf-lib";
import {
  fitRotatedTextSize, centerRotatedText, wrapToWidth,
  pickQrCorner, pickFooterEdge, placeQr,
  FALLBACK_INK, type PageInk, type Corner,
} from "@/lib/stampLayout";

export type StampOptions = {
  userLabel?: string;
  email?: string;
  timestamp?: Date;
  expiresAt?: Date | null;
  watermarkText?: string;
  /** Extra footer line — rev-at-issue + active-change warning. The paper
   *  copy on the desk should warn for itself. */
  footerNotice?: string;
  /** When set, a QR code linking here is stamped on every page so anyone in
   *  the field can scan the PRINT and instantly see whether it's still the
   *  current revision. Paper that verifies itself. */
  verifyUrl?: string;
  /** The original PDF bytes. When provided (and a DOM exists), each page is
   *  rasterized at thumbnail size to find its empty regions so the QR and
   *  footer land where the drawing ISN'T. Omit → conventional placements. */
  sourceBytes?: ArrayBuffer | Uint8Array;
};

function formatDate(d?: Date | null) {
  if (!d) return "";
  return d.toLocaleString();
}

function buildStampText(opts: StampOptions) {
  const parts = [];
  if (opts.watermarkText) parts.push(opts.watermarkText);
  if (opts.userLabel) parts.push(opts.userLabel);
  if (opts.email) parts.push(opts.email);
  if (opts.timestamp) parts.push(`Downloaded: ${formatDate(opts.timestamp)}`);
  if (opts.expiresAt) parts.push(`Expires: ${formatDate(opts.expiresAt)}`);
  return parts.filter(Boolean).join(" • ");
}

// ─── Page ink analysis (browser-only, best-effort) ───────────────────────

const RASTER_WIDTH = 220;      // thumbnail width in px — cheap and enough
const DARK_LUMA = 200;         // pixel luminance below this counts as ink
const MAX_ANALYZED_PAGES = 40; // beyond this, reuse the last page's analysis

/** Fraction of dark pixels inside a rect of the rasterized page. */
function inkIn(
  data: Uint8ClampedArray, imgW: number, imgH: number,
  x0: number, y0: number, x1: number, y1: number,
): number {
  let dark = 0, total = 0;
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(imgW, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(imgH, Math.ceil(y1));
  for (let y = ya; y < yb; y += 1) {
    for (let x = xa; x < xb; x += 1) {
      const i = (y * imgW + x) * 4;
      const a = data[i + 3];
      if (a < 30) { total += 1; continue; } // transparent = blank
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma < DARK_LUMA) dark += 1;
      total += 1;
    }
  }
  return total === 0 ? 0 : dark / total;
}

/**
 * Rasterize each page at thumbnail size and measure ink density in the four
 * corner boxes + the top/bottom bands. Returns null when analysis isn't
 * possible (no DOM, pdf.js failure) — callers fall back to convention.
 * Canvas y runs top-down; results are expressed in PDF orientation
 * (bl = bottom-left of the printed page).
 */
async function analyzePageInk(source: ArrayBuffer | Uint8Array): Promise<PageInk[] | null> {
  if (typeof document === "undefined") return null;
  try {
    const { pdfjs } = await import("react-pdf");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    // pdf.js transfers the buffer to its worker — hand it a copy so the
    // caller's bytes stay usable (pdf-lib needs them too).
    const { PDFJS_VERBOSITY } = await import("@/lib/pdfjsConfig");
    const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: PDFJS_VERBOSITY }).promise;
    try {
      const out: PageInk[] = [];
      const pageCount = Math.min(doc.numPages, MAX_ANALYZED_PAGES);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      for (let p = 1; p <= pageCount; p += 1) {
        const page = await doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: RASTER_WIDTH / base.width });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const W = canvas.width, H = canvas.height;
        // Corner boxes ≈ the QR plate's share of the page; bands for footers.
        const cw = W * 0.24, ch = H * 0.16, m = W * 0.015;
        const bandH = H * 0.09;
        out.push({
          corners: {
            // canvas top = PDF top; PDF "bl" = canvas bottom-left.
            tl: inkIn(data, W, H, m, m, m + cw, m + ch),
            tr: inkIn(data, W, H, W - m - cw, m, W - m, m + ch),
            bl: inkIn(data, W, H, m, H - m - ch, m + cw, H - m),
            br: inkIn(data, W, H, W - m - cw, H - m - ch, W - m, H - m),
          },
          topBand: inkIn(data, W, H, 0, 0, W, bandH),
          bottomBand: inkIn(data, W, H, 0, H - bandH, W, H),
        });
      }
      return out;
    } finally {
      void doc.destroy();
    }
  } catch (e) {
    console.warn("[stamping] page analysis unavailable — using conventional placements", e);
    return null;
  }
}

// ─── The stamp itself ────────────────────────────────────────────────────

function drawWatermark(page: PDFPage, font: PDFFont, text: string): void {
  if (!text) return;
  const { width, height } = page.getSize();
  const ANGLE = -30;
  let run = text;
  let widthAt1pt = font.widthOfTextAtSize(run, 1);
  let fit = fitRotatedTextSize({ widthAt1pt, pageW: width, pageH: height, angleDeg: ANGLE });
  // If even the minimum size overflows, truncate the run until it fits —
  // a clipped watermark is useless; a shorter centered one still reads.
  while (run.length > 8) {
    const w = widthAt1pt * fit.size;
    const a = Math.abs(ANGLE) * (Math.PI / 180);
    if (w * Math.cos(a) + fit.size * Math.sin(a) <= width * 0.88) break;
    run = `${run.slice(0, Math.floor(run.length * 0.8))}…`;
    widthAt1pt = font.widthOfTextAtSize(run, 1);
    fit = fitRotatedTextSize({ widthAt1pt, pageW: width, pageH: height, angleDeg: ANGLE });
  }
  const textW = widthAt1pt * fit.size;
  const { x, y } = centerRotatedText({
    pageW: width, pageH: height, textW, textH: fit.size, angleDeg: ANGLE,
  });
  page.drawText(run, {
    x, y,
    size: fit.size, font,
    color: rgb(0.2, 0.2, 0.2),
    opacity: 0.15,
    rotate: degrees(ANGLE),
  });
}

function drawFooter(input: {
  page: PDFPage;
  font: PDFFont;
  opts: StampOptions;
  edge: "top" | "bottom";
  qrCorner: Corner | null;
}): void {
  const { page, font, opts, edge, qrCorner } = input;
  const { width, height } = page.getSize();

  const mainSize = Math.min(10, Math.max(6.5, width / 62));
  const noticeSize = Math.max(6, mainSize - 1.5);
  const marginX = Math.max(10, width * 0.03);
  const marginY = Math.max(8, height * 0.018);

  // Reserve the QR plate's width when the footer shares its edge, so the
  // two can never collide.
  const qrOnThisEdge =
    qrCorner !== null &&
    ((edge === "bottom" && (qrCorner === "bl" || qrCorner === "br")) ||
     (edge === "top" && (qrCorner === "tl" || qrCorner === "tr")));
  const qrReserve = qrOnThisEdge ? Math.max(46, Math.min(70, width / 12)) + width * 0.045 : 0;
  const qrOnLeft = qrCorner === "bl" || qrCorner === "tl";

  const maxLineW = width - marginX * 2 - qrReserve;
  const xStart = marginX + (qrOnThisEdge && qrOnLeft ? qrReserve : 0);

  const mainText = `UNCONTROLLED COPY • Downloaded: ${formatDate(opts.timestamp)} • Do Not Distribute`;
  const mainLines = wrapToWidth(mainText, maxLineW, (s) => font.widthOfTextAtSize(s, mainSize));
  const noticeLines = opts.footerNotice
    ? wrapToWidth(opts.footerNotice, maxLineW, (s) => font.widthOfTextAtSize(s, noticeSize))
    : [];

  // Stack order top→bottom: main lines then notice lines.
  const entries: Array<{ text: string; size: number; color: ReturnType<typeof rgb> }> = [
    ...mainLines.map((t) => ({ text: t, size: mainSize, color: rgb(0.5, 0.0, 0.0) })),
    ...noticeLines.map((t) => ({ text: t, size: noticeSize, color: rgb(0.55, 0.3, 0.0) })),
  ];
  const lineGap = 2;
  const blockH = entries.reduce((h, e) => h + e.size + lineGap, 0);

  let yCursor = edge === "bottom" ? marginY + blockH : height - marginY;
  for (const e of entries) {
    yCursor -= e.size;
    page.drawText(e.text, {
      x: xStart, y: yCursor,
      size: e.size, font,
      color: e.color,
      opacity: 0.85,
    });
    yCursor -= lineGap;
  }
}

export async function applyStampToPdfDoc(pdfDoc: PDFDocument, opts: StampOptions): Promise<void> {
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const watermark = buildStampText(opts);

  // Verification QR — generated once, embedded on every page. Failure to
  // generate must never fail the stamp (the copy still goes out, just
  // without the scan affordance).
  let qrImage: Awaited<ReturnType<typeof pdfDoc.embedPng>> | null = null;
  if (opts.verifyUrl) {
    try {
      const { toDataURL } = await import("qrcode");
      const dataUrl = await toDataURL(opts.verifyUrl, { margin: 1, width: 256 });
      qrImage = await pdfDoc.embedPng(dataUrl);
    } catch (e) {
      console.warn("[stamping] QR generation failed (stamp continues without it)", e);
    }
  }

  // Per-page emptiness analysis — where does this sheet have room?
  const ink = opts.sourceBytes ? await analyzePageInk(opts.sourceBytes) : null;

  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const { width, height } = page.getSize();
    // Pages beyond the analyzed cap reuse the last analyzed page (sheets in
    // a set share their template); no analysis at all → convention.
    const pageInk: PageInk = ink?.[Math.min(i, ink.length - 1)] ?? FALLBACK_INK;

    drawWatermark(page, font, watermark);

    const qrCorner = qrImage ? pickQrCorner(pageInk.corners) : null;
    const footerEdge = pickFooterEdge(pageInk.topBand, pageInk.bottomBand);
    drawFooter({ page, font, opts, edge: footerEdge, qrCorner });

    if (qrImage && qrCorner) {
      const q = placeQr({ pageW: width, pageH: height, corner: qrCorner });
      // White backing plate: even the emptiest corner of a drawing can have
      // stray linework — the code must stay scannable regardless.
      page.drawRectangle({
        x: q.plate.x, y: q.plate.y, width: q.plate.w, height: q.plate.h,
        color: rgb(1, 1, 1),
        opacity: 0.92,
      });
      page.drawImage(qrImage, { x: q.qrX, y: q.qrY, width: q.qrSize, height: q.qrSize });
      page.drawText("SCAN TO VERIFY", {
        x: q.labelX, y: q.labelY,
        size: q.labelSize,
        font,
        color: rgb(0.25, 0.25, 0.25),
        opacity: 0.9,
      });
    }
  }
}

export async function stampPdf(url: string, opts: StampOptions): Promise<Blob> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const source = await res.arrayBuffer();
    const pdfDoc = await PDFDocument.load(source);
    await applyStampToPdfDoc(pdfDoc, { ...opts, sourceBytes: source });
    const stamped = await pdfDoc.save();
    return new Blob([stamped as BlobPart], { type: "application/pdf" });
  } catch (error) {
    console.error("PDF Stamping Error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Failed to fetch")) {
      throw new Error("CORS_BLOCK: Unable to access file data for stamping. Check the storage bucket's CORS configuration.");
    }
    throw error;
  }
}

export async function downloadStampedPdf(params: {
  url: string;
  filename: string;
  options: StampOptions;
}) {
  const blob = await stampPdf(params.url, params.options);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = params.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
