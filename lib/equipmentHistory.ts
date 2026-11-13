// equipmentHistory - every job done on one piece of equipment, across
// projects: the work orders linked to it in Setup › Units & equipment (its
// registry id on the work order's task) or carrying its site code in the
// schedule's Equipment column, each with its project, dates, steps and the
// findings kept on it. Shown on the equipment's page.

import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { EQUIP_ID, registryTagKey, tagKey } from "@/lib/findings";
import { woOf } from "@/lib/workOrderCrew";
import type { Milestone } from "@/types/schema";

export interface HistoryJob {
  taskId: string;
  projectId: string;
  projectName: string;
  projectStatus: string | null;
  tz: string | null;
  name: string;
  wo: string | null;
  status: string;
  pct: number;
  plannedStart: number | null;
  plannedFinish: number | null;
  actualStart: number | null;
  actualFinish: number | null;
  steps: number;
  stepsDone: number;
  cancelled: boolean;
}

export interface HistoryFinding { id: string; projectId: string; kind: string; topic: string; body: string; nextTime: string; at: number | null }

export interface EquipmentHistory { jobs: HistoryJob[]; findings: HistoryFinding[] }

interface Row {
  id: string; project_id: string; parent_id: string | null; name: string; attributes: Record<string, unknown> | null; work_order_ref: string | null;
  status: string; percent_complete: number | null; planned_start_at: string | null; planned_at: string | null;
  actual_start_at: string | null; actual_at: string | null; cancelled_at: string | null;
}
const COLS = "id, project_id, parent_id, name, attributes, work_order_ref, status, percent_complete, planned_start_at, planned_at, actual_start_at, actual_at, cancelled_at";
const ms = (s: string | null | undefined) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

/** Shape the rows: each work order's task with its steps (pure, tested). */
export function shapeHistory(tasks: Row[], steps: Row[], projects: Map<string, { name: string; status: string | null; tz: string | null }>): HistoryJob[] {
  const kids = new Map<string, Row[]>();
  for (const s of steps) if (s.parent_id) kids.set(s.parent_id, [...(kids.get(s.parent_id) ?? []), s]);
  const seen = new Set<string>();
  const out: HistoryJob[] = [];
  for (const t of tasks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const k = (kids.get(t.id) ?? []).filter((x) => !x.cancelled_at);
    const all = k.length ? k : [t];
    const starts = all.map((x) => ms(x.actual_start_at)).filter((x): x is number => x != null);
    const done = all.filter((x) => x.status === "completed");
    const finishes = done.map((x) => ms(x.actual_at)).filter((x): x is number => x != null);
    const p = projects.get(t.project_id);
    const plannedStarts = all.map((x) => ms(x.planned_start_at)).filter((x): x is number => x != null);
    const plannedEnds = all.map((x) => ms(x.planned_at)).filter((x): x is number => x != null);
    out.push({
      taskId: t.id, projectId: t.project_id, projectName: p?.name ?? "A project", projectStatus: p?.status ?? null, tz: p?.tz ?? null,
      name: t.name, wo: woOf({ workOrderRef: t.work_order_ref, attributes: t.attributes } as unknown as Milestone) || null,
      status: done.length === all.length ? "completed" : starts.length ? "in_progress" : t.status,
      pct: Math.round(k.length ? k.reduce((a, x) => a + (x.status === "completed" ? 100 : Number(x.percent_complete ?? 0)), 0) / k.length : Number(t.percent_complete ?? 0)),
      plannedStart: plannedStarts.length ? Math.min(...plannedStarts) : null,
      plannedFinish: plannedEnds.length ? Math.max(...plannedEnds) : null,
      actualStart: starts.length ? Math.min(...starts) : null,
      actualFinish: done.length === all.length && finishes.length ? Math.max(...finishes) : null,
      steps: k.length, stepsDone: k.filter((x) => x.status === "completed").length,
      cancelled: !!t.cancelled_at,
    });
  }
  // Newest work first.
  return out.sort((a, b) => (b.actualStart ?? b.plannedStart ?? 0) - (a.actualStart ?? a.plannedStart ?? 0));
}

/** The work and findings on one piece of equipment. `code`: its site code
 *  ("5630.06"), matched to the schedule's Equipment column. */
export async function loadEquipmentHistory(orgId: string, asset: { id: string; code?: string | null; tag?: string | null; unitCode?: string | null }): Promise<EquipmentHistory> {
  const byId = supabase.from("milestones").select(COLS).eq("org_id", orgId).eq(`attributes->>${EQUIP_ID}`, asset.id).limit(500);
  const byCode = asset.code ? supabase.from("milestones").select(COLS).eq("org_id", orgId).eq("attributes->>Equipment", asset.code).limit(500) : null;
  const [a, b] = await Promise.all([byId, byCode ?? Promise.resolve({ data: [] as Row[], error: null })]);
  if (a.error) throw new Error(a.error.message);
  const tasks = [...((a.data ?? []) as Row[]), ...(((b?.data ?? []) as Row[]))];
  if (!tasks.length) return { jobs: [], findings: await findingsOn(orgId, asset) };
  const ids = [...new Set(tasks.map((t) => t.id))];
  const pids = [...new Set(tasks.map((t) => t.project_id))];
  const [st, pr, findings] = await Promise.all([
    fetchAllRows<Row>((from, to) => supabase.from("milestones").select(COLS).in("parent_id", ids.slice(0, 200)).order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>),
    supabase.from("projects").select("id, name, status, timezone").in("id", pids),
    findingsOn(orgId, asset),
  ]);
  const projects = new Map(((pr.data ?? []) as Array<{ id: string; name: string; status: string | null; timezone: string | null }>).map((p) => [p.id, { name: p.name, status: p.status, tz: p.timezone }]));
  return { jobs: shapeHistory(tasks, st.rows, projects), findings };
}

/** Every finding on it: tied to it by id, or written on its tag ("V-7")
 *  on a job (a person's finding counts as soon as it is saved; one only
 *  suggested, or thrown out, does not). None when the findings table isn't
 *  there yet. */
async function findingsOn(orgId: string, asset: { id: string; tag?: string | null; unitCode?: string | null }): Promise<HistoryFinding[]> {
  const key = registryTagKey(asset.tag ?? "");
  const { data, error } = await supabase.from("project_findings").select("id, project_id, kind, topic, body, next_time, found_at, asset_id, asset_tag, unit_code, status, source")
    .eq("org_id", orgId).in("status", ["kept", "open"]).or(key ? `asset_id.eq.${asset.id},asset_tag.not.is.null` : `asset_id.eq.${asset.id}`)
    .order("found_at", { ascending: false }).limit(1000);
  if (error) return [];
  return ((data ?? []) as Array<{ id: string; project_id: string; kind: string; topic: string | null; body: string | null; next_time: string | null; found_at: string | null; asset_id: string | null; asset_tag: string | null; unit_code: string | null; status: string; source: string }>)
    // By tag only within its unit: V-7 on another unit is another V-7.
    .filter((r) => (r.status === "kept" || r.source === "manual") && (r.asset_id === asset.id || (!!key && tagKey(r.asset_tag) === key && (!r.unit_code || !asset.unitCode || r.unit_code === asset.unitCode))))
    .map((r) => ({ id: r.id, projectId: r.project_id, kind: r.kind, topic: r.topic ?? "", body: r.body ?? "", nextTime: r.next_time ?? "", at: ms(r.found_at) }));
}
