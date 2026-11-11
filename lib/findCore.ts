// lib/findCore.ts - the rules behind the one search used in Documents, the
// Document Control widget and the top search bar. Pure, so it is tested.
//
// Names are never unique; the equipment ID is. A tag typed bare ("e22") can
// be on several units, so the search says so and asks which one, picking the
// unit of the folder you're in when there is one.

import { searchMatcher } from "@/lib/fuzzySearch";

export interface FindUnit { code: string; label: string }

export interface FindEquip {
  id: string;
  tag: string;
  /** The equipment ID ("5530.29"). */
  code: string | null;
  unitCode: string | null;
  unitLabel: string | null;
  description: string | null;
  typeName: string | null;
  /** Documents this equipment is tagged on. */
  docIds: string[];
  score: number;
}

export interface FindDoc {
  id: string;
  libraryId: string;
  number: string | null;
  title: string | null;
  name: string | null;
  rev: string | null;
  sheet: string | null;
  status: string | null;
  folderId: string | null;
  folderName: string | null;
  /** Equipment tagged on it, as "E-22 (5530.29)". */
  tags?: string[];
  /** What the find service tied it to (tagged to, drawn on, mentioned in). */
  rels?: Array<{ rel: string; node: string; label: string; page?: number }>;
  /** The best page the words were found on. */
  hit?: { page: number; text: string };
}

/** A link to a document where it is filed: its folder opens with it picked
 *  (never the top of the library with the file out of sight). */
export const docHref = (d: Pick<FindDoc, "id" | "libraryId"> & { folderId?: string | null }, full = false) =>
  `/documents/${d.libraryId}?${d.folderId ? `folderId=${d.folderId}&` : ""}doc=${d.id}${full ? "&fs=1" : ""}`;

export interface FindFolder { id: string; libraryId: string; name: string; parentName: string | null }

export interface FindWorkOrder {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  wo: string | null;
  done: number;
  total: number;
}

/** Tag identity: letters and digits only, leading zeros off the number.
 *  "E-22", "e22", "E-022" are one tag. */
export function tagKey(tag: string): string {
  const t = (tag || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return t.replace(/(^|[a-z])0+(?=\d)/g, "$1");
}

/** A short single token with letters and a number: typed as a tag. */
export function isTagLike(q: string): boolean {
  const t = q.trim();
  if (!t || /\s/.test(t) || t.length > 14) return false;
  const k = tagKey(t);
  return k.length >= 2 && /[a-z]/.test(k) && /\d/.test(k);
}

/** An equipment ID typed: "5530.29", "5530". */
export function isCodeLike(q: string): boolean {
  return /^\d{2,6}(\.\d{1,4})?$/.test(q.trim());
}

/** How well a piece of equipment answers the query. 0 means not at all. */
export function equipScore(q: string, e: Pick<FindEquip, "tag" | "code" | "description" | "unitLabel">): number {
  const t = q.trim();
  if (!t) return 0;
  const k = tagKey(t);
  if (k && tagKey(e.tag) === k) return 100;
  if (e.code && e.code === t) return 98;
  if (e.code && isCodeLike(t) && e.code.startsWith(t)) return 70;
  if (k.length >= 2 && isTagLike(t) && tagKey(e.tag).startsWith(k)) return 60;
  const m = searchMatcher(t)(`${e.tag} ${e.code ?? ""} ${e.description ?? ""} ${e.unitLabel ?? ""}`);
  return m > 0 ? Math.min(50, 20 + m) : 0;
}

/** Best first; ties by unit code then tag. */
export function rankEquip(list: FindEquip[]): FindEquip[] {
  return [...list].sort((a, b) =>
    b.score - a.score
    || (a.unitCode ?? "~").localeCompare(b.unitCode ?? "~", undefined, { numeric: true })
    || a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

/** Equipment that answers the query exactly by tag: the ones a person means
 *  when they type "e22". More than one of them is a question to ask. */
export function exactTagMatches(q: string, list: FindEquip[]): FindEquip[] {
  if (!isTagLike(q)) return [];
  const k = tagKey(q);
  return list.filter((e) => tagKey(e.tag) === k);
}

/** The question when a tag is on more than one unit (or listed twice). */
export function whichOneLine(tag: string, matches: FindEquip[]): string | null {
  if (matches.length < 2) return null;
  const units = new Set(matches.map((m) => m.unitCode ?? "?"));
  if (units.size === matches.length) return `${tag} is on ${matches.length} units. Which one?`;
  return `There are ${matches.length} called ${tag}. Which one?`;
}

/** What is picked without asking: the only match, or the one on the unit of
 *  the folder you're in. Null means ask. */
export function defaultPick(q: string, list: FindEquip[], contextUnit: string | null): string | null {
  const exact = exactTagMatches(q, list);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) {
    const here = contextUnit ? exact.filter((e) => e.unitCode === contextUnit) : [];
    return here.length === 1 ? here[0].id : null;
  }
  // An ID typed in full is one piece of equipment.
  const byCode = list.filter((e) => e.code && e.code === q.trim());
  return byCode.length === 1 ? byCode[0].id : null;
}

/** A folder's unit from its name: "55 - Transmix" is unit 55 because the
 *  codebook's unit 55 is Transmix; "LRU" matches "LPG Recovery Unit (LRU)".
 *  A leading number the name does not back up is a section number, not a
 *  unit ("10 - Material Requirements" is not unit 10, Engineering). */
export function unitFromFolderName(name: string, units: FindUnit[]): string | null {
  const n = name.trim();
  const word = n.replace(/^\d+\s*[-_.]?\s*/, "").trim().toLowerCase();
  const says = (u: FindUnit) => {
    const l = u.label.toLowerCase();
    const abbr = l.match(/\(([^)]+)\)/)?.[1]?.trim();
    return l === word || abbr === word || l.startsWith(`${word} `);
  };
  const m = n.match(/^(\d{2,3})(?=\s|-|_|\.|$)/);
  if (m) {
    const led = units.find((u) => u.code === m[1]);
    return led && word.length >= 3 && says(led) ? led.code : null;
  }
  if (word.length < 3) return null;
  const hit = units.filter(says);
  return hit.length === 1 ? hit[0].code : null;
}

/** The unit of the deepest folder in a chain that says one: a mark set on
 *  the folder wins, then its name. */
export function unitOfChain(chain: Array<{ id: string; name: string }>, marks: Map<string, string>, units: FindUnit[]): string | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    const mark = marks.get(f.id);
    if (mark) return mark;
    const byName = unitFromFolderName(f.name, units);
    if (byName) return byName;
  }
  return null;
}

/** "5502-D 2000-5". */
export function docLabel(d: Pick<FindDoc, "number" | "title" | "name">): string {
  return d.number || d.title || d.name || "Document";
}

/** "sheet 05 · Rev 05". */
export function docMeta(d: Pick<FindDoc, "sheet" | "rev">): string {
  return [d.sheet ? `sheet ${d.sheet}` : null, d.rev ? `Rev ${d.rev}` : null].filter(Boolean).join(" · ");
}

/** "E-22 (5530.29)". */
export function equipLabel(e: Pick<FindEquip, "tag" | "code">): string {
  return e.code && !e.tag.includes(e.code) ? `${e.tag} (${e.code})` : e.tag;
}

/** The unit as people say it: "55 Transmix Unit (Old Solvent Unit)". */
export function unitName(e: Pick<FindEquip, "unitCode" | "unitLabel">): string {
  if (!e.unitCode) return "No unit set";
  return e.unitLabel ? `${e.unitCode} ${e.unitLabel}` : `Unit ${e.unitCode}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The documents to list under "Documents": everything found, minus the
 *  ones already shown under the picked equipment. */
export function otherDocs(found: string[], shown: Set<string>): string[] {
  return found.filter((id) => !shown.has(id));
}
