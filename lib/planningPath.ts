// lib/planningPath.ts - where a project in planning stands, step by step:
// Scope, Packages, Schedule, RFQ, Award. Each step is done or not, says
// where it stands in a few words, and the first one not done is next. The
// page's header says the next step; the Plan tab's path shows all five
// (components/projects/setup/ScopeList). Pure.

import { againstSchedule, isTypedItem, type ScopeWO } from "@/lib/woIntake";
import type { ScopeState } from "@/lib/scopeStore";

export type PathKey = "scope" | "pkg" | "sched" | "rfq" | "award";
export interface PathStep { key: PathKey; name: string; done: boolean; state: string; skipped?: boolean;
  /** The task in words when it isn't NEXT_WORDS (jobs typed in make their schedule). */
  ask?: string }
export interface PathFacts { wos: string[]; named?: string[]; steps: number; awarded: number }

/** What the next step asks, said as a task ("build the packages"). */
export const NEXT_WORDS: Record<PathKey, string> = {
  scope: "add the work", pkg: "build the packages", sched: "import the schedule", rfq: "write the RFQ", award: "award the work",
};

/** Each step as a noun in a sentence ("Then the schedule, the RFQ, the award"). */
export const STEP_NOUN: Record<PathKey, string> = { scope: "the scope", pkg: "the packages", sched: "the schedule", rfq: "the RFQ", award: "the award" };

/** The list against the schedule, once the schedule has work order numbers
 *  on it (in a WO column or field, or written in step names that match). */
export function scheduleMatch(items: ScopeWO[], facts: PathFacts | null) {
  if (!facts) return null;
  const mine = new Set(items.map((x) => x.wo));
  if (!facts.wos.length && !(facts.named ?? []).some((n) => mine.has(n))) return null;
  return againstSchedule(items, facts.wos, facts.named);
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function planningPath(scopeIn: ScopeState | null, facts: PathFacts | null): { steps: PathStep[]; next: number } {
  // No work added yet: the path still shows, with adding the work first.
  const scope: ScopeState = scopeIn ?? { items: [], coming: [], source: { file: "", sheet: "", headers: [], map: {} }, imports: [] };
  const skip = new Set(scope.skipped ?? []);
  const n = scope.items.length;
  const withPkg = scope.items.filter((x) => x.pkg || x.drafted).length;
  const approved = scope.items.filter((x) => x.approved).length;
  const vs = scheduleMatch(scope.items, facts);
  const rfqs = scope.rfqs ?? [];
  // Jobs typed in, with no work order numbers: no schedule file to import, so
  // the schedule is made from the jobs (lib/jobsSchedule).
  const typed = n > 0 && scope.items.every((x) => isTypedItem(x.wo));
  // Started from its schedule: the schedule is the plan, and its work
  // orders (when it has numbers) are the scope.
  const fromSchedule = scope.start === "schedule" && !!facts?.steps;
  const noNumbers = fromSchedule && n === 0;
  const raw: PathStep[] = [
    { key: "scope", name: "Scope", done: n > 0 || noNumbers,
      state: noNumbers ? "The schedule's steps (no work order numbers on it)" : n ? `${n} ${fromSchedule ? `work order${n === 1 ? "" : "s"}, from the schedule` : `job${n === 1 ? "" : "s"}`}${scope.coming.length ? `, ${scope.coming.length} still adding scope` : ""}` : "No work added yet" },
    { key: "pkg", name: "Packages", done: noNumbers || (n > 0 && approved === n), state: noNumbers ? "No work orders on the schedule to package" : n ? `${withPkg} of ${n} built, ${approved} approved` : "After the work is added" },
    { key: "sched", name: "Schedule", done: noNumbers || (typed ? !!facts?.steps : !!vs && vs.missing.length === 0), ...(typed && !facts?.steps ? { ask: "make the schedule" } : !typed && !noNumbers && facts?.steps && vs?.missing.length ? { ask: "match the schedule to the list" } : {}),
      state: !facts?.steps ? (typed ? "Not made yet" : "Not imported yet") : noNumbers ? `${facts.steps} steps` : typed ? "On the Schedule tab" : vs ? `${vs.on.length} of ${n} work orders on it${vs.missing.length ? `, ${vs.missing.length} missing` : ""}${vs.extra.length ? `, ${vs.extra.length} not in the list` : ""}` : "Imported, with no work order numbers on it" },
    { key: "rfq", name: "RFQ", done: rfqs.length > 0, state: rfqs.length ? `Written for ${[...new Set(rfqs.flatMap((r) => r.to))].join(", ")} (last ${day(rfqs[rfqs.length - 1].at)})` : "Not written yet" },
    { key: "award", name: "Award", done: !!facts?.awarded, state: facts?.awarded ? `${facts.awarded} contract${facts.awarded === 1 ? "" : "s"} awarded` : "Quotes in, then award" },
  ];
  // A step this job doesn't need counts as done, and says so.
  const steps = raw.map((x) => (skip.has(x.key) && !x.done ? { ...x, done: true, skipped: true, state: "Not needed for this job" } : x));
  return { steps, next: steps.findIndex((s) => !s.done) };
}
