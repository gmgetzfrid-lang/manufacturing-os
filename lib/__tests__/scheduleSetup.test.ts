import { describe, it, expect } from "vitest";
import { setupChecklist, missingRequired, toDo, requestSetup, takePendingSetup } from "@/lib/scheduleSetup";

describe("schedule setup", () => {
  it("time zone and shift times are required; night crews are required; critical path and baseline are offered", () => {
    const items = setupChecklist({ timezoneSet: false, shiftTimesSaved: false, criticalChosen: false, hasBaseline: false });
    expect(missingRequired(items).map((i) => i.id)).toEqual(["timezone", "shifts", "night"]);
    expect(items.filter((i) => !i.required).map((i) => i.id)).toEqual(["type", "critical", "baseline", "manpower", "roles", "print"]);
    // Roles are optional too: the review reads them, the schedule does not need them.
    expect(toDo(items).map((i) => i.id)).not.toContain("roles");
    // The letterhead is optional: never counted as something to do.
    expect(toDo(items).map((i) => i.id)).not.toContain("print");
    expect(toDo(items).map((i) => i.id)).not.toContain("manpower");
    // So is the project type (read from the name until it's set).
    expect(toDo(items).map((i) => i.id)).not.toContain("type");
  });
  it("doesn't shout while the shift times are still loading", () => {
    const items = setupChecklist({ timezoneSet: true, shiftTimesSaved: null, criticalChosen: false, hasBaseline: true, nightDecided: true });
    expect(missingRequired(items)).toEqual([]);
    expect(items.find((i) => i.id === "shifts")?.done).toBe(false);
  });
  it("night crews aren't 'missing' before the project's saved setting has been read (a new device has no copy)", () => {
    const items = setupChecklist({ timezoneSet: true, shiftTimesSaved: true, criticalChosen: true, hasBaseline: true, nightDecided: null });
    expect(missingRequired(items)).toEqual([]);
    expect(items.find((i) => i.id === "night")).toMatchObject({ done: false, checking: true });
    // Read, and saved: set.
    expect(setupChecklist({ timezoneSet: true, shiftTimesSaved: true, criticalChosen: true, hasBaseline: true, nightDecided: true }).filter((i) => !i.extra).every((i) => i.done)).toBe(true);
  });
  it("Setup asked for from another tab opens at that step once the schedule is on the page", () => {
    requestSetup("roles");
    expect(takePendingSetup()).toBe("roles");
    expect(takePendingSetup()).toBeNull();
    requestSetup();
    expect(takePendingSetup()).toBe("first");
  });
});
