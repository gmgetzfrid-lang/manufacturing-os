// staffingPlan - a contractor's staffing plan read from its spreadsheet:
// crafts down the side, dates across the top with a Day and a Night column
// each, heads in the cells (the way Schultz sends it). Turned into hands on
// the tools (direct) and supervision and support (indirect) for every day
// and night shift, by date, so each phase (Transmix-1, LRU, Transmix-2 back
// to back) lines up with its own dates.
//
// Pure: the spreadsheet is read in the browser (xlsx) and its rows handed
// here; the result is kept in the project's settings.

export interface PlanShift { direct: number; indirect: number }
/** A craft on the plan: its name and code as the sheet has them, and
 *  whether it is on the tools (direct) or supervision and support. */
export interface PlanCraft { name: string; code: string; direct: boolean }
export interface StaffingPlan {
  /** The file it was read from ("" when typed in). */
  file: string;
  /** When it was read, and by whom. */
  at: string;
  by: string | null;
  /** "YYYY-MM-DD:day" / ":night" → hands. */
  shifts: Record<string, PlanShift>;
  /** The phases the sheet names over its dates ("Transmix-1" from 10/26). */
  phases?: Array<{ name: string; from: string }>;
  /** The crafts, and each shift's heads by craft (what a rate sheet prices). */
  crafts?: PlanCraft[];
  byCraft?: Record<string, Record<string, number>>;
  /** Where each stretch of dates came from: one sheet per phase, or typed in. */
  sources?: PlanSource[];
}
export interface PlanSource { file: string; from: string; to: string; at: string; by: string | null }
/** By company ("Schultz"). */
export type StaffingPlans = Record<string, StaffingPlan>;

/** Craft codes that are supervision, support or staff, not on the tools. */
const INDIRECT_CODES = new Set(["FM", "GF", "SPV", "ENG", "CLK", "QC", "HW", "INS", "SAF", "SFT", "ADM", "TK", "TR", "MGR", "SUP"]);
const INDIRECT_WORDS = /foreman|forem|superintend|supervis|manager|mgr|engineer|clerk|admin|buyer|estimator|coordinator|planner|scheduler|safety|watch|qc|quality|inspector|tool ?room|timekeeper|office|cost/i;

export function isDirectCraft(name: string, code?: string | null): boolean {
  const c = String(code ?? "").trim().toUpperCase();
  if (c && INDIRECT_CODES.has(c)) return false;
  return !INDIRECT_WORDS.test(name);
}

const dayOf = (v: unknown): string | null => {
  // A date cell is midnight where the sheet was read: noon UTC of it is the same day east or west of UTC.
  if (v instanceof Date && Number.isFinite(v.getTime())) return new Date(v.getTime() + 12 * 3_600_000).toISOString().slice(0, 10);
  if (typeof v === "number" && v > 30000 && v < 80000) {
    // A spreadsheet serial date (days since 1899-12-30).
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (us) { const y = us[3].length === 2 ? `20${us[3]}` : us[3]; return `${y}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`; }
  return null;
};

/** Read the grid. Null when it isn't shaped like a staffing plan (no row of
 *  Day/Night under a row of dates). */
export interface PlanGrid {
  shifts: Record<string, PlanShift>;
  crafts: Array<PlanCraft & { peak: number }>;
  byCraft: Record<string, Record<string, number>>;
  phases: Array<{ name: string; from: string }>;
  /** The runs of dates the sheet names ("Transmix-1", Oct 26 to Oct 31), with people in them. */
  bands: PlanBand[];
  from: string; to: string;
}
export interface PlanBand { name: string; from: string; to: string; shifts: string[]; heads: number }

export function parseStaffingGrid(rows: unknown[][]): PlanGrid | null {
  // The Day/Night row, and the dates above it.
  let dn = -1;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const n = (rows[r] ?? []).filter((v) => /^(day|night)$/i.test(String(v ?? "").trim())).length;
    if (n >= 2) { dn = r; break; }
  }
  if (dn < 1) return null;
  const dates = rows[dn - 1] ?? [];
  const cols = new Map<number, string>();
  let cur: string | null = null;
  for (let c = 0; c < (rows[dn] ?? []).length; c++) {
    const d = dayOf(dates[c]); if (d) cur = d;
    const kind = String(rows[dn][c] ?? "").trim().toLowerCase();
    if (cur && (kind === "day" || kind === "night")) cols.set(c, `${cur}:${kind}`);
  }
  if (!cols.size) return null;
  // Phases named over the dates ("Transmix-1" above its first day).
  const phases: Array<{ name: string; from: string }> = [];
  for (let r = 0; r < dn - 1; r++) {
    const row = rows[r] ?? [];
    if (!/^phases?:?$/i.test(String(row[0] ?? "").trim())) continue;
    for (let c = 1; c < row.length; c++) {
      const v = String(row[c] ?? "").trim();
      if (!v || !cols.has(c) && !cols.has(c + 1)) continue;
      const k = cols.get(c) ?? cols.get(c + 1);
      if (k && !/^phases?:?$/i.test(v)) phases.push({ name: v, from: k.split(":")[0] });
    }
  }
  const shifts: Record<string, PlanShift> = {};
  const byCraft: Record<string, Record<string, number>> = {};
  const crafts: Array<PlanCraft & { peak: number }> = [];
  for (let r = dn + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    let name = String(row[0] ?? "").trim();
    if (!name || /^total/i.test(name)) continue;
    const code = String(row[1] ?? "").trim();
    const direct = isDirectCraft(name, code);
    // The same craft name twice on a sheet (two "Project Manager" rows) is kept as two.
    if (crafts.some((c) => c.name === name)) name = `${name} (${crafts.filter((c) => c.name.startsWith(name)).length + 1})`;
    let peak = 0;
    for (const [c, k] of cols) {
      const n = Number(row[c]);
      if (!Number.isFinite(n) || n <= 0) continue;
      const cell = shifts[k] ?? (shifts[k] = { direct: 0, indirect: 0 });
      if (direct) cell.direct += n; else cell.indirect += n;
      (byCraft[k] ??= {})[name] = n;
      peak = Math.max(peak, n);
    }
    if (peak > 0) crafts.push({ name, code, direct, peak });
  }
  const used = Object.keys(shifts).sort();
  if (!used.length) return null;
  return { shifts, crafts, byCraft, phases, bands: bandsOf(phases, used, shifts), from: used[0].split(":")[0], to: used[used.length - 1].split(":")[0] };
}

/** The sheet's named runs of dates that have people in them, each with its
 *  shifts. With no names on the sheet, the whole plan is one run. */
export function bandsOf(phases: Array<{ name: string; from: string }>, used: string[], shifts: Record<string, PlanShift>): PlanBand[] {
  const named = [...phases].sort((a, b) => a.from.localeCompare(b.from));
  const nameAt = (day: string) => [...named].reverse().find((p) => p.from <= day)?.name ?? "The plan";
  const out = new Map<string, PlanBand>();
  for (const k of used) {
    const day = k.split(":")[0], name = named.length ? nameAt(day) : "The plan";
    const b = out.get(name) ?? { name, from: day, to: day, shifts: [], heads: 0 };
    b.shifts.push(k); b.to = day > b.to ? day : b.to; b.from = day < b.from ? day : b.from;
    b.heads += shifts[k].direct + shifts[k].indirect;
    out.set(name, b);
  }
  return [...out.values()].sort((a, b) => a.from.localeCompare(b.from));
}

/** Where a run of the sheet's dates belongs on this project: the phase its
 *  dates fall in (most of its shifts), else null (not this project). A
 *  project with no phases takes the run whose dates overlap its own. */
export function bandTarget(band: PlanBand, phases: Array<{ id: string; start: string | null; end: string | null }>, span?: { start: string | null; end: string | null }): string | null {
  const days = band.shifts.map((k) => k.split(":")[0]);
  const within = (s: string | null, e: string | null) => days.filter((d) => (!s || d >= s) && (!e || d <= e)).length;
  if (phases.length) {
    const best = phases.map((p) => ({ id: p.id, n: within(p.start, p.end) })).sort((a, b) => b.n - a.n)[0];
    return best && best.n * 2 >= days.length ? best.id : null;
  }
  if (!span || (!span.start && !span.end)) return "project";
  return within(span.start, span.end) * 2 >= days.length ? "project" : null;
}

/** The plan this project keeps from a sheet: the runs picked, by craft. */
export function planFromGrid(g: PlanGrid, keep: (band: PlanBand) => boolean, meta: { file: string; at: string; by: string | null }, direct?: Record<string, boolean>): StaffingPlan {
  const keys = new Set(g.bands.filter(keep).flatMap((b) => b.shifts));
  const crafts = g.crafts.map(({ name, code, direct: d }) => ({ name, code, direct: direct?.[name] ?? d }));
  const byCraft: Record<string, Record<string, number>> = {};
  for (const k of keys) if (g.byCraft[k]) byCraft[k] = { ...g.byCraft[k] };
  const used = new Set(Object.values(byCraft).flatMap((m) => Object.keys(m)));
  const kept = crafts.filter((c) => used.has(c.name));
  return { ...meta, phases: g.phases, crafts: kept, byCraft, shifts: totalsOf(byCraft, kept) };
}

/** Each shift's direct and indirect hands from its heads by craft. */
export function totalsOf(byCraft: Record<string, Record<string, number>>, crafts: PlanCraft[]): Record<string, PlanShift> {
  const isDirect = new Map(crafts.map((c) => [c.name, c.direct]));
  const out: Record<string, PlanShift> = {};
  for (const [k, m] of Object.entries(byCraft)) {
    let d = 0, i = 0;
    for (const [c, n] of Object.entries(m)) { if (!(n > 0)) continue; if (isDirect.get(c) ?? true) d += n; else i += n; }
    if (d + i > 0) out[k] = { direct: d, indirect: i };
  }
  return out;
}

/** A plan typed in: the same heads every day and night over a run of
 *  days for one craft (0 clears it). */
export function fillRange(plan: StaffingPlan, craft: PlanCraft, from: string, to: string, day: number, night: number): StaffingPlan {
  const byCraft: Record<string, Record<string, number>> = Object.fromEntries(Object.entries(plan.byCraft ?? {}).map(([k, m]) => [k, { ...m }]));
  for (let d = from; d <= to; d = nextDay(d)) {
    for (const [kind, n] of [["day", day], ["night", night]] as const) {
      const k = `${d}:${kind}`;
      if (n > 0) (byCraft[k] ??= {})[craft.name] = Math.round(n);
      else if (byCraft[k]) { delete byCraft[k][craft.name]; if (!Object.keys(byCraft[k]).length) delete byCraft[k]; }
    }
  }
  const crafts = (plan.crafts ?? []).some((c) => c.name === craft.name) ? plan.crafts!.map((c) => (c.name === craft.name ? craft : c)) : [...(plan.crafts ?? []), craft];
  return { ...plan, crafts, byCraft, shifts: totalsOf(byCraft, crafts) };
}

/** One shift's heads for one craft (0 clears it). */
export function setShiftHeads(plan: StaffingPlan, craft: string, key: string, n: number): StaffingPlan {
  const byCraft: Record<string, Record<string, number>> = Object.fromEntries(Object.entries(plan.byCraft ?? {}).map(([k, m]) => [k, { ...m }]));
  if (n > 0) (byCraft[key] ??= {})[craft] = Math.round(n);
  else if (byCraft[key]) { delete byCraft[key][craft]; if (!Object.keys(byCraft[key]).length) delete byCraft[key]; }
  return { ...plan, byCraft, shifts: totalsOf(byCraft, plan.crafts ?? []) };
}

export function nextDay(d: string): string {
  const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10);
}

/** The crafts a sheet usually lists, for picking one when typing a plan in. */
export const COMMON_CRAFTS: PlanCraft[] = [
  { name: "BoilerMaker Journeyman", code: "BM", direct: true }, { name: "Pipefitter Journeyman", code: "PF", direct: true },
  { name: "Welder Plater", code: "WE", direct: true }, { name: "Millwright Journeyman", code: "MW", direct: true },
  { name: "Electrician Journeyman", code: "EL", direct: true }, { name: "Laborer Journeyman", code: "LA", direct: true },
  { name: "Equipment Operator", code: "EO", direct: true }, { name: "Firewatch/Holewatch", code: "HW", direct: false },
  { name: "BoilerMaker Foreman", code: "FM", direct: false }, { name: "BoilerMaker Gen.Foreman", code: "GF", direct: false },
  { name: "Pipefitter Foreman", code: "FM", direct: false }, { name: "Project Manager", code: "SPV", direct: false },
  { name: "Quality Control Manager", code: "SPV", direct: false }, { name: "Safety Manager", code: "SPV", direct: false },
  { name: "Safety Tech", code: "SFTY", direct: false }, { name: "Time Keeper", code: "CLK", direct: false },
];

/** A plan's day and night hands over some dates, for saying it in words:
 *  "days 14 on the tools + 6, nights 4 + 2" (the most on any one day). */
export function planSummary(plan: StaffingPlan, from: string, to: string): { day: PlanShift; night: PlanShift } {
  const day = { direct: 0, indirect: 0 }, night = { direct: 0, indirect: 0 };
  for (const [k, v] of Object.entries(plan.shifts)) {
    const [d, kind] = k.split(":");
    if (d < from || d > to) continue;
    const t = kind === "night" ? night : day;
    if (v.direct + v.indirect > t.direct + t.indirect) { t.direct = v.direct; t.indirect = v.indirect; }
  }
  return { day, night };
}


// ─── One plan, put in a phase at a time ───────────────────────────

const dayOfKey = (k: string) => k.split(":")[0];
const keysOf = (pl: StaffingPlan) => [...new Set([...Object.keys(pl.shifts), ...Object.keys(pl.byCraft ?? {})])];
/** The dates a plan covers, first and last ("YYYY-MM-DD"). */
export function planSpan(pl: StaffingPlan): { from: string; to: string } | null {
  const ds = keysOf(pl).map(dayOfKey).sort();
  return ds.length ? { from: ds[0], to: ds[ds.length - 1] } : null;
}
/** Where a plan's dates came from; a plan saved before there were sources is one. */
export function sourcesOf(pl: StaffingPlan): PlanSource[] {
  if (pl.sources?.length) return pl.sources;
  const span = planSpan(pl);
  return span ? [{ file: pl.file, ...span, at: pl.at, by: pl.by }] : [];
}

/** A plan read (or typed) for some dates put into the one already in: the
 *  dates in `range` (a phase's; else the new plan's own) are replaced, every
 *  other date kept, so each phase can have its own sheet. */
export function mergePlan(old: StaffingPlan | null, next: StaffingPlan, range?: { from: string | null; to: string | null } | null): StaffingPlan {
  const own = planSpan(next);
  const from = range?.from ?? own?.from ?? "", to = range?.to ?? own?.to ?? "";
  const inR = (k: string) => { const d = dayOfKey(k); return (!from || d >= from) && (!to || d <= to); };
  const pick = <T,>(o: Record<string, T> | undefined, keep: (k: string) => boolean) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keep(k)));
  const mine = { shifts: pick(next.shifts, inR), byCraft: pick(next.byCraft, inR) };
  const src: PlanSource = { file: next.file, from: from || own?.from || "", to: to || own?.to || "", at: next.at, by: next.by };
  if (!old) return { ...next, ...mine, sources: [src] };
  const shifts = { ...pick(old.shifts, (k) => !inR(k)), ...mine.shifts };
  const byCraft = { ...pick(old.byCraft, (k) => !inR(k)), ...mine.byCraft };
  const used = new Set(Object.values(byCraft).flatMap((m) => Object.keys(m)));
  const crafts = [...(old.crafts ?? []), ...(next.crafts ?? []).filter((c) => !(old.crafts ?? []).some((o) => o.name === c.name))].filter((c) => used.has(c.name));
  const sources = [...sourcesOf(old).filter((x) => x.to < src.from || x.from > src.to), src].sort((x, y) => x.from.localeCompare(y.from));
  return { ...next, shifts, byCraft, crafts, sources, phases: [...(old.phases ?? []), ...(next.phases ?? [])] };
}

/** The plan with the dates in `range` taken out (a phase's plan removed);
 *  null when nothing is left. */
export function withoutRange(pl: StaffingPlan, range: { from: string | null; to: string | null }): StaffingPlan | null {
  const inR = (k: string) => { const d = dayOfKey(k); return (!range.from || d >= range.from) && (!range.to || d <= range.to); };
  const shifts = Object.fromEntries(Object.entries(pl.shifts).filter(([k]) => !inR(k)));
  if (!Object.keys(shifts).length) return null;
  const byCraft = Object.fromEntries(Object.entries(pl.byCraft ?? {}).filter(([k]) => !inR(k)));
  const sources = sourcesOf(pl).filter((x) => (range.from && x.to < range.from) || (range.to && x.from > range.to));
  return { ...pl, shifts, byCraft, sources };
}
