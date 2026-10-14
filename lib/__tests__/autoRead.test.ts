import { describe, it, expect } from "vitest";
import { readAutoRead, pagesLeft, withPagesUsed, DEFAULT_MONTHLY_PAGES } from "@/lib/estate/autoRead";

const now = new Date("2026-10-14T12:00:00Z");

describe("autoRead", () => {
  it("is off without a sponsor", () => {
    const a = readAutoRead({ autoRead: { on: true } }, now);
    expect(a.on).toBe(false);
    expect(pagesLeft(a)).toBe(0);
  });

  it("counts pages within the month and caps", () => {
    const f = { autoRead: { on: true, sponsor: "u1", monthlyPages: 10, month: "2026-10", used: 7 } };
    expect(pagesLeft(readAutoRead(f, now))).toBe(3);
    const after = withPagesUsed(f, 5, now);
    expect(pagesLeft(readAutoRead(after, now))).toBe(0);
  });

  it("starts a new month at zero", () => {
    const f = { autoRead: { on: true, sponsor: "u1", monthlyPages: 10, month: "2026-09", used: 10 } };
    expect(pagesLeft(readAutoRead(f, now))).toBe(10);
  });

  it("defaults a missing cap", () => {
    expect(readAutoRead({ autoRead: { on: true, sponsor: "u1" } }, now).monthlyPages).toBe(DEFAULT_MONTHLY_PAGES);
  });

  it("keeps the library's other features", () => {
    const after = withPagesUsed({ drawingIntel: true, autoRead: { on: true, sponsor: "u1" } }, 2, now);
    expect(after.drawingIntel).toBe(true);
  });
});
