// When work happened: a time put on the shift picked — or, a time that
// isn't on it, on the shift that time is on that day. "Sat day" + 22:00 is
// Sat night 22:00 (it used to be refused). Never later than now.

import { describe, it, expect } from "vitest";
import { clockForWork } from "@/components/projects/ShiftRecordParts";
import { shiftWindow } from "@/lib/shiftReport";

const LA = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-07:00`);
const now = at("2026-10-27", "17:30");
const satDay = shiftWindow("2026-10-24", "day", LA, times), satNight = shiftWindow("2026-10-24", "night", LA, times);

describe("the time work happened", () => {
  it("on the shift picked", () => {
    expect(clockForWork(satDay, "10:00", LA, times, now)).toMatchObject({ at: at("2026-10-24", "10:00"), moved: false });
    // A night runs past midnight: 03:00 is Sunday morning, still Sat night.
    expect(clockForWork(satNight, "03:00", LA, times, now)).toMatchObject({ at: at("2026-10-25", "03:00"), moved: false });
  });
  it("10 pm on Saturday, with Sat day picked: Sat night", () => {
    const r = clockForWork(satDay, "22:00", LA, times, now);
    expect(r).toMatchObject({ at: at("2026-10-24", "22:00"), moved: true });
    expect("shift" in r && r.shift.start).toBe(satNight.start);
  });
  it("10 am on Saturday, with Sat night picked: Sat day", () => {
    expect(clockForWork(satNight, "10:00", LA, times, now)).toMatchObject({ at: at("2026-10-24", "10:00"), moved: true });
  });
  it("not later than now, and a real 24-hour time", () => {
    expect(clockForWork(shiftWindow("2026-10-27", "day", LA, times), "17:45", LA, times, now)).toEqual({ error: "That time hasn't come yet." });
    expect(clockForWork(satDay, "25:00", LA, times, now)).toEqual({ error: "Type the time as 24-hour, like 14:30." });
  });
});
