import { describe, it, expect } from "vitest";
import { effectiveStarts, effectiveSpans, byStart, spanLabel, barGeometry, xAt, hourStep } from "@/lib/scheduleTime";

const tz = "America/Los_Angeles";
const at = (s: string) => Date.parse(s); // with offset
const noWbs = () => 0;

describe("work in the order it happens", () => {
  it("a parent starts when its earliest step does, whatever its stored date", () => {
    const items = [
      { id: "p", parentId: null, plannedStartAt: "2026-10-22T00:00:00-07:00", plannedAt: "2026-10-25T00:00:00-07:00", name: "E-606" },
      { id: "a", parentId: "p", plannedStartAt: "2026-10-22T18:00:00-07:00", plannedAt: "2026-10-22T22:00:00-07:00", name: "Hydro" },
      { id: "b", parentId: "p", plannedStartAt: "2026-10-22T06:00:00-07:00", plannedAt: "2026-10-22T10:00:00-07:00", name: "Pull blinds" },
      { id: "q", parentId: null, plannedStartAt: "2026-10-22T01:00:00-07:00", plannedAt: "2026-10-23T00:00:00-07:00", name: "T-605" },
    ];
    const starts = effectiveStarts(items);
    expect(starts.get("p")).toBe(at("2026-10-22T06:00:00-07:00"));
    // …and finishes when its last step does.
    expect(effectiveSpans(items).get("p")!.finish).toBe(at("2026-10-22T22:00:00-07:00"));
    const kids = items.filter((x) => x.parentId === "p").sort(byStart(starts, noWbs)).map((x) => x.name);
    expect(kids).toEqual(["Pull blinds", "Hydro"]);
    // T-605 (stored 01:00) runs before E-606 (stored midnight, real start 06:00).
    expect(items.filter((x) => !x.parentId).sort(byStart(starts, noWbs)).map((x) => x.name)).toEqual(["T-605", "E-606"]);
  });
  it("dates as Date objects sort too (not only strings)", () => {
    const items = [
      { id: "x", plannedStartAt: new Date("2026-10-22T18:00:00Z"), plannedAt: new Date("2026-10-22T20:00:00Z"), name: "late" },
      { id: "y", plannedStartAt: new Date("2026-10-22T06:00:00Z"), plannedAt: new Date("2026-10-22T08:00:00Z"), name: "early" },
    ];
    expect(items.sort(byStart(effectiveStarts(items), noWbs)).map((x) => x.name)).toEqual(["early", "late"]);
  });
});

describe("start and finish times on every task", () => {
  it("same day, overnight, midnight end, date-only", () => {
    expect(spanLabel(at("2026-10-22T06:00:00-07:00"), at("2026-10-22T10:00:00-07:00"), tz)).toBe("Thu, Oct 22 6:00 AM → 10:00 AM");
    expect(spanLabel(at("2026-10-22T18:00:00-07:00"), at("2026-10-23T06:00:00-07:00"), tz)).toBe("Thu, Oct 22 6:00 PM → Fri 6:00 AM");
    expect(spanLabel(at("2026-10-22T18:00:00-07:00"), at("2026-10-23T00:00:00-07:00"), tz)).toBe("Thu, Oct 22 6:00 PM → 12:00 AM");
    expect(spanLabel(at("2026-10-22T00:00:00-07:00"), at("2026-10-24T00:00:00-07:00"), tz)).toBe("Oct 22 – Oct 24 · 3d");
  });
});

describe("bars sit at their clock times", () => {
  const d0 = at("2026-10-22T00:00:00-07:00");
  it("a 6:00–10:00 step and an 18:00–22:00 step no longer look the same", () => {
    const a = barGeometry(at("2026-10-22T06:00:00-07:00"), at("2026-10-22T10:00:00-07:00"), d0, 240, tz);
    const b = barGeometry(at("2026-10-22T18:00:00-07:00"), at("2026-10-22T22:00:00-07:00"), d0, 240, tz);
    expect(a.left).toBe(60);
    expect(b.left).toBe(180);
    expect(a.width).toBe(39);
  });
  it("date-only work still fills its days, inclusive", () => {
    const g = barGeometry(at("2026-10-23T00:00:00-07:00"), at("2026-10-24T00:00:00-07:00"), d0, 100, tz);
    expect(g).toEqual({ left: 100, width: 199 });
  });
  it("lines up with day ticks across a DST change", () => {
    const start = at("2026-10-31T00:00:00-07:00");
    expect(xAt(at("2026-11-02T06:00:00-08:00"), start, 24, tz)).toBe(2 * 24 + 6);
  });
  it("hour labels appear only when there's room", () => {
    expect(hourStep(60)).toBe(0);
    expect(hourStep(240)).toBe(6);
    expect(hourStep(960)).toBe(1);
  });
});
