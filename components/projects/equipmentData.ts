"use client";

// The project's units, codebook and equipment list, read once and shared by
// everything on the page that asks (Setup, the equipment field on work
// orders and steps), and what was saved here shown at once on every view.

import { useCallback, useEffect, useState } from "react";
import type { Milestone } from "@/types/schema";
import { loadProjectEquipment, withEquipment, EQUIPMENT_CHANGED, type ProjectEquipmentData, type SavedHere } from "@/lib/projectEquipment";

export const cache = new Map<string, ProjectEquipmentData>();
// Work orders' equipment, unit and type saved here, by project: shown at
// once, before the schedule on screen is read again.
export const savedHere = new Map<string, Map<string, SavedHere>>();
export const noteSaved = (projectId: string, ownerId: string, patch: SavedHere) => {
  const m = savedHere.get(projectId) ?? new Map<string, SavedHere>();
  m.set(ownerId, { ...(m.get(ownerId) ?? {}), ...patch });
  savedHere.set(projectId, m);
};
/** The schedule with what was saved here laid over it (every view's unit
 *  and type filters read it too). */
export const withSavedHere = (projectId: string, milestones: Milestone[]) => withEquipment(milestones, savedHere.get(projectId));
// One read shared by everything on the page that asks at once (the banner
// and the Setup button); a change starts a fresh one.
const inflight = new Map<string, Promise<ProjectEquipmentData>>();
export const read = (orgId: string, projectId: string, fresh: boolean) => {
  if (fresh) inflight.delete(projectId);
  let p = inflight.get(projectId);
  if (!p) {
    p = loadProjectEquipment(orgId, projectId);
    inflight.set(projectId, p);
    p.finally(() => setTimeout(() => { if (inflight.get(projectId) === p) inflight.delete(projectId); }, 10_000)).catch(() => undefined);
  }
  return p;
};
/** The next read is a fresh one (something just changed). */
export const forgetRead = (projectId: string) => { inflight.delete(projectId); };

/** The project's units, the codebook and the equipment list alone (no
 *  work order matching): for the equipment field on a work order or step. */
export function useEquipmentRegistry(orgId: string | null | undefined, projectId: string) {
  const [data, setData] = useState<ProjectEquipmentData | null>(() => cache.get(projectId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((fresh: boolean) => {
    if (!orgId) return Promise.resolve();
    return read(orgId, projectId, fresh).then((d) => { cache.set(projectId, d); setData(d); setError(null); }).catch((e) => setError((e as Error).message));
  }, [orgId, projectId]);
  useEffect(() => {
    void load(false);
    const on = () => void load(false);
    window.addEventListener(EQUIPMENT_CHANGED, on);
    return () => window.removeEventListener(EQUIPMENT_CHANGED, on);
  }, [load]);
  const reload = useCallback(() => load(true), [load]);
  return { data, error, reload };
}
/** Shown at once on every view, before the schedule is read again. */
export const noteEquipmentSaved = (projectId: string, ownerId: string, patch: SavedHere) => noteSaved(projectId, ownerId, patch);

