// equipmentIdentity - which piece of equipment a label means.
//
// The equipment number (the site ID, 2030.31) is who a piece of equipment
// is. The tag (X-31) is a second name: it repeats from unit to unit, and a
// unit can hold the same tag twice when the drawing reader added a copy.
// So everywhere a label becomes equipment:
//
//   1. "X-31 (2030.31)" is read as tag X-31 with ID 2030.31.
//   2. The ID decides first, plant-wide.
//   3. Else the tag, inside the unit (the ID's unit when one was given).
//   4. Records that are one piece of equipment (the same ID, or the same
//      tag in a unit where it has at most one ID) count once: the one with
//      an ID is shown, then the one with photos.
//   5. Two different pieces (two IDs, or two units) and nothing to tell
//      them apart is no answer, never a guess.
//
// Pure: no database here (lib/assets, lib/slidePictures, the drawing
// reader and the start over plan use it).

import { idKey, nameKey, plainName, sameEquipmentId } from "@/lib/equipmentPick";

/** An ID as the plant writes them: 5530.26, 5516-TV-110. */
export const looksLikeId = (s: string | null | undefined) => /^\d{3,6}(\.[0-9A-Za-z]{1,7}|-[A-Za-z0-9][A-Za-z0-9/.-]{0,15})$/.test(String(s ?? "").trim());

/** An ID an old import saved inside the name ("X-31 (2030.31)"). */
export const idInTag = (tag: string): string | null => {
  const m = String(tag).match(/\(\s*([^)]+?)\s*\)/);
  return m && looksLikeId(m[1]) ? m[1].toUpperCase() : null;
};

export interface EquipmentLabel { tag: string | null; code: string | null }

/** What a label says: "X-31 (2030.31)", "X-31 (2030.31) Charge pump",
 *  "X-31 · 2030.31", "2030.31 X-31", "2030.31" or "X-31". */
export function parseEquipmentLabel(label: string | null | undefined): EquipmentLabel {
  const s = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { tag: null, code: null };
  if (looksLikeId(s)) return { tag: null, code: s.toUpperCase() };
  const paren = s.match(/^(.+?)\s*\(\s*([^)]+?)\s*\)/);
  if (paren && looksLikeId(paren[2])) return { tag: paren[1].trim() || null, code: paren[2].toUpperCase() };
  const dot = s.match(/^([^·|]+?)\s*[·|]\s*(\S+)/);
  if (dot && looksLikeId(dot[2])) return { tag: dot[1].trim() || null, code: dot[2].toUpperCase() };
  const lead = s.match(/^(\S+)\s+(\S+)$/);
  if (lead && looksLikeId(lead[1]) && !looksLikeId(lead[2])) return { tag: lead[2], code: lead[1].toUpperCase() };
  const tag = plainName(s);
  return { tag: tag || null, code: null };
}

/** The one key both spellings of a label share: its ID when it has one,
 *  else its tag. "X-31 (2030.31)" and "2030.31" are one; "X-31" alone is
 *  its tag. */
export function labelKey(label: string | null | undefined, unitCode?: string | null): string {
  const l = parseEquipmentLabel(label);
  if (l.code) return `id:${idKey(l.code)}`;
  return `tag:${unitCode ?? ""}:${nameKey(l.tag)}`;
}

/** A registry row as identity sees it. */
export interface IdentityRecord {
  id: string;
  tag: string;
  code?: string | null;
  unitCode?: string | null;
  origin?: string | null;
  photos?: number;
  files?: number;
  archived?: boolean | null;
  createdAt?: string | null;
}

/** Its ID: the ID column, else one an old import kept in the name. */
export const idOf = (a: Pick<IdentityRecord, "tag" | "code">): string | null => (a.code && a.code.trim() ? a.code.trim() : idInTag(a.tag));

const has = (a: IdentityRecord) => (idKey(idOf(a)) ? 1 : 0);
const manual = (a: IdentityRecord) => (a.origin === "manual" ? 1 : 0);
const live = (a: IdentityRecord) => (a.archived ? 0 : 1);
const older = (a: IdentityRecord, b: IdentityRecord) => String(a.createdAt ?? "9").localeCompare(String(b.createdAt ?? "9")) || a.id.localeCompare(b.id);

/** Which of one piece's records to show: the one with an ID, then the one
 *  with photos, then the one a person added, then not archived, then the
 *  oldest. */
export function lookupOrder(a: IdentityRecord, b: IdentityRecord): number {
  return has(b) - has(a) || (b.photos ?? 0) - (a.photos ?? 0) || manual(b) - manual(a) || live(b) - live(a) || older(a, b);
}

/** Which of one piece's records to keep when they are merged: the one a
 *  person added, then the one with an ID, then photos, then files, then
 *  not archived, then the oldest. */
export function keepOrder(a: IdentityRecord, b: IdentityRecord): number {
  return manual(b) - manual(a) || has(b) - has(a) || (b.photos ?? 0) - (a.photos ?? 0) || (b.files ?? 0) - (a.files ?? 0) || live(b) - live(a) || older(a, b);
}

/** One piece of equipment and every registry record that is it. */
export interface Piece<T> {
  records: T[];
  /** Its ID (idKey form), when one of its records has one. */
  code: string | null;
  units: Array<string | null>;
  /** Its tags, as nameKey. */
  names: string[];
  /** Records with no ID, in a unit where the tag has more than one ID:
   *  nobody can say which piece they are. */
  unsure?: boolean;
}

/** Records grouped into the pieces of equipment they are. The same ID is
 *  one piece, plant-wide. A record with no ID joins the piece of its tag in
 *  its unit when the unit has exactly one ID for that tag; with none, the
 *  unit's records of that tag are one piece; with two or more, they stand
 *  apart, marked unsure. A record with no unit never joins another. */
export function pieces<T extends IdentityRecord>(records: T[]): Array<Piece<T>> {
  const coded = new Map<string, Piece<T>>();
  const loose = new Map<string, T[]>();
  for (const r of records) {
    const k = idKey(idOf(r));
    if (k) {
      const p = coded.get(k) ?? { records: [], code: k, units: [], names: [] };
      p.records.push(r);
      if (!p.units.includes(r.unitCode ?? null)) p.units.push(r.unitCode ?? null);
      if (!p.names.includes(nameKey(r.tag))) p.names.push(nameKey(r.tag));
      coded.set(k, p);
    } else {
      const g = `${r.unitCode ?? ""}|${nameKey(r.tag)}`;
      loose.set(g, [...(loose.get(g) ?? []), r]);
    }
  }
  const out = [...coded.values()];
  for (const group of loose.values()) {
    const unit = group[0].unitCode ?? null;
    const name = nameKey(group[0].tag);
    const fits = unit == null ? [] : [...coded.values()].filter((p) => p.units.includes(unit) && p.names.includes(name));
    if (fits.length === 1) { fits[0].records.push(...group); continue; }
    out.push({ records: group, code: null, units: [unit], names: [name], ...(fits.length > 1 ? { unsure: true } : {}) });
  }
  return out;
}

/** The record to show for each piece these records make. */
export function onePerPiece<T extends IdentityRecord>(records: T[]): T[] {
  return pieces(records).map((p) => [...p.records].sort(lookupOrder)[0]);
}

/** The unit an ID belongs to, among these units: the longest one its
 *  number starts with (2030.31 is unit 20). */
export function unitOfId(code: string, units: Array<string | null | undefined>): string | null {
  const head = code.trim().split(/[.-]/)[0];
  let best: string | null = null;
  for (const u of units) if (u && head.startsWith(u) && head.length > u.length && (!best || u.length > best.length)) best = u;
  return best;
}

export type PickWhy =
  /** Found by its ID. */
  | "id"
  /** Found by its tag (inside the unit when one was known). */
  | "tag"
  /** The tag names more than one piece of equipment. */
  | "ambiguous"
  /** The tag is listed, but with another ID: not this equipment. */
  | "other-id"
  | "none";

export interface PickResult<T> {
  asset: T | null;
  why: PickWhy;
  /** The records it could have been (for saying why not). */
  candidates: T[];
  /** The units those are on. */
  units: Array<string | null>;
}

const unitsOf = <T extends IdentityRecord>(list: T[]) => [...new Set(list.map((a) => a.unitCode ?? null))];

/** The equipment a label means. `unitCode` narrows a tag to one unit (the
 *  project's, the sheet's). */
export function pickEquipment<T extends IdentityRecord>(registry: T[], want: { label?: string | null; tag?: string | null; code?: string | null; unitCode?: string | null }): PickResult<T> {
  const parsed = want.label != null ? parseEquipmentLabel(want.label) : { tag: null, code: null };
  const tag = (want.tag ?? parsed.tag)?.trim() || null;
  const code = (want.code ?? parsed.code)?.trim() || null;
  if (code) {
    const byId = registry.filter((a) => sameEquipmentId(idOf(a), code));
    if (byId.length) return { asset: [...byId].sort(lookupOrder)[0], why: "id", candidates: byId, units: unitsOf(byId) };
  }
  if (!tag || !nameKey(tag)) return { asset: null, why: "none", candidates: [], units: [] };
  const named = registry.filter((a) => nameKey(a.tag) === nameKey(tag) && (!want.unitCode || a.unitCode === want.unitCode));
  const ps = pieces(named);
  // With an ID given, a piece of that tag with another ID is other
  // equipment; one with no ID yet may be it, in the ID's unit.
  const fit = code ? ps.filter((p) => !p.code && p.units.every((u) => !u || unitOfId(code, [u]) != null)) : ps;
  const records = fit.flatMap((p) => p.records);
  if (!fit.length) {
    const other = code ? ps.filter((p) => p.code).flatMap((p) => p.records) : [];
    return other.length ? { asset: null, why: "other-id", candidates: other, units: unitsOf(other) } : { asset: null, why: "none", candidates: [], units: [] };
  }
  if (fit.length === 1 && !fit[0].unsure) return { asset: [...fit[0].records].sort(lookupOrder)[0], why: "tag", candidates: records, units: unitsOf(records) };
  return { asset: null, why: "ambiguous", candidates: records, units: unitsOf(records) };
}

// ─── The drawing reader ───────────────────────────────────────────

export type ReaderMatch<T> =
  /** The ID is listed: this is it, whatever it's called there. */
  | { kind: "same-id"; asset: T }
  /** The tag is in the unit with no ID yet: this is it (a printed ID goes on it). */
  | { kind: "same-tag"; asset: T; fillId: boolean }
  /** The tag is in the unit with another ID. Never a second record. */
  | { kind: "other-id"; asset: T }
  /** The unit has more than one piece with this tag: the ID decides. */
  | { kind: "unsure"; candidates: T[] }
  | { kind: "new" };

/** What the registry already holds for a tag read off a sheet: by its ID
 *  plant-wide, then by its tag inside the sheet's unit. */
export function readerMatch<T extends IdentityRecord>(registry: T[], row: { tag: string; code: string | null; unitCode: string | null }): ReaderMatch<T> {
  if (row.code) {
    const byId = registry.filter((a) => sameEquipmentId(idOf(a), row.code));
    if (byId.length) return { kind: "same-id", asset: [...byId].sort(lookupOrder)[0] };
  }
  if (!row.unitCode) return { kind: "new" };
  const inUnit = registry.filter((a) => a.unitCode === row.unitCode && nameKey(a.tag) === nameKey(row.tag));
  if (!inUnit.length) return { kind: "new" };
  const ps = pieces(inUnit);
  if (ps.length !== 1 || ps[0].unsure) return { kind: "unsure", candidates: inUnit };
  const best = [...ps[0].records].sort(lookupOrder)[0];
  if (ps[0].code) return row.code ? { kind: "other-id", asset: best } : { kind: "same-tag", asset: best, fillId: false };
  return { kind: "same-tag", asset: best, fillId: !!row.code };
}
