// rateSheet - what each craft costs an hour on a contractor's rate sheet:
// straight time, overtime and double time, and a per diem a head a day.
// A shift is paid as the contract says (California daily overtime unless
// changed: straight time for the first 8 hours, time and a half to 12,
// double time past 12). Overtime and double time are 1.5 and 2 times
// straight time until the sheet says otherwise.
//
// Pure: the sheet is read in the browser and kept in the project's
// settings (lib/crewSettings).

import type { PlanCraft } from "@/lib/staffingPlan";

export interface CraftRate { st: number; ot?: number | null; dt?: number | null }
export interface RateSheet {
  /** By craft name, as the staffing plan has it. */
  crafts: Record<string, CraftRate>;
  /** $ a head for each day worked. */
  perDiem?: number | null;
  /** Hours paid for one shift (null: the shift's length). */
  paidHours?: number | null;
  /** Straight time for the first this many hours of a shift. */
  stHours?: number | null;
  /** Double time past this many hours. */
  dtAfter?: number | null;
  /** The file it was read from, when it was uploaded. */
  file?: string;
  at?: string;
  by?: string | null;
}
/** By company ("Schultz"). */
export type RateSheets = Record<string, RateSheet>;

export const RULES = { stHours: 8, dtAfter: 12 } as const;

/** A craft's rate of one kind: overtime and double time fill in at 1.5 and
 *  2 times straight time until typed. Null: no rate for the craft. */
export function rateOf(sheet: RateSheet | null | undefined, craft: string, kind: "st" | "ot" | "dt"): number | null {
  const r = sheet?.crafts[craft];
  if (!r || !(r.st > 0)) return null;
  if (kind === "st") return r.st;
  const typed = kind === "ot" ? r.ot : r.dt;
  return typed != null && typed > 0 ? typed : r.st * (kind === "ot" ? 1.5 : 2);
}

/** The hours paid for one shift of a sheet (the shift's own length when it doesn't say). */
export const paidHoursOf = (sheet: RateSheet | null | undefined, shiftHours: number) => (sheet?.paidHours && sheet.paidHours > 0 ? sheet.paidHours : shiftHours);

/** One head of a craft for one shift of `hours`: straight time, then
 *  overtime, then double time, and the per diem. Null: no rate. */
export function headCost(sheet: RateSheet | null | undefined, craft: string, hours: number): number | null {
  const st = rateOf(sheet, craft, "st"); if (st == null) return null;
  const stH = sheet?.stHours ?? RULES.stHours, dtA = Math.max(stH, sheet?.dtAfter ?? RULES.dtAfter);
  const a = Math.min(hours, stH), b = Math.max(0, Math.min(hours, dtA) - stH), c = Math.max(0, hours - dtA);
  return a * st + b * rateOf(sheet, craft, "ot")! + c * rateOf(sheet, craft, "dt")! + (sheet?.perDiem ?? 0);
}

/** A shift's heads by craft, priced: the cost, and the crafts with no rate (left out of it). */
export function mixCost(sheet: RateSheet | null | undefined, mix: Record<string, number>, hours: number): { cost: number; priced: number; unpriced: string[] } {
  let cost = 0, priced = 0; const unpriced: string[] = [];
  for (const [c, n] of Object.entries(mix)) {
    if (!(n > 0)) continue;
    const h = headCost(sheet, c, hours);
    if (h == null) { unpriced.push(c); continue; }
    cost += n * h; priced += n;
  }
  return { cost, priced, unpriced };
}

/** The cost of `extra` hours past a paid shift for `hands`, priced at the
 *  crafts on the tools in the mix (all of the mix when none are marked).
 *  Null: none of them has a rate. */
export function holdCost(sheet: RateSheet | null | undefined, mix: Record<string, number>, crafts: PlanCraft[] | undefined, paid: number, hands: number, extra: number): number | null {
  if (!(hands > 0) || !(extra > 0)) return 0;
  const direct = new Map((crafts ?? []).map((c) => [c.name, c.direct]));
  const pick = (onTools: boolean) => Object.entries(mix).filter(([c, n]) => n > 0 && (!onTools || direct.get(c) !== false));
  let list = pick(true); if (!list.length) list = pick(false);
  // With no plan for the shift: the sheet's crafts on the tools, one each.
  if (!list.length) list = Object.keys(sheet?.crafts ?? {}).filter((c) => direct.get(c) !== false).map((c) => [c, 1] as [string, number]);
  let sum = 0, n = 0;
  for (const [c, k] of list) {
    const a = headCost(sheet, c, paid), b = headCost(sheet, c, paid + extra);
    if (a == null || b == null) continue;
    sum += k * (b - a) / extra; n += k;
  }
  return n ? hands * extra * (sum / n) : null;
}

const norm = (t: string) => t.toLowerCase().replace(/journeyman|journeymen/g, "journeyman").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
/** The plan's craft a rate sheet line is for ("Boilermaker - General
 *  Foreman" is "BoilerMaker Gen.Foreman"), or null. */
export function matchCraft(name: string, crafts: string[]): string | null {
  const a = norm(name);
  let best: { c: string; s: number } | null = null;
  for (const c of crafts) {
    const b = norm(c);
    const hit = a.filter((w) => b.some((x) => x === w || (w.length >= 3 && x.length >= 3 && (x.startsWith(w) || w.startsWith(x))))).length;
    const s = hit / Math.max(a.length, b.length);
    if (!best || s > best.s) best = { c, s };
  }
  return best && best.s >= 0.66 ? best.c : null;
}

/** A rate sheet read from a spreadsheet: a header row naming straight time
 *  and overtime (or one rate), crafts down the first text column. */
export function parseRateGrid(rows: unknown[][]): Array<{ craft: string; st: number; ot: number | null; dt: number | null; perDiem: number | null }> | null {
  const cell = (v: unknown) => String(v ?? "").trim();
  const n = (v: unknown) => { const x = typeof v === "number" ? v : Number(cell(v).replace(/[$,\s]/g, "")); return Number.isFinite(x) && x > 0 ? x : null; };
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const head = (rows[r] ?? []).map((v) => cell(v).toLowerCase());
    const find = (re: RegExp) => head.findIndex((h) => re.test(h));
    const st = find(/straight|^st$|^s\.?t\.?\b|regular|^reg\b|base rate|^rate$/);
    if (st < 0) continue;
    const ot = find(/overtime|^ot$|^o\.?t\.?\b|1\.5|time and a half/), dt = find(/double|^dt$|^d\.?t\.?\b|2\.0|2x/), pd = find(/per ?diem|subsist/);
    const out: Array<{ craft: string; st: number; ot: number | null; dt: number | null; perDiem: number | null }> = [];
    for (let i = r + 1; i < rows.length; i++) {
      const row = rows[i] ?? [];
      const craft = cell(row.find((v, k) => k !== st && k !== ot && k !== dt && k !== pd && typeof v === "string" && /[a-z]/i.test(v)));
      const s = n(row[st]);
      if (!craft || s == null) continue;
      out.push({ craft, st: s, ot: ot >= 0 ? n(row[ot]) : null, dt: dt >= 0 ? n(row[dt]) : null, perDiem: pd >= 0 ? n(row[pd]) : null });
    }
    if (out.length) return out;
  }
  return null;
}
