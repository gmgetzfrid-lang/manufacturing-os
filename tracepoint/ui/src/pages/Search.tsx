import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight, Boxes, Camera, ChevronDown, ChevronRight, Clipboard, Download, ExternalLink, File, FileImage, FileSpreadsheet, FileText, FolderOpen,
  History, Info, Layers, Mail, MapPin, Network, PanelRightClose, PanelRightOpen, PenTool, Search, Sparkles, X, Zap, FileArchive, FileCode2,
} from "lucide-react";
import { api, fileUrl } from "../lib/api";
import type { AppState, EquipCard, Facet, Hit, SearchRequest, SearchResponse } from "../lib/types";
import { Button, Empty, IconButton, Kbd, Pill, Spinner, Toggle, cx, useToast } from "../components/ui";
import { bytes, catColor, dateFromSecs, n } from "../lib/format";
import type { Nav } from "../Shell";

const EXAMPLES = [
  { q: "V-2 inspection", d: "A tag used in many units: TracePoint asks which V-2" },
  { q: "5510.06", d: "Old number: found under its new number 5610.15" },
  { q: "crude p&id", d: "Unit word + document type" },
  { q: "TK-1100 API 653", d: "Tank inspections by tag" },
  { q: "latest UT survey LRU", d: "Newest first, inside one unit" },
  { q: "2515-060 iso", d: "Piping circuit drawings" },
];

const PAGE = 100;

function extIcon(ext: string, cat: string) {
  const e = ext.toLowerCase();
  if (cat === "Photos" || [".jpg", ".jpeg", ".png", ".heic", ".bmp", ".gif", ".webp", ".tif", ".tiff"].includes(e)) return <FileImage className="size-[18px]" />;
  if ([".xlsx", ".xls", ".csv", ".xlsm"].includes(e)) return <FileSpreadsheet className="size-[18px]" />;
  if ([".msg", ".eml"].includes(e)) return <Mail className="size-[18px]" />;
  if ([".dwg", ".dxf", ".dgn"].includes(e)) return <PenTool className="size-[18px]" />;
  if ([".zip", ".7z", ".rar"].includes(e)) return <FileArchive className="size-[18px]" />;
  if ([".xml", ".json", ".log", ".txt", ".ini"].includes(e)) return <FileCode2 className="size-[18px]" />;
  if ([".pdf", ".doc", ".docx", ".rtf"].includes(e)) return <FileText className="size-[18px]" />;
  return <File className="size-[18px]" />;
}

function highlight(text: string, words: string[]): ReactNode {
  if (!words.length) return text;
  const esc = words.filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!esc.length) return text;
  const re = new RegExp(`(${esc.join("|")})`, "ig");
  return text.split(re).map((p, i) => (i % 2 ? <mark key={i} className="hl">{p}</mark> : p));
}

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem("tp.recent") ?? "[]"); } catch { return []; }
}
function saveRecent(q: string) {
  try {
    const r = [q, ...loadRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    localStorage.setItem("tp.recent", JSON.stringify(r));
  } catch { /* */ }
}

interface Filters {
  categories: string[];
  units: string[];
  exts: string[];
  year_min: number | null;
  year_max: number | null;
  include_photos: boolean;
  hide_archive: boolean;
  sort: string;
}
const NO_FILTERS: Filters = { categories: [], units: [], exts: [], year_min: null, year_max: null, include_photos: false, hide_archive: false, sort: "relevance" };

export function SearchPage({ state, nav }: { state: AppState; nav: Nav }) {
  const toast = useToast();
  const [query, setQuery] = useState(nav.params.q ?? "");
  const [submitted, setSubmitted] = useState(nav.params.q ?? "");
  const [pinned, setPinned] = useState<number | null>(nav.params.eq ? Number(nav.params.eq) : null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [resp, setResp] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<number>(-1);
  const [preview, setPreview] = useState(() => localStorage.getItem("tp.preview") !== "off");
  const listRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0);

  useEffect(() => {
    if (nav.params.q !== undefined && nav.params.q !== submitted) { setQuery(nav.params.q); setSubmitted(nav.params.q); setPinned(nav.params.eq ? Number(nav.params.eq) : null); }
    if (nav.params.eq && Number(nav.params.eq) !== pinned) { setPinned(Number(nav.params.eq)); if (!nav.params.q) { setQuery(""); setSubmitted(""); } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.params.q, nav.params.eq]);

  const request: SearchRequest = useMemo(
    () => ({ query: submitted, limit, equipment: pinned, ...filters, sort: filters.sort === "relevance" ? "" : filters.sort }),
    [submitted, limit, pinned, filters],
  );

  const run = useCallback(async (r: SearchRequest) => {
    if (!r.query.trim() && r.equipment == null && !r.categories?.length && !r.units?.length) { setResp(null); return; }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await api<SearchResponse>("search", r);
      if (seq === reqSeq.current) {
        setResp(res);
        setSelected((s) => (res.hits.length ? (s >= 0 && s < res.hits.length ? s : 0) : -1));
      }
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { run(request); }, [request, run]);

  const submit = (q: string) => {
    const t = q.trim();
    setSubmitted(t);
    setLimit(PAGE);
    setSelected(0);
    setFilters((f) => ({ ...f, categories: [], units: [], exts: [] }));
    if (t) saveRecent(t);
    setPinned(null);
    const params: Record<string, string> = {};
    if (t) params.q = t;
    window.history.replaceState(null, "", `#/search${t ? `?q=${encodeURIComponent(t)}` : ""}`);
  };

  const hits = resp?.hits ?? [];
  const sel = selected >= 0 ? hits[selected] : undefined;
  const words = useMemo(() => (resp?.chips ?? []).filter((c) => c.kind === "word" || c.kind === "tag" || c.kind === "equipment").map((c) => c.text.replace(/[-_]/g, "")), [resp]);

  // Keyboard: ↑/↓ move, Enter opens, Ctrl+Enter shows in folder.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!hits.length) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); setSelected((s) => Math.min(s + 1, hits.length - 1)); }
      if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      if (e.key === "Enter" && sel) { e.preventDefault(); openFile(sel, e.ctrlKey ? "reveal" : undefined); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-row="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const openFile = async (h: Hit, how?: "reveal" | "original") => {
    try {
      if (how === "reveal") await api("file.reveal", { id: h.id });
      else await api("file.open", { id: h.id, mode: how === "original" ? "original" : state.prefs.open_mode ?? "copy" });
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const exportXlsx = async () => {
    try {
      const r = await api<{ path?: string; rows?: number; cancelled?: boolean }>("export.xlsx", { request });
      if (r.path) toast("ok", `Exported ${r.rows} results to ${r.path}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const togglePreview = () => { setPreview((p) => { localStorage.setItem("tp.preview", p ? "off" : "on"); return !p; }); };

  const empty = !resp && !loading;
  return (
    <div className="flex h-full flex-col">
      {/* Search header */}
      <div className={cx("relative border-b border-[var(--color-border)] transition-all", empty ? "border-transparent" : "bg-[var(--color-surface)]")}>
        {empty && <div className="hero-backdrop absolute inset-0 h-[420px]" />}
        <div className={cx("relative mx-auto px-6", empty ? "max-w-[860px] pt-[11vh]" : "max-w-none pt-4 pb-3")}>
          {empty && (
            <div className="mb-7 text-center animate-[var(--animate-rise)]">
              <h1 className="text-[34px] font-[750] tracking-tight">What are you looking for?</h1>
              <p className="mt-2 text-[14.5px] text-[var(--color-text-muted)]">Equipment numbers, tags, circuits, document types, years — or just describe it.</p>
            </div>
          )}
          <SearchBox value={query} onChange={setQuery} onSubmit={submit} big={empty} loading={loading} onPickEquipment={(id) => { setPinned(id); setSubmitted(""); setQuery(""); }} />
          {resp && <Interpretation resp={resp} pinned={pinned} onUnpin={() => setPinned(null)} onPick={(id) => setPinned(id)} />}
        </div>
        {empty && <Welcome state={state} onPick={(q) => { setQuery(q); submit(q); }} />}
      </div>

      {resp && (
        <div className="flex min-h-0 flex-1">
          <FacetPanel resp={resp} filters={filters} setFilters={(f) => { setFilters(f); setLimit(PAGE); }} />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Results toolbar */}
            <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 text-[12.5px] text-[var(--color-text-muted)]">
              <div className="min-w-0 truncate whitespace-nowrap">
                <span className="font-semibold text-[var(--color-text)] tabular-nums">{n(resp.total)}</span> results
                <span className="text-[var(--color-text-faint)]"> · {resp.took_ms < 1 ? "<1" : resp.took_ms.toFixed(0)} ms</span>
                {resp.suppressed_photos > 0 && !filters.include_photos && (
                  <button onClick={() => setFilters({ ...filters, include_photos: true })} title="TracePoint shows two photos per folder unless you ask for photos" className="ml-2 text-[var(--color-accent)] hover:underline cursor-pointer">+{n(resp.suppressed_photos)} photos</button>
                )}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })} className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12.5px] outline-none cursor-pointer" title="Sort">
                  <option value="relevance">Best match</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option><option value="folder">By folder</option>
                </select>
                <Button size="sm" icon={<Download className="size-3.5" />} onClick={exportXlsx} disabled={!resp.total}>Excel</Button>
                <IconButton label={preview ? "Hide preview" : "Show preview"} onClick={togglePreview}>{preview ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}</IconButton>
              </div>
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
              {resp.card && <EquipmentCardView card={resp.card} nav={nav} onFilter={(c) => setFilters({ ...filters, categories: [c] })} />}
              {resp.total === 0 ? (
                <NoResults resp={resp} onTry={(q) => { setQuery(q); submit(q); }} />
              ) : (
                <div className="px-3 py-2">
                  {hits.map((h, i) => (
                    <ResultRow key={h.id} hit={h} i={i} active={i === selected} words={words} topScore={hits[0]?.score ?? 1} onSelect={() => setSelected(i)} onOpen={() => openFile(h)} onReveal={() => openFile(h, "reveal")} onEquip={(id) => { setPinned(id); setSubmitted(""); setQuery(""); }} />
                  ))}
                  {hits.length < resp.total && (
                    <div className="py-4 text-center"><Button onClick={() => setLimit((l) => l + PAGE * 2)} loading={loading}>Show more ({n(resp.total - hits.length)} left)</Button></div>
                  )}
                </div>
              )}
            </div>
          </div>
          {preview && <PreviewPane hit={sel} state={state} onOpen={openFile} onEquip={(id) => { setPinned(id); setSubmitted(""); setQuery(""); }} nav={nav} />}
        </div>
      )}
    </div>
  );
}

function SearchBox({ value, onChange, onSubmit, big, loading, onPickEquipment }: { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; big: boolean; loading: boolean; onPickEquipment: (id: number) => void }) {
  const [sugg, setSugg] = useState<Facet[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "/" && (e.target as HTMLElement)?.tagName !== "INPUT") { e.preventDefault(); input.current?.focus(); input.current?.select(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (value.trim().length < 2) { setSugg([]); return; }
      api<Facet[]>("suggest", { q: value }).then((s) => { setSugg(s); setSel(-1); }).catch(() => setSugg([]));
    }, 80);
    return () => clearTimeout(t);
  }, [value, open]);
  const pick = (s: Facet) => {
    setOpen(false);
    if (s.key.startsWith("equip:")) onPickEquipment(Number(s.key.slice(6)));
    else {
      const parts = value.trim().split(/\s+/);
      parts[parts.length - 1] = s.label;
      const q = parts.join(" ");
      onChange(q);
      onSubmit(q);
    }
  };
  return (
    <div className="relative">
      <div className={cx("group flex items-center gap-3 rounded-2xl border bg-[var(--color-surface)] transition-all focus-within:border-[var(--color-accent)] focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--color-accent)_13%,transparent)]", big ? "h-[62px] px-5 shadow-xl border-[var(--color-border-strong)]" : "h-12 px-4 shadow-sm border-[var(--color-border)]")}>
        {loading ? <Spinner className={big ? "size-5" : ""} /> : <Search className={cx("text-[var(--color-text-faint)]", big ? "size-5" : "size-4")} />}
        <input
          ref={input}
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && sugg.length) { e.preventDefault(); setSel((s) => Math.min(s + 1, sugg.length - 1)); }
            else if (e.key === "ArrowUp" && sugg.length) { e.preventDefault(); setSel((s) => Math.max(s - 1, -1)); }
            else if (e.key === "Enter") { e.preventDefault(); if (open && sel >= 0 && sugg[sel]) pick(sugg[sel]); else { setOpen(false); onSubmit(value); } }
            else if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Try  V-2 inspection,  5610.15,  crude P&ID,  TK-1100 2019…"
          className={cx("min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--color-text-faint)]", big ? "text-[18px]" : "text-[15px]")}
          spellCheck={false}
        />
        {value && <IconButton label="Clear" onClick={() => { onChange(""); onSubmit(""); input.current?.focus(); }} className="size-8"><X className="size-4" /></IconButton>}
        <Button variant="primary" size={big ? "md" : "sm"} onClick={() => onSubmit(value)} className={big ? "rounded-xl" : ""}>Search <ArrowRight className="size-3.5" /></Button>
      </div>
      {open && sugg.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-40 mt-2 card overflow-hidden p-1.5 shadow-2xl animate-[var(--animate-pop)]">
          {sugg.map((s, i) => (
            <button key={s.key} onMouseDown={(e) => { e.preventDefault(); pick(s); }} onMouseEnter={() => setSel(i)} className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13.5px] cursor-pointer", sel === i && "bg-[var(--color-accent-soft)]")}>
              <span className={cx("flex size-7 shrink-0 items-center justify-center rounded-lg", s.key.startsWith("equip:") ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "bg-[var(--color-surface-3)] text-[var(--color-text-muted)]")}>
                {s.key.startsWith("equip:") ? <Boxes className="size-3.5" /> : <Search className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--color-text-faint)]">{n(s.count)} files</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const CHIP_STYLE: Record<string, { color: string; label: string }> = {
  equipment: { color: "var(--color-accent)", label: "Equipment" },
  tag: { color: "var(--color-info)", label: "Tag" },
  hint: { color: "var(--color-warn)", label: "Possible" },
  word: { color: "var(--color-text-muted)", label: "Word" },
  fuzzy: { color: "var(--color-violet)", label: "Did you mean" },
  unit: { color: "var(--color-ok)", label: "Unit" },
  year: { color: "var(--cat-code)", label: "Year" },
  recent: { color: "var(--cat-code)", label: "Sort" },
  sheet: { color: "var(--cat-drawings)", label: "Sheet" },
  rev: { color: "var(--cat-drawings)", label: "Revision" },
  phrase: { color: "var(--color-info)", label: "Phrase" },
  wildcard: { color: "var(--color-violet)", label: "Wildcard" },
};

function Interpretation({ resp, pinned, onUnpin, onPick }: { resp: SearchResponse; pinned: number | null; onUnpin: () => void; onPick: (id: number) => void }) {
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11.5px] font-medium text-[var(--color-text-faint)]">Reading this as</span>
        {resp.chips.map((c, i) => {
          const st = CHIP_STYLE[c.kind] ?? CHIP_STYLE.word;
          return (
            <span key={i} title={c.detail} className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px]" style={{ borderColor: `color-mix(in srgb, ${st.color} 28%, transparent)`, background: `color-mix(in srgb, ${st.color} 7%, transparent)` }}>
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: st.color }}>{st.label}</span>
              <span className="font-medium">{c.text}</span>
              {c.detail && <span className="max-w-[260px] truncate text-[var(--color-text-faint)]">{c.detail}</span>}
            </span>
          );
        })}
        {pinned != null && (
          <button onClick={onUnpin} className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-accent-soft)] px-2 py-1 text-[12px] font-medium text-[var(--color-accent)] cursor-pointer">
            Showing one piece of equipment <X className="size-3" />
          </button>
        )}
      </div>
      {resp.ambiguity.map((a) => (
        <div key={a.token} className="rounded-xl border border-[color-mix(in_srgb,var(--color-info)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-info)_6%,transparent)] p-3 animate-[var(--animate-rise)]">
          <div className="flex items-center gap-2 text-[13px] font-semibold"><MapPin className="size-4 text-[var(--color-info)]" /> Which {a.token}? It names {a.options.length} pieces of equipment — showing all. Pick one to narrow down.</div>
          <div className="mt-2.5 flex gap-2 overflow-x-auto pb-1">
            {a.options.map((o) => (
              <button key={o.id} onClick={() => onPick(o.id)} className="group shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left shadow-xs transition hover:border-[var(--color-accent)] hover:shadow-md cursor-pointer">
                <div className="flex items-center gap-2 text-[13px] font-semibold">{o.number}<span className="text-[11.5px] font-normal text-[var(--color-text-faint)]">{n(o.files)} files</span></div>
                <div className="max-w-[220px] truncate text-[12px] text-[var(--color-text-muted)]">{o.description || "—"}</div>
                <div className="text-[11px] text-[var(--color-text-faint)]">{o.unit}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Welcome({ state, onPick }: { state: AppState; onPick: (q: string) => void }) {
  const recent = loadRecent();
  return (
    <div className="relative mx-auto max-w-[860px] px-6 pb-10 pt-8 animate-[var(--animate-rise)]">
      {recent.length > 0 && (
        <div className="mb-6">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-text-faint)]"><History className="size-3.5" /> Recent</div>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => <button key={r} onClick={() => onPick(r)} className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] shadow-xs hover:border-[var(--color-accent)] cursor-pointer">{r}</button>)}
          </div>
        </div>
      )}
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-text-faint)]"><Sparkles className="size-3.5" /> Try these</div>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
        {EXAMPLES.map((x) => (
          <button key={x.q} onClick={() => onPick(x.q)} className="card hover-lift p-3.5 text-left cursor-pointer">
            <div className="flex items-center gap-2 text-[13.5px] font-semibold"><Zap className="size-3.5 text-[var(--color-accent)]" /> {x.q}</div>
            <div className="mt-1 text-[12px] leading-snug text-[var(--color-text-muted)]">{x.d}</div>
          </button>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px] text-[var(--color-text-faint)]">
        <span className="flex items-center gap-1.5"><Kbd>/</Kbd> focus search</span>
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span className="flex items-center gap-1.5"><Kbd>Enter</Kbd> open</span>
        <span className="flex items-center gap-1.5"><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> show in folder</span>
        <span className="flex items-center gap-1.5"><Kbd>Ctrl</Kbd><Kbd>K</Kbd> jump anywhere</span>
      </div>
      <div className="mt-4 text-center text-[11.5px] text-[var(--color-text-faint)]">{state.index.source} · {state.index.message}</div>
    </div>
  );
}

function FacetGroup({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-[var(--color-border)] px-3 py-3">
      <button onClick={() => setOpen(!open)} className="mb-1 flex w-full items-center justify-between text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)] cursor-pointer">
        {title} {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

function FacetRow({ label, count, max, active, color, onClick }: { label: string; count: number; max: number; active: boolean; color?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx("relative flex w-full items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-[12.5px] transition cursor-pointer", active ? "bg-[var(--color-accent-soft)] font-medium text-[var(--color-text)]" : "hover:bg-[var(--color-surface-3)] text-[var(--color-text-muted)]")}>
      <span className="absolute inset-y-1 left-0 rounded-r opacity-[0.09]" style={{ width: `${Math.max(4, (count / Math.max(1, max)) * 100)}%`, background: color ?? "var(--color-text)" }} />
      {color && <span className="relative size-2 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="relative min-w-0 flex-1 truncate">{label}</span>
      <span className="relative tabular-nums text-[11.5px] text-[var(--color-text-faint)]">{n(count)}</span>
    </button>
  );
}

function FacetPanel({ resp, filters, setFilters }: { resp: SearchResponse; filters: Filters; setFilters: (f: Filters) => void }) {
  const toggle = (key: "categories" | "units" | "exts", v: string) => {
    const cur = filters[key];
    setFilters({ ...filters, [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const f = resp.facets;
  const maxCat = Math.max(...f.categories.map((x) => x.count), 1);
  const maxUnit = Math.max(...f.units.map((x) => x.count), 1);
  const years = [...f.years].sort((a, b) => Number(a.key) - Number(b.key));
  const maxYear = Math.max(...years.map((y) => y.count), 1);
  const anyFilter = filters.categories.length || filters.units.length || filters.exts.length || filters.year_min || filters.year_max || filters.hide_archive || filters.include_photos;
  return (
    <aside className="w-[226px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface-2)]">
      <div className="flex h-11 items-center justify-between border-b border-[var(--color-border)] px-4 text-[12.5px] font-semibold">
        Refine
        {anyFilter ? <button onClick={() => setFilters({ ...NO_FILTERS, sort: filters.sort })} className="text-[12px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer">Clear all</button> : null}
      </div>
      <FacetGroup title="Document type">
        {f.categories.map((c) => <FacetRow key={c.key} label={c.label} count={c.count} max={maxCat} color={catColor(c.key)} active={filters.categories.includes(c.key)} onClick={() => toggle("categories", c.key)} />)}
      </FacetGroup>
      {years.length > 1 && (
        <FacetGroup title="Year">
          <div className="flex h-14 items-end gap-[2px] px-1">
            {years.map((y) => {
              const yr = Number(y.key);
              const inRange = (!filters.year_min || yr >= filters.year_min) && (!filters.year_max || yr <= filters.year_max);
              return (
                <button
                  key={y.key}
                  title={`${y.key}: ${y.count} files`}
                  onClick={() => setFilters({ ...filters, year_min: filters.year_min === yr && filters.year_max === yr ? null : yr, year_max: filters.year_min === yr && filters.year_max === yr ? null : yr })}
                  className="min-w-[3px] flex-1 rounded-t-sm transition-colors cursor-pointer"
                  style={{ height: `${Math.max(8, (y.count / maxYear) * 100)}%`, background: inRange ? "var(--color-accent)" : "var(--color-border-strong)", opacity: inRange ? 0.85 : 0.5 }}
                />
              );
            })}
          </div>
          <div className="mt-1 flex justify-between px-1 text-[10.5px] text-[var(--color-text-faint)]"><span>{years[0]?.key}</span><span>{years[years.length - 1]?.key}</span></div>
          <div className="mt-2 flex items-center gap-1.5 px-1">
            <input type="number" placeholder="From" value={filters.year_min ?? ""} onChange={(e) => setFilters({ ...filters, year_min: e.target.value ? Number(e.target.value) : null })} className="h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] outline-none focus:border-[var(--color-accent)]" />
            <span className="text-[var(--color-text-faint)]">–</span>
            <input type="number" placeholder="To" value={filters.year_max ?? ""} onChange={(e) => setFilters({ ...filters, year_max: e.target.value ? Number(e.target.value) : null })} className="h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] outline-none focus:border-[var(--color-accent)]" />
          </div>
        </FacetGroup>
      )}
      {f.units.length > 1 && (
        <FacetGroup title="Unit / area">
          {f.units.slice(0, 14).map((u) => <FacetRow key={u.key} label={u.label} count={u.count} max={maxUnit} active={filters.units.includes(u.key)} onClick={() => toggle("units", u.key)} />)}
        </FacetGroup>
      )}
      {f.exts.length > 1 && (
        <FacetGroup title="File type" defaultOpen={false}>
          <div className="flex flex-wrap gap-1.5 px-1 pt-1">
            {f.exts.map((x) => (
              <button key={x.key} onClick={() => toggle("exts", x.key)} className={cx("rounded-md border px-2 py-1 text-[11.5px] font-medium transition cursor-pointer", filters.exts.includes(x.key) ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]")}>
                {x.label} <span className="text-[var(--color-text-faint)]">{x.count}</span>
              </button>
            ))}
          </div>
        </FacetGroup>
      )}
      <div className="space-y-3 px-4 py-4">
        <Toggle checked={filters.include_photos} onChange={(v) => setFilters({ ...filters, include_photos: v })} label="All photos" hint="Otherwise two per folder" />
        <Toggle checked={filters.hide_archive} onChange={(v) => setFilters({ ...filters, hide_archive: v })} label="Hide archive folders" />
      </div>
    </aside>
  );
}

function ResultRow({ hit, i, active, words, topScore, onSelect, onOpen, onReveal, onEquip }: { hit: Hit; i: number; active: boolean; words: string[]; topScore: number; onSelect: () => void; onOpen: () => void; onReveal: () => void; onEquip: (id: number) => void }) {
  const color = catColor(hit.category);
  const crumbs = hit.folder.split("\\").filter(Boolean);
  const unitCode = (hit.unit ?? crumbs[0] ?? "").split(" - ")[0];
  const tail = crumbs.slice(1).slice(-2);
  const skipped = Math.max(0, crumbs.length - 1 - tail.length);
  const rel = Math.max(0.06, Math.min(1, hit.score / Math.max(1, topScore)));
  return (
    <div
      data-row={i}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cx(
        "group relative mb-1 flex cursor-default gap-3 rounded-xl border px-3 py-2.5 transition-all",
        active ? "border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[var(--color-accent-soft)] shadow-sm" : "border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]",
      )}
    >
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px]" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>{extIcon(hit.ext, hit.category)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className={cx("truncate text-[13.5px] font-semibold", hit.junk && "opacity-60")}>{highlight(hit.name, words)}</div>
          {hit.latest && <Pill color="var(--color-ok)">Latest rev</Pill>}
          {hit.archived && <Pill color="var(--color-text-faint)">Archive</Pill>}
          {hit.blank && <Pill color="var(--color-warn)">Template</Pill>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--color-text-faint)]" title={hit.folder}>
          {unitCode && <span className="shrink-0 rounded bg-[var(--color-surface-3)] px-1.5 py-px font-mono text-[10.5px] font-medium text-[var(--color-text-muted)]">{unitCode}</span>}
          <span className="min-w-0 truncate">{skipped > 0 ? "… › " : ""}{tail.join(" › ") || crumbs[0]}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Pill color={color}>{hit.doctype}</Pill>
          {hit.year && <Pill color="var(--color-text-muted)">{hit.year}</Pill>}
          {hit.sheet && <Pill color="var(--cat-drawings)">Sht {hit.sheet}</Pill>}
          {hit.rev && <Pill color="var(--cat-drawings)">Rev {hit.rev}</Pill>}
          {hit.equipment.slice(0, 3).map((e) => (
            <button key={e.id} onClick={(ev) => { ev.stopPropagation(); onEquip(e.id); }} title={`${e.description} · ${e.unit ?? ""} · linked by ${e.via}`} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11.5px] font-medium hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer">
              <Boxes className="size-3" />{e.number}{e.tag ? ` · ${e.tag}` : ""}
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end justify-between gap-2">
        <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <IconButton label="Open" onClick={(e) => { e.stopPropagation(); onOpen(); }} className="size-7"><ExternalLink className="size-3.5" /></IconButton>
          <IconButton label="Show in folder" onClick={(e) => { e.stopPropagation(); onReveal(); }} className="size-7"><FolderOpen className="size-3.5" /></IconButton>
        </div>
        <div title={`Relevance score ${hit.score}`} className="h-1 w-12 overflow-hidden rounded-full bg-[var(--color-surface-3)]"><div className="h-full rounded-full" style={{ width: `${rel * 100}%`, background: "var(--color-text-faint)" }} /></div>
      </div>
    </div>
  );
}

function EquipmentCardView({ card, nav, onFilter }: { card: EquipCard; nav: Nav; onFilter: (c: string) => void }) {
  const total = card.by_category.reduce((s, c) => s + c.count, 0) || 1;
  return (
    <div className="mx-3 mt-3 mb-1 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-md animate-[var(--animate-rise)]">
      <div className="relative px-5 pt-4 pb-3">
        <div className="absolute inset-x-0 top-0 h-1" style={{ background: "var(--brand-gradient)" }} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[20px] font-[750] tracking-tight">{card.number}</span>
              {card.tags.map((t) => <Pill key={t} color="var(--color-accent)" className="text-[12px]">{t}</Pill>)}
              {card.kind && <Pill color="var(--color-text-muted)">{card.kind}</Pill>}
            </div>
            <div className="mt-0.5 text-[14px] text-[var(--color-text-muted)]">{card.description || "No description in THOR"}{card.unit ? <span className="text-[var(--color-text-faint)]"> · {card.unit}</span> : null}</div>
            {card.historical.length > 0 && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-[var(--color-warn)]"><History className="size-3.5" />{card.historical.map((h) => (h.startsWith("now ") ? `Renumbered: ${h}` : `Formerly ${h}`)).join(" · ")}</div>
            )}
            {card.hint_numbers.length > 0 && <div className="mt-1 text-[12px] text-[var(--color-text-faint)]">Possible old number{card.hint_numbers.length > 1 ? "s" : ""}: {card.hint_numbers.join(", ")} (unconfirmed)</div>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" icon={<Network className="size-3.5" />} onClick={() => nav.go("graph", { eq: card.id })}>Graph</Button>
            <Button size="sm" icon={<Layers className="size-3.5" />} onClick={() => nav.go("equipment", { id: card.id })}>Equipment page</Button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          <MiniStat label="Documents" value={n(card.files)} />
          <MiniStat label="Last inspection" value={card.latest_inspection ?? "—"} />
          <MiniStat label="Records from" value={card.first_year ?? "—"} />
          <MiniStat label="Drawing sets" value={card.drawing_families.length || "—"} />
        </div>
      </div>
      <div className="flex h-2 w-full">
        {card.by_category.map((c) => <div key={c.key} title={`${c.label}: ${c.count}`} style={{ width: `${(c.count / total) * 100}%`, background: catColor(c.key) }} />)}
      </div>
      <div className="flex flex-wrap gap-1.5 px-5 py-3">
        {card.by_category.map((c) => (
          <button key={c.key} onClick={() => onFilter(c.key)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2 py-1 text-[12px] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] cursor-pointer">
            <span className="size-2 rounded-full" style={{ background: catColor(c.key) }} />{c.label}<span className="tabular-nums text-[var(--color-text-faint)]">{c.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-[var(--color-surface-2)] px-3 py-2">
      <div className="truncate text-[11px] font-medium text-[var(--color-text-faint)]">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function NoResults({ resp, onTry }: { resp: SearchResponse; onTry: (q: string) => void }) {
  return (
    <Empty icon={<Search className="size-5" />} title={resp.notice ?? "No matches"}>
      Every word in the search must match a file's name, folder, type or equipment.
      {resp.suggestions.length > 0 && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {resp.suggestions.map((s) => <Button key={s} size="sm" onClick={() => onTry(s)}>Try “{s}”</Button>)}
        </div>
      )}
    </Empty>
  );
}

interface FileInfo { hit: Hit; family?: { base: string; kind: string; members: { id: number; name: string; sheet?: string; rev?: string; latest: boolean }[] } | null; folder_files: number }

function PreviewPane({ hit, state, onOpen, onEquip, nav }: { hit?: Hit; state: AppState; onOpen: (h: Hit, how?: "reveal" | "original") => void; onEquip: (id: number) => void; nav: Nav }) {
  const toast = useToast();
  const [tab, setTab] = useState<"preview" | "why" | "family">("preview");
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [width, setWidth] = useState(() => Number(localStorage.getItem("tp.previewWidth") ?? 460));
  useEffect(() => {
    setInfo(null);
    if (!hit) return;
    api<FileInfo>("file.info", { id: hit.id }).then(setInfo).catch(() => {});
  }, [hit?.id]);
  useEffect(() => { if (tab === "family" && !info?.family) setTab("preview"); }, [info, tab]);
  const drag = (e: React.MouseEvent) => {
    const start = e.clientX, w0 = width;
    const move = (ev: MouseEvent) => setWidth(Math.min(1100, Math.max(360, w0 - (ev.clientX - start))));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); localStorage.setItem("tp.previewWidth", String(width)); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  if (!hit) return <aside style={{ width }} className="shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)]"><Empty icon={<Info className="size-5" />} title="Select a result">The preview, why it matched and its related drawings appear here.</Empty></aside>;
  const copyPath = () => { navigator.clipboard?.writeText(hit.path).then(() => toast("ok", "Path copied")); };
  return (
    <aside style={{ width }} className="relative flex shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div onMouseDown={drag} className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--color-accent)_25%,transparent)]" />
      <div className="border-b border-[var(--color-border)] px-4 pt-3 pb-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="break-words text-[14px] font-semibold leading-snug">{hit.name}</div>
            <div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">{hit.doctype} · {bytes(hit.size)} · modified {dateFromSecs(hit.modified)}</div>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => onOpen(hit)} title={(state.prefs.open_mode ?? "copy") === "copy" ? "Opens a read-only copy so THOR can't be changed by accident" : "Opens the original file"}>Open</Button>
          <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => onOpen(hit, "reveal")}>Show in folder</Button>
          <Button size="sm" icon={<Clipboard className="size-3.5" />} onClick={copyPath}>Copy path</Button>
        </div>
        <div className="mt-3 flex gap-4 text-[12.5px]">
          {(["preview", "why", ...(info?.family ? ["family"] : [])] as const).map((t) => (
            <button key={t} onClick={() => setTab(t as typeof tab)} className={cx("-mb-[9px] border-b-2 pb-2 font-medium capitalize cursor-pointer", tab === t ? "border-[var(--color-accent)] text-[var(--color-text)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]")}>
              {t === "why" ? "Why this result" : t === "family" ? `Sheets & revisions (${info?.family?.members.length})` : "Preview"}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "preview" && <FilePreview hit={hit} />}
        {tab === "why" && (
          <div className="space-y-4 p-4">
            <div>
              <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Scoring ({hit.score} points)</div>
              <ul className="space-y-1.5">{(hit.reasons.length ? hit.reasons : ["Listed for this equipment"]).map((r, i) => <li key={i} className="flex items-start gap-2 text-[13px]"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />{r}</li>)}</ul>
            </div>
            {hit.equipment.length > 0 && (
              <div>
                <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Equipment</div>
                <div className="space-y-1.5">
                  {hit.equipment.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                      <Boxes className="size-4 text-[var(--color-accent)]" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold">{e.number}{e.tag ? ` · ${e.tag}` : ""}</div>
                        <div className="truncate text-[12px] text-[var(--color-text-muted)]">{e.description} · {e.unit} · {e.via === "folder" ? "in its folder" : e.via === "filename" ? "named in the filename" : "drawing family"}</div>
                      </div>
                      <IconButton label="Search this equipment" onClick={() => onEquip(e.id)} className="size-7"><Search className="size-3.5" /></IconButton>
                      <IconButton label="Graph" onClick={() => nav.go("graph", { eq: e.id })} className="size-7"><Network className="size-3.5" /></IconButton>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Location</div>
              <div className="break-all rounded-lg bg-[var(--color-surface-2)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{hit.path}</div>
              {info && <div className="mt-1.5 text-[12px] text-[var(--color-text-faint)]">{info.folder_files} file{info.folder_files === 1 ? "" : "s"} in this folder</div>}
            </div>
          </div>
        )}
        {tab === "family" && info?.family && (
          <div className="p-4">
            <div className="mb-3 text-[13px]"><span className="font-semibold">{info.family.base}</span> <span className="text-[var(--color-text-faint)]">· {info.family.kind}</span></div>
            <div className="space-y-1">
              {info.family.members.map((m) => (
                <div key={m.id} className={cx("flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px]", m.id === hit.id ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface-2)]")}>
                  <FileText className="size-3.5 shrink-0 text-[var(--color-text-faint)]" />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  {m.sheet && <Pill color="var(--cat-drawings)">Sht {m.sheet}</Pill>}
                  {m.rev && <Pill color="var(--cat-drawings)">Rev {m.rev}</Pill>}
                  {m.latest && <Pill color="var(--color-ok)">Latest</Pill>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

const IMG = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".jfif"];
const TIFF = [".tif", ".tiff"];
const TEXT = [".txt", ".log", ".csv", ".tsv", ".json", ".xml", ".ini", ".md", ".cfg"];

function FilePreview({ hit }: { hit: Hit }) {
  const e = hit.ext.toLowerCase();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(null);
  useEffect(() => {
    setText(null);
    setFailed(false);
    setReachable(null);
    api<{ ok: boolean }>("file.reachable", { id: hit.id }).then((r) => setReachable(r.ok)).catch(() => setReachable(false));
    if (!TEXT.includes(e)) return;
    fetch(fileUrl(hit.id, "text")).then(async (r) => (r.ok ? setText(await r.text()) : setFailed(true))).catch(() => setFailed(true));
  }, [hit.id, e]);
  if (reachable === false) return <Unavailable hit={hit} />;
  if (reachable === null) return <div className="p-4"><div className="skeleton h-64" /></div>;
  if (e === ".pdf") return <iframe key={hit.id} src={`${fileUrl(hit.id)}#view=FitH`} className="h-full min-h-[600px] w-full border-0 bg-[var(--color-surface-2)]" title={hit.name} />;
  if (IMG.includes(e) || TIFF.includes(e))
    return failed ? <Unavailable hit={hit} /> : (
      <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(var(--color-surface-2)_0%_25%,var(--color-surface)_0%_50%)] bg-[length:20px_20px] p-4">
        <img key={hit.id} src={fileUrl(hit.id, TIFF.includes(e) ? "png" : undefined)} onError={() => setFailed(true)} className="max-h-[80vh] max-w-full rounded-lg shadow-lg" alt={hit.name} />
      </div>
    );
  if (TEXT.includes(e)) return failed ? <Unavailable hit={hit} /> : text === null ? <div className="p-4"><div className="skeleton h-40" /></div> : <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[11.5px] leading-relaxed">{text}</pre>;
  return <Unavailable hit={hit} unsupported />;
}

function Unavailable({ hit, unsupported }: { hit: Hit; unsupported?: boolean }) {
  return (
    <Empty icon={extIcon(hit.ext, hit.category)} title={unsupported ? `${hit.ext.toUpperCase().slice(1) || "This"} files open in their own program` : "This file can't be reached right now"}>
      {unsupported ? "Use Open to view it in Word, Excel, AutoCAD or the program Windows uses for it. TracePoint opens a read-only copy by default." : "THOR may be offline, or the file was moved since the last scan."}
      {hit.category === "Photos" && <div className="mt-3 flex items-center justify-center gap-1.5 text-[12px]"><Camera className="size-3.5" /> HEIC photos need the Windows HEIF extension to preview.</div>}
    </Empty>
  );
}
