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
  /** Added in the app (typed in, or taken from the schedule), not from the
   *  list file: a new import of the list keeps it. */
  typed?: boolean;
  /** When it joined the scope, after the first list (scope growth). */
  addedAt?: string;
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
  /** Removed in the app and still in the list: they stay removed. */
  stillRemoved?: ScopeWO[];
  added: ScopeWO[];
  changed: Array<{ before: ScopeWO; after: ScopeWO; fields: Array<"what" | "equipment" | "category" | "notes"> }>;
  dropped: ScopeWO[];
  same: number;
}

/** The new list against the one the project has, by work order number. */
export function diffScope(before: ScopeWO[], after: ScopeWO[], removed: Iterable<string> = []): ScopeDiff {
  const old = new Map(before.map((x) => [x.wo, x]));
  const now = new Map(after.map((x) => [x.wo, x]));
  const gone = new Set(removed);
  const added = after.filter((x) => !old.has(x.wo) && !gone.has(x.wo));
  // Work added in the app isn't in the list file: it isn't dropped.
  const dropped = before.filter((x) => !now.has(x.wo) && !x.typed);
  const stillRemoved = after.filter((x) => gone.has(x.wo));
  const changed: ScopeDiff["changed"] = [];
  let same = 0;
  for (const a of after) {
    const b = old.get(a.wo);
    if (!b) continue;
    const fields = (["what", "equipment", "category", "notes"] as const).filter((k) => clean(b[k]) !== clean(a[k]));
    if (fields.length) changed.push({ before: b, after: a, fields: [...fields] });
    else same++;
  }
  return { added, changed, dropped, same, ...(stillRemoved.length ? { stillRemoved } : {}) };
}

/** The list after an import is applied: the new rows; a work order the
 *  project already had keeps its package progress (drafted / approved
 *  set in the app stays set). */
export function applyScope(before: ScopeWO[], after: ScopeWO[], removed: Iterable<string> = [], at?: string): ScopeWO[] {
  const old = new Map(before.map((x) => [x.wo, x]));
  const gone = new Set(removed);
  const now = new Set(after.map((x) => x.wo));
  const fromList = after.filter((a) => !gone.has(a.wo)).map((a) => {
    const b = old.get(a.wo);
    // New since the first list: when it joined (scope growth).
    if (!b) return at && before.length ? { ...a, addedAt: at } : a;
    return { ...a, drafted: a.drafted || b.drafted, approved: a.approved || b.approved, ...(b.pkg ? { pkg: b.pkg } : {}), ...(b.approvedBy ? { approvedBy: b.approvedBy, approvedAt: b.approvedAt } : {}), ...(b.addedAt ? { addedAt: b.addedAt } : {}) };
  });
  // Work added in the app stays (the list file doesn't have it).
  return [...fromList, ...before.filter((b) => b.typed && !now.has(b.wo))];
}

/** A work order number as written anywhere ("WO 400101", "W/O# 400101"). */
export const woKey = (s: string | null | undefined) => clean(s).replace(/^w\/?o\s*(#|no\.?|num(ber)?)?\s*[:#-]?\s*/i, "");

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
export function againstSchedule(items: ScopeWO[], scheduled: Iterable<string>, named: Iterable<string> = []): { on: ScopeWO[]; missing: ScopeWO[]; extra: string[] } {
  const sched = new Set([...scheduled].map(woKey).filter(Boolean));
  // A number in a step's name ("400101 Pull bundle") counts as on it too.
  const inNames = new Set([...named].map(woKey));
  const has = (wo: string) => sched.has(wo) || inNames.has(wo);
  const mine = new Set(items.map((x) => x.wo));
  // Work typed in without a work order number can't be matched by number.
  const numbered = items.filter((x) => !isTypedItem(x.wo));
  return {
    on: numbered.filter((x) => has(x.wo)),
    missing: numbered.filter((x) => !has(x.wo)),
    extra: [...sched].filter((w) => !mine.has(w)).sort(),
  };
}

/** A job typed in with no work order number is kept as "item-N". */
export const isTypedItem = (wo: string) => /^item-\d+$/.test(wo);

/** A job typed in by hand: what, and its equipment and work order number
 *  when there are any. */
export function typedItem(v: { what: string; equipment?: string; wo?: string; group?: string }, items: ScopeWO[]): ScopeWO {
  const wo = woKey(v.wo);
  const used = new Set(items.map((x) => x.wo));
  let key = wo;
  if (!key || used.has(key)) { let n = items.filter((x) => isTypedItem(x.wo)).length + 1; while (used.has(`item-${n}`)) n++; key = `item-${n}`; }
  const eq = clean(v.equipment);
  const { tag, name } = splitTag(eq);
  return { wo: key, what: clean(v.what), equipment: eq, tag: tag || (/^[A-Z]{1,4}-?\d{1,4}[A-Z]?$/i.test(eq) ? eq.toUpperCase() : ""), equipmentName: tag ? name : (/^[A-Z]{1,4}-?\d{1,4}[A-Z]?$/i.test(eq) ? "" : eq),
    category: clean(v.group) || "Work", notes: "", conditional: false, drafted: false, approved: false, typed: true };
}

// ── The schedule, by work order ──

/** A schedule row as read for the scope (lib/scopeStore scheduleFacts). */
export interface SchedRow {
  id: string; name: string; parent_id: string | null; work_order_ref: string | null;
  attributes?: Record<string, unknown> | null; status?: string | null; percent_complete?: number | null; cancelled_at?: string | null;
}
/** One work order on the schedule: its steps (the bottom rows), how many are
 *  done or started, whether it was cancelled there, and the rows that carry
 *  its number at the top (what cancelling it cancels). */
export interface WoOnSchedule { name: string; steps: number; done: number; started: number; cancelled: boolean; owners: string[];
  /** A row carrying it has other work orders under it: cancelling that row
   *  would take them off too, so it's left to the Work tab. */
  mixed?: boolean }

const WO_FIELD = /^\s*(work\s*order|wo|w\/o)\s*(#|no\.?|num(ber)?|ref)?\s*$/i;

/** Each work order on the schedule. A row's number is its WO column, else a
 *  custom field named for it (P6 "WO#"), else the nearest row above it with
 *  one. Numbers written in step names are kept apart ("named"): they count
 *  for matching the list, never as extra work. */
export function scheduleByWo(rows: SchedRow[]): { byWo: Record<string, WoOnSchedule>; named: string[] } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parents = new Set(rows.map((r) => r.parent_id).filter(Boolean) as string[]);
  const own = (r: SchedRow) => {
    const w = woKey(r.work_order_ref);
    if (w) return w;
    for (const [k, v] of Object.entries(r.attributes ?? {})) if (WO_FIELD.test(k) && (typeof v === "string" || typeof v === "number") && woKey(String(v))) return woKey(String(v));
    return "";
  };
  const memo = new Map<string, string>();
  const woFor = (r: SchedRow): string => {
    if (memo.has(r.id)) return memo.get(r.id)!;
    let w = own(r);
    const seen = new Set([r.id]);
    for (let p = r.parent_id ? byId.get(r.parent_id) : undefined; !w && p && !seen.has(p.id); p = p.parent_id ? byId.get(p.parent_id) : undefined) { seen.add(p.id); w = own(p); }
    memo.set(r.id, w);
    return w;
  };
  const byWo: Record<string, WoOnSchedule> = {};
  const all = new Map<string, { rows: number; cancelled: number }>();
  const named = new Set<string>();
  for (const r of rows) {
    const w = woFor(r);
    if (!r.cancelled_at) for (const m of r.name.matchAll(/\b\d{5,9}\b/g)) named.add(m[0]);
    if (!w) continue;
    // Cancelled when every bottom row of it is.
    const a = all.get(w) ?? { rows: 0, cancelled: 0 };
    if (!parents.has(r.id)) { a.rows++; if (r.cancelled_at) a.cancelled++; }
    all.set(w, a);
    const o = byWo[w] ?? (byWo[w] = { name: "", steps: 0, done: 0, started: 0, cancelled: false, owners: [] });
    const up = r.parent_id ? byId.get(r.parent_id) : undefined;
    if (own(r) === w && (!up || woFor(up) !== w)) { o.owners.push(r.id); if (!o.name) o.name = r.name; }
    if (parents.has(r.id) || r.cancelled_at) continue;
    const pct = Number(r.percent_complete ?? 0);
    const done = r.status === "completed" || pct >= 100;
    o.steps++;
    if (done) o.done++;
    if (done || pct > 0 || r.status === "in_progress") o.started++;
  }
  for (const [w, a] of all) byWo[w].cancelled = a.rows > 0 && a.cancelled === a.rows;
  // An owner row with another work order under it.
  const ownerOf = new Map<string, string>();
  for (const [w, o] of Object.entries(byWo)) for (const id of o.owners) ownerOf.set(id, w);
  for (const r of rows) {
    const w = woFor(r);
    const seen = new Set([r.id]);
    for (let p = r.parent_id ? byId.get(r.parent_id) : undefined; p && !seen.has(p.id); p = p.parent_id ? byId.get(p.parent_id) : undefined) {
      seen.add(p.id);
      const pw = ownerOf.get(p.id);
      if (pw && pw !== w) byWo[pw].mixed = true;
    }
  }
  return { byWo, named: [...named] };
}
