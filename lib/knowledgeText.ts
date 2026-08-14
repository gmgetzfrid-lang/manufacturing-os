// lib/knowledgeText.ts
//
// Pure text machinery for the AI knowledge libraries — no supabase, no
// network, no provider imports, so the unit tests exercise exactly what
// ingestion and ask-time use.

/** Make extracted text safe to store through PostgREST/Postgres.
 *
 *  PDF text layers with broken font CMaps emit LONE UTF-16 SURROGATES —
 *  JSON.stringify encodes them as unpaired \udXXX escapes, and Postgres's
 *  JSON parser rejects the whole insert with "invalid input syntax for type
 *  json", which surfaced in production as "Indexing failed — chunk insert
 *  failed" killing an entire rebuild over one bad glyph. NUL and other C0
 *  control bytes are equally unstorable (text columns refuse the NUL byte).
 *  Drops both; keeps \n and \t. Explicit charCode loop (not a regex) so no
 *  tool in the chain can mangle a control character in the source. */
export function sanitizeStorageText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {              // high surrogate…
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { out += s[i] + s[i + 1]; i++; }  // …paired: keep
      continue;                                     // …lone: drop
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;       // lone low surrogate: drop
    if (c === 0x7f || (c < 32 && c !== 10 && c !== 9)) continue; // controls: drop
    out += s[i];
  }
  return out;
}

/** A caption line: "TABLE 3 — BOLT TORQUES", "Figure 5-1: ..." — the name a
 *  document uses when it tells the reader to go look at something. */
export const CAPTION_RE = /^\s*(TABLE|FIGURE|FIG\.?|CHART|DETAIL)\s+([A-Z]?\d[\w.-]*)/i;

/** Lines that read as TABLE ROWS: vision transcripts render tables with
 *  " | " separators; text-layer extractions keep column alignment as runs
 *  of spaces. Two signals, either is enough. */
const isTableLine = (l: string): boolean =>
  l.split(" | ").length >= 3 || /\S(\s{2,})\S+(\s{2,})\S/.test(l);

/** Split page text into TABLE blocks and prose runs, BEFORE any whitespace
 *  collapse. This exists because the old pipeline collapsed all whitespace
 *  first — turning a stress table into an undelimited number soup — and the
 *  answer prompt then had to carry a standing "PDF table extraction jumbles
 *  numbers" disclaimer. A table kept intact row-by-row needs no disclaimer.
 *
 *  A table block is 3+ consecutive table-looking lines; the caption line
 *  sitting up to 2 lines above it travels WITH it, because "TABLE 3" glued
 *  to its rows is what makes the chunk findable when prose says "see
 *  Table 3". */
export function splitTables(raw: string): Array<{ kind: "prose" | "table"; text: string }> {
  const lines = raw.split("\n");
  const out: Array<{ kind: "prose" | "table"; text: string }> = [];
  let i = 0;
  let proseStart = 0;
  const flushProse = (until: number) => {
    const t = lines.slice(proseStart, until).join("\n").trim();
    if (t) out.push({ kind: "prose", text: t });
  };
  while (i < lines.length) {
    if (isTableLine(lines[i])) {
      let j = i;
      while (j < lines.length && (isTableLine(lines[j]) || lines[j].trim() === "")) j++;
      // trim trailing blanks from the block
      let end = j;
      while (end > i && lines[end - 1].trim() === "") end--;
      if (end - i >= 3) {
        // caption within 2 lines above joins the table
        let capStart = i;
        for (let k = i - 1; k >= Math.max(proseStart, i - 2); k--) {
          if (CAPTION_RE.test(lines[k])) { capStart = k; break; }
        }
        flushProse(capStart);
        out.push({ kind: "table", text: lines.slice(capStart, end).join("\n").trim() });
        proseStart = end;
        i = j;
        continue;
      }
    }
    i++;
  }
  flushProse(lines.length);
  return out;
}

/** Split one PDF page's text into search-friendly chunks. Target ~1400 chars
 *  with sentence-boundary preference and 160-char overlap so a fact that
 *  straddles a boundary is findable from either side.
 *
 *  TABLES ARE ATOMIC. A table block (see splitTables) becomes its own
 *  chunk with rows and columns intact; an oversized table splits at ROW
 *  boundaries with the caption + header row repeated on each part, so no
 *  part is ever a headerless slab of numbers. */
export function chunkPageText(raw: string, target = 1400, overlap = 160): string[] {
  const parts = splitTables(raw);
  if (parts.some((p) => p.kind === "table")) {
    const chunks: string[] = [];
    for (const part of parts) {
      if (part.kind === "prose") {
        chunks.push(...chunkProse(part.text, target, overlap));
        continue;
      }
      if (part.text.length <= target * 2) {
        chunks.push(part.text);
        continue;
      }
      // Oversized table: split at row boundaries, re-heading each part.
      const rows = part.text.split("\n");
      const headCount = CAPTION_RE.test(rows[0]) ? 2 : 1;
      const head = rows.slice(0, headCount).join("\n");
      let buf: string[] = [];
      let size = head.length;
      for (const row of rows.slice(headCount)) {
        if (size + row.length > target * 2 && buf.length > 0) {
          chunks.push([head, ...buf].join("\n"));
          buf = []; size = head.length;
        }
        buf.push(row); size += row.length + 1;
      }
      if (buf.length > 0) chunks.push([head, ...buf].join("\n"));
    }
    return chunks.filter((c) => c.length >= 40);
  }
  return chunkProse(raw, target, overlap);
}

/** Slice boundaries must never land INSIDE a surrogate pair. A cut through
 *  an astral character turns its two valid halves into two lone surrogates —
 *  text that sanitizeStorageText already passed becomes JSON-unstorable
 *  AFTER chunking, and the insert dies with "invalid input syntax for type
 *  json". Found by reproduction: astral-dense pages (broken PDF fonts map
 *  glyphs to Plane-1 codepoints) poisoned 3 of 5 chunks. */
const alignEnd = (s: string, i: number): number =>
  i > 0 && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff ? i - 1 : i;
const alignStart = (s: string, i: number): number =>
  i < s.length && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff ? i + 1 : i;

function chunkProse(raw: string, target = 1400, overlap = 160): string[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 40) return [];            // page furniture / stray marks
  if (text.length <= target) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + target, text.length);
    if (end < text.length) {
      // Prefer to break at a sentence end inside the last 40% of the window.
      const window = text.slice(start + Math.floor(target * 0.6), end);
      const lastStop = window.lastIndexOf(". ");
      if (lastStop > 0) end = start + Math.floor(target * 0.6) + lastStop + 1;
    }
    end = alignEnd(text, end);
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = alignStart(text, Math.max(end - overlap, start + 1));
  }
  return chunks.filter((c) => c.length >= 40);
}

/** Truncate without ever leaving half a surrogate pair at the cut. Use for
 *  every slice(0, n) whose result lands in a DB row or a provider JSON
 *  body — a plain slice can poison both. */
export function truncateSafe(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, alignEnd(s, n));
}

/** Pull a JSON array of strings out of model output that may be wrapped in
 *  prose or a code fence. Falls back to the raw question if nothing parses —
 *  a bad model answer must never kill the search step. */
export function parseSearchQueries(modelOutput: string, fallback: string): string[] {
  const tryParse = (s: string): string[] | null => {
    try {
      const v = JSON.parse(s) as unknown;
      if (Array.isArray(v)) {
        const strs = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
        return strs.length > 0 ? strs : null;
      }
    } catch { /* keep trying */ }
    return null;
  };

  const direct = tryParse(modelOutput.trim());
  if (direct) return direct.slice(0, 5);

  const match = modelOutput.match(/\[[\s\S]*?\]/);
  if (match) {
    const fromBlock = tryParse(match[0]);
    if (fromBlock) return fromBlock.slice(0, 5);
  }
  return [fallback];
}

/** Refinement-round parsing: "[]" (or a READY sentinel) means the model has
 *  enough passages — return no new queries. Otherwise same semantics as
 *  parseSearchQueries but WITHOUT the fallback (no new queries ≠ error). */
export function parseRefineQueries(modelOutput: string): string[] {
  const trimmed = modelOutput.trim();
  if (trimmed === "[]" || /\bREADY\b/.test(trimmed)) return [];
  const parsed = parseSearchQueries(modelOutput, "__none__");
  return parsed[0] === "__none__" ? [] : parsed;
}

export interface FollowupPlan {
  queries: string[];
  /** Documents the passages reference that the libraries apparently lack. */
  missingDocs: string[];
  /** Optional clarify proposal (only when the library enables the feature):
   *  the answer spans several distinct aspects and the model wants the asker
   *  to pick which one(s) before answering. */
  clarify: { question: string; options: string[] } | null;
}

/** Parse the reference-chasing round: expects a JSON object
 *  {"queries": [...], "missing_documents": [...]} but tolerates a bare
 *  array (old behavior), prose wrapping, READY sentinels, and garbage. */
export function parseFollowupPlan(modelOutput: string): FollowupPlan {
  const none: FollowupPlan = { queries: [], missingDocs: [], clarify: null };
  const trimmed = modelOutput.trim();
  if (trimmed === "[]" || trimmed === "{}" || /\bREADY\b/.test(trimmed)) return none;

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 6) : [];

  // A clarify proposal must be well-formed to surface: a real question and
  // 2-6 short option labels — anything else is dropped, never shown broken.
  const clarifyOf = (v: unknown): FollowupPlan["clarify"] => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const c = v as Record<string, unknown>;
    const question = typeof c.question === "string" ? c.question.trim().slice(0, 300) : "";
    const options = strings(c.options).map((o) => o.trim().slice(0, 60));
    if (!question || options.length < 2) return null;
    return { question, options };
  };

  const tryObject = (s: string): FollowupPlan | null => {
    try {
      const v = JSON.parse(s) as Record<string, unknown>;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return {
          queries: strings(v.queries),
          missingDocs: strings(v.missing_documents ?? v.missingDocuments),
          clarify: clarifyOf(v.clarify),
        };
      }
    } catch { /* keep trying */ }
    return null;
  };

  const direct = tryObject(trimmed);
  if (direct) return direct;
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const fromBlock = tryObject(objMatch[0]);
    if (fromBlock) return fromBlock;
  }
  // Bare array -> treat as queries only (old refine format).
  return { queries: parseRefineQueries(modelOutput), missingDocs: [], clarify: null };
}

/** Which [n] citation markers does the answer actually use? Ordered, deduped. */
export function extractCitationNumbers(answer: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// ── Section awareness ──────────────────────────────────────────────────────

/** "5.3 Pipe Supports", "SECTION 7 — TESTING", "APPENDIX C Tables". */
const HEADING_RE =
  /^(?:\d{1,2}(?:\.\d{1,3}){0,3}[.)]?\s+[A-Z][A-Za-z0-9 ,\-/&()']{2,70}|(?:SECTION|PART|CHAPTER|APPENDIX|ANNEX)\s+[A-Z0-9][A-Za-z0-9 .\-—:]{0,70})$/;

export function isSectionHeading(line: string): boolean {
  const t = line.trim();
  return t.length >= 4 && t.length <= 80 && HEADING_RE.test(t);
}

export interface PageSegment {
  section: string | null;
  text: string;
}

/** Walk a page's lines, splitting at section headings. carrySection is the
 *  heading in force when the page begins (sections span pages). Returns the
 *  segments plus the heading in force when the page ends. */
export function splitPageIntoSections(
  lines: string[], carrySection: string | null,
): { segments: PageSegment[]; lastSection: string | null } {
  const segments: PageSegment[] = [];
  let section = carrySection;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join(" ").trim();
    if (text.length > 0) segments.push({ section, text });
    buf = [];
  };
  for (const line of lines) {
    if (isSectionHeading(line)) {
      flush();
      section = line.trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return { segments, lastSection: section };
}

// ── Structured answers ─────────────────────────────────────────────────────

export interface AnswerBlock {
  type: "hero" | "label" | "bullet" | "important" | "text";
  text: string;
}

/** Parse the model's structured answer into renderable blocks:
 *  "**Answer:** …" → hero; "**Basis:**" / "**Check:**" → label;
 *  "- …" → bullet; "! …" (or IMPORTANT:/WARNING:/MUST:) → important —
 *  the draw-your-eyes-here emphasis tier; anything else → text. Never
 *  throws — a model that ignores the format degrades to text blocks. */
export function parseAnswerBlocks(answer: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  for (const raw of answer.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const hero = line.match(/^\*{0,2}Answer:?\*{0,2}:?\s*(.+)$/i);
    if (hero && blocks.length === 0) { blocks.push({ type: "hero", text: hero[1].trim() }); continue; }
    const important = line.match(/^(?:!\s+|[-*•]\s+!\s+|\*{0,2}(?:IMPORTANT|WARNING|MUST|CRITICAL):?\*{0,2}:?\s+)(.+)$/);
    if (important) { blocks.push({ type: "important", text: important[1].trim() }); continue; }
    const label = line.match(/^\*{0,2}([A-Z][A-Za-z ]{2,24}):\*{0,2}\s*(.*)$/);
    if (label && !line.startsWith("-") && label[2].length === 0) {
      blocks.push({ type: "label", text: label[1].trim() });
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) { blocks.push({ type: "bullet", text: bullet[1].trim() }); continue; }
    blocks.push({ type: "text", text: line });
  }
  return blocks;
}

export interface RetrievedChunk {
  id: string;
  document_id: string;
  page: number;
  content: string;
  rank: number;
  section?: string | null;
}

/** Merge multi-query search results by RECIPROCAL RANK, not raw score.
 *
 *  ts_rank is not calibrated across queries: a rare two-word query yields
 *  systematically higher scores than a six-word facet query, so sorting the
 *  union by raw rank let whichever query was lexically rarest crowd out the
 *  facets of a checklist question. Each batch is treated as a ranked list
 *  and fused positionally (RRF, k=60 — same constant as lib/hybridRank,
 *  which exists because exactly this mistake was made once already at the
 *  keyword/semantic seam). */
export function mergeRetrievedRRF(
  batches: RetrievedChunk[][], cap = 14, maxChars = 1600,
): RetrievedChunk[] {
  const score = new Map<string, { chunk: RetrievedChunk; s: number }>();
  for (const batch of batches) {
    batch.forEach((c, i) => {
      const prev = score.get(c.id);
      const add = 1 / (60 + i + 1);
      if (prev) prev.s += add;
      else score.set(c.id, { chunk: c, s: add });
    });
  }
  return [...score.values()]
    .sort((a, b) => b.s - a.s || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, cap)
    .map(({ chunk }) => ({ ...chunk, content: chunk.content.slice(0, maxChars) }));
}

/** Merge multi-query search results: dedupe by chunk id keeping best rank,
 *  order by rank, cap the count and each chunk's length so the prompt stays
 *  a predictable size on any provider. */
export function mergeRetrieved(
  batches: RetrievedChunk[][], cap = 14, maxChars = 1600,
): RetrievedChunk[] {
  const best = new Map<string, RetrievedChunk>();
  for (const batch of batches) {
    for (const c of batch) {
      const prev = best.get(c.id);
      if (!prev || c.rank > prev.rank) best.set(c.id, c);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, cap)
    .map((c) => ({ ...c, content: c.content.slice(0, maxChars) }));
}

/** pdf.js (bundled inside unpdf) calls Math.sumPrecise in some font/geometry
 *  paths — an ES2026 API that Node runtimes don't ship yet. Without this,
 *  ingestion fails with "Math.sumPrecise is not a function" on exactly the
 *  PDFs that exercise those paths (the bulk-upload mystery: some documents
 *  worked, some didn't). Neumaier compensated summation matches the spec's
 *  precision intent for this workload. Idempotent; a runtime that ships the
 *  real thing keeps it. */
export function ensurePdfPolyfills(): void {
  const m = Math as Math & { sumPrecise?: (values: Iterable<number>) => number };
  if (typeof m.sumPrecise !== "function") {
    m.sumPrecise = (values: Iterable<number>): number => {
      let sum = 0;
      let c = 0;
      for (const v of values) {
        const t = sum + v;
        if (Math.abs(sum) >= Math.abs(v)) c += sum - t + v;
        else c += v - t + sum;
        sum = t;
      }
      return sum + c;
    };
  }
}
