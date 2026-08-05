"use client";

// OrgGraph3D — the org's relationship web as a volume you fly through.
//
// three.js, loaded only when 3D is switched on so the 2D graph stays light.
// Nodes are instanced billboards (one draw call for thousands) with a second
// dimmer halo pass for bloom; links are additive line buffers; labels are
// canvas sprites built lazily for what earns one.
//
// Feature parity with the 2D map is deliberate — anything you can do there
// you can do here: click and drag nodes, fly to a node, region names, live
// display settings, proposal ghosts. A mode switch should change the view,
// not the vocabulary.

import React from "react";
import type { GraphNode, GraphEdge, GraphNodeType, GraphEdgeType } from "@/lib/orgGraph";
import { GraphSim } from "@/lib/graphSim";
import { groupColorFor, type GraphSettings } from "@/lib/graphSettings";
import { NODE_COLORS, EDGE_RGB, ACCENT } from "@/components/graph/graphTheme";

// three is heavy; keep it out of every other route's bundle.
type Three = typeof import("three");

const BASE_R: Record<GraphNodeType, number> = {
  document: 3.2, asset: 3.8, unit: 7, library: 6, project: 6, plant: 8,
};

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  settings: GraphSettings;
  sim: GraphSim;
  query: string;
  selectedId: string | null;
  highlightIds: Set<string>;
  pathIds: Set<string>;
  regions: Array<{ label: string; ids: string[] }>;
  /** Frame these nodes; bump `nonce` to re-fly to the same set. */
  flyTo: { ids: string[]; nonce: number } | null;
  onSelect: (n: GraphNode | null) => void;
  onOpen: (n: GraphNode) => void;
  onSettled?: () => void;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** A soft radial dot, drawn once and reused by every node — this is what
 *  gives the scene its glow without a post-processing pass. Generated at the
 *  device's pixel density so it never looks like a low-res smear. */
function makeDotTexture(THREE: Three, maxAniso: number) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.30, "rgba(255,255,255,0.9)");
  g.addColorStop(0.62, "rgba(255,255,255,0.22)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  tex.needsUpdate = true;
  return tex;
}

/** Label sprites are rendered at device density and sized in world units
 *  from their true pixel dimensions, so text stays crisp instead of being
 *  stretched off a too-small canvas. */
function makeLabelSprite(
  THREE: Three, text: string, color: string, maxAniso: number,
  opts?: { worldHeight?: number; weight?: number; halo?: boolean },
) {
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const fontPx = 64;
  const pad = 10;
  const weight = opts?.weight ?? 700;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `${weight} ${fontPx}px ui-monospace, SFMono-Regular, monospace`;
  const textW = Math.ceil(measure.measureText(text).width);

  const w = textW + pad * 2, h = fontPx + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.font = `${weight} ${fontPx}px ui-monospace, SFMono-Regular, monospace`;
  ctx.textBaseline = "middle";
  if (opts?.halo !== false) {
    ctx.lineWidth = 7;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(2,6,20,0.75)";
    ctx.strokeText(text, pad, h / 2);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, pad, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = maxAniso;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const worldH = opts?.worldHeight ?? 16;
  sprite.scale.set((w / h) * worldH, worldH, 1);
  return sprite;
}

export default function OrgGraph3D({
  nodes, edges, settings, sim, query, selectedId, highlightIds, pathIds,
  regions, flyTo, onSelect, onOpen, onSettled,
}: Props) {
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);

  // Live props for the animation loop, which must not re-subscribe per frame.
  const live = React.useRef({
    nodes, edges, settings, sim, query, selectedId, highlightIds, pathIds,
    regions, onSelect, onOpen, onSettled,
  });
  live.current = {
    nodes, edges, settings, sim, query, selectedId, highlightIds, pathIds,
    regions, onSelect, onOpen, onSettled,
  };

  // Camera commands from React, consumed by the loop.
  const flyRef = React.useRef<{ ids: string[]; nonce: number } | null>(null);
  React.useEffect(() => { flyRef.current = flyTo; }, [flyTo]);

  React.useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      let THREE: Three;
      try {
        THREE = await import("three");
      } catch {
        if (!disposed) setFailed("3D view couldn't load. The 2D map has everything except depth.");
        return;
      }
      if (disposed) return;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(55, 1, 1, 24000);

      let renderer: InstanceType<Three["WebGLRenderer"]>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      } catch {
        if (!disposed) setFailed("This device doesn't support WebGL. The 2D map works everywhere.");
        return;
      }
      const maxAniso = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      mount.appendChild(renderer.domElement);
      renderer.domElement.style.touchAction = "none";
      renderer.domElement.style.display = "block";

      const dot = makeDotTexture(THREE, maxAniso);

      // ── Nodes: instanced billboards, colour per instance ───────────────
      const nodeGeo = new THREE.PlaneGeometry(1, 1);
      // No vertexColors: per-instance colour comes from InstancedMesh's own
      // instanceColor attribute (three injects USE_INSTANCING_COLOR), and
      // asking for both makes the shader ignore one of them.
      const nodeMat = new THREE.MeshBasicMaterial({
        map: dot, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      // A larger, dimmer pass behind the nodes: additive overlap is what
      // produces real bloom in dense regions, with no post-processing chain.
      const haloMat = new THREE.MeshBasicMaterial({
        map: dot, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.55,
      });
      let mesh: InstanceType<Three["InstancedMesh"]> | null = null;
      let halo: InstanceType<Three["InstancedMesh"]> | null = null;

      // ── Links: solid buffer + a dashed buffer for proposals ────────────
      const linkGeo = new THREE.BufferGeometry();
      const linkMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false,
      });
      scene.add(new THREE.LineSegments(linkGeo, linkMat));

      const ghostGeo = new THREE.BufferGeometry();
      const ghostMat = new THREE.LineDashedMaterial({
        color: 0xeab308, transparent: true, opacity: 0.85,
        dashSize: 14, gapSize: 10, depthWrite: false,
      });
      const ghostLines = new THREE.LineSegments(ghostGeo, ghostMat);
      scene.add(ghostLines);

      const labelLayer = new THREE.Group();
      scene.add(labelLayer);
      const labelCache = new Map<string, InstanceType<Three["Sprite"]>>();
      const regionCache = new Map<string, InstanceType<Three["Sprite"]>>();

      const dummy = new THREE.Object3D();
      const scratchColor = new THREE.Color();
      const raycaster = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const dragPlane = new THREE.Plane();
      const dragHit = new THREE.Vector3();
      const camDir = new THREE.Vector3();
      let hoverId: string | null = null;

      // ── Camera rig ─────────────────────────────────────────────────────
      // Starts ANGLED: looking straight down the depth axis renders any
      // volume as a disc. Damped, so orbiting carries momentum.
      const target = new THREE.Vector3(0, 0, 0);
      const desiredTarget = new THREE.Vector3(0, 0, 0);
      const spherical = { radius: 1500, theta: 0.7, phi: 1.12 };
      const desired = { ...spherical };
      let lastInteraction = performance.now();
      const touched = () => { lastInteraction = performance.now(); };

      const applyCamera = () => {
        const { radius, theta, phi } = spherical;
        camera.position.set(
          target.x + radius * Math.sin(phi) * Math.sin(theta),
          target.y + radius * Math.cos(phi),
          target.z + radius * Math.sin(phi) * Math.cos(theta),
        );
        camera.lookAt(target);
        camera.updateMatrixWorld();
      };
      applyCamera();

      // ── Starfield: static, far, and the reason depth READS as depth.
      // Without parallax against something fixed, orbiting a point cloud is
      // ambiguous — the eye can't separate rotation from rearrangement.
      const starCount = 1400;
      const starPos = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        const u = Math.random(), v = Math.random();
        const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1);
        const r = 7000 + Math.random() * 5000;
        starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        starPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        starPos[i * 3 + 2] = r * Math.cos(ph);
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
      const starMat = new THREE.PointsMaterial({
        map: dot, color: 0x9fb0d6, size: 26, sizeAttenuation: true,
        transparent: true, opacity: 0.55, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      scene.add(new THREE.Points(starGeo, starMat));

      // ── Sizing. updateStyle MUST stay on: with it off, three sets the
      // backing buffer to width×DPR but never the CSS size, so on any
      // high-DPI screen the canvas lays out at DPR times its intended size —
      // cropped, and effectively rendered at 1×. That is what "grainy" is.
      const resize = () => {
        const { width, height } = mount.getBoundingClientRect();
        if (width < 2 || height < 2) return;
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(mount);

      // ── Picking ────────────────────────────────────────────────────────
      // Always derived from the event that asked, never from a remembered
      // pointer: a tap fires no pointermove, so a stale position means taps
      // and clicks silently resolve nothing.
      const setNdc = (clientX: number, clientY: number) => {
        const rect = renderer.domElement.getBoundingClientRect();
        ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      };
      const pickAt = (clientX: number, clientY: number): string | null => {
        if (!mesh) return null;
        setNdc(clientX, clientY);
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObject(mesh, false);
        for (const h of hits) {
          if (h.instanceId === undefined) continue;
          const id = live.current.nodes[h.instanceId]?.id;
          if (id) return id;
        }
        return null;
      };

      // ── Input ──────────────────────────────────────────────────────────
      const pointers = new Map<number, { x: number; y: number }>();
      let drag: {
        mode: "orbit" | "pan" | "node";
        nodeId?: string;
        x: number; y: number; moved: number;
      } | null = null;
      let pinchDist = 0;

      const el = renderer.domElement;

      const onDown = (e: PointerEvent) => {
        touched();
        el.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [p1, p2] = [...pointers.values()];
          pinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          drag = null;
          return;
        }
        const hitId = pickAt(e.clientX, e.clientY);
        if (hitId && e.button !== 2 && !e.shiftKey) {
          // Grab the node: drag it on the plane facing the camera.
          const n = live.current.sim.get(hitId);
          if (n) {
            n.fixed = true;
            camera.getWorldDirection(camDir);
            dragPlane.setFromNormalAndCoplanarPoint(camDir, new THREE.Vector3(n.x, n.y, n.z));
          }
          drag = { mode: "node", nodeId: hitId, x: e.clientX, y: e.clientY, moved: 0 };
          return;
        }
        drag = {
          mode: e.button === 2 || e.shiftKey ? "pan" : "orbit",
          x: e.clientX, y: e.clientY, moved: 0,
        };
      };

      const onMove = (e: PointerEvent) => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2) {
          const [p1, p2] = [...pointers.values()];
          const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          if (pinchDist > 0) {
            desired.radius = Math.min(9000, Math.max(80, desired.radius * (pinchDist / Math.max(1, d))));
          }
          pinchDist = d;
          touched();
          return;
        }

        if (!drag) {
          // Hover is computed here, not per frame: an O(nodes) raycast every
          // frame is wasted work when the pointer hasn't moved.
          const id = pickAt(e.clientX, e.clientY);
          if (id !== hoverId) {
            hoverId = id;
            el.style.cursor = id ? "pointer" : "grab";
          }
          return;
        }

        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        touched();

        if (drag.mode === "node" && drag.nodeId) {
          const n = live.current.sim.get(drag.nodeId);
          if (n) {
            setNdc(e.clientX, e.clientY);
            raycaster.setFromCamera(ndc, camera);
            if (raycaster.ray.intersectPlane(dragPlane, dragHit)) {
              n.x = dragHit.x; n.y = dragHit.y; n.z = dragHit.z;
              n.vx = 0; n.vy = 0; n.vz = 0;
              live.current.sim.reheat(0.2);
            }
          }
          return;
        }
        if (drag.mode === "orbit") {
          desired.theta -= dx * 0.005;
          // Clamp off the poles so the view never flips inside out.
          desired.phi = Math.min(Math.PI - 0.08, Math.max(0.08, desired.phi - dy * 0.005));
        } else {
          const scale = spherical.radius * 0.0016;
          const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
          desiredTarget.addScaledVector(right, -dx * scale);
          desiredTarget.addScaledVector(up, dy * scale);
        }
      };

      const onUp = (e: PointerEvent) => {
        touched();
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchDist = 0;
        const d = drag;
        drag = null;
        if (!d) return;
        if (d.nodeId) {
          // A drag positions a node; it doesn't pin it forever.
          const n = live.current.sim.get(d.nodeId);
          if (n) n.fixed = false;
        }
        if (d.moved < 6) {
          const id = d.nodeId ?? pickAt(e.clientX, e.clientY);
          const node = id ? live.current.nodes.find((n) => n.id === id) ?? null : null;
          live.current.onSelect(node);
        }
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        touched();
        desired.radius = Math.min(9000, Math.max(80, desired.radius * Math.exp(e.deltaY * 0.0012)));
      };

      const onDouble = (e: MouseEvent) => {
        const id = pickAt(e.clientX, e.clientY);
        if (!id) return;
        const n = live.current.nodes.find((x) => x.id === id);
        if (n) live.current.onOpen(n);
      };
      const onContext = (ev: Event) => ev.preventDefault();
      const onLeave = () => { hoverId = null; };

      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
      el.addEventListener("pointerleave", onLeave);
      el.addEventListener("wheel", onWheel, { passive: false });
      el.addEventListener("dblclick", onDouble);
      el.addEventListener("contextmenu", onContext);

      // ── Rebuild GPU buffers when the node/edge set changes ─────────────
      let builtFor = "";
      let ghostCount = 0;
      const rebuild = () => {
        const ns = live.current.nodes, es = live.current.edges;
        const signature = `${ns.length}:${es.length}:${ns[0]?.id ?? ""}:${ns[ns.length - 1]?.id ?? ""}`;
        if (signature === builtFor) return;
        builtFor = signature;

        if (mesh) { scene.remove(mesh); mesh.dispose(); }
        if (halo) { scene.remove(halo); halo.dispose(); }
        const count = Math.max(1, ns.length);
        mesh = new THREE.InstancedMesh(nodeGeo, nodeMat, count);
        halo = new THREE.InstancedMesh(nodeGeo, haloMat, count);
        mesh.frustumCulled = false;
        halo.frustumCulled = false;
        halo.renderOrder = -1;
        // setColorAt allocates instanceColor on first use — seed every slot
        // so the attribute exists before the first frame writes to it.
        for (let i = 0; i < count; i++) {
          mesh.setColorAt(i, scratchColor.setRGB(1, 1, 1));
          halo.setColorAt(i, scratchColor.setRGB(1, 1, 1));
        }
        scene.add(halo);
        scene.add(mesh);

        const solid = es.filter((e) => e.type !== "proposed");
        const ghosts = es.filter((e) => e.type === "proposed");
        ghostCount = ghosts.length;
        linkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, solid.length) * 6), 3));
        linkGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(Math.max(1, solid.length) * 6), 3));
        ghostGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, ghosts.length) * 6), 3));

        for (const s of labelCache.values()) {
          labelLayer.remove(s);
          s.material.map?.dispose();
          s.material.dispose();
        }
        labelCache.clear();
      };

      // ── Frame ──────────────────────────────────────────────────────────
      let raf = 0;
      let wasSettled = false;
      let lastFly = 0;
      let lastGlow = true;
      let dashTimer = 0;

      const frame = () => {
        if (disposed) return;
        raf = requestAnimationFrame(frame);
        const {
          nodes: ns, edges: es, settings: st, sim: s, selectedId: sel,
          highlightIds: gold, pathIds: onPathSet, query: q, regions: regs,
        } = live.current;
        rebuild();
        if (!mesh || !halo) return;

        // Glow is a live setting, not a mount-time one.
        if (st.glow !== lastGlow) {
          lastGlow = st.glow;
          nodeMat.blending = st.glow ? THREE.AdditiveBlending : THREE.NormalBlending;
          nodeMat.needsUpdate = true;
        }

        // Fly to a set of nodes (insight spotlight, deep link, focus).
        const fly = flyRef.current;
        if (fly && fly.nonce !== lastFly && fly.ids.length > 0) {
          const pts = fly.ids.map((id) => s.get(id)).filter(Boolean) as Array<{ x: number; y: number; z: number }>;
          if (pts.length > 0) {
            lastFly = fly.nonce;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (const p of pts) {
              minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
              minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
              minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            }
            desiredTarget.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
            const span = Math.max(120, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
            desired.radius = Math.min(4000, Math.max(220, span * 2.2));
            touched();
          }
        }

        const running = s.tick();
        if (!running && !wasSettled) { wasSettled = true; live.current.onSettled?.(); }
        if (running) wasSettled = false;

        // Ease camera; drift when idle so the scene reads as a space rather
        // than a picture.
        if (performance.now() - lastInteraction > 2500) desired.theta += 0.0009;
        spherical.theta += (desired.theta - spherical.theta) * 0.12;
        spherical.phi += (desired.phi - spherical.phi) * 0.12;
        spherical.radius += (desired.radius - spherical.radius) * 0.12;
        target.lerp(desiredTarget, 0.12);
        applyCamera();

        const spotId = hoverId ?? sel;
        const neighbours = new Set<string>();
        if (spotId) {
          for (const e of es) {
            if (e.a === spotId) neighbours.add(e.b);
            if (e.b === spotId) neighbours.add(e.a);
          }
        }

        // ── Nodes ────────────────────────────────────────────────────────
        for (let i = 0; i < ns.length; i++) {
          const n = ns[i];
          const p = s.get(n.id);
          if (!p) continue;
          const isSpot = spotId === n.id;
          const inPath = onPathSet.has(n.id);
          const isGold = gold.has(n.id);
          const matches = q.length >= 2 && n.label.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q);
          const emphasis = isSpot || inPath || isGold || matches ? 1.7 : 1;
          const base = BASE_R[n.type] + Math.min(9, Math.sqrt(n.degree) * 1.1);
          const size = base * 2.6 * st.nodeScale * emphasis;

          dummy.position.set(p.x, p.y, p.z);
          dummy.quaternion.copy(camera.quaternion);   // always face the camera
          dummy.scale.set(size, size, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);

          const hex = inPath ? ACCENT.path
            : isGold ? ACCENT.found
            : (groupColorFor(n, st.groups) ?? NODE_COLORS[n.type]);
          const [r, g, b] = hexToRgb(hex);

          let dim = 1;
          if (spotId && !isSpot && !neighbours.has(n.id) && !inPath) dim = 0.22;
          if (q.length >= 2 && !matches) dim = Math.min(dim, 0.18);
          if (isGold || inPath) dim = 1;

          // Depth cueing: without it every node is equally bright and the
          // scene flattens back into a sticker sheet.
          const dz = camera.position.distanceTo(dummy.position);
          const depth = Math.max(0.35, Math.min(1.25, 1.6 - dz / (spherical.radius * 1.9)));
          const k = dim * depth;
          mesh.setColorAt(i, scratchColor.setRGB(r * k, g * k, b * k));

          const haloBoost = isSpot || isGold || inPath || matches ? 3.4 : 2.1;
          dummy.scale.set(size * haloBoost, size * haloBoost, 1);
          dummy.updateMatrix();
          halo.setMatrixAt(i, dummy.matrix);
          const hk = k * (st.glow ? 0.30 : 0.10);
          halo.setColorAt(i, scratchColor.setRGB(r * hk, g * hk, b * hk));
        }
        mesh.count = ns.length;
        halo.count = ns.length;
        mesh.instanceMatrix.needsUpdate = true;
        halo.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (halo.instanceColor) halo.instanceColor.needsUpdate = true;

        // ── Links ────────────────────────────────────────────────────────
        const pos = linkGeo.getAttribute("position") as InstanceType<Three["BufferAttribute"]>;
        const col = linkGeo.getAttribute("color") as InstanceType<Three["BufferAttribute"]>;
        const gpos = ghostGeo.getAttribute("position") as InstanceType<Three["BufferAttribute"]>;
        const fade = (d: number) => Math.max(0.25, Math.min(1.15, 1.5 - d / (spherical.radius * 2.1)));
        let si = 0, gi = 0;
        for (const e of es) {
          const na = s.get(e.a), nb = s.get(e.b);
          if (!na || !nb) continue;
          if (e.type === "proposed") {
            gpos.setXYZ(gi * 2, na.x, na.y, na.z);
            gpos.setXYZ(gi * 2 + 1, nb.x, nb.y, nb.z);
            gi++;
            continue;
          }
          pos.setXYZ(si * 2, na.x, na.y, na.z);
          pos.setXYZ(si * 2 + 1, nb.x, nb.y, nb.z);
          const rgbStr = EDGE_RGB[e.type as GraphEdgeType] ?? "148,163,184";
          const [r0, g0, b0] = rgbStr.split(",").map((v) => Number(v) / 255);
          const inSpot = !spotId || e.a === spotId || e.b === spotId;
          const onPath = onPathSet.has(e.a) && onPathSet.has(e.b);
          const k = (onPath ? 1.6 : inSpot ? 0.9 : 0.16) * st.linkOpacity;
          const [r, g, b] = onPath ? [0.13, 0.83, 0.93] : [r0, g0, b0];
          // Per-END depth cueing: a link running away from the camera fades
          // along its length, which is most of what sells the third axis.
          const ka = k * fade(Math.hypot(na.x - camera.position.x, na.y - camera.position.y, na.z - camera.position.z));
          const kb = k * fade(Math.hypot(nb.x - camera.position.x, nb.y - camera.position.y, nb.z - camera.position.z));
          col.setXYZ(si * 2, r * ka, g * ka, b * ka);
          col.setXYZ(si * 2 + 1, r * kb, g * kb, b * kb);
          si++;
        }
        pos.needsUpdate = true; col.needsUpdate = true;
        linkGeo.setDrawRange(0, si * 2);
        linkMat.opacity = Math.min(1, 0.35 + st.linkThickness * 0.35);

        gpos.needsUpdate = true;
        ghostGeo.setDrawRange(0, gi * 2);
        ghostLines.visible = gi > 0;
        // Dash distances must be recomputed when endpoints move; while the
        // layout is settling that's every few frames, not every frame.
        if (gi > 0 && (running ? (dashTimer = (dashTimer + 1) % 6) === 0 : ghostCount !== gi)) {
          ghostLines.computeLineDistances();
          ghostCount = gi;
        }

        // ── Region names: the neighbourhood map, in depth ─────────────────
        const showRegions = spherical.radius > 900;
        for (const [key, sprite] of regionCache) {
          if (!showRegions || !regs.some((r) => r.label === key)) {
            labelLayer.remove(sprite);
            sprite.material.map?.dispose();
            sprite.material.dispose();
            regionCache.delete(key);
          }
        }
        if (showRegions) {
          for (const region of regs) {
            let sx = 0, sy = 0, sz = 0, count = 0;
            for (const id of region.ids) {
              const p = s.get(id);
              if (p) { sx += p.x; sy += p.y; sz += p.z; count++; }
            }
            if (count < 3) continue;
            let sprite = regionCache.get(region.label);
            if (!sprite) {
              sprite = makeLabelSprite(
                THREE, region.label.slice(0, 24).toUpperCase(), "#c7d2fe", maxAniso,
                { worldHeight: 46, weight: 900 },
              );
              sprite.material.opacity = 0.32;
              regionCache.set(region.label, sprite);
              labelLayer.add(sprite);
            }
            sprite.position.set(sx / count, sy / count, sz / count);
            sprite.material.opacity = Math.min(0.35, (spherical.radius - 900) / 4000);
          }
        }

        // ── Node labels ──────────────────────────────────────────────────
        const labelRadius = 2600 / Math.max(0.15, st.labelThreshold);
        const want = new Set<string>();
        for (const n of ns) {
          const matches = q.length >= 2 && n.label.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q);
          const near = spherical.radius < labelRadius && n.degree >= 3;
          if (spotId === n.id || neighbours.has(n.id) || matches ||
              onPathSet.has(n.id) || gold.has(n.id) || near) {
            want.add(n.id);
            if (want.size > 140) break;
          }
        }
        for (const [id, sprite] of labelCache) {
          if (!want.has(id)) {
            labelLayer.remove(sprite);
            sprite.material.map?.dispose();
            sprite.material.dispose();
            labelCache.delete(id);
          }
        }
        for (const id of want) {
          const n = ns.find((x) => x.id === id);
          const p = s.get(id);
          if (!n || !p) continue;
          let sprite = labelCache.get(id);
          if (!sprite) {
            sprite = makeLabelSprite(THREE, n.label.slice(0, 24), "#f1f5f9", maxAniso, { worldHeight: 17 });
            labelCache.set(id, sprite);
            labelLayer.add(sprite);
          }
          const base = BASE_R[n.type] + Math.min(9, Math.sqrt(n.degree) * 1.1);
          sprite.position.set(p.x, p.y + base * 2.4 + 8, p.z);
        }

        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(frame);
      setReady(true);

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        el.removeEventListener("pointerleave", onLeave);
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("dblclick", onDouble);
        el.removeEventListener("contextmenu", onContext);
        for (const s of labelCache.values()) { s.material.map?.dispose(); s.material.dispose(); }
        for (const s of regionCache.values()) { s.material.map?.dispose(); s.material.dispose(); }
        mesh?.dispose();
        halo?.dispose();
        nodeGeo.dispose(); nodeMat.dispose(); haloMat.dispose();
        linkGeo.dispose(); linkMat.dispose();
        ghostGeo.dispose(); ghostMat.dispose();
        starGeo.dispose(); starMat.dispose();
        dot.dispose();
        renderer.dispose();
        if (el.parentNode === mount) mount.removeChild(el);
      };
    })();

    return () => { disposed = true; cleanup?.(); };
    // Mount once: everything dynamic is read through the `live` ref.
  }, []);

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 overflow-hidden"
      style={{
        background:
          "radial-gradient(120% 90% at 50% 35%, #16204a 0%, #0d1330 45%, #05070f 100%)",
      }}
    >
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <div className="text-xs text-amber-300 max-w-xs">{failed}</div>
        </div>
      )}
      {!ready && !failed && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-[11px] font-bold text-slate-400">Building the 3D scene…</div>
        </div>
      )}
    </div>
  );
}
