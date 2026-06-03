import { describe, it, expect } from "vitest";
import { mockProvider } from "@/lib/ai/mockProvider";

describe("mockProvider.generateSchedule", () => {
  it("builds a phased hierarchy from a plain-English description", async () => {
    const r = await mockProvider.generateSchedule({
      description: "Swap exchanger E-204, replace PSV-12, inspect tower T-301",
      startDate: "2026-03-02",
      shiftPattern: "day-night",
      crew: "Acme Mech",
    });
    expect(r.title.length).toBeGreaterThan(0);
    // Has phase (summary) rows at level 1 and work rows at level 2.
    const phases = r.tasks.filter((t) => t.isSummary && t.outlineLevel === 1);
    const work = r.tasks.filter((t) => t.outlineLevel === 2);
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(work.length).toBeGreaterThan(0);
    // The three described items show up as work tasks.
    const names = work.map((t) => t.name.toLowerCase()).join(" | ");
    expect(names).toContain("e-204");
    expect(names).toContain("psv-12");
    expect(names).toContain("t-301");
  });

  it("assigns the crew and ISO dates anchored to the start", async () => {
    const r = await mockProvider.generateSchedule({
      description: "Clean and inspect vessel",
      startDate: "2026-05-01",
      crew: "In-house crew",
    });
    const work = r.tasks.find((t) => t.outlineLevel === 2)!;
    expect(work.responsibleParty).toBe("In-house crew");
    expect(work.plannedStartAt!.startsWith("2026-05-01")).toBe(true);
    expect(/^\d{4}-\d{2}-\d{2}T/.test(work.plannedAt)).toBe(true);
  });

  it("phase summary rows envelope their children's dates", async () => {
    const r = await mockProvider.generateSchedule({ description: "do A, do B, do C", startDate: "2026-03-02" });
    const firstPhaseIdx = r.tasks.findIndex((t) => t.isSummary);
    const phase = r.tasks[firstPhaseIdx];
    // Children are the following non-summary rows.
    let lo = Infinity, hi = -Infinity;
    for (let i = firstPhaseIdx + 1; i < r.tasks.length && !r.tasks[i].isSummary; i++) {
      lo = Math.min(lo, Date.parse(r.tasks[i].plannedStartAt ?? r.tasks[i].plannedAt));
      hi = Math.max(hi, Date.parse(r.tasks[i].plannedAt));
    }
    expect(Date.parse(phase.plannedStartAt!)).toBe(lo);
    expect(Date.parse(phase.plannedAt)).toBe(hi);
  });

  it("always returns at least a usable skeleton even from a vague brief", async () => {
    const r = await mockProvider.generateSchedule({ description: "turnaround" });
    expect(r.tasks.length).toBeGreaterThan(0);
    expect(r.notes.length).toBeGreaterThan(0);
  });
});

describe("mockProvider.clarifySchedule", () => {
  it("asks only about gaps the stepper didn't fill", async () => {
    const full = await mockProvider.clarifySchedule({
      description: "x", startDate: "2026-03-02", shiftPattern: "24x7", crew: "Acme",
    });
    expect(full).toEqual([]);
    const partial = await mockProvider.clarifySchedule({ description: "x" });
    expect(partial.length).toBe(3); // start, shift, crew
  });
});
