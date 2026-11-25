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

describe("packages, the schedule and the RFQ from the scope", () => {
  it("one package covers every work order on a piece of equipment, not a whole unit", async () => {
    const { packageGroup } = await import("@/lib/woIntake");
    const r = readScope(approved);
    expect(packageGroup(r.items, "400101").map((x) => x.wo)).toEqual(["400101", "400102"]);
    expect(packageGroup([...r.items, { ...r.items[2], wo: "400199", equipment: "20 - Unit 9", tag: "" }, { ...r.items[2], wo: "400198", equipment: "20 - Unit 9", tag: "" }], "400199").map((x) => x.wo)).toEqual(["400199"]);
  });

  it("the schedule against the list: on it, missing from it, and on it but not in the list", async () => {
    const { againstSchedule } = await import("@/lib/woIntake");
    const v = againstSchedule(readScope(approved).items, ["400101", "400103", "999001"]);
    expect(v.on.map((x) => x.wo)).toEqual(["400101", "400103"]);
    expect(v.missing.map((x) => x.wo)).toEqual(["400102", "400104"]);
    expect(v.extra).toEqual(["999001"]);
  });

  it("the RFQ says the scope counted from the list, the shifts and meetings from the project", async () => {
    const { rfqContent, rfqDocx } = await import("@/lib/rfqFromScope");
    const r = readScope(approved);
    const f = { project: "Unit 9 Turnaround", org: "Acme Refining", service: "Mechanical Contractor Services", to: "Contractor A", fromName: "Planner", contact: "555-0100", location: "Plant 1",
      quoteBy: "2027-01-15", start: "2027-03-01", finish: "2027-03-20", dayStart: "06:00", nightStart: "18:00", meetingBefore: 30, nights: true, items: r.items, coming: r.coming, today: new Date("2027-01-02T12:00:00") };
    const c = rfqContent(f);
    expect(c.title).toBe("Request for Quotation (RFQ): 2027 Unit 9 Turnaround");
    expect(c.glance.rows).toEqual([["Heat exchangers (open, clean, service)", 1, 2], ["Piping work orders", 1, 1], ["Towers (tunnel and clean)", 1, 1]]);
    expect(c.coverage.shifts).toBe("Shifts run 0600 to 1800 (days) and 1800 to 0600 (nights).");
    expect(c.expectations[1][1]).toContain("daily at 0530 and 1730");
    expect(c.glance.coming).toBe("Scope still being added: control valves, PSVs, inspections. An addendum will follow.");
    expect(c.quoteBy).toBe("1/15/2027");
    expect(c.workOrders[0].rows[0]).toEqual(["400101", "X-1 Overhead Cooler", "Annual Service, Clean, and Inspect 9030.01"]);
    expect(rfqDocx(f).byteLength).toBeGreaterThan(1000);
  });
});

describe("the planning path says the next step", () => {
  it("packages first, then the schedule, the RFQ and the award, from what's done", async () => {
    const { planningPath, NEXT_WORDS } = await import("@/lib/planningPath");
    const r = readScope(approved);
    const scope = { items: r.items, coming: r.coming, source: { file: "x.xlsx", sheet: r.sheet, headers: r.headers, map: r.map }, imports: [] };
    let p = planningPath(scope, null);
    expect(p.steps[p.next].key).toBe("pkg");
    expect(NEXT_WORDS[p.steps[p.next].key]).toBe("attach the packages");
    expect(p.steps[1].state).toBe("1 of 4 attached, 0 approved");
    const done = { ...scope, items: r.items.map((x) => ({ ...x, drafted: true, approved: true })) };
    p = planningPath(done, { wos: ["400101", "400102", "400103"], steps: 10, awarded: 0 });
    expect(p.steps[p.next].key).toBe("sched");
    expect(p.steps[2].state).toBe("3 of 4 work orders on it, 1 missing");
    p = planningPath({ ...done, rfqs: [{ at: "2027-01-02T12:00:00Z", service: "Mech", to: ["Contractor A"] }] }, { wos: r.items.map((x) => x.wo), steps: 10, awarded: 1 });
    expect(p.next).toBe(-1);
  });
});

describe("a project with no work order list", () => {
  it("the path starts with adding the work, and says so in the header's words", async () => {
    const { planningPath, NEXT_WORDS } = await import("@/lib/planningPath");
    const p = planningPath(null, null);
    expect(p.next).toBe(0);
    expect(p.steps[0].state).toBe("No work added yet");
    expect(NEXT_WORDS[p.steps[0].key]).toBe("add the work");
  });

  it("jobs typed in keep their WO number when they have one, and aren't matched to the schedule without one", async () => {
    const { typedItem, isTypedItem, againstSchedule } = await import("@/lib/woIntake");
    const a = typedItem({ what: "Replace 6\" gate valve", equipment: "P-60" }, []);
    expect(a).toMatchObject({ wo: "item-1", tag: "P-60", what: "Replace 6\" gate valve", category: "Work" });
    expect(isTypedItem(a.wo)).toBe(true);
    const b = typedItem({ what: "Weld bleeder", wo: "WO 307897", equipment: "LV-431 on the outlet of E-403" }, [a]);
    expect(b.wo).toBe("307897");
    const v = againstSchedule([a, b], ["307897"]);
    expect(v.missing).toEqual([]);
    expect(v.on.map((x) => x.wo)).toEqual(["307897"]);
  });

  it("steps a small job doesn't need count as done and say so", async () => {
    const { planningPath } = await import("@/lib/planningPath");
    const { typedItem } = await import("@/lib/woIntake");
    const items = [typedItem({ what: "Swap pump seal", equipment: "P-12" }, [])];
    const p = planningPath({ items, coming: [], source: { file: "Typed in", sheet: "", headers: [], map: {} }, imports: [], skipped: ["pkg", "rfq", "award"] }, null);
    expect(p.steps.map((s) => [s.key, s.done, s.state])).toEqual([
      ["scope", true, "1 job"], ["pkg", true, "Not needed for this job"], ["sched", false, "Not made yet"], ["rfq", true, "Not needed for this job"], ["award", true, "Not needed for this job"],
    ]);
    expect(p.steps[p.next].key).toBe("sched");
  });
});

describe("a schedule made from the jobs (no schedule file)", () => {
  it("jobs run one after another on day shifts, the night skipped, under their equipment", async () => {
    const { jobsSchedule } = await import("@/lib/jobsSchedule");
    const { typedItem } = await import("@/lib/woIntake");
    const a = typedItem({ what: "Replace mechanical seal", equipment: "P-60" }, []);
    const b = typedItem({ what: "Rig in scaffold", equipment: "" }, [a]);
    const c = typedItem({ what: "Align pump and motor", equipment: "P-60", wo: "307897" }, [a, b]);
    const w = { dayStart: "06:00", nightStart: "18:00", nights: false };
    const r = jobsSchedule([{ item: a, hours: 10 }, { item: b, hours: 4 }, { item: c, hours: 3 }], "2027-03-01T06:00", w);
    // P-60's two jobs together first, then the one with no equipment.
    expect(r.rows.map((x) => [x.wbs, x.name, x.plannedStartAt, x.plannedAt])).toEqual([
      ["1", "P-60", "2027-03-01 06:00", "2027-03-02 07:00"],
      ["1.1", "Replace mechanical seal", "2027-03-01 06:00", "2027-03-01 16:00"],
      ["1.2", "Align pump and motor", "2027-03-01 16:00", "2027-03-02 07:00"],
      ["2", "Rig in scaffold", "2027-03-02 07:00", "2027-03-02 11:00"],
    ]);
    expect(r.rows[2]).toMatchObject({ workOrderRef: "307897", parentExternalRef: "eq:P-60", dependsOnExternalRefs: ["job:item-1"], durationHours: 3 });
    expect(r.rows[1].workOrderRef).toBeNull();
    expect(r.finish).toBe("2027-03-02 11:00");
  });

  it("around the clock when nights are worked; a job with no hours is left out", async () => {
    const { jobsSchedule } = await import("@/lib/jobsSchedule");
    const { typedItem } = await import("@/lib/woIntake");
    const a = typedItem({ what: "Swap seal", equipment: "" }, []);
    const b = typedItem({ what: "Test run", equipment: "" }, [a]);
    const r = jobsSchedule([{ item: a, hours: 14 }, { item: b, hours: NaN }], "2027-03-01T06:00", { dayStart: "06:00", nightStart: "18:00", nights: true });
    expect(r.rows.map((x) => [x.name, x.plannedAt])).toEqual([["Swap seal", "2027-03-01 20:00"]]);
  });

  it("a typed-in job's schedule step is made, not imported, and is done once made", async () => {
    const { planningPath } = await import("@/lib/planningPath");
    const { typedItem } = await import("@/lib/woIntake");
    const items = [typedItem({ what: "Swap pump seal", equipment: "P-12" }, [])];
    const scope = { items, coming: [], source: { file: "Typed in", sheet: "", headers: [], map: {} }, imports: [], skipped: ["pkg" as const, "rfq" as const, "award" as const] };
    let p = planningPath(scope, { wos: [], steps: 0, awarded: 0 });
    expect([p.steps[p.next].ask, p.steps[p.next].state]).toEqual(["make the schedule", "Not made yet"]);
    p = planningPath(scope, { wos: [], steps: 2, awarded: 0 });
    expect(p.next).toBe(-1);
    expect(p.steps[2].state).toBe("On the Schedule tab");
  });
});
