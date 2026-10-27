// Night crews are set by crew: a crew on nights everywhere, or only on the
// equipment chosen (Schultz on the tower only; the hydroblasters on two
// exchangers). Everything else is day work.

import { describe, it, expect } from "vitest";
import { applyNightStaffing, crewEntry, nightCrewChoices, parseEntry, toCrewEntries } from "@/lib/nightStaffing";
import type { Milestone } from "@/types/schema";

const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone => ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const ms = [
  mk({ id: "t", name: "T-101 Tower" }), mk({ id: "e17", name: "E-17 Exchanger" }), mk({ id: "e12", name: "E-12 Exchanger" }),
  mk({ id: "t1", name: "Pull trays", parentId: "t", responsibleParty: "Schultz" }),
  mk({ id: "e1", name: "Pull bundle", parentId: "e17", responsibleParty: "Schultz" }),
  mk({ id: "h1", name: "Hydroblast", parentId: "e17", responsibleParty: "Ancon Hydroblasting" }),
  mk({ id: "h2", name: "Hydroblast", parentId: "e12", responsibleParty: "Ancon Hydroblasting" }),
  mk({ id: "p1", name: "PSV removal", parentId: "e12", responsibleParty: "Valve Shop" }),
  mk({ id: "n1", name: "Calibrate", parentId: "e12" }),
];
const dayIds = (night: string[]) => applyNightStaffing(ms, night).filter((m) => m.staffedShift === "day").map((m) => m.id).sort();

describe("night crews by crew and equipment", () => {
  it("Schultz only on the tower: his exchanger work is day work", () => {
    expect(dayIds([crewEntry("Schultz", "t")])).not.toContain("t1");
    expect(dayIds([crewEntry("Schultz", "t")])).toContain("e1");
  });
  it("the hydroblasters only on E-17: E-12's hydroblast and everyone else's work is day work", () => {
    const d = dayIds([crewEntry("Ancon Hydroblasting", "e17")]);
    expect(d).not.toContain("h1");
    expect(d).toEqual(expect.arrayContaining(["h2", "p1", "t1", "e1", "n1"]));
  });
  it("a crew on all its work, matched however it's capitalised", () => {
    const d = dayIds([crewEntry("schultz ", null)]);
    expect(d).not.toContain("t1"); expect(d).not.toContain("e1");
    expect(d).toContain("h1");
  });
  it("steps with no crew named can be put on nights too", () => {
    expect(dayIds([crewEntry("", "e12")])).not.toContain("n1");
  });
  it("crew names with colons survive the round trip", () => {
    expect(parseEntry(crewEntry("KE: Tower crew", "t"))).toEqual({ crew: "KE: Tower crew", job: "t" });
    expect(parseEntry(crewEntry("KE: Tower crew", null))).toEqual({ crew: "KE: Tower crew", job: null });
  });
  it("an older job-only setting still works, and reads as the crews it covered", () => {
    expect(dayIds(["e17"])).not.toContain("e1");
    expect(dayIds(["e17"])).not.toContain("h1");
    expect(toCrewEntries(ms, ["e17"]).sort()).toEqual([crewEntry("Ancon Hydroblasting", "e17"), crewEntry("Schultz", "e17")].sort());
    // …and gives the same answer as before.
    expect(dayIds(toCrewEntries(ms, ["e17"]))).toEqual(dayIds(["e17"]));
  });
  it("offers each crew with the equipment it works, full names, night-hour steps first", () => {
    const c = nightCrewChoices(ms, (m) => m.id === "h1");
    expect(c[0].crew).toBe("Ancon Hydroblasting");
    expect(c[0].jobs.map((j) => j.name)).toEqual(["E-12 Exchanger", "E-17 Exchanger"]);
    expect(c.find((x) => x.crew === "Schultz")!.jobs.map((j) => j.name)).toEqual(["E-17 Exchanger", "T-101 Tower"]);
    expect(c[c.length - 1].crew).toBe(""); // no crew named, last
  });
});
