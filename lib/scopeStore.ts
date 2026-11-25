// lib/scopeStore.ts - where a project's scope (its work order list, from
// lib/woIntake) is kept: in the project's setup record (projects.setup_state,
// key "scope"), so it works with no database change. One planner imports
// the list; a second import replaces it after the change is reviewed.

import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import type { ColumnMap, ScopeComing, ScopeWO, Sheet } from "@/lib/woIntake";

export interface ScopeRfq { at: string; by?: string; service: string; to: string[] }

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
}

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

export async function saveScope(projectId: string, scope: ScopeState): Promise<void> {
  const cur = await readSetup(projectId);
  const { data, error } = await supabase.from("projects").update({ setup_state: { ...cur, [KEY]: scope } }).eq("id", projectId).select("id");
  if (error) throw new Error(`The scope didn't save: ${error.message}`);
  if (!data?.length) throw new Error("The scope didn't save: only the project's owner or an admin can change it.");
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

/** The schedule as the scope needs it: its work order numbers, the crews on
 *  it, and whether any contract has been awarded. */
export async function scheduleFacts(projectId: string): Promise<{ wos: string[]; crews: string[]; steps: number; awarded: number }> {
  const [ms, parties] = await Promise.all([
    // Paged: a schedule can have more than a thousand steps.
    fetchAllRows<{ work_order_ref: string | null; responsible_party: string | null }>((from, to) =>
      supabase.from("milestones").select("id, work_order_ref, responsible_party").eq("project_id", projectId).order("id").range(from, to)),
    supabase.from("project_parties").select("id").eq("project_id", projectId).not("contract_value", "is", null).limit(50),
  ]);
  const rows = ms.error ? [] : ms.rows;
  return {
    wos: [...new Set(rows.map((r) => (r.work_order_ref ?? "").trim()).filter(Boolean))],
    crews: [...new Set(rows.map((r) => (r.responsible_party ?? "").trim()).filter(Boolean))].sort(),
    steps: rows.length,
    awarded: parties.error ? 0 : (parties.data ?? []).length,
  };
}

/** Asks the schedule tab to open its import (the planning path's Schedule step). */
export const OPEN_SCHEDULE_IMPORT = "schedule-import:open";
