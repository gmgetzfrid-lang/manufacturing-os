// The COLMAP export is consumed by external tools that fail cryptically on
// malformed input, so each piece is pinned here: the quaternion must round-trip
// the rotation, the text files must match the documented column layout, and
// the zip must be a byte-valid archive (verified against Python's zipfile
// when available — an independent implementation, not our own reader).

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildZip, camerasTxt, crc32, imagesTxt, points3dTxt, rotationToQuaternion,
} from "../colmapExport";
import { rodrigues } from "../math/linalg";

function quatToRotation(q: [number, number, number, number]): Float64Array {
  const [w, x, y, z] = q;
  return new Float64Array([
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ]);
}

describe("rotation → COLMAP quaternion", () => {
  it("round-trips arbitrary rotations", () => {
    for (const axis of [[1, 0, 0], [0, 1, 0], [0.3, -0.8, 0.52], [-1, 1, -1]] as const) {
      for (const angle of [0.01, 0.7, 1.9, 3.0]) {
        const n = Math.hypot(...axis);
        const R = rodrigues([axis[0] / n * angle, axis[1] / n * angle, axis[2] / n * angle]);
        const q = rotationToQuaternion(R);
        const back = quatToRotation(q);
        for (let i = 0; i < 9; i++) expect(back[i]).toBeCloseTo(R[i], 9);
        expect(q[0]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("handles the identity", () => {
    const q = rotationToQuaternion(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    expect(q[0]).toBeCloseTo(1, 12);
    expect(Math.hypot(q[1], q[2], q[3])).toBeCloseTo(0, 12);
  });
});

describe("COLMAP text files", () => {
  it("writes PINHOLE cameras with four params", () => {
    const txt = camerasTxt([{ id: 1, width: 1280, height: 720, fx: 1536, fy: 1536, cx: 640, cy: 360 }]);
    const data = txt.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(data).toHaveLength(1);
    const cols = data[0].split(" ");
    expect(cols[1]).toBe("PINHOLE");
    expect(cols).toHaveLength(8);
  });

  it("writes images with a pose line and an (empty) observations line", () => {
    const txt = imagesTxt([{
      id: 7,
      pose: { R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0.5, -1, 2] },
      cameraId: 1,
      name: "000007.jpg",
    }]);
    const lines = txt.split("\n").filter((l) => !l.startsWith("#"));
    const cols = lines[0].split(" ");
    expect(cols).toHaveLength(10);
    expect(cols[0]).toBe("7");
    expect(cols[9]).toBe("000007.jpg");
    expect(Number(cols[1])).toBeCloseTo(1, 9);
    expect(Number(cols[5])).toBeCloseTo(0.5, 9);
    // The observations line exists and is empty.
    expect(lines[1]).toBe("");
  });

  it("writes points with ids, colours and an error column", () => {
    const txt = points3dTxt([
      { xyz: [1, 2, 3], rgb: [255.7, -3, 128] },
    ]);
    const line = txt.split("\n").filter((l) => l && !l.startsWith("#"))[0];
    const cols = line.trim().split(" ");
    expect(cols.slice(0, 8)).toEqual(["1", "1", "2", "3", "255", "0", "128", "1"]);
  });
});

describe("zip container", () => {
  it("matches the reference CRC-32 implementation", () => {
    // "123456789" → 0xCBF43926 is the canonical CRC-32 check value.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("is readable by an independent zip implementation", () => {
    const zip = buildZip([
      { path: "sparse/0/cameras.txt", data: new TextEncoder().encode("hello\n") },
      { path: "images/000001.jpg", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const python = spawnSync("python3", ["--version"]);
    if (python.error || python.status !== 0) {
      // No python here; the CRC check above still guards the payload.
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "colmapzip-"));
    const zipPath = join(dir, "t.zip");
    writeFileSync(zipPath, zip);
    const check = spawnSync("python3", ["-c", [
      "import zipfile,sys",
      `z=zipfile.ZipFile(${JSON.stringify(zipPath)})`,
      "bad=z.testzip()",
      "assert bad is None, bad",
      "names=sorted(z.namelist())",
      "assert names==['images/000001.jpg','sparse/0/cameras.txt'], names",
      "assert z.read('sparse/0/cameras.txt')==b'hello\\n'",
      "print('ok')",
    ].join("\n")]);
    expect(check.stderr.toString()).toBe("");
    expect(check.stdout.toString().trim()).toBe("ok");
  });
});
