"use client";

// CalendarQuickView — the one place to update work from the calendar.
//
// Tap a card: its work order, where the whole task stands against plan,
// and each step on the shift you tapped — its planned window, % against
// plan, hours behind, last comment, hold reason. Tap a step to update it
// right there: status, %, the time it happened (you're on the day — just
// the time), a comment (required, it goes on the report), and why it's
// behind. Its history is one tap away, so you see what you're overriding.
// No sidebar; the schedule details (move, depends on) are a link away.

import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Layers } from "lucide-react";
import type { Milestone, MilestoneNote, MilestoneStatus } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import { expectedFraction, shiftWindow, workHours, notesForShift, TURNOVER_GRACE_MS, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { fmtInTz } from "@/lib/scheduleTz";
import { notesFor, updateMilestoneNote } from "@/lib/milestones";
import { loadProgressLog, type ProgressLogRow } from "@/lib/progressHistory";
import { describeChange } from "@/lib/timeLog";
import { clockForWork, shiftWord, typeClock, DayPick } from "@/components/projects/ShiftRecordParts";
import { whenChoices } from "@/components/projects/ProgressControl";
import { builtSpan } from "@/lib/asBuilt";
import type { PathMarks } from "@/lib/criticalPath";
import PathTag from "@/components/projects/PathTag";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";

/** What the quick view saves for a step. */
export interface StepUpdate {
  status: MilestoneStatus;
  /** For work in progress: the new %. Null = as it is. */
  pct: number | null;
  /** What got done / why — required; it goes on the report. */
  note: string;
  /** When it happened. */
  at: number;
  /** Why it's behind, when given or changed. */
  why?: string;
}

const STATUS: Array<{ v: MilestoneStatus; label: string; on: string }> = [
  { v: "planned", label: "Not started", on: "bg-slate-600 border-slate-600 text-white" },
  { v: "in_progress", label: "In progress", on: "bg-blue-600 border-blue-600 text-white" },
  { v: "on_hold", label: "On hold", on: "bg-amber-600 border-amber-600 text-white" },
  { v: "blocked", label: "Blocked", on: "bg-rose-600 border-rose-600 text-white" },
  { v: "completed", label: "Done", on: "bg-emerald-600 border-emerald-600 text-white" },
];
const DOT: Record<string, string> = { planned: "bg-slate-300", in_progress: "bg-blue-600", on_hold: "bg-amber-500", blocked: "bg-rose-600", missed: "bg-rose-800", completed: "bg-emerald-500" };
const WORD: Record<string, string> = { planned: "Not started", in_progress: "In progress", on_hold: "On hold", blocked: "Blocked", missed: "Missed", completed: "Done" };
const ms = (v: unknown) => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

export default function CalendarQuickView({ task, onDay, others, dayKey, band, dayLabel, tz, times, progress, planNow, canEdit, onUpdate, onOpenDetail, onMoveDays, marks, onDiscovery }: {
  task: Milestone;
  /** Steps on the shift (or day) tapped; the rest behind a toggle. */
  onDay: Milestone[]; others: Milestone[];
  dayKey: string; band?: "day" | "night" | null; dayLabel: string;
  tz: string; times: ShiftTimes;
  progress?: Map<string, ProgressInfo>;
  /** Each task's % planned by now. */
  planNow?: Map<string, number>;
  canEdit: boolean;
  onUpdate?: (id: string, u: StepUpdate) => Promise<boolean>;
  /** The side bar, for planning changes — not offered where there's none. */
  onOpenDetail?: (m: Milestone) => void;
  onMoveDays?: (id: string, delta: number) => void;
  /** The critical path (lib/criticalPath) — each step marked against it. */
  marks?: PathMarks;
  /** Found work on this task: into the schedule. */
  onDiscovery?: (task: Milestone) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const all = useMemo(() => [...onDay, ...others], [onDay, others]);
  const ids = useMemo(() => all.map((m) => m.id).filter((x): x is string => !!x), [all]);
  const idsKey = ids.join(",");
  // Each step's comments, reasons and history.
  const [notes, setNotes] = useState<MilestoneNote[]>([]);
  const [log, setLog] = useState<ProgressLogRow[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener("milestone-notes:changed", on);
    return () => window.removeEventListener("milestone-notes:changed", on);
  }, []);
  // Re-read when a step's status or % changes too.
  const sig = all.map((m) => `${m.id}:${m.status}:${m.percentComplete ?? 0}`).join("|");
  useEffect(() => {
    let alive = true;
    if (!idsKey) return;
    notesFor(idsKey.split(",")).then((n) => { if (alive) setNotes(n); }).catch(() => { /* comments are extra */ });
    if (task.projectId) loadProgressLog(task.projectId).then((l) => { if (alive) setLog((l ?? []).filter((r) => idsKey.includes(r.milestone_id))); }).catch(() => { /* history is extra */ });
    return () => { alive = false; };
  }, [idsKey, task.projectId, tick, sig]);

  const pctOf = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
  const planOf = (m: Milestone) => Math.round(expectedFraction(m, now, tz, times) * 100);
  // Work-hours ahead (+) or behind (−) of plan by now.
  const hoursOf = (m: Milestone) => Math.round(((pctOf(m) - planOf(m)) / 100) * workHours(m, tz) * 10) / 10;
  const isLeaf = all.length === 1 && all[0].id === task.id;
  const taskPct = task.id && !isLeaf ? progress?.get(task.id)?.percent : undefined;
  const taskPlan = task.id && !isLeaf ? planNow?.get(task.id) : undefined;
  const taskHours = Math.round(all.reduce((a, m) => a + hoursOf(m), 0) * 10) / 10;
  const wos = [...new Set([task.workOrderRef, ...all.map((m) => m.workOrderRef)].map((x) => x?.trim()).filter(Boolean))] as string[];
  const crews = [...new Set(all.map((m) => m.responsibleParty?.trim()).filter(Boolean))] as string[];
  // The time you type is on this shift (or this day).
  const win: ShiftWindow = useMemo(() => {
    if (band) return shiftWindow(dayKey, band, tz, times);
    const d = shiftWindow(dayKey, "day", tz, times), n = shiftWindow(dayKey, "night", tz, times);
    return { kind: "day", dayKey, start: d.start, end: n.end };
  }, [band, dayKey, tz, times]);
  // "Tue 14:30" this week; further off, with its date ("Oct 23 16:23").
  const fmt = (t: number) => fmtInTz(t, tz, Math.abs(t - now) < 6 * 86_400_000
    ? { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  // When it happened: this card's shift — or, for a card further on in the
  // calendar (work done ahead of plan), this shift and the ones before.
  const when = useMemo(() => {
    const day = fmtInTz(win.start, tz, { weekday: "short" });
    return whenChoices({ w: win, label: band ? `${day} ${band}` : fmtInTz(win.start, tz, { weekday: "short", month: "short", day: "numeric" }) }, { tz, times }, now);
  }, [win, band, tz, times, now]);
  const [open, setOpen] = useState<string | null>(onDay.length === 1 ? onDay[0].id ?? null : null);
  const [showOthers, setShowOthers] = useState(false);

  const stepInfo = (m: Milestone) => {
    const mine = notes.filter((n) => n.milestoneId === m.id);
    const latest = (k: MilestoneNote["kind"]) => mine.filter((n) => n.kind === k && n.body?.trim()).sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
    const rows = log.filter((r) => r.milestone_id === m.id);
    const since = [...rows].reverse().find((r) => r.new_status === m.status)?.at;
    // The comment this shift's report shows for it (lib/shiftReport) — the
    // one Revise changes; the latest overall is context.
    const forShift = notesForShift(mine, win, TURNOVER_GRACE_MS).note.get(m.id ?? "");
    return { comment: latest("note"), shiftComment: forShift, why: latest("behind"), since: since ? Date.parse(since) : NaN, rows, mine };
  };

  const header = (
    <div className="px-3 py-2 border-b border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)]">
      <div className="flex items-baseline gap-2">
        <Layers className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0 self-center" />
        <span className="text-[13px] font-bold text-[var(--color-text)] flex-1 min-w-0 break-words">{task.name}</span>
        {wos.length > 0 && <span className="font-mono text-[11.5px] font-semibold text-[var(--color-text)] shrink-0">WO {wos.join(", ")}</span>}
      </div>
      <div className="mt-0.5 text-[10.5px] text-[var(--color-text-muted)]">
        <b className="text-[var(--color-text)]">{dayLabel}</b> · {onDay.length} of {all.length} step{all.length === 1 ? "" : "s"} {band ? "this shift" : "this day"}{crews.length ? ` · ${crews.join(", ")}` : ""}
      </div>
      {taskPct != null && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--color-text)]">
          <span className="whitespace-nowrap"><b>Task {taskPct}%</b> done{taskPlan != null ? ` · plan ${taskPlan}%` : ""}</span>
          <span className="relative flex-1 min-w-[60px] h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden>
            <span className="absolute inset-y-0 left-0 rounded-full bg-slate-900 dark:bg-slate-200" style={{ width: `${Math.min(100, taskPct)}%` }} />
            {taskPlan != null && <span className="absolute -top-[3px] w-0.5 h-3 bg-rose-700" style={{ left: `calc(${Math.min(100, taskPlan)}% - 1px)` }} />}
          </span>
          {Math.abs(taskHours) >= 0.1 && <b className={`font-mono whitespace-nowrap ${taskHours < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{taskHours > 0 ? "+" : "−"}{Math.abs(taskHours)} h</b>}
        </div>
      )}
    </div>
  );

  const stepRow = (m: Milestone, muted?: boolean) => {
    const id = m.id ?? m.name;
    const pct = pctOf(m), plan = planOf(m), h = hoursOf(m);
    const info = stepInfo(m);
    const held = m.status === "on_hold" || m.status === "blocked";
    const isOpen = open === id;
    const s0 = startMsOf(m), f0 = finishMsOf(m);
    return (
      <li key={id} className={`border-b border-[var(--color-border)] last:border-b-0 ${muted ? "opacity-70" : ""}`}>
        <button type="button" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen}
          className={`w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-2)] ${isOpen ? "bg-[var(--color-surface-2)]" : ""}`}>
          <span className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${DOT[m.status] ?? DOT.planned}`} aria-label={WORD[m.status]} />
          <span className="flex-1 min-w-0">
            <span className={`block text-[12.5px] font-semibold break-words ${m.status === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{m.name} <PathTag id={m.id} marks={marks} /></span>
            <span className="block font-mono text-[10px] text-[var(--color-text-muted)]">
              {(() => {
                // Where it actually happened, beside the plan.
                const b = builtSpan(m);
                const planned = Number.isFinite(s0) && Number.isFinite(f0) ? `${fmt(s0)} → ${fmt(f0)}` : "";
                if (b.kind === "done") return `Done ${fmt(b.finish)}${planned ? ` · planned ${planned}` : ""}`;
                if (b.kind === "started") return `Started ${fmt(b.start)}${planned ? ` · planned ${planned}` : ""}`;
                return planned;
              })()}{m.status !== "completed" ? ` · plan ${plan}% by now` : ""}{m.workOrderRef && wos.length > 1 ? ` · WO ${m.workOrderRef}` : ""}
            </span>
            {held && (
              <span className="block text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                {WORD[m.status]}{Number.isFinite(info.since) ? ` since ${fmt(info.since)}` : ""}{m.statusReason ? ` — “${m.statusReason}”` : " — no reason given"}
              </span>
            )}
            {info.comment && <span className="block text-[11px] italic text-[var(--color-text-muted)] break-words">“{info.comment.body}” — {fmt(ms(info.comment.happenedAt ?? info.comment.createdAt))}</span>}
            {info.why && h < 0 && <span className="block text-[11px] italic font-medium text-amber-800 dark:text-amber-300 break-words">Why behind: {info.why.body}</span>}
          </span>
          <span className="shrink-0 flex flex-col items-end gap-0.5">
            <span className={`rounded-md border px-1 text-[10px] font-bold tabular-nums ${pct >= 100 ? "text-emerald-700 bg-emerald-50 border-emerald-200" : pct > 0 ? "text-blue-700 bg-blue-50 border-blue-200" : "text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]"}`}>{pct}%</span>
            {Math.abs(h) >= 0.1 && m.status !== "completed" && <span className={`font-mono text-[10.5px] font-bold ${h < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{h > 0 ? "+" : "−"}{Math.abs(h)} h</span>}
          </span>
        </button>
        {isOpen && (
          <StepEditor key={`${id}:${m.status}:${pct}`} m={m} pct={pct} plan={plan} hours={h} info={info} when={when} tz={tz} times={times} fmt={fmt}
            canEdit={canEdit && !!onUpdate && !!m.id} onSave={(u) => onUpdate!(m.id!, u)} onMoveDays={onMoveDays} />
        )}
      </li>
    );
  };

  return (
    <div>
      {header}
      {onDay.length === 0
        ? <div className="px-3 py-3 text-[11px] text-[var(--color-text-faint)]">Nothing under this task is scheduled on {dayLabel}.</div>
        : <ul>{onDay.map((m) => stepRow(m))}</ul>}
      {others.length > 0 && (
        <div className="border-t border-[var(--color-border)]">
          <button type="button" onClick={() => setShowOthers((v) => !v)} className="w-full px-3 py-1.5 text-left text-[10.5px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] inline-flex items-center gap-1">
            <ChevronRight className={`w-3 h-3 transition-transform ${showOthers ? "rotate-90" : ""}`} />
            {others.length} step{others.length === 1 ? "" : "s"} on other {band ? "shifts" : "days"}
          </button>
          {showOthers && <ul className="border-t border-[var(--color-border)]">{others.map((m) => stepRow(m, true))}</ul>}
        </div>
      )}
      <div className="px-3 py-1.5 border-t border-[var(--color-border)] flex items-center justify-between gap-2 text-[10.5px] text-[var(--color-text-faint)]">
        {onDiscovery ? (
          <button type="button" onClick={() => onDiscovery(task)} className="font-bold text-violet-700 dark:text-violet-300 hover:underline">+ Discovery work found</button>
        ) : <span>Tap a step to update it.</span>}
        {onOpenDetail && <button type="button" onClick={() => onOpenDetail(task)} className="font-semibold text-[var(--color-accent)] hover:underline">Schedule details (move, depends on) ›</button>}
      </div>
    </div>
  );
}

/** This shift's comment, fixed in place — the same comment, the same time;
 *  what the report shows changes with it. */
function ReviseComment({ note, fmt }: { note: { id: string; body: string; at: number }; fmt: (t: number) => string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    if (text == null || !note.id) return;
    if (!text.trim()) { setMsg("A comment can't be empty."); return; }
    if (text.trim() === (note.body ?? "").trim()) { setText(null); return; }
    setBusy(true); setMsg(null);
    const ok = await updateMilestoneNote(note.id, text).then(() => true, (e: Error) => { setMsg(e.message); return false; });
    setBusy(false);
    if (ok) setText(null);
  };
  if (text == null) {
    return (
      <div className="flex items-baseline gap-1.5 text-[var(--color-text-muted)]">
        <span className="min-w-0 break-words">This shift&apos;s comment: <i>“{note.body}”</i> — {fmt(note.at)}</span>
        <button type="button" onClick={() => { setText(note.body ?? ""); setMsg(null); }} className="shrink-0 font-bold text-[var(--color-accent)] hover:underline">Revise</button>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="font-bold text-[var(--color-text)]">Revise this shift&apos;s comment <span className="font-normal text-[var(--color-text-muted)]">— it keeps its time; the report shows the fix</span></div>
      <div className="flex items-center gap-1.5">
        <input value={text} autoFocus onChange={(e) => { setText(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") { e.stopPropagation(); setText(null); } }}
          aria-label="Revised comment" className="h-8 flex-1 min-w-0 rounded-md border-2 border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
        <button type="button" disabled={busy} onClick={() => void save()} className="h-8 px-2.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-bold disabled:opacity-60">{busy ? "Saving…" : "Save"}</button>
        <button type="button" onClick={() => setText(null)} className="h-8 px-2 rounded-md border border-[var(--color-border-strong)] font-semibold">Cancel</button>
      </div>
      {msg && <div className="font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
    </div>
  );
}

function StepEditor({ m, pct, plan, hours, info, when, tz, times, fmt, canEdit, onSave, onMoveDays }: {
  m: Milestone; pct: number; plan: number; hours: number;
  info: { comment?: MilestoneNote; shiftComment?: { id: string; body: string; at: number }; why?: MilestoneNote; since: number; rows: ProgressLogRow[]; mine: MilestoneNote[] };
  /** The shifts it may have happened on, the one picked first, and whether
   *  this card is still ahead (planned later than now). */
  when: { choices: Array<{ w: ShiftWindow; label: string }>; idx: number; ahead: boolean };
  tz: string; times: ShiftTimes; fmt: (t: number) => string;
  canEdit: boolean; onSave: (u: StepUpdate) => Promise<boolean>;
  onMoveDays?: (id: string, delta: number) => void;
}) {
  const cur = m.status === "missed" ? "planned" : m.status;
  const [status, setStatus] = useState<MilestoneStatus>(cur);
  const [p, setP] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [clock, setClock] = useState("");
  const [note, setNote] = useState("");
  const [why, setWhy] = useState(info.why?.body ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const held = cur === "on_hold" || cur === "blocked";
  const offHold = held && status !== cur;
  const goingBack = status === "planned" && cur !== "planned" || (status === "in_progress" && p != null && p < pct);
  const noteLabel = status === "on_hold" ? "Why it's on hold" : status === "blocked" ? "What's blocking it" : status === "planned" ? "Why it's going back" : goingBack ? "Why it's going back" : "What got done";
  const behind = hours < -0.05 && status !== "completed";
  const [wi, setWi] = useState(when.idx);
  // Another day than the chips (filling in older work).
  const [otherDay, setOtherDay] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const picked = otherDay ? shiftWindow(otherDay, "day", tz, times) : (when.choices[wi] ?? when.choices[0]).w;
  const dayWord = otherDay ? fmtInTz(picked.start, tz, { weekday: "short", month: "short", day: "numeric" }) : picked.kind === "night" ? `${fmtInTz(picked.start, tz, { weekday: "short", month: "short", day: "numeric" })} night` : fmtInTz(picked.start, tz, { weekday: "short", month: "short", day: "numeric" });
  // A time that isn't on the shift picked lands on the shift it's on that
  // day ("Sat day" + 22:00 → Sat night) — said beside the time.
  const r = clock ? clockForWork(picked, clock, tz, times) : null;
  const win = r && "at" in r ? r.shift : picked;
  const pctNew = status === "in_progress" ? p : null;
  const ready = !!r && "at" in r && !!note.trim() && !saving;
  const save = async () => {
    if (!clock) { setMsg("Put in the time it happened."); return; }
    if (r && "error" in r) { setMsg(r.error); return; }
    if (!note.trim()) { setMsg(`${noteLabel} — it goes on the report.`); return; }
    if (status === "in_progress" && pctNew != null && pctNew >= 100) { setMsg("100% is Done — pick Done."); return; }
    setSaving(true); setMsg(null);
    try {
      // Said again for this shift (the report shows only this shift's), or changed.
      const lastWhyAt = info.why ? ms(info.why.happenedAt ?? info.why.createdAt) : NaN;
      const whyChanged = behind && why.trim() && (why.trim() !== (info.why?.body ?? "").trim() || !(lastWhyAt >= win.start && lastWhyAt <= win.end));
      const ok = await onSave({ status, pct: pctNew, note: note.trim(), at: (r as { at: number }).at, ...(whyChanged ? { why: why.trim() } : {}) });
      if (ok) { setSaved(`Saved at ${clock}.`); setNote(""); setClock(""); }
      else setMsg("Not saved.");
    } catch (e) { setMsg((e as Error).message || "Not saved."); }
    finally { setSaving(false); }
  };
  const chips = [10, 25, 50, 75, 90].filter((v) => v !== pct);
  const btn = "h-8 px-2 rounded-md border text-[11.5px] font-semibold disabled:opacity-50";
  const history = [
    ...info.rows.filter((x) => x.old_status != null && !(x.old_status === x.new_status && Number(x.old_percent ?? 0) === Number(x.new_percent ?? 0)))
      .map((x) => ({ at: Date.parse(x.at), text: `${describeChange(x.old_status, x.old_percent, x.new_status, x.new_percent)} · ${Number(x.old_percent ?? 0) !== Number(x.new_percent ?? 0) ? `${Number(x.old_percent ?? 0)}% → ${Number(x.new_percent ?? 0)}%` : `${Number(x.new_percent ?? 0)}%`}` })),
    ...info.mine.filter((n) => n.body?.trim() && n.kind !== "reschedule" && !/^Progress → \d+%$/.test(n.body.trim()))
      .map((n) => ({ at: ms(n.happenedAt ?? n.createdAt), text: `${n.kind === "behind" ? "Why behind: " : n.kind === "status" ? "Reason: " : ""}“${n.body!.trim()}”` })),
  ].filter((x) => Number.isFinite(x.at)).sort((a, b) => b.at - a.at);

  return (
    <div className="px-3 pb-3 pl-7 space-y-2 bg-[var(--color-surface)] text-[11.5px]">
      <div className="rounded-md bg-[var(--color-surface-2)] px-2 py-1.5 text-[var(--color-text)]">
        Now: <b>{WORD[m.status]}, {pct}%</b>{Number.isFinite(info.since) ? ` · since ${fmt(info.since)}` : ""}{m.status !== "completed" ? ` · plan ${plan}% by now` : ""}
      </div>
      {canEdit && info.shiftComment?.id ? <ReviseComment note={info.shiftComment} fmt={fmt} />
        : info.comment ? <div className="text-[var(--color-text-muted)] break-words">No comment for this shift yet. Last one: <i>“{info.comment.body}”</i> — {fmt(ms(info.comment.happenedAt ?? info.comment.createdAt))}</div> : null}
      {offHold && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-2 py-1.5 text-amber-900 dark:text-amber-200">
          Taking it off {cur === "on_hold" ? "hold" : "block"}. It was: <b>“{m.statusReason || "no reason given"}”</b>{Number.isFinite(info.since) ? ` (since ${fmt(info.since)})` : ""}. Say what changed.
        </div>
      )}
      {canEdit ? (
        <>
          <div>
            <div className="font-bold text-[var(--color-text)] mb-1">Status</div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Status">
              {STATUS.map((x) => (
                <button key={x.v} type="button" aria-pressed={status === x.v} onClick={() => { setStatus(x.v); setMsg(null); setSaved(null); }}
                  className={`${btn} ${status === x.v ? x.on : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>{x.label}</button>
              ))}
            </div>
          </div>
          {status === "in_progress" && (
            <div>
              <div className="font-bold text-[var(--color-text)] mb-1">% done <span className="font-normal text-[var(--color-text-muted)]">— now {pct}%</span></div>
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Percent done">
                {chips.map((v) => (
                  <button key={v} type="button" aria-pressed={p === v && !typed} onClick={() => { setP(v); setTyped(""); setMsg(null); }}
                    className={`${btn} w-10 ${p === v && !typed ? "bg-slate-900 border-slate-900 text-white" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>{v}</button>
                ))}
                <input value={typed} inputMode="numeric" placeholder={String(pct)} aria-label="Percent done"
                  onChange={(e) => { const t = e.target.value.replace(/[^0-9]/g, "").slice(0, 2); setTyped(t); setP(t === "" ? null : Number(t)); setMsg(null); }}
                  className="h-8 w-12 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-right font-mono text-[12px]" />
                <span className="text-[var(--color-text-muted)]">%</span>
              </div>
            </div>
          )}
          <div>
            <div className="font-bold text-[var(--color-text)] mb-1">When <span className="font-bold text-amber-700 dark:text-amber-400">— required</span></div>
            {when.ahead && (
              <div className="mb-1 text-[11px] text-emerald-800 dark:text-emerald-300">Planned later than now — put in when it was really done; it shows on that day as worked ahead.</div>
            )}
            <div className="flex flex-wrap gap-1 mb-1.5" role="group" aria-label="Which shift">
              {when.choices.map((c, i) => (
                <button key={c.w.start} type="button" aria-pressed={i === wi && !otherDay} onClick={() => { setWi(i); setOtherDay(null); setPicking(false); setMsg(null); setSaved(null); }}
                  className={`${btn} ${i === wi && !otherDay ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-text)]" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>{c.label}</button>
              ))}
              {picking || otherDay
                ? <DayPick value={otherDay} onChange={(d) => { setOtherDay(d); setMsg(null); setSaved(null); }} tz={tz} className={otherDay ? "ring-1 ring-[var(--color-accent)] border-[var(--color-accent)]" : ""} />
                : <button type="button" onClick={() => setPicking(true)} className={`${btn} border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]`}>Other day…</button>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <input value={clock} onChange={(e) => { setClock(typeClock(e.target.value)); setMsg(null); setSaved(null); }} inputMode="numeric" placeholder="hh:mm" aria-label="Time it happened, 24-hour"
                className={`h-8 w-[72px] rounded-md border-2 px-1.5 font-mono text-[13px] ${clock ? "border-[var(--color-border-strong)] bg-[var(--color-surface)]" : "border-amber-400 bg-amber-50 dark:bg-amber-950/30"}`} />
              <button type="button" onClick={() => { setWi(0); setOtherDay(null); setPicking(false); setClock(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz })); setMsg(null); }}
                className={`${btn} border-[var(--color-border-strong)] text-[var(--color-text)]`}>Now</button>
              {r && "at" in r
                ? <span className="text-[var(--color-text-muted)]">{r.moved ? "→ " : "on "}<b className="text-[var(--color-text)]">{shiftWord(r.shift, tz)}</b></span>
                : <span className="text-[var(--color-text-muted)]">on {dayWord}</span>}
            </div>
          </div>
          <div>
            <div className="font-bold text-[var(--color-text)] mb-1">{noteLabel} <span className="font-bold text-amber-700 dark:text-amber-400">— required, goes on the report</span></div>
            <input value={note} onChange={(e) => { setNote(e.target.value); setMsg(null); setSaved(null); }} onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              placeholder={status === "on_hold" ? "e.g. waiting on plugging to be removed" : status === "completed" ? "e.g. bundle pulled and set on the pad" : "e.g. 35 of 57 trays out"} aria-label={noteLabel}
              className={`h-9 w-full rounded-md border-2 px-2 text-[12.5px] ${note.trim() ? "border-[var(--color-border-strong)] bg-[var(--color-surface)]" : "border-amber-400 bg-amber-50 dark:bg-amber-950/30"}`} />
          </div>
          {behind && (
            <div>
              <div className="font-bold text-[var(--color-text)] mb-1">Why it&rsquo;s behind <span className="font-normal text-[var(--color-text-muted)]">— shows on the report next to −{Math.abs(hours)} h</span></div>
              <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. trays heavier fouled than planned" aria-label="Why it's behind"
                className="h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
            </div>
          )}
          {msg && <div className="font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
          {saved && <div role="status" className="font-semibold text-emerald-700 dark:text-emerald-400">{saved}</div>}
          <button type="button" onClick={() => void save()} disabled={saving}
            className={`w-full h-9 rounded-lg text-[12.5px] font-black ${ready ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]" : "bg-orange-200 text-orange-900 dark:bg-orange-950/50 dark:text-orange-200"}`}>
            {saving ? "Saving…" : !clock || !note.trim() ? "Put in the time and a comment"
              : `${status === "completed" ? "Mark done" : status === "on_hold" ? "Put on hold" : status === "blocked" ? "Mark blocked" : status === "planned" ? "Set to not started" : pctNew != null ? `Save ${pctNew}%` : "Save"} at ${clock}`}
          </button>
          {onMoveDays && m.id && (
            <div className="flex items-center gap-1 text-[10.5px] text-[var(--color-text-muted)]">
              Move this step a day:
              <button type="button" onClick={() => onMoveDays(m.id!, -1)} title="1 day earlier" className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--color-surface-2)]"><ChevronLeft className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => onMoveDays(m.id!, 1)} title="1 day later" className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--color-surface-2)]"><ChevronRight className="w-3.5 h-3.5" /></button>
            </div>
          )}
        </>
      ) : (
        <div className="text-[var(--color-text-muted)]">View only.</div>
      )}
      <details className="border-t border-dashed border-[var(--color-border-strong)] pt-1.5">
        <summary className="cursor-pointer font-bold text-[var(--color-text)]">History of this step</summary>
        {history.length === 0 ? <div className="mt-1 text-[var(--color-text-muted)]">Nothing recorded yet.</div> : (
          <ol className="mt-1 space-y-0.5">
            {history.slice(0, 12).map((x, i) => (
              <li key={i} className="break-words"><span className="font-mono text-[10.5px] text-[var(--color-text-muted)] mr-1.5">{fmt(x.at)}</span>{x.text}</li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}
