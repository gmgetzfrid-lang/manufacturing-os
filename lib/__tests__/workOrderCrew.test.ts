// A step with no crew named takes its work order's crew — never a guess.

import { describe, it, expect } from "vitest";
import { inheritedCrews, withWorkOrderCrews, woOf } from "@/lib/workOrderCrew";
import { applyNightStaffing, crewEntry } from "@/lib/nightStaffing";
import { standingOf } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone => ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

describe("a blank crew takes the work order's", () => {
  const uit = mk({ id: "uit", name: "UIT-013 - Coriolis Meter" });
  const blinds = mk({ id: "b", name: "Set Blinds; Verify LOTO", parentId: "uit", responsibleParty: "Maintenance (KE)" });
  const remove = mk({ id: "r", name: "Remove Meter", parentId: "uit", responsibleParty: "Maintenance (KE)" });
  const cal = mk({ id: "c", name: "Calibrate Equipment", parentId: "uit" });
  it("UIT-013 Calibrate Equipment is Maintenance (KE), like the rest of its work order", () => {
    expect(inheritedCrews([uit, blinds, remove, cal]).get("c")).toBe("Maintenance (KE)");
    expect(withWorkOrderCrews([uit, blinds, remove, cal]).find((m) => m.id === "c")!.responsibleParty).toBe("Maintenance (KE)");
  });
  it("the work order's own crew wins", () => {
    expect(inheritedCrews([{ ...uit, responsibleParty: "E/I (KE)" }, blinds, cal]).get("c")).toBe("E/I (KE)");
  });
  it("two different crews on the work order: still unknown, never a guess", () => {
    expect(inheritedCrews([uit, blinds, { ...remove, responsibleParty: "Schultz" }, cal]).has("c")).toBe(false);
  });
  it("a step's own crew is never replaced", () => {
    expect(inheritedCrews([uit, blinds, remove, cal]).has("b")).toBe(false);
  });
  it("the schedule itself isn't changed", () => {
    const list = [uit, blinds, remove, cal];
    withWorkOrderCrews(list);
    expect(cal.responsibleParty).toBeUndefined();
  });
  it("night staffing by crew covers it too", () => {
    const out = applyNightStaffing([uit, blinds, remove, cal], [crewEntry("Maintenance (KE)", null)]);
    expect(out.find((m) => m.id === "c")!.staffedShift).not.toBe("day");
  });
});

describe("one verdict", () => {
  it("25% vs 21% is on track - the tile must not say 'Work ahead' beside it", () => {
    expect(standingOf(25, 21)).toBe("on track");
  });
});

describe("WO numbers", () => {
  const ms = (id: string, parentId: string | null, extra: Partial<Milestone> = {}): Milestone =>
    ({ id, parentId, orgId: "o", projectId: "p", name: id, weight: 1, status: "planned", source: "manual", createdBy: "u", ...extra } as Milestone);
  it("a step with none takes its work order's; its own wins; the file's WO column counts", () => {
    const out = withWorkOrderCrews([
      ms("wo", null, { workOrderRef: "4410036" }),
      ms("a", "wo"),
      ms("b", "wo", { workOrderRef: "4410099" }),
      ms("wo2", null, { attributes: { "WO #": "4410040" } }),
      ms("c", "wo2"),
      ms("d", null, { attributes: { "Work Order Status": "open" } }),
    ]);
    const by = new Map(out.map((m) => [m.id, m.workOrderRef]));
    expect(by.get("a")).toBe("4410036");
    expect(by.get("b")).toBe("4410099");
    expect(by.get("c")).toBe("4410040");
    expect(by.get("d")).toBeUndefined();
    expect(woOf(ms("x", null, { attributes: { "Work Order": 4410041 } }))).toBe("4410041");
  });
});
