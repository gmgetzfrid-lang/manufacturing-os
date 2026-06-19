"use client";

// /scratchpad — the personal cockpit. PRODUCTION surface, real data.
//
// The spine: write → submit → it comes back organized → FLIP to verify
// (verbatim raw preserved in notes.raw_body) → it reminds you, with or
// without dates.
//
//   • Console bar: jot a task (parsed for due/recurring), paste a mess
//     (Organize — deterministic local rules, zero egress), or ask a
//     question (lib/askEngine routes to checkouts / holds / collisions /
//     search — real rows, real links).
//   • Note cards flip: organized front ⟷ exact original words, with
//     highlights showing which sentences became tasks.
//   • Board: brief buckets with temperature (overdue breathes, 7-day
//     escalation demands act/snooze/kill), recurring roll-forward,
//     "snoozed N× — still real?" via notes.task_meta. Group by time
//     or by thing (topicForTask).
//   • Check → one-line outcome receipt written INTO the line
//     (`✓date: outcome`) → flight log → weekly report export.
//   • Dateless notes resurface on login via the welcome-back nudge;
//     ONE composed morning-digest bell per day (maybeNotifyMorningDigest).
//   • No AI calls from this page, ever — the organizer and ask engine
//     are local rules. The HUD states exactly that.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Wand2, Clock, Sun, CalendarDays, CircleSlash, Check, X,
  ChevronDown, ChevronRight, Repeat, Trash2, RotateCcw, FileText, HelpCircle, Radar,
  ListChecks, Zap, Layers, BadgeCheck, Flame, AlarmClock, ArrowRight, Bell, AlertTriangle,
  Loader2, StickyNote, Pencil, Send, Copy, CheckCircle2, CalendarPlus,
  Flag, Sparkles, Printer, Building2, User as UserIcon, ArrowUpRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  getDailyBrief, maybeNotifyMorningDigest, listNotes, createNote,
  createOrganizedNote, updateNoteBody, updateNoteTaskMeta, deleteNote,
  extractTasks, completeTaskInBody, appendOutcomeToTask, snoozeTaskInBody,
  removeTaskLineFromBody, organizeCapture, getFlightLog, topicForTask,
  taskKeyFor, nextOccurrence, ymd, scratchpadColumnsReady, setNoteResolved,
  suggestReportPeriod, composeOrganizedBody,
  setTaskPriorityInBody, cleanTaskText,
  snoozeOffsetIso, withTaskReminder, taskRemindAt,
  buildReportDoc, reportDocToMarkdown, reportDocAiPrompt, mergeAiIntoReportDoc,
  type DailyBrief, type TaskWithNote, type Note, type FlightLogEntry,
  type ReportPeriod, type ReportDoc, type PriorityTier,
} from "@/lib/notes";
import { parseReminder } from "@/lib/reminderParse";
import { listNudgeTargets, sendTaskNudge, type NudgeTarget } from "@/lib/taskNudge";
import { getAiProvider } from "@/lib/ai";
import { parseAsk, runAsk, type AskAnswer } from "@/lib/askEngine";
import ScratchpadPanel from "@/components/notes/ScratchpadPanel";
import NoteFootnotes from "@/components/notes/NoteFootnotes";
import { appConfirm } from "@/components/providers/DialogProvider";

// ─── Page shell ─────────────────────────────────────────────────────────────

export default function ScratchpadPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  if (!activeOrgId || !uid) {
    return <div className="p-6 text-sm text-[var(--color-text-muted)]">No active organization.</div>;
  }
  return (
    <Cockpit
      orgId={activeOrgId}
      uid={uid}
      userEmail={userEmail ?? undefined}
      userRole={activeRole ?? undefined}
    />
  );
}

// ─── Cockpit ────────────────────────────────────────────────────────────────

type SnoozeWhen = "tomorrow" | "next shift" | "Monday";
/** A preset or an explicit calendar date. */
type SnoozeChoice = SnoozeWhen | { dateIso: string } | { minutes: number };

/** Friendly local time for a reminder, e.g. "Jun 19, 3:00 PM". */
function fmtRemind(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
interface Toast { id: string; msg: string }
interface Receipt { noteId: string; lineIndex: number; text: string }

const tid = () => Math.random().toString(36).slice(2, 9);
const keyOf = (noteId: string, lineIndex: number) => `${noteId}:${lineIndex}`;

function Cockpit({ orgId, uid, userEmail, userRole }: {
  orgId: string; uid: string; userEmail?: string; userRole?: string;
}) {
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  const [consoleText, setConsoleText] = useState("");
  const [organizing, setOrganizing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const consoleRef = useRef<HTMLTextAreaElement | null>(null);

  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [diffOff, setDiffOff] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const [leaving, setLeaving] = useState<Map<string, "dissolve" | "peel">>(new Map());
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [outcomeText, setOutcomeText] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [groupMode, setGroupMode] = useState<"time" | "thing">("thing");
  const [nudgeOpen, setNudgeOpen] = useState(true);
  const [nudgeDismissed, setNudgeDismissed] = useState<Set<string>>(new Set());
  // Main content is a single switch between the Tasks board (do/triage) and
  // the Notes surface (capture cards + the notes archive). One lens at a time
  // so the same task is never shown in two places at once.
  const [mainView, setMainView] = useState<"tasks" | "notes">("tasks");
  const [reportOpen, setReportOpen] = useState(false);
  // Default to the period you most likely owe TODAY (weekly on report
  // days, monthly at month boundaries, daily midweek).
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>(() => suggestReportPeriod());
  const [nudgeTask, setNudgeTask] = useState<TaskWithNote | null>(null);
  const [now, setNow] = useState<Date>(new Date());
  const [introOpen, setIntroOpen] = useState(false);
  const [flipReady, setFlipReady] = useState(true);


  const toast = useCallback((msg: string) => {
    const t = { id: tid(), msg };
    setToasts((arr) => [...arr, t]);
    setTimeout(() => setToasts((arr) => arr.filter((x) => x.id !== t.id)), 3000);
  }, []);

  // ── Load + the once-daily composed digest ──
  const staleNoDate = useCallback((b: DailyBrief): TaskWithNote[] =>
    b.noDate.filter(({ note }) => Date.now() - new Date(note.createdAt).getTime() > 48 * 3600_000), []);

  const refresh = useCallback(async (background?: boolean) => {
    if (!background) setLoading(true);
    try {
      const [b, ns] = await Promise.all([
        getDailyBrief(orgId, uid),
        listNotes({ orgId, actorUserId: uid, limit: 100 }),
      ]);
      setBrief(b);
      setNotes(ns);
      void maybeNotifyMorningDigest(orgId, uid, b, { staleNoDateCount: staleNoDate(b).length }).catch(() => {});
    } finally {
      setLoading(false);
    }
  }, [orgId, uid, staleNoDate]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Session-scoped nudge dismissals, per day.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`cockpit-nudge-${ymd(new Date())}`);
      if (raw) setNudgeDismissed(new Set(JSON.parse(raw) as string[]));
    } catch { /* fresh session */ }
  }, []);
  const dismissNudge = useCallback((k: string) => {
    setNudgeDismissed((s) => {
      const next = new Set(s).add(k);
      try { sessionStorage.setItem(`cockpit-nudge-${ymd(new Date())}`, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Detect whether flip-to-verify / snooze-tracking columns exist.
  useEffect(() => { void scratchpadColumnsReady().then(setFlipReady); }, []);

  // First-visit power intro — dismissible once, recallable via the ? button.
  useEffect(() => {
    try { if (localStorage.getItem("scratchpad-intro-v1") !== "done") setIntroOpen(true); } catch { setIntroOpen(true); }
  }, []);
  const dismissIntro = useCallback(() => {
    setIntroOpen(false);
    try { localStorage.setItem("scratchpad-intro-v1", "done"); } catch { /* ignore */ }
  }, []);

  // Re-surface the dateless-task nudge when the page has been sitting
  // open for hours (the agreed trigger beyond login). Checks every 10
  // minutes; re-opens after 4h of the banner being away — the banner
  // itself still only renders when there are aging items.
  const lastNudgeShownAt = useRef(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (nudgeOpen) { lastNudgeShownAt.current = Date.now(); return; }
      if (Date.now() - lastNudgeShownAt.current < 4 * 3600_000) return;
      lastNudgeShownAt.current = Date.now();
      setNudgeOpen(true);
    }, 10 * 60_000);
    return () => window.clearInterval(id);
  }, [nudgeOpen]);

  // Live clock.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // "/" focuses the console.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (e.key === "/" && tag !== "TEXTAREA" && tag !== "INPUT") {
        e.preventDefault();
        consoleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Task mutations (all through lib/notes pure rewrites) ──
  const persistBody = useCallback(async (note: Note, newBody: string) => {
    if (newBody.trim() === "") {
      await deleteNote(note.id, uid, orgId);
    } else {
      await updateNoteBody({ id: note.id, body: newBody, updatedBy: uid });
    }
  }, [uid, orgId]);

  const withAnim = useCallback(async (k: string, anim: "dissolve" | "peel", fn: () => Promise<void>) => {
    if (busyKeys.has(k)) return;
    setBusyKeys((s) => new Set(s).add(k));
    setLeaving((m) => new Map(m).set(k, anim));
    try {
      await fn();
      await refresh(true);
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`);
    } finally {
      setLeaving((m) => { const n = new Map(m); n.delete(k); return n; });
      setBusyKeys((s) => { const n = new Set(s); n.delete(k); return n; });
    }
  }, [busyKeys, refresh, toast]);

  const completeTask = useCallback(async ({ note, task }: TaskWithNote) => {
    const k = keyOf(note.id, task.lineIndex);
    let rolledTo: string | null = null;
    await withAnim(k, "dissolve", async () => {
      const res = completeTaskInBody(note.body, task.lineIndex);
      rolledTo = res.rolled ? res.nextDueAt : null;
      await persistBody(note, res.body);
    });
    if (rolledTo) {
      toast(`Recurring — rolled to ${rolledTo}`);
    } else {
      setReceipt({ noteId: note.id, lineIndex: task.lineIndex, text: task.body });
      setOutcomeText("");
    }
  }, [withAnim, persistBody, toast]);

  const logReceipt = useCallback(async (r: Receipt, outcome: string) => {
    setReceipt(null);
    const trimmed = outcome.trim();
    if (!trimmed) { toast("Logged"); return; }
    const note = notes.find((n) => n.id === r.noteId);
    if (!note) return;
    try {
      const newBody = appendOutcomeToTask(note.body, r.lineIndex, trimmed);
      if (newBody !== note.body) await persistBody(note, newBody);
      await refresh(true);
      toast("Logged to flight log");
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`);
    }
  }, [notes, persistBody, refresh, toast]);

  const snoozeTask = useCallback(async ({ note, task }: TaskWithNote, when: SnoozeChoice) => {
    setSnoozeMenuFor(null);
    const k0 = keyOf(note.id, task.lineIndex);

    // Phone-style timed snooze → a precise alarm in task_meta.remindAt (no body
    // rewrite). It goes quiet until the minutes elapse, then fires again.
    if (typeof when === "object" && "minutes" in when) {
      const remindAt = snoozeOffsetIso(when.minutes, now);
      await withAnim(k0, "peel", async () => {
        const meta = withTaskReminder(note.taskMeta, task.body, remindAt);
        await updateNoteTaskMeta(note.id, meta, uid);
      });
      const m = when.minutes;
      toast(`Reminder set — back in ${m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`}`);
      await refresh(true);
      return;
    }

    const iso = typeof when === "object" ? when.dateIso
      : when === "Monday" ? nextOccurrence("monday", now) : nextOccurrence("day", now);
    // A task with no prior date is being SCHEDULED, not snoozed — don't count
    // it as a snooze, and word the confirmation accordingly.
    const settingFirstDate = !task.dueAt;
    const k = keyOf(note.id, task.lineIndex);
    await withAnim(k, "peel", async () => {
      await persistBody(note, snoozeTaskInBody(note.body, task.lineIndex, iso));
      if (!settingFirstDate) {
        // Cosmetic snooze counter; silently unavailable pre-migration.
        const metaKey = taskKeyFor(task.body);
        const meta = { ...note.taskMeta, [metaKey]: { snoozes: (note.taskMeta[metaKey]?.snoozes ?? 0) + 1 } };
        void updateNoteTaskMeta(note.id, meta, uid);
      }
    });
    toast(settingFirstDate
      ? `Due date set — ${iso}`
      : `Snoozed — see you ${typeof when === "object" && "dateIso" in when ? when.dateIso : when === "Monday" ? "Monday" : when}`);
  }, [withAnim, persistBody, uid, toast, now, refresh]);

  // Priority — sets/clears the `!pN` token on the task line. Pure rewrite,
  // same persist path as snooze/complete.
  const setPriority = useCallback(async ({ note, task }: TaskWithNote, p: PriorityTier | null) => {
    try {
      await persistBody(note, setTaskPriorityInBody(note.body, task.lineIndex, p));
      await refresh(true);
    } catch (err) { toast(`Save failed: ${(err as Error).message}`); }
  }, [persistBody, refresh, toast]);

  // Per-task update note. The user types a rough progress/problem note; when
  // an AI provider is configured we polish it into one crisp status line,
  // then append it to the task's meta (newest last). Feeds the report.
  const addTaskUpdate = useCallback(async ({ note, task }: TaskWithNote, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let finalText = trimmed;
    const ai = getAiProvider();
    if (ai.isReal) {
      try {
        const polished = (await ai.summarize(
          `Rewrite this task progress note as ONE concise, professional status sentence — no preamble, no quotes.\nTask: ${cleanTaskText(task)}\nNote: ${trimmed}`
        )).trim();
        if (polished) finalText = polished;
      } catch { /* keep the raw note */ }
    }
    const key = taskKeyFor(task.body);
    const prevMeta = note.taskMeta[key] ?? {};
    const prevUpdates = prevMeta.updates ?? [];
    const meta = { ...note.taskMeta, [key]: { ...prevMeta, updates: [...prevUpdates, { at: new Date().toISOString(), text: finalText }] } };
    try {
      const ok = await updateNoteTaskMeta(note.id, meta, uid);
      await refresh(true);
      toast(ok ? (ai.isReal ? "Update logged (AI-polished)" : "Update logged")
               : "Update couldn't persist — apply migration 20260730 to enable per-task notes");
    } catch (err) { toast(`Save failed: ${(err as Error).message}`); }
  }, [uid, refresh, toast]);

  // Whether a real AI provider is configured (controls "AI-polish" affordances).
  const aiReady = getAiProvider().isReal;

  const killTask = useCallback(async ({ note, task }: TaskWithNote) => {
    if (!(await appConfirm({ message: "Remove this task line for good?", tone: "danger" }))) return;
    const k = keyOf(note.id, task.lineIndex);
    await withAnim(k, "dissolve", async () => {
      await persistBody(note, removeTaskLineFromBody(note.body, task.lineIndex));
    });
    toast("Killed. It won't haunt you.");
  }, [withAnim, persistBody, toast]);

  // ── Console ──
  const wantsOrganize = consoleText.trim().length > 110 || consoleText.includes("\n");
  const looksLikeQuestion = /\?\s*$/.test(consoleText.trim()) || /^(who|what|where|when|how|show|find|search)\b/i.test(consoleText.trim());

  const runOrganize = useCallback(async () => {
    const text = consoleText.trim();
    if (!text || organizing) return;
    setOrganizing(true);
    try {
      // With an AI provider configured, the model does the heavy organizing
      // (best splitting + context). Otherwise the local rules engine. Both
      // yield the same {title, findings, tasks}; AI failures fall back to the
      // heuristic inside the provider.
      const provider = getAiProvider();
      let body: string, taskCount: number, findingCount: number;
      if (provider.isReal) {
        const ai = await provider.organizeNote(text);
        const composed = composeOrganizedBody(ai.title || "Note", ai.findings, ai.tasks);
        body = composed.body; taskCount = composed.taskCount; findingCount = composed.findingCount;
      } else {
        const org = organizeCapture(text);
        body = org.body; taskCount = org.taskCount; findingCount = org.findingCount;
      }

      if (taskCount === 0 && findingCount === 0) {
        await createNote({ orgId, body: text, createdBy: uid, createdByName: userEmail });
        toast("Saved as a note — nothing actionable detected");
      } else {
        const { rawPreserved } = await createOrganizedNote({
          orgId, body, rawBody: text, createdBy: uid, createdByName: userEmail,
        });
        toast(rawPreserved
          ? `Organized — ${taskCount} task${taskCount === 1 ? "" : "s"} extracted. Flip the card to verify.`
          : "Organized — apply migration 20260730 to also keep your raw text");
      }
      setConsoleText("");
      await refresh(true);
    } catch (err) {
      toast(`Couldn't save: ${(err as Error).message}`);
    } finally {
      setOrganizing(false);
    }
  }, [consoleText, organizing, orgId, uid, userEmail, refresh, toast]);

  const submitConsole = useCallback(async () => {
    const text = consoleText.trim();
    if (!text) return;
    if (wantsOrganize) { await runOrganize(); return; }
    // "report" / "daily report" / "weekly report" / "monthly report" —
    // the console deciphers which report you mean and opens it.
    const reportCmd = text.match(/^(?:open\s+|show\s+(?:me\s+)?|give\s+me\s+(?:a\s+|my\s+)?)?(daily|weekly|monthly)?\s*report\??$/i);
    if (reportCmd) {
      const p: ReportPeriod = reportCmd[1]
        ? (reportCmd[1].toLowerCase() === "daily" ? "day" : reportCmd[1].toLowerCase() === "weekly" ? "week" : "month")
        : suggestReportPeriod();
      setReportPeriod(p);
      setReportOpen(true);
      setConsoleText("");
      return;
    }
    if (looksLikeQuestion) {
      setAsking(true);
      try {
        setAnswer(await runAsk({ orgId, brief }, parseAsk(text)));
        setConsoleText("");
      } catch (err) {
        toast(`Ask failed: ${(err as Error).message}`);
      } finally {
        setAsking(false);
      }
      return;
    }
    try {
      const body = /^\s*[-*]\s*\[/.test(text) ? text : `- [ ] ${text}`;
      const note = await createNote({ orgId, body, createdBy: uid, createdByName: userEmail });
      setConsoleText("");
      const t = extractTasks({ id: note.id, body })[0];
      // AI/heuristic: if the line says WHEN to be reminded ("in 2 hours",
      // "at 3pm", "by end of day", "july 1"), set a precise alarm for you.
      // Only when there's an explicit time, or the date parser found nothing —
      // so plain date phrases (e.g. "friday") still ride the calendar dueAt.
      let remindMsg: string | null = null;
      if (t && !t.completed && !taskRemindAt(note.taskMeta, t.body)) {
        const parsed = parseReminder(t.body, { now: new Date() });
        if (parsed && (parsed.hasTime || !t.dueAt)) {
          const meta = withTaskReminder(note.taskMeta, t.body, parsed.remindAt);
          await updateNoteTaskMeta(note.id, meta, uid);
          remindMsg = `⏰ Reminder set for ${fmtRemind(parsed.remindAt)}`;
        }
      }
      toast(remindMsg ?? (t?.dueAt ? `Filed — due ${t.dueAt}` : t?.recurring ? `Filed — every ${t.recurring}` : "Filed to No date — the login nudge keeps it alive"));
      await refresh(true);
    } catch (err) {
      toast(`Couldn't save: ${(err as Error).message}`);
    }
  }, [consoleText, wantsOrganize, looksLikeQuestion, runOrganize, orgId, uid, userEmail, brief, refresh, toast]);

  // ── Note card actions ──
  const saveEdit = useCallback(async (note: Note) => {
    try {
      await persistBody(note, editDraft);
      setEditingId(null);
      await refresh(true);
      toast("Saved");
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`);
    }
  }, [editDraft, persistBody, refresh, toast]);

  const removeNote = useCallback(async (note: Note) => {
    if (!(await appConfirm({ message: "Delete this note and its tasks?", tone: "danger" }))) return;
    try {
      await deleteNote(note.id, uid, orgId);
      await refresh(true);
      toast("Note deleted");
    } catch (err) {
      toast(`Delete failed: ${(err as Error).message}`);
    }
  }, [uid, orgId, refresh, toast]);

  // ── Derived ──
  const nudgeItems = useMemo(() => {
    if (!brief) return [] as TaskWithNote[];
    return staleNoDate(brief).filter(({ note, task }) => !nudgeDismissed.has(keyOf(note.id, task.lineIndex)));
  }, [brief, staleNoDate, nudgeDismissed]);

  const flightLog = useMemo(() => getFlightLog(notes), [notes]);
  const since7 = useMemo(() => ymd(new Date(Date.now() - 7 * 864e5)), []);
  const weekLog = useMemo(() => flightLog.filter((e) => e.doneAt >= since7), [flightLog, since7]);
  const topTopic = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of weekLog) counts.set(e.topic, (counts.get(e.topic) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  }, [weekLog]);

  const openByTopic = useMemo(() => {
    if (!brief) return [] as Array<[string, TaskWithNote[]]>;
    const all = [...brief.overdue, ...brief.today, ...brief.soon, ...brief.later, ...brief.noDate];
    const m = new Map<string, TaskWithNote[]>();
    for (const item of all) {
      const topic = topicForTask(item.task.body);
      const arr = m.get(topic) ?? [];
      arr.push(item);
      m.set(topic, arr);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [brief]);

  // The report is built + edited + exported inside <ReportComposer/> from
  // `notes` + the chosen period — see below. Nothing to precompute here.

  // Close (archive) a whole note — it leaves the cockpit but stays
  // recoverable under All notes → Include resolved.
  const resolveNote = useCallback(async (note: Note) => {
    try {
      await setNoteResolved({ id: note.id, resolved: true, actorUserId: uid });
      await refresh(true);
      toast("Note closed — archived under All notes (Include resolved)");
    } catch (err) {
      toast(`Close failed: ${(err as Error).message}`);
    }
  }, [uid, refresh, toast]);

  // ── Render ──
  if (loading && !brief) {
    return (
      <div className="min-h-screen bg-[var(--color-canvas)] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" />
      </div>
    );
  }
  if (!brief) return null;

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const dateLabel = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  const isEmpty = brief.totals.total === 0 && notes.length === 0;
  const cards = notes.filter((n) => !n.resolved).slice(0, 3);

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] text-[var(--color-text)] pb-28 bg-[radial-gradient(ellipse_at_top,rgba(251,146,60,0.08),transparent_55%)]">
      <style>{COCKPIT_CSS}</style>
      <div className="max-w-7xl mx-auto px-6 pt-6">

        {/* Header */}
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2">
              <StickyNote className="w-5 h-5 text-[var(--color-accent)]" />
              <h1 className="text-xl font-black text-[var(--color-text)] tracking-tight">Scratchpad</h1>
              <HudChip />
              <button onClick={() => setIntroOpen((v) => !v)} className="p-1 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="What can this do?">
                <HelpCircle className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              Write → submit → organized → flip to verify → it reminds you. Private to you. Press <kbd className="px-1 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] font-mono text-[10px]">/</kbd> for the console.
            </p>
          </div>
          <div className="text-right">
            <div className="font-mono text-3xl font-black text-[var(--color-text)] tabular-nums leading-none">
              {hh}:{mm}<span className="text-[var(--color-text-faint)]">:{ss}</span>
            </div>
            <div className="text-[10px] font-black tracking-[0.25em] text-[var(--color-text-muted)] mt-1">{dateLabel}</div>
          </div>
        </div>

        {/* First-visit explainer — the power, frictionlessly. One tap to try
            each capability, one tap to dismiss forever, ? to bring it back. */}
        {introOpen && (
          <div className="mt-4 rounded-2xl border border-[var(--color-accent-ring)] bg-gradient-to-br from-[var(--color-accent-soft)] via-[var(--color-surface)] to-violet-500/[0.08] p-4 cockpit-flipin">
            <div className="flex items-start gap-2">
              <Wand2 className="w-4 h-4 text-[var(--color-accent)] mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-[var(--color-text)]">This isn&apos;t a notepad. It&apos;s your seat in the cockpit.</div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">Four things it does the moment you type — tap one to try it:</div>
              </div>
              <button onClick={dismissIntro} className="shrink-0 px-2 py-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[10px] font-black text-[var(--color-text)] hover:text-[var(--color-text)]">Got it</button>
            </div>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              <IntroTry icon={Zap} title="Jot → tracked reminder" sub="dates, recurring, or none at all — it nudges you either way"
                onClick={() => { setConsoleText("call Joe about the gasket spec due friday"); consoleRef.current?.focus(); }} />
              <IntroTry icon={Wand2} title="Paste a mess → organized" sub="then FLIP the card to verify your exact words survived"
                onClick={() => { setConsoleText("walked unit 3 this morning, e-204 flange still weeping. need to call joe about the gasket spec before friday. also order 2 spare gaskets"); consoleRef.current?.focus(); }} />
              <IntroTry icon={HelpCircle} title="Ask the site" sub="who has E-204? what&apos;s blocked? — live answers with links"
                onClick={() => { setConsoleText("who has E-204?"); consoleRef.current?.focus(); }} />
              <IntroTry icon={Radar} title="It watches what you mention" sub="locked docs, blocked assets, schedule tasks landing sooner than they read"
                onClick={() => { setConsoleText("check the hydrotest on E-204 next week"); consoleRef.current?.focus(); }} />
            </div>
            {/* The Excel-replacement: notes in, status report out. */}
            <button
              onClick={() => { setReportPeriod(suggestReportPeriod()); setReportOpen(true); }}
              className="mt-1.5 w-full flex items-start gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left hover:border-[var(--color-accent-ring)] transition-colors"
            >
              <BadgeCheck className="w-3.5 h-3.5 text-[var(--color-accent)] mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-xs font-black text-[var(--color-text)]">It writes your status report — no more Excel</span>
                <span className="block text-[10px] text-[var(--color-text-muted)]">daily / weekly / monthly: achievements, roadblocks, in-progress, daily log — or just type “weekly report” in the console</span>
              </span>
            </button>
            <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">Private to you · deterministic local rules · nothing leaves your org&apos;s database.</div>
          </div>
        )}

        {/* Status strip */}
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <StatusChip icon={Flame} label="overdue" value={brief.totals.overdue} tone="rose" />
          <StatusChip icon={Sun} label="today" value={brief.totals.today} tone="amber" />
          <StatusChip icon={CalendarDays} label="this week" value={brief.totals.soon} tone="blue" />
          <StatusChip icon={CircleSlash} label="no date" value={brief.totals.noDate} tone="slate" />
          <StatusChip icon={BadgeCheck} label="done this week" value={weekLog.length} tone="emerald" />
        </div>

        {/* Why flip-to-verify might be missing: the columns aren't there yet.
            Explain it instead of silently hiding the feature. */}
        {!flipReady && (
          <div className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/[0.07] px-4 py-2.5 flex items-start gap-2 text-[11px]">
            <RotateCcw className="w-3.5 h-3.5 text-sky-700 dark:text-sky-300 mt-0.5 shrink-0" />
            <div className="text-[var(--color-text-muted)]">
              <span className="font-black text-sky-800 dark:text-sky-200">Flip-to-verify isn&apos;t active yet.</span> Apply migration{" "}
              <code className="font-mono bg-[var(--color-surface-2)] px-1 rounded text-[var(--color-text)]">20260730_scratchpad_cockpit.sql</code>{" "}
              to keep your verbatim original when you Organize a capture (and to track snooze counts). Until then, capturing still works — there&apos;s just no separate original to flip to.
            </div>
          </div>
        )}

        {/* Quick capture — a real, obvious type-here field (not a flat card). */}
        <div className={`mt-4 rounded-2xl border bg-[var(--color-surface)] shadow-sm transition-colors ${organizing ? "border-[var(--color-accent-ring)] ring-2 ring-[var(--color-accent-ring)]/20" : "border-[var(--color-border)]"}`}>
          <div className="px-4 pt-3 pb-1 flex items-center gap-2">
            <span className="shrink-0 w-6 h-6 rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)] flex items-center justify-center"><Wand2 className="w-3.5 h-3.5" /></span>
            <span className="text-sm font-black text-[var(--color-text)]">Brain-dump it</span>
            <span className="text-[11px] text-[var(--color-text-muted)] hidden sm:inline">— write it however it comes out; we&rsquo;ll organize it into tasks for you.</span>
          </div>
          <div className="px-4 pt-1 pb-2">
            {/* The recessed field is the affordance — bordered, captioned,
                with a persistent send button so it never reads as a card. */}
            <div className={`flex items-end gap-2 rounded-xl border px-3 py-2 transition-all ${organizing ? "border-[var(--color-accent-ring)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/50 focus-within:border-[var(--color-accent-ring)] focus-within:bg-[var(--color-surface)] focus-within:ring-2 focus-within:ring-[var(--color-accent-ring)]/20"}`}>
              <Pencil className="w-4 h-4 text-[var(--color-text-faint)] shrink-0 mb-1.5" />
              <textarea
                ref={consoleRef}
                value={consoleText}
                onChange={(e) => setConsoleText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitConsole(); }
                }}
                rows={consoleText.includes("\n") ? 3 : 2}
                placeholder="Type here — walked unit 3, E-204 flange still weeping, call Joe re gasket spec before friday, order 2 spare gaskets…"
                className="flex-1 bg-transparent resize-none outline-none text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] caret-[var(--color-accent)] leading-relaxed self-stretch"
              />
              <button
                onClick={() => void submitConsole()}
                disabled={organizing || asking || !consoleText.trim()}
                title={wantsOrganize ? "Organize into tasks" : looksLikeQuestion ? "Ask the scratchpad" : "File this note"}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {organizing || asking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : wantsOrganize ? <Wand2 className="w-3.5 h-3.5" /> : looksLikeQuestion ? <Zap className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{organizing ? "Organizing…" : asking ? "Asking…" : wantsOrganize ? "Organize" : looksLikeQuestion ? "Ask" : "File"}</span>
              </button>
            </div>
          </div>
          <div className="px-4 pb-3 flex items-center gap-2 text-[10px] font-bold flex-wrap">
            <span className="text-[var(--color-text-muted)]">Try:</span>
            {([
              ["call Joe about the gasket spec due friday", "task with a due date"],
              ["grease P-101A bearings every monday", "recurring"],
              ["who has E-204?", "who has E-204?"],
              ["what's blocked?", "what's blocked?"],
            ] as Array<[string, string]>).map(([text, label]) => (
              <button
                key={label}
                onClick={() => setConsoleText(text)}
                className="px-2 py-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)] hover:text-[var(--color-text)] transition-colors"
              >
                {label}
              </button>
            ))}
            <span className="ml-auto text-[var(--color-text-faint)] hidden sm:inline">Enter to file · Shift+Enter for a new line</span>
          </div>
        </div>

        {/* Answer card */}
        {answer && (
          <div className="mt-3 rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 to-[var(--color-surface)] p-4 cockpit-flipin">
            <div className="flex items-start gap-3">
              <Zap className="w-4 h-4 text-cyan-600 dark:text-cyan-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-[var(--color-text)]">{answer.title}</div>
                <div className="mt-1.5 space-y-1">
                  {answer.lines.map((l, i) => l.href ? (
                    <Link key={i} href={l.href} className={`block text-xs hover:text-cyan-700 dark:text-cyan-300 ${l.strong ? "text-[var(--color-text)] font-bold" : "text-[var(--color-text-muted)]"}`}>
                      {l.text} <ChevronRight className="w-3 h-3 inline -mt-0.5 text-[var(--color-text-faint)]" />
                    </Link>
                  ) : (
                    <div key={i} className="text-xs text-[var(--color-text-muted)]">{l.text}</div>
                  ))}
                </div>
                {answer.more && (
                  <Link href={answer.more.href} className="mt-2 inline-flex items-center gap-1 text-[11px] font-black text-cyan-600 dark:text-cyan-400 hover:text-cyan-700 dark:text-cyan-300">
                    {answer.more.label} <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
              <button onClick={() => setAnswer(null)} className="text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        {/* Welcome-back nudge — dateless notes resurface, no due date needed */}
        {nudgeOpen && nudgeItems.length > 0 && (
          <div className="mt-3 rounded-2xl border border-sky-500/25 bg-gradient-to-r from-sky-500/10 via-[var(--color-surface)] to-[var(--color-surface)] p-4 cockpit-flipin">
            <div className="flex items-start gap-3">
              <Bell className="w-4 h-4 text-sky-700 dark:text-sky-300 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-[var(--color-text)]">
                  Welcome back — {nudgeItems.length} dateless task{nudgeItems.length === 1 ? "" : "s"} gathering dust. Still matter?
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">No due date needed — anything undated and older than two days resurfaces here on each visit.</div>
                <div className="mt-2.5 space-y-1.5">
                  {nudgeItems.slice(0, 5).map((item) => {
                    const k = keyOf(item.note.id, item.task.lineIndex);
                    return (
                      <div key={k} className="flex items-center gap-2 text-xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                        <span className="text-[var(--color-text)] flex-1 break-words">{item.task.body}</span>
                        <button onClick={() => dismissNudge(k)} className="px-2 py-0.5 rounded-md bg-[var(--color-surface-2)] hover:bg-[var(--color-border-strong)] text-[10px] font-bold text-[var(--color-text)]">Still matters</button>
                        <button onClick={() => void snoozeTask(item, "Monday")} className="px-2 py-0.5 rounded-md bg-[var(--color-surface-2)] hover:bg-[var(--color-border-strong)] text-[10px] font-bold text-[var(--color-text)]">Mon</button>
                        <button onClick={() => void completeTask(item)} className="px-2 py-0.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">Done</button>
                      </div>
                    );
                  })}
                </div>
              </div>
              <button onClick={() => setNudgeOpen(false)} className="text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        {isEmpty && (
          <div className="mt-4 rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-6">
            <h2 className="text-sm font-black text-[var(--color-text)] mb-2">Your cockpit is empty — prime it from the console above.</h2>
            <div className="space-y-1.5 text-xs">
              <SyntaxHint example="call Joe about MOC-2024-051 due tomorrow" hint="a dated task" />
              <SyntaxHint example="inspect E-204 tube bundle @2026-07-15" hint="ISO date — most reliable" />
              <SyntaxHint example="grease P-101A bearings every monday" hint="recurring — rolls forward when you check it" />
              <SyntaxHint example="paste a whole messy walkdown note…" hint="Organize restructures it; flip the card to verify" />
            </div>
          </div>
        )}

        {/* Main grid */}
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">

            {/* View switch — Tasks (do / triage) vs Notes (capture + manage).
                One lens at a time, so the same task is never shown in two
                places at once (board AND notes). */}
            <div className="flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 w-fit">
              <button onClick={() => setMainView("tasks")} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-colors ${mainView === "tasks" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                <ListChecks className="w-3.5 h-3.5" /> Tasks <span className="opacity-70 tabular-nums">{brief.totals.total}</span>
              </button>
              <button onClick={() => setMainView("notes")} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-colors ${mainView === "notes" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                <StickyNote className="w-3.5 h-3.5" /> Notes <span className="opacity-70 tabular-nums">{notes.length}</span>
              </button>
            </div>
            {/* Make the "other lens" discoverable — the organized/flip view is
                one click away, not gone. */}
            <p className="-mt-1 text-[10px] text-[var(--color-text-faint)]">
              {mainView === "tasks" ? "Doing & triage. " : "Your organized captures — read them, edit, or "}
              <button onClick={() => setMainView(mainView === "tasks" ? "notes" : "tasks")} className="font-bold text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:underline underline-offset-2">
                {mainView === "tasks" ? "switch to Notes to read & flip to your exact original words →" : "← back to the task board"}
              </button>
            </p>

            {/* ── NOTES view: recent capture cards + the full notes archive ── */}
            {mainView === "notes" && (
            <>
            {/* Recent capture cards */}
            {cards.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                orgId={orgId}
                isFlipped={flipped.has(n.id)}
                showDiff={!diffOff.has(n.id)}
                editing={editingId === n.id}
                editDraft={editDraft}
                leaving={leaving}
                busyKeys={busyKeys}
                snoozeMenuFor={snoozeMenuFor}
                onFlip={() => setFlipped((s) => { const x = new Set(s); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; })}
                onToggleDiff={() => setDiffOff((s) => { const x = new Set(s); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; })}
                onStartEdit={() => { setEditingId(n.id); setEditDraft(n.body); }}
                onEditDraft={setEditDraft}
                onSaveEdit={() => void saveEdit(n)}
                onCancelEdit={() => setEditingId(null)}
                onDelete={() => void removeNote(n)}
                onResolve={() => void resolveNote(n)}
                onComplete={(item) => void completeTask(item)}
                onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                onSnooze={(item, when) => void snoozeTask(item, when)}
              />
            ))}

            {/* Full notes archive — search, edit, resolve every note. */}
            <ScratchpadPanel
              orgId={orgId}
              userId={uid}
              userName={userEmail}
              userEmail={userEmail}
              userRole={userRole}
              listMaxHeight="60vh"
            />
            </>
            )}

            {/* ── TASKS view: the board (every checkbox across your notes) ── */}
            {mainView === "tasks" && (
            <>
            {/* Board */}
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-2">
                <ListChecks className="w-4 h-4 text-[var(--color-accent)]" />
                <span className="text-xs font-black uppercase tracking-widest text-[var(--color-text-muted)]">Tasks</span>
                <span className="text-[10px] text-[var(--color-text-faint)] font-bold">every checkbox across your notes</span>
              </div>
              <div className="flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
                <button onClick={() => setGroupMode("thing")} className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider ${groupMode === "thing" ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                  <Layers className="w-3 h-3 inline mr-1 -mt-0.5" />by thing
                </button>
                <button onClick={() => setGroupMode("time")} className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider ${groupMode === "time" ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                  <Clock className="w-3 h-3 inline mr-1 -mt-0.5" />by time
                </button>
              </div>
            </div>

            {/* Digest — always on, above the grouping: the day at a glance no
                matter how the list below is sliced. */}
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.05] px-3 py-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px]">
              <Bell className="w-3.5 h-3.5 text-violet-700 dark:text-violet-300 shrink-0" />
              <span className="font-black text-[var(--color-text)]">Your day:</span>
              <span className={`font-bold ${brief.totals.overdue > 0 ? "text-rose-700 dark:text-rose-300" : "text-[var(--color-text-muted)]"}`}>{brief.totals.overdue} overdue{brief.overdue[0]?.task.dueAt ? ` — oldest due ${brief.overdue[0].task.dueAt}` : ""}</span>
              <span className={`font-bold ${brief.totals.today > 0 ? "text-amber-700 dark:text-amber-300" : "text-[var(--color-text-muted)]"}`}>{brief.totals.today} today</span>
              <span className="font-bold text-[var(--color-text-muted)]">{nudgeItems.length} aging dateless</span>
              <span className="ml-auto text-[var(--color-text-faint)] hidden sm:inline">also one bell ping on your first visit each day</span>
            </div>

            {groupMode === "time" ? (
              <div className="space-y-3">
                <BoardSection title="Overdue" tone="rose" icon={Flame} count={brief.totals.overdue}>
                  {brief.overdue.map((item) => (
                    <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                      leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                      onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                      onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                      onSnooze={(when) => void snoozeTask(item, when)}
                      onSetPriority={(p) => void setPriority(item, p)} onAddUpdate={(t) => void addTaskUpdate(item, t)} aiReady={aiReady} />
                  ))}
                  {brief.totals.overdue === 0 && <EmptyRow text="Nothing overdue. Savor it." />}
                </BoardSection>
                <BoardSection title="Today" tone="amber" icon={Sun} count={brief.totals.today}>
                  {brief.today.map((item) => (
                    <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                      leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                      onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                      onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                      onSnooze={(when) => void snoozeTask(item, when)}
                      onSetPriority={(p) => void setPriority(item, p)} onAddUpdate={(t) => void addTaskUpdate(item, t)} aiReady={aiReady} />
                  ))}
                  {brief.totals.today === 0 && <EmptyRow text="Clear. Unfinished work rolls into Overdue at midnight — by the dates, not by magic." />}
                </BoardSection>
                <BoardSection title="This week" tone="blue" icon={CalendarDays} count={brief.totals.soon}>
                  {brief.soon.map((item) => (
                    <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                      leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                      onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                      onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                      onSnooze={(when) => void snoozeTask(item, when)}
                      onSetPriority={(p) => void setPriority(item, p)} onAddUpdate={(t) => void addTaskUpdate(item, t)} aiReady={aiReady} />
                  ))}
                </BoardSection>
                {brief.totals.later > 0 && (
                  <BoardSection title="Later" tone="slate" icon={CalendarDays} count={brief.totals.later}>
                    {brief.later.map((item) => (
                      <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                        leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                        onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                        onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                        onSnooze={(when) => void snoozeTask(item, when)}
                      onSetPriority={(p) => void setPriority(item, p)} onAddUpdate={(t) => void addTaskUpdate(item, t)} aiReady={aiReady} />
                    ))}
                  </BoardSection>
                )}
                <BoardSection title="No date" tone="slate" icon={CircleSlash} count={brief.totals.noDate} subtitle="kept alive by the login nudge">
                  {brief.noDate.map((item) => (
                    <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                      leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                      onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                      onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                      onSnooze={(when) => void snoozeTask(item, when)}
                      onSetPriority={(p) => void setPriority(item, p)} onAddUpdate={(t) => void addTaskUpdate(item, t)} aiReady={aiReady} />
                  ))}
                </BoardSection>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {openByTopic.map(([topic, items]) => (
                  <div key={topic} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 cockpit-flipin">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-2 h-2 rounded-full bg-cyan-400" />
                      <span className="text-xs font-black text-[var(--color-text)]">{topic}</span>
                      <span className="text-[10px] font-bold text-[var(--color-text-muted)]">{items.length}</span>
                      {topic !== "General" && (
                        <Link href={`/search?q=${encodeURIComponent(topic)}`} className="ml-auto text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)] hover:text-cyan-600 dark:text-cyan-400">open in search</Link>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {items.map((item) => (
                        <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now} compact
                          leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                          onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                          onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                          onSnooze={(when) => void snoozeTask(item, when)}
                      onSetPriority={(p) => void setPriority(item, p)} onAddUpdate={(t) => void addTaskUpdate(item, t)} aiReady={aiReady} />
                      ))}
                    </div>
                  </div>
                ))}
                {openByTopic.length === 0 && <EmptyRow text="No open tasks." />}
              </div>
            )}

            </>
            )}
          </div>

          {/* Right rail */}
          <div className="space-y-4">
            <FlightLogPanel weekLog={weekLog} allLog={flightLog} topTopic={topTopic} carried={brief.totals.overdue} onOpenReports={(p) => { setReportPeriod(p); setReportOpen(true); }} />
          </div>
        </div>
      </div>

      {/* Reports — daily / weekly / monthly, organized */}
      {reportOpen && (
        <ReportComposer
          notes={notes}
          period={reportPeriod}
          onPeriod={setReportPeriod}
          defaultPerson={userEmail ?? ""}
          aiReady={aiReady}
          onClose={() => setReportOpen(false)}
        />
      )}

      {/* Nudge a person */}
      {nudgeTask && (
        <NudgeModal
          orgId={orgId}
          uid={uid}
          fromName={userEmail}
          item={nudgeTask}
          onClose={() => setNudgeTask(null)}
          onSent={(name) => { setNudgeTask(null); toast(`Nudged ${name} — it's in their bell now`); }}
        />
      )}

      {/* Receipt bar */}
      {receipt && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 w-[min(560px,92vw)] rounded-2xl border border-emerald-500/30 bg-[var(--color-surface)] backdrop-blur shadow-2xl shadow-emerald-500/10 p-3 cockpit-flipin">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold text-[var(--color-text)] truncate">Done: {receipt.text}</div>
              <div className="text-[10px] text-[var(--color-text-muted)]">One-line outcome? It&apos;s written into the note and feeds your weekly report.</div>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              autoFocus
              value={outcomeText}
              onChange={(e) => setOutcomeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void logReceipt(receipt, outcomeText); }}
              placeholder="e.g. spec confirmed w/ Joe — 85 ft-lb"
              className="flex-1 bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] rounded-lg px-3 py-1.5 text-xs text-[var(--color-text)] outline-none focus:border-emerald-500/50 placeholder:text-[var(--color-text-faint)]"
            />
            <button onClick={() => void logReceipt(receipt, outcomeText)} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-[white] text-xs font-black hover:bg-emerald-600 dark:hover:bg-emerald-400">Log</button>
            <button onClick={() => void logReceipt(receipt, "")} className="px-2 py-1.5 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Skip</button>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-5 right-5 z-50 space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="px-3.5 py-2 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] text-xs font-bold text-[var(--color-text)] shadow-xl cockpit-flipin">
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Note card (flip-to-verify) ─────────────────────────────────────────────

function NoteCard({
  note, orgId, isFlipped, showDiff, editing, editDraft, leaving, busyKeys, snoozeMenuFor,
  onFlip, onToggleDiff, onStartEdit, onEditDraft, onSaveEdit, onCancelEdit, onDelete, onResolve,
  onComplete, onSnoozeMenu, onSnooze,
}: {
  note: Note; orgId: string; isFlipped: boolean; showDiff: boolean; editing: boolean; editDraft: string;
  leaving: Map<string, "dissolve" | "peel">; busyKeys: Set<string>; snoozeMenuFor: string | null;
  onFlip: () => void; onToggleDiff: () => void;
  onStartEdit: () => void; onEditDraft: (v: string) => void; onSaveEdit: () => void; onCancelEdit: () => void;
  onDelete: () => void;
  onResolve: () => void;
  onComplete: (item: TaskWithNote) => void;
  onSnoozeMenu: (k: string) => void;
  onSnooze: (item: TaskWithNote, when: SnoozeChoice) => void;
}) {
  const tasks = useMemo(() => extractTasks(note), [note]);
  const lines = note.body.split("\n");
  const isCheckbox = (l: string) => /^\s*[-*]\s*\[/.test(l);
  const title = lines[0] && !isCheckbox(lines[0]) && !lines[0].startsWith("- ") ? lines[0] : null;
  const findings = lines.filter((l) => /^- (?!\[)/.test(l)).map((l) => l.replace(/^- /, ""));
  const open = tasks.filter((t) => !t.completed);
  const done = tasks.filter((t) => t.completed);
  const hasStructure = !!title || findings.length > 0 || tasks.length > 0;
  const highlights = useMemo(
    () => (note.rawBody && showDiff ? organizeCapture(note.rawBody).taskSources : []),
    [note.rawBody, showDiff],
  );

  if (editing) {
    return (
      <div className="rounded-2xl border border-[var(--color-accent-ring)] bg-[var(--color-surface)] p-4">
        <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-accent)] mb-2">Editing note</div>
        <textarea
          value={editDraft}
          onChange={(e) => onEditDraft(e.target.value)}
          rows={Math.min(14, Math.max(5, editDraft.split("\n").length + 1))}
          className="w-full bg-[var(--color-canvas)] border border-[var(--color-border)] rounded-xl p-3 font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent-ring)]"
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={onSaveEdit} className="px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)]">Save</button>
          <button onClick={onCancelEdit} className="px-2 py-1.5 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
          <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">Checkbox syntax: <code className="font-mono">- [ ] task due friday</code></span>
        </div>
      </div>
    );
  }

  return (
    <div className="cockpit-scene">
      <div className={`cockpit-card ${isFlipped ? "cockpit-flipped" : ""}`}>

        {/* FRONT — organized */}
        <div className="cockpit-face rounded-2xl border border-[var(--color-accent-ring)] bg-gradient-to-br from-[var(--color-accent-soft)] via-[var(--color-surface)] to-[var(--color-surface)] p-4 shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <Wand2 className="w-4 h-4 text-[var(--color-accent)] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-black text-[var(--color-text)] truncate">{title ?? "Note"}</div>
              <div className="text-[10px] text-[var(--color-text-muted)] font-bold">
                {fmtWhen(note.createdAt)}{open.length > 0 && ` · ${open.length} open task${open.length === 1 ? "" : "s"}`}{done.length > 0 && ` · ${done.length} done`}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1">
              {note.rawBody && (
                <button onClick={onFlip} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[10px] font-black text-[var(--color-text)] hover:text-[var(--color-text)] hover:border-[var(--color-accent-ring)]" title="Flip to your exact original words">
                  <RotateCcw className="w-3 h-3" /> what I wrote
                </button>
              )}
              <button onClick={onResolve} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-black text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20" title="Close this note — archives it (recoverable under All notes)">
                <CheckCircle2 className="w-3 h-3" /> Close
              </button>
              <button onClick={onStartEdit} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={onDelete} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-rose-700 dark:text-rose-300" title="Delete note"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>

          {!hasStructure && (
            <pre className="mt-3 text-xs text-[var(--color-text)] font-mono whitespace-pre-wrap">{note.body}</pre>
          )}

          {findings.length > 0 && (
            <div className="mt-3">
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[var(--color-text-muted)] mb-1">Findings</div>
              <ul className="space-y-0.5">
                {findings.map((f, i) => (
                  <li key={i} className="text-xs text-[var(--color-text)] flex items-start gap-1.5"><span className="text-[var(--color-text-faint)] mt-0.5">▸</span> {f}</li>
                ))}
              </ul>
            </div>
          )}

          {tasks.length > 0 && (
            <div className="mt-3">
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[var(--color-text-muted)] mb-1">Tasks</div>
              <ul className="space-y-1">
                {tasks.map((t) => {
                  const k = keyOf(note.id, t.lineIndex);
                  const anim = leaving.get(k);
                  const item: TaskWithNote = { note, task: t };
                  return (
                    <li key={k} className={`group/task flex items-center gap-2 text-xs ${anim === "dissolve" ? "cockpit-dissolve" : anim === "peel" ? "cockpit-peel" : ""} ${t.completed ? "opacity-50" : ""}`}>
                      <button
                        onClick={() => !t.completed && !busyKeys.has(k) && onComplete(item)}
                        disabled={t.completed || busyKeys.has(k)}
                        className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${t.completed ? "bg-emerald-500 border-emerald-500" : "border-[var(--color-border-strong)] hover:border-amber-400"}`}
                        title={t.recurring ? `Recurring (every ${t.recurring}) — completing rolls it forward` : "Done"}
                      >
                        {t.completed && <Check className="w-2.5 h-2.5 text-[var(--color-accent-fg)]" />}
                      </button>
                      <span className={`flex-1 min-w-0 break-words ${t.completed ? "line-through text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>
                        {t.dueText ? t.body.replace(t.dueText, "").replace(/\s{2,}/g, " ").trim() : t.body}
                        {t.outcome && <span className="text-emerald-600/80 dark:text-emerald-400/80 no-underline"> — {t.outcome}</span>}
                      </span>
                      {t.recurring && <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-500/10 border border-blue-500/30 text-blue-700 dark:text-blue-300 text-[9px] font-black"><Repeat className="w-2.5 h-2.5" /> {t.recurring}</span>}
                      {t.dueAt && !t.completed && (
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${dueTone(t.dueAt)}`}>{humanDue(t.dueAt)}</span>
                      )}
                      {!t.completed && (
                        <span className="relative shrink-0 hidden group-hover/task:inline-flex">
                          <button onClick={() => onSnoozeMenu(k)} className="p-0.5 rounded hover:bg-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title="Snooze"><AlarmClock className="w-3 h-3" /></button>
                          {snoozeMenuFor === k && <SnoozeMenu onSnooze={(w) => onSnooze(item, w)} />}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Passive intelligence: live footnotes for everything this note
              references — locks, holds, schedule dates, asset state — plus
              close-miss suggestions. Heuristics only, zero egress. */}
          <NoteFootnotes orgId={orgId} body={note.body} />
        </div>

        {/* BACK — verbatim raw */}
        <div className="cockpit-face cockpit-back rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4 shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <FileText className="w-4 h-4 text-[var(--color-text-muted)] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-black text-[var(--color-text)]">Your exact words</div>
              <div className="text-[10px] text-[var(--color-text-muted)] font-bold">verbatim — nothing edited, nothing lost</div>
            </div>
            <button onClick={onToggleDiff} className={`shrink-0 px-2 py-1 rounded-lg border text-[10px] font-black ${showDiff ? "border-[var(--color-accent-ring)] bg-[var(--color-accent-soft)] text-amber-700 dark:text-amber-300" : "border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
              {showDiff ? "highlighting tasks" : "show what became tasks"}
            </button>
            <button onClick={onFlip} className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[10px] font-black text-[var(--color-text)] hover:text-[var(--color-text)]">
              <Wand2 className="w-3 h-3 text-[var(--color-accent)]" /> organized
            </button>
          </div>
          <div className="mt-3 rounded-xl bg-[var(--color-canvas)] border border-[var(--color-border)] p-3 font-mono text-xs leading-relaxed text-[var(--color-text)] whitespace-pre-wrap">
            <RawWithHighlights raw={note.rawBody ?? note.body} highlights={highlights} />
          </div>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-[var(--color-text-faint)] font-bold">
            {showDiff && highlights.length > 0 && (
              <span><mark className="bg-[var(--color-accent-soft)] text-amber-700 dark:text-amber-300 px-1 rounded">highlighted</mark> = what the organizer turned into tasks</span>
            )}
            <span className="ml-auto">spot a mistake? <button onClick={onStartEdit} className="text-[var(--color-accent)] hover:text-amber-700 dark:text-amber-300 font-black">edit the organized note</button></span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RawWithHighlights({ raw, highlights }: { raw: string; highlights: string[] }) {
  if (highlights.length === 0) return <>{raw}</>;
  const parts: React.ReactNode[] = [];
  let rest = raw;
  let k = 0;
  for (const h of highlights) {
    const idx = rest.toLowerCase().indexOf(h.toLowerCase());
    if (idx === -1) continue;
    if (idx > 0) parts.push(<span key={k++}>{rest.slice(0, idx)}</span>);
    parts.push(<mark key={k++} className="bg-[var(--color-accent-soft)] text-amber-800 dark:text-amber-200 rounded px-0.5">{rest.slice(idx, idx + h.length)}</mark>);
    rest = rest.slice(idx + h.length);
  }
  parts.push(<span key={k++}>{rest}</span>);
  return <>{parts}</>;
}

// ─── Board pieces ───────────────────────────────────────────────────────────

function BoardSection({
  title, tone, icon: Icon, count, subtitle, children,
}: {
  title: string; tone: "rose" | "amber" | "blue" | "slate";
  icon: React.ComponentType<{ className?: string }>;
  count: number; subtitle?: string; children: React.ReactNode;
}) {
  const tones: Record<string, [string, string]> = {
    rose: ["text-rose-600 dark:text-rose-400", "border-l-rose-500/60"],
    amber: ["text-[var(--color-accent)]", "border-l-amber-500/60"],
    blue: ["text-blue-600 dark:text-blue-400", "border-l-blue-500/50"],
    slate: ["text-[var(--color-text-muted)]", "border-l-slate-700"],
  };
  const [iconCls, borderCls] = tones[tone];
  return (
    <div className={`rounded-2xl border border-[var(--color-border)] border-l-4 ${borderCls} bg-[var(--color-surface)] p-3`}>
      <div className="flex items-baseline gap-2 mb-2">
        <Icon className={`w-3.5 h-3.5 self-center ${iconCls}`} />
        <span className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text)]">{title}</span>
        <span className="text-[10px] font-bold text-[var(--color-text-faint)] tabular-nums">{count}</span>
        {subtitle && <span className="ml-auto text-[9px] text-[var(--color-text-faint)] font-bold">{subtitle}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

const PRIO_WORD: Record<number, string> = { 1: "highest", 2: "high", 3: "medium", 4: "low" };
function prioChipCls(p: number | null): string {
  if (p === 1) return "bg-rose-500/15 border-rose-500/40 text-rose-700 dark:text-rose-300";
  if (p === 2) return "bg-orange-500/15 border-orange-500/40 text-orange-700 dark:text-orange-300";
  if (p === 3) return "bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300";
  if (p === 4) return "bg-slate-500/10 border-[var(--color-border-strong)] text-[var(--color-text-muted)]";
  return "bg-transparent border-[var(--color-border-strong)] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]";
}
function prioDot(p: number): string {
  return p === 1 ? "bg-rose-500" : p === 2 ? "bg-orange-500" : p === 3 ? "bg-amber-500" : "bg-slate-400";
}
function fmtUpd(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return ""; }
}

function TaskRow({
  item, now, compact, leaving, busyKeys, snoozeMenuFor, onComplete, onKill, onNudgePerson, onSnoozeMenu, onSnooze,
  onSetPriority, onAddUpdate, aiReady,
}: {
  item: TaskWithNote; now: Date; compact?: boolean;
  leaving: Map<string, "dissolve" | "peel">; busyKeys: Set<string>; snoozeMenuFor: string | null;
  onComplete: () => void; onKill: () => void; onNudgePerson: () => void;
  onSnoozeMenu: (k: string) => void; onSnooze: (when: SnoozeChoice) => void;
  onSetPriority: (p: PriorityTier | null) => void; onAddUpdate: (text: string) => void; aiReady: boolean;
}) {
  const { note, task } = item;
  const k = keyOf(note.id, task.lineIndex);
  const anim = leaving.get(k);
  const leavingCls = anim === "dissolve" ? "cockpit-dissolve" : anim === "peel" ? "cockpit-peel" : "";
  const daysOver = task.dueAt && task.dueAt < ymd(now)
    ? Math.round((new Date(`${ymd(now)}T00:00:00`).getTime() - new Date(`${task.dueAt}T00:00:00`).getTime()) / 864e5)
    : 0;
  const escalated = daysOver >= 7;
  const metaForTask = note.taskMeta[taskKeyFor(task.body)];
  const snoozes = metaForTask?.snoozes ?? 0;
  const updates = metaForTask?.updates ?? [];
  const topic = topicForTask(task.body);
  const display = cleanTaskText(task);
  const [prioOpen, setPrioOpen] = useState(false);
  const [updOpen, setUpdOpen] = useState(false);
  const [updText, setUpdText] = useState("");

  // Shared affordances rendered in both the escalated card and the row.
  const prioChip = (
    <div className="relative shrink-0">
      <button onClick={() => setPrioOpen((v) => !v)} title={task.priority ? `Priority P${task.priority} — change` : "Set priority"}
        className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[9px] font-black border transition-colors ${prioChipCls(task.priority)}`}>
        <Flag className="w-2.5 h-2.5" />{task.priority ? `P${task.priority}` : ""}
      </button>
      {prioOpen && (
        <div className="absolute right-0 top-full mt-1 z-30 w-32 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ring-1 ring-black/5 shadow-lg p-1 cockpit-flipin" onClick={(e) => e.stopPropagation()}>
          {([1, 2, 3, 4] as PriorityTier[]).map((p) => (
            <button key={p} onClick={() => { onSetPriority(p); setPrioOpen(false); }}
              className="w-full flex items-center gap-2 px-2 py-1 rounded-lg text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-border-strong)]">
              <span className={`w-2 h-2 rounded-full ${prioDot(p)}`} /> P{p} <span className="text-[var(--color-text-faint)] ml-auto">{PRIO_WORD[p]}</span>
            </button>
          ))}
          {task.priority && <button onClick={() => { onSetPriority(null); setPrioOpen(false); }} className="w-full text-left px-2 py-1 mt-0.5 border-t border-[var(--color-border-strong)] rounded-lg text-[11px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-border-strong)]">Clear priority</button>}
        </div>
      )}
    </div>
  );

  const updBtn = (
    <button onClick={() => setUpdOpen((v) => !v)} title="Log a progress / problem note (feeds your report)"
      className={`relative p-1 rounded-md hover:bg-[var(--color-border-strong)] ${updates.length > 0 || updOpen ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
      <Sparkles className="w-3.5 h-3.5" />
      {updates.length > 0 && <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[8px] font-black flex items-center justify-center">{updates.length}</span>}
    </button>
  );

  const submitUpd = () => { if (updText.trim()) { onAddUpdate(updText); setUpdText(""); setUpdOpen(false); } };
  const extras = (updOpen || updates.length > 0) ? (
    <div className="mt-2 ml-7 space-y-1">
      {updates.map((u, i) => (
        <div key={i} className="text-[11px] text-[var(--color-text-muted)] flex items-start gap-1.5">
          <span className="text-[var(--color-text-faint)] mt-0.5 shrink-0">▸</span>
          <span className="break-words"><span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] mr-1">{fmtUpd(u.at)}</span>{u.text}</span>
        </div>
      ))}
      {updOpen && (
        <div className="flex items-end gap-1.5 pt-0.5">
          <textarea value={updText} onChange={(e) => setUpdText(e.target.value)} rows={2} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitUpd(); } }}
            placeholder={aiReady ? "Rough update — AI tightens it into one status line… (⌘↵)" : "Progress or problem note… (⌘↵)"}
            className="flex-1 bg-[var(--color-surface-2)]/60 border border-[var(--color-border-strong)] rounded-lg px-2 py-1.5 text-[11px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-accent-ring)] resize-none" />
          <button onClick={submitUpd} disabled={!updText.trim()} title={aiReady ? "Add (AI-polished)" : "Add update"}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[10px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
            {aiReady ? <Sparkles className="w-3 h-3" /> : <Check className="w-3 h-3" />} Add
          </button>
        </div>
      )}
    </div>
  ) : null;

  const heat = daysOver >= 7 ? "border-rose-500/60 bg-rose-500/[0.10] cockpit-breathe"
    : daysOver >= 3 ? "border-rose-500/40 bg-rose-500/[0.07] cockpit-breathe"
    : daysOver >= 1 ? "border-rose-500/25 bg-rose-500/[0.04]"
    : task.dueAt === ymd(now) ? "border-[var(--color-accent-ring)] bg-[var(--color-accent-soft)]"
    : "border-[var(--color-border)] bg-[var(--color-surface)]";

  if (escalated) {
    return (
      <div className={`relative rounded-xl border ${heat} p-3 ${leavingCls}`}>
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">{display}</div>
            <div className="text-[10px] font-black uppercase tracking-widest text-rose-600 dark:text-rose-400 mt-0.5">{daysOver}d overdue — do it, snooze it, or kill it</div>
          </div>
          {prioChip}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <button onClick={onComplete} disabled={busyKeys.has(k)} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-500 text-[white] text-[11px] font-black hover:bg-emerald-600 dark:hover:bg-emerald-400 disabled:opacity-60"><Check className="w-3 h-3" /> Do it now</button>
          <div className="relative flex-1">
            <button onClick={() => onSnoozeMenu(k)} className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] text-[11px] font-black text-[var(--color-text)] hover:bg-[var(--color-border-strong)]"><AlarmClock className="w-3 h-3" /> Snooze <ChevronDown className="w-3 h-3" /></button>
            {snoozeMenuFor === k && <SnoozeMenu onSnooze={onSnooze} />}
          </div>
          <button onClick={onKill} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] text-[11px] font-black text-[var(--color-text-muted)] hover:text-rose-700 dark:text-rose-300 hover:border-rose-500/40"><Trash2 className="w-3 h-3" /> Kill</button>
          {updBtn}
          <button onClick={onNudgePerson} title="Send to a teammate" className="inline-flex items-center justify-center px-2 py-1.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-sky-700 dark:text-sky-300 hover:border-sky-500/40"><Send className="w-3 h-3" /></button>
        </div>
        {extras}
      </div>
    );
  }

  return (
    <div className={`group relative rounded-xl border ${heat} px-3 ${compact ? "py-1.5" : "py-2"} ${leavingCls}`}>
    <div className="flex items-start gap-2.5">
      <button
        onClick={onComplete}
        disabled={busyKeys.has(k)}
        className="group/done w-[18px] h-[18px] rounded-md border-2 border-[var(--color-border-strong)] hover:border-emerald-500 hover:bg-emerald-500/15 shrink-0 transition-colors disabled:opacity-50 flex items-center justify-center mt-0.5"
        title={task.recurring ? `Recurring (every ${task.recurring}) — completing rolls it forward` : "Mark done (asks for a one-line outcome)"}
      >
        <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 opacity-0 group-hover/done:opacity-100" />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold text-[var(--color-text)] break-words">{display}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/70" /> {topic}
          </span>
          {task.recurring && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-500/10 border border-blue-500/30 text-blue-700 dark:text-blue-300 text-[9px] font-black"><Repeat className="w-2.5 h-2.5" /> every {task.recurring}</span>
          )}
          {snoozes >= 3 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-[var(--color-accent-soft)] border border-[var(--color-accent-ring)] text-amber-700 dark:text-amber-300 text-[9px] font-black"><AlarmClock className="w-2.5 h-2.5" /> snoozed {snoozes}× — still real?</span>
          )}
        </div>
      </div>
      {task.dueAt && (
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wide ${dueTone(task.dueAt)}`}>{humanDue(task.dueAt)}</span>
      )}
      <div className="shrink-0 flex items-center gap-1">
        {prioChip}
        {task.dueAt ? (
          // Already dated → reschedule (presets or a date).
          <div className="relative">
            <button onClick={() => onSnoozeMenu(k)} className="p-1 rounded-md hover:bg-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title="Reschedule — presets or pick a date"><AlarmClock className="w-3.5 h-3.5" /></button>
            {snoozeMenuFor === k && <SnoozeMenu onSnooze={onSnooze} />}
          </div>
        ) : (
          // No due date → an OBVIOUS button (always visible) that opens a
          // native calendar to set one. Snooze makes no sense without a date.
          <span className="relative inline-flex shrink-0">
            <span className="inline-flex items-center gap-1 text-[10px] font-black text-[var(--color-accent)] bg-[var(--color-accent-soft)] border border-[var(--color-accent-ring)]/50 rounded-md px-2 py-1 transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-fg)] hover:border-[var(--color-accent)]">
              <CalendarPlus className="w-3.5 h-3.5" /> Set due date
            </span>
            <input
              type="date"
              min={ymd(now)}
              onChange={(e) => { if (e.target.value) onSnooze({ dateIso: e.target.value }); }}
              aria-label="Set due date"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer [color-scheme:light] dark:[color-scheme:dark]"
            />
          </span>
        )}
        {updBtn}
        <button onClick={onNudgePerson} className="p-1 rounded-md hover:bg-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-sky-700 dark:text-sky-300" title="Send to a teammate"><Send className="w-3.5 h-3.5" /></button>
        <button onClick={onKill} className="p-1 rounded-md hover:bg-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-rose-700 dark:text-rose-300" title="Kill (removes the line)"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
    {extras}
    </div>
  );
}

function SnoozeMenu({ onSnooze }: { onSnooze: (when: SnoozeChoice) => void }) {
  return (
    <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] ring-1 ring-black/5 shadow-lg p-1 cockpit-flipin" onClick={(e) => e.stopPropagation()}>
      {/* Phone-style timed snooze — fires again when it elapses. */}
      <div className="px-1.5 pt-0.5">
        <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">Remind in</div>
        <div className="flex gap-1 mb-1">
          {[{ m: 15, l: "15m" }, { m: 60, l: "1h" }, { m: 120, l: "2h" }].map(({ m, l }) => (
            <button key={m} onClick={() => onSnooze({ minutes: m })} className="flex-1 px-1.5 py-1 rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)] text-[11px] font-black hover:bg-[var(--color-accent)]/15">
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-[var(--color-border-strong)] my-1" />
      {(["tomorrow", "next shift", "Monday"] as const).map((w) => (
        <button key={w} onClick={() => onSnooze(w)} className="w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-border-strong)] hover:text-[var(--color-text)] capitalize">
          {w}
        </button>
      ))}
      <div className="mt-1 pt-1.5 border-t border-[var(--color-border-strong)] px-1.5 pb-1">
        <label className="block text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">or pick a date</label>
        <input
          type="date"
          min={ymd(new Date())}
          onChange={(e) => { if (e.target.value) onSnooze({ dateIso: e.target.value }); }}
          className="w-full bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-md px-1.5 py-1 text-[11px] text-[var(--color-text)] [color-scheme:light] dark:[color-scheme:dark]"
        />
      </div>
    </div>
  );
}

function IntroTry({ icon: Icon, title, sub, onClick }: {
  icon: React.ComponentType<{ className?: string }>; title: string; sub: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="flex items-start gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left hover:border-[var(--color-accent-ring)] transition-colors">
      <Icon className="w-3.5 h-3.5 text-[var(--color-accent)] mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-xs font-black text-[var(--color-text)]">{title}</span>
        <span className="block text-[10px] text-[var(--color-text-muted)]">{sub}</span>
      </span>
    </button>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="text-[11px] text-[var(--color-text-faint)] italic px-1 py-0.5">{text}</div>;
}

// ─── Right rail ─────────────────────────────────────────────────────────────

function FlightLogPanel({
  weekLog, allLog, topTopic, carried, onOpenReports,
}: {
  weekLog: FlightLogEntry[]; allLog: FlightLogEntry[];
  topTopic: [string, number] | null; carried: number; onOpenReports: (period: ReportPeriod) => void;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-2">
        <BadgeCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        <span className="text-xs font-black uppercase tracking-widest text-[var(--color-text)]">Flight log</span>
        <span className="text-[10px] text-[var(--color-text-faint)] font-bold">receipts of done work</span>
      </div>

      <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-emerald-600/80 dark:text-emerald-400/80">This week</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-2xl font-black text-[var(--color-text)] tabular-nums">{weekLog.length}</span>
          <span className="text-[11px] font-bold text-[var(--color-text-muted)]">
            done · {carried} carrying over{topTopic ? <> · top topic <span className="text-purple-700 dark:text-purple-300 font-black">{topTopic[0]}</span></> : null}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Reports:</span>
          {(["day", "week", "month"] as const).map((p) => (
            <button key={p} onClick={() => onOpenReports(p)} className="px-2 py-1 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] text-[10px] font-black text-[var(--color-text)] hover:text-[var(--color-text)] hover:border-emerald-500/40">
              {p === "day" ? "Daily" : p === "week" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {allLog.slice(0, 8).map((e) => (
          <div key={`${e.noteId}:${e.lineIndex}`} className="flex items-start gap-2 text-xs">
            <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-500 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[var(--color-text)] font-bold truncate">{e.text}</div>
              {e.outcome && <div className="text-[10px] text-[var(--color-text-muted)] italic truncate">“{e.outcome}”</div>}
            </div>
            <span className="text-[9px] font-bold text-[var(--color-text-faint)] shrink-0 mt-0.5">{e.doneAt.slice(5)}</span>
          </div>
        ))}
        {allLog.length === 0 && (
          <div className="text-[11px] text-[var(--color-text-faint)] italic">Check a task off and log a one-line outcome — receipts land here, written into the note itself.</div>
        )}
      </div>
    </div>
  );
}

// ─── Small pieces ───────────────────────────────────────────────────────────

function StatusChip({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: number;
  tone: "rose" | "amber" | "blue" | "slate" | "emerald";
}) {
  const tones: Record<string, string> = {
    rose: value > 0 ? "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300" : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]",
    amber: value > 0 ? "border-[var(--color-accent-ring)] bg-[var(--color-accent-soft)] text-amber-700 dark:text-amber-300" : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]",
    blue: "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]",
    slate: "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]",
    emerald: "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11px] font-black ${tones[tone]}`}>
      <Icon className="w-3.5 h-3.5" />
      <span className="tabular-nums">{value}</span>
      <span className="font-bold opacity-70">{label}</span>
    </span>
  );
}

function HudChip() {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)] text-[9px] font-black uppercase tracking-widest"
      title="Private to you. Everything here runs on your device — organizing, reminders, answers, and footnotes are computed from your own data. Nothing is sent to any outside service."
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Private · on your device
    </span>
  );
}

function SyntaxHint({ example, hint }: { example: string; hint: string }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <code className="font-mono bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] px-2 py-0.5 rounded text-[var(--color-text)]">{example}</code>
      <span className="text-[var(--color-text-muted)]">→ {hint}</span>
    </div>
  );
}

function dueTone(dueAt: string): string {
  const today = ymd(new Date());
  if (dueAt < today) return "bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30";
  if (dueAt === today) return "bg-[var(--color-accent-soft)] text-amber-700 dark:text-amber-300 border border-[var(--color-accent-ring)]";
  return "bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/25";
}

function humanDue(dueAt: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${dueAt}T00:00:00`);
  const diff = Math.round((due.getTime() - today.getTime()) / 864e5);
  if (diff < 0) return `${-diff}d overdue`;
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff < 7) return `${diff}d`;
  return dueAt;
}

function fmtWhen(ts: string): string {
  try {
    return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return ts;
  }
}

// ─── Report modal — daily / weekly / monthly ────────────────────────────────
// Achievements (when, outcome, how long each took) + carry-over (how long
// open, how overdue). Copy / download are secondary to READING it here.

// ─── Report composer: edit every field, then print to PDF ───────
// The deliverable a supervisor sends. buildReportDoc() supplies the facts
// (completed / carry-over from the user's own tasks, with a quiet schedule
// read); the user edits any prose; "Elevate with AI" rewrites descriptions
// and infers impediments/requests; Export PDF opens a clean print view.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A clean, standalone HTML document for printing → Save as PDF. */
function reportPrintHtml(d: ReportDoc, org: string, person: string): string {
  const row = (title: string, meta: string, body: string) =>
    `<div class="item"><div class="it"><span class="t">${esc(title)}</span>${meta ? `<span class="m">${esc(meta)}</span>` : ""}</div>${body ? `<div class="d">${esc(body)}</div>` : ""}</div>`;
  const sec = (label: string, inner: string) => `<h2>${esc(label)}</h2>${inner || `<p class="empty">None.</p>`}`;
  const completed = d.completed.map((c) => row(c.text, [c.scheduleNote, fmtDayLabel(c.doneAt)].filter(Boolean).join(" · "), c.description || c.outcome || "")).join("");
  const carry = d.carryOver.map((c) => {
    const meta = [c.priority ? `P${c.priority}` : "", `open ${c.daysOpen}d`, c.overdueDays > 0 ? `${c.overdueDays}d overdue` : c.dueAt ? `due ${c.dueAt}` : ""].filter(Boolean).join(" · ");
    return row(c.text, meta, c.description);
  }).join("");
  const imp = d.impediments.map((i) => `<li><b>${esc(i.text)}</b>${i.detail ? ` — ${esc(i.detail)}` : ""}</li>`).join("");
  const req = d.requests.map((r) => `<li><b>${esc(r.text)}</b>${r.detail ? ` — ${esc(r.detail)}` : ""}</li>`).join("");
  const prio = d.nextPriorities.map((p) => row(`${p.priority ? `[P${p.priority}] ` : ""}${p.title}`, p.dueAt ? `due ${p.dueAt}` : "", p.description)).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.periodLabel)} Status Report</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 24px; }
  header { border-bottom: 3px solid #111; padding-bottom: 12px; margin-bottom: 20px; }
  header .org { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; }
  header .sub { color: #555; font-size: 12px; margin-top: 3px; }
  header .title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #b45309; margin-top: 8px; }
  .summary { background: #f6f6f4; border-left: 3px solid #b45309; padding: 10px 14px; margin: 0 0 22px; font-style: italic; color: #333; }
  h2 { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.16em; color: #444; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin: 22px 0 10px; }
  .item { margin: 0 0 9px; page-break-inside: avoid; }
  .item .it { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .item .t { font-weight: 700; }
  .item .m { color: #777; font-size: 11px; white-space: nowrap; font-weight: 600; }
  .item .d { color: #333; font-size: 12px; margin-top: 1px; }
  ul { margin: 0; padding-left: 18px; }
  li { margin: 0 0 6px; page-break-inside: avoid; }
  .empty { color: #999; font-style: italic; margin: 0 0 8px; }
  footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #eee; color: #aaa; font-size: 10px; }
</style></head><body>
  <header>
    <div class="org">${esc(org || "Status Report")}</div>
    <div class="sub">${person ? `Prepared by ${esc(person)} · ` : ""}${esc(d.rangeLabel)}</div>
    <div class="title">${esc(d.periodLabel)} Status Report</div>
  </header>
  ${d.summary ? `<div class="summary">${esc(d.summary)}</div>` : ""}
  ${sec("Completed", completed)}
  ${sec("Carry-over / In progress", carry)}
  ${sec("Impediments", imp ? `<ul>${imp}</ul>` : "")}
  ${sec("Requests", req ? `<ul>${req}</ul>` : "")}
  ${sec("Next period priorities", prio)}
  <footer>Generated from the scratchpad${d.aiElevated ? " · AI-elevated draft, reviewed before export" : ""}.</footer>
</body></html>`;
}

function ReportComposer({
  notes, period, onPeriod, defaultPerson, aiReady, onClose,
}: {
  notes: Note[];
  period: ReportPeriod;
  onPeriod: (p: ReportPeriod) => void;
  defaultPerson: string;
  aiReady: boolean;
  onClose: () => void;
}) {
  const LS = "scratchpad-report-id";
  const [org, setOrg] = useState("");
  const [person, setPerson] = useState(defaultPerson);
  const [doc, setDoc] = useState<ReportDoc>(() => buildReportDoc(notes, { period, org: "", person: defaultPerson }));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Remember org / person across exports.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS) || "{}") as { org?: string; person?: string };
      if (saved.org) setOrg(saved.org);
      if (saved.person) setPerson(saved.person);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify({ org, person })); } catch { /* ignore */ }
  }, [org, person]);

  // Rebuild the body when the period changes — a fresh report (drops manual
  // edits intentionally; switching period means different facts).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDoc(buildReportDoc(notes, { period, org, person })); }, [period]);

  const merged = (): ReportDoc => ({ ...doc, org, person });
  const setLine = (sec: "impediments" | "requests", i: number, field: "text" | "detail", v: string) =>
    setDoc((d) => ({ ...d, [sec]: d[sec].map((it, j) => (j === i ? { ...it, [field]: v } : it)) }));
  const addLine = (sec: "impediments" | "requests") => setDoc((d) => ({ ...d, [sec]: [...d[sec], { text: "", detail: "" }] }));
  const removeLine = (sec: "impediments" | "requests", i: number) => setDoc((d) => ({ ...d, [sec]: d[sec].filter((_, j) => j !== i) }));

  const generate = async () => {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const raw = await getAiProvider().summarize(reportDocAiPrompt(merged()));
      setDoc((d) => mergeAiIntoReportDoc({ ...d, org, person }, raw));
      setNote("AI elevated the prose and inferred impediments/requests — review and edit, then export.");
    } catch {
      setNote("Couldn't reach the AI — your facts are intact; edit and export anyway.");
    } finally { setBusy(false); }
  };

  const copyMd = () => { void navigator.clipboard.writeText(reportDocToMarkdown(merged())).then(() => setNote("Copied as markdown.")).catch(() => setNote("Clipboard unavailable.")); };
  const exportPdf = () => {
    const w = window.open("", "_blank", "width=860,height=1100");
    if (!w) { setNote("Allow pop-ups to export the PDF (or use Copy markdown)."); return; }
    w.document.write(reportPrintHtml(doc, org, person));
    w.document.close(); w.focus();
    setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 350);
  };

  const inp = "w-full bg-[var(--color-surface-2)]/50 border border-[var(--color-border-strong)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-accent-ring)] focus:bg-[var(--color-surface)]";
  const secHead = "text-[10px] font-black uppercase tracking-[0.2em] mb-2 flex items-center gap-1.5";

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-2xl cockpit-flipin" onClick={(e) => e.stopPropagation()}>

        {/* Header: identity + period tabs */}
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3 flex-wrap">
            <BadgeCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <div className="text-base font-black text-[var(--color-text)]">Status report</div>
            <div className="ml-auto flex items-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-0.5">
              {(["day", "week", "month"] as const).map((p) => (
                <button key={p} onClick={() => onPeriod(p)} className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider ${period === p ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                  {p === "day" ? "Daily" : p === "week" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
            <div className="relative"><Building2 className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" /><input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organization name" className={`${inp} pl-8`} /></div>
            <div className="relative"><UserIcon className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" /><input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Your name" className={`${inp} pl-8`} /></div>
          </div>
          <div className="text-[10px] font-bold text-[var(--color-text-muted)] mt-2">{doc.rangeLabel} · {doc.stats.done} done · {doc.stats.carry} carrying over{doc.stats.overdueCarry > 0 ? ` (${doc.stats.overdueCarry} overdue)` : ""}</div>
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[55vh] overflow-y-auto">
          {/* Executive summary */}
          <div>
            <div className={`${secHead} text-[var(--color-text-muted)]`}><FileText className="w-3 h-3" /> Summary</div>
            <textarea value={doc.summary} onChange={(e) => setDoc((d) => ({ ...d, summary: e.target.value }))} rows={2} className={`${inp} resize-none`} placeholder="One-paragraph overview…" />
          </div>

          {/* Completed */}
          <div>
            <div className={`${secHead} text-emerald-600/90 dark:text-emerald-400/90`}><Check className="w-3 h-3" /> Completed ({doc.completed.length})</div>
            {doc.completed.length === 0 ? <div className="text-xs text-[var(--color-text-faint)] italic">Nothing completed in this window.</div> : (
              <div className="space-y-2">
                {doc.completed.map((c, i) => (
                  <div key={`${c.noteId}:${c.lineIndex}`} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-[var(--color-text)] break-words">{c.text}</span>
                      <span className="shrink-0 text-[10px] font-black text-[var(--color-text-muted)]">{[c.scheduleNote, fmtDayLabel(c.doneAt)].filter(Boolean).join(" · ")}</span>
                    </div>
                    <textarea value={c.description} onChange={(e) => setDoc((d) => ({ ...d, completed: d.completed.map((x, j) => j === i ? { ...x, description: e.target.value } : x) }))} rows={1} placeholder="Describe the outcome…" className={`${inp} mt-1.5 resize-none`} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Carry-over */}
          <div>
            <div className={`${secHead} text-[var(--color-accent)]`}><Repeat className="w-3 h-3" /> Carry-over / in progress ({doc.carryOver.length})</div>
            {doc.carryOver.length === 0 ? <div className="text-xs text-emerald-600 dark:text-emerald-400 font-bold">Nothing open — clean slate.</div> : (
              <div className="space-y-2">
                {doc.carryOver.map((c, i) => (
                  <div key={`${c.noteId}:${c.lineIndex}`} className={`rounded-lg border px-2.5 py-2 ${c.overdueDays > 0 ? "border-rose-500/30 bg-rose-500/[0.05]" : "border-[var(--color-border)] bg-[var(--color-surface-2)]/50"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-[var(--color-text)] break-words flex items-center gap-1.5">
                        {c.priority && <span className={`inline-flex items-center gap-0.5 rounded px-1 py-px text-[8px] font-black border ${prioChipCls(c.priority)}`}><Flag className="w-2 h-2" />P{c.priority}</span>}
                        {c.text}
                      </span>
                      <span className="shrink-0 text-[10px] font-black text-[var(--color-text-muted)]">{c.overdueDays > 0 ? `${c.overdueDays}d overdue` : c.dueAt ? `due ${c.dueAt}` : `open ${c.daysOpen}d`}</span>
                    </div>
                    <textarea value={c.description} onChange={(e) => setDoc((d) => ({ ...d, carryOver: d.carryOver.map((x, j) => j === i ? { ...x, description: e.target.value } : x) }))} rows={1} placeholder="Progress / where it stands…" className={`${inp} mt-1.5 resize-none`} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Impediments — editable list */}
          <EditableLines label="Impediments" icon={AlertTriangle} tone="text-rose-600/90 dark:text-rose-400/90" items={doc.impediments} inp={inp} secHead={secHead}
            onChange={(i, f, v) => setLine("impediments", i, f, v)} onAdd={() => addLine("impediments")} onRemove={(i) => removeLine("impediments", i)} placeholder="What's blocking progress…" />

          {/* Requests — editable list */}
          <EditableLines label="Requests" icon={ArrowUpRight} tone="text-sky-600/90 dark:text-sky-400/90" items={doc.requests} inp={inp} secHead={secHead}
            onChange={(i, f, v) => setLine("requests", i, f, v)} onAdd={() => addLine("requests")} onRemove={(i) => removeLine("requests", i)} placeholder="What you need from others…" />

          {/* Next priorities */}
          <div>
            <div className={`${secHead} text-purple-600/90 dark:text-purple-400/90`}><Flag className="w-3 h-3" /> Next period priorities ({doc.nextPriorities.length})</div>
            {doc.nextPriorities.length === 0 ? <div className="text-xs text-[var(--color-text-faint)] italic">No prioritized or due-soon tasks. Set a P1–P4 on a task to surface it here.</div> : (
              <div className="space-y-2">
                {doc.nextPriorities.map((p, i) => (
                  <div key={i} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-[8px] font-black border ${prioChipCls(p.priority)}`}><Flag className="w-2 h-2" />{p.priority ? `P${p.priority}` : "—"}</span>
                      <input value={p.title} onChange={(e) => setDoc((d) => ({ ...d, nextPriorities: d.nextPriorities.map((x, j) => j === i ? { ...x, title: e.target.value } : x) }))} className={`${inp} flex-1`} />
                      {p.dueAt && <span className="shrink-0 text-[10px] font-black text-blue-700 dark:text-blue-300">due {p.dueAt}</span>}
                      <button onClick={() => setDoc((d) => ({ ...d, nextPriorities: d.nextPriorities.filter((_, j) => j !== i) }))} className="shrink-0 p-1 rounded text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                    </div>
                    <textarea value={p.description} onChange={(e) => setDoc((d) => ({ ...d, nextPriorities: d.nextPriorities.map((x, j) => j === i ? { ...x, description: e.target.value } : x) }))} rows={1} placeholder="Why it matters / what done looks like…" className={`${inp} mt-1.5 resize-none`} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {note && <div className="text-[11px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2">{note}</div>}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <button onClick={exportPdf} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)]"><Printer className="w-3.5 h-3.5" /> Export PDF</button>
          <button onClick={copyMd} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] text-[11px] font-black text-[var(--color-text)]"><Copy className="w-3.5 h-3.5" /> Copy markdown</button>
          {aiReady ? (
            <button onClick={() => void generate()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 text-white text-[11px] font-black hover:bg-purple-500 disabled:opacity-60" title="Sends the report facts to the configured AI to elevate the prose and infer impediments/requests — only when you click.">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} {busy ? "Elevating…" : "Elevate with AI"}
            </button>
          ) : (
            <span className="text-[10px] text-[var(--color-text-faint)] inline-flex items-center gap-1"><Sparkles className="w-3 h-3" /> Configure AI to auto-elevate the prose.</span>
          )}
          <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">Edit anything, then Export PDF.</span>
        </div>
      </div>
    </div>
  );
}

function EditableLines({ label, icon: Icon, tone, items, inp, secHead, onChange, onAdd, onRemove, placeholder }: {
  label: string; icon: React.ComponentType<{ className?: string }>; tone: string;
  items: { text: string; detail: string }[]; inp: string; secHead: string;
  onChange: (i: number, field: "text" | "detail", v: string) => void; onAdd: () => void; onRemove: (i: number) => void; placeholder: string;
}) {
  return (
    <div>
      <div className={`${secHead} ${tone}`}><Icon className="w-3 h-3" /> {label} ({items.length})</div>
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input value={it.text} onChange={(e) => onChange(i, "text", e.target.value)} placeholder={placeholder} className={`${inp} flex-1`} />
            <input value={it.detail} onChange={(e) => onChange(i, "detail", e.target.value)} placeholder="detail" className={`${inp} w-32 hidden sm:block`} />
            <button onClick={() => onRemove(i)} className="shrink-0 p-1 rounded text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
          </div>
        ))}
        <button onClick={onAdd} className="text-[11px] font-black text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">+ Add {label.toLowerCase().replace(/s$/, "")}</button>
      </div>
    </div>
  );
}

function fmtDayLabel(iso: string): string {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// ─── Nudge modal — send a task to a teammate ────────────────────────────────

function NudgeModal({
  orgId, uid, fromName, item, onClose, onSent,
}: {
  orgId: string; uid: string; fromName?: string;
  item: TaskWithNote;
  onClose: () => void;
  onSent: (name: string) => void;
}) {
  const [targets, setTargets] = useState<NudgeTarget[] | null>(null);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listNudgeTargets(orgId, uid)
      .then((t) => { if (!cancelled) setTargets(t); })
      .catch((e) => { if (!cancelled) { setTargets([]); setErr((e as Error).message); } });
    return () => { cancelled = true; };
  }, [orgId, uid]);

  const taskText = item.task.dueText
    ? item.task.body.replace(item.task.dueText, "").replace(/\s{2,}/g, " ").trim()
    : item.task.body;
  const list = (targets ?? []).filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));

  const send = async (t: NudgeTarget) => {
    if (sendingTo) return;
    setSendingTo(t.uid);
    setErr(null);
    try {
      await sendTaskNudge({ orgId, toUserId: t.uid, fromUserId: uid, fromName, taskText, message: msg });
      onSent(t.name);
    } catch (e) {
      setErr((e as Error).message);
      setSendingTo(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 sm:p-10 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-2xl cockpit-flipin" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <Send className="w-4 h-4 text-sky-700 dark:text-sky-300" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Send to a teammate</div>
            <div className="text-[10px] text-[var(--color-text-muted)] truncate">“{taskText}” — lands in their bell. A heads-up, not an assignment.</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-3 space-y-2">
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="optional note — e.g. can you grab this before Friday?"
            className="w-full bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-text)] outline-none focus:border-sky-500/50 placeholder:text-[var(--color-text-faint)]"
          />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="find a person…"
            className="w-full bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-text)] outline-none focus:border-sky-500/50 placeholder:text-[var(--color-text-faint)]"
          />
          {err && <div className="text-[11px] text-rose-600 dark:text-rose-400">{err}</div>}
          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {targets === null && <div className="text-[11px] text-[var(--color-text-muted)] py-2 text-center"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" />Loading members…</div>}
            {targets !== null && list.length === 0 && <div className="text-[11px] text-[var(--color-text-faint)] italic py-2 text-center">No matching members.</div>}
            {list.map((t) => (
              <button
                key={t.uid}
                onClick={() => void send(t)}
                disabled={!!sendingTo}
                className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-[var(--color-surface-2)] text-left disabled:opacity-50"
              >
                <span className="w-7 h-7 rounded-full bg-sky-500/15 border border-sky-500/30 text-sky-700 dark:text-sky-300 text-[11px] font-black flex items-center justify-center shrink-0">
                  {t.name.charAt(0).toUpperCase()}
                </span>
                <span className="text-xs font-bold text-[var(--color-text)] flex-1 truncate">{t.name}</span>
                {sendingTo === t.uid ? <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-700 dark:text-sky-300" /> : <Send className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Cockpit CSS — flips, dissolves, peels, breathing ───────────────────────

const COCKPIT_CSS = `
.cockpit-scene { perspective: 1400px; }
.cockpit-card { display: grid; transform-style: preserve-3d; transition: transform .7s cubic-bezier(.25,.8,.25,1.08); }
.cockpit-card.cockpit-flipped { transform: rotateY(180deg); }
.cockpit-face { grid-area: 1 / 1; backface-visibility: hidden; -webkit-backface-visibility: hidden; min-width: 0; }
.cockpit-back { transform: rotateY(180deg); }

@keyframes cockpit-breathe-kf {
  0%, 100% { box-shadow: 0 0 0 0 rgba(244,63,94,0); }
  50%      { box-shadow: 0 0 18px 1px rgba(244,63,94,.16); }
}
.cockpit-breathe { animation: cockpit-breathe-kf 2.8s ease-in-out infinite; }

@keyframes cockpit-dissolve-kf { to { opacity: 0; transform: scale(.96) translateY(-4px); } }
.cockpit-dissolve { animation: cockpit-dissolve-kf .42s ease-in forwards; }

@keyframes cockpit-peel-kf { to { opacity: 0; transform: translateX(56px) rotate(3deg); } }
.cockpit-peel { animation: cockpit-peel-kf .38s ease-in forwards; }

@keyframes cockpit-flipin-kf { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
.cockpit-flipin { animation: cockpit-flipin-kf .34s cubic-bezier(.2,.8,.3,1.1); }

@keyframes cockpit-blink-kf { 0%, 55% { opacity: 1; } 56%, 100% { opacity: .15; } }
.cockpit-blink { animation: cockpit-blink-kf 1.1s step-end infinite; }
`;
