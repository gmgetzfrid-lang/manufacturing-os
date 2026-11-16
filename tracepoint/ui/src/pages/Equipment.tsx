import { useEffect, useMemo, useState } from "react";
import { Boxes, History, Network, Search } from "lucide-react";
import { api } from "../lib/api";
import type { EquipCard } from "../lib/types";
import { Button, Empty, Input, Pill, Spinner, cx } from "../components/ui";
import { catColor, n } from "../lib/format";
import type { Nav } from "../Shell";

interface Row { id: number; number: string; tags: string[]; description: string; kind: string; unit?: string | null; files: number; historical: string[] }
interface Unit { label: string; code: string; name: string }
interface GraphData { timeline: { year: number; counts: Record<string, number> }[]; card: EquipCard }

export function EquipmentPage({ nav }: { nav: Nav }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [q, setQ] = useState("");
  const [unit, setUnit] = useState<string>("");
  const [sel, setSel] = useState<number | null>(nav.params.id ? Number(nav.params.id) : null);
  useEffect(() => { if (nav.params.id) setSel(Number(nav.params.id)); }, [nav.params.id]);
  const [showPiping, setShowPiping] = useState(false);
  useEffect(() => {
    api<{ equipment: Row[]; units: Unit[] }>("equipment.list", {}).then((r) => { setRows(r.equipment); setUnits(r.units); });
  }, []);
  const filtered = useMemo(() => {
    if (!rows) return [];
    const ql = q.toLowerCase().replace(/[-\s]/g, "");
    return rows.filter((r) => (!unit || r.unit === unit) && (!ql || r.number.replace(".", "").includes(ql.replace(".", "")) || r.number.toLowerCase().includes(q.toLowerCase()) || r.description.toLowerCase().includes(q.toLowerCase()) || r.tags.some((t) => t.toLowerCase().replace(/[-\s]/g, "").includes(ql)) || r.kind.toLowerCase().includes(q.toLowerCase())));
  }, [rows, q, unit]);
  const unitCounts = useMemo(() => {
    const m = new Map<string, number>();
    rows?.forEach((r) => r.unit && m.set(r.unit, (m.get(r.unit) ?? 0) + 1));
    return m;
  }, [rows]);
  const kinds = useMemo(() => {
    const m = new Map<string, Row[]>();
    filtered.forEach((r) => { const k = r.kind || "Other"; m.set(k, [...(m.get(k) ?? []), r]); });
    // What people look for first; piping circuits (hundreds, mostly
    // unnamed) last.
    const rank = (k: string) => {
      const u = k.toUpperCase();
      const order = ["VESSEL", "TOWER", "EXCHANGER", "HEATER", "TANK", "RELIEF", "PSV", "PUMP", "COMPRESSOR", "BOILER", "REACTOR"];
      const i = order.findIndex((o) => u.includes(o));
      if (u.includes("PIPING")) return 1000;
      return i >= 0 ? i : 100;
    };
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].length - a[1].length);
  }, [filtered]);
  return (
    <div className="flex h-full">
      <aside className="w-[250px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <div className="mb-2 px-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Units</div>
        <button onClick={() => setUnit("")} className={cx("flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] cursor-pointer", !unit ? "bg-[var(--color-surface)] font-medium shadow-sm" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]")}>
          All equipment <span className="text-[11.5px] text-[var(--color-text-faint)]">{rows ? n(rows.length) : ""}</span>
        </button>
        {units.filter((u) => unitCounts.get(u.label)).map((u) => (
          <button key={u.label} onClick={() => setUnit(u.label)} className={cx("flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] cursor-pointer", unit === u.label ? "bg-[var(--color-surface)] font-medium shadow-sm" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]")}>
            <span className="truncate">{u.code ? <span className="mr-1.5 font-mono text-[11.5px] text-[var(--color-text-faint)]">{u.code}</span> : null}{u.name}</span>
            <span className="text-[11.5px] text-[var(--color-text-faint)]">{unitCounts.get(u.label)}</span>
          </button>
        ))}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-[var(--color-border)] px-6 pb-4 pt-5">
          <h1 className="text-[22px] font-[700] tracking-tight">Equipment</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">Every vessel, exchanger, relief device, tank and piping circuit TracePoint found in THOR, with its documents.</p>
          <div className="mt-3 max-w-xl"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by number, tag, description or type…" icon={<Search className="size-4" />} autoFocus /></div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!rows ? <div className="flex justify-center p-10"><Spinner /></div> : filtered.length === 0 ? <Empty icon={<Boxes className="size-5" />} title="No equipment matches" /> : (
            kinds.map(([kind, list]) => {
              const piping = kind.toUpperCase().includes("PIPING");
              const shown = piping && !showPiping && !q ? [] : list;
              return (
                <div key={kind} className="mb-6">
                  <div className="mb-2 flex items-baseline gap-2 px-1">
                    <span className="text-[16px] font-bold">{kind.charAt(0) + kind.slice(1).toLowerCase()}</span>
                    <span className="text-[13px] text-[var(--color-text-faint)]">{n(list.length)}</span>
                    {piping && !q && <button onClick={() => setShowPiping(!showPiping)} className="ml-2 text-[13px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer">{showPiping ? "Hide" : "Show all"}</button>}
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(420px,1fr))] gap-x-4">
                    {shown.slice(0, 600).map((r) => (
                      <button key={r.id} onClick={() => setSel(r.id)} className={cx("flex items-baseline gap-2.5 border-b border-[var(--color-border)] px-2 py-2 text-left transition cursor-pointer", sel === r.id ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface)]")}>
                        <span className="shrink-0 text-[15px] font-bold tabular-nums">{r.number}</span>
                        {r.tags[0] && <span className="shrink-0 text-[14px] font-semibold text-[var(--color-accent)]">{r.tags[0]}</span>}
                        <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--color-text)]">{r.description}</span>
                        {r.historical.length > 0 && <span className="shrink-0 text-[12px] text-[var(--color-warn)]" title={`Formerly ${r.historical.join(", ")}`}>was {r.historical[0]}</span>}
                        <span className="shrink-0 text-[12.5px] tabular-nums text-[var(--color-text-faint)]">{n(r.files)} docs</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {sel != null && <EquipmentDetail id={sel} nav={nav} onClose={() => setSel(null)} />}
    </div>
  );
}

function EquipmentDetail({ id, nav, onClose }: { id: number; nav: Nav; onClose: () => void }) {
  const [g, setG] = useState<GraphData | null>(null);
  useEffect(() => { setG(null); api<GraphData>("graph.equipment", { id }).then(setG); }, [id]);
  if (!g) return <aside className="w-[440px] shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)] p-6"><div className="skeleton h-40" /></aside>;
  const c = g.card;
  const maxYear = Math.max(1, ...g.timeline.map((t) => Object.values(t.counts).reduce((a, b) => a + b, 0)));
  return (
    <aside className="w-[440px] shrink-0 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] animate-[var(--animate-fade)]">
      <div className="h-1" style={{ background: "var(--brand-gradient)" }} />
      <div className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[22px] font-[750] tracking-tight">{c.number}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">{c.tags.map((t) => <Pill key={t} color="var(--color-accent)">{t}</Pill>)}{c.kind && <Pill color="var(--color-text-muted)">{c.kind}</Pill>}</div>
          </div>
          <button onClick={onClose} className="text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer">Close</button>
        </div>
        <div className="mt-2 text-[14px]">{c.description}</div>
        <div className="text-[12.5px] text-[var(--color-text-faint)]">{c.unit}</div>
        {c.historical.length > 0 && <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-[var(--color-warn)]"><History className="size-3.5" />{c.historical.join(" · ")}</div>}
        <div className="mt-4 flex gap-2">
          <Button variant="primary" size="sm" icon={<Search className="size-3.5" />} onClick={() => nav.go("search", { eq: c.id })}>All {n(c.files)} documents</Button>
          <Button size="sm" icon={<Network className="size-3.5" />} onClick={() => nav.go("graph", { eq: c.id })}>Graph</Button>
        </div>
        <div className="mt-6">
          <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Document history</div>
          {g.timeline.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-faint)]">No dated documents.</div> : (
            <div className="flex h-28 items-end gap-1 rounded-xl bg-[var(--color-surface-2)] p-3">
              {g.timeline.map((t) => {
                const total = Object.values(t.counts).reduce((a, b) => a + b, 0);
                return (
                  <div key={t.year} title={`${t.year}: ${Object.entries(t.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`} className="flex min-w-[6px] flex-1 flex-col-reverse overflow-hidden rounded-t" style={{ height: `${Math.max(8, (total / maxYear) * 100)}%` }}>
                    {Object.entries(t.counts).map(([k, v]) => <div key={k} style={{ height: `${(v / total) * 100}%`, background: catColor(k) }} />)}
                  </div>
                );
              })}
            </div>
          )}
          {g.timeline.length > 0 && <div className="mt-1 flex justify-between text-[11px] text-[var(--color-text-faint)]"><span>{g.timeline[0].year}</span><span>{g.timeline[g.timeline.length - 1].year}</span></div>}
        </div>
        <div className="mt-5 space-y-1.5">
          <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">By document type</div>
          {c.by_category.map((x) => (
            <button key={x.key} onClick={() => nav.go("search", { eq: c.id })} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--color-surface-2)] cursor-pointer">
              <span className="size-2.5 rounded-full" style={{ background: catColor(x.key) }} />
              <span className="flex-1 text-left">{x.label}</span>
              <span className="tabular-nums text-[var(--color-text-faint)]">{x.count}</span>
            </button>
          ))}
        </div>
        {c.related.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Often mentioned with <span className="font-normal normal-case">(unverified)</span></div>
            <div className="flex flex-wrap gap-1.5">{c.related.map((r) => <Pill key={r.id} color="var(--color-text-muted)" title={r.description}>{r.number}{r.tag ? ` ${r.tag}` : ""}</Pill>)}</div>
          </div>
        )}
        {c.folder && <div className="mt-5 break-all rounded-lg bg-[var(--color-surface-2)] p-3 font-mono text-[11px] text-[var(--color-text-muted)]">{c.folder}</div>}
      </div>
    </aside>
  );
}
