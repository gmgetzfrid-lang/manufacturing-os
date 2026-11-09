// equipmentPick - linking a work order (the task; its steps take its
// equipment) to equipment in the project's unit, and the rules for adding
// equipment.
//
//   - The ID (2010.07: unit 20, vessels 10, item 7) is one piece of
//     equipment across the plant; the name (V-7) repeats from unit to unit,
//     so it only has to be unique within its unit.
//   - Only admins add equipment. Everyone else picks from the unit's list,
//     or asks an admin to add what's missing; the ask is kept on the work
//     order until an admin adds it (and it links itself) or it's linked to
//     something already there.
//
// Pure: no database here (lib/projectEquipment loads and saves).

import type { Milestone } from "@/types/schema";
import { codeOf } from "@/lib/woClass";
import { searchMatcher } from "@/lib/fuzzySearch";

/** A piece of equipment as the picker shows it. */
export interface PickAsset { id: string; tag: string; unitCode: string | null; code?: string | null; description?: string | null }

/** The registry's "X-31 (2030.31)" is X-31. */
export const plainName = (tag: string) => tag.replace(/\s*\(.*$/, "").trim();

/** How equipment is written everywhere: the name, its ID, what it is -
 *  "E-26 (5530.19) Debutanizer Trim Cooler". */
export function equipmentLabel(a: Pick<PickAsset, "tag" | "code" | "description">): string {
  const id = a.code?.trim() || (a.tag.match(/\(([^)]+)\)/)?.[1] ?? "");
  const what = a.description?.trim();
  return `${plainName(a.tag)}${id ? ` (${id})` : ""}${what ? ` ${what}` : ""}`;
}

/** What a work order's name says the equipment is: "V-7 - Transmix
 *  Fractionator" is a Transmix Fractionator. Empty when the name doesn't
 *  lead with the tag. */
export function descriptionFrom(name: string | null | undefined, tag: string): string {
  const n = (name ?? "").trim();
  const m = n.match(/^\s*([A-Z]{1,4})\s?-\s?(\d{1,5}[A-Z]{0,2})\b\s*[-–:·]?\s*(.*)$/i);
  if (!m || nameKey(`${m[1]}-${m[2]}`) !== nameKey(tag)) return "";
  return m[3].trim();
}

/** A name as one piece of equipment: letters and digits, lower case,
 *  no leading zeros ("V-7", "v 7", "V07" and "V-07" are one name). */
export const nameKey = (tag: string | null | undefined) =>
  plainName(tag ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(^|[a-z])0+(?=\d)/g, "$1");

/** An ID as one piece of equipment (2010.7 and 2010.07 are one ID). */
export const idKey = (code: string | null | undefined) => (code ?? "").trim().toUpperCase().replace(/\.0+(\d)/, ".$1");

export const sameEquipmentId = (a: string | null | undefined, b: string | null | undefined) => !!idKey(a) && idKey(a) === idKey(b);

/** The plant's own number for it: the Equipment column of the work order
 *  (or a task above it) in the schedule. Never worked out from the name:
 *  the item number isn't the tag number (Transmix V-7 is 5510.19). */
export function scheduleId(m: Milestone, byId: Map<string, Milestone>): string | null {
  const seen = new Set<string>();
  for (let x: Milestone | undefined = m; x && !(x.id && seen.has(x.id)); x = x.parentId ? byId.get(x.parentId) : undefined) {
    if (x.id) seen.add(x.id);
    const c = codeOf(x);
    if (c) return c;
  }
  return null;
}

/** What's wrong with an ID for a unit, in words; null when it's fine. IDs
 *  are written 5510.19 or 5516-TV-110. */
export function idProblem(code: string, unitCode: string): string | null {
  const c = code.trim();
  if (!c) return "Enter its ID, as the plant numbers it.";
  if (!/^\d{3,6}(\.[0-9A-Za-z]{1,7}|-[A-Za-z0-9][A-Za-z0-9/.-]{0,15})$/.test(c)) return `Write the ID as the plant does: unit and section, then the number (${unitCode}10.19 or ${unitCode}16-TV-110).`;
  if (!c.startsWith(unitCode)) return `${c} isn't on unit ${unitCode}: it starts with ${c.slice(0, unitCode.length)}. Put the project on that unit too, then add it there.`;
  return null;
}

export type NewCheck =
  | { kind: "ok" }
  /** Already in this unit: link that one instead. */
  | { kind: "same_name"; asset: PickAsset }
  /** The ID is another piece of equipment. */
  | { kind: "same_id"; asset: PickAsset }
  | { kind: "bad_id"; words: string }
  | { kind: "no_name" };

/** Can this be added to the unit, or is it already there? */
export function checkNew(x: { tag: string; code: string; unitCode: string }, registry: PickAsset[]): NewCheck {
  if (!nameKey(x.tag)) return { kind: "no_name" };
  const here = registry.find((a) => a.unitCode === x.unitCode && nameKey(a.tag) === nameKey(x.tag));
  if (here) return { kind: "same_name", asset: here };
  const bad = idProblem(x.code, x.unitCode);
  if (bad) return { kind: "bad_id", words: bad };
  const used = registry.find((a) => sameEquipmentId(a.code, x.code));
  if (used) return { kind: "same_id", asset: used };
  return { kind: "ok" };
}

/** The unit's equipment matching what's typed (V-7, v7, 5510.07, "trim
 *  cooler"), best first; everything, by name, when nothing's typed. */
export function unitEquipment(registry: PickAsset[], unitCodes: string[], query: string): PickAsset[] {
  const mine = registry.filter((a) => a.unitCode != null && unitCodes.includes(a.unitCode));
  const q = query.trim();
  const byName = (a: PickAsset, b: PickAsset) => plainName(a.tag).localeCompare(plainName(b.tag), undefined, { numeric: true });
  if (!q) return [...mine].sort(byName);
  const match = searchMatcher(q);
  const exact = nameKey(q);
  return mine
    .map((a) => ({ a, s: nameKey(a.tag) === exact || sameEquipmentId(a.code, q) ? 1000 : match(`${plainName(a.tag)} ${a.code ?? ""} ${a.tag} ${a.description ?? ""}`) }))
    .filter((x) => x.s > 0)
    .sort((p, q2) => q2.s - p.s || byName(p.a, q2.a))
    .map((x) => x.a);
}

/** The same name on other units: different pieces of equipment, said so
 *  nobody links the Crude Unit's V-7 to a Transmix work order. */
export function sameNameElsewhere(tag: string, registry: PickAsset[], unitCodes: string[]): PickAsset[] {
  const k = nameKey(tag);
  return k ? registry.filter((a) => nameKey(a.tag) === k && !(a.unitCode != null && unitCodes.includes(a.unitCode))) : [];
}

// ─── Asking an admin ───────────────────────────────────────────────

export const EQUIP_REQUEST = "equipment_request";

/** The ask as it's kept on the step (JSON text). */
export const requestValue = (r: EquipmentRequest) => JSON.stringify(r);

export interface EquipmentRequest {
  tag: string;
  /** The unit it's asked for on. */
  unit: string | null;
  by: string | null;
  byName: string | null;
  /** ISO time it was asked. */
  at: string;
}

/** The ask waiting on a work order (or step), if any. */
export function requestOf(m: Pick<Milestone, "attributes"> | null | undefined): EquipmentRequest | null {
  const raw = (m?.attributes ?? {})[EQUIP_REQUEST] as unknown;
  // Kept as JSON text, like the other records on a step (a parsed object read back too).
  let r: Partial<EquipmentRequest> | undefined;
  try { r = typeof raw === "string" ? JSON.parse(raw) : (raw as Partial<EquipmentRequest> | undefined); } catch { r = undefined; }
  return r && typeof r.tag === "string" && r.tag.trim()
    ? { tag: r.tag.trim(), unit: r.unit ?? null, by: r.by ?? null, byName: r.byName ?? null, at: r.at ?? "" }
    : null;
}
