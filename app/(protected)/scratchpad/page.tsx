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
  ListChecks, Zap, Layers, BadgeCheck, Flame, AlarmClock, ArrowRight, Bell,
  Loader2, StickyNote, Pencil, Archive, Send, Download, Copy, CheckCircle2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  getDailyBrief, maybeNotifyMorningDigest, listNotes, createNote,
  createOrganizedNote, updateNoteBody, updateNoteTaskMeta, deleteNote,
  extractTasks, completeTaskInBody, appendOutcomeToTask, snoozeTaskInBody,
  removeTaskLineFromBody, organizeCapture, getFlightLog, topicForTask,
  taskKeyFor, nextOccurrence, ymd, scratchpadColumnsReady, setNoteResolved,
  buildReport, reportToMarkdown,
  type DailyBrief, type TaskWithNote, type Note, type FlightLogEntry,
  type ReportData, type ReportPeriod,
} from "@/lib/notes";
import { listNudgeTargets, sendTaskNudge, type NudgeTarget } from "@/lib/taskNudge";
import { parseAsk, runAsk, type AskAnswer } from "@/lib/askEngine";
import ScratchpadPanel from "@/components/notes/ScratchpadPanel";
import NoteFootnotes from "@/components/notes/NoteFootnotes";

// ─── Page shell ─────────────────────────────────────────────────────────────

export default function ScratchpadPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  if (!activeOrgId || !uid) {
    return <div className="p-6 text-sm text-slate-500">No active organization.</div>;
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
type SnoozeChoice = SnoozeWhen | { dateIso: string };
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
  const [groupMode, setGroupMode] = useState<"time" | "thing">("time");
  const [nudgeOpen, setNudgeOpen] = useState(true);
  const [nudgeDismissed, setNudgeDismissed] = useState<Set<string>>(new Set());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>("week");
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
    const iso = typeof when === "object" ? when.dateIso
      : when === "Monday" ? nextOccurrence("monday", now) : nextOccurrence("day", now);
    const k = keyOf(note.id, task.lineIndex);
    await withAnim(k, "peel", async () => {
      await persistBody(note, snoozeTaskInBody(note.body, task.lineIndex, iso));
      // Cosmetic counter; silently unavailable pre-migration.
      const metaKey = taskKeyFor(task.body);
      const meta = { ...note.taskMeta, [metaKey]: { snoozes: (note.taskMeta[metaKey]?.snoozes ?? 0) + 1 } };
      void updateNoteTaskMeta(note.id, meta, uid);
    });
    toast(`Snoozed — see you ${typeof when === "object" ? when.dateIso : when === "Monday" ? "Monday" : when}`);
  }, [withAnim, persistBody, uid, toast, now]);

  const killTask = useCallback(async ({ note, task }: TaskWithNote) => {
    if (!window.confirm("Remove this task line for good?")) return;
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
      const org = organizeCapture(text);
      if (org.taskCount === 0 && org.findingCount === 0) {
        await createNote({ orgId, body: text, createdBy: uid, createdByName: userEmail });
        toast("Saved as a note — nothing actionable detected");
      } else {
        const { rawPreserved } = await createOrganizedNote({
          orgId, body: org.body, rawBody: text, createdBy: uid, createdByName: userEmail,
        });
        toast(rawPreserved
          ? `Organized — ${org.taskCount} task${org.taskCount === 1 ? "" : "s"} extracted. Flip the card to verify.`
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
      await createNote({ orgId, body, createdBy: uid, createdByName: userEmail });
      setConsoleText("");
      const t = extractTasks({ id: "tmp", body })[0];
      toast(t?.dueAt ? `Filed — due ${t.dueAt}` : t?.recurring ? `Filed — every ${t.recurring}` : "Filed to No date — the login nudge keeps it alive");
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
    if (!window.confirm("Delete this note and its tasks?")) return;
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

  // The report proper — daily / weekly / monthly. Achievements (when,
  // outcome, how long each took) + everything still open that carries
  // over. Recomputed when notes or the period change.
  const report: ReportData = useMemo(
    () => buildReport(notes, { period: reportPeriod }),
    [notes, reportPeriod],
  );

  const copyReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(reportToMarkdown(report));
      toast("Report copied as markdown");
    } catch {
      toast("Couldn't access the clipboard");
    }
  }, [report, toast]);

  const downloadReport = useCallback(() => {
    const blob = new Blob([reportToMarkdown(report)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scratchpad-report-${report.period}-${report.todayIso}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Report downloaded as .md");
  }, [report, toast]);

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
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-amber-500" />
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
    <div className="min-h-screen bg-slate-950 text-slate-200 pb-28 bg-[radial-gradient(ellipse_at_top,rgba(251,146,60,0.08),transparent_55%)]">
      <style>{COCKPIT_CSS}</style>
      <div className="max-w-7xl mx-auto px-6 pt-6">

        {/* Header */}
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2">
              <StickyNote className="w-5 h-5 text-amber-500" />
              <h1 className="text-xl font-black text-white tracking-tight">Scratchpad</h1>
              <HudChip />
              <button onClick={() => setIntroOpen((v) => !v)} className="p-1 rounded-lg hover:bg-slate-800 text-slate-600 hover:text-slate-300" title="What can this do?">
                <HelpCircle className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Write → submit → organized → flip to verify → it reminds you. Private to you. Press <kbd className="px-1 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-[10px]">/</kbd> for the console.
            </p>
          </div>
          <div className="text-right">
            <div className="font-mono text-3xl font-black text-white tabular-nums leading-none">
              {hh}:{mm}<span className="text-slate-600">:{ss}</span>
            </div>
            <div className="text-[10px] font-black tracking-[0.25em] text-slate-500 mt-1">{dateLabel}</div>
          </div>
        </div>

        {/* First-visit explainer — the power, frictionlessly. One tap to try
            each capability, one tap to dismiss forever, ? to bring it back. */}
        {introOpen && (
          <div className="mt-4 rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/[0.10] via-slate-900 to-violet-500/[0.08] p-4 cockpit-flipin">
            <div className="flex items-start gap-2">
              <Wand2 className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-white">This isn&apos;t a notepad. It&apos;s your seat in the cockpit.</div>
                <div className="text-[11px] text-slate-400 mt-0.5">Four things it does the moment you type — tap one to try it:</div>
              </div>
              <button onClick={dismissIntro} className="shrink-0 px-2 py-1 rounded-lg border border-slate-700 bg-slate-800/80 text-[10px] font-black text-slate-300 hover:text-white">Got it</button>
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
            <div className="mt-2 text-[10px] text-slate-600">Private to you · deterministic local rules · nothing leaves your org&apos;s database.</div>
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
            <RotateCcw className="w-3.5 h-3.5 text-sky-300 mt-0.5 shrink-0" />
            <div className="text-slate-400">
              <span className="font-black text-sky-200">Flip-to-verify isn&apos;t active yet.</span> Apply migration{" "}
              <code className="font-mono bg-slate-800 px-1 rounded text-slate-300">20260730_scratchpad_cockpit.sql</code>{" "}
              to keep your verbatim original when you Organize a capture (and to track snooze counts). Until then, capturing still works — there&apos;s just no separate original to flip to.
            </div>
          </div>
        )}

        {/* Console */}
        <div className={`mt-4 rounded-2xl border bg-slate-900/80 backdrop-blur transition-colors ${organizing ? "border-amber-500/50" : "border-slate-800 focus-within:border-amber-500/40"}`}>
          <div className="flex items-start gap-3 px-4 py-3">
            <span className={`mt-1 text-amber-400 font-black select-none font-mono ${consoleText ? "" : "cockpit-blink"}`}>&gt;</span>
            <textarea
              ref={consoleRef}
              value={consoleText}
              onChange={(e) => setConsoleText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitConsole(); }
              }}
              rows={consoleText.includes("\n") ? 3 : 1}
              placeholder="jot a task, paste a mess, or ask a question…   (Enter files it · Shift+Enter for a new line)"
              className="flex-1 bg-transparent resize-none outline-none text-sm text-slate-100 placeholder:text-slate-600 font-mono caret-amber-400"
            />
            {wantsOrganize && (
              <button
                onClick={() => void runOrganize()}
                disabled={organizing}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500 text-slate-950 text-xs font-black hover:bg-amber-400 disabled:opacity-70 cockpit-flipin"
              >
                {organizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                {organizing ? "Organizing…" : "Organize"}
              </button>
            )}
            {!wantsOrganize && looksLikeQuestion && consoleText.trim() && (
              <span className="shrink-0 mt-1 text-[10px] font-black uppercase tracking-widest text-cyan-400 cockpit-flipin">
                {asking ? <Loader2 className="w-3 h-3 animate-spin inline" /> : "↵ ask"}
              </span>
            )}
          </div>
          <div className="px-4 pb-2 flex items-center gap-3 text-[10px] text-slate-600 font-bold flex-wrap">
            <span>try:</span>
            <button onClick={() => setConsoleText("call Joe about the gasket spec due friday")} className="hover:text-slate-400 font-mono">task with a due date</button>
            <span className="text-slate-800">·</span>
            <button onClick={() => setConsoleText("grease P-101A bearings every monday")} className="hover:text-slate-400 font-mono">recurring</button>
            <span className="text-slate-800">·</span>
            <button onClick={() => setConsoleText("who has E-204?")} className="hover:text-slate-400 font-mono">who has E-204?</button>
            <span className="text-slate-800">·</span>
            <button onClick={() => setConsoleText("what's blocked?")} className="hover:text-slate-400 font-mono">what&apos;s blocked?</button>
          </div>
        </div>

        {/* Answer card */}
        {answer && (
          <div className="mt-3 rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 to-slate-900 p-4 cockpit-flipin">
            <div className="flex items-start gap-3">
              <Zap className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-white">{answer.title}</div>
                <div className="mt-1.5 space-y-1">
                  {answer.lines.map((l, i) => l.href ? (
                    <Link key={i} href={l.href} className={`block text-xs hover:text-cyan-300 ${l.strong ? "text-slate-200 font-bold" : "text-slate-400"}`}>
                      {l.text} <ChevronRight className="w-3 h-3 inline -mt-0.5 text-slate-600" />
                    </Link>
                  ) : (
                    <div key={i} className="text-xs text-slate-400">{l.text}</div>
                  ))}
                </div>
                {answer.more && (
                  <Link href={answer.more.href} className="mt-2 inline-flex items-center gap-1 text-[11px] font-black text-cyan-400 hover:text-cyan-300">
                    {answer.more.label} <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
              <button onClick={() => setAnswer(null)} className="text-slate-600 hover:text-slate-400"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        {/* Welcome-back nudge — dateless notes resurface, no due date needed */}
        {nudgeOpen && nudgeItems.length > 0 && (
          <div className="mt-3 rounded-2xl border border-sky-500/25 bg-gradient-to-r from-sky-500/10 via-slate-900 to-slate-900 p-4 cockpit-flipin">
            <div className="flex items-start gap-3">
              <Bell className="w-4 h-4 text-sky-300 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-white">
                  Welcome back — {nudgeItems.length} dateless task{nudgeItems.length === 1 ? "" : "s"} gathering dust. Still matter?
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">No due date needed — anything undated and older than two days resurfaces here on each visit.</div>
                <div className="mt-2.5 space-y-1.5">
                  {nudgeItems.slice(0, 5).map((item) => {
                    const k = keyOf(item.note.id, item.task.lineIndex);
                    return (
                      <div key={k} className="flex items-center gap-2 text-xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                        <span className="text-slate-300 flex-1 truncate">{item.task.body}</span>
                        <button onClick={() => dismissNudge(k)} className="px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-slate-300">Still matters</button>
                        <button onClick={() => void snoozeTask(item, "Monday")} className="px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-slate-300">Mon</button>
                        <button onClick={() => void completeTask(item)} className="px-2 py-0.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-[10px] font-bold text-emerald-300">Done</button>
                      </div>
                    );
                  })}
                </div>
              </div>
              <button onClick={() => setNudgeOpen(false)} className="text-slate-600 hover:text-slate-400"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        {isEmpty && (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-6">
            <h2 className="text-sm font-black text-white mb-2">Your cockpit is empty — prime it from the console above.</h2>
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

            {/* Board */}
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-2">
                <ListChecks className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-black uppercase tracking-widest text-slate-400">Your board</span>
              </div>
              <div className="flex items-center rounded-lg border border-slate-800 bg-slate-900 p-0.5">
                <button onClick={() => setGroupMode("time")} className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider ${groupMode === "time" ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"}`}>
                  <Clock className="w-3 h-3 inline mr-1 -mt-0.5" />by time
                </button>
                <button onClick={() => setGroupMode("thing")} className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider ${groupMode === "thing" ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"}`}>
                  <Layers className="w-3 h-3 inline mr-1 -mt-0.5" />by thing
                </button>
              </div>
            </div>

            {groupMode === "time" ? (
              <div className="space-y-3">
                <BoardSection title="Overdue" tone="rose" icon={Flame} count={brief.totals.overdue}>
                  {brief.overdue.map((item) => (
                    <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                      leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                      onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                      onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                      onSnooze={(when) => void snoozeTask(item, when)} />
                  ))}
                  {brief.totals.overdue === 0 && <EmptyRow text="Nothing overdue. Savor it." />}
                </BoardSection>
                <BoardSection title="Today" tone="amber" icon={Sun} count={brief.totals.today}>
                  {brief.today.map((item) => (
                    <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                      leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                      onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                      onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                      onSnooze={(when) => void snoozeTask(item, when)} />
                  ))}
                  {brief.totals.today === 0 && <EmptyRow text="Clear. Unfinished work rolls into Overdue at midnight — by the dates, not by magic." />}
                </BoardSection>
                <BoardSection title="This week" tone="blue" icon={CalendarDays} count={brief.totals.soon}>
                  {brief.soon.map((item) => (
                    <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                      leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                      onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                      onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                      onSnooze={(when) => void snoozeTask(item, when)} />
                  ))}
                </BoardSection>
                {brief.totals.later > 0 && (
                  <BoardSection title="Later" tone="slate" icon={CalendarDays} count={brief.totals.later}>
                    {brief.later.map((item) => (
                      <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                        leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                        onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                        onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                        onSnooze={(when) => void snoozeTask(item, when)} />
                    ))}
                  </BoardSection>
                )}
                <BoardSection title="No date" tone="slate" icon={CircleSlash} count={brief.totals.noDate} subtitle="kept alive by the login nudge">
                  {brief.noDate.map((item) => (
                    <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now}
                      leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                      onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                      onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                      onSnooze={(when) => void snoozeTask(item, when)} />
                  ))}
                </BoardSection>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {openByTopic.map(([topic, items]) => (
                  <div key={topic} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3 cockpit-flipin">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-2 h-2 rounded-full bg-cyan-400" />
                      <span className="text-xs font-black text-white">{topic}</span>
                      <span className="text-[10px] font-bold text-slate-500">{items.length}</span>
                      {topic !== "General" && (
                        <Link href={`/search?q=${encodeURIComponent(topic)}`} className="ml-auto text-[9px] font-black uppercase tracking-widest text-slate-600 hover:text-cyan-400">open in search</Link>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {items.map((item) => (
                        <TaskRow key={keyOf(item.note.id, item.task.lineIndex)} item={item} now={now} compact
                          leaving={leaving} busyKeys={busyKeys} snoozeMenuFor={snoozeMenuFor}
                          onComplete={() => void completeTask(item)} onKill={() => void killTask(item)} onNudgePerson={() => setNudgeTask(item)}
                          onSnoozeMenu={(k) => setSnoozeMenuFor(snoozeMenuFor === k ? null : k)}
                          onSnooze={(when) => void snoozeTask(item, when)} />
                      ))}
                    </div>
                  </div>
                ))}
                {openByTopic.length === 0 && <EmptyRow text="No open tasks." />}
              </div>
            )}

            {/* Archive — full classic management of every note */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
              <button onClick={() => setArchiveOpen((v) => !v)} className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-slate-900">
                <Archive className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-black uppercase tracking-widest text-slate-400">All notes</span>
                <span className="text-[10px] font-bold text-slate-600">{notes.length} loaded · search, edit, resolve</span>
                <ChevronDown className={`w-4 h-4 text-slate-600 ml-auto transition-transform ${archiveOpen ? "rotate-180" : ""}`} />
              </button>
              {archiveOpen && (
                <div className="p-3 bg-slate-100 border-t border-slate-800">
                  <ScratchpadPanel
                    orgId={orgId}
                    userId={uid}
                    userName={userEmail}
                    userEmail={userEmail}
                    userRole={userRole}
                    listMaxHeight="60vh"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Right rail */}
          <div className="space-y-4">
            <DigestCard brief={brief} staleCount={nudgeItems.length} />
            <FlightLogPanel weekLog={weekLog} allLog={flightLog} topTopic={topTopic} carried={brief.totals.overdue} onOpenReports={(p) => { setReportPeriod(p); setReportOpen(true); }} />
          </div>
        </div>
      </div>

      {/* Reports — daily / weekly / monthly, organized */}
      {reportOpen && (
        <ReportModal
          report={report}
          onPeriod={setReportPeriod}
          onCopy={() => void copyReport()}
          onDownload={downloadReport}
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
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 w-[min(560px,92vw)] rounded-2xl border border-emerald-500/30 bg-slate-900/95 backdrop-blur shadow-2xl shadow-emerald-500/10 p-3 cockpit-flipin">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <Check className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold text-white truncate">Done: {receipt.text}</div>
              <div className="text-[10px] text-slate-500">One-line outcome? It&apos;s written into the note and feeds your weekly report.</div>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              autoFocus
              value={outcomeText}
              onChange={(e) => setOutcomeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void logReceipt(receipt, outcomeText); }}
              placeholder="e.g. spec confirmed w/ Joe — 85 ft-lb"
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 outline-none focus:border-emerald-500/50 placeholder:text-slate-600"
            />
            <button onClick={() => void logReceipt(receipt, outcomeText)} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 text-xs font-black hover:bg-emerald-400">Log</button>
            <button onClick={() => void logReceipt(receipt, "")} className="px-2 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:text-slate-300">Skip</button>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-5 right-5 z-50 space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="px-3.5 py-2 rounded-xl bg-slate-800/95 border border-slate-700 text-xs font-bold text-slate-200 shadow-xl cockpit-flipin">
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
      <div className="rounded-2xl border border-amber-500/40 bg-slate-900 p-4">
        <div className="text-[10px] font-black uppercase tracking-widest text-amber-400 mb-2">Editing note</div>
        <textarea
          value={editDraft}
          onChange={(e) => onEditDraft(e.target.value)}
          rows={Math.min(14, Math.max(5, editDraft.split("\n").length + 1))}
          className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-200 outline-none focus:border-amber-500/40"
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={onSaveEdit} className="px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 text-xs font-black hover:bg-amber-400">Save</button>
          <button onClick={onCancelEdit} className="px-2 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-300">Cancel</button>
          <span className="ml-auto text-[10px] text-slate-600">Checkbox syntax: <code className="font-mono">- [ ] task due friday</code></span>
        </div>
      </div>
    );
  }

  return (
    <div className="cockpit-scene">
      <div className={`cockpit-card ${isFlipped ? "cockpit-flipped" : ""}`}>

        {/* FRONT — organized */}
        <div className="cockpit-face rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.07] via-slate-900 to-slate-900 p-4 shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <Wand2 className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-black text-white truncate">{title ?? "Note"}</div>
              <div className="text-[10px] text-slate-500 font-bold">
                {fmtWhen(note.createdAt)}{open.length > 0 && ` · ${open.length} open task${open.length === 1 ? "" : "s"}`}{done.length > 0 && ` · ${done.length} done`}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1">
              {note.rawBody && (
                <button onClick={onFlip} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-700 bg-slate-800/80 text-[10px] font-black text-slate-300 hover:text-white hover:border-amber-500/40" title="Flip to your exact original words">
                  <RotateCcw className="w-3 h-3" /> what I wrote
                </button>
              )}
              <button onClick={onResolve} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-black text-emerald-300 hover:bg-emerald-500/20" title="Close this note — archives it (recoverable under All notes)">
                <CheckCircle2 className="w-3 h-3" /> Close
              </button>
              <button onClick={onStartEdit} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-200" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={onDelete} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-rose-300" title="Delete note"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>

          {!hasStructure && (
            <pre className="mt-3 text-xs text-slate-300 font-mono whitespace-pre-wrap">{note.body}</pre>
          )}

          {findings.length > 0 && (
            <div className="mt-3">
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500 mb-1">Findings</div>
              <ul className="space-y-0.5">
                {findings.map((f, i) => (
                  <li key={i} className="text-xs text-slate-300 flex items-start gap-1.5"><span className="text-slate-600 mt-0.5">▸</span> {f}</li>
                ))}
              </ul>
            </div>
          )}

          {tasks.length > 0 && (
            <div className="mt-3">
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500 mb-1">Tasks</div>
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
                        className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${t.completed ? "bg-emerald-500 border-emerald-500" : "border-slate-600 hover:border-amber-400"}`}
                        title={t.recurring ? `Recurring (every ${t.recurring}) — completing rolls it forward` : "Done"}
                      >
                        {t.completed && <Check className="w-2.5 h-2.5 text-slate-950" />}
                      </button>
                      <span className={`flex-1 min-w-0 truncate ${t.completed ? "line-through text-slate-500" : "text-slate-200"}`}>
                        {t.dueText ? t.body.replace(t.dueText, "").replace(/\s{2,}/g, " ").trim() : t.body}
                        {t.outcome && <span className="text-emerald-400/80 no-underline"> — {t.outcome}</span>}
                      </span>
                      {t.recurring && <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 text-[9px] font-black"><Repeat className="w-2.5 h-2.5" /> {t.recurring}</span>}
                      {t.dueAt && !t.completed && (
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${dueTone(t.dueAt)}`}>{humanDue(t.dueAt)}</span>
                      )}
                      {!t.completed && (
                        <span className="relative shrink-0 hidden group-hover/task:inline-flex">
                          <button onClick={() => onSnoozeMenu(k)} className="p-0.5 rounded hover:bg-slate-700 text-slate-500 hover:text-slate-200" title="Snooze"><AlarmClock className="w-3 h-3" /></button>
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
        <div className="cockpit-face cockpit-back rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <FileText className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-black text-white">Your exact words</div>
              <div className="text-[10px] text-slate-500 font-bold">verbatim — nothing edited, nothing lost</div>
            </div>
            <button onClick={onToggleDiff} className={`shrink-0 px-2 py-1 rounded-lg border text-[10px] font-black ${showDiff ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-slate-700 bg-slate-800 text-slate-400"}`}>
              {showDiff ? "highlighting tasks" : "show what became tasks"}
            </button>
            <button onClick={onFlip} className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-700 bg-slate-800/80 text-[10px] font-black text-slate-300 hover:text-white">
              <Wand2 className="w-3 h-3 text-amber-400" /> organized
            </button>
          </div>
          <div className="mt-3 rounded-xl bg-slate-950 border border-slate-800 p-3 font-mono text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
            <RawWithHighlights raw={note.rawBody ?? note.body} highlights={highlights} />
          </div>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-600 font-bold">
            {showDiff && highlights.length > 0 && (
              <span><mark className="bg-amber-500/20 text-amber-300 px-1 rounded">highlighted</mark> = what the organizer turned into tasks</span>
            )}
            <span className="ml-auto">spot a mistake? <button onClick={onStartEdit} className="text-amber-400 hover:text-amber-300 font-black">edit the organized note</button></span>
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
    parts.push(<mark key={k++} className="bg-amber-500/20 text-amber-200 rounded px-0.5">{rest.slice(idx, idx + h.length)}</mark>);
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
    rose: ["text-rose-400", "border-l-rose-500/60"],
    amber: ["text-amber-400", "border-l-amber-500/60"],
    blue: ["text-blue-400", "border-l-blue-500/50"],
    slate: ["text-slate-500", "border-l-slate-700"],
  };
  const [iconCls, borderCls] = tones[tone];
  return (
    <div className={`rounded-2xl border border-slate-800 border-l-4 ${borderCls} bg-slate-900/60 p-3`}>
      <div className="flex items-baseline gap-2 mb-2">
        <Icon className={`w-3.5 h-3.5 self-center ${iconCls}`} />
        <span className="text-[11px] font-black uppercase tracking-widest text-slate-300">{title}</span>
        <span className="text-[10px] font-bold text-slate-600 tabular-nums">{count}</span>
        {subtitle && <span className="ml-auto text-[9px] text-slate-600 font-bold">{subtitle}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function TaskRow({
  item, now, compact, leaving, busyKeys, snoozeMenuFor, onComplete, onKill, onNudgePerson, onSnoozeMenu, onSnooze,
}: {
  item: TaskWithNote; now: Date; compact?: boolean;
  leaving: Map<string, "dissolve" | "peel">; busyKeys: Set<string>; snoozeMenuFor: string | null;
  onComplete: () => void; onKill: () => void; onNudgePerson: () => void;
  onSnoozeMenu: (k: string) => void; onSnooze: (when: SnoozeChoice) => void;
}) {
  const { note, task } = item;
  const k = keyOf(note.id, task.lineIndex);
  const anim = leaving.get(k);
  const leavingCls = anim === "dissolve" ? "cockpit-dissolve" : anim === "peel" ? "cockpit-peel" : "";
  const daysOver = task.dueAt && task.dueAt < ymd(now)
    ? Math.round((new Date(`${ymd(now)}T00:00:00`).getTime() - new Date(`${task.dueAt}T00:00:00`).getTime()) / 864e5)
    : 0;
  const escalated = daysOver >= 7;
  const snoozes = note.taskMeta[taskKeyFor(task.body)]?.snoozes ?? 0;
  const topic = topicForTask(task.body);
  const display = task.dueText ? task.body.replace(task.dueText, "").replace(/\s{2,}/g, " ").trim() : task.body;
  const heat = daysOver >= 7 ? "border-rose-500/60 bg-rose-500/[0.10] cockpit-breathe"
    : daysOver >= 3 ? "border-rose-500/40 bg-rose-500/[0.07] cockpit-breathe"
    : daysOver >= 1 ? "border-rose-500/25 bg-rose-500/[0.04]"
    : task.dueAt === ymd(now) ? "border-amber-500/25 bg-amber-500/[0.04]"
    : "border-slate-800 bg-slate-900/40";

  if (escalated) {
    return (
      <div className={`relative rounded-xl border ${heat} p-3 ${leavingCls}`}>
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-rose-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-white">{display}</div>
            <div className="text-[10px] font-black uppercase tracking-widest text-rose-400 mt-0.5">{daysOver}d overdue — do it, snooze it, or kill it</div>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <button onClick={onComplete} disabled={busyKeys.has(k)} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-500 text-slate-950 text-[11px] font-black hover:bg-emerald-400 disabled:opacity-60"><Check className="w-3 h-3" /> Do it now</button>
          <div className="relative flex-1">
            <button onClick={() => onSnoozeMenu(k)} className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-black text-slate-300 hover:bg-slate-700"><AlarmClock className="w-3 h-3" /> Snooze <ChevronDown className="w-3 h-3" /></button>
            {snoozeMenuFor === k && <SnoozeMenu onSnooze={onSnooze} />}
          </div>
          <button onClick={onKill} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-black text-slate-400 hover:text-rose-300 hover:border-rose-500/40"><Trash2 className="w-3 h-3" /> Kill</button>
          <button onClick={onNudgePerson} title="Send to a teammate" className="inline-flex items-center justify-center px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-sky-300 hover:border-sky-500/40"><Send className="w-3 h-3" /></button>
        </div>
      </div>
    );
  }

  return (
    <div className={`group relative flex items-center gap-2.5 rounded-xl border ${heat} px-3 ${compact ? "py-1.5" : "py-2"} ${leavingCls}`}>
      <button
        onClick={onComplete}
        disabled={busyKeys.has(k)}
        className="group/done w-[18px] h-[18px] rounded-md border-2 border-slate-500 hover:border-emerald-400 hover:bg-emerald-500/15 shrink-0 transition-colors disabled:opacity-50 flex items-center justify-center"
        title={task.recurring ? `Recurring (every ${task.recurring}) — completing rolls it forward` : "Mark done (asks for a one-line outcome)"}
      >
        <Check className="w-3 h-3 text-emerald-400 opacity-0 group-hover/done:opacity-100" />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold text-slate-200 truncate">{display}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/70" /> {topic}
          </span>
          {task.recurring && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 text-[9px] font-black"><Repeat className="w-2.5 h-2.5" /> every {task.recurring}</span>
          )}
          {snoozes >= 3 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[9px] font-black"><AlarmClock className="w-2.5 h-2.5" /> snoozed {snoozes}× — still real?</span>
          )}
        </div>
      </div>
      {task.dueAt && (
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wide ${dueTone(task.dueAt)}`}>{humanDue(task.dueAt)}</span>
      )}
      <div className="shrink-0 flex items-center gap-0.5">
        <div className="relative">
          <button onClick={() => onSnoozeMenu(k)} className="p-1 rounded-md hover:bg-slate-700 text-slate-500 hover:text-slate-200" title="Snooze — presets or pick a date"><AlarmClock className="w-3.5 h-3.5" /></button>
          {snoozeMenuFor === k && <SnoozeMenu onSnooze={onSnooze} />}
        </div>
        <button onClick={onNudgePerson} className="p-1 rounded-md hover:bg-slate-700 text-slate-500 hover:text-sky-300" title="Send to a teammate"><Send className="w-3.5 h-3.5" /></button>
        <button onClick={onKill} className="p-1 rounded-md hover:bg-slate-700 text-slate-500 hover:text-rose-300" title="Kill (removes the line)"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}

function SnoozeMenu({ onSnooze }: { onSnooze: (when: SnoozeChoice) => void }) {
  return (
    <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-xl border border-slate-700 bg-slate-800 shadow-2xl p-1 cockpit-flipin" onClick={(e) => e.stopPropagation()}>
      {(["tomorrow", "next shift", "Monday"] as const).map((w) => (
        <button key={w} onClick={() => onSnooze(w)} className="w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white capitalize">
          {w}
        </button>
      ))}
      <div className="mt-1 pt-1.5 border-t border-slate-700 px-1.5 pb-1">
        <label className="block text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">or pick a date</label>
        <input
          type="date"
          min={ymd(new Date())}
          onChange={(e) => { if (e.target.value) onSnooze({ dateIso: e.target.value }); }}
          className="w-full bg-slate-900 border border-slate-700 rounded-md px-1.5 py-1 text-[11px] text-slate-200 [color-scheme:dark]"
        />
      </div>
    </div>
  );
}

function IntroTry({ icon: Icon, title, sub, onClick }: {
  icon: React.ComponentType<{ className?: string }>; title: string; sub: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="flex items-start gap-2.5 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-left hover:border-amber-500/40 transition-colors">
      <Icon className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-xs font-black text-slate-200">{title}</span>
        <span className="block text-[10px] text-slate-500">{sub}</span>
      </span>
    </button>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="text-[11px] text-slate-600 italic px-1 py-0.5">{text}</div>;
}

// ─── Right rail ─────────────────────────────────────────────────────────────

function DigestCard({ brief, staleCount }: { brief: DailyBrief; staleCount: number }) {
  const oldest = brief.overdue[0]?.task.dueAt;
  return (
    <div className="rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/[0.08] via-slate-900 to-slate-900 p-4">
      <div className="flex items-center gap-2">
        <Bell className="w-4 h-4 text-violet-300" />
        <span className="text-xs font-black uppercase tracking-widest text-white">Morning digest</span>
      </div>
      <div className="mt-3 space-y-1.5 text-xs">
        <div className="flex items-center gap-2 text-rose-300 font-bold"><Flame className="w-3.5 h-3.5" /> {brief.totals.overdue} overdue{oldest ? ` — oldest due ${oldest}` : ""}</div>
        <div className="flex items-center gap-2 text-amber-300 font-bold"><Sun className="w-3.5 h-3.5" /> {brief.totals.today} due today</div>
        <div className="flex items-center gap-2 text-slate-400 font-bold"><CircleSlash className="w-3.5 h-3.5" /> {staleCount} dateless task{staleCount === 1 ? "" : "s"} aging</div>
        {brief.totals.soon > 0 && (
          <div className="flex items-center gap-2 text-slate-400 font-bold"><CalendarDays className="w-3.5 h-3.5" /> {brief.totals.soon} later this week</div>
        )}
      </div>
      <div className="mt-3 text-[10px] text-slate-600 leading-relaxed">
        Composed into ONE bell notification on your first visit each day — dates or no dates. Nothing fires twice.
      </div>
    </div>
  );
}

function FlightLogPanel({
  weekLog, allLog, topTopic, carried, onOpenReports,
}: {
  weekLog: FlightLogEntry[]; allLog: FlightLogEntry[];
  topTopic: [string, number] | null; carried: number; onOpenReports: (period: ReportPeriod) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex items-center gap-2">
        <BadgeCheck className="w-4 h-4 text-emerald-400" />
        <span className="text-xs font-black uppercase tracking-widest text-white">Flight log</span>
        <span className="text-[10px] text-slate-600 font-bold">receipts of done work</span>
      </div>

      <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-emerald-400/80">This week</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-2xl font-black text-white tabular-nums">{weekLog.length}</span>
          <span className="text-[11px] font-bold text-slate-400">
            done · {carried} carrying over{topTopic ? <> · top topic <span className="text-purple-300 font-black">{topTopic[0]}</span></> : null}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-600">Reports:</span>
          {(["day", "week", "month"] as const).map((p) => (
            <button key={p} onClick={() => onOpenReports(p)} className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[10px] font-black text-slate-300 hover:text-white hover:border-emerald-500/40">
              {p === "day" ? "Daily" : p === "week" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {allLog.slice(0, 8).map((e) => (
          <div key={`${e.noteId}:${e.lineIndex}`} className="flex items-start gap-2 text-xs">
            <Check className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-slate-300 font-bold truncate">{e.text}</div>
              {e.outcome && <div className="text-[10px] text-slate-500 italic truncate">“{e.outcome}”</div>}
            </div>
            <span className="text-[9px] font-bold text-slate-600 shrink-0 mt-0.5">{e.doneAt.slice(5)}</span>
          </div>
        ))}
        {allLog.length === 0 && (
          <div className="text-[11px] text-slate-600 italic">Check a task off and log a one-line outcome — receipts land here, written into the note itself.</div>
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
    rose: value > 0 ? "border-rose-500/40 bg-rose-500/10 text-rose-300" : "border-slate-800 bg-slate-900 text-slate-500",
    amber: value > 0 ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-slate-800 bg-slate-900 text-slate-500",
    blue: "border-slate-800 bg-slate-900 text-slate-400",
    slate: "border-slate-800 bg-slate-900 text-slate-500",
    emerald: "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-300",
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
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-slate-700 bg-slate-900 text-slate-400 text-[9px] font-black uppercase tracking-widest"
      title="Private to you. Everything here runs on your device — organizing, reminders, answers, and footnotes are computed from your own data. Nothing is sent to any outside service."
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Private · on your device
    </span>
  );
}

function SyntaxHint({ example, hint }: { example: string; hint: string }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <code className="font-mono bg-slate-800 border border-slate-700 px-2 py-0.5 rounded text-slate-200">{example}</code>
      <span className="text-slate-500">→ {hint}</span>
    </div>
  );
}

function dueTone(dueAt: string): string {
  const today = ymd(new Date());
  if (dueAt < today) return "bg-rose-500/15 text-rose-300 border border-rose-500/30";
  if (dueAt === today) return "bg-amber-500/15 text-amber-300 border border-amber-500/30";
  return "bg-blue-500/10 text-blue-300 border border-blue-500/25";
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

function ReportModal({
  report, onPeriod, onCopy, onDownload, onClose,
}: {
  report: ReportData;
  onPeriod: (p: ReportPeriod) => void;
  onCopy: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl cockpit-flipin" onClick={(e) => e.stopPropagation()}>

        {/* Header: title + period tabs */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-3 flex-wrap">
          <BadgeCheck className="w-5 h-5 text-emerald-400" />
          <div>
            <div className="text-base font-black text-white">Your report</div>
            <div className="text-[10px] font-bold text-slate-500">{report.sinceIso === report.todayIso ? report.todayIso : `${report.sinceIso} → ${report.todayIso}`}</div>
          </div>
          <div className="ml-auto flex items-center rounded-lg border border-slate-700 bg-slate-800 p-0.5">
            {(["day", "week", "month"] as const).map((p) => (
              <button key={p} onClick={() => onPeriod(p)} className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider ${report.period === p ? "bg-slate-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
                {p === "day" ? "Daily" : p === "week" ? "Weekly" : "Monthly"}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>

        {/* Stats strip */}
        <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-4 flex-wrap text-xs">
          <span className="font-black text-white text-lg tabular-nums">{report.stats.done}</span>
          <span className="text-slate-400 font-bold -ml-2">done</span>
          <span className="font-black text-white text-lg tabular-nums">{report.stats.carry}</span>
          <span className="text-slate-400 font-bold -ml-2">carrying over{report.stats.overdueCarry > 0 && <span className="text-rose-400"> · {report.stats.overdueCarry} overdue</span>}</span>
          {report.stats.avgTookDays !== null && (
            <span className="text-slate-400 font-bold">avg <span className="text-white font-black">{report.stats.avgTookDays}d</span> to close</span>
          )}
          {report.stats.topTopic && (
            <span className="text-slate-400 font-bold">top: <span className="text-purple-300 font-black">{report.stats.topTopic[0]}</span> ({report.stats.topTopic[1]})</span>
          )}
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[55vh] overflow-y-auto">
          {/* Achievements */}
          <div>
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-400/90 mb-2">Achievements</div>
            {report.achievements.length === 0 ? (
              <div className="text-xs text-slate-600 italic">Nothing completed in this window — the carry-over below is the to-do.</div>
            ) : (
              <div className="space-y-3">
                {report.achievements.map((g) => (
                  <div key={g.day}>
                    <div className="text-[10px] font-black text-slate-500 mb-1">{fmtDayLabel(g.day)}</div>
                    <div className="space-y-1">
                      {g.items.map((e) => (
                        <div key={`${e.noteId}:${e.lineIndex}`} className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-1.5">
                          <Check className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold text-slate-200">{e.text}</div>
                            {e.outcome && <div className="text-[10px] text-emerald-400/80 italic">“{e.outcome}”</div>}
                          </div>
                          <div className="shrink-0 text-right">
                            {e.tookDays !== null && (
                              <div className="text-[10px] font-black text-slate-400">{e.tookDays === 0 ? "same day" : `took ${e.tookDays}d`}</div>
                            )}
                            <div className="text-[9px] font-bold text-purple-300/80">{e.topic}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Carry-over */}
          <div>
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-400/90 mb-2">Carrying over</div>
            {report.carryOver.length === 0 ? (
              <div className="text-xs text-emerald-400 font-bold">Nothing open — clean slate.</div>
            ) : (
              <div className="space-y-1">
                {report.carryOver.map((c) => (
                  <div key={`${c.noteId}:${c.lineIndex}`} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${c.overdueDays > 0 ? "border-rose-500/30 bg-rose-500/[0.05]" : "border-slate-800 bg-slate-950/50"}`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.overdueDays > 0 ? "bg-rose-400" : "bg-slate-600"}`} />
                    <div className="min-w-0 flex-1 text-xs font-bold text-slate-200 truncate">{c.text}</div>
                    <div className="shrink-0 flex items-center gap-1.5 text-[10px] font-black">
                      <span className="text-slate-500">open {c.daysOpen}d</span>
                      {c.overdueDays > 0 && <span className="text-rose-300">{c.overdueDays}d overdue</span>}
                      {c.overdueDays === 0 && c.dueAt && <span className="text-blue-300">due {c.dueAt}</span>}
                      {c.recurring && <span className="text-blue-300 inline-flex items-center gap-0.5"><Repeat className="w-2.5 h-2.5" />{c.recurring}</span>}
                      <span className="text-purple-300/80">{c.topic}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center gap-2">
          <button onClick={onCopy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-black text-slate-300 hover:text-white"><Copy className="w-3.5 h-3.5" /> Copy markdown</button>
          <button onClick={onDownload} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-black text-slate-300 hover:text-white"><Download className="w-3.5 h-3.5" /> Download .md</button>
          <span className="ml-auto text-[10px] text-slate-600">Proof of where the time went — and what rolls forward.</span>
        </div>
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
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center p-4 sm:p-10 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl cockpit-flipin" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
          <Send className="w-4 h-4 text-sky-300" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-black text-white">Send to a teammate</div>
            <div className="text-[10px] text-slate-500 truncate">“{taskText}” — lands in their bell. A heads-up, not an assignment.</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-3 space-y-2">
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="optional note — e.g. can you grab this before Friday?"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-sky-500/50 placeholder:text-slate-600"
          />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="find a person…"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-sky-500/50 placeholder:text-slate-600"
          />
          {err && <div className="text-[11px] text-rose-400">{err}</div>}
          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {targets === null && <div className="text-[11px] text-slate-500 py-2 text-center"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" />Loading members…</div>}
            {targets !== null && list.length === 0 && <div className="text-[11px] text-slate-600 italic py-2 text-center">No matching members.</div>}
            {list.map((t) => (
              <button
                key={t.uid}
                onClick={() => void send(t)}
                disabled={!!sendingTo}
                className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-slate-800 text-left disabled:opacity-50"
              >
                <span className="w-7 h-7 rounded-full bg-sky-500/15 border border-sky-500/30 text-sky-300 text-[11px] font-black flex items-center justify-center shrink-0">
                  {t.name.charAt(0).toUpperCase()}
                </span>
                <span className="text-xs font-bold text-slate-200 flex-1 truncate">{t.name}</span>
                {sendingTo === t.uid ? <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-300" /> : <Send className="w-3.5 h-3.5 text-slate-600" />}
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
