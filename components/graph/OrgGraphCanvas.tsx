"use client";

// OrgGraphCanvas — a living force-directed map of the whole org, drawn on a
// single <canvas>. Obsidian-style: physics settle the web into clusters,
// wheel/pinch zooms about the cursor, drag pans, nodes drag, hover lights a
// neighborhood, labels fade in as you fly closer.
//
// Memory that never goes away: node positions are seeded deterministically
// from their ids and persisted to localStorage per org, so the map keeps its
// shape visit after visit — your crude unit lives where you left it.

import React from "react";
import type { GraphNode, GraphEdge, GraphNodeType, GraphEdgeType } from "@/lib/orgGraph";

export const NODE_COLORS: Record<GraphNodeType, string> = {
  document: "#3b82f6",
  asset:    "#10b981",
  unit:     "#8b5cf6",
  library:  "#f59e0b",
  project:  "#f43f5e",
  plant:    "#64748b",
};

const EDGE_COLORS: Record<GraphEdgeType, string> = {
  tag:          "148,163,184", // slate
  unit:         "139,92,246",  // violet
  library:      "245,158,11",  // amber
  project:      "244,63,94",   // rose
  related:      "124,58,237",  // deep violet — the human-curated layer
  supersession: "100,116,139",
};

const BASE_R: Record<GraphNodeType, number> = {
  document: 3.5, asset: 4, unit: 7, library: 6, project: 6, plant: 8,
};

interface SimNode extends GraphNode {
  x: number; y: number; vx: number; vy: number; r: number;
}

/** Deterministic position seed — same id lands in the same spot on every
 *  machine before physics even runs. */
function seed(id: string): { x: number; y: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const angle = ((h >>> 0) % 6283) / 1000;
  const radius = 120 + ((h >>> 11) % 900);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

const REST: Record<GraphEdgeType, number> = {
  tag: 80, unit: 110, library: 150, project: 120, related: 70, supersession: 60,
};

export default function OrgGraphCanvas({
  nodes, edges, focusId, query, onSelect, onOpen, storageKey, selectedId,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focusId?: string | null;
  /** Lowercased, punctuation-stripped search — matching nodes glow. */
  query: string;
  onSelect: (node: GraphNode | null) => void;
  onOpen: (node: GraphNode) => void;
  storageKey: string;
  selectedId: string | null;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  // All mutable sim state lives in refs — React renders once, physics runs
  // in rAF without re-render churn.
  const simRef = React.useRef<{
    nodes: SimNode[]; edges: GraphEdge[];
    byId: Map<string, SimNode>;
    neighbors: Map<string, Set<string>>;
    alpha: number; saved: boolean;
  }>({ nodes: [], edges: [], byId: new Map(), neighbors: new Map(), alpha: 1, saved: false });

  const camRef = React.useRef({ x: 0, y: 0, scale: 0.55 });
  const hoverRef = React.useRef<string | null>(null);
  const dragRef = React.useRef<{
    mode: "none" | "pan" | "node" | "pinch";
    nodeId?: string;
    sx: number; sy: number; camX: number; camY: number; moved: number;
  }>({ mode: "none", sx: 0, sy: 0, camX: 0, camY: 0, moved: 0 });
  const pointersRef = React.useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = React.useRef<{ dist: number; scale: number } | null>(null);
  const queryRef = React.useRef(query);
  const selectedRef = React.useRef<string | null>(selectedId);
  queryRef.current = query;
  selectedRef.current = selectedId;

  // ── Build / rebuild the simulation when data changes ─────────────────
  React.useEffect(() => {
    const sim = simRef.current;
    const prev = sim.byId;
    let stored: Record<string, [number, number]> = {};
    if (prev.size === 0) {
      try { stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { /* fresh */ }
    }
    const byId = new Map<string, SimNode>();
    const simNodes: SimNode[] = nodes.map((n) => {
      const old = prev.get(n.id);
      const mem = stored[n.id];
      const p = old ?? (mem ? { x: mem[0], y: mem[1] } : seed(n.id));
      const sn: SimNode = {
        ...n,
        x: p.x, y: p.y,
        vx: old?.vx ?? 0, vy: old?.vy ?? 0,
        r: BASE_R[n.type] + Math.min(9, Math.sqrt(n.degree) * 1.1),
      };
      byId.set(n.id, sn);
      return sn;
    });
    const neighbors = new Map<string, Set<string>>();
    const liveEdges = edges.filter((e) => byId.has(e.a) && byId.has(e.b));
    for (const e of liveEdges) {
      (neighbors.get(e.a) ?? neighbors.set(e.a, new Set()).get(e.a)!).add(e.b);
      (neighbors.get(e.b) ?? neighbors.set(e.b, new Set()).get(e.b)!).add(e.a);
    }
    sim.nodes = simNodes; sim.edges = liveEdges; sim.byId = byId;
    sim.neighbors = neighbors;
    sim.alpha = Math.max(sim.alpha, prev.size > 0 ? 0.35 : 1);
    sim.saved = false;
  }, [nodes, edges, storageKey]);

  // ── Fly to the focused node once it exists ───────────────────────────
  React.useEffect(() => {
    if (!focusId) return;
    const n = simRef.current.byId.get(focusId);
    if (!n) return;
    camRef.current = { x: n.x, y: n.y, scale: 1.4 };
  }, [focusId, nodes]);

  // ── Physics + paint loop ─────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let alive = true;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const tickPhysics = () => {
      const sim = simRef.current;
      if (sim.alpha < 0.004) {
        if (!sim.saved) {
          sim.saved = true;
          try {
            const pos: Record<string, [number, number]> = {};
            for (const n of sim.nodes) pos[n.id] = [Math.round(n.x), Math.round(n.y)];
            localStorage.setItem(storageKey, JSON.stringify(pos));
          } catch { /* storage full — the map just re-settles next visit */ }
        }
        return;
      }
      const a = sim.alpha;
      const CELL = 130;
      const grid = new Map<string, SimNode[]>();
      for (const n of sim.nodes) {
        const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push(n);
      }
      // Repulsion — grid-local so 3k nodes stay cheap.
      for (const n of sim.nodes) {
        const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL);
        let fx = 0, fy = 0;
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const cell = grid.get(`${gx},${gy}`);
            if (!cell) continue;
            for (const m of cell) {
              if (m === n) continue;
              const dx = n.x - m.x, dy = n.y - m.y;
              const d2 = dx * dx + dy * dy + 0.01;
              if (d2 > CELL * CELL) continue;
              const f = Math.min(12, (260 * (n.r + m.r) * 0.14) / d2);
              fx += dx * f; fy += dy * f;
            }
          }
        }
        // Weak centering keeps disconnected islands on screen.
        fx -= n.x * 0.0006; fy -= n.y * 0.0006;
        n.vx = (n.vx + fx * a) * 0.82;
        n.vy = (n.vy + fy * a) * 0.82;
      }
      // Springs.
      for (const e of sim.edges) {
        const na = sim.byId.get(e.a)!, nb = sim.byId.get(e.b)!;
        const dx = nb.x - na.x, dy = nb.y - na.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const k = ((d - REST[e.type]) / d) * 0.028 * a;
        const fx = dx * k, fy = dy * k;
        na.vx += fx; na.vy += fy;
        nb.vx -= fx; nb.vy -= fy;
      }
      const held = dragRef.current.mode === "node" ? dragRef.current.nodeId : null;
      for (const n of sim.nodes) {
        if (n.id === held) { n.vx = 0; n.vy = 0; continue; }
        const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (sp > 14) { n.vx = (n.vx / sp) * 14; n.vy = (n.vy / sp) * 14; }
        n.x += n.vx; n.y += n.vy;
      }
      sim.alpha *= 0.985;
    };

    const draw = () => {
      const sim = simRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr, h = canvas.height / dpr;
      const cam = camRef.current;
      const styles = getComputedStyle(document.documentElement);
      const textColor = styles.getPropertyValue("--color-text").trim() || "#334155";
      const bg = styles.getPropertyValue("--color-surface-2").trim() || "#f8fafc";

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      ctx.translate(w / 2, h / 2);
      ctx.scale(cam.scale, cam.scale);
      ctx.translate(-cam.x, -cam.y);

      const hover = hoverRef.current;
      const selected = selectedRef.current;
      const spotlightId = hover ?? selected;
      const spotlight = spotlightId ? sim.neighbors.get(spotlightId) ?? new Set<string>() : null;
      const q = queryRef.current;

      // Visible world bounds with margin, for culling.
      const half = { x: w / 2 / cam.scale + 60, y: h / 2 / cam.scale + 60 };

      ctx.lineWidth = 1 / cam.scale;
      for (const e of sim.edges) {
        const na = sim.byId.get(e.a)!, nb = sim.byId.get(e.b)!;
        if ((na.x < cam.x - half.x && nb.x < cam.x - half.x) || (na.x > cam.x + half.x && nb.x > cam.x + half.x) ||
            (na.y < cam.y - half.y && nb.y < cam.y - half.y) || (na.y > cam.y + half.y && nb.y > cam.y + half.y)) continue;
        let alpha = e.type === "related" ? 0.5 : e.type === "library" ? 0.10 : 0.18;
        if (spotlightId) {
          const inSpot = e.a === spotlightId || e.b === spotlightId;
          alpha = inSpot ? 0.75 : alpha * 0.15;
        }
        ctx.strokeStyle = `rgba(${EDGE_COLORS[e.type]},${alpha})`;
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.lineTo(nb.x, nb.y);
        ctx.stroke();
      }

      const labelable: SimNode[] = [];
      for (const n of sim.nodes) {
        if (n.x < cam.x - half.x || n.x > cam.x + half.x || n.y < cam.y - half.y || n.y > cam.y + half.y) continue;
        const isSpot = spotlightId === n.id;
        const isNeighbor = spotlight?.has(n.id) ?? false;
        const matches = q.length >= 2 && n.label.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q);
        let dim = 1;
        if (spotlightId && !isSpot && !isNeighbor) dim = 0.18;
        if (q.length >= 2 && !matches) dim = Math.min(dim, 0.15);

        ctx.globalAlpha = dim;
        ctx.fillStyle = NODE_COLORS[n.type];
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
        if (isSpot || matches || n.id === focusId) {
          ctx.strokeStyle = matches && !isSpot ? "#eab308" : textColor;
          ctx.lineWidth = 2 / cam.scale;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 2.5 / cam.scale, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1 / cam.scale;
        }
        ctx.globalAlpha = 1;

        const wantLabel = isSpot || isNeighbor || matches ||
          cam.scale * n.r > 7 || (n.degree >= 10 && cam.scale > 0.45);
        if (wantLabel && dim > 0.15) labelable.push(n);
      }

      // Labels last, capped so a zoomed-out frame never rasterizes thousands.
      const fontPx = Math.max(9, Math.min(13, 11 / cam.scale));
      ctx.font = `700 ${fontPx}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.fillStyle = textColor;
      for (const n of labelable.slice(0, 400)) {
        ctx.fillText(n.label.slice(0, 26), n.x, n.y - n.r - 4 / cam.scale);
      }
    };

    const loop = () => {
      if (!alive) return;
      tickPhysics();
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); };
  }, [storageKey, focusId]);

  // ── Coordinate helpers ───────────────────────────────────────────────
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cam = camRef.current;
    return {
      x: (clientX - rect.left - rect.width / 2) / cam.scale + cam.x,
      y: (clientY - rect.top - rect.height / 2) / cam.scale + cam.y,
    };
  };

  const hitTest = (clientX: number, clientY: number): SimNode | null => {
    const p = toWorld(clientX, clientY);
    const cam = camRef.current;
    const slop = 4 / cam.scale;
    let best: SimNode | null = null, bestD = Infinity;
    for (const n of simRef.current.nodes) {
      const dx = n.x - p.x, dy = n.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < n.r + slop && d < bestD) { best = n; bestD = d; }
    }
    return best;
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const cam = camRef.current;
    const before = toWorld(clientX, clientY);
    cam.scale = Math.min(6, Math.max(0.05, cam.scale * factor));
    const after = toWorld(clientX, clientY);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
  };

  // ── Input ────────────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [p1, p2] = [...pointersRef.current.values()];
      pinchRef.current = { dist: Math.hypot(p2.x - p1.x, p2.y - p1.y), scale: camRef.current.scale };
      dragRef.current.mode = "pinch";
      return;
    }
    const hit = hitTest(e.clientX, e.clientY);
    dragRef.current = {
      mode: hit ? "node" : "pan",
      nodeId: hit?.id,
      sx: e.clientX, sy: e.clientY,
      camX: camRef.current.x, camY: camRef.current.y,
      moved: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (drag.mode === "pinch" && pointersRef.current.size === 2 && pinchRef.current) {
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const target = pinchRef.current.scale * (dist / Math.max(1, pinchRef.current.dist));
      zoomAt(mid.x, mid.y, target / camRef.current.scale);
      return;
    }
    if (drag.mode === "none") {
      const hit = hitTest(e.clientX, e.clientY);
      hoverRef.current = hit?.id ?? null;
      canvasRef.current!.style.cursor = hit ? "pointer" : "grab";
      return;
    }
    drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (drag.mode === "pan") {
      camRef.current.x = drag.camX - (e.clientX - drag.sx) / camRef.current.scale;
      camRef.current.y = drag.camY - (e.clientY - drag.sy) / camRef.current.scale;
    } else if (drag.mode === "node" && drag.nodeId) {
      const n = simRef.current.byId.get(drag.nodeId);
      if (n) {
        const p = toWorld(e.clientX, e.clientY);
        n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
        simRef.current.alpha = Math.max(simRef.current.alpha, 0.12);
        simRef.current.saved = false;
      }
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    const drag = dragRef.current;
    if (drag.mode === "node" || drag.mode === "pan") {
      if (drag.moved < 5) {
        const node = drag.nodeId ? simRef.current.byId.get(drag.nodeId) ?? null : null;
        onSelect(node);
      }
    }
    dragRef.current = { mode: "none", sx: 0, sy: 0, camX: 0, camY: 0, moved: 0 };
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) onOpen(hit);
    else zoomAt(e.clientX, e.clientY, 1.6);
  };

  // Native non-passive wheel listener: React's synthetic wheel is passive,
  // which would let trackpad pinch (ctrl+wheel) zoom the whole browser page
  // instead of the graph.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const speed = e.ctrlKey ? 0.008 : 0.0016;
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * speed));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // zoomAt reads refs only — stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="block select-none"
        style={{ touchAction: "none", cursor: "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
