// lib/drawingConnectors.ts - off-page connectors, checked against the
// sheets they point at. For the drafting department.
//
// A P&ID line that leaves a sheet carries a connector: "TO X-58 SHT 3",
// "FROM E-21 5502-D 2000 SHT 6". Each one makes three claims that can be
// checked against what is on file:
//   the sheet exists            a connector to a sheet that is not on file
//   the tag is on that sheet    "TO X-58 on sheet 3", and sheet 3 has no X-58
//   the other side agrees       sheet 2 sends a line TO sheet 3; sheet 3
//                               shows nothing coming FROM sheet 2
// This reads the connectors as they were read off the drawings and lists
// what does not hold. It says only what it can check: a connector with no
// readable target, a target sheet that was never read, a drawing with no
// sheet number recorded are counted apart, never reported as faults. Pure.

export interface SheetOnFile {
  id: string; libraryId: string;
  /** The drawing's number as filed, and its sheet when one is recorded. */
  number: string; sheet: string | null; name: string;
}
export interface ConnectorRead { sheetId: string; page: number; tag: string; raw: string }
export interface ParsedConnector { direction: "to" | "from"; tag: string; drawing: string | null; sheet: string }

const DRAWING = /(\d{3,5}\s?-?\s?[A-Z]\s?[- ]?\s?\d{3,5})/i;
/** A drawing number as a key: letters and digits only ("5502-D 2000" and "5502D2000" are one). */
export const drawingKey = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, "");
/** The drawing a filed number belongs to: its leading drawing number, with
 *  anything an upload added after it left off ("5602-D 1000-10"). */
export function drawingOf(number: string): string | null {
  const m = number.trim().match(new RegExp(`^${DRAWING.source}`, "i"));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}
/** One way to write a drawing number, so "6002-D-2000" and "6002-D 2000"
 *  are listed as the one drawing they are. */
export function drawingLabel(n: string): string {
  const m = drawingKey(n).match(/^(\d+)([A-Z])(\d+)$/);
  return m ? `${m[1]}-${m[2]} ${m[3]}` : n.trim();
}
/** "08" and "8" are one sheet. */
export const sheetKey = (s: string | number) => String(parseInt(String(s), 10));
/** A tag as a key: "X-058" and "X58" are one. */
export const connectorTagKey = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/([A-Z])0+(?=\d)/g, "$1");
/** The sheet a file name says it is, when nothing else does ("..._SHT04_R22_..."). */
export function sheetFromName(name: string): string | null {
  const m = name.match(/(?:^|[^A-Za-z])(?:SHEET|SHT|SH)[\s_.-]?(\d{1,3})(?!\d)/i);
  return m ? sheetKey(m[1]) : null;
}

/** "TO X-58 SHT 3", "FROM E-21 5502-D 2000 SHT 6". Null: not a connector
 *  with a sheet to go to. */
export function parseConnector(raw: string): ParsedConnector | null {
  const s = raw.trim().replace(/\s+/g, " ");
  const m = s.match(/^(TO|FROM)\s+(\S+)\s*(.*?)\s*(?:SHEET|SHT\.?|SH\.?)\s*(\d{1,3})\b/i);
  if (!m) return null;
  const drawing = m[3].match(DRAWING)?.[1] ?? null;
  return { direction: m[1].toUpperCase() === "TO" ? "to" : "from", tag: m[2].replace(/[,;:]$/, ""), drawing: drawing ? drawing.replace(/\s+/g, " ").trim() : null, sheet: sheetKey(m[4]) };
}

export interface SheetRef { id: string; libraryId: string; label: string }
export interface MissingSheet { drawing: string; sheet: string; askedBy: Array<{ from: SheetRef; direction: "to" | "from"; tag: string }> }
export interface TagNotThere { from: SheetRef; to: SheetRef; direction: "to" | "from"; tag: string; raw: string }
export interface OneWay { from: SheetRef; to: SheetRef; direction: "to" | "from"; count: number; tags: string[] }

export interface ConnectorChecks {
  sheets: number;
  connectors: number;
  /** Connectors whose target sheet is on file, was read, and carries the tag. */
  holds: number;
  missingSheets: MissingSheet[];
  tagNotThere: TagNotThere[];
  oneWay: OneWay[];
  /** Counted apart, not faults: nothing to check them against. */
  unchecked: { noTarget: number; targetNotRead: number; noSheetRecorded: number; noSheetDrawings: string[] };
}

/** `tagsOn`: the equipment and instrument tags read on each sheet (by sheet
 *  id). A sheet with none counts as not read. */
export function checkConnectors(sheets: SheetOnFile[], reads: ConnectorRead[], tagsOn: Map<string, Iterable<string>>): ConnectorChecks {
  const byId = new Map(sheets.map((s) => [s.id, s]));
  const sheetOf = (s: SheetOnFile) => (s.sheet && /\d/.test(s.sheet) ? sheetKey(s.sheet) : sheetFromName(s.name));
  const ref = (s: SheetOnFile): SheetRef => ({ id: s.id, libraryId: s.libraryId, label: `${drawingLabel(drawingOf(s.number) ?? s.number)}${sheetOf(s) ? ` sheet ${sheetOf(s)}` : ""}` });
  const byKey = new Map<string, SheetOnFile>();
  const drawingsOnFile = new Map<string, { display: string; withSheet: number; without: number }>();
  for (const s of sheets) {
    const d = drawingOf(s.number);
    if (!d) continue;
    const k = drawingKey(d), sh = sheetOf(s);
    const row = drawingsOnFile.get(k) ?? { display: drawingLabel(d), withSheet: 0, without: 0 };
    if (sh) { row.withSheet++; byKey.set(`${k}|${sh}`, s); } else row.without++;
    drawingsOnFile.set(k, row);
  }
  const tags = new Map<string, Set<string>>();
  for (const [id, list] of tagsOn) tags.set(id, new Set([...list].map(connectorTagKey)));

  const out: ConnectorChecks = { sheets: byKey.size, connectors: 0, holds: 0, missingSheets: [], tagNotThere: [], oneWay: [], unchecked: { noTarget: 0, targetNotRead: 0, noSheetRecorded: 0, noSheetDrawings: [] } };
  const missing = new Map<string, MissingSheet>();
  const noSheet = new Set<string>();
  // sheet pair, by direction: who says what about whom.
  const says = new Map<string, { count: number; tags: Set<string> }>();
  const seen = new Set<string>();
  for (const r of reads) {
    const from = byId.get(r.sheetId);
    if (!from) continue;
    const dedupe = `${r.sheetId}|${r.raw.trim().toUpperCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.connectors++;
    const c = parseConnector(r.raw);
    const own = drawingOf(from.number);
    const drawing = c ? c.drawing ?? own : null;
    if (!c || !drawing) { out.unchecked.noTarget++; continue; }
    const dk = drawingKey(drawing);
    const to = byKey.get(`${dk}|${c.sheet}`);
    if (!to) {
      const onFile = drawingsOnFile.get(dk);
      // The drawing is on file with no sheet number recorded: it may well be that sheet.
      if (onFile && onFile.without > 0) { out.unchecked.noSheetRecorded++; noSheet.add(onFile.display); continue; }
      const k = `${dk}|${c.sheet}`;
      const row = missing.get(k) ?? { drawing: onFile?.display ?? drawingLabel(drawing), sheet: c.sheet, askedBy: [] };
      row.askedBy.push({ from: ref(from), direction: c.direction, tag: c.tag });
      missing.set(k, row);
      continue;
    }
    if (to.id === from.id) { out.unchecked.noTarget++; continue; }
    const pair = `${from.id}|${to.id}|${c.direction}`;
    const p = says.get(pair) ?? { count: 0, tags: new Set<string>() };
    p.count++; p.tags.add(c.tag);
    says.set(pair, p);
    const there = tags.get(to.id);
    if (!there || there.size === 0) { out.unchecked.targetNotRead++; continue; }
    if (there.has(connectorTagKey(c.tag))) out.holds++;
    else out.tagNotThere.push({ from: ref(from), to: ref(to), direction: c.direction, tag: c.tag, raw: r.raw.trim() });
  }
  // The other side: A sends TO B, so B shows something FROM A; and the reverse.
  for (const [pair, p] of says) {
    const [a, b, dir] = pair.split("|") as [string, string, "to" | "from"];
    const back = `${b}|${a}|${dir === "to" ? "from" : "to"}`;
    if (says.has(back)) continue;
    const A = byId.get(a)!, B = byId.get(b)!;
    // Nothing read on the other sheet: it cannot be said to be silent.
    if (!(tags.get(b)?.size)) continue;
    out.oneWay.push({ from: ref(A), to: ref(B), direction: dir, count: p.count, tags: [...p.tags].sort() });
  }
  const byLabel = (x: SheetRef, y: SheetRef) => x.label.localeCompare(y.label, undefined, { numeric: true });
  out.missingSheets = [...missing.values()].sort((x, y) => x.drawing.localeCompare(y.drawing, undefined, { numeric: true }) || Number(x.sheet) - Number(y.sheet));
  out.tagNotThere.sort((x, y) => byLabel(x.from, y.from) || x.tag.localeCompare(y.tag, undefined, { numeric: true }));
  out.oneWay.sort((x, y) => byLabel(x.from, y.from) || byLabel(x.to, y.to));
  out.unchecked.noSheetDrawings = [...noSheet].sort();
  return out;
}

/** One line a drafter can act on. */
export const missingLine = (m: MissingSheet) =>
  `${m.drawing} sheet ${m.sheet} is not on file. ${m.askedBy.length} connector${m.askedBy.length === 1 ? "" : "s"} point${m.askedBy.length === 1 ? "s" : ""} to it.`;
export const tagLine = (t: TagNotThere) =>
  `${t.from.label} shows ${t.tag} ${t.direction === "to" ? "going to" : "coming from"} ${t.to.label}. ${t.tag} was not read on that sheet.`;
export const oneWayLine = (o: OneWay) =>
  o.direction === "to"
    ? `${o.from.label} sends ${o.count} line${o.count === 1 ? "" : "s"} to ${o.to.label} (${o.tags.join(", ")}). That sheet shows nothing coming from it.`
    : `${o.from.label} takes ${o.count} line${o.count === 1 ? "" : "s"} from ${o.to.label} (${o.tags.join(", ")}). That sheet shows nothing going to it.`;
