// crewSettings - everything a project keeps about its contractors' crews,
// in one read of the project's settings (projects.shift_times): which crew
// is whose (manpower.companyOf), each contractor's staffing plan, rate
// sheet, and its budget line and company on the Costs tab.
//
// The contractor list joins the crews on the schedule with the companies
// on the Costs tab, so a contractor is the same one everywhere.

import { supabase } from "@/lib/supabase";
import { cleanManpower, companyOf, type ManpowerSettings } from "@/lib/manpower";
import { cleanNextPlanSettings, patchProjectSettings } from "@/lib/nextPlanStore";
import type { StaffingPlans } from "@/lib/staffingPlan";
import type { CraftRate, RateSheet, RateSheets } from "@/lib/rateSheet";
import type { CostParty } from "@/lib/costs";

export interface ContractorLink { partyId?: string | null; lineId?: string | null }
export interface CrewSettings {
  manpower: ManpowerSettings;
  staffing: StaffingPlans;
  rateSheets: RateSheets;
  contractors: Record<string, ContractorLink>;
}

const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v * 100) / 100) : null);
const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

export function cleanRateSheet(v: unknown): RateSheet | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const crafts: Record<string, CraftRate> = {};
  for (const [k, x] of Object.entries((o.crafts as Record<string, unknown>) ?? {})) {
    const y = (x ?? {}) as Record<string, unknown>;
    const st = num(y.st, 5000);
    if (!k.trim() || st == null || st <= 0) continue;
    crafts[k.slice(0, 80)] = { st, ot: num(y.ot, 10000), dt: num(y.dt, 10000) };
  }
  const sheet: RateSheet = {
    crafts, perDiem: num(o.perDiem, 5000), paidHours: num(o.paidHours, 24), stHours: num(o.stHours, 24), dtAfter: num(o.dtAfter, 24),
    file: str(o.file, 200) || undefined, at: str(o.at, 40) || undefined, by: str(o.by, 120) || null,
  };
  return Object.keys(crafts).length || sheet.perDiem != null ? sheet : null;
}

export function cleanCrewSettings(st: Record<string, unknown> | null | undefined): CrewSettings {
  const rateSheets: RateSheets = {};
  for (const [co, x] of Object.entries((st?.rateSheets ?? {}) as Record<string, unknown>)) { const s = cleanRateSheet(x); if (s) rateSheets[co.slice(0, 80)] = s; }
  const contractors: Record<string, ContractorLink> = {};
  for (const [co, x] of Object.entries((st?.contractors ?? {}) as Record<string, unknown>)) {
    const y = (x ?? {}) as Record<string, unknown>;
    const link = { partyId: str(y.partyId, 60) || null, lineId: str(y.lineId, 60) || null };
    if (link.partyId || link.lineId) contractors[co.slice(0, 80)] = link;
  }
  return { manpower: cleanManpower(st?.manpower), staffing: cleanNextPlanSettings(st).staffing, rateSheets, contractors };
}

export async function loadCrewSettings(projectId: string): Promise<CrewSettings> {
  const { data } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  return cleanCrewSettings((data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times ?? null);
}

/** A contractor's rate sheet (null removes it). */
export function saveRateSheet(projectId: string, company: string, sheet: RateSheet | null): Promise<void> {
  return patchProjectSettings(projectId, (st) => {
    const cur = { ...((st.rateSheets ?? {}) as Record<string, unknown>) };
    const clean = sheet ? cleanRateSheet(sheet) : null;
    if (clean) cur[company] = clean; else delete cur[company];
    st.rateSheets = cur;
  });
}

/** A contractor's company and budget line on the Costs tab. */
export function saveContractorLink(projectId: string, company: string, link: ContractorLink): Promise<void> {
  return patchProjectSettings(projectId, (st) => {
    const cur = { ...((st.contractors ?? {}) as Record<string, unknown>) };
    const next = { ...((cur[company] ?? {}) as ContractorLink), ...link };
    if (next.partyId || next.lineId) cur[company] = next; else delete cur[company];
    st.contractors = cur;
  });
}

/** Which contractor a crew on the schedule belongs to. */
export function saveCrewCompany(projectId: string, crew: string, company: string): Promise<void> {
  return patchProjectSettings(projectId, (st) => {
    const m = cleanManpower(st.manpower);
    const of = { ...(m.companyOf ?? {}) };
    if (company.trim()) of[crew] = company.trim(); else delete of[crew];
    st.manpower = { ...m, companyOf: of };
  });
}

// ─── The contractor list ────────────────────────────────────────────

export interface Contractor {
  /** The name the crews and settings use ("Schultz"). */
  company: string;
  /** Its crews on the schedule. */
  crews: string[];
  /** Its company on the Costs tab, when there is one. */
  party: CostParty | null;
}

const GENERIC = new Set(["inc", "llc", "ltd", "co", "corp", "company", "the", "and", "services", "service", "industrial", "industries", "construction", "contractors", "contracting", "group", "adv", "advanced", "pump", "project"]);
const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
/** A Costs-tab company that is this crew company ("Caltrol, Adv. Combustion" for "Advanced Combustion"). */
export function partyFor(company: string, parties: CostParty[], link?: ContractorLink | null): CostParty | null {
  if (link?.partyId) return parties.find((p) => p.id === link.partyId) ?? null;
  const a = words(company);
  if (!a.length) return null;
  const hits = parties.filter((p) => p.status !== "inactive" && (p.name.toLowerCase() === company.toLowerCase() || words(p.name).some((w) => a.includes(w))));
  return hits.length === 1 ? hits[0] : null;
}

/** The contractors on a project: each company with crews on the schedule
 *  (plant staff left out), each contractor on the Costs tab, and any with a
 *  staffing plan or rate sheet; each once. */
export function contractorList(crews: string[], parties: CostParty[], s: CrewSettings): Contractor[] {
  const by = new Map<string, Contractor>();
  for (const crew of crews) {
    const co = companyOf(crew, s.manpower);
    if (co === "Kern Energy") continue;
    const c = by.get(co) ?? { company: co, crews: [], party: null };
    if (!c.crews.includes(crew)) c.crews.push(crew);
    by.set(co, c);
  }
  for (const co of [...Object.keys(s.staffing), ...Object.keys(s.rateSheets), ...Object.keys(s.contractors)]) if (!by.has(co) && co !== "Kern Energy") by.set(co, { company: co, crews: [], party: null });
  const used = new Set<string>();
  for (const c of by.values()) { c.party = partyFor(c.company, parties, s.contractors[c.company]); if (c.party) used.add(c.party.id); }
  for (const p of parties) {
    if (used.has(p.id) || p.status === "inactive" || (p.kind && !/contract|vendor|sub/i.test(p.kind))) continue;
    if (!by.has(p.name)) by.set(p.name, { company: p.name, crews: [], party: p });
  }
  return [...by.values()].sort((a, b) => b.crews.length - a.crews.length || a.company.localeCompare(b.company));
}
