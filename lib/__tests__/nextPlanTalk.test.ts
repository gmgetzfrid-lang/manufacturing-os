import { describe, it, expect } from "vitest";
import { parseTalkReply } from "@/lib/nextPlanTalk";
import { cleanChange, cleanNextPlanSettings } from "@/lib/nextPlanStore";

const known = { orders: new Set(["wo:v7", "wo:e13"]), acts: new Set(["a1", "a2"]), crews: new Set(["Schultz", "Ancon"]) };
const shiftsOfDay = (d: number, k: "day" | "night") => (d - 1) * 2 + (k === "night" ? 1 : 0);

describe("Tell the schedule: the reply, checked", () => {
  it("keeps changes that name what's there, drops the rest", () => {
    const r = parseTalkReply({ understood: "V-7 first", changes: [{ kind: "first", order: "wo:v7" }, { kind: "asap", order: "wo:nope" }, { kind: "hours", actId: "a2", hours: 6 }, { kind: "explode" }] }, known, "V-7 is critical", shiftsOfDay);
    expect(r.changes.map((c) => c.kind)).toEqual(["first", "hours"]);
    expect(r.dropped).toBe(2);
    expect(r.changes[0].said).toBe("V-7 is critical");
  });
  it("hands over a span of days and shifts become one change per shift", () => {
    const r = parseTalkReply({ changes: [{ kind: "heads", crew: "Ancon", day: "3-4", shift: "both", n: 10 }] }, known, "Ancon 2 crews", shiftsOfDay);
    expect(r.changes.map((c) => (c as { shift: number }).shift)).toEqual([4, 5, 6, 7]);
  });
  it("a question is passed on, not guessed", () => {
    expect(parseTalkReply({ question: "There are three E-22s. Which unit?" , changes: [] }, known, "E-22 first", shiftsOfDay).question).toMatch(/three E-22s/);
  });
});

describe("kept changes and staffing plans", () => {
  it("cleans what's saved", () => {
    expect(cleanChange({ kind: "hold", target: { order: "x" }, day: 3 })).toMatchObject({ kind: "hold", day: 3 });
    expect(cleanChange({ kind: "hold", target: {}, day: 3 })).toBeNull();
    expect(cleanChange({ kind: "split", actId: "a", fraction: 1.4, name: "x" })).toBeNull();
    const s = cleanNextPlanSettings({ nextPlan: { ph1: [{ kind: "asap", target: { ids: ["a1"] } }, { kind: "bad" }] }, staffingPlans: { Schultz: { file: "p.xlsx", shifts: { "2026-10-26:day": { direct: 14, indirect: 6 }, junk: { direct: 1 } } } } });
    expect(s.changes.ph1).toHaveLength(1);
    expect(s.staffing.Schultz.shifts).toEqual({ "2026-10-26:day": { direct: 14, indirect: 6 } });
  });
});
