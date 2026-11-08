// The as-built schedule: each work order and step against the original
// plan, with what wasn't recorded said so.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { buildAsBuilt, asBuiltDocument, varianceWords } from "@/lib/asBuiltSchedule";

const tz = "America/Los_Angeles";
const at = (d: string, h: string) => `${d}T${h}:00-07:00`;
const m = (id: string, x: Record<string, unknown>) => ({ id, name: id, parentId: null, status: "planned", percentComplete: 0, ...x } as unknown as Milestone);
const saved = { baselineSetAt: at("2026-10-28", "09:00") };
const ms: Milestone[] = [
  m("E-12", { workOrderRef: "301502" }),
  m("Shell hydro", { parentId: "E-12", durationHours: 2, plannedStartAt: at("2026-10-28", "08:00"), plannedAt: at("2026-10-28", "10:00"), baselineStartAt: at("2026-10-28", "08:00"), baselineFinishAt: at("2026-10-28", "10:00"), ...saved,
    status: "completed", percentComplete: 100, actualStartAt: at("2026-10-28", "12:00"), actualAt: at("2026-10-28", "13:00") }),
  m("Pull blinds", { parentId: "E-12", durationHours: 2, plannedStartAt: at("2026-10-28", "10:00"), plannedAt: at("2026-10-28", "12:00"), baselineStartAt: at("2026-10-28", "10:00"), baselineFinishAt: at("2026-10-28", "12:00"), ...saved,
    status: "completed", percentComplete: 100, actualAt: at("2026-10-29", "08:00") }),
  m("Welded pipe", { parentId: "E-12", durationHours: 23, plannedStartAt: at("2026-10-29", "06:00"), plannedAt: at("2026-10-30", "05:00"),
    attributes: { discovery: { id: "d1", seq: 1, what: "low TML", foundAt: Date.parse(at("2026-10-29", "03:00")), impact: { hours: 32 } } },
    status: "in_progress", percentComplete: 40, actualStartAt: at("2026-10-29", "07:00") }),
];
const kids = new Map<string, Milestone[]>([["E-12", ms.slice(1)]]);

describe("buildAsBuilt", () => {
  const a = buildAsBuilt({ milestones: ms, childrenByParent: kids, tz });
  it("one work order, its steps against the original plan", () => {
    expect(a.orders).toHaveLength(1);
    const o = a.orders[0];
    expect(o.wo).toBe("301502");
    expect(o.steps.map((s) => [s.name, s.inPlan, s.varianceH, s.elapsedH])).toEqual([
      ["Shell hydro", true, 3, 1],
      ["Pull blinds", true, 20, null],
      ["Welded pipe", false, null, null],
    ]);
    expect(o.status).toBe("in_progress");
    expect(o.finish).toBeNull();
  });
  it("a start not recorded is said, and its bar starts at the planned start", () => {
    const s = a.orders[0].steps[1];
    expect(s.start).toBeNull();
    expect(s.barStart).toBe(Date.parse(at("2026-10-28", "10:00")));
    expect(a.startsNotRecorded).toBe(1);
  });
  it("added work is marked, and the plan is the one saved", () => {
    expect(a.orders[0].steps[2].added).toBe("discovery");
    expect(a.basis.kind).toBe("baseline");
    expect(a.planFinish).toBe(Date.parse(at("2026-10-28", "12:00")));
    expect(a.added).toBe(1);
  });
  it("the page says it", () => {
    const html = asBuiltDocument(a, { project: "Transmix", scope: "Whole project", tz, now: Date.parse(at("2026-11-08", "09:00")) });
    expect(html).toContain("not recorded");
    expect(html).toContain("WO 301502");
    expect(html).toContain("added: discovery");
    expect(html).toContain("still going");
    expect(html).not.toMatch(/[—–]/);
  });
  it("variance words", () => {
    expect(varianceWords(33.5)).toBe("+33.5 h");
    expect(varianceWords(-2)).toBe("-2 h");
    expect(varianceWords(0.2)).toBe("on plan");
    expect(varianceWords(null)).toBe("");
  });
});
