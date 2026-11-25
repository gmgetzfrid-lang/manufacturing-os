// lib/planningPath.ts - where a project in planning stands, step by step:
// Scope, Packages, Schedule, RFQ, Award. Each step is done or not, says
// where it stands in a few words, and the first one not done is next. The
// page's header says the next step; the Plan tab's path shows all five
// (components/projects/setup/ScopeList). Pure.

import { againstSchedule } from "@/lib/woIntake";
import type { ScopeState } from "@/lib/scopeStore";

export type PathKey = "scope" | "pkg" | "sched" | "rfq" | "award";
export interface PathStep { key: PathKey; name: string; done: boolean; state: string }
export interface PathFacts { wos: string[]; steps: number; awarded: number }

/** What the next step asks, said as a task ("attach the packages"). */
export const NEXT_WORDS: Record<PathKey, string> = {
  scope: "import the work order list", pkg: "attach the packages", sched: "import the schedule", rfq: "write the RFQ", award: "award the work",
};

/** Each step as a noun in a sentence ("Then the schedule, the RFQ, the award"). */
export const STEP_NOUN: Record<PathKey, string> = { scope: "the scope", pkg: "the packages", sched: "the schedule", rfq: "the RFQ", award: "the award" };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function planningPath(scope: ScopeState, facts: PathFacts | null): { steps: PathStep[]; next: number } {
  const n = scope.items.length;
  const withPkg = scope.items.filter((x) => x.pkg || x.drafted).length;
  const approved = scope.items.filter((x) => x.approved).length;
  const vs = facts?.wos.length ? againstSchedule(scope.items, facts.wos) : null;
  const rfqs = scope.rfqs ?? [];
  const steps: PathStep[] = [
    { key: "scope", name: "Scope", done: n > 0, state: `${n} work orders${scope.coming.length ? `, ${scope.coming.length} still adding scope` : ""}` },
    { key: "pkg", name: "Packages", done: n > 0 && approved === n, state: `${withPkg} of ${n} attached, ${approved} approved` },
    { key: "sched", name: "Schedule", done: !!vs && vs.missing.length === 0,
      state: !facts?.steps ? "Not imported yet" : vs ? `${vs.on.length} of ${n} work orders on it${vs.missing.length ? `, ${vs.missing.length} missing` : ""}${vs.extra.length ? `, ${vs.extra.length} not in the list` : ""}` : "Imported, with no work order numbers on it" },
    { key: "rfq", name: "RFQ", done: rfqs.length > 0, state: rfqs.length ? `Written for ${[...new Set(rfqs.flatMap((r) => r.to))].join(", ")} (last ${day(rfqs[rfqs.length - 1].at)})` : "Not written yet" },
    { key: "award", name: "Award", done: !!facts?.awarded, state: facts?.awarded ? `${facts.awarded} contract${facts.awarded === 1 ? "" : "s"} awarded` : "Quotes in, then award" },
  ];
  return { steps, next: steps.findIndex((s) => !s.done) };
}
