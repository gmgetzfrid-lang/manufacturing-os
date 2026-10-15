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
  team_folder?: string | null;
}
interface ScanState { running: boolean; root?: string; phase?: string; files?: number; dirs?: number; errors?: number; started?: string; log?: string[]; finished?: string | null; error?: string | null }

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

  const reload = async () => { await api("index.reload"); toast("info", "Reloading the index…"); setTimeout(refresh, 400); };
  const importDb = async () => {
    try {
      const r = await api<{ imported?: string; cancelled?: boolean }>("index.import");
      if (r.imported) { toast("ok", "Imported. Loading the new index…"); setTimeout(refresh, 400); }
    } catch (e) { toast("error", (e as Error).message); }
  };
  const rescan = async (root: string) => {
    try { setScan(await api<ScanState>("indexer.start", { root })); toast("info", `Rescanning ${root}`); } catch (e) { toast("error", (e as Error).message); }
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
              <Button variant="primary" icon={<ScanLine className="size-4" />} onClick={addRoot}>Index a new root…</Button>
            </div>
          )}
        </div>

        <div className="mt-6 grid grid-cols-5 gap-3">
          <Stat label="Files indexed" value={n(st.stats.files)} icon={<FileStack className="size-4" />} sub={`${Math.round((st.stats.with_equipment / total) * 100)}% tied to equipment`} />
          <Stat label="Folders" value={n(st.stats.folders)} icon={<FolderTree className="size-4" />} />
          <Stat label="Equipment & circuits" value={n(st.stats.equipment)} icon={<Layers className="size-4" />} sub={`${st.stats.units} units / areas`} />
          <Stat label="Drawing families" value={n(st.stats.families)} icon={<Database className="size-4" />} />
          <Stat label="Load time" value={`${(st.stats.load_ms / 1000).toFixed(1)} s`} icon={<Timer className="size-4" />} sub={st.state.source_kind === "builtin" ? "Built-in snapshot" : st.state.source_kind === "team" ? "Team index" : "Local index"} />
        </div>

        {scan?.running || scan?.finished || scan?.error ? <ScanPanel scan={scan} onStop={() => api("indexer.stop").then(load)} /> : null}

        <Section className="mt-6" title="Indexed THOR roots" subtitle="Each root is scanned read-only. Only names, folders, sizes and dates are read; nothing on THOR is changed.">
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

function ScanPanel({ scan, onStop }: { scan: ScanState; onStop: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [scan.log?.length]);
  return (
    <div className="mt-6 card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
        {scan.running ? <span className="relative flex size-2.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--color-accent)] opacity-60" /><span className="relative inline-flex size-2.5 rounded-full bg-[var(--color-accent)]" /></span> : scan.error ? <TriangleAlert className="size-4 text-[var(--color-bad)]" /> : <CheckCircle2 className="size-4 text-[var(--color-ok)]" />}
        <div className="flex-1">
          <div className="text-[14px] font-semibold">{scan.running ? `Scanning ${scan.root}` : scan.error ? "Scan stopped" : "Scan finished"}</div>
          <div className="text-[12.5px] text-[var(--color-text-muted)]">{scan.phase} · {n(scan.files ?? 0)} files · {n(scan.dirs ?? 0)} folders{scan.errors ? ` · ${scan.errors} unreadable` : ""}{scan.started ? ` · started ${when(scan.started)}` : ""}</div>
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
