import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Database, FileStack, FolderTree, HardDrive, Import, Layers, Lock, Play, RefreshCw, ScanLine, ShieldCheck, Square, Timer, TriangleAlert } from "lucide-react";
import { api, onEvent } from "../lib/api";
import type { AppState } from "../lib/types";
import { Button, Pill, Section, Spinner, Stat, cx, useToast } from "../components/ui";
import { catColor, fullDate, n, when } from "../lib/format";

interface Root { root_id: string; path: string; created_at: string; last_crawl_at?: string | null; last_crawl_started?: string | null; last_crawl_completed?: string | null; last_crawl_status?: string | null; files_seen: number; dirs_seen: number; issues: number; files_indexed: number; enabled: boolean }
interface Status {
  state: { ready: boolean; message: string; source: string; source_kind: string };
  roots: Root[];
  stats: { files: number; folders: number; equipment: number; units: number; families: number; load_ms: number; with_equipment: number; categories: Record<string, number> };
  generated_at?: string | null;
  protected: string[];
  writable: string[];
  team: AppState["team"];
  groups: { open: number; locked: number; hidden: number; unavailable: number };
  published?: Published | null;
}
interface Published { at: string; groups: number; files: number; open_to_everyone: number; refused: { group: string; files: number; reason: string }[]; unreadable: number }
interface ScanState { running: boolean; root?: string; phase?: string; files?: number; dirs?: number; new?: number; changed?: number; missing?: number; errors?: number; files_per_sec?: number; started?: string; log?: string[]; finished?: string | null; error?: string | null }

interface ContentState { running: boolean; phase: string; total: number; done: number; pages: number; ocr_pages: number; unreadable_pages: number; staged_for_ai: number; errors: number; files_per_min: number; eta_min?: number | null; current?: string | null; started?: string | null; finished?: string | null; error?: string | null; pdf_engine: boolean; ocr_engine: boolean; files_read_total: number }

function ContentPanel({ canIndex }: { canIndex: boolean }) {
  const [c, setC] = useState<ContentState | null>(null);
  const toast = useToast();
  useEffect(() => { api<ContentState>("content.status").then(setC).catch(() => {}); }, []);
  useEffect(() => onEvent("content", (p: ContentState) => setC(p)), []);
  if (!c) return null;
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const start = async () => { try { await api("content.start"); toast("info", "Reading document contents in the background"); } catch (e) { toast("error", (e as Error).message); } };
  const fmtEta = (m?: number | null) => (m == null ? "" : m < 1 ? "under a minute left" : m < 90 ? `about ${Math.round(m)} min left` : `about ${(m / 60).toFixed(1)} h left`);
  return (
    <Section className="mt-6" title="Document contents" subtitle="Reads the text inside PDFs, Word and Excel files — and scanned pages with the OCR built into Windows — so search finds words inside documents. Free and local; THOR is only read.">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]">
        <div><span className="text-[22px] font-bold tabular-nums">{n(c.files_read_total)}</span> <span className="text-[var(--color-text-muted)]">documents searchable by content</span></div>
        <Pill color={c.pdf_engine || !c.started ? "var(--color-ok)" : "var(--color-bad)"}>PDF engine {c.pdf_engine || !c.started ? "ready" : "unavailable"}</Pill>
        {c.started && <Pill color={c.ocr_engine ? "var(--color-ok)" : "var(--color-warn)"}>{c.ocr_engine ? "Windows OCR ready" : "OCR unavailable on this PC"}</Pill>}
        <div className="ml-auto flex gap-2">
          {canIndex && (c.running ? <Button icon={<Square className="size-4" />} onClick={() => api("content.stop")}>Stop (keeps what's read)</Button> : <Button variant="primary" icon={<ScanLine className="size-4" />} onClick={start}>Read new & changed documents</Button>)}
        </div>
      </div>
      {(c.running || c.finished) && (
        <div className="mt-4 rounded-xl border border-[var(--color-border)] p-4">
          <div className="flex items-baseline justify-between gap-4">
            <div className="text-[16px] font-bold">{c.running ? (c.phase === "reading" ? `Reading documents — ${pct}%` : c.phase) : c.phase === "stopped" ? "Stopped — what was read is saved" : "Finished"}</div>
            <div className="text-[13px] text-[var(--color-text-muted)]">{c.running ? `${n(Math.round(c.files_per_min))} documents/min · ${fmtEta(c.eta_min)}` : c.finished ? `finished ${when(c.finished)}` : ""}</div>
          </div>
          {c.running && <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-surface-3)]"><div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} /></div>}
          <div className="mt-2.5 text-[14px]">
            <b className="tabular-nums">{n(c.done)}</b> of {n(c.total)} documents · <b className="tabular-nums">{n(c.pages)}</b> pages with text · <b className="tabular-nums">{n(c.ocr_pages)}</b> read by OCR
            {c.errors ? <> · <b className="tabular-nums text-[var(--color-bad)]">{n(c.errors)}</b> couldn't be opened</> : null}
          </div>
          {c.staged_for_ai > 0 && <div className="mt-1.5 text-[13.5px] text-[var(--color-text-muted)]"><b className="text-[var(--color-violet)]">{n(c.staged_for_ai)}</b> valuable pages had no readable text even after OCR — they're waiting for your decision on AI reading (nothing is sent anywhere until an administrator approves a cost).</div>}
          {c.running && c.current && <div className="mt-1.5 truncate text-[12.5px] text-[var(--color-text-faint)]">Now: {c.current}</div>}
          {c.error && <div className="mt-1.5 text-[13px] text-[var(--color-bad)]">{c.error}</div>}
        </div>
      )}
    </Section>
  );
}

interface AiReadSummary {
  staged: number; by_category: Record<string, number>; top: { id: number; name: string; page: number; value: number; doctype: string; year?: number; folder: string }[];
  provider?: string | null; model?: string | null; per_page: number; per_page_worst: number; price_basis: string; cap_index_usd: number; left_index_usd: number;
  running: AiRead;
}
interface AiRead { running: boolean; approved: number; done: number; empty: number; failed: number; spent_usd: number; model?: string | null; current?: string | null; finished?: string | null; stopped_reason?: string | null }

/** Pages the free OCR couldn't read, offered for AI reading: you choose how
 *  many (most valuable first) with a live cost estimate; nothing is sent
 *  until you approve. */
function AiReadPanel() {
  const [sum, setSum] = useState<AiReadSummary | null>(null);
  const [run, setRun] = useState<AiRead | null>(null);
  const [count, setCount] = useState(0);
  const toast = useToast();
  const load = useCallback(() => api<AiReadSummary>("airead.summary").then((x) => {
    setSum(x); setRun(x.running);
    const affordable = x.per_page_worst > 0 ? Math.floor(x.left_index_usd / x.per_page_worst) : 0;
    setCount(Math.min(x.staged, Math.max(0, affordable), 500));
  }).catch(() => setSum(null)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onEvent("airead", (p: AiRead) => { setRun(p); if (!p.running) load(); }), [load]);
  useEffect(() => onEvent("content", (p: { running: boolean }) => { if (!p.running) load(); }), [load]);
  if (!sum || (sum.staged === 0 && !run?.running && !run?.finished)) return null;
  const est = count * sum.per_page, worst = count * sum.per_page_worst;
  const over = worst > sum.left_index_usd;
  const money = (x: number) => (x < 1 ? `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}¢` : `$${x.toFixed(2)}`);
  const start = async () => {
    if (!confirm(`Send ${count} page images to ${sum.model} for reading?\n\nEstimated ${money(est)} (at most ${money(worst)}), charged to your own API key. You can stop at any time.`)) return;
    try { await api("airead.start", { count }); toast("info", "AI reading started"); } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <Section className="mt-6" title="AI reading of unreadable pages" subtitle="Valuable pages where the free OCR found no readable text. Only what you approve is sent, to your own AI provider, within your document-reading budget.">
      {run?.running ? (
        <div className="rounded-xl border border-[var(--color-border)] p-4">
          <div className="flex items-baseline justify-between gap-4">
            <div className="text-[16px] font-bold">Reading pages with {run.model} — {run.done + run.empty + run.failed} of {run.approved}</div>
            <Button icon={<Square className="size-4" />} onClick={() => api("airead.stop")}>Stop</Button>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-surface-3)]"><div className="h-full rounded-full bg-[var(--color-violet)] transition-all" style={{ width: `${((run.done + run.empty + run.failed) / Math.max(1, run.approved)) * 100}%` }} /></div>
          <div className="mt-2 text-[14px]"><b>{run.done}</b> read · {run.empty} blank · {run.failed} failed · spent <b>{money(run.spent_usd)}</b></div>
          {run.current && <div className="mt-1 truncate text-[12.5px] text-[var(--color-text-faint)]">Now: {run.current}</div>}
        </div>
      ) : (
        <div className="grid grid-cols-[1.1fr_1fr] gap-6">
          <div>
            <div className="text-[15px]"><b className="text-[22px] tabular-nums">{n(sum.staged)}</b> valuable pages couldn't be read for free.</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-[var(--color-text-muted)]">{Object.entries(sum.by_category).sort((a, b) => b[1] - a[1]).map(([k, v]) => <span key={k}>{k} <b className="text-[var(--color-text)]">{n(v)}</b></span>)}</div>
            {sum.model ? (
              <>
                <div className="mt-4 flex items-center gap-3">
                  <input type="range" min={0} max={sum.staged} step={1} value={count} onChange={(e) => setCount(Number(e.target.value))} className="flex-1 accent-[var(--color-violet)]" />
                  <span className="w-20 text-right text-[15px] font-bold tabular-nums">{n(count)}</span>
                </div>
                <div className="mt-2 text-[14.5px]">
                  Read the <b>{n(count)}</b> most valuable pages with <b className="font-mono text-[13px]">{sum.model}</b>: about <b>{money(est)}</b> <span className="text-[var(--color-text-muted)]">(at most {money(worst)})</span>
                </div>
                <div className={cx("mt-1 text-[13px]", over ? "text-[var(--color-bad)]" : "text-[var(--color-text-muted)]")}>{money(sum.left_index_usd)} left of {money(sum.cap_index_usd)} for document reading this month{over ? " — the job will stop when the budget runs out" : ""}.</div>
                {sum.price_basis === "unlisted" && <div className="mt-1 text-[13px] text-[var(--color-warn)]">No published price on file for this model; estimated at the provider's highest price.</div>}
                <div className="mt-3"><Button variant="primary" disabled={count === 0} onClick={start}>Approve & read {n(count)} pages</Button></div>
              </>
            ) : (
              <div className="mt-3 text-[13.5px] text-[var(--color-text-muted)]">Set up your AI key in Profile › AI to read these pages.</div>
            )}
            {run?.finished && <div className="mt-3 text-[13px] text-[var(--color-text-muted)]">Last run: {run.done} read, {run.empty} blank, {run.failed} failed, {money(run.spent_usd)}{run.stopped_reason ? ` — ${run.stopped_reason}` : ""}.</div>}
          </div>
          <div className="rounded-xl border border-[var(--color-border)] p-3">
            <div className="mb-1.5 text-[13px] font-bold">Read first (highest value)</div>
            <div className="max-h-[220px] space-y-1 overflow-y-auto text-[12.5px]">
              {sum.top.slice(0, 40).map((t, i) => (
                <div key={`${t.id}-${t.page}`} className={cx("flex gap-2", i >= count && "opacity-40")}>
                  <span className="w-5 shrink-0 text-right tabular-nums text-[var(--color-text-faint)]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate" title={t.folder}><b>{t.name}</b> · p.{t.page}</span>
                  <span className="shrink-0 text-[var(--color-text-faint)]">{t.doctype}{t.year ? ` · ${t.year}` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

export function SourcesPage({ state, refresh }: { state: AppState; refresh: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [scan, setScan] = useState<ScanState | null>(null);
  const toast = useToast();
  const canIndex = state.user?.role === "admin" || state.user?.role === "indexer";
  const load = useCallback(() => { api<Status>("index.status").then(setSt).catch((e) => toast("error", e.message)); api<ScanState>("indexer.status").then(setScan).catch(() => {}); }, [toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onEvent("index", () => load()), [load]);
  useEffect(() => onEvent("scan", (p: ScanState) => setScan(p)), []);
  if (!st) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const cats = Object.entries(st.stats.categories ?? {}).sort((a, b) => b[1] - a[1]);
  const total = st.stats.files || 1;
  const share = async () => {
    try { const r = await api<{ message: string }>("index.share"); toast("ok", r.message); load(); } catch (e) { toast("error", (e as Error).message); }
  };

  const reload = async () => { await api("index.reload"); toast("info", "Reloading the index…"); setTimeout(refresh, 400); };
  const importDb = async () => {
    try {
      const r = await api<{ imported?: string; cancelled?: boolean; message?: string }>("index.import");
      if (r.imported) { toast("ok", r.message ?? "Imported."); setTimeout(refresh, 400); }
    } catch (e) { toast("error", (e as Error).message); }
  };
  const rescan = async (root: string) => {
    try { setScan(await api<ScanState>("indexer.start", root ? { root } : {})); toast("info", root ? `Rescanning ${root}` : "Rescanning every THOR root"); } catch (e) { toast("error", (e as Error).message); }
  };
  const addRoot = async () => {
    try { const r = await api<ScanState & { cancelled?: boolean }>("indexer.start", { pick: true }); if (!r.cancelled) setScan(r); } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-8 py-7">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[24px] font-[700] tracking-tight">Sources & index</h1>
            <p className="mt-1 text-[13.5px] text-[var(--color-text-muted)]">What TracePoint has indexed from THOR, when, and how it's kept current.</p>
          </div>
          {canIndex && (
            <div className="flex gap-2">
              <Button icon={<Import className="size-4" />} onClick={importDb}>Import database…</Button>
              <Button icon={<RefreshCw className="size-4" />} onClick={reload}>Reload</Button>
              <Button icon={<ScanLine className="size-4" />} onClick={addRoot} disabled={scan?.running}>Add a THOR folder…</Button>
              <Button variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => rescan("")} disabled={scan?.running}>Rescan all</Button>
            </div>
          )}
        </div>

        <div className="mt-6 grid grid-cols-5 gap-3">
          <Stat label="Files indexed" value={n(st.stats.files ?? 0)} icon={<FileStack className="size-4" />} sub={`${Math.round(((st.stats.with_equipment ?? 0) / total) * 100)}% tied to equipment`} />
          <Stat label="Folders" value={n(st.stats.folders ?? 0)} icon={<FolderTree className="size-4" />} />
          <Stat label="Equipment & circuits" value={n(st.stats.equipment ?? 0)} icon={<Layers className="size-4" />} sub={`${st.stats.units} units / areas`} />
          <Stat label="Drawing families" value={n(st.stats.families ?? 0)} icon={<Database className="size-4" />} />
          <Stat label="Load time" value={`${((st.stats.load_ms ?? 0) / 1000).toFixed(1)} s`} icon={<Timer className="size-4" />} sub={st.state.source_kind === "team" ? "Shared index" : "This PC only"} />
        </div>

        <Permissions st={st} canIndex={canIndex} onShare={share} running={!!scan?.running} />
        <Connections canIndex={canIndex} />
        <PrivateFolders running={!!scan?.running} onStarted={(x) => setScan(x)} />

        {scan?.running || scan?.finished || scan?.error ? <ScanPanel scan={scan} onStop={() => api("indexer.stop").then(load)} /> : null}
        <ContentPanel canIndex={canIndex} />
        {state.user?.role === "admin" && <AiReadPanel />}

        <Section className="mt-6" title="Indexed THOR roots" subtitle="Each root is scanned read-only: names, folders, sizes, dates and each file's Windows permissions. Nothing on THOR is changed.">
          <div className="space-y-3">
            {st.roots.map((r) => {
              const ok = r.last_crawl_status === "inventory_complete" || r.last_crawl_status === "complete";
              return (
                <div key={r.root_id} className="flex items-center gap-4 rounded-xl border border-[var(--color-border)] p-4">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><HardDrive className="size-5" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[14px] font-semibold">{r.path}</span>
                      <Pill color={ok ? "var(--color-ok)" : "var(--color-warn)"}>{ok ? <CheckCircle2 className="size-3" /> : <TriangleAlert className="size-3" />}{(r.last_crawl_status ?? "never scanned").replace(/_/g, " ")}</Pill>
                      <Pill color="var(--color-info)"><Lock className="size-3" />read-only</Pill>
                    </div>
                    <div className="mt-1.5 grid grid-cols-4 gap-4 text-[12.5px]">
                      <div><div className="text-[var(--color-text-faint)]">Last scan finished</div><div className="font-medium" title={fullDate(r.last_crawl_completed)}>{fullDate(r.last_crawl_completed)} <span className="text-[var(--color-text-faint)]">({when(r.last_crawl_completed)})</span></div></div>
                      <div><div className="text-[var(--color-text-faint)]">Files / folders seen</div><div className="font-medium tabular-nums">{n(r.files_seen)} / {n(r.dirs_seen)}</div></div>
                      <div><div className="text-[var(--color-text-faint)]">In this index</div><div className="font-medium tabular-nums">{n(r.files_indexed)} files</div></div>
                      <div><div className="text-[var(--color-text-faint)]">Issues</div><div className="font-medium tabular-nums">{r.issues}</div></div>
                    </div>
                  </div>
                  {canIndex && <Button icon={<RefreshCw className="size-4" />} onClick={() => rescan(r.path)} disabled={scan?.running}>Rescan</Button>}
                </div>
              );
            })}
            {st.roots.length === 0 && <div className="text-[13px] text-[var(--color-text-faint)]">No roots indexed yet.</div>}
          </div>
          <div className="mt-4 text-[12.5px] text-[var(--color-text-muted)]">
            Index in use: <span className="font-medium text-[var(--color-text)]">{st.state.source}</span>
            {st.generated_at && <> · built from the scan finished {fullDate(st.generated_at)}</>}
          </div>
        </Section>

        <div className="mt-6 grid grid-cols-2 gap-6">
          <Section title="What's in THOR" subtitle="Files by document type">
            <div className="space-y-2">
              {cats.map(([k, v]) => (
                <div key={k} className="flex items-center gap-3 text-[13px]">
                  <span className="w-40 truncate">{k}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]"><div className="h-full rounded-full" style={{ width: `${Math.max(1, (v / total) * 100)}%`, background: catColor(k) }} /></div>
                  <span className="w-16 text-right tabular-nums text-[var(--color-text-muted)]">{n(v)}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="THOR integrity guard" subtitle="Enforced in code for every write TracePoint makes">
            <div className="flex items-start gap-3 rounded-xl bg-[color-mix(in_srgb,var(--color-ok)_8%,transparent)] p-3 text-[13px]">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[var(--color-ok)]" />
              <div>TracePoint refuses any write, rename or delete inside these sources — by UNC path, mapped drive letter or folder link.</div>
            </div>
            <div className="mt-3 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Protected (never written)</div>
            <div className="mt-1 space-y-1">{st.protected.map((p) => <div key={p} className="font-mono text-[12px]">{p}</div>)}</div>
            <div className="mt-3 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">TracePoint's own folders (only places it writes)</div>
            <div className="mt-1 space-y-1">{st.writable.map((p) => <div key={p} className="break-all font-mono text-[12px] text-[var(--color-text-muted)]">{p}</div>)}</div>
          </Section>
        </div>
      </div>
    </div>
  );
}

interface LinkStats { cards: number; copy_groups: number; extra_copies: number; version_groups: number; superseded: number; stale_copies: number; content_links: number; stranded: number; moved: number; nameplate_matches: number; ms: number }

/** What TracePoint connected: copies, revisions, stranded documents. */
function Connections({ canIndex }: { canIndex: boolean }) {
  const [l, setL] = useState<LinkStats | null>(null);
  const toast = useToast();
  useEffect(() => { api<LinkStats>("links.status").then(setL).catch(() => {}); }, []);
  if (!l) return null;
  const report = async () => {
    try { const r = await api<{ path?: string; rows?: number; cancelled?: boolean }>("report.cleanup"); if (r.path) toast("ok", `Saved ${n(r.rows ?? 0)} rows to ${r.path}`); } catch (e) { toast("error", (e as Error).message); }
  };
  const tiles: [string, number, string][] = [
    ["Newer revision exists", l.superseded, "Older revisions people might grab by mistake"],
    ["Old copies saved recently", l.stale_copies, "Superseded files that look new on disk"],
    ["Filed away from their equipment", l.stranded, "Project, scan and department copies"],
    ["Tied to equipment by contents", l.content_links, `Incl. ${n(l.nameplate_matches)} by nameplate number`],
    ["Extra copies of the same file", l.extra_copies, `${n(l.copy_groups)} files exist more than once`],
    ["Moved since last scan", l.moved, "Found at their new location"],
  ];
  return (
    <Section className="mt-6" title="Connections found" subtitle={`From file names, folders, document contents and OCR — worked out on this PC in ${(l.ms / 1000).toFixed(1)} s, from only the files you can open.`}>
      <div className="grid grid-cols-3 gap-3">
        {tiles.map(([t, v, d]) => (
          <div key={t} className="rounded-xl bg-[var(--color-surface-2)] p-3.5">
            <div className="text-[22px] font-bold tabular-nums">{n(v)}</div>
            <div className="text-[13px] font-semibold">{t}</div>
            <div className="text-[12px] text-[var(--color-text-muted)]">{d}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-4 text-[12.5px] text-[var(--color-text-muted)]">
        <span>{n(l.cards)} documents have a fingerprint card (read contents). More connections appear as more documents are read.</span>
        {canIndex && <Button onClick={report}>Cleanup report (Excel)…</Button>}
      </div>
    </Section>
  );
}

interface PrivateStatus { allowed: boolean; encrypted: boolean; files: number; roots: { root_id: string; path: string; last_scan?: string | null; files: number }[] }

/** Folders on this PC searched for this person only. */
function PrivateFolders({ running, onStarted }: { running: boolean; onStarted: (s: ScanState) => void }) {
  const [p, setP] = useState<PrivateStatus | null>(null);
  const toast = useToast();
  const load = useCallback(() => { api<PrivateStatus>("private.status").then(setP).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, running]);
  if (!p) return null;
  const go = async (cmd: string, body: Record<string, unknown> = {}) => {
    try { const r = await api<ScanState & { cancelled?: boolean }>(cmd, body); if (!r.cancelled && r.running !== undefined) onStarted(r); load(); } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <Section className="mt-6" title="Your private folders" subtitle="Search your own Documents, Downloads or a local drive alongside THOR. Only you see them — they stay on this PC, never go to the shared folder, and never go to AI.">
      {!p.allowed ? (
        <div className="text-[13px] text-[var(--color-text-muted)]">Switched off on this PC by your IT department.</div>
      ) : (
        <>
          <div className="space-y-2">
            {p.roots.map((r) => (
              <div key={r.root_id} className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] p-3">
                <Lock className="size-4 text-[var(--color-info)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] font-semibold">{r.path}</div>
                  <div className="text-[12px] text-[var(--color-text-muted)]">{n(r.files)} files{r.last_scan ? ` · scanned ${when(r.last_scan)}` : ""}</div>
                </div>
                <Button size="sm" onClick={() => confirm("Stop searching this folder? Nothing in the folder is changed.") && go("private.remove", { root_id: r.root_id })}>Remove</Button>
              </div>
            ))}
            {p.roots.length === 0 && <div className="text-[13px] text-[var(--color-text-faint)]">None yet.</div>}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" icon={<Lock className="size-4" />} disabled={running} onClick={() => go("private.add")}>Add a private folder…</Button>
            {p.roots.length > 0 && <Button icon={<RefreshCw className="size-4" />} disabled={running} onClick={() => go("private.rescan")}>Rescan mine</Button>}
            <span className="ml-auto text-[12px] text-[var(--color-text-faint)]">{p.encrypted ? "Encrypted by Windows for your account" : "Protected by your Windows profile"} · OneDrive online-only files are never downloaded</span>
          </div>
        </>
      )}
    </Section>
  );
}

/** Who sees what: the shared index is split by Windows permissions. */
function Permissions({ st, canIndex, onShare, running }: { st: Status; canIndex: boolean; onShare: () => void; running: boolean }) {
  const g = st.groups;
  const p = st.published;
  const shared = st.team?.mode === "team";
  return (
    <Section className="mt-6" title="Who sees what" subtitle="TracePoint shows each person only the THOR files their own Windows account can open — the same rule as opening them in Explorer.">
      <div className="flex items-start gap-3 rounded-xl bg-[color-mix(in_srgb,var(--color-ok)_8%,transparent)] p-3.5 text-[13.5px]">
        <Lock className="mt-0.5 size-5 shrink-0 text-[var(--color-ok)]" />
        <div>
          {shared ? <>You're seeing only folders your Windows account can open. Files in locked folders aren't on this PC at all — not their names, not their text.</> : <>This PC's own index: built from what your Windows account could read when you scanned.</>}
          {canIndex && shared && <div className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">This PC loaded {g.open} permission group{g.open === 1 ? "" : "s"}{g.locked ? ` · ${g.locked} locked to this account` : ""}{g.hidden ? ` · ${g.hidden} hidden (Windows refused on this PC — share permissions or changed since the last scan)` : ""}{g.unavailable ? ` · ${g.unavailable} couldn't be checked` : ""}.</div>}
        </div>
      </div>
      {canIndex && shared && (
        <div className="mt-4 flex items-start gap-4">
          <div className="flex-1 text-[13px]">
            {p ? (
              <>
                <div><b>Last shared {when(p.at)}:</b> {n(p.files)} files in {p.groups} groups, each locked with its THOR folder's own Windows permissions.</div>
                {p.open_to_everyone > 0 && <div className="mt-1 text-[var(--color-text-muted)]">{p.open_to_everyone} group{p.open_to_everyone === 1 ? " is" : "s are"} readable by all staff on THOR, so {p.open_to_everyone === 1 ? "it is" : "they are"} here too. If a THOR share is restricted only by <i>share</i> permissions, ask IT to set the same on the folder.</div>}
                {p.unreadable > 0 && <div className="mt-1 text-[var(--color-warn)]">{n(p.unreadable)} files were left out: their permissions couldn't be read.</div>}
                {p.refused.length > 0 && (
                  <div className="mt-2 rounded-lg border border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] p-2.5">
                    <div className="font-semibold text-[var(--color-warn)]">Held back — not shared with anyone</div>
                    {p.refused.map((r, i) => <div key={i} className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">{n(r.files)} files (group {r.group}): {r.reason}</div>)}
                  </div>
                )}
              </>
            ) : <span className="text-[var(--color-text-muted)]">Each scan shares automatically when it finishes.</span>}
          </div>
          <Button onClick={onShare} disabled={running}>Share again</Button>
        </div>
      )}
    </Section>
  );
}

function ScanPanel({ scan, onStop }: { scan: ScanState; onStop: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [scan.log?.length]);
  return (
    <div className="mt-6 card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
        {scan.running ? <span className="relative flex size-2.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--color-accent)] opacity-60" /><span className="relative inline-flex size-2.5 rounded-full bg-[var(--color-accent)]" /></span> : scan.error ? <TriangleAlert className="size-4 text-[var(--color-bad)]" /> : <CheckCircle2 className="size-4 text-[var(--color-ok)]" />}
        <div className="flex-1">
          <div className="text-[16px] font-bold">{scan.running ? `Scanning ${scan.root}` : scan.error ? "Scan stopped" : "Scan finished — index updated"}</div>
          <div className="mt-0.5 text-[14px] text-[var(--color-text)]">
            <b className="tabular-nums">{n(scan.files ?? 0)}</b> files · <b className="tabular-nums">{n(scan.dirs ?? 0)}</b> folders
            {" · "}<b className="tabular-nums text-[var(--color-ok)]">{n(scan.new ?? 0)}</b> new · <b className="tabular-nums text-[var(--color-info)]">{n(scan.changed ?? 0)}</b> changed · <b className="tabular-nums text-[var(--color-warn)]">{n(scan.missing ?? 0)}</b> missing
            {scan.errors ? <> · <b className="tabular-nums text-[var(--color-bad)]">{scan.errors}</b> issues</> : null}
          </div>
          <div className="text-[12.5px] text-[var(--color-text-muted)]">{scan.phase}{scan.running && scan.files_per_sec ? ` · ${n(Math.round(scan.files_per_sec))} files/s` : ""}{scan.started ? ` · started ${when(scan.started)}` : ""} · THOR is only read, never changed</div>
        </div>
        {scan.running ? <Button size="sm" icon={<Square className="size-3.5" />} onClick={onStop}>Stop</Button> : <Pill color={scan.error ? "var(--color-bad)" : "var(--color-ok)"}>{scan.error ?? "Index updated"}</Pill>}
      </div>
      <div ref={box} className={cx("max-h-48 overflow-y-auto bg-[var(--color-surface-2)] px-5 py-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-text-muted)]")}>
        {(scan.log ?? []).map((l, i) => <div key={i}>{l}</div>)}
        {scan.running && <div className="flex items-center gap-2 text-[var(--color-text-faint)]"><Play className="size-3" /> working…</div>}
      </div>
    </div>
  );
}
