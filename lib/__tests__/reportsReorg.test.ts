// The project reorganised (Plan · Today · Work · Reports): the project type
// and the word the app says for it, one name per report, the work orders
// the Work tab and the Work order report share, and the update as it goes
// out from Today's Email / Print and from Reports alike.

import { describe, it, expect, beforeEach } from "vitest";
import { projectTypeOf, cleanProjectType, typeWord, unitsDown, projectTypeSet, PROJECT_TYPES, DEFAULT_PROJECT_TYPE } from "@/lib/projectType";
import { REPORTS, reportName } from "@/lib/reportLinks";
import { groupWorkOrders, showsOrder, findOrders, fieldOrdersOf } from "@/lib/workOrderGroups";
import { sectionsOff, updateToSend, updatePrintDocument, offKey, onKey } from "@/lib/updatePrint";
import { impactLine } from "@/lib/discovery";
import { discoverySub } from "@/lib/managementUpdate";
import { projectFacts, safetyBrief } from "@/lib/safetyTalk";
import { setupChecklist, toDo } from "@/lib/scheduleSetup";
import type { ExportDoc } from "@/lib/reportExport";
import type { Milestone } from "@/types/schema";

const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone => ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

describe("project type", () => {
  it("this project stays a turnaround: read from its name until it's set", () => {
    expect(projectTypeOf(undefined, "October 2026 Transmix-1 Turnaround")).toEqual({ word: "Turnaround", short: "TA" });
    expect(projectTypeOf(null, "Unit 300 TA 2027").word).toBe("Turnaround");
    expect(projectTypeOf(null, "Spring 2027 outage").word).toBe("Outage");
    expect(projectTypeOf(null, "Crude unit S/D").word).toBe("Shutdown");
  });
  it("\"ta\" in lower case is a word, not a turnaround", () => {
    expect(projectTypeOf(null, "Pump data cleanup")).toEqual(DEFAULT_PROJECT_TYPE);
  });
  it("set in Setup, it wins over the name", () => {
    expect(projectTypeOf({ word: "Capital project", short: "Project" }, "Transmix-1 Turnaround").word).toBe("Capital project");
    expect(projectTypeSet({ word: "Outage", short: "Outage" })).toBe(true);
    expect(projectTypeSet(undefined)).toBe(false);
  });
  it("its own word: tidied, no em dash, a short form at least the word", () => {
    expect(cleanProjectType({ word: "  Tie—in  ", short: "" })).toEqual({ word: "Tie-in", short: "Tie-in" });
    expect(cleanProjectType({ word: "   " })).toBeNull();
    expect(cleanProjectType("Turnaround")).toBeNull();
  });
  it("in a sentence: lower case, a word in capitals as it is", () => {
    expect(typeWord(PROJECT_TYPES[0])).toBe("turnaround");
    expect(typeWord({ word: "Capital project", short: "Project" })).toBe("capital project");
    expect(typeWord({ word: "LRU swap", short: "LRU" })).toBe("LRU swap");
  });
  it("live units around the work: turnaround, outage, shutdown, not a capital project", () => {
    expect(PROJECT_TYPES.filter(unitsDown).map((t) => t.word)).toEqual(["Turnaround", "Outage", "Shutdown"]);
  });
  it("the offered kinds", () => {
    expect(PROJECT_TYPES.map((t) => t.word)).toEqual(["Turnaround", "Outage", "Shutdown", "Capital project", "Maintenance", "Construction"]);
  });
  it("Setup lists it first, never as something to do", () => {
    const items = setupChecklist({ timezoneSet: true, shiftTimesSaved: true, criticalChosen: true, hasBaseline: true, nightDecided: true, typeSet: false });
    expect(items[0]).toMatchObject({ id: "type", label: "Project type", done: false, extra: true });
    expect(toDo(items)).toEqual([]);
  });
});

describe("the word replaces \"turnaround\"", () => {
  const impact = { hours: 3, taskFinish: [0, 23 * 3_600_000] as [number, number], finish: [0, 0] as [number, number], critical: false } as Parameters<typeof impactLine>[0];
  const hrs = (h: number) => `${h} h`;
  it("a found work's impact: \"outage finish unchanged\"", () => {
    expect(impactLine(impact, hrs, "outage")).toBe("3 h of work · task finish +23 h · outage finish unchanged");
    // Unchanged for anything not told otherwise.
    expect(impactLine(impact, hrs)).toBe("3 h of work · task finish +23 h · turnaround finish unchanged");
  });
  it("the report's line on what was added", () => {
    const ds = { shift: { count: 1, hours: 4, finishH: 2, critical: 0 }, job: { count: 3, hours: 10, finishH: 2 } } as Parameters<typeof discoverySub>[0];
    expect(discoverySub(ds, hrs, "capital project")).toContain("capital project +2 h");
  });
  it("the safety topic's kicker: the kind of project", () => {
    const shift = { start: Date.UTC(2026, 9, 28, 13), kind: "day" as const, dayKey: "2026-10-28" };
    const base = { names: ["October 2026 Transmix-1 Turnaround"], start: Date.UTC(2026, 9, 24), finish: Date.UTC(2026, 10, 4), tz: "America/Los_Angeles" };
    const ta = safetyBrief([], shift, { project: projectFacts(base, shift, []) });
    expect(ta[0].kicker).toMatch(/^Turnaround/);
    const outage = safetyBrief([], shift, { project: projectFacts({ ...base, type: { word: "Outage", short: "Outage" } }, shift, []) });
    expect(outage[0].kicker).toMatch(/^Outage/);
    const capital = projectFacts({ ...base, type: { word: "Capital project", short: "Project" } }, shift, []);
    expect(capital.turnaround).toBe(false);
    expect(safetyBrief([], shift, { project: capital })[0].kicker).toMatch(/^Capital project/);
  });
});

describe("one name per report", () => {
  it("the reports, then the forms", () => {
    expect(REPORTS.filter((r) => !r.form).map((r) => r.name)).toEqual(["Shift turnover", "Hourly log", "Time log", "Schedule report", "Work order report", "Kick-off", "Close-out"]);
    expect(REPORTS.filter((r) => r.form).map((r) => r.name)).toEqual(["Field tracker"]);
    expect(new Set(REPORTS.map((r) => r.name)).size).toBe(REPORTS.length);
    expect(reportName("hourly")).toBe("Hourly log");
  });
  it("no em dash in what the list says", () => {
    for (const r of REPORTS) expect(`${r.name} ${r.sub}`).not.toMatch(/[—–]/);
  });
});

describe("work orders: the Work tab and the report read the same", () => {
  const tz = "America/Los_Angeles", times = { dayStart: "05:30", nightStart: "17:30" };
  const H = 3_600_000, t0 = Date.UTC(2026, 9, 27, 14);
  const iso = (t: number) => new Date(t).toISOString();
  const e12 = mk({ id: "e12", name: "E-12", workOrderRef: "301582" });
  const pull = mk({ id: "p", name: "Pull bundle", parentId: "e12", responsibleParty: "Schultz", status: "completed", plannedStartAt: iso(t0), plannedAt: iso(t0 + 4 * H), actualStartAt: iso(t0), actualAt: iso(t0 + 3 * H), percentComplete: 100 });
  const hydro = mk({ id: "h", name: "Hydro", parentId: "e12", responsibleParty: "Schultz", plannedStartAt: iso(t0 + 5 * H), plannedAt: iso(t0 + 9 * H) });
  const v7 = mk({ id: "v7", name: "V-7", workOrderRef: "301235" });
  const tray = mk({ id: "t", name: "Remove trays", parentId: "v7", responsibleParty: "Ancon", status: "on_hold", plannedStartAt: iso(t0 + H), plannedAt: iso(t0 + 30 * H) });
  const all = [e12, pull, hydro, v7, tray];
  const kids = new Map<string, Milestone[]>([["e12", [pull, hydro]], ["v7", [tray]]]);
  const orders = groupWorkOrders(all, kids, undefined, tz, times, t0 + 6 * H);
  it("each step under its work order, earliest first", () => {
    expect(orders.map((o) => o.wo)).toEqual(["301582", "301235"]);
    expect(orders[0].steps.map((s) => s.id)).toEqual(["p", "h"]);
    expect(orders[0]).toMatchObject({ done: 1, crews: ["Schultz"], standing: "in_progress" });
    expect(orders[1].standing).toBe("held");
  });
  it("the filters and the search", () => {
    expect(orders.filter((o) => showsOrder(o, "held")).map((o) => o.wo)).toEqual(["301235"]);
    expect(orders.filter((o) => showsOrder(o, "open")).length).toBe(2);
    expect(findOrders(orders, "hydro").map((o) => o.wo)).toEqual(["301582"]);
    expect(findOrders(orders, "ancon trays").map((o) => o.wo)).toEqual(["301235"]);
  });
  it("the field tracker's work orders: steps, resource and plan only", () => {
    const f = fieldOrdersOf(orders);
    expect(f[0]).toMatchObject({ wo: "301582", name: "E-12", crews: ["Schultz"] });
    expect(f[0].steps.map((s) => s.name)).toEqual(["Pull bundle", "Hydro"]);
    expect(Object.keys(f[0].steps[0]).sort()).toEqual(["crew", "id", "name", "planFinish", "planStart"]);
  });
});

describe("the update as it goes out", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  });
  const doc: ExportDoc = {
    kind: "Shift turnover", project: "Transmix-1", when: "Day shift Fri, Oct 30 → Night shift Fri, Oct 30", asOf: "", sections: [
      { id: "stand", title: "Where we stand", blocks: [] },
      { id: "done", title: "Done", blocks: [] },
      { id: "held", title: "Held", flag: "rose", blocks: [] },
      { id: "safety", title: "Safety focus", offByDefault: true, blocks: [] },
    ],
  } as unknown as ExportDoc;
  it("what was left out last time stays out; flagged and Where we stand always go", () => {
    store.set(offKey("turnover"), JSON.stringify(["done", "held", "stand"]));
    expect([...sectionsOff(doc, "turnover")].sort()).toEqual(["done", "safety"]);
    expect(updateToSend(doc, "turnover").sections.map((s) => s.id)).toEqual(["stand", "held"]);
  });
  it("a section off by default goes when it was ticked", () => {
    store.set(onKey("turnover"), JSON.stringify(["safety"]));
    expect(updateToSend(doc, "turnover").sections.map((s) => s.id)).toEqual(["stand", "done", "held", "safety"]);
  });
  it("printed: safety on a page of its own at the end, no letterhead", () => {
    store.set(onKey("turnover"), JSON.stringify(["safety"]));
    const html = updatePrintDocument(updateToSend(doc, "turnover"), null);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("break-before:page");
    expect(html).toContain("<title>Transmix-1 - Shift turnover - Night shift Fri, Oct 30</title>");
  });
});
