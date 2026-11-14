import { describe, it, expect } from "vitest";
import { closeNeeds, type NeedsInput } from "@/lib/closeNeeds";

// Transmix Phase 1 as the records stand.
const phase1: NeedsInput = {
  typeKnown: true, typeWord: "turnaround",
  roles: { recorded: false, required: 0, filled: 0 },
  companies: ["Ancon", "Kern Energy", "Schultz"], bids: [], rates: [], staffing: [],
  headCounts: { shiftsCounted: 2, shiftsWorked: 17 }, incidentsAnswered: 0,
  targets: [{ name: "Added work", set: false }, { name: "Safety", set: false }, { name: "Quality", set: false }],
  costs: { budget: 630000, spent: 0 }, materials: null, stepsLeft: 3,
};

describe("what the review needs from a person", () => {
  it("each item says where it stands and the one place it goes", () => {
    const n = closeNeeds(phase1);
    const by = (id: string) => n.find((x) => x.id === id)!;
    expect(n.map((x) => x.id)).toEqual(["type", "roles", "staffing", "rates", "heads", "incidents", "targets", "costs", "materials", "steps"]);
    expect(by("type")).toMatchObject({ done: true, status: "Turnaround. Lessons go to every turnaround." });
    expect(by("roles")).toMatchObject({ done: false, status: "Not filled in.", go: { kind: "setup", step: "roles" } });
    // Kern Energy's own crews have no plan or rates to hold them to; each contractor's go on its page.
    expect(by("staffing")).toMatchObject({ done: false, status: "None in. Each shift's head count has no plan to hold it to.", go: { kind: "contractors" }, button: "Costs › Contractors" });
    expect(by("rates")).toMatchObject({ done: false, status: "None in, so labor cost can't be shown.", go: { kind: "contractors" } });
    expect(by("heads")).toMatchObject({ done: false, status: "2 of 17 shifts worked.", go: { kind: "tab", tab: "today" } });
    expect(by("incidents").status).toBe("Answered on 0 of 17 shifts.");
    expect(by("targets")).toMatchObject({ title: "Targets for added work, safety, quality", status: "None set.", go: { kind: "score" } });
    expect(by("costs").status).toBe("$630,000 budget; no spend posted.");
    expect(by("materials").go).toEqual({ kind: "tab", tab: "materials" });
    expect(by("steps")).toMatchObject({ status: "3 steps left.", go: { kind: "steps" } });
    expect(JSON.stringify(n)).not.toMatch(/\u2014/);
  });
  it("filled in, each is done", () => {
    const n = closeNeeds({
      ...phase1, roles: { recorded: true, required: 9, filled: 9 }, bids: ["Ancon"], rates: ["Ancon", "Schultz"], staffing: ["Schultz"],
      headCounts: { shiftsCounted: 15, shiftsWorked: 17 }, incidentsAnswered: 16, targets: phase1.targets.map((t) => ({ ...t, set: true })),
      costs: { budget: 630000, spent: 410000 }, materials: 12, stepsLeft: 0,
    });
    expect(n.every((x) => x.done)).toBe(true);
    expect(n.find((x) => x.id === "staffing")!.status).toBe("In for all 2 contractors.");
  });
  it("a missing plan or rate sheet names the contractor", () => {
    expect(closeNeeds({ ...phase1, staffing: ["Ancon"] }).find((x) => x.id === "staffing")!.status).toBe("None for Schultz.");
    expect(closeNeeds({ ...phase1, rates: ["Schultz"] }).find((x) => x.id === "rates")!.status).toBe("None for Ancon.");
  });
});
