// nextPlanStore - what's kept for the suggested schedule: the changes a
// person made to it (for each phase, or the whole project), and the
// contractors' staffing plans read in. Both live in the project's settings
// (projects.shift_times), like the manpower settings: no database update.

import { supabase } from "@/lib/supabase";
import type { PlanChange, Cal } from "@/lib/nextPlan";
import type { StaffingPlans, StaffingPlan } from "@/lib/staffingPlan";

export interface NextPlanSettings { changes: Record<string, PlanChange[]>; staffing: StaffingPlans }

const CALS = new Set<Cal>(["day", "night", "both"]);
const str = (v: unknown, n = 300) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const target = (v: unknown): { order?: string; ids?: string[] } | null => {
  const t = (v ?? {}) as { order?: unknown; ids?: unknown };
  const order = str(t.order, 200) || undefined;
  const ids = Array.isArray(t.ids) ? t.ids.filter((x): x is string => typeof x === "string").slice(0, 500) : undefined;
  return order || ids?.length ? { order, ids } : null;
};

/** One change, checked; null when it isn't one. */
export function cleanChange(v: unknown): PlanChange | null {
  const c = (v ?? {}) as Record<string, unknown>;
  const base = { id: str(c.id, 80) || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, said: str(c.said, 500), at: num(c.at) ?? Date.now() };
  const cal = CALS.has(c.cal as Cal) ? (c.cal as Cal) : undefined;
  switch (c.kind) {
    case "nights": { const t = target(c.target); return t ? { ...base, kind: "nights", target: t, on: c.on !== false } : null; }
    case "asap": { const t = target(c.target); return t ? { ...base, kind: "asap", target: t } : null; }
    case "first": { const t = target(c.target); return t ? { ...base, kind: "first", target: t } : null; }
    case "drop": { const t = target(c.target); return t ? { ...base, kind: "drop", target: t } : null; }
    case "hold": { const t = target(c.target); const d = num(c.day); return t && d != null && d >= 1 && d <= 365 ? { ...base, kind: "hold", target: t, day: Math.round(d) } : null; }
    case "hours": { const h = num(c.hours); const id = str(c.actId, 200); return id && h != null && h >= 0 && h <= 5000 ? { ...base, kind: "hours", actId: id, hours: h } : null; }
    case "add": {
      const h = num(c.hours) ?? 0; const name = str(c.name, 200).trim();
      return name ? { ...base, kind: "add", name, crew: str(c.crew, 80), hours: Math.max(0, Math.min(5000, h)), cal, after: str(c.after, 200) || null, before: str(c.before, 200) || null, pre: c.pre === true, order: str(c.order, 200) || null } : null;
    }
    case "split": {
      const h = num(c.hours) ?? 0; const f = num(c.fraction); const id = str(c.actId, 200); const name = str(c.name, 200).trim();
      return id && name && f != null && f > 0 && f < 1 ? { ...base, kind: "split", actId: id, fraction: f, name, crew: str(c.crew, 80), hours: Math.max(0, Math.min(5000, h)), cal } : null;
    }
    case "heads": { const n = num(c.n), s = num(c.shift); const crew = str(c.crew, 80); return crew && n != null && n >= 0 && n <= 2000 && s != null && s >= 0 && s < 2000 ? { ...base, kind: "heads", crew, shift: Math.round(s), n: Math.round(n) } : null; }
    default: return null;
  }
}

function cleanPlan(v: unknown): StaffingPlan | null {
  const p = (v ?? {}) as Record<string, unknown>;
  const shifts: StaffingPlan["shifts"] = {};
  for (const [k, x] of Object.entries((p.shifts ?? {}) as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}:(day|night)$/.test(k)) continue;
    const d = num((x as { direct?: unknown })?.direct) ?? 0, i = num((x as { indirect?: unknown })?.indirect) ?? 0;
    if (d > 0 || i > 0) shifts[k] = { direct: d, indirect: i };
  }
  if (!Object.keys(shifts).length) return null;
  const phases = Array.isArray(p.phases) ? p.phases.flatMap((x) => (str(x?.name, 80) && /^\d{4}-\d{2}-\d{2}$/.test(str(x?.from, 10)) ? [{ name: str(x.name, 80), from: str(x.from, 10) }] : [])) : undefined;
  return { file: str(p.file, 200), at: str(p.at, 40), by: str(p.by, 120) || null, shifts, phases };
}

export function cleanNextPlanSettings(st: Record<string, unknown> | null | undefined): NextPlanSettings {
  const changes: Record<string, PlanChange[]> = {};
  for (const [scope, list] of Object.entries(((st?.nextPlan ?? {}) as Record<string, unknown>))) {
    if (Array.isArray(list)) changes[scope] = list.map(cleanChange).filter((c): c is PlanChange => !!c).slice(0, 400);
  }
  const staffing: StaffingPlans = {};
  for (const [co, p] of Object.entries(((st?.staffingPlans ?? {}) as Record<string, unknown>))) { const c = cleanPlan(p); if (c) staffing[co.slice(0, 80)] = c; }
  return { changes, staffing };
}

export async function loadNextPlanSettings(projectId: string): Promise<NextPlanSettings> {
  const { data } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  return cleanNextPlanSettings((data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times ?? null);
}

async function patch(projectId: string, f: (st: Record<string, unknown>) => void): Promise<void> {
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  const st = { ...(((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}) };
  f(st);
  const { data, error } = await supabase.from("projects").update({ shift_times: st }).eq("id", projectId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Not saved - only the project's owner, a co-owner or an admin can change this.");
}

/** The changes for one scope (a phase id, or "all"). */
export function saveNextPlanChanges(projectId: string, scope: string, changes: PlanChange[]): Promise<void> {
  return patch(projectId, (st) => { st.nextPlan = { ...((st.nextPlan ?? {}) as Record<string, unknown>), [scope]: changes.map(cleanChange).filter(Boolean) }; });
}

/** A company's staffing plan (null removes it). */
export function saveStaffingPlan(projectId: string, company: string, plan: StaffingPlan | null): Promise<void> {
  return patch(projectId, (st) => {
    const cur = { ...((st.staffingPlans ?? {}) as Record<string, unknown>) };
    if (plan) cur[company] = plan; else delete cur[company];
    st.staffingPlans = cur;
  });
}
