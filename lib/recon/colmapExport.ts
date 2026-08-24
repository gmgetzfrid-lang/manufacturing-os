// COLMAP-format export of a finished reconstruction.
//
// COLMAP's sparse text format is the lingua franca of photogrammetry: every
// Gaussian-splat trainer reads it, including the in-browser one this project
// integrates (Brush). The pipeline's own conventions match COLMAP's exactly —
// poses are world→camera with x_cam = R·X + t — so the export is a direct
// serialisation, not a conversion.
//
// Layout produced:
//   images/<name>.jpg          (written by the caller, referenced here by name)
//   sparse/0/cameras.txt       PINHOLE fx fy cx cy, one camera per frame size
//   sparse/0/images.txt        QW QX QY QZ TX TY TZ CAMERA_ID NAME
//   sparse/0/points3D.txt      initial cloud for splat seeding

import type { Pose } from "./math/twoView";

/** Row-major 3x3 rotation → COLMAP quaternion [w, x, y, z]. */
export function rotationToQuaternion(R: Float64Array): [number, number, number, number] {
  const m00 = R[0], m01 = R[1], m02 = R[2];
  const m10 = R[3], m11 = R[4], m12 = R[5];
  const m20 = R[6], m21 = R[7], m22 = R[8];
  const trace = m00 + m11 + m22;
  let w: number, x: number, y: number, z: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  const n = Math.hypot(w, x, y, z) || 1;
  // COLMAP normalises with a positive w by convention.
  const sign = w < 0 ? -1 : 1;
  return [(w / n) * sign, (x / n) * sign, (y / n) * sign, (z / n) * sign];
}

export interface ColmapCameraSpec {
  id: number;
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface ColmapImageSpec {
  id: number;
  pose: Pose;
  cameraId: number;
  /** File name (no directory) the image is stored under, e.g. "000012.jpg". */
  name: string;
}

export function camerasTxt(cameras: ColmapCameraSpec[]): string {
  const lines = [
    "# Camera list with one line of data per camera:",
    "#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]",
  ];
  for (const c of cameras) {
    lines.push(
      `${c.id} PINHOLE ${c.width} ${c.height} ${fmt(c.fx)} ${fmt(c.fy)} ${fmt(c.cx)} ${fmt(c.cy)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function imagesTxt(images: ColmapImageSpec[]): string {
  const lines = [
    "# Image list with two lines of data per image:",
    "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME",
    "#   POINTS2D[] as (X, Y, POINT3D_ID)",
  ];
  for (const img of images) {
    const [qw, qx, qy, qz] = rotationToQuaternion(img.pose.R);
    const [tx, ty, tz] = img.pose.t;
    lines.push(
      `${img.id} ${fmt(qw)} ${fmt(qx)} ${fmt(qy)} ${fmt(qz)} ` +
      `${fmt(tx)} ${fmt(ty)} ${fmt(tz)} ${img.cameraId} ${img.name}`,
    );
    // The observations line is required by the format even when empty.
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function points3dTxt(
  points: Array<{ xyz: [number, number, number]; rgb: [number, number, number] }>,
): string {
  const lines = [
    "# 3D point list with one line of data per point:",
    "#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)",
  ];
  points.forEach((p, i) => {
    const [x, y, z] = p.xyz;
    const r = clampByte(p.rgb[0]);
    const g = clampByte(p.rgb[1]);
    const b = clampByte(p.rgb[2]);
    lines.push(`${i + 1} ${fmt(x)} ${fmt(y)} ${fmt(z)} ${r} ${g} ${b} 1 `);
  });
  return `${lines.join("\n")}\n`;
}

function fmt(v: number): string {
  // Full float precision without exponent notation surprises for the parsers.
  return Number.isInteger(v) ? String(v) : v.toPrecision(12).replace(/0+$/, "").replace(/\.$/, "");
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// ── Store-only ZIP ──────────────────────────────────────────────────────────
//
// Enough of the ZIP format to hand the user one downloadable dataset file:
// local headers, central directory, end record, CRC-32. No compression — the
// bulk is JPEG, which recompresses to nothing anyway.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0x0800, true);       // UTF-8 names
    lv.setUint16(8, 0, true);            // store
    lv.setUint16(10, 0, true);           // mod time
    lv.setUint16(12, 0x2100, true);      // mod date (a fixed valid date)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x2100, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    localParts.push(local, entry.data);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((a, p) => a + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
