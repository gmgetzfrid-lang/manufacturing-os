import { describe, it, expect } from "vitest";
import { setupChecklist, missingRequired } from "@/lib/scheduleSetup";

describe("schedule setup", () => {
  it("time zone and shift times are required; night crews, critical path and baseline are offered", () => {
    const items = setupChecklist({ timezoneSet: false, shiftTimesSaved: false, criticalChosen: false, hasBaseline: false });
    expect(missingRequired(items).map((i) => i.id)).toEqual(["timezone", "shifts"]);
    expect(items.filter((i) => !i.required).map((i) => i.id)).toEqual(["night", "critical", "baseline"]);
  });
  it("doesn't shout while the shift times are still loading", () => {
    const items = setupChecklist({ timezoneSet: true, shiftTimesSaved: null, criticalChosen: false, hasBaseline: true });
    expect(missingRequired(items)).toEqual([]);
    expect(items.find((i) => i.id === "shifts")?.done).toBe(false);
  });
});
