// lib/__tests__/effectiveDate.test.ts
import { describe, it, expect } from "vitest";
import { effectiveStatusFor, daysUntilEffective } from "@/lib/effectiveDate";

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

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
