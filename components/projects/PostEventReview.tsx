"use client";

// PostEventReview - the look back at a finished event (or one phase of it),
// drafted from its records (lib/postEventReview). The conclusions come
// first: what the event showed, most costly first, each with what justifies
// a change and the change. Under them, each finding with how it is done
// well, what happened and what to do differently, the questions the records
// can't answer, and the records themselves for when someone asks.
//
// A person keeps, changes, adds to or throws out each finding, adds their
// own, and answers the questions; Re-analyze reads the records again with
// those answers. What was kept or changed is never overwritten. Kept
// findings go to the lessons register. The same review downloads as a Word
// report and as the meeting slides, and the slides open on screen (View
// slides) on a computer or a phone.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Download, FileText, Loader2, Pencil, Plus, Presentation, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
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
import { loadOrg, orgStanding } from "@/lib/eventOrganization";
import {
  CATEGORIES, CAUSE_CHOICES, CAUSE_WORD, KNOWN_WORD, RATING_MEANS, RATING_WORD, basisOf, buildReview, categoryOf, emptySaved, jobWord, orderWord, pointOf, shiftWord, shiftsWord,
  type Answer, type CategoryId, type CauseId, type Finding, type Known, type FindingEdit, type OrgStanding, type Rating, type ReviewSaved,
} from "@/lib/postEventReview";
import { changeReview, loadReview, reviewScope, syncLesson } from "@/lib/reviewStore";
import { CREWS_HEAD, CREWS_NOTE, CREWS_TITLE, crewsRows, deckSlides, fileStem, reviewDocx, reviewPptx, saveFile, type ReviewFileOpts } from "@/lib/reviewFiles";
import { overloaded } from "@/lib/crewFlow";
import ReviewSlides from "@/components/projects/ReviewSlides";

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
  const [organization, setOrganization] = useState<OrgStanding | null>(null);
  const [targets, setTargets] = useState<Record<string, string> | null>(null);
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
  const [viewing, setViewing] = useState(false);
  // A file that is made, where the browser wants a tap to hand it over.
  const [held, setHeld] = useState<{ data: Uint8Array | Blob; name: string; mime: string } | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(null);
    void (async () => {
      try {
        const [s, np, mats, org] = await Promise.all([
          loadReview(projectId, scope),
          loadNextPlanSettings(projectId).catch(() => null),
          listMaterials(projectId).catch(() => ({ rows: [], missing: true })),
          loadOrg(projectId).catch(() => null),
        ]);
        if (!live) return;
        setSaved(s); setPlans(np?.staffing ?? null); setOrganization(orgStanding(org)); setTargets(null);
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
    const dependsOn = new Map(mine.filter((x) => x.id).map((x) => [x.id!, x.dependsOn ?? []]));
    return buildReview({ built, work, notes: myNotes, look, discoveries: ds, tz, saved, materials: register, organization, dependsOn });
  }, [saved, milestones, phases, phaseId, notes, log, records, plans, mp, tz, times, register, organization]);

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
    if (f.source === "person") { const a = next.added.find((x) => `added:${x.id}` === key); return a ? { ...f, title: a.title ?? f.title, observation: a.observation ?? "", gap: a.gap ?? "", next: a.next ?? "", year: a.year ?? "", owner: a.owner ?? "", effect: a.effect ?? "", why: a.why ?? a.effect ?? f.why, rating: a.rating ?? f.rating, info: it?.info ?? [] } : f; }
    return { ...f, title: e.title ?? f.drafted.title, observation: e.observation ?? f.drafted.observation, rating: e.rating ?? f.drafted.rating, practice: e.practice ?? f.practice, gap: e.gap ?? f.gap, next: e.next ?? f.next, year: e.year ?? f.year, owner: e.owner ?? f.owner, effect: e.effect ?? f.effect, why: e.why ?? f.why, info: it?.info ?? [] };
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
    for (const k of ["practice", "gap", "next", "year", "owner", "effect", "why", "ask", "because"] as const) { const v = (e[k] ?? "").trim(); if (v !== f[k]) { if (v) out[k] = v; else delete out[k]; } }
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
      await lesson({ key: `added:${id}`, category, source: "person", rating: e.rating ?? "opportunity", title: e.title ?? "Finding", observation: e.observation ?? "", evidence: [], practice: "", gap: e.gap ?? "", next: e.next ?? "", year: e.year ?? "", owner: e.owner ?? "", effect: e.effect ?? "", moved: null, proof: "", why: e.effect ?? "", hours: null, ask: e.ask ?? e.next ?? "", because: e.because ?? e.effect ?? "", info: [], status: "kept", edited: false, stale: false, drafted: { title: e.title ?? c.name, observation: e.observation ?? "", rating: e.rating ?? "opportunity" }, by: who, at: Date.now() }, true);
    });
  };
  const filled = Object.entries(answers).filter(([, a]) => a.cause || a.known || a.note?.trim());
  const saveAnswers = () => void act("answers", (s) => { for (const [k, a] of filled) s.answers[k] = { ...(a.cause ? { cause: a.cause } : {}), ...(a.known ? { known: a.known } : {}), ...(a.note?.trim() ? { note: a.note.trim() } : {}), at: Date.now(), by: who }; }, () => { setAnswers({}); onReload(); setTick((t) => t + 1); });
  const saveTargets = () => { const t = targets; if (!t) return; void act("targets", (s) => { s.targets = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)); }, () => setTargets(null)); };
  const reanalyze = () => { setMsg(null); setErr(null); onReload(); setTick((t) => t + 1); };

  const fileOpts = (): ReviewFileOpts => ({ project: projectName, phase: phase?.name ?? null, tz, preparedBy: null, date: fmtInTz(Date.now(), tz, { month: "long", day: "numeric", year: "numeric" }) });
  const download = async (kind: "word" | "slides") => {
    if (!review) return;
    setBusy(kind); setErr(null); setHeld(null);
    try {
      const o = fileOpts();
      const made = kind === "word"
        ? { data: await reviewDocx(review, o), name: `${fileStem(o)}.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
        : { data: await reviewPptx(review, o), name: `${fileStem(o)} slides.pptx`, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
      if (!(await saveFile(made.data, made.name, made.mime))) setHeld(made);
    } catch (e) { setErr(`The file couldn't be made: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  const saveHeld = async () => { if (held && (await saveFile(held.data, held.name, held.mime))) setHeld(null); };

  if (!review) return <div className="py-16 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;
  const m = review.metrics;
  const pt = pointOf(review, phase?.name ?? projectName, tz);
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
          <button type="button" onClick={() => setViewing(true)} disabled={!m.steps} className={dark}><Presentation className="w-4 h-4" /> View slides</button>
          <button type="button" onClick={() => void download("slides")} disabled={!!busy || !m.steps} className={btn}>{busy === "slides" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} PowerPoint</button>
          <button type="button" onClick={() => void download("word")} disabled={!!busy || !m.steps} className={btn}>{busy === "word" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Word report</button>
        </div>
      </div>

      {err && <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12.5px] font-semibold text-rose-800 dark:text-rose-300">{err}</div>}
      {msg && <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] font-semibold text-amber-900 dark:text-amber-200">{msg}</div>}
      {held && !viewing && <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 flex items-center gap-2 flex-wrap text-[12.5px] font-semibold text-amber-900 dark:text-amber-200" data-file-ready><span className="min-w-0 flex-1 basis-40">The file is ready.</span><button type="button" onClick={() => void saveHeld()} className={pri}><Download className="w-4 h-4" /> Save file</button></div>}
      {viewing && <ReviewSlides slides={deckSlides(review, fileOpts())} name={`${phase?.name ?? projectName} post-event review`} onClose={() => setViewing(false)} onDownload={() => void download("slides")} downloading={busy === "slides"} ready={held ? { name: held.name, onSave: () => void saveHeld() } : null} />}

      {!m.steps ? <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">No schedule{phase ? ` for ${phase.name}` : ""} yet, so there is nothing to review.</div> : <>
        <section className="rounded-2xl border-2 border-[var(--color-text)] bg-[var(--color-surface)] p-4" data-review-point>
          <h3 className="text-[18px] sm:text-[20px] font-black leading-snug text-[var(--color-text)]">{pt.conclusions.length ? `On the slide: ${pt.conclusions.length} change${pt.conclusions.length === 1 ? "" : "s"} for the next event` : "Nothing is on the slide yet"}</h3>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">{pt.headline} {pt.span} Only what you accept or write goes on the slide.</p>
          {pt.conclusions.length > 0 && (
            <ol className="mt-3 space-y-2.5">
              {pt.conclusions.map((c, i) => (
                <li key={c.key} className="flex gap-3 text-[var(--color-text)]" data-conclusion={c.key}>
                  <span className="shrink-0 w-7 h-7 rounded-full bg-[var(--color-text)] text-[var(--color-surface)] text-[13px] font-black flex items-center justify-center">{i + 1}</span>
                  <div className="min-w-0"><b className="block text-[15px] leading-snug">{c.ask}</b><p className="text-[13px] text-[var(--color-text-muted)]">{c.because}</p></div>
                </li>
              ))}
            </ol>
          )}
          {pt.pending.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3" data-review-pending>
              <b className="block text-[13.5px] text-amber-900 dark:text-amber-200">Needs your call ({pt.pending.length}): not on the slide</b>
              <ul className="mt-2 space-y-2.5">
                {pt.pending.map((c) => {
                  const f = review.findings.find((x) => x.key === c.key)!;
                  return (
                    <li key={c.key} className="text-[13px] text-[var(--color-text)]" data-pending={c.key}>
                      <b className="block">{c.title}</b>
                      <span className="block text-[var(--color-text-muted)]">{c.because}</span>
                      {c.ask ? <span className="block"><span className={label}>Suggested change </span>{c.ask}</span> : <span className="block text-[var(--color-text-muted)]">No change suggested. Write one with Edit, or set it aside.</span>}
                      {canManage && <span className="mt-1 flex gap-1.5 flex-wrap">
                        {c.ask && <button type="button" disabled={!!busy} onClick={() => keep(f)} className={dark}><Check className="w-4 h-4" /> Accept</button>}
                        <button type="button" disabled={!!busy} onClick={() => { setEditing(f.key); setAdding(false); document.querySelector(`[data-finding="${f.key}"]`)?.scrollIntoView({ block: "center" }); }} className={btn}><Pencil className="w-4 h-4" /> {c.ask ? "Reword" : "Write the change"}</button>
                        <button type="button" disabled={!!busy} onClick={() => discard(f)} className={btn}><Trash2 className="w-4 h-4" /> Not this</button>
                      </span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <Kpi name="Schedule variance" value={m.varianceH == null ? "Open" : `${m.varianceH > 0 ? "+" : ""}${m.varianceH} h`} bad={(m.varianceH ?? 0) > 0.5} detail={m.baselineFinish != null ? `against the baseline finish, ${when(m.baselineFinish)}` : "no baseline finish"} />
          <Kpi name="Scope" value={`${m.baselineSteps} + ${m.addedSteps}`} detail={`planned activities + added from ${review.found.length} finding${review.found.length === 1 ? "" : "s"}`} />
          <Kpi name="Scope growth" value={m.addedPct == null ? "n/a" : `${m.addedPct}%`} detail={`${m.addedH} h added on a ${m.baselineH} h plan (schedule estimates)`} />
          <Kpi name="Stuck work" value={`${m.shiftsWithStuck} of ${m.shifts}`} bad={m.shiftsWithStuck > 0} detail={m.shiftsWithStuck ? `shifts had jobs sitting, ${m.leastAtOnce === m.mostAtOnce ? m.mostAtOnce : `${m.leastAtOnce} to ${m.mostAtOnce}`} at a time; equipment out for service not counted` : "shifts had a job sitting"} />
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
                      <span className={label}>{c.name}</span>
                      <span className={`text-[10.5px] font-black px-1.5 py-0.5 rounded ${RATE_CLS[f.rating]}`}>{f.rating === "none" && f.moved === 0 ? "No effect on the finish" : RATING_WORD[f.rating]}</span>
                      {f.source === "person" && <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">Added by {f.by ?? "a person"}</span>}
                      <span className={`ml-auto text-[11px] font-black px-2 py-0.5 rounded-full ${f.status === "kept" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
                        {f.status === "kept" ? `Kept${f.at ? ` ${day(f.at)}` : ""}${f.edited ? " · changed" : ""}` : f.status === "discarded" ? "Discarded" : `Draft${f.edited ? " · changed" : ""}${asks ? ` · ${asks} question${asks === 1 ? "" : "s"} open` : ""}`}
                      </span>
                    </div>
                    <h3 className="mt-1 text-[15.5px] font-black text-[var(--color-text)]">{f.title}</h3>
                    {f.effect && <p className={`mt-0.5 text-[13px] font-bold ${f.moved === 3 ? "text-rose-700 dark:text-rose-400" : "text-[var(--color-text)]"}`} data-finding-effect>{f.effect}</p>}
                    {closes && f.why && f.why !== f.effect && <p className="mt-0.5 text-[13px] text-[var(--color-text)]">{f.why}</p>}
                    <dl className="mt-2 grid gap-x-3 gap-y-1.5 sm:grid-cols-[136px_minmax(0,1fr)] text-[13px] text-[var(--color-text)]">
                      <dt className={`${label} pt-0.5`}>What happened</dt>
                      <dd>
                        {f.observation.trim() ? (() => { const ls = f.observation.split("\n").map((l) => l.trim()).filter(Boolean); return ls.length > 1 ? <ul className="list-disc pl-4 space-y-0.5">{ls.map((l, i) => <li key={i}>{l}</li>)}</ul> : <>{ls[0]}</>; })() : <span className="text-[var(--color-text-muted)]">Nothing written.</span>}
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
                        {f.practice && <><dt className={`${label} pt-0.5`}>Done well</dt><dd className="text-[var(--color-text-muted)]">{f.practice}</dd></>}
                        {f.gap && <><dt className={`${label} pt-0.5`}>What was missing</dt><dd>{f.gap}</dd></>}
                        <dt className={`${label} pt-0.5`}>{f.status === "kept" || f.source === "person" ? "Do differently" : "Suggested change"}</dt><dd>{f.next || <span className="text-[var(--color-text-muted)]">None suggested. Write one with Edit.</span>}{f.owner && <span className="ml-1.5 text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)] whitespace-nowrap">Owner: {f.owner}</span>}</dd>
                        {f.year && <><dt className={`${label} pt-0.5`}>Longer term</dt><dd>{f.year}</dd></>}
                      </>}
                      {!closes && f.next && <><dt className={`${label} pt-0.5`}>Do differently</dt><dd>{f.next}</dd></>}
                    </dl>
                    {f.stale && (
                      <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200">
                        <b>The records have changed since this was {f.edited ? "changed" : "kept"}.</b> They now say:<ul className="list-disc pl-4 mt-1">{f.drafted.observation.split("\n").filter(Boolean).map((l, i) => <li key={i}>{l}</li>)}</ul>
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
                    {f.key === "organization" && f.status !== "discarded" && <button type="button" onClick={() => onTab("members")} className="mt-2 text-[12.5px] font-bold text-[var(--color-accent)] hover:underline">{organization?.recorded ? "Open the event organization (Members)" : "Record the roles and who fills each (Members)"}</button>}
                    {canManage && infoFor !== f.key && (
                      <div className="mt-3 flex gap-1.5 flex-wrap">
                        {f.status === "discarded" ? <button type="button" disabled={!!busy} onClick={() => restore(f)} className={btn}><RotateCcw className="w-4 h-4" /> Restore</button> : <>
                          {f.status === "kept" ? <button type="button" disabled={!!busy} onClick={() => unkeep(f)} className={btn}><Check className="w-4 h-4 text-emerald-600" /> {closes ? "On the slide · undo" : "Kept · undo"}</button>
                            : <button type="button" disabled={!!busy} onClick={() => keep(f)} className={dark}>{busy === `keep:${f.key}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {closes ? "Accept for the slide" : "Keep"}</button>}
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
                          {q.answer === "known" && (
                            <div className="flex gap-1.5 flex-wrap">
                              {(Object.keys(KNOWN_WORD) as Known[]).map((k) => <button key={k} type="button" aria-pressed={a.known === k} onClick={() => set({ known: a.known === k ? undefined : k })} className={`h-8 px-2.5 rounded-full border text-[12px] font-bold ${a.known === k ? "bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]" : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)]"}`}>{KNOWN_WORD[k]}</button>)}
                            </div>
                          )}
                          <input aria-label="Answer" value={a.note ?? ""} onChange={(e) => set({ note: e.target.value })} placeholder={q.answer === "known" ? "What we do next time (this is the slide line)" : q.answer === "cause" ? "More, if it helps (optional)" : "One line is enough"} className={field} />
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

        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-review-measures>
          <h3 className="text-[14px] font-black text-[var(--color-text)]">Targets for the next event</h3>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">Set the tolerance for each measure here. Tap a suggestion or type your own, then Save. Nothing is judged against a target until you set it.</p>
          <div className="mt-2 space-y-2">
            {review.measures.map((x) => {
              const cur = (targets ?? saved?.targets ?? {})[x.key] ?? "";
              const put = (v: string) => setTargets({ ...(targets ?? saved?.targets ?? {}), [x.key]: v });
              return (
                <div key={x.key} className="rounded-xl border border-[var(--color-border)] px-3 py-2.5 text-[13px]">
                  <div className="flex items-baseline gap-x-3 flex-wrap"><b className="text-[var(--color-text)]">{x.measure}</b><span className="ml-auto text-[var(--color-text)]">This event: <b>{x.result}</b></span></div>
                  <div className="text-[12px] text-[var(--color-text-muted)]">{x.hint}</div>
                  {canManage ? (
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <span className={label}>Target</span>
                      {x.picks.map((pk) => <button key={pk} type="button" onClick={() => put(pk)} aria-pressed={cur === pk} className={`h-8 px-2.5 rounded-full border text-[12px] font-bold ${cur === pk ? "bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]" : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)]"}`}>{pk}</button>)}
                      <input aria-label={`Target: ${x.measure}`} value={cur} onChange={(e) => put(e.target.value)} placeholder="or type your own" className={`${field} !w-44 h-8 !py-0`} />
                    </div>
                  ) : <div className="mt-1 text-[12.5px]">{x.set ? <>Target: <b>{x.target}</b></> : <span className="text-[var(--color-text-muted)]">Target: not set</span>}</div>}
                </div>
              );
            })}
          </div>
          {canManage && targets && <div className="mt-2.5 flex gap-1.5"><button type="button" disabled={!!busy} onClick={saveTargets} className={pri}>{busy === "targets" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save targets</button><button type="button" onClick={() => setTargets(null)} className={btn}>Cancel</button></div>}
        </section>

        <details className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <summary className="cursor-pointer px-4 py-3 text-[14px] font-black text-[var(--color-text)]">The records behind it: every job that waited, by name</summary>
          <div className="px-4 pb-4 space-y-4">
            {review.flows.filter(overloaded).map((f) => (
              <div key={f.crew} data-crew-waits={f.crew}>
                <h4 className="text-[13px] font-black text-[var(--color-text)]">What waited for {f.crew}: {f.jobs.length} job{f.jobs.length === 1 ? "" : "s"}, {f.peak.open} open at once{f.plannedPeak ? ` (plan ${f.plannedPeak})` : ""}</h4>
                <p className="mb-1.5 text-[12px] text-[var(--color-text-muted)]">Each wait runs from when the job was ready to when {f.crew} started it. Check the &ldquo;ready when&rdquo; step on each: where the schedule has no link the app takes the step planned before it, and you can correct it.</p>
                <ul className="space-y-2">
                  {f.jobs.map((j) => (
                    <li key={j.id} className="rounded-xl border border-[var(--color-border)] px-3 py-2 text-[12.5px] text-[var(--color-text)]">
                      <div className="flex items-baseline gap-x-3 flex-wrap"><b>{jobWord(j)}</b><span className="ml-auto font-bold">{j.waitH >= 1 ? `Waited ${j.waitH} h` : "No wait"}</span></div>
                      <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[var(--color-text-muted)]">Ready when</span>
                        {canManage && j.candidates.length > 1 ? (
                          <select aria-label={`Ready when: ${jobWord(j)}`} value={j.afterId} disabled={!!busy} onChange={(e) => void act(`ready:${j.id}`, (s) => { s.readyAfter = { ...(s.readyAfter ?? {}), [j.id]: e.target.value }; })} className={`${field} !w-auto max-w-full h-8 !py-0`}>
                            {!j.candidates.some((c) => c.id === j.afterId) && <option value={j.afterId}>{j.after}</option>}
                            {j.candidates.map((c) => <option key={c.id} value={c.id}>{c.name.replace(/\s*\([^)]*\)/g, "")}{c.order !== j.order ? ` (${c.order})` : ""}</option>)}
                          </select>
                        ) : <b>{j.after}</b>}
                        <span className="text-[var(--color-text-muted)]">was done{j.basis === "guessed" ? " (taken from the planned sequence)" : j.basis === "corrected" ? " (as corrected)" : ""}</span>
                      </div>
                      <div className="text-[var(--color-text-muted)]">Ready {when(j.openedAt)} · {f.crew} started {when(j.startedAt)}{j.lateStartH != null && Math.abs(j.lateStartH) >= 1 ? ` · ${Math.abs(j.lateStartH)} h ${j.lateStartH > 0 ? "after" : "before"} its planned start` : ""}{j.crewOn.length ? ` · ${f.crew} was on ${[...new Set(j.crewOn.map(orderWord))].join(", ")}` : ""}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <Table title="Other work orders that finished after their plan" head={["Work order", "Finished after its plan by", "Where the time went"]} empty="None beyond what the findings tell."
              rows={review.late.filter((o) => !o.told).map((o) => [orderWord(o.order), `${o.lateH} h${o.added ? " (added work)" : ""}`, o.parts.slice(0, 3).map((p) => (p.kind === "over" ? `${p.step.replace(/\s*\([^)]*\)/g, "").replace(/[()]/g, "").trim()}: open ${p.tookH} h, progress logged on ${p.workedShifts} shift${p.workedShifts === 1 ? "" : "s"}, planned as ${p.plannedH} h of work (${p.crew})` : p.kind === "wait" ? `${p.step.replace(/\s*\([^)]*\)/g, "").replace(/[()]/g, "").trim()} sat ${p.hours} h before ${p.crew} started it` : `Started ${p.hours} h after its planned start`)).join("; ") || "Not shown by the record"])} />
            <Table title={CREWS_TITLE} head={CREWS_HEAD} empty="No work passed between crews." rows={crewsRows(review)} />
            <p className="-mt-2 text-[12px] text-[var(--color-text-muted)]">{CREWS_NOTE}</p>
            <Table title={`Started jobs that sat still: ${m.stuckJobs} job${m.stuckJobs === 1 ? "" : "s"}, ${m.stuckShifts} shift${m.stuckShifts === 1 ? "" : "s"} in all`} head={["Job", "Crew", "Shifts", "When", "Why, from the record"]} empty="No started job sat a full shift."
              rows={review.stuck.map((j) => [jobWord(j), j.crew, String(j.shifts.length), shiftsWord(j.shifts.map((s) => s.key)), [...new Set(j.shifts.map((s) => `${CAUSE_WORD[s.cause]}${s.said ? `: "${s.said}"` : s.crewOn.length ? ` (crew on ${[...new Set(s.crewOn.map(orderWord))].slice(0, 3).join(", ")})` : ""}`))].join(" Then: ")])} />
            <Table title={`Ready jobs not started: ${m.readyJobs} job${m.readyJobs === 1 ? "" : "s"}, ${m.readyShifts} shift${m.readyShifts === 1 ? "" : "s"} in all`} head={["Ready job", "Crew", "Shifts", "When", "Crew was on"]} empty="No ready job waited a full shift to start."
              rows={review.ready.map((j) => [jobWord(j), j.crew, String(j.shifts.length), shiftsWord(j.shifts), j.said ?? (j.busyOn.length ? [...new Set(j.busyOn.map(orderWord))].join(", ") : j.crewLogged ? "" : "No work logged by this crew")])} />
            <Table title={`Out for service (a planned step, not counted as waiting): ${review.service.length} job${review.service.length === 1 ? "" : "s"}`} head={["Job", "Crew", "Shifts away", "Written when it went", "Back"]} empty="Nothing went out for service."
              rows={review.service.map((j) => [jobWord(j), j.crew, shiftsWord(j.shifts), j.said, j.stillOut ? `Still out past the time quoted: "${j.stillOut.said}"` : "As planned"])} />
            <Table title={`By shift: ${m.shiftsWithStuck} of ${m.shifts} shifts had a job sitting`} head={["Shift", "Started, sitting still", "Ready, not started", "Together"]} empty="None."
              rows={review.byShift.map((c) => [shiftWord(c.key), String(c.stuck), String(c.ready), String(c.stuck + c.ready)])} />
            <Table title={`Found work: ${review.found.length} finding${review.found.length === 1 ? "" : "s"}, ${m.addedSteps} activit${m.addedSteps === 1 ? "y" : "ies"} added`} head={["Finding", "Activities", "Work when approved", "Critical path", "Approved by"]} empty="No work was added during the event."
              rows={review.found.map((f) => [`${f.what} (${orderWord(f.on)})`, String(f.steps), `${f.hours} h`, f.critical ? "Yes" : "No", f.approvedBy ?? "Not recorded"])} />
            <p className="text-[11.5px] text-[var(--color-text-muted)]">A job sat a shift when it had started and nothing was logged on it for that whole shift, or was ready and did not start. A job that sits several shifts is counted in each. Night shifts count only for work that ran on nights. Equipment out for repair or calibration is a planned step and is listed apart. Head counts were recorded for {m.headCounts.counted} of the {m.headCounts.of} crew-shifts that moved work{m.labor ? `; they put ${m.labor.pct}% of labor hours on added work` : ", so labor hours are not estimated"}.</p>
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
  const [e, setE] = useState<FindingEdit>({ title: init?.title ?? "", observation: init?.observation ?? "", practice: init?.practice ?? "", gap: init?.gap ?? "", next: init?.next ?? "", year: init?.year ?? "", owner: init?.owner ?? "", effect: init?.effect ?? "", why: init?.why ?? "", ask: init?.ask ?? "", because: init?.because ?? "", rating: init?.rating ?? "opportunity" });
  const set = (k: keyof FindingEdit, v: string) => setE((x) => ({ ...x, [k]: v }));
  const Area = ({ k, name, hint, rows = 2 }: { k: "observation" | "gap" | "next" | "year" | "why"; name: string; hint: string; rows?: number }) => (
    <label className="block"><span className={label}>{name}</span><textarea rows={rows} value={e[k] ?? ""} onChange={(ev) => set(k, ev.target.value)} placeholder={hint} className={`${field} mt-0.5`} /></label>
  );
  const ok = !!(e.title ?? "").trim() && !!(e.observation ?? "").trim();
  return (
    <div className="space-y-2.5">
      <b className="block text-[14px] text-[var(--color-text)]">{title}</b>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {pickCategory && <label className="block"><span className={label}>Category</span><select value={category} onChange={(ev) => setCategory(ev.target.value as CategoryId)} className={`${field} mt-0.5`}>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <label className="block"><span className={label}>Rating</span><select value={e.rating} onChange={(ev) => setE((x) => ({ ...x, rating: ev.target.value as Rating }))} className={`${field} mt-0.5`}>{(["gap", "opportunity", "strength"] as Rating[]).map((r) => <option key={r} value={r}>{RATING_WORD[r]}</option>)}</select></label>
      </div>
      <label className="block"><span className={label}>Finding, in one line</span><input value={e.title ?? ""} onChange={(ev) => set("title", ev.target.value)} placeholder="Flange not ordered: the length was not on the drawing" className={`${field} mt-0.5`} /></label>
      {Area({ k: "observation", name: "What happened (one fact a line)", hint: "Which job, which crew, when", rows: 5 })}
      <label className="block"><span className={label}>What it cost</span><input value={e.effect ?? ""} onChange={(ev) => set("effect", ev.target.value)} placeholder="Hours on the finish, dollars, or rework" className={`${field} mt-0.5`} /></label>
      <label className="block"><span className={label}>On the slide: the change, in one line</span><input value={e.ask ?? ""} onChange={(ev) => set("ask", ev.target.value)} placeholder="Bring a second cleaning crew for the days equipment opens." className={`${field} mt-0.5`} /></label>
      <label className="block"><span className={label}>On the slide: why, in one line</span><input value={e.because ?? ""} onChange={(ev) => set("because", ev.target.value)} placeholder="7 jobs were open at once and equipment sat open 181.5 h." className={`${field} mt-0.5`} /></label>
      {Area({ k: "why", name: "What justifies a change (with the numbers)", hint: "Hours waited, hours over plan, what one more crew or one check would have saved" })}
      {Area({ k: "gap", name: "What was missing", hint: "What was missing or didn't work" })}
      {Area({ k: "next", name: "What we do differently next time", hint: "What will be in place before the next event" })}
      {Area({ k: "year", name: "Longer term (optional)", hint: "What takes longer than one event" })}
      <label className="block"><span className={label}>Owner (a role)</span><input value={e.owner ?? ""} onChange={(ev) => set("owner", ev.target.value)} placeholder="Logistics coordinator" className={`${field} mt-0.5`} /></label>
      <div className="flex gap-1.5 flex-wrap">
        <button type="button" disabled={!ok || busy} onClick={() => onSave(e, pickCategory ? category : undefined)} className={pri}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save</button>
        <button type="button" onClick={onCancel} className={btn}>Cancel</button>
        {!ok && <span className="text-[12px] text-[var(--color-text-muted)] self-center">Needs the finding and what happened.</span>}
      </div>
    </div>
  );
}
