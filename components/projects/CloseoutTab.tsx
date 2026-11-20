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
import { Check, UploadCloud, ArrowRight, Loader2, Plus, FileText, ChevronDown, ChevronUp } from "lucide-react";
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
import ProjectFilePlace from "@/components/projects/ProjectFilePlace";
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
import ManpowerLook from "@/components/projects/ManpowerLook";
import { useManpowerSettings } from "@/components/projects/ManpowerSetup";
import { loadShiftRecords, type ShiftRecord } from "@/lib/shiftRecord";
import { companyOf, handsAt, manpowerSummary, shiftCounts, type ManpowerSettings, type ShiftCount } from "@/lib/manpower";
import PostEventReview from "@/components/projects/PostEventReview";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { Card } from "@/components/ui/PageHero";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import { fileSize } from "@/components/projects/cost/FilePreview";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

type PssrList = { list: Checklist; satisfied: number; applicable: number };

// ── What's left to close a job once its work is done ──
// One reading for the close-out's steps and the project page's band, so
// both say the same number.

export type CloseItemId = "pssr" | "turnover" | "punch" | "co";
export interface CloseItem { id: CloseItemId; name: string; detail: string }
/** The close-out steps after the work: open ones in order, then the clear ones. */
export interface CloseOpen { open: CloseItem[]; clear: CloseItem[] }

const listOk = (x: PssrList | undefined) => !!x && (x.list.status === "complete" || (x.applicable > 0 && x.satisfied === x.applicable));
const joinNames = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Each phase's PSSR (or the job's): clear, and in words. */
function pssrState(phases: ProjectPhase[], pssrs: PssrList[], settings: CloseoutSettings): { ok: boolean; detail: string } {
  const byPhase = settings.pssrByPhase ?? {};
  if (phases.length) {
    const rows = phases.map((p) => {
      const v = byPhase[p.id];
      const list = v?.checklistId ? pssrs.find((x) => x.list.id === v.checklistId) : undefined;
      return { p, notNeeded: !!v?.notNeeded, list, ok: !!v?.notNeeded || listOk(list) };
    });
    const notIn = rows.filter((r) => !r.ok && !r.list).map((r) => r.p.name);
    const going = rows.filter((r) => !r.ok && r.list).map((r) => `${r.p.name}: ${r.list!.satisfied} of ${r.list!.applicable} items done`);
    const ok = rows.every((r) => r.ok);
    return { ok, detail: ok ? "Clear for every phase." : [notIn.length ? `${joinNames(notIn)}: not uploaded` : "", ...going].filter(Boolean).join(". ") };
  }
  if (settings.pssr === "not_needed") return { ok: true, detail: "Not needed for this job." };
  const one = pssrs[0];
  if (!one) return { ok: false, detail: "Not uploaded" };
  return { ok: listOk(one), detail: `${one.satisfied} of ${one.applicable} items done` };
}

/** The open and clear close-out steps from what was read. A part that
 *  couldn't be read (null) is left out rather than called clear. */
export function closeOpenOf(x: { phases: ProjectPhase[]; pssrs: PssrList[] | null; settings: CloseoutSettings; items: TurnoverItem[] | null; snap: ProjectStateSnapshot | null }): CloseOpen {
  const all: Array<CloseItem & { ok: boolean }> = [];
  if (x.pssrs) { const s = pssrState(x.phases, x.pssrs, x.settings); all.push({ id: "pssr", name: x.phases.length ? "PSSR for each phase" : "PSSR", detail: s.detail, ok: s.ok }); }
  if (x.items) {
    const required = x.items.filter((i) => i.required);
    const inCount = required.filter((i) => i.status === "accepted" || i.status === "waived").length;
    all.push({ id: "turnover", name: "Turnover documents", detail: required.length ? `${inCount} of ${required.length} required in` : "None set for this job", ok: required.length <= inCount });
  }
  if (x.snap) {
    all.push({ id: "punch", name: "Punch list", detail: x.snap.punchOpen ? `${x.snap.punchOpen} open` : "Nothing open", ok: x.snap.punchOpen === 0 });
    all.push({ id: "co", name: "Change orders", detail: x.snap.openChangeOrders ? `${x.snap.openChangeOrders} waiting on a decision` : "None waiting", ok: x.snap.openChangeOrders === 0 });
  }
  const strip = ({ id, name, detail }: CloseItem) => ({ id, name, detail });
  return { open: all.filter((i) => !i.ok).map(strip), clear: all.filter((i) => i.ok).map(strip) };
}

/** What's left to close, read on its own (the project page's band). Off:
 *  null and nothing read. */
export function useCloseOpen(orgId: string | undefined, projectId: string | undefined, phases: ProjectPhase[], on: boolean, key = 0): CloseOpen | null {
  const [v, setV] = useState<CloseOpen | null>(null);
  useEffect(() => {
    if (!on || !orgId || !projectId) return;
    let live = true;
    void (async () => {
      const [lists, settings, items, snap] = await Promise.all([
        listChecklists(orgId, projectId).catch(() => null),
        loadCloseoutSettings(projectId).catch(() => ({} as CloseoutSettings)),
        listTurnoverItems(orgId, projectId).catch(() => null),
        gatherProjectSnapshot(orgId, projectId).catch(() => null),
      ]);
      const mine = (lists ?? []).filter((c) => c.kind === "pssr" && c.status !== "void");
      const pssrs = lists ? await Promise.all(mine.map(async (c) => { const pr = computeChecklistProgress(await listChecklistItems(c.id)); return { list: c, satisfied: pr.satisfied, applicable: pr.applicable }; })).catch(() => null) : null;
      if (live) setV(closeOpenOf({ phases, pssrs, settings, items, snap }));
    })();
    return () => { live = false; };
  }, [orgId, projectId, phases, on, key]);
  return on ? v : null;
}

/** One step on a path: done (filled, a check), next (ringed, "· next"),
 *  or still to do (faint). */
export interface PathRow { state: "done" | "next" | "todo"; title: React.ReactNode; detail?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode }

/** Steps joined by one line down their left, so they read as one path. */
export function PathSteps({ rows }: { rows: PathRow[] }) {
  return (
    <ol className="list-none">
      {rows.map((r, i) => {
        const last = i === rows.length - 1;
        return (
          <li key={i} className="flex gap-3.5" aria-current={r.state === "next" ? "step" : undefined}>
            <div className="flex flex-col items-center">
              <span className={`w-[22px] h-[22px] shrink-0 rounded-full box-border flex items-center justify-center text-[11px] ${
                r.state === "done" ? "bg-[var(--color-text)] text-[var(--color-surface)]"
                  : r.state === "next" ? "border-2 border-[var(--color-text)] font-extrabold text-[var(--color-text)]"
                    : "border border-[var(--color-border-strong)] font-bold text-[var(--color-text-faint)]"}`}>
                {r.state === "done" ? <Check className="w-3 h-3" strokeWidth={3} /> : i + 1}
              </span>
              {!last && <span aria-hidden className={`flex-1 w-0.5 min-h-[18px] ${r.state === "done" ? "bg-[var(--color-text)]" : "bg-[var(--color-border)]"}`} />}
            </div>
            <div className={`min-w-0 flex-1 ${last ? "" : "pb-4"}`}>
              <div className="flex items-start gap-2 flex-wrap">
                <div className="min-w-0 flex-1 basis-48">
                  <div className={`text-[14px] leading-snug ${r.state === "todo" ? "font-semibold text-[var(--color-text-muted)]" : "font-bold text-[var(--color-text)]"}`}>
                    {r.title}{r.state === "next" && <span className="text-[12px] font-bold text-[var(--color-text)]"> · next</span>}
                  </div>
                  {r.detail && <div className="text-[13px] text-[var(--color-text-muted)] leading-snug">{r.detail}</div>}
                </div>
                {r.action && <div className="shrink-0">{r.action}</div>}
              </div>
              {r.children}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default function CloseoutTab({ orgId, projectId, projectName, projectStatus, jobKind, tz, phases, uid, userEmail, canManage, onTab, onPickPhase, onLessons, onComplete, onOpen }: {
  orgId: string; projectId: string; projectName: string; projectStatus: string; jobKind: string | null; tz: string;
  phases: ProjectPhase[]; uid: string; userEmail: string | null; canManage: boolean;
  /** Go to another tab (Quality's punch list, Costs, Reports). */
  onTab: (tab: string) => void;
  /** Pick a phase on the project (to import its schedule on Plan). */
  onPickPhase?: (phaseId: string) => void;
  onLessons: () => void;
  onComplete: () => void;
  /** What's still open to close, each time it's read (the page's band says it). */
  onOpen?: (open: CloseOpen) => void;
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
  const [readFailed, setReadFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Turnover files already filed, so Try again only ties them.
  const filed = useRef(new Map<string, { documentId: string; label: string }>());
  // Uploading a PSSR: for the whole job ("all") or a phase.
  const [uploading, setUploading] = useState<string | null>(null);
  const [newDoc, setNewDoc] = useState("");
  const [phasePick, setPhasePick] = useState<string | null>(null);
  // The close-out's pages: the steps to close, and the post-event review.
  const [view, setView] = useState<"steps" | "review">("steps");
  // Where attached files are saved: the project's library, else one picked here.
  const [home, setHome] = useState<ProjectFileHome | null>(null);
  // The shift meetings' head counts, and each company's bid (lib/manpower).
  const [records, setRecords] = useState<Map<string, ShiftRecord> | null>(null);
  const mp = useManpowerSettings(projectId);
  useEffect(() => {
    let live = true;
    loadShiftRecords(projectId).then((r) => { if (live) setRecords(r); }).catch(() => { if (live) setRecords(new Map()); });
    return () => { live = false; };
  }, [projectId, tick]);

  useEffect(() => {
    let live = true;
    void (async () => {
      // A read that fails says so, instead of looking like nothing's there.
      const failed: string[] = [];
      const miss = <T,>(what: string, v: T) => () => { failed.push(what); return v; };
      const rows = <T,>(table: string) => fetchAllRows<T>((from, to) => supabase.from(table).select("*").eq("project_id", projectId).order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>);
      const [m, l, lines, entries, proj, s, lists, t, cs, h] = await Promise.all([
        listMilestones({ orgId, projectId, includeGhost: true }).catch(miss("the schedule", [] as Milestone[])),
        loadProgressLog(projectId),
        rows<CostLine>("cost_accounts"), rows<CostEntry>("cost_entries"),
        supabase.from("projects").select("authorized_amount").eq("id", projectId).maybeSingle(),
        gatherProjectSnapshot(orgId, projectId).catch(miss("the punch list and change orders", null)),
        listChecklists(orgId, projectId).catch(miss("the PSSR", [] as Checklist[])),
        listTurnoverItems(orgId, projectId).catch(miss("the turnover documents", [] as TurnoverItem[])),
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
      setReadFailed(failed);
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
    return buildLookBack({ milestones: active, notes, discoveries: discoveries(active), now: Date.now(), tz, log });
  }, [ms, notes, tz, log]);
  const lookById = useMemo(() => new Map((look?.steps ?? []).map((x) => [x.id, x])), [look]);
  const phaseIds = useMemo(() => (ms && pickedPhase ? new Set(inPhase(ms, phases, pickedPhase.id).map((m) => m.id!)) : null), [ms, phases, pickedPhase]);
  // All phases: each phase's own numbers, against its own plan.
  const perPhase = useMemo(() => (ms && money0 && !pickedPhase ? phases.map((p) => ({
    p, ids: new Set(inPhase(ms, phases, p.id).map((m) => m.id!)),
    ps: phaseStats({ milestones: ms, phases, phase: p, log, tz, times, now: Date.now(), total: money0.afe, lines: money0.lines, entries: money0.entries }),
  })) : []), [ms, money0, pickedPhase, phases, log, tz, times]);
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
  // Attach a file to a turnover document: filed in the project's place,
  // then tied to the item. Try again never files it twice: a file already
  // filed is only tied again.
  const attachFile = async (it: TurnoverItem, file: File) => {
    if (!home?.place) throw new Error("Pick where this project's files go first (above the list).");
    const key = `${it.id}:${file.name}:${file.size}:${file.lastModified}`;
    await tryUpload(file.name, async () => {
      let made = filed.current.get(key);
      if (!made) {
        made = await uploadProjectFile({ orgId, projectId, projectName, file, prefix: "TURNOVER", title: `${it.name} - ${file.name.replace(/\.[a-z0-9]+$/i, "")}`, actorUserId: uid, actorEmail: userEmail });
        filed.current.set(key, made);
      }
      const r = await attachTurnoverDocument({ item: it, documentId: made.documentId, documentLabel: made.label, actor });
      if (!r.ok) throw new Error(r.error ?? "Filed, but not tied to the document.");
    }, { onRetried: () => reload() });
    reload();
  };
  const invoiced = money0 ? money0.entries.filter((e) => e.status !== "void" && (e.entry_type === "actual" || e.entry_type === "adjustment")).reduce((s, e) => s + Number(e.amount ?? 0), 0) : 0;
  const left = [
    !allWorkDone, !pssrOk, items && required.length > inCount, snap && snap.punchOpen > 0, snap && snap.openChangeOrders > 0,
  ].filter(Boolean).length;
  // Tell the page what's still open (its band says it), each time it's read.
  const said = useRef(onOpen);
  useEffect(() => { said.current = onOpen; });
  useEffect(() => {
    if (!ms || pssrs === undefined) return;
    said.current?.(closeOpenOf({ phases, pssrs, settings, items, snap }));
  }, [ms, pssrs, settings, items, snap, phases]);

  const btn = "inline-flex items-center gap-1 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
  const pri = "inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-extrabold whitespace-nowrap hover:bg-[var(--color-accent-hover)] shadow-[0_10px_22px_-12px_var(--color-accent)] disabled:opacity-50";
  const quiet = "inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap";
  // One main next step, the only orange button: schedule a phase that has
  // none, else upload the PSSR that's missing, else Mark complete once
  // everything is clear.
  const firstPssrMissing = phases.length ? phases.find((p) => { const x = phasePssr(p.id); return !x.notNeeded && !x.list; }) ?? null : null;
  const main: "import" | "pssr" | "complete" | null = !canManage || projectStatus === "completed" ? null
    : unscheduled.length ? "import"
      : pssrs !== undefined && !pssrOk && (phases.length ? !!firstPssrMissing : !pssrNotNeeded && pssr === null) ? "pssr"
        : allWorkDone && left === 0 ? "complete" : null;

  if (!ms || !work) return <Card><LoadingBlock what="close-out" className="border-0 p-0" /></Card>;

  // The close-out's two pages, and its two reports: the first card.
  const nav = (
    <Card pad={false} className="px-3 sm:px-4 py-2.5 flex items-center gap-2 flex-wrap">
      <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Close-out">
        {([["steps", "Steps to close"], ["review", "Post-event review"]] as const).map(([id, name]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)} data-closeout-view={id}
            className={`h-9 px-3.5 rounded-lg text-[13px] font-bold whitespace-nowrap transition-colors ${view === id ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>{name}</button>
        ))}
      </div>
      <div className="flex-1" />
      <div className="flex gap-1 flex-wrap">
        <button type="button" onClick={() => onTab("reports:asbuilt")} className={quiet}><FileText className="w-4 h-4 text-[var(--color-text-muted)]" /> As-built schedule</button>
        <button type="button" onClick={() => onTab("reports:closeout")} className={quiet}><FileText className="w-4 h-4 text-[var(--color-text-muted)]" /> Close-out report</button>
      </div>
    </Card>
  );
  if (view === "review") return (
    <div className="space-y-4">{nav}
      <PostEventReview orgId={orgId} projectId={projectId} projectName={projectName} tz={tz} times={times} phases={phases} milestones={ms} log={log} notes={notes ?? []} records={records ?? new Map()} money={money0}
        canManage={canManage} actor={actor} onReload={reload} onTab={onTab} stepsLeft={left} onSteps={() => setView("steps")} />
    </div>
  );

  // The steps, as one path: done ones filled, the first open one next.
  const oks: Array<boolean | null> = [allWorkDone, pssrs === undefined ? null : pssrOk, items ? required.length === inCount : null, snap ? snap.punchOpen === 0 : null, snap ? snap.openChangeOrders === 0 : null, null, null];
  const nextAt = oks.findIndex((o) => o === false);
  const stateAt = (i: number): PathRow["state"] => (oks[i] ? "done" : i === nextAt ? "next" : "todo");
  const pssrRows = phases.length ? (
    <div className="mt-2 space-y-1">
      {phases.map((p) => {
        const x = phasePssr(p.id);
        const ok = x.notNeeded || listOk(x.list);
        return (
          <div key={p.id} className="flex items-center gap-2 flex-wrap text-[13px] min-h-9">
            <span className="min-w-0 flex-1 basis-40 text-[var(--color-text)]">
              {ok && <Check className="inline w-3.5 h-3.5 mr-1 -mt-0.5 text-emerald-700 dark:text-emerald-400" />}
              <b>{p.name}</b>: <span className="text-[var(--color-text-muted)]">{x.notNeeded ? "not needed" : x.list ? `${x.list.list.title}, ${x.list.satisfied} of ${x.list.applicable} items done${x.list.list.status === "complete" ? ", complete" : ""}` : "not uploaded"}</span>
            </span>
            {x.list && <button type="button" onClick={() => onTab("quality")} className={btn}>Open</button>}
            {!x.list && !x.notNeeded && canManage && <>
              <button type="button" onClick={() => { setErr(null); setUploading(p.id); }} className={main === "pssr" && firstPssrMissing?.id === p.id ? pri : btn}><UploadCloud className="w-4 h-4" /> Upload</button>
              <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssrByPhase: { [p.id]: { notNeeded: true, checklistId: null } } }))} className={quiet}>Not needed</button>
            </>}
            {x.notNeeded && canManage && <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssrByPhase: { [p.id]: { notNeeded: false, checklistId: null } } }))} className={quiet}>Needed after all</button>}
          </div>
        );
      })}
      {untied.map((x) => (
        <label key={x.list.id} className="flex items-center gap-2 flex-wrap text-[13px] min-h-9">
          <span className="min-w-0 flex-1 basis-40 text-[var(--color-text)]"><b>{x.list.title}</b> <span className="text-[var(--color-text-muted)]">· uploaded before the phases: which phase is it?</span></span>
          {canManage && (
            <select value="" aria-label={`Phase for ${x.list.title}`} disabled={!!busy}
              onChange={(e) => { const id = e.target.value; if (id) void run("pssr", () => saveCloseoutSettings(projectId, { pssrByPhase: { [id]: { checklistId: x.list.id, notNeeded: false } } })); }}
              className="h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px]">
              <option value="">Pick the phase</option>
              {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </label>
      ))}
    </div>
  ) : null;
  const workRows = phases.length ? (
    <ul className="mt-1.5 space-y-1 text-[13px] text-[var(--color-text)]">
      {phaseWork.map(({ p, w }) => (
        <li key={p.id} className="flex items-center gap-2 flex-wrap min-h-7">
          <span className="min-w-0 flex-1 basis-56">
            {w.total === 0 ? <b>{noScheduleWords(p, now, tz)}.</b>
              : w.allDone ? <><b>{p.name}</b>: done {w.finishedAt != null ? when(w.finishedAt) : ""}{w.finishedAt != null && w.plannedFinish != null ? <span className={w.hoursAfterPlan != null && w.hoursAfterPlan >= 0.5 ? "text-rose-700 dark:text-rose-400 font-semibold" : "text-[var(--color-text-muted)]"}>, {vsPlanWords(w.hoursAfterPlan)}</span> : null}<span className="text-[var(--color-text-muted)]"> · {w.done} of {w.total} steps</span></>
                : <><b>{p.name}</b>: <span className="text-[var(--color-text-muted)]">{w.done} of {w.total} steps done</span></>}
          </span>
          {w.total === 0 && canManage && <button type="button" onClick={() => importFor(p)} className={main === "import" && p.id === unscheduled[0]?.id ? pri : btn}><UploadCloud className="w-4 h-4" /> Import {p.name}&rsquo;s schedule</button>}
        </li>
      ))}
      {!allWorkDone && projectStatus !== "completed" && <li className="text-[var(--color-text-muted)]">You can close out the finished phases now (their PSSR, turnover documents).</li>}
    </ul>
  ) : null;
  const steps: PathRow[] = [
    {
      state: stateAt(0), title: allWorkDone ? "Work done" : "The work",
      detail: phases.length ? undefined
        : work.allDone ? <>{work.done} of {work.total} steps{work.finishedAt != null ? `, finished ${when(work.finishedAt)}` : ""}{work.finishedAt != null && work.plannedFinish != null ? <span className={work.hoursAfterPlan != null && work.hoursAfterPlan >= 0.5 ? "text-rose-700 dark:text-rose-400 font-semibold" : ""}> ({vsPlanWords(work.hoursAfterPlan)})</span> : null}.</>
          : work.total ? `${work.total - work.done} of ${work.total} steps not marked done.` : "No schedule yet.",
      action: !allWorkDone && !unscheduled.length ? <button type="button" onClick={() => onTab("work")} className={btn}>Open the work <ArrowRight className="w-3.5 h-3.5" /></button> : null,
      children: workRows,
    },
    phases.length ? {
      state: stateAt(1), title: "PSSR (pre-startup safety review), each phase",
      detail: pssrs === undefined ? "Checking…" : "Each phase starts up on its own: upload its PSSR (PDF), read into items you check off, or mark it not needed.",
      children: pssrRows,
    } : {
      state: stateAt(1), title: "PSSR (pre-startup safety review)",
      detail: pssrNotNeeded ? "Not needed for this job." : pssr === undefined ? "Checking…" : pssr ? `${pssr.list.title}: ${pssr.satisfied} of ${pssr.applicable} items done${pssr.list.status === "complete" ? ", complete" : ""}`
        : "Upload the PSSR (PDF): saved to the project's documents and read into items you check off. Or mark it not needed for this job.",
      action: pssrNotNeeded ? (canManage ? <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssr: null }))} className={quiet}>Needed after all</button> : null)
        : pssr ? <button type="button" onClick={() => onTab("quality")} className={btn}>Open <ArrowRight className="w-3.5 h-3.5" /></button>
          : canManage ? <span className="flex gap-1.5 flex-wrap">
            <button type="button" onClick={() => { setErr(null); setUploading("all"); }} className={main === "pssr" ? pri : btn}><UploadCloud className="w-4 h-4" /> Upload PSSR</button>
            <button type="button" disabled={!!busy} onClick={() => void run("pssr", () => saveCloseoutSettings(projectId, { pssr: "not_needed" }))} className={quiet}>Not needed</button>
          </span> : null,
    },
    {
      state: stateAt(2), title: "Turnover documents",
      detail: !items ? "Checking…" : items.length === 0 ? "No documents set for this job yet." : `${inCount} of ${required.length} required in. You pick what this job needs.`,
      children: items && (
        <div className="mt-2 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {/* Where attached files go: asked once, picked by the person, changeable here. */}
          {home && items.length > 0 && (
            <div className="py-2">
              <ProjectFilePlace orgId={orgId} projectId={projectId} uid={uid} canManage={canManage} home={home} onChange={setHome} />
            </div>
          )}
          {items.map((it) => (
            <TurnoverRow key={it.id} it={it} canManage={canManage} busy={busy === it.id}
              onRequired={() => void run(it.id, () => updateTurnoverItem({ item: it, patch: { required: !it.required }, actor }))}
              onAccept={() => void run(it.id, () => reviewTurnoverItem({ item: it, status: "accepted", actor }))}
              onFile={(file) => attachFile(it, file)} />
          ))}
          {canManage && (
            <div className="py-2 flex items-center gap-2 flex-wrap">
              {items.length === 0 && <button type="button" disabled={!!busy} onClick={() => void run("seed", async () => { const r = await seedTurnoverItems({ orgId, projectId, jobKind, actor }); return { ok: r.ok, error: r.error }; })} className={btn}>Start from the usual list</button>}
              <input value={newDoc} onChange={(e) => setNewDoc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newDoc.trim()) { const n = newDoc.trim(); setNewDoc(""); void run("add", async () => { const r = await addTurnoverItem({ orgId, projectId, name: n, required: true, actor }); return { ok: r.ok, error: r.error }; }); } }}
                placeholder="Add a document this job needs" aria-label="Add a document this job needs" className="h-9 flex-1 min-w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-[13px]" />
              <button type="button" disabled={!newDoc.trim() || !!busy} onClick={() => { const n = newDoc.trim(); setNewDoc(""); void run("add", async () => { const r = await addTurnoverItem({ orgId, projectId, name: n, required: true, actor }); return { ok: r.ok, error: r.error }; }); }} className={btn}><Plus className="w-3.5 h-3.5" /> Add</button>
            </div>
          )}
        </div>
      ),
    },
    { state: stateAt(3), title: "Punch list", detail: !snap ? "Checking…" : snap.punchOpen === 0 ? "Nothing open" : `${snap.punchOpen} open`,
      action: <button type="button" onClick={() => onTab("quality")} className={btn}>Open</button> },
    { state: stateAt(4), title: "Change orders", detail: !snap ? "Checking…" : snap.openChangeOrders === 0 ? "None waiting on a decision" : `${snap.openChangeOrders} waiting on a decision`,
      action: snap && snap.openChangeOrders > 0 ? <button type="button" onClick={() => onTab("costs")} className={btn}>Decide <ArrowRight className="w-3.5 h-3.5" /></button> : null },
    { state: stateAt(5), title: "Final cost", detail: money0 ? `${money(invoiced)} invoiced${money0.afe != null ? ` of ${money(money0.afe)} AFE` : ""}. Post the last invoices before closing.` : "Checking…",
      action: <button type="button" onClick={() => onTab("costs")} className={btn}>Invoices</button> },
    { state: stateAt(6), title: "Lessons & findings", detail: "Keep what this job taught for next time.",
      action: <button type="button" onClick={onLessons} className={btn}>Review</button> },
    ...(projectStatus !== "completed" ? [{
      state: (left === 0 && allWorkDone ? "next" : "todo") as PathRow["state"], title: "Mark the project complete",
      detail: !canManage ? "The project owner marks it complete."
        : unscheduled.length > 0 ? <span className="font-semibold text-amber-800 dark:text-amber-300">{joinNames(unscheduled.map((p) => p.name))} {unscheduled.length === 1 ? "has" : "have"} no schedule yet: complete the project only if {unscheduled.length === 1 ? "it isn't" : "they aren't"} going ahead.</span>
          : left > 0 ? `${left} step${left === 1 ? "" : "s"} still open: you can complete anyway.` : "Everything above is clear.",
      action: canManage ? <button type="button" onClick={onComplete} className={main === "complete" ? pri : btn}><Check className="w-4 h-4" /> Mark project complete</button> : null,
    }] : [{ state: "done" as const, title: "Project complete", detail: "The project is marked complete." }]),
  ];

  return (
    <div className="space-y-4">
      {nav}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] items-start">
        {/* To close this project: every step as one path. */}
        <Card label="To close the project" action={<span className="text-[12px] font-semibold text-[var(--color-text-muted)]">{left === 0 ? "All clear" : `${left} left`}</span>}>
          {readFailed.length > 0 && (
            <div role="alert" className="mb-3 text-[13px] font-semibold text-rose-700 dark:text-rose-300 flex flex-wrap items-center gap-x-3">
              <span>Couldn&apos;t load {readFailed.join(", ")}. What&apos;s shown may be missing items.</span>
              <button type="button" onClick={reload} className="text-[var(--color-accent-text)] font-bold hover:underline">Try again</button>
            </div>
          )}
          {err && <div role="alert" className="mb-3 text-[13px] font-semibold text-rose-700 dark:text-rose-300 whitespace-pre-line">{err}</div>}
          <PathSteps rows={steps} />
        </Card>

        {/* How the job did */}
        <Card label="How the job did" action={phases.length > 0 ? (
          <span className="inline-flex rounded-lg bg-[var(--color-surface-2)] p-0.5" role="group" aria-label="Phase">
            {[{ id: null as string | null, name: "All" }, ...phases.map((p) => ({ id: p.id as string | null, name: p.name }))].map((p) => (
              <button key={p.id ?? "all"} type="button" aria-pressed={phasePick === p.id} onClick={() => setPhasePick(p.id)}
                className={`h-8 px-2.5 rounded-md text-[12px] font-bold whitespace-nowrap ${phasePick === p.id ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{p.name}</button>
            ))}
          </span>
        ) : undefined}>
          {stats ? (
            <div className="space-y-4">
              {pickedPhase && <div className="text-[13px] text-[var(--color-text-muted)]">{pickedPhase.name} · {phaseDates(pickedPhase).replace(" – ", " to ")} · {pickedPhase.share}% of the {money0?.afe != null ? "AFE" : "budget"}</div>}
              {stats.noSchedule && pickedPhase ? (
                <p className="text-[13px] text-amber-900 dark:text-amber-200">
                  <b>{noScheduleWords(pickedPhase, now, tz)}.</b> Nothing to measure until its schedule is imported.
                </p>
              ) : (
                <>
                  {stats.missing.length > 0 && (
                    <p className="text-[13px] text-amber-900 dark:text-amber-200">
                      <b>{stats.missing.map((p) => noScheduleWords(p, now, tz)).join("; ")}.</b> The figures below cover only {phases.filter((p) => !stats.missing.some((x) => x.id === p.id)).map((p) => p.name).join(", ")}.
                    </p>
                  )}
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px]">
                    {stats.missing.length > 0
                      ? <Fact k="Finish" v="Not finished" s={`${stats.missing.map((p) => p.name).join(", ")} not scheduled`} tone="warn" />
                      : <Fact k={stats.finishedAt != null ? "Finished" : "Planned finish"} v={stats.finishedAt != null ? short(stats.finishedAt) : stats.plannedFinish != null ? short(stats.plannedFinish) : "-"}
                        tone={stats.finishedAt != null && stats.plannedFinish != null && stats.finishedAt - stats.plannedFinish >= 1_800_000 ? "bad" : undefined}
                        s={stats.finishedAt != null && stats.plannedFinish != null ? `${vsPlanWords(Math.round(((stats.finishedAt - stats.plannedFinish) / 3_600_000) * 10) / 10)} (${short(stats.plannedFinish)})` : !pickedPhase && phases.length > 0 ? `${stats.phasesDone} of ${phases.length} phases done` : `${stats.actualPct}% done, plan ${stats.plannedPct}%`} />}
                    <Fact k="Steps" v={`${stats.done} of ${stats.steps}`} s={`${Math.round(stats.hours).toLocaleString("en-US")} h of work`} />
                    <Fact k="Added work" v={`${stats.added.count} added`} s={stats.added.count ? `${stats.added.steps} step${stats.added.steps === 1 ? "" : "s"}, +${stats.added.hours} h of work` : "nothing added to the plan"} />
                    <Fact k={pickedPhase ? "Phase budget" : money0?.afe != null ? "AFE" : "Budget"} v={money(stats.budget)} s={`budget lines ${money(stats.lines.reduce((a, l) => a + l.budget, 0))}`} />
                    <Fact k="Spent" v={money(stats.spent)} s={stats.budget ? `${Math.round((stats.spent / stats.budget) * 100)}% of the ${pickedPhase ? "phase budget" : money0?.afe != null ? "AFE" : "budget"}` : "no budget"} />
                    <Fact k={stats.budget - stats.spent >= 0 ? "Left" : "Over"} v={money(Math.abs(stats.budget - stats.spent))} tone={stats.budget - stats.spent >= 0 ? "good" : "bad"} s={stats.budget - stats.spent >= 0 ? "invoices still to come?" : "over the budget"} />
                  </dl>
                  {!pickedPhase && phases.length > 0 ? (
                    // All phases: each phase against its own plan, never merged into one line.
                    <div className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                      {perPhase.map(({ p, ps, ids }) => (
                        <div key={p.id} className="py-3 space-y-2">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <b className="text-[14px] text-[var(--color-text)]">{p.name}</b>
                            <span className="text-[12px] text-[var(--color-text-muted)]">{phaseDates(p).replace(" – ", " to ")}</span>
                          </div>
                          <div className={`text-[13px] ${ps.noSchedule ? "text-amber-800 dark:text-amber-300" : "text-[var(--color-text)]"}`}>
                            {ps.noSchedule ? `${noScheduleWords(p, now, tz)}.`
                              : ps.finishedAt != null ? <>Done {when(ps.finishedAt)}{ps.plannedFinish != null ? <>, <span className={ps.finishedAt - ps.plannedFinish >= 1_800_000 ? "font-semibold text-rose-700 dark:text-rose-400" : ""}>{vsPlanWords(Math.round(((ps.finishedAt - ps.plannedFinish) / 3_600_000) * 10) / 10)}</span> (plan {when(ps.plannedFinish)})</> : null}.</>
                                : `${ps.actualPct}% done, plan by now ${ps.plannedPct}%, ${ps.done} of ${ps.steps} steps.`}
                          </div>
                          {ps.shifts.length > 0 && <Progress stats={ps} tz={tz} look={look} lookById={lookById} ids={ids} loading={!look} records={records} mp={mp} />}
                        </div>
                      ))}
                      {perPhase.length > 1 && <WholeManpower shifts={perPhase.flatMap((x) => x.ps.shifts)} records={records} mp={mp} />}
                    </div>
                  ) : stats.shifts.length > 0 && <Progress stats={stats} tz={tz} look={look} lookById={lookById} ids={phaseIds} loading={!look} records={records} mp={mp} />}
                </>
              )}
              {stats.lines.length > 0 && <div className="pt-3 border-t border-[var(--color-border)]"><LinesChart rows={stats.lines} cur="USD" bare /></div>}
            </div>
          ) : <LoadingBlock what="how the job did" className="border-0 p-0" />}
        </Card>
      </div>
      {uploading && (
        <Modal onClose={() => setUploading(null)} size="lg">
          <ModalHeader icon={UploadCloud} title={uploading === "all" ? "Upload the PSSR" : `Upload ${phases.find((p) => p.id === uploading)?.name ?? "the phase"}'s PSSR`} subtitle="Filed where you pick, then read into checklist items. You check them before anything is kept." onClose={() => setUploading(null)} />
          <ModalBody className="!p-0">
            {err && <div role="alert" className="px-4 pt-3 text-[12.5px] font-semibold text-rose-700 dark:text-rose-400">{err}</div>}
            <NewChecklistFlow orgId={orgId} projectId={projectId} projectName={projectName} actor={actor}
              part={uploading === "all" ? null : phases.find((p) => p.id === uploading)?.name ?? null}
              onDone={() => { const forPhase = uploading; setUploading(null); void tieNewPssr(forPhase); void projectFileHome(orgId, projectId).then(setHome).catch(() => undefined); }} onCancel={() => setUploading(null)} setErr={setErr} kindDefault="pssr" />
          </ModalBody>
        </Modal>
      )}
    </div>
  );
}

/** One plan's progress, shift by shift, and why it slipped (the steps in
 *  `ids`, else all). */
function Progress({ stats, tz, look, lookById, ids, loading, records, mp }: {
  stats: ReturnType<typeof phaseStats>; tz: string; look: LookBack | null; lookById: Map<string, StepLook>; ids: Set<string> | null; loading: boolean;
  records: Map<string, ShiftRecord> | null; mp: ManpowerSettings | null;
}) {
  const [now] = useState(() => Date.now());
  // The shift-by-shift story is long: one tap opens it.
  const [open, setOpen] = useState(false);
  const counts = useMemo(() => (records ? shiftCounts(records, stats.shifts.filter((r) => r.start <= now).map((r) => ({ kind: r.kind, dayKey: r.dayKey, start: r.start, end: Math.min(r.end, now) })), mp) : []), [records, stats.shifts, mp, now]);
  const steps = useMemo(() => (look?.steps ?? []).filter((x) => !ids || ids.has(x.id)), [look, ids]);
  const late = stats.finishedAt != null && stats.plannedFinish != null && stats.finishedAt - stats.plannedFinish > 3_600_000;
  if (!open) return (
    <button type="button" onClick={() => setOpen(true)} aria-expanded={false} data-progress-open
      className="w-full flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 h-10 text-left text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
      <span className="min-w-0 flex-1">{late || stats.actualPct < stats.plannedPct ? "Shift by shift, and why it slipped" : "Shift by shift"}</span>
      <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />
    </button>
  );
  return (
    <>
      <button type="button" onClick={() => setOpen(false)} aria-expanded data-progress-open
        className="w-full flex items-center gap-2 rounded-lg px-3 h-9 text-left text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
        <span className="min-w-0 flex-1">Hide the shift-by-shift story</span>
        <ChevronUp className="w-4 h-4 text-[var(--color-text-muted)]" />
      </button>
      <div>
        <div className="text-[13px] font-bold text-[var(--color-text)]">Against the original plan, shift by shift</div>
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
                  {r.planEnds && stats.plannedFinish != null && <span className="block text-[11px] font-bold text-[var(--color-text)]">plan finish {fmtInTz(stats.plannedFinish, tz, { hour: "numeric", minute: "2-digit", hour12: true })}</span>}
                  {r.finishes && stats.finishedAt != null && <span className="block text-[11px] font-bold text-emerald-700 dark:text-emerald-400">all done {fmtInTz(stats.finishedAt, tz, { hour: "numeric", minute: "2-digit", hour12: true })}</span>}
                  {r.current && <span className="block text-[11px] text-[var(--color-text-muted)]">now</span>}</span>
                <div className="space-y-0.5">
                  {r.plan != null
                    ? <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden"><div className="h-full rounded-full bg-slate-400" style={{ width: `${Math.min(100, r.plan)}%` }} /></div>
                    : <div className="h-1.5" />}
                  <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">{r.done != null && <div className={`h-full rounded-full ${red ? "bg-rose-500" : "bg-emerald-600"}`} style={{ width: `${Math.min(100, r.done)}%` }} />}</div>
                </div>
                <span className="text-right tabular-nums text-[var(--color-text-muted)] leading-tight pr-1">
                  {r.plan != null ? `${r.plan}%` : "past plan"}{r.done != null ? <> / <b className={red ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}>{r.done}%</b>{r.plan == null && red && <b className="text-rose-700 dark:text-rose-400"> late</b>}</> : " / to come"}
                  {r.addedKnown > 0 && <span className="block text-[11px] text-amber-700 dark:text-amber-400">added {Math.round((r.addedDone ?? 0) * 10) / 10} of {r.addedKnown} h</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <SlipStory stats={stats} tz={tz} look={look} lookById={lookById} setbacks={(look?.setbacks ?? []).filter((x) => !ids || ids.has(x.id))} steps={steps} loading={loading} counts={counts} mp={mp} />
      <ManpowerLook shifts={stats.shifts} records={records} settings={mp} steps={steps} tz={tz} now={now} />
    </>
  );
}

/** Why it finished late (or where it slipped), from the record: when it
 *  fell behind; what set the finish, back through what each step waited
 *  on to the steps that lost time of their own; what put it behind, the
 *  late steps grouped under where their delay came from; then the biggest
 *  setbacks and where the time went. Where nothing recorded explains a
 *  late start, what was going on at the time is shown as context. */
function SlipStory({ stats, tz, look, lookById, setbacks, steps, loading, counts, mp }: {
  stats: ReturnType<typeof phaseStats>; tz: string; look: LookBack | null; lookById: Map<string, StepLook>; setbacks: StepLook[]; steps: StepLook[]; loading: boolean;
  counts: ShiftCount[]; mp: ManpowerSettings | null;
}) {
  const sl = stats.slip;
  const late = stats.finishedAt != null && stats.plannedFinish != null && stats.finishedAt > stats.plannedFinish + 1_800_000;
  const when = (t: number) => `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  const label = (x: { task: string; name: string; wo?: string; crew?: string }) => `${x.task ? `${x.task} \u203a ` : ""}${x.name}${x.wo ? ` (WO ${x.wo})` : ""}${x.crew ? `, ${x.crew}` : ""}`;
  const unexplained = (x: StepLook) => (x.lost["late-start"] ?? 0) >= 1;
  // Waited for the crew: its company's hands then, against the bid (as
  // counted at that shift's meeting).
  const hands = (x: StepLook): string | null => {
    if ((x.lost.crew ?? 0) <= 0 || !x.crew) return null;
    const co = companyOf(x.crew, mp);
    const h = handsAt(counts, co, x.waitFrom + (Math.max(x.waitFrom, x.as) - x.waitFrom) / 2, mp);
    if (!h) return null;
    // Like for like: direct against the bid's direct; a count not split
    // against the bid's total.
    const said = h.direct != null
      ? `${h.direct} direct on site then${h.bidDirect != null ? `, bid ${h.bidDirect}` : ""}`
      : `${h.total} on site then (not split direct and indirect)${h.bidTotal != null ? `, bid ${h.bidTotal}` : ""}`;
    return `${co} had ${said}${h.carried ? "; count carried over, not checked" : ""}.`;
  };
  const Cause = ({ x, held, self }: { x: StepLook; held?: Array<{ s: SlipStep; right: string }>; self?: number }) => (
    <li className="py-2">
      <div className="text-[12.5px] font-bold text-[var(--color-text)] leading-snug">{label(x)}</div>
      {rootWords(x).slice(0, 3).map((w) => <div key={w} className="text-[12px] text-amber-800 dark:text-amber-300 leading-snug">{w}</div>)}
      {hands(x) && <div className="text-[11.5px] text-[var(--color-text-muted)] leading-snug">{hands(x)}</div>}
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
  const byCause = (["hold", "longer", "crew", "late-start", "replanned", "discovery"] as CauseKind[]).map((c) => ({ c, h: Math.round(steps.reduce((a, x) => a + (x.lost[c] ?? 0), 0) * 10) / 10, n: steps.filter((x) => (x.lost[c] ?? 0) > 0).length })).filter((x) => x.h > 0);
  const maxH = Math.max(1, ...byCause.map((x) => x.h));
  const head = "text-[13px] font-bold text-[var(--color-text)] mt-3";
  return (
    <div className="pt-3 border-t border-[var(--color-border)]">
      <div className="text-[14px] font-bold text-[var(--color-text)]">{late ? "Why it finished late" : "Where it slipped"}</div>
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
          <div className={head}>What put it behind {at.current ? "so far this shift" : "at the end of"} {at.current ? `(${shiftLabel(at)})` : shiftLabel(at)}</div>
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
              {hands(x) && <div className="text-[11.5px] text-[var(--color-text-muted)] leading-snug">{hands(x)}</div>}
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

/** All phases: the manpower over the whole project, in one line. */
function WholeManpower({ shifts, records, mp }: { shifts: ReturnType<typeof phaseStats>["shifts"]; records: Map<string, ShiftRecord> | null; mp: ManpowerSettings | null }) {
  const [now] = useState(() => Date.now());
  const sum = useMemo(() => {
    if (!records) return null;
    const seen = new Set<string>();
    const w = shifts.filter((r) => r.start <= now && !seen.has(`${r.dayKey}:${r.kind}`) && seen.add(`${r.dayKey}:${r.kind}`))
      .sort((a, b) => a.start - b.start).map((r) => ({ kind: r.kind, dayKey: r.dayKey, start: r.start, end: Math.min(r.end, now) }));
    return manpowerSummary(shiftCounts(records, w, mp), records, mp);
  }, [shifts, records, mp, now]);
  if (!sum || sum.counted === 0) return null;
  const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
  return (
    <div className="py-3 text-[13px] leading-snug">
      <b className="text-[var(--color-text)]">Whole project manpower: </b>
      <span className="text-[var(--color-text-muted)]">
        {n0(sum.totalMH)} man-hours{sum.directMH + sum.indirectMH > 0 ? ` (${n0(sum.directMH)} direct, ${n0(sum.indirectMH)} indirect)` : ""}, peak {sum.peak?.n ?? 0} on site
        {sum.cost != null ? `, ${money(sum.cost)} at the bid rates` : ""}.
        {" "}{sum.incidents.recordable} recordable{sum.incidents.recordable === 1 ? "" : "s"}{sum.recordableRate != null ? `, rate ${sum.recordableRate.toFixed(2)} per 200,000 man-hours` : ""}.
        {" "}Counted on {sum.counted} of {sum.shifts} shifts{sum.carried ? `, ${sum.carried} carried over, not checked` : ""}.
      </span>
    </div>
  );
}

/** One line of how the job did: the name, the figure, what backs it. */
function Fact({ k, v, s, tone }: { k: string; v: string; s: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <>
      <dt className="text-[var(--color-text-muted)]">{k}</dt>
      <dd className="min-w-0">
        <b className={tone === "good" ? "text-emerald-700 dark:text-emerald-400" : tone === "bad" ? "text-rose-700 dark:text-rose-400" : tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-[var(--color-text)]"}>{v}</b>
        <span className="text-[var(--color-text-muted)]"> · {s}</span>
      </dd>
    </>
  );
}

const STATUS: Record<TurnoverItem["status"], { word: string; cls: string }> = {
  open: { word: "Needed", cls: "bg-[var(--color-surface-2)] text-[var(--color-text)] dark:bg-[var(--color-surface-2)] dark:text-[var(--color-text)]" },
  received: { word: "Received", cls: "bg-[var(--color-surface-2)] text-[var(--color-text)] dark:bg-[var(--color-surface-2)] dark:text-[var(--color-text)]" },
  accepted: { word: "Accepted", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  rejected: { word: "Rejected", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  waived: { word: "Waived", cls: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" },
};

/** One turnover document: needed for this job or not, where it stands,
 *  and attach the file or accept it. */
function TurnoverRow({ it, canManage, busy, onRequired, onAccept, onFile }: { it: TurnoverItem; canManage: boolean; busy: boolean; onRequired: () => void; onAccept: () => void; onFile: (f: File) => Promise<void> }) {
  const file = useRef<HTMLInputElement | null>(null);
  // The file going up for this row, and one that didn't, kept for Try again.
  const [sending, setSending] = useState<File | null>(null);
  const [failed, setFailed] = useState<{ file: File; error: string } | null>(null);
  const canAttach = canManage && it.required && (it.status === "open" || it.status === "rejected");
  const send = async (f: File) => {
    setSending(f); setFailed(null);
    try { await onFile(f); }
    catch (e) { setFailed({ file: f, error: (e as Error).message || "It didn't attach." }); }
    finally { setSending(null); }
  };
  const drag = useFileDrag((fs) => { void send(fs[0]); }, !canAttach || busy || !!sending);
  const st = it.required ? STATUS[it.status] : { word: "Not for this job", cls: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" };
  return (
    <div {...drag.bind} className={`${drag.ring}`}>
    <div className={`px-3 py-2 flex items-center gap-2.5 text-[12.5px] ${it.required ? "" : "opacity-60"}`}>
      <button type="button" role="switch" aria-checked={it.required} aria-label={`${it.name} needed for this job`} disabled={!canManage || busy} onClick={onRequired}
        className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${it.required ? "bg-[var(--color-text)]" : "bg-[var(--color-border-strong)]"} disabled:opacity-60`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-[var(--color-surface)] shadow transition-all ${it.required ? "left-[18px]" : "left-0.5"}`} />
      </button>
      <span className="min-w-0 flex-1 break-words leading-snug text-[var(--color-text)]" title={it.description ?? undefined}>{it.name}</span>
      <span className={`shrink-0 text-[11px] font-black px-2 py-0.5 rounded-full ${st.cls}`}>{busy || sending ? <Loader2 className="w-3 h-3 animate-spin inline" /> : st.word}</span>
      {canAttach && (
        <>
          <input ref={file} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f); if (file.current) file.current.value = ""; }} />
          <button type="button" disabled={busy || !!sending} onClick={() => file.current?.click()} className="shrink-0 h-7 px-2.5 rounded-lg border border-[var(--color-border-strong)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Attach</button>
        </>
      )}
      {canManage && it.required && it.status === "received" && (
        <button type="button" disabled={busy} onClick={onAccept} className="shrink-0 h-7 px-2.5 rounded-lg border border-emerald-500/60 text-[12px] font-bold text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/10">Accept</button>
      )}
    </div>
    {drag.over && <div className="px-3 pb-2 text-[12px] font-bold text-[var(--color-text)]">{drag.say}</div>}
    {(sending || failed) && (
      <div className="px-3 pb-2 flex items-center gap-2 text-[12px]">
        <FileThumb file={(sending ?? failed!.file)} size={28} />
        <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">{(sending ?? failed!.file).name} <span className="text-[var(--color-text-muted)]">· {fileSize((sending ?? failed!.file).size)}</span>
          {sending ? <span className="text-[var(--color-text-muted)]"> · attaching…</span> : <span className="block font-semibold text-rose-700 dark:text-rose-300 truncate">{failed!.error}</span>}
        </span>
        {failed && !sending && <button type="button" onClick={() => void send(failed.file)} className="shrink-0 h-7 px-2.5 rounded-lg border border-[var(--color-border-strong)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Try again</button>}
      </div>
    )}
    </div>
  );
}
