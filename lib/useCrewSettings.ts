"use client";

// The project's contractor settings (staffing plans, rate sheets, which
// crew is whose) for screens that read them: the shift meeting's head
// counts and the hold-over's cost. Read once a minute at most; a save on
// Costs › Contractors drops the copy so the next read is fresh.

import { useEffect, useState } from "react";
import { loadCrewSettings, type CrewSettings } from "@/lib/crewSettings";

const cache = new Map<string, { at: number; p: Promise<CrewSettings> }>();
export const CREW_SETTINGS_CHANGED = "crew-settings:changed";

export function invalidateCrewSettings(projectId: string): void {
  cache.delete(projectId);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CREW_SETTINGS_CHANGED, { detail: projectId }));
}

export function useCrewSettings(projectId?: string | null): CrewSettings | null {
  const [s, setS] = useState<CrewSettings | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail === projectId) setTick((t) => t + 1); };
    window.addEventListener(CREW_SETTINGS_CHANGED, on);
    return () => window.removeEventListener(CREW_SETTINGS_CHANGED, on);
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    const hit = cache.get(projectId);
    const p = hit && Date.now() - hit.at < 60_000 ? hit.p : loadCrewSettings(projectId);
    if (!hit || hit.p !== p) cache.set(projectId, { at: Date.now(), p });
    p.then((v) => { if (live) setS(v); }).catch(() => undefined);
    return () => { live = false; };
  }, [projectId, tick]);
  return s;
}
