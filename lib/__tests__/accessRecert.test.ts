// lib/__tests__/accessRecert.test.ts
import { describe, it, expect } from "vitest";
import { computeNextRecertDate, recertStatusFor, daysUntilRecert, describeRecert } from "@/lib/accessRecert";

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("computeNextRecertDate", () => {
  it("adds the interval months to the basis date", () => {
    expect(computeNextRecertDate("2026-01-15T00:00:00Z", 6)).toBe("2026-07-15");
    expect(computeNextRecertDate("2026-01-15T00:00:00Z", 12)).toBe("2027-01-15");
  });
});

describe("recertStatusFor", () => {
  it("is 'none' with no date", () => {
    expect(recertStatusFor(null)).toBe("none");
  });
  it("is 'overdue' in the past, 'due_soon' within lead, 'current' beyond", () => {
    expect(recertStatusFor(iso(-1))).toBe("overdue");
    expect(recertStatusFor(iso(10))).toBe("due_soon");
    expect(recertStatusFor(iso(120))).toBe("current");
  });
});

describe("daysUntilRecert", () => {
  it("returns forward days / null", () => {
    expect(daysUntilRecert(null)).toBeNull();
    expect(daysUntilRecert(iso(5))).toBe(5);
  });
});

describe("describeRecert", () => {
  it("describes the cadence", () => {
    expect(describeRecert({ enabled: true, intervalMonths: 6 })).toBe("Recertify every 6 months");
    expect(describeRecert({ enabled: true, intervalMonths: 1 })).toBe("Recertify every 1 month");
    expect(describeRecert(null)).toBe("No recertification cadence");
    expect(describeRecert({ enabled: false })).toBe("No recertification cadence");
  });
});
