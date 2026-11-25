// lib/scheduleScope.ts - a project that starts from its schedule: the
// schedule's work orders are its scope, so nobody is asked for a work order
// list they already planned past. Pure (the dialog writes what this reads).

import type { ParsedMilestone, ParseResult, ScheduleFormat } from "@/lib/scheduleParsers";
import type { MilestoneSource } from "@/types/schema";
import { scheduleByWo, typedItem, type SchedRow, type ScopeWO } from "@/lib/woIntake";

/** What a schedule file holds, for the new-project check. */
export interface ScheduleRead {
  /** Its work orders, as scope items ("From the schedule"). */
  items: ScopeWO[];
  /** Steps (the rows that aren't summaries). */
  steps: number;
  /** First start and last finish (ISO), when it has dates. */
  from: string | null;
  to: string | null;
}

/** The schedule's rows the way the work-order reader takes them: each row
 *  keyed by its own id in the file, its parent, and its WO column/fields. */
function asSchedRows(rows: ParsedMilestone[]): SchedRow[] {
  return rows.map((r, i) => ({
    id: r.externalRef || `row-${i}`,
    name: r.name,
    parent_id: r.parentExternalRef ?? null,
    work_order_ref: r.workOrderRef ?? null,
    attributes: (r.attributes ?? null) as Record<string, unknown> | null,
    percent_complete: r.percentComplete ?? null,
  }));
}

export function readScheduleScope(rows: ParsedMilestone[]): ScheduleRead {
  const { byWo } = scheduleByWo(asSchedRows(rows));
  const at = new Date().toISOString();
  const items: ScopeWO[] = [];
  for (const [wo, o] of Object.entries(byWo)) {
    if (o.cancelled) continue;
    items.push({ ...typedItem({ what: o.name || `WO ${wo}`, wo, group: "From the schedule" }, items), addedAt: at });
  }
  const steps = rows.filter((r) => !r.isSummary);
  const starts = steps.map((r) => r.plannedStartAt || r.plannedAt).filter(Boolean).sort();
  const ends = steps.map((r) => r.plannedAt).filter(Boolean).sort();
  return { items, steps: steps.length, from: starts[0] ?? null, to: ends[ends.length - 1] ?? null };
}

/** Where the rows came from, as the schedule store records it. */
export function scheduleSource(format: ScheduleFormat): Exclude<MilestoneSource, "manual"> {
  return format.startsWith("msproject") ? "msproject" : format.startsWith("p6") ? "p6" : "csv";
}

/** A parsed file's rows as the importer takes them (every hierarchy,
 *  duration and progress field the parser found). */
export function importRows(parse: ParseResult) {
  return parse.rows.map((r) => ({
    name: r.name,
    plannedAt: r.plannedAt,
    plannedStartAt: r.plannedStartAt,
    weight: r.weight,
    percentComplete: r.percentComplete,
    description: r.description,
    externalRef: r.externalRef,
    parentExternalRef: r.parentExternalRef,
    dependsOnExternalRefs: r.dependsOnExternalRefs,
    linksByRef: r.linksByRef,
    outlineLevel: r.outlineLevel,
    wbs: r.wbs,
    isSummary: r.isSummary,
    workOrderRef: r.workOrderRef,
    responsibleParty: r.responsibleParty,
    responsibleKind: r.responsibleKind,
    responsibleOrg: r.responsibleOrg,
    location: r.location,
    durationHours: r.durationHours,
    attributes: r.attributes,
  }));
}

/** The schedule files the new-project dialog and the import both take. */
export const SCHEDULE_ACCEPT = ".xml,.xer,.csv,.txt,application/xml,text/xml,text/csv,text/plain";
