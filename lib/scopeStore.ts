// lib/scopeStore.ts - where a project's scope (its work order list, from
// lib/woIntake) is kept: in the project's setup record (projects.setup_state,
// key "scope"), so it works with no database change. One planner imports
// the list; a second import replaces it after the change is reviewed.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { packagesKey, packageStage, PACKAGES_CHANGED, type ProjectPackages } from "@/lib/woPackagesCore";
import { scheduleByWo, type ColumnMap, type ScopeComing, type ScopeWO, type SchedRow, type ScopePackage, type Sheet, type WoOnSchedule } from "@/lib/woIntake";

export interface ScopeRfq { at: string; by?: string; service: string; to: string[] }

/** A change to the scope made in the app, kept with who, when and why. */
export interface ScopeChange { at: string; by?: string; kind: "added" | "removed" | "edited" | "put back"; wo: string; what: string; why?: string }

/** A work order taken off the scope: kept, with why, so it can be put back
 *  (with the schedule steps cancelled with it). */
export type RemovedWO = ScopeWO & { removedAt: string; removedBy?: string; why: string; cancelledIds?: string[] };

export interface ScopeImport { at: string; by?: string; file: string; sheet: string; added: number; changed: number; dropped: number }

export interface ScopeState {
  items: ScopeWO[];
  coming: ScopeComing[];
  /** The file and tab it came from, the columns as read (so the next
   *  import of the same layout needs nothing picked), and each import. */
  source: { file: string; sheet: string; headers: string[]; map: ColumnMap };
  imports: ScopeImport[];
  /** RFQs written from this scope. */
  rfqs?: ScopeRfq[];
  /** Planning steps this job doesn't need (a small in-house job: no
   *  packages, RFQ or award). */
  skipped?: import("@/lib/planningPath").PathKey[];
  /** Taken off the scope in the app. */
  removed?: RemovedWO[];
  /** Every change made in the app (the list's imports are in `imports`). */
  changes?: ScopeChange[];
  /** How the project started: its schedule (the scope is the schedule's
   *  work orders), a work order list, or empty. */
  start?: "schedule" | "list" | "empty";
}

/** Where typed-in work came from (no list file). */
export const TYPED_SOURCE = { file: "Typed in", sheet: "", headers: [] as string[], map: {} };

const KEY = "scope";

async function readSetup(projectId: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.from("projects").select("setup_state").eq("id", projectId).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { setup_state?: Record<string, unknown> | null } | null)?.setup_state ?? {}) as Record<string, unknown>;
}

/** The project's scope, or null when no list has been imported. */
export async function loadScope(projectId: string): Promise<ScopeState | null> {
  const s = (await readSetup(projectId))[KEY] as ScopeState | undefined;
  return s && Array.isArray(s.items) ? { ...s, coming: s.coming ?? [], imports: s.imports ?? [] } : null;
}

/** Said on the window when a project's scope is saved, so the page's header
 *  (the next step) follows at once. */
export const SCOPE_CHANGED = "scope:changed";

export async function saveScope(projectId: string, scope: ScopeState): Promise<void> {
  const cur = await readSetup(projectId);
  const { data, error } = await supabase.from("projects").update({ setup_state: { ...cur, [KEY]: scope } }).eq("id", projectId).select("id");
  if (error) throw new Error(`The scope didn't save: ${error.message}`);
  if (!data?.length) throw new Error("The scope didn't save: only the project's owner or an admin can change it.");
  pkgCache.delete(projectId);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SCOPE_CHANGED, { detail: projectId }));
}

// ── Each work order's package, where the work is done ──

const pkgCache = new Map<string, Promise<Map<string, ScopePackage>>>();

/** The project's packages by work order number, read once per project and
 *  again when the scope is saved. */
export function scopePackages(projectId: string): Promise<Map<string, ScopePackage>> {
  let p = pkgCache.get(projectId);
  if (!p) {
    // Attached package files, then packages built in the app (they win: the
    // link opens the package with where it stands).
    p = Promise.all([
      loadScope(projectId),
      Promise.resolve(supabase.from("org_configurations").select("data").eq("key", packagesKey(projectId)).maybeSingle()).then(({ data }) => ((data as { data?: ProjectPackages } | null)?.data ?? null), () => null),
    ]).then(([s, built]) => {
      const m = new Map((s?.items ?? []).filter((x) => x.pkg).map((x) => [x.wo, x.pkg!]));
      for (const pk of Object.values(built?.packages ?? {})) {
        const st = packageStage(pk);
        const word = pk.status === "filed" ? "filed" : pk.status === "issued" ? `printed${st.forms ? `, ${st.signed} of ${st.forms} forms back` : ""}` : pk.status === "approved" ? "approved" : "draft";
        const link: ScopePackage = { documentId: "", label: `Work package (${word})`, href: `/projects/${projectId}?tab=plan&package=${encodeURIComponent(pk.key)}`, at: pk.updatedAt };
        for (const wo of pk.wos.length ? pk.wos : [pk.key]) m.set(wo, link);
      }
      return m;
    });
    p.catch(() => pkgCache.delete(projectId));
    pkgCache.set(projectId, p);
  }
  return p;
}

/** The project's packages by work order number (null until read). */
export function useScopePackages(projectId?: string | null): Map<string, ScopePackage> | null {
  const [got, setGot] = useState<{ id?: string | null; m: Map<string, ScopePackage> | null }>({ id: projectId, m: null });
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    const read = () => { scopePackages(projectId).then((m) => { if (live) setGot({ id: projectId, m }); }, () => undefined); };
    read();
    const on = (e: Event) => { if ((e as CustomEvent).detail === projectId) read(); };
    // A package built, printed or filed: read again.
    const onPkg = (e: Event) => { if ((e as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) { pkgCache.delete(projectId); read(); } };
    window.addEventListener(SCOPE_CHANGED, on);
    window.addEventListener(PACKAGES_CHANGED, onPkg);
    return () => { live = false; window.removeEventListener(SCOPE_CHANGED, on); window.removeEventListener(PACKAGES_CHANGED, onPkg); };
  }, [projectId]);
  return got.id === projectId ? got.m : null;
}

/** A spreadsheet's tabs as rows of text, as the cells show (a tag typed
 *  2030.10 stays "2030.10", a date stays as written). */
export async function readSheets(file: File): Promise<Sheet[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: "", blankrows: false })
      .map((r) => r.map((c) => String(c ?? ""))),
  }));
}

/** Spreadsheet files the list can come in. */
export const LIST_ACCEPT = ".xlsx,.xlsm,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv";

export interface ScheduleFacts {
  /** Work orders on the schedule (not cancelled there). */
  wos: string[];
  /** Numbers written in step names, for matching the list. */
  named: string[];
  /** Each work order on the schedule: steps, done, cancelled, its top rows. */
  byWo: Record<string, WoOnSchedule>;
  crews: string[];
  steps: number;
  awarded: number;
}

type FactRow = SchedRow & { responsible_party: string | null };
const FACT_COLS = "id, name, parent_id, work_order_ref, attributes, status, percent_complete, responsible_party";

/** The schedule as the scope needs it: each work order on it and how far
 *  along it is, the crews on it, and whether any contract has been awarded. */
export async function scheduleFacts(projectId: string): Promise<ScheduleFacts> {
  // Paged: a schedule can have more than a thousand steps.
  const read = (cols: string) => fetchAllRows<FactRow>((from, to) =>
    supabase.from("milestones").select(cols).eq("project_id", projectId).order("id").range(from, to));
  const [ms0, parties] = await Promise.all([
    read(`${FACT_COLS}, cancelled_at`),
    supabase.from("project_parties").select("id").eq("project_id", projectId).not("contract_value", "is", null).limit(50),
  ]);
  // A database without the cancel columns yet: read without them.
  const ms = ms0.error && /cancelled_at/.test(ms0.error) ? await read(FACT_COLS) : ms0;
  const rows = ms.error ? [] : ms.rows;
  const { byWo, named } = scheduleByWo(rows);
  return {
    wos: Object.keys(byWo).filter((w) => !byWo[w].cancelled),
    named, byWo,
    crews: [...new Set(rows.filter((r) => !r.cancelled_at).map((r) => (r.responsible_party ?? "").trim()).filter(Boolean))].sort(),
    steps: rows.filter((r) => !r.cancelled_at).length,
    awarded: parties.error ? 0 : (parties.data ?? []).length,
  };
}

/** Asks the schedule tab to open its import (the planning path's Schedule step). */
export const OPEN_SCHEDULE_IMPORT = "schedule-import:open";
