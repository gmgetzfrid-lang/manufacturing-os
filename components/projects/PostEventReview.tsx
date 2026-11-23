"use client";

// PostEventReview - the look back at a finished event (or one phase of it),
// told from its own records (lib/postEventReview, lib/partyLoad).
//
// It opens on the answer: how the finish came out against the plan, and
// where the late hours went, each piece put down to the finding that
// explains it. Then each finding, most hours of the finish first, with the
// chart and the jobs that show it: for a party (a contractor or crew), how
// much of its work was ready at once against how much it was planned to
// work, which jobs waited, and what they held up after them. Then what to
// change next time, written from those numbers.
//
// What the records show is in the review as it stands: a person can say a
// finding is not right (with a line why), answer the one question the
// records leave open, and set a party's crews where its chart is. Nothing
// here is written that the records or a person did not say. The same review
// downloads as a Word report and as the meeting slides, and the slides open
// on screen (View slides) on a computer or a phone.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Download, Loader2, Plus, Presentation, RefreshCw, RotateCcw, X } from "lucide-react";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import type { ShiftRecord } from "@/lib/shiftRecord";
import type { ShiftTimes } from "@/lib/shiftReport";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork } from "@/lib/asBuiltWork";
import { buildLookBack } from "@/lib/lookBack";
import { discoveries } from "@/lib/discovery";
import { inPhase, phaseOnDay, type ProjectPhase } from "@/lib/projectPhases";
import { companyOf } from "@/lib/manpower";
import { useManpowerSettings } from "@/components/projects/ManpowerSetup";
import { loadNextPlanSettings } from "@/lib/nextPlanStore";
import type { StaffingPlans } from "@/lib/staffingPlan";
import { dayKey, fmtInTz } from "@/lib/scheduleTz";
import { listMaterials, summarize } from "@/lib/materials";
import { loadOrg, orgStanding } from "@/lib/eventOrganization";
import {
  AREAS, areaOf, basisOf, buildReview, emptySaved, pointOf,
  type CategoryId, type Finding, type FindingEdit, type JobFinding, type OrgStanding, type Question, type Rating, type ReviewSaved,
} from "@/lib/postEventReview";
import { linksOf, type PartyLoad } from "@/lib/partyLoad";
import { changeReview, loadAtOnce, loadReview, reviewScope, saveAtOnce, syncLesson } from "@/lib/reviewStore";
import { appliesWord, deckSlides, fileStem, plannedWord, reviewDocx, reviewPptx, saveFile, type ReviewFileOpts } from "@/lib/reviewFiles";
import { bookOf, scoreInputsFrom, type Action, type ScoreInputs } from "@/lib/reviewBook";
import { phaseStats, type CostEntry, type CostLine } from "@/lib/phaseReport";
import type { AreaId } from "@/lib/postEventReview";
import ReviewSlides from "@/components/projects/ReviewSlides";
import { IdleBars, LateHours, LoadChart, LoadStrip } from "@/components/projects/ReviewCharts";
import { useTheme } from "@/components/providers/ThemeProvider";
import { useOrgBranding } from "@/components/providers/OrgBrandingProvider";
import { lookFromPalette, lookFromTemplate } from "@/lib/deckLook";
import { loadSlideTemplate } from "@/lib/slideTemplateStore";
import { saveSlidesChoice, useSlidesChoice } from "@/lib/slidesChoice";
import type { ScreenDeck } from "@/lib/slidePreview";
import { PLAIN_FIT, type DeckFit } from "@/lib/reviewFiles";
import { coverHasPicture, templateArea } from "@/lib/reviewTemplateDeck";
import { autoPictures, captionOf, equipmentFor, loadEquipmentPhotos, picRoom, readyPic, slideTags, type PhotoOption, type SlidePicChoice } from "@/lib/slidePictures";
import { resolveFileUrl, uploadToPath } from "@/lib/storage";
import { createPhotoRecord, invalidateAssetCache, parseCapturedAtFromFilename } from "@/lib/assets";
import type { SlideEdit } from "@/components/projects/SlideEditPanel";
import type { SlideSpec } from "@/lib/reviewFiles";
import type { TemplateInfo } from "@/lib/slideTemplate";
import { useProjectFindings, useProjectUnit } from "@/components/projects/Findings";
import { categoriesOf, guessCategories, isLive, leadTag, type Category } from "@/lib/findings";
import { useProjectType } from "@/lib/shiftTimesStore";
import { typeWord } from "@/lib/projectType";
import { appAlert } from "@/components/providers/DialogProvider";
import LoadingBlock from "@/components/ui/LoadingBlock";
import MoreMenu from "@/components/ui/MoreMenu";
import { useDraft, clearDraft } from "@/hooks/useDraft";

const btn = "inline-flex items-center justify-center gap-1.5 h-10 sm:h-9 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50 transition-colors";
const pri = "inline-flex items-center justify-center gap-1.5 h-10 sm:h-9 px-3.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-semibold hover:bg-[var(--color-accent-hover)] whitespace-nowrap disabled:opacity-50 transition-colors";
const field = "w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[14px] text-[var(--color-text)]";
const label = "text-[12px] font-semibold text-[var(--color-text-muted)]";
const link = "text-[13px] font-semibold text-[var(--color-accent-text)] hover:underline disabled:opacity-50";
const box = "rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-4 sm:p-5";

/** Lesson versions already written this session (see the effect in the review). */
const SYNCED = new Set<string>();

export default function PostEventReview({ orgId, projectId, projectName, tz, times, phases, milestones, log, notes, records, money, canManage, actor, onReload }: {
  orgId: string; projectId: string; projectName: string; tz: string; times: ShiftTimes;
  phases: ProjectPhase[]; milestones: Milestone[]; log: ProgressLogRow[] | null; notes: MilestoneNote[]; records: Map<string, ShiftRecord>;
  /** The project's budget lines and spend (cost controls), for the files. */
  money?: { lines: CostLine[]; entries: CostEntry[]; afe: number | null } | null;
  canManage: boolean; actor: { uid: string; email: string | null };
  /** Read the project's records again. */
  onReload: () => void;
  onTab?: (tab: string) => void;
  stepsLeft?: number | null;
  onSteps?: () => void;
}) {
  // One phase at a time: the first finished one, else the first.
  const doneOf = useCallback((id: string) => { const leaves = inPhase(milestones, phases, id).filter((m) => !m.isSummary && !(m as { cancelledAt?: unknown }).cancelledAt); return leaves.length > 0 && leaves.every((m) => m.status === "completed"); }, [milestones, phases]);
  const [phaseId, setPhaseId] = useState<string | null>(() => (phases.length ? (phases.find((p) => doneOf(p.id)) ?? phases[0]).id : null));
  const phase = phases.find((p) => p.id === phaseId) ?? null;
  const scope = reviewScope(phases.length ? phaseId : null);
  const mp = useManpowerSettings(projectId);
  const [plans, setPlans] = useState<StaffingPlans | null>(null);
  const [saved, setSaved] = useState<ReviewSaved | null>(null);
  const [atOnce, setAtOnce] = useState<Record<string, number>>({});
  const [register, setRegister] = useState<{ lines: number; specIncomplete: number; openQuestions: number; late: number } | null>(null);
  const [organization, setOrganization] = useState<OrgStanding | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The files' colors: the workspace's; the slides go onto the company template when there is one.
  const { palette } = useTheme();
  const { branding } = useOrgBranding();
  const tpl = branding?.slides ?? null;
  const { choice: savedChoice } = useSlidesChoice(projectId);
  const [ownChoice, setOwnChoice] = useState<boolean | null>(null);
  const useTpl = !!tpl && (ownChoice ?? savedChoice ?? true);
  const wordLook = useMemo(() => lookFromPalette(palette), [palette]);
  const slideLook = useMemo(() => (useTpl && tpl ? lookFromTemplate(tpl) : wordLook), [useTpl, tpl, wordLook]);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);
  const [viewing, setViewing] = useState(false);
  const [screen, setScreen] = useState<{ deck: ScreenDeck | null; state: "loading" | { error: string } | null }>({ deck: null, state: null });
  // A file that is made, where the browser wants a tap to hand it over.
  const [held, setHeld] = useState<{ data: Uint8Array | Blob; name: string; mime: string } | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(null);
    void (async () => {
      try {
        const [s, np, mats, org, n] = await Promise.all([
          loadReview(projectId, scope),
          loadNextPlanSettings(projectId).catch(() => null),
          listMaterials(projectId).catch(() => ({ rows: [] })),
          loadOrg(projectId).catch(() => null),
          loadAtOnce(projectId, scope).catch(() => ({})),
        ]);
        if (!live) return;
        setSaved(s); setPlans(np?.staffing ?? null); setOrganization(orgStanding(org)); setAtOnce(n);
        const mine = mats.rows.filter((r) => !phases.length || !r.phaseId || r.phaseId === phaseId);
        const sum = summarize(mine, Date.now());
        setRegister(!sum.lines ? null : { lines: sum.lines, specIncomplete: sum.specIncomplete, openQuestions: sum.openQuestions, late: sum.late });
      } catch (e) { if (live) { setErr((e as Error).message); setSaved(emptySaved()); } }
    })();
    return () => { live = false; };
  }, [projectId, scope, phaseId, phases.length, tick]);

  // The findings written on the job: part of what the review is built from.
  const { rows: projectFindings } = useProjectFindings(projectId);
  const buildFor = useCallback((pid: string | null, saved: ReviewSaved, crews: Record<string, number>) => {
    const mine = phases.length && pid ? inPhase(milestones, phases, pid) : milestones;
    const kids = new Map<string, Milestone[]>();
    for (const m of mine) if (m.parentId) { if (!kids.has(m.parentId)) kids.set(m.parentId, []); kids.get(m.parentId)!.push(m); }
    const ids = new Set(mine.map((m) => m.id));
    const active = mine.filter((m) => !(m as { cancelledAt?: unknown }).cancelledAt);
    const myNotes = notes.filter((n) => ids.has(n.milestoneId));
    const now = Date.now();
    const built = buildAsBuilt({ milestones: mine, childrenByParent: kids, phases, tz });
    const work = buildAsBuiltWork({ built, milestones: mine, log: (log ?? []).filter((r) => ids.has(r.milestone_id)), notes: myNotes, records, plans, companyOf: (c) => companyOf(c, mp), tz, times, now });
    const ds = discoveries(active);
    const look = buildLookBack({ milestones: active, notes: myNotes, discoveries: ds, now, tz, log: (log ?? []).filter((r) => ids.has(r.milestone_id)) });
    const dependsOn = new Map(mine.filter((x) => x.id).map((x) => [x.id!, x.dependsOn ?? []]));
    const calendar = new Map(mine.filter((x) => x.id).map((x) => [x.id!, String(((x.attributes ?? {}) as Record<string, unknown>).work_calendar ?? "").trim() || null]));
    // This phase's: on its work, else written on its days.
    const byId = new Map(milestones.filter((x) => x.id).map((x) => [x.id!, x]));
    const jobFindings: JobFinding[] = projectFindings
      .filter((f) => isLive(f) && f.source !== "review" && (f.milestoneId ? ids.has(f.milestoneId) : !phases.length || !pid || phaseOnDay(dayKey(f.foundAt, tz), phases)?.id === pid))
      .map((f) => {
        const on = f.milestoneId ? byId.get(f.milestoneId) : undefined;
        const named = categoriesOf(f.topic);
        const cats: Category[] = named.length ? named : guessCategories(f.body).length ? guessCategories(f.body) : [f.kind === "material" ? "Logistics" : f.kind === "missed_scope" ? "Planning" : "Execution"];
        return { id: f.id, areas: cats.map((c) => c.toLowerCase() as AreaId), kind: f.kind, body: f.body, nextTime: f.nextTime, tag: f.assetTag ?? leadTag(on?.name), on: on?.name ?? null, every: f.appliesTo === "all", by: f.createdByName, at: f.foundAt };
      });
    return {
      review: buildReview({ built, work, notes: myNotes, look, discoveries: ds, tz, saved, materials: register, organization, dependsOn, links: linksOf(mine, kids), calendarOf: (id) => calendar.get(id) ?? null, atOnce: crews, log: (log ?? []).filter((r) => ids.has(r.milestone_id)), jobFindings }),
      work,
    };
  }, [milestones, phases, notes, log, records, plans, mp, tz, times, register, organization, projectFindings]);
  const made = useMemo(() => (saved ? buildFor(phases.length ? phaseId : null, saved, atOnce) : null), [saved, phases.length, phaseId, buildFor, atOnce]);
  const review = made?.review ?? null;
  // The files' inputs, from the same shift records, manpower settings and cost lines the rest of the app reads.
  const scoreIn = useMemo<ScoreInputs>(() => {
    if (!made || !saved) return {};
    const st = money ? phaseStats({ milestones, phases, phase, log, tz, times, now: Date.now(), total: money.afe, lines: money.lines, entries: money.entries }) : null;
    return { ...scoreInputsFrom({ work: made.work, records, manpower: mp }), costs: st ? { budget: st.budget || null, spent: st.spent, committed: st.committed } : null, entries: saved.score, targets: saved.targets };
  }, [made, saved, money, milestones, phases, phase, log, tz, times, records, mp]);
  // Open actions from the other phases' reviews carry here until they are closed.
  const [others, setOthers] = useState<Record<string, ReviewSaved>>({});
  useEffect(() => {
    let live = true;
    const rest = phases.filter((p) => p.id !== phaseId);
    void Promise.all(rest.map((p) => loadReview(projectId, reviewScope(p.id)).then((sv) => [p.id, sv] as const).catch(() => null)))
      .then((xs) => { if (live) setOthers(Object.fromEntries(xs.filter((x): x is readonly [string, ReviewSaved] => !!x))); });
    return () => { live = false; };
  }, [projectId, phaseId, phases, tick]);
  const carried = useMemo(() => phases.filter((p) => p.id !== phaseId && others[p.id] && (others[p.id].added.length > 0 || Object.values(others[p.id].items).some((i) => i.status === "kept" && (i.edits?.owner || i.edits?.due))))
    .map((p) => ({ phase: p, actions: bookOf(buildFor(p.id, others[p.id], {}).review, p.name, tz).actions.filter((a) => !a.done && (a.who || a.by)) })).filter((x) => x.actions.length > 0), [phases, phaseId, others, buildFor, tz]);

  const who = actor.email;
  const ptype = useProjectType(projectId, projectName);
  const typeIn = typeWord(ptype);
  const unit = useProjectUnit(orgId, projectId);
  // A finding a person kept on purpose (or wrote) is in the lessons register,
  // with who it is for; each version is written once. One taken out since
  // comes out. What the records show is in the review without that step,
  // and goes to the register only when a person keeps it.
  useEffect(() => {
    if (!review || !canManage || !orgId) return;
    const inRegister = new Set(projectFindings.filter((r) => r.source === "review" && r.status === "kept").map((r) => r.sourceRef));
    for (const f of review.findings) {
      if (f.source === "job") continue;
      if (!(f.status === "kept" && !f.auto && (f.rating === "gap" || f.rating === "opportunity"))) {
        const out = `out:${projectId}:${scope}:${f.key}`;
        if (inRegister.has(`${scope}:${f.key}`) && !SYNCED.has(out) && f.status === "discarded") {
          SYNCED.add(out);
          void syncLesson({ orgId, projectId, projectType: ptype.word, unitCode: unit?.code ?? null, scope, finding: f, kept: false, actor: { id: actor.uid, name: who } }).catch((e) => { SYNCED.delete(out); void appAlert({ title: "Lessons register not updated", message: `"${f.title}" didn't come off the lessons register (${(e as Error).message}). It tries again the next time this review opens.`, tone: "danger" }); });
        }
        continue;
      }
      const sig = `${projectId}:${scope}:${f.key}:${f.applies}:${ptype.word}:${unit?.code ?? ""}:${f.title}:${f.next}:${f.ask}`;
      if (SYNCED.has(sig)) continue;
      SYNCED.add(sig);
      void syncLesson({ orgId, projectId, projectType: ptype.word, unitCode: unit?.code ?? null, scope, finding: f, kept: true, actor: { id: actor.uid, name: who } }).catch((e) => { SYNCED.delete(sig); void appAlert({ title: "Lessons register not updated", message: `"${f.title}" didn't reach the lessons register (${(e as Error).message}). It tries again the next time this review opens.`, tone: "danger" }); });
    }
  }, [review, canManage, orgId, projectId, scope, ptype.word, unit?.code, actor.uid, who, projectFindings]);
  const act = async (key: string, change: (s: ReviewSaved) => void, after?: (next: ReviewSaved) => Promise<void> | void) => {
    setBusy(key); setErr(null); setMsg(null);
    try { const next = await changeReview(projectId, scope, change); setSaved(next); await after?.(next); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const lesson = async (f: Finding, kept: boolean) => {
    if (f.source === "job") return;
    const ok = await syncLesson({ orgId, projectId, projectType: ptype.word, unitCode: unit?.code ?? null, scope, finding: f, kept, actor: { id: actor.uid, name: who } }).catch((e) => { setErr((e as Error).message); return true; });
    if (!ok && kept) setMsg("Kept here. The lessons register (From past jobs) isn't set up in the database yet, so it wasn't added there.");
  };
  const refind = (next: ReviewSaved, key: string): Finding | undefined => {
    if (!review) return undefined;
    const f = review.findings.find((x) => x.key === key);
    if (!f) return undefined;
    const it = next.items[key]; const e = it?.edits ?? {};
    if (f.source === "person") { const a = next.added.find((x) => `added:${x.id}` === key); return a ? { ...f, title: a.title ?? f.title, observation: a.observation ?? "", gap: a.gap ?? "", next: a.next ?? "", year: a.year ?? "", owner: a.owner ?? "", effect: a.effect ?? "", why: a.why ?? a.effect ?? f.why, rating: a.rating ?? f.rating, info: it?.info ?? [] } : f; }
    return { ...f, title: e.title ?? f.drafted.title, observation: e.observation ?? f.drafted.observation, rating: e.rating ?? f.drafted.rating, practice: e.practice ?? f.practice, gap: e.gap ?? f.gap, next: e.next ?? f.next, year: e.year ?? f.year, owner: e.owner ?? f.owner, effect: e.effect ?? f.effect, why: e.why ?? f.why, info: it?.info ?? [] };
  };

  // Keep: in the review (the default for what the records show), and in the lessons register.
  const keep = (f: Finding) => void act(`keep:${f.key}`, (s) => { s.items[f.key] = { ...s.items[f.key], status: "kept", notRight: undefined, basis: basisOf(f), at: Date.now(), by: who }; delete s.items[f.key].notRight; }, () => lesson(f, true));
  // Not right: out of the review and off the slides, with a line why.
  const notRight = (f: Finding, why: string) => void act(`drop:${f.key}`, (s) => { s.items[f.key] = { ...s.items[f.key], status: "discarded", notRight: why.trim() || undefined, at: Date.now(), by: who }; if (!why.trim()) delete s.items[f.key].notRight; }, () => (f.status === "kept" && !f.auto ? lesson(f, false) : undefined));
  const putBack = (f: Finding) => void act(`drop:${f.key}`, (s) => { const it = { ...s.items[f.key] }; delete it.status; delete it.notRight; s.items[f.key] = it; });
  const saveEdit = (f: Finding, e: FindingEdit, category?: CategoryId) => void act(`edit:${f.key}`, (s) => {
    if (f.source === "person") { const a = s.added.find((x) => `added:${x.id}` === f.key); if (a) Object.assign(a, e, category ? { category } : {}); return; }
    const out: FindingEdit = { ...(s.items[f.key]?.edits ?? {}) };
    for (const k of ["title", "observation"] as const) { const v = (e[k] ?? "").trim(); if (v && v !== f.drafted[k]) out[k] = v; else delete out[k]; }
    for (const k of ["practice", "gap", "next", "year", "owner", "effect", "why", "ask", "because", "due", "cost"] as const) { const v = (e[k] ?? "").trim(); if (v !== f[k]) { if (v) out[k] = v; else delete out[k]; } }
    if (e.rating && e.rating !== f.drafted.rating) out.rating = e.rating; else delete out.rating;
    s.items[f.key] = { ...s.items[f.key], edits: out, basis: basisOf(f), at: Date.now(), by: who };
  }, (next) => { const g = refind(next, f.key); return g && ((f.status === "kept" && !f.auto) || f.source === "person") ? lesson(g, true) : undefined; });
  const setPlan = (keys: string[], patch: { owner?: string; due?: string }) => void act(`plan:${keys[0]}`, (s) => {
    for (const key of keys) {
      const a = s.added.find((x) => `added:${x.id}` === key);
      if (a) { Object.assign(a, patch); continue; }
      const it = { ...s.items[key] }; const e: Record<string, unknown> = { ...(it.edits ?? {}) };
      for (const [k, v] of Object.entries(patch)) { const t = (v ?? "").trim(); if (t) e[k] = t; else delete e[k]; }
      it.edits = e as FindingEdit; s.items[key] = it;
    }
  });
  // An action can stand for several findings that asked for the same change: closing it closes each.
  const setDone = (keys: string[], done: boolean) => void act(`done:${keys[0]}`, (s) => { for (const key of keys) { const it = { ...s.items[key] }; if (done) it.done = true; else delete it.done; s.items[key] = it; } });
  const closeCarried = async (pid: string, key: string) => {
    setBusy(`carried:${key}`); setErr(null);
    try { const next = await changeReview(projectId, reviewScope(pid), (s) => { s.items[key] = { ...s.items[key], done: true }; }); setOthers((o) => ({ ...o, [pid]: next })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const answer = (q: Question, note: string) => void act(`q:${q.key}`, (s) => { const t = note.trim(); if (t) s.answers[q.key] = { note: t, at: Date.now(), by: who }; else delete s.answers[q.key]; });
  // A party's crews: how many jobs it can work at once, kept with the contractor settings.
  const setCrews = async (party: string, n: number | null) => {
    setBusy(`crews:${party}`); setErr(null);
    try { await saveAtOnce(projectId, scope, party, n); setAtOnce(await loadAtOnce(projectId, scope)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const addFinding = (e: FindingEdit, category: CategoryId) => {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
    void act("add", (s) => { s.added.push({ ...e, id, category, at: Date.now(), by: who }); }, async () => {
      clearDraft(`review-add:${projectId}:${scope}`);
      setAdding(false);
      const c = areaOf(category);
      await lesson({ key: `added:${id}`, category, source: "person", rating: e.rating ?? "opportunity", title: e.title ?? "Finding", observation: e.observation ?? "", evidence: [], practice: "", gap: e.gap ?? "", next: e.next ?? "", year: e.year ?? "", owner: e.owner ?? "", due: e.due ?? "", cost: e.cost ?? "", done: false, auto: false, applies: "all", effect: e.effect ?? "", finishH: 0, moved: null, proof: "", why: e.effect ?? "", hours: null, ask: e.ask ?? e.next ?? "", because: e.because ?? e.effect ?? "", info: [], status: "kept", edited: false, stale: false, drafted: { title: e.title ?? c.name, observation: e.observation ?? "", rating: e.rating ?? "opportunity" }, by: who, at: Date.now() }, true);
    });
  };
  const reanalyze = () => { setMsg(null); setErr(null); onReload(); setTick((t) => t + 1); };

  const fileOpts = (): ReviewFileOpts => ({ project: projectName, phase: phase?.name ?? null, tz, preparedBy: null, date: fmtInTz(Date.now(), tz, { month: "long", day: "numeric", year: "numeric" }), score: scoreIn, kind: typeIn });
  const download = async (kind: "word" | "slides") => {
    if (!review) return;
    setBusy(kind); setErr(null); setHeld(null);
    try {
      const o = fileOpts();
      const made = kind === "word"
        ? { data: await reviewDocx(review, o, wordLook), name: `${fileStem(o)}.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
        : await (async () => {
          const t = useTpl && tpl ? await loadSlideTemplate(tpl) : null;
          const specs = (await picturesOn(deckSlides(review, o, t ? templateArea(t.info, tpl?.pick) : PLAIN_FIT))).specs;
          return { data: await reviewPptx(review, o, { specs, look: slideLook, template: t && tpl ? { ...t, pick: tpl.pick } : null }), name: `${fileStem(o)} slides.pptx`, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
        })();
      if (!(await saveFile(made.data, made.name, made.mime))) setHeld(made);
    } catch (e) { setErr(`The file couldn't be made: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  const saveHeld = async () => { if (held && (await saveFile(held.data, held.name, held.mime))) setHeld(null); };
  // The template, measured, when the slides go onto it: its room decides
  // where each slide splits (one table size the deck through).
  const [tplInfo, setTplInfo] = useState<{ path: string; info: TemplateInfo | null } | null>(null);
  useEffect(() => {
    if (!useTpl || !tpl) return;
    let live = true;
    void loadSlideTemplate(tpl).then((x) => { if (live) setTplInfo({ path: tpl.path, info: x.info }); }).catch(() => { if (live) setTplInfo({ path: tpl.path, info: null }); });
    return () => { live = false; };
  }, [useTpl, tpl]);
  const tplMeasured = useTpl && tpl && tplInfo?.path === tpl.path ? tplInfo : null;
  const deckFit: DeckFit | null = !useTpl ? PLAIN_FIT : tplMeasured ? (tplMeasured.info ? templateArea(tplMeasured.info, tpl?.pick) : PLAIN_FIT) : null;
  // The slides on show, made once when the viewer opens (and again when the review changes).
  const baseSpecs = useMemo<SlideSpec[] | null>(() => (viewing && review && deckFit ? deckSlides(review, fileOpts(), deckFit) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewing, review, deckFit?.w, deckFit?.h, deckFit?.footInside]);

  // ── Pictures ──
  // Each slide that names equipment shows its photo, when it has one; a
  // person's own choice for a slide (saved with the review) wins. The room
  // a slide has depends on the look: the plain slides, or the template's.
  const [photoTick, setPhotoTick] = useState(0);
  const [pics, setPics] = useState<{ specs: SlideSpec[]; photos: Map<string, PhotoOption[]>; auto: Record<string, SlidePicChoice[]>; area: { w: number; h: number }; coverSpot: boolean; base: SlideSpec[] } | null>(null);
  const picturesOn = async (base: SlideSpec[]) => {
    const info = useTpl && tpl ? (await loadSlideTemplate(tpl)).info : null;
    const area = info ? templateArea(info, tpl?.pick) : PLAIN_FIT;
    const coverSpot = info ? coverHasPicture(info, tpl?.pick) : true;
    const tags = [...new Set(base.flatMap(slideTags))];
    const photos = orgId ? await loadEquipmentPhotos(orgId, tags, unit?.code ?? null, { from: review?.metrics.start ?? null, to: review?.metrics.actualFinish ?? null }).catch(() => new Map<string, PhotoOption[]>()) : new Map<string, PhotoOption[]>();
    const auto = autoPictures(base, photos, coverSpot, area);
    const specs = await Promise.all(base.map(async (sp) => {
      if (!sp.key) return sp;
      const list = (saved?.slides[sp.key]?.pics ?? auto[sp.key] ?? []).slice(0, picRoom(sp, coverSpot, area));
      const ready = (await Promise.allSettled(list.map((p) => readyPic(p.path, p.caption, () => resolveFileUrl(p.path))))).flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      return ready.length ? { ...sp, pics: ready } : sp;
    }));
    return { specs, photos, auto, area, coverSpot, base };
  };
  useEffect(() => {
    if (!viewing || !baseSpecs) return;
    let live = true;
    void picturesOn(baseSpecs).then((r) => { if (live) setPics(r); }).catch(() => { /* the slides show without pictures */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing, baseSpecs, useTpl, tpl, photoTick]);
  const viewSpecs = pics && pics.base === baseSpecs ? pics.specs : baseSpecs;
  const scoreSpec = baseSpecs?.find((x) => x.key === "score");
  const slideEdit: SlideEdit | null = canManage && baseSpecs && review ? {
    picsOf: (key) => {
      const sp = baseSpecs.find((x) => x.key === key);
      if (!sp || !pics) return { pics: [], chosen: false, room: 0, why: sp ? "Reading the equipment photos…" : "This slide has no room for pictures." };
      const room = picRoom(sp, pics.coverSpot, pics.area);
      const own = saved?.slides[key];
      const shownPics = viewSpecs?.find((x) => x.key === key)?.pics ?? [];
      const list = (own?.pics ?? pics.auto[key] ?? []).slice(0, room).map((p) => ({ ...p, url: shownPics.find((q) => (q as { path?: string }).path === p.path)?.url }));
      const why = room ? null : sp.body.k === "cover" ? "Your template's cover has no spot for a picture." : sp.body.k === "table" ? "This slide's table needs the whole slide, so it has no room for a picture." : "This slide has no room for pictures.";
      return { pics: list, chosen: !!own, room, why };
    },
    options: pics ? [...pics.photos.values()].flat() : [],
    tagsOf: (key) => { const sp = baseSpecs.find((x) => x.key === key); return sp ? slideTags(sp.body.k === "cover" && scoreSpec ? scoreSpec : sp) : []; },
    setPics: async (key, list) => {
      const next = await changeReview(projectId, scope, (st) => { if (list) st.slides[key] = { pics: list }; else delete st.slides[key]; });
      setSaved(next);
    },
    upload: async (file, tag) => {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const type = file.type || "image/jpeg";
      const taken = parseCapturedAtFromFilename(file.name) ?? (file.lastModified ? new Date(file.lastModified).toISOString() : null);
      // A photo of a piece of equipment is kept with it, for every slide and screen that shows it.
      const eq = tag && orgId ? await equipmentFor(orgId, tag, unit?.code ?? null) : null;
      if (eq && orgId) {
        const path = `orgs/${orgId}/assets/${eq.id}/photos/${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
        await uploadToPath(file, path, { contentType: type });
        await createPhotoRecord({ orgId, assetId: eq.id, fileUrl: path, fileSize: file.size, contentType: type, capturedAt: taken ?? undefined, uploadedBy: actor.uid });
        invalidateAssetCache();
        setPhotoTick((t) => t + 1);
        return { path, caption: captionOf(eq.tag, taken), tag: eq.tag };
      }
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
      const path = `orgs/${orgId}/projects/${projectId}/review-pictures/${id}.${ext}`;
      await uploadToPath(file, path, { contentType: type });
      return { path, caption: captionOf("Photo", taken) };
    },
    words: (rowKey, close) => {
      const f = review.findings.find((x) => x.key === rowKey);
      if (!f) return <p className="text-[14px] text-[var(--color-text-muted)]">That line&apos;s finding isn&apos;t in this review any more.</p>;
      return <FindingForm key={f.key} title={`Change: ${f.title}`} init={f} pickCategory={f.source === "person"} busy={busy === `edit:${f.key}`} onCancel={close} onSave={(e, cat) => { saveEdit(f, e, cat); close(); }} />;
    },
  } : null;
  // On the template: the same file the download writes, drawn for the screen.
  useEffect(() => {
    let live = true;
    const want = viewing && useTpl && tpl && viewSpecs;
    queueMicrotask(() => { if (live) setScreen((x) => ({ deck: want ? x.deck : null, state: want ? "loading" : null })); });
    if (!want) return () => { live = false; };
    void (async () => {
      try {
        const [{ data, info }, { screenDeck }] = await Promise.all([loadSlideTemplate(tpl), import("@/lib/slidePreview")]);
        const deck = await screenDeck(tpl.path, viewSpecs, { info, data, look: slideLook, pick: tpl.pick, title: `${phase?.name ?? projectName} post-event review` });
        if (live) setScreen({ deck, state: null });
      } catch (e) { if (live) setScreen({ deck: null, state: { error: (e as Error).message } }); }
    })();
    return () => { live = false; };
  }, [viewing, useTpl, tpl, viewSpecs, slideLook, phase?.name, projectName]);
  /** The switch: saved on the project for everyone when this person may change it. */
  const chooseSlides = async (on: boolean) => {
    setOwnChoice(on);
    if (!canManage) return;
    try { await saveSlidesChoice(projectId, on); } catch (e) { setErr((e as Error).message); }
  };


  if (!review) return <LoadingBlock what="the review" />;
  const m = review.metrics;
  const late = m.varianceH != null && m.varianceH >= 1;
  const pt = pointOf(review, phase?.name ?? projectName, tz);
  const bk = bookOf(review, phase?.name ?? projectName, tz, scoreIn);
  const live = review.findings.filter((f) => f.status !== "discarded");
  const main = live.filter((f) => f.rating === "gap" || f.rating === "opportunity" || f.finishH > 0);
  const went = live.filter((f) => !main.includes(f) && f.rating === "strength");
  const quiet = live.filter((f) => !main.includes(f) && !went.includes(f));
  const out = review.findings.filter((f) => f.status === "discarded");
  const go = (key: string) => { const el = document.querySelector(`[data-finding="${key.replace(/"/g, "")}"]`); el?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const actionOf = new Map(bk.actions.flatMap((a) => a.keys.map((k) => [k, a.n] as const)));
  const at = (t: number | null) => (t == null ? "Not finished" : `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
  const card = (f: Finding) => (
    <FindingCard key={f.key} f={f} tz={tz} lateH={late ? m.varianceH : null} canManage={canManage} busy={busy} action={actionOf.get(f.key) ?? null}
      questions={review.questions.filter((q) => q.findingKey === f.key)} answers={saved?.answers ?? {}}
      onKeep={() => keep(f)} onNotRight={(why) => notRight(f, why)} onAnswer={answer} onCrews={(party, n) => void setCrews(party, n)} />
  );

  return (
    <div className="space-y-4" data-post-event-review>
      <div className="min-w-0" data-review-head>
        <div className="flex items-end gap-x-3 gap-y-2 flex-wrap min-h-8">
          <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">Post-event review{phase ? ` · ${phase.name}` : ""}</h2>
          <div className="flex-1" />
          <div className="flex gap-1.5 items-center">
          <button type="button" onClick={() => setViewing(true)} disabled={!m.steps} className={pri}><Presentation className="w-4 h-4" /> View slides</button>
          <MoreMenu items={[
            { icon: <RefreshCw className="w-4 h-4" />, label: "Re-analyze", onClick: () => { if (!busy) reanalyze(); } },
            ...(m.steps ? [
              { icon: <Download className="w-4 h-4" />, label: "Download PowerPoint", onClick: () => { if (!busy) void download("slides"); }, line: true },
              { icon: <Download className="w-4 h-4" />, label: "Download Word report", onClick: () => { if (!busy) void download("word"); } },
            ] : []),
            ...(canManage ? [{ icon: <Plus className="w-4 h-4" />, label: "Add a finding of your own", onClick: () => setAdding(true), line: true }] : []),
          ]} />
          </div>
        </div>
        {phases.length > 0 && (
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            {phases.map((p) => (
              <button key={p.id} type="button" onClick={() => { setPhaseId(p.id); setAdding(false); }} aria-pressed={p.id === phaseId}
                className={`h-9 px-3.5 rounded-full border text-[13px] font-semibold ${p.id === phaseId ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent-text)]/30 border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]"}`}>{p.name}</button>
            ))}
          </div>
        )}
        {(busy === "slides" || busy === "word") && <p role="status" className="mt-2 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Making the {busy === "word" ? "Word report" : "PowerPoint"}…</p>}
        {err && <div role="alert" className="mt-2 text-[13px] font-semibold text-[var(--state-overdue)]">{err}</div>}
        {msg && <div role="status" className="mt-2 text-[13px] font-semibold text-[var(--state-held)]">{msg}</div>}
        {held && !viewing && <div role="status" className="mt-2 flex items-center gap-2 flex-wrap text-[13px] font-semibold text-[var(--color-text)]" data-file-ready><span className="min-w-0 flex-1 basis-40">The file is ready.</span><button type="button" onClick={() => void saveHeld()} className={btn}><Download className="w-4 h-4" /> Save file</button></div>}
      </div>
      {viewing && viewSpecs && <ReviewSlides slides={viewSpecs} name={`${phase?.name ?? projectName} post-event review`} onClose={() => setViewing(false)} onDownload={() => void download("slides")} downloading={busy === "slides"} ready={held ? { name: held.name, onSave: () => void saveHeld() } : null} look={slideLook} template={tpl?.name ?? null}
        deck={useTpl ? screen.deck : null} deckState={useTpl ? screen.state : null} choice={tpl ? { on: useTpl, set: (on) => void chooseSlides(on) } : null} edit={slideEdit} />}

      {carried.map(({ phase: p, actions }) => (
        <section key={p.id} className={box} data-review-carried={p.id}>
          <b className="block text-[14px] text-[var(--color-text)]">Open actions from the {p.name} review: {actions.length}</b>
          <ul className="mt-2 space-y-2">
            {actions.map((a) => (
              <li key={a.key} className="flex gap-3 items-start text-[13.5px] text-[var(--color-text)]">
                <div className="min-w-0 flex-1"><b className="block leading-snug">{a.what}</b><span className="text-[12.5px] text-[var(--color-text-muted)]">Owner: {a.who || "not set"} · By: {a.by || "not set"}</span></div>
                {canManage && <button type="button" disabled={!!busy} onClick={() => void closeCarried(p.id, a.key)} className={btn}><Check className="w-4 h-4" /> Done</button>}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {!m.steps ? <div className={`${box} text-[14px] text-[var(--color-text-muted)]`}>No schedule{phase ? ` for ${phase.name}` : ""} yet, so there is nothing to review.</div> : <>
        <section className={box} data-review-answer>
          <h3 className="font-display text-[19px] sm:text-[22px] font-semibold leading-snug text-[var(--color-text)]"><Tags text={pt.headline} /></h3>
          <dl className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2.5 text-[13px]">
            <div><dt className="text-[var(--color-text-muted)]">Baseline finish</dt><dd className="font-semibold text-[15px] text-[var(--color-text)]">{at(m.baselineFinish)}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Actual finish</dt><dd className="font-semibold text-[15px] text-[var(--color-text)]">{at(m.actualFinish)}</dd></div>
            <div className="col-span-2 sm:col-span-1"><dt className="text-[var(--color-text-muted)]">Against the baseline</dt><dd className={`font-semibold text-[15px] ${m.varianceH == null ? "text-[var(--color-text)]" : m.varianceH >= 1 ? "text-[var(--state-overdue)]" : "text-[var(--state-released)]"}`}>{m.varianceH == null ? `${m.steps - m.stepsDone} of ${m.steps} activities still open` : Math.abs(m.varianceH) < 1 ? "On the baseline finish" : `${Math.abs(m.varianceH)} h ${m.varianceH > 0 ? "late" : "early"}`}</dd></div>
          </dl>
          {late && review.lateBars.length > 0 && (
            <div className="mt-5">
              <h4 className="text-[15px] font-semibold text-[var(--color-text)]">Where the {m.varianceH} h went</h4>
              <p className="mb-2.5 text-[12.5px] text-[var(--color-text-muted)]">Each piece of the late finish and the finding that explains it. A bar goes to its finding.</p>
              <LateHours bars={review.lateBars} late={m.varianceH!} onPick={go} />
            </div>
          )}
          {!m.done && <p className="mt-3 text-[12.5px] text-[var(--color-text-muted)]">{m.steps - m.stepsDone} of {m.steps} activities are not done yet, so these numbers are to date.</p>}
        </section>

        <section className="space-y-3" data-review-findings>
          <div className="flex items-baseline gap-x-3 gap-y-0.5 flex-wrap px-0.5">
            <h3 className="font-display text-[17px] font-semibold text-[var(--color-text)]">What the records show</h3>
            {main.length > 0 && late && <span className="text-[12.5px] text-[var(--color-text-muted)]">Most hours of the late finish first</span>}
          </div>
          {adding && <div className={box}><FindingForm title="Add a finding of your own" draftKey={`review-add:${projectId}:${scope}`} pickCategory busy={busy === "add"} onCancel={() => setAdding(false)} onSave={(e, c) => addFinding(e, c ?? "execution")} /></div>}
          {main.length === 0 && <div className={`${box} text-[14px] text-[var(--color-text-muted)]`}>Nothing in the records calls for a change.</div>}
          {main.map(card)}
          {went.length > 0 && (
            <section className={box} data-review-well>
              <h4 className="text-[14px] font-semibold text-[var(--color-text)]">What went well</h4>
              <ul className="mt-1.5 space-y-1 text-[13.5px] text-[var(--color-text)] list-disc pl-5">{went.map((f) => <li key={f.key}><b>{f.title}.</b> {f.observation.split("\n")[0]}</li>)}</ul>
            </section>
          )}
          {quiet.length > 0 && (
            <details className={`${box} !py-3`} data-review-quiet>
              <summary className="cursor-pointer text-[14px] font-semibold text-[var(--color-text)]">Also checked, did not move the finish ({quiet.length})</summary>
              <div className="mt-3 space-y-3">{quiet.map(card)}</div>
            </details>
          )}
          {out.length > 0 && (
            <details className={`${box} !py-3`} data-review-out>
              <summary className="cursor-pointer text-[14px] font-semibold text-[var(--color-text)]">Taken out of the review ({out.length})</summary>
              <ul className="mt-2 space-y-2">
                {out.map((f) => (
                  <li key={f.key} className="flex items-start gap-3 text-[13.5px]">
                    <div className="min-w-0 flex-1"><b className="block text-[var(--color-text)]">{f.title}</b><span className="text-[var(--color-text-muted)]">{f.notRight ? `Not right: ${f.notRight}` : "Taken out."}{f.by ? ` (${f.by})` : ""}</span></div>
                    {canManage && <button type="button" disabled={!!busy} onClick={() => putBack(f)} className={btn}><RotateCcw className="w-4 h-4" /> Put back</button>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className={box} data-review-plan>
          <h3 className="font-display text-[17px] font-semibold text-[var(--color-text)]">What we change next time</h3>
          {bk.actions.length ? (
            <ol className="mt-3 space-y-4">
              {bk.actions.map((a) => <ActionLine key={a.key} a={a} kind={typeIn} busy={busy === `plan:${a.key}` || busy === `done:${a.key}`} canManage={canManage} onPlan={(patch) => setPlan(a.keys, patch)} onDone={(d) => setDone(a.keys, d)} onGo={() => go(a.key)} />)}
            </ol>
          ) : <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">Nothing in the records calls for a change.</p>}
        </section>

        <details className={`${box} !py-3`} data-review-definitions>
          <summary className="cursor-pointer text-[14px] font-semibold text-[var(--color-text)]">How each number is counted</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[13px] border-collapse">
              <tbody>{review.definitions.map((d) => <tr key={d.measure} className="border-b last:border-b-0 border-[var(--color-border)] align-top"><th scope="row" className="text-left font-semibold pr-3 py-1.5 text-[var(--color-text)] whitespace-nowrap">{d.measure}</th><td className="py-1.5 text-[var(--color-text)]">{d.means}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      </>}
    </div>
  );
}

// ─── A finding ─────────────────────────────────────────────────────

function FindingCard({ f, tz, lateH, canManage, busy, action, questions, answers, onKeep, onNotRight, onAnswer, onCrews }: {
  f: Finding; tz: string; lateH: number | null; canManage: boolean; busy: string | null; action: number | null;
  questions: Question[]; answers: ReviewSaved["answers"];
  onKeep: () => void; onNotRight: (why: string) => void; onAnswer: (q: Question, note: string) => void; onCrews: (party: string, n: number | null) => void;
}) {
  const [why, setWhy] = useState<string | null>(null);
  const lines = f.observation.split("\n").map((l) => l.trim()).filter(Boolean);
  // A party's load and ready work with nobody on it say it in one passage; the rest say it in a line, then their facts.
  const head = f.idle ? lines.join(" ") : f.load ? lines.slice(0, 3).join(" ") : f.why && f.source === "records" ? f.why : lines[0] ?? "";
  const rest = f.idle ? [] : f.load ? lines.slice(3) : f.why && f.source === "records" ? lines : lines.slice(1);
  const showEffect = !!f.effect && !head.includes(f.effect) && !rest.includes(f.effect);
  const L = f.load;
  return (
    <article data-finding={f.key} className={`${box} scroll-mt-4`}>
      <div className="flex items-center gap-2 flex-wrap text-[12px]">
        <span className={label}>{areaOf(f.category).name}</span>
        {lateH != null && (f.finishH > 0
          ? <span className="font-semibold px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--state-overdue)_12%,transparent)] text-[var(--state-overdue)]" data-finish-hours>{f.finishH} h of the {lateH} h late finish</span>
          : f.moved === 0 ? <span className="font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">Did not move the finish</span> : null)}
        {f.source === "person" && <span className="font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">Written in the review{f.by ? ` by ${f.by}` : ""}</span>}
        {f.source === "job" && <span className="font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">{f.where}</span>}
      </div>
      <h4 className="mt-1 text-[16px] font-semibold leading-snug text-[var(--color-text)]"><Tags text={f.title} /></h4>
      {head && <p className="mt-1 text-[14px] leading-relaxed text-[var(--color-text)]" data-finding-headline>{head}</p>}
      {showEffect && <p className="mt-1 text-[13px] font-semibold text-[var(--color-text)]" data-finding-effect>{f.effect}</p>}

      {L && <LoadBody L={L} tz={tz} canManage={canManage} busy={busy} onCrews={onCrews} />}
      {f.idle && (
        <div className="mt-3" data-idle>
          <IdleBars groups={f.idle.groups.slice(0, 8)} />
          {f.idle.groups.length > 8 && <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">And {f.idle.groups.length - 8} more in the jobs below.</p>}
        </div>
      )}
      {rest.length > 0 && <ul className="mt-2 space-y-1 text-[13.5px] text-[var(--color-text)] list-disc pl-5">{rest.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {f.info.length > 0 && <ul className="mt-2 space-y-1 text-[13px] text-[var(--color-text)]">{f.info.map((l, i) => <li key={i} className="border-l-2 border-[var(--color-border-strong)] pl-2">{l}</li>)}</ul>}

      {questions.map((q) => <QuestionLine key={q.key} q={q} said={answers[q.key]?.note ?? ""} canManage={canManage} busy={busy === `q:${q.key}`} onSave={(t) => onAnswer(q, t)} />)}

      {(f.jobs?.rows.length || (f.evidence.length > 0 && f.source !== "job")) ? (
        <details className="mt-3 group" data-finding-jobs>
          <summary className="cursor-pointer list-none inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--color-accent-text)]"><ChevronDown className="w-4 h-4 transition-transform group-open:rotate-180" />The jobs ({f.jobs?.rows.length ?? f.evidence.length})</summary>
          {f.jobs ? <JobsTable head={f.jobs.head} rows={f.jobs.rows} /> : <ul className="mt-2 space-y-1 text-[12.5px] text-[var(--color-text)] list-disc pl-5">{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </details>
      ) : null}

      {(f.ask || action != null) && f.rating !== "none" && f.rating !== "strength" && (
        <p className="mt-3 text-[13px] text-[var(--color-text)]"><span className={label}>Next time </span>{f.ask}{action != null && <span className="text-[var(--color-text-muted)]"> (action {action})</span>}</p>
      )}
      {canManage && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <div role="group" aria-label="Is this finding right?" className="inline-flex rounded-md border border-[var(--color-border-strong)] overflow-hidden">
            <button type="button" disabled={!!busy} onClick={() => { setWhy(null); if (f.auto) onKeep(); }} aria-pressed={why == null}
              title={f.auto ? "It is in the review. Keep also puts it in the lessons register." : "Kept, and in the lessons register."}
              className={`inline-flex items-center gap-1.5 h-10 sm:h-9 px-3 text-[13.5px] font-semibold ${why == null ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]" : "bg-[var(--color-surface)] text-[var(--color-text)]"}`}>
              {busy === `keep:${f.key}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {f.auto ? "Keep" : "Kept"}
            </button>
            <button type="button" disabled={!!busy} onClick={() => setWhy("")} aria-pressed={why != null}
              className={`inline-flex items-center gap-1.5 h-10 sm:h-9 px-3 text-[13.5px] font-semibold border-l border-[var(--color-border-strong)] ${why != null ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "bg-[var(--color-surface)] text-[var(--color-text)]"}`}>
              <X className="w-4 h-4" /> Not right
            </button>
          </div>
          {why != null && (
            <form className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1 basis-64" onSubmit={(e) => { e.preventDefault(); onNotRight(why); setWhy(null); }}>
              <input autoFocus value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What is not right? One line." aria-label="What is not right" className={`${field} min-w-0 flex-1 basis-48 h-10 sm:h-9 !py-0`} maxLength={300} />
              <button type="submit" disabled={!!busy} className={btn}>Take it out</button>
              <button type="button" onClick={() => setWhy(null)} className={link}>Cancel</button>
            </form>
          )}
        </div>
      )}
    </article>
  );
}

/** A party's load: the chart, where its planned number came from (and the
 *  place to set its crews), and the jobs that waited with what they held up. */
function LoadBody({ L, tz, canManage, busy, onCrews }: { L: PartyLoad; tz: string; canManage: boolean; busy: string | null; onCrews: (party: string, n: number | null) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const jobs = L.waited.length ? [...L.waited].sort((a, b) => a.ready - b.ready).slice(0, 8) : L.idle.slice(0, 6);
  const saving = busy === `crews:${L.party}`;
  return (
    <div className="mt-3" data-load={L.party}>
      <LoadChart load={L} tz={tz} />
      <div className="mt-2 text-[13px] text-[var(--color-text)]" data-planned-at-once>
        <span>{plannedWord(L, tz)}</span>{" "}
        {canManage && edit == null && <button type="button" className={link} onClick={() => setEdit(String(L.planned.n))}>Set {L.party}&apos;s crews</button>}
        {edit != null && (
          <form className="mt-1.5 flex items-center gap-1.5 flex-wrap" onSubmit={(e) => { e.preventDefault(); const n = Math.round(Number(edit)); if (n >= 1 && n <= 50) { onCrews(L.party, n); setEdit(null); } }}>
            <label className="inline-flex items-center gap-1.5 text-[13px]">Jobs {L.party} can work at once
              <input autoFocus type="number" inputMode="numeric" min={1} max={50} value={edit} onChange={(e) => setEdit(e.target.value)} className={`${field} !w-20 h-10 sm:h-9 !py-0`} />
            </label>
            <button type="submit" disabled={saving || !(Number(edit) >= 1 && Number(edit) <= 50)} className={btn}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save</button>
            {L.planned.from === "set" && <button type="button" className={link} onClick={() => { onCrews(L.party, null); setEdit(null); }}>Use the schedule&apos;s {L.planned.sched}</button>}
            <button type="button" className={link} onClick={() => setEdit(null)}>Cancel</button>
            <span className="basis-full text-[12px] text-[var(--color-text-muted)]">Kept with {L.party}&apos;s staffing settings for this phase. The review counts again with it.</span>
          </form>
        )}
      </div>
      {jobs.length > 0 && (
        <div className="mt-4">
          <h5 className="mb-1.5 text-[13px] font-semibold text-[var(--color-text)]">{L.waited.length ? `The jobs that waited for ${L.party}, and what they held up` : `${L.party}'s ready jobs with nobody on them`}</h5>
          <LoadStrip load={L} jobs={jobs} held={L.waited.length ? L.down.held : L.downIdle.held} tz={tz} />
        </div>
      )}
    </div>
  );
}

/** The one question the records leave open on a finding: optional, never in the way. */
function QuestionLine({ q, said, canManage, busy, onSave }: { q: Question; said: string; canManage: boolean; busy: boolean; onSave: (t: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="mt-3 rounded-md bg-[var(--color-surface-2)] px-3 py-2 text-[13px]" data-question={q.key}>
      <span className="text-[var(--color-text)]">{q.ask}</span>{" "}
      {said && text == null && <span className="text-[var(--color-text-muted)]">Answered.</span>}
      {canManage && text == null && <button type="button" className={link} onClick={() => setText(said)}>{said ? "Change the answer" : "Answer (optional)"}</button>}
      {text != null && (
        <form className="mt-1.5 flex items-center gap-1.5 flex-wrap" onSubmit={(e) => { e.preventDefault(); onSave(text); setText(null); }}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label={q.ask} placeholder="One line is enough" maxLength={1000} className={`${field} min-w-0 flex-1 basis-56 h-10 sm:h-9 !py-0`} />
          <button type="submit" disabled={busy} className={btn}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save</button>
          <button type="button" className={link} onClick={() => setText(null)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

/** A table that scrolls inside its box on a phone. */
function JobsTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="mt-2 rounded-lg border border-[var(--color-border)] overflow-x-auto max-w-full">
      <table className="w-full min-w-[640px] text-[12.5px] border-collapse">
        <thead><tr>{head.map((h) => <th key={h} scope="col" className="text-left px-2.5 py-2 bg-[var(--color-surface-2)] font-semibold text-[var(--color-text-muted)] border-b border-[var(--color-border)] whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b last:border-b-0 border-[var(--color-border)] align-top">{r.map((c, n) => <td key={n} className={`px-2.5 py-1.5 text-[var(--color-text)] ${n === 0 ? "font-semibold" : ""}`}>{c.split("\n").map((t, k) => <span key={k} className={k ? "block text-[var(--color-text-muted)]" : "block"}>{t}</span>)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** One action: what to change and why, from this event; owner and date set in place. */
function ActionLine({ a, kind, busy, canManage, onPlan, onDone, onGo }: { a: Action; kind: string | null; busy: boolean; canManage: boolean; onPlan: (p: { owner?: string; due?: string }) => void; onDone: (done: boolean) => void; onGo: () => void }) {
  return (
    <li className={`flex gap-3 text-[var(--color-text)] ${a.done ? "opacity-60" : ""}`} data-conclusion={a.key}>
      <span className="shrink-0 w-7 h-7 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text)] text-[13px] font-semibold flex items-center justify-center">{a.n}</span>
      <div className="min-w-0 flex-1">
        <b className="block text-[15px] leading-snug">{a.what}{a.done ? " (done)" : ""}</b>
        {a.benefit && <p className="mt-0.5 text-[13.5px] text-[var(--color-text)]">{a.benefit}</p>}
        <div className="mt-1 flex items-center gap-x-2 gap-y-1 flex-wrap text-[12.5px] text-[var(--color-text-muted)]">
          <span>{a.areaName} · {appliesWord(a.applies, kind)}</span>
          <button type="button" className={link} onClick={onGo}>See the finding</button>
        </div>
        <div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap text-[13px]">
          <InlineValue name="Owner" value={a.who} canManage={canManage} busy={busy} onSave={(v) => onPlan({ owner: v })} />
          <InlineValue name="By" value={a.by} canManage={canManage} busy={busy} onSave={(v) => onPlan({ due: v })} />
          {canManage && <button type="button" disabled={busy} className={link} onClick={() => onDone(!a.done)}>{a.done ? "Not done" : "Mark done"}</button>}
        </div>
      </div>
    </li>
  );
}
function InlineValue({ name, value, canManage, busy, onSave }: { name: string; value: string; canManage: boolean; busy: boolean; onSave: (v: string) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  if (edit != null) return (
    <form className="inline-flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); onSave(edit); setEdit(null); }}>
      <span className="text-[var(--color-text-muted)]">{name}</span>
      <input autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} aria-label={name} className={`${field} !w-40 h-9 !py-0`} maxLength={120} />
      <button type="submit" disabled={busy} className={link}>Save</button>
      <button type="button" className={link} onClick={() => setEdit(null)}>Cancel</button>
    </form>
  );
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[var(--color-text-muted)]">{name}:</span>
      <span className={value ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>{value || "not set"}</span>
      {canManage && <button type="button" disabled={busy} className={link} onClick={() => setEdit(value)}>{value ? "Change" : "Set"}</button>}
    </span>
  );
}

/** Text with each equipment tag kept on one line ("E-12" never splits at its hyphen). */
function Tags({ text }: { text: string }) {
  const parts = text.split(/(\b[A-Z]{1,4}-\d{1,5}[A-Z]{0,2}\b\.?)/);
  return <>{parts.map((t, i) => (i % 2 ? <span key={i} className="whitespace-nowrap">{t}</span> : t))}</>;
}

/** The category a new finding is filed under, for each of the seven areas. */
const AREA_CATEGORY: Record<AreaId, CategoryId> = { safety: "safety", organization: "organization", planning: "planning", contractors: "contractors", costs: "costs", logistics: "materials", execution: "execution" };
const RATING_PICK: Array<[Rating, string]> = [["gap", "It cost the event"], ["opportunity", "Do it differently next time"], ["strength", "It worked, keep it"]];

function FindingForm({ title, init, pickCategory, busy, onSave, onCancel, draftKey = null }: {
  title: string; init?: Finding; pickCategory?: boolean; busy: boolean;
  /** A new finding's draft, kept on this device (none when changing one). */
  draftKey?: string | null;
  onSave: (e: FindingEdit, category?: CategoryId) => void; onCancel: () => void;
}) {
  const [category, setCategory] = useState<CategoryId>(init ? AREA_CATEGORY[areaOf(init.category).id] : "materials");
  const [e, setE] = useState<FindingEdit>({ title: init?.title ?? "", observation: init?.observation ?? "", practice: init?.practice ?? "", gap: init?.gap ?? "", next: init?.next ?? "", year: init?.year ?? "", owner: init?.owner ?? "", due: init?.due ?? "", cost: init?.cost ?? "", effect: init?.effect ?? "", why: init?.why ?? "", ask: init?.ask ?? "", because: init?.because ?? "", rating: init?.rating ?? "opportunity" });
  const set = (k: keyof FindingEdit, v: string) => setE((x) => ({ ...x, [k]: v }));
  const draft = useDraft<FindingEdit>(draftKey, e, (v) => setE((x) => ({ ...x, ...v })),
    (v) => !Object.entries(v ?? {}).some(([k, t]) => k !== "rating" && typeof t === "string" && t.trim()));
  const Area = ({ k, name, hint, rows = 2 }: { k: "observation" | "gap" | "next" | "year" | "why"; name: string; hint: string; rows?: number }) => (
    <label className="block"><span className={label}>{name}</span><textarea rows={rows} value={e[k] ?? ""} onChange={(ev) => set(k, ev.target.value)} placeholder={hint} className={`${field} mt-0.5`} /></label>
  );
  const ok = !!(e.title ?? "").trim() && !!(e.observation ?? "").trim();
  return (
    <div className="space-y-2.5">
      <b className="block text-[14px] text-[var(--color-text)]">{title}</b>
      {draft.restored && <p className="text-[12px] text-[var(--color-text-muted)]">What you were writing is back.</p>}
      <div className="grid gap-2.5 sm:grid-cols-2">
        {pickCategory && <label className="block"><span className={label}>Area</span><select value={category} onChange={(ev) => setCategory(ev.target.value as CategoryId)} className={`${field} mt-0.5`}>{AREAS.map((a) => <option key={a.id} value={AREA_CATEGORY[a.id]}>{a.name}</option>)}</select></label>}
        <label className="block"><span className={label}>What it is</span><select value={e.rating} onChange={(ev) => setE((x) => ({ ...x, rating: ev.target.value as Rating }))} className={`${field} mt-0.5`}>{RATING_PICK.map(([r, w]) => <option key={r} value={r}>{w}</option>)}</select></label>
      </div>
      <label className="block"><span className={label}>Finding, in one line</span><input value={e.title ?? ""} onChange={(ev) => set("title", ev.target.value)} placeholder="Flange not ordered: the length was not on the drawing" className={`${field} mt-0.5`} /></label>
      {Area({ k: "observation", name: "What happened (one fact a line)", hint: "Which job, which crew, when", rows: 5 })}
      <label className="block"><span className={label}>What it cost</span><input value={e.effect ?? ""} onChange={(ev) => set("effect", ev.target.value)} placeholder="Hours on the finish, dollars, or rework" className={`${field} mt-0.5`} /></label>
      <label className="block"><span className={label}>What we will do, in one line</span><input value={e.ask ?? ""} onChange={(ev) => set("ask", ev.target.value)} placeholder="Bring a second cleaning crew for the days equipment opens." className={`${field} mt-0.5`} /></label>
      <label className="block"><span className={label}>The benefit, in one line (from this event)</span><input value={e.because ?? ""} onChange={(ev) => set("because", ev.target.value)} placeholder="7 jobs were open at once and equipment sat open 181.5 h." className={`${field} mt-0.5`} /></label>
      {Area({ k: "why", name: "What justifies a change (with the numbers)", hint: "Hours waited, hours over plan, what one more crew or one check would have saved" })}
      {Area({ k: "gap", name: "Root cause", hint: "What was missing or didn't work" })}
      {Area({ k: "next", name: "How it will be done", hint: "The steps, and what will be in place before the next event" })}
      {Area({ k: "year", name: "Longer term (optional)", hint: "What takes longer than one event" })}
      <div className="grid gap-2.5 sm:grid-cols-3">
        <label className="block"><span className={label}>Who will do it</span><input value={e.owner ?? ""} onChange={(ev) => set("owner", ev.target.value)} placeholder="Logistics coordinator" className={`${field} mt-0.5`} /></label>
        <label className="block"><span className={label}>By what date</span><input value={e.due ?? ""} onChange={(ev) => set("due", ev.target.value)} placeholder="Before scope freeze" className={`${field} mt-0.5`} /></label>
        <label className="block"><span className={label}>What it will cost</span><input value={e.cost ?? ""} onChange={(ev) => set("cost", ev.target.value)} placeholder="$ or hours" className={`${field} mt-0.5`} /></label>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <button type="button" disabled={!ok || busy} onClick={() => onSave(e, pickCategory ? category : undefined)} className={pri}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save</button>
        <button type="button" onClick={onCancel} className={btn}>Cancel</button>
        {!ok && <span className="text-[12px] text-[var(--color-text-muted)] self-center">Needs the finding and what happened.</span>}
      </div>
    </div>
  );
}
