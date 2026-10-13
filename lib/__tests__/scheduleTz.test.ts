import { describe, it, expect } from "vitest";
import {
  wallClock, wallClockToMs, tzOffsetMs, dayKey, dayKeyToMs, startOfDay, addDays, dayDiff,
  dayOfWeek, startOfMonth, addMonths, hasTimeOfDay, clockLabel, toDateTimeInput, fromDateTimeInput,
  fromDateInput, naiveToIso, shiftWallClock, normalizeTimeZone, isValidTimeZone, tzAbbrev,
} from "@/lib/scheduleTz";

const CHI = "America/Chicago";

describe("scheduleTz basics", () => {
  it("validates and normalizes zones", () => {
    expect(isValidTimeZone(CHI)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(normalizeTimeZone(null)).toBe("UTC");
    expect(normalizeTimeZone("nope")).toBe("UTC");
    expect(normalizeTimeZone(CHI)).toBe(CHI);
  });

  it("reads the plant wall clock and offset", () => {
    const ms = Date.parse("2026-10-14T13:00:00Z"); // 8:00 CDT
    expect(wallClock(ms, CHI)).toEqual({ year: 2026, month: 10, day: 14, hour: 8, minute: 0, second: 0 });
    expect(tzOffsetMs(ms, CHI)).toBe(-5 * 3600_000);
    expect(wallClock(ms, "UTC").hour).toBe(13);
  });

  it("round-trips wall clock → instant → wall clock", () => {
    const w = { year: 2026, month: 10, day: 14, hour: 6, minute: 30, second: 0 };
    const ms = wallClockToMs(w, CHI);
    expect(new Date(ms).toISOString()).toBe("2026-10-14T11:30:00.000Z");
    expect(wallClock(ms, CHI)).toEqual(w);
  });

  it("handles the DST transitions correctly", () => {
    // Spring forward 2026-03-08 in Chicago: 02:00 → 03:00.
    const before = wallClockToMs({ year: 2026, month: 3, day: 8, hour: 1, minute: 0, second: 0 }, CHI);
    const after = wallClockToMs({ year: 2026, month: 3, day: 8, hour: 3, minute: 0, second: 0 }, CHI);
    expect((after - before) / 3600_000).toBe(1); // the 2:00 hour does not exist
    // Fall back 2026-11-01: the plant day is 25 hours long.
    const d0 = dayKeyToMs("2026-11-01", CHI), d1 = dayKeyToMs("2026-11-02", CHI);
    expect((d1 - d0) / 3600_000).toBe(25);
    expect(dayDiff(d0, d1, CHI)).toBe(1);
    expect(wallClock(addDays(d0, 1, CHI), CHI)).toMatchObject({ day: 2, hour: 0 });
  });
});

describe("day bucketing", () => {
  it("buckets an evening task on the plant's day, not the UTC day", () => {
    const sevenPm = Date.parse("2026-10-15T00:00:00Z"); // 19:00 CDT on Oct 14
    expect(dayKey(sevenPm, "UTC")).toBe("2026-10-15");
    expect(dayKey(sevenPm, CHI)).toBe("2026-10-14");
    expect(new Date(startOfDay(sevenPm, CHI)).toISOString()).toBe("2026-10-14T05:00:00.000Z");
    expect(dayOfWeek(sevenPm, CHI)).toBe(3); // Wednesday
  });

  it("navigates months in plant time", () => {
    const ms = Date.parse("2026-10-14T13:00:00Z");
    expect(new Date(startOfMonth(ms, CHI)).toISOString()).toBe("2026-10-01T05:00:00.000Z");
    expect(wallClock(addMonths(ms, 3, CHI), CHI)).toMatchObject({ year: 2027, month: 1, day: 1 });
    expect(wallClock(addMonths(ms, -10, CHI), CHI)).toMatchObject({ year: 2025, month: 12, day: 1 });
  });
});

describe("time-of-day labels", () => {
  it("knows which tasks carry a time", () => {
    const midnight = dayKeyToMs("2026-10-14", CHI);
    expect(hasTimeOfDay(midnight, CHI)).toBe(false);
    expect(clockLabel(midnight, CHI)).toBe("");
    const six = wallClockToMs({ year: 2026, month: 10, day: 14, hour: 6, minute: 5, second: 0 }, CHI);
    expect(clockLabel(six, CHI)).toBe("6:05");
    expect(hasTimeOfDay(six, "UTC")).toBe(true);
  });

  it("gives a short zone name", () => {
    expect(tzAbbrev(CHI, Date.parse("2026-07-01T12:00:00Z"))).toBe("CDT");
    expect(tzAbbrev(CHI, Date.parse("2026-01-01T12:00:00Z"))).toBe("CST");
    expect(tzAbbrev("UTC")).toBe("UTC");
  });
});

describe("form inputs", () => {
  it("round-trips datetime-local values in plant time", () => {
    const iso = fromDateTimeInput("2026-10-14T08:00", CHI);
    expect(iso).toBe("2026-10-14T13:00:00.000Z");
    expect(toDateTimeInput(iso, CHI)).toBe("2026-10-14T08:00");
    expect(toDateTimeInput(iso, "UTC")).toBe("2026-10-14T13:00");
    expect(fromDateTimeInput("", CHI)).toBeNull();
    expect(fromDateTimeInput("garbage", CHI)).toBeNull();
  });

  it("parses a date-only input at plant midnight or a chosen hour", () => {
    expect(fromDateInput("2026-10-14", CHI)).toBe("2026-10-14T05:00:00.000Z");
    expect(fromDateInput("2026-10-14", CHI, 12)).toBe("2026-10-14T17:00:00.000Z");
    expect(fromDateInput("2026-10-14", "UTC")).toBe("2026-10-14T00:00:00.000Z");
  });
});

describe("imports and zone changes", () => {
  it("reads naive schedule-file timestamps as plant time but keeps explicit offsets", () => {
    expect(naiveToIso("2026-08-15", CHI)).toBe("2026-08-15T05:00:00.000Z");
    expect(naiveToIso("2026-08-15 08:00", CHI)).toBe("2026-08-15T13:00:00.000Z");
    expect(naiveToIso("2026-08-15T08:00:00", CHI)).toBe("2026-08-15T13:00:00.000Z");
    expect(naiveToIso("2026-08-15T08:00:00Z", CHI)).toBe("2026-08-15T08:00:00.000Z");
    expect(naiveToIso("2026-08-15T08:00:00+02:00", CHI)).toBe("2026-08-15T06:00:00.000Z");
    expect(naiveToIso("2026-08-15 08:00", "UTC")).toBe("2026-08-15T08:00:00.000Z");
    expect(naiveToIso("not a date", CHI)).toBeNull();
  });

  it("re-anchors a schedule so the written times survive a zone change", () => {
    // Stored as 08:00 UTC under the old (UTC) convention; after the plant is
    // set to Chicago it must still read 08:00 at the plant.
    const moved = shiftWallClock("2026-08-15T08:00:00Z", "UTC", CHI);
    expect(moved).toBe("2026-08-15T13:00:00.000Z");
    expect(clockLabel(Date.parse(moved), CHI)).toBe("8:00");
    // And back.
    expect(shiftWallClock(moved, CHI, "UTC")).toBe("2026-08-15T08:00:00.000Z");
    // A no-op when the zone doesn't change.
    expect(shiftWallClock(moved, CHI, CHI)).toBe(moved);
  });
});
