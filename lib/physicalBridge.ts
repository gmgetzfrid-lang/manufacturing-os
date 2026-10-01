// lib/physicalBridge.ts
//
// THE PHYSICAL BRIDGE — printable artifacts that connect the plant floor
// back to the database with a phone camera. One lib, four artifacts:
//
//   * Equipment QR labels  — sticker per tag → /assets/[tag] (docs, holds,
//     doc pack, report-a-problem) — a STAFF page: a scan with no session is
//     sent to sign-in carrying the tag (PHYS-7 / HLD-13, option (b)), and
//     the caption says so. Single label or bulk sheet.
//   * Hold cards           — the physical red tag, made honest: scanning
//     answers "is this hold still active?" live.
//   * Ticket travelers     — one-pager that rides the paper folder;
//     scanning shows live ticket status.
//   * Package cover sheets — job-folder cover; scanning shows the live
//     verdict for the whole pack (green / amber / grey / red —
//     COVER_SCAN_LINES says what each means).
//
// Frictionless rules: every generator is ONE call with data the app
// already has — no options to configure, sensible layout defaults, and the
// download triggers immediately. All client-side (pdf-lib + qrcode).

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, PDFImage } from "pdf-lib";
import { publicOrigin } from "@/lib/publicOrigin";

const INK = rgb(0.09, 0.12, 0.16);
const MUTED = rgb(0.42, 0.47, 0.53);
const AMBER = rgb(0.7, 0.35, 0.02);
const RED = rgb(0.75, 0.11, 0.11);

async function qrPng(doc: PDFDocument, url: string): Promise<PDFImage | null> {
  try {
    const { toDataURL } = await import("qrcode");
    const dataUrl = await toDataURL(url, { margin: 1, width: 512 });
    return await doc.embedPng(dataUrl);
  } catch {
    return null;
  }
}

function download(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Every printed artifact QR-links against the PUBLIC origin — see
// lib/publicOrigin.ts for why window.location.origin is wrong here.
function origin(): string {
  return publicOrigin();
}

const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_");

/** Truncate text to fit a width at a size (binary-search-free, fine for labels). */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

// ─── Equipment QR labels ─────────────────────────────────────────────────

/** PHYS-7 / HLD-13 (option (b), 2026-09-17): the label keeps its
 *  /assets/<tag> target — every sticker already in the plant points there,
 *  and a re-stick across every tag is not a redeploy — and that page is a
 *  STAFF page (a scan with no session is sent to sign-in carrying the tag).
 *  So the caption promises exactly that: what the page delivers, to whom.
 *  Three short lines (bold, then regular) that fit the narrowest label —
 *  the old one-line caption ran off the single 3.5" sticker. */
export const LABEL_CAPTION_LINES: readonly string[] = [
  "SCAN — STAFF SIGN-IN",
  "drawings · holds ·",
  "report a problem",
];

/** The equipment label's QR target. Exported for tests: the path shape
 *  /assets/<tag> must survive (existing stickers). */
export function equipmentLabelUrl(tag: string): string {
  return `${origin()}/assets/${encodeURIComponent(tag)}`;
}

export interface LabelAsset {
  tag: string;
  description?: string | null;
  location?: string | null;
}

/** One asset per call → a single 3.5"×2" label, or many → a letter sheet
 *  of 10 labels (2×5, Avery 5163-compatible). Auto-picks by count. */
export async function printEquipmentLabels(assets: LabelAsset[]): Promise<void> {
  if (assets.length === 0) return;
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  const drawLabel = async (
    page: PDFPage, x: number, y: number, w: number, h: number, asset: LabelAsset,
  ) => {
    const url = equipmentLabelUrl(asset.tag);
    const qr = await qrPng(doc, url);
    const pad = 8;
    const qrSize = h - pad * 2;
    page.drawRectangle({ x, y, width: w, height: h, borderColor: MUTED, borderWidth: 0.75, color: rgb(1, 1, 1) });
    if (qr) page.drawImage(qr, { x: x + pad, y: y + pad, width: qrSize, height: qrSize });
    const tx = x + pad + qrSize + pad;
    const maxW = w - (tx - x) - pad;
    page.drawText(fit(asset.tag, bold, 20, maxW), { x: tx, y: y + h - pad - 20, size: 20, font: bold, color: INK });
    if (asset.description) {
      page.drawText(fit(asset.description, regular, 9, maxW), { x: tx, y: y + h - pad - 34, size: 9, font: regular, color: INK });
    }
    if (asset.location) {
      page.drawText(fit(asset.location, regular, 8, maxW), { x: tx, y: y + h - pad - 46, size: 8, font: regular, color: MUTED });
    }
    // Bottom-up: the last caption line sits on the label's bottom margin.
    LABEL_CAPTION_LINES.forEach((line, i) => {
      const font = i === 0 ? bold : regular;
      const lineY = y + pad + 2 + (LABEL_CAPTION_LINES.length - 1 - i) * 9;
      page.drawText(fit(line, font, 7, maxW), { x: tx, y: lineY, size: 7, font, color: MUTED });
    });
  };

  if (assets.length === 1) {
    // Single sticker: 3.5in × 2in at 72pt/in.
    const page = doc.addPage([252, 144]);
    await drawLabel(page, 0, 0, 252, 144, assets[0]);
  } else {
    // Letter sheet, 2 × 5 grid of 4"×2" labels (Avery 5163 geometry).
    const PW = 612, PH = 792, LW = 288, LH = 144;
    const marginX = (PW - LW * 2) / 2;
    const marginY = (PH - LH * 5) / 2;
    let page = doc.addPage([PW, PH]);
    for (let i = 0; i < assets.length; i++) {
      const slot = i % 10;
      if (i > 0 && slot === 0) page = doc.addPage([PW, PH]);
      const col = slot % 2;
      const row = Math.floor(slot / 2);
      await drawLabel(page, marginX + col * LW, PH - marginY - (row + 1) * LH, LW, LH, assets[i]);
    }
  }

  const bytes = await doc.save();
  const name = assets.length === 1
    ? `QR_Label_${safe(assets[0].tag)}.pdf`
    : `QR_Labels_${assets.length}_tags_${new Date().toISOString().slice(0, 10)}.pdf`;
  download(bytes, name);
}

// ─── Hold cards ──────────────────────────────────────────────────────────

/** The hold card's scan instruction (VFY-10 / PHYS-10) — what the field
 *  follows, so it says exactly what /verify-hold answers. */
export const HOLD_CARD_SCAN_LINES: readonly string[] = [
  "GREEN when scanned = no hold remains on this document — this tag comes down.",
  "AMBER = this hold is released but another is still active — leave the equipment tagged.",
];
/** The text column left of the QR plate (x 32 → 452). */
export const HOLD_CARD_TEXT_WIDTH = 410;

export interface HoldCardInput {
  holdId: string;
  docLabel: string;
  docRev: string | null;
  reason: string;
  notes?: string | null;
  openedByName?: string | null;
  openedAt: string;
}

/** Half-letter landscape card, unmissably red, with the live-status QR. */
export async function printHoldCard(input: HoldCardInput): Promise<void> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 396]); // half letter, landscape

  page.drawRectangle({ x: 0, y: 0, width: 612, height: 396, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 10, y: 10, width: 592, height: 376, borderColor: RED, borderWidth: 6 });
  page.drawRectangle({ x: 10, y: 316, width: 592, height: 70, color: RED });
  page.drawText("HOLD — DO NOT ADVANCE", { x: 32, y: 338, size: 30, font: bold, color: rgb(1, 1, 1) });

  page.drawText(fit(`${input.docLabel}${input.docRev ? `  ·  Rev ${input.docRev}` : ""}`, bold, 18, 380), {
    x: 32, y: 280, size: 18, font: bold, color: INK,
  });
  page.drawText(fit(`Reason: ${input.reason}`, bold, 13, 380), { x: 32, y: 252, size: 13, font: bold, color: RED });
  if (input.notes) {
    page.drawText(fit(input.notes, regular, 10, 380), { x: 32, y: 232, size: 10, font: regular, color: INK });
  }
  page.drawText(
    `Placed by ${input.openedByName || "Document Control"} on ${new Date(input.openedAt).toLocaleDateString()}`,
    { x: 32, y: 208, size: 10, font: regular, color: MUTED },
  );

  const qr = await qrPng(doc, `${origin()}/verify-hold/${input.holdId}`);
  if (qr) {
    page.drawImage(qr, { x: 452, y: 60, width: 130, height: 130 });
    page.drawText("SCAN: is this hold", { x: 452, y: 46, size: 9, font: bold, color: INK });
    page.drawText("still active?", { x: 452, y: 35, size: 9, font: bold, color: INK });
  }
  // VFY-10 / PHYS-10: the instruction matches the conditional verdict — a
  // released card is GREEN only when no other hold remains on the document;
  // released with another hold still active is AMBER, and the tag stays.
  HOLD_CARD_SCAN_LINES.forEach((line, i) => {
    page.drawText(fit(line, regular, 9, HOLD_CARD_TEXT_WIDTH), { x: 32, y: 50 - i * 12, size: 9, font: regular, color: MUTED });
  });

  download(await doc.save(), `HOLD_${safe(input.docLabel)}.pdf`);
}

// ─── Ticket travelers ────────────────────────────────────────────────────

export interface TravelerInput {
  ticketRowId: string;          // DB id → public /verify-ticket/[id]
  ticketNumber: string | null;  // human number, e.g. KE-DDRT-26-0001
  title: string;
  status: string;
  requesterName?: string | null;
  drafterName?: string | null;
  createdAt?: string | null;
  /** Current deliverable rev at print time (1A while in review, 1 issued). */
  deliverableRev?: string | null;
}

/** One-pager that rides the paper folder. Scan → live ticket status. */
export async function printTicketTraveler(input: TravelerInput): Promise<void> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);

  page.drawRectangle({ x: 36, y: 700, width: 540, height: 56, color: INK });
  page.drawText("DRAFTING TRAVELER", { x: 52, y: 728, size: 20, font: bold, color: rgb(1, 1, 1) });
  page.drawText(input.ticketNumber ?? "", { x: 52, y: 710, size: 11, font: regular, color: rgb(0.8, 0.85, 0.9) });

  page.drawText(fit(input.title, bold, 15, 400), { x: 52, y: 660, size: 15, font: bold, color: INK });
  const lines: Array<[string, string]> = [
    ["Status at printing", input.status.replace(/_/g, " ")],
    ["Deliverable rev", input.deliverableRev ? `Rev ${input.deliverableRev}` : "— (none issued yet)"],
    ["Requested by", input.requesterName || "—"],
    ["Drafter", input.drafterName || "—"],
    ["Opened", input.createdAt ? new Date(input.createdAt).toLocaleDateString() : "—"],
  ];
  lines.forEach(([k, v], i) => {
    const y = 620 - i * 22;
    page.drawText(`${k}:`, { x: 52, y, size: 10, font: bold, color: MUTED });
    page.drawText(fit(v, regular, 10, 280), { x: 170, y, size: 10, font: regular, color: INK });
  });
  page.drawText("Paper goes stale — the QR doesn't. Anyone can scan it, no", { x: 52, y: 500, size: 10, font: regular, color: MUTED });
  page.drawText("login: it answers whether this ticket's deliverable is still", { x: 52, y: 487, size: 10, font: regular, color: MUTED });
  page.drawText("the latest issued revision.", { x: 52, y: 474, size: 10, font: regular, color: MUTED });

  // PUBLIC verify page — the person holding the folder in the field has no
  // account; sending them to the protected app was a login wall.
  const verifyTarget = `${origin()}/verify-ticket/${input.ticketRowId}${input.deliverableRev ? `?r=${encodeURIComponent(input.deliverableRev)}` : ""}`;
  const qr = await qrPng(doc, verifyTarget);
  if (qr) {
    page.drawImage(qr, { x: 420, y: 520, width: 150, height: 150 });
    page.drawText("SCAN TO VERIFY REVISION", { x: 424, y: 505, size: 9, font: bold, color: INK });
  }

  download(await doc.save(), `Traveler_${safe(input.ticketNumber ?? input.ticketRowId)}.pdf`);
}

// ─── Work-package cover sheets ───────────────────────────────────────────

/** Rows on the cover's first page (above the QR plate) and on each
 *  continuation page. */
export const COVER_FIRST_PAGE_ROWS = 24;
export const COVER_CONTINUATION_ROWS = 40;
const COVER_ROW_HEIGHT = 16;

/** [from, to) index ranges of the contents list per cover page — every
 *  sheet appears exactly once, in order (PKG-12). Pure; exported for tests. */
export function coverContentsChunks(count: number): Array<[number, number]> {
  if (count <= 0) return [];
  const out: Array<[number, number]> = [[0, Math.min(count, COVER_FIRST_PAGE_ROWS)]];
  for (let from = COVER_FIRST_PAGE_ROWS; from < count; from += COVER_CONTINUATION_ROWS) {
    out.push([from, Math.min(count, from + COVER_CONTINUATION_ROWS)]);
  }
  return out;
}

/** The cover's scan legend (VFY-2 / VFY-8 / VFY-11 / PHYS-1) — what the
 *  crew follows, so it states the verdict set /verify-package answers
 *  (lib/verifyPresent.ts presentPackVerdict): green only "current"; amber
 *  "not yet in effect" and "incomplete" (a package sheet not in this pack
 *  that cannot be printed now); grey "closed", "empty", "can't confirm which
 *  printing", "can't verify"; red "held" and "stale" (changed / withdrawn /
 *  removed, not an issued revision, a sheet no longer available, a package
 *  sheet a re-print would carry missing from this pack). The old two-colour
 *  legend (green "this pack is current", red "a sheet changed since
 *  printing") knew neither amber nor grey, and its red line, at x 428, ran
 *  past the page edge. */
export const COVER_SCAN_LINES: readonly string[] = [
  "GREEN = every sheet is current — work from this pack.",
  "AMBER = do only what the screen says — a sheet is not yet in effect or not in this pack.",
  "GREY = the scan cannot confirm this pack — check with Document Control before work.",
  "RED = stop — a sheet changed, was withdrawn, is held, is not issued or is missing.",
];
/** The cover's text column left of the QR plate (x 52 → 420; the plate's
 *  caption starts at x 428). */
export const COVER_TEXT_WIDTH = 368;

export interface PackageCoverInput {
  packageId: string;
  /** The immutable print-snapshot id (PKG-2). When present the QR verifies
   *  against WHAT WAS PRINTED, so refreshing pins can't flip this paper's
   *  verdict. Omitted → legacy package-level QR. */
  printId?: string | null;
  name: string;
  description?: string | null;
  ownerName?: string | null;
  printedByName?: string | null;
  docs: Array<{ label: string; rev: string | null }>;
}

/** Cover page (returned as a PDFDocument so callers can prepend it to the
 *  merged drawing pack). Scan → the live pack verdict (COVER_SCAN_LINES). */
export async function buildPackageCover(input: PackageCoverInput): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);

  page.drawRectangle({ x: 36, y: 690, width: 540, height: 66, color: INK });
  page.drawText("WORK PACKAGE", { x: 52, y: 726, size: 14, font: bold, color: rgb(0.7, 0.78, 0.86) });
  page.drawText(fit(input.name, bold, 22, 500), { x: 52, y: 700, size: 22, font: bold, color: rgb(1, 1, 1) });

  if (input.description) {
    page.drawText(fit(input.description, regular, 11, 520), { x: 52, y: 662, size: 11, font: regular, color: INK });
  }
  page.drawText(
    `Owner: ${input.ownerName || "—"}   ·   Printed ${new Date().toLocaleDateString()}${input.printedByName ? ` by ${input.printedByName}` : ""}`,
    { x: 52, y: 640, size: 9, font: regular, color: MUTED },
  );

  // PKG-12: EVERY sheet is listed, in pack order — continuation pages carry
  // the rest (the cover used to list 24 and summarise the remainder as
  // "…and N more sheets", so a printed folder could not be checked for
  // completeness). The cover pages are all prepended to the pack.
  const chunks = coverContentsChunks(input.docs.length);
  const totalPages = chunks.length;
  page.drawText(
    totalPages > 1 ? `CONTENTS — revisions as printed (${input.docs.length} sheets; continued on ${totalPages - 1} more page${totalPages > 2 ? "s" : ""})` : "CONTENTS — revisions as printed",
    { x: 52, y: 600, size: 10, font: bold, color: MUTED },
  );
  const drawRows = (p: PDFPage, from: number, to: number, topY: number) => {
    for (let i = from; i < to; i++) {
      const d = input.docs[i];
      const y = topY - (i - from) * COVER_ROW_HEIGHT;
      p.drawText(fit(`${i + 1}.  ${d.label}`, regular, 10, 380), { x: 52, y, size: 10, font: regular, color: INK });
      p.drawText(`Rev ${d.rev ?? "—"}`, { x: 460, y, size: 10, font: bold, color: INK });
    }
  };
  if (chunks.length) drawRows(page, chunks[0][0], chunks[0][1], 580);
  chunks.slice(1).forEach(([from, to], k) => {
    const cont = doc.addPage([612, 792]);
    cont.drawText(fit(`WORK PACKAGE — ${input.name}`, bold, 12, 500), { x: 52, y: 750, size: 12, font: bold, color: INK });
    cont.drawText(`CONTENTS (continued) — revisions as printed · page ${k + 2} of ${totalPages}`, { x: 52, y: 730, size: 10, font: bold, color: MUTED });
    drawRows(cont, from, to, 706);
  });

  // PUBLIC verify page — the crew member scanning in the field has no
  // account; the old /packages target was a login wall under the words
  // "SCAN BEFORE STARTING WORK".
  const verifyTarget = input.printId
    ? `${origin()}/verify-package/${input.packageId}?print=${input.printId}`
    : `${origin()}/verify-package/${input.packageId}`;
  const qr = await qrPng(doc, verifyTarget);
  if (qr) {
    page.drawImage(qr, { x: 440, y: 80, width: 130, height: 130 });
    page.drawText("SCAN BEFORE STARTING WORK", { x: 428, y: 66, size: 9, font: bold, color: AMBER });
    page.drawText("No login needed.", { x: 428, y: 54, size: 8, font: regular, color: MUTED });
    // The legend, left of the QR plate and below the contents (which end at
    // y 212 on the first page): every verdict colour the scan can answer.
    COVER_SCAN_LINES.forEach((line, i) => {
      page.drawText(fit(line, regular, 9, COVER_TEXT_WIDTH), { x: 52, y: 102 - i * 12, size: 9, font: regular, color: MUTED });
    });
  }
  return doc;
}
