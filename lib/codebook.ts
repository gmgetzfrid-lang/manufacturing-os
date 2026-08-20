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

/** Canonical tag form: uppercase, single dash between prefix and number,
 *  no internal whitespace. "e 22" / "E–22" / "E-22 " → "E-22". */
export function normalizeTag(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[‐-―−]/g, "-") // unicode dashes → ascii
    .replace(/\s+/g, "")
    .replace(/^([A-Z]+)[-]?(\d)/, "$1-$2");
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

/** Find the equipment type an tag prefix belongs to. Longest-prefix wins so
 *  "EA-101" matches a type with prefix "EA" before one with "E". */
export function typeForTag(tag: string, book: Codebook): CodebookEntry | null {
  const parts = splitTag(tag);
  if (!parts) return null;
  let best: CodebookEntry | null = null;
  let bestLen = 0;
  for (const t of book.equipmentTypes) {
    for (const p of t.meta.tagPrefixes ?? []) {
      const up = p.toUpperCase();
      if (parts.prefix === up && up.length > bestLen) { best = t; bestLen = up.length; }
    }
  }
  return best;
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
  const { mirrorsTag, padTo } = book.iterableRule;
  if (!mirrorsTag) return null; // non-mirroring schemes need per-asset codes, not derivation
  const n = String(parseInt(parts.number, 10)); // canonical: strip leading zeros first…
  const padded = padTo > 0 ? n.padStart(padTo, "0") : n; // …then apply the org's padding
  return `${unitCode}${type.code}.${padded}${parts.suffix}`;
}

/** Invert a site code back to a tag: "2030.22" → {tag:"E-22", unitCode:"20"}.
 *  Unit and type codes are matched longest-first against the codebook, so
 *  overlapping code sets ("2" and "20") resolve deterministically. */
export function codeToTag(code: string, book: Codebook): { tag: string; unitCode: string; typeCode: string } | null {
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
    const prefix = (type.meta.tagPrefixes ?? [])[0];
    if (!prefix) continue;
    const n = String(parseInt(iterable, 10));
    return { tag: `${prefix.toUpperCase()}-${n}${suffix}`, unitCode: unit.code, typeCode };
  }
  return null;
}

/** Parse a drawing number against the org's segment map. Tolerant by design:
 *  separators (dash, dot, underscore, space, slash) between segments are
 *  skipped, sheet markers (SHT / SH / SHEET / S.) are recognized, case is
 *  ignored, and trailing segments may be absent ("2002-D-10001" with a
 *  sheet segment configured still parses — sheet comes back null). Returns
 *  null only when a REQUIRED leading segment can't be satisfied. */
export function parseDrawingNumber(raw: string, book: Codebook): ParsedDrawingNumber | null {
  const config = book.drawingNumber;
  if (!config || config.segments.length === 0) return null;
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
    if (segment.kind === "sheet") skipSheetMarker(); else skipSeparators();
    if (i >= s.length) {
      // Ran out of input. Leading identity segments are required; trailing
      // iterable/sheet are allowed to be absent.
      const required = segment.kind === "unit" || segment.kind === "drawing_type" || segment.kind === "size";
      return required ? null : out;
    }
    switch (segment.kind) {
      case "unit":
      case "drawing_type": {
        const width = segment.digits ?? 2;
        const chunk = s.slice(i, i + width);
        if (!new RegExp(`^\\d{${width}}$`).test(chunk)) return null;
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
        if (!new RegExp(`^[A-Z]{${width}}$`).test(chunk)) return null;
        out.size = chunk;
        i += width;
        break;
      }
      case "iterable": {
        const m = s.slice(i).match(/^\d+/);
        if (!m) return out; // optional tail
        out.iterable = m[0];
        i += m[0].length;
        break;
      }
      case "sheet": {
        const m = s.slice(i).match(/^\d+/);
        if (!m) return out; // optional tail
        out.sheet = String(parseInt(m[0], 10));
        i += m[0].length;
        break;
      }
    }
  }
  return out;
}

// ─── Import merge (AI-assisted codebook building) ───────────────────────────

export interface ProposedEntry {
  kind: CodebookKind;
  code: string;
  label: string;
  tagPrefixes?: string[];
}

export interface ImportDiff {
  adds: ProposedEntry[];
  /** Proposed rows whose code exists but whose label/prefixes differ. */
  changes: Array<{ existing: CodebookEntry; proposed: ProposedEntry }>;
  unchanged: ProposedEntry[];
}

/** Diff an AI-import proposal against the current codebook. Pure — the UI
 *  renders this and the user decides; nothing is applied here. Manual edits
 *  can never be steamrolled because "apply" only ever writes rows the user
 *  accepted from this diff. */
export function diffImport(existing: CodebookEntry[], proposed: ProposedEntry[]): ImportDiff {
  const byKey = new Map(existing.map((e) => [`${e.kind}:${e.code}`, e]));
  const out: ImportDiff = { adds: [], changes: [], unchanged: [] };
  const seen = new Set<string>();
  for (const p of proposed) {
    const code = String(p.code).trim();
    const label = String(p.label).trim();
    if (!code || !label) continue;
    const key = `${p.kind}:${code}`;
    if (seen.has(key)) continue; // AI duplicates collapse
    seen.add(key);
    const clean: ProposedEntry = { kind: p.kind, code, label, tagPrefixes: p.tagPrefixes?.map((x) => x.trim().toUpperCase()).filter(Boolean) };
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

export async function upsertEntry(orgId: string, entry: Omit<CodebookEntry, "id"> & { id?: string }, userId: string): Promise<void> {
  const row = {
    org_id: orgId, kind: entry.kind, code: entry.code.trim(), label: entry.label.trim(),
    meta: entry.meta ?? {}, sort: entry.sort ?? 0, origin: entry.origin ?? "manual",
    created_by: userId, updated_at: new Date().toISOString(),
  };
  const { error } = entry.id
    ? await supabase.from("codebook_entries").update(row).eq("id", entry.id)
    : await supabase.from("codebook_entries").upsert(row, { onConflict: "org_id,kind,code" });
  if (error) throw new Error(error.message);
}

export async function deleteEntry(id: string): Promise<void> {
  const { error } = await supabase.from("codebook_entries").delete().eq("id", id);
  if (error) throw new Error(error.message);
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
  const { error: upErr } = await supabase
    .from("codebook_entries")
    .update({ meta, updated_at: new Date().toISOString() })
    .eq("id", data.id as string);
  if (upErr) throw new Error(upErr.message);
}

/** Bind (or unbind, with null) an operating area's knowledge library —
 *  read-modify-write on the unit's meta, same contract as saveUnitLinks. */
export async function setUnitKnowledgeLibrary(
  orgId: string, unitCode: string, knowledgeLibraryId: string | null,
): Promise<void> {
  const { data, error } = await supabase
    .from("codebook_entries").select("id, meta")
    .eq("org_id", orgId).eq("kind", "unit").eq("code", unitCode).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Unit ${unitCode} isn't in the Site Codebook.`);
  const meta = { ...((data.meta as Record<string, unknown>) ?? {}) };
  if (knowledgeLibraryId) meta.knowledgeLibraryId = knowledgeLibraryId;
  else delete meta.knowledgeLibraryId;
  const { error: upErr } = await supabase
    .from("codebook_entries")
    .update({ meta, updated_at: new Date().toISOString() })
    .eq("id", data.id as string);
  if (upErr) throw new Error(upErr.message);
}

export async function saveConfig(orgId: string, patch: {
  drawingNumber?: DrawingNumberConfig | null;
  iterableRule?: IterableRule;
  legendDocIds?: string[];
}, userId: string): Promise<void> {
  const row: Record<string, unknown> = { org_id: orgId, updated_by: userId, updated_at: new Date().toISOString() };
  if (patch.drawingNumber !== undefined) row.drawing_number = patch.drawingNumber ?? {};
  if (patch.iterableRule !== undefined) row.iterable_rule = patch.iterableRule;
  if (patch.legendDocIds !== undefined) row.legend_doc_ids = patch.legendDocIds;
  const { error } = await supabase.from("codebook_config").upsert(row, { onConflict: "org_id" });
  if (error) throw new Error(error.message);
}

/** Apply accepted rows from an import diff. Only writes what the user
 *  accepted; origin marks them as imported (display-only). */
export async function applyImport(orgId: string, accepted: ProposedEntry[], userId: string): Promise<number> {
  let written = 0;
  for (const p of accepted) {
    await upsertEntry(orgId, {
      kind: p.kind, code: p.code, label: p.label,
      meta: p.kind === "equipment_type" ? { tagPrefixes: p.tagPrefixes ?? [] } : {},
      sort: 0, origin: "import",
    }, userId);
    written++;
  }
  return written;
}
