// lib/stepOpen.ts - ask the schedule to open one step's panel, from
// anywhere on the project page (the "Needed from you" box for a late step).
// The schedule may not be on screen yet (another tab, still loading), so
// the request waits here until the schedule that has the step takes it.

export const STEP_OPEN_EVENT = "step:open";

type Pending = { id: string; edit: boolean };
let pending: Pending | null = null;

/** Open the step's panel; `edit` opens it ready to change its dates. */
export function openStep(id: string, edit = false): void {
  pending = { id, edit };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(STEP_OPEN_EVENT, { detail: { id, edit } }));
}

/** The step waiting to be opened, if this schedule has it (then it's taken). */
export function takePendingStep(has: (id: string) => boolean): Pending | null {
  if (!pending || !has(pending.id)) return null;
  const p = pending;
  pending = null;
  return p;
}
