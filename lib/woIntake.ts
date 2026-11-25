// lib/woIntake.ts - a turnaround's scope from the work order list the
// planner already has (an Infor EAM export, sorted into an "approved" tab).
//
// The list changes shape from job to job and grows while it's planned, so
// nothing here depends on column order or names being exact: the tab is
// picked by its name ("approved") or by how many work orders it holds; the
// header row is found under any title rows; each column is found by its
// name and, failing that, by what's in it (six-digit work order numbers,
// equipment tags). Rows that aren't work orders but say who is still
// adding scope ("Waiting on PSVs (James R.)") become "scope still coming",
// each with its owner. A second import is compared by work order number:
// new, changed, dropped.
//
// Pure: the caller reads the file into sheets (readSheets, in the browser).

export interface Sheet { name: string; rows: string[][] }

export type ColumnRole = "wo" | "what" | "equipment" | "equipmentName" | "category" | "notes" | "drafted" | "approved" | "addedBy" | "added";

export const ROLE_WORD: Record<ColumnRole, string> = {
  wo: "Work order", what: "What", equipment: "Equipment", equipmentName: "Equipment name",
  category: "Group", notes: "Notes", drafted: "Package drafted", approved: "Package approved",
  addedBy: "Added by", added: "Date added",
};

export type ColumnMap = Partial<Record<ColumnRole, number>>;

export interface ScopeWO {
  wo: string;
  what: string;
  /** The equipment's number in the list ("2030.01"). */
  equipment: string;
  /** Its tag and name, from the equipment description ("X-1", "Middle Naphtha Cooler"). */
  tag: string;
  equipmentName: string;
  /** The list's own group ("Exchanger"); "Other" when blank. */
  category: string;
  notes: string;
  /** The notes say the work depends on what's found ("inspect for cleanliness"). */
  conditional: boolean;
  drafted: boolean;
  approved: boolean;
  addedBy?: string;
  added?: string;
  /** The work package, attached in the app: a controlled document. */
  pkg?: ScopePackage;
  approvedBy?: string;
  approvedAt?: string;
}

export interface ScopePackage { documentId: string; label: string; href: string; at: string; by?: string }

export interface ScopeComing { what: string; owner: string }

export interface ScopeRead {
  sheet: string;
  /** The title above the header ("CRUDE UNIT - APPROVED WORK"), if any. */
  title: string;
  headerRow: number;
  headers: string[];
  map: ColumnMap;
  items: ScopeWO[];
  coming: ScopeComing[];
  /** Rows that were neither a work order nor scope still coming. */
  skipped: number;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const WO_RE = /^\d{5,8}$/;
const isWo = (s: string) => WO_RE.test(s.replace(/\.0+$/, ""));

/** The tab with the approved work: its name says approved, else the one
 *  holding the most work order numbers. */
export function pickSheet(sheets: Sheet[]): number {
  const named = sheets.findIndex((s) => /approved/i.test(s.name));
  if (named >= 0) return named;
  let best = 0, most = -1;
  sheets.forEach((s, i) => {
    const n = s.rows.filter((r) => r.some((c) => isWo(clean(c)))).length;
    if (n > most) { most = n; best = i; }
  });
  return best;
}

/** The header row: within the first rows, the first with three or more
 *  short labels, one of them a work order heading (else the row above the
 *  first work order number). */
export function findHeader(rows: string[][]): number {
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map(clean).filter(Boolean);
    if (cells.length >= 3 && cells.some((c) => /^(work ?order|wo\b|wo ?#|w\.o\.)/i.test(c)) && cells.every((c) => c.length <= 60)) return i;
  }
  const first = rows.findIndex((r) => r.some((c) => isWo(clean(c))));
  return Math.max(0, first - 1);
}

const HEAD: Array<[ColumnRole, RegExp]> = [
  ["wo", /^(work ?order( ?(no|number|#))?|wo( ?(no|number|#))?|w\.o\.?)$/i],
  ["equipmentName", /^(equip\w*|asset|tag) ?desc/i],
  ["equipment", /^(equip\w*|asset|tag)( ?(no|number|id|#))?$/i],
  ["what", /^(description( of work)?|work description|pm description|task|scope|work)$/i],
  ["category", /^(category|group|discipline|work type|craft)$/i],
  ["notes", /^(notes?|comments?|status note)$/i],
  ["drafted", /drafted/i],
  ["approved", /package approved|pkg approved/i],
  ["addedBy", /^(created|added|entered) by$/i],
  ["added", /^(date (added|created)|added|created)$/i],
];

/** Which column is which: by its heading, then by its contents for the
 *  ones a list must have (work order, what, equipment). */
export function mapColumns(headers: string[], body: string[][]): ColumnMap {
  const map: ColumnMap = {};
  const taken = new Set<number>();
  for (const [role, re] of HEAD) {
    const i = headers.findIndex((h, j) => !taken.has(j) && re.test(clean(h)));
    if (i >= 0) { map[role] = i; taken.add(i); }
  }
  const colVals = (j: number) => body.map((r) => clean(r[j])).filter(Boolean);
  const width = Math.max(headers.length, ...body.slice(0, 50).map((r) => r.length));
  if (map.wo == null) {
    for (let j = 0; j < width; j++) {
      const v = colVals(j);
      if (!taken.has(j) && v.length && v.filter(isWo).length / v.length >= 0.7) { map.wo = j; taken.add(j); break; }
    }
  }
  if (map.what == null) {
    // The longest text column left.
    let best = -1, len = 0;
    for (let j = 0; j < width; j++) {
      if (taken.has(j)) continue;
      const v = colVals(j);
      const avg = v.length ? v.reduce((a, s) => a + s.length, 0) / v.length : 0;
      if (avg > len && v.filter((s) => /[a-z]{3}/i.test(s)).length >= v.length * 0.7) { len = avg; best = j; }
    }
    if (best >= 0) { map.what = best; taken.add(best); }
  }
  return map;
}

const truthy = (s: string) => /^(true|yes|y|x|✓|done|1)$/i.test(s);

/** "X-1 - Middle Naphtha Cooler" → X-1, Middle Naphtha Cooler. */
export function splitTag(desc: string): { tag: string; name: string } {
  const m = desc.match(/^([A-Z]{1,4}-?\d{1,4}[A-Z]?)\s*[-–]\s*(.+)$/i);
  return m ? { tag: m[1].toUpperCase(), name: m[2].trim() } : { tag: "", name: desc };
}

/** Notes that make the work depend on what's found. */
export const CONDITIONAL_RE = /inspect for clean|check for clean|if (needed|required|dirty|found)|as needed|conditional/i;

/** "** Waiting on Control Valves (Scott F.), environmental equipment (Gabe
 *  C.), PSVs (James R.), and inspections(MI)." → four items, each with
 *  its owner. Text that isn't a list of that kind is one item, no owner. */
export function comingFrom(text: string): ScopeComing[] {
  let t = clean(text).replace(/^[*•\-\s]+/, "").replace(/\.$/, "");
  t = t.replace(/^(still )?(waiting|pending|to come|outstanding)( on| from)?[:\s]*/i, "");
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of t) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  const out = parts.map((p) => p.trim().replace(/^and\s+/i, "")).filter(Boolean).map((p) => {
    const m = p.match(/^(.*?)\s*\(([^)]+)\)$/);
    const what = (m ? m[1] : p).trim();
    return { what: what ? what[0].toUpperCase() + what.slice(1) : what, owner: m ? m[2].trim() : "" };
  });
  return out.length ? out : [{ what: clean(text), owner: "" }];
}

/** A row that says scope is still to come. */
const COMING_RE = /waiting on|still (to come|coming|adding)|pending|to be added|outstanding/i;

/** Read one sheet into the scope. `map` overrides the columns found. */
export function readScope(sheet: Sheet, override?: ColumnMap): ScopeRead {
  const rows = sheet.rows.map((r) => r.map(clean));
  const h = findHeader(rows);
  const headers = rows[h] ?? [];
  const body = rows.slice(h + 1);
  const map = { ...mapColumns(headers, body), ...(override ?? {}) };
  const title = rows.slice(0, h).flat().find((c) => c.length > 3) ?? "";
  const at = (r: string[], role: ColumnRole) => (map[role] != null ? clean(r[map[role]!]) : "");
  const items: ScopeWO[] = [];
  const coming: ScopeComing[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of body) {
    if (!r.some(Boolean)) continue;
    const wo = at(r, "wo").replace(/\.0+$/, "");
    if (isWo(wo)) {
      if (seen.has(wo)) { skipped++; continue; }
      seen.add(wo);
      const eqName = at(r, "equipmentName");
      const { tag, name } = splitTag(eqName);
      const notes = at(r, "notes");
      items.push({
        wo, what: at(r, "what"), equipment: at(r, "equipment"), tag, equipmentName: name,
        category: at(r, "category") || "Other", notes,
        conditional: CONDITIONAL_RE.test(notes),
        drafted: truthy(at(r, "drafted")), approved: truthy(at(r, "approved")),
        ...(at(r, "addedBy") ? { addedBy: at(r, "addedBy") } : {}),
        ...(at(r, "added") ? { added: at(r, "added") } : {}),
      });
      continue;
    }
    const text = r.find((c) => c.length > 12) ?? "";
    if (text && COMING_RE.test(text)) coming.push(...comingFrom(text));
    else skipped++;
  }
  return { sheet: sheet.name, title, headerRow: h, headers, map, items, coming, skipped };
}

/** A project name from the list's title or the file's name: "CRUDE UNIT -
 *  APPROVED WORK" → "Crude Unit Turnaround". */
export function nameFrom(title: string, file: string): string {
  const fromTitle = title.split(/\s+[-–]\s+/)[0]?.trim() ?? "";
  const base = fromTitle && !/approved|work order|pm list/i.test(fromTitle) ? fromTitle
    : file.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").replace(/\b(PM|WO|and|List|&)\b/gi, " ").replace(/\s+/g, " ").trim();
  // An all-capitals title is title-cased ("CRUDE UNIT" → "Crude Unit"); a
  // mixed-case one keeps its words as written ("Crude NHT").
  const words = base === base.toUpperCase() ? base.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : base.replace(/\b\w/g, (c) => c.toUpperCase());
  return /turnaround|outage|shutdown/i.test(words) ? words : `${words} Turnaround`;
}

/** Work orders by group, biggest first: each with how many pieces of
 *  equipment and work orders. */
export function byCategory(items: ScopeWO[]): Array<{ category: string; equipment: number; items: ScopeWO[] }> {
  const m = new Map<string, ScopeWO[]>();
  for (const x of items) m.set(x.category, [...(m.get(x.category) ?? []), x]);
  return [...m.entries()].map(([category, list]) => ({ category, equipment: new Set(list.map((x) => x.equipment || x.wo)).size, items: list }))
    .sort((a, b) => b.items.length - a.items.length || a.category.localeCompare(b.category));
}

/** Pieces of equipment with more than one work order (one package each?). */
export function shared(items: ScopeWO[]): Array<{ equipment: string; tag: string; wos: string[] }> {
  const m = new Map<string, ScopeWO[]>();
  for (const x of items) if (x.equipment) m.set(x.equipment, [...(m.get(x.equipment) ?? []), x]);
  return [...m.entries()].filter(([, l]) => l.length > 1).map(([equipment, l]) => ({ equipment, tag: l.find((x) => x.tag)?.tag ?? "", wos: l.map((x) => x.wo) }));
}

export interface ScopeDiff {
  added: ScopeWO[];
  changed: Array<{ before: ScopeWO; after: ScopeWO; fields: Array<"what" | "equipment" | "category" | "notes"> }>;
  dropped: ScopeWO[];
  same: number;
}

/** The new list against the one the project has, by work order number. */
export function diffScope(before: ScopeWO[], after: ScopeWO[]): ScopeDiff {
  const old = new Map(before.map((x) => [x.wo, x]));
  const now = new Map(after.map((x) => [x.wo, x]));
  const added = after.filter((x) => !old.has(x.wo));
  const dropped = before.filter((x) => !now.has(x.wo));
  const changed: ScopeDiff["changed"] = [];
  let same = 0;
  for (const a of after) {
    const b = old.get(a.wo);
    if (!b) continue;
    const fields = (["what", "equipment", "category", "notes"] as const).filter((k) => clean(b[k]) !== clean(a[k]));
    if (fields.length) changed.push({ before: b, after: a, fields: [...fields] });
    else same++;
  }
  return { added, changed, dropped, same };
}

/** The list after an import is applied: the new rows; a work order the
 *  project already had keeps its package progress (drafted / approved
 *  set in the app stays set). */
export function applyScope(before: ScopeWO[], after: ScopeWO[]): ScopeWO[] {
  const old = new Map(before.map((x) => [x.wo, x]));
  return after.map((a) => {
    const b = old.get(a.wo);
    return b ? { ...a, drafted: a.drafted || b.drafted, approved: a.approved || b.approved, ...(b.pkg ? { pkg: b.pkg } : {}), ...(b.approvedBy ? { approvedBy: b.approvedBy, approvedAt: b.approvedAt } : {}) } : a;
  });
}

/** A piece of equipment with its own number or tag ("X-1", "2030.01"), as
 *  opposed to a whole unit ("20 - Crude"): its work orders share a package. */
export const realEquipment = (x: ScopeWO) => !!x.tag || /^\d{3,5}[.-][\w.-]+$/.test(x.equipment);

/** The work orders one package covers: this one and, on a piece of
 *  equipment, every other work order of the same kind on it (X-1's service
 *  and its coating; not H-2's decoke and its I/E checks). */
export function packageGroup(items: ScopeWO[], wo: string): ScopeWO[] {
  const x = items.find((i) => i.wo === wo);
  if (!x) return [];
  return realEquipment(x) ? items.filter((i) => i.equipment === x.equipment && i.category === x.category) : [x];
}

/** The scope against the schedule's work order numbers. */
export function againstSchedule(items: ScopeWO[], scheduled: Iterable<string>): { on: ScopeWO[]; missing: ScopeWO[]; extra: string[] } {
  const sched = new Set([...scheduled].map((s) => s.trim()).filter(Boolean));
  const mine = new Set(items.map((x) => x.wo));
  return {
    on: items.filter((x) => sched.has(x.wo)),
    missing: items.filter((x) => !sched.has(x.wo)),
    extra: [...sched].filter((w) => !mine.has(w)).sort(),
  };
}
