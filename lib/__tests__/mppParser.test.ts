// lib/__tests__/mppParser.test.ts
//
// Covers the tsmpp -> MppTaskRow mapping (the in-process modern-.mpp path):
// date normalization to wall-clock-as-UTC, predecessor links, and hierarchy.
// The real binary parse is exercised manually against MPXJ sample files; here
// we lock the pure mapping logic with a synthetic project so dates/links/levels
// can't silently regress.
import { describe, it, expect } from "vitest";
import { mapTsmppProject } from "@/lib/mppParser";
import type { ProjectData, ProjectTask } from "@tensor-estate/tsmpp";

function task(p: Partial<ProjectTask> & { id: number; name: string }): ProjectTask {
  return {
    level: 0,
    startDate: "2014-10-17T08:00",
    finishDate: "2014-10-17T17:00",
    durationDays: 1,
    isSummary: false,
    isMilestone: false,
    parentId: null,
    predecessors: [],
    ...p,
  } as ProjectTask;
}
function project(tasks: ProjectTask[]): ProjectData {
  return { name: "Test", tasks } as unknown as ProjectData;
}

describe("mapTsmppProject", () => {
  it("normalizes wall-clock dates to a UTC instant (matches the app's storage convention)", () => {
    const [row] = mapTsmppProject(project([task({ id: 1, name: "A", startDate: "2014-10-17T08:00", finishDate: "2014-10-17T17:00" })]));
    expect(row.start).toBe("2014-10-17T08:00:00Z");
    expect(row.finish).toBe("2014-10-17T17:00:00Z");
  });

  it("handles seconds, date-only, already-zoned, and missing dates", () => {
    const rows = mapTsmppProject(project([
      task({ id: 1, name: "secs", startDate: "2020-01-02T03:04:05", finishDate: "2020-01-02" }),
      task({ id: 2, name: "zoned", startDate: "2020-01-02T03:04:00Z", finishDate: null as unknown as string }),
    ]));
    expect(rows[0].start).toBe("2020-01-02T03:04:05Z");
    expect(rows[0].finish).toBe("2020-01-02T00:00:00Z");
    expect(rows[1].start).toBe("2020-01-02T03:04:00Z"); // untouched
    expect(rows[1].finish).toBeNull();
  });

  it("carries predecessor task ids (finish-to-start links)", () => {
    const [row] = mapTsmppProject(project([
      task({ id: 5, name: "succ", predecessors: [{ taskId: 2, type: "FS" }, { taskId: 3, type: "SS" }] }),
    ]));
    expect(row.predecessors).toEqual([2, 3]);
  });

  it("maps hierarchy: parentId -> parentUid and level -> 1-based outlineLevel", () => {
    const [parent, child] = mapTsmppProject(project([
      task({ id: 1, name: "Phase", level: 0, isSummary: true }),
      task({ id: 2, name: "Step", level: 1, parentId: 1 }),
    ]));
    expect(parent.isSummary).toBe(true);
    expect(parent.outlineLevel).toBe(1);
    expect(child.parentUid).toBe(1);
    expect(child.outlineLevel).toBe(2);
  });

  it("skips unnamed rows and preserves milestone flag", () => {
    const rows = mapTsmppProject(project([
      task({ id: 1, name: "", }),
      task({ id: 2, name: "Go-live", isMilestone: true }),
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Go-live");
    expect(rows[0].isMilestone).toBe(true);
  });
});
