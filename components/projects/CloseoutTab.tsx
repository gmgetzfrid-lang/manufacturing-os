"use client";

// CloseoutTab - closing out a job in one place: where the work stands
// (done, and when it finished against the plan), every step left to close
// it (the PSSR, the turnover documents this job needs, the punch list,
// change orders, the final cost, lessons & findings) each finished right
// here, then Mark the project complete; beside it, how the job did. A
// finished job opens on this tab.
//
// In phases (Transmix-1 and -2), each phase says where it stands: done,
// under way, or no schedule yet. The project isn't done until every phase
// is; each phase has its own PSSR.

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
import { phaseStats, chartKey, shiftLabel, behindAt, noScheduleWords, slipWords, slipStepLine, type CostLine, type CostEntry, type SlipStep } from "@/lib/phaseReport";
import { buildLookBack, lostWords, rootWords, whileWaiting, finishChain, causeOf, ownCause, CAUSE_LABEL, type Cause as CauseKind, type StepLook, type LookBack } from "@/lib/lookBack";
import { discoveries } from "@/lib/discovery";
import { notesFor } from "@/lib/milestones";
import type { MilestoneNote } from "@/types/schema";
import { phaseDates, inPhase, type ProjectPhase } from "@/lib/projectPhases";
import { fmtInTz } from "@/lib/scheduleTz";
import { NewChecklistFlow } from "@/components/projects/QualityTab";
import { LinesChart } from "@/components/projects/cost/BudgetTable";
import { Modal, ModalBody, ModalHeader } from "@/components/ui/Modal";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

type PssrList = { list: Checklist; satisfied: number; applicable: number };

export default function CloseoutTab({ orgId, projectId, projectName, projectStatus, jobKind, tz, phases, uid, userEmail, canManage, onTab, onPickPhase, onLessons, onComplete }: {
  orgId: string; projectId: string; projectName: string; projectStatus: string; jobKind: string | null; tz: string;
  phases: ProjectPhase[]; uid: string; userEmail: string | null; canManage: boolean;
  /** Go to another tab (Quality's punch list, Costs, Reports). */
  onTab: (tab: string) => void;
  /** Pick a phase on the project (to import its schedule on Plan). */
  onPickPhase?: (phaseId: string) => void;
  onLessons: () => void;
  onComplete: () => void;
}) {
  const actor = useMemo(() => ({ uid, email: userEmail }), [uid, userEmail]);
  const times = useShiftTimes(projectId);
  const [ms, setMs] = useState<Milestone[] | null>(null);
  const [log, setLog] = useState<ProgressLogRow[] | null>(null);
  // What was recorded on each step (holds and their reasons, what people
  // said): the look back's reasons for the slip.
  const [notes, setNotes] = useState<MilestoneNote[] | null>(null);
  const [money0, setMoney0] = useState<{ lines: CostLine[]; entries: CostEntry[]; afe: number | null } | null>(null);
  const [snap, setSnap] = useState<ProjectStateSnapshot | null>(null);
  // Every PSSR on the project (a project in phases has one a phase).
  const [pssrs, setPssrs] = useState<PssrList[] | undefined>(undefined);
  const [items, setItems] = useState<TurnoverItem[] | null>(null);
  const [settings, setSettings] = useState<CloseoutSettings>({});
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Uploading a PSSR: for the whole job ("all") or a phase.
  const [uploading, setUploading] = useState<string | null>(null);
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
      const stepNotes = await notesFor(m.map((x) => x.id!).filter(Boolean)).catch(() => [] as MilestoneNote[]);
      const mine = lists.filter((c) => c.kind === "pssr" && c.status !== "void");
      const withProg = await Promise.all(mine.map(async (c) => { const pr = computeChecklistProgress(await listChecklistItems(c.id)); return { list: c, satisfied: pr.satisfied, applicable: pr.applicable }; }));
      if (!live) return;
      setMs(m); setLog(l); setNotes(stepNotes);
      const a = (proj.data as { authorized_amount?: number | null } | null)?.authorized_amount;
      setMoney0({ lines: lines.rows, entries: entries.rows, afe: a == null ? null : Number(a) });
      setSnap(s); setItems(t); setSettings(cs); setHome(h);
      setPssrs(withProg);
    })();
    return () => { live = false; };
  }, [orgId, projectId, tick]);

  const work = useMemo(() => (ms ? workSummary(ms) : null), [ms]);
  // Each phase: where its work stands (no steps: no schedule yet).
  const phaseWork = useMemo(() => (ms ? phases.map((p) => ({ p, w: workSummary(inPhase(ms, phases, p.id)) })) : []), [ms, phases]);
  const unscheduled = phaseWork.filter((x) => x.w.total === 0).map((x) => x.p);
  const allWorkDone = phases.length ? phaseWork.length > 0 && phaseWork.every((x) => x.w.total > 0 && x.w.allDone) : !!work?.allDone;
  const now = Date.now();
  const pickedPhase = phasePick ? phases.find((p) => p.id === phasePick) ?? null : null;
  const stats = useMemo(() => (ms && money0 ? phaseStats({ milestones: ms, phases, phase: pickedPhase, log, tz, times, now: Date.now(), total: money0.afe, lines: money0.lines, entries: money0.entries }) : null),
    [ms, money0, phases, pickedPhase, log, tz, times]);
  // The look back (lib/lookBack): each step's lost time and why, as recorded.
  const look = useMemo(() => {
    if (!ms || !notes) return null;
    const active = ms.filter((m) => !(m as { cancelledAt?: unknown }).cancelledAt);
    return buildLookBack({ milestones: active, notes, discoveries: discoveries(active), now: Date.now(), tz });
  }, [ms, notes, tz]);
  const lookById = useMemo(() => new Map((look?.steps ?? []).map((x) => [x.id, x])), [look]);
  const phaseIds = useMemo(() => (ms && pickedPhase ? new Set(inPhase(ms, phases, pickedPhase.id).map((m) => m.id!)) : null), [ms, phases, pickedPhase]);
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
  const listOk = (x: PssrList | undefined) => !!x && (x.list.status === "complete" || (x.applicable > 0 && x.satisfied === x.applicable));
  const byPhase = settings.pssrByPhase ?? {};
  const tiedIds = new Set(Object.values(byPhase).map((v) => v.checklistId).filter(Boolean) as string[]);
  // A PSSR uploaded before phases were set up, not tied to one yet.
  const untied = phases.length ? (pssrs ?? []).filter((x) => !tiedIds.has(x.list.id)) : [];
  const phasePssr = (id: string) => { const v = byPhase[id]; return { notNeeded: !!v?.notNeeded, list: v?.checklistId ? (pssrs ?? []).find((x) => x.list.id === v.checklistId) : undefined }; };
  const pssrNotNeeded = settings.pssr === "not_needed";
  const pssr = pssrs === undefined ? undefined : pssrs[0] ?? null;
  const pssrOk = phases.length
    ? phases.every((p) => { const x = phasePssr(p.id); return x.notNeeded || listOk(x.list); })
    : pssrNotNeeded || listOk(pssr ?? undefined);
  const importFor = (p: ProjectPhase) => { onPickPhase?.(p.id); onTab("plan"); };
  // A PSSR just uploaded for a phase: the newest one not tied to a phase is it.
  const tieNewPssr = async (forPhase: string | null) => {
    if (forPhase && forPhase !== "all") {
      const lists = await listChecklists(orgId, projectId).catch(() => [] as Checklist[]);
      const fresh = lists.filter((c) => c.kind === "pssr" && c.status !== "void" && !tiedIds.has(c.id)).sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
      if (fresh) { const r = await saveCloseoutSettings(projectId, { pssrByPhase: { [forPhase]: { checklistId: fresh.id, notNeeded: false } } }); if (!r.ok) setErr(r.error ?? "Not saved."); }
    }
    reload();
  };
  const invoiced = money0 ? money0.entries.filter((e) => e.status !== "void" && (e.entry_type === "actual" || e.entry_type === "adjustment")).reduce((s, e) => s + Number(e.amount ?? 0), 0) : 0;
  const left = [
    !allWorkDone, !pssrOk, items && required.length > inCount, snap && snap.punchOpen > 0, snap && snap.openChangeOrders > 0,
  ].filter(Boolean).length;

  const btn = "inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
  const pri = "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black whitespace-nowrap disabled:opacity-50";

  if (!ms || !work) return <div className="py-16 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  return (
    <div className="space-y-4">
      {/* Where the work stands: the whole job, or each phase. */}
      <div className={`rounded-2xl border px-4 py-3 flex items-start gap-3 flex-wrap ${allWorkDone ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800" : "border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800"}`}>
        <span className={`mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${allWorkDone ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>{allWorkDone ? <Check className="w-5 h-5" /> : <span className="text-[15px] font-black">!</span>}</span>
        <div className="min-w-0 flex-1 basis-60">
          <div className={`text-[15px] font-black ${allWorkDone ? "text-emerald-900 dark:text-emerald-200" : "text-amber-900 dark:text-amber-200"}`}>
            {phases.length
              ? allWorkDone ? `The work is done: every phase (${work.done} of ${work.total} steps)`
                : unscheduled.length ? `Not done: ${unscheduled.map((p) => p.name).join(", ")} ${unscheduled.length === 1 ? "has" : "have"} no schedule yet`
                  : `Not done: ${phaseWork.filter((x) => !x.w.allDone).map((x) => x.p.name).join(", ")} still going`
              : work.allDone ? `The work is done: ${work.done} of ${work.total} steps` : `${work.done} of ${work.total} steps done`}
          </div>
          {phases.length ? (
            <ul className={`mt-1 space-y-1 text-[12.5px] ${allWorkDone ? "text-emerald-800 dark:text-emerald-300" : "text-amber-900 dark:text-amber-200"}`}>
              {phaseWork.map(({ p, w }) => (
                <li key={p.id} className="flex items-start gap-2 flex-wrap">
                  <span className="min-w-0 flex-1 basis-56">
                    {w.total === 0 ? <><b>{noScheduleWords(p, now, tz)}</b>.</>
                      : w.allDone ? <><b>{p.name}: done</b>, {w.done} of {w.total} steps{w.finishedAt != null ? ` · last finished ${when(w.finishedAt)}` : ""}{w.finishedAt != null && w.plannedFinish != null ? ` · planned ${when(w.plannedFinish)} (${vsPlanWords(w.hoursAfterPlan)})` : ""}</>
                        : <><b>{p.name}</b>: {w.done} of {w.total} steps done</>}
                  </span>
                  {w.total === 0 && canManage && <button type="button" onClick={() => importFor(p)} className={pri}><UploadCloud className="w-4 h-4" /> Import {p.name}&rsquo;s schedule</button>}
                </li>
              ))}
              {projectStatus !== "completed" && <li>{allWorkDone ? (left === 0 ? "Every close-out step is clear." : `Now close it out: ${left} thing${left === 1 ? "" : "s"} left.`) : "You can close out the finished phases now (their PSSR, turnover documents)."}</li>}
              {projectStatus === "completed" && <li>The project is marked complete.</li>}
            </ul>
          ) : (
            <div className={`text-[12.5px] ${work.allDone ? "text-emerald-800 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300"}`}>
              {work.finishedAt != null
                ? `Last step finished ${when(work.finishedAt)}${work.plannedFinish != null ? ` · planned ${when(work.plannedFinish)} (${vsPlanWords(work.hoursAfterPlan)})` : ""}. `
                : work.total ? `${work.total - work.done} step${work.total - work.done === 1 ? "" : "s"} not marked done yet. ` : "No schedule yet. "}
              {projectStatus === "completed" ? "The project is marked complete." : left === 0 ? "Every close-out step is clear." : work.allDone ? `Now close it out: ${left} thing${left === 1 ? "" : "s"} left.` : ""}
            </div>
          )}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button type="button" onClick={() => onTab("reports:asbuilt")} className={btn}><FileText className="w-4 h-4" /> As-built schedule</button>
          <button type="button" onClick={() => onTab("reports:closeout")} className={btn}><FileText className="w-4 h-4" /> Close-out report</button>
        </div>
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
            <Step n={1} ok={allWorkDone} title="Work done"
              detail={phases.length
                ? phaseWork.map(({ p, w }) => (w.total === 0 ? `${p.name}: no schedule yet` : w.allDone ? `${p.name}: done${w.finishedAt != null ? ` ${short(w.finishedAt)}` : ""}` : `${p.name}: ${w.done} of ${w.total} steps`)).join(" · ")
                : work.allDone ? `${work.done} of ${work.total} steps${work.finishedAt != null ? ` · finished ${when(work.finishedAt)}` : ""}` : `${work.total - work.done} of ${work.total} steps not marked done`}
              action={unscheduled.length && canManage ? <button type="button" onClick={() => importFor(unscheduled[0])} className={btn}>Import {unscheduled[0].name}&rsquo;s schedule</button>
                : !allWorkDone ? <button type="button" onClick={() => onTab("work")} className={btn}>Open the work <ArrowRight className="w-3.5 h-3.5" /></button> : null} />

            {phases.length ? (
              <Step n={2} ok={pssrs === undefined ? null : pssrOk} title="PSSR (pre-startup safety review), each phase"
                detail={pssrs === undefined ? "Checking…" : "Each phase starts up on its own: upload its PSSR (PDF), read into items you check off, or mark it not needed."}>
                <div className="mt-2 rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                  {phases.map((p) => {
                    const x = phasePssr(p.id);
                    const ok = x.notNeeded || listOk(x.list);
                    return (
                      <div key={p.id} className="px-3 py-2 flex items-center gap-2 flex-wrap text-[12.5px]">
                        <span className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center ${ok ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"}`}>{ok ? <Check className="w-3 h-3" /> : <span className="text-[10px] font-black">!</span>}</span>
                        <span className="min-w-0 flex-1 basis-40"><b className="text-[var(--color-text)]">{p.name}</b> <span className="text-[var(--color-text-muted)]">{x.notNeeded ? "· not needed" : x.list ? `· ${x.list.list.title}: ${x.list.satisfied} of ${x.list.applicable} items done${x.list.list.status === "complete" ? ", complete" : ""}` : "· not uploaded"}</span></span>
                        {x.list && <button type="button" onClick={() => onTab("quality")} className={btn}>Open</button>}
                        {!x.list && !x.notNeeded && canManage && <>
                          <button type="button" onClick={() => { setErr(null); setUploading(p.id); }} className={pri}><UploadCloud className="w-4 h-4" /> Upload</button>
                          <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssrByPhase: { [p.id]: { notNeeded: true, checklistId: null } } }))} className={btn}>Not needed</button>
                        </>}
                        {x.notNeeded && canManage && <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssrByPhase: { [p.id]: { notNeeded: false, checklistId: null } } }))} className={btn}>Needed after all</button>}
                      </div>
                    );
                  })}
                  {untied.map((x) => (
                    <label key={x.list.id} className="px-3 py-2 flex items-center gap-2 flex-wrap text-[12.5px] bg-[var(--color-surface-2)]/40">
                      <span className="min-w-0 flex-1 basis-40 text-[var(--color-text)]"><b>{x.list.title}</b> <span className="text-[var(--color-text-muted)]">· uploaded before the phases: which phase is it?</span></span>
                      {canManage && (
                        <select value="" aria-label={`Phase for ${x.list.title}`} disabled={!!busy}
                          onChange={(e) => { const id = e.target.value; if (id) void run("pssr", () => saveCloseoutSettings(projectId, { pssrByPhase: { [id]: { checklistId: x.list.id, notNeeded: false } } })); }}
                          className="h-8 rounded-lg border border-orange-400 bg-[var(--color-surface)] px-2 text-[12.5px]">
                          <option value="">Pick the phase</option>
                          {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      )}
                    </label>
                  ))}
                </div>
              </Step>
            ) : (
              <Step n={2} ok={pssrOk} title="PSSR (pre-startup safety review)"
                detail={pssrNotNeeded ? "Not needed for this job." : pssr === undefined ? "Checking…" : pssr ? `${pssr.list.title}: ${pssr.satisfied} of ${pssr.applicable} items done${pssr.list.status === "complete" ? " · complete" : ""}`
                  : "Upload the PSSR (PDF): saved to the project's documents and read into items you check off. Or mark it not needed for this job."}
                action={pssrNotNeeded ? (canManage ? <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssr: null }))} className={btn}>Needed after all</button> : null)
                  : pssr ? <button type="button" onClick={() => onTab("quality")} className={btn}>Open <ArrowRight className="w-3.5 h-3.5" /></button>
                    : canManage ? <span className="flex gap-1.5 flex-wrap">
                      <button type="button" onClick={() => { setErr(null); setUploading("all"); }} className={pri}><UploadCloud className="w-4 h-4" /> Upload PSSR</button>
                      <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssr: "not_needed" }))} className={btn}>Not needed</button>
                    </span> : null} />
            )}

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
              {unscheduled.length > 0
                ? <span className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">{unscheduled.map((p) => p.name).join(", ")} {unscheduled.length === 1 ? "has" : "have"} no schedule yet: complete the project only if {unscheduled.length === 1 ? "it isn't" : "they aren't"} going ahead.</span>
                : left > 0 && <span className="text-[12px] text-[var(--color-text-muted)]">{left} step{left === 1 ? "" : "s"} still open: you can complete anyway.</span>}
              <button type="button" onClick={onComplete} className={allWorkDone ? "inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-emerald-600 text-white text-[13px] font-black hover:bg-emerald-700" : "inline-flex items-center gap-1.5 h-9 px-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-[13px] font-bold hover:bg-[var(--color-surface-2)]"}><Check className="w-4 h-4" /> Mark project complete</button>
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
              {stats.noSchedule && pickedPhase ? (
                <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2.5 text-[12.5px] text-amber-900 dark:text-amber-200 flex items-center gap-2 flex-wrap">
                  <span className="min-w-0 flex-1 basis-48"><b>{noScheduleWords(pickedPhase, now, tz)}.</b> Nothing to measure until its schedule is imported.</span>
                  {canManage && <button type="button" onClick={() => importFor(pickedPhase)} className={pri}><UploadCloud className="w-4 h-4" /> Import {pickedPhase.name}&rsquo;s schedule</button>}
                </div>
              ) : (
                <>
                  {stats.missing.length > 0 && (
                    <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200">
                      <b>{stats.missing.map((p) => noScheduleWords(p, now, tz)).join("; ")}.</b> The figures below cover only {phases.filter((p) => !stats.missing.some((x) => x.id === p.id)).map((p) => p.name).join(", ")}.
                    </div>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {stats.missing.length > 0
                      ? <Tile k="Finish" v="Not finished" s={`${stats.missing.map((p) => p.name).join(", ")} not scheduled`} tone="warn" />
                      : <Tile k={stats.finishedAt != null ? "Finished" : "Planned finish"} v={stats.finishedAt != null ? short(stats.finishedAt) : stats.plannedFinish != null ? short(stats.plannedFinish) : "-"}
                        s={stats.finishedAt != null && stats.plannedFinish != null ? `${vsPlanWords(Math.round(((stats.finishedAt - stats.plannedFinish) / 3_600_000) * 10) / 10)} (${short(stats.plannedFinish)})` : `${stats.actualPct}% done, plan ${stats.plannedPct}%`} />}
                    <Tile k="Steps" v={`${stats.done} / ${stats.steps}`} s={`${Math.round(stats.hours).toLocaleString("en-US")} h of work`} />
                    <Tile k="Added work" v={`${stats.added.count} added`} s={stats.added.count ? `${stats.added.steps} step${stats.added.steps === 1 ? "" : "s"} · +${stats.added.hours} h of work` : "nothing added to the plan"} />
                    <Tile k={pickedPhase ? "Phase budget" : money0?.afe != null ? "AFE" : "Budget"} v={money(stats.budget)} s={`budget lines ${money(stats.lines.reduce((a, l) => a + l.budget, 0))}`} />
                    <Tile k="Spent" v={money(stats.spent)} s={stats.budget ? `${Math.round((stats.spent / stats.budget) * 100)}% of the ${pickedPhase ? "phase budget" : money0?.afe != null ? "AFE" : "budget"}` : "no budget"} />
                    <Tile k={stats.budget - stats.spent >= 0 ? "Left" : "Over"} v={money(Math.abs(stats.budget - stats.spent))} tone={stats.budget - stats.spent >= 0 ? "good" : "bad"} s={stats.budget - stats.spent >= 0 ? "invoices still to come?" : "over the budget"} />
                  </div>
                  {stats.shifts.length > 0 && (
                    <div>
                      <div className="text-[12.5px] font-bold text-[var(--color-text)]">Against the original plan, shift by shift</div>
                      <ul className="mt-1 mb-2 space-y-0.5 text-[11.5px] leading-snug text-[var(--color-text-muted)]">
                        {chartKey(stats, tz).map((k) => <li key={k}>{k}</li>)}
                        <li>Past the plan&rsquo;s finish, anything short of 100% is late, in red.</li>
                      </ul>
                      <div className="divide-y divide-[var(--color-border)]/60">
                        {stats.shifts.map((r) => {
                          const red = behindAt(r);
                          return (
                            <div key={r.start} className={`grid grid-cols-[116px_minmax(0,1fr)_auto] gap-2 items-center py-1 text-[12px] ${r.kind === "night" ? "bg-[var(--color-surface-2)]/50" : ""}`}>
                              <span className="text-[var(--color-text)] leading-tight pl-1">{shiftLabel(r)}
                                {r.planEnds && stats.plannedFinish != null && <span className="block text-[10.5px] font-bold text-[#000A72] dark:text-indigo-300">plan finish {fmtInTz(stats.plannedFinish, tz, { hour: "numeric", minute: "2-digit", hour12: true })}</span>}
                                {r.finishes && stats.finishedAt != null && <span className="block text-[10.5px] font-bold text-emerald-700 dark:text-emerald-400">all done {fmtInTz(stats.finishedAt, tz, { hour: "numeric", minute: "2-digit", hour12: true })}</span>}
                                {r.current && <span className="block text-[10.5px] text-[var(--color-text-muted)]">now</span>}</span>
                              <div className="space-y-0.5">
                                {r.plan != null
                                  ? <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden"><div className="h-full rounded-full bg-slate-400" style={{ width: `${Math.min(100, r.plan)}%` }} /></div>
                                  : <div className="h-1.5" />}
                                <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">{r.done != null && <div className={`h-full rounded-full ${red ? "bg-rose-500" : "bg-emerald-600"}`} style={{ width: `${Math.min(100, r.done)}%` }} />}</div>
                              </div>
                              <span className="text-right tabular-nums text-[var(--color-text-muted)] leading-tight pr-1">
                                {r.plan != null ? `${r.plan}%` : "past plan"}{r.done != null ? <> / <b className={red ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}>{r.done}%</b>{r.plan == null && red && <b className="text-rose-700 dark:text-rose-400"> late</b>}</> : " / to come"}
                                {r.addedKnown > 0 && <span className="block text-[10.5px] text-amber-700 dark:text-amber-400">added {Math.round((r.addedDone ?? 0) * 10) / 10} of {r.addedKnown} h</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {stats.shifts.length > 0 && <SlipStory stats={stats} tz={tz} look={look} lookById={lookById} setbacks={(look?.setbacks ?? []).filter((x) => !phaseIds || phaseIds.has(x.id))} steps={(look?.steps ?? []).filter((x) => !phaseIds || phaseIds.has(x.id))} loading={!look} />}
                </>
              )}
              {stats.lines.length > 0 && <LinesChart rows={stats.lines} cur="USD" />}
            </div>
          ) : <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>}
        </div>
      </div>

      {uploading && (
        <Modal onClose={() => setUploading(null)} size="lg">
          <ModalHeader icon={UploadCloud} title={uploading === "all" ? "Upload the PSSR" : `Upload ${phases.find((p) => p.id === uploading)?.name ?? "the phase"}'s PSSR`} subtitle="Saved to this project's documents, then read into checklist items. You check them before anything is kept." onClose={() => setUploading(null)} />
          <ModalBody className="!p-0">
            {err && <div role="alert" className="px-4 pt-3 text-[12.5px] font-semibold text-rose-700 dark:text-rose-400">{err}</div>}
            <NewChecklistFlow orgId={orgId} projectId={projectId} projectName={projectName} actor={actor}
              onDone={() => { const forPhase = uploading; setUploading(null); void tieNewPssr(forPhase); }} onCancel={() => setUploading(null)} setErr={setErr} kindDefault="pssr" />
          </ModalBody>
        </Modal>
      )}
    </div>
  );
}

/** Why it finished late (or where it slipped), from the record: when it
 *  fell behind; what set the finish, back through what each step waited
 *  on to the steps that lost time of their own; what put it behind, the
 *  late steps grouped under where their delay came from; then the biggest
 *  setbacks and where the time went. Where nothing recorded explains a
 *  late start, what was going on at the time is shown as context. */
function SlipStory({ stats, tz, look, lookById, setbacks, steps, loading }: {
  stats: ReturnType<typeof phaseStats>; tz: string; look: LookBack | null; lookById: Map<string, StepLook>; setbacks: StepLook[]; steps: StepLook[]; loading: boolean;
}) {
  const sl = stats.slip;
  const late = stats.finishedAt != null && stats.plannedFinish != null && stats.finishedAt > stats.plannedFinish + 1_800_000;
  const when = (t: number) => `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  const label = (x: { task: string; name: string; wo?: string; crew?: string }) => `${x.task ? `${x.task} \u203a ` : ""}${x.name}${x.wo ? ` (WO ${x.wo})` : ""}${x.crew ? `, ${x.crew}` : ""}`;
  const unexplained = (x: StepLook) => (x.lost["late-start"] ?? 0) >= 1;
  const Cause = ({ x, held, self }: { x: StepLook; held?: Array<{ s: SlipStep; right: string }>; self?: number }) => (
    <li className="py-2">
      <div className="text-[12.5px] font-bold text-[var(--color-text)] leading-snug">{label(x)}</div>
      {rootWords(x).slice(0, 3).map((w) => <div key={w} className="text-[12px] text-amber-800 dark:text-amber-300 leading-snug">{w}</div>)}
      {unexplained(x) && whileWaiting(lookById, x, 2).map((w) => <div key={w} className="text-[11.5px] text-[var(--color-text-muted)] leading-snug">While it waited: {w}</div>)}
      {self != null && self > 0 && <div className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)] leading-snug">{Math.round(self * 10) / 10} h of its own planned work behind then</div>}
      {held && held.length > 0 && (
        <div className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)] leading-snug">Held up: {held.map((h) => `${h.s.task ? `${h.s.task} \u203a ` : ""}${h.s.name} (${h.right})`).join("; ")}</div>
      )}
    </li>
  );
  // What set the finish: the chain from the last step done, the steps on
  // it with time of their own lost; the rest waited.
  const chain = look && late ? finishChain(look) : [];
  const drivers = chain.filter(ownCause);
  const waited = chain.filter((x) => !ownCause(x));
  // What put it behind: the steps furthest behind then, under their cause.
  const at = sl.forGood ?? sl.first;
  const groups = new Map<string, { cause: StepLook; held: Array<{ s: SlipStep; right: string }>; self: number; hours: number }>();
  for (const x of sl.behind.slice(0, 12)) {
    const c = causeOf(lookById, x.id);
    if (!c) continue;
    const g = groups.get(c.id) ?? { cause: c, held: [], self: 0, hours: 0 };
    if (c.id !== x.id) g.held.push({ s: x, right: `${x.hoursBehind} h behind` });
    else g.self += x.hoursBehind;
    g.hours += x.hoursBehind;
    groups.set(c.id, g);
  }
  const behindCauses = [...groups.values()].sort((a, b) => b.hours - a.hours).slice(0, 5);
  const byCause = (["hold", "longer", "late-start", "replanned", "discovery"] as CauseKind[]).map((c) => ({ c, h: Math.round(steps.reduce((a, x) => a + (x.lost[c] ?? 0), 0) * 10) / 10, n: steps.filter((x) => (x.lost[c] ?? 0) > 0).length })).filter((x) => x.h > 0);
  const maxH = Math.max(1, ...byCause.map((x) => x.h));
  const head = "text-[12.5px] font-black text-[var(--color-text)] mt-3";
  return (
    <div className="rounded-xl border border-[var(--color-border)] px-3 py-2.5">
      <div className="text-[13px] font-black text-[var(--color-text)]">{late ? "Why it finished late" : "Where it slipped"}</div>
      <ul className="mt-1 space-y-0.5 text-[12px] text-[var(--color-text)] leading-snug">
        {slipWords(stats, tz).map((w) => <li key={w}>{w}</li>)}
      </ul>
      {loading && <div className="mt-2 text-[11.5px] text-[var(--color-text-muted)]">Reading what was recorded on each step…</div>}
      {drivers.length > 0 && (
        <>
          <div className={head}>What set the finish</div>
          <div className="text-[11.5px] text-[var(--color-text-muted)]">The last step done, back through what each waited on (its links). These lost time of their own:</div>
          <ol className="divide-y divide-[var(--color-border)]/60">{drivers.map((x) => <Cause key={x.id} x={x} />)}</ol>
          {waited.length > 0 && <div className="text-[11.5px] text-[var(--color-text-muted)] leading-snug">Waited on them: {waited.map((x) => x.name).join(", ")}.</div>}
        </>
      )}
      {at && behindCauses.length > 0 && (
        <>
          <div className={head}>What put it behind at the end of {shiftLabel(at)}</div>
          <div className="text-[11.5px] text-[var(--color-text-muted)]">The steps furthest behind then, under where their delay came from:</div>
          <ul className="divide-y divide-[var(--color-border)]/60">{behindCauses.map((g) => <Cause key={g.cause.id} x={g.cause} held={g.held} self={g.self} />)}</ul>
        </>
      )}
      {sl.pastPlan.length > 0 && stats.plannedFinish != null && (
        <>
          <div className={head}>Still going when the plan said done ({when(stats.plannedFinish)})</div>
          <div className="text-[11.5px] text-[var(--color-text)] leading-snug">{sl.pastPlan.slice(0, 10).map((x) => `${slipStepLine(x)}: ${x.finish != null ? `done ${when(x.finish)}` : "not done"}`).join(" · ")}{sl.pastPlan.length > 10 ? ` · and ${sl.pastPlan.length - 10} more` : ""}</div>
        </>
      )}
      {setbacks.length > 0 && (
        <>
          <div className={head}>Steps that lost the most time of their own</div>
          <ul className="divide-y divide-[var(--color-border)]/60">{setbacks.slice(0, 5).map((x) => (
            <li key={x.id} className="py-1.5">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[12px] text-[var(--color-text)] leading-snug">{label(x)}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-rose-700 dark:text-rose-400">lost {x.lostH} h</span>
              </div>
              {lostWords(x).slice(0, 3).map((w) => <div key={w} className="text-[11.5px] text-amber-800 dark:text-amber-300 leading-snug">{w}</div>)}
              {unexplained(x) && whileWaiting(lookById, x, 1).map((w) => <div key={w} className="text-[11.5px] text-[var(--color-text-muted)] leading-snug">While it waited: {w}</div>)}
            </li>
          ))}</ul>
        </>
      )}
      {byCause.length > 0 && (
        <>
          <div className={head}>Where the time went</div>
          <div className="text-[11px] text-[var(--color-text-muted)] mb-1">Hours each step lost of its own, by cause (waiting on the work before it isn&rsquo;t counted again). Steps run side by side, so these add up to more than the finish&rsquo;s slip.</div>
          <div className="space-y-1">{byCause.map((x) => (
            <div key={x.c} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] gap-2 items-center text-[11.5px]">
              <span className="text-[var(--color-text)] leading-tight">{CAUSE_LABEL[x.c]}</span>
              <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden"><div className="h-full rounded-full bg-amber-500" style={{ width: `${(x.h / maxH) * 100}%` }} /></div>
              <span className="tabular-nums text-[var(--color-text-muted)]">{x.h} h · {x.n} step{x.n === 1 ? "" : "s"}</span>
            </div>
          ))}</div>
        </>
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

function Tile({ k, v, s, tone }: { k: string; v: string; s: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] px-3 py-2 min-w-0">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{k}</div>
      <div className={`text-[16px] font-black truncate ${tone === "good" ? "text-emerald-700 dark:text-emerald-400" : tone === "bad" ? "text-rose-700 dark:text-rose-400" : tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-[var(--color-text)]"}`}>{v}</div>
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
