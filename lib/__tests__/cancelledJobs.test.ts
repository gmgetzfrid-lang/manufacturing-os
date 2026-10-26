// A job taken off this schedule leaves every view with its steps, and the
// close-out lists it once — the job, not each step under it.

import { describe, it, expect } from "vitest";
import { splitCancelled } from "@/lib/cancelledJobs";
import type { Milestone } from "@/types/schema";

const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", plannedStartAt: "2026-10-26T06:00:00Z", plannedAt: "2026-10-26T18:00:00Z", ...p } as Milestone);
const AT = "2026-10-26T15:00:00Z";

describe("splitCancelled", () => {
  const unit = mk({ id: "u", name: "Transmix-1" });
  const e17 = mk({ id: "e17", name: "E-17", parentId: "u", cancelledAt: AT, cancelNote: "Bundle not here", movedTo: "Spring 2027 outage" });
  const e17a = mk({ id: "e17a", name: "Pull bundle", parentId: "e17", cancelledAt: AT });
  const e17b = mk({ id: "e17b", name: "Hydroblast", parentId: "e17" }); // stamped or not, it goes with its job
  const v7 = mk({ id: "v7", name: "V-7", parentId: "u" });
  const v7a = mk({ id: "v7a", name: "Open manways", parentId: "v7", plannedStartAt: "2026-10-27T06:00:00Z" });
  const v7b = mk({ id: "v7b", name: "Inspect trays", parentId: "v7", cancelledAt: AT, movedTo: "Nov 15" });

  it("takes the job and its steps off; keeps the rest", () => {
    const { active } = splitCancelled([unit, e17, e17a, e17b, v7, v7a, v7b]);
    expect(active.map((m) => m.id)).toEqual(["u", "v7", "v7a"]);
  });

  it("lists each cancelled job once, with where it sits and how many steps went", () => {
    const { cancelled } = splitCancelled([unit, e17, e17a, e17b, v7, v7a, v7b]);
    expect(cancelled.map((j) => [j.m.name, j.crumbs.join(" › "), j.steps, j.m.movedTo])).toEqual([
      ["E-17", "Transmix-1", 2, "Spring 2027 outage"],
      ["Inspect trays", "Transmix-1 › V-7", 1, "Nov 15"],
    ]);
  });

  it("a task whose every step was cancelled goes too — an empty heading isn't work", () => {
    const tw = mk({ id: "tw", name: "T-605" });
    const tw1 = mk({ id: "tw1", name: "Open manways", parentId: "tw", cancelledAt: AT });
    const { active, cancelled } = splitCancelled([tw, tw1, v7, v7a]);
    expect(active.map((m) => m.id)).toEqual(["v7", "v7a"]);
    expect(cancelled.map((j) => j.m.id)).toEqual(["tw1"]);
  });

  it("nothing cancelled: the same list back", () => {
    const list = [unit, v7, v7a];
    expect(splitCancelled(list).active).toBe(list);
  });
});
