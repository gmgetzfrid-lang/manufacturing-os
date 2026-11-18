import { describe, it, expect } from "vitest";
import { mostAtOnce, lessonChanges, OFFSITE_STEP, type Lesson } from "@/lib/nextPlanLessons";

describe("lessons for the suggested schedule", () => {
  it("knows a trip off site by its name", () => {
    for (const n of ["Hotshot Exchanger to Redman", "Meter Out for Service", "Send it out for calibration", "Ship to the shop", "Valve at the vendor"]) expect(OFFSITE_STEP.test(n)).toBe(true);
    for (const n of ["Return from Redman", "Pull Bundle", "Hydroblast Shell and Bundle", "Set Blinds; Verify LOTO", "QC Complete"]) expect(OFFSITE_STEP.test(n)).toBe(false);
  });
  it("counts the most open at one moment", () => {
    expect(mostAtOnce([{ start: 0, finish: 10 }, { start: 5, finish: 15 }, { start: 10, finish: 20 }, { start: 12, finish: 13 }])).toBe(3);
    expect(mostAtOnce([{ start: 0, finish: 10 }, { start: 10, finish: 20 }])).toBe(1);
  });
  it("a lesson left out puts in none of its changes", () => {
    const l = (id: string): Lesson => ({ id, area: "planning", title: id, saw: "", does: "", acts: [], changes: [{ id: `${id}:1`, said: "", at: 0, kind: "first", target: { ids: ["x"] } }] });
    expect(lessonChanges([l("a"), l("b")], new Set(["a"])).map((c) => c.id)).toEqual(["b:1"]);
  });
});
