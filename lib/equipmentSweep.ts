// equipmentSweep - what the drawings say about each piece of equipment, and
// how it lines up with the registry. The equipment ID is the key:
//
//   - The ID printed beside a tag on the sheet ("E-17 (5530.26)") is the
//     equipment: matched to the registry by ID, whatever name it has there.
//   - The ID says the unit and the type: 5530.26 is unit 55 (Transmix),
//     type 30 (Exchangers), by the site codebook.
//   - The name (E-17) repeats from unit to unit, so it only ever matches
//     inside the same unit, and only when no ID is printed.
//   - Nothing is guessed: no ID printed and none in the registry means the
//     row needs a person to enter it.
//
// Pure: no database here (lib/equipmentBridgeServer reads and writes).

import { normalizeTag, splitTag, type Codebook } from "@/lib/codebook";
import { idKey, nameKey } from "@/lib/equipmentPick";

/** What a sheet's callout says: "E-17 (5530.26) TRANSMIX FEED ... · SIZE ...". */
export function readCallout(tag: string, raw: string | null | undefined): { code: string | null; name: string | null } {
  const s = String(raw ?? "").trim();
  if (!s) return { code: null, name: null };
  const t = normalizeTag(tag);
  // Drop the tag at the front (as printed, or normalized).
  // A callout starts with its tag; anything else (a title block, a file
  // path an older reading kept) says nothing about the equipment.
  let rest = s;
  const lead = rest.match(/^\s*([A-Z]{1,4}\s?-?\s?\d{1,6}[A-Z]{0,2})\b\s*/i);
  if (!lead || normalizeTag(lead[1]) !== t) return { code: null, name: null };
  rest = rest.slice(lead[0].length);
  const m = rest.match(/^\(\s*([^)]+?)\s*\)\s*/);
  const code = m && looksLikeId(m[1]) ? m[1].trim().toUpperCase() : null;
  if (m) rest = rest.slice(m[0].length);
  const name = rest.split("·")[0].trim().replace(/\s+/g, " ") || null;
  return { code, name };
}

/** An ID as the plant writes them: 5530.26, 5516-TV-110. */
export const looksLikeId = (s: string | null | undefined) => /^\d{3,6}(\.[0-9A-Za-z]{1,7}|-[A-Za-z0-9][A-Za-z0-9/.-]{0,15})$/.test(String(s ?? "").trim());

export interface DecodedId { unitCode: string; unitLabel: string; typeCode: string | null; typeLabel: string | null }

/** The unit and type an ID says, by the codebook: 5530.26 is unit 55, type
 *  30. Longest unit code first. Null when no unit in the codebook fits. */
export function decodeId(code: string | null | undefined, book: Codebook): DecodedId | null {
  const c = String(code ?? "").trim();
  if (!looksLikeId(c)) return null;
  const head = c.split(/[.-]/)[0];
  for (const u of [...book.units].sort((a, b) => b.code.length - a.code.length)) {
    if (!head.startsWith(u.code) || head.length <= u.code.length) continue;
    const rest = head.slice(u.code.length);
    const t = book.equipmentTypes.find((x) => x.code === rest) ?? null;
    return { unitCode: u.code, unitLabel: u.label, typeCode: t?.code ?? null, typeLabel: t?.label ?? null };
  }
  return null;
}

/** The usual meaning of a tag letter, for a tag with no ID: only letters
 *  that mean one thing. The codebook's own prefixes win. */
const LETTER: Record<string, RegExp> = { E: /^exchangers?$/i, V: /^vessels?$/i, H: /^heaters?$/i, P: /^pumps? \(centrifugal\)$/i, B: /^blowers?$/i, C: /^compressors?$/i };

export function typeFromLetter(tag: string, book: Codebook): { code: string; label: string; from: "codebook" | "letter" } | null {
  const p = splitTag(tag)?.prefix;
  if (!p) return null;
  for (const t of book.equipmentTypes) if ((t.meta.tagPrefixes ?? []).some((x) => x.toUpperCase() === p)) return { code: t.code, label: t.label, from: "codebook" };
  const re = LETTER[p];
  const t = re ? book.equipmentTypes.find((x) => re.test(x.label)) : undefined;
  return t ? { code: t.code, label: t.label, from: "letter" } : null;
}

/** Does the tag's letter fit the type the ID says? (A pump letter on an
 *  exchanger ID is worth a look.) Unknown letters fit. */
export function letterFits(tag: string, typeLabel: string | null): boolean {
  const p = splitTag(tag)?.prefix;
  if (!p || !typeLabel) return true;
  const fits: Record<string, RegExp> = { E: /exchang|cool|condens|heater/i, V: /vessel|drum|tower|tank|filter/i, P: /pump/i, H: /heater|boiler/i, B: /blower|boiler/i, C: /compressor/i, T: /tank|tower|vessel/i };
  return fits[p] ? fits[p].test(typeLabel) : true;
}

export interface RegistryAsset { id: string; tag: string; code: string | null; unitCode: string | null; description?: string | null }

export interface SweepRow {
  tag: string;
  pages: number[];
  /** The ID: read off the sheet, else the registry's (by name in the unit). */
  code: string | null;
  codeFrom: "sheet" | "registry" | null;
  /** The service name read off the sheet. */
  name: string | null;
  unitCode: string | null;
  typeCode: string | null;
  typeLabel: string | null;
  typeFrom: "id" | "codebook" | "letter" | "registry" | null;
  /** The registry's equipment it is, and how that was found. */
  assetId: string | null;
  assetStatus: "existing" | "new";
  match: "id" | "name" | null;
  /** The registry calls it something else (matched by ID). */
  listedAs: string | null;
  /** The same name on other units: different equipment, said so. */
  otherUnits: Array<{ unitCode: string | null; code: string | null }>;
  /** Something a person should look at before it's added. */
  problem: string | null;
  /** The registry has this name in the unit with another ID (often one
   *  guessed from the tag before): the equipment the sheet's ID can replace. */
  clash?: { assetId: string; code: string } | null;
}

/** Each tag on a drawing, lined up with the registry. `drawingUnit` is the
 *  unit of a sheet that prints no IDs (the library's pick, or the drawing
 *  number's); a sheet that prints IDs says its own unit. */
export function sweepRows(input: {
  readings: Array<{ tag: string; page: number; raw: string | null }>;
  registry: RegistryAsset[];
  book: Codebook;
  drawingUnit: string | null;
  /** The drawing's own number ("2002-D 2001"): a tag read out of it (D-2001)
   *  is the title block, not equipment. */
  drawingNumber?: string | null;
}): SweepRow[] {
  const { book, registry } = input;
  const own = new Set([...String(input.drawingNumber ?? "").toUpperCase().matchAll(/([A-Z]{1,4})[\s-]?(\d{1,6})/g)].map((m) => nameKey(`${m[1]}-${m[2]}`)));
  const byTag = new Map<string, { pages: Set<number>; code: string | null; name: string | null }>();
  for (const r of input.readings) {
    const tag = normalizeTag(r.tag);
    if (!splitTag(tag) || own.has(nameKey(tag))) continue;
    const cur = byTag.get(tag) ?? { pages: new Set<number>(), code: null, name: null };
    if (Number.isFinite(r.page)) cur.pages.add(r.page);
    const c = readCallout(tag, r.raw);
    cur.code = cur.code ?? c.code;
    cur.name = cur.name ?? c.name;
    byTag.set(tag, cur);
  }
  // The sheet's unit: what its printed IDs say (most of them), else the given one.
  const units = new Map<string, number>();
  for (const v of byTag.values()) { const u = decodeId(v.code, book)?.unitCode; if (u) units.set(u, (units.get(u) ?? 0) + 1); }
  const sheetUnit = [...units.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? input.drawingUnit;

  const byId = new Map<string, RegistryAsset>();
  for (const a of registry) if (a.code && idKey(a.code)) byId.set(idKey(a.code), a);
  const plain = (t: string) => t.replace(/\s*\(.*$/, "").trim();

  return [...byTag.entries()].map(([tag, v]): SweepRow => {
    const dec = decodeId(v.code, book);
    const unitCode = dec?.unitCode ?? sheetUnit ?? null;
    const sameName = registry.filter((a) => nameKey(plain(a.tag)) === nameKey(tag));
    const inUnit = sameName.filter((a) => unitCode != null && a.unitCode === unitCode);
    let asset: RegistryAsset | null = null;
    let match: SweepRow["match"] = null;
    let problem: string | null = null;
    let listedAs: string | null = null;
    let clash: SweepRow["clash"] = null;
    if (v.code) {
      asset = byId.get(idKey(v.code)) ?? null;
      if (asset) {
        match = "id";
        if (nameKey(plain(asset.tag)) !== nameKey(tag)) listedAs = plain(asset.tag);
      } else {
        // Not in the registry by ID. The same name in the unit with no ID
        // yet is this equipment (its ID gets filled in); with another ID,
        // it's a clash for a person.
        const named = inUnit[0];
        if (named && !named.code) { asset = named; match = "name"; }
        else if (named?.code) {
          problem = `The ${unitWord(named.unitCode, book)} list has ${tag} as ${named.code}; the sheet says ${v.code}.`;
          clash = { assetId: named.id, code: named.code };
        }
      }
    } else if (inUnit.length === 1) {
      asset = inUnit[0]; match = "name";
    }
    const t = dec?.typeCode ? { code: dec.typeCode, label: dec.typeLabel ?? dec.typeCode, from: "id" as const } : typeFromLetter(tag, book);
    if (dec?.typeLabel && !letterFits(tag, dec.typeLabel)) problem = problem ?? `The ID says ${dec.typeLabel.toLowerCase()}, but the tag letter doesn't fit.`;
    if (v.code && !dec) problem = problem ?? `${v.code} doesn't start with a unit in the site codebook.`;
    const code = v.code ?? (asset?.code ?? null);
    return {
      tag, pages: [...v.pages].sort((a, b) => a - b),
      code, codeFrom: v.code ? "sheet" : asset?.code ? "registry" : null,
      name: v.name,
      unitCode,
      typeCode: t?.code ?? null, typeLabel: t?.label ?? null, typeFrom: t?.from ?? null,
      assetId: asset?.id ?? null, assetStatus: asset ? "existing" : "new", match, listedAs,
      otherUnits: sameName.filter((a) => a.id !== asset?.id && a.unitCode !== unitCode).map((a) => ({ unitCode: a.unitCode, code: a.code })),
      problem,
      clash,
    };
  }).sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

const unitWord = (code: string | null, book: Codebook) => (code ? book.units.find((u) => u.code === code)?.label.replace(/\s*\(.*\)\s*$/, "") ?? `unit ${code}` : "registry");

/** Ready to go without a person: an ID printed on the sheet, a unit and a
 *  type the codebook reads from it, nothing odd. */
export const autoReady = (r: SweepRow) => r.codeFrom === "sheet" && r.typeFrom === "id" && !!r.unitCode && !r.problem;

/** What a person decided about one row in the review. */
export interface RowChoice {
  skip?: boolean; code?: string | null; typeCode?: string | null;
  /** Replace what the registry says with the sheet's: its ID (where they
   *  clash) and its service name. */
  overwrite?: boolean;
}
