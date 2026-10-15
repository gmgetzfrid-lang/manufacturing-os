import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ExternalLink, FolderOpen, Maximize2, Network, Search } from "lucide-react";
import { api } from "../lib/api";
import type { EquipCard, Facet } from "../lib/types";
import { Button, Empty, IconButton, Input, Pill, useToast } from "../components/ui";
import { catColor, n } from "../lib/format";
import { useTheme } from "../lib/theme";
import type { Nav } from "../Shell";

interface GNode { id: string; kind: string; label: string; sub?: string; count?: number; file_id?: number; equip_id?: number; year?: number; center?: boolean; category?: string; latest?: boolean; doctype?: string }
interface GEdge { from: string; to: string; kind: string; label?: string; dashed?: boolean }
interface GraphData { nodes: GNode[]; edges: GEdge[]; card: EquipCard }
interface SimNode extends GNode { x: number; y: number; vx: number; vy: number; r: number; fixed?: boolean; color: string; parentCat?: string }

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

export function GraphPage({ nav }: { nav: Nav }) {
  const [eq, setEq] = useState<number | null>(nav.params.eq ? Number(nav.params.eq) : null);
  const [data, setData] = useState<GraphData | null>(null);
  const [q, setQ] = useState("");
  const [sugg, setSugg] = useState<Facet[]>([]);
  const [selected, setSelected] = useState<GNode | null>(null);
  const toast = useToast();
  useEffect(() => { if (nav.params.eq) setEq(Number(nav.params.eq)); }, [nav.params.eq]);
  useEffect(() => {
    if (eq == null) return;
    setData(null);
    setSelected(null);
    api<GraphData>("graph.equipment", { id: eq }).then(setData).catch((e) => toast("error", e.message));
  }, [eq, toast]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim().length < 2) { setSugg([]); return; }
      api<Facet[]>("suggest", { q }).then((s) => setSugg(s.filter((x) => x.key.startsWith("equip:"))));
    }, 100);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (id: number) => { setQ(""); setSugg([]); nav.go("graph", { eq: id }); setEq(id); };

  return (
    <div className="relative flex h-full">
      <div className="relative min-w-0 flex-1">
        <div className="absolute left-4 top-4 z-20 w-[380px]">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Graph any equipment: 5610.15, V-2, TK-1100…" icon={<Search className="size-4" />} className="shadow-lg" />
          {sugg.length > 0 && (
            <div className="mt-1.5 card p-1 shadow-xl">
              {sugg.map((s) => (
                <button key={s.key} onClick={() => pick(Number(s.key.slice(6)))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-[var(--color-surface-3)] cursor-pointer">
                  <Boxes className="size-3.5 text-[var(--color-accent)]" /><span className="flex-1 truncate">{s.label}</span><span className="text-[11px] text-[var(--color-text-faint)]">{s.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {eq == null ? (
          <div className="flex h-full items-center justify-center"><Empty icon={<Network className="size-5" />} title="Pick a piece of equipment">See its documents by type, drawing families, renumbering history and the equipment it's mentioned with.</Empty></div>
        ) : !data ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-text-faint)]">Building graph…</div>
        ) : (
          <GraphCanvas data={data} onSelect={setSelected} onRecenter={(id) => pick(id)} />
        )}
        <Legend />
      </div>
      {data && <GraphSide data={data} selected={selected} nav={nav} />}
    </div>
  );
}

function Legend() {
  const items = [["Equipment", "--color-accent"], ["Document type", "--color-info"], ["File", "--color-text-muted"], ["Drawing family", "--cat-drawings"], ["Related (unverified)", "--color-warn"]];
  return (
    <div className="absolute bottom-4 left-4 z-10 flex flex-wrap gap-3 rounded-xl border border-[var(--color-border)] glass px-3 py-2 text-[11.5px] text-[var(--color-text-muted)] shadow-md">
      {items.map(([l, v]) => <span key={l} className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: `var(${v})` }} />{l}</span>)}
    </div>
  );
}

function GraphCanvas({ data, onSelect, onRecenter }: { data: GraphData; onSelect: (n: GNode | null) => void; onRecenter: (id: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const { mode } = useTheme();
  const view = useRef({ x: 0, y: 0, k: 1 });
  const hover = useRef<SimNode | null>(null);
  const sel = useRef<SimNode | null>(null);
  const drag = useRef<{ node?: SimNode; panX?: number; panY?: number; sx: number; sy: number; moved: boolean } | null>(null);
  const alpha = useRef(1);

  // Radial "sunburst" layout: equipment in the centre, document types on a
  // ring, each type's files fanned out in its own sector, and everything else
  // (unit, history, drawing families, related equipment) on an outer arc.
  const sim = useMemo(() => {
    const parentOf = new Map<string, string>();
    data.edges.forEach((e) => { if (e.kind === "contains") parentOf.set(e.to, e.from); });
    const kindR: Record<string, number> = { equipment: 26, category: 15, file: 6.5, photos: 7.5, more: 6, family: 10, related: 11, unit: 11, history: 10, hint: 9 };
    const nodes: SimNode[] = data.nodes.map((nd) => {
      let color = "--color-text-muted";
      if (nd.kind === "equipment") color = "--color-accent";
      else if (nd.kind === "category") color = catColor(nd.label).slice(4, -1);
      else if (nd.kind === "file" || nd.kind === "photos" || nd.kind === "more") color = catColor(parentOf.get(nd.id)?.slice(1) ?? "General").slice(4, -1);
      else if (nd.kind === "family") color = "--cat-drawings";
      else if (nd.kind === "related") color = "--color-warn";
      else if (nd.kind === "unit") color = "--color-ok";
      else if (nd.kind === "history" || nd.kind === "hint") color = "--cat-code";
      return { ...nd, x: 0, y: 0, vx: 0, vy: 0, r: kindR[nd.kind] ?? 8, fixed: nd.center, color, parentCat: parentOf.get(nd.id), ax: 0, ay: 0 } as SimNode;
    });
    const byId = new Map(nodes.map((x) => [x.id, x]));
    const cats = nodes.filter((x) => x.kind === "category");
    const outer = nodes.filter((x) => ["unit", "history", "hint", "family", "related"].includes(x.kind));
    const children = (c: SimNode) => nodes.filter((x) => x.parentCat === c.id);
    const weights = cats.map((c) => 1.2 + Math.min(children(c).length, 9));
    const outerW = outer.length ? 3 + outer.length * 1.6 : 0;
    const total = weights.reduce((a, b) => a + b, 0) + outerW;
    let angle = -Math.PI / 2;
    const R1 = 175, R2 = 300, R3 = 330;
    cats.forEach((c, i) => {
      const span = (weights[i] / total) * Math.PI * 2;
      const mid = angle + span / 2;
      c.x = Math.cos(mid) * R1; c.y = Math.sin(mid) * R1;
      const kids = children(c);
      kids.forEach((k, j) => {
        const t = kids.length === 1 ? 0.5 : j / (kids.length - 1);
        const a2 = angle + span * (0.12 + 0.76 * t);
        const r = R2 + (j % 2) * 46;
        k.x = Math.cos(a2) * r; k.y = Math.sin(a2) * r;
      });
      angle += span;
    });
    outer.forEach((o, j) => {
      const span = (outerW / total) * Math.PI * 2;
      const t = outer.length === 1 ? 0.5 : j / (outer.length - 1);
      const a2 = angle + span * (0.1 + 0.8 * t);
      const r = o.kind === "related" ? R3 + 70 : R3 - 40 + (j % 2) * 50;
      o.x = Math.cos(a2) * r; o.y = Math.sin(a2) * r;
    });
    nodes.forEach((x) => { (x as any).ax = x.x; (x as any).ay = x.y; });
    const links = data.edges.map((e) => ({ ...e, a: byId.get(e.from)!, b: byId.get(e.to)! })).filter((l) => l.a && l.b);
    return { nodes, links, byId };
  }, [data]);

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr, H = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const v = view.current;
    ctx.translate(W / 2 + v.x, H / 2 + v.y);
    ctx.scale(v.k, v.k);
    const textC = cssVar("--color-text"), mutedC = cssVar("--color-text-muted"), faintC = cssVar("--color-text-faint"), surf = cssVar("--color-surface"), border = cssVar("--color-border-strong");
    const focus = hover.current ?? sel.current;
    const near = new Set<string>();
    if (focus) { near.add(focus.id); sim.links.forEach((l) => { if (l.a === focus) near.add(l.b.id); if (l.b === focus) near.add(l.a.id); }); }
    // Edges
    for (const l of sim.links) {
      const dim = focus && !(near.has(l.a.id) && near.has(l.b.id));
      ctx.globalAlpha = dim ? 0.06 : l.kind === "cooccurs" ? 0.6 : l.kind === "member" ? 0.18 : 0.45;
      ctx.strokeStyle = l.kind === "cooccurs" ? cssVar("--color-warn") : l.kind === "member" || l.kind === "family" ? cssVar("--cat-drawings") : border;
      ctx.lineWidth = (l.kind === "has_type" ? 2 : 1.1) / Math.sqrt(v.k);
      ctx.setLineDash(l.dashed ? [5, 5] : []);
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Nodes
    for (const nd of sim.nodes) {
      const col = cssVar(nd.color);
      const dim = focus && !near.has(nd.id);
      ctx.globalAlpha = dim ? 0.18 : 1;
      if (nd.center) {
        const g = ctx.createRadialGradient(nd.x, nd.y, nd.r * 0.6, nd.x, nd.y, nd.r * 2.6);
        g.addColorStop(0, col + "55");
        g.addColorStop(1, col + "00");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r * 2.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2);
      ctx.fillStyle = nd.kind === "file" || nd.kind === "photos" || nd.kind === "more" ? surf : col;
      ctx.fill();
      ctx.lineWidth = nd.kind === "file" || nd.kind === "photos" || nd.kind === "more" ? 2.2 : 0;
      if (ctx.lineWidth) { ctx.strokeStyle = col; ctx.stroke(); }
      if (nd === sel.current || nd === hover.current) { ctx.lineWidth = 3; ctx.strokeStyle = textC; ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r + 4, 0, Math.PI * 2); ctx.stroke(); }
      if (nd.kind === "related" || nd.kind === "hint") { ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = surf; ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r - 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
      // Labels: big nodes always, small ones when zoomed or focused.
      const showLabel = nd.r >= 10 || v.k > 1.25 || near.has(nd.id);
      if (showLabel && !dim) {
        const big = nd.center || nd.kind === "category";
        ctx.font = `${big ? 650 : 500} ${(big ? 13 : 11) / Math.max(0.8, Math.sqrt(v.k))}px Inter Variable, Segoe UI, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = nd.label.length > 34 ? nd.label.slice(0, 32) + "…" : nd.label;
        ctx.fillStyle = big ? textC : mutedC;
        ctx.fillText(label, nd.x, nd.y + nd.r + 5);
        if (nd.count && (nd.kind === "category" || nd.center)) { ctx.fillStyle = faintC; ctx.fillText(`${nd.count}`, nd.x, nd.y + nd.r + 20 / Math.max(0.8, Math.sqrt(v.k))); }
      }
    }
    ctx.globalAlpha = 1;
  }, [sim]);

  // Force simulation.
  useEffect(() => {
    let raf = 0;
    alpha.current = 1;
    const step = () => {
      const a = alpha.current;
      if (a > 0.005) {
        const N = sim.nodes;
        // Keep nodes from overlapping…
        for (let i = 0; i < N.length; i++) {
          for (let j = i + 1; j < N.length; j++) {
            const p = N[i], q = N[j];
            const dx = q.x - p.x, dy = q.y - p.y;
            const min = p.r + q.r + 14;
            const d2 = dx * dx + dy * dy;
            if (d2 < min * min) {
              const d = Math.sqrt(d2) || 0.01;
              const push = ((min - d) / d) * 0.5;
              if (!p.fixed) { p.x -= dx * push; p.y -= dy * push; }
              if (!q.fixed) { q.x += dx * push; q.y += dy * push; }
            }
          }
        }
        // …while each one is pulled gently back to its place in the layout.
        for (const nd of N) {
          if (nd.fixed || drag.current?.node === nd) continue;
          const an = nd as any;
          nd.x += (an.ax - nd.x) * 0.08 * a;
          nd.y += (an.ay - nd.y) * 0.08 * a;
        }
        alpha.current *= 0.97;
      }
      draw();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [sim, draw, mode]);

  // Resize.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const c = canvas.current, w = wrap.current;
      if (!c || !w) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = w.clientWidth * dpr; c.height = w.clientHeight * dpr;
      c.style.width = `${w.clientWidth}px`; c.style.height = `${w.clientHeight}px`;
      draw();
    });
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [draw]);

  const toWorld = (ev: { clientX: number; clientY: number }) => {
    const c = canvas.current!.getBoundingClientRect();
    const v = view.current;
    return { x: (ev.clientX - c.left - c.width / 2 - v.x) / v.k, y: (ev.clientY - c.top - c.height / 2 - v.y) / v.k };
  };
  const hit = (ev: { clientX: number; clientY: number }) => {
    const p = toWorld(ev);
    let best: SimNode | null = null, bd = Infinity;
    for (const nd of sim.nodes) {
      const d = Math.hypot(nd.x - p.x, nd.y - p.y);
      if (d < nd.r + 6 && d < bd) { best = nd; bd = d; }
    }
    return best;
  };
  const fit = () => { const w = wrap.current; const k = w ? Math.min(1.1, Math.min(w.clientWidth, w.clientHeight) / 900) : 0.85; view.current = { x: 0, y: 0, k }; };
  useEffect(fit, [data]);

  return (
    <div ref={wrap} className="absolute inset-0">
      <div className="absolute inset-0 grid-lines opacity-60" />
      <canvas
        ref={canvas}
        className="relative cursor-grab active:cursor-grabbing"
        onWheel={(e) => {
          const v = view.current;
          const k = Math.min(4, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0012)));
          const c = canvas.current!.getBoundingClientRect();
          const mx = e.clientX - c.left - c.width / 2, my = e.clientY - c.top - c.height / 2;
          v.x = mx - ((mx - v.x) * k) / v.k; v.y = my - ((my - v.y) * k) / v.k; v.k = k;
        }}
        onMouseDown={(e) => {
          const nd = hit(e);
          drag.current = nd ? { node: nd, sx: e.clientX, sy: e.clientY, moved: false } : { panX: view.current.x, panY: view.current.y, sx: e.clientX, sy: e.clientY, moved: false };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (d) {
            if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
            if (d.node && !d.node.center) { const p = toWorld(e); d.node.x = p.x; d.node.y = p.y; (d.node as any).ax = p.x; (d.node as any).ay = p.y; alpha.current = Math.max(alpha.current, 0.4); }
            else if (d.panX !== undefined) { view.current.x = d.panX + (e.clientX - d.sx); view.current.y = d.panY! + (e.clientY - d.sy); }
          } else {
            hover.current = hit(e);
            canvas.current!.style.cursor = hover.current ? "pointer" : "grab";
          }
        }}
        onMouseUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            sel.current = d.node ?? null;
            onSelect(d.node ?? null);
          }
        }}
        onDoubleClick={(e) => { const nd = hit(e); if (nd?.equip_id != null && !nd.center) onRecenter(nd.equip_id); }}
        onMouseLeave={() => { hover.current = null; drag.current = null; }}
      />
      <div className="absolute right-4 top-16 z-10 flex flex-col gap-1 rounded-xl border border-[var(--color-border)] glass p-1 shadow-md">
        <IconButton label="Fit" onClick={fit}><Maximize2 className="size-4" /></IconButton>
      </div>
    </div>
  );
}

function GraphSide({ data, selected, nav }: { data: GraphData; selected: GNode | null; nav: Nav }) {
  const c = data.card;
  const toast = useToast();
  const open = (how: "open" | "reveal") => selected?.file_id != null && api(how === "open" ? "file.open" : "file.reveal", { id: selected.file_id, mode: "copy" }).catch((e) => toast("error", e.message));
  return (
    <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] p-5 pt-16">
      <div className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Centre</div>
      <div className="mt-1 text-[20px] font-[750]">{c.number}</div>
      <div className="mt-1 flex flex-wrap gap-1.5">{c.tags.map((t) => <Pill key={t} color="var(--color-accent)">{t}</Pill>)}</div>
      <div className="mt-1.5 text-[13.5px] text-[var(--color-text-muted)]">{c.description}</div>
      <div className="text-[12px] text-[var(--color-text-faint)]">{c.unit} · {n(c.files)} documents</div>
      <Button size="sm" className="mt-3" icon={<Search className="size-3.5" />} onClick={() => nav.go("search", { eq: c.id })}>Search its documents</Button>
      <div className="my-5 h-px bg-[var(--color-border)]" />
      {!selected ? (
        <div className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          Click a node to see it here. Double-click another piece of equipment to move the graph to it. Scroll to zoom, drag to pan.
          <div className="mt-3 rounded-lg bg-[var(--color-surface-2)] p-3 text-[12px]">Dashed amber links come from names appearing together in THOR. They are clues, not confirmed engineering relationships.</div>
        </div>
      ) : (
        <div className="animate-[var(--animate-fade)]">
          <div className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">{selected.kind}</div>
          <div className="mt-1 break-words text-[14.5px] font-semibold">{selected.label}</div>
          {selected.sub && <div className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">{selected.sub}</div>}
          {selected.doctype && <div className="mt-1.5 flex gap-1.5"><Pill color="var(--color-info)">{selected.doctype}</Pill>{selected.year && <Pill color="var(--color-text-muted)">{selected.year}</Pill>}{selected.latest && <Pill color="var(--color-ok)">Latest</Pill>}</div>}
          {selected.count != null && selected.kind !== "file" && <div className="mt-1 text-[12.5px] text-[var(--color-text-faint)]">{n(selected.count)} items</div>}
          <div className="mt-3 flex flex-wrap gap-2">
            {selected.file_id != null && <><Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => open("open")}>Open</Button><Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => open("reveal")}>Folder</Button></>}
            {selected.equip_id != null && !selected.center && <Button size="sm" icon={<Network className="size-3.5" />} onClick={() => nav.go("graph", { eq: selected.equip_id })}>Centre on this</Button>}
            {selected.kind === "category" && <Button size="sm" icon={<Search className="size-3.5" />} onClick={() => nav.go("search", { eq: c.id })}>See all</Button>}
          </div>
        </div>
      )}
    </aside>
  );
}
