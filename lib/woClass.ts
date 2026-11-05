// woClass - the unit and equipment type of each work order, read from the
// site's own numbering (lib/codebook) and kept on the work order's task.
//
// The schedule's Equipment column carries the site code: "5630.06" is unit
// 56 (LRU), type 30 (Exchangers), item 06; "5659-FI-101" is unit 56, type
// 59, FI-101. Decoded against the Site Codebook, that's exact. Without a
// code: the registry equipment it's linked to, then the tag's letters (the
// codebook's tag prefixes, else the usual ones: E exchanger, PSV relief
// valve...); the unit: the project's when it has only one, else the
// registry's, else the project's main unit (its first). What was
// confirmed in Setup (EQUIP_UNIT / EQUIP_TYPE on the task) always wins.
//
// Pure: no database here.

import type { Milestone } from "@/types/schema";
import { splitTag, typeForTag, type Codebook, type CodebookEntry } from "@/lib/codebook";
import { leadTag, tagsIn } from "@/lib/findings";

/** Kept on a work order's task once confirmed in Setup › Unit & equipment. */
export const EQUIP_UNIT = "equipment_unit";
export const EQUIP_TYPE = "equipment_type";

/** Where a unit or type came from, said plainly on screen. */
export type ClassFrom = "saved" | "code" | "registry" | "tag" | "project" | "main";

export interface WoClass {
  unit: string | null;
  unitFrom: ClassFrom | null;
  type: string | null;
  typeFrom: ClassFrom | null;
  /** The site code it was read from, when there was one. */
  code: string | null;
}

export const NO_CLASS: WoClass = { unit: null, unitFrom: null, type: null, typeFrom: null, code: null };

/** A column holding the site's equipment number ("Equipment", "Equip #",
 *  "Equipment No", "Site code"). */
const CODE_KEY = /^\s*(equipment|equip\.?|site|asset)\s*(#|no\.?|num(ber)?|code|id)?\s*$/i;
/** A site code: digits, then ".item" or "-TAG": 5630.06, 5610.01A, 5659-FI-101. */
const CODE_SHAPE = /^(\d{3,6})(?:\.(\d{1,5}[A-Z]{0,2})|-([A-Z]{1,6}-?[A-Z0-9]{1,8}(?:\/[A-Z0-9]{1,4})?))$/i;
const CODE_IN_TEXT = /\b(\d{3,6}(?:\.\d{1,5}[A-Z]{0,2}|-[A-Z]{1,6}-?[A-Z0-9]{1,8}))\b/gi;

export interface DecodedCode {
  code: string;
  unit: string | null;
  type: string | null;
  /** The type is in the codebook. */
  typeKnown: boolean;
}

/** Read a site code against the codebook: the unit, then the type, each
 *  matched longest first. A type the codebook doesn't have yet is kept
 *  (typeKnown false), so it can be added there. Null: not a site code, or
 *  no unit in the codebook starts it. */
export function decodeSiteCode(raw: string | null | undefined, book: Codebook): DecodedCode | null {
  const code = String(raw ?? "").trim().toUpperCase();
  const m = code.match(CODE_SHAPE);
  if (!m || book.units.length === 0) return null;
  const head = m[1];
  const units = [...book.units].sort((a, b) => b.code.length - a.code.length).filter((u) => head.startsWith(u.code) && head.length > u.code.length);
  for (const u of units) {
    const t = head.slice(u.code.length);
    if (book.equipmentTypes.some((x) => x.code === t)) return { code, unit: u.code, type: t, typeKnown: true };
  }
  const u = units[0];
  return u ? { code, unit: u.code, type: head.slice(u.code.length), typeKnown: false } : null;
}

/** The site codes written in a text, once each ("Modify piping from E-2
 *  (5630.12) to V-2 (5610.15)"). */
export function codesIn(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(CODE_IN_TEXT)) { const c = m[1].toUpperCase(); if (!out.includes(c)) out.push(c); }
  return out;
}

/** The site code a task carries in its own column. */
export function codeOf(m: Milestone): string | null {
  for (const [k, v] of Object.entries((m.attributes ?? {}) as Record<string, unknown>)) {
    if (!CODE_KEY.test(k) || (typeof v !== "string" && typeof v !== "number")) continue;
    const s = String(v).trim();
    if (CODE_SHAPE.test(s)) return s.toUpperCase();
  }
  return null;
}

// The usual tag letters, for a codebook type that has none set: matched to
// the codebook's own types by name. Only letters that mean one thing.
const USUAL: Array<[RegExp, RegExp]> = [
  [/^(E|EA|X)$/, /exchang/i],
  [/^(V|D)$/, /^vessels?$/i],
  [/^(PSV|PRV|RV|SV|PVSV)$/, /^relief valves?$/i],
  [/^(C|K)$/, /^compressors?$/i],
  [/^(XV|FV|LV|PV|TV|HV|MOV|CV|SDV|BDV|FCV|LCV|PCV|TCV)$/, /^valves$/i],
  [/^(H)$/, /^heaters$/i],
  [/^(FA)$/, /flame arrest/i],
];

/** The type a tag's letters point to: the codebook's prefixes first, else
 *  the usual letters for a type that has none (E is Exchangers). */
export function typeOfTag(tag: string | null | undefined, book: Codebook): CodebookEntry | null {
  if (!tag) return null;
  const own = typeForTag(tag, book);
  if (own) return own;
  const p = splitTag(tag)?.prefix;
  if (!p) return null;
  // A prefix the codebook gives to some type is that type's alone.
  if (book.equipmentTypes.some((t) => (t.meta.tagPrefixes ?? []).some((x) => x.toUpperCase() === p))) return null;
  for (const [letters, name] of USUAL) {
    if (!letters.test(p)) continue;
    const hits = book.equipmentTypes.filter((t) => name.test(t.label) && !(t.meta.tagPrefixes ?? []).length);
    return hits.length === 1 ? hits[0] : null;
  }
  return null;
}

export const typeLabel = (code: string | null | undefined, book: Codebook): string =>
  !code ? "" : book.equipmentTypes.find((t) => t.code === code)?.label ?? `Type ${code}`;
export const unitLabel = (code: string | null | undefined, book: Codebook): string =>
  !code ? "" : book.units.find((u) => u.code === code)?.label ?? `Unit ${code}`;

/** What a work order's task has confirmed. */
export function savedClass(m: Milestone): { unit: string | null; type: string | null } {
  const a = (m.attributes ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : null);
  return { unit: s(EQUIP_UNIT), type: s(EQUIP_TYPE) };
}

/** A work order's unit and type. `chain`: its task, then the tasks above
 *  it; `kids`: its steps; `asset`: the registry equipment it's linked to;
 *  `tag`: its equipment tag (saved or read from the name). */
export function classifyWorkOrder(o: {
  owner: Milestone; chain?: Milestone[]; kids?: Milestone[]; book: Codebook;
  projectUnits: string[]; asset?: { unitCode: string | null; code?: string | null } | null; tag?: string | null;
}): WoClass {
  const { owner, book } = o;
  const saved = savedClass(owner);
  // The site code: its own column, else one all its steps agree on, else
  // the task above, else the one code written in its name.
  let code = codeOf(owner);
  if (!code && o.kids?.length) {
    const cs = [...new Set(o.kids.map(codeOf).filter((c): c is string => !!c))];
    if (cs.length === 1) code = cs[0];
  }
  if (!code) for (const up of (o.chain ?? []).slice(1)) { const c = codeOf(up); if (c) { code = c; break; } }
  const named = codesIn([owner.name, owner.description].filter(Boolean).join(" "));
  if (!code && named.length === 1) code = named[0];
  const dec = decodeSiteCode(code, book);
  // Several codes in the name (piping from E-2 to V-2): the unit when they
  // share it, never the type.
  const namedUnits = [...new Set(named.map((c) => decodeSiteCode(c, book)?.unit).filter(Boolean))];
  const fromAsset = o.asset ? decodeSiteCode(o.asset.code, book) : null;
  const tagType = typeOfTag(o.tag ?? leadTag(owner.name) ?? tagsIn(owner.name)[0] ?? null, book);

  let unit: string | null = null, unitFrom: ClassFrom | null = null;
  if (saved.unit) { unit = saved.unit; unitFrom = "saved"; }
  else if (dec?.unit) { unit = dec.unit; unitFrom = "code"; }
  else if (!code && namedUnits.length === 1) { unit = namedUnits[0]!; unitFrom = "code"; }
  else if (o.projectUnits.length === 1) { unit = o.projectUnits[0]; unitFrom = "project"; }
  else if (o.asset?.unitCode) { unit = o.asset.unitCode; unitFrom = "registry"; }
  // On several units, nothing saying which: the project's main one (its first).
  else if (o.projectUnits.length > 1) { unit = o.projectUnits[0]; unitFrom = "main"; }

  let type: string | null = null, typeFrom: ClassFrom | null = null;
  if (saved.type) { type = saved.type; typeFrom = "saved"; }
  else if (dec?.type) { type = dec.type; typeFrom = "code"; }
  else if (fromAsset?.type) { type = fromAsset.type; typeFrom = "registry"; }
  else if (tagType) { type = tagType.code; typeFrom = "tag"; }

  return { unit, unitFrom, type, typeFrom, code: dec ? dec.code : code };
}

/** Each work order's class, by its task's id. `orders`: each work order's
 *  task (lib/projectEquipment setupOrders). */
export function classesFor(orders: Array<{ owner: Milestone }>, all: Milestone[], book: Codebook, projectUnits: string[],
  extra?: (owner: Milestone) => { asset?: { unitCode: string | null; code?: string | null } | null; tag?: string | null }): Map<string, WoClass> {
  const byId = new Map<string, Milestone>();
  const kids = new Map<string, Milestone[]>();
  for (const m of all) { if (m.id) byId.set(m.id, m); if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]); }
  const out = new Map<string, WoClass>();
  for (const { owner } of orders) {
    if (!owner.id) continue;
    const chain: Milestone[] = [];
    const seen = new Set<string>();
    for (let x: Milestone | undefined = owner; x?.id && !seen.has(x.id); x = x.parentId ? byId.get(x.parentId) : undefined) { seen.add(x.id); chain.push(x); }
    out.set(owner.id, classifyWorkOrder({ owner, chain, kids: kids.get(owner.id) ?? [], book, projectUnits, ...(extra?.(owner) ?? {}) }));
  }
  return out;
}

/** A step's class: its work order's (the nearest task above it, or itself,
 *  that's a work order). */
export function classOfStep(m: Milestone, byId: Map<string, Milestone>, classes: Map<string, WoClass>): WoClass | null {
  const seen = new Set<string>();
  for (let x: Milestone | undefined = m; x?.id && !seen.has(x.id); x = x.parentId ? byId.get(x.parentId) : undefined) {
    seen.add(x.id);
    const c = classes.get(x.id);
    if (c) return c;
  }
  return null;
}

/** "No unit" / "No type" are choices too: work with nothing set. */
export const NONE = "-";

/** Keep a class when it's in the picked units and types (empty: all). */
export function classPasses(c: WoClass | null | undefined, units: string[], types: string[]): boolean {
  if (units.length && !units.includes(c?.unit ?? NONE)) return false;
  if (types.length && !types.includes(c?.type ?? NONE)) return false;
  return true;
}

/** The units and types in use, most work orders first, for filter lists. */
export function classChoices(classes: Iterable<WoClass>, book: Codebook): { units: Array<{ code: string; label: string; n: number }>; types: Array<{ code: string; label: string; n: number }> } {
  const u = new Map<string, number>(), t = new Map<string, number>();
  for (const c of classes) {
    u.set(c.unit ?? NONE, (u.get(c.unit ?? NONE) ?? 0) + 1);
    t.set(c.type ?? NONE, (t.get(c.type ?? NONE) ?? 0) + 1);
  }
  const list = (m: Map<string, number>, label: (k: string) => string) => [...m.entries()]
    .map(([code, n]) => ({ code, label: code === NONE ? "" : label(code), n }))
    .sort((a, b) => (a.code === NONE ? 1 : b.code === NONE ? -1 : b.n - a.n || a.label.localeCompare(b.label)));
  return {
    units: list(u, (k) => unitLabel(k, book)).map((x) => ({ ...x, label: x.code === NONE ? "No unit" : `${x.label} (${x.code})` })),
    types: list(t, (k) => typeLabel(k, book)).map((x) => ({ ...x, label: x.code === NONE ? "No type set" : x.label })),
  };
}

/** Where it came from, in a few words: "from 5630.06", "from the tag". */
export function fromWords(from: ClassFrom | null, c: WoClass): string {
  switch (from) {
    case "saved": return "confirmed";
    case "code": return c.code ? `from ${c.code}` : "from the equipment number";
    case "registry": return "from the registry";
    case "tag": return "from the tag letters";
    case "project": return "the project's unit";
    case "main": return "the project's main unit";
    default: return "";
  }
}
