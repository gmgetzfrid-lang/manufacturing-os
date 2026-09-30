// lib/codebook.ts — the Site Codebook: the org-defined language of the site.
//
// A refinery (or any plant) encodes meaning into numbers: units ("20" =
// Crude), equipment types ("30" = Exchangers, tag prefix E), drawing types
// ("02" = P&ID), and composes them — the exchanger E-22 in the crude unit is
// "2030.22"; its P&ID is "2002-D-10001 SHT.4". Every site does this
// DIFFERENTLY, so none of it is hard-coded: this module stores what one org
// teaches it and exposes a pure codec over that teaching. An empty codebook
// makes every function degrade to "no opinion" (null / passthrough) — the
// app must work fine with no codebook at all.
//
// Consumers: the knowledge AI decoder (default standing instructions), the
// drafting request forms (unit selects), the equipment registry (unit-first
// browsing + dual identity), and the drawing→equipment bridge
// (lib/equipmentBridge.ts).
//
// Everything under "PURE CODEC" is side-effect free and unit-tested in
// lib/__tests__/codebook.test.ts — that's where the edge cases live.

import { supabase } from "@/lib/supabase";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CodebookKind = "unit" | "equipment_type" | "drawing_type";

/** A library (or one folder of it) pinned to an operating unit — "the crude
 *  unit's P&IDs live here". Pure org data on the unit's codebook entry, so
 *  every site wires its own structure and an unset unit simply has none. */
export interface UnitResourceLink {
  id: string;
  /** What this is to the unit ("P&IDs", "Operating manuals", "Unit data"). */
  label: string;
  libraryId: string;
  libraryName: string;
  folderId?: string | null;
  folderName?: string | null;
}

export interface CodebookEntry {
  id: string;
  kind: CodebookKind;
  /** The site's code for the item ("20", "30", "02"). Kept as TEXT — leading
   *  zeros are meaningful ("02" ≠ "2"). */
  code: string;
  label: string;
  /** kind-specific extras. equipment_type: tagPrefixes (["E"] or ["EA","E"]).
   *  unit: links (libraries/folders pinned to the unit's hub page). */
  meta: {
    tagPrefixes?: string[];
    links?: UnitResourceLink[];
    /** unit: the AI knowledge library bound to this operating area — the
     *  shelf its drawings feed and its questions answer from. */
    knowledgeLibraryId?: string;
  };
  sort: number;
  origin: "manual" | "import";
}

/** One piece of a drawing number, in order. Separators between segments
 *  (dashes, dots, spaces, "SHT" markers) are tolerated automatically. */
export interface DrawingSegment {
  kind: "unit" | "drawing_type" | "size" | "iterable" | "sheet";
  /** For unit / drawing_type: exact digit count ("20" + "02" → 2 + 2). */
  digits?: number;
  /** For size: exact letter count (paper size "D" → 1). */
  letters?: number;
}

export interface DrawingNumberConfig {
  segments: DrawingSegment[];
}

export interface IterableRule {
  /** True (the common case): the code iterable mirrors the tag's number —
   *  E-22 → .22. */
  mirrorsTag: boolean;
  /** Zero-pad the iterable to this width (0 = no padding). P-5 with padTo 2
   *  → .05; padTo 0 → .5. */
  padTo: number;
}

export interface Codebook {
  units: CodebookEntry[];
  equipmentTypes: CodebookEntry[];
  drawingTypes: CodebookEntry[];
  drawingNumber: DrawingNumberConfig | null;
  iterableRule: IterableRule;
  legendDocIds: string[];
}

export const EMPTY_CODEBOOK: Codebook = {
  units: [], equipmentTypes: [], drawingTypes: [],
  drawingNumber: null,
  iterableRule: { mirrorsTag: true, padTo: 0 },
  legendDocIds: [],
};

export interface ParsedDrawingNumber {
  unitCode: string | null;
  unitLabel: string | null;
  drawingTypeCode: string | null;
  drawingTypeLabel: string | null;
  size: string | null;
  iterable: string | null;
  sheet: string | null;
}

// ─── PURE CODEC ─────────────────────────────────────────────────────────────

/** Canonical tag SPELLING: uppercase, single dash between prefix and number,
 *  no internal whitespace. "e 22" / "E–22" / "E-22 " → "E-22". This is how a
 *  tag is displayed and what the codec parses (splitTag / typeForTag /
 *  tagToCode). It is NOT an identity key — two spellings that differ only in
 *  punctuation ("NORTH-FURNACE" vs "NORTHFURNACE") stay distinct here. Every
 *  identity column (assets.tag_normalized, asset_aliases.alias_normalized)
 *  and every identity lookup uses `tagKey` below. */
export function normalizeTag(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[‐-―−]/g, "-") // unicode dashes → ascii
    .replace(/\s+/g, "")
    .replace(/^([A-Z]+)[-]?(\d)/, "$1-$2");
}

/** GAP-310 / CB-9 — THE one tag grammar: the identity key of a tag or an
 *  alias. Lowercase, everything but [a-z0-9] removed: "E-22", "E22",
 *  "e 22", "E–22" → "e22"; "the north furnace" / "North-Furnace" →
 *  "thenorthfurnace". Punctuation- and case-blind by design, and exactly the
 *  database's `normalize_tag()` (20260609) for ASCII input, so a key
 *  computed here matches a key computed by a trigger.
 *
 *  It is the projection of the canonical spelling: tagKey(normalizeTag(x))
 *  === tagKey(x), and splitTag(tagKey(x)) agrees with splitTag(x) whenever
 *  the latter places the tag — so the key round-trips through the codec.
 *  lib/assets.ts `normalizeTag` and lib/documentTags.ts `normalizeTag` are
 *  re-exports of this function; lib/__tests__/codebook.test.ts pins every
 *  call site to one table of awkward inputs. */
export function tagKey(raw: string): string {
  return (raw || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Split a normalized tag into prefix / number / suffix.
 *  "E-22" → {prefix:"E", number:"22", suffix:""}
 *  "P-101A" → {prefix:"P", number:"101", suffix:"A"}
 *  Returns null for things that aren't shaped like equipment tags. */
export function splitTag(tag: string): { prefix: string; number: string; suffix: string } | null {
  const m = normalizeTag(tag).match(/^([A-Z]{1,4})-(\d{1,6})([A-Z]{0,2})$/);
  if (!m) return null;
  return { prefix: m[1], number: m[2], suffix: m[3] };
}

/** Every equipment type that claims this tag's prefix. The prefix is the
 *  tag's whole letter run ("EA-101" → "EA"), so "EA" and "E" never compete;
 *  two entries here means two types registered the SAME prefix (CB-8). */
export function typeCandidatesForTag(tag: string, book: Codebook): CodebookEntry[] {
  const parts = splitTag(tag);
  if (!parts) return [];
  return book.equipmentTypes.filter((t) =>
    (t.meta.tagPrefixes ?? []).some((p) => p.trim().toUpperCase() === parts.prefix));
}

/** Find the equipment type an tag prefix belongs to. The prefix is matched
 *  whole, so "EA-101" matches a type with prefix "EA", never one with "E".
 *  CB-8: when two types claim the same prefix the answer is AMBIGUOUS and
 *  this returns null — never a silent first-by-sort pick (reordering rows
 *  would re-type the plant). typeCandidatesForTag names the contenders. */
export function typeForTag(tag: string, book: Codebook): CodebookEntry | null {
  const candidates = typeCandidatesForTag(tag, book);
  return candidates.length === 1 ? candidates[0] : null;
}

/** CB-3 — the one shape guard for codebook codes. Units and equipment types
 *  are composed into site codes digit by digit ("20" + "30" → "2030.22") and
 *  inverted the same way, so a letter code is write-only: derivable, never
 *  invertible, never decodable from a drawing number. Returns why a code is
 *  unusable, or null. Leading zeros are meaningful ("02" ≠ "2"). */
export function codeProblem(kind: CodebookKind, code: string): string | null {
  const c = String(code ?? "").trim();
  if (!c) return "A code is required.";
  if (c.length > 6) return `Code "${c}" is longer than 6 characters.`;
  if ((kind === "unit" || kind === "equipment_type") && !/^\d{1,6}$/.test(c)) {
    const what = kind === "unit" ? "Unit" : "Equipment-type";
    return `${what} code "${c}" is not numeric — site codes are composed from digits (20 + 30 → 2030.22), so a letter code can never be decoded back.`;
  }
  return null;
}

export function isValidCode(kind: CodebookKind, code: string): boolean {
  return codeProblem(kind, code) === null;
}

/** CB-8 — the prefixes a would-be equipment type shares with OTHER types
 *  (matched by code; an entry never conflicts with itself). */
export function prefixClaimsElsewhere(
  types: ReadonlyArray<Pick<CodebookEntry, "code" | "label" | "meta">>,
  candidate: { code: string; tagPrefixes?: string[] },
): Array<{ prefix: string; code: string; label: string }> {
  const out: Array<{ prefix: string; code: string; label: string }> = [];
  const mine = new Set((candidate.tagPrefixes ?? []).map((p) => p.trim().toUpperCase()).filter(Boolean));
  for (const t of types) {
    if (t.code.trim() === candidate.code.trim()) continue;
    for (const p of t.meta.tagPrefixes ?? []) {
      const up = p.trim().toUpperCase();
      if (mine.has(up)) out.push({ prefix: up, code: t.code, label: t.label });
    }
  }
  return out;
}

/** Compose a full site code from a tag + unit: E-22 in unit "20" (type "30")
 *  → "2030.22". Alpha suffixes ride along ("P-101A" → "2030.101A" style).
 *  Null when the codebook can't place the tag (unknown prefix, no unit). */
export function tagToCode(tag: string, unitCode: string | null | undefined, book: Codebook): string | null {
  if (!unitCode) return null;
  const parts = splitTag(tag);
  if (!parts) return null;
  const type = typeForTag(tag, book);
  if (!type) return null;
  // CB-3: a letter unit or type code would mint a code nothing can invert
  // ("CU30.22") — decline instead of writing an undecodable identity.
  if (!/^\d+$/.test(unitCode) || !/^\d+$/.test(type.code)) return null;
  const { mirrorsTag, padTo } = book.iterableRule;
  if (!mirrorsTag) return null; // non-mirroring schemes need per-asset codes, not derivation
  const n = String(parseInt(parts.number, 10)); // canonical: strip leading zeros first…
  const padded = padTo > 0 ? n.padStart(padTo, "0") : n; // …then apply the org's padding
  return `${unitCode}${type.code}.${padded}${parts.suffix}`;
}

/** A decoded site code. `candidates` is every tag the code can stand for:
 *  one per tag prefix of the type. CB-10: a site code encodes the TYPE, not
 *  the prefix, so a type registered with two prefixes (Vessels: V, D) maps
 *  V-1 and D-1 to the same code — the inverse cannot know which, and says so
 *  (`tag` null, `ambiguous` true) instead of silently renaming D-1 to V-1.
 *  The unit is certain either way. */
export interface DecodedSiteCode {
  tag: string | null;
  unitCode: string;
  typeCode: string;
  candidates: string[];
  ambiguous: boolean;
}

/** Invert a site code back to a tag: "2030.22" → {tag:"E-22", unitCode:"20"}.
 *  Unit and type codes are matched longest-first against the codebook, so
 *  overlapping code sets ("2" and "20") resolve deterministically. */
export function codeToTag(code: string, book: Codebook): DecodedSiteCode | null {
  const m = String(code).trim().match(/^(\d+)\.(\d+)([A-Za-z]{0,2})$/);
  if (!m) return null;
  const head = m[1];
  const iterable = m[2];
  const suffix = m[3].toUpperCase();
  const unitsByLen = [...book.units].sort((a, b) => b.code.length - a.code.length);
  for (const unit of unitsByLen) {
    if (!head.startsWith(unit.code)) continue;
    const typeCode = head.slice(unit.code.length);
    const type = book.equipmentTypes.find((t) => t.code === typeCode);
    if (!type) continue;
    const prefixes = [...new Set((type.meta.tagPrefixes ?? []).map((p) => p.trim().toUpperCase()).filter(Boolean))];
    if (prefixes.length === 0) continue;
    const n = String(parseInt(iterable, 10));
    const candidates = prefixes.map((p) => `${p}-${n}${suffix}`);
    return {
      tag: candidates.length === 1 ? candidates[0] : null,
      unitCode: unit.code, typeCode, candidates, ambiguous: candidates.length > 1,
    };
  }
  return null;
}

/** CB-10 — tags that derive the SAME site code (the codec is not injective
 *  across a type's prefixes, or across leading zeros: E-022 / E-22). Pure;
 *  the registry refuses the second asset at the database
 *  (assets_org_code_unique, 20261128) and this names the pair beforehand. */
export function siteCodeCollisions(
  rows: ReadonlyArray<{ id: string; tag: string; unitCode: string | null | undefined }>,
  book: Codebook,
): Array<{ code: string; ids: string[]; tags: string[] }> {
  const byCode = new Map<string, { ids: string[]; tags: string[] }>();
  for (const r of rows) {
    const code = tagToCode(r.tag, r.unitCode, book);
    if (!code) continue;
    const g = byCode.get(code) ?? { ids: [], tags: [] };
    g.ids.push(r.id); g.tags.push(r.tag);
    byCode.set(code, g);
  }
  return [...byCode.entries()].filter(([, g]) => g.ids.length > 1).map(([code, g]) => ({ code, ...g }));
}

export interface CodebookProblem {
  kind: "non_numeric_code" | "shared_prefix" | "multi_prefix_type";
  /** The codebook entries involved (ids). */
  entryIds: string[];
  message: string;
}

/** Everything in a loaded codebook that makes the codec degrade silently —
 *  reported, never repaired (CB-3 letter codes, CB-8 a prefix claimed by
 *  two types, CB-10 a type whose prefixes share one number space). Pure;
 *  the admin codebook page renders it. */
export function codebookProblems(book: Codebook): CodebookProblem[] {
  const out: CodebookProblem[] = [];
  for (const e of [...book.units, ...book.equipmentTypes]) {
    const why = codeProblem(e.kind, e.code);
    // CB-3: a legacy letter code stays usable for everything but decoding
    // (label, pinned libraries, knowledge binding); its code is replaced by
    // adding the digit code, refiling the equipment, then removing this one.
    if (why) out.push({ kind: "non_numeric_code", entryIds: [e.id], message: `${why} Nothing is decoded for ${e.label}. To replace it: add a digit code for ${e.label}, refile its equipment there, then remove ${e.code}.` });
  }
  const byPrefix = new Map<string, CodebookEntry[]>();
  for (const t of book.equipmentTypes) {
    for (const p of new Set((t.meta.tagPrefixes ?? []).map((x) => x.trim().toUpperCase()).filter(Boolean))) {
      byPrefix.set(p, [...(byPrefix.get(p) ?? []), t]);
    }
  }
  for (const [prefix, types] of byPrefix) {
    if (types.length < 2) continue;
    out.push({
      kind: "shared_prefix", entryIds: types.map((t) => t.id),
      message: `Prefix ${prefix}- is claimed by ${types.map((t) => `${t.code} ${t.label}`).join(" and ")} — ${prefix}- tags are left uncategorized and uncoded until one type gives it up.`,
    });
  }
  for (const t of book.equipmentTypes) {
    const px = [...new Set((t.meta.tagPrefixes ?? []).map((x) => x.trim().toUpperCase()).filter(Boolean))];
    if (px.length < 2) continue;
    out.push({
      kind: "multi_prefix_type", entryIds: [t.id],
      message: `${t.code} ${t.label} has prefixes ${px.join(", ")} sharing one number space: ${px.map((p) => `${p}-1`).join(" and ")} derive the same site code, and the registry holds only one of them per unit.`,
    });
  }
  return out;
}

/** Parse a drawing number against the org's segment map. Tolerant by design:
 *  separators (dash, dot, underscore, space, slash) between segments are
 *  skipped, sheet markers (SHT / SH / SHEET / S.) are recognized, case is
 *  ignored, and trailing segments may be absent ("2002-D-10001" with a
 *  sheet segment configured still parses — sheet comes back null). Returns
 *  null only when a REQUIRED leading segment can't be satisfied. */
export function parseDrawingNumber(raw: string, book: Codebook): ParsedDrawingNumber | null {
  return decodeDrawingNumber(raw, book).parsed;
}

const SEGMENT_NAMES: Record<DrawingSegment["kind"], string> = {
  unit: "unit", drawing_type: "drawing type", size: "paper size", iterable: "number", sheet: "sheet",
};

/** CB-3 — why a drawing number does not decode, in words ("segment 1 (unit,
 *  2 digits) expected digits but found "CU""), plus the codebook's own part
 *  in it (a unit code that is not numeric can never be matched). Null when
 *  it decodes. The live preview shows this instead of a bare "doesn't match". */
export function explainDrawingNumberMiss(raw: string, book: Codebook): string | null {
  const { parsed, reason } = decodeDrawingNumber(raw, book);
  if (parsed) return null;
  const letterUnits = book.units.filter((u) => !/^\d+$/.test(u.code)).map((u) => u.code);
  const note = letterUnits.length > 0
    ? ` Unit code${letterUnits.length === 1 ? "" : "s"} ${letterUnits.map((c) => `"${c}"`).join(", ")} ${letterUnits.length === 1 ? "is" : "are"} not numeric, so no drawing number can ever decode to ${letterUnits.length === 1 ? "it" : "them"}.`
    : "";
  return `${reason ?? "Doesn't match the segments."}${note}`;
}

function decodeDrawingNumber(raw: string, book: Codebook): { parsed: ParsedDrawingNumber | null; reason: string | null } {
  const config = book.drawingNumber;
  if (!config || config.segments.length === 0) return { parsed: null, reason: "No drawing-number segments are configured." };
  const miss = (reason: string) => ({ parsed: null, reason });
  const s = String(raw).toUpperCase().trim();
  const out: ParsedDrawingNumber = {
    unitCode: null, unitLabel: null, drawingTypeCode: null, drawingTypeLabel: null,
    size: null, iterable: null, sheet: null,
  };

  let i = 0;
  const skipSeparators = () => { while (i < s.length && /[-_.\s/]/.test(s[i])) i++; };
  const skipSheetMarker = () => {
    skipSeparators();
    const rest = s.slice(i);
    const m = rest.match(/^(SHEET|SHT|SH|S)\.?\s*/);
    // Only treat a leading letter-run as a marker when digits follow it —
    // otherwise "S" could eat part of a real segment.
    if (m && /\d/.test(rest.slice(m[0].length, m[0].length + 1))) i += m[0].length;
  };

  for (let seg = 0; seg < config.segments.length; seg++) {
    const segment = config.segments[seg];
    const name = `Segment ${seg + 1} (${SEGMENT_NAMES[segment.kind]})`;
    if (segment.kind === "sheet") skipSheetMarker(); else skipSeparators();
    if (i >= s.length) {
      // Ran out of input. Leading identity segments are required; trailing
      // iterable/sheet are allowed to be absent.
      const required = segment.kind === "unit" || segment.kind === "drawing_type" || segment.kind === "size";
      return required ? miss(`The number ends before ${name.toLowerCase()}.`) : { parsed: out, reason: null };
    }
    switch (segment.kind) {
      case "unit":
      case "drawing_type": {
        const width = segment.digits ?? 2;
        const chunk = s.slice(i, i + width);
        if (!new RegExp(`^\\d{${width}}$`).test(chunk)) {
          return miss(`${name} expects ${width} digit${width === 1 ? "" : "s"} but found "${chunk}".`);
        }
        i += width;
        if (segment.kind === "unit") {
          out.unitCode = chunk;
          out.unitLabel = book.units.find((u) => u.code === chunk)?.label ?? null;
        } else {
          out.drawingTypeCode = chunk;
          out.drawingTypeLabel = book.drawingTypes.find((d) => d.code === chunk)?.label ?? null;
        }
        break;
      }
      case "size": {
        const width = segment.letters ?? 1;
        const chunk = s.slice(i, i + width);
        if (!new RegExp(`^[A-Z]{${width}}$`).test(chunk)) {
          return miss(`${name} expects ${width} letter${width === 1 ? "" : "s"} but found "${chunk}".`);
        }
        out.size = chunk;
        i += width;
        break;
      }
      case "iterable": {
        const m = s.slice(i).match(/^\d+/);
        if (!m) return { parsed: out, reason: null }; // optional tail
        out.iterable = m[0];
        i += m[0].length;
        break;
      }
      case "sheet": {
        const m = s.slice(i).match(/^\d+/);
        if (!m) return { parsed: out, reason: null }; // optional tail
        out.sheet = String(parseInt(m[0], 10));
        i += m[0].length;
        break;
      }
    }
  }
  return { parsed: out, reason: null };
}

// ─── Import merge (AI-assisted codebook building) ───────────────────────────

export interface ProposedEntry {
  kind: CodebookKind;
  code: string;
  label: string;
  tagPrefixes?: string[];
  /** CB-3: set by the import route's cleaner when the code fails the shape
   *  guard — the row is shown flagged and can never be applied. */
  problem?: string;
}

export interface ImportDiff {
  adds: ProposedEntry[];
  /** Proposed rows whose code exists but whose label/prefixes differ. */
  changes: Array<{ existing: CodebookEntry; proposed: ProposedEntry }>;
  unchanged: ProposedEntry[];
  /** CB-3 / CB-8: rows that can never be applied — a code that fails the
   *  shape guard, or a tag prefix another equipment type already claims.
   *  Shown flagged with the reason; never checked, never written. */
  rejected: Array<{ proposed: ProposedEntry; reason: string }>;
}

/** Diff an AI-import proposal against the current codebook. Pure — the UI
 *  renders this and the user decides; nothing is applied here. Manual edits
 *  can never be steamrolled because "apply" only ever writes rows the user
 *  accepted from this diff. */
export function diffImport(existing: CodebookEntry[], proposed: ProposedEntry[]): ImportDiff {
  const byKey = new Map(existing.map((e) => [`${e.kind}:${e.code}`, e]));
  const out: ImportDiff = { adds: [], changes: [], unchanged: [], rejected: [] };
  const seen = new Set<string>();
  // Prefix claims as they will stand after applying: existing types, then
  // each accepted proposal in order (a proposal for an existing code
  // replaces that type's claims).
  const claims = existing.filter((e) => e.kind === "equipment_type")
    .map((e) => ({ code: e.code, label: e.label, meta: { tagPrefixes: e.meta.tagPrefixes ?? [] } }));
  for (const p of proposed) {
    const code = String(p.code).trim();
    const label = String(p.label).trim();
    if (!code || !label) continue;
    const key = `${p.kind}:${code}`;
    if (seen.has(key)) continue; // AI duplicates collapse
    seen.add(key);
    const clean: ProposedEntry = { kind: p.kind, code, label, tagPrefixes: p.tagPrefixes?.map((x) => x.trim().toUpperCase()).filter(Boolean) };
    const shape = p.problem ?? codeProblem(p.kind, code);
    if (shape) { out.rejected.push({ proposed: clean, reason: shape }); continue; }
    if (clean.kind === "equipment_type") {
      const clash = prefixClaimsElsewhere(claims, { code, tagPrefixes: clean.tagPrefixes });
      if (clash.length > 0) {
        out.rejected.push({
          proposed: clean,
          reason: clash.map((c) => `prefix ${c.prefix} is already claimed by ${c.code} ${c.label}`).join("; "),
        });
        continue;
      }
      const idx = claims.findIndex((c) => c.code === code);
      const next = { code, label, meta: { tagPrefixes: clean.tagPrefixes ?? [] } };
      if (idx >= 0) claims[idx] = next; else claims.push(next);
    }
    const ex = byKey.get(key);
    if (!ex) { out.adds.push(clean); continue; }
    const prefixesDiffer = clean.kind === "equipment_type" &&
      JSON.stringify([...(clean.tagPrefixes ?? [])].sort()) !== JSON.stringify([...(ex.meta.tagPrefixes ?? [])].sort());
    if (ex.label !== clean.label || prefixesDiffer) out.changes.push({ existing: ex, proposed: clean });
    else out.unchanged.push(clean);
  }
  return out;
}

// ─── Data access ────────────────────────────────────────────────────────────

function rowToEntry(r: Record<string, unknown>): CodebookEntry {
  return {
    id: String(r.id),
    kind: r.kind as CodebookKind,
    code: String(r.code),
    label: String(r.label),
    meta: (r.meta as CodebookEntry["meta"]) ?? {},
    sort: Number(r.sort ?? 0),
    origin: (r.origin as "manual" | "import") ?? "manual",
  };
}

/** Load the whole codebook in one round trip pair. Resilient: a missing
 *  migration (table not found) returns EMPTY_CODEBOOK instead of throwing so
 *  every consumer keeps working pre-migration. */
export async function loadCodebook(orgId: string): Promise<Codebook> {
  try {
    const [entriesRes, configRes] = await Promise.all([
      supabase.from("codebook_entries").select("*").eq("org_id", orgId).order("sort").order("code"),
      supabase.from("codebook_config").select("*").eq("org_id", orgId).maybeSingle(),
    ]);
    if (entriesRes.error) return EMPTY_CODEBOOK;
    const entries = ((entriesRes.data ?? []) as Array<Record<string, unknown>>).map(rowToEntry);
    const cfg = configRes.data as Record<string, unknown> | null;
    const dn = (cfg?.drawing_number ?? null) as DrawingNumberConfig | null;
    return {
      units: entries.filter((e) => e.kind === "unit"),
      equipmentTypes: entries.filter((e) => e.kind === "equipment_type"),
      drawingTypes: entries.filter((e) => e.kind === "drawing_type"),
      drawingNumber: dn && Array.isArray(dn.segments) && dn.segments.length > 0 ? dn : null,
      iterableRule: {
        mirrorsTag: (cfg?.iterable_rule as IterableRule | undefined)?.mirrorsTag ?? true,
        padTo: (cfg?.iterable_rule as IterableRule | undefined)?.padTo ?? 0,
      },
      legendDocIds: Array.isArray(cfg?.legend_doc_ids) ? (cfg?.legend_doc_ids as string[]) : [],
    };
  } catch {
    return EMPTY_CODEBOOK;
  }
}

// CB-4 / IRLS-10: every codebook write asks for its row back. RLS (the
// additive controller bar, 20261046) refuses an UPDATE/DELETE with ZERO rows
// and no error — a refused edit must read as a refusal, never a green save.
const CODEBOOK_REFUSED = "Not saved — only Admin or Document Control can edit the Site Codebook.";

function codebookWriteError(err: { code?: string; message: string }): Error {
  // CB-5: the database refuses to remove (or re-code) a unit / type that
  // registry equipment or a process flow still references (20261128
  // codebook_entries_guard_in_use) and says how many.
  if (/codebook_entries_in_use/.test(err.message)) {
    const what = err.message.replace(/^[\s\S]*?codebook_entries_in_use:\s*/, "").trim();
    return new Error(`Refused — ${what}. A code still in use cannot be removed or changed: refile them first (Operating areas).`);
  }
  if (err.code === "23514" || /codebook_entries_code_digits/.test(err.message)) {
    return new Error("Unit and equipment-type codes are digits — the database refused a letter code (CB-3).");
  }
  if (err.code === "42501") return new Error(CODEBOOK_REFUSED);
  return new Error(err.message);
}

export async function upsertEntry(orgId: string, entry: Omit<CodebookEntry, "id"> & { id?: string }, userId: string): Promise<void> {
  // CB-3: the shared shape guard binds a NEW code — a new row, or an edit
  // that changes the code. A legacy letter-coded unit or type already in
  // the book keeps working for everything else (relabel, prefixes, pinned
  // libraries, its knowledge binding): the database's guard (20261128
  // trg_codebook_entries_code_digits) fires on INSERT and on a code change
  // only, and so does this one.
  let storedCode: string | null = null;
  if (entry.id) {
    const { data: stored, error: readErr } = await supabase
      .from("codebook_entries").select("code, kind").eq("id", entry.id).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    const s = stored as { code?: unknown; kind?: unknown } | null;
    if (s && String(s.kind) === entry.kind) storedCode = String(s.code ?? "").trim();
  }
  if (storedCode === null || storedCode !== String(entry.code ?? "").trim()) {
    const problem = codeProblem(entry.kind, entry.code);
    if (problem) throw new Error(problem);
  }
  // CB-8: one prefix, one equipment type — a second claimant would leave
  // every tag with that prefix uncategorized (typeForTag answers ambiguous).
  if (entry.kind === "equipment_type" && (entry.meta?.tagPrefixes ?? []).length > 0) {
    const { data: others, error: readErr } = await supabase
      .from("codebook_entries").select("code, label, meta")
      .eq("org_id", orgId).eq("kind", "equipment_type");
    if (readErr) throw new Error(readErr.message);
    const clash = prefixClaimsElsewhere(
      ((others ?? []) as Array<Record<string, unknown>>).map((r) => ({
        code: String(r.code), label: String(r.label), meta: (r.meta as CodebookEntry["meta"]) ?? {},
      })),
      { code: entry.code, tagPrefixes: entry.meta.tagPrefixes },
    );
    if (clash.length > 0) {
      const c = clash[0];
      throw new Error(`Prefix ${c.prefix}- is already claimed by ${c.code} ${c.label}. Two types on one prefix leave every ${c.prefix}- tag uncategorized — remove it there first.`);
    }
  }
  const row = {
    org_id: orgId, kind: entry.kind, code: entry.code.trim(), label: entry.label.trim(),
    meta: entry.meta ?? {}, sort: entry.sort ?? 0, origin: entry.origin ?? "manual",
    created_by: userId, updated_at: new Date().toISOString(),
  };
  const { data, error } = entry.id
    ? await supabase.from("codebook_entries").update(row).eq("id", entry.id).select("id")
    : await supabase.from("codebook_entries").upsert(row, { onConflict: "org_id,kind,code" }).select("id");
  if (error) throw codebookWriteError(error);
  if (!data || data.length === 0) throw new Error(CODEBOOK_REFUSED);
}

/** CB-5: the database refuses to remove a unit or equipment type that
 *  registry equipment (its filing, or the unit / type part of a stored site
 *  code) or a process flow still references — for EVERY caller, not only
 *  the codebook page (20261128 codebook_entries_guard_in_use); the refusal
 *  arrives here with the counts. The page counts first for a friendlier
 *  message (it also counts tags typed by a type's prefixes). */
export async function deleteEntry(id: string): Promise<void> {
  const { data, error } = await supabase.from("codebook_entries").delete().eq("id", id).select("id");
  if (error) throw codebookWriteError(error);
  if (!data || data.length === 0) throw new Error("Not removed — only Admin or Document Control can edit the Site Codebook.");
}

/** Replace a unit's pinned resource links, preserving everything else in its
 *  meta. Read-modify-write on the one row — links live WITH the unit, so
 *  export/restore and the codebook page carry them for free. */
export async function saveUnitLinks(orgId: string, unitCode: string, links: UnitResourceLink[]): Promise<void> {
  const { data, error } = await supabase
    .from("codebook_entries").select("id, meta")
    .eq("org_id", orgId).eq("kind", "unit").eq("code", unitCode).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Unit ${unitCode} isn't in the Site Codebook.`);
  const meta = { ...((data.meta as Record<string, unknown>) ?? {}), links };
  const { data: updated, error: upErr } = await supabase
    .from("codebook_entries")
    .update({ meta, updated_at: new Date().toISOString() })
    .eq("id", data.id as string)
    .select("id");
  if (upErr) throw codebookWriteError(upErr);
  if (!updated || updated.length === 0) throw new Error(CODEBOOK_REFUSED);
}

// NOTE: binding a unit to its knowledge library happens SERVER-SIDE
// (POST /api/area/knowledge-status), under the same controller bar as the
// rest of the knowledge stack. The codebook RLS write policy reads the role
// COLLECTION since 20261046 (caller_holds_any_role, Admin + DocCtrl — what
// is_org_controller means), and every client write in this file is checked.

export async function saveConfig(orgId: string, patch: {
  drawingNumber?: DrawingNumberConfig | null;
  iterableRule?: IterableRule;
  legendDocIds?: string[];
}, userId: string): Promise<void> {
  const row: Record<string, unknown> = { org_id: orgId, updated_by: userId, updated_at: new Date().toISOString() };
  if (patch.drawingNumber !== undefined) row.drawing_number = patch.drawingNumber ?? {};
  if (patch.iterableRule !== undefined) row.iterable_rule = patch.iterableRule;
  if (patch.legendDocIds !== undefined) row.legend_doc_ids = patch.legendDocIds;
  const { data, error } = await supabase.from("codebook_config").upsert(row, { onConflict: "org_id" }).select("org_id");
  if (error) throw codebookWriteError(error);
  if (!data || data.length === 0) throw new Error(CODEBOOK_REFUSED);
}

/** CB-5: process flows whose endpoint is this unit (process_flows stores a
 *  unit endpoint as the bare codebook code — a deleted unit leaves them
 *  pointing at nothing). Zero before the process-flows migration. */
export async function unitFlowReferenceCount(orgId: string, unitCode: string): Promise<number> {
  let total = 0;
  for (const [kindCol, refCol] of [["from_kind", "from_ref"], ["to_kind", "to_ref"]] as const) {
    const { count, error } = await supabase
      .from("process_flows").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq(kindCol, "unit").eq(refCol, unitCode);
    if (error) {
      if (error.code === "42P01" || /does not exist/i.test(error.message ?? "")) return 0;
      throw new Error(error.message);
    }
    total += count ?? 0;
  }
  return total;
}

/** Apply accepted rows from an import diff. Only writes what the user
 *  accepted; origin marks them as imported (display-only). */
export async function applyImport(orgId: string, accepted: ProposedEntry[], userId: string): Promise<number> {
  let written = 0;
  const refused: string[] = [];
  for (const p of accepted) {
    try {
      await upsertEntry(orgId, {
        kind: p.kind, code: p.code, label: p.label,
        meta: p.kind === "equipment_type" ? { tagPrefixes: p.tagPrefixes ?? [] } : {},
        sort: 0, origin: "import",
      }, userId);
      written++;
    } catch (e) {
      refused.push(`${p.code} ${p.label}: ${(e as Error).message}`);
    }
  }
  // Every row is attempted; a refusal is reported with the count that DID
  // land, never swallowed and never mistaken for a full apply.
  if (refused.length > 0) {
    throw new Error(`Applied ${written} of ${accepted.length}. Not applied — ${refused.slice(0, 3).join(" · ")}${refused.length > 3 ? ` (+${refused.length - 3} more)` : ""}`);
  }
  return written;
}
