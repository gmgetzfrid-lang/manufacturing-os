// Work orders: one per WO number, with every step under it.

import { describe, it, expect } from "vitest";
import { workOrderGroupsOf } from "@/lib/workOrderGroups";
import type { Milestone } from "@/types/schema";

const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone => ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const kidsOf = (ms: Milestone[]) => {
  const m = new Map<string, Milestone[]>();
  for (const x of ms) if (x.parentId) m.set(x.parentId, [...(m.get(x.parentId) ?? []), x]);
  return m;
};

describe("one work order per WO number", () => {
  it("the WO copied down onto steps: still one work order, named for its equipment", () => {
    const ms = [
      mk({ id: "v1", name: "V-01 - Tower", workOrderRef: "304528" }),
      mk({ id: "s1", parentId: "v1", name: "Open", workOrderRef: "304528" }),
      mk({ id: "s2", parentId: "v1", name: "Clean", workOrderRef: "304528" }),
      mk({ id: "s3", parentId: "v1", name: "Inspect" }),
    ];
    const g = [...workOrderGroupsOf(ms, kidsOf(ms)).values()];
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ wo: "304528" });
    expect(g[0].owner.id).toBe("v1");
    expect(g[0].steps.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
  });
  it("steps with no WO under a task whose sub-tasks all carry one number join that work order", () => {
    const ms = [
      mk({ id: "pd", name: "Pulsation Dampeners" }),
      mk({ id: "pd1", parentId: "pd", name: "PD-1", workOrderRef: "310337" }),
      mk({ id: "pd1a", parentId: "pd1", name: "Reinstall PD-1" }),
      mk({ id: "pd2", parentId: "pd", name: "PD-2", workOrderRef: "310337" }),
      mk({ id: "pd2a", parentId: "pd2", name: "Reinstall PD-2" }),
      mk({ id: "weld", parentId: "pd", name: "Weld supports" }),
    ];
    const g = [...workOrderGroupsOf(ms, kidsOf(ms)).values()];
    expect(g).toHaveLength(1);
    expect(g[0].wo).toBe("310337");
    expect(g[0].steps.map((s) => s.id).sort()).toEqual(["pd1a", "pd2a", "weld"]);
  });
  it("several WO numbers under the task: its no-WO steps stay apart", () => {
    const ms = [
      mk({ id: "pd", name: "Pulsation Dampeners" }),
      mk({ id: "pd1", parentId: "pd", name: "PD-1", workOrderRef: "310337" }),
      mk({ id: "pd1a", parentId: "pd1", name: "Reinstall PD-1" }),
      mk({ id: "pd2", parentId: "pd", name: "PD-2", workOrderRef: "310338" }),
      mk({ id: "pd2a", parentId: "pd2", name: "Reinstall PD-2" }),
      mk({ id: "weld", parentId: "pd", name: "Weld supports" }),
    ];
    const g = [...workOrderGroupsOf(ms, kidsOf(ms)).values()];
    expect(g.map((x) => x.wo).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["310337", "310338", null]);
  });
  it("one number on two pieces of equipment: one work order, the other named too", () => {
    const ms = [
      mk({ id: "a", name: "P-1 - Pump", workOrderRef: "300001" }),
      mk({ id: "a1", parentId: "a", name: "Pull pump" }),
      mk({ id: "b", name: "P-2 - Pump", workOrderRef: "300001" }),
      mk({ id: "b1", parentId: "b", name: "Pull pump" }),
    ];
    const g = [...workOrderGroupsOf(ms, kidsOf(ms)).values()];
    expect(g).toHaveLength(1);
    expect(g[0].steps).toHaveLength(2);
    expect(g[0].also?.map((x) => x.id)).toEqual(["b"]);
  });
});
