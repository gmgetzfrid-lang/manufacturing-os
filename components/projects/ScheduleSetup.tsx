"use client";

// Schedule setup — one place for everything the schedule's reports hang
// on. A red banner names what's missing until it's done (it can't be
// dismissed), and the wizard walks through each item with what's in force
// now filled in, so confirming a right answer is one click.

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock, Factory, Flag, Globe2, HardHat, Loader2, Moon, Printer, Settings2, Sun, Tag, Zap } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { setupChecklist, missingRequired, toDo, OPEN_SETUP_EVENT, type SetupItem, type SetupItemId } from "@/lib/scheduleSetup";
import { useLetterhead } from "@/lib/letterheadStore";
import { LetterheadStep } from "@/components/projects/LetterheadSetup";
import { browserTimeZone, listTimeZones, tzLabel, DEFAULT_SCHEDULE_TZ } from "@/lib/scheduleTz";
import { updateProjectMeta } from "@/lib/projects";
import { useShiftTimes, useShiftTimesState, useShiftTimesSaved, saveProjectShiftTimes, shiftTimesProblem, saveProjectType } from "@/lib/shiftTimesStore";
import { PROJECT_TYPES, projectTypeOf, projectTypeSet, typeWord, type ProjectType } from "@/lib/projectType";
import { meetingLeadMin, workShiftOf, shiftAt, shiftWindow, type PullCrew, type ShiftTimes } from "@/lib/shiftReport";
import { stepBandDays } from "@/lib/shiftBands";
import { splitTag } from "@/lib/shiftSheet";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import { dayKey, dayKeyToMs, addDays } from "@/lib/scheduleTz";
import { applyNightStaffing, nightJobChoices, jobNightCrews, jobNightEntries, type JobChoice, type NightJobs } from "@/lib/nightStaffing";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { useCriticalMode, useCriticalModeLoaded, saveCriticalMode } from "@/lib/criticalModeStore";
import { CRITICAL_MODES, resolveCriticalPath, effectiveCriticalMode, type CriticalMode } from "@/lib/criticalPath";
import type { Milestone } from "@/types/schema";
import { EquipmentStep, useProjectEquipment } from "@/components/projects/EquipmentSetup";
import { ManpowerStep, useManpowerSettings, manpowerSet } from "@/components/projects/ManpowerSetup";

const ICON: Record<SetupItemId, typeof Clock> = { type: Tag, equipment: Factory, timezone: Globe2, shifts: Clock, night: Moon, critical: Zap, baseline: Flag, manpower: HardHat, print: Printer };
// Opened by itself once per project on this device — after that the banner
// (while anything's really missing) and the Setup button are the way in.
const SHOWN_KEY = (projectId: string) => `scheduleSetup.autoOpened:${projectId}`;

interface Props {
  projectId: string;
  /** Its name: the project type is read from it until one is set. */
  projectName?: string;
  /** The project's own zone (null = never set, running on UTC). */
  timezone: string | null | undefined;
  milestones: Milestone[];
  hasBaseline: boolean;
  /** Owner / admin: may change project settings. */
  canManage: boolean;
  /** May set the baseline. */
  canEdit: boolean;
  userId: string;
  onProjectChanged: () => void;
  onSetBaseline: () => Promise<void>;
}

/** Setup › Unit & equipment done: the unit picked, every work order's
 *  equipment confirmed (a codebook with no units: nothing to pick). */
function useEquipmentSet(p: Props): boolean | null {
  const orgId = p.milestones.find((m) => m.orgId)?.orgId ?? null;
  const eq = useProjectEquipment(orgId, p.projectId, p.milestones);
  if (!orgId) return true;
  return eq.data && eq.data.units.length === 0 ? true : eq.set;
}

/** The banner (while anything required is missing) and the wizard. */
export function ScheduleSetup(p: Props) {
  const saved = useShiftTimesSaved(p.projectId);
  const critical = useCriticalMode(p.projectId);
  const st = useShiftTimesState(p.projectId);
  // Not known until the project's saved settings are read: a new device has
  // no copy yet, and that isn't "not set".
  const nightDecided = st.loaded ? st.times.nightJobs !== undefined : null;
  const letterheadSet = !!useLetterhead(p.projectId).lh;
  const typeSet = projectTypeSet(st.times.projectType);
  const equipmentSet = useEquipmentSet(p);
  const mpSet = manpowerSet(useManpowerSettings(p.projectId));
  const items = useMemo(() => setupChecklist({
    timezoneSet: !!p.timezone, shiftTimesSaved: saved, criticalChosen: critical != null, hasBaseline: p.hasBaseline, nightDecided, letterheadSet, typeSet, equipmentSet, manpowerSet: mpSet,
  }), [p.timezone, saved, critical, p.hasBaseline, nightDecided, letterheadSet, typeSet, equipmentSet, mpSet]);
  const missing = missingRequired(items);
  // Opens by itself for someone who can fix it — only once everything has
  // been read (nothing "checking"), and only once on this device.
  const [open, setOpen] = useState<SetupItemId | null>(null);
  // Opened at a step from elsewhere on the page (the calendar's "Night
  // crews"), on whichever tab it is: this part is on all of them.
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<SetupItemId>).detail ?? missing[0]?.id ?? "timezone");
    window.addEventListener(OPEN_SETUP_EVENT, on);
    return () => window.removeEventListener(OPEN_SETUP_EVENT, on);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the step asked for; the first missing one is only a fallback
  }, []);
  const settled = !items.some((i) => i.checking);
  const first = p.canManage && settled ? missing[0]?.id : undefined;
  useEffect(() => {
    if (!first) return;
    try {
      if (localStorage.getItem(SHOWN_KEY(p.projectId)) === "1") return;
      localStorage.setItem(SHOWN_KEY(p.projectId), "1");
    } catch { /* private mode: the banner still shouts */ }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opens once, after the settings have loaded
    setOpen(first);
  }, [first, p.projectId]);

  return (
    <>
      {missing.length > 0 ? (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border-2 border-rose-400 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/50 px-3.5 py-3 text-rose-900 dark:text-rose-100">
          <AlertTriangle className="w-5 h-5 shrink-0 text-rose-600 dark:text-rose-400" />
          <div className="flex-1 min-w-[220px] text-[13px] leading-snug">
            <b>Finish setting up this schedule - the reports can&apos;t be trusted yet.</b>{" "}
            Missing: {missing.map((i) => i.label.toLowerCase()).join(" and ")}.
            <span className="block text-[12px] text-rose-800/90 dark:text-rose-200/80">{missing[0].why}</span>
          </div>
          {p.canManage ? (
            <button onClick={() => setOpen(missing[0].id)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[12.5px] font-bold px-3.5 py-2 shadow-sm">
              <Settings2 className="w-4 h-4" /> Finish setup
            </button>
          ) : (
            <span className="shrink-0 text-[12px] font-semibold">Ask the project owner to finish setup.</span>
          )}
        </div>
      ) : null}
      {open && <SetupWizard {...p} items={items} start={open} critical={critical} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The always-there way back in: "Setup ✓" / "Setup · 2 to do". */
export function ScheduleSetupButton(p: Props) {
  const saved = useShiftTimesSaved(p.projectId);
  const critical = useCriticalMode(p.projectId);
  const st = useShiftTimesState(p.projectId);
  const nightDecided = st.loaded ? st.times.nightJobs !== undefined : null;
  const letterheadSet = !!useLetterhead(p.projectId).lh;
  const equipmentSet = useEquipmentSet(p);
  const items = setupChecklist({ timezoneSet: !!p.timezone, shiftTimesSaved: saved, criticalChosen: critical != null, hasBaseline: p.hasBaseline, nightDecided, letterheadSet, typeSet: projectTypeSet(st.times.projectType), equipmentSet });
  const todo = toDo(items).length;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Project type, unit & equipment, time zone, shift times, night shifts, critical path, baseline, printed reports"
        className={`inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border shadow-sm transition-colors ${todo
          ? "text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 hover:bg-amber-100"
          : "text-[var(--color-text)] bg-[var(--color-surface)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
        <Settings2 className="w-3.5 h-3.5" /> Setup{todo ? ` · ${todo} to do` : <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />}
      </button>
      {open && <SetupWizard {...p} items={items} start={items.find((i) => !i.done && !i.extra)?.id ?? "timezone"} critical={critical} onClose={() => setOpen(false)} />}
    </>
  );
}

function SetupWizard({ items: given, start, critical, onClose: close, ...rest }: Props & { items: SetupItem[]; start: SetupItemId; critical: CriticalMode | null; onClose: () => void }) {
  // The project re-reads only when the wizard closes: re-reading mid-way
  // would reload the page under it and close it after step 1.
  const [tzSaved, setTzSaved] = useState<string | null>(null);
  const p = { ...rest, timezone: tzSaved ?? rest.timezone, onProjectChanged: () => undefined };
  const items = given.map((i) => (i.id === "timezone" && tzSaved ? { ...i, done: true } : i));
  const onClose = () => { close(); if (tzSaved) rest.onProjectChanged(); };
  const [at, setAt] = useState<SetupItemId>(start);
  const idx = items.findIndex((i) => i.id === at);
  const item = items[idx];
  const go = (d: number) => setAt(items[Math.max(0, Math.min(items.length - 1, idx + d))].id);
  // Optional extras (the letterhead) never count against "all set".
  const counted = items.filter((i) => !i.extra);
  const allDone = counted.every((i) => i.done);
  return (
    <Modal onClose={onClose} size={at === "night" ? "full" : at === "print" || at === "equipment" ? "xl" : "lg"}>
      <ModalHeader icon={Settings2} title="Schedule setup" subtitle="What the schedule's reports hang on - set once for everyone on the project." onClose={onClose} />
      <ModalBody className="p-0">
        <div className="flex flex-col sm:flex-row">
          {/* Steps */}
          <nav className="sm:w-56 shrink-0 border-b sm:border-b-0 sm:border-r border-[var(--color-border)] p-2 flex sm:flex-col gap-1 overflow-x-auto" aria-label="Setup steps">
            {items.map((i, n) => {
              const Icon = ICON[i.id];
              const on = i.id === at;
              return (
                <button key={i.id} onClick={() => setAt(i.id)} aria-current={on ? "step" : undefined}
                  className={`shrink-0 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] ${on ? "bg-[var(--color-surface-2)] font-bold text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${i.done
                    ? "bg-emerald-600 text-white" : i.required ? "bg-rose-600 text-white" : i.extra ? "bg-slate-400 text-white dark:bg-slate-600" : "bg-amber-500 text-white"}`}>
                    {i.done ? <Check className="w-3 h-3" /> : n + 1}
                  </span>
                  <Icon className="w-3.5 h-3.5 shrink-0 hidden sm:block" />
                  <span className="whitespace-nowrap">{i.label}</span>
                </button>
              );
            })}
          </nav>
          {/* The step */}
          <div className="flex-1 min-w-0 p-4 space-y-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-black text-[var(--color-text)]">{item.label}</h3>
                {item.checking ? <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">checking…</span> : item.done
                  ? <span className="text-[10px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-400">✓ set</span>
                  : <span className={`text-[10px] font-black uppercase tracking-wider ${item.required ? "text-rose-600 dark:text-rose-400" : item.extra ? "text-[var(--color-text-faint)]" : "text-amber-600 dark:text-amber-400"}`}>{item.required ? "needed" : item.extra ? "optional" : "advised"}</span>}
              </div>
              <p className="text-[12.5px] text-[var(--color-text-muted)] mt-0.5">{item.why}</p>
            </div>
            {at === "type" && <TypeStep {...p} onSaved={() => go(1)} />}
            {at === "equipment" && <EquipmentStep projectId={p.projectId} projectName={p.projectName} milestones={p.milestones} canManage={p.canManage} userId={p.userId} />}
            {at === "timezone" && <TimeZoneStep {...p} done={item.done} onSaved={(z) => { setTzSaved(z); go(1); }} />}
            {at === "shifts" && <ShiftsStep {...p} done={item.done} checking={!!item.checking} onSaved={() => go(1)} />}
            {/* Night shifts stay open after saving: they're changed as the job goes. */}
            {at === "night" && <NightStep {...p} done={item.done} onSaved={() => undefined} />}
            {at === "critical" && <CriticalStep {...p} critical={critical} onSaved={() => go(1)} />}
            {at === "baseline" && <BaselineStep {...p} done={item.done} />}
            {at === "manpower" && <ManpowerStep projectId={p.projectId} milestones={p.milestones} canManage={p.canManage} />}
            {at === "print" && <LetterheadStep projectId={p.projectId} canManage={p.canManage} />}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex items-center w-full gap-2">
          <button onClick={() => go(-1)} disabled={idx === 0} className="inline-flex items-center gap-1 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1.5 disabled:opacity-30">
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
          <span className="flex-1 text-center text-[11px] text-[var(--color-text-faint)]">{counted.filter((i) => i.done).length} of {counted.length} set</span>
          {idx < items.length - 1 ? (
            <button onClick={() => go(1)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-text)] px-2 py-1.5">
              {item.done ? "Next" : "Skip for now"} <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={onClose} className={`text-[12px] font-bold px-3 py-1.5 rounded-lg ${allDone ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "text-[var(--color-text)]"}`}>
              {allDone ? "All set - close" : "Close"}
            </button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}

const btn = "inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[12.5px] font-bold px-3.5 py-2 shadow-sm disabled:opacity-50";
const field = "h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-text)]";

function Msg({ err }: { err: string | null }) {
  return err ? <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div> : null;
}
function NoRights() {
  return <div className="text-[12px] text-[var(--color-text-muted)]">Only the project owner or an admin can change this.</div>;
}

/** Setup › Project type: the word the app says for the project, and its
 *  short form. Read from the project's name until it's set here. */
function TypeStep({ projectId, projectName, canManage, onSaved }: Props & { onSaved: () => void }) {
  const times = useShiftTimes(projectId);
  const now = projectTypeOf(times.projectType, projectName);
  const [t, setT] = useState<ProjectType>(now);
  const known = PROJECT_TYPES.find((x) => x.word === t.word);
  const [other, setOther] = useState(!PROJECT_TYPES.some((x) => x.word === now.word));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = projectTypeSet(times.projectType);
  const same = set && now.word === t.word.trim() && now.short === t.short.trim();
  const save = async () => {
    setBusy(true); setErr(null);
    try { await saveProjectType(projectId, t); onSaved(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!canManage) return <div className="text-[13px]">This project is a <b>{typeWord(now)}</b> ({now.short}).</div>;
  const pill = (on: boolean) => `h-9 px-3.5 rounded-full border text-[13px] font-bold ${on ? "bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;
  const w = typeWord({ word: t.word.trim() || "project", short: t.short });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Project type">
        {PROJECT_TYPES.map((x) => (
          <button key={x.word} type="button" aria-pressed={!other && t.word === x.word} onClick={() => { setOther(false); setT(x); }} className={pill(!other && t.word === x.word)}>{x.word}</button>
        ))}
        <button type="button" aria-pressed={other} onClick={() => { setOther(true); if (known) setT({ word: "", short: "" }); }} className={pill(other)}>Other…</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {other && (
          <label className="space-y-1"><span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Its word</span>
            <input value={t.word} onChange={(e) => setT({ word: e.target.value, short: t.short })} placeholder="e.g. Tie-in" maxLength={40} className={`${field} w-full`} /></label>
        )}
        <label className="space-y-1"><span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Short form</span>
          <input value={t.short} onChange={(e) => setT({ word: t.word, short: e.target.value })} placeholder={t.word || "e.g. TA"} maxLength={16} className={`${field} w-full`} /></label>
      </div>
      <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-2 text-[12px] text-[var(--color-text-muted)]">
        Shows as: &ldquo;2 h of work · task finish unchanged · <b className="text-[var(--color-text)]">{w}</b> finish unchanged&rdquo; · safety topic &ldquo;<b className="text-[var(--color-text)]">{t.word.trim() || "Project"}</b> · Transmix-1&rdquo; · &ldquo;e.g. <b className="text-[var(--color-text)]">{t.short.trim() || t.word.trim() || "Project"}</b> manager&rdquo;
      </div>
      {!set && <p className="text-[12px] text-[var(--color-text-muted)]">Read from the project&apos;s name for now. If it&apos;s right, just confirm.</p>}
      <Msg err={err} />
      <button onClick={() => void save()} disabled={busy || !t.word.trim() || same} className={btn}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} {same ? "Saved" : set ? "Save project type" : "This is right - confirm"}
      </button>
    </div>
  );
}

const US_ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York", "America/Anchorage", "Pacific/Honolulu"];

function TimeZoneStep({ projectId, timezone, canManage, userId, done, onSaved }: Props & { done: boolean; onSaved: (tz: string) => void }) {
  const here = browserTimeZone();
  const [tz, setTz] = useState(timezone || (here !== DEFAULT_SCHEDULE_TZ ? here : "America/Los_Angeles"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const all = useMemo(() => listTimeZones(), []);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await updateProjectMeta({ projectId, patch: { timezone: tz }, keepWallClock: true, actorUserId: userId });
      onSaved(tz);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!canManage) return done ? <div className="text-[13px]">Plant time: <b>{tzLabel(timezone!)}</b></div> : <NoRights />;
  return (
    <div className="space-y-2.5">
      <label className="block space-y-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">The plant&apos;s time zone</span>
        <select value={tz} onChange={(e) => setTz(e.target.value)} className={`${field} w-full`}>
          <optgroup label="US">{US_ZONES.map((z) => <option key={z} value={z}>{tzLabel(z)}</option>)}</optgroup>
          <optgroup label="All">{all.filter((z) => !US_ZONES.includes(z)).map((z) => <option key={z} value={z}>{z}</option>)}</optgroup>
        </select>
      </label>
      <p className="text-[12px] text-[var(--color-text-muted)]">Times on the schedule stay as written - 8:00 stays 8:00.</p>
      <Msg err={err} />
      <button onClick={() => void save()} disabled={busy || (done && tz === timezone)} className={btn}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} {done && tz === timezone ? "Saved" : timezone && tz === timezone ? "Confirm" : "Save time zone"}
      </button>
    </div>
  );
}

function ShiftsStep({ projectId, canManage, done, checking, onSaved }: Props & { done: boolean; checking: boolean; onSaved: () => void }) {
  const times = useShiftTimes(projectId);
  const [draft, setDraft] = useState<ShiftTimes | null>(null);
  const t = draft ?? times;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const problem = shiftTimesProblem(t);
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr(null);
    try { await saveProjectShiftTimes(projectId, { ...t, meetingBefore: meetingLeadMin(t) }); setDraft(null); onSaved(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!canManage && !done) return <NoRights />;
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <label className="space-y-1"><span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Day shift starts</span>
          <input type="time" disabled={!canManage} value={t.dayStart} onChange={(e) => setDraft({ ...t, dayStart: e.target.value })} className={`${field} w-full`} /></label>
        <label className="space-y-1"><span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Night shift starts</span>
          <input type="time" disabled={!canManage} value={t.nightStart} onChange={(e) => setDraft({ ...t, nightStart: e.target.value })} className={`${field} w-full`} /></label>
        <label className="space-y-1"><span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Turnover meeting</span>
          <span className="flex items-center gap-1.5"><input type="number" min={0} max={180} step={5} disabled={!canManage} value={meetingLeadMin(t)} onChange={(e) => setDraft({ ...t, meetingBefore: Number(e.target.value) })} className={`${field} w-20`} />
            <span className="text-[12px] text-[var(--color-text-muted)]">min before</span></span></label>
      </div>
      {!done && !draft && <p className="text-[12px] text-[var(--color-text-muted)]">These are filled in with what the app is using now. If they&apos;re right, just confirm.</p>}
      <Msg err={err} />
      {canManage && (
        <button onClick={() => void save()} disabled={busy || (done && !draft) || (checking && !draft)} className={btn}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {checking && !draft ? "Reading the saved times…" : done && !draft ? "Saved" : draft ? "Save shift times" : "These are right - confirm"}
        </button>
      )}
    </div>
  );
}

type JobMode = "day" | "all" | "some";

/** Night setup, by job: every job works days; a job the schedule puts in
 *  night hours either stays on days (its night hours wait for the day
 *  crew) or runs days and nights, with all its crews on nights or only
 *  some. Beside it, the shifts as they'll come out: each date's day shift
 *  and night shift side by side, so a round-the-clock job shows on both. */
function NightStep({ projectId, milestones: given, canManage, done, onSaved }: Props & { done: boolean; onSaved: () => void }) {
  const tz = useScheduleTz();
  const { times, loaded } = useShiftTimesState(projectId);
  const saved: NightJobs | undefined = times.nightJobs;
  // The schedule as the file has it: the saved night setting off, so what's
  // shown follows the choices made here, not the last ones saved.
  const milestones = useMemo(() => given.map((m) => (m.staffedShift ? { ...m, staffedShift: null } : m)), [given]);
  const fileShift = useMemo(() => (m: Milestone) => workShiftOf(m, tz, times), [tz, times]);
  const jobs = useMemo(() => nightJobChoices(milestones, (m) => fileShift(m) !== "day"), [milestones, fileShift]);
  const [fileMode, setFileMode] = useState(saved === "file");
  const [picks, setPicks] = useState<Map<string, Set<string>>>(() => jobNightCrews(jobs, Array.isArray(saved) ? saved : []));
  // The saved setting can arrive after this opens (a new device): until a
  // choice is made here, show what's saved.
  const [touched, setTouched] = useState(false);
  const savedKey = JSON.stringify(saved ?? null) + jobs.length;
  const [shownKey, setShownKey] = useState(savedKey);
  if (!touched && savedKey !== shownKey) {
    setShownKey(savedKey);
    setFileMode(saved === "file");
    setPicks(jobNightCrews(jobs, Array.isArray(saved) ? saved : []));
  }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  // Hands kept for extra work the turnover pulls forward (optional).
  const [edited, setEdited] = useState<PullCrew | null | undefined>(undefined);
  const chosen: PullCrew | null = edited === undefined ? times.helpers ?? null : edited;
  const helpers: PullCrew = chosen ?? { crew: null, hands: 2, hours: 12 };
  const setHelpers = (p: PullCrew) => setEdited(p);
  const [showHelpers, setShowHelpers] = useState(!!times.helpers);
  const crews = useMemo(() => [...new Set(milestones.map((m) => m.responsibleParty?.trim()).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [milestones]);
  const modeOf = (j: JobChoice): JobMode => { const p = picks.get(j.id); return !p || p.size === 0 ? "day" : p.has("*") ? "all" : "some"; };
  const setJob = (id: string, v: Set<string> | null) => {
    setSavedNow(false); setTouched(true);
    setPicks((cur) => { const n = new Map(cur); if (v && v.size) n.set(id, v); else n.delete(id); return n; });
  };
  const entries = jobNightEntries(picks);
  const next: NightJobs = fileMode ? "file" : entries;
  const savedNorm = saved === "file" ? "file" : Array.isArray(saved) ? jobNightEntries(jobNightCrews(jobs, saved)) : undefined;
  const helpersSame = JSON.stringify(chosen) === JSON.stringify(times.helpers ?? null);
  const same = helpersSame && JSON.stringify(next) === JSON.stringify(savedNorm) && JSON.stringify(saved) === JSON.stringify(savedNorm);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await saveProjectShiftTimes(projectId, { ...times, nightJobs: next, helpers: chosen ?? undefined }); setEdited(undefined); setSavedNow(true); onSaved(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  // Each tap saves (a moment after the last one): nothing's lost by going
  // on to the next step without pressing Save.
  const pendingKey = JSON.stringify(next) + JSON.stringify(chosen);
  useEffect(() => {
    if (!canManage || !loaded || busy || same || (!touched && edited === undefined)) return;
    const t = setTimeout(() => { void save(); }, 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- save reads the latest choices; the key is what changed
  }, [pendingKey, canManage, loaded, same, touched, edited]);

  // ── The shifts as they'll come out: the same rule the calendar and the
  // turnover use (lib/shiftBands), on the choices made here.
  const entriesKey = entries.join("|");
  const parents = useMemo(() => new Set(milestones.map((m) => m.parentId).filter(Boolean) as string[]), [milestones]);
  const byId = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m])), [milestones]);
  const plan = useMemo(() => {
    const staffed = withWorkOrderCrews(applyNightStaffing(milestones, fileMode ? "file" : entriesKey ? entriesKey.split("|") : []));
    return staffed.filter((m) => m.id && !parents.has(m.id)).map((m) => ({ m, bands: stepBandDays(m, tz, times), now: workShiftOf(m, tz, times) }));
  }, [milestones, fileMode, entriesKey, parents, tz, times]);
  // Start on today, or the job's first day when it hasn't started.
  const firstDay = useMemo(() => {
    const today = shiftAt(Date.now(), tz, times).dayKey;
    const starts = plan.map((x) => startMsOf(x.m)).filter(Number.isFinite);
    const first = starts.length ? dayKey(Math.min(...starts), tz) : today;
    return first > today ? first : today;
  }, [plan, tz, times]);
  const [offset, setOffset] = useState(0);
  const dayKeys = [0, 1, 2].map((i) => dayKey(addDays(dayKeyToMs(firstDay, tz), offset + i, tz), tz));
  // Night hours in the file that no night crew is on: they wait for days.
  const waiting = plan.filter((x) => fileShift(x.m) !== "day" && x.now === "day" && x.m.status !== "completed" && finishMsOf(x.m) > Date.now());
  const dayF = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }), [tz]);
  const clockF = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }), [tz]);
  const crewName = (c: string) => c || "No crew named";
  const jobOf = (m: Milestone) => (m.parentId ? byId.get(m.parentId) : undefined);
  // "E-12" for "E-12 - Transmix Feed..."; a name with no tag in front, whole.
  const short = (name: string) => splitTag(name).tag ?? name;
  // One shift's jobs: each with its crews and steps.
  const shiftJobs = (k: string, band: "day" | "night") => {
    const rows = plan.filter((x) => x.bands[band].has(k) && x.m.status !== "completed");
    const by = new Map<string, { name: string; crews: Set<string>; steps: number }>();
    for (const { m } of rows) {
      const j = jobOf(m);
      const key = j?.id ?? m.id!;
      const cur = by.get(key) ?? { name: short(j?.name ?? m.name), crews: new Set<string>(), steps: 0 };
      cur.crews.add(crewName(m.responsibleParty?.trim() ?? "")); cur.steps++;
      by.set(key, cur);
    }
    return [...by.values()];
  };
  const onJobs = jobs.filter((j) => modeOf(j) !== "day");
  // Saved for crews that aren't on the schedule (renamed, or from another
  // file): they put nothing on nights, and Save drops them.
  const stale = useMemo(() => {
    if (!Array.isArray(saved)) return [];
    const have = new Set([...crews, ...jobs.flatMap((j) => j.crews)].map((c) => c.trim().toLowerCase()));
    const out = new Set<string>();
    for (const e of saved) {
      const m = /^crew:[^:]*:(.*)$/.exec(e);
      if (m && m[1].trim() && !have.has(m[1].trim().toLowerCase())) out.add(m[1].trim());
    }
    return [...out];
  }, [saved, crews, jobs]);
  const seg = (on: boolean, night: boolean) => `px-2.5 py-1.5 border-l first:border-l-0 border-[var(--color-border-strong)] ${on ? (night ? "bg-violet-700 text-white" : "bg-sky-700 text-white") : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text)]">
        <b>Every job works days.</b> These jobs also have work the schedule puts in night hours. For each: keep it on <b>days only</b> (its night hours wait for the day crew), or run it <b>days and nights</b>. The shifts shown here change as you choose.
      </div>

      {stale.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 text-[12.5px] text-amber-900 dark:text-amber-200">
          <b>Saved for crews that aren&apos;t on this schedule:</b> {stale.join(", ")}. They put nothing on nights. Set the jobs below and Save - these names are dropped then.
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
        {/* Jobs */}
        <div className="space-y-2 min-w-0">
          <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Jobs with night hours</div>
          <div className={`rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] ${fileMode ? "opacity-50 pointer-events-none" : ""}`}>
            {jobs.length === 0 && <div className="px-3 py-3 text-[13px] text-[var(--color-text-muted)]">{milestones.length ? "Nothing on the schedule is in night hours: it's all day work." : "No steps yet - import the schedule first."}</div>}
            {jobs.map((j) => {
              const mode = modeOf(j);
              const p = picks.get(j.id);
              return (
                <div key={j.id} className={`px-3 py-2.5 space-y-2 ${mode !== "day" ? "bg-violet-50/70 dark:bg-violet-950/25" : ""}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <div className="min-w-[160px] flex-1">
                      <div className="text-[14px] font-bold text-[var(--color-text)]" title={j.crumbs}>{j.name}</div>
                      <div className="text-[11.5px] text-[var(--color-text-muted)]">
                        {j.crews.map(crewName).join(", ")} · <span className="text-violet-700 dark:text-violet-300">{j.nightSteps} of {j.steps} step{j.steps === 1 ? "" : "s"} in night hours</span>
                      </div>
                    </div>
                    <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden text-[12px] font-bold" role="radiogroup" aria-label={`${j.name}: shifts`}>
                      <button type="button" role="radio" aria-checked={mode === "day"} disabled={!canManage} onClick={() => setJob(j.id, null)} className={seg(mode === "day", false)}>Days only</button>
                      <button type="button" role="radio" aria-checked={mode !== "day"} disabled={!canManage} onClick={() => { if (mode !== "all") setJob(j.id, new Set(["*"])); }} title="All its crews on nights (tap a crew below to leave one on days)" className={seg(mode !== "day", true)}>Days and nights</button>
                    </div>
                  </div>
                  {mode !== "day" && j.crews.length > 1 && (
                    <div className="space-y-1">
                      <div className="text-[11.5px] text-[var(--color-text-muted)]">On nights:</div>
                      <div className="flex flex-wrap gap-1.5">
                        {j.crews.map((c) => {
                          const on = mode === "all" || [...(p ?? [])].some((x) => x.trim().toLowerCase() === c.trim().toLowerCase());
                          return (
                            <button key={c || "__none"} type="button" disabled={!canManage} aria-pressed={on}
                              onClick={() => {
                                const cur = mode === "all" ? new Set(j.crews) : new Set([...(p ?? [])]);
                                const has = [...cur].find((x) => x.trim().toLowerCase() === c.trim().toLowerCase());
                                if (has != null) cur.delete(has); else cur.add(c);
                                setJob(j.id, cur.size === 0 ? null : j.crews.every((x) => [...cur].some((y) => y.trim().toLowerCase() === x.trim().toLowerCase())) ? new Set(["*"]) : cur);
                              }}
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${on ? "bg-violet-700 border-violet-700 text-white" : "bg-[var(--color-surface)] border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                              {on ? <Moon className="w-3 h-3" aria-hidden /> : null}{crewName(c)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <label className="flex items-start gap-2 text-[12px] text-[var(--color-text-muted)] cursor-pointer">
            <input type="checkbox" className="mt-0.5" disabled={!canManage} checked={fileMode} onChange={(e) => { setFileMode(e.target.checked); setSavedNow(false); setTouched(true); }} />
            <span>Skip this - anything the schedule file puts in night hours is night work.</span>
          </label>
        </div>

        {/* The shifts as they'll come out — kept in view while the jobs scroll. */}
        <div className="order-first xl:order-none space-y-2 min-w-0 xl:sticky xl:top-0 xl:self-start xl:max-h-[calc(100vh-220px)] xl:overflow-y-auto">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">The shifts</span>
            <span className="ml-auto inline-flex items-center gap-1">
              <button type="button" onClick={() => setOffset((o) => o - 3)} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]" aria-label="Earlier days"><ChevronLeft className="w-4 h-4" /></button>
              {offset !== 0 && <button type="button" onClick={() => setOffset(0)} className="px-2 h-7 rounded-md border border-[var(--color-border)] text-[11px] font-bold hover:bg-[var(--color-surface-2)]">Back</button>}
              <button type="button" onClick={() => setOffset((o) => o + 3)} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]" aria-label="Later days"><ChevronRight className="w-4 h-4" /></button>
            </span>
          </div>
          {dayKeys.map((k) => {
            const dw = shiftWindow(k, "day", tz, times), nw = shiftWindow(k, "night", tz, times);
            const band = (b: "day" | "night", w: { start: number; end: number }) => {
              const list = shiftJobs(k, b);
              const night = b === "night";
              return (
                <div className={`min-w-0 rounded-md border ${night ? "border-violet-200 dark:border-violet-900 bg-violet-50/60 dark:bg-violet-950/20" : "border-sky-200 dark:border-sky-900 bg-sky-50/60 dark:bg-sky-950/20"}`}>
                  <div className={`px-2.5 py-1 flex items-center gap-1.5 text-[11.5px] font-black ${night ? "text-violet-900 dark:text-violet-200" : "text-sky-900 dark:text-sky-200"}`}>
                    {night ? <Moon className="w-3.5 h-3.5" aria-hidden /> : <Sun className="w-3.5 h-3.5" aria-hidden />}{night ? "Night" : "Day"}
                    <span className="font-semibold opacity-80">{clockF.format(w.start)}</span>
                    <span className="ml-auto font-semibold opacity-80">{list.reduce((n, x) => n + x.steps, 0)} step{list.reduce((n, x) => n + x.steps, 0) === 1 ? "" : "s"}</span>
                  </div>
                  {list.length === 0 ? <div className="px-2.5 pb-1.5 text-[11.5px] text-[var(--color-text-muted)]">No work.</div> : (
                    <ul className="px-2.5 pb-1.5 space-y-0.5">
                      {list.map((x) => (
                        <li key={x.name} className="grid grid-cols-[1fr_auto] gap-2 text-[12px]">
                          <span className="min-w-0 truncate"><b>{x.name}</b> <span className="text-[var(--color-text-muted)]">{[...x.crews].join(", ")}</span></span>
                          <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">{x.steps}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            };
            return (
              <div key={k} className="rounded-lg border border-[var(--color-border)] overflow-hidden">
                <div className="px-3 py-1.5 text-[12.5px] font-black bg-[var(--color-surface-2)]">{dayF.format(dw.start)}</div>
                <div className="p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">{band("day", dw)}{band("night", nw)}</div>
              </div>
            );
          })}
          {waiting.length > 0 && (
            <details className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30">
              <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-bold text-amber-900 dark:text-amber-200">
                {waiting.length} step{waiting.length === 1 ? "" : "s"} in night hours on days-only jobs - they wait for the day shift
              </summary>
              <ul className="px-3 pb-2 space-y-0.5">
                {waiting.sort((a, b) => startMsOf(a.m) - startMsOf(b.m)).map(({ m }) => (
                  <li key={m.id} className="grid grid-cols-[1fr_auto] gap-2 text-[12px]">
                    <span className="min-w-0 truncate text-[var(--color-text)]"><b>{short(jobOf(m)?.name ?? "")}</b> · {m.name} · {crewName(m.responsibleParty?.trim() ?? "")}</span>
                    <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{dayF.format(startMsOf(m)).split(",")[0]} {clockF.format(startMsOf(m))}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {/* The whole choice, in a line */}
      <div className="rounded-lg border-2 border-violet-200 dark:border-violet-900 bg-violet-50/60 dark:bg-violet-950/30 px-4 py-2.5 text-[13px] text-[var(--color-text)]">
        <b>Days and nights:</b> {fileMode ? "whatever the schedule file puts in night hours." : onJobs.length === 0 ? "none - every job works days only." : onJobs.map((j) => {
          const p = picks.get(j.id)!;
          return `${short(j.name)}${p.has("*") ? "" : ` (${[...p].map(crewName).join(", ")} on nights)`}`;
        }).join("; ")}
      </div>

      <div className="rounded-lg border border-[var(--color-border)]">
        <button type="button" onClick={() => setShowHelpers((v) => !v)} className="w-full flex items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-bold text-[var(--color-text)]">
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showHelpers ? "rotate-90" : ""}`} />
          Extra hands for work pulled forward <span className="font-normal text-[12px] text-[var(--color-text-muted)]">- optional{chosen ? `: ${chosen.crew ?? "crew not set"}, ${chosen.hands} × ${chosen.hours} h` : ""}</span>
        </button>
        {showHelpers && (
          <div className="px-3 pb-2.5 space-y-1.5">
            <div className="text-[12px] text-[var(--color-text-muted)]">The crew you keep for extra work the turnover pulls forward (&ldquo;Add work for the night shift&rdquo;), and its usual size. Changeable on each turnover.</div>
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <select disabled={!canManage} value={helpers.crew ?? ""} onChange={(e) => setHelpers({ ...helpers, crew: e.target.value || null })} aria-label="Crew for extra work" className={`${field} max-w-[240px]`}>
                <option value="">Not set</option>
                {crews.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input type="number" min={0} max={50} disabled={!canManage} value={helpers.hands} onChange={(e) => setHelpers({ ...helpers, hands: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })} aria-label="Hands" className={`${field} w-16`} />
              <span className="text-[var(--color-text-muted)]">hands ×</span>
              <input type="number" min={0} max={24} step={0.5} disabled={!canManage} value={helpers.hours} onChange={(e) => setHelpers({ ...helpers, hours: Math.max(0, Math.min(24, Number(e.target.value) || 0)) })} aria-label="Hours each" className={`${field} w-16`} />
              <span className="text-[var(--color-text-muted)]">h</span>
              {chosen && canManage && <button type="button" onClick={() => setEdited(null)} className="text-[11.5px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline">Clear</button>}
            </div>
          </div>
        )}
      </div>
      <Msg err={err} />
      {canManage ? (
        <div className="flex items-center gap-3">
          <button onClick={() => void save()} disabled={busy || !loaded || (done && same)} className={btn}>
            {(busy || !loaded) && <Loader2 className="w-4 h-4 animate-spin" />} {!loaded ? "Reading your saved night setup…" : done && same ? "Saved" : "Save"}
          </button>
          {savedNow && <span className="text-[12px] font-semibold text-emerald-700 dark:text-emerald-400">Saved - the calendar, the turnover and the shift sheet follow it now.</span>}
        </div>
      ) : <NoRights />}
    </div>
  );
}

function CriticalStep({ projectId, milestones, canManage, critical, onSaved }: Props & { critical: CriticalMode | null; onSaved: () => void }) {
  const inForce = effectiveCriticalMode(milestones, critical);
  const tz = useScheduleTz();
  // Not until the saved choice has been read — never preselect over it.
  const loaded = useCriticalModeLoaded(projectId);
  const [picked, setPick] = useState<CriticalMode | null>(null);
  const pick = picked ?? critical ?? inForce;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const counts = useMemo(() => {
    const leaves = new Set(milestones.map((m) => m.parentId).filter(Boolean));
    const steps = milestones.filter((m) => m.id && !leaves.has(m.id) && m.status !== "completed").length;
    return { steps, of: Object.fromEntries(CRITICAL_MODES.map((o) => [o.value, resolveCriticalPath(milestones, o.value, { tz }).ids.size])) as Record<CriticalMode, number> };
  }, [milestones, tz]);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await saveCriticalMode(projectId, pick); onSaved(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-2">
      {CRITICAL_MODES.map((o) => (
        <label key={o.value} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer ${pick === o.value ? "border-orange-400 bg-orange-50 dark:border-orange-700 dark:bg-orange-950/40" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
          <input type="radio" name="crit" disabled={!canManage} checked={pick === o.value} onChange={() => setPick(o.value)} className="mt-1" />
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-bold text-[var(--color-text)]">{o.label}</span>
            <span className="block text-[12px] text-[var(--color-text-muted)]">{o.hint}</span>
          </span>
          <span className="shrink-0 text-[12px] font-mono text-[var(--color-text-muted)]">{counts.of[o.value]} of {counts.steps} open steps</span>
        </label>
      ))}
      <p className="text-[12px] text-[var(--color-text-muted)]">Mark any task Critical / Not critical on its card afterwards - that wins over this.</p>
      <Msg err={err} />
      {canManage ? (
        <button onClick={() => void save()} disabled={busy || !loaded || critical === pick} className={btn}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {!loaded ? "Reading the saved choice…" : critical === pick ? "Saved" : critical == null && pick === inForce ? "Confirm" : "Save"}
        </button>
      ) : <NoRights />}
    </div>
  );
}

function BaselineStep({ milestones, canEdit, done, onSetBaseline }: Props & { done: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const when = useMemo(() => {
    const t = milestones.map((m) => Date.parse(String(m.baselineSetAt ?? ""))).filter(Number.isFinite);
    return t.length ? new Date(Math.max(...t)) : null;
  }, [milestones]);
  if (done) {
    return <div className="text-[13px] text-[var(--color-text)]">Progress is measured against the plan captured {when ? <b>{when.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</b> : "earlier"}. Re-baseline from the schedule toolbar only if the plan was formally changed.</div>;
  }
  if (!canEdit) return <NoRights />;
  if (milestones.length === 0) return <div className="text-[12.5px] text-[var(--color-text-muted)]">Import the schedule first - then capture it here.</div>;
  return (
    <div className="space-y-2.5">
      <p className="text-[12.5px] text-[var(--color-text)]">Capture the plan as it stands now. From then on, a step moved later still counts as late against it.</p>
      <Msg err={err} />
      <button disabled={busy} className={btn} onClick={async () => {
        setBusy(true); setErr(null);
        try { await onSetBaseline(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} Set the baseline now
      </button>
    </div>
  );
}
