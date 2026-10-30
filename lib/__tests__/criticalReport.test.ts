// The critical path on the turnover: what's on it leads Done and Next,
// what's near it or losing float says so, and work that needs the same
// crew at the same time as critical work says that — on the screen rows
// and in the email alike (both read lib/turnoverPlan).

import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { buildShiftReport, shiftWindow, type ShiftTimes } from "@/lib/shiftReport";
import { turnoverPlan, doneByTask, pathNote, competition } from "@/lib/turnoverPlan";
import { turnoverUpdate, forecastText } from "@/lib/managementUpdate";
import { toPlainText } from "@/lib/reportExport";
import type { Milestone } from "@/types/schema";

const LA = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-07:00`)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", shift: "both", ...p } as Milestone);
const f = { D: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(5, 10), DTs: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(5, 16), T: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(11, 16), win: () => "", hrs: (h: number) => `${h} h` };

const e17 = mk({ id: "e17", name: "E-17 Exchanger" });
const v7 = mk({ id: "v7", name: "V-7 Tower" });
const tonight = (id: string, parentId: string, crew: string, from: string, to: string) =>
  mk({ id, name: `Step ${id}`, parentId, responsibleParty: crew, plannedStartAt: at("2026-10-27", from), plannedAt: at(to < from ? "2026-10-28" : "2026-10-27", to) });
const done = (id: string, parentId: string) => mk({ id, name: `Step ${id}`, parentId, responsibleParty: "Schultz", status: "completed", percentComplete: 100, actualAt: at("2026-10-27", "10:00"), plannedStartAt: at("2026-10-27", "08:00"), plannedAt: at("2026-10-27", "10:00") });
const ms = [e17, v7,
  tonight("b", "e17", "Ancon", "18:30", "22:00"),   // same crew, same hours as critical a
  tonight("c", "e17", "Schultz", "19:00", "21:00"), // near critical, losing float
  tonight("a", "v7", "Ancon", "20:00", "23:30"),    // critical — planned last, listed first
  done("d2", "e17"), done("d1", "v7")];
const day = shiftWindow("2026-10-27", "day", LA, times);
const report = buildShiftReport({
  milestones: ms, tz: LA, times, shift: day, now: day.end, startPct: new Map(ms.map((m) => [m.id!, 0])),
  criticalIds: new Set(["a"]),
  path: { criticalThen: new Set(["a", "d1"]), near: new Set(["c"]), floatH: new Map([["c", 6], ["b", 30]]), floatThenH: new Map([["c", 14], ["b", 31]]) },
});
const plan = turnoverPlan(report, () => false);
const nextIds = plan.items.filter((x) => x.kind === "next").map((x) => x.r.leaf.id);

describe("the critical path on the turnover", () => {
  it("leads the next crew's list", () => {
    expect(nextIds[0]).toBe("a");
  });
  it("Done credits work that was on the path when the shift began - first", () => {
    const rows = doneByTask(report, plan, f);
    expect(rows.map((x) => x.key)).toEqual(["v7", "e17"]);
    expect(rows[0].critical).toBe(true);
    expect(rows[0].lines[0].critical).toBe(true);
    expect(rows[1].critical).toBe(false);
  });
  it("near critical, losing float - in words", () => {
    const c = plan.items.find((x) => x.r.leaf.id === "c")!.r;
    expect(pathNote(c, f.hrs)).toBe("near critical - float 14 h → 6 h this shift");
    const b = plan.items.find((x) => x.r.leaf.id === "b")!.r;
    expect(pathNote(b, f.hrs)).toBeNull();
  });
  it("the same crew wanted on critical work at the same time", () => {
    const comp = competition(report, plan.items.map((x) => x.r));
    expect(comp.get("b")?.crew).toBe("Ancon");
    expect(comp.get("b")?.critical.map((r) => r.leaf.id)).toEqual(["a"]);
    expect(comp.has("c")).toBe(false); // Schultz isn't on critical work
  });
  it("the email says the same", () => {
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(report, f, { pctOf: () => 0, finishOf: () => undefined, forecast: { finish: Date.parse(at("2026-11-01", "02:18")), slipH: 8.3 } }) });
    expect(text).toMatch(/Critical path/);
    expect(text).toMatch(/Near critical - float 14 h → 6 h this shift/);
    expect(text).toMatch(/Same crew as critical work \(Ancon\): Step a goes first/);
    expect(text).toMatch(/Step d1 · critical path/);
    expect(text).toMatch(/forecast finish 11-01 02:18 - 8\.3 h late/);
  });
  it("the forecast in words", () => {
    expect(forecastText({ finish: 0, slipH: 0.2 }, { D: () => "11-01", T: () => "02:18", hrs: f.hrs })).toBe("forecast finish 11-01 02:18, on plan");
    expect(forecastText({ finish: 0, slipH: -3 }, { D: () => "10-31", T: () => "15:00", hrs: f.hrs })).toBe("forecast finish 10-31 15:00 - 3 h early");
  });
});

import { carriedOpenWork } from "@/lib/openWork";
import { carryCutoff } from "@/lib/shiftReport";

describe("carried over - one rule for the report, the calendar and the day list", () => {
  const late = [e17, v7,
    mk({ id: "y", name: "Yesterday's", parentId: "e17", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "15:00"), status: "in_progress", percentComplete: 50 }),
    mk({ id: "m", name: "This morning's", parentId: "v7", plannedStartAt: at("2026-10-27", "07:00"), plannedAt: at("2026-10-27", "10:00") }),
    mk({ id: "p", name: "This afternoon's", parentId: "v7", plannedStartAt: at("2026-10-27", "12:00"), plannedAt: at("2026-10-27", "16:00") }),
    mk({ id: "ok", name: "Done", parentId: "v7", plannedStartAt: at("2026-10-27", "06:00"), plannedAt: at("2026-10-27", "08:00"), status: "completed", percentComplete: 100 })];
  const ids = (now: number) => {
    const r = buildShiftReport({ milestones: late, tz: LA, times, shift: day, now, criticalIds: new Set(["m"]) });
    return { report: r.review.carryOver.map((x) => x.leaf.id), calendar: carriedOpenWork(late, now, LA, times, new Set(["m"])).map((w) => w.leaf.id) };
  };
  it("mid-shift: what's due by now", () => {
    const x = ids(Date.parse(at("2026-10-27", "13:00")));
    expect(x.calendar).toEqual(["m", "y"]);           // critical first, then oldest due
    expect([...x.report].sort()).toEqual([...x.calendar].sort());
  });
  it("from the turnover meeting on: what's due by the shift's end", () => {
    const now = Date.parse(at("2026-10-27", "17:40"));
    expect(carryCutoff(day, now, times)).toBe(day.end);
    const x = ids(now);
    expect(x.calendar).toEqual(["m", "y", "p"]);
    expect([...x.report].sort()).toEqual([...x.calendar].sort());
  });
});
