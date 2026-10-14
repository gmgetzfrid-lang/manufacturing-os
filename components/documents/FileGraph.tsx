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
// Exploring, not admiring: click a folder and it becomes the root of the
// view — everything outside it is gone, its contents fan out, the camera
// fits. A dim "up" node above the root climbs back out; the page's
// breadcrumbs jump anywhere on the way. Click a file to zoom to it and see
// its details; double-click to open it.
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
  /** A small pill under the label — the unit this node is linked to. */
  badge?: string;
  /** Equipment linked to it: a green count on the icon's shoulder. */
  equipment?: number;
}

export interface FileGraphLight {
  verdict: "strong" | "possible" | "weak" | "rejected";
  score: number;
}

/** An entity the search resolved (equipment, unit, project), drawn beside the
 *  files it relates to with a dashed line per relationship. */
export interface FileGraphSatellite {
  id: string;
  label: string;
  sub?: string;
  color: string;
  iconKey: FileTypeInfo["key"];
  href?: string;
  /** "named" is the fallback: the entity resolved but no result is linked to it yet, so it sits beside the top hits. */
  links: Array<{ to: string; kind: "drawn_on" | "mentioned_in" | "tagged_to" | "filed_under" | "in_project" | "linked_unit" | "named" }>;
}

export interface FileGraphHandle {
  fit: () => void;
  /** Fly the camera to a node; `scale` is the zoom to land at. */
  focus: (id: string, scale?: number) => void;
}

interface Props {
  /** The nodes to draw — the page decides what is in view. */
  visible: FileGraphNode[];
  /** Containers in view whose children are not all in view (badge + "click to explore"). */
  collapsed: Set<string>;
  /** The node above the current root, drawn dim as the way back up. */
  upNode: FileGraphNode | null;
  sameBytes: Map<string, string[]>;
  lit: Map<string, FileGraphLight>;
  /** Rank numbers to print on the best hits (1 = best). */
  ranks?: Map<string, number>;
  /** The result being looked at right now: drawn with the strongest ring. */
  activeId?: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A container was clicked: make it the root of the view. */
  onDrill: (id: string) => void;
  onUp: () => void;
  /** A file was double-clicked. */
  onOpen: (id: string) => void;
  satellites?: FileGraphSatellite[];
  onSatellite?: (s: FileGraphSatellite) => void;
  /** Symbolic links: [document id, folder id] pairs ("also filed under"). */
  filedLinks?: Array<[string, string]>;
  className?: string;
}

const RADIUS: Record<FileNodeKind, number> = { library: 24, drive: 24, folder: 17, extfolder: 17, file: 13, extfile: 13 };
const VERDICT: Record<FileGraphLight["verdict"], string> = {
  strong: "#16a34a", possible: "#eab308", weak: "#94a3b8", rejected: "#ef4444",
};
const isContainer = (k: FileNodeKind) => k !== "file" && k !== "extfile";

interface Camera { x: number; y: number; scale: number }

const FileGraph = React.forwardRef<FileGraphHandle, Props>(function FileGraph(
  { visible, collapsed, upNode, sameBytes, lit, ranks, activeId = null, selectedId, onSelect, onDrill, onUp, onOpen, satellites = [], onSatellite, filedLinks = [], className = "" }, ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { images, hostRef } = useIconImages();
  const camRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const camTarget = useRef<Camera | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverAt, setHoverAt] = useState<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 0, h: 0 });
  const drag = useRef<{ on: boolean; sx: number; sy: number; cx: number; cy: number; moved: boolean }>({ on: false, sx: 0, sy: 0, cx: 0, cy: 0, moved: false });

  // Latest props for the render loop, synced in effects.
  const litRef = useRef(lit); useEffect(() => { litRef.current = lit; }, [lit]);
  const selRef = useRef(selectedId); useEffect(() => { selRef.current = selectedId; }, [selectedId]);
  const hoverRef = useRef(hoverId); useEffect(() => { hoverRef.current = hoverId; }, [hoverId]);
  const imagesRef = useRef(images); useEffect(() => { imagesRef.current = images; }, [images]);
  const collapsedRef = useRef(collapsed); useEffect(() => { collapsedRef.current = collapsed; }, [collapsed]);
  const ranksRef = useRef(ranks); useEffect(() => { ranksRef.current = ranks; }, [ranks]);
  const activeRef = useRef(activeId); useEffect(() => { activeRef.current = activeId; }, [activeId]);
  const satRef = useRef(satellites); useEffect(() => { satRef.current = satellites; }, [satellites]);
  const filedRef = useRef(filedLinks); useEffect(() => { filedRef.current = filedLinks; }, [filedLinks]);
  /** Satellite positions, recomputed each frame from the files they link to. */
  const satPos = useRef<Map<string, Placed>>(new Map());
  const upRef = useRef(upNode); useEffect(() => { upRef.current = upNode; }, [upNode]);

  const byId = useMemo(() => new Map(visible.map((n) => [n.id, n])), [visible]);
  const visibleRef = useRef(visible); useEffect(() => { visibleRef.current = visible; }, [visible]);

  // Target layout; current positions ease toward it.
  const target = useMemo(() => balloonLayout(
    visible.map((n) => ({ id: n.id, parentId: n.parentId && byId.has(n.parentId) ? n.parentId : null, r: RADIUS[n.kind], labelPad: isContainer(n.kind) ? 16 : 14 })),
    { gap: 12 },
  ), [visible, byId]);
  /** Where the "up" node sits: above the whole layout, over the root. */
  const upPos = useMemo<Placed | null>(() => {
    if (!upNode || !target.size) return null;
    const b = layoutBounds(target, 0);
    const root = visible.find((n) => !n.parentId || !byId.has(n.parentId));
    const rp = root ? target.get(root.id) : null;
    return { x: rp?.x ?? (b.minX + b.maxX) / 2, y: b.minY - 70 };
  }, [upNode, target, visible, byId]);
  const upPosRef = useRef(upPos); useEffect(() => { upPosRef.current = upPos; }, [upPos]);
  const targetRef = useRef(target);
  const posRef = useRef<Map<string, Placed>>(new Map());
  const fitted = useRef(false);
  function fitTo(pos: Map<string, Placed>, up?: Placed | null) {
    const canvas = canvasRef.current;
    if (!canvas || !pos.size) return;
    const b = layoutBounds(pos, 60);
    if (up) b.minY = Math.min(b.minY, up.y - 50);
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
    // Every change of what is in view re-fits: a drill-down lands framed.
    if (target.size) { fitted.current = true; fitTo(target, upPosRef.current); }
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
    fit: () => fitTo(targetRef.current, upPosRef.current),
    focus: (id: string, scale?: number) => {
      const p = targetRef.current.get(id);
      if (!p) return;
      const z = scale ?? Math.max(camRef.current.scale, 1.1);
      camTarget.current = { scale: z, x: -p.x * z, y: -p.y * z };
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

      // The way up: a dim node above the root.
      const up = upRef.current, upP = upPosRef.current;
      const rootNode = visibleRef.current.find((n) => !n.parentId || !byId.has(n.parentId));
      const rootP = rootNode ? pos.get(rootNode.id) : null;
      if (up && upP && rootP) {
        ctx.setLineDash([4 / s, 4 / s]);
        ctx.strokeStyle = "rgba(100,116,139,0.45)"; ctx.lineWidth = Math.max(1, 1.2 / s);
        ctx.beginPath(); ctx.moveTo(upP.x, upP.y); ctx.lineTo(rootP.x, rootP.y); ctx.stroke();
        ctx.setLineDash([]);
        const r = RADIUS[up.kind] * 0.8;
        ctx.globalAlpha = hoverRef.current === "__up__" ? 0.95 : 0.5;
        ctx.beginPath(); ctx.arc(upP.x, upP.y, r, 0, Math.PI * 2);
        ctx.fillStyle = up.type.color; ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.5; ctx.stroke();
        const img = imagesRef.current.get(up.kind === "folder" || up.kind === "extfolder" ? "folderOpen" : up.type.key);
        if (img) ctx.drawImage(img, upP.x - r * 0.6, upP.y - r * 0.6, r * 1.2, r * 1.2);
        ctx.font = "600 11px ui-sans-serif, system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillStyle = "#334155";
        ctx.fillText(`↑ ${up.label.length > 24 ? up.label.slice(0, 22) + "…" : up.label}`, upP.x, upP.y + r + 4);
        ctx.globalAlpha = 1;
      }

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
      // Also-filed-under: amber dashed arcs from a file to its other home.
      ctx.setLineDash([3 / s, 4 / s]); ctx.lineWidth = Math.max(1, 1.4 / s);
      for (const [docId, folderId] of filedRef.current) {
        const a = pos.get(docId), b = pos.get(folderId);
        if (!a || !b) continue;
        const bright = !searching || litNow.has(docId);
        ctx.strokeStyle = bright ? "rgba(217,119,6,0.8)" : "rgba(217,119,6,0.15)";
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const off = Math.min(100, len * 0.2);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx + (dy / len) * off, my - (dx / len) * off, b.x, b.y); ctx.stroke();
      }
      ctx.setLineDash([]);

      // Satellites: each sits beside the centroid of the visible files it
      // relates to, spread around it so several never overlap.
      const sats = satRef.current;
      const satsHere = sats.filter((sat) => sat.links.some((l) => pos.has(l.to)));
      // One ring for all of them, never overlapping: the ring sits outside
      // everything they link to, each marker gets an arc as wide as its
      // label, and they keep the order of the direction their files lie in,
      // so each sits near its own files. Turned away from the "up" button.
      const upHere = upPosRef.current;
      const centroids = new Map<string, { x: number; y: number }>();
      let ax = 0, ay = 0, an = 0;
      for (const sat of satsHere) {
        let cx = 0, cy = 0, n = 0;
        for (const l of sat.links) { const p = pos.get(l.to); if (p) { cx += p.x; cy += p.y; n++; ax += p.x; ay += p.y; an++; } }
        if (n) centroids.set(sat.id, { x: cx / n, y: cy / n });
      }
      const anchor = an ? { x: ax / an, y: ay / an } : { x: 0, y: 0 };
      let reach = 0;
      for (const sat of satsHere) for (const l of sat.links) { const p = pos.get(l.to); if (p) reach = Math.max(reach, Math.hypot(p.x - anchor.x, p.y - anchor.y)); }
      ctx.font = "800 12px ui-sans-serif, system-ui";
      const arcOf = (sat: FileGraphSatellite) => Math.max(66, ctx.measureText(sat.label).width + 16);
      const total = satsHere.reduce((a, sat) => a + arcOf(sat), 0);
      const radius = Math.max(reach + 70, total / (2 * Math.PI));
      const gap = upHere ? Math.atan2(upHere.y - anchor.y, upHere.x - anchor.x) : -Math.PI / 2;
      const dirOf = (sat: FileGraphSatellite) => { const c = centroids.get(sat.id) ?? anchor; const a = Math.atan2(c.y - anchor.y, c.x - anchor.x) - gap; return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); };
      const ordered = [...satsHere].sort((a, b) => dirOf(a) - dirOf(b));
      const slot = new Map<string, number>();
      {
        // Spread the free arc evenly so the gap at the "up" side stays clear.
        const free = Math.max(0, 2 * Math.PI * radius - total);
        let at = free / 2;
        for (const sat of ordered) { const w = arcOf(sat); slot.set(sat.id, gap + (at + w / 2) / radius); at += w; }
      }
      satsHere.forEach((sat) => {
        if (!centroids.has(sat.id)) return;
        const ang = slot.get(sat.id) ?? 0;
        const target = { x: anchor.x + Math.cos(ang) * radius, y: anchor.y + Math.sin(ang) * radius };
        const cur = satPos.current.get(sat.id) ?? target;
        cur.x += (target.x - cur.x) * 0.2; cur.y += (target.y - cur.y) * 0.2;
        satPos.current.set(sat.id, cur);
        const LINK: Record<string, string> = { drawn_on: "rgba(14,165,233,0.8)", mentioned_in: "rgba(99,102,241,0.8)", tagged_to: "rgba(16,185,129,0.8)", filed_under: "rgba(217,119,6,0.8)", in_project: "rgba(245,158,11,0.8)", linked_unit: "rgba(124,58,237,0.8)", named: "rgba(148,163,184,0.5)" };
        ctx.setLineDash([5 / s, 4 / s]); ctx.lineWidth = Math.max(1, 1.4 / s);
        for (const l of sat.links) {
          const p = pos.get(l.to);
          if (!p) continue;
          ctx.strokeStyle = LINK[l.kind] ?? "rgba(100,116,139,0.6)";
          ctx.beginPath(); ctx.moveTo(cur.x, cur.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        }
        ctx.setLineDash([]);
        const r = 20;
        ctx.beginPath(); ctx.arc(cur.x, cur.y, r + 6, 0, Math.PI * 2); ctx.fillStyle = sat.color + "33"; ctx.fill();
        ctx.beginPath(); ctx.arc(cur.x, cur.y, r, 0, Math.PI * 2); ctx.fillStyle = sat.color; ctx.fill();
        ctx.lineWidth = hoverRef.current === `sat:${sat.id}` ? 3 : 1.5; ctx.strokeStyle = hoverRef.current === `sat:${sat.id}` ? "#0ea5e9" : "rgba(255,255,255,0.95)"; ctx.stroke();
        const img = imagesRef.current.get(sat.iconKey);
        if (img) ctx.drawImage(img, cur.x - r * 0.6, cur.y - r * 0.6, r * 1.2, r * 1.2);
        ctx.font = "800 12px ui-sans-serif, system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        const tw = ctx.measureText(sat.label).width;
        ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(cur.x - tw / 2 - 3, cur.y + r + 3, tw + 6, 16);
        ctx.fillStyle = "#0f172a"; ctx.fillText(sat.label, cur.x, cur.y + r + 5);
      });
      for (const sat of sats) if (!satsHere.includes(sat)) satPos.current.delete(sat.id);

      // Nodes.
      const sel = selRef.current, hov = hoverRef.current, imgs = imagesRef.current, col = collapsedRef.current;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (const n of visibleRef.current) {
        const p = pos.get(n.id);
        if (!p) continue;
        const light = litNow.get(n.id);
        const active = n.id === activeRef.current;
        const dim = searching && !light && !litPath.has(n.id);
        const r = RADIUS[n.kind];
        ctx.globalAlpha = dim ? 0.22 : 1;
        if (light) {
          ctx.beginPath(); ctx.arc(p.x, p.y, r + (active ? 14 : 9), 0, Math.PI * 2);
          ctx.fillStyle = VERDICT[light.verdict] + (active ? "55" : "40"); ctx.fill();
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = VERDICT[light.verdict]; ctx.lineWidth = active ? 5 : 3; ctx.stroke();
          if (active) {
            ctx.beginPath(); ctx.arc(p.x, p.y, r + 10, 0, Math.PI * 2);
            ctx.strokeStyle = "#0ea5e9"; ctx.lineWidth = 2.5; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
          }
        }
        // Disc.
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.type.color; ctx.fill();
        ctx.lineWidth = n.id === sel ? 3.5 : n.id === hov ? 2.5 : 1.5;
        ctx.strokeStyle = n.id === sel ? "#0ea5e9" : n.id === hov ? "#0ea5e9" : "rgba(255,255,255,0.9)";
        ctx.stroke();
        // Icon.
        // Folders show open or closed; any other container (an operating
        // area, an equipment type, a piece of equipment) keeps its own icon.
        const plainFolder = (n.kind === "folder" || n.kind === "extfolder") && (n.type.key === "folder" || n.type.key === "folderOpen");
        const key = plainFolder ? (col.has(n.id) ? "folder" : "folderOpen") : n.type.key;
        const img = imgs.get(key);
        const iconSize = r * 1.15;
        if (img) ctx.drawImage(img, p.x - iconSize / 2, p.y - iconSize / 2, iconSize, iconSize);
        // Rank badge on the best hits: "1" is what you are after.
        const rank = ranksRef.current?.get(n.id);
        if (rank) {
          const bx = p.x - r * 0.85, by = p.y - r * 0.85, br = Math.max(8, r * 0.5);
          ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
          ctx.fillStyle = active ? "#0ea5e9" : "#0f172a"; ctx.fill();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.font = `800 ${Math.max(9, br * 1.2)}px ui-sans-serif, system-ui`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(String(rank), bx, by);
          ctx.textBaseline = "top";
        }
        // Collapsed count badge.
        if (isContainer(n.kind) && n.childCount > 0 && col.has(n.id)) {
          const bx = p.x + r * 0.75, by = p.y - r * 0.75, br = Math.max(7, r * 0.42);
          ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
          ctx.fillStyle = "#0f172a"; ctx.fill();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.max(8, br * 1.1)}px ui-sans-serif, system-ui`;
          ctx.textBaseline = "middle";
          ctx.fillText(n.childCount > 999 ? "999+" : String(n.childCount), bx, by);
          ctx.textBaseline = "top";
        }
        // Equipment count, on the icon's right shoulder: always visible.
        if (n.equipment) {
          const t = n.equipment > 99 ? "99+" : String(n.equipment);
          ctx.font = "800 9px ui-sans-serif, system-ui";
          const w = Math.max(15, ctx.measureText(t).width + 8);
          const bx = p.x + r * 0.62, byy = p.y - 6.5;
          ctx.fillStyle = dim ? "rgba(5,150,105,0.35)" : "#059669";
          ctx.beginPath(); ctx.roundRect(bx, byy, w, 13, 6.5); ctx.fill();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(t, bx + w / 2, byy + 6.8);
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
          if (n.badge) {
            ctx.font = "700 9px ui-sans-serif, system-ui";
            const bw = ctx.measureText(n.badge).width + 8;
            const by = p.y + r + 5 + fontPx + 5;
            ctx.fillStyle = dim ? "rgba(124,58,237,0.25)" : "#7c3aed";
            ctx.beginPath(); ctx.roundRect(p.x - bw / 2, by, bw, 12, 6); ctx.fill();
            ctx.fillStyle = "#fff"; ctx.fillText(n.badge, p.x, by + 2);
          }
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
    const upP = upPosRef.current, up = upRef.current;
    if (up && upP && Math.hypot(upP.x - wx, upP.y - wy) < RADIUS[up.kind] * 0.8 + 4 / camRef.current.scale) return "__up__";
    for (const [id, p] of satPos.current) if (Math.hypot(p.x - wx, p.y - wy) < 20 + 4 / camRef.current.scale) return `sat:${id}`;
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
    if (!d.on) {
      const { x, y } = toWorld(e);
      const rect = canvasRef.current!.getBoundingClientRect();
      setHoverAt({ x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height });
      setHoverId(hit(x, y));
      return;
    }
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
    camRef.current.x = d.cx + (e.clientX - d.sx);
    camRef.current.y = d.cy + (e.clientY - d.sy);
  };
  const lastClick = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = { on: false, sx: 0, sy: 0, cx: 0, cy: 0, moved: false };
    if (d.moved) return;
    const { x, y } = toWorld(e);
    const id = hit(x, y);
    if (id === "__up__") { onUp(); return; }
    if (id?.startsWith("sat:")) { const sat = satRef.current.find((x) => `sat:${x.id}` === id); if (sat) onSatellite?.(sat); return; }
    const now = performance.now();
    const dbl = id && lastClick.current.id === id && now - lastClick.current.at < 350;
    lastClick.current = { id, at: now };
    if (!id) { onSelect(null); return; }
    const n = byId.get(id);
    if (!n) return;
    if (isContainer(n.kind)) { onDrill(id); return; }
    if (dbl) { onOpen(id); return; }
    onSelect(id);
    const p = targetRef.current.get(id);
    if (p) { const scale = Math.max(camRef.current.scale, 1.5); camTarget.current = { scale, x: -p.x * scale, y: -p.y * scale }; }
  };

  const hoverSat = hoverId?.startsWith("sat:") ? satellites.find((x) => `sat:${x.id}` === hoverId) : null;
  const hoverNode = hoverId === "__up__" ? upNode : hoverSat ? { id: hoverSat.id, kind: "file" as const, label: hoverSat.label, parentId: null, childCount: 0, type: { key: hoverSat.iconKey, label: hoverSat.sub ?? "Entity", color: hoverSat.color, ext: "" } } : hoverId ? byId.get(hoverId) : null;

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
        <div
          className="pointer-events-none absolute max-w-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-2.5 py-1.5 text-xs shadow-md z-10"
          style={{
            left: hoverAt.x + 16,
            top: hoverAt.y + 16,
            transform: `translate(${hoverAt.x > hoverAt.w - 280 ? "calc(-100% - 32px)" : "0"}, ${hoverAt.y > hoverAt.h - 90 ? "calc(-100% - 32px)" : "0"})`,
          }}
        >
          <div className="font-bold truncate">{hoverNode.label}</div>
          <div className="text-[var(--color-text-muted)]">
            {hoverId === "__up__" ? "Click to go back up" : hoverSat ? `${hoverSat.sub ?? "Entity"} · ${hoverSat.links.length} linked file${hoverSat.links.length === 1 ? "" : "s"} · click to open` : isContainer(hoverNode.kind) ? `${hoverNode.type.label} · ${hoverNode.childCount} inside · click to explore` : `${hoverNode.type.label} · click for details · double-click to open`}
          </div>
        </div>
      )}
    </div>
  );
});

export default FileGraph;
