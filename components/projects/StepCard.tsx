"use client";

// StepCard — one step, opened from the calendar or the report. Kept to
// what's needed: the work order, crew and hours; planned against actual
// start and finish; one main button (Start, or Finish); when it happened
// (opens on now; a calendar and a time wheel for earlier, or Planned); an
// optional comment. The shift works itself out from the time. The last
// few things that happened sit underneath.

import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Play, Check } from "lucide-react";
import type { Milestone, MilestoneNote, MilestoneStatus } from "@/types/schema";
import { shiftAt, workHours, type ShiftTimes } from "@/lib/shiftReport";
import { fmtInTz, toDateTimeInput, fromDateTimeInput } from "@/lib/scheduleTz";
import DateTimePicker from "@/components/projects/DateTimePicker";
import { discoveryOf, kindOf, ADDED, type AddedKind } from "@/lib/discovery";
import { ADDED_TONE } from "@/components/projects/DiscoveryTag";
import PctSlider from "@/components/projects/PctSlider";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { updateMilestoneNote, setProgressTime, setNoteTime, updateDiscoveryRecord, deleteDiscovery } from "@/lib/milestones";
import { appConfirm } from "@/components/providers/DialogProvider";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { describeChange } from "@/lib/timeLog";

/** What a change saves (the schedule's one save — ExecutionView.updateStep). */
export interface StepUpdate {
  status: MilestoneStatus;
  /** For work in progress: the new %. Null = as it is. */
  pct: number | null;
  /** A comment for the report — optional, except a hold's reason. */
  note: string;
  /** When it happened. */
  at: number;
  /** Why it's behind, when given. */
  why?: string;
}

type Action = "start" | "progress" | "finish" | "hold" | "resume" | "edit" | "reopen";
/** Something in the history, and what moves when its time is fixed: its
 *  log line, the step's actual start / finish, its comments. */
interface HistoryEvent {
  key: string; at: number; text: string;
  said: Array<{ text: string; note: MilestoneNote | null }>;
  logId?: number; fix?: "start" | "finish"; noteIds: string[];
  /** Where it sits: its time, or — when its time wasn't saved — just
   *  before what was entered after it. `seq` breaks ties (entry order). */
  sort: number; seq: number;
  /** "unset": the time it happened wasn't saved (it reads the time it was
   *  typed in); "order": the time picked is after what came next. */
  unsure?: "unset" | "order";
  /** Its comment (a hold's reason, or what got done) — edited with it. */
  comment?: { note: MilestoneNote; text: string };
}
/** A logged change in words: "Started", "Progress · 25%", "Blocked". */
const logWords = (x: ProgressLogRow) => {
  const pct = Number(x.new_percent ?? 0), o = x.old_status;
  switch (x.new_status) {
    case "completed": return "Finished";
    case "in_progress":
      return o === "planned" || o === "missed" ? "Started"
        : o === "blocked" ? `Block lifted${pct ? ` · ${pct}%` : ""}`
          : o === "on_hold" ? `Off hold${pct ? ` · ${pct}%` : ""}`
            : o === "completed" ? `Reopened · ${pct}%` : `Progress · ${pct}%`;
    case "blocked": return "Blocked";
    case "on_hold": return "On hold";
    case "planned": return "Set back to not started";
    case "missed": return "Missed";
    default: return describeChange(x.old_status, x.old_percent, x.new_status, x.new_percent);
  }
};
/** The box that scrolls it: the nearest scrolling parent, else the page. */
function scrollParentOf(el: HTMLElement): HTMLElement {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}
const hoursWords = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h * 10) / 10} h`);
const ms = (v: unknown) => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));
const H = 3_600_000;

export default function StepCard({ m, wo, pct, hours, rows, notes, tz, times, now, canEdit, onUpdate, onFixTimes, onMoveDays }: {
  m: Milestone;
  wo?: string;
  pct: number;
  /** Work-hours ahead (+) / behind (−) of plan by now. */
  hours: number;
  /** Its progress log and its notes — what's happened. */
  rows: ProgressLogRow[];
  notes: MilestoneNote[];
  tz: string; times: ShiftTimes; now: number;
  canEdit: boolean;
  onUpdate?: (u: StepUpdate) => Promise<boolean>;
  /** Correct when it really started / finished. */
  onFixTimes?: (t: { start?: number | null; finish?: number | null }) => Promise<boolean>;
  onMoveDays?: (id: string, delta: number) => void;
}) {
  // "Sat 10:00 PM" this week; further off "Oct 24, 10:00 PM".
  const when = (t: number) => fmtInTz(t, tz, Math.abs(t - now) < 6 * 86_400_000
    ? { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

  const ps = startMsOf(m), pf = finishMsOf(m);
  const found = discoveryOf(m);
  // Correcting what was found and when (on every step it added).
  const [foundEdit, setFoundEdit] = useState<{ kind: AddedKind; what: string; at: string } | null>(null);
  const [foundMsg, setFoundMsg] = useState<string | null>(null);
  const [foundBusy, setFoundBusy] = useState(false);
  const saveFound = async () => {
    if (!found || !foundEdit || !m.projectId) return;
    const what = foundEdit.what.trim();
    const iso = foundEdit.at.length >= 16 ? fromDateTimeInput(foundEdit.at, tz) : null;
    const at = iso ? Date.parse(iso) : NaN;
    const k = ADDED[foundEdit.kind];
    if (!what) { setFoundMsg(foundEdit.kind === "added" ? "Say what's being added." : "Say what was found."); return; }
    if (!Number.isFinite(at)) { setFoundMsg(`Pick the day and the time it was ${k.found}.`); return; }
    if (at > Date.now() + 60_000) { setFoundMsg(`When it was ${k.found} can't be in the future.`); return; }
    setFoundBusy(true);
    try {
      await updateDiscoveryRecord(m.projectId, found.id, { kind: foundEdit.kind, what, foundAt: at });
      window.dispatchEvent(new CustomEvent("schedule:changed"));
      setFoundEdit(null); setSaved(`${k.word}: ${k.found} ${when(at)}`);
    } catch (e) { setFoundMsg((e as Error).message || "Not saved."); }
    finally { setFoundBusy(false); }
  };
  // Taking it off the schedule: every step it added, with their progress.
  const removeFound = async () => {
    if (!found || !m.projectId) return;
    const k = ADDED[kindOf(found)];
    const n = Math.max(1, found.of ?? 1);
    if (!(await appConfirm({
      title: `Delete this ${k.lower}?`,
      message: `“${found.what}” comes off the schedule: ${n === 1 ? "its step is" : `all ${n} of its steps are`} deleted, with any progress and comments on ${n === 1 ? "it" : "them"}. Steps that waited on it wait on what it waited on instead. Planned dates it pushed later stay where they are — move them back if they should.`,
      confirmLabel: `Delete ${k.lower}`,
    }))) return;
    setFoundBusy(true); setFoundMsg(null);
    try {
      await deleteDiscovery(m.projectId, found.id);
      window.dispatchEvent(new CustomEvent("schedule:changed"));
    } catch (e) { setFoundMsg((e as Error).message || "Not deleted."); }
    finally { setFoundBusy(false); }
  };
  const as = ms(m.actualStartAt), af = m.status === "completed" ? ms(m.actualAt) : NaN;
  const done = m.status === "completed", held = m.status === "on_hold" || m.status === "blocked";
  const started = done || m.status === "in_progress" || held || Number.isFinite(as);
  const allotted = Math.round((m.durationHours != null && m.durationHours > 0 ? m.durationHours : workHours(m, tz)) * 10) / 10;
  // One tag: how it stands against the plan.
  const tag = (() => {
    const d = done && Number.isFinite(af) ? af - pf : Number.isFinite(as) ? as - ps : Number.isFinite(ps) && now > ps ? now - ps : NaN;
    if (!Number.isFinite(d)) return null;
    const h = Math.abs(d) / H;
    if (h < 0.25) return { t: "on time", tone: "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40" };
    const v = h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`;
    const what = done ? "finished" : Number.isFinite(as) ? "started" : "not started";
    return d > 0 ? { t: what === "not started" ? `${v} past planned start` : `${what} ${v} late`, tone: "text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-950/40" }
      : { t: `${what} ${v} early`, tone: "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40" };
  })();

  // What's happened, in the order it happened, by shift. Things are
  // entered one after another as they happen, so the order they were
  // entered in is the order of events: a change whose time wasn't saved
  // (it reads the time it was typed in — later than what was entered after
  // it) keeps its place in that order, flagged to set. Started and
  // finished at the step's actual times; each comment on the change it
  // came with.
  const history = useMemo(() => {
    const ev: HistoryEvent[] = [];
    if (Number.isFinite(as)) ev.push({ key: "start", at: as, sort: as, seq: -1, text: "Started", said: [], fix: "start", noteIds: [] });
    if (done && Number.isFinite(af)) ev.push({ key: "finish", at: af, sort: af, seq: 1e9, text: "Finished", said: [], fix: "finish", noteIds: [] });
    const real = rows.filter((x) => x.old_status != null && !(x.old_status === x.new_status && Number(x.old_percent ?? 0) === Number(x.new_percent ?? 0)))
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0) || Date.parse(a.at) - Date.parse(b.at));
    // The earliest time of anything entered after each change.
    const after = real.map(() => Infinity);
    for (let i = real.length - 2; i >= 0; i--) after[i] = Math.min(after[i + 1], Date.parse(real[i + 1].at));
    const unsure = real.map((x, i): HistoryEvent["unsure"] => (Date.parse(x.at) > after[i] + 60_000 ? (x.entered_at ? "order" : "unset") : undefined));
    // Each saved change, by when it was saved — a comment goes with the
    // change it was saved with.
    const saves: Array<{ at: number; key: string }> = [];
    let startOwned = false;
    for (let i = 0; i < real.length; i++) {
      const x = real[i], t = Date.parse(x.at);
      const savedAt = Date.parse(x.entered_at ?? x.at);
      // Starts and finishes are told by the actual times; the log line goes
      // with them when the time is fixed.
      const own = (k: string) => { const e = ev.find((y) => y.key === k); if (e) { if (x.id != null) e.logId = x.id; e.seq = i; } };
      if (x.new_status === "completed") { if (done) { saves.push({ at: savedAt, key: "finish" }); own("finish"); } continue; }
      if (x.new_status === "in_progress" && (x.old_status === "planned" || x.old_status === "missed")) { if (Number.isFinite(as)) { saves.push({ at: savedAt, key: "start" }); own("start"); startOwned = true; } continue; }
      let text = logWords(x);
      // Back to work after a hold: how long it was held, when both times are known.
      const prev = real[i - 1];
      if (x.new_status === "in_progress" && (x.old_status === "blocked" || x.old_status === "on_hold") && prev && prev.new_status === x.old_status && !unsure[i] && !unsure[i - 1]) {
        const h = (t - Date.parse(prev.at)) / H;
        if (h > 0) text += ` · ${x.old_status === "blocked" ? "blocked" : "on hold"} ${hoursWords(h)}`;
      }
      const key = `r${x.id ?? ""}${x.at}${x.new_status}${x.new_percent}`;
      ev.push({ key, at: t, sort: unsure[i] ? after[i] : t, seq: i, text, said: [], logId: x.id, noteIds: [], unsure: unsure[i] });
      saves.push({ at: savedAt, key });
    }
    // Started straight off a hold (blocked before it began): one line.
    if (!startOwned && Number.isFinite(as)) {
      const off = ev.find((e) => e.logId != null && !e.unsure && Math.abs(e.at - as) <= 2 * 60_000 && /^(Block lifted|Off hold)/.test(e.text));
      if (off) {
        off.text = off.text.replace(/^Block lifted/, "Started — block lifted").replace(/^Off hold/, "Started — off hold");
        off.fix = "start";
        ev.splice(ev.findIndex((e) => e.key === "start"), 1);
      }
    }
    const near = 10 * 60_000;
    for (const n of notes) {
      // "(for Mon night shift)" — said by the time it's saved with.
      const body = n.happenedAt ? n.body?.trim().replace(/\s*\(for [^()]*shift\)\s*$/i, "") : n.body?.trim();
      if (!body || n.kind === "reschedule" || /^Progress → \d+%$/.test(body) || /^Actual times corrected/.test(body)) continue;
      if (n.kind === "status" && !(n.statusAt === "on_hold" || n.statusAt === "blocked")) continue;
      const at = ms(n.happenedAt ?? n.createdAt);
      if (!Number.isFinite(at)) continue;
      const line = { text: n.kind === "behind" ? `why behind: “${body}”` : `“${body}”`, note: n.kind === "note" && n.id ? n : null };
      const typed = ms(n.createdAt);
      const viaSave = saves.filter((x) => Math.abs(x.at - typed) <= near).sort((a, b) => Math.abs(a.at - typed) - Math.abs(b.at - typed))[0];
      const host = (viaSave ? ev.find((e) => e.key === viaSave.key) : undefined)
        ?? ev.filter((e) => Math.abs(e.at - at) <= near).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
      const comment = n.id && n.kind !== "behind" ? { note: n, text: body } : undefined;
      if (host) { host.said.push(line); if (n.id) host.noteIds.push(n.id); if (!host.comment && comment) host.comment = comment; }
      else ev.push({ key: `n${n.id ?? n.createdAt}`, at, sort: at, seq: 1e8, text: "", said: [line], noteIds: n.id ? [n.id] : [], comment });
    }
    return ev.filter((e) => Number.isFinite(e.sort)).sort((a, b) => a.sort - b.sort || a.seq - b.seq);
  }, [rows, notes, as, af, done]);
  const [allHistory, setAllHistory] = useState(false);
  // The step's last logged change: a time put in has to come after it
  // (the history reads in order; the reports read it by time). The log's
  // starting line isn't a change.
  const lastEntry = useMemo(() => {
    let best: { at: number; text: string } | null = null;
    for (const x of rows) {
      const t = Date.parse(x.at);
      if (x.old_status != null && Number.isFinite(t) && (!best || t > best.at)) best = { at: t, text: logWords(x) };
    }
    return best;
  }, [rows]);
  const beforeLast = (t: number) => (lastEntry && t < lastEntry.at - 60_000
    ? `That's before the last entry on this step — “${lastEntry.text}” at ${when(lastEntry.at)}. Pick a later time, or tap that entry's time in History to fix it first.`
    : null);
  // Fixing the time of something in the history.
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixV, setFixV] = useState("");
  const [fixText, setFixText] = useState("");
  const [fixMsg, setFixMsg] = useState<string | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const canFix = (x: HistoryEvent) => canEdit && (x.fix ? !!onFixTimes : x.logId != null || x.noteIds.length > 0);
  const canEditEntry = (x: HistoryEvent) => canFix(x) || (canEdit && !!x.comment);
  const openFix = (x: HistoryEvent) => {
    setFixing(fixing === x.key ? null : x.key); setFixMsg(null); setSaved(null);
    setFixV(toDateTimeInput(x.unsure === "unset" ? x.sort : x.at, tz));
    setFixText(x.comment?.text ?? "");
  };
  // Saves what changed: the time (its log line, the actual start or
  // finish, its comments move together) and the comment's words.
  const saveFix = async (x: HistoryEvent) => {
    const t = fixV.length >= 16 ? toMs(fixV) : NaN;
    if (!Number.isFinite(t)) { setFixMsg("Pick the day and the time."); return; }
    const text = fixText.trim();
    if (x.comment && !text) { setFixMsg("The comment can't be empty."); return; }
    const timeChanged = canFix(x) && (x.unsure === "unset" || Math.abs(t - x.at) >= 60_000);
    const textChanged = !!x.comment && text !== x.comment.text;
    if (!timeChanged && !textChanged) { setFixing(null); return; }
    if (timeChanged) {
      if (t > Date.now() + 60_000) { setFixMsg("That time is in the future."); return; }
      if (x.fix === "start" && Number.isFinite(af) && t > af) { setFixMsg(`It finished ${when(af)} — it can't start after that.`); return; }
      if (x.fix === "finish" && Number.isFinite(as) && t < as) { setFixMsg(`It started ${when(as)} — it can't finish before that.`); return; }
      // It stays between what came before it and what came after (ones
      // whose time wasn't saved don't count — theirs is the time typed).
      if (x.logId != null) {
        const seq = rows.filter((r) => r.old_status != null && r.id != null).sort((a, b) => a.id! - b.id!);
        const unsaved = (j: number) => !seq[j].entered_at && Date.parse(seq[j].at) > Math.min(Infinity, ...seq.slice(j + 1).map((y) => Date.parse(y.at))) + 60_000;
        const k = seq.findIndex((r) => r.id === x.logId);
        let prev: ProgressLogRow | null = null, next: ProgressLogRow | null = null;
        for (let j = k - 1; j >= 0 && !prev; j--) if (!unsaved(j)) prev = seq[j];
        for (let j = k + 1; k >= 0 && j < seq.length && !next; j++) if (!unsaved(j)) next = seq[j];
        if (prev && t < Date.parse(prev.at)) { setFixMsg(`That's before “${logWords(prev)}” at ${when(Date.parse(prev.at))}, which came first. If that one's wrong, fix it first.`); return; }
        if (next && t > Date.parse(next.at)) { setFixMsg(`That's after “${logWords(next)}” at ${when(Date.parse(next.at))}, which came next. If that one's wrong, fix it first.`); return; }
      }
    }
    setFixBusy(true); setFixMsg(null);
    try {
      if (textChanged && x.comment?.note.id) await updateMilestoneNote(x.comment.note.id, text);
      if (!timeChanged) { window.dispatchEvent(new CustomEvent("milestone-notes:changed")); setFixing(null); setSaved("Comment saved"); return; }
      if (x.logId != null) {
        const r = await setProgressTime(x.logId, t);
        if (r !== "ok") { setFixMsg(r === "missing" ? "Fixing a time needs the database update run first." : r === "range" ? "That's more than 60 days back." : "Not saved."); return; }
      }
      if (x.fix && onFixTimes && !(await onFixTimes(x.fix === "start" ? { start: t } : { finish: t }))) { setFixMsg("Not saved."); return; }
      // Its comments go with it.
      for (const id of x.noteIds) await setNoteTime(id, t).catch(() => undefined);
      window.dispatchEvent(new CustomEvent("milestone-notes:changed"));
      setFixing(null); setSaved(`Saved: ${when(t)}`);
    } catch (e) { setFixMsg((e as Error).message || "Not saved."); }
    finally { setFixBusy(false); }
  };

  const [action, setAction] = useState<Action | null>(null);
  const [atV, setAtV] = useState("");
  const [startV, setStartV] = useState("");
  const [p, setP] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");
  const [showWhy, setShowWhy] = useState(false);
  const [holdKind, setHoldKind] = useState<"on_hold" | "blocked">("on_hold");
  // After a save the form closes up, but what you're looking at stays put:
  // near the bottom of a scrolling list the browser would pull everything
  // down to fill the room the form took, so that room stays, out of sight
  // at the end of the card, and the list keeps its place.
  const rootRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ h: number; sc: HTMLElement; top: number; slack: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current, root = rootRef.current, room = roomRef.current;
    if (action || !a || !root || !room) return;
    anchor.current = null;
    const need = a.h - root.offsetHeight - a.slack;
    if (need > 0) { room.style.height = `${need}px`; a.sc.scrollTop = a.top; }
  }, [action]);
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = (a: Action) => {
    setAction(a); setMsg(null); setSaved(null); setNote(""); setWhy(""); setShowWhy(false); setP(null);
    // Opens on now (entering it as it happens); earlier is a tap away.
    setAtV(a === "edit" ? (Number.isFinite(af) ? toDateTimeInput(af, tz) : "") : toDateTimeInput(Date.now(), tz));
    setStartV(a === "edit" && Number.isFinite(as) ? toDateTimeInput(as, tz) : "");
  };
  const toMs = (v: string) => { const iso = fromDateTimeInput(v, tz); return iso ? Date.parse(iso) : NaN; };
  const need = (v: string, what: string): number | string => {
    const t = v.length >= 16 ? toMs(v) : NaN;
    if (!Number.isFinite(t)) return `Pick ${what}${v ? " — the time" : ""}.`;
    if (t > Date.now() + 60_000) return "That time is in the future.";
    return t;
  };

  const save = async () => {
    if (!action || busy) return;
    const run = async (u: StepUpdate) => (onUpdate ? onUpdate(u) : false);
    const extra = showWhy && why.trim() ? { why: why.trim() } : {};
    let ok = false, said = "";
    setMsg(null);
    setBusy(true);
    try {
      if (action === "start" || action === "resume") {
        const t = need(atV, "when it started");
        if (typeof t === "string") { setMsg(t); return; }
        const late = beforeLast(t); if (late) { setMsg(late); return; }
        ok = await run({ status: "in_progress", pct: null, note: note.trim(), at: t, ...extra });
        said = `Started ${when(t)}`;
      } else if (action === "progress") {
        if (p == null || p === Math.round(pct)) { setMsg("Slide it to the new %."); return; }
        const t = need(atV, "when");
        if (typeof t === "string") { setMsg(t); return; }
        const late = beforeLast(t); if (late) { setMsg(late); return; }
        // 100% is finished.
        if (p >= 100) {
          if (Number.isFinite(as) && t < as) { setMsg(`It started ${when(as)} — it can't finish before that.`); return; }
          ok = await run({ status: "completed", pct: null, note: note.trim(), at: t, ...extra });
          said = `Finished ${when(t)}`;
        } else {
          ok = await run({ status: "in_progress", pct: p, note: note.trim(), at: t, ...extra });
          said = `${p}% at ${when(t)}`;
        }
      } else if (action === "finish") {
        const f = need(atV, "when it finished");
        if (typeof f === "string") { setMsg(f); return; }
        let s: number | null = null;
        if (!started && startV.length >= 16) {
          const t = need(startV, "when it started");
          if (typeof t === "string") { setMsg(t); return; }
          if (t > f) { setMsg("It can't finish before it started."); return; }
          s = t;
        }
        if (Number.isFinite(as) && f < as) { setMsg(`It started ${when(as)} — it can't finish before that.`); return; }
        const late = beforeLast(s ?? f); if (late) { setMsg(late); return; }
        // Not started yet: its start goes in first.
        if (s != null && !(await run({ status: "in_progress", pct: null, note: "", at: s }))) { setMsg("Not saved."); return; }
        ok = await run({ status: "completed", pct: null, note: note.trim(), at: f, ...extra });
        said = `Finished ${when(f)}`;
      } else if (action === "hold") {
        if (!note.trim()) { setMsg("Say why."); return; }
        const t = need(atV, "when it stopped");
        if (typeof t === "string") { setMsg(t); return; }
        const late = beforeLast(t); if (late) { setMsg(late); return; }
        ok = await run({ status: holdKind, pct: null, note: note.trim(), at: t });
        said = `${holdKind === "blocked" ? "Blocked" : "On hold"} ${when(t)}`;
      } else if (action === "reopen") {
        if (!note.trim()) { setMsg("Say why."); return; }
        const t = need(atV, "when");
        if (typeof t === "string") { setMsg(t); return; }
        const late = beforeLast(t); if (late) { setMsg(late); return; }
        ok = await run({ status: "in_progress", pct: p ?? 90, note: note.trim(), at: t });
        said = "Reopened";
      } else if (action === "edit") {
        if (!onFixTimes) return;
        const s = startV ? need(startV, "the start") : null;
        if (typeof s === "string") { setMsg(s); return; }
        const f = done ? (atV ? need(atV, "the finish") : null) : undefined;
        if (typeof f === "string") { setMsg(f); return; }
        if (s != null && f != null && f < s) { setMsg("The finish can't be before the start."); return; }
        ok = await onFixTimes({ start: s, ...(done ? { finish: f ?? null } : {}) });
        said = "Times fixed";
      }
      if (ok) {
        const root = rootRef.current;
        if (root) { const sc = scrollParentOf(root); anchor.current = { h: root.offsetHeight, sc, top: sc.scrollTop, slack: sc.scrollHeight - sc.scrollTop - sc.clientHeight }; }
        setSaved(said); setAction(null);
      } else setMsg((x) => x ?? "Not saved.");
    } catch (e) { setMsg((e as Error).message || "Not saved."); }
    finally { setBusy(false); }
  };

  // One main button; the rest are small.
  const main: { a: Action; label: string; icon: React.ReactNode } | null = !canEdit || !onUpdate ? null
    : done ? null : held ? { a: "resume", label: "Resume", icon: <Play className="w-3.5 h-3.5" /> }
      : started ? { a: "finish", label: "Finish", icon: <Check className="w-3.5 h-3.5" /> } : { a: "start", label: "Start", icon: <Play className="w-3.5 h-3.5" /> };
  const more: Array<{ a: Action; label: string }> = !canEdit || !onUpdate ? [] : [
    ...(started && !done && !held ? [{ a: "progress" as Action, label: "Update %" }] : []),
    ...(!started || held ? [{ a: "finish" as Action, label: "Finish" }] : []),
    ...(!done && !held ? [{ a: "hold" as Action, label: "Hold" }] : []),
    ...(started && onFixTimes ? [{ a: "edit" as Action, label: "Fix times" }] : []),
    ...(done ? [{ a: "reopen" as Action, label: "Reopen" }] : []),
  ].filter((x) => x.a !== main?.a);

  const cell = "py-0.5 pr-3 whitespace-nowrap";
  // The latest few, oldest first; the rest a tap away.
  const LATEST = 8;
  const hidden = allHistory ? 0 : Math.max(0, history.length - LATEST);
  const shown = history.slice(hidden);
  const toSet = history.filter((x) => x.unsure === "unset").length;
  const shiftOf = (t: number) => {
    const w = shiftAt(t, tz, times);
    return { key: `${w.dayKey}:${w.kind}`, night: w.kind === "night", label: `${fmtInTz(w.start, tz, { weekday: "short", month: "short", day: "numeric" })} · ${w.kind} shift` };
  };
  const clock = (t: number) => fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true });
  const pickLabel = action === "start" || action === "resume" ? "Started" : action === "finish" ? "Finished" : action === "hold" ? "Stopped" : action === "edit" ? "Finished" : "When";
  return (
    <div ref={rootRef} className="px-3 pb-3 pl-7 space-y-2 bg-[var(--color-surface)] text-[12.5px]">
      {found && (
        <div className={`rounded-md border px-2 py-1 ${ADDED_TONE[foundEdit?.kind ?? kindOf(found)]}`}>
          {foundEdit ? (
            <div className="space-y-2 py-1">
              <div className="flex flex-wrap gap-1" role="group" aria-label="What kind of work">
                {(["discovery", "added"] as const).map((x) => (
                  <button key={x} type="button" aria-pressed={foundEdit.kind === x} onClick={() => { setFoundEdit({ ...foundEdit, kind: x }); setFoundMsg(null); }}
                    className={`h-8 px-3 rounded-md border text-[12px] font-bold text-[var(--color-text)] ${foundEdit.kind === x ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] opacity-70"}`}>{ADDED[x].word}</button>
                ))}
              </div>
              <label className="block">
                <span className="block font-semibold mb-1">{ADDED[foundEdit.kind].what}</span>
                <input value={foundEdit.what} onChange={(e) => { setFoundEdit({ ...foundEdit, what: e.target.value }); setFoundMsg(null); }} aria-label={ADDED[foundEdit.kind].what}
                  className="h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]" />
              </label>
              <DateTimePicker label={`When was it ${ADDED[foundEdit.kind].found}?`} value={foundEdit.at} onChange={(v) => { setFoundEdit({ ...foundEdit, at: v }); setFoundMsg(null); }} tz={tz} times={times} />
              {foundMsg && <div role="alert" className="font-semibold text-rose-700 dark:text-rose-400">{foundMsg}</div>}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void saveFound()} disabled={foundBusy}
                  className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold disabled:opacity-60">{foundBusy ? "Saving…" : "Save"}</button>
                <button type="button" onClick={() => setFoundEdit(null)} className="h-9 px-3 rounded-lg font-semibold text-[var(--color-text-muted)]">Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <b>{ADDED[kindOf(found)].word}</b>{Number.isFinite(found.foundAt) ? ` · ${ADDED[kindOf(found)].found} ${when(found.foundAt)}` : ""} — “{found.what}”. Not in the original schedule.
              {canEdit && m.projectId && <button type="button" onClick={() => { setFoundEdit({ kind: kindOf(found), what: found.what, at: toDateTimeInput(found.foundAt, tz) }); setFoundMsg(null); }} className="ml-1.5 text-[11px] font-semibold text-[var(--color-accent)] hover:underline">Edit</button>}
              {canEdit && m.projectId && <button type="button" onClick={() => void removeFound()} disabled={foundBusy} className="ml-2 text-[11px] font-semibold text-rose-700 dark:text-rose-400 hover:underline disabled:opacity-50">{foundBusy ? "Deleting…" : "Delete"}</button>}
              {foundMsg && <div role="alert" className="font-semibold text-rose-700 dark:text-rose-400">{foundMsg}</div>}
            </>
          )}
        </div>
      )}
      {m.description?.trim() && <div className="text-[var(--color-text-muted)] line-clamp-2 break-words">{m.description.trim()}</div>}
      <div className="text-[var(--color-text-muted)]">{[wo ? `WO ${wo}` : null, m.responsibleParty?.trim() || null, `${allotted} h`].filter(Boolean).join(" · ")}</div>
      <table className="text-[12.5px]">
        <thead><tr className="text-[11px] text-[var(--color-text-muted)]"><th /><th className={`${cell} text-left font-medium`}>Start</th><th className={`${cell} text-left font-medium`}>Finish</th></tr></thead>
        <tbody>
          <tr><td className={`${cell} text-[var(--color-text-muted)]`}>Plan</td><td className={cell}>{Number.isFinite(ps) ? when(ps) : "—"}</td><td className={cell}>{Number.isFinite(pf) ? when(pf) : "—"}</td></tr>
          <tr className="font-semibold"><td className={`${cell} font-normal text-[var(--color-text-muted)]`}>Actual</td><td className={cell}>{Number.isFinite(as) ? when(as) : "—"}</td><td className={cell}>{Number.isFinite(af) ? when(af) : held ? (m.status === "blocked" ? "blocked" : "on hold") : started ? `${pct}%` : "—"}</td></tr>
        </tbody>
      </table>
      {tag && <span className={`inline-block rounded px-1.5 py-0.5 text-[11.5px] font-bold ${tag.tone}`}>{tag.t}</span>}
      {held && m.statusReason && <div className="text-amber-800 dark:text-amber-300">“{m.statusReason}”</div>}
      {saved && <div role="status" className="font-semibold text-emerald-700 dark:text-emerald-400">✓ {saved}</div>}

      {(main || more.length > 0 || (canEdit && m.id)) && !action && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {main && (
            <button type="button" onClick={() => open(main.a)} className="inline-flex items-center gap-1 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)]">
              {main.icon}{main.label}
            </button>
          )}
          {more.map((x) => <button key={x.a} type="button" onClick={() => open(x.a)} className="font-semibold text-[var(--color-accent)] hover:underline">{x.label}</button>)}
          {/* The plan itself — dates, hours, crew, name — in the step's panel. */}
          {canEdit && m.id && <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("step:edit-plan", { detail: { id: m.id } }))} className="font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline">Edit plan</button>}
        </div>
      )}

      {action && (
        <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-2.5 space-y-2">
          {action === "progress" && <PctSlider value={p ?? Math.round(pct)} was={Math.round(pct)} onChange={(v) => { setP(v); setMsg(null); }} />}
          {action === "hold" && (
            <div className="flex gap-1">
              {([["on_hold", "On hold"], ["blocked", "Blocked"]] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={holdKind === k} onClick={() => setHoldKind(k)}
                  className={`h-8 px-3 rounded-md border text-[12px] font-bold ${holdKind === k ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"}`}>{l}</button>
              ))}
            </div>
          )}
          {(action === "edit" || (action === "finish" && !started)) && (
            <DateTimePicker label="Started" hint={action === "finish" ? "(if known)" : undefined} value={startV} onChange={(v) => { setStartV(v); setMsg(null); }} tz={tz} times={times} planned={ps}
              shortcuts={[{ label: "Planned", at: ps }]} showNow={action !== "edit"} />
          )}
          {(action !== "edit" || done) && (
            <DateTimePicker label={pickLabel} value={atV} onChange={(v) => { setAtV(v); setMsg(null); }} tz={tz} times={times}
              planned={action === "finish" || action === "edit" ? pf : ps}
              shortcuts={[{ label: "Planned", at: action === "finish" || action === "edit" ? pf : action === "start" || action === "resume" ? ps : NaN }]}
              showNow={action !== "edit"} />
          )}
          {action !== "edit" && (
            <input value={note} onChange={(e) => { setNote(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              placeholder={action === "hold" ? "Why? (required)" : action === "reopen" ? "Why reopen? (required)" : "Comment (optional)"} aria-label="Comment"
              className="h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
          )}
          {hours < -0.05 && !done && (action === "start" || action === "progress" || action === "finish" || action === "resume") && (
            showWhy
              ? <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why it's behind (optional)" aria-label="Why it's behind"
                className="h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
              : <button type="button" onClick={() => setShowWhy(true)} className="text-[11.5px] font-semibold text-[var(--color-accent)] hover:underline">+ Why it&apos;s behind</button>
          )}
          {msg && <div role="alert" className="font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void save()} disabled={busy}
              className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)] disabled:opacity-60">{busy ? "Saving…" : action === "progress" && p === 100 ? "Save as finished" : "Save"}</button>
            <button type="button" onClick={() => setAction(null)} className="h-9 px-3 rounded-lg text-[var(--color-text-muted)] font-semibold hover:text-[var(--color-text)]">Cancel</button>
          </div>
        </div>
      )}

      <div className="border-t border-[var(--color-border)] pt-1.5">
        <div className="flex items-baseline justify-between gap-2 mb-0.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">History</span>
          {toSet > 0 && <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">{toSet === 1 ? "1 time" : `${toSet} times`} to set</span>}
        </div>
        {history.length === 0 ? <div className="text-[var(--color-text-muted)]">Nothing yet.</div> : (
          <>
            {hidden > 0 && <button type="button" onClick={() => setAllHistory(true)} className="mb-0.5 text-[11.5px] font-semibold text-[var(--color-accent)] hover:underline">Show {hidden} earlier</button>}
            <ol>
              {shown.map((x, i) => {
                const sh = shiftOf(x.sort), head = i === 0 || shiftOf(shown[i - 1].sort).key !== sh.key;
                const editable = canEditEntry(x);
                const time = x.unsure === "unset" ? "set time" : x.unsure === "order" ? `⚠ ${when(x.at)}` : clock(x.at);
                const timeCls = x.unsure === "unset" ? "rounded px-1 text-[11px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                  : x.unsure === "order" ? "font-semibold text-amber-700 dark:text-amber-400" : "text-[var(--color-text-muted)]";
                const tip = x.unsure === "unset" ? "When it happened wasn't saved — tap to set it" : x.unsure === "order" ? "This time is after what came next — check it" : undefined;
                return (
                  <li key={x.key} className="text-[12px] break-words">
                    {head && <div className={`mt-1.5 text-[10.5px] font-bold uppercase tracking-wide ${sh.night ? "text-violet-700 dark:text-violet-300" : "text-sky-700 dark:text-sky-300"}`}>{sh.label}</div>}
                    <div className="py-0.5 pl-2 border-l-2 border-[var(--color-border)]">
                      {x.unsure && editable
                        ? <button type="button" onClick={() => openFix(x)} title={tip} className={`mr-1.5 whitespace-nowrap ${timeCls}`}>{time}</button>
                        : <span title={tip} className={`mr-1.5 whitespace-nowrap ${timeCls}`}>{time}</span>}
                      {x.text && <b className="text-[var(--color-text)]">{x.text}</b>}
                      {x.said.map((c, k) => <span key={k} className="text-[var(--color-text)]">{x.text || k > 0 ? " — " : ""}{c.text}</span>)}
                      {editable && fixing !== x.key && <button type="button" onClick={() => openFix(x)} className="ml-1.5 text-[11px] font-semibold text-[var(--color-accent)] hover:underline">Edit</button>}
                    </div>
                    {fixing === x.key && (
                      <div className="mt-1 mb-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-2.5 space-y-2 text-[12.5px]">
                        {canFix(x) && <DateTimePicker label="When it happened" value={fixV} onChange={(v) => { setFixV(v); setFixMsg(null); }} tz={tz} times={times} showNow={false} disabled={fixBusy} />}
                        {x.comment && (
                          <input value={fixText} onChange={(e) => { setFixText(e.target.value); setFixMsg(null); }} onKeyDown={(e) => { if (e.key === "Enter") void saveFix(x); }}
                            aria-label="Comment" disabled={fixBusy} className="h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
                        )}
                        {fixMsg && <div role="alert" className="font-semibold text-rose-700 dark:text-rose-400">{fixMsg}</div>}
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => void saveFix(x)} disabled={fixBusy}
                            className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)] disabled:opacity-60">{fixBusy ? "Saving…" : "Save"}</button>
                          <button type="button" onClick={() => setFixing(null)} className="h-9 px-3 rounded-lg text-[var(--color-text-muted)] font-semibold hover:text-[var(--color-text)]">Cancel</button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {allHistory && history.length > LATEST && <button type="button" onClick={() => setAllHistory(false)} className="mt-0.5 text-[11.5px] font-semibold text-[var(--color-accent)] hover:underline">Less</button>}
          </>
        )}
      </div>

      {canEdit && onMoveDays && m.id && !started && (
        <div className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
          Move plan a day
          <button type="button" onClick={() => onMoveDays(m.id!, -1)} title="1 day earlier" className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--color-surface-2)]"><ChevronLeft className="w-3.5 h-3.5" /></button>
          <button type="button" onClick={() => onMoveDays(m.id!, 1)} title="1 day later" className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--color-surface-2)]"><ChevronRight className="w-3.5 h-3.5" /></button>
        </div>
      )}
      <div ref={roomRef} aria-hidden className="!mt-0" />
    </div>
  );
}
