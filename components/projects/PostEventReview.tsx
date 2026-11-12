"use client";

// PostEventReview - the look back at a finished event (or one phase of it),
// drafted from its records (lib/postEventReview): the numbers, a finding
// for each category with what the event showed, the leading practice, the
// gap and how it closes, and the questions the records can't answer.
//
// A person keeps, changes, adds to or throws out each finding, adds their
// own, and answers the questions; Re-analyze reads the records again with
// those answers. What was kept or changed is never overwritten. Kept
// findings go to the lessons register. The same review downloads as a Word
// report and as the meeting slides.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FileText, Loader2, Pencil, Plus, Presentation, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import type { ShiftRecord } from "@/lib/shiftRecord";
import type { ShiftTimes } from "@/lib/shiftReport";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork } from "@/lib/asBuiltWork";
import { buildLookBack } from "@/lib/lookBack";
import { discoveries } from "@/lib/discovery";
import { inPhase, type ProjectPhase } from "@/lib/projectPhases";
import { companyOf } from "@/lib/manpower";
import { useManpowerSettings } from "@/components/projects/ManpowerSetup";
import { loadNextPlanSettings } from "@/lib/nextPlanStore";
import type { StaffingPlans } from "@/lib/staffingPlan";
import { fmtInTz } from "@/lib/scheduleTz";
import { listMaterials, summarize } from "@/lib/materials";
import {
  CATEGORIES, CAUSE_CHOICES, CAUSE_WORD, RATING_MEANS, RATING_WORD, basisOf, buildReview, categoryOf, emptySaved, jobWord, orderWord, shiftWord, shiftsWord,
  type Answer, type CategoryId, type CauseId, type Finding, type FindingEdit, type Rating, type ReviewSaved,
} from "@/lib/postEventReview";
import { changeReview, loadReview, reviewScope, syncLesson } from "@/lib/reviewStore";
import { fileStem, reviewDocx, reviewPptx, saveFile, type ReviewFileOpts } from "@/lib/reviewFiles";

const btn = "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
const dark = "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--color-text)] text-[var(--color-surface)] text-[12.5px] font-black whitespace-nowrap disabled:opacity-50";
const pri = "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black whitespace-nowrap disabled:opacity-50";
const field = "w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)]";
const label = "text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]";
const RATE_CLS: Record<Rating, string> = {
  gap: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  opportunity: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  strength: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  none: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]",
};

type Filter = "all" | "gap" | "opportunity" | "strength" | "kept" | "discarded";

export default function PostEventReview({ orgId, projectId, projectName, jobKind, tz, times, phases, milestones, log, notes, records, canManage, actor, onReload, onTab }: {
  orgId: string; projectId: string; projectName: string; jobKind: string | null; tz: string; times: ShiftTimes;
  phases: ProjectPhase[]; milestones: Milestone[]; log: ProgressLogRow[] | null; notes: MilestoneNote[]; records: Map<string, ShiftRecord>;
  canManage: boolean; actor: { uid: string; email: string | null };
  /** Read the project's records again. */
  onReload: () => void;
  onTab: (tab: string) => void;
}) {
  // One phase at a time: the first finished one, else the first.
  const doneOf = useCallback((id: string) => { const leaves = inPhase(milestones, phases, id).filter((m) => !m.isSummary && !(m as { cancelledAt?: unknown }).cancelledAt); return leaves.length > 0 && leaves.every((m) => m.status === "completed"); }, [milestones, phases]);
  const [phaseId, setPhaseId] = useState<string | null>(() => (phases.length ? (phases.find((p) => doneOf(p.id)) ?? phases[0]).id : null));
  const phase = phases.find((p) => p.id === phaseId) ?? null;
  const scope = reviewScope(phases.length ? phaseId : null);
  const mp = useManpowerSettings(projectId);
  const [plans, setPlans] = useState<StaffingPlans | null>(null);
  const [saved, setSaved] = useState<ReviewSaved | null>(null);
  const [register, setRegister] = useState<{ lines: number; specIncomplete: number; openQuestions: number; late: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const [infoText, setInfoText] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setSaved(null);
    void (async () => {
      try {
        const [s, np, mats] = await Promise.all([
          loadReview(projectId, scope),
          loadNextPlanSettings(projectId).catch(() => null),
          listMaterials(projectId).catch(() => ({ rows: [], missing: true })),
        ]);
        if (!live) return;
        setSaved(s); setPlans(np?.staffing ?? null);
        const mine = mats.rows.filter((r) => !phases.length || !r.phaseId || r.phaseId === phaseId);
        const sum = summarize(mine, Date.now());
        setRegister(mats.missing || !sum.lines ? null : { lines: sum.lines, specIncomplete: sum.specIncomplete, openQuestions: sum.openQuestions, late: sum.late });
      } catch (e) { if (live) { setErr((e as Error).message); setSaved(emptySaved()); } }
    })();
    return () => { live = false; };
  }, [projectId, scope, phaseId, phases.length, tick]);

  const review = useMemo(() => {
    if (!saved) return null;
    const mine = phases.length && phaseId ? inPhase(milestones, phases, phaseId) : milestones;
    const kids = new Map<string, Milestone[]>();
    for (const m of mine) if (m.parentId) { if (!kids.has(m.parentId)) kids.set(m.parentId, []); kids.get(m.parentId)!.push(m); }
    const ids = new Set(mine.map((m) => m.id));
    const active = mine.filter((m) => !(m as { cancelledAt?: unknown }).cancelledAt);
    const myNotes = notes.filter((n) => ids.has(n.milestoneId));
    const now = Date.now();
    const built = buildAsBuilt({ milestones: mine, childrenByParent: kids, phases, tz });
    const work = buildAsBuiltWork({ built, milestones: mine, log: (log ?? []).filter((r) => ids.has(r.milestone_id)), notes: myNotes, records, plans, companyOf: (c) => companyOf(c, mp), tz, times, now });
    const ds = discoveries(active);
    const look = buildLookBack({ milestones: active, notes: myNotes, discoveries: ds, now, tz });
    return buildReview({ built, work, notes: myNotes, look, discoveries: ds, tz, saved, materials: register });
  }, [saved, milestones, phases, phaseId, notes, log, records, plans, mp, tz, times, register]);

  const who = actor.email;
  const act = async (key: string, change: (s: ReviewSaved) => void, after?: (next: ReviewSaved) => Promise<void> | void) => {
    setBusy(key); setErr(null); setMsg(null);
    try { const next = await changeReview(projectId, scope, change); setSaved(next); await after?.(next); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  // A kept finding goes to the lessons register; un-kept or thrown out, it leaves.
  const lesson = async (f: Finding, kept: boolean) => {
    const ok = await syncLesson({ orgId, projectId, projectType: jobKind, scope, finding: f, kept, actor: { id: actor.uid, name: who } }).catch((e) => { setErr((e as Error).message); return true; });
    if (!ok && kept) setMsg("Kept here. The lessons register (From past jobs) isn't set up in the database yet, so it wasn't added there.");
  };
  const refind = (next: ReviewSaved, key: string): Finding | undefined => {
    if (!review) return undefined;
    const f = review.findings.find((x) => x.key === key);
    if (!f) return undefined;
    // The same finding with what was just saved laid over it.
    const it = next.items[key]; const e = it?.edits ?? {};
    if (f.source === "person") { const a = next.added.find((x) => `added:${x.id}` === key); return a ? { ...f, title: a.title ?? f.title, observation: a.observation ?? "", gap: a.gap ?? "", next: a.next ?? "", year: a.year ?? "", owner: a.owner ?? "", rating: a.rating ?? f.rating, info: it?.info ?? [] } : f; }
    return { ...f, title: e.title ?? f.drafted.title, observation: e.observation ?? f.drafted.observation, rating: e.rating ?? f.drafted.rating, practice: e.practice ?? f.practice, gap: e.gap ?? f.gap, next: e.next ?? f.next, year: e.year ?? f.year, owner: e.owner ?? f.owner, info: it?.info ?? [] };
  };

  const keep = (f: Finding) => void act(`keep:${f.key}`, (s) => { s.items[f.key] = { ...s.items[f.key], status: "kept", basis: basisOf(f), at: Date.now(), by: who }; }, () => lesson(f, true));
  const unkeep = (f: Finding) => void act(`keep:${f.key}`, (s) => { const it = { ...s.items[f.key] }; delete it.status; s.items[f.key] = it; }, () => lesson(f, false));
  const discard = (f: Finding) => void act(`drop:${f.key}`, (s) => { s.items[f.key] = { ...s.items[f.key], status: "discarded", at: Date.now(), by: who }; }, () => (f.status === "kept" || f.source === "person" ? lesson(f, false) : undefined));
  const restore = (f: Finding) => void act(`drop:${f.key}`, (s) => { const it = { ...s.items[f.key] }; delete it.status; s.items[f.key] = it; }, () => (f.source === "person" ? lesson(f, true) : undefined));
  const takeDraft = (f: Finding) => void act(`draft:${f.key}`, (s) => { const it = { ...s.items[f.key] }; const e = { ...(it.edits ?? {}) }; delete e.title; delete e.observation; delete e.rating; it.edits = e; it.basis = basisOf(f); s.items[f.key] = it; },
    (next) => { const g = refind(next, f.key); return g && f.status === "kept" ? lesson(g, true) : undefined; });
  const saveEdit = (f: Finding, e: FindingEdit, category?: CategoryId) => void act(`edit:${f.key}`, (s) => {
    if (f.source === "person") { const a = s.added.find((x) => `added:${x.id}` === f.key); if (a) Object.assign(a, e, category ? { category } : {}); return; }
    // Only what differs from the draft is kept as a change.
    const out: FindingEdit = { ...(s.items[f.key]?.edits ?? {}) };
    for (const k of ["title", "observation"] as const) { const v = (e[k] ?? "").trim(); if (v && v !== f.drafted[k]) out[k] = v; else delete out[k]; }
    for (const k of ["practice", "gap", "next", "year", "owner"] as const) { const v = (e[k] ?? "").trim(); if (v !== f[k]) { if (v) out[k] = v; else delete out[k]; } }
    if (e.rating && e.rating !== f.drafted.rating) out.rating = e.rating; else delete out.rating;
    s.items[f.key] = { ...s.items[f.key], edits: out, basis: basisOf(f), at: Date.now(), by: who };
  }, (next) => { setEditing(null); const g = refind(next, f.key); return g && (f.status === "kept" || f.source === "person") ? lesson(g, true) : undefined; });
  const addInfo = (f: Finding) => { const t = infoText.trim(); if (!t) return; void act(`info:${f.key}`, (s) => { const it = { ...s.items[f.key] }; it.info = [...(it.info ?? []), t]; s.items[f.key] = it; }, (next) => { setInfoFor(null); setInfoText(""); const g = refind(next, f.key); return g && (f.status === "kept" || f.source === "person") ? lesson(g, true) : undefined; }); };
  const dropInfo = (f: Finding, i: number) => void act(`info:${f.key}`, (s) => { const it = { ...s.items[f.key] }; it.info = (it.info ?? []).filter((_, n) => n !== i); s.items[f.key] = it; });
  const addFinding = (e: FindingEdit, category: CategoryId) => {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
    void act("add", (s) => { s.added.push({ ...e, id, category, at: Date.now(), by: who }); }, async () => {
      setAdding(false);
      const c = categoryOf(category);
      await lesson({ key: `added:${id}`, category, source: "person", rating: e.rating ?? "opportunity", title: e.title ?? "Finding", observation: e.observation ?? "", evidence: [], practice: "", gap: e.gap ?? "", next: e.next ?? "", year: e.year ?? "", owner: e.owner ?? "", info: [], status: "kept", edited: false, stale: false, drafted: { title: e.title ?? c.name, observation: e.observation ?? "", rating: e.rating ?? "opportunity" }, by: who, at: Date.now() }, true);
    });
  };
  const filled = Object.entries(answers).filter(([, a]) => a.cause || a.note?.trim());
  const saveAnswers = () => void act("answers", (s) => { for (const [k, a] of filled) s.answers[k] = { ...(a.cause ? { cause: a.cause } : {}), ...(a.note?.trim() ? { note: a.note.trim() } : {}), at: Date.now(), by: who }; }, () => { setAnswers({}); onReload(); setTick((t) => t + 1); });
  const reanalyze = () => { setMsg(null); setErr(null); onReload(); setTick((t) => t + 1); };

  const fileOpts = (): ReviewFileOpts => ({ project: projectName, phase: phase?.name ?? null, tz, preparedBy: null, date: fmtInTz(Date.now(), tz, { month: "long", day: "numeric", year: "numeric" }) });
  const download = async (kind: "word" | "slides") => {
    if (!review) return;
    setBusy(kind); setErr(null);
    try {
      const o = fileOpts();
      if (kind === "word") saveFile(await reviewDocx(review, o), `${fileStem(o)}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      else saveFile(await reviewPptx(review, o), `${fileStem(o)} slides.pptx`, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    } catch (e) { setErr(`The file couldn't be made: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  if (!review) return <div className="py-16 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;
  const m = review.metrics;
  const liveF = review.findings.filter((f) => f.status !== "discarded");
  const count = (r: Rating) => liveF.filter((f) => f.rating === r).length;
  const shown = review.findings.filter((f) => filter === "discarded" ? f.status === "discarded" : f.status !== "discarded" && (filter === "all" || (filter === "kept" ? f.status === "kept" : f.rating === filter)));
  const day = (t: number | null) => (t == null ? "" : fmtInTz(t, tz, { month: "numeric", day: "numeric" }));
  const when = (t: number) => `${fmtInTz(t, tz, { weekday: "short", month: "numeric", day: "numeric" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  const Pill = ({ id, children }: { id: Filter; children: React.ReactNode }) => (
    <button type="button" onClick={() => setFilter(id)} aria-pressed={filter === id} className={`h-8 px-3 rounded-full border text-[12.5px] font-extrabold whitespace-nowrap ${filter === id ? "bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]" : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]"}`}>{children}</button>
  );

  return (
    <div className="space-y-4" data-post-event-review>
      {phases.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className={label}>Phase</span>
          {phases.map((p) => (
            <button key={p.id} type="button" onClick={() => { setPhaseId(p.id); setEditing(null); setAdding(false); setAnswers({}); }} aria-pressed={p.id === phaseId}
              className={`h-8 px-3 rounded-full border text-[12.5px] font-extrabold ${p.id === phaseId ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]"}`}>{p.name}</button>
          ))}
          <span className="text-[12px] text-[var(--color-text-muted)]">One phase at a time; each has its own review.</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-[19px] font-black text-[var(--color-text)]">Post-event review{phase ? ` · ${phase.name}` : ""}</h2>
          <p className="text-[13px] text-[var(--color-text-muted)]">Drafted from the schedule, the as-built record, holds and comments. Keep, change or discard each finding; answer the questions to fill in what the records don&rsquo;t say.{!m.done && m.steps ? ` ${m.steps - m.stepsDone} of ${m.steps} activities are not done yet, so these numbers are to date.` : ""}</p>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button type="button" onClick={reanalyze} disabled={!!busy} className={btn}><RefreshCw className="w-4 h-4" /> Re-analyze</button>
          <button type="button" onClick={() => void download("word")} disabled={!!busy || !m.steps} className={btn}>{busy === "word" ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Word report</button>
          <button type="button" onClick={() => void download("slides")} disabled={!!busy || !m.steps} className={dark}>{busy === "slides" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Presentation className="w-4 h-4" />} Meeting slides</button>
        </div>
      </div>

      {err && <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12.5px] font-semibold text-rose-800 dark:text-rose-300">{err}</div>}
      {msg && <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] font-semibold text-amber-900 dark:text-amber-200">{msg}</div>}

      {!m.steps ? <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">No schedule{phase ? ` for ${phase.name}` : ""} yet, so there is nothing to review.</div> : <>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <Kpi name="Schedule variance" value={m.varianceH == null ? "Open" : `${m.varianceH > 0 ? "+" : ""}${m.varianceH} h`} bad={(m.varianceH ?? 0) > 0.5} detail={m.baselineFinish != null ? `against the baseline finish, ${when(m.baselineFinish)}` : "no baseline finish"} />
          <Kpi name="Scope" value={`${m.baselineSteps} + ${m.addedSteps}`} detail={`planned activities + added from ${review.found.length} finding${review.found.length === 1 ? "" : "s"}`} />
          <Kpi name="Scope growth" value={m.addedPct == null ? "n/a" : `${m.addedPct}%`} detail={`${m.addedH} h added on a ${m.baselineH} h plan (schedule estimates)`} />
          <Kpi name="Stuck work" value={`${m.shiftsWithStuck} of ${m.shifts}`} bad={m.shiftsWithStuck > 0} detail={m.shiftsWithStuck ? `shifts had jobs sitting, ${m.leastAtOnce === m.mostAtOnce ? m.mostAtOnce : `${m.leastAtOnce} to ${m.mostAtOnce}`} at a time` : "shifts had a job sitting"} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
          <div className="order-2 lg:order-1 min-w-0 space-y-3">
            <div className="flex gap-1.5 flex-wrap items-center">
              <Pill id="all">All {liveF.length}</Pill>
              <Pill id="gap">Gaps {count("gap")}</Pill>
              <Pill id="opportunity">Opportunities {count("opportunity")}</Pill>
              <Pill id="strength">Strengths {count("strength")}</Pill>
              <Pill id="kept">Kept {liveF.filter((f) => f.status === "kept").length}</Pill>
              <Pill id="discarded">Discarded {review.findings.length - liveF.length}</Pill>
              {canManage && <button type="button" onClick={() => { setAdding(true); setEditing(null); }} className={`${btn} ml-auto`}><Plus className="w-4 h-4" /> Add a finding</button>}
            </div>
            <p className="text-[11.5px] text-[var(--color-text-muted)]">{RATING_MEANS}</p>

            {adding && <div className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-surface)] p-4"><FindingForm title="Add a finding" pickCategory busy={busy === "add"} onCancel={() => setAdding(false)} onSave={(e, c) => addFinding(e, c ?? "materials")} /></div>}

            {shown.length === 0 && <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">Nothing here.</div>}
            {shown.map((f) => {
              const c = categoryOf(f.category);
              const closes = f.rating === "gap" || f.rating === "opportunity";
              const asks = review.questions.filter((q) => q.findingKey === f.key).length;
              return (
                <article key={f.key} data-finding={f.key} className={`rounded-2xl border bg-[var(--color-surface)] p-4 ${f.status === "discarded" ? "opacity-70 border-[var(--color-border)]" : "border-[var(--color-border)]"}`}>
                  {editing === f.key ? (
                    <FindingForm title={`Change: ${c.name}`} init={f} pickCategory={f.source === "person"} busy={busy === `edit:${f.key}`} onCancel={() => setEditing(null)} onSave={(e, cat) => saveEdit(f, e, cat)} />
                  ) : <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={label}>{c.name} · {c.stage}</span>
                      <span className={`text-[10.5px] font-black px-1.5 py-0.5 rounded ${RATE_CLS[f.rating]}`}>{RATING_WORD[f.rating]}</span>
                      {f.source === "person" && <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">Added by {f.by ?? "a person"}</span>}
                      <span className={`ml-auto text-[11px] font-black px-2 py-0.5 rounded-full ${f.status === "kept" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
                        {f.status === "kept" ? `Kept${f.at ? ` ${day(f.at)}` : ""}${f.edited ? " · changed" : ""}` : f.status === "discarded" ? "Discarded" : `Draft${f.edited ? " · changed" : ""}${asks ? ` · ${asks} question${asks === 1 ? "" : "s"} open` : ""}`}
                      </span>
                    </div>
                    <h3 className="mt-1 text-[15.5px] font-black text-[var(--color-text)]">{f.title}</h3>
                    <dl className="mt-2 grid gap-x-3 gap-y-1.5 sm:grid-cols-[136px_minmax(0,1fr)] text-[13px] text-[var(--color-text)]">
                      <dt className={`${label} pt-0.5`}>Event observation</dt>
                      <dd>
                        {f.observation || <span className="text-[var(--color-text-muted)]">Nothing written.</span>}
                        {f.info.map((line, i) => (
                          <div key={i} className="mt-1 flex items-start gap-1.5 text-[12.5px]"><span className="font-bold text-[var(--color-text-muted)] whitespace-nowrap">Added:</span><span className="min-w-0 flex-1">{line}</span>{canManage && <button type="button" aria-label="Remove this line" onClick={() => dropInfo(f, i)} className="text-[var(--color-text-muted)] hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>}</div>
                        ))}
                        {f.evidence.length > 0 && (
                          <details className="mt-1.5">
                            <summary className="cursor-pointer text-[12px] font-bold text-[var(--color-accent)]">From the records ({f.evidence.length})</summary>
                            <ul className="mt-1 space-y-1 text-[12px] text-[var(--color-text-muted)] list-disc pl-4">{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
                          </details>
                        )}
                      </dd>
                      {closes && <>
                        <dt className={`${label} pt-0.5`}>Leading practice</dt><dd>{f.practice}</dd>
                        <dt className={`${label} pt-0.5`}>Gap</dt><dd>{f.gap || <span className="text-[var(--color-text-muted)]">Not written.</span>}</dd>
                        <dt className={`${label} pt-0.5`}>Next event</dt><dd>{f.next || <span className="text-[var(--color-text-muted)]">Not written.</span>}{f.owner && <span className="ml-1.5 text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)] whitespace-nowrap">Owner: {f.owner}</span>}</dd>
                        <dt className={`${label} pt-0.5`}>12 months</dt><dd>{f.year || <span className="text-[var(--color-text-muted)]">Not written.</span>}</dd>
                      </>}
                    </dl>
                    {f.stale && (
                      <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200">
                        <b>The records have changed since this was {f.edited ? "changed" : "kept"}.</b> They now say: &ldquo;{f.drafted.observation}&rdquo;
                        {canManage && <div className="mt-1.5 flex gap-1.5 flex-wrap"><button type="button" disabled={!!busy} onClick={() => takeDraft(f)} className={btn}>Use the new draft</button><button type="button" disabled={!!busy} onClick={() => keep(f)} className={btn}>Keep mine as it is</button></div>}
                      </div>
                    )}
                    {infoFor === f.key && (
                      <div className="mt-2 flex gap-1.5 flex-wrap">
                        <textarea autoFocus rows={2} value={infoText} onChange={(e) => setInfoText(e.target.value)} placeholder="What the records don't say (one or two lines)" className={`${field} flex-1 basis-60`} />
                        <button type="button" disabled={!infoText.trim() || !!busy} onClick={() => addInfo(f)} className={pri}>Add</button>
                        <button type="button" onClick={() => { setInfoFor(null); setInfoText(""); }} className={btn}>Cancel</button>
                      </div>
                    )}
                    {f.key === "materials" && f.status !== "discarded" && <button type="button" onClick={() => onTab("materials")} className="mt-2 text-[12.5px] font-bold text-[var(--color-accent)] hover:underline">Open the materials register</button>}
                    {canManage && infoFor !== f.key && (
                      <div className="mt-3 flex gap-1.5 flex-wrap">
                        {f.status === "discarded" ? <button type="button" disabled={!!busy} onClick={() => restore(f)} className={btn}><RotateCcw className="w-4 h-4" /> Restore</button> : <>
                          {f.status === "kept" ? <button type="button" disabled={!!busy} onClick={() => unkeep(f)} className={btn}><Check className="w-4 h-4 text-emerald-600" /> Kept · undo</button>
                            : <button type="button" disabled={!!busy} onClick={() => keep(f)} className={dark}>{busy === `keep:${f.key}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Keep</button>}
                          <button type="button" disabled={!!busy} onClick={() => { setEditing(f.key); setAdding(false); }} className={btn}><Pencil className="w-4 h-4" /> Edit</button>
                          <button type="button" disabled={!!busy} onClick={() => { setInfoFor(f.key); setInfoText(""); }} className={btn}><Plus className="w-4 h-4" /> Add information</button>
                          <button type="button" disabled={!!busy} onClick={() => discard(f)} className={btn}><Trash2 className="w-4 h-4" /> Discard</button>
                        </>}
                      </div>
                    )}
                  </>}
                </article>
              );
            })}
          </div>

          <aside className="order-1 lg:order-2 space-y-3">
            {review.questions.length > 0 ? (
              <div className="rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3.5" data-review-questions>
                <h3 className="text-[14px] font-black text-amber-900 dark:text-amber-200">Fill in what the records don&rsquo;t say ({review.questions.length})</h3>
                <div className="mt-2 space-y-2">
                  {review.questions.map((q) => {
                    const a = answers[q.key] ?? {};
                    const set = (patch: Answer) => setAnswers((s) => ({ ...s, [q.key]: { ...s[q.key], ...patch } }));
                    return (
                      <div key={q.key} className="rounded-xl border border-amber-200 dark:border-amber-800 bg-[var(--color-surface)] p-2.5 text-[12.5px]">
                        <b className="block text-[var(--color-text)]">{q.ask}</b>
                        {canManage && <div className="mt-1.5 space-y-1.5">
                          {q.answer === "cause" && (
                            <select aria-label="Reason" value={a.cause ?? ""} onChange={(e) => set({ cause: (e.target.value || undefined) as CauseId | undefined })} className={field}>
                              <option value="">Pick a reason</option>
                              {CAUSE_CHOICES.map((c) => <option key={c} value={c}>{CAUSE_WORD[c]}</option>)}
                            </select>
                          )}
                          <input aria-label="Answer" value={a.note ?? ""} onChange={(e) => set({ note: e.target.value })} placeholder={q.answer === "cause" ? "More, if it helps (optional)" : "One line is enough"} className={field} />
                        </div>}
                      </div>
                    );
                  })}
                </div>
                {canManage && <button type="button" disabled={!filled.length || !!busy} onClick={saveAnswers} className={`${pri} w-full mt-2.5`}>{busy === "answers" ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save {filled.length || ""} answer{filled.length === 1 ? "" : "s"} and re-analyze</button>}
              </div>
            ) : (
              <div className="rounded-2xl border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 p-3.5 text-[12.5px] text-emerald-900 dark:text-emerald-200"><b>No open questions.</b> Every stuck shift has a reason{review.answeredCount ? ` (${review.answeredCount} answered here)` : ""}.</div>
            )}
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 text-[12.5px] text-[var(--color-text-muted)]">
              <b className="block text-[13px] text-[var(--color-text)]">How a finding is drafted</b>
              Every number is counted from what was entered; nothing is assumed. Each finding lists the records behind it. Re-analyze reads the records again with your answers. What you kept or changed is never overwritten, and kept findings go to the lessons register for the next job.
              <div className="mt-2 flex gap-1.5 flex-wrap"><button type="button" onClick={() => onTab("reports:asbuilt")} className={btn}><FileText className="w-4 h-4" /> As-built schedule</button></div>
            </div>
          </aside>
        </div>

        <details className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]" open>
          <summary className="cursor-pointer px-4 py-3 text-[14px] font-black text-[var(--color-text)]">The records behind it: every stuck job, by name</summary>
          <div className="px-4 pb-4 space-y-4">
            <Table title={`Started jobs that sat still: ${m.stuckJobs} job${m.stuckJobs === 1 ? "" : "s"}, ${m.stuckShifts} shift${m.stuckShifts === 1 ? "" : "s"} in all`} head={["Job", "Crew", "Shifts", "When", "Why, from the record"]} empty="No started job sat a full shift."
              rows={review.stuck.map((j) => [jobWord(j), j.crew, String(j.shifts.length), shiftsWord(j.shifts.map((s) => s.key)), [...new Set(j.shifts.map((s) => `${CAUSE_WORD[s.cause]}${s.said ? `: "${s.said}"` : s.crewOn.length ? ` (crew on ${[...new Set(s.crewOn.map(orderWord))].slice(0, 3).join(", ")})` : ""}`))].join(" Then: ")])} />
            <Table title={`Ready jobs not started: ${m.readyJobs} job${m.readyJobs === 1 ? "" : "s"}, ${m.readyShifts} shift${m.readyShifts === 1 ? "" : "s"} in all`} head={["Ready job", "Crew", "Shifts", "When", "Crew was on"]} empty="No ready job waited a full shift to start."
              rows={review.ready.map((j) => [jobWord(j), j.crew, String(j.shifts.length), shiftsWord(j.shifts), j.said ?? (j.busyOn.length ? [...new Set(j.busyOn.map(orderWord))].join(", ") : j.crewLogged ? "" : "No work logged by this crew")])} />
            <Table title={`By shift: ${m.shiftsWithStuck} of ${m.shifts} shifts had a job sitting`} head={["Shift", "Started, sitting still", "Ready, not started", "Together"]} empty="None."
              rows={review.byShift.map((c) => [shiftWord(c.key), String(c.stuck), String(c.ready), String(c.stuck + c.ready)])} />
            <Table title={`Found work: ${review.found.length} finding${review.found.length === 1 ? "" : "s"}, ${m.addedSteps} activit${m.addedSteps === 1 ? "y" : "ies"} added`} head={["Finding", "Activities", "Work when approved", "Critical path", "Approved by"]} empty="No work was added during the event."
              rows={review.found.map((f) => [`${f.what} (${orderWord(f.on)})`, String(f.steps), `${f.hours} h`, f.critical ? "Yes" : "No", f.approvedBy ?? "Not recorded"])} />
            <p className="text-[11.5px] text-[var(--color-text-muted)]">A job is stuck in a shift when it had started and nothing was logged on it for that whole shift, or was ready and did not start. A job that sits several shifts is counted in each. Night shifts count only for work that ran on nights. Head counts were recorded for {m.headCounts.counted} of the {m.headCounts.of} crew-shifts that moved work{m.labor ? `; they put ${m.labor.pct}% of labor hours on added work` : ", so labor hours are not estimated"}.</p>
          </div>
        </details>
      </>}
    </div>
  );
}

function Kpi({ name, value, detail, bad }: { name: string; value: string; detail: string; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <div className={label}>{name}</div>
      <div className={`text-[22px] font-black leading-tight ${bad ? "text-rose-700 dark:text-rose-400" : "text-[var(--color-text)]"}`}>{value}</div>
      <div className="text-[12px] text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

/** A table that reads as stacked rows on a phone. */
function Table({ title, head, rows, empty }: { title: string; head: string[]; rows: string[][]; empty: string }) {
  return (
    <div>
      <h4 className="text-[13px] font-black text-[var(--color-text)] mb-1.5">{title}</h4>
      {rows.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">{empty}</div> : <>
        <div className="hidden sm:block rounded-xl border border-[var(--color-border)] overflow-x-auto">
          <table className="w-full text-[12.5px] border-collapse">
            <thead><tr>{head.map((h) => <th key={h} className="text-left px-2.5 py-2 bg-[var(--color-surface-2)] text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)]">{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i} className="border-b last:border-b-0 border-[var(--color-border)] align-top">{r.map((c, n) => <td key={n} className={`px-2.5 py-2 text-[var(--color-text)] ${n === 0 ? "font-bold" : ""}`}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <ul className="sm:hidden space-y-2">
          {rows.map((r, i) => (
            <li key={i} className="rounded-xl border border-[var(--color-border)] px-3 py-2 text-[12.5px]">
              <b className="block text-[var(--color-text)]">{r[0]}</b>
              {r.slice(1).map((c, n) => c && <div key={n} className="text-[var(--color-text)]"><span className="text-[var(--color-text-muted)]">{head[n + 1]}: </span>{c}</div>)}
            </li>
          ))}
        </ul>
      </>}
    </div>
  );
}

function FindingForm({ title, init, pickCategory, busy, onSave, onCancel }: {
  title: string; init?: Finding; pickCategory?: boolean; busy: boolean;
  onSave: (e: FindingEdit, category?: CategoryId) => void; onCancel: () => void;
}) {
  const [category, setCategory] = useState<CategoryId>(init?.category ?? "materials");
  const [e, setE] = useState<FindingEdit>({ title: init?.title ?? "", observation: init?.observation ?? "", practice: init?.practice ?? "", gap: init?.gap ?? "", next: init?.next ?? "", year: init?.year ?? "", owner: init?.owner ?? "", rating: init?.rating ?? "opportunity" });
  const set = (k: keyof FindingEdit, v: string) => setE((x) => ({ ...x, [k]: v }));
  const Area = ({ k, name, hint, rows = 2 }: { k: "observation" | "practice" | "gap" | "next" | "year"; name: string; hint: string; rows?: number }) => (
    <label className="block"><span className={label}>{name}</span><textarea rows={rows} value={e[k] ?? ""} onChange={(ev) => set(k, ev.target.value)} placeholder={hint} className={`${field} mt-0.5`} /></label>
  );
  const ok = !!(e.title ?? "").trim() && !!(e.observation ?? "").trim();
  return (
    <div className="space-y-2.5">
      <b className="block text-[14px] text-[var(--color-text)]">{title}</b>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {pickCategory && <label className="block"><span className={label}>Category</span><select value={category} onChange={(ev) => setCategory(ev.target.value as CategoryId)} className={`${field} mt-0.5`}>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.stage})</option>)}</select></label>}
        <label className="block"><span className={label}>Rating</span><select value={e.rating} onChange={(ev) => setE((x) => ({ ...x, rating: ev.target.value as Rating }))} className={`${field} mt-0.5`}>{(["gap", "opportunity", "strength"] as Rating[]).map((r) => <option key={r} value={r}>{RATING_WORD[r]}</option>)}</select></label>
      </div>
      <label className="block"><span className={label}>Finding, in one line</span><input value={e.title ?? ""} onChange={(ev) => set("title", ev.target.value)} placeholder="Flange not ordered: the length was not on the drawing" className={`${field} mt-0.5`} /></label>
      {Area({ k: "observation", name: "Event observation", hint: "What happened, with the facts: which job, when, what it cost", rows: 3 })}
      {init && init.source === "records" && Area({ k: "practice", name: "Leading practice", hint: "How it is done well" })}
      {Area({ k: "gap", name: "Gap", hint: "What was missing or didn't work" })}
      {Area({ k: "next", name: "Closure, next event", hint: "What will be in place before the next event" })}
      {Area({ k: "year", name: "Closure, within 12 months", hint: "What takes longer than one event" })}
      <label className="block"><span className={label}>Owner (a role)</span><input value={e.owner ?? ""} onChange={(ev) => set("owner", ev.target.value)} placeholder="Logistics coordinator" className={`${field} mt-0.5`} /></label>
      <div className="flex gap-1.5 flex-wrap">
        <button type="button" disabled={!ok || busy} onClick={() => onSave(e, pickCategory ? category : undefined)} className={pri}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save</button>
        <button type="button" onClick={onCancel} className={btn}>Cancel</button>
        {!ok && <span className="text-[12px] text-[var(--color-text-muted)] self-center">Needs the finding and what happened.</span>}
      </div>
    </div>
  );
}
