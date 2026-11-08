"use client";

// CloseoutTab - closing out a job in one place: where the work stands
// (done, and when it finished against the plan), every step left to close
// it (the PSSR, the turnover documents this job needs, the punch list,
// change orders, the final cost, lessons & findings) each finished right
// here, then Mark the project complete; beside it, how the job did. A
// finished job opens on this tab.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, UploadCloud, ArrowRight, Loader2, Plus, FileText } from "lucide-react";
import type { Milestone } from "@/types/schema";
import { listMilestones } from "@/lib/milestones";
import { loadProgressLog, type ProgressLogRow } from "@/lib/progressHistory";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { supabase } from "@/lib/supabase";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { gatherProjectSnapshot } from "@/lib/projectSnapshot";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";
import { listChecklists, listChecklistItems, computeChecklistProgress, type Checklist } from "@/lib/checklists";
import { listTurnoverItems, seedTurnoverItems, addTurnoverItem, updateTurnoverItem, attachTurnoverDocument, reviewTurnoverItem, type TurnoverItem } from "@/lib/turnover";
import { uploadProjectFile, projectFileHome, type ProjectFileHome } from "@/lib/projectUpload";
import { loadCloseoutSettings, saveCloseoutSettings, type CloseoutSettings } from "@/lib/closeoutSettings";
import { workSummary, vsPlanWords } from "@/lib/closeoutStatus";
import { phaseStats, type CostLine, type CostEntry } from "@/lib/phaseReport";
import { phaseDates, type ProjectPhase } from "@/lib/projectPhases";
import { fmtInTz } from "@/lib/scheduleTz";
import { NewChecklistFlow } from "@/components/projects/QualityTab";
import { LinesChart } from "@/components/projects/cost/BudgetTable";
import { Modal, ModalBody, ModalHeader } from "@/components/ui/Modal";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export default function CloseoutTab({ orgId, projectId, projectName, projectStatus, jobKind, tz, phases, uid, userEmail, canManage, onTab, onLessons, onComplete }: {
  orgId: string; projectId: string; projectName: string; projectStatus: string; jobKind: string | null; tz: string;
  phases: ProjectPhase[]; uid: string; userEmail: string | null; canManage: boolean;
  /** Go to another tab (Quality's punch list, Costs, Reports). */
  onTab: (tab: string) => void;
  onLessons: () => void;
  onComplete: () => void;
}) {
  const actor = useMemo(() => ({ uid, email: userEmail }), [uid, userEmail]);
  const times = useShiftTimes(projectId);
  const [ms, setMs] = useState<Milestone[] | null>(null);
  const [log, setLog] = useState<ProgressLogRow[] | null>(null);
  const [money0, setMoney0] = useState<{ lines: CostLine[]; entries: CostEntry[]; afe: number | null } | null>(null);
  const [snap, setSnap] = useState<ProjectStateSnapshot | null>(null);
  const [pssr, setPssr] = useState<{ list: Checklist; satisfied: number; applicable: number } | null | undefined>(undefined);
  const [items, setItems] = useState<TurnoverItem[] | null>(null);
  const [settings, setSettings] = useState<CloseoutSettings>({});
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [newDoc, setNewDoc] = useState("");
  const [phasePick, setPhasePick] = useState<string | null>(null);
  // Where attached files are saved: the project's library, else one picked here.
  const [home, setHome] = useState<ProjectFileHome | null>(null);
  const [lib, setLib] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      const rows = <T,>(table: string) => fetchAllRows<T>((from, to) => supabase.from(table).select("*").eq("project_id", projectId).order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>);
      const [m, l, lines, entries, proj, s, lists, t, cs, h] = await Promise.all([
        listMilestones({ orgId, projectId, includeGhost: true }).catch(() => [] as Milestone[]),
        loadProgressLog(projectId),
        rows<CostLine>("cost_accounts"), rows<CostEntry>("cost_entries"),
        supabase.from("projects").select("authorized_amount").eq("id", projectId).maybeSingle(),
        gatherProjectSnapshot(orgId, projectId).catch(() => null),
        listChecklists(orgId, projectId).catch(() => [] as Checklist[]),
        listTurnoverItems(orgId, projectId).catch(() => [] as TurnoverItem[]),
        loadCloseoutSettings(projectId).catch(() => ({} as CloseoutSettings)),
        projectFileHome(orgId, projectId).catch(() => null),
      ]);
      const p = lists.find((c) => c.kind === "pssr" && c.status !== "void") ?? null;
      const prog = p ? computeChecklistProgress(await listChecklistItems(p.id)) : null;
      if (!live) return;
      setMs(m); setLog(l);
      const a = (proj.data as { authorized_amount?: number | null } | null)?.authorized_amount;
      setMoney0({ lines: lines.rows, entries: entries.rows, afe: a == null ? null : Number(a) });
      setSnap(s); setItems(t); setSettings(cs); setHome(h);
      setPssr(p && prog ? { list: p, satisfied: prog.satisfied, applicable: prog.applicable } : null);
    })();
    return () => { live = false; };
  }, [orgId, projectId, tick]);

  const work = useMemo(() => (ms ? workSummary(ms) : null), [ms]);
  const pickedPhase = phasePick ? phases.find((p) => p.id === phasePick) ?? null : null;
  const stats = useMemo(() => (ms && money0 ? phaseStats({ milestones: ms, phases, phase: pickedPhase, log, tz, times, now: Date.now(), total: money0.afe, lines: money0.lines, entries: money0.entries }) : null),
    [ms, money0, phases, pickedPhase, log, tz, times]);
  const short = (t: number) => `${fmtInTz(t, tz, { month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  const when = (t: number) => `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key); setErr(null);
    try { const r = await fn(); if (!r.ok) setErr(r.error ?? "Not saved."); else reload(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  // ── The steps ──
  const required = (items ?? []).filter((i) => i.required);
  const inCount = required.filter((i) => i.status === "accepted" || i.status === "waived").length;
  const pssrNotNeeded = settings.pssr === "not_needed";
  const pssrOk = pssrNotNeeded || (!!pssr && (pssr.list.status === "complete" || (pssr.applicable > 0 && pssr.satisfied === pssr.applicable)));
  const invoiced = money0 ? money0.entries.filter((e) => e.status !== "void" && (e.entry_type === "actual" || e.entry_type === "adjustment")).reduce((s, e) => s + Number(e.amount ?? 0), 0) : 0;
  const left = [
    work && !work.allDone, !pssrOk, items && required.length > inCount, snap && snap.punchOpen > 0, snap && snap.openChangeOrders > 0,
  ].filter(Boolean).length;

  const btn = "inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
  const pri = "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black whitespace-nowrap disabled:opacity-50";

  if (!ms || !work) return <div className="py-16 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  return (
    <div className="space-y-4">
      {/* Where the work stands */}
      <div className={`rounded-2xl border px-4 py-3 flex items-start gap-3 flex-wrap ${work.allDone ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800" : "border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800"}`}>
        <span className={`mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${work.allDone ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>{work.allDone ? <Check className="w-5 h-5" /> : <span className="text-[12px] font-black">{work.total ? Math.round((work.done / work.total) * 100) : 0}%</span>}</span>
        <div className="min-w-0 flex-1 basis-60">
          <div className={`text-[15px] font-black ${work.allDone ? "text-emerald-900 dark:text-emerald-200" : "text-amber-900 dark:text-amber-200"}`}>
            {work.allDone ? `The work is done: ${work.done} of ${work.total} steps` : `${work.done} of ${work.total} steps done`}
          </div>
          <div className={`text-[12.5px] ${work.allDone ? "text-emerald-800 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300"}`}>
            {work.finishedAt != null
              ? `Last step finished ${when(work.finishedAt)}${work.plannedFinish != null ? ` · planned ${when(work.plannedFinish)} (${vsPlanWords(work.hoursAfterPlan)})` : ""}. `
              : work.total ? `${work.total - work.done} step${work.total - work.done === 1 ? "" : "s"} not marked done yet. ` : "No schedule yet. "}
            {projectStatus === "completed" ? "The project is complete." : left === 0 ? "Every close-out step is clear." : work.allDone ? `Now close it out: ${left} thing${left === 1 ? "" : "s"} left.` : ""}
          </div>
        </div>
        <button type="button" onClick={() => onTab("reports:closeout")} className={btn}><FileText className="w-4 h-4" /> Close-out report</button>
      </div>

      {err && <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12.5px] font-semibold text-rose-800 dark:text-rose-300 whitespace-pre-line">{err}</div>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] items-start">
        {/* To close this project */}
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-baseline gap-x-2 flex-wrap">
            <b className="text-[14px] text-[var(--color-text)] whitespace-nowrap">To close this project</b>
            <span className="text-[12px] text-[var(--color-text-muted)]">{left === 0 ? "all clear" : `${left} left`} · tap any to finish it here</span>
          </div>
          <ol className="divide-y divide-[var(--color-border)]">
            <Step n={1} ok={work.allDone} title="Work done"
              detail={work.allDone ? `${work.done} of ${work.total} steps${work.finishedAt != null ? ` · finished ${when(work.finishedAt)}` : ""}` : `${work.total - work.done} of ${work.total} steps not marked done`}
              action={!work.allDone ? <button type="button" onClick={() => onTab("work")} className={btn}>Open the work <ArrowRight className="w-3.5 h-3.5" /></button> : null} />

            <Step n={2} ok={pssrOk} title="PSSR (pre-startup safety review)"
              detail={pssrNotNeeded ? "Not needed for this job." : pssr === undefined ? "Checking…" : pssr ? `${pssr.list.title}: ${pssr.satisfied} of ${pssr.applicable} items done${pssr.list.status === "complete" ? " · complete" : ""}`
                : "Upload the PSSR (PDF): saved to the project's documents and read into items you check off. Or mark it not needed for this job."}
              action={pssrNotNeeded ? (canManage ? <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssr: null }))} className={btn}>Needed after all</button> : null)
                : pssr ? <button type="button" onClick={() => onTab("quality")} className={btn}>Open <ArrowRight className="w-3.5 h-3.5" /></button>
                  : canManage ? <span className="flex gap-1.5 flex-wrap justify-end">
                    <button type="button" onClick={() => { setErr(null); setUploading(true); }} className={pri}><UploadCloud className="w-4 h-4" /> Upload PSSR</button>
                    <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssr: "not_needed" }))} className={btn}>Not needed</button>
                  </span> : null} />

            <Step n={3} ok={items ? required.length === inCount : null} title="Turnover documents"
              detail={!items ? "Checking…" : items.length === 0 ? "No documents set for this job yet." : `${inCount} of ${required.length} required in · you pick what this job needs`}>
              {items && (
                <div className="mt-2 rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                  {canManage && home && !home.libraryId && items.some((i) => i.required && (i.status === "open" || i.status === "rejected")) && (
                    <label className="px-3 py-2 flex items-center gap-2 flex-wrap text-[12.5px] bg-[var(--color-surface-2)]/40">
                      <span className="font-bold text-[var(--color-text)]">Attached files are saved in</span>
                      <select value={lib} onChange={(e) => setLib(e.target.value)} aria-label="Library for attached files"
                        className={`h-8 rounded-lg border bg-[var(--color-surface)] px-2 text-[12.5px] ${lib ? "border-[var(--color-border-strong)]" : "border-orange-400"}`}>
                        <option value="">Pick a library</option>
                        {home.libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                      <span className="text-[11.5px] text-[var(--color-text-muted)]">asked once: the project&rsquo;s files go there from now on</span>
                    </label>
                  )}
                  {items.map((it) => (
                    <TurnoverRow key={it.id} it={it} canManage={canManage} busy={busy === it.id}
                      onRequired={() => void run(it.id, () => updateTurnoverItem({ item: it, patch: { required: !it.required }, actor }))}
                      onAccept={() => void run(it.id, () => reviewTurnoverItem({ item: it, status: "accepted", actor }))}
                      onFile={(file) => void run(it.id, async () => {
                        if (home && !home.libraryId && !lib) return { ok: false, error: "Pick where attached files are saved first (above the list)." };
                        const d = await uploadProjectFile({ orgId, projectId, projectName, file, prefix: "TURNOVER", title: `${it.name} - ${file.name.replace(/\.[a-z0-9]+$/i, "")}`, libraryId: lib || null, actorUserId: uid, actorEmail: userEmail });
                        return attachTurnoverDocument({ item: it, documentId: d.documentId, documentLabel: d.label, actor });
                      })} />
                  ))}
                  {canManage && (
                    <div className="px-3 py-2 flex items-center gap-2 flex-wrap bg-[var(--color-surface-2)]/40">
                      {items.length === 0 && <button type="button" disabled={!!busy} onClick={() => void run("seed", async () => { const r = await seedTurnoverItems({ orgId, projectId, jobKind, actor }); return { ok: r.ok, error: r.error }; })} className={btn}>Start from the usual list</button>}
                      <input value={newDoc} onChange={(e) => setNewDoc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newDoc.trim()) { const n = newDoc.trim(); setNewDoc(""); void run("add", async () => { const r = await addTurnoverItem({ orgId, projectId, name: n, required: true, actor }); return { ok: r.ok, error: r.error }; }); } }}
                        placeholder="+ Add a document this job needs" aria-label="Add a document this job needs" className="h-8 flex-1 min-w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
                      <button type="button" disabled={!newDoc.trim() || !!busy} onClick={() => { const n = newDoc.trim(); setNewDoc(""); void run("add", async () => { const r = await addTurnoverItem({ orgId, projectId, name: n, required: true, actor }); return { ok: r.ok, error: r.error }; }); }} className={btn}><Plus className="w-3.5 h-3.5" /> Add</button>
                    </div>
                  )}
                </div>
              )}
            </Step>

            <Step n={4} ok={snap ? snap.punchOpen === 0 : null} title="Punch list" detail={!snap ? "Checking…" : snap.punchOpen === 0 ? "Nothing open" : `${snap.punchOpen} open`}
              action={<button type="button" onClick={() => onTab("quality")} className={btn}>Open</button>} />
            <Step n={5} ok={snap ? snap.openChangeOrders === 0 : null} title="Change orders" detail={!snap ? "Checking…" : snap.openChangeOrders === 0 ? "None waiting on a decision" : `${snap.openChangeOrders} waiting on a decision`}
              action={snap && snap.openChangeOrders > 0 ? <button type="button" onClick={() => onTab("costs")} className={btn}>Decide <ArrowRight className="w-3.5 h-3.5" /></button> : null} />
            <Step n={6} ok={null} title="Final cost" detail={money0 ? `${money(invoiced)} invoiced${money0.afe != null ? ` of ${money(money0.afe)} AFE` : ""} · post the last invoices before closing` : "Checking…"}
              action={<button type="button" onClick={() => onTab("costs")} className={btn}>Invoices</button>} />
            <Step n={7} ok={null} title="Lessons & findings" detail="Keep what this job taught for next time."
              action={<button type="button" onClick={onLessons} className={btn}>Review</button>} />
          </ol>
          {canManage && projectStatus !== "completed" && (
            <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center justify-end gap-3 flex-wrap">
              {left > 0 && <span className="text-[12px] text-[var(--color-text-muted)]">{left} step{left === 1 ? "" : "s"} still open: you can complete anyway.</span>}
              <button type="button" onClick={onComplete} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-emerald-600 text-white text-[13px] font-black hover:bg-emerald-700"><Check className="w-4 h-4" /> Mark project complete</button>
            </div>
          )}
        </div>

        {/* How the job did */}
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
            <b className="text-[14px] text-[var(--color-text)] mr-auto">How the job did</b>
            {phases.length > 0 && (
              <span className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Phase">
                {[{ id: null as string | null, name: "All" }, ...phases.map((p) => ({ id: p.id as string | null, name: p.name }))].map((p) => (
                  <button key={p.id ?? "all"} type="button" aria-pressed={phasePick === p.id} onClick={() => setPhasePick(p.id)}
                    className={`h-8 px-2.5 text-[12px] font-bold border-r last:border-r-0 border-[var(--color-border-strong)] ${phasePick === p.id ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-[var(--color-surface)] text-[var(--color-text)]"}`}>{p.name}</button>
                ))}
              </span>
            )}
          </div>
          {stats ? (
            <div className="p-4 space-y-4">
              {pickedPhase && <div className="text-[12px] text-[var(--color-text-muted)]">{pickedPhase.name} · {phaseDates(pickedPhase)} · {pickedPhase.share}% of the {money0?.afe != null ? "AFE" : "budget"}</div>}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Tile k={stats.finishedAt != null ? "Finished" : "Planned finish"} v={stats.finishedAt != null ? short(stats.finishedAt) : stats.plannedFinish != null ? short(stats.plannedFinish) : "-"}
                  s={stats.finishedAt != null && stats.plannedFinish != null ? vsPlanWords(Math.round(((stats.finishedAt - stats.plannedFinish) / 3_600_000) * 10) / 10) : `${stats.actualPct}% done, plan ${stats.plannedPct}%`} />
                <Tile k="Steps" v={`${stats.done} / ${stats.steps}`} s={`${Math.round(stats.hours).toLocaleString("en-US")} h of work`} />
                <Tile k="Added work" v={`${stats.added.count} step${stats.added.count === 1 ? "" : "s"}`} s={stats.added.count ? `+${Math.round(stats.added.hours)} h, discovery` : "nothing added to the plan"} />
                <Tile k={pickedPhase ? "Phase budget" : money0?.afe != null ? "AFE" : "Budget"} v={money(stats.budget)} s={`budget lines ${money(stats.lines.reduce((a, l) => a + l.budget, 0))}`} />
                <Tile k="Spent" v={money(stats.spent)} s={stats.budget ? `${Math.round((stats.spent / stats.budget) * 100)}% of the ${pickedPhase ? "phase budget" : money0?.afe != null ? "AFE" : "budget"}` : "no budget"} />
                <Tile k={stats.budget - stats.spent >= 0 ? "Left" : "Over"} v={money(Math.abs(stats.budget - stats.spent))} tone={stats.budget - stats.spent >= 0 ? "good" : "bad"} s={stats.budget - stats.spent >= 0 ? "invoices still to come?" : "over the budget"} />
              </div>
              {stats.days.length > 0 && (
                <div>
                  <div className="text-[12.5px] font-bold text-[var(--color-text)] mb-1.5">Progress, planned and done, by day <span className="font-semibold text-[var(--color-text-muted)]">· gray plan; done green, red when behind</span></div>
                  <div className="space-y-1.5">
                    {stats.days.map((d) => {
                      const [y, mo, dd] = d.day.split("-").map(Number);
                      const label = new Date(Date.UTC(y, mo - 1, dd)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
                      const behind = d.actual != null && d.actual + 0.05 < d.planned;
                      return (
                        <div key={d.day} className="grid grid-cols-[86px_minmax(0,1fr)_92px] gap-2 items-center text-[12px]">
                          <span className="text-[var(--color-text)]">{label}</span>
                          <div className="space-y-0.5">
                            <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden"><div className="h-full rounded-full bg-slate-400" style={{ width: `${Math.min(100, d.planned)}%` }} /></div>
                            <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">{d.actual != null && <div className={`h-full rounded-full ${behind ? "bg-rose-500" : "bg-emerald-600"}`} style={{ width: `${Math.min(100, d.actual)}%` }} />}</div>
                          </div>
                          <span className="text-right tabular-nums text-[var(--color-text-muted)]">{d.planned}%{d.actual != null ? ` / ${d.actual}%` : ""}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {stats.lines.length > 0 && <LinesChart rows={stats.lines} cur="USD" />}
            </div>
          ) : <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>}
        </div>
      </div>

      {uploading && (
        <Modal onClose={() => setUploading(false)} size="lg">
          <ModalHeader icon={UploadCloud} title="Upload the PSSR" subtitle="Saved to this project's documents, then read into checklist items. You check them before anything is kept." onClose={() => setUploading(false)} />
          <ModalBody className="!p-0">
            {err && <div role="alert" className="px-4 pt-3 text-[12.5px] font-semibold text-rose-700 dark:text-rose-400">{err}</div>}
            <NewChecklistFlow orgId={orgId} projectId={projectId} projectName={projectName} actor={actor}
              onDone={() => { setUploading(false); reload(); }} onCancel={() => setUploading(false)} setErr={setErr} kindDefault="pssr" />
          </ModalBody>
        </Modal>
      )}
    </div>
  );
}

function Step({ n, ok, title, detail, action, children }: { n: number; ok: boolean | null; title: string; detail: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="px-4 py-3 flex items-start gap-3">
      <span className={`mt-0.5 w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[12px] font-black ${ok ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : ok === false ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
        {ok ? <Check className="w-3.5 h-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2 flex-wrap">
          <div className="min-w-0 flex-1 basis-48">
            <div className="text-[13.5px] font-bold text-[var(--color-text)]">{title}</div>
            <div className="text-[12px] text-[var(--color-text-muted)] leading-snug">{detail}</div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {children}
      </div>
    </li>
  );
}

function Tile({ k, v, s, tone }: { k: string; v: string; s: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] px-3 py-2 min-w-0">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{k}</div>
      <div className={`text-[16px] font-black truncate ${tone === "good" ? "text-emerald-700 dark:text-emerald-400" : tone === "bad" ? "text-rose-700 dark:text-rose-400" : "text-[var(--color-text)]"}`}>{v}</div>
      <div className="text-[11px] text-[var(--color-text-muted)] truncate">{s}</div>
    </div>
  );
}

const STATUS: Record<TurnoverItem["status"], { word: string; cls: string }> = {
  open: { word: "Needed", cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300" },
  received: { word: "Received", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300" },
  accepted: { word: "Accepted", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  rejected: { word: "Rejected", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  waived: { word: "Waived", cls: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
};

/** One turnover document: needed for this job or not, where it stands,
 *  and attach the file or accept it. */
function TurnoverRow({ it, canManage, busy, onRequired, onAccept, onFile }: { it: TurnoverItem; canManage: boolean; busy: boolean; onRequired: () => void; onAccept: () => void; onFile: (f: File) => void }) {
  const file = useRef<HTMLInputElement | null>(null);
  const st = it.required ? STATUS[it.status] : { word: "Not for this job", cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" };
  return (
    <div className={`px-3 py-2 flex items-center gap-2.5 text-[12.5px] ${it.required ? "" : "opacity-60"}`}>
      <button type="button" role="switch" aria-checked={it.required} aria-label={`${it.name} needed for this job`} disabled={!canManage || busy} onClick={onRequired}
        className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${it.required ? "bg-[var(--color-accent)]" : "bg-slate-300 dark:bg-slate-600"} disabled:opacity-60`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${it.required ? "left-[18px]" : "left-0.5"}`} />
      </button>
      <span className="min-w-0 flex-1 break-words leading-snug text-[var(--color-text)]" title={it.description ?? undefined}>{it.name}</span>
      <span className={`shrink-0 text-[11px] font-black px-2 py-0.5 rounded-full ${st.cls}`}>{busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : st.word}</span>
      {canManage && it.required && (it.status === "open" || it.status === "rejected") && (
        <>
          <input ref={file} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); if (file.current) file.current.value = ""; }} />
          <button type="button" disabled={busy} onClick={() => file.current?.click()} className="shrink-0 h-7 px-2.5 rounded-lg border border-[var(--color-border-strong)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Attach</button>
        </>
      )}
      {canManage && it.required && it.status === "received" && (
        <button type="button" disabled={busy} onClick={onAccept} className="shrink-0 h-7 px-2.5 rounded-lg border border-emerald-400 text-[12px] font-bold text-emerald-800 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30">Accept</button>
      )}
    </div>
  );
}
