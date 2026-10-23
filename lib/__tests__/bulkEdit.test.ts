import { describe, it, expect } from "vitest";
import { BULK_FIELDS, valuesIn, planReplace, planSet } from "@/lib/bulkEdit";
import type { Milestone } from "@/types/schema";

const mk = (id: string, responsibleParty: string | null, location: string | null = null): Milestone =>
  ({ id, name: `Task ${id}`, orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", plannedAt: "2026-10-26", responsibleParty, location } as Milestone);
const party = BULK_FIELDS.find((f) => f.key === "responsibleParty")!;
const loc = BULK_FIELDS.find((f) => f.key === "location")!;
const ms = [
  mk("1", "Acme Mechanical"), mk("2", "Acme Mechanical, Bay Crane"), mk("3", "acme  mechanical"),
  mk("4", "Bay Crane"), mk("5", null), mk("6", "Acme Mechanical Services", "Unit 6"),
];

describe("swap a contractor on every task", () => {
  it("lists every name in use with its count, names inside lists counted on their own", () => {
    expect(valuesIn(ms, party)).toEqual([
      { value: "Acme Mechanical", count: 3 },
      { value: "Bay Crane", count: 2 },
      { value: "Acme Mechanical Services", count: 1 },
    ]);
  });
  it("replaces the name everywhere — whole names only, other names in a list untouched", () => {
    const plan = planReplace(ms, party, "Acme Mechanical", "Gulf Coast Mech");
    expect(plan.map((c) => [c.id, c.after])).toEqual([
      ["1", "Gulf Coast Mech"], ["2", "Gulf Coast Mech, Bay Crane"], ["3", "Gulf Coast Mech"],
    ]);
  });
  it("blank = remove the name; a name that would appear twice appears once", () => {
    expect(planReplace(ms, party, "Bay Crane", "").map((c) => [c.id, c.after])).toEqual([["2", "Acme Mechanical"], ["4", null]]);
    expect(planReplace(ms, party, "Bay Crane", "Acme Mechanical").find((c) => c.id === "2")!.after).toBe("Acme Mechanical");
  });
  it("sets a value on chosen tasks, skipping ones that already have it", () => {
    expect(planSet(ms, loc, new Set(["5", "6"]), "Unit 6").map((c) => c.id)).toEqual(["5"]);
  });
});
