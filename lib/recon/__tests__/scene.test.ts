// The point payload is written by scene.ts and read by lib/walkthrough/viewer.ts.
// They are in different modules with no shared decoder, so a change to one and
// not the other would silently distort every scene — hence this round-trip.

import { describe, expect, it } from "vitest";

import { encodePoints } from "../scene";
import { POINT_STRIDE } from "../types";

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
  const normals = new Float32Array(count * 3);
  const [minX, minY, minZ] = quant.min;
  const [spanX, spanY, spanZ] = quant.span;
  const sx = spanX / 65535;
  const sy = spanY / 65535;
  const sz = spanZ / 65535;
  for (let i = 0; i < count; i++) {
    const b = i * POINT_STRIDE;
    positions[i * 3] = (view.getInt16(b, true) + 32768) * sx + minX;
    positions[i * 3 + 1] = (view.getInt16(b + 2, true) + 32768) * sy + minY;
    positions[i * 3 + 2] = (view.getInt16(b + 4, true) + 32768) * sz + minZ;
    colors[i * 3] = bytes[b + 6];
    colors[i * 3 + 1] = bytes[b + 7];
    colors[i * 3 + 2] = bytes[b + 8];
    const nu = bytes[b + 9];
    const nv = bytes[b + 10];
    if (nu !== 128 || nv !== 128) {
      const n = decodeOctahedral(nu, nv);
      normals[i * 3] = n[0];
      normals[i * 3 + 1] = n[1];
      normals[i * 3 + 2] = n[2];
    }
  }
  return { positions, colors, normals };
}

/** Mirrors decodeOctahedral in lib/walkthrough/viewer.ts exactly. */
function decodeOctahedral(nu: number, nv: number): [number, number, number] {
  let x = (nu / 255) * 2 - 1;
  let y = (nv / 255) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const sx = x >= 0 ? 1 : -1;
    const sy = y >= 0 ? 1 : -1;
    const nx = (1 - Math.abs(y)) * sx;
    const ny = (1 - Math.abs(x)) * sy;
    x = nx; y = ny;
  }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
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
    expect(buffer.byteLength).toBe(count * POINT_STRIDE);

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

// Normals decide whether the viewer can draw a surface or only a dot, and the
// encoder and the viewer's decoder live in different modules with no shared
// code — the same trap the position round-trip above exists to catch.
describe("normal encoding", () => {
  it("round-trips unit normals to within two degrees over the whole sphere", () => {
    let seed = 987654321;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    const count = 4000;
    const xyz = new Float32Array(count * 3);
    const rgb = new Uint8Array(count * 3);
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Uniform on the sphere, so grazing and back-facing normals are covered
      // too — a surfel seen from behind still has to shade correctly.
      const z = rand() * 2 - 1;
      const t = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      normals[i * 3] = r * Math.cos(t);
      normals[i * 3 + 1] = r * Math.sin(t);
      normals[i * 3 + 2] = z;
      xyz[i * 3] = rand() * 10;
      xyz[i * 3 + 1] = rand() * 3;
      xyz[i * 3 + 2] = rand() * 10;
    }

    const { buffer, quantization } = encodePoints(xyz, rgb, count, normals);
    const decoded = decodeLikeViewer(buffer, count, quantization);

    let worstDeg = 0;
    for (let i = 0; i < count; i++) {
      const dot =
        normals[i * 3] * decoded.normals[i * 3] +
        normals[i * 3 + 1] * decoded.normals[i * 3 + 1] +
        normals[i * 3 + 2] * decoded.normals[i * 3 + 2];
      worstDeg = Math.max(worstDeg, (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI);
    }
    expect(worstDeg).toBeLessThan(2);
  });

  it("marks a missing normal so the viewer falls back to a round dot", () => {
    const count = 3;
    const { buffer, quantization } = encodePoints(
      new Float32Array(count * 3), new Uint8Array(count * 3), count,
    );
    const decoded = decodeLikeViewer(buffer, count, quantization);
    for (let i = 0; i < count * 3; i++) expect(decoded.normals[i]).toBe(0);
  });

  it("keeps a zero-length normal distinguishable from a real one", () => {
    const count = 2;
    const normals = new Float32Array([0, 0, 0, 0, 1, 0]);
    const { buffer, quantization } = encodePoints(
      new Float32Array(count * 3), new Uint8Array(count * 3), count, normals,
    );
    const d = decodeLikeViewer(buffer, count, quantization);
    expect(Math.hypot(d.normals[0], d.normals[1], d.normals[2])).toBe(0);
    expect(d.normals[4]).toBeCloseTo(1, 2);
  });

  it("survives normals that are not exactly unit length", () => {
    const normals = new Float32Array([0, 3.7, 0, -2.2, 0, 0]);
    const { buffer, quantization } = encodePoints(
      new Float32Array(6), new Uint8Array(6), 2, normals,
    );
    const d = decodeLikeViewer(buffer, 2, quantization);
    expect(d.normals[1]).toBeCloseTo(1, 2);
    expect(d.normals[3]).toBeCloseTo(-1, 2);
  });
});
