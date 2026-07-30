"use client";

// PointCloudViewer — streams a Cloud-Optimized Point Cloud (COPC) from R2
// straight into WebGL. No plugin, no Autodesk cloud: the file's embedded
// octree lets us fetch ONLY the points the current view needs (HTTP range
// requests against a presigned URL), so a multi-billion-point plant scan
// opens in seconds at coarse detail and sharpens as you fly around.
//
// LOD strategy: breadth-first walk of the COPC octree; a node is wanted
// when its cube projects larger than a pixel threshold on screen, subject
// to a global point budget (near nodes win). Wanted-but-missing nodes load
// with limited concurrency; no-longer-wanted nodes are disposed. Each
// node's raw attributes are kept so recoloring (RGB / intensity /
// elevation) never refetches.

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Copc, Getter, Hierarchy } from "copc";
import { LazPerf } from "laz-perf";
import { Loader2, RefreshCw, Maximize2 } from "lucide-react";

type ColorMode = "auto" | "rgb" | "intensity" | "elevation";

interface NodeRecord {
  key: string;
  points: THREE.Points;
  raw: { rgb: Float32Array | null; intensity: Float32Array | null; z: Float32Array; count: number };
  pointCount: number;
}

const MIN_NODE_PIXELS = 110;   // refine a node once its cube looks bigger than this
const LOAD_CONCURRENCY = 4;

let lazPerfPromise: Promise<LazPerf> | null = null;
function getLazPerf(): Promise<LazPerf> {
  if (!lazPerfPromise) {
    lazPerfPromise = LazPerf.create({
      locateFile: (f: string) => `/${f}`, // served from public/laz-perf.wasm
    } as unknown as Parameters<typeof LazPerf.create>[0]) as Promise<LazPerf>;
  }
  return lazPerfPromise;
}

function parseKey(key: string): [number, number, number, number] {
  const [d, x, y, z] = key.split("-").map(Number);
  return [d, x, y, z];
}

/** Elevation ramp (deep blue → teal → yellow) — readable on dark and light. */
function elevationColor(t: number): [number, number, number] {
  const c = new THREE.Color();
  c.setHSL(0.66 - 0.5 * Math.min(Math.max(t, 0), 1), 0.85, 0.35 + 0.3 * t);
  return [c.r, c.g, c.b];
}

// ── Direct LAS / PTS sampling (no conversion required) ──────────────────
// Plain .las is seekable (fixed-size records after a fixed header) and .pts
// is line-oriented text — both allow RANGED sampling: fetch evenly spread
// runs of the file until the point budget is met. No octree, so no
// camera-driven refinement — but a uniform few-million-point sample of a
// unit reads clearly, and it means "export from ReCap → upload → see it".

interface SampledBatch {
  positions: Float32Array; // relative to the first batch's center
  rgb: Float32Array | null;
  intensity: Float32Array | null;
  z: Float32Array;
  count: number;
}

async function fetchRange(url: string, begin: number, end: number): Promise<{ bytes: Uint8Array; total: number | null }> {
  const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
  if (!(res.status === 206 || res.status === 200)) throw new Error(`Range request failed (HTTP ${res.status})`);
  const cr = res.headers.get("Content-Range");
  const total = cr?.includes("/") ? Number(cr.split("/")[1]) : null;
  return { bytes: new Uint8Array(await res.arrayBuffer()), total: Number.isFinite(total) ? total : null };
}

const LAS_RGB_OFFSET: Record<number, number> = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

async function* loadLasSampled(url: string, budget: number): AsyncGenerator<{ batch: SampledBatch; center: [number, number, number]; span: number; zRange: [number, number]; total: number }> {
  const { bytes: head } = await fetchRange(url, 0, 375);
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head[0] !== 0x4c || head[1] !== 0x41 || head[2] !== 0x53 || head[3] !== 0x46) {
    throw new Error("Not a LAS file (bad magic).");
  }
  const versionMinor = dv.getUint8(25);
  const pointOffset = dv.getUint32(96, true);
  const fmt = dv.getUint8(104) & 0x3f;
  const recLen = dv.getUint16(105, true);
  const legacyCount = dv.getUint32(107, true);
  const count = versionMinor >= 4 ? Number(dv.getBigUint64(247, true)) || legacyCount : legacyCount;
  if (!count || !recLen) throw new Error("LAS header has no points.");
  if (dv.getUint8(104) & 0x80) throw new Error("This is a compressed LAZ, not LAS — use the converter (or upload .copc.laz).");
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const maxX = dv.getFloat64(179, true), minX = dv.getFloat64(187, true);
  const maxY = dv.getFloat64(195, true), minY = dv.getFloat64(203, true);
  const maxZ = dv.getFloat64(211, true), minZ = dv.getFloat64(219, true);
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const zRange: [number, number] = [minZ, maxZ];
  const rgbOff = LAS_RGB_OFFSET[fmt];

  const RUN_POINTS = 65536;
  const runs = Math.max(1, Math.min(Math.ceil(budget / RUN_POINTS), Math.ceil(count / RUN_POINTS)));
  for (let r = 0; r < runs; r++) {
    const startPoint = runs === 1 ? 0 : Math.floor((r * (count - RUN_POINTS)) / (runs - 1));
    const n = Math.min(RUN_POINTS, count - startPoint);
    if (n <= 0) continue;
    const begin = pointOffset + startPoint * recLen;
    const { bytes } = await fetchRange(url, begin, begin + n * recLen);
    const pdv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const m = Math.min(n, Math.floor(bytes.byteLength / recLen));
    const positions = new Float32Array(m * 3);
    const z = new Float32Array(m);
    let rgb: Float32Array | null = rgbOff !== undefined ? new Float32Array(m * 3) : null;
    const intensity = new Float32Array(m);
    let rgbMax = 0, intensityMax = 0;
    for (let i = 0; i < m; i++) {
      const p = i * recLen;
      const X = pdv.getInt32(p, true) * sx + ox;
      const Y = pdv.getInt32(p + 4, true) * sy + oy;
      const Z = pdv.getInt32(p + 8, true) * sz + oz;
      positions[i * 3] = X - center[0];
      positions[i * 3 + 1] = Y - center[1];
      positions[i * 3 + 2] = Z - center[2];
      z[i] = Z;
      const it = pdv.getUint16(p + 12, true);
      intensity[i] = it; if (it > intensityMax) intensityMax = it;
      if (rgb && rgbOff !== undefined) {
        const cr = pdv.getUint16(p + rgbOff, true), cg = pdv.getUint16(p + rgbOff + 2, true), cb = pdv.getUint16(p + rgbOff + 4, true);
        rgb[i * 3] = cr; rgb[i * 3 + 1] = cg; rgb[i * 3 + 2] = cb;
        if (cr > rgbMax) rgbMax = cr; if (cg > rgbMax) rgbMax = cg; if (cb > rgbMax) rgbMax = cb;
      }
    }
    if (rgb) {
      if (rgbMax === 0) rgb = null;
      else { const s = rgbMax > 255 ? 65535 : 255; for (let i = 0; i < rgb.length; i++) rgb[i] /= s; }
    }
    const inten = intensityMax > 0 ? intensity : null;
    if (inten) for (let i = 0; i < m; i++) inten[i] /= intensityMax;
    yield { batch: { positions, rgb, intensity: inten, z, count: m }, center, span, zRange, total: count };
  }
}

async function* loadPtsSampled(url: string, budget: number): AsyncGenerator<{ batch: SampledBatch; center: [number, number, number]; span: number; zRange: [number, number]; total: number }> {
  // Learn the file size from the first range, then sample evenly spread
  // text windows, discarding the partial line at each window edge.
  const WINDOW = 1_500_000; // ~1.5 MB of text ≈ 30-40k points
  const first = await fetchRange(url, 0, WINDOW);
  const total = first.total ?? first.bytes.byteLength;
  const est = Math.ceil(budget / 30000);
  const windows = Math.max(1, Math.min(est, Math.ceil(total / WINDOW)));
  const decoder = new TextDecoder();

  let center: [number, number, number] | null = null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let emitted = 0;

  for (let w = 0; w < windows && emitted < budget; w++) {
    const begin = windows === 1 ? 0 : Math.floor((w * (total - WINDOW)) / (windows - 1));
    const bytes = w === 0 ? first.bytes : (await fetchRange(url, Math.max(begin, 0), Math.min(begin + WINDOW, total))).bytes;
    const text = decoder.decode(bytes);
    const lines = text.split("\n");
    // Drop partial edge lines (except the file start).
    const rows = lines.slice(begin === 0 ? 0 : 1, -1);
    const px: number[] = [], py: number[] = [], pz: number[] = [], pi: number[] = [], pr: number[] = [], pg: number[] = [], pb: number[] = [];
    for (const line of rows) {
      const c = line.trim().split(/\s+/);
      if (c.length < 3) continue;
      const x = Number(c[0]), y = Number(c[1]), zz = Number(c[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zz)) continue; // header/count line
      px.push(x); py.push(y); pz.push(zz);
      if (c.length >= 7) { pi.push(Number(c[3])); pr.push(Number(c[4])); pg.push(Number(c[5])); pb.push(Number(c[6])); }
      else if (c.length === 6) { pr.push(Number(c[3])); pg.push(Number(c[4])); pb.push(Number(c[5])); }
      else if (c.length >= 4) { pi.push(Number(c[3])); }
    }
    const m = px.length;
    if (!m) continue;
    for (let i = 0; i < m; i++) {
      if (px[i] < minX) minX = px[i]; if (px[i] > maxX) maxX = px[i];
      if (py[i] < minY) minY = py[i]; if (py[i] > maxY) maxY = py[i];
      if (pz[i] < minZ) minZ = pz[i]; if (pz[i] > maxZ) maxZ = pz[i];
    }
    if (!center) center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    const positions = new Float32Array(m * 3);
    const z = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      positions[i * 3] = px[i] - center[0];
      positions[i * 3 + 1] = py[i] - center[1];
      positions[i * 3 + 2] = pz[i] - center[2];
      z[i] = pz[i];
    }
    let rgb: Float32Array | null = null;
    if (pr.length === m) {
      rgb = new Float32Array(m * 3);
      let mx = 0;
      for (let i = 0; i < m; i++) { if (pr[i] > mx) mx = pr[i]; if (pg[i] > mx) mx = pg[i]; if (pb[i] > mx) mx = pb[i]; }
      const s = mx > 255 ? 65535 : 255;
      for (let i = 0; i < m; i++) { rgb[i * 3] = pr[i] / s; rgb[i * 3 + 1] = pg[i] / s; rgb[i * 3 + 2] = pb[i] / s; }
    }
    let intensity: Float32Array | null = null;
    if (pi.length === m) {
      intensity = new Float32Array(m);
      let lo = Infinity, hi = -Infinity;
      for (const v of pi) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const spanI = Math.max(hi - lo, 1e-6);
      for (let i = 0; i < m; i++) intensity[i] = (pi[i] - lo) / spanI;
    }
    emitted += m;
    yield {
      batch: { positions, rgb, intensity, z, count: m },
      center,
      span: Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1,
      zRange: [minZ, maxZ],
      total: 0,
    };
  }
}

export default function PointCloudViewer({ url, kind = "copc", height = 560 }: {
  /** Presigned GET URL for the render object (must support Range). */
  url: string;
  /** copc = octree streaming; las/pts = ranged uniform sampling. */
  kind?: "copc" | "las" | "pts";
  height?: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"boot" | "ready" | "error">("boot");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ points: 0, nodes: 0, total: 0 });
  const [colorMode, setColorMode] = useState<ColorMode>("auto");
  const [budget, setBudget] = useState(2_500_000);

  // Live handles the effect exposes to the small control handlers.
  const apiRef = useRef<{
    refresh?: () => void;
    recolor?: (m: ColorMode) => void;
    setBudget?: (n: number) => void;
    home?: () => void;
  }>({});

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let alive = true;
    let disposed = false;

    // three.js scaffolding
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.up.set(0, 0, 1); // scans are Z-up
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    const group = new THREE.Group();
    scene.add(group);

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // COPC state
    const loaded = new Map<string, NodeRecord>();
    const loadedPages = new Set<string>();
    let nodes: Hierarchy.Node.Map = {};
    let pages: Hierarchy.Page.Map = {};
    let copcMeta: Copc | null = null;
    let lazPerf: LazPerf | null = null;
    let cubeMin: [number, number, number] = [0, 0, 0];
    let cubeSpan = 1;
    let cubeCenter: [number, number, number] = [0, 0, 0];
    let zRange: [number, number] = [0, 1];
    let currentColorMode: ColorMode = colorMode;
    let currentBudget = budget;
    let selecting = false;
    let selectAgain = false;

    const getter: Getter = async (begin, end) => {
      const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
      if (!(res.status === 206 || res.status === 200)) throw new Error(`Range request failed (HTTP ${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    };

    const nodeBox = (key: string) => {
      const [d, x, y, z] = parseKey(key);
      const edge = cubeSpan / Math.pow(2, d);
      return {
        edge,
        center: new THREE.Vector3(
          cubeMin[0] + edge * (x + 0.5) - cubeCenter[0],
          cubeMin[1] + edge * (y + 0.5) - cubeCenter[1],
          cubeMin[2] + edge * (z + 0.5) - cubeCenter[2],
        ),
      };
    };

    const colorsFor = (raw: NodeRecord["raw"], mode: ColorMode): Float32Array => {
      const n = raw.count;
      const out = new Float32Array(n * 3);
      const useRgb = (mode === "rgb" || mode === "auto") && raw.rgb;
      const useIntensity = !useRgb && (mode === "intensity" || mode === "auto") && raw.intensity;
      if (useRgb && raw.rgb) {
        out.set(raw.rgb);
      } else if (useIntensity && raw.intensity) {
        for (let i = 0; i < n; i++) {
          const v = 0.15 + 0.85 * raw.intensity[i];
          out[i * 3] = v; out[i * 3 + 1] = v; out[i * 3 + 2] = v;
        }
      } else {
        const [z0, z1] = zRange;
        const span = Math.max(z1 - z0, 1e-6);
        for (let i = 0; i < n; i++) {
          const [r, g, b] = elevationColor((raw.z[i] - z0) / span);
          out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
        }
      }
      return out;
    };

    const loadNode = async (key: string, node: Hierarchy.Node) => {
      if (!copcMeta || !lazPerf) return;
      const view = await Copc.loadPointDataView(getter, copcMeta, node, { lazPerf });
      if (!alive) return;
      const n = view.pointCount;
      const getX = view.getter("X"), getY = view.getter("Y"), getZ = view.getter("Z");
      let getR: ((i: number) => number) | null = null;
      let getG: ((i: number) => number) | null = null;
      let getB: ((i: number) => number) | null = null;
      let getI: ((i: number) => number) | null = null;
      try { getR = view.getter("Red"); getG = view.getter("Green"); getB = view.getter("Blue"); } catch { /* no RGB dims */ }
      try { getI = view.getter("Intensity"); } catch { /* no intensity dim */ }

      const positions = new Float32Array(n * 3);
      const z = new Float32Array(n);
      let rgb: Float32Array | null = getR && getG && getB ? new Float32Array(n * 3) : null;
      const intensityRaw = getI ? new Float32Array(n) : null;
      let rgbMax = 0;
      let intensityMax = 0;
      for (let i = 0; i < n; i++) {
        const px = getX(i), py = getY(i), pz = getZ(i);
        positions[i * 3] = px - cubeCenter[0];
        positions[i * 3 + 1] = py - cubeCenter[1];
        positions[i * 3 + 2] = pz - cubeCenter[2];
        z[i] = pz;
        if (rgb && getR && getG && getB) {
          const r = getR(i), g = getG(i), b = getB(i);
          rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
          if (r > rgbMax) rgbMax = r; if (g > rgbMax) rgbMax = g; if (b > rgbMax) rgbMax = b;
        }
        if (intensityRaw && getI) { intensityRaw[i] = getI(i); if (intensityRaw[i] > intensityMax) intensityMax = intensityRaw[i]; }
      }
      // Normalize color spaces: 16-bit vs 8-bit RGB; all-zero RGB = absent.
      if (rgb) {
        if (rgbMax === 0) rgb = null;
        else {
          const scale = rgbMax > 255 ? 65535 : 255;
          for (let i = 0; i < rgb.length; i++) rgb[i] = rgb[i] / scale;
        }
      }
      let intensity: Float32Array | null = null;
      if (intensityRaw && intensityMax > 0) {
        intensity = intensityRaw;
        for (let i = 0; i < n; i++) intensity[i] = intensity[i] / intensityMax;
      }

      const raw = { rgb, intensity, z, count: n };
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setAttribute("color", new THREE.BufferAttribute(colorsFor(raw, currentColorMode), 3));
      const [d] = parseKey(key);
      const mat = new THREE.PointsMaterial({
        size: Math.max((copcMeta.info.spacing / Math.pow(2, d)) * 1.35, cubeSpan / 6000),
        vertexColors: true,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(geom, mat);
      if (!alive) { geom.dispose(); mat.dispose(); return; }
      group.add(points);
      loaded.set(key, { key, points, raw, pointCount: n });
    };

    const dropNode = (key: string) => {
      const rec = loaded.get(key);
      if (!rec) return;
      group.remove(rec.points);
      rec.points.geometry.dispose();
      (rec.points.material as THREE.Material).dispose();
      loaded.delete(key);
    };

    let sampledTotal = 0;
    let sampledGeneration = 0;

    const publishStats = () => {
      if (!alive) return;
      let pts = 0;
      loaded.forEach((r) => { pts += r.pointCount; });
      setStats({ points: pts, nodes: loaded.size, total: copcMeta ? Number(copcMeta.header.pointCount) : sampledTotal });
    };

    /** LAS/PTS mode: uniform ranged sample of the whole cloud at the
     *  current budget. Re-runs wholesale on budget change / Refine. */
    const loadSampled = async () => {
      const generation = ++sampledGeneration;
      setBusy(true);
      try {
        [...loaded.keys()].forEach(dropNode);
        const gen = kind === "las" ? loadLasSampled(url, currentBudget) : loadPtsSampled(url, currentBudget);
        let first = true;
        let batchNo = 0;
        for await (const item of gen) {
          if (!alive || generation !== sampledGeneration) return;
          if (first) {
            first = false;
            cubeSpan = item.span;
            zRange = item.zRange;
            sampledTotal = item.total;
            camera.near = Math.max(cubeSpan / 5000, 0.01);
            camera.far = cubeSpan * 30;
            camera.updateProjectionMatrix();
            camera.position.set(cubeSpan * 0.7, -cubeSpan * 0.7, cubeSpan * 0.45);
            controls.target.set(0, 0, 0);
            controls.update();
            setStatus("ready");
          }
          const { batch } = item;
          const geom = new THREE.BufferGeometry();
          geom.setAttribute("position", new THREE.BufferAttribute(batch.positions, 3));
          const raw = { rgb: batch.rgb, intensity: batch.intensity, z: batch.z, count: batch.count };
          geom.setAttribute("color", new THREE.BufferAttribute(colorsFor(raw, currentColorMode), 3));
          const mat = new THREE.PointsMaterial({
            size: cubeSpan / 1200, vertexColors: true, sizeAttenuation: true,
          });
          const points = new THREE.Points(geom, mat);
          group.add(points);
          loaded.set(`batch-${batchNo++}`, { key: `batch-${batchNo}`, points, raw, pointCount: batch.count });
          publishStats();
        }
        if (first && alive) {
          setStatus("error");
          setError("The file parsed but contained no readable points.");
        }
      } catch (e) {
        if (alive && generation === sampledGeneration) {
          setStatus("error");
          setError((e as Error).message || "Couldn't read the point cloud.");
        }
      } finally {
        if (alive) setBusy(false);
      }
    };

    /** One refinement pass: pick wanted nodes for the current camera, load
     *  the missing ones, drop the rest. Re-entrancy safe. */
    const select = async () => {
      if (!copcMeta) return;
      if (selecting) { selectAgain = true; return; }
      selecting = true;
      setBusy(true);
      try {
        const focal = (mount.clientHeight || 1) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
        const wanted: Array<{ key: string; node: Hierarchy.Node; dist: number; depth: number }> = [];
        const queue: string[] = ["0-0-0-0"];
        while (queue.length) {
          const key = queue.shift()!;
          // Lazy hierarchy pages (big clouds ship subtrees on demand).
          const page = pages[key];
          if (page && !loadedPages.has(key)) {
            try {
              const sub = await Copc.loadHierarchyPage(getter, page);
              nodes = { ...nodes, ...sub.nodes };
              pages = { ...pages, ...sub.pages };
              loadedPages.add(key);
            } catch { /* subtree unavailable — skip */ }
            if (!alive) return;
          }
          const node = nodes[key];
          if (!node || node.pointCount === 0) continue;
          const { edge, center } = nodeBox(key);
          const dist = Math.max(camera.position.distanceTo(center) - edge * 0.87, edge * 0.05);
          const projected = (edge / dist) * focal;
          const [depth] = parseKey(key);
          if (depth > 0 && projected < MIN_NODE_PIXELS) continue;
          wanted.push({ key, node, dist, depth });
          const [d, x, y, z] = parseKey(key);
          for (let dx = 0; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) for (let dz = 0; dz <= 1; dz++) {
            queue.push(`${d + 1}-${x * 2 + dx}-${y * 2 + dy}-${z * 2 + dz}`);
          }
        }
        // Near + coarse first; cut at the point budget.
        wanted.sort((a, b) => a.depth - b.depth || a.dist - b.dist);
        const keep = new Set<string>();
        let sum = 0;
        for (const w of wanted) {
          if (sum + w.node.pointCount > currentBudget && keep.size > 0) continue;
          keep.add(w.key);
          sum += w.node.pointCount;
        }
        // Drop what we no longer want, load what's missing (near-first).
        [...loaded.keys()].filter((k) => !keep.has(k)).forEach(dropNode);
        const missing = wanted.filter((w) => keep.has(w.key) && !loaded.has(w.key));
        for (let i = 0; i < missing.length; i += LOAD_CONCURRENCY) {
          if (!alive) return;
          await Promise.all(missing.slice(i, i + LOAD_CONCURRENCY).map((w) =>
            loadNode(w.key, w.node).catch(() => undefined)));
          publishStats();
        }
        publishStats();
      } finally {
        selecting = false;
        if (alive) setBusy(false);
        if (selectAgain && alive) { selectAgain = false; void select(); }
      }
    };

    const home = () => {
      camera.position.set(cubeSpan * 0.7, -cubeSpan * 0.7, cubeSpan * 0.45);
      controls.target.set(0, 0, 0);
      controls.update();
      void select();
    };

    apiRef.current = {
      refresh: () => { if (kind === "copc") void select(); else void loadSampled(); },
      recolor: (m: ColorMode) => {
        currentColorMode = m;
        loaded.forEach((rec) => {
          rec.points.geometry.setAttribute("color", new THREE.BufferAttribute(colorsFor(rec.raw, m), 3));
          rec.points.geometry.attributes.color.needsUpdate = true;
        });
      },
      setBudget: (n: number) => { currentBudget = n; if (kind === "copc") void select(); else void loadSampled(); },
      home,
    };

    // Boot. COPC: parse header, load root hierarchy, frame, camera-driven
    // octree refinement. LAS/PTS: uniform ranged sample at the budget.
    if (kind === "copc") {
      (async () => {
        try {
          const [meta, lp] = await Promise.all([Copc.create(getter), getLazPerf()]);
          if (!alive) return;
          copcMeta = meta;
          lazPerf = lp;
          const [minx, miny, minz, maxx, maxy, maxz] = meta.info.cube;
          cubeMin = [minx, miny, minz];
          cubeSpan = Math.max(maxx - minx, maxy - miny, maxz - minz);
          cubeCenter = [(minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2];
          zRange = [meta.header.min[2], meta.header.max[2]];
          camera.near = Math.max(cubeSpan / 5000, 0.01);
          camera.far = cubeSpan * 30;
          camera.updateProjectionMatrix();
          const root = await Copc.loadHierarchyPage(getter, meta.info.rootHierarchyPage);
          if (!alive) return;
          nodes = root.nodes;
          pages = root.pages;
          setStatus("ready");
          home();
        } catch (e) {
          if (!alive) return;
          setStatus("error");
          setError((e as Error).message || "Couldn't open the point cloud.");
        }
      })();
    } else {
      void loadSampled();
    }

    controls.addEventListener("end", () => { if (kind === "copc") void select(); });

    return () => {
      alive = false;
      if (!disposed) {
        disposed = true;
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.dispose();
        loaded.forEach((r) => {
          r.points.geometry.dispose();
          (r.points.material as THREE.Material).dispose();
        });
        loaded.clear();
        renderer.dispose();
        if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
      }
    };
    // The viewer rebuilds only when the file changes; color/budget mutate live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind]);

  const changeColorMode = useCallback((m: ColorMode) => {
    setColorMode(m);
    apiRef.current.recolor?.(m);
  }, []);
  const changeBudget = useCallback((n: number) => {
    setBudget(n);
    apiRef.current.setBudget?.(n);
  }, []);

  return (
    <div className="relative rounded-2xl border border-[var(--color-border)] overflow-hidden bg-black" style={{ height }}>
      <div ref={mountRef} className="absolute inset-0" />

      {status === "boot" && (
        <div className="absolute inset-0 flex items-center justify-center text-white/80 text-sm gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Opening point cloud…
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="text-center text-sm text-white/90 max-w-md">
            <div className="font-bold mb-1">Couldn&apos;t open the 3D model</div>
            <div className="text-white/60 text-xs">{error}</div>
          </div>
        </div>
      )}

      {status === "ready" && (
        <>
          <div className="absolute top-2 left-2 flex items-center gap-1.5 flex-wrap">
            <select
              value={colorMode}
              onChange={(e) => changeColorMode(e.target.value as ColorMode)}
              className="h-7 rounded-lg bg-black/60 backdrop-blur border border-white/20 text-white text-[11px] font-bold px-2"
              title="Coloring"
            >
              <option value="auto">Auto color</option>
              <option value="rgb">Scan color</option>
              <option value="intensity">Intensity</option>
              <option value="elevation">Elevation</option>
            </select>
            <select
              value={budget}
              onChange={(e) => changeBudget(Number(e.target.value))}
              className="h-7 rounded-lg bg-black/60 backdrop-blur border border-white/20 text-white text-[11px] font-bold px-2"
              title="Point budget (higher = denser, heavier)"
            >
              <option value={1_000_000}>1M points</option>
              <option value={2_500_000}>2.5M points</option>
              <option value={5_000_000}>5M points</option>
              <option value={10_000_000}>10M points</option>
            </select>
            <button
              onClick={() => apiRef.current.home?.()}
              className="h-7 px-2 rounded-lg bg-black/60 backdrop-blur border border-white/20 text-white text-[11px] font-bold inline-flex items-center gap-1 hover:bg-black/80"
              title="Reset view"
            >
              <Maximize2 className="w-3 h-3" /> Fit
            </button>
            <button
              onClick={() => apiRef.current.refresh?.()}
              className="h-7 px-2 rounded-lg bg-black/60 backdrop-blur border border-white/20 text-white text-[11px] font-bold inline-flex items-center gap-1 hover:bg-black/80"
              title="Refine detail for this view"
            >
              <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} /> Refine
            </button>
          </div>
          <div className="absolute bottom-2 left-2 text-[10px] font-bold text-white/70 bg-black/50 backdrop-blur rounded-md px-2 py-1 tabular-nums">
            {(stats.points / 1_000_000).toFixed(2)}M / {(stats.total / 1_000_000).toFixed(1)}M points · {stats.nodes} tiles{busy ? " · loading…" : ""}
          </div>
          <div className="absolute bottom-2 right-2 text-[10px] text-white/50 bg-black/40 backdrop-blur rounded-md px-2 py-1">
            drag orbit · right-drag pan · wheel zoom
          </div>
        </>
      )}
    </div>
  );
}
