// shiftRecord — what a shift records about itself at its turnover: who was
// on site (each crew's supervisor at the meeting and head count), any
// safety incidents, and the notes & actions it leaves (follow-ups stay on
// every report until someone clears them).
//
// Kept on the shift's own row in shift_handovers (column `record`, from
// 20261105_shift_record.sql) — the row for "2026-10-27:day" is that shift's.

"use client";

import { noEmDashDeep } from "@/lib/noEmDash";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { TableOrder } from "@/lib/turnoverPlan";
import type { HourlyNotes } from "@/lib/shiftHourly";
import type { ShiftMeeting } from "@/lib/shiftMeeting";
import type { HoldOver } from "@/lib/holdOver";
import type { SheetRecord } from "@/lib/shiftSheet";
import type { ShiftPlan } from "@/lib/shiftReport";

export interface CrewCount {
  /** Who attended the meeting from the crew (lib/shiftMeeting). */
  names?: string[];
  /** Earlier: the crew's supervisor at the meeting (one name). */
  supervisor?: string;
  /** On site this shift (direct + indirect when they're entered). */
  headcount?: number | null;
  /** Of those: on the tools. */
  direct?: number | null;
  /** Of those: supervision, safety, hole and fire watch, QC, tool room. */
  indirect?: number | null;
  /** Plant staff at the meeting (Operations on all the units): not on the
   *  job, not counted on site. */
  plant?: boolean;
}

export const INCIDENT_KINDS = ["Near miss", "First aid", "Recordable", "Spill / release", "Evacuation / alarm", "Stop work", "Property damage"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export interface Incident {
  id: string; at: number; kind: IncidentKind; text: string; by?: string | null;
  /** Changed after it was first written: when and by whom. */
  edited?: { at: number; by?: string | null } | null;
}

export interface ShiftNote {
  id: string;
  /** When it happened (plant time, picked on the shift). */
  at: number;
  text: string;
  /** Stays on the next reports until cleared. */
  followUp?: boolean;
  by?: string | null;
  cleared?: { at: number; by?: string | null } | null;
  /** Changed after it was first written: when and by whom. */
  edited?: { at: number; by?: string | null } | null;
}

/** A lesson for next time, written at the close-out. */
export interface Lesson { id: string; kind: "keep" | "improve"; text: string; by?: string | null; at: number }

/** The close-out's own record (its lessons) — kept beside the shifts'. */
export const CLOSEOUT_KEY = "closeout";

export interface ShiftRecord {
  /** The meeting that starts the shift: who attended from each crew and its
   *  head count on site, by crew name as on the schedule. */
  crews?: Record<string, CrewCount>;
  /** That meeting's safety topic and notes, or that it wasn't held. */
  meeting?: ShiftMeeting;
  /** Crews kept on past the end of the shift (overtime, lib/holdOver). */
  holdOver?: HoldOver[];
  incidents?: { none?: { at: number; by?: string | null } | null; items?: Incident[] };
  notes?: ShiftNote[];
  /** The report's tables as dragged into order at the meeting. */
  order?: TableOrder;
  /** The close-out's lessons (record CLOSEOUT_KEY). */
  lessons?: Lesson[];
  /** Shift notes, hour by hour (lib/shiftHourly): written from the shift's entries as they come in. */
  hourly?: HourlyNotes;
  /** The shift sheet as printed (lib/shiftSheet): its lines, in order, so
   *  entering it shows the same lines. */
  sheet?: SheetRecord;
  /** The shift's plan, set by hand before it (Shift tab › Plan the night):
   *  the steps it's given, and the % expected of each by its end. */
  plan?: ShiftPlan;
}

export const SHIFT_RECORD_MIGRATION = "20261105_shift_record.sql";
const MISSING = `Saving crews, incidents and notes needs the database update (${SHIFT_RECORD_MIGRATION}) run first.`;
const missing = (msg: string) => /record|shift_handovers|does not exist|schema cache/i.test(msg);

/** "2026-10-27:day" before "2026-10-27:night" before "2026-10-28:day". */
export function compareShiftKeys(a: string, b: string): number {
  const [da, ka] = a.split(":"), [db, kb] = b.split(":");
  return da < db ? -1 : da > db ? 1 : ka === kb ? 0 : ka === "day" ? -1 : 1;
}

/** The last earlier shift of the same kind that named its crews — its
 *  supervisors and head counts are the likely ones this time. */
export function lastSameKind(records: Map<string, ShiftRecord>, shiftKey: string): { key: string; crews: Record<string, CrewCount> } | null {
  const kind = shiftKey.split(":")[1];
  const keys = [...records.keys()].filter((k) => k.split(":")[1] === kind && compareShiftKeys(k, shiftKey) < 0).sort(compareShiftKeys).reverse();
  for (const k of keys) {
    const crews = records.get(k)?.crews;
    if (crews && Object.values(crews).some((c) => c.names?.length || c.supervisor?.trim() || c.headcount != null)) return { key: k, crews };
  }
  return null;
}

/** Follow-ups left by earlier shifts and not cleared yet — with the shift
 *  each came from. */
export function openFollowUps(records: Map<string, ShiftRecord>, shiftKey: string): Array<ShiftNote & { shiftKey: string }> {
  const out: Array<ShiftNote & { shiftKey: string }> = [];
  for (const [k, r] of records) {
    if (compareShiftKeys(k, shiftKey) >= 0) continue;
    for (const n of r.notes ?? []) if (n.followUp && !n.cleared) out.push({ ...n, shiftKey: k });
  }
  return out.sort((a, b) => a.at - b.at);
}

// Changes to what a shift already wrote, kept honest: an edit keeps the
// item's id and who first wrote it and stamps the edit; a removed item put
// back (Undo) comes back as it was; a cleared follow-up opens again.

/** An incident changed in place. */
export function editIncident(r: ShiftRecord, id: string, x: { at: number; kind: IncidentKind; text: string }, by: string | null, now = Date.now()): ShiftRecord {
  const items = (r.incidents?.items ?? []).map((i) => (i.id === id ? { ...i, ...x, edited: { at: now, by } } : i));
  return { ...r, incidents: { ...(r.incidents ?? {}), items } };
}

/** A removed incident put back exactly (Undo), unless it's there already. */
export function restoreIncident(r: ShiftRecord, x: Incident): ShiftRecord {
  const items = r.incidents?.items ?? [];
  if (items.some((i) => i.id === x.id)) return r;
  return { ...r, incidents: { none: null, items: [...items, x] } };
}

/** A note changed in place. */
export function editNote(r: ShiftRecord, id: string, x: { at: number; text: string; followUp: boolean }, by: string | null, now = Date.now()): ShiftRecord {
  return { ...r, notes: (r.notes ?? []).map((n) => (n.id === id ? { ...n, ...x, edited: { at: now, by } } : n)) };
}

/** A removed note put back exactly (Undo), unless it's there already. */
export function restoreNote(r: ShiftRecord, x: ShiftNote): ShiftRecord {
  const notes = r.notes ?? [];
  if (notes.some((n) => n.id === x.id)) return r;
  return { ...r, notes: [...notes, x] };
}

/** A cleared follow-up open again (Undo clear): back on every report. */
export function unclearNote(r: ShiftRecord, id: string): ShiftRecord {
  return { ...r, notes: (r.notes ?? []).map((n) => (n.id === id ? { ...n, cleared: null } : n)) };
}

/** Every shift's record on the project, by shift key. Throws a plain
 *  message when the database update hasn't been run. */
export async function loadShiftRecords(projectId: string): Promise<Map<string, ShiftRecord>> {
  const { data, error } = await supabase.from("shift_handovers").select("shift_key, record").eq("project_id", projectId);
  if (error) throw new Error(missing(error.message) ? MISSING : error.message);
  const out = new Map<string, ShiftRecord>();
  for (const r of (data ?? []) as Array<{ shift_key: string; record: ShiftRecord | null }>) if (r.record && Object.keys(r.record).length) out.set(r.shift_key, r.record);
  return out;
}

// One save at a time for each shift: each reads the record fresh, so two
// quick changes (two names added) both land.
const saving = new Map<string, Promise<unknown>>();

/** Change one shift's record: read it fresh, apply the change, write the
 *  record back (the turnover's other columns are left alone). */
export function saveShiftRecord(input: {
  orgId: string; projectId: string; shiftKey: string; userId: string;
  change: (r: ShiftRecord) => ShiftRecord;
}): Promise<ShiftRecord> {
  const k = `${input.projectId}|${input.shiftKey}`;
  const run = (saving.get(k) ?? Promise.resolve()).catch(() => undefined).then(() => saveOnce(input));
  saving.set(k, run);
  const done = () => { if (saving.get(k) === run) saving.delete(k); };
  run.then(done, done);
  return run;
}

async function saveOnce(input: {
  orgId: string; projectId: string; shiftKey: string; userId: string;
  change: (r: ShiftRecord) => ShiftRecord;
}): Promise<ShiftRecord> {
  const { data: cur, error: readErr } = await supabase.from("shift_handovers").select("record")
    .eq("project_id", input.projectId).eq("shift_key", input.shiftKey).maybeSingle();
  if (readErr) throw new Error(missing(readErr.message) ? MISSING : readErr.message);
  // What's typed in it (notes, crews, the hours): no em dash.
  const next = noEmDashDeep(input.change(((cur as { record: ShiftRecord | null } | null)?.record) ?? {}));
  const { error } = await supabase.from("shift_handovers").upsert({
    org_id: input.orgId, project_id: input.projectId, shift_key: input.shiftKey,
    record: next, updated_at: new Date().toISOString(), updated_by: input.userId,
  }, { onConflict: "project_id,shift_key" });
  if (error) throw new Error(missing(error.message) ? MISSING : error.message);
  window.dispatchEvent(new CustomEvent("shift-record:changed", { detail: { projectId: input.projectId } }));
  return next;
}

export const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** The project's shift records, kept fresh after any save here. */
export function useShiftRecords(projectId?: string | null): { records: Map<string, ShiftRecord>; error: string | null; reload: () => void } {
  const [records, setRecords] = useState<Map<string, ShiftRecord>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    loadShiftRecords(projectId)
      .then((m) => { if (alive) { setRecords(m); setError(null); } })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [projectId, tick]);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail?.projectId === projectId) reload(); };
    window.addEventListener("shift-record:changed", on);
    return () => window.removeEventListener("shift-record:changed", on);
  }, [projectId, reload]);
  return { records, error, reload };
}
