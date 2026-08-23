import { describe, expect, it } from "vitest";

/**
 * The oriented-splat mask, extracted from POINT_FRAGMENT in viewer.ts.
 *
 * gl_PointCoord runs y DOWN from the top-left of the sprite; the minor-axis
 * direction is derived from view space, where y runs UP. The shader flips y to
 * reconcile them, and this reproduces that so the frames can be checked without
 * a GPU. `flipY: false` models the bug this test exists to catch.
 */
function insideSplat(
  pointCoord: [number, number],
  minorDir: [number, number],
  squash: number,
  flipY = true,
): boolean {
  const ox = (pointCoord[0] - 0.5) * 2;
  const oy = (flipY ? 0.5 - pointCoord[1] : pointCoord[1] - 0.5) * 2;
  const ex = ox * minorDir[0] + oy * minorDir[1];
  const ey = ox * -minorDir[1] + oy * minorDir[0];
  return (ex / squash) ** 2 + ey ** 2 <= 1;
}

/** Screen direction of a normal, as the vertex shader computes it. */
function minorDirOf(nx: number, ny: number): [number, number] {
  const len = Math.hypot(nx, ny) || 1;
  return [nx / len, ny / len];
}

describe("oriented splat footprint", () => {
  // A normal pointing up-and-right in view space squashes the ellipse along
  // that diagonal, so the splat is long across the OTHER diagonal.
  const diagonal = minorDirOf(1, 1);
  const squash = 0.35;

  it("is elongated across the normal, not along it", () => {
    // Up-right in screen terms is (x+, y-) in gl_PointCoord, which is y-down.
    const alongNormal: [number, number] = [0.5 + 0.32, 0.5 - 0.32];
    const acrossNormal: [number, number] = [0.5 + 0.32, 0.5 + 0.32];
    expect(insideSplat(alongNormal, diagonal, squash)).toBe(false);
    expect(insideSplat(acrossNormal, diagonal, squash)).toBe(true);
  });

  it("would be mirrored without the y flip — the bug this guards", () => {
    const acrossNormal: [number, number] = [0.5 + 0.32, 0.5 + 0.32];
    expect(insideSplat(acrossNormal, diagonal, squash, false))
      .not.toBe(insideSplat(acrossNormal, diagonal, squash, true));
  });

  it("is a plain circle when the surface faces the camera", () => {
    for (const dir of [minorDirOf(1, 0), minorDirOf(0, 1), minorDirOf(-1, 2)]) {
      // squash 1 means no foreshortening: the mask must not depend on the
      // direction at all, or a head-on wall would show oriented artefacts.
      expect(insideSplat([0.5 + 0.45, 0.5], dir, 1)).toBe(true);
      expect(insideSplat([0.5, 0.5 + 0.45], dir, 1)).toBe(true);
      expect(insideSplat([0.5 + 0.45, 0.5 + 0.45], dir, 1)).toBe(false);
    }
  });

  it("keeps the splat centre lit whatever the orientation", () => {
    for (const s of [0.3, 0.6, 1]) {
      for (const dir of [minorDirOf(1, 1), minorDirOf(-3, 1), minorDirOf(0, 1)]) {
        expect(insideSplat([0.5, 0.5], dir, s)).toBe(true);
      }
    }
  });

  it("never lights a fragment outside the sprite's inscribed circle", () => {
    // The ellipse has semi-axes squash and 1 in the rotated frame, so it can
    // never reach past radius 1 — anything beyond is outside the point sprite.
    const dir = minorDirOf(2, -1);
    for (const p of [[0, 0], [1, 0], [0, 1], [1, 1]] as Array<[number, number]>) {
      expect(insideSplat(p, dir, 0.9)).toBe(false);
    }
  });
});
