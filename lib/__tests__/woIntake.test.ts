import { describe, it, expect } from "vitest";
import { pickSheet, findHeader, readScope, comingFrom, nameFrom, byCategory, shared, diffScope, applyScope, splitTag, type Sheet } from "@/lib/woIntake";
import { setupChecklist, missingRequired } from "@/lib/scheduleSetup";

// Shaped like a planner's Infor export sorted into tabs: a title row, the
// headers, work orders, blank rows, and a note under the list.
const approved: Sheet = { name: "UNIT 9 - APPROVED WORK", rows: [
  ["UNIT 9 - APPROVED WORK", "", "", "", "", "", "", "", "", ""],
  ["Work Order", "Date Added", "Description of Work", "Equipment", "Equipment Description", "Created By", "Category", "Package Drafted", "Package Approved", "Notes"],
  ["400101", "11/20/26", "Annual Service, Clean, and Inspect 9030.01", "9030.01", "X-1 - Overhead Cooler", "PLANNER", "Exchanger", "FALSE", "FALSE", "Inspect for Cleanliness as of now. 11/20 - AB"],
  ["400102", "11/20/26", "Coat Channel Internals", "9030.01", "X-1 - Overhead Cooler", "PLANNER", "Exchanger", "TRUE", "FALSE", "See Comments"],
  ["400103", "11/20/26", "Tunnel and Clean Tower", "9010.04", "V-4 - Main Tower", "PLANNER", "Tower", "FALSE", "FALSE", ""],
  ["400104", "11/20/26", "Repair corroded gasket surface", "9015-049", "Line 049 - Bottoms to heater", "PLANNER", "Piping", "FALSE", "FALSE", "NEED DRAWING"],
  ["", "", "", "", "", "", "", "", "", ""],
  ["** Waiting on Control Valves (Pat Q.), PSVs (Lee R.), and inspections(MI).", "", "", "", "", "", "", "", "", ""],
] };
const pmList: Sheet = { name: "UNIT 9 - PM LIST", rows: [
  ["Work Order", "WO Due Date", "PM Description", "Equipment"],
  ["400201", "10/1/26", "Replace probe", "9060-CC-1"],
] };

describe("a work order list read into a project's scope", () => {
  it("picks the approved tab, finds the header under the title, and every column by its name", () => {
    expect(pickSheet([pmList, approved])).toBe(1);
    expect(findHeader(approved.rows)).toBe(1);
    const r = readScope(approved);
    expect(r.title).toBe("UNIT 9 - APPROVED WORK");
    expect(Object.keys(r.map).sort()).toEqual(["added", "addedBy", "approved", "category", "drafted", "equipment", "equipmentName", "notes", "what", "wo"]);
    expect(r.items.map((x) => x.wo)).toEqual(["400101", "400102", "400103", "400104"]);
    expect(r.items[0]).toMatchObject({ tag: "X-1", equipmentName: "Overhead Cooler", category: "Exchanger", conditional: true, drafted: false });
    expect(r.items[1].drafted).toBe(true);
  });

  it("the note under the list is scope still coming, each with its owner", () => {
    expect(readScope(approved).coming).toEqual([
      { what: "Control Valves", owner: "Pat Q." }, { what: "PSVs", owner: "Lee R." }, { what: "Inspections", owner: "MI" },
    ]);
    expect(comingFrom("Waiting on the turnaround book")).toEqual([{ what: "The turnaround book", owner: "" }]);
  });

  it("finds the work order column by its numbers when the heading is something else", () => {
    const odd: Sheet = { name: "Sheet1", rows: [["Num", "Job", "Equip"], ["500001", "Pull bundle and hydroblast", "E-5"], ["500002", "Replace gasket on flange", "E-6"]] };
    const r = readScope(odd);
    expect(r.items.map((x) => [x.wo, x.what])).toEqual([["500001", "Pull bundle and hydroblast"], ["500002", "Replace gasket on flange"]]);
  });

  it("names the project from the list's title, groups and counts, and flags equipment with two work orders", () => {
    const r = readScope(approved);
    expect(nameFrom(r.title, "x.xlsx")).toBe("Unit 9 Turnaround");
    expect(nameFrom("", "Crude__NHT_PM_and_WO_List.xlsx")).toBe("Crude NHT Turnaround");
    expect(byCategory(r.items).map((g) => [g.category, g.equipment, g.items.length])).toEqual([["Exchanger", 1, 2], ["Piping", 1, 1], ["Tower", 1, 1]]);
    expect(shared(r.items)).toEqual([{ equipment: "9030.01", tag: "X-1", wos: ["400101", "400102"] }]);
    expect(splitTag("P-60 - Fractionator Bottoms Pump")).toEqual({ tag: "P-60", name: "Fractionator Bottoms Pump" });
  });

  it("a second import says what's new, changed and dropped, and keeps package progress", () => {
    const before = readScope(approved).items;
    const after = [
      { ...before[0], drafted: false, notes: "Dirty: clean it" },
      before[2],
      { ...before[3], wo: "400105", what: "New: replace valve" },
    ];
    const d = diffScope(before, after);
    expect(d.added.map((x) => x.wo)).toEqual(["400105"]);
    expect(d.dropped.map((x) => x.wo)).toEqual(["400102", "400104"]);
    expect(d.changed.map((c) => [c.after.wo, c.fields])).toEqual([["400101", ["notes"]]]);
    expect(d.same).toBe(1);
    const kept = applyScope([{ ...before[0], drafted: true }], after);
    expect(kept[0].drafted).toBe(true);
  });
});

describe("setup asks for night shifts only once there's a schedule", () => {
  const base = { timezoneSet: true, shiftTimesSaved: true, criticalChosen: false, hasBaseline: false, nightDecided: false };
  it("a new project from its list opens nothing by itself", () => {
    expect(missingRequired(setupChecklist({ ...base, scheduleIn: false }))).toEqual([]);
  });
  it("with a schedule, night shifts are required again", () => {
    expect(missingRequired(setupChecklist({ ...base, scheduleIn: true })).map((i) => i.id)).toEqual(["night"]);
  });
});
