import { describe, expect, it } from "vitest";
import { judgeMotion, describeMotion, nextWindowSize } from "../captureHealth";

describe("judging how a capture was filmed", () => {
  const W = 1280;

  it("calls a steady walk healthy", () => {
    // Walking at ~1.4 m/s sampled at 3.2 fps moves the image a few percent of
    // its width between frames, depending on how close things are.
    for (const px of [40, 80, 150, 250]) {
      expect(judgeMotion(px, W)).toBe("healthy");
    }
  });

  it("spots a camera that barely travelled", () => {
    // Filming from one spot, or panning: plenty of frames, no baseline, and
    // nothing to triangulate. This looks like a capture problem but reads in
    // the numbers as an almost-static image.
    expect(judgeMotion(10, W)).toBe("too-still");
    expect(judgeMotion(0, W)).toBe("too-still");
  });

  it("spots a camera swung too fast to match", () => {
    expect(judgeMotion(400, W)).toBe("too-fast");
    expect(judgeMotion(900, W)).toBe("too-fast");
  });

  it("judges relative to frame width, not absolute pixels", () => {
    // 140px is a third of a 400px frame and a fourteenth of a 1920px one, and
    // they are not remotely the same capture.
    expect(judgeMotion(140, 400)).toBe("too-fast");
    expect(judgeMotion(140, 1920)).toBe("healthy");
    expect(judgeMotion(30, 400)).toBe("healthy");
    expect(judgeMotion(30, 1920)).toBe("too-still");
  });

  it("says nothing misleading when it has no measurement", () => {
    expect(judgeMotion(NaN, W)).toBe("healthy");
    expect(judgeMotion(50, 0)).toBe("healthy");
  });

  it("always produces a description", () => {
    for (const v of ["too-still", "healthy", "too-fast"] as const) {
      expect(describeMotion(v).length).toBeGreaterThan(10);
    }
  });
});

describe("adapting the sampling rate to measured motion", () => {
  const BUDGET = 0.08 * 1280; // 102px on a portrait phone frame

  it("collapses to keeping every decoded frame after one oversized hop", () => {
    // The real failure: 184px hops. One of those must be enough — waiting for
    // a trend means several unmatched pairs in a row.
    expect(nextWindowSize(2, 2, 184, BUDGET)).toBe(1);
  });

  it("stays dense while the camera keeps moving fast", () => {
    expect(nextWindowSize(1, 2, 150, BUDGET)).toBe(1);
  });

  it("relaxes back one step at a time once motion settles", () => {
    expect(nextWindowSize(1, 3, 20, BUDGET)).toBe(2);
    expect(nextWindowSize(2, 3, 20, BUDGET)).toBe(3);
  });

  it("never exceeds the time-based rate", () => {
    expect(nextWindowSize(3, 3, 5, BUDGET)).toBe(3);
  });

  it("holds steady in the healthy band", () => {
    // Neither oversized nor tiny: no reason to change anything.
    expect(nextWindowSize(2, 3, 60, BUDGET)).toBe(2);
  });

  it("does nothing without a measurement", () => {
    expect(nextWindowSize(2, 3, NaN, BUDGET)).toBe(2);
    expect(nextWindowSize(2, 3, 50, 0)).toBe(2);
  });
});
