// lib/catalogBooks.ts — reading a catalog a person marked, whatever it holds.
//
// A person marks what their catalog is ("Piping specs", "Valve data
// sheets", "Coating systems") — nothing here guesses which documents those
// are, or what they're about. A catalog comes in one of two shapes:
//
//   A BOOK  — one document of many sections, each keyed by a code that
//             repeats on its pages (a running header, or "Heading (CODE)").
//             The sections are found by lib/sectionTemplate.ts.
//   A SET   — a library whose documents are each one entry.
//
// Either way each section or document becomes one entry: its code, the line
// that says what it's for, and its printed "Label: value" fields — the
// labels learned from the catalog itself. What the entries MEAN is for the
// library's own text and the workspace's skills to say. Pure functions; the
// server stores the entries.

import { labelCounts, openingFields } from "@/lib/specSelect";
import { classMentions } from "@/lib/pressureClass";

export interface EntryRecord {
  code: string;
  /** What the entry is for: its "Service"/"Scope"-style field, or its opening line. */
  service?: string;
  rating?: string;
  /** Every other labelled field printed on its opening page. */
  attrs?: Record<string, string>;
  notes?: string[];
  /** The name the person gave the catalog. */
  catalog?: string;
}

const PURPOSE_LABEL = /^(services?( description)?|scope|application|use|used for|description)$/i;
const RATING_LABEL = /rating|pressure class|flange class/i;
const HEADING_IN_VALUE = /\s(?=[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)? \([A-Z0-9][A-Z0-9.-]{2,11}\))/;

/** One entry from its opening page, its first block (where the opening
 *  line is), the text of all its pages, and the catalog's label counts. */
export function entryRecord(o: {
  code: string; opening: string; firstBlock?: string; allText: string; counts: Map<string, number>;
  keep?: (label: string) => boolean; pages?: [number, number]; catalog?: string;
}): EntryRecord {
  const firstLine = (o.firstBlock ?? o.opening).replace(/\s+/g, " ").trim()
    .split(new RegExp(`${HEADING_IN_VALUE.source}|(?<=[.;])\\s`))[0].slice(0, 240);
  // A value ends where the first table begins ("… Pipe (AAAC2H) Compcode …").
  const cut = (v: string) => v.split(HEADING_IN_VALUE)[0].trim();
  const fields = Object.fromEntries(Object.entries(openingFields(o.opening, o.counts))
    .filter(([k]) => !o.keep || o.keep(k))
    .map(([k, v]) => [k, cut(v)] as const).filter(([, v]) => v));
  const pick = (re: RegExp) => Object.entries(fields).find(([k]) => re.test(k))?.[1];
  const service = pick(PURPOSE_LABEL) ?? firstLine.replace(/^services?\s*:\s*/i, "");
  const printedRating = pick(RATING_LABEL);
  const mentions = classMentions(o.allText);
  const attrs = Object.fromEntries(Object.entries(fields).filter(([k]) => !PURPOSE_LABEL.test(k)).slice(0, 10));
  return {
    code: o.code,
    ...(service ? { service: service.slice(0, 240) } : {}),
    ...(printedRating ? { rating: printedRating.slice(0, 40) } : mentions[0] ? { rating: `Class ${mentions[0][0]}` } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    notes: [
      ...(o.pages ? [`Pages ${o.pages[0]}–${o.pages[1]}`] : []),
      ...(mentions.length ? [`Classes written on its pages: ${mentions.slice(0, 4).map(([n, k]) => `${n} ×${k}`).join(", ")}`] : []),
    ],
    ...(o.catalog ? { catalog: o.catalog } : {}),
  };
}

/** One entry per section of a book. */
export function sectionRecords(ranges: Array<{ key: string; first: number; last: number }>, byPage: Map<number, string[]>, catalog?: string) {
  const seen = new Set<string>();
  const out: Array<{ code: string; page: number; record: EntryRecord }> = [];
  // Field labels are learned from the whole book: the wording that repeats
  // on every section's opening page.
  const counts = labelCounts(ranges.map((r) => (byPage.get(r.first) ?? []).join(" ")));
  for (const r of ranges) {
    const code = r.key.toUpperCase().slice(0, 30);
    if (seen.has(`${code}:${r.first}`)) continue;
    seen.add(`${code}:${r.first}`);
    let allText = "";
    for (let p = r.first; p <= r.last; p++) allText += " " + (byPage.get(p) ?? []).join(" ");
    const parts = byPage.get(r.first) ?? [];
    out.push({ code, page: r.first, record: entryRecord({ code, opening: parts.join(" "), firstBlock: parts[0] ?? "", allText, counts, pages: [r.first, r.last], catalog }) });
  }
  return out;
}

// ── Sets: a library whose documents are each one entry ──────────────────────

/** Labels every controlled document prints — they say nothing about the
 *  entry, so they aren't recorded as its fields. */
const DOCUMENT_LABELS = /^(rev(ision)?( no\.?| number)?|date|dated|date issued|approved( by)?|prepared( by)?|checked( by)?|reviewed( by)?|originator|page|sheet|issued?( date)?|effective( date)?|supersedes|author|owner|title|subject|doc(ument)?( no\.?| number)?|number|no\.?|references?|notes?|table|figure|attachment|appendix|section)$/i;

export interface SetDoc { id: string; name: string; text: string }

/** A set member's code: the designation in its name, or its name. */
export function codeFromName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, "").trim();
  const tok = base.split(/[\s_]+/).find((t) => /\d/.test(t) && /^[A-Za-z0-9][A-Za-z0-9./-]{1,20}$/.test(t));
  return (tok ?? base).toUpperCase().slice(0, 30);
}

/** One entry per document of a set. Its fields are the labels printed on
 *  at least `share` of the documents' first pages. */
export function setRecords(docs: SetDoc[], catalog?: string, share = 0.3): { fields: string[]; entries: Array<{ documentId: string; code: string; record: EntryRecord }> } {
  const counts = labelCounts(docs.map((d) => d.text));
  const min = Math.max(2, Math.ceil(share * docs.length));
  const keep = (label: string) => (counts.get(label) ?? 0) >= min && !DOCUMENT_LABELS.test(label);
  const entries = docs.map((d) => {
    const code = codeFromName(d.name);
    return { documentId: d.id, code, record: entryRecord({ code, opening: d.text, allText: d.text, counts, keep, catalog }) };
  });
  const fields = [...new Set(entries.flatMap((e) => Object.keys(e.record.attrs ?? {})))];
  return { fields, entries };
}
