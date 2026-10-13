"use client";

// FileGraph — the document estate as a map you can walk.
//
// Libraries, folders and files on the shared physics engine, drawn as a
// tree you expand by clicking. Two things a folder list can't show:
//
//   * SAME BYTES — a dashed link between files whose hashes match, so one
//     drawing dropped into five folders under five names reads as one thing
//     in five places.
//   * SEARCH LIGHT — when a search is live, everything dims except the
//     candidates, coloured by verdict, so where the strong hits cluster is
//     visible before a single result is read.
//
// Canvas, not DOM: a few thousand nodes stay smooth.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { GraphSim } from "@/lib/graphSim";

export type FileNodeKind = "library" | "folder" | "file" | "drive" | "extfolder" | "extfile";

export interface FileGraphNode {
  id: string;
  kind: FileNodeKind;
  label: string;
  parentId: string | null;
  /** How many children (for the collapsed badge). */
  childCount: number;
}

export interface FileGraphLight {
  verdict: "strong" | "possible" | "weak" | "rejected";
  score: number;
}

interface Props {
  nodes: FileGraphNode[];
  /** ids of nodes whose children are shown. */
  expanded: Set<string>;
  /** file id → file ids with the same bytes (symmetric). */
  sameBytes: Map<string, string[]>;
  /** Search lighting; empty map = no search. */
  lit: Map<string, FileGraphLight>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  className?: string;
}

const COLORS: Record<FileNodeKind, string> = {
  library: "#7c3aed", folder: "#f59e0b", file: "#3b82f6",
  drive: "#0f766e", extfolder: "#14b8a6", extfile: "#67e8f9",
};
const RADIUS: Record<FileNodeKind, number> = {
  library: 11, folder: 7, file: 4, drive: 11, extfolder: 7, extfile: 4,
};
const VERDICT: Record<FileGraphLight["verdict"], string> = {
  strong: "#16a34a", possible: "#eab308", weak: "#94a3b8", rejected: "#ef4444",
};

interface Camera { x: number; y: number; scale: number }

export default function FileGraph({ nodes, expanded, sameBytes, lit, selectedId, onSelect, onToggle, className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<GraphSim>(new GraphSim({ linkDistance: 70, repelForce: 1.4, centerForce: 0.5 }));
  const camRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const drag = useRef<{ mode: "none" | "pan" | "node"; id?: string; sx: number; sy: number; cx: number; cy: number; moved: boolean }>({ mode: "none", sx: 0, sy: 0, cx: 0, cy: 0, moved: false });
  // The render loop runs outside React; it reads the latest props through
  // refs that are synced in effects (never during render).
  const litRef = useRef(lit);
  const selRef = useRef(selectedId);
  const hoverRef = useRef(hoverId);
  useEffect(() => { litRef.current = lit; }, [lit]);
  useEffect(() => { selRef.current = selectedId; }, [selectedId]);
  useEffect(() => { hoverRef.current = hoverId; }, [hoverId]);

  // Visible = every ancestor expanded.
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const visible = useMemo(() => {
    const out: FileGraphNode[] = [];
    for (const n of nodes) {
      let ok = true;
      let p = n.parentId;
      const seen = new Set<string>();
      while (p && ok && !seen.has(p)) { seen.add(p); if (!expanded.has(p)) ok = false; p = byId.get(p)?.parentId ?? null; }
      if (ok) out.push(n);
    }
    return out;
  }, [nodes, expanded, byId]);
  const visibleRef = useRef(visible);
  useEffect(() => { visibleRef.current = visible; }, [visible]);

  const edges = useMemo(() => {
    const vis = new Set(visible.map((n) => n.id));
    const out: Array<{ a: string; b: string; kind: "tree" | "same" }> = [];
    for (const n of visible) if (n.parentId && vis.has(n.parentId)) out.push({ a: n.parentId, b: n.id, kind: "tree" });
    const seen = new Set<string>();
    for (const [a, list] of sameBytes) {
      if (!vis.has(a)) continue;
      for (const b of list) {
        if (!vis.has(b)) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a, b, kind: "same" });
      }
    }
    return out;
  }, [visible, sameBytes]);
  const edgesRef = useRef(edges);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  useEffect(() => {
    simRef.current.setGraph(
      visible.map((n) => ({ id: n.id, mass: n.kind === "library" || n.kind === "drive" ? 6 : n.kind === "folder" || n.kind === "extfolder" ? 2.5 : 1 })),
      edges.map((e) => (e.kind === "tree"
        ? { a: e.a, b: e.b, distance: byId.get(e.b)?.kind === "file" || byId.get(e.b)?.kind === "extfile" ? 45 : 90 }
        : { a: e.a, b: e.b, strength: 0.15, distance: 160 })),
    );
  }, [visible, edges, byId]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const sim = simRef.current;
      sim.tick();
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      }
      const cam = camRef.current;
      const litNow = litRef.current;
      const searching = litNow.size > 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2 + cam.x, h / 2 + cam.y);
      ctx.scale(cam.scale, cam.scale);

      // Ancestors of lit nodes glow faintly so the path to a hit is readable.
      const litPath = new Set<string>();
      if (searching) {
        for (const id of litNow.keys()) {
          let p = byId.get(id)?.parentId ?? null;
          const seen = new Set<string>();
          while (p && !seen.has(p)) { seen.add(p); litPath.add(p); p = byId.get(p)?.parentId ?? null; }
        }
      }

      for (const e of edgesRef.current) {
        const a = sim.get(e.a), b = sim.get(e.b);
        if (!a || !b) continue;
        const dim = searching && !(litNow.has(e.a) || litNow.has(e.b) || (litPath.has(e.a) && litPath.has(e.b)) || (litPath.has(e.a) && litNow.has(e.b)));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        if (e.kind === "same") {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = dim ? "rgba(239,68,68,0.12)" : "rgba(239,68,68,0.7)";
          ctx.lineWidth = 1.2 / cam.scale;
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = dim ? "rgba(100,116,139,0.10)" : "rgba(100,116,139,0.45)";
          ctx.lineWidth = 1 / cam.scale;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const sel = selRef.current, hov = hoverRef.current;
      for (const n of visibleRef.current) {
        const sn = sim.get(n.id);
        if (!sn) continue;
        const light = litNow.get(n.id);
        const dim = searching && !light && !litPath.has(n.id);
        const r = RADIUS[n.kind] * (light ? 1.6 : 1);
        ctx.globalAlpha = dim ? 0.18 : 1;
        if (light) {
          ctx.beginPath(); ctx.arc(sn.x, sn.y, r + 5, 0, Math.PI * 2);
          ctx.fillStyle = VERDICT[light.verdict] + "33"; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(sn.x, sn.y, r, 0, Math.PI * 2);
        ctx.fillStyle = light ? VERDICT[light.verdict] : COLORS[n.kind];
        ctx.fill();
        if (n.id === sel || n.id === hov) {
          ctx.lineWidth = 2 / cam.scale; ctx.strokeStyle = "#0ea5e9"; ctx.stroke();
        }
        const isContainer = n.kind !== "file" && n.kind !== "extfile";
        if (isContainer && n.childCount > 0 && !expanded.has(n.id)) {
          ctx.fillStyle = "#fff"; ctx.font = `${Math.max(7, 9 / cam.scale)}px ui-sans-serif, system-ui`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(String(n.childCount), sn.x, sn.y);
        }
        const showLabel = isContainer || light || n.id === sel || n.id === hov || cam.scale > 1.6;
        if (showLabel) {
          ctx.font = `${isContainer ? 600 : 400} ${Math.max(9, 11 / cam.scale)}px ui-sans-serif, system-ui`;
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillStyle = dim ? "rgba(71,85,105,0.3)" : "#334155";
          const label = n.label.length > 36 ? n.label.slice(0, 34) + "…" : n.label;
          ctx.fillText(label, sn.x + r + 4, sn.y);
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [byId, expanded]);

  // Wheel zoom around the cursor.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(6, Math.max(0.15, cam.scale * factor));
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2, my = e.clientY - rect.top - rect.height / 2;
      cam.x = mx - (mx - cam.x) * (next / cam.scale);
      cam.y = my - (my - cam.y) * (next / cam.scale);
      cam.scale = next;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const toWorld = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const cam = camRef.current;
    return {
      x: (e.clientX - rect.left - rect.width / 2 - cam.x) / cam.scale,
      y: (e.clientY - rect.top - rect.height / 2 - cam.y) / cam.scale,
    };
  };
  const hit = (wx: number, wy: number): string | null => {
    const sim = simRef.current;
    let best: string | null = null, bestD = Infinity;
    for (const n of visibleRef.current) {
      const sn = sim.get(n.id);
      if (!sn) continue;
      const d = Math.hypot(sn.x - wx, sn.y - wy);
      const r = RADIUS[n.kind] + 6 / camRef.current.scale;
      if (d < r && d < bestD) { best = n.id; bestD = d; }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = toWorld(e);
    const id = hit(x, y);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode: id ? "node" : "pan", id: id ?? undefined, sx: e.clientX, sy: e.clientY, cx: camRef.current.x, cy: camRef.current.y, moved: false };
    if (id) { const sn = simRef.current.get(id); if (sn) sn.fixed = true; }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.mode === "none") { const { x, y } = toWorld(e); setHoverId(hit(x, y)); return; }
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
    if (d.mode === "pan") {
      camRef.current.x = d.cx + (e.clientX - d.sx);
      camRef.current.y = d.cy + (e.clientY - d.sy);
    } else if (d.id) {
      const sn = simRef.current.get(d.id);
      const { x, y } = toWorld(e);
      if (sn) { sn.x = x; sn.y = y; sn.vx = 0; sn.vy = 0; simRef.current.reheat(0.2); }
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.mode === "node" && d.id) {
      const sn = simRef.current.get(d.id);
      if (sn) sn.fixed = false;
      if (!d.moved) {
        const n = byId.get(d.id);
        onSelect(d.id);
        if (n && n.kind !== "file" && n.kind !== "extfile") onToggle(d.id);
      }
    } else if (d.mode === "pan" && !d.moved) {
      onSelect(null);
    }
    drag.current = { mode: "none", sx: 0, sy: 0, cx: 0, cy: 0, moved: false };
    void e;
  };

  return (
    <canvas
      ref={canvasRef}
      className={`w-full h-full touch-none ${hoverId ? "cursor-pointer" : "cursor-grab"} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHoverId(null)}
    />
  );
}
