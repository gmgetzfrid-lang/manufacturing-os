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
// like a piping-spec database — which sections' own text uses it. The
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
  "need needs needed use used using uses get give find show tell me us there here any all some each every per than then so if not no yes " +
  "spec specs specification specifications piping pipe pipes class classes rating rated line lines stream streams service services system " +
  "required requirement requirements require allowed allow ok okay right best good new existing type types kind size sizes number " +
  "lb lbs pound pounds psi psig asme ansi cl"
).split(/\s+/));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The asker's own terms worth sweeping: the query writer's quoted terms
 *  first, then the question's multi-word phrases, then its distinctive
 *  single words. At most `max`. */
export function sweepTerms(question: string, quoted: string[] = [], max = 4): string[] {
  const out: string[] = [];
  const push = (t: string) => {
    const v = t.toLowerCase().replace(/[^a-z0-9 ./-]/g, " ").replace(/\s+/g, " ").trim();
    if (v.length < 3 || !/[a-z]/.test(v) || out.includes(v)) return;
    if (v.split(" ").every((w) => STOP.has(w))) return;
    out.push(v);
  };
  for (const q of quoted) push(q);
  // Runs of subject words, with numbers and class notation taken out.
  const words = question.toLowerCase().replace(/#\s*\d+|\d+\s*#/g, " ").split(/[^a-z0-9/-]+/).filter(Boolean);
  const runs: string[][] = [];
  let run: string[] = [];
  for (const w of words) {
    if (STOP.has(w) || /^\d+$/.test(w)) { if (run.length) runs.push(run); run = []; continue; }
    run.push(w);
  }
  if (run.length) runs.push(run);
  for (const r of runs) for (let i = 0; i + 1 < r.length; i++) push(`${r[i]} ${r[i + 1]}`);
  for (const r of runs) for (const w of r) if (w.length >= 4 || /\d/.test(w)) push(w);
  return out.slice(0, max);
}

/** The sentences of a passage that use a term (whole words, any case). */
export function sentencesWith(content: string, term: string): string[] {
  const re = new RegExp(`(^|[^a-z0-9])${esc(term)}(?![a-z0-9])`, "i");
  return content.replace(/\s+/g, " ").split(/(?<=[.;:!?])\s+(?=[A-Z0-9(])|\s{2,}|\n/)
    .map((s) => s.trim()).filter((s) => s && re.test(s))
    .map((s) => (s.length > 320 ? s.slice(0, 320) + "…" : s));
}

/** Does this sentence tie the term to another term? Returns what it ties it
 *  to: a related term in the same sentence, or the words in a parenthesis
 *  right after it ("sour gas (Wet H2S)"), or a definition ("X means …"). */
export function tieIn(sentence: string, term: string, leads: string[]): { kind: "paren" | "defines" | "related"; to: string } | null {
  const s = sentence;
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
  tie: { kind: "paren" | "defines" | "related"; to: string } | null;
}
export interface SweepSection { key: string; page: number; rating: string | null; line: string; chunk: SweepChunk }
export interface TermSweep {
  term: string;
  docCount: number;
  passageCount: number;
  /** Used in more than half the library — listed by count only. */
  tooCommon: boolean;
  /** Per document, most hits first: its best sentences. */
  docs: Array<{ documentId: string; hits: number; best: SweepHit[] }>;
  /** Sections of a sectioned book (piping classes) whose own text uses the term. */
  sections: Array<{ documentId: string; items: SweepSection[] }>;
}

/** Order a document's hits: ties first, then definitions, then the rest. */
const tieRank = (h: SweepHit) => (h.tie?.kind === "paren" ? 0 : h.tie?.kind === "defines" ? 1 : h.tie ? 2 : 3);

/** Sections of a book document already mapped (piping classes, read class
 *  by class from the spec book): each section's key and first page. */
async function mappedSections(admin: SupabaseClient, docId: string): Promise<Array<{ key: string; page: number }>> {
  const { rows } = await fetchAllRows<{ tag: string; page: number }>((from, to) => admin
    .from("knowledge_page_entities").select("tag, page")
    .eq("document_id", docId).eq("kind", "pipe_class").order("page").range(from, to), 20_000);
  return rows.map((r) => ({ key: r.tag, page: r.page }));
}

/** The recorded rating of the named sections. */
async function sectionRatings(admin: SupabaseClient, docId: string, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await inSlices(keys, 100, 3, async (slice) => {
    const { data } = await admin.from("knowledge_page_entities").select("tag, raw")
      .eq("document_id", docId).eq("kind", "pipe_class").in("tag", slice);
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

/** A document this dense with the term is a book of sections (a spec
 *  database, a data-sheet book): its hits are listed section by section. */
const BOOK_HITS = 30;

/** Sweep the libraries for each term. Every query is ids-only first; text is
 *  read only for the passages that will be looked at. */
export async function sweepLibrary(admin: SupabaseClient, opts: {
  orgId: string; libraryIds: string[]; terms: string[];
  /** Documents the asker may read (retired and AI-excluded already removed). */
  allowedDocIds: Set<string>;
  deadlineMs: number;
}): Promise<TermSweep[]> {
  const out: TermSweep[] = [];
  const sectionCache = new Map<string, Array<{ key: string; page: number }>>();
  for (const term of opts.terms) {
    if (Date.now() > opts.deadlineMs) break;
    type Row = { id: string; document_id: string; page: number };
    const { rows } = await fetchAllRows<Row>((from, to) => admin
      .from("knowledge_chunks").select("id, document_id, page")
      .eq("org_id", opts.orgId).in("library_id", opts.libraryIds)
      .textSearch("tsv", term, { type: "phrase", config: "english" })
      .order("id").range(from, to), 6000);
    const hits = rows.filter((r) => opts.allowedDocIds.has(r.document_id));
    const byDoc = new Map<string, Row[]>();
    for (const r of hits) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r]);
    const sweep: TermSweep = {
      term, docCount: byDoc.size, passageCount: hits.length,
      tooCommon: byDoc.size > Math.max(40, opts.allowedDocIds.size * 0.5),
      docs: [], sections: [],
    };
    out.push(sweep);
    if (hits.length === 0 || sweep.tooCommon) continue;

    // Books get their mapped sections; everything else is a document.
    for (const [docId, list] of byDoc) {
      if (list.length >= BOOK_HITS && !sectionCache.has(docId)) sectionCache.set(docId, await mappedSections(admin, docId));
    }
    // Which passages to read: an ordinary document, up to 12 spread across
    // it; a book, one per section (or per page when it isn't mapped).
    const toRead: Row[] = [];
    for (const [docId, list] of byDoc) {
      const sorted = [...list].sort((a, b) => a.page - b.page);
      if (list.length >= BOOK_HITS) {
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
    for (const [docId, list] of byDoc) {
      const chunks = list.map((r) => read.get(r.id)).filter((c): c is SweepChunk => !!c).sort((a, b) => a.page - b.page);
      if (list.length >= BOOK_HITS) {
        const sections = sectionCache.get(docId) ?? [];
        const items: SweepSection[] = [];
        const seen = new Set<string>();
        for (const c of chunks) {
          const line = sentencesWith(c.content, term)[0] ?? "";
          const key = sectionAt(sections, c.page)?.key ?? codeOf(line) ?? `p${c.page}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ key, page: c.page, rating: null, line, chunk: c });
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
      sweep.docs.push({ documentId: docId, hits: list.length, best: best.slice(0, 3) });
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

/** The passages worth attaching: every tie and definition, then each
 *  document's best sentence, then sections whose rating fits. */
export function sweepPassages(sweeps: TermSweep[], rating: string | null, max = 12): SweepChunk[] {
  const picked: SweepChunk[] = [];
  const add = (c: SweepChunk) => { if (picked.length < max && !picked.some((p) => p.id === c.id)) picked.push(c); };
  for (const s of sweeps) for (const d of s.docs) for (const h of d.best) if (h.tie && h.tie.kind !== "related") add(h.chunk);
  for (const s of sweeps) for (const d of s.docs) for (const h of d.best) if (h.tie) add(h.chunk);
  for (const s of sweeps) for (const g of s.sections) {
    for (const it of g.items.filter((i) => rating && i.rating && sameRating(i.rating, rating)).slice(0, 4)) add(it.chunk);
  }
  for (const s of sweeps) for (const d of s.docs.slice(0, 6)) if (d.best[0]) add(d.best[0].chunk);
  return picked;
}

export const sameRating = (recorded: string, asked: string) => new RegExp(`(^|[^0-9])${asked}([^0-9]|$)`).test(recorded);

/** The sweep as the answer reads it. `n` gives a passage's [n] if attached. */
export function sweepBlock(sweeps: TermSweep[], docName: (id: string) => string, n: (chunkId: string) => number | null,
  totalDocs: number, rating: string | null): string {
  const live = sweeps.filter((s) => s.passageCount > 0);
  if (live.length === 0 && sweeps.length === 0) return "";
  const short = (name: string) => name.replace(/\.pdf$/i, "");
  const cite = (id: string) => { const k = n(id); return k ? ` [${k}]` : " (not attached)"; };
  const lines: string[] = [
    `TERM SWEEP — every passage in these libraries that uses the asker's own words, found by searching all ${totalDocs} reachable documents (not a ranked sample):`,
  ];
  for (const s of sweeps) {
    if (s.passageCount === 0) { lines.push(`"${s.term}": used nowhere in the libraries.`); continue; }
    if (s.tooCommon) { lines.push(`"${s.term}": used in ${s.docCount} documents — too common to list.`); continue; }
    lines.push(`"${s.term}": used in ${s.docCount} document${s.docCount === 1 ? "" : "s"} (${s.passageCount} passage${s.passageCount === 1 ? "" : "s"}).`);
    for (const d of s.docs.slice(0, 14)) {
      const h = d.best[0];
      if (!h) continue;
      const tie = h.tie ? (h.tie.kind === "paren" ? `  ← writes "${s.term}" as "${h.tie.to}"` : h.tie.kind === "defines" ? "  ← defines it" : `  ← same sentence as "${h.tie.to}"`) : "";
      lines.push(`  - ${short(docName(d.documentId))} p.${h.chunk.page}${h.chunk.section ? ` (${h.chunk.section.slice(0, 50)})` : ""}${cite(h.chunk.id)}: "${h.sentence}"${tie}`);
    }
    if (s.docs.length > 14) lines.push(`  - …and ${s.docs.length - 14} more documents.`);
    for (const g of s.sections) {
      const fit = rating ? g.items.filter((i) => i.rating && sameRating(i.rating, rating)) : [];
      const unknown = g.items.filter((i) => !i.rating);
      lines.push(`  Sections of ${short(docName(g.documentId))} whose own text uses "${s.term}": ${g.items.length}` +
        (rating ? ` — ${fit.length} recorded as Class ${rating}${unknown.length ? `, ${unknown.length} with no rating recorded` : ""}` : "") + ":");
      const show = [...fit, ...g.items.filter((i) => !fit.includes(i))].slice(0, 16);
      for (const it of show) {
        lines.push(`    - ${it.key} p.${it.page}${it.rating ? ` · rating ${it.rating}` : " · rating not recorded (read it on the page)"}${cite(it.chunk.id)}: "${it.line}"`);
      }
      if (g.items.length > show.length) lines.push(`    - …and ${g.items.length - show.length} more sections.`);
    }
  }
  lines.push(
    "READ THIS BEFORE ANSWERING: it is the complete list, not a sample. Before writing that the library doesn't use a term, " +
    "doesn't tie two terms together, or has no class or rule for a service, check it. A sentence here that ties the asker's " +
    "term to another (\"sour gas (Wet H2S) service\") IS textual basis — cite it and say whose words they are and what they " +
    "govern (a valve practice's wording is evidence of how the company uses the term, not a piping rule). A section listed " +
    "here whose rating fits is a candidate answer: name it. A passage marked (not attached) can be named but not quoted.",
  );
  return "\n\n" + lines.join("\n");
}
