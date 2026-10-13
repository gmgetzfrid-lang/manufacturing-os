"use client";

// FileGraph — the document estate as a map you can read.
//
// A balloon tree: each library at the centre of its own cluster, folders
// on rings around it, files on rings around their folders. Every node is
// an icon on a coloured disc — a PDF looks like a PDF, a drawing like a
// drawing, a folder like a folder — with its name underneath. The layout
// is computed, not simulated: nothing drifts, nothing overlaps, and the
// same folder is in the same place every visit.
//
// Two things a folder list can't show:
//   * SAME BYTES — a dashed red arc between files whose hashes match.
//   * SEARCH LIGHT — with a search live, everything dims except the
//     candidates, ringed by verdict, so where the hits cluster is visible
//     before a single result is read.

import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { balloonLayout, layoutBounds, type Placed } from "@/lib/fileFinder/balloonLayout";
import type { FileTypeInfo } from "@/lib/fileFinder/fileTypes";
import { useIconImages, IconHost } from "./fileGraphIcons";

export type FileNodeKind = "library" | "folder" | "file" | "drive" | "extfolder" | "extfile";

export interface FileGraphNode {
  id: string;
  kind: FileNodeKind;
  label: string;
  parentId: string | null;
  childCount: number;
  type: FileTypeInfo;
}

export interface FileGraphLight {
  verdict: "strong" | "possible" | "weak" | "rejected";
  score: number;
}

export interface FileGraphHandle {
  fit: () => void;
  focus: (id: string) => void;
}

interface Props {
  nodes: FileGraphNode[];
  expanded: Set<string>;
  sameBytes: Map<string, string[]>;
  lit: Map<string, FileGraphLight>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  className?: string;
}

const RADIUS: Record<FileNodeKind, number> = { library: 24, drive: 24, folder: 17, extfolder: 17, file: 13, extfile: 13 };
const VERDICT: Record<FileGraphLight["verdict"], string> = {
  strong: "#16a34a", possible: "#eab308", weak: "#94a3b8", rejected: "#ef4444",
};
const isContainer = (k: FileNodeKind) => k !== "file" && k !== "extfile";

interface Camera { x: number; y: number; scale: number }

const FileGraph = React.forwardRef<FileGraphHandle, Props>(function FileGraph(
  { nodes, expanded, sameBytes, lit, selectedId, onSelect, onToggle, className = "" }, ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { images, hostRef } = useIconImages();
  const camRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const camTarget = useRef<Camera | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const drag = useRef<{ on: boolean; sx: number; sy: number; cx: number; cy: number; moved: boolean }>({ on: false, sx: 0, sy: 0, cx: 0, cy: 0, moved: false });

  // Latest props for the render loop, synced in effects.
  const litRef = useRef(lit); useEffect(() => { litRef.current = lit; }, [lit]);
  const selRef = useRef(selectedId); useEffect(() => { selRef.current = selectedId; }, [selectedId]);
  const hoverRef = useRef(hoverId); useEffect(() => { hoverRef.current = hoverId; }, [hoverId]);
  const imagesRef = useRef(images); useEffect(() => { imagesRef.current = images; }, [images]);
  const expandedRef = useRef(expanded); useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const visible = useMemo(() => {
    const out: FileGraphNode[] = [];
    for (const n of nodes) {
      let ok = true, p = n.parentId;
      const seen = new Set<string>();
      while (p && ok && !seen.has(p)) { seen.add(p); if (!expanded.has(p)) ok = false; p = byId.get(p)?.parentId ?? null; }
      if (ok) out.push(n);
    }
    return out;
  }, [nodes, expanded, byId]);
  const visibleRef = useRef(visible); useEffect(() => { visibleRef.current = visible; }, [visible]);

  // Target layout; current positions ease toward it.
  const target = useMemo(() => balloonLayout(
    visible.map((n) => ({ id: n.id, parentId: n.parentId, r: RADIUS[n.kind], labelPad: isContainer(n.kind) ? 16 : 14 })),
    { gap: 12 },
  ), [visible]);
  const targetRef = useRef(target);
  const posRef = useRef<Map<string, Placed>>(new Map());
  const fitted = useRef(false);
  function fitTo(pos: Map<string, Placed>) {
    const canvas = canvasRef.current;
    if (!canvas || !pos.size) return;
    const b = layoutBounds(pos, 60);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const scale = Math.min(2.5, Math.max(0.08, Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY))));
    camTarget.current = { scale, x: -((b.minX + b.maxX) / 2) * scale, y: -((b.minY + b.maxY) / 2) * scale };
  }
  useEffect(() => {
    targetRef.current = target;
    const pos = posRef.current;
    // New nodes appear where their parent is and grow outward.
    for (const [id, t] of target) {
      if (!pos.has(id)) {
        const parent = byId.get(id)?.parentId;
        const from = (parent && pos.get(parent)) || t;
        pos.set(id, { x: from.x, y: from.y });
      }
    }
    for (const id of [...pos.keys()]) if (!target.has(id)) pos.delete(id);
    if (!fitted.current && target.size) { fitted.current = true; fitTo(target); }
  }, [target, byId]);

  const sameEdges = useMemo(() => {
    const vis = new Set(visible.map((n) => n.id));
    const out: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const [a, list] of sameBytes) {
      if (!vis.has(a)) continue;
      for (const b of list) {
        if (!vis.has(b)) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!seen.has(key)) { seen.add(key); out.push([a, b]); }
      }
    }
    return out;
  }, [visible, sameBytes]);
  const sameRef = useRef(sameEdges); useEffect(() => { sameRef.current = sameEdges; }, [sameEdges]);

  useImperativeHandle(ref, () => ({
    fit: () => fitTo(targetRef.current),
    focus: (id: string) => {
      const p = targetRef.current.get(id);
      if (!p) return;
      const scale = Math.max(camRef.current.scale, 1.1);
      camTarget.current = { scale, x: -p.x * scale, y: -p.y * scale };
    },
  }), []);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      }
      // Ease positions and camera.
      const pos = posRef.current, tgt = targetRef.current;
      for (const [id, t] of tgt) {
        const p = pos.get(id);
        if (!p) continue;
        p.x += (t.x - p.x) * 0.16; p.y += (t.y - p.y) * 0.16;
      }
      const cam = camRef.current, ct = camTarget.current;
      if (ct) {
        cam.x += (ct.x - cam.x) * 0.18; cam.y += (ct.y - cam.y) * 0.18; cam.scale += (ct.scale - cam.scale) * 0.18;
        if (Math.abs(ct.x - cam.x) < 0.5 && Math.abs(ct.y - cam.y) < 0.5 && Math.abs(ct.scale - cam.scale) < 0.002) camTarget.current = null;
      }

      const litNow = litRef.current, searching = litNow.size > 0;
      const litPath = new Set<string>();
      if (searching) {
        for (const id of litNow.keys()) {
          let p = byId.get(id)?.parentId ?? null;
          const seen = new Set<string>();
          while (p && !seen.has(p)) { seen.add(p); litPath.add(p); p = byId.get(p)?.parentId ?? null; }
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2 + cam.x, h / 2 + cam.y);
      ctx.scale(cam.scale, cam.scale);
      const s = cam.scale;

      // Tree edges.
      ctx.lineWidth = Math.max(1, 1.2 / s);
      for (const n of visibleRef.current) {
        if (!n.parentId) continue;
        const a = pos.get(n.parentId), b = pos.get(n.id);
        if (!a || !b) continue;
        const bright = !searching || litNow.has(n.id) || litPath.has(n.id);
        ctx.strokeStyle = bright ? "rgba(100,116,139,0.55)" : "rgba(100,116,139,0.10)";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      // Same-bytes arcs.
      ctx.setLineDash([6 / s, 5 / s]);
      ctx.lineWidth = Math.max(1, 1.6 / s);
      for (const [ia, ib] of sameRef.current) {
        const a = pos.get(ia), b = pos.get(ib);
        if (!a || !b) continue;
        const bright = !searching || litNow.has(ia) || litNow.has(ib);
        ctx.strokeStyle = bright ? "rgba(220,38,38,0.75)" : "rgba(220,38,38,0.12)";
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const off = Math.min(120, len * 0.25);
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx - (dy / len) * off, my + (dx / len) * off, b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Nodes.
      const sel = selRef.current, hov = hoverRef.current, imgs = imagesRef.current, exp = expandedRef.current;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (const n of visibleRef.current) {
        const p = pos.get(n.id);
        if (!p) continue;
        const light = litNow.get(n.id);
        const dim = searching && !light && !litPath.has(n.id);
        const r = RADIUS[n.kind];
        ctx.globalAlpha = dim ? 0.22 : 1;
        if (light) {
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 9, 0, Math.PI * 2);
          ctx.fillStyle = VERDICT[light.verdict] + "40"; ctx.fill();
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = VERDICT[light.verdict]; ctx.lineWidth = 3; ctx.stroke();
        }
        // Disc.
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.type.color; ctx.fill();
        ctx.lineWidth = n.id === sel ? 3.5 : n.id === hov ? 2.5 : 1.5;
        ctx.strokeStyle = n.id === sel ? "#0ea5e9" : n.id === hov ? "#0ea5e9" : "rgba(255,255,255,0.9)";
        ctx.stroke();
        // Icon.
        const key = n.kind === "folder" || n.kind === "extfolder" ? (exp.has(n.id) ? "folderOpen" : "folder") : n.type.key;
        const img = imgs.get(key);
        const iconSize = r * 1.15;
        if (img) ctx.drawImage(img, p.x - iconSize / 2, p.y - iconSize / 2, iconSize, iconSize);
        // Collapsed count badge.
        if (isContainer(n.kind) && n.childCount > 0 && !exp.has(n.id)) {
          const bx = p.x + r * 0.75, by = p.y - r * 0.75, br = Math.max(7, r * 0.42);
          ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
          ctx.fillStyle = "#0f172a"; ctx.fill();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.max(8, br * 1.1)}px ui-sans-serif, system-ui`;
          ctx.textBaseline = "middle";
          ctx.fillText(n.childCount > 999 ? "999+" : String(n.childCount), bx, by);
          ctx.textBaseline = "top";
        }
        // Label.
        const showLabel = isContainer(n.kind) || light || n.id === sel || n.id === hov || s > 0.75;
        if (showLabel) {
          const container = isContainer(n.kind);
          const fontPx = container ? 12 : 11;
          ctx.font = `${container ? 700 : 500} ${fontPx}px ui-sans-serif, system-ui`;
          const label = n.label.length > 28 ? n.label.slice(0, 26) + "…" : n.label;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fillRect(p.x - tw / 2 - 3, p.y + r + 3, tw + 6, fontPx + 4);
          ctx.fillStyle = dim ? "rgba(51,65,85,0.5)" : container ? "#0f172a" : "#334155";
          ctx.fillText(label, p.x, p.y + r + 5);
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [byId]);

  // Wheel zoom around the cursor.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camTarget.current = null;
      const cam = camRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(4, Math.max(0.05, cam.scale * factor));
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
    return { x: (e.clientX - rect.left - rect.width / 2 - cam.x) / cam.scale, y: (e.clientY - rect.top - rect.height / 2 - cam.y) / cam.scale };
  };
  const hit = (wx: number, wy: number): string | null => {
    let best: string | null = null, bestD = Infinity;
    for (const n of visibleRef.current) {
      const p = posRef.current.get(n.id);
      if (!p) continue;
      const d = Math.hypot(p.x - wx, p.y - wy);
      const r = RADIUS[n.kind] + 4 / camRef.current.scale;
      if (d < r && d < bestD) { best = n.id; bestD = d; }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    camTarget.current = null;
    drag.current = { on: true, sx: e.clientX, sy: e.clientY, cx: camRef.current.x, cy: camRef.current.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.on) { const { x, y } = toWorld(e); setHoverId(hit(x, y)); return; }
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
    camRef.current.x = d.cx + (e.clientX - d.sx);
    camRef.current.y = d.cy + (e.clientY - d.sy);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = { on: false, sx: 0, sy: 0, cx: 0, cy: 0, moved: false };
    if (d.moved) return;
    const { x, y } = toWorld(e);
    const id = hit(x, y);
    onSelect(id);
    if (id) { const n = byId.get(id); if (n && isContainer(n.kind)) onToggle(id); }
  };

  const hoverNode = hoverId ? byId.get(hoverId) : null;

  return (
    <div className={`relative w-full h-full ${className}`}>
      <IconHost ref={hostRef} />
      <canvas
        ref={canvasRef}
        className={`w-full h-full touch-none ${hoverId ? "cursor-pointer" : "cursor-grab"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverId(null)}
      />
      {hoverNode && (
        <div className="pointer-events-none absolute top-3 right-3 max-w-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-2.5 py-1.5 text-xs shadow-sm">
          <div className="font-bold truncate">{hoverNode.label}</div>
          <div className="text-[var(--color-text-muted)]">{hoverNode.type.label}{isContainer(hoverNode.kind) ? ` · ${hoverNode.childCount} inside · click to ${expanded.has(hoverNode.id) ? "close" : "open"}` : ""}</div>
        </div>
      )}
    </div>
  );
});

export default FileGraph;
