import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * hintFor lives inside the worker bundle, so it is read as source and evaluated
 * here rather than imported — the worker itself cannot be loaded under Node.
 */
const src = readFileSync(
  join(__dirname, "..", "workers", "recon.worker.ts"), "utf8",
);
const body = src.slice(
  src.indexOf("function hintFor(message: string): string {"),
  src.indexOf("export {};"),
);
const hintFor = new Function(`${body.replace(/: string/g, "")}; return hintFor;`)() as
  (m: string) => string;

describe("advice attached to a failure", () => {
  // The user's real failure said matching was fine and growth stalled, and was
  // told to re-record with more overlap — advice that did not follow from it.
  it("does not blame the capture when matching was the bottleneck", () => {
    const hint = hintFor(
      "No image pairs could be verified. 30 frames, median 1800 features each; " +
      "292 pairs proposed, 0 verified; median 6 raw matches per pair. " +
      "Matches are the bottleneck: the frames are not sharing enough recognisable detail.",
    );
    expect(hint).toMatch(/blur|light|slower/i);
    expect(hint).not.toMatch(/revisit areas the others already covered/i);
  });

  it("names repeating texture when matches were plentiful but inconsistent", () => {
    const hint = hintFor(
      "No image pairs could be verified. Matches were plentiful but no consistent camera " +
      "motion fitted them, which usually means repeated texture.",
    );
    expect(hint).toMatch(/repeat/i);
  });

  it("talks about joining pieces when growth stalled", () => {
    const hint = hintFor(
      "None of the 4 starting pairs tried could be grown into a reconstruction. " +
      "Registration reached 2 frames before stalling.",
    );
    expect(hint).toMatch(/one space|continuous/i);
  });

  it("still recognises the older failures", () => {
    expect(hintFor("WebGPU adapter unavailable")).toMatch(/Chrome|Edge/);
    expect(hintFor("Could not decode: hevc unsupported")).toMatch(/Most Compatible/);
    expect(hintFor("No image pair had enough parallax")).toMatch(/Walk through/);
  });

  it("always says something actionable", () => {
    for (const m of ["something went wrong", "", "unknown failure"]) {
      expect(hintFor(m).length).toBeGreaterThan(20);
    }
  });

  it("says nothing when the user cancelled", () => {
    expect(hintFor("Reconstruction cancelled")).toBe("");
  });
});
