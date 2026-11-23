"use client";

// The project's setup, on every tab. "Change" beside anything the project
// asks for (the PSSR on Close-out, What this project needs on Plan, the
// header's Setup) opens the wizard at that part, right where the person
// is, without moving them to another tab. The schedule tabs keep their own
// copy only to show what's still missing on their first card.

import React, { useMemo } from "react";
import type { Milestone } from "@/types/schema";
import { ScheduleSetup } from "@/components/projects/ScheduleSetup";
import { ScheduleTzProvider } from "@/components/projects/ScheduleTzContext";
import { applyNightStaffing } from "@/lib/nightStaffing";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { setBaseline } from "@/lib/milestones";

const quiet = () => undefined;

export default function SetupHost({ orgId, projectId, projectName, timezone, steps, canManage, canEdit, userId, userEmail, userRole, onProjectChanged }: {
  orgId: string; projectId: string; projectName: string; timezone: string | null | undefined;
  /** The whole schedule (every phase, nothing cancelled). */
  steps: Milestone[];
  canManage: boolean; canEdit: boolean; userId: string; userEmail?: string | null; userRole?: string | null;
  onProjectChanged: () => void;
}) {
  const times = useShiftTimes(projectId);
  // Jobs with no night crew are day work, as every schedule view shows them.
  const milestones = useMemo(() => applyNightStaffing(steps, times.nightJobs), [steps, times.nightJobs]);
  const hasBaseline = useMemo(() => steps.some((m) => m.baselineFinishAt), [steps]);
  return (
    <ScheduleTzProvider timeZone={timezone}>
      <ScheduleSetup projectId={projectId} projectName={projectName} timezone={timezone} milestones={milestones} hasBaseline={hasBaseline}
        canManage={canManage} canEdit={canEdit} userId={userId} userEmail={userEmail ?? undefined}
        onProjectChanged={onProjectChanged} onMissing={quiet}
        onSetBaseline={async () => {
          const res = await setBaseline({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail ?? undefined, actorUserRole: userRole ?? undefined });
          if (!res.ok) throw new Error(res.error ?? "Couldn't set the baseline.");
          window.dispatchEvent(new CustomEvent("schedule:changed"));
        }} />
    </ScheduleTzProvider>
  );
}
