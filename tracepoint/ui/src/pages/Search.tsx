import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight, Boxes, Camera, CheckCircle2, Copy, ChevronDown, ChevronRight, Clipboard, Download, ExternalLink, File, FileImage, FileSpreadsheet, FileText, FolderOpen,
  History, Info, Layers, Mail, MapPin, Network, PanelRightClose, PanelRightOpen, PenTool, Search, Sparkles, X, Zap, FileArchive, FileCode2,
} from "lucide-react";
import { api, fileUrl } from "../lib/api";
import type { AppState, EquipCard, Facet, Hit, SearchRequest, SearchResponse } from "../lib/types";
import { Button, Empty, IconButton, Kbd, Pill, Spinner, Toggle, cx, useToast } from "../components/ui";
import { bytes, catColor, dateFromSecs, n } from "../lib/format";
import type { Nav } from "../Shell";

const EXAMPLES = [
  { q: "the thickness readings on the receiver in the crude unit from a couple years ago", d: "Just describe it — TracePoint works out the equipment, document type and dates" },
  { q: "can you find the nameplate for the separator", d: "Plain English: “nameplate” means U-1A / code documents" },
  { q: "pictures from when they patched the overhead line", d: "Photos + repairs" },
  { q: "V-2 inspection", d: "A tag used in several units: TracePoint asks which one" },
  { q: "relief valve test reports newest first", d: "Say how to sort it" },
  { q: "API 653 tank inspection", d: "Exact keyword search still works" },
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
  const [mode, setMode] = useState<"auto" | "exact">(() => (localStorage.getItem("tp.searchMode") === "exact" ? "exact" : "auto"));
  useEffect(() => {
    if (nav.params.q !== undefined && nav.params.q !== submitted) { setQuery(nav.params.q); setSubmitted(nav.params.q); setPinned(nav.params.eq ? Number(nav.params.eq) : null); }
    if (nav.params.eq && Number(nav.params.eq) !== pinned) { setPinned(Number(nav.params.eq)); if (!nav.params.q) { setQuery(""); setSubmitted(""); } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.params.q, nav.params.eq]);

  const request: SearchRequest = useMemo(
    () => ({ query: submitted, limit, equipment: pinned, ...filters, sort: filters.sort === "relevance" ? "" : filters.sort, mode }),
    [submitted, limit, pinned, filters, mode],
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

  // Results as you type: a short pause runs the search (not saved to recent).
  useEffect(() => {
    const t = query.trim();
    if (t.length < 3 || t === submitted) return;
    const h = setTimeout(() => {
      setSubmitted(t);
      setLimit(PAGE);
      setSelected(0);
      setPinned(null);
      setFilters((f) => ({ ...f, categories: [], units: [], exts: [] }));
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Enter on a search that's already showing a best match opens that file.
  const lastEnter = useRef("");
  const submit = (q: string) => {
    const t = q.trim();
    if (t && t === lastEnter.current && t === submitted && resp?.best && resp.hits[0]) {
      openFile(resp.hits[0]);
      return;
    }
    lastEnter.current = t;
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
  const [insideSel, setInsideSel] = useState<Hit | null>(null);
  useEffect(() => setInsideSel(null), [resp]);
  const sel = insideSel ?? (selected >= 0 ? hits[selected] : undefined);
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
                <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-0.5" title="Smart understands plain English and falls back to best fit; Exact uses TracePoint's strict keyword rules">
                  {(["auto", "exact"] as const).map((m) => (
                    <button key={m} onClick={() => { setMode(m); localStorage.setItem("tp.searchMode", m); }} className={cx("h-7 rounded-md px-2.5 text-[12px] font-medium cursor-pointer", mode === m ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)]")}>{m === "auto" ? "Smart" : "Exact"}</button>
                  ))}
                </div>
                <select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })} className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12.5px] outline-none cursor-pointer" title="Sort">
                  <option value="relevance">Best match</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option><option value="folder">By folder</option>
                </select>
                <Button size="sm" icon={<Download className="size-3.5" />} onClick={exportXlsx} disabled={!resp.total}>Excel</Button>
                <IconButton label={preview ? "Hide preview" : "Show preview"} onClick={togglePreview}>{preview ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}</IconButton>
              </div>
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
              {resp.notice && resp.total > 0 && !resp.best && <div className="mx-3 mt-3 flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--color-info)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-info)_6%,transparent)] px-3.5 py-2.5 text-[13px]"><Info className="mt-0.5 size-4 shrink-0 text-[var(--color-info)]" />{resp.notice}</div>}
              {resp.best && hits[0] && <BestMatch hit={hits[0]} why={resp.best} onOpen={() => openFile(hits[0])} onReveal={() => openFile(hits[0], "reveal")} onSelect={() => setSelected(0)} armed={lastEnter.current === submitted} />}
              {(resp.inside?.length ?? 0) > 0 && <InsideDocs hits={resp.inside!} selected={insideSel?.id} first={resp.total === 0} onSelect={(h) => setInsideSel(h)} onOpen={(h) => openFile(h)} />}
              {resp.card && <EquipmentCardView card={resp.card} nav={nav} onFilter={(c) => setFilters({ ...filters, categories: [c] })} />}
              {resp.total === 0 ? (
                <NoResults resp={resp} onTry={(q) => { setQuery(q); submit(q); }} />
              ) : (
                <div>
                  {hits.map((h, i) => (
                    <ResultRow key={h.id} hit={h} i={i} active={i === selected} words={words} topScore={hits[0]?.score ?? 1} onSelect={() => { setInsideSel(null); setSelected(i); }} onOpen={() => openFile(h)} onReveal={() => openFile(h, "reveal")} onEquip={(id) => { setPinned(id); setSubmitted(""); setQuery(""); }} />
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
          placeholder="Describe what you need — or type a number, tag or keywords…"
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
  concept: { color: "var(--color-violet)", label: "Looking for" },
  ignored: { color: "var(--color-text-faint)", label: "Ignored" },
};

/** Plain-English summary of how the search was read: one sentence with the
 *  parts that matter in bold. The raw chips sit behind "Details". */
function Interpretation({ resp, pinned, onUnpin, onPick }: { resp: SearchResponse; pinned: number | null; onUnpin: () => void; onPick: (id: number) => void }) {
  const [details, setDetails] = useState(false);
  const of = (k: string) => resp.chips.filter((c) => c.kind === k);
  const B = ({ children, color }: { children: ReactNode; color?: string }) => <b className="font-[650] text-[var(--color-text)]" style={color ? { boxShadow: `inset 0 -0.35em 0 color-mix(in srgb, ${color} 18%, transparent)` } : undefined}>{children}</b>;
  const list = (xs: ReactNode[]) => xs.flatMap((x, i) => (i === 0 ? [x] : i === xs.length - 1 ? [" and ", x] : [", ", x]));
  const what = of("concept").map((c) => <B key={c.text} color="var(--color-violet)">{c.text.toLowerCase()}</B>);
  const eqs = [...of("equipment"), ...of("tag")].map((c) => <B key={c.text} color="var(--color-accent)">{c.text}{c.kind === "equipment" && c.detail ? ` ${c.detail.split(" — ")[0]}` : ""}</B>);
  const units = of("unit").map((c) => <B key={c.text} color="var(--color-ok)">{c.text}</B>);
  const words = [...of("word"), ...of("phrase"), ...of("wildcard"), ...of("sheet"), ...of("rev")].map((c) => <B key={c.kind + c.text}>{c.text}</B>);
  const year = of("year")[0];
  const sort = of("recent")[0];
  const fixes = of("fuzzy");
  const sentence: ReactNode[] = [];
  sentence.push(what.length ? <>Finding {list(what)}</> : <>Finding files</>);
  if (eqs.length) sentence.push(<> for {list(eqs)}</>);
  if (units.length) sentence.push(<> in {list(units)}</>);
  if (words.length) sentence.push(<> {what.length || eqs.length ? "mentioning" : "matching"} {list(words)}</>);
  if (year) sentence.push(<> from <B color="var(--cat-code)">{year.text}</B></>);
  if (sort) sentence.push(<>, <B>{sort.text}</B></>);
  return (
    <div className="mt-3 space-y-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <p className="text-[15.5px] leading-snug text-[var(--color-text-muted)]">{sentence}.</p>
        {fixes.length > 0 && <span className="text-[13px] text-[var(--color-text-faint)]">Spelling fixed: {fixes.map((f) => `${f.detail.replace(/^you typed /, "")} → ${f.text}`).join(", ")}</span>}
        {pinned != null && (
          <button onClick={onUnpin} className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-accent-soft)] px-2 py-0.5 text-[12.5px] font-medium text-[var(--color-accent)] cursor-pointer">
            One piece of equipment only <X className="size-3" />
          </button>
        )}
        <button onClick={() => setDetails(!details)} className="text-[12.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:underline cursor-pointer">{details ? "Hide details" : "Details"}</button>
      </div>
      {details && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {resp.chips.map((c, i) => {
            const st = CHIP_STYLE[c.kind] ?? CHIP_STYLE.word;
            return (
              <span key={i} title={c.detail} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[12px]">
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: st.color }}>{st.label}</span>
                <span className="font-medium">{c.text}</span>
                {c.detail && c.kind !== "ignored" && <span className="max-w-[280px] truncate text-[var(--color-text-faint)]">{c.detail}</span>}
              </span>
            );
          })}
        </div>
      )}
      {resp.ambiguity.map((a) => (
        <div key={a.token} className="rounded-xl border border-[color-mix(in_srgb,var(--color-info)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-info)_6%,transparent)] p-3.5 animate-[var(--animate-rise)]">
          <div className="flex items-center gap-2 text-[14px] font-semibold"><MapPin className="size-4 text-[var(--color-info)]" /> {a.token.startsWith("the equipment") ? "Which equipment did you mean?" : `Which ${a.token}?`}<span className="font-normal text-[var(--color-text-muted)]">{a.token.startsWith("the equipment") ? `${a.options.length} fit your description — showing all until you pick one.` : `${a.options.length} pieces of equipment use that tag — showing all until you pick one.`}</span></div>
          <div className="mt-2.5 flex gap-2 overflow-x-auto pb-1">
            {a.options.map((o) => (
              <button key={o.id} onClick={() => onPick(o.id)} className="group shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left shadow-xs transition hover:border-[var(--color-accent)] hover:shadow-md cursor-pointer">
                <div className="text-[14px] font-bold">{o.number}{o.tag ? <span className="ml-1.5 font-semibold text-[var(--color-accent)]">{o.tag}</span> : null}</div>
                <div className="max-w-[240px] truncate text-[13px] text-[var(--color-text)]">{o.description || "—"}</div>
                <div className="text-[11.5px] text-[var(--color-text-faint)]">{o.unit} · {n(o.files)} files</div>
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
      <button onClick={() => setOpen(!open)} className="mb-1.5 flex w-full items-center justify-between text-[13.5px] font-bold text-[var(--color-text)] cursor-pointer">
        {title} {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

function FacetRow({ label, count, max, active, color, onClick }: { label: string; count: number; max: number; active: boolean; color?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx("relative flex w-full items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-[13.5px] transition cursor-pointer", active ? "bg-[var(--color-accent-soft)] font-semibold text-[var(--color-text)]" : "hover:bg-[var(--color-surface-3)] text-[var(--color-text-muted)]")}>
      <span className="absolute inset-y-1 left-0 rounded-r opacity-[0.09]" style={{ width: `${Math.max(4, (count / Math.max(1, max)) * 100)}%`, background: color ?? "var(--color-text)" }} />
      {color && <span className="relative size-2 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="relative min-w-0 flex-1 truncate">{label}</span>
      <span className="relative tabular-nums text-[12.5px] font-medium text-[var(--color-text-faint)]">{n(count)}</span>
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
      <div className="flex h-12 items-center justify-between border-b border-[var(--color-border)] px-4 text-[15px] font-bold">
        Narrow down
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
          {f.units.slice(0, 8).map((u) => <FacetRow key={u.key} label={u.label} count={u.count} max={maxUnit} active={filters.units.includes(u.key)} onClick={() => toggle("units", u.key)} />)}
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

function ResultRow({ hit, i, active, words, onSelect, onOpen, onReveal, onEquip }: { hit: Hit; i: number; active: boolean; words: string[]; topScore: number; onSelect: () => void; onOpen: () => void; onReveal: () => void; onEquip: (id: number) => void }) {
  const color = catColor(hit.category);
  const crumbs = hit.folder.split("\\").filter(Boolean);
  const tail = crumbs.slice(-3);
  const flags = [hit.latest && "Latest revision", hit.archived && "Archive", hit.blank && "Blank template", hit.sheet && `Sheet ${hit.sheet}`, hit.rev && `Rev ${hit.rev}`].filter(Boolean) as string[];
  return (
    <div
      data-row={i}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cx(
        "group relative flex cursor-default gap-3.5 border-b border-[var(--color-border)] px-4 py-3 transition-colors",
        active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface)]",
      )}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[3px] bg-[var(--color-accent)]" />}
      <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}>{extIcon(hit.ext, hit.category)}</div>
      <div className="min-w-0 flex-1">
        <div className={cx("truncate text-[15px] font-semibold leading-snug text-[var(--color-text)]", hit.junk && "opacity-60")}>{highlight(hit.name, words)}</div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[13px]">
          <span className="shrink-0 font-semibold" style={{ color }}>{hit.doctype}</span>
          {hit.year && <><span className="text-[var(--color-text-faint)]">·</span><span className="shrink-0 font-semibold tabular-nums text-[var(--color-text)]">{hit.year}</span></>}
          {hit.equipment.slice(0, 2).map((e) => (
            <span key={e.id} className="contents">
              <span className="text-[var(--color-text-faint)]">·</span>
              <button onClick={(ev) => { ev.stopPropagation(); onEquip(e.id); }} title={`${e.description} · ${e.unit ?? ""} · linked by ${e.via}`} className="shrink-0 font-medium text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:underline cursor-pointer">
                {e.number}{e.tag ? ` ${e.tag}` : ""}
              </button>
            </span>
          ))}
          {flags.map((f) => <span key={f} className="shrink-0 rounded bg-[var(--color-surface-3)] px-1.5 text-[11.5px] font-medium text-[var(--color-text-muted)]">{f}</span>)}
        </div>
        <LinkChips hit={hit} />
        {hit.snippet && <div className="mt-1 line-clamp-2 text-[13px] text-[var(--color-text-muted)]"><span className="mr-1.5 font-semibold text-[var(--color-text)]">p.{hit.page}</span>{snippetNodes(hit.snippet)}</div>}
        <div className="mt-0.5 truncate text-[12px] text-[var(--color-text-faint)]" title={hit.folder}>{crumbs.length > 3 ? "… › " : ""}{tail.join(" › ")}</div>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition group-hover:opacity-100">
        <IconButton label="Open" onClick={(e) => { e.stopPropagation(); onOpen(); }} className="size-8"><ExternalLink className="size-4" /></IconButton>
        <IconButton label="Show in folder" onClick={(e) => { e.stopPropagation(); onReveal(); }} className="size-8"><FolderOpen className="size-4" /></IconButton>
      </div>
    </div>
  );
}

/** What the linker found about this file, at a glance. */
function LinkChips({ hit }: { hit: Hit }) {
  const chips: { t: string; c: string; title?: string }[] = [];
  if (hit.stale_copy) chips.push({ t: "Old revision, saved recently", c: "var(--color-bad)", title: hit.newer?.why ?? "" });
  else if (hit.newer) chips.push({ t: "Newer revision exists", c: "var(--color-warn)", title: hit.newer.why ?? "" });
  if (hit.home) chips.push({ t: `Copy · ${hit.copies + 1} in all`, c: "var(--color-text-muted)", title: `Best-kept copy: ${hit.home.folder}` });
  if (hit.stranded_for.length) chips.push({ t: `Belongs with ${hit.stranded_for.slice(0, 2).join(", ")}`, c: "var(--color-violet)", title: "About this equipment, but not filed in its folder" });
  if (hit.private) chips.push({ t: "Private", c: "var(--color-info)", title: "One of your private folders — only you see it" });
  if (!chips.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {chips.map((x) => (
        <span key={x.t} title={x.title} className="rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold" style={{ color: x.c, background: `color-mix(in srgb, ${x.c} 12%, transparent)` }}>{x.t}</span>
      ))}
    </div>
  );
}

/** Newer revision / best-kept copy / where it belongs, with one click to the better file. */
function Connections({ hit, state, nav }: { hit: Hit; state: AppState; nav: Nav }) {
  const toast = useToast();
  const open = (id: number) => api("file.open", { id, mode: state.prefs.open_mode ?? "copy" }).catch((e) => toast("error", (e as Error).message));
  const rows: ReactNode[] = [];
  if (hit.newer) rows.push(
    <div key="n" className="rounded-xl border p-2.5" style={{ borderColor: "color-mix(in srgb, var(--color-warn) 45%, transparent)", background: "color-mix(in srgb, var(--color-warn) 7%, transparent)" }}>
      <div className="text-[12.5px] font-semibold" style={{ color: "var(--color-warn)" }}>{hit.stale_copy ? "Old revision — saved more recently than the newest one" : "A newer revision exists"}</div>
      <div className="mt-0.5 truncate text-[13px] font-medium" title={hit.newer.name}>{hit.newer.name}</div>
      <div className="truncate text-[11.5px] text-[var(--color-text-faint)]" title={hit.newer.folder}>{hit.newer.folder}</div>
      {hit.newer.why && <div className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">{hit.newer.why}</div>}
      <Button size="sm" className="mt-1.5" icon={<ExternalLink className="size-3.5" />} onClick={() => open(hit.newer!.id)}>Open the newer one</Button>
    </div>,
  );
  if (hit.home) rows.push(
    <div key="h" className="rounded-xl border border-[var(--color-border)] p-2.5">
      <div className="text-[12.5px] font-semibold text-[var(--color-text-muted)]">A copy — {hit.copies + 1} identical files. The best-kept one:</div>
      <div className="mt-0.5 truncate text-[12px]" title={hit.home.folder}>{hit.home.folder}</div>
      <Button size="sm" className="mt-1.5" icon={<ExternalLink className="size-3.5" />} onClick={() => open(hit.home!.id)}>Open that one</Button>
    </div>,
  );
  if (hit.stranded_for.length) rows.push(
    <div key="s" className="rounded-xl border p-2.5" style={{ borderColor: "color-mix(in srgb, var(--color-violet) 40%, transparent)" }}>
      <div className="text-[12.5px] font-semibold" style={{ color: "var(--color-violet)" }}>About {hit.stranded_for.join(", ")} — but not filed in its folder</div>
      <Button size="sm" className="mt-1.5" icon={<Search className="size-3.5" />} onClick={() => nav.go("search", { q: hit.stranded_for[0] })}>See all of {hit.stranded_for[0]}</Button>
    </div>,
  );
  if (!rows.length) return null;
  return <div className="space-y-2 border-b border-[var(--color-border)] p-3">{rows}</div>;
}

/** «word» → bold. */
function snippetNodes(s: string): ReactNode {
  return s.split(/(«[^»]*»)/).map((p, i) => (p.startsWith("«") ? <b key={i} className="font-bold text-[var(--color-text)]">{p.slice(1, -1)}</b> : p));
}

/** Matches found in the text of documents (PDF text, Word/Excel, OCR). */
function InsideDocs({ hits, selected, first, onSelect, onOpen }: { hits: Hit[]; selected?: number; first: boolean; onSelect: (h: Hit) => void; onOpen: (h: Hit) => void }) {
  const [all, setAll] = useState(false);
  const shown = all || first ? hits : hits.slice(0, 3);
  return (
    <div className="mx-4 mt-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-2.5">
        <FileText className="size-4 text-[var(--color-info)]" />
        <span className="text-[14.5px] font-bold">Found inside documents</span>
        <span className="text-[13px] text-[var(--color-text-faint)]">{hits.length} · words in the text, not just the name</span>
      </div>
      {shown.map((h) => (
        <div key={`${h.id}-${h.page}`} onClick={() => onSelect(h)} onDoubleClick={() => onOpen(h)} className={cx("group flex cursor-default gap-3 border-b border-[var(--color-border)] px-5 py-2.5 last:border-0", selected === h.id ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface-2)]")}>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[14.5px] font-semibold">{h.name}</span>
              <span className="shrink-0 rounded bg-[var(--color-surface-3)] px-1.5 text-[12px] font-semibold text-[var(--color-text-muted)]">page {h.page}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-[var(--color-text-muted)]">{snippetNodes(h.snippet ?? "")}</div>
            <div className="mt-0.5 truncate text-[12px] text-[var(--color-text-faint)]">{h.doctype}{h.year ? ` · ${h.year}` : ""}{h.equipment[0] ? ` · ${h.equipment[0].number}${h.equipment[0].tag ? " " + h.equipment[0].tag : ""}` : ""}</div>
          </div>
          <IconButton label="Open" onClick={(e) => { e.stopPropagation(); onOpen(h); }} className="size-8 opacity-0 group-hover:opacity-100"><ExternalLink className="size-4" /></IconButton>
        </div>
      ))}
      {!first && hits.length > 3 && <button onClick={() => setAll(!all)} className="w-full py-2 text-[13px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer">{all ? "Show fewer" : `Show ${hits.length - 3} more`}</button>}
    </div>
  );
}

/** The answer, when TracePoint is confident: big, with why and one-click open. */
function BestMatch({ hit, why, onOpen, onReveal, onSelect, armed }: { hit: Hit; why: string; onOpen: () => void; onReveal: () => void; onSelect: () => void; armed: boolean }) {
  const toast = useToast();
  const color = catColor(hit.category);
  return (
    <div onClick={onSelect} className="mx-4 mt-4 overflow-hidden rounded-2xl border-2 border-[color-mix(in_srgb,var(--color-ok)_45%,transparent)] bg-[var(--color-surface)] shadow-md animate-[var(--animate-rise)]">
      <div className="flex items-start gap-4 px-5 py-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{extIcon(hit.ext, hit.category)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12.5px] font-bold uppercase tracking-wide text-[var(--color-ok)]"><CheckCircle2 className="size-4" />Best match</div>
          <div className="mt-0.5 break-words text-[19px] font-[750] leading-snug tracking-tight">{hit.name}</div>
          <div className="mt-1 text-[14.5px] font-medium text-[var(--color-text)]">{why}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-[var(--color-text-faint)]" title={hit.folder}>{hit.folder}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button variant="primary" icon={<ExternalLink className="size-4" />} onClick={(e) => { e.stopPropagation(); onOpen(); }}>Open</Button>
          <div className="flex gap-1">
            <IconButton label="Show in folder" onClick={(e) => { e.stopPropagation(); onReveal(); }}><FolderOpen className="size-4" /></IconButton>
            <IconButton label="Copy path" onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(hit.path).then(() => toast("ok", "Path copied")); }}><Copy className="size-4" /></IconButton>
          </div>
        </div>
      </div>
      {armed && <div className="border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ok)_6%,transparent)] px-5 py-1.5 text-[12.5px] text-[var(--color-text-muted)]">Press <Kbd>Enter</Kbd> again to open it · <Kbd>↓</Kbd> for the other results</div>}
    </div>
  );
}

function EquipmentCardView({ card, nav, onFilter }: { card: EquipCard; nav: Nav; onFilter: (c: string) => void }) {
  const total = card.by_category.reduce((s, c) => s + c.count, 0) || 1;
  const facts = [`${n(card.files)} documents`, card.latest_inspection ? `last inspected ${card.latest_inspection}` : "no dated inspection", card.first_year ? `records since ${card.first_year}` : null, card.drawing_families.length ? `${card.drawing_families.length} drawing sets` : null].filter(Boolean);
  return (
    <div className="mx-4 mt-4 mb-2 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm animate-[var(--animate-rise)]">
      <div className="px-5 pt-4 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">{card.kind || "Equipment"}{card.unit ? ` · ${card.unit}` : ""}</div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5">
              <span className="text-[24px] font-[800] tracking-tight">{card.number}</span>
              {card.tags.length > 0 && <span className="text-[20px] font-[700] text-[var(--color-accent)]">{card.tags[0]}</span>}
              <span className="text-[18px] font-semibold text-[var(--color-text)]">{card.description || "No description in THOR"}</span>
            </div>
            <div className="mt-1 text-[14px] text-[var(--color-text-muted)]">{facts.join(" · ")}</div>
            {card.historical.length > 0 && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-warn)]"><History className="size-4" />{card.historical.map((h) => (h.startsWith("now ") ? `Renumbered: ${h}` : `Formerly ${h}`)).join(" · ")}</div>
            )}
            {card.hint_numbers.length > 0 && <div className="mt-1 text-[12.5px] text-[var(--color-text-faint)]">Possible old number{card.hint_numbers.length > 1 ? "s" : ""}: {card.hint_numbers.join(", ")} (unconfirmed)</div>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" icon={<Network className="size-3.5" />} onClick={() => nav.go("graph", { eq: card.id })}>Graph</Button>
            <Button size="sm" variant="primary" icon={<Layers className="size-3.5" />} onClick={() => nav.go("equipment", { id: card.id })}>Open equipment</Button>
          </div>
        </div>
      </div>
      <div className="flex h-1.5 w-full">
        {card.by_category.map((c) => <div key={c.key} title={`${c.label}: ${c.count}`} style={{ width: `${(c.count / total) * 100}%`, background: catColor(c.key) }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 py-2.5">
        {card.by_category.map((c) => (
          <button key={c.key} onClick={() => onFilter(c.key)} title={`Show only ${c.label}`} className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline cursor-pointer">
            <span className="size-2 rounded-full" style={{ background: catColor(c.key) }} />{c.label}<span className="font-semibold tabular-nums text-[var(--color-text)]">{c.count}</span>
          </button>
        ))}
      </div>
      {card.elsewhere_total > 0 && <Elsewhere card={card} />}
    </div>
  );
}

/** Documents about this equipment that live somewhere else on THOR. */
function Elsewhere({ card }: { card: EquipCard }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const list = open ? card.elsewhere : card.elsewhere.slice(0, 3);
  return (
    <div className="border-t border-[var(--color-border)] px-5 py-3">
      <div className="flex items-center gap-2 text-[13.5px] font-semibold" style={{ color: "var(--color-violet)" }}>
        <FolderOpen className="size-4" /> {card.elsewhere_total} more document{card.elsewhere_total === 1 ? "" : "s"} about {card.number} filed elsewhere
      </div>
      <div className="mt-1.5 space-y-1">
        {list.map((f) => (
          <div key={f.id} className="flex items-center gap-2 text-[12.5px]">
            <button onClick={() => api("file.open", { id: f.id }).catch((e) => toast("error", (e as Error).message))} className="truncate font-medium hover:text-[var(--color-accent)] hover:underline cursor-pointer" title={f.why ?? ""}>{f.name}</button>
            <span className="truncate text-[var(--color-text-faint)]" title={f.folder}>{f.folder.split("\\").slice(-2).join(" › ")}</span>
          </div>
        ))}
      </div>
      {card.elsewhere.length > 3 && <button onClick={() => setOpen(!open)} className="mt-1 text-[12.5px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer">{open ? "Show fewer" : `Show ${card.elsewhere.length - 3} more`}</button>}
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
        <Connections hit={hit} state={state} nav={nav} />
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
                        <div className="truncate text-[12px] text-[var(--color-text-muted)]">{e.description} · {e.unit} · {e.via === "folder" ? "in its folder" : e.via === "filename" ? "named in the filename" : e.via === "contents" ? "found in the document's contents" : "drawing family"}</div>
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
  if (e === ".pdf") return <iframe key={`${hit.id}-${hit.page ?? 0}`} src={`${fileUrl(hit.id)}#${hit.page ? `page=${hit.page}&` : ""}view=FitH`} className="h-full min-h-[600px] w-full border-0 bg-[var(--color-surface-2)]" title={hit.name} />;
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
