"use client";

// Setup › Staffing plans: each contractor's crews and staffing plan, the
// same plan its page in Costs › Contractors shows (with its rate sheet,
// quote and cost), so it is put in once and seen in both places. Kept here:
// the project's manpower settings hook other screens read (which crew is whose).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Milestone } from "@/types/schema";
import { loadManpowerSettings, type ManpowerSettings } from "@/lib/manpower";
import { supabase } from "@/lib/supabase";
import { phasesOfRow, type ProjectPhase } from "@/lib/projectPhases";
import { useCrewSettings } from "@/lib/useCrewSettings";
import { contractorList } from "@/lib/crewSettings";
import ContractorsPanel from "@/components/projects/cost/ContractorsPanel";

export const MANPOWER_CHANGED = "manpower:changed";
const cache = new Map<string, ManpowerSettings>();

/** The project's manpower settings, kept current across the page. */
export function useManpowerSettings(projectId: string | null | undefined) {
  const [s, setS] = useState<ManpowerSettings | null>(() => (projectId ? cache.get(projectId) ?? null : null));
  const load = useCallback(() => {
    if (!projectId) return;
    // A failed read stays "not known" (null), never "no plans": nothing is
    // shown as empty that wasn't read.
    void loadManpowerSettings(projectId).then((x) => { cache.set(projectId, x); setS(x); }).catch((e) => { console.warn("[manpower] settings read failed", e); setS(null); });
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

/** Setup › Staffing plans: each contractor on the schedule and its plan,
 *  put in here or on its page in Costs › Contractors (one plan, both places). */
export function ManpowerStep(p: { projectId: string; milestones: Milestone[]; canManage: boolean; userId?: string; userEmail?: string; timezone?: string | null }) {
  const [phases, setPhases] = useState<ProjectPhase[]>([]);
  useEffect(() => {
    let live = true;
    void supabase.from("projects").select("phases, shift_times").eq("id", p.projectId).maybeSingle().then(({ data }) => { if (live && data) setPhases(phasesOfRow(data as { phases?: unknown; shift_times?: unknown })); });
    return () => { live = false; };
  }, [p.projectId]);
  return (
    <ContractorsPanel mode="staffing" orgId="" projectId={p.projectId} canManage={p.canManage} actor={{ uid: p.userId ?? "", email: p.userEmail ?? null }}
      tz={p.timezone || "America/Los_Angeles"} phases={phases} phase={null} parties={[]} accounts={[]} entries={[]} docs={[]}
      onPartiesChanged={() => {}} onQuotes={() => {}} />
  );
}

/** Setup's check: every contractor on the schedule has a staffing plan
 *  (null while loading; true when there are none to plan). */
export function useStaffingSet(projectId: string, milestones: Milestone[]): boolean | null {
  const s = useCrewSettings(projectId);
  return useMemo(() => {
    if (!s) return null;
    const crews = [...new Set(milestones.filter((m) => !m.cancelledAt).map((m) => m.responsibleParty?.trim() ?? "").filter(Boolean))];
    const list = contractorList(crews, [], s).filter((c) => c.crews.length);
    return list.every((c) => !!s.staffing[c.company]);
  }, [s, milestones]);
}
