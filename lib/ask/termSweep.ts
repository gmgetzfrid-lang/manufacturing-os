// lib/ask/termSweep.ts — every place a library uses the asker's own words.
//
// Ranked search hands the answer the dozen passages that score best for the
// question. In a library of a thousand cross-referencing standards that is a
// sample, and the sentence that settles the question — "valves for use in
// sour gas (Wet H2S) service…" in a control-valve practice, a class whose
// service line reads "Sour Service (200 BHN MAX)" on page 812 of a spec
// book — loses the ranking to pages that merely repeat the words more.
//
// The sweep doesn't rank. For each of the asker's own terms it finds EVERY
// passage in every reachable document that uses the term, then reads them
// for the sentences that matter: where the term is tied to another term
// ("sour gas (Wet H2S)"), where it is defined, and — in a book of sections
// a person marked as a catalog — which sections' own text uses it. The
// answer gets the whole map, and the passages that carry ties are attached
// so they can be cited.
//
// Pure helpers first; the database sweep below them.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { leadsFor } from "@/lib/searchLeads";
import { inSlices } from "@/lib/inSlices";

// Words that carry no subject of their own in a question about standards.
const STOP = new Set((
  "a an the and or of to in on for at by with from into about over under as is are was were be been being it its this that these those " +
  "what which who whom whose when where why how can could should would will shall may might must do does did done i we you they my our your " +
  "im i'm ive i've id i'd dont don't cant can't wont won't its it's thats that's theres there's whats what's " +
  "need needs needed use used using uses get give find show tell me us there here any all some each every per than then so if not no yes " +
  "spec specs specification specifications piping pipe pipes class classes rating rated line lines stream streams service services system " +
  "required requirement requirements require allowed allow ok okay right best good new existing type types kind size sizes number " +
  "lb lbs pound pounds psi psig asme ansi cl want trying going put install installing installed " +
  "connect connects connected connecting attach attaches attached attaching goes go going work working works " +
  "able okay sure thing things stuff part parts piece place"
).split(/\s+/));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A sweep term is a phrase ("sour gas") or words that must appear
 *  TOGETHER, written "class 300 + nozzle" — where a question's subjects
 *  meet in one sentence is where its answer usually is. */
export const partsOf = (term: string) => term.split(" + ").map((p) => p.trim()).filter(Boolean);

/** The asker's own terms worth sweeping, most telling first: the query
 *  writer's quoted terms; where a second pressure class meets each subject
 *  word ("class 300 + nozzle" for a Class 300 part in a Class 150 line);
 *  the question's phrases; its single subject words. At most `max`. */
export function sweepTerms(question: string, quoted: string[] = [], max = 6, classes: string[] = [], lineClass: string | null = null): string[] {
  const out: string[] = [];
  const clean = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ./+-]/g, " ").replace(/\s+/g, " ").trim();
  const push = (t: string) => {
    const v = clean(t);
    if (v.length < 3 || !/[a-z]/.test(v) || out.includes(v)) return;
    if (v.split(/\s+\+?\s*/).every((w) => STOP.has(w) || w === "+")) return;
    out.push(v);
  };
  for (const q of quoted) push(q);
  // Runs of subject words, with numbers and class notation taken out.
  const words = question.toLowerCase().replace(/[’']/g, "").replace(/#\s*\d+|\d+\s*#/g, " ").split(/[^a-z0-9/-]+/).filter(Boolean);
  const runs: string[][] = [];
  let run: string[] = [];
  for (const w of words) {
    if (STOP.has(w) || /^\d+$/.test(w)) { if (run.length) runs.push(run); run = []; continue; }
    run.push(w);
  }
  if (run.length) runs.push(run);
  const singles = [...new Set(runs.flat().filter((w) => w.length >= 4 || /\d/.test(w)))];
  // A part rated differently from its line: that rating with each subject.
  const others = classes.filter((c) => c !== lineClass);
  // The asker's words first, then the words the documents more likely use
  // for the same thing ("vessel" → "equipment", "nozzle").
  const leads = leadsFor(singles);
  for (const c of others) for (const w of [...singles].reverse()) push(`class ${c} + ${w}`);
  for (const c of others) for (const w of leads) push(`class ${c} + ${w}`);
  for (const r of runs) for (let i = 0; i + 1 < r.length; i++) push(`${r[i]} ${r[i + 1]}`);
  for (const w of singles) push(w);
  return out.slice(0, max);
}

/** A regex for one part of a term: whole words, plurals and -ed/-ing
 *  forms allowed; a pressure class in any of its notations. */
export function partRegex(part: string): RegExp {
  const cls = part.match(/^class (\d{3,4})$/);
  if (cls) {
    const n = cls[1];
    return new RegExp(`(?:class|cl\\.?|ansi|asme|rating)\\s*#?\\s*${n}(?![0-9])|(?<![0-9.])${n}\\s*(?:#|lbs?\\b|pound|class\\b)|#\\s*${n}(?![0-9])`, "i");
  }
  return new RegExp(`(^|[^a-z0-9])${esc(part)}(?:s|es|ed|ing|ion|ions)?(?![a-z0-9])`, "i");
}

/** The sentences of a passage that use a term — every part of it, in the
 *  same sentence. A long table row is cut around the first match. */
export function sentencesWith(content: string, term: string): string[] {
  const res = partsOf(term).map(partRegex);
  return content.replace(/\s+/g, " ").split(/(?<=[.;!?])\s+(?=[A-Z0-9(])/)
    .map((x) => x.trim()).filter((x) => x && res.every((re) => re.test(x)))
    // A contents line ("7.0 LINE CLASS SELECTION ........ 4") points at the
    // passage; it isn't the passage.
    .filter((x) => !/\.{6,}|…{3,}/.test(x))
    .map((x) => {
      if (x.length <= 320) return x;
      const at = Math.max(0, (x.search(res[res.length - 1]) ?? 0) - 150);
      return (at > 0 ? "…" : "") + x.slice(at, at + 320) + (at + 320 < x.length ? "…" : "");
    });
}

/** Does this sentence tie the term to another term? Returns what it ties it
 *  to: a related term in the same sentence, or the words in a parenthesis
 *  right after it ("sour gas (Wet H2S)"), or a definition ("X means …"). */
export function tieIn(sentence: string, term: string, leads: string[]): { kind: "paren" | "defines" | "together" | "related"; to: string } | null {
  const s = sentence;
  // Words searched together: the sentence holding all of them is the find.
  if (partsOf(term).length > 1) return { kind: "together", to: partsOf(term).slice(1).join(", ") };
  const paren = s.match(new RegExp(`${esc(term)}\\s*\\(([^)]{2,40})\\)`, "i"));
  if (paren && !/^\s*\d+\s*$/.test(paren[1])) return { kind: "paren", to: paren[1].trim() };
  if (new RegExp(`${esc(term)}\\W{0,3}(\\s+(means|is defined as|refers to|shall mean|includes)\\b|\\s*[-–—:]\\s+[A-Z])`, "i").test(s)) {
    return { kind: "defines", to: "its definition" };
  }
  const lower = s.toLowerCase();
  const hit = leads.find((l) => new RegExp(`(^|[^a-z0-9])${esc(l)}([^a-z0-9]|$)`).test(lower));
  return hit ? { kind: "related", to: hit } : null;
}

export interface SweepChunk {
  id: string; document_id: string; library_id: string; page: number; section: string | null; content: string;
}
export interface SweepHit {
  chunk: SweepChunk;
  sentence: string;
  tie: { kind: "paren" | "defines" | "together" | "related"; to: string } | null;
}
export interface SweepSection {
  key: string; page: number;
  /** The section's recorded rating (from the class-by-class read). */
  rating: string | null;
  /** Pressure classes written on the page, most frequent first — when no
   *  rating is recorded, what the page itself says. */
  seen: Array<[string, number]>;
  line: string; chunk: SweepChunk;
}

const RATING_CLASSES = ["150", "300", "400", "600", "900", "1500", "2500"];
/** How often each pressure class is written in a text, in any notation. */
export function ratingsSeen(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const n of RATING_CLASSES) {
    const re = new RegExp(partRegex(`class ${n}`).source, "gi");
    const k = (text.match(re) ?? []).length;
    if (k > 0) out.push([n, k]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}
export interface TermSweep {
  term: string;
  docCount: number;
  passageCount: number;
  /** Used in more than half the library — listed by count only. */
  tooCommon: boolean;
  /** Per document, most hits first: its best sentences. */
  docs: Array<{ documentId: string; hits: number; best: SweepHit[] }>;
  /** Sections of a sectioned book (a marked catalog's entries) whose own text uses the term. */
  sections: Array<{ documentId: string; items: SweepSection[] }>;
}

/** Order a document's hits: ties first, then definitions, then the rest. */
const tieRank = (h: SweepHit) => (h.tie?.kind === "paren" ? 0 : h.tie?.kind === "defines" || h.tie?.kind === "together" ? 1 : h.tie ? 2 : 3);

/** Sections of a book a person marked as a catalog, already read entry by
 *  entry: each section's key and first page. */
async function mappedSections(admin: SupabaseClient, docId: string): Promise<Array<{ key: string; page: number }>> {
  const { rows } = await fetchAllRows<{ tag: string; page: number }>((from, to) => admin
    .from("knowledge_page_entities").select("tag, page")
    .eq("document_id", docId).eq("kind", "catalog_entry").order("page").range(from, to), 20_000);
  return rows.map((r) => ({ key: r.tag, page: r.page }));
}

/** The recorded rating of the named sections. */
async function sectionRatings(admin: SupabaseClient, docId: string, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await inSlices(keys, 100, 3, async (slice) => {
    const { data } = await admin.from("knowledge_page_entities").select("tag, raw")
      .eq("document_id", docId).eq("kind", "catalog_entry").in("tag", slice);
    for (const r of (data ?? []) as Array<{ tag: string; raw: string | null }>) {
      try {
        const rating = (JSON.parse(r.raw ?? "{}") as { rating?: unknown }).rating;
        if (typeof rating === "string" && rating.trim()) out.set(r.tag, rating.trim());
      } catch { /* a bad record has no rating */ }
    }
  });
  return out;
}

/** A section code at the start of a line ("AAAC2H - Hydrocarbon…"). */
const codeOf = (line: string) => line.match(/\b([A-Z0-9][A-Z0-9.-]{2,11})\s*[-–—:]\s/)?.[1] ?? null;

/** The database search for a term: a phrase, or its parts all together
 *  (a pressure class by its number — the sentence check pins the notation). */
const searchOf = (term: string) => {
  const parts = partsOf(term);
  if (parts.length === 1) return term;
  return parts.map((p) => p.match(/^class (\d{3,4})$/)?.[1] ?? `"${p}"`).join(" ");
};

/** A book of sections (a spec database, a data-sheet book) — by its size,
 *  or by how densely it uses the term — is listed section by section, so a
 *  class that uses the word once on page 812 is still on the list. */
const BOOK_HITS = 30;
const BOOK_PAGES = 150;

/** Sweep the libraries for each term. Every query is ids-only first; text is
 *  read only for the passages that will be looked at. */
export async function sweepLibrary(admin: SupabaseClient, opts: {
  orgId: string; libraryIds: string[]; terms: string[];
  /** Documents the asker may read (retired and AI-excluded already removed). */
  allowedDocIds: Set<string>;
  /** Page counts, to recognise book-sized documents. */
  pageCounts?: Map<string, number>;
  deadlineMs: number;
}): Promise<TermSweep[]> {
  const isBook = (docId: string, hits: number) => hits >= BOOK_HITS || (opts.pageCounts?.get(docId) ?? 0) >= BOOK_PAGES;
  const out: TermSweep[] = [];
  const sectionCache = new Map<string, Array<{ key: string; page: number }>>();
  for (const term of opts.terms) {
    if (Date.now() > opts.deadlineMs) break;
    type Row = { id: string; document_id: string; page: number };
    const { rows } = await fetchAllRows<Row>((from, to) => admin
      .from("knowledge_chunks").select("id, document_id, page")
      .eq("org_id", opts.orgId).in("library_id", opts.libraryIds)
      .textSearch("tsv", searchOf(term), { type: partsOf(term).length > 1 ? "websearch" : "phrase", config: "english" })
      .order("id").range(from, to), 6000);
    const hits = rows.filter((r) => opts.allowedDocIds.has(r.document_id));
    const byDoc = new Map<string, Row[]>();
    for (const r of hits) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r]);
    const sweep: TermSweep = {
      term, docCount: byDoc.size, passageCount: hits.length,
      // In a third of the library or more, a word names nothing in particular.
      tooCommon: byDoc.size > Math.max(40, opts.allowedDocIds.size * 0.3),
      docs: [], sections: [],
    };
    out.push(sweep);
    if (hits.length === 0 || sweep.tooCommon) continue;

    // Books get their mapped sections; everything else is a document.
    for (const [docId, list] of byDoc) {
      if (isBook(docId, list.length) && !sectionCache.has(docId)) sectionCache.set(docId, await mappedSections(admin, docId));
    }
    // Which passages to read: an ordinary document, up to 12 spread across
    // it; a book, one per section (or per page when it isn't mapped).
    const toRead: Row[] = [];
    for (const [docId, list] of byDoc) {
      const sorted = [...list].sort((a, b) => a.page - b.page);
      if (isBook(docId, list.length)) {
        const sections = sectionCache.get(docId) ?? [];
        const seen = new Set<string>();
        for (const r of sorted) {
          const key = sectionAt(sections, r.page)?.key ?? `p${r.page}`;
          if (seen.has(key) || seen.size >= 120) continue;
          seen.add(key);
          toRead.push(r);
        }
      } else {
        const step = Math.max(1, Math.floor(sorted.length / 12));
        for (let i = 0; i < sorted.length; i += step) toRead.push(sorted[i]);
      }
    }
    const read = new Map<string, SweepChunk>();
    await inSlices(toRead.slice(0, 600).map((r) => r.id), 100, 4, async (ids) => {
      const { data } = await admin.from("knowledge_chunks")
        .select("id, document_id, library_id, page, section, content").in("id", ids);
      for (const c of (data ?? []) as SweepChunk[]) read.set(c.id, c);
    });

    const leads = leadsFor(term.split(" "));
    const combo = partsOf(term).length > 1;
    for (const [docId, list] of byDoc) {
      const chunks = list.map((r) => read.get(r.id)).filter((c): c is SweepChunk => !!c).sort((a, b) => a.page - b.page);
      if (isBook(docId, list.length)) {
        const sections = sectionCache.get(docId) ?? [];
        const items: SweepSection[] = [];
        const seen = new Set<string>();
        for (const c of chunks) {
          const line = sentencesWith(c.content, term)[0] ?? "";
          // Words searched together must meet in one sentence, not just a page.
          if (!line && combo) continue;
          const key = sectionAt(sections, c.page)?.key ?? codeOf(line) ?? `p${c.page}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ key, page: c.page, rating: null, seen: ratingsSeen(c.content), line, chunk: c });
        }
        if (sections.length > 0) {
          const ratings = await sectionRatings(admin, docId, items.map((i) => i.key));
          for (const it of items) it.rating = ratings.get(it.key) ?? null;
        }
        sweep.sections.push({ documentId: docId, items });
        continue;
      }
      const best: SweepHit[] = [];
      for (const c of chunks) {
        for (const sentence of sentencesWith(c.content, term).slice(0, 2)) {
          best.push({ chunk: c, sentence, tie: tieIn(sentence, term, leads) });
        }
      }
      best.sort((a, b) => tieRank(a) - tieRank(b) || a.chunk.page - b.chunk.page);
      if (combo && best.length === 0) continue;
      sweep.docs.push({ documentId: docId, hits: list.length, best: best.slice(0, 3) });
    }
    if (combo) {
      sweep.sections = sweep.sections.filter((g) => g.items.length > 0);
      sweep.docCount = sweep.docs.length + sweep.sections.length;
    }
    // Documents with a tie first, then by how much they use the term.
    sweep.docs.sort((a, b) => (a.best[0] ? tieRank(a.best[0]) : 9) - (b.best[0] ? tieRank(b.best[0]) : 9) || b.hits - a.hits);
  }
  return out;
}

/** The section a page belongs to: the last one starting at or before it. */
export function sectionAt<T extends { page: number }>(sections: T[], page: number): T | null {
  let best: T | null = null;
  for (const s of sections) if (s.page <= page && (!best || s.page > best.page)) best = s;
  return best;
}

/** The passages worth attaching: every tie, definition and words-together
 *  find, then sections whose rating fits (the line's first), then each
 *  document's best sentence. `ratings` lists the line's class first. */
export function sweepPassages(sweeps: TermSweep[], ratings: string[], max = 12): SweepChunk[] {
  const picked: SweepChunk[] = [];
  const add = (c: SweepChunk) => { if (picked.length < max && !picked.some((p) => p.id === c.id)) picked.push(c); };
  for (const s of sweeps) for (const d of s.docs) for (const h of d.best) if (h.tie && h.tie.kind !== "related") add(h.chunk);
  for (const s of sweeps) for (const g of s.sections) {
    const combo = partsOf(s.term).length > 1;
    const items = orderByFit(g.items, ratings).filter((i) => combo || fits(i, ratings) || mayFit(i, ratings) || ratings.length === 0);
    for (const it of items.slice(0, 5)) add(it.chunk);
  }
  for (const s of sweeps) for (const d of s.docs) for (const h of d.best) if (h.tie) add(h.chunk);
  for (const s of sweeps) for (const d of s.docs.slice(0, 6)) if (d.best[0]) add(d.best[0].chunk);
  return picked;
}

export const sameRating = (recorded: string, asked: string) => new RegExp(`(^|[^0-9])${asked}([^0-9]|$)`).test(recorded);
const fits = (i: SweepSection, ratings: string[]) => !!i.rating && ratings.some((r) => sameRating(i.rating!, r));
/** No recorded rating, but the page writes one of the asked classes. */
const mayFit = (i: SweepSection, ratings: string[]) => !i.rating && i.seen.some(([n]) => ratings.includes(n));
/** Sections recorded with the line's rating first, then other asked
 *  ratings, then unrecorded, then the rest. */
function orderByFit(items: SweepSection[], ratings: string[]): SweepSection[] {
  const rank = (i: SweepSection) => {
    if (!i.rating) {
      const k = i.seen.length ? ratings.indexOf(i.seen[0][0]) : -1;
      return k >= 0 ? ratings.length + k : mayFit(i, ratings) ? 2 * ratings.length : 2 * ratings.length + 1;
    }
    const k = ratings.findIndex((r) => sameRating(i.rating!, r));
    return k >= 0 ? k : 2 * ratings.length + 2;
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** How a term reads to the answer: "sour gas", or "Class 300" with "nozzle". */
const shown = (term: string) => partsOf(term).map((p) => `"${p.replace(/^class (\d+)$/, "Class $1")}"`).join(" with ");

/** The sweep as the answer reads it. `n` gives a passage's [n] if attached.
 *  `ratings` lists the classes the question names, the line's first. */
export function sweepBlock(sweeps: TermSweep[], docName: (id: string) => string, n: (chunkId: string) => number | null,
  totalDocs: number, ratings: string[]): string {
  if (sweeps.length === 0) return "";
  const short = (name: string) => name.replace(/\.pdf$/i, "");
  const cite = (id: string) => { const k = n(id); return k ? ` [${k}]` : " (not attached)"; };
  const lines: string[] = [
    `TERM SWEEP — every passage in these libraries that uses the asker's own words, found by searching all ${totalDocs} reachable documents (not a ranked sample). Words joined by "with" were searched TOGETHER — only sentences holding all of them count:`,
  ];
  for (const s of sweeps) {
    const label = shown(s.term);
    if (s.passageCount === 0 || s.docCount === 0) { lines.push(`${label}: ${partsOf(s.term).length > 1 ? "never together in one sentence" : "used nowhere"} in the libraries.`); continue; }
    if (s.tooCommon) { lines.push(`${label}: used in ${s.docCount} documents — too common to list.`); continue; }
    lines.push(`${label}: in ${s.docCount} document${s.docCount === 1 ? "" : "s"}.`);
    for (const d of s.docs.slice(0, 14)) {
      const h = d.best[0];
      if (!h) continue;
      const tie = !h.tie ? "" : h.tie.kind === "paren" ? `  ← writes "${s.term}" as "${h.tie.to}"`
        : h.tie.kind === "defines" ? "  ← defines it" : h.tie.kind === "together" ? "" : `  ← same sentence as "${h.tie.to}"`;
      lines.push(`  - ${short(docName(d.documentId))} p.${h.chunk.page}${h.chunk.section ? ` (${h.chunk.section.slice(0, 50)})` : ""}${cite(h.chunk.id)}: "${h.sentence}"${tie}`);
    }
    if (s.docs.length > 14) lines.push(`  - …and ${s.docs.length - 14} more documents.`);
    for (const g of s.sections) {
      const fit = g.items.filter((i) => fits(i, ratings));
      const unknown = g.items.filter((i) => !i.rating);
      lines.push(`  Sections of ${short(docName(g.documentId))} whose own text has ${label}: ${g.items.length}` +
        (ratings.length ? ` — ${fit.length} recorded as Class ${ratings.join("/")}${unknown.length ? `, ${unknown.length} with no rating recorded` : ""}` : "") + ":");
      const list = orderByFit(g.items, ratings).slice(0, 16);
      for (const it of list) {
        const onPage = it.seen.length ? ` · page shows ${it.seen.slice(0, 3).map(([n, k]) => `Class ${n} ×${k}`).join(", ")}` : "";
        lines.push(`    - ${it.key} p.${it.page}${it.rating ? ` · rating ${it.rating}` : ` · no rating recorded${onPage}`}${cite(it.chunk.id)}: "${it.line}"`);
      }
      if (g.items.length > list.length) lines.push(`    - …and ${g.items.length - list.length} more sections.`);
    }
  }
  lines.push(
    "READ THIS BEFORE ANSWERING: it is the complete list, not a sample. Before writing that the library doesn't use a term, " +
    "doesn't tie two terms together, or has no class, row or rule for the case asked, check it. A sentence here that ties the " +
    "asker's term to another (\"sour gas (Wet H2S) service\") IS textual basis — cite it and say whose words they are and what " +
    "they govern. In a spec book, a section's numbered NOTES say when one of its rows applies (\"use against … Class 300 " +
    "flanged equipment nozzles\"): such a note is the rule — quote it with the section it belongs to. A section whose " +
    "rating fits is a candidate answer: name it. A passage marked (not attached) can be named but not quoted.",
  );
  return "\n\n" + lines.join("\n");
}
