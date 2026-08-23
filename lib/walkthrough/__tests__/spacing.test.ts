import { describe, expect, it } from "vitest";
import { measureSpacing } from "../viewer";

/** Points on the walls, floor and ceiling of a box, spaced `step` apart. */
function boxSurface(step: number, sizeX = 8, sizeY = 3, sizeZ = 12) {
  const pts: number[] = [];
  const push = (x: number, y: number, z: number) => pts.push(x, y, z);
  for (let x = 0; x <= sizeX; x += step) {
    for (let z = 0; z <= sizeZ; z += step) { push(x, 0, z); push(x, sizeY, z); }
  }
  for (let x = 0; x <= sizeX; x += step) {
    for (let y = 0; y <= sizeY; y += step) { push(x, y, 0); push(x, y, sizeZ); }
  }
  for (let y = 0; y <= sizeY; y += step) {
    for (let z = 0; z <= sizeZ; z += step) { push(0, y, z); push(sizeX, y, z); }
  }
  return {
    positions: new Float32Array(pts),
    count: pts.length / 3,
    bounds: {
      min: [0, 0, 0] as [number, number, number],
      max: [sizeX, sizeY, sizeZ] as [number, number, number],
    },
  };
}

describe("measureSpacing", () => {
  it.each([0.05, 0.1, 0.2])("recovers a known %s m sample spacing", (step) => {
    const { positions, count, bounds } = boxSurface(step);
    const measured = measureSpacing(positions, count, bounds);
    // Grid occupancy is an estimator, not an exact count; within 2x is enough
    // to size splats sensibly, which is all it is used for.
    expect(measured).toBeGreaterThan(step / 2);
    expect(measured).toBeLessThan(step * 2);
  });

  it("scales with the scene rather than returning a fixed number", () => {
    const coarse = boxSurface(0.2);
    const fine = boxSurface(0.05);
    expect(measureSpacing(coarse.positions, coarse.count, coarse.bounds))
      .toBeGreaterThan(measureSpacing(fine.positions, fine.count, fine.bounds));
  });

  it("falls back rather than dividing by zero on a degenerate cloud", () => {
    const positions = new Float32Array(300); // every point at the origin
    const bounds = {
      min: [0, 0, 0] as [number, number, number],
      max: [0, 0, 0] as [number, number, number],
    };
    expect(measureSpacing(positions, 100, bounds)).toBeGreaterThan(0);
  });

  it("does not crash on a cloud too small to measure", () => {
    const { positions, bounds } = boxSurface(0.5);
    expect(measureSpacing(positions, 4, bounds)).toBeGreaterThan(0);
  });
});
