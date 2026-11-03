// projectStatus - what a project's status change writes, and what it says
// on the record. Pure, so the rules are tested (lib/__tests__).
//
// A finished project can come back: Reopen puts a completed, cancelled or
// archived project back to active and clears the stamps that said it was
// over (completed date, cancel date and reason). The history of it having
// been closed stays in Activity and the audit log.

import type { ProjectStatus } from "@/types/schema";

const CLOSED: ProjectStatus[] = ["completed", "cancelled", "archived"];

/** A completed, cancelled or archived project can be reopened. */
export const canReopen = (status: ProjectStatus | null | undefined): boolean => !!status && CLOSED.includes(status);

/** Going back to active from a closed status. Paused to active is a resume. */
export const isReopen = (from: ProjectStatus | null | undefined, to: ProjectStatus): boolean => to === "active" && canReopen(from);

/** The columns a status change sets on the project row. */
export function statusChangePatch(from: ProjectStatus | null | undefined, to: ProjectStatus, reason: string | undefined, nowIso: string): Record<string, unknown> {
  const patch: Record<string, unknown> = { status: to };
  if (to === "completed") patch.completed_at = nowIso;
  if (to === "cancelled") {
    patch.cancelled_at = nowIso;
    patch.cancelled_reason = reason?.trim() || null;
  }
  if (isReopen(from, to)) {
    patch.completed_at = null;
    patch.cancelled_at = null;
    patch.cancelled_reason = null;
  }
  return patch;
}

/** The line it leaves in Activity: "Project reopened (was completed): reason". */
export function statusActivityBody(from: ProjectStatus | null | undefined, to: ProjectStatus, reason?: string): string {
  const why = reason?.trim() ? `: ${reason.trim()}` : "";
  if (isReopen(from, to)) return `Project reopened (was ${from})${why}`;
  return `Project ${to}${why}`;
}
