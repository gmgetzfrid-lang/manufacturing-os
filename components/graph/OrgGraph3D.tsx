"use client";

// OrgGraph3D — the org's relationship web as a volume you fly through.
//
// three.js, loaded only when 3D is switched on so the 2D graph stays light.
// Nodes are instanced glowing sprites (one draw call for thousands), links
// are a single additive line-segment buffer, labels are canvas sprites
// created lazily and only for what deserves one.
//
// Interaction: drag to orbit, right-drag / two-finger to pan, wheel to
// dolly, hover to spotlight a neighbourhood, click to select, double-click
// to open. Physics come from the shared GraphSim, so the arrangement is the
// same one you tuned in 2D — lifted off the page, not rebuilt.

import React from "react";
import type { GraphNode, GraphEdge, GraphNodeType, GraphEdgeType } from "@/lib/orgGraph";
import { GraphSim } from "@/lib/graphSim";
import { groupColorFor, type GraphSettings } from "@/lib/graphSettings";
import { NODE_COLORS, EDGE_RGB } from "@/components/graph/graphTheme";

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
  onSelect: (n: GraphNode | null) => void;
  onOpen: (n: GraphNode) => void;
  /** Told when the physics settle so the page can persist positions. */
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

/** A soft radial dot, drawn once and reused by every node sprite — this is
 *  what gives the 3D view its glow without a post-processing pass. */
function makeDotTexture(THREE: Three): InstanceType<Three["CanvasTexture"]> {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.85)");
  g.addColorStop(0.7, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function makeLabelSprite(THREE: Three, text: string, color: string) {
  const pad = 8, font = 44;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `700 ${font}px ui-monospace, monospace`;
  const w = Math.ceil(measure.measureText(text).width) + pad * 2;
  const h = font + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `700 ${font}px ui-monospace, monospace`;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.strokeText(text, pad, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, pad, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set((w / h) * 14, 14, 1);
  return sprite;
}

export default function OrgGraph3D({
  nodes, edges, settings, sim, query, selectedId, highlightIds, pathIds,
  onSelect, onOpen, onSettled,
}: Props) {
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);

  // Live props for the animation loop, which must not re-subscribe per frame.
  const live = React.useRef({ nodes, edges, settings, sim, query, selectedId, highlightIds, pathIds, onSelect, onOpen, onSettled });
  live.current = { nodes, edges, settings, sim, query, selectedId, highlightIds, pathIds, onSelect, onOpen, onSettled };

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
      const camera = new THREE.PerspectiveCamera(55, 1, 1, 12000);
      camera.position.set(0, 0, 900);

      let renderer: InstanceType<Three["WebGLRenderer"]>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        if (!disposed) setFailed("This device doesn't support WebGL. The 2D map works everywhere.");
        return;
      }
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      mount.appendChild(renderer.domElement);
      renderer.domElement.style.touchAction = "none";
      renderer.domElement.style.display = "block";

      const dot = makeDotTexture(THREE);

      // ── Nodes: one instanced sprite mesh, colour per instance ──────────
      const nodeGeo = new THREE.PlaneGeometry(1, 1);
      // No vertexColors here: per-instance colour comes from InstancedMesh's
      // own instanceColor attribute (three injects USE_INSTANCING_COLOR), and
      // asking for both makes the shader ignore one of them.
      const nodeMat = new THREE.MeshBasicMaterial({
        map: dot, transparent: true, depthWrite: false,
        blending: settings.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      let mesh: InstanceType<Three["InstancedMesh"]> | null = null;

      // ── Links: one line-segment buffer ────────────────────────────────
      const linkGeo = new THREE.BufferGeometry();
      const linkMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false,
      });
      const lines = new THREE.LineSegments(linkGeo, linkMat);
      scene.add(lines);

      const labelLayer = new THREE.Group();
      scene.add(labelLayer);
      const labelCache = new Map<string, InstanceType<Three["Sprite"]>>();

      const dummy = new THREE.Object3D();
      const scratchColor = new THREE.Color();
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let hoverId: string | null = null;

      // ── Camera rig: orbit + pan + dolly, no external controls dep ──────
      const target = new THREE.Vector3(0, 0, 0);
      const spherical = { radius: 900, theta: 0, phi: Math.PI / 2 };
      const applyCamera = () => {
        const { radius, theta, phi } = spherical;
        camera.position.set(
          target.x + radius * Math.sin(phi) * Math.sin(theta),
          target.y + radius * Math.cos(phi),
          target.z + radius * Math.sin(phi) * Math.cos(theta),
        );
        camera.lookAt(target);
      };
      applyCamera();

      const resize = () => {
        const { width, height } = mount.getBoundingClientRect();
        renderer.setSize(width, height, false);
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(mount);

      // ── Input ──────────────────────────────────────────────────────────
      const pointers = new Map<number, { x: number; y: number }>();
      let drag: { mode: "orbit" | "pan"; x: number; y: number; moved: number } | null = null;
      let pinchDist = 0;

      const el = renderer.domElement;
      const onDown = (e: PointerEvent) => {
        el.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [p1, p2] = [...pointers.values()];
          pinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          drag = null;
          return;
        }
        drag = {
          mode: e.button === 2 || e.shiftKey ? "pan" : "orbit",
          x: e.clientX, y: e.clientY, moved: 0,
        };
      };
      const onMove = (e: PointerEvent) => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const rect = el.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        if (pointers.size === 2) {
          const [p1, p2] = [...pointers.values()];
          const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          if (pinchDist > 0) {
            spherical.radius = Math.min(6000, Math.max(60, spherical.radius * (pinchDist / Math.max(1, d))));
            applyCamera();
          }
          pinchDist = d;
          return;
        }
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        if (drag.mode === "orbit") {
          spherical.theta -= dx * 0.005;
          // Clamp off the poles so the view never flips inside out.
          spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - dy * 0.005));
        } else {
          const scale = spherical.radius * 0.0016;
          const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
          target.addScaledVector(right, -dx * scale);
          target.addScaledVector(up, dy * scale);
        }
        applyCamera();
      };
      const onUp = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchDist = 0;
        if (drag && drag.moved < 5) {
          const hit = pick();
          live.current.onSelect(hit ? live.current.nodes.find((n) => n.id === hit) ?? null : null);
        }
        drag = null;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        spherical.radius = Math.min(6000, Math.max(60, spherical.radius * Math.exp(e.deltaY * 0.0012)));
        applyCamera();
      };
      const onDouble = () => {
        const hit = pick();
        if (!hit) return;
        const n = live.current.nodes.find((x) => x.id === hit);
        if (n) live.current.onOpen(n);
      };
      const onContext = (e: Event) => e.preventDefault();

      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
      el.addEventListener("wheel", onWheel, { passive: false });
      el.addEventListener("dblclick", onDouble);
      el.addEventListener("contextmenu", onContext);

      const pick = (): string | null => {
        if (!mesh) return null;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObject(mesh);
        const first = hits[0];
        if (!first || first.instanceId === undefined) return null;
        return live.current.nodes[first.instanceId]?.id ?? null;
      };

      // ── Rebuild GPU buffers when the node/edge set changes ─────────────
      let builtFor = "";
      const rebuild = () => {
        const ns = live.current.nodes, es = live.current.edges;
        const signature = `${ns.length}:${es.length}:${ns[0]?.id ?? ""}:${ns[ns.length - 1]?.id ?? ""}`;
        if (signature === builtFor) return;
        builtFor = signature;

        if (mesh) { scene.remove(mesh); mesh.dispose(); }
        mesh = new THREE.InstancedMesh(nodeGeo, nodeMat, Math.max(1, ns.length));
        mesh.frustumCulled = false;
        // setColorAt allocates instanceColor on first use — seed every slot so
        // the attribute exists before the first frame writes to it.
        for (let i = 0; i < ns.length; i++) mesh.setColorAt(i, scratchColor.setRGB(1, 1, 1));
        scene.add(mesh);

        linkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, es.length) * 6), 3));
        linkGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(Math.max(1, es.length) * 6), 3));

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
      const frame = () => {
        if (disposed) return;
        raf = requestAnimationFrame(frame);
        const { nodes: ns, edges: es, settings: st, sim: s, selectedId: sel, highlightIds, pathIds, query: q } = live.current;
        rebuild();
        if (!mesh) return;

        const running = s.tick();
        if (!running && !wasSettled) { wasSettled = true; live.current.onSettled?.(); }
        if (running) wasSettled = false;

        hoverId = pick();
        const spotId = hoverId ?? sel;
        const neighbours = new Set<string>();
        if (spotId) {
          for (const e of es) {
            if (e.a === spotId) neighbours.add(e.b);
            if (e.b === spotId) neighbours.add(e.a);
          }
        }

        // Nodes
        for (let i = 0; i < ns.length; i++) {
          const n = ns[i];
          const p = s.get(n.id);
          if (!p) continue;
          const base = BASE_R[n.type] + Math.min(9, Math.sqrt(n.degree) * 1.1);
          const isSpot = spotId === n.id;
          const inPath = pathIds.has(n.id);
          const isGold = highlightIds.has(n.id);
          const matches = q.length >= 2 && n.label.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q);
          const emphasis = isSpot || inPath || isGold || matches ? 1.7 : 1;
          const size = base * 2.6 * st.nodeScale * emphasis;
          dummy.position.set(p.x, p.y, p.z);
          dummy.quaternion.copy(camera.quaternion);   // always face the camera
          dummy.scale.set(size, size, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);

          const hex = inPath ? "#22d3ee"
            : isGold ? "#eab308"
            : (groupColorFor(n, st.groups) ?? NODE_COLORS[n.type]);
          const [r, g, b] = hexToRgb(hex);
          // Dim everything outside the spotlight / search so the subject pops.
          let dim = 1;
          if (spotId && !isSpot && !neighbours.has(n.id) && !inPath) dim = 0.22;
          if (q.length >= 2 && !matches) dim = Math.min(dim, 0.18);
          if (isGold || inPath) dim = 1;
          mesh.setColorAt(i, scratchColor.setRGB(r * dim, g * dim, b * dim));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

        // Links
        const pos = linkGeo.getAttribute("position") as InstanceType<Three["BufferAttribute"]>;
        const col = linkGeo.getAttribute("color") as InstanceType<Three["BufferAttribute"]>;
        for (let i = 0; i < es.length; i++) {
          const e = es[i];
          const na = s.get(e.a), nb = s.get(e.b);
          if (!na || !nb) { pos.setXYZ(i * 2, 0, 0, 0); pos.setXYZ(i * 2 + 1, 0, 0, 0); continue; }
          pos.setXYZ(i * 2, na.x, na.y, na.z);
          pos.setXYZ(i * 2 + 1, nb.x, nb.y, nb.z);
          const rgb = EDGE_RGB[e.type as GraphEdgeType] ?? "148,163,184";
          const [r0, g0, b0] = rgb.split(",").map((v) => Number(v) / 255);
          const inSpot = !spotId || e.a === spotId || e.b === spotId;
          const onPath = pathIds.has(e.a) && pathIds.has(e.b);
          const k = (onPath ? 1.6 : inSpot ? 0.9 : 0.16) * st.linkOpacity;
          const [r, g, b] = onPath ? [0.13, 0.83, 0.93] : [r0, g0, b0];
          col.setXYZ(i * 2, r * k, g * k, b * k);
          col.setXYZ(i * 2 + 1, r * k, g * k, b * k);
        }
        pos.needsUpdate = true; col.needsUpdate = true;
        linkGeo.setDrawRange(0, es.length * 2);
        linkMat.opacity = 0.9;
        // three's LineBasicMaterial ignores linewidth on most platforms;
        // thickness is expressed through opacity instead, honestly.
        linkMat.opacity = Math.min(1, 0.35 + st.linkThickness * 0.35);

        // Labels — only what earns one, and capped.
        const want = new Set<string>();
        const camDist = spherical.radius;
        for (const n of ns) {
          const p = s.get(n.id);
          if (!p) continue;
          const matches = q.length >= 2 && n.label.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q);
          const near = camDist < 1400 && n.degree >= 4;
          if (spotId === n.id || neighbours.has(n.id) || matches || pathIds.has(n.id) || highlightIds.has(n.id) || near) {
            want.add(n.id);
            if (want.size > 120) break;
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
            sprite = makeLabelSprite(THREE, n.label.slice(0, 24), "#f8fafc");
            labelCache.set(id, sprite);
            labelLayer.add(sprite);
          }
          const base = BASE_R[n.type] + Math.min(9, Math.sqrt(n.degree) * 1.1);
          sprite.position.set(p.x, p.y + base * 2.2 + 6, p.z);
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
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("dblclick", onDouble);
        el.removeEventListener("contextmenu", onContext);
        for (const s of labelCache.values()) { s.material.map?.dispose(); s.material.dispose(); }
        mesh?.dispose();
        nodeGeo.dispose(); nodeMat.dispose();
        linkGeo.dispose(); linkMat.dispose();
        dot.dispose();
        renderer.dispose();
        if (el.parentNode === mount) mount.removeChild(el);
      };
    })();

    return () => { disposed = true; cleanup?.(); };
    // Mount once: everything dynamic is read through the `live` ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={mountRef} className="absolute inset-0 overflow-hidden bg-[#0b1020]">
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
