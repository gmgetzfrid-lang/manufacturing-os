// lib/__tests__/effectiveDate.test.ts
import { describe, it, expect, afterEach } from "vitest";
import {
  effectiveStatusFor, daysUntilEffective, effectiveTodayISO, EFFECTIVE_DATE_TIME_ZONE,
  belongsToCurrentVersion,
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
  afterEach(() => { process.env.TZ = prevTz; });

  // The finding's scenario: a Houston (UTC-5 in August) publisher at 20:30
  // local on 21 Aug picks 22 Aug. UTC is already 01:30 on 22 Aug.
  const houstonEvening = new Date("2026-08-22T01:30:00Z");

  it("the effective-date calendar is a named constant (UTC until a facility zone exists)", () => {
    expect(EFFECTIVE_DATE_TIME_ZONE).toBe("UTC");
    expect(effectiveTodayISO(houstonEvening)).toBe("2026-08-22");
  });

  it("the badge and the watermark agree at the boundary instant: 22 Aug is already 'today', so the badge reads effective — no pending badge whose flip nobody announces", () => {
    // applyEffectiveDate suppresses iff eff <= effectiveTodayISO(); the badge
    // is 'pending' iff eff > effectiveTodayISO(). Same calendar → exactly one
    // of the two is true for every date.
    for (const d of ["2026-08-21", "2026-08-22", "2026-08-23"]) {
      const suppressed = d <= effectiveTodayISO(houstonEvening);
      const pending = effectiveStatusFor(d, houstonEvening) === "pending";
      expect(suppressed).toBe(!pending);
    }
    expect(effectiveStatusFor("2026-08-22", houstonEvening)).toBe("effective");
    expect(effectiveStatusFor("2026-08-23", houstonEvening)).toBe("pending");
    expect(daysUntilEffective("2026-08-23", houstonEvening)).toBe(1);
  });

  it("the answers do not move with the runner's TZ (America/Chicago, Asia/Tokyo, UTC)", () => {
    for (const tz of ["America/Chicago", "Asia/Tokyo", "UTC", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      expect(effectiveTodayISO(houstonEvening)).toBe("2026-08-22");
      expect(effectiveStatusFor("2026-08-22", houstonEvening)).toBe("effective");
      expect(effectiveStatusFor("2026-08-23", houstonEvening)).toBe("pending");
      expect(daysUntilEffective("2026-08-25", houstonEvening)).toBe(3);
      expect(daysUntilEffective("2026-08-20", houstonEvening)).toBe(-2);
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
