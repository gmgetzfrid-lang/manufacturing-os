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

describe("dependency extraction (finish-to-start links)", () => {
  it("P6 XER: maps TASKPRED rows onto the successor's dependsOnExternalRefs", () => {
    const xer = [
      "ERMHDR\t19.12\t2026-01-01\tProject\tadmin",
      "%T\tTASK",
      "%F\ttask_id\tproj_id\twbs_id\ttask_code\ttask_name\ttarget_start_date\ttarget_end_date",
      "%R\t10\t100\t2\tA1010\tDig trench\t2026-03-01 08:00\t2026-03-03 17:00",
      "%R\t11\t100\t2\tA1020\tPour concrete\t2026-03-04 08:00\t2026-03-06 17:00",
      "%E",
      "%T\tTASKPRED",
      "%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt",
      "%R\t1\t11\t10\tPR_FS\t0",
      "%E",
    ].join("\n");
    const res = parseScheduleFile("schedule.xer", xer);
    const pour = res.rows.find((r) => r.name === "Pour concrete")!;
    expect(pour.dependsOnExternalRefs).toEqual(["p6-task:10"]);
    const dig = res.rows.find((r) => r.name === "Dig trench")!;
    expect(dig.dependsOnExternalRefs ?? []).toEqual([]); // no predecessors
  });

  it("CSV: parses the Predecessors column (ids, with FS/lag suffixes stripped)", () => {
    const csv = [
      "ID,Task Name,Start,Finish,Predecessors",
      "1,Design,2026-01-01,2026-01-05,",
      "2,Build,2026-01-06,2026-01-10,1",
      "3,Test,2026-01-11,2026-01-12,2FS+1d",
    ].join("\n");
    const res = parseScheduleFile("plan.csv", csv);
    expect(res.rows.find((r) => r.name === "Build")!.dependsOnExternalRefs).toEqual(["msp:1"]);
    expect(res.rows.find((r) => r.name === "Test")!.dependsOnExternalRefs).toEqual(["msp:2"]);
    expect(res.rows.find((r) => r.name === "Design")!.dependsOnExternalRefs).toBeUndefined();
  });

  it("CSV: handles multiple predecessors", () => {
    const csv = [
      "ID,Task Name,Finish,Predecessors",
      "1,A,2026-01-05,",
      "2,B,2026-01-10,",
      '3,C,2026-01-12,"1,2"',
    ].join("\n");
    const res = parseScheduleFile("plan.csv", csv);
    expect(res.rows.find((r) => r.name === "C")!.dependsOnExternalRefs).toEqual(["msp:1", "msp:2"]);
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

// ─── projects Round G (PT SCH-1 / SCH-3 / SCH-8, PC SCHED-2 / SCHED-6 / SCHED-8 / SCHED-9) ───

import { detectDateConvention, coerceIso, contentKey, durationTextToHours, SCHEDULE_IMPORT_LIMITS } from "@/lib/scheduleParsers";

describe("SCH-1 · day/month is decided once from the whole file, never per row", () => {
  it("a file with any day-part > 12 reads EVERY row as D/M/Y (15/08/2026 fixes it)", () => {
    const csv = [
      "Task Name,Start,Finish",
      "A,01/08/2026,15/08/2026",
      "B,02/08/2026,03/08/2026", // ambiguous on its own — read as 2 Aug because the file is D/M/Y
    ].join("\n");
    const res = parseScheduleFile("plan.csv", csv);
    expect(res.dates).toEqual({ convention: "dmy", decidedBy: "file", sample: "15/08/2026" });
    expect(res.rows.find((r) => r.name === "A")!.plannedAt).toBe("2026-08-15T00:00:00Z");
    expect(res.rows.find((r) => r.name === "B")!.plannedStartAt).toBe("2026-08-02T00:00:00Z");
    expect(res.rows.find((r) => r.name === "B")!.plannedAt).toBe("2026-08-03T00:00:00Z");
  });

  it("a file with a month-part > 12 reads every row as M/D/Y", () => {
    const csv = ["Task Name,Finish", "A,8/15/2026", "B,5/8/2026"].join("\n");
    const res = parseScheduleFile("plan.csv", csv);
    expect(res.dates?.convention).toBe("mdy");
    expect(res.rows.find((r) => r.name === "B")!.plannedAt).toBe("2026-05-08T00:00:00Z");
  });

  it("a genuinely ambiguous file (every value ≤ 12) withholds its rows and asks once; the answer applies to every row and is reported", () => {
    const csv = ["Task Name,Finish", "A,05/08/2026", "B,03/04/2026"].join("\n");
    const asked = parseScheduleFile("plan.csv", csv);
    expect(asked.needsDateConvention).toBe(true);
    expect(asked.rows).toEqual([]);
    expect(asked.dates).toEqual({ convention: null, decidedBy: "none", sample: "05/08/2026" });
    expect(asked.warnings[0]).toMatch(/day\/month or month\/day/);

    const dmy = parseScheduleFile("plan.csv", csv, { dateConvention: "dmy" });
    expect(dmy.needsDateConvention).toBeUndefined();
    expect(dmy.dates).toEqual({ convention: "dmy", decidedBy: "user", sample: "05/08/2026" });
    expect(dmy.rows.map((r) => r.plannedAt)).toEqual(["2026-08-05T00:00:00Z", "2026-04-03T00:00:00Z"]);

    const mdy = parseScheduleFile("plan.csv", csv, { dateConvention: "mdy" });
    expect(mdy.rows.map((r) => r.plannedAt)).toEqual(["2026-05-08T00:00:00Z", "2026-03-04T00:00:00Z"]);
  });

  it("a user's answer never overrides a file that fixed the convention itself", () => {
    const csv = ["Task Name,Finish", "A,15/08/2026"].join("\n");
    const res = parseScheduleFile("plan.csv", csv, { dateConvention: "mdy" });
    expect(res.dates?.decidedBy).toBe("file");
    expect(res.rows[0].plannedAt).toBe("2026-08-15T00:00:00Z");
  });

  it("a self-contradicting file asks too, and under the chosen reading the impossible rows are skipped and counted — never a month 15", () => {
    const csv = ["Task Name,Finish", "A,15/08/2026", "B,08/15/2026"].join("\n");
    const asked = parseScheduleFile("plan.csv", csv);
    expect(asked.needsDateConvention).toBe(true);
    expect(detectDateConvention(csv)).toMatchObject({ conflict: true, ambiguous: true, convention: null });
    const res = parseScheduleFile("plan.csv", csv, { dateConvention: "dmy" });
    expect(res.rows.map((r) => r.name)).toEqual(["A"]);
    expect(res.warnings.some((w) => /1 row skipped \(date could not be read as day\/month\/year\)/.test(w))).toBe(true);
    expect(coerceIso("15/08/2026", "mdy")).toBe("");
  });

  it("ISO dates never trigger the question, and coerceIso is a pure function of (value, convention)", () => {
    expect(detectDateConvention("Task Name,Finish\nA,2026-08-15\nB,2026-08-15T08:00:00")).toEqual({ convention: null, ambiguous: false, conflict: false, sample: null });
    expect(coerceIso("05/08/2026", "dmy")).toBe("2026-08-05T00:00:00Z");
    expect(coerceIso("05/08/2026", "mdy")).toBe("2026-05-08T00:00:00Z");
    expect(coerceIso("15/08/2026 5:30 PM", "dmy")).toBe("2026-08-15T17:30:00Z");
  });
});

describe("SCHED-9 · offset-less datetimes are read as wall-clock-as-UTC", () => {
  it("attaches Z to a bare ISO datetime and keeps an explicit offset", () => {
    expect(coerceIso("2026-06-01T19:00:00")).toBe("2026-06-01T19:00:00Z");
    expect(coerceIso("2026-06-01T19:00:00.000")).toBe("2026-06-01T19:00:00.000Z");
    expect(coerceIso("2026-06-01T19:00:00Z")).toBe("2026-06-01T19:00:00Z");
    expect(coerceIso("2026-06-01T19:00:00+05:30")).toBe("2026-06-01T19:00:00+05:30");
    expect(coerceIso("2026-03-01 08:00")).toBe("2026-03-01T08:00:00Z");
  });
});

describe("SCH-3 · row identity is content, not position", () => {
  const base = [
    "Task Name,Start,Finish",
    "Mobilize,2026-01-01,2026-01-02",
    "Scaffold,2026-01-03,2026-01-05",
    "Hydrotest,2026-01-06,2026-01-06",
  ];
  it("a keyless CSV keys every row on its own content and says so", () => {
    const res = parseScheduleFile("punch.csv", base.join("\n"));
    expect(res.keyColumn).toBe("content (name + dates)");
    // "Task Name" sniffs as MS Project CSV, so the namespace is msp-; a generic
    // header gets csv-. Either way the key is the row's content, not its index.
    for (const r of res.rows) expect(r.externalRef).toMatch(/^msp-key:[0-9a-f]{8}$/);
    expect(res.rows[1].externalRef).toBe(`msp-key:${contentKey("Scaffold", "2026-01-05T00:00:00Z", "2026-01-03T00:00:00Z")}`);
    const generic = parseScheduleFile("punch.csv", ["Name,Start,Finish", "Mobilize,2026-01-01,2026-01-02"].join("\n"));
    expect(generic.rows[0].externalRef).toBe(`csv-key:${contentKey("Mobilize", "2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")}`);
  });

  it("inserting a row at the top leaves every other row's identity intact (GAP-403 acceptance 1)", () => {
    const before = parseScheduleFile("punch.csv", base.join("\n"));
    const after = parseScheduleFile("punch.csv", [base[0], "Permit,2025-12-30,2025-12-31", ...base.slice(1)].join("\n"));
    const refsBefore = new Map(before.rows.map((r) => [r.name, r.externalRef]));
    for (const r of after.rows.filter((x) => x.name !== "Permit")) expect(r.externalRef).toBe(refsBefore.get(r.name));
    expect(after.rows.find((r) => r.name === "Permit")!.externalRef).not.toBe(before.rows[0].externalRef);
    // The old scheme re-pointed csv-row:0 from Mobilize to Permit.
    expect(after.rows.some((r) => /csv-row:/.test(r.externalRef ?? ""))).toBe(false);
  });

  it("two different keyless CSVs into one project do not collide", () => {
    const a = parseScheduleFile("a.csv", base.join("\n"));
    const b = parseScheduleFile("b.csv", ["Task Name,Start,Finish", "Insulate,2026-02-01,2026-02-02", "Paint,2026-02-03,2026-02-04"].join("\n"));
    const refsA = new Set(a.rows.map((r) => r.externalRef));
    for (const r of b.rows) expect(refsA.has(r.externalRef)).toBe(false);
  });

  it("identical rows within one file get a #n suffix and a warning instead of overwriting each other", () => {
    const res = parseScheduleFile("dup.csv", [base[0], base[1], base[1]].join("\n"));
    expect(res.rows[1].externalRef).toBe(`${res.rows[0].externalRef}#2`);
    expect(res.warnings.some((w) => /share.*a key with an earlier row/.test(w))).toBe(true);
  });

  it("MS Project CSV prefers Unique ID and warns when only ID (the outline position) is present", () => {
    const withBoth = parseScheduleFile("msp.csv", ["Unique ID,ID,Task Name,Finish", "101,1,Design,2026-01-05", "205,2,Build,2026-01-10"].join("\n"));
    expect(withBoth.keyColumn).toBe("Unique ID");
    expect(withBoth.rows.map((r) => r.externalRef)).toEqual(["msp:101", "msp:205"]);
    expect(withBoth.warnings.some((w) => /renumbers/.test(w))).toBe(false);

    const idOnly = parseScheduleFile("msp.csv", ["ID,Task Name,Finish", "1,Design,2026-01-05"].join("\n"));
    expect(idOnly.keyColumn).toBe("ID");
    expect(idOnly.rows[0].externalRef).toBe("msp:1");
    expect(idOnly.warnings.some((w) => /keyed on the "ID" column, which MS Project renumbers/.test(w))).toBe(true);
  });
});

describe("SCHED-8 · predecessors resolve through the ID column when both Unique ID and ID exist", () => {
  it("divergent Unique ID / ID columns: links land on the right rows, unresolvable tokens are counted", () => {
    const csv = [
      "Unique ID,ID,Task Name,Finish,Predecessors",
      "101,1,Design,2026-01-05,",
      "205,2,Build,2026-01-10,1",
      "14,3,Test,2026-01-12,\"2,9\"",   // 9 names no row; Unique ID 14 must NOT be mistaken for ID 14
      "300,4,Ship,2026-01-14,14",       // ID 14 does not exist → unresolved, not "Test"
    ].join("\n");
    const res = parseScheduleFile("msp.csv", csv);
    expect(res.rows.find((r) => r.name === "Build")!.dependsOnExternalRefs).toEqual(["msp:101"]);
    expect(res.rows.find((r) => r.name === "Test")!.dependsOnExternalRefs).toEqual(["msp:205"]);
    expect(res.rows.find((r) => r.name === "Ship")!.dependsOnExternalRefs).toBeUndefined();
    expect(res.links).toEqual({ fs: 2, notEnforced: 0, withLag: 0, unresolved: 2 });
    expect(res.warnings.some((w) => /2 predecessor references pointed at a row that is not in this file/.test(w))).toBe(true);
  });

  it("Unique ID without ID: predecessors are NOT guessed against the Unique ID namespace", () => {
    const res = parseScheduleFile("msp.csv", ["Unique ID,Task Name,Finish,Predecessors", "101,Design,2026-01-05,", "205,Build,2026-01-10,101"].join("\n"));
    expect(res.rows.find((r) => r.name === "Build")!.dependsOnExternalRefs).toBeUndefined();
    expect(res.warnings.some((w) => /Predecessor links were not imported/.test(w))).toBe(true);
  });
});

describe("SCH-8 · relationship type + lag are captured; only FS becomes an edge", () => {
  it("CSV tokens: SS/FF/SF are recorded and reported as not enforced; FS lag is recorded", () => {
    const csv = [
      "ID,Task Name,Finish,Predecessors",
      "1,A,2026-01-05,",
      "2,B,2026-01-10,1SS+1d",
      "3,C,2026-01-12,\"2FS+2h,1FF\"",
    ].join("\n");
    const res = parseScheduleFile("plan.csv", csv);
    const b = res.rows.find((r) => r.name === "B")!;
    expect(b.dependsOnExternalRefs).toBeUndefined();
    expect(b.links).toEqual([{ predecessorExternalRef: "msp:1", type: "SS", lagHours: 8 }]);
    expect(b.attributes?.source_links).toBe("SS msp:1 +8h");
    const c = res.rows.find((r) => r.name === "C")!;
    expect(c.dependsOnExternalRefs).toEqual(["msp:2"]);
    expect(c.links).toEqual([
      { predecessorExternalRef: "msp:2", type: "FS", lagHours: 2 },
      { predecessorExternalRef: "msp:1", type: "FF", lagHours: 0 },
    ]);
    expect(c.attributes?.source_links).toBe("FS msp:2 +2h; FF msp:1");
    expect(res.links).toEqual({ fs: 1, notEnforced: 2, withLag: 1, unresolved: 0 });
    expect(res.warnings.some((w) => /2 start-to-start \/ finish-to-finish \/ start-to-finish links captured but not enforced/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /1 finish-to-start link carries lag/.test(w))).toBe(true);
  });

  it("XER TASKPRED: pred_type + lag_hr_cnt survive; an SS + FF pair does not become a cycle", () => {
    const xer = [
      "ERMHDR\t19.12\t2026-01-01\tProject\tadmin",
      "%T\tTASK",
      "%F\ttask_id\tproj_id\twbs_id\ttask_code\ttask_name\ttarget_start_date\ttarget_end_date\ttarget_drtn_hr_cnt",
      "%R\t10\t100\t2\tA1010\tDig trench\t2026-03-01 08:00\t2026-03-03 17:00\t24",
      "%R\t11\t100\t2\tA1020\tPour concrete\t2026-03-04 08:00\t2026-03-06 17:00\t16",
      "%E",
      "%T\tTASKPRED",
      "%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt",
      "%R\t1\t11\t10\tPR_SS\t4",
      "%R\t2\t11\t10\tPR_FF\t0",
      "%E",
    ].join("\n");
    const res = parseScheduleFile("schedule.xer", xer);
    const pour = res.rows.find((r) => r.name === "Pour concrete")!;
    expect(pour.dependsOnExternalRefs).toBeUndefined();
    expect(pour.links).toEqual([
      { predecessorExternalRef: "p6-task:10", type: "SS", lagHours: 4 },
      { predecessorExternalRef: "p6-task:10", type: "FF", lagHours: 0 },
    ]);
    expect(pour.attributes?.source_links).toBe("SS p6-task:10 +4h; FF p6-task:10");
    expect(res.links?.notEnforced).toBe(2);
    // SCHED-2: target_drtn_hr_cnt → durationHours
    expect(pour.durationHours).toBe(16);
    expect(res.rows.find((r) => r.name === "Dig trench")!.durationHours).toBe(24);
  });
});

describe("SCHED-2 · work hours reach durationHours", () => {
  it("CSV Work / Duration text is parsed to hours (8 h days, 40 h weeks)", () => {
    expect(durationTextToHours("40 hrs")).toBe(40);
    expect(durationTextToHours("5 days")).toBe(40);
    expect(durationTextToHours("2 wks")).toBe(80);
    expect(durationTextToHours("90 mins")).toBe(1.5);
    expect(durationTextToHours("12")).toBe(12);
    expect(durationTextToHours("")).toBeNull();
    const res = parseScheduleFile("msp.csv", ["ID,Task Name,Finish,Work", "1,Weld,2026-01-05,40 hrs", "2,Sign,2026-01-06,"].join("\n"));
    expect(res.rows[0].durationHours).toBe(40);
    expect(res.rows[1].durationHours).toBeNull();
  });
});

describe("SCHED-6 · a multi-project XER is never merged", () => {
  const xer = [
    "ERMHDR\t19.12\t2026-01-01\tProject\tadmin",
    "%T\tPROJECT",
    "%F\tproj_id\tproj_short_name",
    "%R\t100\tUNIT-100",
    "%R\t200\tUNIT-200",
    "%E",
    "%T\tPROJWBS",
    "%F\twbs_id\tproj_id\tparent_wbs_id\tproj_node_flag\twbs_short_name\twbs_name",
    "%R\t1\t100\t\tY\tR1\tUnit 100 Root",
    "%R\t2\t200\t\tY\tR2\tUnit 200 Root",
    "%E",
    "%T\tTASK",
    "%F\ttask_id\tproj_id\twbs_id\ttask_code\ttask_name\ttarget_start_date\ttarget_end_date",
    "%R\t10\t100\t1\tA1\tDig trench\t2026-03-01 08:00\t2026-03-03 17:00",
    "%R\t20\t200\t2\tB1\tOther unit work\t2026-03-01 08:00\t2026-03-03 17:00",
    "%R\t21\t200\t2\tB2\tMore other unit work\t2026-03-04 08:00\t2026-03-06 17:00",
    "%E",
  ].join("\n");

  it("lists the projects with their counts and withholds rows until one is chosen", () => {
    const res = parseScheduleFile("eps.xer", xer);
    expect(res.needsProjectChoice).toBe(true);
    expect(res.rows).toEqual([]);
    expect(res.projects).toEqual([{ id: "100", name: "UNIT-100", rows: 1 }, { id: "200", name: "UNIT-200", rows: 2 }]);
    expect(res.warnings[0]).toMatch(/holds 2 projects \(UNIT-100, UNIT-200\)/);
  });

  it("with a choice, only that project's activities and WBS come through", () => {
    const res = parseScheduleFile("eps.xer", xer, { projectId: "200" });
    expect(res.needsProjectChoice).toBeUndefined();
    expect(res.selectedProjectId).toBe("200");
    expect(res.rows.map((r) => r.name).sort()).toEqual(["More other unit work", "Other unit work", "Unit 200 Root"]);
    expect(res.rows.some((r) => r.name === "Dig trench")).toBe(false);
  });

  it("a single-project file needs no choice", () => {
    const single = xer.split("\n").filter((l) => !/\t200\t/.test(l)).join("\n");
    const res = parseScheduleFile("one.xer", single);
    expect(res.needsProjectChoice).toBeUndefined();
    expect(res.projects).toEqual([{ id: "100", name: "UNIT-100", rows: 1 }]);
    expect(res.rows.some((r) => r.name === "Dig trench")).toBe(true);
  });
});

describe("SCH-14 · limits are named constants", () => {
  it("5 MB / 5,000 rows", () => {
    expect(SCHEDULE_IMPORT_LIMITS).toEqual({ maxBytes: 5 * 1024 * 1024, maxRows: 5000 });
  });
});
