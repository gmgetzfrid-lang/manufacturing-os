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

export interface RefAudit {
  /** Referenced drawing numbers that match NO sheet in the library —
   *  broken/off-library references, with who references them. */
  missing: Array<{ ref: string; referencedBy: string[]; count: number }>;
  /** Cross-references that resolve inside the library. */
  resolved: number;
  totalRefs: number;
}

/** docs: every sheet in the library with its display name (drawing numbers
 *  are extracted from the names); refsByDoc: the refs each sheet makes. */
export function auditDrawingRefs(
  docs: Array<{ id: string; name: string }>,
  refsByDoc: Map<string, string[]>,
): RefAudit {
  // A sheet's identity = every drawing-number-shaped token in its name.
  const identity = new Set<string>();
  for (const d of docs) {
    for (const ref of extractDrawingRefs(d.name)) identity.add(ref);
    identity.add(normalizeRef(d.name));
  }
  const nameById = new Map(docs.map((d) => [d.id, d.name]));

  const missingMap = new Map<string, { referencedBy: Set<string>; count: number }>();
  let resolved = 0;
  let totalRefs = 0;
  for (const [docId, refs] of refsByDoc) {
    const selfRefs = new Set(extractDrawingRefs(nameById.get(docId) ?? ""));
    for (const ref of refs) {
      if (selfRefs.has(ref)) continue;          // a sheet citing its own number
      totalRefs++;
      if (identity.has(ref)) { resolved++; continue; }
      const entry = missingMap.get(ref) ?? { referencedBy: new Set<string>(), count: 0 };
      entry.referencedBy.add(nameById.get(docId) ?? "Sheet");
      entry.count++;
      missingMap.set(ref, entry);
    }
  }
  const missing = [...missingMap.entries()]
    .map(([ref, v]) => ({ ref, referencedBy: [...v.referencedBy].sort().slice(0, 6), count: v.count }))
    .sort((a, b) => b.count - a.count);
  return { missing, resolved, totalRefs };
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
