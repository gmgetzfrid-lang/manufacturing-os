import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, FolderOpen, Pause, Play, RotateCcw, Square, XCircle } from "lucide-react";
import { api } from "../../lib/api";
import { Button, Empty, Pill, Spinner, Stat, cx, useToast } from "../../components/ui";
import { PageHeader, type Nav } from "../App";
import { STATUS, ago, money, type IntakeState, type Scan } from "../types";
import { ScanModal } from "./ScanModal";

export function HomePage({ state, nav, refresh, tick }: { state: IntakeState; nav: Nav; refresh: () => void; tick: number }) {
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (!state.root_ok) return;
    api<Scan[]>("scans", { limit: 300 }).then(setScans).catch(() => setScans([]));
  }, [tick, state.root_ok]);
  const by = state.counts.by_status ?? {};
  const ready = state.root_ok && !!state.settings.key && state.pdf_engine;
  const active = (scans ?? []).filter((s) => ["reading", "analyzing", "filing"].includes(s.status));
  const queued = by.queued ?? 0;
  const pause = async () => {
    await api(state.settings.paused ? "intake.resume" : "intake.pause");
    refresh();
  };
  return (
    <>
      <PageHeader
        title="Intake"
        subtitle={<>Drop scanned folders into <span className="font-medium text-[var(--color-text)]">{state.settings.root}</span>. Each one is read, split into documents, named and filed automatically.</>}
        action={
          <div className="flex gap-2">
            <Button icon={<FolderOpen className="size-4" />} onClick={() => api("folder.open", { which: "root" }).catch((e) => toast("error", e.message))}>Open drop folder</Button>
            {ready && <Button variant={state.settings.paused ? "primary" : "secondary"} icon={state.settings.paused ? <Play className="size-4" /> : <Pause className="size-4" />} onClick={pause}>{state.settings.paused ? "Resume" : "Pause"}</Button>}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[1180px] space-y-6">
          {state.notice && (
            <div className="flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_9%,var(--color-surface))] px-4 py-3 text-[13px]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-warn)]" />
              <div className="flex-1">{state.notice}</div>
              <button className="text-[12px] text-[var(--color-text-muted)] hover:underline cursor-pointer" onClick={() => api("notice.clear").then(refresh)}>Dismiss</button>
            </div>
          )}
          {!ready || state.references_ok.length === 0 ? <Setup state={state} nav={nav} /> : null}

          <div className="grid grid-cols-6 gap-3">
            <Stat label="In drop folder" value={state.waiting_in_drop} sub="arriving" />
            <Stat label="Waiting" value={queued} sub="in line" />
            <Stat label="Working on" value={state.running.length} sub={state.settings.paused ? "paused" : `${state.settings.parallel} at a time`} />
            <button className="text-left cursor-pointer" onClick={() => nav.go("review")}>
              <Stat label="Needs review" value={<span className={by.review ? "text-[var(--color-warn)]" : ""}>{by.review ?? 0}</span>} sub="held for you" />
            </button>
            <button className="text-left cursor-pointer" onClick={() => nav.go("filed")}>
              <Stat label="Filed" value={by.filed ?? 0} sub={`${state.counts.documents ?? 0} documents · ${state.counts.pages_filed ?? 0} pages`} />
            </button>
            <Stat label="Spend" value={money(state.counts.cost)} sub="reading so far" />
          </div>

          {active.length > 0 && (
            <div className="space-y-2">
              <div className="text-[12.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Working on now</div>
              {active.map((s) => (
                <div key={s.id} className="card flex items-center gap-4 px-4 py-3">
                  <Spinner className="text-[var(--color-info)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{s.file_name}</div>
                    <div className="text-[12.5px] text-[var(--color-text-muted)]">{s.stage || STATUS[s.status].label}{s.pages ? ` · ${s.pages} pages` : ""}</div>
                  </div>
                  <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={() => api("scan.stop", { id: s.id })}>Stop</Button>
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[12.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Recent scans</div>
              <div className="text-[12px] text-[var(--color-text-faint)]">{state.registry}</div>
            </div>
            {scans === null ? (
              <div className="card p-6"><div className="skeleton h-5 w-1/3" /></div>
            ) : scans.length === 0 ? (
              <div className="card"><Empty icon={<FolderOpen className="size-6" />} title="No scans yet">Scan a manila folder, name the file with its equipment number (for example 2010.06.pdf), and save it into {state.settings.root}. It is picked up within a few seconds.</Empty></div>
            ) : (
              <div className="card overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead className="bg-[var(--color-surface-2)] text-left text-[11.5px] uppercase tracking-wide text-[var(--color-text-faint)]">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Scan</th>
                      <th className="px-3 py-2.5 font-semibold">Status</th>
                      <th className="px-3 py-2.5 font-semibold">Equipment</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Pages</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Documents</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Cost</th>
                      <th className="px-4 py-2.5 text-right font-semibold">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map((s) => (
                      <tr key={s.id} onClick={() => (s.status === "review" ? nav.go("review", { id: s.id }) : setOpen(s.id))} className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                        <td className="max-w-[340px] truncate px-4 py-2.5 font-medium">{s.file_name}</td>
                        <td className="px-3 py-2.5"><StatusPill s={s} /></td>
                        <td className="max-w-[300px] truncate px-3 py-2.5 text-[var(--color-text-muted)]" title={s.equipment_rel}>{s.equipment_rel ? s.equipment_rel.split("/").pop() : s.equipment || "—"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{s.pages || "—"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{s.documents || "—"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-text-muted)]">{s.cost ? money(s.cost) : "—"}</td>
                        <td className="px-4 py-2.5 text-right text-[var(--color-text-faint)]">{ago(s.done_at || s.added_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
      {open !== null && <ScanModal id={open} onClose={() => setOpen(null)} nav={nav} />}
    </>
  );
}

export function StatusPill({ s }: { s: Scan }) {
  const st = STATUS[s.status];
  const icon = s.status === "filed" ? <CheckCircle2 className="size-3" /> : s.status === "failed" ? <XCircle className="size-3" /> : s.status === "review" ? <AlertTriangle className="size-3" /> : ["reading", "analyzing", "filing"].includes(s.status) ? <Spinner className="size-3" /> : s.status === "duplicate" ? <RotateCcw className="size-3" /> : <CircleDashed className="size-3" />;
  return (
    <Pill color={st.color} className="gap-1" title={s.error || s.stage}>
      {icon}
      {st.label}
    </Pill>
  );
}

function Setup({ state, nav }: { state: IntakeState; nav: Nav }) {
  const steps: { ok: boolean; label: string; detail: string; warn?: boolean }[] = [
    { ok: state.root_ok, label: "Drop folder", detail: state.root_ok ? state.settings.root : `${state.settings.root} isn't available. Plug in the drive or choose the folder in Settings.` },
    { ok: !!state.settings.key, label: "Anthropic API key", detail: state.settings.key ? `Saved (${state.settings.key})` : "Needed to read the pages. Add it in Settings." },
    { ok: state.references_ok.length > 0 && state.references_ok.every((r) => r.ok), warn: true, label: "Network equipment folders", detail: state.references_ok.length ? state.references_ok.map((r) => `${r.path}${r.ok ? "" : " (not reachable)"}`).join(", ") : "Recommended: point to the network drive's unit folders so new files reuse the exact existing folder names." },
    { ok: state.pdf_engine, label: "PDF engine", detail: state.pdf_engine ? "Ready" : state.pdf_engine_error },
    { ok: state.ocr, warn: true, label: "Windows text recognition", detail: state.ocr ? "Ready: filed PDFs get searchable text." : "Not available on this PC: files are still filed, but without a searchable text layer. Add an English language pack with OCR in Windows Settings › Time & language." },
  ];
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[14.5px] font-semibold">Before you start</div>
        <Button size="sm" variant="primary" onClick={() => nav.go("settings")}>Open Settings</Button>
      </div>
      <div className="space-y-2.5">
        {steps.map((s) => (
          <div key={s.label} className="flex items-start gap-3 text-[13px]">
            {s.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" /> : s.warn ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-warn)]" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-bad)]" />}
            <div>
              <div className={cx("font-medium")}>{s.label}</div>
              <div className="text-[12.5px] text-[var(--color-text-muted)]">{s.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
