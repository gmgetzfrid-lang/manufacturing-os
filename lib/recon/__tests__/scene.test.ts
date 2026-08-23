// The point payload is written by scene.ts and read by lib/walkthrough/viewer.ts.
// They are in different modules with no shared decoder, so a change to one and
// not the other would silently distort every scene — hence this round-trip.

import { describe, expect, it } from "vitest";

import { encodePoints } from "../scene";

/** Mirrors the decode loop in lib/walkthrough/viewer.ts exactly. */
function decodeLikeViewer(
  buffer: ArrayBuffer,
  count: number,
  quant: { min: [number, number, number]; span: [number, number, number] },
) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const [minX, minY, minZ] = quant.min;
  const [spanX, spanY, spanZ] = quant.span;
  const sx = spanX / 65535;
  const sy = spanY / 65535;
  const sz = spanZ / 65535;
  for (let i = 0; i < count; i++) {
    const b = i * 10;
    positions[i * 3] = (view.getInt16(b, true) + 32768) * sx + minX;
    positions[i * 3 + 1] = (view.getInt16(b + 2, true) + 32768) * sy + minY;
    positions[i * 3 + 2] = (view.getInt16(b + 4, true) + 32768) * sz + minZ;
    colors[i * 3] = bytes[b + 6];
    colors[i * 3 + 1] = bytes[b + 7];
    colors[i * 3 + 2] = bytes[b + 8];
  }
  return { positions, colors };
}

describe("encodePoints", () => {
  it("round-trips positions to sub-millimetre accuracy over a room-sized scene", () => {
    let seed = 12345;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    const count = 5000;
    const xyz = new Float32Array(count * 3);
    const rgb = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      // A 20 x 3 x 20 metre volume — larger than the target room.
      xyz[i * 3] = (rand() - 0.5) * 20;
      xyz[i * 3 + 1] = rand() * 3;
      xyz[i * 3 + 2] = (rand() - 0.5) * 20;
      rgb[i * 3] = (rand() * 256) | 0;
      rgb[i * 3 + 1] = (rand() * 256) | 0;
      rgb[i * 3 + 2] = (rand() * 256) | 0;
    }

    const { buffer, quantization } = encodePoints(xyz, rgb, count);
    expect(buffer.byteLength).toBe(count * 10);

    const decoded = decodeLikeViewer(buffer, count, quantization);

    let worst = 0;
    for (let i = 0; i < count * 3; i++) {
      worst = Math.max(worst, Math.abs(decoded.positions[i] - xyz[i]));
    }
    // int16 over 20 m is ~0.3 mm; allow a touch for float32 rounding.
    expect(worst).toBeLessThan(0.001);

    for (let i = 0; i < count * 3; i++) {
      expect(decoded.colors[i]).toBe(rgb[i]);
    }
  });

  it("handles a degenerate single-point cloud without producing NaN", () => {
    const xyz = new Float32Array([1.5, 2.5, -3.5]);
    const rgb = new Uint8Array([10, 20, 30]);
    const { buffer, quantization } = encodePoints(xyz, rgb, 1);
    const decoded = decodeLikeViewer(buffer, 1, quantization);
    for (let i = 0; i < 3; i++) {
      expect(Number.isFinite(decoded.positions[i])).toBe(true);
      expect(decoded.positions[i]).toBeCloseTo(xyz[i], 3);
    }
  });

  it("keeps every point inside the reported bounds", () => {
    const count = 500;
    const xyz = new Float32Array(count * 3);
    const rgb = new Uint8Array(count * 3);
    for (let i = 0; i < count * 3; i++) xyz[i] = Math.sin(i) * 7;
    const { buffer, quantization } = encodePoints(xyz, rgb, count);
    const decoded = decodeLikeViewer(buffer, count, quantization);
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) {
        const v = decoded.positions[i * 3 + a];
        expect(v).toBeGreaterThanOrEqual(quantization.min[a] - 1e-3);
        expect(v).toBeLessThanOrEqual(quantization.min[a] + quantization.span[a] + 1e-3);
      }
    }
  });
});
