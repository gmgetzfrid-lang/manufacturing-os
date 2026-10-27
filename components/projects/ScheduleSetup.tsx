"use client";

// Schedule setup — one place for everything the schedule's reports hang
// on. A red banner names what's missing until it's done (it can't be
// dismissed), and the wizard walks through each item with what's in force
// now filled in, so confirming a right answer is one click.

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock, Flag, Globe2, Loader2, Moon, Settings2, Zap } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { setupChecklist, missingRequired, type SetupItem, type SetupItemId } from "@/lib/scheduleSetup";
import { browserTimeZone, listTimeZones, tzLabel, DEFAULT_SCHEDULE_TZ } from "@/lib/scheduleTz";
import { updateProjectMeta } from "@/lib/projects";
import { useShiftTimes, useShiftTimesSaved, saveProjectShiftTimes, shiftTimesProblem } from "@/lib/shiftTimesStore";
import { meetingLeadMin, workShiftOf, type PullCrew, type ShiftTimes } from "@/lib/shiftReport";
import { applyNightStaffing, nightCrewChoices, toCrewEntries, crewEntry, parseEntry, type NightJobs } from "@/lib/nightStaffing";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { useCriticalMode, useCriticalModeLoaded, saveCriticalMode } from "@/lib/criticalModeStore";
import { CRITICAL_MODES, resolveCriticalPath, effectiveCriticalMode, type CriticalMode } from "@/lib/criticalPath";
import type { Milestone } from "@/types/schema";

const ICON: Record<SetupItemId, typeof Clock> = { timezone: Globe2, shifts: Clock, night: Moon, critical: Zap, baseline: Flag };
const SESSION_KEY = (projectId: string) => `scheduleSetup.shown:${projectId}`;

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
  const nightDecided = useShiftTimes(p.projectId).nightJobs !== undefined;
  const items = useMemo(() => setupChecklist({
    timezoneSet: !!p.timezone, shiftTimesSaved: saved, criticalChosen: critical != null, hasBaseline: p.hasBaseline, nightDecided,
  }), [p.timezone, saved, critical, p.hasBaseline, nightDecided]);
  const missing = missingRequired(items);
  // Opens by itself once per session for someone who can fix it.
  const [open, setOpen] = useState<SetupItemId | null>(null);
  const first = p.canManage ? missing[0]?.id : undefined;
  useEffect(() => {
    if (!first) return;
    try {
      if (sessionStorage.getItem(SESSION_KEY(p.projectId)) === "1") return;
      sessionStorage.setItem(SESSION_KEY(p.projectId), "1");
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
  const nightDecided = useShiftTimes(p.projectId).nightJobs !== undefined;
  const items = setupChecklist({ timezoneSet: !!p.timezone, shiftTimesSaved: saved, criticalChosen: critical != null, hasBaseline: p.hasBaseline, nightDecided });
  const todo = items.filter((i) => !i.done && !i.checking).length;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Time zone, shift times, critical path, baseline"
        className={`inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border shadow-sm transition-colors ${todo
          ? "text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 hover:bg-amber-100"
          : "text-[var(--color-text)] bg-[var(--color-surface)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
        <Settings2 className="w-3.5 h-3.5" /> Setup{todo ? ` · ${todo} to do` : <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />}
      </button>
      {open && <SetupWizard {...p} items={items} start={items.find((i) => !i.done)?.id ?? "timezone"} critical={critical} onClose={() => setOpen(false)} />}
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
            {at === "night" && <NightStep {...p} done={item.done} onSaved={() => go(1)} />}
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
type Outcome = "night" | "both" | "dayHours" | "toDay";

function NightStep({ projectId, milestones, canManage, done, onSaved }: Props & { done: boolean; onSaved: () => void }) {
  const tz = useScheduleTz();
  const times = useShiftTimes(projectId);
  const saved: NightJobs | undefined = times.nightJobs;
  const [mode, setMode] = useState<"crews" | "file">(saved === "file" ? "file" : "crews");
  // Which crews work nights, and where: everywhere, or only on these jobs.
  // (An older job-only setting is shown as the crews it covered.)
  const [picks, setPicks] = useState<Map<string, CrewPick>>(() => fromEntries(Array.isArray(saved) ? toCrewEntries(milestones, saved) : []));
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Hands kept for extra work the turnover pulls forward (optional).
  // undefined = untouched (whatever is saved); null = cleared.
  const [edited, setEdited] = useState<PullCrew | null | undefined>(undefined);
  const chosen: PullCrew | null = edited === undefined ? times.helpers ?? null : edited;
  const helpers: PullCrew = chosen ?? { crew: null, hands: 2, hours: 12 };
  const setHelpers = (p: PullCrew) => setEdited(p);
  const crews = useMemo(() => [...new Set(milestones.map((m) => m.responsibleParty?.trim()).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [milestones]);
  // The file's own hours, before any night-crew setting is applied.
  const fileShift = useMemo(() => (m: Milestone) => workShiftOf({ ...m, staffedShift: null }, tz, times), [tz, times]);
  const choices = useMemo(() => nightCrewChoices(milestones, (m) => fileShift(m) !== "day"), [milestones, fileShift]);
  const key = (crew: string) => crew.trim().toLowerCase();
  const pickOf = (crew: string) => picks.get(key(crew));
  const isOn = (crew: string) => { const p = pickOf(crew); return !!p && (p.all || p.jobs.size > 0); };
  const update = (crew: string, fn: (cur: CrewPick | undefined) => CrewPick | undefined) =>
    setPicks((cur) => { const n = new Map(cur); const v = fn(cur.get(key(crew))); if (v) n.set(key(crew), v); else n.delete(key(crew)); return n; });
  const entries: string[] = [];
  for (const c of choices) {
    const p = pickOf(c.crew);
    if (!p) continue;
    if (p.all) entries.push(crewEntry(c.crew, null));
    else for (const j of c.jobs) if (p.jobs.has(j.id)) entries.push(crewEntry(c.crew, j.id));
  }
  entries.sort();
  const next: NightJobs = mode === "file" ? "file" : entries;
  const savedNorm = saved === "file" ? "file" : Array.isArray(saved) ? toCrewEntries(milestones, saved).sort() : undefined;
  const helpersSame = JSON.stringify(chosen) === JSON.stringify(times.helpers ?? null);
  const same = helpersSame && JSON.stringify(next) === JSON.stringify(savedNorm) && !(Array.isArray(saved) && saved.some((e) => !e.startsWith("crew:")));
  const save = async () => {
    setBusy(true); setErr(null);
    try { await saveProjectShiftTimes(projectId, { ...times, nightJobs: next, helpers: chosen ?? undefined }); setEdited(undefined); onSaved(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  // ── What the choice does to every step: the same rule the turnover uses.
  const entriesKey = entries.join("|");
  const outcomeOf = useMemo(() => {
    const staffed = applyNightStaffing(milestones, mode === "file" ? "file" : entriesKey ? entriesKey.split("|") : []);
    const out = new Map<string, Outcome>();
    for (const m of staffed) {
      if (!m.id) continue;
      const w = workShiftOf(m, tz, times);
      out.set(m.id, w === "night" ? "night" : w === "both" ? "both" : fileShift(m) === "day" ? "dayHours" : "toDay");
    }
    return out;
  }, [milestones, mode, entriesKey, tz, times, fileShift]);
  const parents = useMemo(() => new Set(milestones.map((m) => m.parentId).filter(Boolean) as string[]), [milestones]);
  const steps = useMemo(() => milestones.filter((m) => m.id && !parents.has(m.id)), [milestones, parents]);
  const byId = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m])), [milestones]);
  const dayF = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }), [tz]);
  const timeF = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }), [tz]);
  const when = (m: Milestone) => {
    const s = startMsOf(m), f = finishMsOf(m);
    if (!Number.isFinite(s) || !Number.isFinite(f)) return "no dates";
    const ds = dayF.format(s), df = dayF.format(f);
    return ds === df ? `${ds} · ${timeF.format(s)}–${timeF.format(f)}` : `${ds} ${timeF.format(s)} → ${df} ${timeF.format(f)}`;
  };
  const nightSteps = steps.filter((m) => { const o = outcomeOf.get(m.id!); return o === "night" || o === "both"; });
  const movedToDay = steps.filter((m) => outcomeOf.get(m.id!) === "toDay" && m.status !== "completed");

  const ql = q.trim().toLowerCase();
  const shown = choices.filter((c) => !ql || c.crew.toLowerCase().includes(ql) || c.jobs.some((j) => `${j.name} ${j.crumbs}`.toLowerCase().includes(ql)));
  const crewName = (c: string) => c || "No crew named";
  const current = choices.find((c) => key(c.crew) === sel) ?? shown[0] ?? null;
  const stepsOfCrew = (crew: string) => steps.filter((m) => key(m.responsibleParty ?? "") === key(crew));
  const pillOf = (crew: string) => {
    const p = pickOf(crew);
    if (p && !p.all && p.jobs.size === 0) return { t: "Nights: pick its jobs", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200" };
    if (!isOn(crew)) return { t: "Days only", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" };
    return p!.all ? { t: "Nights: all its work", cls: "bg-indigo-600 text-white" } : { t: `Nights: ${p!.jobs.size} job${p!.jobs.size === 1 ? "" : "s"}`, cls: "bg-indigo-600 text-white" };
  };
  const OUT: Record<Outcome, { t: string; cls: string }> = {
    night: { t: "Night work", cls: "text-indigo-700 dark:text-indigo-300 font-bold" },
    both: { t: "Both shifts — its hours span day and night", cls: "text-indigo-700 dark:text-indigo-300 font-bold" },
    dayHours: { t: "Day work — the schedule has it in day hours", cls: "text-[var(--color-text-muted)]" },
    toDay: { t: "Day work — no night crew on it; waits for the day shift", cls: "text-amber-700 dark:text-amber-300 font-semibold" },
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text)] space-y-1.5">
        <p><b>How this works.</b> Only the crews you put on nights work nights. For each crew, choose <b>days only</b>, <b>nights on all its work</b>, or <b>nights only on the jobs you pick</b> (Schultz on the towers, say).</p>
        <p>A night crew works the steps the schedule puts in <b>night hours</b>. A step the schedule puts in day hours stays day work. To move one step to nights anyway, open it and set <b>Shift → Night shift</b>.</p>
        <p>The right side lists <b>every step</b> of the crew you pick, with its schedule time and what the turnover will do with it, before you save.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {([["crews", "I'll choose which crews work nights"], ["file", "Follow the schedule file's hours (anything in night hours is night work)"]] as const).map(([v, t]) => (
          <label key={v} className={`flex-1 min-w-[240px] flex items-start gap-2.5 rounded-lg border-2 px-3 py-2.5 cursor-pointer ${mode === v ? "border-orange-400 bg-orange-50 dark:border-orange-700 dark:bg-orange-950/40" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
            <input type="radio" name="night" disabled={!canManage} checked={mode === v} onChange={() => setMode(v)} className="mt-1" />
            <span className="text-[13.5px] font-bold text-[var(--color-text)]">{t}</span>
          </label>
        ))}
      </div>

      {mode === "crews" && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(260px,2fr)_3fr] gap-3">
          {/* Crews */}
          <div className="space-y-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a crew or equipment — Schultz, tower, E-17"
              className={`${field} w-full`} aria-label="Find a crew or equipment" />
            <div className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-[60vh] overflow-y-auto">
              {choices.length === 0 && <div className="px-3 py-3 text-[13px] text-[var(--color-text-muted)]">No steps yet — import the schedule first.</div>}
              {shown.map((c) => {
                const pill = pillOf(c.crew);
                const active = current && key(current.crew) === key(c.crew);
                return (
                  <button key={c.crew || "__none"} type="button" onClick={() => setSel(key(c.crew))} aria-pressed={!!active}
                    className={`w-full text-left px-3 py-2.5 ${active ? "bg-orange-50 dark:bg-orange-950/30 border-l-4 border-orange-500" : "hover:bg-[var(--color-surface-2)] border-l-4 border-transparent"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className={`text-[14px] font-bold ${c.crew ? "text-[var(--color-text)]" : "italic text-[var(--color-text-muted)]"}`}>{crewName(c.crew)}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${pill.cls}`}>{pill.t}</span>
                    </div>
                    <div className="text-[12px] text-[var(--color-text-muted)] mt-0.5">
                      {c.steps} step{c.steps === 1 ? "" : "s"} on {c.jobs.length} job{c.jobs.length === 1 ? "" : "s"}
                      {c.nightSteps > 0 && <> · <span className="text-indigo-700 dark:text-indigo-300">{c.nightSteps} in night hours in the schedule</span></>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* The crew picked: how it works nights, and every step it means */}
          {current ? (
            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3 min-w-0">
              <div>
                <div className="text-[16px] font-black text-[var(--color-text)]">{crewName(current.crew)}</div>
                <div className="text-[12.5px] text-[var(--color-text-muted)]">How does this crew work nights?</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label={`How ${crewName(current.crew)} works nights`}>
                {([["none", "Days only", "No night crew. Its night-hour steps wait for the day shift."], ["all", "Nights on all its work", "Works nights wherever the schedule has its steps in night hours."], ["some", "Nights only on jobs I pick", "Pick the equipment below — everything else is days only."]] as const).map(([v, t, h]) => {
                  const p = pickOf(current.crew);
                  const cur = !isOn(current.crew) && !(p && !p.all) ? "none" : p?.all ? "all" : "some";
                  return (
                    <button key={v} type="button" role="radio" aria-checked={cur === v} disabled={!canManage}
                      onClick={() => update(current.crew, (x) => (v === "none" ? undefined : v === "all" ? { all: true, jobs: x?.jobs ?? new Set() } : { all: false, jobs: x?.jobs ?? new Set() }))}
                      className={`text-left rounded-lg border-2 px-3 py-2 ${cur === v ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
                      <div className="text-[13px] font-bold text-[var(--color-text)]">{cur === v ? "● " : "○ "}{t}</div>
                      <div className="text-[11.5px] text-[var(--color-text-muted)] mt-0.5">{h}</div>
                    </button>
                  );
                })}
              </div>
              {(() => {
                const p = pickOf(current.crew);
                const choosing = !!p && !p.all;
                const mine = stepsOfCrew(current.crew);
                const groups = current.jobs.map((j) => ({ j, list: mine.filter((m) => m.parentId === j.id) })).filter((g) => g.list.length);
                const loose = mine.filter((m) => !m.parentId || !byId.has(m.parentId));
                const onCount = mine.filter((m) => { const o = outcomeOf.get(m.id!); return o === "night" || o === "both"; }).length;
                return (
                  <div className="space-y-2">
                    <div className="text-[13px] text-[var(--color-text)]">
                      <b>{onCount} of {mine.length}</b> of this crew&apos;s steps would be night work{choosing ? " — tick the jobs it works nights" : ""}:
                    </div>
                    <div className="rounded-lg border border-[var(--color-border)] max-h-[48vh] overflow-y-auto divide-y divide-[var(--color-border)]">
                      {groups.map(({ j, list }) => (
                        <div key={j.id}>
                          <label className={`flex items-start gap-2.5 px-3 py-2 bg-[var(--color-surface-2)] ${choosing ? "cursor-pointer" : ""}`}>
                            {choosing && <input type="checkbox" className="mt-1" disabled={!canManage} checked={p!.jobs.has(j.id)}
                              onChange={() => update(current.crew, (x) => { const jobs = new Set(x && !x.all ? x.jobs : []); if (jobs.has(j.id)) jobs.delete(j.id); else jobs.add(j.id); return { all: false, jobs }; })} />}
                            <span className="flex-1 min-w-0">
                              <span className="block text-[13.5px] font-bold text-[var(--color-text)] break-words">{j.name}</span>
                              {j.crumbs && <span className="block text-[11.5px] text-[var(--color-text-muted)] break-words">{j.crumbs}</span>}
                            </span>
                            <span className="shrink-0 text-[11.5px] text-[var(--color-text-muted)]">{list.length} step{list.length === 1 ? "" : "s"}</span>
                          </label>
                          <ul className="px-3 py-1.5 space-y-1">
                            {list.map((m) => {
                              const o = outcomeOf.get(m.id!) ?? "dayHours";
                              return (
                                <li key={m.id} className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-x-3 text-[12.5px] pl-6">
                                  <span className="min-w-0">
                                    <span className="text-[var(--color-text)]">{m.name}</span>
                                    <span className="block text-[11.5px] text-[var(--color-text-muted)]">{when(m)}{m.status === "completed" ? " · done" : ""}</span>
                                  </span>
                                  <span className={`text-[12px] sm:text-right ${OUT[o].cls}`}>{OUT[o].t}</span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                      {loose.map((m) => {
                        const o = outcomeOf.get(m.id!) ?? "dayHours";
                        return (
                          <div key={m.id} className="px-3 py-2 text-[12.5px] grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-x-3">
                            <span><span className="text-[var(--color-text)]">{m.name}</span><span className="block text-[11.5px] text-[var(--color-text-muted)]">{when(m)} · not under a job (only &ldquo;all its work&rdquo; covers it)</span></span>
                            <span className={`text-[12px] sm:text-right ${OUT[o].cls}`}>{OUT[o].t}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-[13px] text-[var(--color-text-muted)]">Pick a crew on the left.</div>}
        </div>
      )}

      {/* The whole picture, in words */}
      <div className="rounded-lg border-2 border-indigo-200 dark:border-indigo-900 bg-indigo-50/60 dark:bg-indigo-950/30 px-4 py-3 text-[13px] text-[var(--color-text)] space-y-1">
        <div><b>On nights:</b> {mode === "file" ? "whatever the schedule file puts in night hours." : choices.filter((c) => isOn(c.crew)).length === 0 ? "nobody — all work is day work." : choices.filter((c) => isOn(c.crew)).map((c) => {
          const p = pickOf(c.crew)!;
          return `${crewName(c.crew)} (${p.all ? "all its work" : c.jobs.filter((j) => p.jobs.has(j.id)).map((j) => j.name).join(", ")})`;
        }).join("; ")}</div>
        <div><b>{nightSteps.length}</b> step{nightSteps.length === 1 ? "" : "s"} will be night work (or both shifts).{movedToDay.length > 0 && <> <span className="text-amber-700 dark:text-amber-300"><b>{movedToDay.length}</b> open step{movedToDay.length === 1 ? "" : "s"} the schedule puts in night hours will wait for the day shift</span> (no night crew on them).</>}</div>
      </div>

      <div className="rounded-lg border border-[var(--color-border)] px-3 py-2 space-y-1.5">
        <div className="text-[13px] font-bold text-[var(--color-text)]">Hands for extra work <span className="font-normal text-[12px] text-[var(--color-text-muted)]">— optional</span></div>
        <div className="text-[12px] text-[var(--color-text-muted)]">The crew you keep for work pulled forward on the turnover (&ldquo;Add work for the night shift&rdquo;), and its usual size. Changeable on each turnover.</div>
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
          {!chosen && <span className="text-[11.5px] text-[var(--color-text-faint)]">not set</span>}
        </div>
      </div>
      <Msg err={err} />
      {canManage ? (
        <button onClick={() => void save()} disabled={busy || (done && same)} className={btn}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {done && same ? "Saved" : mode === "crews" ? `Save — ${choices.filter((c) => isOn(c.crew)).length} crew${choices.filter((c) => isOn(c.crew)).length === 1 ? "" : "s"} on nights, ${nightSteps.length} night steps` : "Save"}
        </button>
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
