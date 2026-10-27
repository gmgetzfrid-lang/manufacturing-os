"use client";

// Schedule setup — one place for everything the schedule's reports hang
// on. A red banner names what's missing until it's done (it can't be
// dismissed), and the wizard walks through each item with what's in force
// now filled in, so confirming a right answer is one click.

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock, Flag, Globe2, Loader2, Moon, Settings2, Zap } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { setupChecklist, missingRequired, OPEN_SETUP_EVENT, type SetupItem, type SetupItemId } from "@/lib/scheduleSetup";
import { browserTimeZone, listTimeZones, tzLabel, DEFAULT_SCHEDULE_TZ } from "@/lib/scheduleTz";
import { updateProjectMeta } from "@/lib/projects";
import { useShiftTimes, useShiftTimesState, useShiftTimesSaved, saveProjectShiftTimes, shiftTimesProblem } from "@/lib/shiftTimesStore";
import { meetingLeadMin, workShiftOf, shiftAt, shiftWindow, type PullCrew, type ShiftTimes } from "@/lib/shiftReport";
import { stepBandDays } from "@/lib/shiftBands";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import { dayKey, dayKeyToMs, addDays } from "@/lib/scheduleTz";
import { applyNightStaffing, nightCrewChoices, toCrewEntries, crewEntry, parseEntry, type NightJobs } from "@/lib/nightStaffing";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { useCriticalMode, useCriticalModeLoaded, saveCriticalMode } from "@/lib/criticalModeStore";
import { CRITICAL_MODES, resolveCriticalPath, effectiveCriticalMode, type CriticalMode } from "@/lib/criticalPath";
import type { Milestone } from "@/types/schema";

const ICON: Record<SetupItemId, typeof Clock> = { timezone: Globe2, shifts: Clock, night: Moon, critical: Zap, baseline: Flag };
// Opened by itself once per project on this device — after that the banner
// (while anything's really missing) and the Setup button are the way in.
const SHOWN_KEY = (projectId: string) => `scheduleSetup.autoOpened:${projectId}`;

interface Props {
  projectId: string;
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

/** The banner (while anything required is missing) and the wizard. */
export function ScheduleSetup(p: Props) {
  const saved = useShiftTimesSaved(p.projectId);
  const critical = useCriticalMode(p.projectId);
  const st = useShiftTimesState(p.projectId);
  // Not known until the project's saved settings are read: a new device has
  // no copy yet, and that isn't "not set".
  const nightDecided = st.loaded ? st.times.nightJobs !== undefined : null;
  const items = useMemo(() => setupChecklist({
    timezoneSet: !!p.timezone, shiftTimesSaved: saved, criticalChosen: critical != null, hasBaseline: p.hasBaseline, nightDecided,
  }), [p.timezone, saved, critical, p.hasBaseline, nightDecided]);
  const missing = missingRequired(items);
  // Opens by itself for someone who can fix it — only once everything has
  // been read (nothing "checking"), and only once on this device.
  const [open, setOpen] = useState<SetupItemId | null>(null);
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
            <b>Finish setting up this schedule — the reports can&apos;t be trusted yet.</b>{" "}
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
  const items = setupChecklist({ timezoneSet: !!p.timezone, shiftTimesSaved: saved, criticalChosen: critical != null, hasBaseline: p.hasBaseline, nightDecided });
  const todo = items.filter((i) => !i.done && !i.checking).length;
  const [open, setOpen] = useState(false);
  // Opened at a step from elsewhere on the page (the calendar's "Night crews").
  const [at, setAt] = useState<SetupItemId | null>(null);
  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent<SetupItemId>).detail; setAt(id ?? null); setOpen(true); };
    window.addEventListener(OPEN_SETUP_EVENT, on);
    return () => window.removeEventListener(OPEN_SETUP_EVENT, on);
  }, []);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Time zone, shift times, critical path, baseline"
        className={`inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border shadow-sm transition-colors ${todo
          ? "text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 hover:bg-amber-100"
          : "text-[var(--color-text)] bg-[var(--color-surface)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
        <Settings2 className="w-3.5 h-3.5" /> Setup{todo ? ` · ${todo} to do` : <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />}
      </button>
      {open && <SetupWizard {...p} items={items} start={at ?? items.find((i) => !i.done)?.id ?? "timezone"} critical={critical} onClose={() => { setOpen(false); setAt(null); }} />}
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
  const allDone = items.every((i) => i.done);
  return (
    <Modal onClose={onClose} size={at === "night" ? "full" : "lg"}>
      <ModalHeader icon={Settings2} title="Schedule setup" subtitle="What the schedule's reports hang on — set once for everyone on the project." onClose={onClose} />
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
                    ? "bg-emerald-600 text-white" : i.required ? "bg-rose-600 text-white" : "bg-amber-500 text-white"}`}>
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
                  : <span className={`text-[10px] font-black uppercase tracking-wider ${item.required ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"}`}>{item.required ? "needed" : "advised"}</span>}
              </div>
              <p className="text-[12.5px] text-[var(--color-text-muted)] mt-0.5">{item.why}</p>
            </div>
            {at === "timezone" && <TimeZoneStep {...p} done={item.done} onSaved={(z) => { setTzSaved(z); go(1); }} />}
            {at === "shifts" && <ShiftsStep {...p} done={item.done} checking={!!item.checking} onSaved={() => go(1)} />}
            {/* Night crews stay open after saving: they're changed as the job goes. */}
            {at === "night" && <NightStep {...p} done={item.done} onSaved={() => undefined} />}
            {at === "critical" && <CriticalStep {...p} critical={critical} onSaved={() => go(1)} />}
            {at === "baseline" && <BaselineStep {...p} done={item.done} />}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex items-center w-full gap-2">
          <button onClick={() => go(-1)} disabled={idx === 0} className="inline-flex items-center gap-1 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1.5 disabled:opacity-30">
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
          <span className="flex-1 text-center text-[11px] text-[var(--color-text-faint)]">{items.filter((i) => i.done).length} of {items.length} set</span>
          {idx < items.length - 1 ? (
            <button onClick={() => go(1)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-text)] px-2 py-1.5">
              {item.done ? "Next" : "Skip for now"} <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={onClose} className={`text-[12px] font-bold px-3 py-1.5 rounded-lg ${allDone ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "text-[var(--color-text)]"}`}>
              {allDone ? "All set — close" : "Close"}
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
      <p className="text-[12px] text-[var(--color-text-muted)]">Times on the schedule stay as written — 8:00 stays 8:00.</p>
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
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {checking && !draft ? "Reading the saved times…" : done && !draft ? "Saved" : draft ? "Save shift times" : "These are right — confirm"}
        </button>
      )}
    </div>
  );
}

type CrewPick = { all: boolean; jobs: Set<string> };
type NightMode = "none" | "all" | "some";

/** Night crews, the way the site thinks about them: every crew works days;
 *  some also have a night crew — on all their work (Ancon), or only on
 *  certain jobs (Schultz on the V-7 tower). Beside it, the nights as they'll
 *  come out — every step each night crew has, night by night — and the
 *  night work nobody's on, which waits for the day shift. */
function NightStep({ projectId, milestones: given, canManage, done, onSaved }: Props & { done: boolean; onSaved: () => void }) {
  const tz = useScheduleTz();
  const { times, loaded } = useShiftTimesState(projectId);
  const saved: NightJobs | undefined = times.nightJobs;
  // The schedule as the file has it: the saved night setting off, so what's
  // shown follows the choices made here, not the last ones saved.
  const milestones = useMemo(() => given.map((m) => (m.staffedShift ? { ...m, staffedShift: null } : m)), [given]);
  const [fileMode, setFileMode] = useState(saved === "file");
  const [picks, setPicks] = useState<Map<string, CrewPick>>(() => fromEntries(Array.isArray(saved) ? toCrewEntries(milestones, saved) : []));
  // The saved setting can arrive after this opens (a new device): until a
  // choice is made here, show what's saved.
  const [touched, setTouched] = useState(false);
  const savedKey = JSON.stringify(saved ?? null);
  const [shownKey, setShownKey] = useState(savedKey);
  if (!touched && savedKey !== shownKey) {
    setShownKey(savedKey);
    setFileMode(saved === "file");
    setPicks(fromEntries(Array.isArray(saved) ? toCrewEntries(milestones, saved) : []));
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
  const fileShift = useMemo(() => (m: Milestone) => workShiftOf(m, tz, times), [tz, times]);
  const choices = useMemo(() => nightCrewChoices(milestones, (m) => fileShift(m) !== "day"), [milestones, fileShift]);
  const key = (crew: string) => crew.trim().toLowerCase();
  const pickOf = (crew: string) => picks.get(key(crew));
  const modeOf = (crew: string): NightMode => { const p = pickOf(crew); return !p ? "none" : p.all ? "all" : "some"; };
  const isOn = (crew: string) => { const p = pickOf(crew); return !!p && (p.all || p.jobs.size > 0); };
  const update = (crew: string, fn: (cur: CrewPick | undefined) => CrewPick | undefined) => {
    setSavedNow(false); setTouched(true);
    setPicks((cur) => { const n = new Map(cur); const v = fn(cur.get(key(crew))); if (v) n.set(key(crew), v); else n.delete(key(crew)); return n; });
  };
  const entries: string[] = [];
  for (const c of choices) {
    const p = pickOf(c.crew);
    if (!p) continue;
    if (p.all) entries.push(crewEntry(c.crew, null));
    else for (const j of c.jobs) if (p.jobs.has(j.id)) entries.push(crewEntry(c.crew, j.id));
  }
  entries.sort();
  const next: NightJobs = fileMode ? "file" : entries;
  const savedNorm = saved === "file" ? "file" : Array.isArray(saved) ? toCrewEntries(milestones, saved).sort() : undefined;
  const helpersSame = JSON.stringify(chosen) === JSON.stringify(times.helpers ?? null);
  const same = helpersSame && JSON.stringify(next) === JSON.stringify(savedNorm) && !(Array.isArray(saved) && saved.some((e) => !e.startsWith("crew:")));
  const save = async () => {
    setBusy(true); setErr(null);
    try { await saveProjectShiftTimes(projectId, { ...times, nightJobs: next, helpers: chosen ?? undefined }); setEdited(undefined); setSavedNow(true); onSaved(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  // ── The nights as they'll come out: the same rule the calendar and the
  // turnover use (lib/shiftBands), on the choices made here.
  const entriesKey = entries.join("|");
  const parents = useMemo(() => new Set(milestones.map((m) => m.parentId).filter(Boolean) as string[]), [milestones]);
  const byId = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m])), [milestones]);
  const plan = useMemo(() => {
    const staffed = withWorkOrderCrews(applyNightStaffing(milestones, fileMode ? "file" : entriesKey ? entriesKey.split("|") : []));
    return staffed.filter((m) => m.id && !parents.has(m.id)).map((m) => ({ m, bands: stepBandDays(m, tz, times), now: workShiftOf(m, tz, times) }));
  }, [milestones, fileMode, entriesKey, parents, tz, times]);
  const tonight = useMemo(() => shiftAt(Date.now(), tz, times).dayKey, [tz, times]);
  const [offset, setOffset] = useState(0);
  const nightKeys = [0, 1, 2].map((i) => dayKey(addDays(dayKeyToMs(tonight, tz), offset + i, tz), tz));
  // Night work the file plans that no night crew is on: the day shift's.
  const waiting = plan.filter((x) => fileShift(x.m) !== "day" && x.now === "day" && x.m.status !== "completed" && finishMsOf(x.m) > Date.now());
  const dayF = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }), [tz]);
  const clockF = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }), [tz]);
  const hoursIn = (m: Milestone, a: number, b: number) => {
    const s = startMsOf(m), f = finishMsOf(m);
    if (!Number.isFinite(s) || !Number.isFinite(f)) return "";
    const from = s >= a ? clockF.format(s) : "…", to = f <= b ? clockF.format(f) : "…";
    return from === "…" && to === "…" ? "all night" : `${from}–${to}`;
  };
  const crewName = (c: string) => c || "No crew named";
  const onCrews = choices.filter((c) => isOn(c.crew));
  const order = [...choices].sort((a, b) => Number(isOn(b.crew)) - Number(isOn(a.crew)));

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text)]">
        <b>Everyone works days.</b> Put a crew on nights — on <b>all its work</b>, or only on <b>the jobs you pick</b>.
        A night crew takes its steps the schedule has in night hours; round-the-clock jobs (the tower) run both shifts.
        The nights on the right change as you choose.
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
        {/* Crews */}
        <div className="space-y-2 min-w-0">
          <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Who works nights</div>
          <div className={`rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] ${fileMode ? "opacity-50 pointer-events-none" : ""}`}>
            {choices.length === 0 && <div className="px-3 py-3 text-[13px] text-[var(--color-text-muted)]">No steps yet — import the schedule first.</div>}
            {order.map((c) => {
              const mode = modeOf(c.crew);
              const p = pickOf(c.crew);
              return (
                <div key={c.crew || "__none"} className={`px-3 py-2.5 space-y-2 ${isOn(c.crew) ? "bg-violet-50/70 dark:bg-violet-950/25" : ""}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <div className="min-w-[140px] flex-1">
                      <div className={`text-[14px] font-bold ${c.crew ? "text-[var(--color-text)]" : "italic text-[var(--color-text-muted)]"}`}>{crewName(c.crew)}</div>
                      <div className="text-[11.5px] text-[var(--color-text-muted)]">
                        {c.steps} step{c.steps === 1 ? "" : "s"} on {c.jobs.length} job{c.jobs.length === 1 ? "" : "s"}
                        {c.nightSteps > 0 && <> · <span className="text-violet-700 dark:text-violet-300">{c.nightSteps} planned in night hours</span></>}
                      </div>
                    </div>
                    <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden text-[12px] font-bold" role="radiogroup" aria-label={`${crewName(c.crew)} at night`}>
                      {([["none", "Days only"], ["all", "Nights: all its work"], ["some", "Nights: some jobs"]] as const).map(([v, t]) => (
                        <button key={v} type="button" role="radio" aria-checked={mode === v} disabled={!canManage}
                          onClick={() => update(c.crew, (x) => (v === "none" ? undefined : v === "all" ? { all: true, jobs: x?.jobs ?? new Set() } : { all: false, jobs: x?.jobs ?? new Set() }))}
                          className={`px-2.5 py-1.5 border-l first:border-l-0 border-[var(--color-border-strong)] ${mode === v ? (v === "none" ? "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900" : "bg-violet-700 text-white") : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  {mode === "some" && (
                    <div className="space-y-1">
                      <div className="text-[11.5px] text-[var(--color-text-muted)]">Tap the jobs {crewName(c.crew)} works at night:</div>
                      <div className="flex flex-wrap gap-1.5">
                        {c.jobs.map((j) => {
                          const on = !!p?.jobs.has(j.id);
                          return (
                            <button key={j.id} type="button" disabled={!canManage} title={j.crumbs} aria-pressed={on}
                              onClick={() => update(c.crew, (x) => { const jobs = new Set(x && !x.all ? x.jobs : []); if (jobs.has(j.id)) jobs.delete(j.id); else jobs.add(j.id); return { all: false, jobs }; })}
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${on ? "bg-violet-700 border-violet-700 text-white" : "bg-[var(--color-surface)] border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                              {on ? <Moon className="w-3 h-3" aria-hidden /> : null}{j.name}
                              <span className={`text-[10.5px] font-bold ${on ? "text-violet-200" : "text-[var(--color-text-faint)]"}`}>{j.steps}</span>
                            </button>
                          );
                        })}
                      </div>
                      {p && p.jobs.size === 0 && <div className="text-[11.5px] font-semibold text-amber-700 dark:text-amber-300">None picked yet — still days only.</div>}
                      {p && c.jobs.length > 1 && c.jobs.every((j) => p.jobs.has(j.id)) && (
                        <div className="text-[11.5px] text-[var(--color-text-muted)]">That&apos;s all its jobs — <button type="button" disabled={!canManage} onClick={() => update(c.crew, () => ({ all: true, jobs: new Set() }))} className="font-bold text-violet-700 dark:text-violet-300 underline">Nights: all its work</button> also covers jobs added later.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <label className="flex items-start gap-2 text-[12px] text-[var(--color-text-muted)] cursor-pointer">
            <input type="checkbox" className="mt-0.5" disabled={!canManage} checked={fileMode} onChange={(e) => { setFileMode(e.target.checked); setSavedNow(false); setTouched(true); }} />
            <span>Skip the crews — anything the schedule file puts in night hours is night work.</span>
          </label>
        </div>

        {/* The nights as they'll come out — kept in view while the crews scroll. */}
        <div className="order-first xl:order-none space-y-2 min-w-0 xl:sticky xl:top-0 xl:self-start xl:max-h-[calc(100vh-220px)] xl:overflow-y-auto">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">The nights</span>
            <span className="ml-auto inline-flex items-center gap-1">
              <button type="button" onClick={() => setOffset((o) => o - 3)} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]" aria-label="Earlier nights"><ChevronLeft className="w-4 h-4" /></button>
              {offset !== 0 && <button type="button" onClick={() => setOffset(0)} className="px-2 h-7 rounded-md border border-[var(--color-border)] text-[11px] font-bold hover:bg-[var(--color-surface-2)]">Tonight</button>}
              <button type="button" onClick={() => setOffset((o) => o + 3)} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]" aria-label="Later nights"><ChevronRight className="w-4 h-4" /></button>
            </span>
          </div>
          {nightKeys.map((k) => {
            const w = shiftWindow(k, "night", tz, times);
            const rows = plan.filter((x) => x.bands.night.has(k)).sort((a, b) => startMsOf(a.m) - startMsOf(b.m));
            const open = rows.filter((x) => x.m.status !== "completed");
            const byCrew = new Map<string, typeof rows>();
            for (const x of open) { const c = x.m.responsibleParty?.trim() || ""; byCrew.set(c, [...(byCrew.get(c) ?? []), x]); }
            return (
              <div key={k} className="rounded-lg border border-violet-200 dark:border-violet-900 overflow-hidden">
                <div className="px-3 py-1.5 flex items-center gap-2 bg-violet-800 text-white">
                  <Moon className="w-3.5 h-3.5 text-violet-200" aria-hidden />
                  <span className="text-[12.5px] font-black">{k === tonight ? "Tonight — " : ""}{dayF.format(w.start)}</span>
                  <span className="text-[11px] text-violet-200">{clockF.format(w.start)} → {dayF.format(w.end).split(",")[0]} {clockF.format(w.end)}</span>
                  <span className="ml-auto text-[11px] font-semibold text-violet-200">{open.length} step{open.length === 1 ? "" : "s"}{rows.length > open.length ? ` · ${rows.length - open.length} done` : ""}</span>
                </div>
                {open.length === 0 ? (
                  <div className="px-3 py-2 text-[12px] text-[var(--color-text-muted)] bg-violet-50/60 dark:bg-violet-950/20">No night work.</div>
                ) : (
                  <div className="divide-y divide-violet-100 dark:divide-violet-950 bg-violet-50/60 dark:bg-violet-950/20">
                    {[...byCrew.entries()].map(([crew, list]) => (
                      <div key={crew || "__none"} className="px-3 py-1.5">
                        <div className="text-[12px] font-black text-violet-900 dark:text-violet-200">{crewName(crew)} <span className="font-semibold text-violet-700/80 dark:text-violet-300/80">· {list.length}</span></div>
                        <ul className="mt-0.5 space-y-0.5">
                          {list.map(({ m }) => (
                            <li key={m.id} className="grid grid-cols-[1fr_auto] gap-2 text-[12px]">
                              <span className="min-w-0 truncate text-[var(--color-text)]" title={`${m.parentId ? `${byId.get(m.parentId)?.name ?? ""} · ` : ""}${m.name}`}>
                                {m.parentId && byId.get(m.parentId) ? <span className="text-[var(--color-text-muted)]">{byId.get(m.parentId)!.name.split(" - ")[0]} · </span> : null}{m.name}
                              </span>
                              <span className="font-mono text-[11px] text-[var(--color-text-muted)] tabular-nums">{hoursIn(m, w.start, w.end)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {waiting.length > 0 && (
            <details className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30">
              <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-bold text-amber-900 dark:text-amber-200">
                {waiting.length} night step{waiting.length === 1 ? "" : "s"} nobody&apos;s on — they wait for the day shift
              </summary>
              <ul className="px-3 pb-2 space-y-0.5">
                {waiting.sort((a, b) => startMsOf(a.m) - startMsOf(b.m)).map(({ m }) => (
                  <li key={m.id} className="grid grid-cols-[1fr_auto] gap-2 text-[12px]">
                    <span className="min-w-0 truncate text-[var(--color-text)]"><b>{crewName(m.responsibleParty?.trim() ?? "")}</b> · {m.parentId && byId.get(m.parentId) ? `${byId.get(m.parentId)!.name.split(" - ")[0]} · ` : ""}{m.name}</span>
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
        <b>On nights:</b> {fileMode ? "whatever the schedule file puts in night hours." : onCrews.length === 0 ? "nobody — all work is day work." : onCrews.map((c) => {
          const p = pickOf(c.crew)!;
          return `${crewName(c.crew)} (${p.all ? "all its work" : c.jobs.filter((j) => p.jobs.has(j.id)).map((j) => j.name.split(" - ")[0]).join(", ")})`;
        }).join("; ")}
      </div>

      <div className="rounded-lg border border-[var(--color-border)]">
        <button type="button" onClick={() => setShowHelpers((v) => !v)} className="w-full flex items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-bold text-[var(--color-text)]">
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showHelpers ? "rotate-90" : ""}`} />
          Extra hands for work pulled forward <span className="font-normal text-[12px] text-[var(--color-text-muted)]">— optional{chosen ? `: ${chosen.crew ?? "crew not set"}, ${chosen.hands} × ${chosen.hours} h` : ""}</span>
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
            {(busy || !loaded) && <Loader2 className="w-4 h-4 animate-spin" />} {!loaded ? "Reading your saved night crews…" : done && same ? "Saved" : "Save night crews"}
          </button>
          {savedNow && <span className="text-[12px] font-semibold text-emerald-700 dark:text-emerald-400">Saved — the calendar and the turnover follow it now.</span>}
        </div>
      ) : <NoRights />}
    </div>
  );
}

/** Saved entries as the picker's state, by crew. */
function fromEntries(entries: string[]): Map<string, { all: boolean; jobs: Set<string> }> {
  const out = new Map<string, { all: boolean; jobs: Set<string> }>();
  for (const e of entries) {
    const x = parseEntry(e);
    if (!("crew" in x)) continue;
    const k = x.crew.trim().toLowerCase();
    const cur = out.get(k) ?? { all: false, jobs: new Set<string>() };
    if (x.job == null) cur.all = true; else cur.jobs.add(x.job);
    out.set(k, cur);
  }
  return out;
}

function CriticalStep({ projectId, milestones, canManage, critical, onSaved }: Props & { critical: CriticalMode | null; onSaved: () => void }) {
  const inForce = effectiveCriticalMode(milestones, critical);
  // Not until the saved choice has been read — never preselect over it.
  const loaded = useCriticalModeLoaded(projectId);
  const [picked, setPick] = useState<CriticalMode | null>(null);
  const pick = picked ?? critical ?? inForce;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const counts = useMemo(() => {
    const leaves = new Set(milestones.map((m) => m.parentId).filter(Boolean));
    const steps = milestones.filter((m) => m.id && !leaves.has(m.id) && m.status !== "completed").length;
    return { steps, of: Object.fromEntries(CRITICAL_MODES.map((o) => [o.value, resolveCriticalPath(milestones, o.value).ids.size])) as Record<CriticalMode, number> };
  }, [milestones]);
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
      <p className="text-[12px] text-[var(--color-text-muted)]">Mark any task Critical / Not critical on its card afterwards — that wins over this.</p>
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
  if (milestones.length === 0) return <div className="text-[12.5px] text-[var(--color-text-muted)]">Import the schedule first — then capture it here.</div>;
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
