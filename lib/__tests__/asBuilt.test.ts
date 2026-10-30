// Work shows where it actually happened (the plan untouched), and each
// shift's report carries only the comments said for it.

import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { asBuilt, builtSpan } from "@/lib/asBuilt";
import { notesForShift, shiftWindow, type ShiftTimes } from "@/lib/shiftReport";
import { whenChoices } from "@/components/projects/ProgressControl";
import type { Milestone, MilestoneNote } from "@/types/schema";

const LA = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-07:00`)).toISOString();
const t = (d: string, hm: string) => Date.parse(at(d, hm));
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

// E-14: four steps planned Thursday; three done Tuesday afternoon.
const e14 = mk({ id: "e14", name: "E-14 Naphtha Cooler", plannedStartAt: at("2026-10-29", "06:00"), plannedAt: at("2026-10-29", "16:00") });
const step = (n: number, done?: string) => mk({
  id: `s${n}`, name: `Step ${n}`, parentId: "e14", responsibleParty: "Schultz",
  plannedStartAt: at("2026-10-29", `${String(5 + n * 2).padStart(2, "0")}:00`), plannedAt: at("2026-10-29", `${String(7 + n * 2).padStart(2, "0")}:00`),
  ...(done ? { status: "completed", percentComplete: 100, actualAt: at("2026-10-27", done), actualStartAt: at("2026-10-27", done) } : {}),
});
const ms = [e14, step(1, "14:00"), step(2, "15:10"), step(3, "16:20"), step(4)];
const kids = new Map([["e14", ms.slice(1)]]);

describe("as built", () => {
  const b = asBuilt(ms, kids, LA, times);
  it("a step done ahead of plan sits when it was done - on that shift", () => {
    expect(builtSpan(ms[1])).toMatchObject({ kind: "done", ahead: true, start: t("2026-10-27", "14:00"), finish: t("2026-10-27", "14:00") });
    expect([...b.bands(ms[1]).day]).toEqual(["2026-10-27"]);
    expect(b.bands(ms[1]).night.size).toBe(0);
  });
  it("a step not done yet stays where it's planned", () => {
    expect(builtSpan(ms[4]).kind).toBe("planned");
    expect([...b.bands(ms[4]).day]).toEqual(["2026-10-29"]);
  });
  it("the task spans from the day it was worked to the day its last step is due", () => {
    const row = b.row(e14);
    expect(Date.parse(String(row.plannedStartAt))).toBe(t("2026-10-27", "14:00"));
    expect(Date.parse(String(row.plannedAt))).toBe(t("2026-10-29", "15:00"));
    expect(e14.plannedStartAt).toBe(at("2026-10-29", "06:00")); // the plan isn't touched
  });
  it("started ahead: from its start to its planned finish", () => {
    const s = mk({ id: "x", name: "x", status: "in_progress", percentComplete: 20, actualStartAt: at("2026-10-27", "09:00"), plannedStartAt: at("2026-10-29", "06:00"), plannedAt: at("2026-10-29", "10:00") });
    expect(builtSpan(s)).toMatchObject({ kind: "started", ahead: true, start: t("2026-10-27", "09:00"), finish: t("2026-10-29", "10:00") });
  });
  it("done late, marked done straight off: from its planned start to when it was done", () => {
    const s = mk({ id: "y", name: "y", status: "completed", percentComplete: 100, actualAt: at("2026-10-27", "14:00"), actualStartAt: at("2026-10-27", "14:00"), plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "10:00") });
    expect(builtSpan(s)).toMatchObject({ kind: "done", ahead: false, start: t("2026-10-26", "06:00"), finish: t("2026-10-27", "14:00") });
  });
  it("started late stays on its plan (the carry-over list has it)", () => {
    const s = mk({ id: "z", name: "z", status: "in_progress", actualStartAt: at("2026-10-27", "09:00"), plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "10:00") });
    expect(builtSpan(s).kind).toBe("planned");
  });
});

describe("when it happened: the shift to put the time on", () => {
  const now = t("2026-10-27", "17:30");
  it("a card on this shift: this shift", () => {
    const own = { w: shiftWindow("2026-10-27", "day", LA, times), label: "Tue day" };
    expect(whenChoices(own, { tz: LA, times }, now)).toMatchObject({ idx: 0, ahead: false });
  });
  it("a card further on (Thursday): this shift, and it says the card is ahead", () => {
    const own = { w: shiftWindow("2026-10-29", "day", LA, times), label: "Thu day" };
    const r = whenChoices(own, { tz: LA, times }, now);
    expect(r).toMatchObject({ idx: 0, ahead: true });
    expect(r.choices.map((c) => c.label)).toEqual(["This shift", "Mon night", "Mon day"]);
  });
  it("an older card: its own shift, in time order", () => {
    const own = { w: shiftWindow("2026-10-25", "night", LA, times), label: "Sun night" };
    const r = whenChoices(own, { tz: LA, times }, now);
    expect(r.choices.map((c) => c.label)).toEqual(["This shift", "Mon night", "Mon day", "Sun night"]);
    expect(r.idx).toBe(3);
  });
});

describe("each shift's report: only the comments said for it", () => {
  const day = shiftWindow("2026-10-27", "day", LA, times);
  const night = shiftWindow("2026-10-27", "night", LA, times);
  const n = (id: string, body: string, created: string, happened?: string, kind: MilestoneNote["kind"] = "note"): MilestoneNote =>
    ({ id: body, orgId: "o", milestoneId: id, kind, body, createdAt: created, createdBy: "u", createdByName: "G", happenedAt: happened ?? null });
  const notes = [
    n("a", "yesterday's", at("2026-10-26", "14:00")),
    n("a", "said at 14:00", at("2026-10-27", "14:00")),
    n("b", "typed at the meeting", at("2026-10-27", "18:20")),
    n("c", "punched for 16:30, typed at night", at("2026-10-27", "22:00"), at("2026-10-27", "16:30")),
    n("d", "night's own", at("2026-10-27", "23:00")),
    n("a", "trays heavier fouled", at("2026-10-27", "15:00"), undefined, "behind"),
    n("e", "Progress → 45%", at("2026-10-27", "15:00")),
  ];
  it("day shift: its own, the meeting's, and one punched for it - not yesterday's", () => {
    const r = notesForShift(notes, day, 3_600_000);
    expect(r.note.get("a")?.body).toBe("said at 14:00");
    expect(r.note.get("b")?.body).toBe("typed at the meeting");
    expect(r.note.get("c")?.body).toBe("punched for 16:30, typed at night");
    expect(r.note.has("d")).toBe(false);
    expect(r.note.has("e")).toBe(false);
    expect(r.why.get("a")?.body).toBe("trays heavier fouled");
  });
  it("night shift: only its own - nothing trails over from the day", () => {
    const r = notesForShift(notes, night, 3_600_000);
    expect([...r.note.keys()]).toEqual(["d"]);
    expect(r.why.size).toBe(0);
  });
});
