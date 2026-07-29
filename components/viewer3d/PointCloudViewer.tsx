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

export default function PointCloudViewer({ url, height = 560 }: {
  /** Presigned GET URL for the .copc.laz object (must support Range). */
  url: string;
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

    const publishStats = () => {
      if (!alive) return;
      let pts = 0;
      loaded.forEach((r) => { pts += r.pointCount; });
      setStats({ points: pts, nodes: loaded.size, total: copcMeta ? Number(copcMeta.header.pointCount) : 0 });
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
      refresh: () => void select(),
      recolor: (m: ColorMode) => {
        currentColorMode = m;
        loaded.forEach((rec) => {
          rec.points.geometry.setAttribute("color", new THREE.BufferAttribute(colorsFor(rec.raw, m), 3));
          rec.points.geometry.attributes.color.needsUpdate = true;
        });
      },
      setBudget: (n: number) => { currentBudget = n; void select(); },
      home,
    };

    // Boot: parse header, load root hierarchy, frame the cube, first pass.
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

    controls.addEventListener("end", () => { void select(); });

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
  }, [url]);

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
