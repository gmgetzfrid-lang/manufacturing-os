// shiftRecord — what a shift records about itself at its turnover: who was
// on site (each crew's supervisor at the meeting and head count), any
// safety incidents, and the notes & actions it leaves (follow-ups stay on
// every report until someone clears them).
//
// Kept on the shift's own row in shift_handovers (column `record`, from
// 20261105_shift_record.sql) — the row for "2026-10-27:day" is that shift's.

"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export interface CrewCount {
  /** The crew's supervisor at the turnover meeting — doubles as attendance. */
  supervisor?: string;
  /** On site this shift. */
  headcount?: number | null;
}

export const INCIDENT_KINDS = ["Near miss", "First aid", "Recordable", "Spill / release", "Evacuation / alarm", "Stop work", "Property damage"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export interface Incident { id: string; at: number; kind: IncidentKind; text: string; by?: string | null }

export interface ShiftNote {
  id: string;
  /** When it happened (plant time, picked on the shift). */
  at: number;
  text: string;
  /** Stays on the next reports until cleared. */
  followUp?: boolean;
  by?: string | null;
  cleared?: { at: number; by?: string | null } | null;
}

export interface ShiftRecord {
  /** By crew name, as on the schedule. */
  crews?: Record<string, CrewCount>;
  incidents?: { none?: { at: number; by?: string | null } | null; items?: Incident[] };
  notes?: ShiftNote[];
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
    if (crews && Object.values(crews).some((c) => c.supervisor?.trim() || c.headcount != null)) return { key: k, crews };
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

/** Every shift's record on the project, by shift key. Throws a plain
 *  message when the database update hasn't been run. */
export async function loadShiftRecords(projectId: string): Promise<Map<string, ShiftRecord>> {
  const { data, error } = await supabase.from("shift_handovers").select("shift_key, record").eq("project_id", projectId);
  if (error) throw new Error(missing(error.message) ? MISSING : error.message);
  const out = new Map<string, ShiftRecord>();
  for (const r of (data ?? []) as Array<{ shift_key: string; record: ShiftRecord | null }>) if (r.record && Object.keys(r.record).length) out.set(r.shift_key, r.record);
  return out;
}

/** Change one shift's record: read it fresh, apply the change, write the
 *  record back (the turnover's other columns are left alone). */
export async function saveShiftRecord(input: {
  orgId: string; projectId: string; shiftKey: string; userId: string;
  change: (r: ShiftRecord) => ShiftRecord;
}): Promise<ShiftRecord> {
  const { data: cur, error: readErr } = await supabase.from("shift_handovers").select("record")
    .eq("project_id", input.projectId).eq("shift_key", input.shiftKey).maybeSingle();
  if (readErr) throw new Error(missing(readErr.message) ? MISSING : readErr.message);
  const next = input.change(((cur as { record: ShiftRecord | null } | null)?.record) ?? {});
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
