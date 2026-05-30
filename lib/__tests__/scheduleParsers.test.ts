// lib/__tests__/scheduleParsers.test.ts
//
// Pure-function tests for the schedule-import parsers. These cover
// the bugs that made imported schedules render flat / on the wrong
// days / out of order:
//
//   * Primavera XER dropped start dates and the entire WBS hierarchy.
//   * CSV dropped start dates and never reconstructed hierarchy from
//     an "Outline Level" column.
//   * The MPXJ converter orphans every top-level phase; we rebuild
//     parent links from outline level.
//
// The XML parsers (MS Project XML, P6 XML) rely on DOMParser, which
// isn't present in the node test env, so they're exercised via the
// browser at runtime rather than here.

import { describe, it, expect } from "vitest";
import { parseScheduleFile, reconstructHierarchyFromOutline, dropPlaceholderLeaves, isPlaceholderTaskName } from "@/lib/scheduleParsers";

describe("parseP6Xer", () => {
  const xer = [
    "ERMHDR\t19.12\t2026-01-01\tProject\tadmin",
    "%T\tPROJWBS",
    "%F\twbs_id\tproj_id\tparent_wbs_id\tproj_node_flag\twbs_short_name\twbs_name",
    "%R\t1\t100\t\tY\tROOT\tProject Root",
    "%R\t2\t100\t1\tN\tA\tPhase A",
    "%E",
    "%T\tTASK",
    "%F\ttask_id\tproj_id\twbs_id\ttask_code\ttask_name\ttarget_start_date\ttarget_end_date\tphys_complete_pct",
    "%R\t10\t100\t2\tA1010\tDig trench\t2026-03-01 08:00\t2026-03-03 17:00\t0",
    "%R\t11\t100\t2\tA1020\tPour concrete\t2026-03-04 08:00\t2026-03-06 17:00\t50",
    "%E",
  ].join("\n");

  it("detects the XER format", () => {
    const res = parseScheduleFile("schedule.xer", xer);
    expect(res.format).toBe("p6-xer");
  });

  it("captures start dates (previously dropped)", () => {
    const res = parseScheduleFile("schedule.xer", xer);
    const dig = res.rows.find((r) => r.name === "Dig trench")!;
    expect(dig).toBeTruthy();
    expect(dig.plannedStartAt).toBe("2026-03-01T08:00:00Z");
    expect(dig.plannedAt).toBe("2026-03-03T17:00:00Z");
    expect(dig.percentComplete).toBe(0);
  });

  it("builds the WBS hierarchy: tasks parent under their WBS node", () => {
    const res = parseScheduleFile("schedule.xer", xer);
    const dig = res.rows.find((r) => r.name === "Dig trench")!;
    expect(dig.parentExternalRef).toBe("p6-wbs:2");
    const phaseA = res.rows.find((r) => r.name === "Phase A")!;
    expect(phaseA.isSummary).toBe(true);
    expect(phaseA.parentExternalRef).toBe("p6-wbs:1");
    const root = res.rows.find((r) => r.name === "Project Root")!;
    expect(root.parentExternalRef).toBeNull(); // proj_node_flag=Y
  });

  it("rolls summary spans up from descendant activities", () => {
    const res = parseScheduleFile("schedule.xer", xer);
    const phaseA = res.rows.find((r) => r.name === "Phase A")!;
    // Rolled-up spans go through Date#toISOString, which carries millis.
    expect(new Date(phaseA.plannedStartAt!).getTime()).toBe(Date.parse("2026-03-01T08:00:00Z")); // earliest child start
    expect(new Date(phaseA.plannedAt).getTime()).toBe(Date.parse("2026-03-06T17:00:00Z"));        // latest child finish
  });

  it("computes 1-based outline levels from the tree", () => {
    const res = parseScheduleFile("schedule.xer", xer);
    expect(res.rows.find((r) => r.name === "Project Root")!.outlineLevel).toBe(1);
    expect(res.rows.find((r) => r.name === "Phase A")!.outlineLevel).toBe(2);
    expect(res.rows.find((r) => r.name === "Dig trench")!.outlineLevel).toBe(3);
  });
});

describe("parseMsProjectCsv with outline column", () => {
  const csv = [
    "Task Name,Start,Finish,Outline Level",
    "Phase 1,2026-01-01,2026-01-10,1",
    "Task A,2026-01-01,2026-01-05,2",
    "Task B,2026-01-06,2026-01-10,2",
  ].join("\n");

  it("captures start dates", () => {
    const res = parseScheduleFile("plan.csv", csv);
    const a = res.rows.find((r) => r.name === "Task A")!;
    expect(a.plannedStartAt).toBe("2026-01-01T00:00:00Z");
    expect(a.plannedAt).toBe("2026-01-05T00:00:00Z");
  });

  it("carries unmapped columns into attributes and lifts WO#/location", () => {
    const csv = [
      "Task Name,Start,Finish,Work Order,Contractor,Area,Resource Names",
      "Replace PSV,2026-02-01,2026-02-02,WO-44821,Acme Mech,Unit 12,J. Diaz",
    ].join("\n");
    const res = parseScheduleFile("wo.csv", csv);
    const t = res.rows[0];
    expect(t.workOrderRef).toBe("WO-44821");
    expect(t.location).toBe("Unit 12");
    expect(t.responsibleParty).toBe("J. Diaz");
    expect(t.attributes).toMatchObject({ "work order": "WO-44821", contractor: "Acme Mech", area: "Unit 12" });
  });

  it("reconstructs hierarchy + summary flags from outline level", () => {
    const res = parseScheduleFile("plan.csv", csv);
    const phase = res.rows.find((r) => r.name === "Phase 1")!;
    const a = res.rows.find((r) => r.name === "Task A")!;
    const b = res.rows.find((r) => r.name === "Task B")!;
    expect(phase.isSummary).toBe(true);
    expect(a.parentExternalRef).toBe(phase.externalRef);
    expect(b.parentExternalRef).toBe(phase.externalRef);
  });
});

describe("reconstructHierarchyFromOutline (MPXJ orphan fix)", () => {
  it("links orphaned top-level phases to the project-summary row", () => {
    const rows = [
      { externalRef: "msp-uid:0", parentExternalRef: null, outlineLevel: 0 }, // project summary
      { externalRef: "msp-uid:1", parentExternalRef: null, outlineLevel: 1 }, // orphaned phase
      { externalRef: "msp-uid:2", parentExternalRef: "msp-uid:1", outlineLevel: 2 }, // already correct
    ];
    reconstructHierarchyFromOutline(rows);
    expect(rows[1].parentExternalRef).toBe("msp-uid:0"); // filled
    expect(rows[2].parentExternalRef).toBe("msp-uid:1"); // untouched
  });

  it("leaves a flat list flat when there are no shallower rows", () => {
    const rows = [
      { externalRef: "a", parentExternalRef: null, outlineLevel: 1 },
      { externalRef: "b", parentExternalRef: null, outlineLevel: 1 },
    ];
    reconstructHierarchyFromOutline(rows);
    expect(rows[0].parentExternalRef).toBeNull();
    expect(rows[1].parentExternalRef).toBeNull();
  });
});

describe("placeholder (<New Task>) handling", () => {
  it("recognizes MS Project's placeholder name in its variants", () => {
    expect(isPlaceholderTaskName("<New Task>")).toBe(true);
    expect(isPlaceholderTaskName("  <new task>  ")).toBe(true);
    expect(isPlaceholderTaskName("< New  Task >")).toBe(true);
    expect(isPlaceholderTaskName("New Task setup")).toBe(false);
    expect(isPlaceholderTaskName("Dig trench")).toBe(false);
  });

  it("drops placeholder leaves but keeps placeholders that have children", () => {
    const rows = [
      { name: "<New Task>", externalRef: "p", parentExternalRef: null },        // parent → keep
      { name: "Real child", externalRef: "c", parentExternalRef: "p" },
      { name: "<New Task>", externalRef: "junk", parentExternalRef: null },     // leaf → drop
      { name: "Dig trench", externalRef: "d", parentExternalRef: null },
    ];
    const { rows: kept, dropped } = dropPlaceholderLeaves(rows);
    expect(dropped).toBe(1);
    expect(kept.map((r) => r.externalRef)).toEqual(["p", "c", "d"]);
  });
});
