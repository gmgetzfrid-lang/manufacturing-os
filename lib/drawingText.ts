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
  X: "Exchangers / Special",
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
  for (const m of text.toUpperCase().matchAll(EQUIPMENT_RE)) {
    const prefix = m[1];
    if (EQUIPMENT_STOP_PREFIXES.has(prefix)) continue;
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
  "AND", "TO", "FROM", "ON", "SEE", "THE", "CONT", "WITH", "PER", "FOR", "REF", "AT", "OR", "IN",
]);

export function extractDrawingRefs(text: string): string[] {
  const seen = new Set<string>();
  const upper = text.toUpperCase();
  for (const re of REF_PATTERNS) {
    re.lastIndex = 0;
    for (const m of upper.matchAll(re)) {
      const norm = normalizeRef(m[0]);
      const segs = norm.split("-");
      // Prose word captured as a leading segment ("AND-PID-107") — the bare
      // ref is matched separately by the looser pattern; drop this one.
      if (REF_STOP_LEADS.has(segs[0])) continue;
      // Equipment tags also match the loose third pattern (e.g. 10-V-101):
      // require the letter segment to NOT be a known equipment prefix when
      // the shape is number-letters-number.
      if (segs.length === 3 && /^\d+$/.test(segs[0]) && /^\d+$/.test(segs[2])) {
        if (EQUIPMENT_CATEGORIES[segs[1]] !== undefined && segs[1].length <= 2) continue;
      }
      seen.add(norm);
    }
  }
  // A prefixed match ("21-PID-1105") also yields its bare suffix via the
  // second pattern ("PID-1105") — keep only the most specific form.
  const refs = [...seen];
  return refs.filter((r) => !refs.some((other) => other !== r && other.endsWith(`-${r}`)));
}

// ── Census ─────────────────────────────────────────────────────────────────

export interface CensusCategory {
  prefix: string;
  label: string;              // friendly name or "Unknown prefix"
  known: boolean;
  distinctTags: number;
  occurrences: number;
  sample: string[];           // up to 8 example tags
}

export interface EquipmentCensus {
  totalDistinct: number;
  totalOccurrences: number;
  categories: CensusCategory[];       // sorted by distinct desc
  unknownPrefixes: string[];          // drives the "share your decoder" ask
}

export function buildEquipmentCensus(
  entities: Array<{ tag: string }>,
): EquipmentCensus {
  const byPrefix = new Map<string, Map<string, number>>();
  for (const e of entities) {
    const prefix = e.tag.split("-")[0] ?? e.tag;
    const tags = byPrefix.get(prefix) ?? new Map<string, number>();
    tags.set(e.tag, (tags.get(e.tag) ?? 0) + 1);
    byPrefix.set(prefix, tags);
  }
  const categories: CensusCategory[] = [...byPrefix.entries()].map(([prefix, tags]) => {
    const label = EQUIPMENT_CATEGORIES[prefix];
    return {
      prefix,
      label: label ?? "Unknown prefix",
      known: label !== undefined,
      distinctTags: tags.size,
      occurrences: [...tags.values()].reduce((a, b) => a + b, 0),
      sample: [...tags.keys()].sort().slice(0, 8),
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
 *  "025-PID-0107" → "025-PID", "PID-107" → "PID", "21-D-1105" → "21-D".
 *  Two sheets in the same series belong to the same drawing set — which is
 *  what separates "a sheet you didn't load" from "a different unit". */
export function refSeries(ref: string): string {
  const segs = normalizeRef(ref).split("-");
  return segs.length <= 1 ? segs[0] ?? "" : segs.slice(0, -1).join("-");
}

/** The sheet number as a NUMBER, so 0107 and 107 are the same sheet. */
function refSheetNumber(ref: string): number | null {
  const last = normalizeRef(ref).split("-").pop() ?? "";
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
   *  "load these" rather than a wall of numbers. */
  outOfScope: Array<{ series: string; refs: string[]; count: number; referencedBy: string[] }>;
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
): RefAudit {
  // A sheet's identity = every drawing-number-shaped token in its name.
  const identityByDoc = new Map<string, string[]>();
  const identity: Array<{ ref: string; docId: string }> = [];
  for (const d of docs) {
    const refs = extractDrawingRefs(d.name);
    const own = refs.length > 0 ? refs : [normalizeRef(d.name)];
    identityByDoc.set(d.id, own);
    for (const ref of own) identity.push({ ref, docId: d.id });
  }
  const exact = new Map(identity.map((i) => [i.ref, i.docId]));
  const nameById = new Map(docs.map((d) => [d.id, d.name]));
  const scope = [...new Set(identity.map((i) => refSeries(i.ref)))].filter(Boolean).sort();

  /** Which loaded sheet does this reference mean? Exact match first, then a
   *  UNIQUE same-series sheet with the same number (0107 ≡ 107). Ambiguity
   *  resolves to nothing — a wrong match would invent a connection. */
  const resolveDoc = (ref: string): string | null => {
    const hit = exact.get(ref);
    if (hit) return hit;
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
      const inScope = scope.some((s) => seriesMatch(s, series));
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
      .map(([series, v]) => ({
        series,
        refs: [...v.refs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        count: v.count,
        referencedBy: [...v.referencedBy].sort().slice(0, 6),
      }))
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
      EQUIPMENT_CATEGORIES[prefix] ?? `Unknown (${prefix})`,
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
