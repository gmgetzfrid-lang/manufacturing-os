"use client";

// Setup › Contractors: a pointer. Each contractor's crews, staffing plan
// and rate sheet live on its page in Costs › Contractors, with its quote
// and budget line, so they are put in once, in one place. Kept here: the
// project's manpower settings hook other screens read (which crew is whose).

import React, { useCallback, useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Milestone } from "@/types/schema";
import { loadManpowerSettings, type ManpowerSettings } from "@/lib/manpower";
import { openContractor } from "@/lib/costsNav";

export const MANPOWER_CHANGED = "manpower:changed";
const cache = new Map<string, ManpowerSettings>();

/** The project's manpower settings, kept current across the page. */
export function useManpowerSettings(projectId: string | null | undefined) {
  const [s, setS] = useState<ManpowerSettings | null>(() => (projectId ? cache.get(projectId) ?? null : null));
  const load = useCallback(() => {
    if (!projectId) return;
    void loadManpowerSettings(projectId).then((x) => { cache.set(projectId, x); setS(x); }).catch(() => setS({}));
  }, [projectId]);
  useEffect(() => {
    load();
    window.addEventListener(MANPOWER_CHANGED, load);
    return () => window.removeEventListener(MANPOWER_CHANGED, load);
  }, [load]);
  return s;
}

/** Set: some company has a bid. */
export const manpowerSet = (s: ManpowerSettings | null) => (s == null ? null : Object.keys(s.bids ?? {}).length > 0);

const btn = "inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[12.5px] font-bold px-3.5 py-2 shadow-sm";

export function ManpowerStep(_: { projectId: string; milestones: Milestone[]; canManage: boolean; userEmail?: string }) {
  return (
    <div className="space-y-3" data-manpower-moved>
      <p className="text-[13.5px] text-[var(--color-text)]">Each contractor has one page in <b>Costs › Contractors</b>: its crews on the schedule, its staffing plan (upload its sheet or type it in), its rate sheet, its quote and budget line, and every shift&rsquo;s heads and cost against the plan.</p>
      <p className="text-[12.5px] text-[var(--color-text-muted)]">Head counts go in at the shift meeting, where each contractor&rsquo;s plan shows beside its count.</p>
      <button type="button" onClick={() => openContractor(null)} className={btn}>Open Costs › Contractors <ArrowRight className="w-4 h-4" /></button>
    </div>
  );
}
