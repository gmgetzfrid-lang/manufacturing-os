// lib/__tests__/scheduleLinks.test.ts
import { describe, it, expect } from "vitest";
import {
  normalizeLinks, serializeLinks, linkCode, requiredStartMs, type DependencyLink,
} from "@/lib/scheduleLinks";

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);

describe("normalizeLinks", () => {
  it("maps the legacy FS-only array to FS+0 links", () => {
    expect(normalizeLinks(["a", "b"], undefined)).toEqual([
      { predId: "a", type: "FS", lagDays: 0 },
      { predId: "b", type: "FS", lagDays: 0 },
    ]);
  });

  it("prefers the rich links column when present", () => {
    const rich: DependencyLink[] = [{ predId: "a", type: "SS", lagDays: 2 }];
    expect(normalizeLinks(["x"], rich)).toEqual(rich);
  });

  it("reads snake_case + coerces bad types/lags", () => {
    const raw = [{ pred_id: "a", type: "BOGUS", lag_days: "3" }];
    expect(normalizeLinks(null, raw)).toEqual([{ predId: "a", type: "FS", lagDays: 3 }]);
  });

  it("dedupes by predecessor (last wins) and drops self-links", () => {
    const raw: DependencyLink[] = [
      { predId: "a", type: "FS", lagDays: 0 },
      { predId: "a", type: "SS", lagDays: 1 },
      { predId: "self", type: "FS", lagDays: 0 },
    ];
    expect(normalizeLinks(null, raw, "self")).toEqual([{ predId: "a", type: "SS", lagDays: 1 }]);
  });

  it("returns [] for empty inputs", () => {
    expect(normalizeLinks(null, null)).toEqual([]);
    expect(normalizeLinks([], [])).toEqual([]);
  });
});

describe("serializeLinks", () => {
  it("dual-writes the rich array and the legacy id list", () => {
    const links: DependencyLink[] = [
      { predId: "a", type: "SS", lagDays: 1 },
      { predId: "b", type: "FS", lagDays: 0 },
    ];
    const out = serializeLinks(links);
    expect(out.dependsOn).toEqual(["a", "b"]);
    expect(out.dependencyLinks).toEqual(links);
  });
});

describe("linkCode", () => {
  it("formats type + lead/lag MS-Project style", () => {
    expect(linkCode({ type: "FS", lagDays: 0 })).toBe("FS");
    expect(linkCode({ type: "FS", lagDays: 2 })).toBe("FS+2");
    expect(linkCode({ type: "SS", lagDays: -1 })).toBe("SS-1");
  });
});

describe("requiredStartMs", () => {
  // predecessor occupies Jan10..Jan20; successor currently a 4-day span.
  const predStart = ms("2026-01-10");
  const predFinish = ms("2026-01-20");
  const succStart = ms("2026-01-01");
  const succFinish = ms("2026-01-05"); // 4-day span (ms)

  it("FS+0 = day after the predecessor finishes", () => {
    expect(requiredStartMs({ type: "FS", lagDays: 0 }, predStart, predFinish, succStart, succFinish))
      .toBe(predFinish + DAY);
  });
  it("FS+2 leaves a 2-day gap", () => {
    expect(requiredStartMs({ type: "FS", lagDays: 2 }, predStart, predFinish, succStart, succFinish))
      .toBe(predFinish + 3 * DAY);
  });
  it("SS+0 starts with the predecessor", () => {
    expect(requiredStartMs({ type: "SS", lagDays: 0 }, predStart, predFinish, succStart, succFinish))
      .toBe(predStart);
  });
  it("FF+0 finishes when the predecessor finishes (start backs off by the span)", () => {
    const span = succFinish - succStart;
    expect(requiredStartMs({ type: "FF", lagDays: 0 }, predStart, predFinish, succStart, succFinish))
      .toBe(predFinish - span);
  });
});
