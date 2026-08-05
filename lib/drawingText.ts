// lib/drawingText.ts — pure, testable drawing-text intelligence.
//
// P&IDs and drawings carry their meaning in TAGS, not prose: equipment
// numbers (V-3, P-101A, PSV-2001), and drawing-number references (the text
// behind off-page connectors and "continued on" arrows). This module is the
// pattern layer that turns extracted page text into structured entities,
// and entities into answers:
//
//   - extractEquipmentTags / extractDrawingRefs: conservative regexes.
//     Extraction runs only on SPARSE pages (drawings), so prose false-
//     positives are already rare; patterns still prefer precision.
//   - buildEquipmentCensus: distinct tags grouped by prefix with friendly
//     category names; unknown prefixes surface as "teach me your decoder"
//     suggestions instead of silent misbuckets.
//   - auditDrawingRefs: which sheets reference which drawing numbers, and
//     which referenced numbers exist NOWHERE in the library — the
//     broken/missing-reference audit, computed deterministically.

export const SPARSE_PAGE_MAX_CHARS = 2000;

/** Drawing pages are text-sparse; prose pages are dense. This single
 *  threshold decides whether entity extraction runs on a page. */
export function isDrawingLikePage(pageText: string): boolean {
  return pageText.trim().length > 0 && pageText.length <= SPARSE_PAGE_MAX_CHARS;
}

/** Friendly names for common ISA/refinery tag prefixes. Unknown prefixes
 *  still count — they land in "unknown" and drive the decoder suggestion. */
export const EQUIPMENT_CATEGORIES: Record<string, string> = {
  V: "Vessels / Drums",
  D: "Drums",
  E: "Exchangers",
  P: "Pumps",
  C: "Columns / Compressors",
  K: "Compressors",
  T: "Towers / Tanks",
  TK: "Tanks",
  F: "Furnaces / Filters",
  H: "Heaters",
  R: "Reactors",
  M: "Mixers / Motors",
  A: "Agitators / Analyzers",
  B: "Blowers / Boilers",
  S: "Separators / Strainers",
  X: "Special / Package equipment",
  PSV: "Relief valves (PSV)",
  PRV: "Relief valves (PRV)",
  RV: "Relief valves (RV)",
  PV: "Pressure valves",
  FV: "Flow valves",
  LV: "Level valves",
  TV: "Temperature valves",
};

export interface EquipmentTagHit {
  tag: string;        // "V-3", "P-101A" (normalized uppercase, dashed)
  prefix: string;     // "V", "PSV"
}

// LETTERS-DASH-DIGITS(optional letter suffix). The dash is required — it's
// what separates real tags from prose abbreviations. Longest-prefix rules
// (PSV before P) come from the prefix itself being captured.
const EQUIPMENT_RE = /\b([A-Z]{1,3})[-–](\d{1,5})([A-Z]{1,2})?\b/g;

// Tokens that match the shape but are never equipment on real drawings.
const EQUIPMENT_STOP_PREFIXES = new Set([
  "NO", "DWG", "REV", "PID", "DRW", "SHT", "SH", "PG", "ISO", "API", "ANSI", "NPS",
]);

export function extractEquipmentTags(text: string): EquipmentTagHit[] {
  const out: EquipmentTagHit[] = [];
  const upper = text.toUpperCase();
  for (const m of upper.matchAll(EQUIPMENT_RE)) {
    const prefix = m[1];
    if (EQUIPMENT_STOP_PREFIXES.has(prefix)) continue;
    // "2002-D-2001" is a DRAWING NUMBER — reading D-2001 out of its middle
    // would mint a phantom drum for every sheet in the set. A digit-dash
    // immediately before the prefix means the letters are an inner segment
    // of a larger number, not a tag.
    const at = m.index ?? 0;
    if (at >= 2 && /[-–]/.test(upper[at - 1]) && /\d/.test(upper[at - 2])) continue;
    const tag = `${prefix}-${m[2]}${m[3] ?? ""}`;
    out.push({ tag, prefix });
  }
  return out;
}

/** Normalize a drawing-number-ish string for matching: uppercase, spaces
 *  collapsed to dashes, leading zeros inside numeric segments kept (they
 *  matter on real registers). */
export function normalizeRef(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "-").replace(/–/g, "-").replace(/-+/g, "-").trim();
}

// Drawing-number shapes seen in the wild:
//   025-PID-0107, 21-D-1105, PID-107, DWG 2245-01, 100-P&ID-22
const REF_PATTERNS: RegExp[] = [
  /\b[A-Z0-9]{1,6}[-\s](?:P&ID|PID|DWG|DRW|D)[-\s]?\d{1,6}(?:[-\s]\d{1,4})?\b/gi,
  /\b(?:P&ID|PID|DWG|DRW)[-\s]?\d{2,6}(?:[-\s]\d{1,4})?\b/gi,
  /\b\d{2,4}[-\s][A-Z]{1,4}[-\s]\d{2,6}\b/g,
];

// Words that precede a drawing number in prose ("SEE PID-107", "CONT ON
// DWG 2245") and would otherwise be captured as a bogus leading segment.
const REF_STOP_LEADS = new Set([
  "AND", "TO", "FROM", "ON", "SEE", "THE", "CONT", "WITH", "PER", "FOR", "REF", "AT", "OR", "IN", "OF",
]);

// Prose/furniture words that can land in a number's MIDDLE segment and mint
// phantom drawings: "SHT 11 OF 16" → "11-OF-16", "603 OR 604" → "603-OR-604".
// Never drawing numbers, no context override.
const REF_MIDDLE_STOP = new Set([
  "OF", "OR", "AND", "TO", "ON", "IN", "AT", "BY", "PER", "FOR",
  "SHT", "SH", "SHEET", "REV", "NO", "OFF",
]);

// Off-page connectors on multi-sheet sets carry a SHEET as well as a
// drawing number ("CONT ON DWG 025-A-1001 SH 3") — the sheet is half the
// address. Canonical form: "<number>-SH<n>".
const SHEET_SUFFIX_RE = /^\s*[,.]?\s*SH(?:T|EET)?\s*\.?\s*(?:NO\.?)?\s*[:#]?\s*(\d{1,3})\b/;

// Words that INTRODUCE a drawing number ("SEE X", "CONT ON DWG X") — strong
// evidence the token is a drawing reference even when its shape could pass
// for an area-prefixed equipment tag. Deliberately excludes TO/AT/ON:
// "TO V-1402" introduces a DESTINATION, and treating those as drawing
// context is how equipment tags leak into the reference audit.
const REF_CONTEXT_RE = /(?:DWG|DRG|DRAWING|SEE|CONT|CONTINUED|REF|REFERENCE)[.\s:#]*$/;

export function extractDrawingRefs(text: string): string[] {
  const seen = new Set<string>();
  const upper = text.toUpperCase();
  for (let pi = 0; pi < REF_PATTERNS.length; pi++) {
    const re = REF_PATTERNS[pi];
    // The LOOSE pattern (bare digits-letters-digits) is the only ambiguous
    // one; the -PID-/-DWG-/-D- shapes carry their own evidence.
    const loose = pi === 2;
    re.lastIndex = 0;
    for (const m of upper.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // The match stopped mid-token ("DWG 025" out of "DWG 025-A-1001") —
      // a label glued to a fragment is garbage; a longer pattern owns the
      // real number.
      if (upper[end] === "-") continue;
      const norm = normalizeRef(m[0]);
      const segs = norm.split("-");
      // Prose word captured as a leading segment ("AND-PID-107") — the bare
      // ref is matched separately by the looser pattern; drop this one.
      if (REF_STOP_LEADS.has(segs[0])) continue;
      if (segs.length === 3 && /^\d+$/.test(segs[0]) && /^\d+$/.test(segs[2])) {
        // Prose word in the middle ("11 OF 16", "603 OR 604") — never a
        // drawing number, no matter what precedes it.
        if (REF_MIDDLE_STOP.has(segs[1])) continue;
        // Equipment tags also match the loose pattern (10-V-101, 104 PSV
        // 2001). The shape alone can't decide — "025-A-1001" is a real
        // drawing number — so STRONG context does: introduced by SEE/DWG/
        // CONT it's a reference; bare or after a mere preposition, it
        // stays a tag.
        if (loose && EQUIPMENT_CATEGORIES[segs[1]] !== undefined &&
            !REF_CONTEXT_RE.test(upper.slice(Math.max(0, start - 24), start))) {
          continue;
        }
      }
      // A sheet number right after the match is part of the address.
      const sheet = upper.slice(end).match(SHEET_SUFFIX_RE);
      seen.add(sheet ? `${norm}-SH${sheet[1]}` : norm);
    }
  }
  // A prefixed match ("21-PID-1105") also yields its bare suffix via the
  // second pattern ("PID-1105"), and a sheet-addressed match also yields
  // its bare base — keep only the most specific form of each.
  const refs = [...seen];
  return refs.filter((r) =>
    !refs.some((other) => other !== r && other.endsWith(`-${r}`)) &&
    !refs.some((other) => other !== r && other.startsWith(`${r}-SH`)));
}

// ── Title block ────────────────────────────────────────────────────────────
// The sheet's REAL identity is printed in its own border: drawing number,
// sheet number, revision. Filenames are whatever someone exported; the
// title block is authoritative. Works on both text-layer pages and vision
// transcripts (the vision prompt asks for labeled title-block lines).

export interface TitleBlockInfo {
  drawingNumber: string | null;   // normalized, e.g. "025-PID-0101"
  sheetNumber: string | null;     // "3"
  rev: string | null;             // "2", "A"
}

// The NO/NUMBER label is REQUIRED — "DWG 025-A-1001" without it is exactly
// the off-page-connector phrasing, and mistaking a connector for the
// sheet's own identity would corrupt the whole audit.
const TB_DWG_RE = /(?:DRAWING|DWG|DRG)[.\s]*(?:NO|NUMBER|#)[.:\s]*([A-Z0-9][A-Z0-9\-._]{3,24})/g;
const TB_SHEET_OF_RE = /\bSH(?:EET|T)?[.\s]*(?:NO\.?)?[.:\s]*(\d{1,4})\s*OF\s*\d{1,4}\b/;
const TB_SHEET_RE = /\bSHEET[.\s]*(?:NO\.?)?[.:\s]*(\d{1,4})\b/;
const TB_REV_RE = /\bREV(?:ISION)?[.\s]*(?:NO\.?)?[.:\s]*([A-Z0-9]{1,3})\b/g;
const TB_STOP_VALUES = new Set(["NO", "NUMBER", "REV", "SHEET", "SH", "DATE", "OF", "BY", "DWG"]);

export function extractTitleBlock(pageText: string): TitleBlockInfo {
  const upper = pageText.toUpperCase();

  let drawingNumber: string | null = null;
  TB_DWG_RE.lastIndex = 0;
  for (const m of upper.matchAll(TB_DWG_RE)) {
    const candidate = normalizeRef(m[1].replace(/[-._]+$/, ""));
    if (!/\d/.test(candidate)) continue;                    // "INDEX", "SIZE"…
    if (TB_STOP_VALUES.has(candidate)) continue;
    if (candidate.length < 4 && !candidate.includes("-")) continue;
    drawingNumber = candidate;
    break;
  }

  const sheetMatch = upper.match(TB_SHEET_OF_RE) ?? upper.match(TB_SHEET_RE);
  const sheetNumber = sheetMatch ? String(Number(sheetMatch[1])) : null;

  let rev: string | null = null;
  TB_REV_RE.lastIndex = 0;
  for (const m of upper.matchAll(TB_REV_RE)) {
    if (TB_STOP_VALUES.has(m[1])) continue;
    rev = m[1];
    break;
  }

  return { drawingNumber, sheetNumber, rev };
}

// ── Site decoder ───────────────────────────────────────────────────────────
// The owner can TEACH the numbering scheme in Library AI setup — plain text
// like "First two digits = unit (20 = Crude Unit, 25 = Vacuum Unit)". Two
// things are machine-read out of it: how many leading digits name the unit,
// and what each unit number means. Everything else in the text goes to the
// model verbatim.

export interface UnitMap {
  /** How many leading digits of a drawing number name the unit. */
  prefixLen: number;
  /** "20" → "Crude Unit" */
  names: Record<string, string>;
}

const UNIT_PAIR_RE = /\b(\d{1,3})\s*(?:=|:|→)\s*([A-Za-z][A-Za-z0-9 /&()'-]{1,40}?)(?=[\n,;.)]|$)/g;

// Owner-taught TAG PREFIX meanings: "X- = Exchanger, ZZ- = Sample station".
// The trailing dash is the marker — it keeps "D = sheet size" prose and unit
// pairs ("20 = Crude Unit") from being read as equipment categories.
const PREFIX_PAIR_RE = /\b([A-Z]{1,3})-\s*=\s*([A-Za-z][A-Za-z0-9 /&()'-]{1,40}?)(?=[\n,;.)]|$)/g;

export function parsePrefixMap(decoderText: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!decoderText.trim()) return out;
  PREFIX_PAIR_RE.lastIndex = 0;
  for (const m of decoderText.matchAll(PREFIX_PAIR_RE)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

export function parseUnitMap(decoderText: string): UnitMap | null {
  if (!decoderText.trim()) return null;
  const names: Record<string, string> = {};
  UNIT_PAIR_RE.lastIndex = 0;
  for (const m of decoderText.matchAll(UNIT_PAIR_RE)) {
    names[m[1]] = m[2].trim();
  }
  if (Object.keys(names).length === 0) return null;
  // "first three digits" beats inference; else the common key length wins.
  const stated = decoderText.match(/first\s+(two|three|four|2|3|4)\s+digits/i)?.[1]?.toLowerCase();
  const prefixLen =
    stated === "three" || stated === "3" ? 3
    : stated === "four" || stated === "4" ? 4
    : stated === "two" || stated === "2" ? 2
    : (Object.keys(names)[0]?.length ?? 2);
  return { prefixLen, names };
}

/** Which unit does this drawing number belong to? "2502-D-0001" with a
 *  2-digit prefix → "25". Null when the number doesn't lead with enough
 *  digits to say. */
export function unitOfRef(ref: string, prefixLen: number): string | null {
  const first = normalizeRef(ref).split("-")[0] ?? "";
  const digits = first.match(/^\d+/)?.[0] ?? "";
  return digits.length >= prefixLen ? digits.slice(0, prefixLen) : null;
}

// ── Off-page connector boxes ───────────────────────────────────────────────
// The small numbered box at the page edge IS the connector's identity: the
// continuation sheet carries the SAME number, and the stream name plus
// destination equipment verify the match. The vision prompt asks for
// "OPC <n>: …" lines, so transcripts carry them machine-readably.

const OPC_BOX_RE = /\bOPC[\s#.:-]*(\d{1,4})\b/g;

export function parseOpcBoxes(line: string): string[] {
  const out: string[] = [];
  OPC_BOX_RE.lastIndex = 0;
  for (const m of line.toUpperCase().matchAll(OPC_BOX_RE)) out.push(String(Number(m[1])));
  return [...new Set(out)];
}

// ── Census ─────────────────────────────────────────────────────────────────

export interface CensusCategory {
  prefix: string;
  label: string;              // friendly name or "Unknown prefix"
  known: boolean;
  distinctTags: number;
  occurrences: number;
  sample: string[];           // up to 8 example tags
  /** Highest numeric part in use, and the next safe number after it —
   *  the "what number can I use for a new drum" answer. */
  maxNumber: number | null;
  nextNumber: number | null;
}

export interface EquipmentCensus {
  totalDistinct: number;
  totalOccurrences: number;
  categories: CensusCategory[];       // sorted by distinct desc
  unknownPrefixes: string[];          // drives the "share your decoder" ask
}

export function buildEquipmentCensus(
  entities: Array<{ tag: string }>,
  /** Owner-taught prefix meanings (parsePrefixMap) — they beat the built-in
   *  guesses: the site knows what X- means, the defaults don't. */
  labels?: Record<string, string>,
): EquipmentCensus {
  const byPrefix = new Map<string, Map<string, number>>();
  for (const e of entities) {
    const prefix = e.tag.split("-")[0] ?? e.tag;
    const tags = byPrefix.get(prefix) ?? new Map<string, number>();
    tags.set(e.tag, (tags.get(e.tag) ?? 0) + 1);
    byPrefix.set(prefix, tags);
  }
  const categories: CensusCategory[] = [...byPrefix.entries()].map(([prefix, tags]) => {
    const label = labels?.[prefix] ?? EQUIPMENT_CATEGORIES[prefix];
    const numbers = [...tags.keys()]
      .map((t) => Number(t.slice(prefix.length + 1).match(/^\d+/)?.[0]))
      .filter((n) => Number.isFinite(n)) as number[];
    const maxNumber = numbers.length > 0 ? Math.max(...numbers) : null;
    return {
      prefix,
      label: label ?? "Unknown prefix",
      known: label !== undefined,
      distinctTags: tags.size,
      occurrences: [...tags.values()].reduce((a, b) => a + b, 0),
      sample: [...tags.keys()].sort().slice(0, 8),
      maxNumber,
      nextNumber: maxNumber !== null ? maxNumber + 1 : null,
    };
  }).sort((a, b) => b.distinctTags - a.distinctTags);
  return {
    totalDistinct: categories.reduce((a, c) => a + c.distinctTags, 0),
    totalOccurrences: categories.reduce((a, c) => a + c.occurrences, 0),
    categories,
    unknownPrefixes: categories.filter((c) => !c.known).map((c) => c.prefix),
  };
}

// ── Drawing-reference audit ────────────────────────────────────────────────

/** The identifying part of a drawing number, minus its sheet number:
 *  "025-PID-0107" → "025-PID", "21-D-1105" → "21-D", and for explicit
 *  sheet addresses "025-A-1001-SH3" → "025-A-1001" (the sheets of one
 *  drawing ARE its series). Two refs in the same series belong to the same
 *  drawing set — which is what separates "a sheet you didn't load" from
 *  "a different unit". */
export function refSeries(ref: string): string {
  const segs = normalizeRef(ref).split("-");
  const last = segs[segs.length - 1] ?? "";
  if (/^SH\d+$/.test(last)) return segs.slice(0, -1).join("-");
  return segs.length <= 1 ? segs[0] ?? "" : segs.slice(0, -1).join("-");
}

/** The sheet number as a NUMBER, so 0107 and 107 (and SH3) all compare. */
function refSheetNumber(ref: string): number | null {
  const last = normalizeRef(ref).split("-").pop() ?? "";
  const sh = last.match(/^SH(\d+)$/);
  if (sh) return Number(sh[1]);
  return /^\d+$/.test(last) ? Number(last) : null;
}

/** Series are written loosely on real drawings — a sheet titled
 *  "025-PID-0107" gets referenced as plain "PID-0107" all over the set. One
 *  series being a suffix of the other means the same series. */
function seriesMatch(a: string, b: string): boolean {
  return a === b || a.endsWith(`-${b}`) || b.endsWith(`-${a}`);
}

export interface RefAudit {
  /** Cross-references that resolve to a sheet in the library. */
  resolved: number;
  totalRefs: number;
  /** Series present in the library — the audit's SCOPE. */
  seriesInScope: string[];
  /** IN SCOPE and absent: same drawing series, sheet not loaded. These are
   *  the ones worth chasing — a gap in the set. */
  missingInSeries: Array<{ ref: string; referencedBy: string[]; count: number }>;
  /** OUT OF SCOPE: references into other units/series. Entirely expected on
   *  any real unit's P&IDs and NEVER evidence of a broken connector — you
   *  simply weren't given those drawings. Grouped by series so the ask is
   *  "load these" rather than a wall of numbers; unitName is filled in when
   *  the site decoder knows the unit numbering. */
  outOfScope: Array<{
    series: string; refs: string[]; count: number; referencedBy: string[];
    unitName?: string | null;
  }>;
  /** Both sheets ARE loaded, but the target never references back. The only
   *  bucket that can indicate a genuine drafting error — still called
   *  one-way, not broken, because plenty of continuation notes are. */
  oneWay: Array<{ from: string; to: string; count: number }>;
}

/** docs: every sheet in the library with its display name (drawing numbers
 *  are extracted from the names); refsByDoc: the refs each sheet makes.
 *
 *  The distinction this function exists to make: an off-page connector
 *  pointing at a unit you never loaded is NOT broken. Calling it broken is
 *  worse than saying nothing — it manufactures alarm about drawings that are
 *  probably perfect. Only two things are actionable: sheets missing from a
 *  series you DID load, and connectors that don't come back inside the set. */
export function auditDrawingRefs(
  docs: Array<{ id: string; name: string }>,
  refsByDoc: Map<string, string[]>,
  /** Identities READ FROM EACH SHEET'S OWN TITLE BLOCK at ingest (kind
   *  'self' entities) — drawing number, plus number-SHn per sheet. When a
   *  sheet declares who it is, that beats anything the filename says:
   *  files are named by whoever exported them, borders are drafted. */
  selfTagsByDoc?: Map<string, string[]>,
  /** Site decoder (parseUnitMap) — names the unit each out-of-scope series
   *  belongs to, so "load these" reads as units, not bare numbers. */
  unitMap?: UnitMap | null,
): RefAudit {
  // A sheet's identity: what its title block declares, else every drawing-
  // number-shaped token in its filename.
  const identityByDoc = new Map<string, string[]>();
  const identity: Array<{ ref: string; docId: string }> = [];
  for (const d of docs) {
    const declared = (selfTagsByDoc?.get(d.id) ?? []).map(normalizeRef).filter(Boolean);
    const fromName = extractDrawingRefs(d.name);
    const own = declared.length > 0 ? declared
      : fromName.length > 0 ? fromName : [normalizeRef(d.name)];
    identityByDoc.set(d.id, own);
    for (const ref of own) identity.push({ ref, docId: d.id });
  }
  // One number can identify several docs (every sheet of a set carries the
  // set's base drawing number) — track ALL owners, never last-write-wins.
  const exact = new Map<string, Set<string>>();
  for (const i of identity) {
    const set = exact.get(i.ref) ?? new Set<string>();
    set.add(i.docId);
    exact.set(i.ref, set);
  }
  const nameById = new Map(docs.map((d) => [d.id, d.name]));
  const scopeAll = [...new Set(identity.map((i) => refSeries(i.ref)))].filter(Boolean).sort();
  // For display, keep only root series — "025-PID", not forty per-drawing
  // entries under it.
  const scope = scopeAll.filter((s) => !scopeAll.some((r) => r !== s && s.startsWith(`${r}-`)));

  /** Which loaded sheet does this reference mean? Exact match first, then a
   *  UNIQUE same-series sheet with the same number (0107 ≡ 107, SH3 ≡ 3).
   *  "multi" = the number identifies a loaded multi-sheet set without
   *  naming one sheet — present, just not a single link. Ambiguity never
   *  invents a connection. */
  const resolveDoc = (ref: string): string | "multi" | null => {
    const hit = exact.get(ref);
    if (hit) return hit.size === 1 ? [...hit][0] : "multi";
    const series = refSeries(ref);
    const num = refSheetNumber(ref);
    if (num === null) return null;
    const candidates = identity.filter((i) =>
      seriesMatch(refSeries(i.ref), series) && refSheetNumber(i.ref) === num);
    const docIds = new Set(candidates.map((c) => c.docId));
    return docIds.size === 1 ? [...docIds][0] : null;
  };

  const missingMap = new Map<string, { referencedBy: Set<string>; count: number }>();
  const outMap = new Map<string, { refs: Set<string>; count: number; referencedBy: Set<string> }>();
  const links = new Map<string, { from: string; to: string; count: number }>();
  let resolved = 0;
  let totalRefs = 0;

  for (const [docId, refs] of refsByDoc) {
    const selfRefs = new Set(identityByDoc.get(docId) ?? []);
    const fromName = nameById.get(docId) ?? "Sheet";
    for (const ref of refs) {
      if (selfRefs.has(ref)) continue;          // a sheet citing its own number
      totalRefs++;
      const targetId = resolveDoc(ref);
      if (targetId === "multi") { resolved++; continue; }  // set is loaded; no single sheet named
      if (targetId && targetId !== docId) {
        resolved++;
        const key = `${docId}→${targetId}`;
        const link = links.get(key) ?? { from: docId, to: targetId, count: 0 };
        link.count++;
        links.set(key, link);
        continue;
      }
      if (targetId === docId) continue;         // resolved to itself
      const series = refSeries(ref);
      const inScope = scopeAll.some((s) => seriesMatch(s, series));
      if (inScope) {
        const entry = missingMap.get(ref) ?? { referencedBy: new Set<string>(), count: 0 };
        entry.referencedBy.add(fromName);
        entry.count++;
        missingMap.set(ref, entry);
      } else {
        const entry = outMap.get(series)
          ?? { refs: new Set<string>(), count: 0, referencedBy: new Set<string>() };
        entry.refs.add(ref);
        entry.count++;
        entry.referencedBy.add(fromName);
        outMap.set(series, entry);
      }
    }
  }

  // One-way: A points at B (both loaded) and B never points back at A.
  const oneWay: RefAudit["oneWay"] = [];
  for (const link of links.values()) {
    if (links.has(`${link.to}→${link.from}`)) continue;
    oneWay.push({
      from: nameById.get(link.from) ?? "Sheet",
      to: nameById.get(link.to) ?? "Sheet",
      count: link.count,
    });
  }

  return {
    resolved,
    totalRefs,
    seriesInScope: scope,
    missingInSeries: [...missingMap.entries()]
      .map(([ref, v]) => ({ ref, referencedBy: [...v.referencedBy].sort().slice(0, 6), count: v.count }))
      .sort((a, b) => b.count - a.count),
    outOfScope: [...outMap.entries()]
      .map(([series, v]) => {
        const unit = unitMap ? unitOfRef(series, unitMap.prefixLen) : null;
        return {
          series,
          refs: [...v.refs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
          count: v.count,
          referencedBy: [...v.referencedBy].sort().slice(0, 6),
          unitName: unit ? unitMap!.names[unit] ?? `unit ${unit}` : null,
        };
      })
      .sort((a, b) => b.count - a.count),
    oneWay: oneWay.sort((a, b) => b.count - a.count),
  };
}

// ── CSV register ───────────────────────────────────────────────────────────

const csvCell = (s: string): string =>
  /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

/** The equipment register as CSV (opens straight into Excel): one row per
 *  distinct tag with category, occurrence count, and the sheets it's on. */
export function equipmentRegisterCsv(
  entities: Array<{ tag: string; documentName: string; page: number }>,
  labels?: Record<string, string>,
): string {
  const byTag = new Map<string, { count: number; sheets: Map<string, number> }>();
  for (const e of entities) {
    const entry = byTag.get(e.tag) ?? { count: 0, sheets: new Map<string, number>() };
    entry.count++;
    if (!entry.sheets.has(e.documentName)) entry.sheets.set(e.documentName, e.page);
    byTag.set(e.tag, entry);
  }
  const rows = [["Tag", "Category", "Occurrences", "Sheets", "First page"]];
  const sorted = [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  for (const [tag, entry] of sorted) {
    const prefix = tag.split("-")[0] ?? tag;
    rows.push([
      tag,
      labels?.[prefix] ?? EQUIPMENT_CATEGORIES[prefix] ?? `Unknown (${prefix})`,
      String(entry.count),
      [...entry.sheets.keys()].join("; "),
      String([...entry.sheets.values()][0] ?? ""),
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

// ── Vision-fallback decision ───────────────────────────────────────────────

/** A page carrying less than this much extracted text has no usable text
 *  layer at all — a pure scan, or a fully-SHX drawing. */
export const TEXTLESS_PAGE_MAX_CHARS = 60;

/** Below this, a page is "thin": too little text to be prose. */
const THIN_PAGE_MAX_CHARS = 1200;

/** Decide whether a page needs AI vision to be readable.
 *
 *  The obvious case is an empty text layer. The case that actually bites is
 *  subtler: an AutoCAD drawing whose BODY text is SHX (plots as line-work,
 *  invisible to extraction) but whose TITLE BLOCK is TrueType — the page
 *  yields a few hundred characters of drawing number and revision, sails
 *  past an "is it empty" check, and every equipment tag stays invisible.
 *
 *  So: a thin page that produced NO tags and NO references and reads like
 *  labels rather than sentences is a drawing we can't see, and gets looked
 *  at. Prose pages (which have sentences) never qualify, so standards
 *  libraries don't pay for vision they don't need. */
export function pageNeedsVision(pageText: string, tagsFound: number): boolean {
  const text = pageText.trim();
  if (text.length < TEXTLESS_PAGE_MAX_CHARS) return true;
  if (tagsFound > 0) return false;
  if (text.length > THIN_PAGE_MAX_CHARS) return false;
  // Sentence enders are the prose signal — drawings are labels, not prose.
  const sentences = (text.match(/[.!?](\s|$)/g) ?? []).length;
  return sentences <= 2;
}

// ── Equipment-list intent ──────────────────────────────────────────────────
// "Show me all equipment" / "list the pumps" deserves a TABLE, not prose —
// the ask route attaches a structured, clickable register when a question
// matches. Pure so the trigger is testable.

const EQUIP_VERB_RE = /\b(show|list|all|every|table|register|inventory|census|count|how many|spreadsheet|breakdown)\b/i;

const CATEGORY_QUERIES: Array<{ re: RegExp; prefixes: string[]; label: string }> = [
  { re: /\bvessels?\b|\bdrums?\b/i, prefixes: ["V", "D"], label: "Vessels / Drums" },
  { re: /\bpumps?\b/i, prefixes: ["P"], label: "Pumps" },
  { re: /\bexchangers?\b/i, prefixes: ["E", "X"], label: "Exchangers" },
  { re: /\bcompressors?\b/i, prefixes: ["K", "C"], label: "Compressors" },
  { re: /\btowers?\b|\bcolumns?\b/i, prefixes: ["T", "C"], label: "Towers / Columns" },
  { re: /\btanks?\b/i, prefixes: ["TK", "T"], label: "Tanks" },
  { re: /\bpsvs?\b|\brelief\s+valves?\b|\bprvs?\b/i, prefixes: ["PSV", "PRV", "RV"], label: "Relief valves" },
  { re: /\bheaters?\b/i, prefixes: ["H"], label: "Heaters" },
  { re: /\bfurnaces?\b/i, prefixes: ["F"], label: "Furnaces" },
  { re: /\breactors?\b/i, prefixes: ["R"], label: "Reactors" },
];

export interface EquipmentListIntent {
  match: boolean;
  /** Prefixes to filter to, or null = every category. */
  prefixes: string[] | null;
  label: string | null;
}

export function matchEquipmentListIntent(question: string): EquipmentListIntent {
  if (!EQUIP_VERB_RE.test(question)) return { match: false, prefixes: null, label: null };
  const cat = CATEGORY_QUERIES.find((c) => c.re.test(question));
  if (cat) return { match: true, prefixes: cat.prefixes, label: cat.label };
  if (/\bequipment\b/i.test(question)) return { match: true, prefixes: null, label: null };
  return { match: false, prefixes: null, label: null };
}

// ── Off-page connector box pairing ─────────────────────────────────────────
//
// A connector's box number must reappear on its continuation sheet — the
// number IS the match, the stream name only verifies it. Extracted from the
// drawing route so the same analysis backs both the live panel and the
// permanent audit record; one of those silently drifting from the other is
// how a "clean" audit stops meaning anything.

export interface OpcEntity {
  document_id: string;
  page: number;
  tag: string;
  raw?: string | null;
}

export interface OpcAudit {
  boxCount: number;
  /** Box leaves a sheet naming a loaded destination that has no matching box. */
  unreturned: Array<{ box: string; from: string; to: string; line: string }>;
  /** Box names no drawing at all — broken by definition, since nothing on the
   *  sheet tells the reader where to continue. */
  noRef: Array<{ box: string; sheet: string; page: number; line: string }>;
}

export function auditOpcBoxes(
  opcRows: readonly OpcEntity[],
  /** Sheet identities declared by each document's own title block. */
  selfByDoc: ReadonlyMap<string, string[]>,
  nameById: ReadonlyMap<string, string>,
): OpcAudit {
  const opcByDoc = new Map<string, Set<string>>();
  for (const o of opcRows) {
    const set = opcByDoc.get(o.document_id) ?? new Set<string>();
    set.add(o.tag);
    opcByDoc.set(o.document_id, set);
  }
  const identityIndex = new Map<string, Set<string>>();
  for (const [docId, tags] of selfByDoc) {
    for (const t of tags) {
      const set = identityIndex.get(t) ?? new Set<string>();
      set.add(docId);
      identityIndex.set(t, set);
    }
  }

  const unreturned: OpcAudit["unreturned"] = [];
  for (const o of opcRows) {
    if (!o.raw) continue;
    for (const ref of extractDrawingRefs(o.raw)) {
      const owners = identityIndex.get(ref);
      // An ambiguous number identifies a multi-sheet set, not one sheet —
      // never guess which one and report the guess as a defect.
      if (!owners || owners.size !== 1) continue;
      const target = [...owners][0];
      if (target === o.document_id) continue;
      if (!(opcByDoc.get(target)?.has(o.tag))) {
        unreturned.push({
          box: o.tag,
          from: nameById.get(o.document_id) ?? "Sheet",
          to: nameById.get(target) ?? "Sheet",
          line: o.raw.slice(0, 120),
        });
      }
    }
  }

  const noRef = opcRows
    .filter((o) => !o.raw || extractDrawingRefs(o.raw).length === 0)
    .map((o) => ({
      box: o.tag,
      sheet: nameById.get(o.document_id) ?? "Sheet",
      page: o.page,
      line: (o.raw ?? "").slice(0, 120),
    }));

  return { boxCount: opcRows.length, unreturned, noRef };
}
