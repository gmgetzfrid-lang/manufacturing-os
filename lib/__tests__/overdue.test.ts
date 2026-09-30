// lib/__tests__/overdue.test.ts
//
// PT SCH-5: three contradictory overdue rules across the schedule surfaces —
// `planned < Date.now()` (ScheduleTab, executionReport → SchedulePulse,
// scheduleFilter, and the snapshot / report before J7), `planned < local
// midnight` (ScheduleProgress) and `planned < startOfDayUTC(now)`
// (ExecutionView's summary strip). Measured at now = 2026-08-21T16:00Z (9am
// Pacific) for a task due 2026-08-21: "overdue" by the first rule in every
// zone, by the second in Los Angeles and Tokyo, never by the third — so the
// pulse said "5 overdue" two inches above a strip saying "Overdue 0".
//
// One predicate now: isOverdueMilestone (lib/milestoneLiveness.ts — the J7
// consumer limb put it there first; this package routes the remaining five
// schedule sites through it). Due today is not overdue, in any timezone.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOverdueMilestone } from "@/lib/milestoneLiveness";
import { computeExecutionReport } from "@/lib/executionReport";
import { filterMilestones, EMPTY_FILTER } from "@/lib/scheduleFilter";
import type { Milestone } from "@/types/schema";

const inZone = <T,>(zone: string, fn: () => T): T => {
  const tz = process.env.TZ;
  try { process.env.TZ = zone; return fn(); } finally { process.env.TZ = tz; }
};
const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", name: "t", weight: 1, plannedAt: "2026-08-21T00:00:00Z", status: "in_progress", source: "manual", createdBy: "u", ...o,
});

describe("SCH-5 · one overdue rule — due today is not overdue, in UTC−8, UTC and UTC+9", () => {
  for (const zone of ["America/Los_Angeles", "UTC", "Asia/Tokyo"]) {
    it(`${zone}: the finding's measured case, and the day boundary`, () => {
      inZone(zone, () => {
        const due = { planned_at: "2026-08-21T00:00:00Z", status: "in_progress" };
        expect(isOverdueMilestone(due, Date.parse("2026-08-21T16:00:00Z"))).toBe(false); // due today
        expect(isOverdueMilestone(due, Date.parse("2026-08-21T23:59:59Z"))).toBe(false);
        expect(isOverdueMilestone(due, Date.parse("2026-08-22T00:00:00Z"))).toBe(true);  // the next UTC day
        expect(isOverdueMilestone({ ...due, status: "completed" }, Date.parse("2026-09-01T00:00:00Z"))).toBe(false);
        // The surfaces agree: the pulse (report) and the filter read the same answer.
        const rows = [mk({ id: "a" })];
        const now = new Date("2026-08-21T16:00:00Z");
        expect(computeExecutionReport(rows, { now }).overdue).toBe(0);
        expect(filterMilestones(rows, { ...EMPTY_FILTER, overdueOnly: true }, { now: now.getTime() }).has("a")).toBe(false);
      });
    });
  }
});

describe("SCH-5 · every call site resolves to the one predicate (source pin)", () => {
  const files = [
    "components/projects/ScheduleTab.tsx",
    "lib/executionReport.ts",
    "lib/scheduleFilter.ts",
    "components/projects/ScheduleProgress.tsx",
    "components/projects/ExecutionView.tsx",
    "lib/projectSnapshot.ts",
    "lib/projectReport.ts",
  ];
  for (const f of files) {
    it(`${f} imports isOverdueMilestone and keeps no local 'planned before now' rule`, () => {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src).toMatch(/import \{[^}]*\bisOverdueMilestone\b[^}]*\} from "@\/lib\/milestoneLiveness";/);
      expect(src).toMatch(/isOverdueMilestone\(/);
      const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // The three retired shapes: finish/planned compared with now, Date.now() or today.
      expect(code).not.toMatch(/(finishMs\(m\)|planned(?:\.getTime\(\))?|plannedAt[^;\n]*\))\s*<\s*(now|nowMs|Date\.now\(\)|today(?:\.getTime\(\))?)\b/);
      expect(code).not.toMatch(/Date\.parse\(m\.plannedAt as string\)\s*>=\s*now/);
      expect(code).not.toMatch(/today\.setHours\(0,\s*0,\s*0,\s*0\)/);
    });
  }
});
