// lib/drawingText.ts — pure, testable drawing-text intelligence.
//
// P&IDs and drawings carry their meaning in TAGS, not prose: equipment
// numbers (V-3, P-101A, PSV-2001), and drawing-number references (the text
// behind off-page connectors and "continued on" arrows). This module is the
// pattern layer that turns extracted page text into structured entities,
// and entities into answers:
//
//   - extractEquipmentTags / extractDrawingRefs: conservative regexes.
//     Extraction runs only on DRAWING-LIKE pages (isDrawingLikePage), so
//     prose false-positives are already rare; patterns still prefer
//     precision.
//   - buildEquipmentCensus: distinct tags grouped by prefix with friendly
//     category names; unknown prefixes surface as "teach me your decoder"
//     suggestions instead of silent misbuckets.
//   - auditDrawingRefs: which sheets reference which drawing numbers, and
//     which referenced numbers exist NOWHERE in the library — the
//     broken/missing-reference audit, computed deterministically.

/** At or under this many characters a page is too short to be a page of
 *  prose (a standard's page runs 2,500-4,000), so it is treated as a
 *  drawing without further evidence — the behaviour every sparse sheet
 *  has always had. It is a FAST PATH, not a ceiling: a page over it is
 *  still a drawing when its text says so (below). */
export const SPARSE_PAGE_MAX_CHARS = 2000;

/** A dense page is a drawing when its text is a TAG LIST, not sentences
 *  (DWG-7 / BR-12). A TrueType P&ID — the best input there is, needing no
 *  AI — carries every tag, line number, note and revision row in its text
 *  layer, and runs to several thousand characters; under the old
 *  2,000-character ceiling it was read as prose and nothing was extracted.
 *  Signals, measured rather than guessed:
 *
 *    - TAG DENSITY: equipment tags + drawing references per 1,000
 *      characters. A prose page that mentions equipment (a procedure
 *      naming P-101A) carries one or two; a drawing's text layer carries a
 *      dozen or more. 4 per 1,000 sits well clear of both.
 *    - A TITLE BLOCK: a labelled drawing number in the sheet's own border
 *      (extractTitleBlock). A notes-heavy sheet whose tags are line-work
 *      still declares who it is.
 *    - LETTER CASE, required with either: engineering drawings are lettered
 *      in capitals (ASME Y14.2, and every CAD standard in practice); prose
 *      is mostly lower case. A page whose letters are more than 35 % lower
 *      case is prose, however many tags it names — that keeps an equipment
 *      list written in sentences, a procedure, or a spec citing "drawing
 *      no. 123-A-456" out.
 *
 *  Sentence enders are deliberately NOT a signal here: a drawing's
 *  numbered notes ("1. ALL DIMENSIONS IN MM.") end in full stops. */
export const DENSE_DRAWING_MIN_TAGS_PER_KCHAR = 4;
export const DRAWING_MAX_LOWERCASE_RATIO = 0.35;

export interface DrawingSignals {
  chars: number;
  /** Equipment tags + drawing references found in the text. */
  tags: number;
  /** tags per 1,000 characters. */
  tagsPerKchar: number;
  /** Share of letters that are lower case (0 for a page with no letters). */
  lowercaseRatio: number;
}

/** The measurements isDrawingLikePage decides on — exported so the drawing
 *  lens can say WHY a sheet with text was or was not read as a drawing. */
export function drawingSignals(pageText: string): DrawingSignals {
  const text = pageText.trim();
  const chars = text.length;
  const tags = chars === 0 ? 0 : extractEquipmentTags(text).length + extractDrawingRefs(text).length;
  const lower = (text.match(/[a-z]/g) ?? []).length;
  const upper = (text.match(/[A-Z]/g) ?? []).length;
  return {
    chars,
    tags,
    tagsPerKchar: chars === 0 ? 0 : (tags * 1000) / chars,
    lowercaseRatio: lower + upper === 0 ? 0 : lower / (lower + upper),
  };
}

/** Does entity extraction run on this page? Sparse pages always (the fast
 *  path); dense pages when their text is shaped like a drawing's — a tag
 *  list in capitals — and never when it reads as prose. */
export function isDrawingLikePage(pageText: string): boolean {
  if (pageText.trim().length === 0) return false;
  if (pageText.length <= SPARSE_PAGE_MAX_CHARS) return true;
  const s = drawingSignals(pageText);
  if (s.lowercaseRatio > DRAWING_MAX_LOWERCASE_RATIO) return false;
  return s.tagsPerKchar >= DENSE_DRAWING_MIN_TAGS_PER_KCHAR
    || extractTitleBlock(pageText).drawingNumber !== null;
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

// A pipe LINE NUMBER is <size>"-<service>-<number>-<spec>: 6"-P-1024-A1A,
// 1-1/2"-CWS-101-B2, 10"-HC-15003-A1A-HC. After its size it is shaped
// exactly like a tag — P-1024 reads as a pump — so every line on a P&ID
// minted a phantom piece of equipment (DWG-2). The SIZE is what gives it
// away: a number (whole, fraction, or whole-and-fraction) followed by an
// inch mark (", '', ”, ″) or IN/INCH. A metric size (150-P-1024,
// DN150-P-1024) ends in a digit-dash and is already caught by the
// drawing-number guard below.
//
// A size alone is NOT enough. Valves and instruments are routinely written
// with the size of the line they sit in — 2" PSV-2001, 4" FCV-101,
// 3"x4" PSV-101 — and those are real, PSM-critical tags. What separates
// the two is the joint: a line number's size is GLUED to its service by a
// dash (6"-P-1024, 6 IN-P-1024); a size written with only a space (or
// nothing) before a tag makes it a line number only when the token goes on
// to carry a line SPEC segment (6" P-1024-A1A). The LINE label is the same:
// "LINE NO." always introduces a line; a bare LINE word ("SUCTION LINE
// P-101A") only when the spec segment follows.
/** The size of a line: 6", 1-1/2", 3/4", .75", 6'', 6 IN, 6INCH. */
const LINE_SIZE_SRC =
  String.raw`(?:\d+\s*[-\s]\s*\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)\s*(?:"|''|”|″|IN(?:CH(?:ES)?)?\.?)`;
/** Text ending in a line size with the dash glued to it — "6\"-",
 *  "1-1/2\"-", "6 IN-": unambiguously the head of a line number. */
const LINE_SIZE_DASH_BEFORE_RE = new RegExp(String.raw`${LINE_SIZE_SRC}[-–]\s*$`);
/** Text ending in a line size with no dash — "2\" ", "2\"": a line number
 *  only when a spec segment follows the token (LINE_SPEC_AFTER_RE). */
const LINE_SIZE_SPACE_BEFORE_RE = new RegExp(String.raw`${LINE_SIZE_SRC}\s*$`);
/** "LINE NO. P-1024" / "LINE # P-1024": always a line. */
const LINE_NO_LABEL_BEFORE_RE = /\bLINE\s*(?:NO\.?|#)\s*$/;
/** A bare LINE word — a line only with a spec segment after the token. */
const LINE_WORD_BEFORE_RE = /\bLINE\s*$/;
/** The first spec segment of a line number right after its service-number:
 *  "-A1A", "-B2", "-CS". Two characters at least — "PSV-2001-A" (a valve
 *  with a one-letter suffix) is a tag, not a line. */
const LINE_SPEC_SRC = String.raw`[-–][A-Z0-9]{2,6}(?![A-Z0-9])`;
const LINE_SPEC_AFTER_RE = new RegExp(String.raw`^${LINE_SPEC_SRC}`);
/** A whole line number: size, service, number, then spec segments — the
 *  same two joints: dash-glued, or spaced with a spec segment required. */
const LINE_NUMBER_RE = new RegExp(
  String.raw`(?<![A-Z0-9./-])(${LINE_SIZE_SRC})(?:[-–]\s*|\s*(?=[A-Z]{1,4}[-–]\d{1,6}${LINE_SPEC_SRC}))` +
  String.raw`([A-Z]{1,4})[-–](\d{1,6})((?:[-–][A-Z0-9]{1,6})*)`,
  "g",
);

/** Is the tag-shaped token between `before` and `after` part of a pipe
 *  line number? The ONE rule extractEquipmentTags and extractLineNumbers
 *  share (DWG-2). */
function isLineNumberContext(before: string, after: string): boolean {
  if (LINE_SIZE_DASH_BEFORE_RE.test(before) || LINE_NO_LABEL_BEFORE_RE.test(before)) return true;
  return (LINE_SIZE_SPACE_BEFORE_RE.test(before) || LINE_WORD_BEFORE_RE.test(before))
    && LINE_SPEC_AFTER_RE.test(after);
}

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
    // A pipe line number (6"-P-1024-A1A) — its size and joint say so; a
    // size-annotated valve (2" PSV-2001) is still a tag.
    const before = upper.slice(Math.max(0, at - 16), at);
    if (isLineNumberContext(before, upper.slice(at + m[0].length))) continue;
    const tag = `${prefix}-${m[2]}${m[3] ?? ""}`;
    out.push({ tag, prefix });
  }
  return out;
}

/** Pipe line numbers on a page, normalised (6"-P-1024-A1A) — the same size
 *  grammar extractEquipmentTags uses to keep them OUT of the equipment
 *  count, so the two can never disagree about what a line number is.
 *
 *  Not yet written to the index: storing them as their own entity kind
 *  ('line' — "which line feeds V-3") is a call in lib/knowledgeIngest.ts,
 *  the ingest owner's file, handed over with DWG-2. Until then a line
 *  number is simply never equipment. */
export function extractLineNumbers(text: string): string[] {
  const out = new Set<string>();
  const upper = text.toUpperCase();
  LINE_NUMBER_RE.lastIndex = 0;
  for (const m of upper.matchAll(LINE_NUMBER_RE)) {
    const size = m[1].replace(/\s+/g, "").replace(/(?:''|”|″|IN(?:CH(?:ES)?)?\.?)$/, '"');
    const spec = (m[4] ?? "").replace(/–/g, "-");
    out.add(`${size}-${m[2]}-${m[3]}${spec}`);
  }
  return [...out];
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
// transcripts.
//
// THE CONTRACT WITH THE VISION PROMPT (PR-11). A transcript is one flat
// stream holding the title block AND every off-page connector — and a
// connector is routinely written WITH the label ("CONT ON DWG NO.
// 040-B-2002 SH 1"). Reading the first labelled number anywhere on the page
// made such a sheet declare itself to be the sheet it points AT. So the
// prompt fences the border's fields between TITLE_BLOCK_OPEN and
// TITLE_BLOCK_CLOSE, and when the fence is present only the fenced lines
// are read. A text layer has no fence; there a candidate introduced by
// continuation phrasing (CONT ON / CONTINUED ON / SEE / TO / FROM / REF)
// is a connector, never the sheet's identity.

export const TITLE_BLOCK_OPEN = "=== TITLE BLOCK ===";
export const TITLE_BLOCK_CLOSE = "=== END TITLE BLOCK ===";

export interface TitleBlockInfo {
  drawingNumber: string | null;   // normalized, e.g. "025-PID-0101"
  sheetNumber: string | null;     // "3"
  rev: string | null;             // "2", "A"
}

// The NO/NUMBER label is REQUIRED — "DWG 025-A-1001" without it is exactly
// the off-page-connector phrasing, and mistaking a connector for the
// sheet's own identity would corrupt the whole audit.
const TB_DWG_RE = /(?:DRAWING|DWG|DRG)[.\s]*(?:NO|NUMBER|#)[.:\s]*([A-Z0-9][A-Z0-9\-._]{3,24})/g;
const TB_SHEET_OF_RE = /\bSH(?:EET|T)?[.\s]*(?:NO\.?)?[.:\s]*(\d{1,4})\s*OF\s*\d{1,4}\b/g;
const TB_SHEET_RE = /\bSHEET[.\s]*(?:NO\.?)?[.:\s]*(\d{1,4})\b/g;
const TB_REV_RE = /\bREV(?:ISION)?[.\s]*(?:NO\.?)?[.:\s]*([A-Z0-9]{1,3})\b/g;
const TB_STOP_VALUES = new Set(["NO", "NUMBER", "REV", "SHEET", "SH", "DATE", "OF", "BY", "DWG"]);
/** Continuation phrasing RIGHT before the label, on the same line, makes a
 *  labelled number a connector's destination: "CONT ON DWG NO. X",
 *  "CONTINUED ON DRAWING NO X", "SEE DWG NO X", "TO DRAWING NO. X",
 *  "FROM DWG # X", "REF DWG NO. X". Nothing may stand between — "TO V-3"
 *  on the line above a border strip is a destination, not a connector. */
const TB_CONTINUATION_BEFORE_RE =
  /\b(?:CONT(?:INUED|INUATION|'D|D)?|SEE|TO|FROM|REF(?:ERENCE)?|REFER[ \t]+TO)\b[ \t.:,]*(?:(?:ON|IN|AT)[ \t.:,]*)?$/;

/** The fenced title block of a vision transcript, or null when the text
 *  carries no fence (a text layer, or an older transcript). */
function fencedTitleBlock(upper: string): string | null {
  const open = upper.indexOf(TITLE_BLOCK_OPEN);
  if (open < 0) return null;
  const from = open + TITLE_BLOCK_OPEN.length;
  const close = upper.indexOf(TITLE_BLOCK_CLOSE, from);
  // An unclosed fence still bounds the read: the border's four fields.
  return close >= 0 ? upper.slice(from, close) : upper.slice(from).split("\n").slice(0, 6).join("\n");
}

/** True when the words just before `at` introduce a connector. */
function introducedAsConnector(text: string, at: number): boolean {
  return TB_CONTINUATION_BEFORE_RE.test(text.slice(Math.max(0, at - 28), at));
}

export function extractTitleBlock(pageText: string): TitleBlockInfo {
  const fenced = fencedTitleBlock(pageText.toUpperCase());
  const upper = fenced ?? pageText.toUpperCase();
  // Inside the fence everything is the border's own; outside it, a match
  // introduced by continuation phrasing belongs to a connector.
  const isConnector = (at: number) => fenced === null && introducedAsConnector(upper, at);

  let drawingNumber: string | null = null;
  TB_DWG_RE.lastIndex = 0;
  for (const m of upper.matchAll(TB_DWG_RE)) {
    if (isConnector(m.index ?? 0)) continue;
    const candidate = normalizeRef(m[1].replace(/[-._]+$/, ""));
    if (!/\d/.test(candidate)) continue;                    // "INDEX", "SIZE"…
    if (TB_STOP_VALUES.has(candidate)) continue;
    if (candidate.length < 4 && !candidate.includes("-")) continue;
    drawingNumber = candidate;
    break;
  }

  const firstSheet = (re: RegExp): RegExpMatchArray | null => {
    re.lastIndex = 0;
    for (const m of upper.matchAll(re)) if (!isConnector(m.index ?? 0)) return m;
    return null;
  };
  const sheetMatch = firstSheet(TB_SHEET_OF_RE) ?? firstSheet(TB_SHEET_RE);
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
// destination equipment verify the match.
//
// THE CONTRACT WITH THE VISION PROMPT (DWG-4). Drawings do not print the
// letters O-P-C — they draw a pennant — so the only way box numbers reach
// the index is a transcript line the prompt asks for in exactly this form.
// lib/knowledgeVision.ts builds its instruction FROM these constants, so the
// prompt and the parser cannot drift apart again (the prompt once asked for
// no OPC line at all, and the whole connector layer — including the audit's
// top-severity verdict — had no input). The destination drawing comes
// FIRST, right after the box: an evidence line is stored cut to
// OPC_RAW_STORED_MAX characters, and a long service description must never
// push the drawing number off the end of it (DWG-8).
//
// The destination is LABELLED (DWG) and read BY POSITION (parseOpcLine).
// Sites number drawings every way there is — 025-M-0107, 4410-01-001,
// 123456, M-101 — and extractDrawingRefs deliberately reads the ambiguous
// shapes only after a context word. The label gives the reference layer
// that context; the position lets the connector audit read ANY number the
// field holds. "Broken" is then exactly what the contract says it is: the
// connector shows neither a drawing number nor a sheet — the field reads
// NONE, or is empty, and no SH follows. A connector that names only a sheet
// continues within its OWN drawing (SAME, or NONE / empty with a sheet):
// it is paired against that sheet of the source's declared drawing, never
// called broken. A destination present but unreadable is unknown, never
// broken. A pennant with no box number gets no OPC line at all — the prompt
// has it transcribed as continuation phrasing, which the reference audit
// reads (one-way, flagged), so no box is ever invented for it.

/** What a transcript line for one connector looks like. */
export const OPC_LINE_FORMAT = "OPC <box number>: DWG <destination drawing number> SH <sheet> — <TO|FROM> <service or equipment>";
/** A worked example — parsed by parseOpcBoxes / parseOpcLine / extractDrawingRefs in the tests. */
export const OPC_LINE_EXAMPLE = "OPC 14: DWG 2002-D-2001 SH 4 — TO V-1402 CRUDE OVERHEAD";
/** Written in place of the drawing number when the connector shows neither
 *  a drawing number nor a sheet. */
export const OPC_NO_DRAWING = "NONE";
/** Written in place of the drawing number when the connector shows only a
 *  sheet: it continues on another sheet of this same drawing. */
export const OPC_SAME_DRAWING = "SAME";
/** Ingest stores a connector's evidence line cut to this many characters
 *  (lib/knowledgeIngest.ts, truncateSafe(line, 160) — pinned by a test). A
 *  stored line this long may have been cut: its missing drawing number is
 *  UNKNOWN, never evidence of a broken connector. */
export const OPC_RAW_STORED_MAX = 160;

const OPC_BOX_RE = /\bOPC[\s#.:-]*(\d{1,4})\b/g;

export function parseOpcBoxes(line: string): string[] {
  const out: string[] = [];
  OPC_BOX_RE.lastIndex = 0;
  for (const m of line.toUpperCase().matchAll(OPC_BOX_RE)) out.push(String(Number(m[1])));
  return [...new Set(out)];
}

/** A connector line in the contract's shape, read by position. */
export interface OpcLine {
  box: string;
  /** The destination field as written (upper case, trimmed); null when it
   *  is empty or reads NONE or SAME. */
  destination: string | null;
  /** The sheet the connector names, when it names one. */
  sheet: string | null;
  /** The field reads NONE and no sheet is named — the connector says it
   *  names nowhere to continue. */
  none: boolean;
  /** The field is empty and no sheet is named. */
  empty: boolean;
  /** The connector names only a sheet (SAME, or NONE / empty with a SH):
   *  it continues on that sheet of the source's own drawing. */
  sameDrawing: boolean;
}

// "OPC <n>: DWG <field> [SH <n>] [— <service>]". The label may carry NO. /
// NUMBER / #; the separator is an em or en dash (spaced or not), or a
// spaced hyphen — never a bare hyphen, which is part of drawing numbers.
const OPC_CONTRACT_RE = /^\s*OPC[\s#.:-]*(\d{1,4})\s*:\s*(?:DWG|DRG|DRAWING)\b\.?(?:\s*(?:NO\b\.?|NUMBER\b|#))?\s*[:.]?\s*(.*)$/;
const OPC_SEPARATOR_RE = /\s*[—–]\s*|\s+-{1,2}\s+/;
const OPC_SHEET_RE = /^(.*?)[\s,]*\bSH(?:T|EET)?\b\.?\s*(?:NO\b\.?)?\s*[:#]?\s*(\d{1,3})\b/;

/** Read a transcript line written in OPC_LINE_FORMAT; null for a line in any
 *  other shape (a text layer's own phrasing, or an older transcript). */
export function parseOpcLine(line: string): OpcLine | null {
  const m = line.toUpperCase().match(OPC_CONTRACT_RE);
  if (!m) return null;
  const rest = m[2];
  const cut = rest.search(OPC_SEPARATOR_RE);
  const head = cut >= 0 ? rest.slice(0, cut) : rest;
  const sh = head.match(OPC_SHEET_RE);
  const field = (sh ? sh[1] : head).trim().replace(/[\s,.;:]+$/, "");
  const marked = (word: string) => field === word || field.startsWith(`${word} `);
  const none = marked(OPC_NO_DRAWING);
  const same = marked(OPC_SAME_DRAWING);
  const sheet = sh ? String(Number(sh[2])) : null;
  // Only a sheet: a continuation within this drawing, whichever way the
  // missing drawing number was written.
  const sameDrawing = sheet !== null && (same || none || field === "");
  return {
    box: String(Number(m[1])),
    destination: none || same || field === "" ? null : field,
    sheet,
    none: none && !sameDrawing,
    empty: field === "" && !sameDrawing,
    sameDrawing,
  };
}

/** The forms a positional destination is looked up by: the field itself,
 *  normalised, and whatever the reference grammar reads out of it with the
 *  contract's label in front — each sheet-addressed when a sheet is named
 *  (a bare number may identify a whole multi-sheet set, never one sheet).
 *  Empty when the field holds nothing shaped like a drawing number. */
function opcDestinationForms(dest: OpcLine): string[] {
  if (!dest.destination) return [];
  const viaGrammar = extractDrawingRefs(`DWG ${dest.destination}`).map((r) => r.replace(/-SH\d+$/, ""));
  // One token with a digit in it is a drawing number however it is shaped
  // (4410-01-001, 123456, M-101); several words are only when the grammar
  // reads one out of them ("SEE NOTE 3" is not a destination).
  const single = /^[A-Z0-9][A-Z0-9\-–./_&]*$/.test(dest.destination) && /\d/.test(dest.destination)
    ? [normalizeRef(dest.destination)] : [];
  const bases = [...new Set([...single, ...viaGrammar])];
  return bases.map((b) => (dest.sheet ? `${b}-SH${dest.sheet}` : b));
}

/** A line outside the contract with no readable reference: does anything on
 *  it still look like a drawing number? Three or more digits in a row, once
 *  the box number, equipment tags and a sheet number are set aside. */
function hasUnreadNumber(raw: string): boolean {
  const rest = raw.toUpperCase()
    .replace(OPC_BOX_RE, " ")
    .replace(EQUIPMENT_RE, " ")
    .replace(/\bSH(?:T|EET)?\b\.?\s*(?:NO\b\.?)?\s*[:#]?\s*\d{1,3}\b/g, " ");
  return /\d{3,}/.test(rest);
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
  /** One entry per occurrence, or — from a database roll-up (DWG-11) — one
   *  per tag and sheet with its occurrence `count`. */
  entities: Array<{ tag: string; count?: number }>,
  /** Owner-taught prefix meanings (parsePrefixMap) — they beat the built-in
   *  guesses: the site knows what X- means, the defaults don't. */
  labels?: Record<string, string>,
): EquipmentCensus {
  const byPrefix = new Map<string, Map<string, number>>();
  for (const e of entities) {
    const prefix = e.tag.split("-")[0] ?? e.tag;
    const tags = byPrefix.get(prefix) ?? new Map<string, number>();
    tags.set(e.tag, (tags.get(e.tag) ?? 0) + (e.count ?? 1));
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

/** Code-unit order: the same on every server, whatever its locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The number a sheet IS, from what its title block declared (kind 'self'
 *  tags: the drawing number, plus number-SHn per sheet read). ONE function
 *  behind both the number the drawing lens shows and the key the audit
 *  record is filed under (DWG-10) — and deterministic: the shortest declared
 *  number without a -SHn suffix, ties broken in code-unit order, so the
 *  order the rows came back in can never change it. */
export function declaredSheetIdentity(selfTags: readonly string[]): {
  base: string | null;
  /** How many distinct sheet-addressed forms (-SHn) were declared. */
  sheetsDeclared: number;
} {
  const unique = [...new Set(selfTags.filter(Boolean))];
  const shortest = (xs: string[]) => [...xs].sort((a, b) => a.length - b.length || byCodeUnit(a, b))[0] ?? null;
  const sheetForms = unique.filter((t) => /-SH\d+$/.test(t));
  const base = shortest(unique.filter((t) => !/-SH\d+$/.test(t)))
    // Only sheet-addressed forms were declared: the number they share.
    ?? shortest(sheetForms.map((t) => t.replace(/-SH\d+$/, "")));
  return { base, sheetsDeclared: sheetForms.length };
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
export function seriesMatch(a: string, b: string): boolean {
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

/** Every number a sheet answers to: what its title block declared (kind
 *  'self'), else every drawing-number-shaped token in its filename, else the
 *  filename itself. The audit resolves references against these, and the
 *  audit record's scope rule (lib/drawingAuditLog.ts) reads the same. */
export function sheetIdentities(name: string, declaredTags: readonly string[]): string[] {
  const declared = declaredTags.map(normalizeRef).filter(Boolean);
  if (declared.length > 0) return declared;
  const fromName = extractDrawingRefs(name);
  return fromName.length > 0 ? fromName : [normalizeRef(name)];
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
    const own = sheetIdentities(d.name, selfTagsByDoc?.get(d.id) ?? []);
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

// ── Entity roll-up (DWG-11) ────────────────────────────────────────────────
// The census, the audit and the per-sheet readout need, per sheet, each
// distinct tag of each kind with how often and on which pages it occurs —
// not every occurrence. 20261124's drawing_entity_rollup() computes exactly
// this in the database; this is the same roll-up over raw rows, for a
// database that has not applied it (the route reads the rows to exhaustion
// first). The two must agree: lib/__tests__ pins this against the SQL.

export interface EntityRollupRow {
  document_id: string;
  kind: string;
  tag: string;
  occurrences: number;
  first_page: number;
  /** Distinct pages, ascending. */
  pages: number[];
}

export function rollUpEntities(
  rows: ReadonlyArray<{ document_id: string; page: number; kind: string; tag: string }>,
): EntityRollupRow[] {
  const byKey = new Map<string, EntityRollupRow>();
  for (const r of rows) {
    const key = `${r.document_id}\u0000${r.kind}\u0000${r.tag}`;
    const hit = byKey.get(key);
    if (!hit) {
      byKey.set(key, { document_id: r.document_id, kind: r.kind, tag: r.tag, occurrences: 1, first_page: r.page, pages: [r.page] });
      continue;
    }
    hit.occurrences++;
    if (r.page < hit.first_page) hit.first_page = r.page;
    if (!hit.pages.includes(r.page)) hit.pages.push(r.page);
  }
  const out = [...byKey.values()];
  for (const r of out) r.pages.sort((a, b) => a - b);
  return out.sort((a, b) => byCodeUnit(a.document_id, b.document_id) || byCodeUnit(a.kind, b.kind) || byCodeUnit(a.tag, b.tag));
}

// ── CSV register ───────────────────────────────────────────────────────────

const csvCell = (s: string): string =>
  /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

/** The equipment register as CSV (opens straight into Excel): one row per
 *  distinct tag with category, occurrence count, and the sheets it's on. */
export function equipmentRegisterCsv(
  /** One entry per occurrence, or one per tag and sheet with its `count`
   *  (the database roll-up, DWG-11) — `page` is then the first page. */
  entities: Array<{ tag: string; documentName: string; page: number; count?: number }>,
  labels?: Record<string, string>,
): string {
  const byTag = new Map<string, { count: number; sheets: Map<string, number> }>();
  for (const e of entities) {
    const entry = byTag.get(e.tag) ?? { count: 0, sheets: new Map<string, number>() };
    entry.count += e.count ?? 1;
    // The FIRST page the tag is on, whatever order the rows arrived in.
    const seen = entry.sheets.get(e.documentName);
    if (seen === undefined || e.page < seen) entry.sheets.set(e.documentName, e.page);
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
export const THIN_PAGE_MAX_CHARS = 1200;
/** Tags a THIN page must carry before its text layer is believed. One is
 *  what a title block alone produces — the sheet's own drawing number. */
export const MIN_TAGS_THIN_PAGE = 3;

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

  // On a page with barely any text, ONE tag is not evidence that the text
  // layer works — and this is not a hypothetical.
  //
  // A P&ID exported from AutoCAD with SHX fonts draws every tag, every
  // instrument bubble and every line number as STROKED GEOMETRY. The only
  // real text on the sheet is the TrueType title block, which parses to
  // about 170 characters and yields exactly one drawing reference: the
  // sheet's OWN number. Counting that as a tag says "the text layer is
  // fine", vision is skipped, and the sheet is indexed as its title block
  // and nothing else.
  //
  // Nothing errors. The equipment census comes back empty, the reference
  // audit comes back empty, and search finds title blocks — across an
  // ENTIRE drawing set, with no failure anywhere to explain it. A sheet
  // whose text layer genuinely carries its tags yields dozens of them, so
  // requiring a handful on a thin page separates the two cases cleanly and
  // costs nothing on drawings that were readable all along.
  const thin = text.length <= THIN_PAGE_MAX_CHARS;
  if (tagsFound >= (thin ? MIN_TAGS_THIN_PAGE : 1)) return false;
  if (!thin) return false;
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
  /** Box leaves a sheet naming a loaded destination whose box numbers WERE
   *  read, and none of them is this box. */
  unreturned: Array<{ box: string; from: string; to: string; line: string }>;
  /** Box leaves a sheet naming a loaded destination whose box numbers were
   *  never read — a text layer (which prints a pennant, not a box token), a
   *  sheet read by AI vision before connector boxes were transcribed, or a
   *  same-drawing connector whose source declared no drawing number. The
   *  pairing could not be checked: absence of evidence, so it keeps the
   *  sheet from passing and never makes it broken (DWG-4 / DWG-8). */
  unpaired: Array<{ box: string; from: string; to: string; line: string }>;
  /** Box names no destination at all — broken by definition, since nothing
   *  on the sheet tells the reader where to continue. Only POSITIVE evidence
   *  can say that: a contract line whose destination reads NONE or is empty
   *  with no sheet named, or a complete line that holds nothing a drawing
   *  number could be. */
  noRef: Array<{ box: string; sheet: string; page: number; line: string }>;
  /** Box whose destination could not be read: the stored line may have been
   *  cut before it (DWG-8), or what stands there is not shaped like a
   *  drawing number. Absence of evidence, recorded as unknown — worth a look
   *  on the sheet, never "broken". */
  unknown: Array<{ box: string; sheet: string; page: number; line: string }>;
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

  // A stored line at the storage cut may have lost its tail — and with it
  // the drawing number. That is not evidence the connector names nothing.
  const mayBeCut = (o: OpcEntity) => (o.raw ?? "").length >= OPC_RAW_STORED_MAX - 1;

  const unreturned: OpcAudit["unreturned"] = [];
  const unpaired: OpcAudit["unpaired"] = [];
  const noRef: OpcAudit["noRef"] = [];
  const unknown: OpcAudit["unknown"] = [];
  const shape = (o: OpcEntity) => ({
    box: o.tag,
    sheet: nameById.get(o.document_id) ?? "Sheet",
    page: o.page,
    // The reviewer sees the whole stored line — the evidence the verdict
    // was decided on, not a shorter slice of it.
    line: o.raw ?? "",
  });

  for (const o of opcRows) {
    const raw = o.raw ?? "";
    // Nothing stored says nothing — about the destination either way.
    if (!raw) { unknown.push(shape(o)); continue; }
    const contract = parseOpcLine(raw);
    const positional = contract ? opcDestinationForms(contract) : [];
    const refs = [...new Set([...positional, ...extractDrawingRefs(raw)])];
    const from = nameById.get(o.document_id) ?? "Sheet";

    // Is there a destination at all? (DWG-4 / DWG-8) A reference read
    // anywhere on the line is one, whatever the field says; so is a sheet of
    // the connector's own drawing.
    if (refs.length === 0 && !contract?.sameDrawing) {
      if (contract) {
        // NONE, or nothing in the field, and no sheet: the connector says it
        // names nowhere to continue. Something in the field that is not a
        // drawing number (or SAME with no sheet): unreadable, never broken.
        if (contract.none || (contract.empty && !mayBeCut(o))) noRef.push(shape(o));
        else unknown.push(shape(o));
      } else {
        (mayBeCut(o) || hasUnreadNumber(raw) ? unknown : noRef).push(shape(o));
      }
      continue;
    }

    // A sheet of this same drawing: that sheet of the number the source's
    // own title block declared.
    const lookups = [...refs];
    if (contract?.sameDrawing) {
      const base = declaredSheetIdentity(selfByDoc.get(o.document_id) ?? []).base;
      if (base) lookups.push(`${base}-SH${contract.sheet}`);
      else unpaired.push({ box: o.tag, from, to: `sheet ${contract.sheet} of its own drawing (whose number was not read)`, line: raw });
    }

    // Box pairing: the box must reappear on the sheet it names.
    const targets = new Set<string>();
    for (const ref of lookups) {
      const owners = identityIndex.get(ref);
      // An ambiguous number identifies a multi-sheet set, not one sheet —
      // never guess which one and report the guess as a defect.
      if (!owners || owners.size !== 1) continue;
      targets.add([...owners][0]);
    }
    for (const target of targets) {
      if (target === o.document_id) continue;
      const entry = { box: o.tag, from, to: nameById.get(target) ?? "Sheet", line: raw };
      const boxes = opcByDoc.get(target);
      // A target with no box numbers read cannot say whether the box comes
      // back — never evidence that it does not.
      if (!boxes) unpaired.push(entry);
      else if (!boxes.has(o.tag)) unreturned.push(entry);
    }
  }

  return { boxCount: opcRows.length, unreturned, unpaired, noRef, unknown };
}
