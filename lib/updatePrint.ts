// updatePrint - the shift turnover, kick-off or close-out as it goes out:
// the sections chosen in the Email / Print box (remembered on this device),
// as an email body or a printed page (on the letterhead when the project
// has one). Today's Email / Print and Reports print the same thing.

import { toEmailHtml, toPlainText, type ExportDoc } from "@/lib/reportExport";
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
  const ownPage = `table[data-sec="safety"]{break-before:page}`;
  return lh ? letterheadDocument(lh, subject, body, ownPage)
    : `<!doctype html><html><head><meta charset="utf-8"><title>${subject.replace(/</g, "&lt;")}</title><style>@page{margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${ownPage}</style></head><body>${body}</body></html>`;
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

/** Copy the update for an email. */
export const copyUpdateForEmail = (picked: ExportDoc) => copyRich(toEmailHtml(picked), toPlainText(picked));

/** Print a page: written into a window opened at the tap (so the browser
 *  doesn't take it for a pop-up). False: the window was blocked. */
export function printHtml(html: string, w: Window | null = typeof window !== "undefined" ? window.open("", "_blank") : null): boolean {
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
}
