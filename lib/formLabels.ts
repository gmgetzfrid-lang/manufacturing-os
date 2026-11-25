// lib/formLabels.ts - reading a blank sheet's labels ("WO No.:",
// "Equipment:", "Date:") from the words printed on it, and where the app
// would write each value: on the label's blank line when it has one, else
// just after the label. Pure: the words come from pdf.js (the PDF's own
// text, so a sheet made in Word or Excel), positions in PDF points with
// the origin bottom-left. A scan has no words, so nothing is found, and
// the screen says so.

import type { FieldPlacement, TocCols } from "@/lib/packagePdf";

export type FillKey = FieldPlacement["key"];

/** What each fill writes, in words (the setup screen's choices). */
export const FILL_WORDS: Record<FillKey, string> = {
  wo: "Work order number",
  equipment: "Equipment tag and name",
  description: "Job description",
  project: "Project",
  date: "Date printed",
  status: "Package status",
  workspace: "Company",
  by: "Printed by",
};
export const FILL_KEYS = Object.keys(FILL_WORDS) as FillKey[];

/** One run of text as pdf.js gives it: baseline at y, w wide, h tall. */
export interface TextBit { str: string; x: number; y: number; w: number; h: number }
export interface PageText { width: number; height: number; bits: TextBit[] }

export interface FoundLabel {
  page: number;
  /** The label as printed ("W/O No.:"). */
  text: string;
  key: FillKey;
  box: { x: number; y: number; w: number; h: number };
  /** Where the value goes. */
  at: { x: number; y: number; size: number; maxWidth: number };
  /** Filled unless the owner says otherwise: the first of its kind on the
   *  first page, written as a label (a colon or a blank line after it, not
   *  a table's column heading); a date only in the sheet's heading area. */
  on: boolean;
}

const NO = String.raw`(?:\s*(?:#|no\.?|nbr\.?|num\.?|number))?`;
const LABELS: Array<[FillKey, RegExp]> = ([
  ["wo", String.raw`w\.?\s*\/?\s*o\.?${NO}|work\s*order${NO}|job${NO}`],
  ["equipment", String.raw`equip(?:ment|\.)?(?:\s*(?:tag|id|name|item))?${NO}|tag${NO}|equipment\s*description`],
  ["description", String.raw`(?:job|work|task)?\s*description(?:\s*of\s*work)?|scope(?:\s*of\s*work)?|work\s*to\s*be\s*(?:done|performed)`],
  ["project", String.raw`project(?:\s*(?:name|title))?|turnaround(?:\s*name)?|outage(?:\s*name)?|t\s*\/\s*a|tar`],
  ["date", String.raw`date(?:\s*(?:issued|printed|of\s*issue))?|issue\s*date|issued\s*on`],
  ["status", String.raw`(?:package\s*)?status`],
  ["workspace", String.raw`company(?:\s*name)?|client|owner|facility|refinery`],
  ["by", String.raw`prepared\s*by|issued\s*by|planned\s*by|planner|originator`],
] as Array<[FillKey, string]>).map(([k, src]) => [k, new RegExp(`^(?:${src})\\s*[:：]?$`, "i")]);

const BLANK = /^[_.\s]{3,}$/;
const TRAILING_BLANK = /[\s:：]*([_.]{3,})\s*$/;

/** The fill a label asks for, or null. */
export function labelKey(text: string): FillKey | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length > 32) return null;
  for (const [k, re] of LABELS) if (re.test(t)) return k;
  return null;
}

/** The page's words in lines, top to bottom, each line left to right. */
function lines(bits: TextBit[]): TextBit[][] {
  const words = bits.filter((b) => b.str.trim() && Number.isFinite(b.x) && Number.isFinite(b.y)).sort((a, b) => b.y - a.y || a.x - b.x);
  const out: TextBit[][] = [];
  for (const b of words) {
    const line = out.find((l) => Math.abs(l[0].y - b.y) <= Math.max(2, 0.35 * Math.max(l[0].h, b.h, 1)));
    if (line) line.push(b); else out.push([b]);
  }
  for (const l of out) l.sort((a, b) => a.x - b.x);
  return out;
}

/** Every label on the sheet the app knows how to fill. */
export function findLabels(pages: PageText[]): FoundLabel[] {
  const found: FoundLabel[] = [];
  pages.forEach((pg, page) => {
    for (const line of lines(pg.bits)) {
      let i = 0;
      while (i < line.length) {
        let took = 0;
        // Longest first: "Work", "Order", "No.:" can come as three bits.
        for (let n = Math.min(4, line.length - i); n >= 1 && !took; n--) {
          const seq = line.slice(i, i + n);
          const h = Math.max(...seq.map((b) => b.h), 1);
          if (seq.some((b, j) => j > 0 && b.x - (seq[j - 1].x + seq[j - 1].w) > 1.5 * h)) continue;
          const raw = seq.map((b) => b.str).join(" ");
          // A blank line printed in the same run as the label ("WO#: ______").
          const tail = raw.match(TRAILING_BLANK);
          // Where the blank line starts in the joined text (the label keeps its colon).
          const u = tail ? raw.length - tail[0].length + tail[0].indexOf(tail[1]) : raw.length;
          const label = raw.slice(0, u).trim();
          const key = labelKey(label);
          if (!key) continue;
          const first = seq[0];
          const last = seq[seq.length - 1];
          let blankX: number | null = null;
          let used = n;
          if (tail) {
            // Where the underscores start, by share of the last bit's letters.
            const into = u - (raw.length - last.str.length);
            blankX = last.x + (last.w * Math.max(0, into)) / Math.max(1, last.str.length);
          } else if (line[i + n] && BLANK.test(line[i + n].str) && line[i + n].x - (last.x + last.w) <= 3 * h) {
            blankX = line[i + n].x;
            used = n + 1;
          }
          const labelEnd = tail ? blankX! : last.x + last.w;
          const x = Math.round((blankX ?? labelEnd + h * 0.4) + 2);
          // Room to the next words on the line (another label), else the margin.
          const next = line.slice(i + used).find((b) => !BLANK.test(b.str) && b.x > x);
          const right = next ? next.x - 6 : pg.width - 30;
          found.push({
            page, text: label, key,
            box: { x: first.x, y: first.y - h * 0.25, w: labelEnd - first.x, h: h * 1.25 },
            at: { x, y: Math.round(first.y + (blankX != null ? 2 : 0)), size: Math.round(Math.min(12, Math.max(8, h * 0.95))), maxWidth: Math.max(36, Math.round(right - x)) },
            on: false,
          });
          // Was it written as a label (a colon or a blank after it)?
          (found[found.length - 1] as FoundLabel & { asLabel?: boolean }).asLabel = /[:：]\s*$/.test(label) || blankX != null;
          took = used;
        }
        i += took || 1;
      }
    }
  });
  // On by default: the first of each kind, page 1, written as a label; a
  // date only up in the heading (not "Date" by an inspector's signature).
  const seen = new Set<FillKey>();
  for (const f of found) {
    const asLabel = (f as FoundLabel & { asLabel?: boolean }).asLabel;
    delete (f as FoundLabel & { asLabel?: boolean }).asLabel;
    const top = f.box.y > pages[f.page].height * 0.6;
    if (f.page === 0 && asLabel && !seen.has(f.key) && (f.key !== "date" || top)) { f.on = true; seen.add(f.key); }
  }
  return found;
}

/** The fills to save from what was found (the ones on). */
export function fillsFrom(found: FoundLabel[]): FieldPlacement[] {
  return found.filter((f) => f.on).map((f) => ({ key: f.key, page: f.page, x: f.at.x, y: f.at.y, size: f.at.size, maxWidth: f.at.maxWidth, label: f.text }));
}

/** A contents page's list area: under its column headings ("Description …
 *  Page") or under its title ("Table of Contents"). Null when neither is
 *  on it (the owner marks it). */
export function findListArea(pg: PageText): { x: number; y: number; w: number; h: number; cols?: TocCols } | null {
  const ls = lines(pg.bits);
  const words = (l: TextBit[]) => l.map((b) => b.str).join(" ").toLowerCase();
  const head = ls.find((l) => /\bpage\b|\bpg\.?\b/.test(words(l)) && /description|item|document|title|contents|section|tab\b|form/.test(words(l)));
  const title = ls.find((l) => /^\s*(table\s+of\s+)?contents\s*$|^\s*index\s*$|package\s+contents/.test(words(l)));
  const at = head ?? title;
  if (!at) return null;
  const h = Math.max(...at.map((b) => b.h), 1);
  const top = at[0].y - (head ? h * 0.6 : h * 1.4);
  const x = head ? Math.max(18, Math.min(...at.map((b) => b.x)) - 2) : 54;
  const right = pg.width - 36;
  const bottom = 54;
  if (top - bottom < 72 || right - x < 144) return null;
  const area = { x: Math.round(x), y: bottom, w: Math.round(right - x), h: Math.round(top - bottom) };
  if (!head) return area;
  // Its own column headings: the rows are written under them.
  const word = (re: RegExp) => head.find((b) => re.test(b.str.trim()));
  const pg2 = word(/^(page|pg\.?|page\s*no\.?)$/i);
  const desc = word(/description|title|document|form|section|contents/i);
  const num = word(/^(item|no\.?|#|tab|ref\.?|seq\.?)$/i);
  const kind = word(/^(kind|type)$/i);
  const cols: TocCols = {};
  if (desc) cols.item = Math.round(desc.x);
  if (num && (!desc || num.x < desc.x)) { if (desc) cols.no = Math.round(num.x); else cols.item = Math.round(num.x + 30); }
  if (kind) cols.kind = Math.round(kind.x);
  if (pg2) cols.pageR = Math.round(pg2.x + pg2.w);
  return { ...area, cols };
}
