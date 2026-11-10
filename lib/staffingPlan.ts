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
export interface StaffingPlan {
  file: string;
  /** When it was read, and by whom. */
  at: string;
  by: string | null;
  /** "YYYY-MM-DD:day" / ":night" → hands. */
  shifts: Record<string, PlanShift>;
  /** The phases the sheet names over its dates ("Transmix-1" from 10/26). */
  phases?: Array<{ name: string; from: string }>;
}
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
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString().slice(0, 10);
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
export function parseStaffingGrid(rows: unknown[][]): { shifts: Record<string, PlanShift>; crafts: Array<{ name: string; code: string; direct: boolean; peak: number }>; phases: Array<{ name: string; from: string }>; from: string; to: string } | null {
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
  const crafts: Array<{ name: string; code: string; direct: boolean; peak: number }> = [];
  for (let r = dn + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const name = String(row[0] ?? "").trim();
    if (!name || /^total/i.test(name)) continue;
    const code = String(row[1] ?? "").trim();
    const direct = isDirectCraft(name, code);
    let peak = 0;
    for (const [c, k] of cols) {
      const n = Number(row[c]);
      if (!Number.isFinite(n) || n <= 0) continue;
      const cell = shifts[k] ?? (shifts[k] = { direct: 0, indirect: 0 });
      if (direct) cell.direct += n; else cell.indirect += n;
      peak = Math.max(peak, n);
    }
    if (peak > 0) crafts.push({ name, code, direct, peak });
  }
  const used = Object.keys(shifts).sort();
  if (!used.length) return null;
  return { shifts, crafts, phases, from: used[0].split(":")[0], to: used[used.length - 1].split(":")[0] };
}

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
