import { describe, expect, it } from "vitest";

/**
 * The gate that decides whether a reconstruction is a scene at all.
 *
 * Extracted as a predicate so it can be tested without a browser. It must match
 * the condition in recon.worker.ts — a reconstruction that placed a handful of
 * frames produces a couple of camera-shaped cones of points, and rendering that
 * as a walkable space is a failure presented as a result.
 */
function isPresentable(
  registered: number, used: number, components: number[],
): boolean {
  const fraction = used > 0 ? registered / used : 0;
  const biggest = components.reduce((m, c) => Math.max(m, c), 0);
  return fraction >= 0.35 && biggest >= 8;
}

describe("refusing to present a failed reconstruction", () => {
  it("rejects the shape the user was shown: a few frames out of many", () => {
    // Two or three registered frames means two or three depth-map frustums,
    // which is what "clusters of coloured circles" actually is.
    expect(isPresentable(2, 40, [2])).toBe(false);
    expect(isPresentable(3, 30, [3])).toBe(false);
  });

  it("rejects a run whose frames scattered into tiny disconnected groups", () => {
    expect(isPresentable(18, 40, [4, 4, 3, 3, 2, 2])).toBe(false);
  });

  it("accepts a reconstruction that genuinely covers the capture", () => {
    expect(isPresentable(86, 89, [86])).toBe(true);
    expect(isPresentable(40, 44, [40])).toBe(true);
  });

  it("accepts a partial but substantial reconstruction", () => {
    // Half a capture is disappointing but is still a room, and the report says
    // so — refusing here would throw away a usable result.
    expect(isPresentable(22, 44, [22])).toBe(true);
  });

  it("rejects a large fraction that is nonetheless too few frames", () => {
    // A very short capture where almost everything registered, but there is
    // simply not enough of it to be a space.
    expect(isPresentable(5, 6, [5])).toBe(false);
  });

  it("never divides by zero on an empty capture", () => {
    expect(isPresentable(0, 0, [])).toBe(false);
  });
});
