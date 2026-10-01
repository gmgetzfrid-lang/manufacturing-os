// lib/__tests__/effectiveDate.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  effectiveStatusFor, daysUntilEffective, effectiveTodayISO, effectiveDateTimeZone,
  EFFECTIVE_DATE_FALLBACK_TIME_ZONE, belongsToCurrentVersion,
} from "@/lib/effectiveDate";

// REV-9: fixtures are built in the SAME calendar the module decides in
// (effectiveTodayISO), never from a local-midnight Date — so the suite means
// the same thing on a runner in any zone.
const DAY = 86_400_000;
const iso = (offsetDays: number, now = new Date()) => effectiveTodayISO(new Date(now.getTime() + offsetDays * DAY));

describe("effectiveStatusFor", () => {
  it("is 'none' when no date is set", () => {
    expect(effectiveStatusFor(null)).toBe("none");
    expect(effectiveStatusFor(undefined)).toBe("none");
  });
  it("is 'pending' for a future date", () => {
    expect(effectiveStatusFor(iso(7))).toBe("pending");
  });
  it("is 'effective' for today or a past date", () => {
    expect(effectiveStatusFor(iso(0))).toBe("effective");
    expect(effectiveStatusFor(iso(-3))).toBe("effective");
  });
  it("is 'none' for an unparseable value", () => {
    expect(effectiveStatusFor("not-a-date")).toBe("none");
    expect(effectiveStatusFor("2026-02-30")).toBe("none");
  });
});

describe("daysUntilEffective", () => {
  it("returns null with no date", () => {
    expect(daysUntilEffective(null)).toBeNull();
  });
  it("counts forward days for a future date", () => {
    expect(daysUntilEffective(iso(5))).toBe(5);
  });
  it("is <= 0 once the date has arrived", () => {
    expect(daysUntilEffective(iso(0))).toBeLessThanOrEqual(0);
  });
});

describe("REV-9 — one definition of 'today' for the badge, the watermark, the scan and /api/verify", () => {
  const prevTz = process.env.TZ;
  const prevZone = process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
  beforeEach(() => { delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE; });
  afterEach(() => {
    process.env.TZ = prevTz;
    if (prevZone === undefined) delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
    else process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = prevZone;
  });

  // The finding's scenario: a Houston (UTC-5 in August) publisher at 20:30
  // local on 21 Aug picks 22 Aug (the day after the training). UTC is
  // already 01:30 on 22 Aug.
  const houstonEvening = new Date("2026-08-22T01:30:00Z");
  // The same publish, the next facility morning — the scan's run.
  const houstonNextMorning = new Date("2026-08-22T13:00:00Z");

  it("the calendar is the deployment's facility zone (NEXT_PUBLIC_FACILITY_TIME_ZONE), read at call time", () => {
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
    expect(effectiveDateTimeZone()).toBe("America/Chicago");
    expect(effectiveTodayISO(houstonEvening)).toBe("2026-08-21");
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "Asia/Tokyo";
    expect(effectiveTodayISO(houstonEvening)).toBe("2026-08-22");
  });

  it("the finding's Houston case, with the facility zone set: the badge stays pending that evening, the watermark is NOT pre-stamped, and the next morning the date is in force (the scan announces it)", () => {
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
    // applyEffectiveDate suppresses iff eff <= effectiveTodayISO().
    expect("2026-08-22" <= effectiveTodayISO(houstonEvening)).toBe(false);
    expect(effectiveStatusFor("2026-08-22", houstonEvening)).toBe("pending");
    expect(daysUntilEffective("2026-08-22", houstonEvening)).toBe(1);
    // the scan's .lte("effective_date", today) on the facility's 22 Aug
    expect("2026-08-22" <= effectiveTodayISO(houstonNextMorning)).toBe(true);
    expect(effectiveStatusFor("2026-08-22", houstonNextMorning)).toBe("effective");
  });

  it("unset, or not a zone Intl knows, the calendar falls back to UTC-12 — the LATEST calendar, never UTC: the reviewer's Houston evening keeps its badge pending and its announcement", () => {
    expect(effectiveDateTimeZone()).toBe(EFFECTIVE_DATE_FALLBACK_TIME_ZONE);
    expect(EFFECTIVE_DATE_FALLBACK_TIME_ZONE).toBe("Etc/GMT+12");
    expect(effectiveTodayISO(houstonEvening)).toBe("2026-08-21");
    // the finding's own scenario, with NO zone configured: pending that evening, not pre-stamped
    expect(effectiveStatusFor("2026-08-22", houstonEvening)).toBe("pending");
    expect("2026-08-22" <= effectiveTodayISO(houstonEvening)).toBe(false);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "Mars/Olympus_Mons";
    expect(effectiveDateTimeZone()).toBe("Etc/GMT+12");
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("with no zone named, a date is NEVER in force early in any facility's calendar (UTC-14 … UTC+14), at any instant — at worst it is late", () => {
    const zones = ["Pacific/Kiritimati", "Asia/Tokyo", "Europe/London", "UTC", "America/Chicago", "America/Los_Angeles", "Pacific/Honolulu", "Pacific/Pago_Pago"];
    const start = Date.parse("2026-08-20T00:00:00Z");
    for (let t = start; t < start + 3 * DAY; t += 30 * 60_000) {
      const now = new Date(t);
      const fallbackToday = effectiveTodayISO(now); // unset → UTC-12
      for (const zone of zones) {
        const facilityToday = effectiveTodayISO(now, zone);
        // "in force under the fallback" implies "in force at the facility"
        expect(fallbackToday <= facilityToday).toBe(true);
      }
    }
  });

  it("the badge and the watermark agree at every instant: exactly one of 'suppressed' and 'pending' holds for every date, in any facility zone", () => {
    for (const zone of [undefined, "America/Chicago", "Asia/Tokyo"]) {
      if (zone) process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = zone;
      else delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
      for (const d of ["2026-08-21", "2026-08-22", "2026-08-23"]) {
        const suppressed = d <= effectiveTodayISO(houstonEvening);
        const pending = effectiveStatusFor(d, houstonEvening) === "pending";
        expect(suppressed).toBe(!pending);
      }
    }
  });

  it("the answers do not move with the runner's TZ (America/Chicago, Asia/Tokyo, UTC) — only with the named facility zone", () => {
    for (const tz of ["America/Chicago", "Asia/Tokyo", "UTC", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
      expect(effectiveTodayISO(houstonEvening)).toBe("2026-08-21");
      expect(effectiveStatusFor("2026-08-21", houstonEvening)).toBe("effective");
      expect(effectiveStatusFor("2026-08-22", houstonEvening)).toBe("pending");
      expect(daysUntilEffective("2026-08-25", houstonEvening)).toBe(4);
      expect(daysUntilEffective("2026-08-20", houstonEvening)).toBe(-1);
      process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
      expect(effectiveTodayISO(houstonEvening)).toBe("2026-08-21");
      expect(effectiveStatusFor("2026-08-22", houstonEvening)).toBe("pending");
    }
  });

  it("the module no longer reads the local clock's midnight or parses a bare datetime", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/lib/effectiveDate.ts`, "utf8").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/setHours\(0,\s*0,\s*0,\s*0\)/);
    expect(src).not.toMatch(/T00:00:00`/);
    // the scan and the watermark both route through the one helper
    expect(src).toMatch(/const todayISO = \(\) => effectiveTodayISO\(\);/);
    expect(src).toMatch(/const suppress = !eff \|\| eff <= todayISO\(\);/);
    expect(src).toMatch(/\.lte\("effective_date", todayISO\(\)\)/);
    // the literal reference Next inlines into the browser bundle
    expect(src).toMatch(/process\.env\.NEXT_PUBLIC_FACILITY_TIME_ZONE/);
  });
});

describe("REV-13 — the scan announces only a date the CURRENT version carries", () => {
  const dates = new Map<string, string | null>([["v-cur", "2026-12-01"], ["v-revert", null]]);
  it("announces when the document's date is its current version's", () => {
    expect(belongsToCurrentVersion("2026-12-01", "v-cur", dates)).toBe(true);
  });
  it("never announces a withdrawn revision's date left on the document (a revert to a version with no date)", () => {
    expect(belongsToCurrentVersion("2026-12-01", "v-revert", dates)).toBe(false);
  });
  it("never announces when the current version is unknown or missing", () => {
    expect(belongsToCurrentVersion("2026-12-01", null, dates)).toBe(false);
    expect(belongsToCurrentVersion("2026-12-01", "v-gone", dates)).toBe(false);
    expect(belongsToCurrentVersion(null, "v-cur", dates)).toBe(false);
  });
});
