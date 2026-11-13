// manpower - who was on the job, shift by shift: each company's direct
// hands (on the tools) and indirect (supervision, safety, hole and fire
// watch, QC, tool room), counted at the shift meeting.
//
//   - A count is the meeting's: carried from the last same shift until
//     someone changes it or says it's right; a carried count is said so,
//     never passed off as checked.
//   - Crews are grouped into companies ("Schultz - Tower" and "Schultz 1"
//     are Schultz); in-house "(KE)" crews are Kern Energy.
//   - Man-hours are counted hands x the shift's hours ("counted at the
//     meeting": who left early or came late isn't seen).
//   - Man-hours by work order are estimated: a company's direct hours in a
//     shift shared over its work going in that shift, by hours going.
//     Nobody counts by job, and it says so.
//   - The bid (each company's manpower per day and night shift, and its
//     rate when it bills by the hour) is the plan the counts are held to.
//
// Pure, but for loading and saving the project's settings.

import { supabase } from "@/lib/supabase";
import type { CrewCount, ShiftRecord } from "@/lib/shiftRecord";
import { rosterFor } from "@/lib/shiftMeeting";
import type { ShiftWindow } from "@/lib/shiftReport";

export interface BidShift { direct?: number | null; indirect?: number | null }
export interface CompanyBid {
  day?: BidShift;
  night?: BidShift;
  /** $ per man-hour, when it bills by the hour. */
  rate?: number | null;
}
export interface ManpowerSettings {
  /** A crew's company, when it isn't the one its name gives. */
  companyOf?: Record<string, string>;
  /** Each company's bid manpower and rate. */
  bids?: Record<string, CompanyBid>;
}

/** The company a crew's name gives: "Schultz - Tower", "Schultz 1" and
 *  "Schultz" are Schultz; "Maintenance (KE)" is Kern Energy. */
export function defaultCompany(crew: string): string {
  const c = crew.replace(/\s+/g, " ").trim();
  if (/\(\s*KE\s*\)$/i.test(c)) return "Kern Energy";
  return c.replace(/\s+[-–]\s+.*$/, "").replace(/\s+\d+[A-Z]?$/i, "").trim() || c;
}

export const companyOf = (crew: string, s?: ManpowerSettings | null): string =>
  s?.companyOf?.[crew]?.trim() || defaultCompany(crew);

/** A crew's count at a meeting: direct, indirect, and their total. An
 *  older count with only a total keeps its total, not split. */
export function countOf(c: CrewCount | undefined): { direct: number | null; indirect: number | null; total: number | null; split: boolean } {
  if (!c || c.plant) return { direct: null, indirect: null, total: null, split: false };
  const d = num(c.direct), i = num(c.indirect);
  if (d != null || i != null) return { direct: d ?? 0, indirect: i ?? 0, total: (d ?? 0) + (i ?? 0), split: true };
  const t = num(c.headcount);
  return { direct: null, indirect: null, total: t, split: false };
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** A crew's record with its direct and indirect set (its total kept with them). */
/** A crew's count as one total (no direct / indirect split). */
export function withTotal(c: CrewCount | undefined, total: number | null): CrewCount {
  const t = num(total);
  return { ...(c ?? {}), direct: null, indirect: null, headcount: t };
}

export function withCounts(c: CrewCount | undefined, direct: number | null, indirect: number | null): CrewCount {
  const base = { ...(c ?? {}) };
  const d = num(direct), i = num(indirect);
  return { ...base, direct: d, indirect: i, headcount: d == null && i == null ? null : (d ?? 0) + (i ?? 0) };
}

export interface CompanyShift {
  company: string;
  direct: number | null;
  indirect: number | null;
  total: number;
  /** Direct and indirect known (else only a total). */
  split: boolean;
  /** The crews counted in it. */
  crews: string[];
}
export interface ShiftCount {
  key: string;
  kind: "day" | "night";
  start: number;
  end: number;
  hours: number;
  /** Carried from an earlier shift, not changed or checked for this one. */
  carried: boolean;
  /** Counted at all (some company has a count). */
  counted: boolean;
  companies: CompanyShift[];
}

/** Each shift's counts, by company. */
export function shiftCounts(records: Map<string, ShiftRecord>, windows: ShiftWindow[], s?: ManpowerSettings | null): ShiftCount[] {
  return windows.map((w) => {
    const key = `${w.dayKey}:${w.kind}`;
    const { crews, from } = rosterFor(records, key);
    const by = new Map<string, CompanyShift>();
    for (const [crew, c] of Object.entries(crews)) {
      const n = countOf(c);
      if (n.total == null) continue;
      const co = companyOf(crew, s);
      const x = by.get(co) ?? { company: co, direct: 0, indirect: 0, total: 0, split: true, crews: [] };
      x.total += n.total;
      if (n.split) { x.direct = (x.direct ?? 0) + (n.direct ?? 0); x.indirect = (x.indirect ?? 0) + (n.indirect ?? 0); }
      else x.split = false;
      x.crews.push(crew);
      by.set(co, x);
    }
    const companies = [...by.values()].map((x) => (x.split ? x : { ...x, direct: null, indirect: null }))
      .sort((a, b) => b.total - a.total || a.company.localeCompare(b.company));
    return { key, kind: w.kind, start: w.start, end: w.end, hours: (w.end - w.start) / 3_600_000, carried: from != null && companies.length > 0, counted: companies.length > 0, companies };
  });
}

export interface CompanyTotals {
  company: string;
  directMH: number;
  indirectMH: number;
  /** Man-hours counted only as a total (no split). */
  unsplitMH: number;
  totalMH: number;
  peak: number;
  /** Average on site over the shifts it was counted on. */
  average: number;
  shifts: number;
  /** Of those, carried from an earlier shift, not checked. */
  carried: number;
  /** Indirect share of the split man-hours (null: none split). */
  indirectShare: number | null;
  /** The bid's man-hours over the shifts it has a bid for (null: no bid). */
  bidMH: number | null;
  /** Counted man-hours on those same shifts, to hold against bidMH. */
  onBidMH: number;
  /** Shifts it was counted short of its bid direct (checked counts only). */
  shortShifts: number;
  /** Counted man-hours x its rate (null: no rate). */
  cost: number | null;
}

export interface ManpowerSummary {
  shifts: number;
  counted: number;
  carried: number;
  totalMH: number;
  directMH: number;
  indirectMH: number;
  unsplitMH: number;
  peak: { n: number; key: string } | null;
  companies: CompanyTotals[];
  /** Incidents written on the shifts (by kind). */
  incidents: { recordable: number; firstAid: number; nearMiss: number };
  /** Recordables per 200,000 counted man-hours (null: no hours). */
  recordableRate: number | null;
  /** Counted man-hours x rates, where a rate is set. */
  cost: number | null;
}

const bidFor = (b: CompanyBid | undefined, kind: "day" | "night") => b?.[kind];
const r1 = (x: number) => Math.round(x * 10) / 10;

export function manpowerSummary(counts: ShiftCount[], records: Map<string, ShiftRecord>, s?: ManpowerSettings | null): ManpowerSummary {
  const by = new Map<string, CompanyTotals & { sum: number }>();
  let peak: ManpowerSummary["peak"] = null;
  for (const c of counts) {
    if (!c.counted) continue;
    const onSite = c.companies.reduce((a, x) => a + x.total, 0);
    if (!peak || onSite > peak.n) peak = { n: onSite, key: c.key };
    for (const x of c.companies) {
      const t = by.get(x.company) ?? { company: x.company, directMH: 0, indirectMH: 0, unsplitMH: 0, totalMH: 0, peak: 0, average: 0, shifts: 0, carried: 0, indirectShare: null, bidMH: null, onBidMH: 0, shortShifts: 0, cost: null, sum: 0 };
      if (x.split) { t.directMH += (x.direct ?? 0) * c.hours; t.indirectMH += (x.indirect ?? 0) * c.hours; }
      else t.unsplitMH += x.total * c.hours;
      t.totalMH += x.total * c.hours;
      t.peak = Math.max(t.peak, x.total);
      t.sum += x.total;
      t.shifts += 1;
      if (c.carried) t.carried += 1;
      const bid = bidFor(s?.bids?.[x.company], c.kind);
      if (bid && (bid.direct != null || bid.indirect != null)) {
        t.bidMH = (t.bidMH ?? 0) + ((bid.direct ?? 0) + (bid.indirect ?? 0)) * c.hours;
        t.onBidMH += x.total * c.hours;
        // Short of the bid, on a count someone checked (never on a carried one).
        if (bid.direct != null && x.split && !c.carried && (x.direct ?? 0) < bid.direct) t.shortShifts += 1;
      }
      by.set(x.company, t);
    }
  }
  const companies = [...by.values()].map(({ sum, ...t }) => {
    const split = t.directMH + t.indirectMH;
    const rate = s?.bids?.[t.company]?.rate;
    return {
      ...t, directMH: r1(t.directMH), indirectMH: r1(t.indirectMH), unsplitMH: r1(t.unsplitMH), totalMH: r1(t.totalMH),
      average: r1(sum / Math.max(1, t.shifts)), bidMH: t.bidMH == null ? null : r1(t.bidMH), onBidMH: r1(t.onBidMH),
      indirectShare: split > 0 ? Math.round((t.indirectMH / split) * 100) / 100 : null,
      cost: rate != null && rate > 0 ? Math.round(t.totalMH * rate) : null,
    };
  }).sort((a, b) => b.totalMH - a.totalMH);
  const totalMH = r1(companies.reduce((a, x) => a + x.totalMH, 0));
  const incidents = { recordable: 0, firstAid: 0, nearMiss: 0 };
  const inJob = new Set(counts.map((c) => c.key));
  for (const [k, r] of records) {
    if (!inJob.has(k)) continue;
    for (const i of r.incidents?.items ?? []) {
      if (i.kind === "Recordable") incidents.recordable++;
      else if (i.kind === "First aid") incidents.firstAid++;
      else if (i.kind === "Near miss") incidents.nearMiss++;
    }
  }
  const costs = companies.map((x) => x.cost).filter((x): x is number => x != null);
  return {
    shifts: counts.length,
    counted: counts.filter((c) => c.counted).length,
    carried: counts.filter((c) => c.counted && c.carried).length,
    totalMH,
    directMH: r1(companies.reduce((a, x) => a + x.directMH, 0)),
    indirectMH: r1(companies.reduce((a, x) => a + x.indirectMH, 0)),
    unsplitMH: r1(companies.reduce((a, x) => a + x.unsplitMH, 0)),
    peak,
    companies,
    incidents,
    recordableRate: totalMH > 0 ? Math.round((incidents.recordable * 200_000 / totalMH) * 100) / 100 : null,
    cost: costs.length ? costs.reduce((a, x) => a + x, 0) : null,
  };
}

/** A piece of work as built: its work order, the crew on it, when it ran. */
export interface WorkSpan { wo: string; label: string; crew: string; start: number; end: number }

export interface WorkOrderHours { wo: string; label: string; directMH: number; companies: string[] }

/** Each work order's direct man-hours, estimated: each shift, a company's
 *  counted direct hours shared over its work going that shift, by the
 *  hours each was going. What a company was counted for with nothing of
 *  its going is kept apart (`untied`), not spread. */
export function estimateByWorkOrder(counts: ShiftCount[], spans: WorkSpan[], s?: ManpowerSettings | null): { orders: WorkOrderHours[]; untiedMH: number } {
  const out = new Map<string, WorkOrderHours & { cos: Set<string> }>();
  let untied = 0;
  for (const c of counts) {
    for (const x of c.companies) {
      if (!x.split || !x.direct) continue;
      const mh = x.direct * c.hours;
      const going = spans.map((sp) => ({ sp, h: Math.max(0, Math.min(sp.end, c.end) - Math.max(sp.start, c.start)) / 3_600_000 }))
        .filter((g) => g.h > 0 && companyOf(g.sp.crew, s) === x.company);
      const sum = going.reduce((a, g) => a + g.h, 0);
      if (sum <= 0) { untied += mh; continue; }
      for (const g of going) {
        const o = out.get(g.sp.wo) ?? { wo: g.sp.wo, label: g.sp.label, directMH: 0, companies: [], cos: new Set<string>() };
        o.directMH += (mh * g.h) / sum;
        o.cos.add(x.company);
        out.set(g.sp.wo, o);
      }
    }
  }
  const orders = [...out.values()].map(({ cos, ...o }) => ({ ...o, directMH: r1(o.directMH), companies: [...cos].sort() }))
    .sort((a, b) => b.directMH - a.directMH);
  return { orders, untiedMH: r1(untied) };
}

/** A company's hands at a time, against its bid: for the look-back's
 *  "waited for the crew" ("Schultz had 24 of 36 bid direct hands"). */
export function handsAt(counts: ShiftCount[], company: string, t: number, s?: ManpowerSettings | null): { direct: number | null; total: number; bidDirect: number | null; bidTotal: number | null; carried: boolean } | null {
  const c = counts.find((x) => t >= x.start && t < x.end);
  const x = c?.companies.find((y) => y.company === company);
  if (!c || !x) return null;
  const b = s?.bids?.[company]?.[c.kind];
  const bidTotal = b && (b.direct != null || b.indirect != null) ? (b.direct ?? 0) + (b.indirect ?? 0) : null;
  return { direct: x.direct, total: x.total, bidDirect: b?.direct ?? null, bidTotal, carried: c.carried };
}

// ─── Settings ──────────────────────────────────────────────────────

export function cleanManpower(v: unknown): ManpowerSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const companyOf: Record<string, string> = {};
  for (const [k, x] of Object.entries((o.companyOf as Record<string, unknown>) ?? {})) if (typeof x === "string" && x.trim()) companyOf[k] = x.trim().slice(0, 60);
  const bids: Record<string, CompanyBid> = {};
  const n = (x: unknown, max: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(max, Math.round(x * 100) / 100) : null);
  const shift = (x: unknown): BidShift | undefined => {
    if (!x || typeof x !== "object") return undefined;
    const y = x as Record<string, unknown>;
    const d = n(y.direct, 2000), i = n(y.indirect, 2000);
    return d == null && i == null ? undefined : { direct: d, indirect: i };
  };
  for (const [k, x] of Object.entries((o.bids as Record<string, unknown>) ?? {})) {
    if (!x || typeof x !== "object") continue;
    const y = x as Record<string, unknown>;
    const b: CompanyBid = { day: shift(y.day), night: shift(y.night), rate: n(y.rate, 10_000) };
    if (b.day || b.night || b.rate != null) bids[k] = b;
  }
  return { companyOf, bids };
}

export async function loadManpowerSettings(projectId: string): Promise<ManpowerSettings> {
  const { data } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  const st = (data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times;
  return cleanManpower(st?.manpower);
}

export async function saveManpowerSettings(projectId: string, next: ManpowerSettings): Promise<void> {
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  const st = { ...(((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}) };
  st.manpower = cleanManpower(next);
  const { data, error } = await supabase.from("projects").update({ shift_times: st }).eq("id", projectId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Not saved - only the project's owner, a co-owner or an admin can change this.");
}
