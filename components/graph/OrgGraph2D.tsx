"use client";

// OrgGraph2D — the flat map, rebuilt on the shared simulation.
//
// Everything the 3D view does, minus depth, plus the things a 2D canvas can
// do better: crisp text, curved links that don't overlap, directional
// arrows, and hover halos. Camera moves are eased rather than teleporting,
// which is most of what makes a graph feel expensive rather than homemade.

import React from "react";
import type { GraphNode, GraphEdge, GraphNodeType, GraphEdgeType } from "@/lib/orgGraph";
import type { GraphSim } from "@/lib/graphSim";
import { groupColorFor, type GraphSettings } from "@/lib/graphSettings";
import { NODE_COLORS, EDGE_RGB, ACCENT } from "@/components/graph/graphTheme";

const BASE_R: Record<GraphNodeType, number> = {
  document: 3.5, asset: 4, unit: 7, library: 6, project: 6, plant: 8, plot: 6,
};

export interface Camera { x: number; y: number; scale: number }

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sim: GraphSim;
  settings: GraphSettings;
  query: string;
  selectedId: string | null;
  highlightIds: Set<string>;
  pathIds: Set<string>;
  regions: Array<{ label: string; ids: string[] }>;
  /** Set to fly the camera somewhere; bump `nonce` to re-fly the same target. */
  flyTo: { ids: string[]; nonce: number } | null;
  onSelect: (n: GraphNode | null) => void;
  onOpen: (n: GraphNode) => void;
  onSettled?: () => void;
}

export default function OrgGraph2D({
  nodes, edges, sim, settings, query, selectedId, highlightIds, pathIds,
  regions, flyTo, onSelect, onOpen, onSettled,
}: Props) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  const camRef = React.useRef<Camera>({ x: 0, y: 0, scale: 0.55 });
  // Eased camera: we render toward this target instead of snapping to it.
  const camTargetRef = React.useRef<Camera | null>(null);
  const hoverRef = React.useRef<string | null>(null);
  const dragRef = React.useRef<{
    mode: "none" | "pan" | "node" | "pinch";
    nodeId?: string; sx: number; sy: number; camX: number; camY: number; moved: number;
  }>({ mode: "none", sx: 0, sy: 0, camX: 0, camY: 0, moved: 0 });
  const pointersRef = React.useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = React.useRef<{ dist: number; scale: number } | null>(null);
  // Node scale-in animation: id → 0..1 progress, so new nodes grow in.
  const bornRef = React.useRef(new Map<string, number>());

  const live = React.useRef({ nodes, edges, sim, settings, query, selectedId, highlightIds, pathIds, regions, onSelect, onOpen, onSettled });
  live.current = { nodes, edges, sim, settings, query, selectedId, highlightIds, pathIds, regions, onSelect, onOpen, onSettled };

  // ── Fly to a set of nodes ──────────────────────────────────────────────
  React.useEffect(() => {
    if (!flyTo || flyTo.ids.length === 0) return;
    const pts = flyTo.ids.map((id) => sim.get(id)).filter(Boolean) as Array<{ x: number; y: number }>;
    if (pts.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const box = wrapRef.current?.getBoundingClientRect();
    const spanX = Math.max(80, maxX - minX), spanY = Math.max(80, maxY - minY);
    const fit = box ? Math.min((box.width * 0.6) / spanX, (box.height * 0.6) / spanY) : 1;
    camTargetRef.current = {
      x: (minX + maxX) / 2, y: (minY + maxY) / 2,
      scale: Math.min(1.8, Math.max(0.3, fit)),
    };
  }, [flyTo, sim]);

  // ── Render loop ────────────────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0, alive = true, wasSettled = false;

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

    const draw = () => {
      if (!alive) return;
      raf = requestAnimationFrame(draw);
      const { nodes: ns, edges: es, sim: s, settings: st, query: q, selectedId: sel, highlightIds, pathIds, regions: regs } = live.current;

      const running = s.tick();
      if (!running && !wasSettled) { wasSettled = true; live.current.onSettled?.(); }
      if (running) wasSettled = false;

      // Ease the camera toward its target — never teleport.
      const cam = camRef.current, tgt = camTargetRef.current;
      if (tgt) {
        cam.x += (tgt.x - cam.x) * 0.12;
        cam.y += (tgt.y - cam.y) * 0.12;
        cam.scale += (tgt.scale - cam.scale) * 0.12;
        if (Math.abs(tgt.x - cam.x) < 0.5 && Math.abs(tgt.y - cam.y) < 0.5 &&
            Math.abs(tgt.scale - cam.scale) < 0.002) camTargetRef.current = null;
      }

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr, h = canvas.height / dpr;
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
      const spotId = hover ?? sel;
      const neighbours = new Set<string>();
      if (spotId) {
        for (const e of es) {
          if (e.a === spotId) neighbours.add(e.b);
          if (e.b === spotId) neighbours.add(e.a);
        }
      }
      const half = { x: w / 2 / cam.scale + 80, y: h / 2 / cam.scale + 80 };
      const visible = (x: number, y: number) =>
        x > cam.x - half.x && x < cam.x + half.x && y > cam.y - half.y && y < cam.y + half.y;

      // ── Region names, faint, only when zoomed out ────────────────────
      if (cam.scale < 1.1 && regs.length > 0) {
        ctx.textAlign = "center";
        for (const region of regs) {
          let sx = 0, sy = 0, count = 0;
          for (const id of region.ids) {
            const p = s.get(id);
            if (p) { sx += p.x; sy += p.y; count++; }
          }
          if (count < 3) continue;
          const cx = sx / count, cy = sy / count;
          if (!visible(cx, cy)) continue;
          ctx.globalAlpha = Math.min(0.3, Math.max(0, (1.1 - cam.scale) * 0.5));
          ctx.fillStyle = textColor;
          ctx.font = `900 ${Math.min(64, 22 / cam.scale)}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillText(region.label.slice(0, 28).toUpperCase(), cx, cy);
          ctx.globalAlpha = 1;
        }
      }

      // ── Links ────────────────────────────────────────────────────────
      ctx.lineCap = "round";
      for (const e of es) {
        const na = s.get(e.a), nb = s.get(e.b);
        if (!na || !nb) continue;
        if (!visible(na.x, na.y) && !visible(nb.x, nb.y)) continue;

        const onPath = pathIds.has(e.a) && pathIds.has(e.b);
        const inSpot = !spotId || e.a === spotId || e.b === spotId;
        const proposed = e.type === "proposed";

        let alpha = proposed ? 0.55 : e.type === "related" ? 0.5 : e.type === "library" ? 0.1 : 0.2;
        if (spotId) alpha = inSpot ? 0.8 : alpha * 0.16;
        if (onPath) alpha = 1;
        alpha *= st.linkOpacity;

        const rgb = onPath ? "34,211,238" : EDGE_RGB[e.type as GraphEdgeType] ?? "148,163,184";
        ctx.strokeStyle = `rgba(${rgb},${alpha})`;
        ctx.lineWidth = ((onPath ? 2.6 : 1) * st.linkThickness) / cam.scale;
        if (proposed) ctx.setLineDash([6 / cam.scale, 5 / cam.scale]);

        // Curved links separate parallel relationships and simply look better.
        const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
        const dx = nb.x - na.x, dy = nb.y - na.y;
        const len = Math.hypot(dx, dy) || 1;
        const bow = st.curvedLinks ? Math.min(28, len * 0.12) : 0;
        const cxp = mx - (dy / len) * bow, cyp = my + (dx / len) * bow;

        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        if (bow > 0) ctx.quadraticCurveTo(cxp, cyp, nb.x, nb.y);
        else ctx.lineTo(nb.x, nb.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Direction, where direction means something.
        if (st.showArrows && (alpha > 0.3) && (e.type === "supersession" || e.type === "related" || onPath)) {
          const tipX = nb.x, tipY = nb.y;
          const fromX = bow > 0 ? cxp : na.x, fromY = bow > 0 ? cyp : na.y;
          const ang = Math.atan2(tipY - fromY, tipX - fromX);
          const rN = BASE_R[ns.find((n) => n.id === e.b)?.type ?? "document"] + 3;
          const ax = tipX - Math.cos(ang) * rN, ay = tipY - Math.sin(ang) * rN;
          const size = 7 / cam.scale;
          ctx.fillStyle = `rgba(${rgb},${Math.min(1, alpha + 0.2)})`;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - Math.cos(ang - 0.4) * size, ay - Math.sin(ang - 0.4) * size);
          ctx.lineTo(ax - Math.cos(ang + 0.4) * size, ay - Math.sin(ang + 0.4) * size);
          ctx.closePath();
          ctx.fill();
        }
      }

      // ── Nodes ────────────────────────────────────────────────────────
      const born = bornRef.current;
      const labelable: Array<{ n: GraphNode; x: number; y: number; r: number }> = [];
      for (const n of ns) {
        const p = s.get(n.id);
        if (!p || !visible(p.x, p.y)) continue;

        // Grow-in: a node that just appeared scales up rather than popping.
        let grow = born.get(n.id) ?? 0;
        if (grow < 1) { grow = Math.min(1, grow + 0.08); born.set(n.id, grow); }
        const ease = grow * grow * (3 - 2 * grow);

        const isSpot = spotId === n.id;
        const isNeighbour = neighbours.has(n.id);
        const isGold = highlightIds.has(n.id);
        const inPath = pathIds.has(n.id);
        const matches = q.length >= 2 && n.label.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(q);

        let dim = 1;
        if (spotId && !isSpot && !isNeighbour && !inPath) dim = 0.18;
        if (q.length >= 2 && !matches) dim = Math.min(dim, 0.15);
        if (isGold || inPath) dim = 1;

        const r = (BASE_R[n.type] + Math.min(9, Math.sqrt(n.degree) * 1.1)) * st.nodeScale * ease;
        const color = inPath ? ACCENT.path
          : isGold ? ACCENT.found
          : (groupColorFor(n, st.groups) ?? NODE_COLORS[n.type]);

        // Halo — the cheap trick that reads as "expensive".
        if (st.glow && (isSpot || isGold || inPath || matches)) {
          const glow = ctx.createRadialGradient(p.x, p.y, r * 0.4, p.x, p.y, r * 3.2);
          glow.addColorStop(0, `${color}66`);
          glow.addColorStop(1, `${color}00`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.globalAlpha = dim;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();

        if (isSpot || matches || isGold || inPath) {
          ctx.strokeStyle = inPath ? ACCENT.path : (isGold || matches) && !isSpot ? ACCENT.search : textColor;
          ctx.lineWidth = (inPath || isGold ? 2.5 : 2) / cam.scale;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 3 / cam.scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        const wantLabel = isSpot || isNeighbour || matches || isGold || inPath ||
          cam.scale > st.labelThreshold * (n.degree >= 8 ? 0.6 : 1.6);
        if (wantLabel && dim > 0.15) labelable.push({ n, x: p.x, y: p.y, r });
      }

      // ── Labels last, so nothing draws over them ──────────────────────
      const fontPx = Math.max(9, Math.min(13, 11 / cam.scale));
      ctx.font = `700 ${fontPx}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      for (const { n, x, y, r } of labelable.slice(0, 400)) {
        const label = n.label.slice(0, 26);
        // A soft plate behind the text keeps it readable over dense webs.
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = `${bg}cc`;
        ctx.fillRect(x - tw / 2 - 2, y - r - 4 - fontPx, tw + 4, fontPx + 2);
        ctx.fillStyle = textColor;
        ctx.fillText(label, x, y - r - 5);
      }

      // Clean up grow-in state for nodes that left.
      if (born.size > ns.length * 2 + 50) {
        const living = new Set(ns.map((n) => n.id));
        for (const id of born.keys()) if (!living.has(id)) born.delete(id);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // ── Input ──────────────────────────────────────────────────────────────
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cam = camRef.current;
    return {
      x: (clientX - rect.left - rect.width / 2) / cam.scale + cam.x,
      y: (clientY - rect.top - rect.height / 2) / cam.scale + cam.y,
    };
  };

  const hitTest = (clientX: number, clientY: number): GraphNode | null => {
    const p = toWorld(clientX, clientY);
    const cam = camRef.current;
    const slop = 5 / cam.scale;
    let best: GraphNode | null = null, bestD = Infinity;
    for (const n of live.current.nodes) {
      const sp = live.current.sim.get(n.id);
      if (!sp) continue;
      const r = (BASE_R[n.type] + Math.min(9, Math.sqrt(n.degree) * 1.1)) * live.current.settings.nodeScale;
      const d = Math.hypot(sp.x - p.x, sp.y - p.y);
      if (d < r + slop && d < bestD) { best = n; bestD = d; }
    }
    return best;
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const cam = camRef.current;
    camTargetRef.current = null;      // a manual zoom cancels any fly-to
    const before = toWorld(clientX, clientY);
    cam.scale = Math.min(6, Math.max(0.05, cam.scale * factor));
    const after = toWorld(clientX, clientY);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
  };

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0016)));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    camTargetRef.current = null;
    dragRef.current = {
      mode: hit ? "node" : "pan", nodeId: hit?.id,
      sx: e.clientX, sy: e.clientY,
      camX: camRef.current.x, camY: camRef.current.y, moved: 0,
    };
    if (hit) {
      const sn = live.current.sim.get(hit.id);
      if (sn) sn.fixed = true;
    }
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
      const sn = live.current.sim.get(drag.nodeId);
      if (sn) {
        const p = toWorld(e.clientX, e.clientY);
        sn.x = p.x; sn.y = p.y; sn.vx = 0; sn.vy = 0;
        live.current.sim.reheat(0.2);
      }
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    const drag = dragRef.current;
    if (drag.nodeId) {
      const sn = live.current.sim.get(drag.nodeId);
      // Release the node back to physics — a drag positions, it doesn't pin.
      if (sn) sn.fixed = false;
    }
    if ((drag.mode === "node" || drag.mode === "pan") && drag.moved < 5) {
      const node = drag.nodeId ? live.current.nodes.find((n) => n.id === drag.nodeId) ?? null : null;
      live.current.onSelect(node);
    }
    dragRef.current = { mode: "none", sx: 0, sy: 0, camX: 0, camY: 0, moved: 0 };
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) live.current.onOpen(hit);
    else zoomAt(e.clientX, e.clientY, 1.6);
  };

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
