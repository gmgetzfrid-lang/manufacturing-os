// equipmentStartOver - the plan for starting the equipment over from the
// drawings, worked out before anything changes so an admin sees it first.
//
//   1. Remove: every record the drawing reader made that nothing holds on
//      to: no photos, no linked files, no notes, nicknames, typed document
//      tags, work orders, findings or links a person drew.
//   2. Merge: records that are one piece of equipment (the same ID, or the
//      same tag in a unit where it has at most one ID) become one. The one a
//      person added is kept, else the one with an ID, else the one with
//      photos; photos, files and links move onto it. A record a person
//      added is never merged away, and copies the ID can't place are left.
//   3. Drawings: only the equipment entries the reader itself wrote into a
//      drawing's column come off, never what a person typed.
//
// Pure: no database here (lib/equipmentStartOverServer reads and runs it).

import { pieces, keepOrder, lookupOrder, idOf, type IdentityRecord } from "@/lib/equipmentIdentity";
import { plainName } from "@/lib/equipmentPick";

export interface StartOverAsset extends IdentityRecord {
  /** Things a person hung on it: notes, nicknames, typed document tags,
   *  work orders, findings, links drawn by hand. */
  refs: number;
  /** Changed after it was added (by a person, or a sort a person ran). */
  edited: boolean;
}

/** A record as the preview lists it. */
export interface PlanAsset { id: string; tag: string; code: string | null; unitCode: string | null; origin: string | null; photos: number; files: number; edited: boolean }

export interface MergeGroup { keep: PlanAsset; drop: PlanAsset[]; by: "id" | "tag" }

/** Copies left as they are: the tag has more than one ID in the unit
 *  ("ids"), or a person added the same piece twice ("typed"). */
export interface Unsure { tag: string; unitCode: string | null; ids: string[]; why: "ids" | "typed" }

export interface StartOverPlan {
  remove: PlanAsset[];
  merges: MergeGroup[];
  unsure: Unsure[];
  /** What stays as it is. */
  kept: { total: number; manual: number; reader: number; edited: number };
}

const listed = (a: StartOverAsset): PlanAsset => ({
  id: a.id, tag: a.tag, code: idOf(a), unitCode: a.unitCode ?? null, origin: a.origin ?? null, photos: a.photos ?? 0, files: a.files ?? 0, edited: a.edited,
});
const byTag = (x: { tag: string; unitCode: string | null }, y: { tag: string; unitCode: string | null }) =>
  String(x.unitCode ?? "").localeCompare(String(y.unitCode ?? ""), undefined, { numeric: true }) || plainName(x.tag).localeCompare(plainName(y.tag), undefined, { numeric: true });

/** Made by the drawing reader, and nothing a person hung on it. */
export function removable(a: StartOverAsset, opts: { keepEdited?: boolean } = {}): boolean {
  return a.origin === "drawing" && !(a.photos ?? 0) && !(a.files ?? 0) && !a.refs && !(opts.keepEdited && a.edited);
}

export function planStartOver(assets: StartOverAsset[], opts: { keepEdited?: boolean } = {}): StartOverPlan {
  const remove = assets.filter((a) => removable(a, opts));
  const gone = new Set(remove.map((a) => a.id));
  const rest = assets.filter((a) => !gone.has(a.id));
  const ps = pieces(rest);
  const merges: MergeGroup[] = [];
  const unsure: Unsure[] = [];
  const dropped = new Set<string>();
  for (const p of ps) {
    if (p.unsure) {
      const ids = ps.filter((q) => q.code && q.units.some((u) => p.units.includes(u)) && q.names.some((n) => p.names.includes(n)))
        .map((q) => idOf([...q.records].sort(lookupOrder)[0]) ?? "");
      unsure.push({ tag: plainName(p.records[0].tag), unitCode: p.units[0] ?? null, ids: ids.filter(Boolean).sort(), why: "ids" });
      continue;
    }
    if (p.records.length < 2) continue;
    const [keep, ...others] = [...p.records].sort(keepOrder);
    // A record a person added is never merged away.
    const typed = others.filter((a) => a.origin === "manual");
    if (typed.length) unsure.push({ tag: plainName(keep.tag), unitCode: keep.unitCode ?? null, ids: [...new Set([keep, ...typed].map((a) => idOf(a) ?? "no ID"))], why: "typed" });
    const drop = others.filter((a) => a.origin !== "manual");
    if (!drop.length) continue;
    for (const d of drop) dropped.add(d.id);
    merges.push({ keep: listed(keep), drop: drop.map(listed), by: p.code ? "id" : "tag" });
  }
  const stays = rest.filter((a) => !dropped.has(a.id));
  return {
    remove: remove.map(listed).sort(byTag),
    merges: merges.sort((x, y) => byTag(x.keep, y.keep)),
    unsure: unsure.sort(byTag),
    kept: {
      total: stays.length,
      manual: stays.filter((a) => a.origin === "manual").length,
      reader: stays.filter((a) => a.origin === "drawing").length,
      edited: opts.keepEdited ? stays.filter((a) => a.origin === "drawing" && a.edited && !(a.photos ?? 0) && !(a.files ?? 0) && !a.refs).length : 0,
    },
  };
}

// ─── Drawings ─────────────────────────────────────────────────────

/** The registry's tag form: lower case, letters and digits. "X-31" and
 *  "X-31 (2030.31)" are different entries. */
const entryKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A drawing's equipment column as a list. */
export function columnList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

/** What runs wrote into a column: each run's after minus its before. */
export function journalAdditions(changes: Array<{ before: unknown; after: unknown }>): string[] {
  const out = new Map<string, string>();
  for (const c of changes) {
    const before = new Set(columnList(c.before).map(entryKey));
    for (const t of columnList(c.after)) if (!before.has(entryKey(t)) && !out.has(entryKey(t))) out.set(entryKey(t), t);
  }
  return [...out.values()];
}

/** A drawing's column with the reader's own entries taken off. `proven`
 *  is what the reader is known to have written (its journal and its own
 *  record); anything else, a person typed or nobody can say, stays. */
export function withoutReaderEntries(column: string[], proven: string[]): { keep: string[]; removed: string[] } {
  const p = new Set(proven.map(entryKey));
  return { keep: column.filter((t) => !p.has(entryKey(t))), removed: column.filter((t) => p.has(entryKey(t))) };
}

/** A short fingerprint of a plan, so the run does exactly what the
 *  preview showed (or says the list changed). */
export function planKey(plan: StartOverPlan, drawings: Array<{ documentId: string; removed: string[]; links: number }>): string {
  const parts = [
    ...plan.remove.map((a) => `r:${a.id}`),
    ...plan.merges.map((m) => `m:${m.keep.id}<${m.drop.map((d) => d.id).sort().join("+")}`),
    ...drawings.map((d) => `d:${d.documentId}:${d.removed.map(entryKey).sort().join("+")}:${d.links}`),
  ].sort();
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${parts.length}-${h.toString(36)}`;
}
