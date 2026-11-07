// updatePrint - the shift turnover, kick-off or close-out as it goes out:
// the sections chosen in the Email / Print box (remembered on this device),
// as an email body or a printed page (on the letterhead when the project
// has one). The Shift tab's Email / Print and Reports print the same thing.

import { toEmailHtml, toPlainText, headerHtml, headerText, tilePart, type ExportDoc, type ExportBlock, type HeaderPart } from "@/lib/reportExport";
import { formHtml, formText, formDocx, type FormRowId, type FormDocxHeader } from "@/lib/shiftForm";
import { letterheadDocument, type Letterhead } from "@/lib/letterhead";
import type { MeetingKind } from "@/lib/meetingPlan";

export const offKey = (meeting: MeetingKind) => `shiftReport.copyOff.${meeting}`;
export const onKey = (meeting: MeetingKind) => `shiftReport.copyOn.${meeting}`;
const idOf = (s: ExportDoc["sections"][number]) => s.id ?? s.title;

const readList = (k: string): string[] => {
  try { const v = JSON.parse(localStorage.getItem(k) ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
};

/** The sections left out: the ones left out last time, except a flagged
 *  one (blocked work, things behind) and Where we stand, which always go;
 *  and a section off by default (the safety focus) unless it was ticked. */
export function sectionsOff(d: ExportDoc, meeting: MeetingKind): Set<string> {
  const flagged = new Set(d.sections.filter((x) => x.flag || x.id === "stand").map(idOf));
  const on = readList(onKey(meeting));
  const quiet = d.sections.filter((x) => x.offByDefault && !on.includes(idOf(x))).map(idOf);
  return new Set([...readList(offKey(meeting)).filter((id) => !flagged.has(id)), ...quiet]);
}

/** The update with only the sections that go out. */
export function updateToSend(d: ExportDoc, meeting: MeetingKind, off = sectionsOff(d, meeting)): ExportDoc {
  return { ...d, sections: d.sections.filter((s) => !off.has(idOf(s))) };
}

/** "Transmix-1 - Shift turnover - Night shift Fri, Oct 30 …" */
export const updateSubject = (d: ExportDoc) => `${d.project} - ${d.kind} - ${d.when.split(" → ").pop()}`;

/** The page to print: the safety topics on a page of their own at the
 *  end, on the letterhead when there is one. */
export function updatePrintDocument(picked: ExportDoc, lh: Letterhead | null): string {
  const subject = updateSubject(picked);
  const body = toEmailHtml({ ...picked, sections: [...picked.sections.filter((s) => s.id !== "safety"), ...picked.sections.filter((s) => s.id === "safety")] });
  // On paper the update fills the page (the email keeps its 820px for a
  // mail app); on screen, the print window centers it.
  const ownPage = `table[data-sec="safety"]{break-before:page}@media print{table{max-width:none!important}}`;
  return lh ? letterheadDocument(lh, subject, body, ownPage)
    : `<!doctype html><html><head><meta charset="utf-8"><title>${subject.replace(/</g, "&lt;")}</title><style>@page{margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${ownPage}@media screen{body>div{max-width:820px;margin:0 auto;padding:16px}}</style></head><body>${body}</body></html>`;
}

/** Copy as an email body: tables and colors kept (Outlook, Gmail…), plain
 *  text beside it. */
export async function copyRich(html: string, text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
      return true;
    }
  } catch { /* fall through */ }
  const el = document.createElement("div");
  el.innerHTML = html;
  el.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.appendChild(el);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges(); sel?.addRange(range);
  const ok = document.execCommand("copy");
  sel?.removeAllRanges(); el.remove();
  return ok;
}

/** Copy the update for an email, in the format chosen. */
export const copyUpdateForEmail = (picked: ExportDoc) => { const p = sendParts(picked); return copyRich(p.html, p.text); };

/** Print a page: written into a window opened at the tap (so the browser
 *  doesn't take it for a pop-up). False: the window was blocked. */
export function printHtml(html: string, w: Window | null = typeof window !== "undefined" ? window.open("", "_blank") : null): boolean {
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
}

// ─── The required format (lib/shiftForm) ─────────────────────────────
// The turnover goes out as the plant's table, with the header pieces
// picked above it - or as the detailed update. The choice, the header
// pieces and the rows left out are remembered on this device, and Copy
// for email, Print and the Word file all follow them.

export type SendFormat = "form" | "detail";
export const FORMAT_KEY = "shiftReport.format";
export const HEADER_OFF_KEY = "shiftReport.headerOff";
export const FORM_OFF_KEY = "shiftReport.formOff";

export const readFormat = (): SendFormat => { try { return localStorage.getItem(FORMAT_KEY) === "detail" ? "detail" : "form"; } catch { return "form"; } };
export const readHeaderOff = () => new Set(readList(HEADER_OFF_KEY) as HeaderPart[]);
export const readFormOff = () => new Set(readList(FORM_OFF_KEY) as FormRowId[]);
export const saveList = (k: string, v: Iterable<string>) => { try { localStorage.setItem(k, JSON.stringify([...v])); } catch { /* private mode */ } };

/** What goes out: the email body and its text. The required format when
 *  the update has it and it's chosen; else the detailed update. */
export function sendParts(d: ExportDoc, o: { format?: SendFormat; headerOff?: ReadonlySet<HeaderPart>; formOff?: ReadonlySet<FormRowId> } = {}): { html: string; text: string; form: boolean } {
  const format = o.format ?? readFormat();
  if (!d.form || format === "detail") return { html: toEmailHtml(d), text: toPlainText(d), form: false };
  const hOff = o.headerOff ?? readHeaderOff(), fOff = o.formOff ?? readFormOff();
  const h = formHead(d), shown = { project: !hOff.has("project"), when: !hOff.has("when") };
  const head = headerHtml(h, hOff), headT = headerText(h, hOff);
  return { html: head + formHtml(d.form, fOff, shown), text: [headT, formText(d.form, fOff, shown)].filter(Boolean).join("\n\n"), form: true };
}

/** The header over the shift table says the shift's date once ("Thursday,
 *  November 5, 2026 · Day shift 6:00 AM – 6:00 PM", as of the time), not
 *  the turnover's "Day shift … → Night shift …". */
const formHead = (d: ExportDoc): ExportDoc => (d.form ? { ...d, when: d.form.dateLine, asOf: d.form.asOf ?? d.asOf } : d);

/** The header pieces for the Word file. */
export function docxHeader(full: ExportDoc, off: ReadonlySet<HeaderPart>): FormDocxHeader {
  const d = formHead(full);
  const stand = d.sections.find((s) => s.id === "stand");
  const ov = stand?.blocks.find((b): b is Extract<ExportBlock, { k: "overview" }> => b.k === "overview");
  return {
    ...(off.has("kind") ? {} : { kind: d.kind }),
    ...(off.has("project") ? {} : { project: d.project }),
    ...(off.has("when") ? {} : { when: d.when }),
    ...(off.has("asof") ? {} : { asOf: d.asOf }),
    ...(d.status && !off.has("status") ? { status: d.status } : {}),
    ...(stand && !off.has("standLine") ? { standLine: stand.sub ?? "" } : {}),
    tiles: (ov?.stats ?? []).filter((x) => { const p = tilePart(x.label); return !p || !off.has(p); }),
    ...(ov?.bars && !off.has("bars") ? { bars: ov.bars } : {}),
  };
}

/** The Word file's name: "LRU Turnaround - Shift update November 5 2026 day.docx". */
export function updateFileName(d: ExportDoc): string {
  const date = d.form?.when.match(/^[A-Za-z]+ \d{1,2}, \d{4}/)?.[0] ?? "";
  const kind = /night/i.test(d.when.split(" → ")[0]) ? "night" : "day";
  return `${d.project} - Shift update ${date} ${kind}.docx`;
}

/** The update as a Word file, in the required format. */
export async function updateDocx(d: ExportDoc, o: { headerOff?: ReadonlySet<HeaderPart>; formOff?: ReadonlySet<FormRowId> } = {}): Promise<Uint8Array> {
  if (!d.form) throw new Error("This update has no shift table to export.");
  return formDocx(d.form, o.formOff ?? readFormOff(), docxHeader(d, o.headerOff ?? readHeaderOff()));
}

/** Save bytes as a file. */
export function saveFile(bytes: Uint8Array, name: string, type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  // Plain letters only: some browsers drop a name with dashes or brackets
  // in it and save the file as "download".
  const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".docx");
  const base = name.slice(0, name.length - ext.length).replace(/[–—]/g, "-").replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  a.href = url; a.download = `${base || "update"}${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The page to print, in the format chosen (on the letterhead when there is one). */
export function sendPrintDocument(d: ExportDoc, lh: Letterhead | null, o: { format?: SendFormat; headerOff?: ReadonlySet<HeaderPart>; formOff?: ReadonlySet<FormRowId> } = {}): string {
  const parts = sendParts(d, o);
  if (!parts.form) return updatePrintDocument(d, lh);
  const subject = updateSubject(d);
  const css = "@media print{table{max-width:none!important}}";
  return lh ? letterheadDocument(lh, subject, parts.html, css)
    : `<!doctype html><html><head><meta charset="utf-8"><title>${subject.replace(/</g, "&lt;")}</title><style>@page{margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${css}@media screen{body>div,body>table{max-width:820px;margin:0 auto}body{padding:16px}}</style></head><body>${parts.html}</body></html>`;
}
