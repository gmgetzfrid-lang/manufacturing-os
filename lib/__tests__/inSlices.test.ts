import { describe, it, expect } from "vitest";
import { inSlices } from "@/lib/inSlices";

describe("inSlices", () => {
  it("covers every item once, in slice order, never more than `concurrency` at a time", async () => {
    let live = 0, peak = 0;
    const items = Array.from({ length: 1050 }, (_, i) => i);
    const out = await inSlices(items, 100, 4, async (s) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return s;
    });
    expect(out.flat()).toEqual(items);
    expect(out).toHaveLength(11);
    expect(peak).toBeLessThanOrEqual(4);
    expect(await inSlices([], 100, 4, async (s) => s)).toEqual([]);
  });
});
