// lib/sendToDrafting.ts
//
// One new drafting request from a set of sheets: each sheet's issued file,
// with the person's markups drawn into it where they marked it up. Shared by
// the book viewer ("Send markups") and the Staged page ("Send to drafting"),
// so both attach the same files and fill in the request the same way.
//
// Browser-only (it fetches files and bakes markups on a canvas).

import { supabase } from "@/lib/supabase";
import { resolveFileUrl } from "@/lib/storage";
import { stashDraft, type DraftHandoffFile } from "@/lib/draftHandoff";
import { hasMarkups, type PageMarkups } from "@/lib/stagedDocs";
import type { DocumentRecord } from "@/types/schema";

/** The stored path of the file a document shows: its current version, else
 *  the newest version that is not waiting in review. */
export async function issuedFilePath(doc: Pick<DocumentRecord, "id" | "currentVersionId">): Promise<string | null> {
  if (doc.currentVersionId) {
    const { data } = await supabase.from("document_versions").select("file_url").eq("id", doc.currentVersionId).single();
    if (data?.file_url) return data.file_url as string;
  }
  const { data } = await supabase.from("document_versions").select("file_url").eq("record_id", doc.id)
    .or("review_state.is.null,review_state.eq.approved").order("created_at", { ascending: false }).limit(1);
  return data && data.length > 0 ? (data[0].file_url as string) : null;
}

/** A URL this browser can read the document's issued file from. */
export async function issuedFileUrl(doc: Pick<DocumentRecord, "id" | "currentVersionId">): Promise<string | null> {
  const path = await issuedFilePath(doc);
  return path ? resolveFileUrl(path) : null;
}

/** The sheet with the person's markups drawn into it, as a PDF. */
export async function markedUpPdf(url: string, markups: PageMarkups): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The file could not be read (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // fabric and pdf-lib load only when a sheet is actually baked.
  const { bakeMarkupIntoPdf } = await import("@/lib/markupExport");
  const baked = await bakeMarkupIntoPdf(bytes, markups);
  return new Blob([baked as BlobPart], { type: "application/pdf" });
}

export interface DraftingSheet {
  doc: DocumentRecord;
  /** Where the browser reads the issued file (resolved). */
  url: string | null;
  /** The stored path, for the original file's extension. */
  path?: string | null;
  /** The person's markups; drawn into the PDF when there are any. */
  markups?: PageMarkups | null;
}

// Number, sheet and rev: sheets of one drawing share a number, so the sheet
// keeps their files apart.
const stemOf = (d: DocumentRecord) => {
  const sheet = sheetOf(d);
  return `${d.documentNumber || d.title || "sheet"}${sheet ? `_Sh${sheet}` : ""}${d.rev ? `_Rev${d.rev}` : ""}`.replace(/[^\w.\-]+/g, "_");
};

function extOf(path: string | null | undefined, type: string): string {
  const m = /\.([A-Za-z0-9]{1,6})(?:\?.*)?$/.exec(path ?? "");
  if (m) return `.${m[1].toLowerCase()}`;
  return type === "application/pdf" || !type ? ".pdf" : "";
}

/** The file a sheet goes to drafting as: the marked-up PDF, or the original. */
async function sheetFile(s: DraftingSheet): Promise<DraftHandoffFile | null> {
  if (!s.url) return null;
  const docId = s.doc.id, docNumber = s.doc.documentNumber || undefined;
  if (s.markups && hasMarkups(s.markups)) {
    const blob = await markedUpPdf(s.url, s.markups);
    return { name: `${stemOf(s.doc)}_markup.pdf`, blob, docId, docNumber };
  }
  const res = await fetch(s.url);
  if (!res.ok) return null;
  const blob = await res.blob();
  return { name: `${stemOf(s.doc)}${extOf(s.path, blob.type)}`, blob, docId, docNumber };
}

const metaVal = (d: DocumentRecord, re: RegExp): string | null => {
  const m = (d.metadata ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(m)) if (re.test(k) && v != null && v !== "") return String(v);
  return null;
};
const sheetOf = (d: DocumentRecord) => (d.sheetNumber != null ? String(d.sheetNumber) : metaVal(d, /sheet/i));
const unitOf = (d: DocumentRecord) => metaVal(d, /\bunit\b|\barea\b/i);

/** The request's title, description and unit for the sheets going with it:
 *  number, rev, sheet and title per sheet, and the unit when they share one.
 *  The requester only adds what needs to change. */
export function draftingRequestText(
  sheets: Array<{ doc: DocumentRecord; markedUp: boolean }>,
  notAttached: DocumentRecord[] = [],
): { title: string; description: string; unit: string } {
  const n = sheets.length;
  const marked = sheets.filter((s) => s.markedUp).length;
  const units = Array.from(new Set(sheets.map((s) => unitOf(s.doc)).filter((u): u is string => !!u)));
  const unit = units.length === 1 ? units[0] : "";
  const plural = (k: number) => `${k} sheet${k === 1 ? "" : "s"}`;
  const mixed = marked > 0 && marked < n;
  const lines = sheets.map(({ doc: d, markedUp }) => {
    const sheet = sheetOf(d);
    return `• ${d.documentNumber || d.title || "Document"}${d.rev ? ` Rev ${d.rev}` : ""}${sheet ? ` · Sheet ${sheet}` : ""}${d.title && d.title !== d.documentNumber ? ` - ${d.title}` : ""}${mixed && markedUp ? " (marked up)" : ""}`;
  });
  const head = marked === n ? "Marked-up sheets, attached as Source files:"
    : marked > 0 ? `Sheets attached as Source files, ${marked} marked up:`
    : "Sheets attached as Source files:";
  const title = (marked === n ? `Markups: ${plural(n)}` : marked > 0 ? `Markups: ${plural(n)}, ${marked} marked up` : `${plural(n)} for drafting`)
    + (unit ? ` · Unit ${unit}` : "");
  const missing = notAttached.length
    ? `\nNot attached, the file could not be read: ${notAttached.map((d) => `${d.documentNumber || d.title || "Document"}${d.rev ? ` Rev ${d.rev}` : ""}`).join(", ")}`
    : "";
  const description = [head, ...lines, missing, unit ? `\nUnit: ${unit}` : "", "\nWhat needs to change:\n- "].filter(Boolean).join("\n");
  return { title, description, unit };
}

/** A document as a sheet to send: where its issued file is, and its markups. */
export async function draftingSheet(doc: DocumentRecord, markups?: PageMarkups | null): Promise<DraftingSheet> {
  const path = doc.id ? await issuedFilePath({ id: doc.id, currentVersionId: doc.currentVersionId }) : null;
  return { doc, path, url: path ? await resolveFileUrl(path) : null, markups: markups ?? null };
}

/** Read every sheet's file (marked-up sheets with their markups drawn in),
 *  hand them to the request form, and return its address. `href` is null
 *  when no file could be read; `skipped` are the sheets left out. */
export async function prepareDraftingRequest(sheets: DraftingSheet[]): Promise<{ href: string | null; skipped: DocumentRecord[] }> {
  const files: DraftHandoffFile[] = [];
  const sent: Array<{ doc: DocumentRecord; markedUp: boolean }> = [];
  const skipped: DocumentRecord[] = [];
  // One at a time: a book of large P&IDs baked at once would hold them all in memory.
  for (const s of sheets) {
    try {
      const f = await sheetFile(s);
      if (f) { files.push(f); sent.push({ doc: s.doc, markedUp: !!s.markups && hasMarkups(s.markups) }); }
      else skipped.push(s.doc);
    } catch (e) {
      console.error("drafting: a sheet could not be prepared", e);
      skipped.push(s.doc);
    }
  }
  if (files.length === 0) return { href: null, skipped };
  const { title, description, unit } = draftingRequestText(sent, skipped);
  const key = await stashDraft(files);
  const params = new URLSearchParams({ title, description, draft: key });
  if (unit) params.set("unit", unit);
  return { href: `/requests/new?${params.toString()}`, skipped };
}
