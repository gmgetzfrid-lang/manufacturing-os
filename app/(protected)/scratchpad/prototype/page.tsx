"use client";

// /scratchpad/prototype — HIGH-FIDELITY INTERACTIVE PROTOTYPE of the
// scratchpad cockpit. 100% mock data, zero backend calls, zero AI calls —
// every behavior is simulated locally so the design can be felt and judged
// before anything real is wired up.
//
// What it demonstrates (the agreed spine):
//   write → submit → comes back organized → FLIP to verify → it reminds you
//
//   • Console bar: jot a task / paste a mess (✦ Organize) / ask a question
//   • Flip card: AI-organized front ⟷ verbatim raw back with diff highlights
//   • Board with temperature: cards warm with age, overdue breathes,
//     7-day escalation demands act/snooze/kill, "snoozed 4×" callout
//   • Group by TIME or by THING (topic clusters)
//   • Check → one-line outcome receipt → Flight log → weekly report
//   • Welcome-back nudge for dateless notes; 06:00 digest preview
//   • AI HUD with live health/latency + LOCAL fallback toggle
//   • Demo controls (bottom-right): end-of-day rollover, login nudge, AI off
//
// THROWAWAY: not linked from nav (except a preview pill on /scratchpad).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles, Clock, Sun, CalendarDays, CircleSlash, AlertTriangle, Check, X,
  ChevronDown, RefreshCw, Repeat, Send, Trash2, RotateCcw, KeyRound, FileText,
  AtSign, ListChecks, Zap, Layers, BadgeCheck, Flame, AlarmClock, Settings2,
  ArrowRight, Bell, Loader2, StickyNote,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

type Bucket = "overdue" | "today" | "week" | "nodate";
type Leaving = "dissolve" | "peel" | "slide" | null;

interface ProtoTask {
  id: string;
  text: string;
  topic: string;
  bucket: Bucket;
  dueLabel?: string;
  daysOverdue?: number;
  recurring?: string;
  snoozes?: number;
  leaving?: Leaving;
}

interface ProtoChip {
  kind: "equipment" | "moc" | "person" | "deadline" | "document";
  text: string;
  hover?: string;
}

interface NoteTask { text: string; due?: string; done?: boolean; leaving?: boolean }

interface OrganizedNote {
  id: string;
  title: string;
  when: string;
  findings: string[];
  tasks: NoteTask[];
  chips: ProtoChip[];
  raw: string;
  rawHighlights: string[];
  flipped: boolean;
  showDiff: boolean;
  justIn?: boolean;
}

interface LogEntry { id: string; text: string; outcome: string; when: string }
interface AnswerCard { q: string; lines: string[]; chips: ProtoChip[] }
interface Toast { id: string; msg: string }

const uid = () => Math.random().toString(36).slice(2, 9);

// ─── Seed data — a believable Thursday morning ──────────────────────────────

const SEED_TASKS: ProtoTask[] = [
  { id: uid(), text: "Send red-line markups to doc control", topic: "Paperwork", bucket: "overdue", dueLabel: "7d overdue", daysOverdue: 7 },
  { id: uid(), text: "Call Joe about E-204 gasket spec", topic: "E-204", bucket: "overdue", dueLabel: "2d overdue", daysOverdue: 2 },
  { id: uid(), text: "Verify LOTO list for P-101A swap", topic: "Unit 3", bucket: "overdue", dueLabel: "1d overdue", daysOverdue: 1, snoozes: 4 },
  { id: uid(), text: "Walk down P-101A vibration reading", topic: "Unit 3", bucket: "today", dueLabel: "today" },
  { id: uid(), text: "Submit weekly checkout report", topic: "Paperwork", bucket: "today", dueLabel: "today", recurring: "every friday" },
  { id: uid(), text: "Confirm crane window with Marcus", topic: "Unit 3", bucket: "today", dueLabel: "by 15:00" },
  { id: uid(), text: "Relief valve recert paperwork", topic: "E-204", bucket: "week", dueLabel: "Wed" },
  { id: uid(), text: "Review MOC-2024-051 redlines", topic: "MOC-2024-051", bucket: "week", dueLabel: "Thu" },
  { id: uid(), text: "Idea: color-code the blinds list", topic: "General", bucket: "nodate" },
  { id: uid(), text: "Ask about spare gasket stock minimums", topic: "E-204", bucket: "nodate" },
  { id: uid(), text: "Attach walkdown photos to note", topic: "Unit 3", bucket: "nodate" },
];

const HERO_RAW = "ok walked unit 3 this morning, e-204 inlet flange still weeping, need to call joe about gasket spec before friday. dana said MOC-2024-051 paperwork is stuck w/ safety - follow up. also order 2 spare gaskets and check p-101a vibration, reading was high-ish. relief valve cert expires next month dont forget";

const SEED_NOTE: OrganizedNote = {
  id: uid(),
  title: "Unit 3 morning walkdown",
  when: "organized 2m ago",
  findings: [
    "E-204 inlet flange still weeping",
    "P-101A vibration reading trending high",
    "MOC-2024-051 paperwork stuck with Safety (per Dana)",
  ],
  tasks: [
    { text: "Call Joe re: E-204 gasket spec", due: "Friday" },
    { text: "Follow up with Dana on MOC-2024-051" },
    { text: "Order 2 spare gaskets" },
    { text: "Trend P-101A vibration reading" },
    { text: "Schedule relief valve recert", due: "next month" },
  ],
  chips: [
    { kind: "equipment", text: "E-204", hover: "E-204 · Exchanger · BLOCKED · locked by Alice M." },
    { kind: "equipment", text: "P-101A", hover: "P-101A · Pump · EXECUTING" },
    { kind: "moc", text: "MOC-2024-051", hover: "MOC · on hold 6d · awaiting Safety" },
    { kind: "person", text: "Joe", hover: "Joe T. · Maintenance" },
    { kind: "person", text: "Dana", hover: "Dana R. · Safety" },
    { kind: "deadline", text: "Friday", hover: "Jun 13 — tomorrow" },
  ],
  raw: HERO_RAW,
  rawHighlights: [
    "need to call joe about gasket spec before friday",
    "follow up",
    "order 2 spare gaskets",
    "check p-101a vibration",
    "relief valve cert expires next month dont forget",
  ],
  flipped: false,
  showDiff: true,
};

const SEED_LOG: LogEntry[] = [
  { id: uid(), text: "Cleared hold #42 paperwork", outcome: "released by Safety 14:10", when: "yesterday" },
  { id: uid(), text: "Returned E-204 IFC drawing", outcome: "rev C checked in", when: "yesterday" },
  { id: uid(), text: "Updated blind list for Unit 3", outcome: "—", when: "Mon" },
];

const TOPIC_TONES: Record<string, string> = {
  "E-204": "bg-purple-400",
  "Unit 3": "bg-cyan-400",
  "MOC-2024-051": "bg-blue-400",
  "Paperwork": "bg-slate-400",
  "General": "bg-emerald-400",
};

// ─── Mock organizer (pure local rules — this IS the demo) ───────────────────

const TASK_VERB = /\b(call|check|follow up|order|schedule|ask|confirm|verify|inspect|get|fix|send|submit|need to|don'?t forget)\b/i;
const DUE_RX = /\b(?:by |due |before )?(friday|monday|tuesday|wednesday|thursday|tomorrow|today|next week|next month)\b/i;

function cleanTask(s: string): string {
  const t = s.replace(/^\s*(also|and|then|ok|need to|don'?t forget(?: about)?)\s+/i, "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function organizeText(rawIn: string): OrganizedNote {
  const raw = rawIn.trim();
  const sentences = raw.split(/[.!?;\n]+/).map((s) => s.trim()).filter(Boolean);
  const tasks: NoteTask[] = [];
  const findings: string[] = [];
  const rawHighlights: string[] = [];

  for (const s of sentences) {
    if (TASK_VERB.test(s)) {
      const due = DUE_RX.exec(s)?.[1];
      tasks.push({ text: cleanTask(s.replace(DUE_RX, "").replace(/\s{2,}/g, " ").trim()), due });
      rawHighlights.push(s);
    } else {
      findings.push(cleanTask(s));
    }
  }

  const chips: ProtoChip[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(/\b([a-zA-Z]{1,3}-\d{2,4}[a-zA-Z]?)\b/g)) {
    const tag = m[1].toUpperCase();
    if (seen.has(tag) || /^MOC/i.test(tag)) continue;
    seen.add(tag);
    chips.push({ kind: "equipment", text: tag, hover: `${tag} · resolves to your asset registry in the build` });
  }
  for (const m of raw.matchAll(/\bMOC-\d{4}-\d+\b/gi)) {
    const t = m[0].toUpperCase();
    if (!seen.has(t)) { seen.add(t); chips.push({ kind: "moc", text: t }); }
  }
  const due = DUE_RX.exec(raw)?.[1];
  if (due) chips.push({ kind: "deadline", text: due });

  const firstWords = sentences[0]?.split(/\s+/).slice(0, 6).join(" ") ?? "Quick capture";
  return {
    id: uid(),
    title: firstWords.charAt(0).toUpperCase() + firstWords.slice(1),
    when: "organized just now",
    findings, tasks, chips, raw, rawHighlights,
    flipped: false, showDiff: true, justIn: true,
  };
}

function mockAnswer(q: string): AnswerCard {
  if (/e-?204/i.test(q)) {
    return {
      q: "Who has E-204?",
      lines: ["Alice M. — 2 documents touching E-204, checked out since Tue", "P&ID-1142 rev B · ISO-204-12"],
      chips: [{ kind: "equipment", text: "E-204" }, { kind: "person", text: "Alice M." }],
    };
  }
  if (/block|hold/i.test(q)) {
    return {
      q: "What&apos;s blocked?",
      lines: ["3 active holds · oldest 6 days", "MOC-2024-051 — awaiting Safety review (6d)", "E-204 reinsulation — parts on order (2d)"],
      chips: [{ kind: "moc", text: "MOC-2024-051" }, { kind: "equipment", text: "E-204" }],
    };
  }
  return {
    q,
    lines: ["4 results (demo)", "P&ID-1142 — Unit 3 Overheads, rev B", "SPEC-0871 — Gasket, spiral wound"],
    chips: [{ kind: "document", text: "P&ID-1142" }, { kind: "document", text: "SPEC-0871" }],
  };
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ScratchpadPrototypePage() {
  const [now, setNow] = useState<Date>(new Date());
  const [tasks, setTasks] = useState<ProtoTask[]>(SEED_TASKS);
  const [notes, setNotes] = useState<OrganizedNote[]>([SEED_NOTE]);
  const [log, setLog] = useState<LogEntry[]>(SEED_LOG);
  const [doneThisWeek, setDoneThisWeek] = useState(9);

  const [consoleText, setConsoleText] = useState("");
  const [organizing, setOrganizing] = useState(false);
  const [answer, setAnswer] = useState<AnswerCard | null>(null);
  const consoleRef = useRef<HTMLTextAreaElement | null>(null);

  const [aiOnline, setAiOnline] = useState(true);
  const [latency, setLatency] = useState(412);

  const [groupMode, setGroupMode] = useState<"time" | "thing">("time");
  const [nudgeOpen, setNudgeOpen] = useState(true);
  const [nudgeDismissed, setNudgeDismissed] = useState<Set<string>>(new Set());
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string | null>(null);
  const [receiptFor, setReceiptFor] = useState<ProtoTask | null>(null);
  const [outcomeText, setOutcomeText] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [demoOpen, setDemoOpen] = useState(false);

  // Live clock.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // AI HUD heartbeat — jittering latency while "online".
  useEffect(() => {
    if (!aiOnline) return;
    const id = setInterval(() => setLatency(280 + Math.round(Math.random() * 320)), 3500);
    return () => clearInterval(id);
  }, [aiOnline]);

  // "/" focuses the console from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        consoleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toast = useCallback((msg: string) => {
    const t = { id: uid(), msg };
    setToasts((arr) => [...arr, t]);
    setTimeout(() => setToasts((arr) => arr.filter((x) => x.id !== t.id)), 2800);
  }, []);

  // ── Task actions ──────────────────────────────────────────────
  const removeAfter = useCallback((id: string, leaving: Leaving, ms: number, then?: () => void) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, leaving } : t)));
    setTimeout(() => {
      setTasks((ts) => ts.filter((t) => t.id !== id));
      then?.();
    }, ms);
  }, []);

  const checkTask = useCallback((task: ProtoTask) => {
    removeAfter(task.id, "dissolve", 420, () => {
      setReceiptFor(task);
      setOutcomeText("");
      setDoneThisWeek((n) => n + 1);
    });
  }, [removeAfter]);

  const logReceipt = useCallback((task: ProtoTask, outcome: string) => {
    setLog((l) => [{ id: uid(), text: task.text, outcome: outcome.trim() || "—", when: "just now" }, ...l]);
    setReceiptFor(null);
    toast("Logged to flight log");
  }, [toast]);

  const snoozeTask = useCallback((task: ProtoTask, when: "tomorrow" | "next shift" | "Monday") => {
    setSnoozeMenuFor(null);
    setTasks((ts) => ts.map((t) => (t.id === task.id ? { ...t, leaving: "peel" } : t)));
    setTimeout(() => {
      setTasks((ts) => ts.map((t) => t.id === task.id
        ? {
            ...t, leaving: null, snoozes: (t.snoozes ?? 0) + 1, daysOverdue: undefined,
            bucket: when === "next shift" ? "today" : "week",
            dueLabel: when === "next shift" ? "next shift" : when === "tomorrow" ? "tomorrow" : "Mon",
          }
        : t));
      toast(`Snoozed — see you ${when}`);
    }, 380);
  }, [toast]);

  const killTask = useCallback((task: ProtoTask) => {
    removeAfter(task.id, "dissolve", 420, () => toast("Killed. It won&apos;t haunt you."));
  }, [removeAfter, toast]);

  const nudgePerson = useCallback((task: ProtoTask) => {
    toast(`Nudged Joe — “${task.text.slice(0, 32)}…” (demo)`);
  }, [toast]);

  // ── Console ───────────────────────────────────────────────────
  const wantsOrganize = consoleText.trim().length > 110 || consoleText.includes("\n");
  const isQuestion = /\?\s*$/.test(consoleText.trim()) || /^(who|what|where|when|how|show|find)\b/i.test(consoleText.trim());

  const runOrganize = useCallback(() => {
    const text = consoleText.trim();
    if (!text || organizing) return;
    setOrganizing(true);
    setTimeout(() => {
      setNotes((ns) => [organizeText(text), ...ns]);
      setConsoleText("");
      setOrganizing(false);
      toast(aiOnline ? "Organized — flip the card to verify" : "Organized locally (rules engine)");
    }, aiOnline ? 1000 : 250);
  }, [consoleText, organizing, aiOnline, toast]);

  const submitConsole = useCallback(() => {
    const text = consoleText.trim();
    if (!text) return;
    if (wantsOrganize) { runOrganize(); return; }
    if (isQuestion) { setAnswer(mockAnswer(text)); setConsoleText(""); return; }
    // Quick task capture.
    const due = DUE_RX.exec(text)?.[1];
    const recurring = /\bevery (monday|tuesday|wednesday|thursday|friday|shift|month)\b/i.exec(text)?.[0];
    const tag = /\b([a-zA-Z]{1,3}-\d{2,4}[a-zA-Z]?)\b/.exec(text)?.[1]?.toUpperCase();
    const topic = tag ?? (/unit 3/i.test(text) ? "Unit 3" : "General");
    const bucket: Bucket = due === "today" || recurring ? "today" : due ? "week" : "nodate";
    setTasks((ts) => [...ts, {
      id: uid(),
      text: cleanTask(text.replace(/^- \[ \]\s*/, "").replace(DUE_RX, "").trim()),
      topic, bucket,
      dueLabel: recurring ? "today" : due,
      recurring: recurring?.toLowerCase(),
    }]);
    setConsoleText("");
    toast(due || recurring ? `Filed — ${recurring ?? `due ${due}`}` : "Filed to No date — the nudge will keep it alive");
  }, [consoleText, wantsOrganize, isQuestion, runOrganize, toast]);

  // ── Demo controls ─────────────────────────────────────────────
  const demoRollover = useCallback(() => {
    setDemoOpen(false);
    const todays = tasks.filter((t) => t.bucket === "today" && !t.recurring);
    if (todays.length === 0) { toast("Nothing left in Today to roll"); return; }
    setTasks((ts) => ts.map((t) => (t.bucket === "today" && !t.recurring ? { ...t, leaving: "slide" } : t)));
    setTimeout(() => {
      setTasks((ts) => ts.map((t) => t.bucket === "today" && !t.recurring
        ? { ...t, leaving: null, bucket: "overdue", daysOverdue: 1, dueLabel: "1d overdue" }
        : t));
      toast("Day rolled — unfinished work carried into Overdue");
    }, 520);
  }, [tasks, toast]);

  const demoNudge = useCallback(() => { setNudgeDismissed(new Set()); setNudgeOpen(true); setDemoOpen(false); }, []);
  const demoAiToggle = useCallback(() => { setAiOnline((v) => !v); setDemoOpen(false); }, []);

  // ── Derived ───────────────────────────────────────────────────
  const buckets = useMemo(() => ({
    overdue: tasks.filter((t) => t.bucket === "overdue").sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0)),
    today: tasks.filter((t) => t.bucket === "today"),
    week: tasks.filter((t) => t.bucket === "week"),
    nodate: tasks.filter((t) => t.bucket === "nodate"),
  }), [tasks]);

  const topics = useMemo(() => {
    const m = new Map<string, ProtoTask[]>();
    for (const t of tasks) {
      const arr = m.get(t.topic) ?? [];
      arr.push(t);
      m.set(t.topic, arr);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [tasks]);

  const nudgeItems = buckets.nodate.filter((t) => !nudgeDismissed.has(t.id));
  const carriedOver = 2;

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const dateLabel = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }).toUpperCase();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 pb-28 bg-[radial-gradient(ellipse_at_top,rgba(251,146,60,0.08),transparent_55%)]">
      <style>{PROTO_CSS}</style>

      <div className="max-w-7xl mx-auto px-6 pt-6">

        {/* ── Header: identity + live clock ── */}
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2">
              <StickyNote className="w-5 h-5 text-amber-500" />
              <h1 className="text-xl font-black text-white tracking-tight">Scratchpad</h1>
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-black uppercase tracking-widest">Cockpit prototype · mock data</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">Write → submit → it comes back organized → flip to verify → it reminds you. Press <kbd className="px-1 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-[10px]">/</kbd> to jump to the console.</p>
          </div>
          <div className="text-right">
            <div className="font-mono text-3xl font-black text-white tabular-nums leading-none">
              {hh}:{mm}<span className="text-slate-600">:{ss}</span>
            </div>
            <div className="text-[10px] font-black tracking-[0.25em] text-slate-500 mt-1">{dateLabel}</div>
          </div>
        </div>

        {/* ── Status strip ── */}
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <StatusChip icon={Flame} label="overdue" value={buckets.overdue.length} tone="rose" />
          <StatusChip icon={Sun} label="today" value={buckets.today.length} tone="amber" />
          <StatusChip icon={CalendarDays} label="this week" value={buckets.week.length} tone="blue" />
          <StatusChip icon={BadgeCheck} label="done this week" value={doneThisWeek} tone="emerald" />
          <div className="ml-auto">
            <AiHud online={aiOnline} latency={latency} onToggle={() => setAiOnline((v) => !v)} />
          </div>
        </div>

        {/* ── Console bar ── */}
        <div className={`mt-4 rounded-2xl border bg-slate-900/80 backdrop-blur transition-colors ${organizing ? "border-amber-500/50" : "border-slate-800 focus-within:border-amber-500/40"}`}>
          <div className="flex items-start gap-3 px-4 py-3">
            <span className={`mt-1 text-amber-400 font-black select-none ${consoleText ? "" : "proto-blink"}`}>✦</span>
            <textarea
              ref={consoleRef}
              value={consoleText}
              onChange={(e) => setConsoleText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitConsole(); }
              }}
              rows={consoleText.includes("\n") ? 3 : 1}
              placeholder="jot a task, paste a mess, or ask a question…   (Enter files it · Shift+Enter for a new line)"
              className="flex-1 bg-transparent resize-none outline-none text-sm text-slate-100 placeholder:text-slate-600 font-mono caret-amber-400"
            />
            {wantsOrganize && (
              <button
                onClick={runOrganize}
                disabled={organizing}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500 text-slate-950 text-xs font-black hover:bg-amber-400 disabled:opacity-70 proto-flipin"
              >
                {organizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {organizing ? "Organizing…" : "Organize"}
              </button>
            )}
            {!wantsOrganize && isQuestion && consoleText.trim() && (
              <span className="shrink-0 mt-1 text-[10px] font-black uppercase tracking-widest text-cyan-400 proto-flipin">↵ ask</span>
            )}
          </div>
          <div className="px-4 pb-2 flex items-center gap-3 text-[10px] text-slate-600 font-bold">
            <span>try:</span>
            <button onClick={() => setConsoleText("- [ ] grease P-101A bearings every monday")} className="hover:text-slate-400 font-mono">recurring task</button>
            <span className="text-slate-800">·</span>
            <button onClick={() => setConsoleText("who has E-204?")} className="hover:text-slate-400 font-mono">who has E-204?</button>
            <span className="text-slate-800">·</span>
            <button onClick={() => setConsoleText("got pulled into the E-204 job today. flange bolts were undertorqued, need to call joe about the torque spec before friday. also order new stud bolts and dont forget the insulation crew needs the all-clear by monday. dana mentioned MOC-2024-051 might cover this scope already, verify that")} className="hover:text-slate-400 font-mono">paste a mess → ✦</button>
          </div>
        </div>

        {/* ── Answer card ── */}
        {answer && (
          <div className="mt-3 rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 to-slate-900 p-4 proto-flipin">
            <div className="flex items-start gap-3">
              <Zap className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-black text-cyan-300 uppercase tracking-widest" dangerouslySetInnerHTML={{ __html: answer.q }} />
                <div className="mt-1.5 space-y-1">
                  {answer.lines.map((l, i) => (
                    <div key={i} className={i === 0 ? "text-sm font-bold text-white" : "text-xs text-slate-400"}>{l}</div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {answer.chips.map((c, i) => <Chip key={i} chip={c} dark />)}
                </div>
                <div className="mt-2 text-[10px] text-slate-600 italic">Demo data — the build wires this to your live engines.</div>
              </div>
              <button onClick={() => setAnswer(null)} className="text-slate-600 hover:text-slate-400"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        {/* ── Welcome-back nudge ── */}
        {nudgeOpen && nudgeItems.length > 0 && (
          <div className="mt-3 rounded-2xl border border-sky-500/25 bg-gradient-to-r from-sky-500/10 via-slate-900 to-slate-900 p-4 proto-flipin">
            <div className="flex items-start gap-3">
              <Bell className="w-4 h-4 text-sky-300 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-white">Welcome back — {nudgeItems.length} dateless note{nudgeItems.length === 1 ? "" : "s"} gathering dust. Still matter?</div>
                <div className="text-[11px] text-slate-500 mt-0.5">No due date needed — these resurface every login, and after the page sits open a few hours.</div>
                <div className="mt-2.5 space-y-1.5">
                  {nudgeItems.map((t) => (
                    <div key={t.id} className="flex items-center gap-2 text-xs">
                      <span className={`w-1.5 h-1.5 rounded-full ${TOPIC_TONES[t.topic] ?? "bg-slate-500"}`} />
                      <span className="text-slate-300 flex-1 truncate">{t.text}</span>
                      <button onClick={() => setNudgeDismissed((s) => new Set(s).add(t.id))} className="px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-slate-300">Still matters</button>
                      <button onClick={() => snoozeTask(t, "Monday")} className="px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-slate-300">Mon</button>
                      <button onClick={() => checkTask(t)} className="px-2 py-0.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-[10px] font-bold text-emerald-300">Done</button>
                    </div>
                  ))}
                </div>
              </div>
              <button onClick={() => setNudgeOpen(false)} className="text-slate-600 hover:text-slate-400"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        {/* ── Main grid ── */}
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* LEFT 2/3 — flip cards + board */}
          <div className="lg:col-span-2 space-y-4">
            {notes.map((n) => (
              <FlipCard
                key={n.id}
                note={n}
                onFlip={() => setNotes((ns) => ns.map((x) => x.id === n.id ? { ...x, flipped: !x.flipped } : x))}
                onToggleDiff={() => setNotes((ns) => ns.map((x) => x.id === n.id ? { ...x, showDiff: !x.showDiff } : x))}
                onCheckTask={(ti) => {
                  setNotes((ns) => ns.map((x) => x.id === n.id
                    ? { ...x, tasks: x.tasks.map((t, i) => i === ti ? { ...t, leaving: true } : t) }
                    : x));
                  setTimeout(() => {
                    setNotes((ns) => ns.map((x) => x.id === n.id
                      ? { ...x, tasks: x.tasks.map((t, i) => i === ti ? { ...t, done: true, leaving: false } : t) }
                      : x));
                    setDoneThisWeek((c) => c + 1);
                    toast("Done — logged");
                  }, 420);
                }}
              />
            ))}

            {/* Board header */}
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
                <BoardSection title="Overdue" tone="rose" icon={Flame} count={buckets.overdue.length}>
                  {buckets.overdue.map((t) => (
                    <TaskCard key={t.id} task={t} escalated={(t.daysOverdue ?? 0) >= 7}
                      snoozeOpen={snoozeMenuFor === t.id}
                      onCheck={() => checkTask(t)} onKill={() => killTask(t)} onNudge={() => nudgePerson(t)}
                      onSnoozeMenu={() => setSnoozeMenuFor(snoozeMenuFor === t.id ? null : t.id)}
                      onSnooze={(w) => snoozeTask(t, w)} />
                  ))}
                  {buckets.overdue.length === 0 && <EmptyRow text="Nothing overdue. Savor it." />}
                </BoardSection>
                <BoardSection title="Today" tone="amber" icon={Sun} count={buckets.today.length}>
                  {buckets.today.map((t) => (
                    <TaskCard key={t.id} task={t}
                      snoozeOpen={snoozeMenuFor === t.id}
                      onCheck={() => checkTask(t)} onKill={() => killTask(t)} onNudge={() => nudgePerson(t)}
                      onSnoozeMenu={() => setSnoozeMenuFor(snoozeMenuFor === t.id ? null : t.id)}
                      onSnooze={(w) => snoozeTask(t, w)} />
                  ))}
                  {buckets.today.length === 0 && <EmptyRow text="Clear. The board rolls unfinished work forward at midnight — visibly." />}
                </BoardSection>
                <BoardSection title="This week" tone="blue" icon={CalendarDays} count={buckets.week.length}>
                  {buckets.week.map((t) => (
                    <TaskCard key={t.id} task={t}
                      snoozeOpen={snoozeMenuFor === t.id}
                      onCheck={() => checkTask(t)} onKill={() => killTask(t)} onNudge={() => nudgePerson(t)}
                      onSnoozeMenu={() => setSnoozeMenuFor(snoozeMenuFor === t.id ? null : t.id)}
                      onSnooze={(w) => snoozeTask(t, w)} />
                  ))}
                </BoardSection>
                <BoardSection title="No date" tone="slate" icon={CircleSlash} count={buckets.nodate.length} subtitle="kept alive by the login nudge">
                  {buckets.nodate.map((t) => (
                    <TaskCard key={t.id} task={t}
                      snoozeOpen={snoozeMenuFor === t.id}
                      onCheck={() => checkTask(t)} onKill={() => killTask(t)} onNudge={() => nudgePerson(t)}
                      onSnoozeMenu={() => setSnoozeMenuFor(snoozeMenuFor === t.id ? null : t.id)}
                      onSnooze={(w) => snoozeTask(t, w)} />
                  ))}
                </BoardSection>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {topics.map(([topic, ts]) => (
                  <div key={topic} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3 proto-flipin">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full ${TOPIC_TONES[topic] ?? "bg-slate-500"}`} />
                      <span className="text-xs font-black text-white">{topic}</span>
                      <span className="text-[10px] font-bold text-slate-500">{ts.length}</span>
                      {topic !== "General" && topic !== "Paperwork" && (
                        <span className="ml-auto text-[9px] font-black uppercase tracking-widest text-slate-600">walking there? start here</span>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {ts.map((t) => (
                        <TaskCard key={t.id} task={t} compact
                          snoozeOpen={snoozeMenuFor === t.id}
                          onCheck={() => checkTask(t)} onKill={() => killTask(t)} onNudge={() => nudgePerson(t)}
                          onSnoozeMenu={() => setSnoozeMenuFor(snoozeMenuFor === t.id ? null : t.id)}
                          onSnooze={(w) => snoozeTask(t, w)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* RIGHT 1/3 — digest + flight log */}
          <div className="space-y-4">
            <DigestCard overdue={buckets.overdue.length} today={buckets.today.length} carried={carriedOver} oldest={buckets.overdue[0]?.dueLabel ?? "—"} />
            <FlightLog log={log} doneThisWeek={doneThisWeek} carried={carriedOver} onExport={() => toast("Weekly report copied (demo)")} />
            <div className="rounded-2xl border border-dashed border-slate-800 p-4 text-[11px] text-slate-600 leading-relaxed">
              <span className="font-black text-slate-500 uppercase tracking-widest text-[9px]">In the build</span><br />
              This whole right rail also mirrors into Home/Inbox — integrated, not moved. Chips resolve to live records. Reminders fire as real bell notifications.
            </div>
          </div>
        </div>
      </div>

      {/* ── Receipt bar ── */}
      {receiptFor && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 w-[min(560px,92vw)] rounded-2xl border border-emerald-500/30 bg-slate-900/95 backdrop-blur shadow-2xl shadow-emerald-500/10 p-3 proto-flipin">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <Check className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold text-white truncate">Done: {receiptFor.text}</div>
              <div className="text-[10px] text-slate-500">One-line outcome? Feeds your weekly report.</div>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              autoFocus
              value={outcomeText}
              onChange={(e) => setOutcomeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") logReceipt(receiptFor, outcomeText); }}
              placeholder="e.g. spec confirmed w/ Joe — 85 ft-lb"
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 outline-none focus:border-emerald-500/50 placeholder:text-slate-600"
            />
            <button onClick={() => logReceipt(receiptFor, outcomeText)} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 text-xs font-black hover:bg-emerald-400">Log</button>
            <button onClick={() => logReceipt(receiptFor, "")} className="px-2 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:text-slate-300">Skip</button>
          </div>
        </div>
      )}

      {/* ── Toasts ── */}
      <div className="fixed bottom-5 right-5 z-50 space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="px-3.5 py-2 rounded-xl bg-slate-800/95 border border-slate-700 text-xs font-bold text-slate-200 shadow-xl proto-flipin" dangerouslySetInnerHTML={{ __html: t.msg }} />
        ))}
      </div>

      {/* ── Demo controls ── */}
      <div className="fixed bottom-5 left-5 z-40">
        {demoOpen && (
          <div className="mb-2 rounded-2xl border border-slate-700 bg-slate-900/95 backdrop-blur p-2 space-y-1 proto-flipin w-60">
            <div className="px-2 pt-1 pb-1.5 text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Prototype-only controls</div>
            <DemoBtn icon={AlarmClock} label="Simulate end of day" sub="watch Today roll into Overdue" onClick={demoRollover} />
            <DemoBtn icon={Bell} label="Replay login nudge" sub="dateless notes resurface" onClick={demoNudge} />
            <DemoBtn icon={Zap} label={aiOnline ? "Take AI offline" : "Bring AI online"} sub="falls back to local rules" onClick={demoAiToggle} />
          </div>
        )}
        <button onClick={() => setDemoOpen((v) => !v)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-200 hover:border-slate-600 shadow-lg">
          <Settings2 className="w-3.5 h-3.5" /> demo
        </button>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatusChip({ icon: Icon, label, value, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; tone: "rose" | "amber" | "blue" | "emerald" }) {
  const tones: Record<string, string> = {
    rose: value > 0 ? "border-rose-500/40 bg-rose-500/10 text-rose-300" : "border-slate-800 bg-slate-900 text-slate-500",
    amber: value > 0 ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-slate-800 bg-slate-900 text-slate-500",
    blue: "border-slate-800 bg-slate-900 text-slate-400",
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

function AiHud({ online, latency, onToggle }: { online: boolean; latency: number; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={online ? "Live health check — click to simulate outage" : "Local rules engine — nothing leaves the browser. Click to restore."}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-[11px] font-black transition-colors ${
        online ? "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-300 hover:bg-emerald-500/15" : "border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800"
      }`}
    >
      {online ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
          </span>
          ✦ ONLINE <span className="font-mono font-bold text-emerald-400/70 tabular-nums">{latency}ms</span>
        </>
      ) : (
        <>
          <span className="inline-flex rounded-full h-2 w-2 bg-slate-500" />
          LOCAL <span className="font-bold text-slate-500">rules only · zero egress</span>
        </>
      )}
    </button>
  );
}

const CHIP_STYLE: Record<ProtoChip["kind"], { icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  equipment: { icon: KeyRound, cls: "bg-purple-500/10 text-purple-300 border-purple-500/30" },
  moc: { icon: FileText, cls: "bg-blue-500/10 text-blue-300 border-blue-500/30" },
  person: { icon: AtSign, cls: "bg-slate-500/10 text-slate-300 border-slate-600" },
  deadline: { icon: CalendarDays, cls: "bg-amber-500/10 text-amber-300 border-amber-500/30" },
  document: { icon: FileText, cls: "bg-indigo-500/10 text-indigo-300 border-indigo-500/30" },
};

function Chip({ chip }: { chip: ProtoChip; dark?: boolean }) {
  const cfg = CHIP_STYLE[chip.kind];
  const Icon = cfg.icon;
  return (
    <span className="relative group/chip">
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black border cursor-default ${cfg.cls}`}>
        <Icon className="w-2.5 h-2.5" /> {chip.text}
      </span>
      {chip.hover && (
        <span className="pointer-events-none absolute left-0 -top-8 z-30 hidden group-hover/chip:block whitespace-nowrap px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[10px] font-bold text-slate-200 shadow-xl">
          {chip.hover}
        </span>
      )}
    </span>
  );
}

function FlipCard({
  note, onFlip, onToggleDiff, onCheckTask,
}: {
  note: OrganizedNote;
  onFlip: () => void;
  onToggleDiff: () => void;
  onCheckTask: (taskIndex: number) => void;
}) {
  return (
    <div className={`proto-scene ${note.justIn ? "proto-flipin" : ""}`}>
      <div className={`proto-card ${note.flipped ? "proto-flipped" : ""}`}>

        {/* FRONT — the organized version */}
        <div className="proto-face rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.07] via-slate-900 to-slate-900 p-4 shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <Sparkles className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-black text-white">{note.title}</div>
              <div className="text-[10px] text-slate-500 font-bold">{note.when} · {note.tasks.length} tasks extracted · {note.findings.length} findings</div>
            </div>
            <button onClick={onFlip} className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-700 bg-slate-800/80 text-[10px] font-black text-slate-300 hover:text-white hover:border-amber-500/40" title="Flip to your exact original words">
              <RotateCcw className="w-3 h-3" /> what I wrote
            </button>
          </div>

          {note.findings.length > 0 && (
            <div className="mt-3">
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500 mb-1">Findings</div>
              <ul className="space-y-0.5">
                {note.findings.map((f, i) => (
                  <li key={i} className="text-xs text-slate-300 flex items-start gap-1.5">
                    <span className="text-slate-600 mt-0.5">▸</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {note.tasks.length > 0 && (
            <div className="mt-3">
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500 mb-1">Extracted tasks</div>
              <ul className="space-y-1">
                {note.tasks.map((t, i) => (
                  <li key={i} className={`flex items-center gap-2 text-xs ${t.leaving ? "proto-dissolve" : ""} ${t.done ? "opacity-40" : ""}`}>
                    <button
                      onClick={() => !t.done && onCheckTask(i)}
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${t.done ? "bg-emerald-500 border-emerald-500" : "border-slate-600 hover:border-amber-400"}`}
                    >
                      {t.done && <Check className="w-2.5 h-2.5 text-slate-950" />}
                    </button>
                    <span className={`flex-1 ${t.done ? "line-through text-slate-500" : "text-slate-200"}`}>{t.text}</span>
                    {t.due && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[9px] font-black uppercase">{t.due}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {note.chips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {note.chips.map((c, i) => <Chip key={i} chip={c} />)}
            </div>
          )}
        </div>

        {/* BACK — verbatim raw + diff highlights */}
        <div className="proto-face proto-back rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <FileText className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-black text-white">Your exact words</div>
              <div className="text-[10px] text-slate-500 font-bold">verbatim — nothing edited, nothing lost</div>
            </div>
            <button onClick={onToggleDiff} className={`shrink-0 px-2 py-1 rounded-lg border text-[10px] font-black ${note.showDiff ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-slate-700 bg-slate-800 text-slate-400"}`}>
              {note.showDiff ? "hiding nothing" : "show what became tasks"}
            </button>
            <button onClick={onFlip} className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-700 bg-slate-800/80 text-[10px] font-black text-slate-300 hover:text-white">
              <Sparkles className="w-3 h-3 text-amber-400" /> organized
            </button>
          </div>
          <div className="mt-3 rounded-xl bg-slate-950 border border-slate-800 p-3 font-mono text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
            <RawWithHighlights raw={note.raw} highlights={note.showDiff ? note.rawHighlights : []} />
          </div>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-600 font-bold">
            {note.showDiff && <span><mark className="bg-amber-500/20 text-amber-300 px-1 rounded">highlighted</mark> = what the organizer turned into tasks</span>}
            <span className="ml-auto inline-flex items-center gap-1">spot a mistake? <button className="text-amber-400 hover:text-amber-300 font-black">re-organize</button> · <button className="text-slate-400 hover:text-slate-300 font-black">edit raw</button></span>
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

function BoardSection({
  title, tone, icon: Icon, count, subtitle, children,
}: {
  title: string; tone: "rose" | "amber" | "blue" | "slate";
  icon: React.ComponentType<{ className?: string }>;
  count: number; subtitle?: string; children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    rose: "text-rose-400 border-l-rose-500/60",
    amber: "text-amber-400 border-l-amber-500/60",
    blue: "text-blue-400 border-l-blue-500/50",
    slate: "text-slate-500 border-l-slate-700",
  };
  return (
    <div className={`rounded-2xl border border-slate-800 border-l-4 ${tones[tone].split(" ")[1]} bg-slate-900/60 p-3`}>
      <div className="flex items-baseline gap-2 mb-2">
        <Icon className={`w-3.5 h-3.5 self-center ${tones[tone].split(" ")[0]}`} />
        <span className="text-[11px] font-black uppercase tracking-widest text-slate-300">{title}</span>
        <span className="text-[10px] font-bold text-slate-600 tabular-nums">{count}</span>
        {subtitle && <span className="ml-auto text-[9px] text-slate-600 font-bold">{subtitle}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function TaskCard({
  task, escalated, compact, snoozeOpen, onCheck, onKill, onNudge, onSnoozeMenu, onSnooze,
}: {
  task: ProtoTask; escalated?: boolean; compact?: boolean; snoozeOpen: boolean;
  onCheck: () => void; onKill: () => void; onNudge: () => void;
  onSnoozeMenu: () => void; onSnooze: (when: "tomorrow" | "next shift" | "Monday") => void;
}) {
  const leavingCls = task.leaving === "dissolve" ? "proto-dissolve" : task.leaving === "peel" ? "proto-peel" : task.leaving === "slide" ? "proto-slide" : "";
  const heat = task.bucket === "overdue"
    ? (task.daysOverdue ?? 0) >= 7
      ? "border-rose-500/60 bg-rose-500/[0.10] proto-breathe"
      : (task.daysOverdue ?? 0) >= 3
        ? "border-rose-500/40 bg-rose-500/[0.07] proto-breathe"
        : "border-rose-500/25 bg-rose-500/[0.04]"
    : task.bucket === "today"
      ? "border-amber-500/25 bg-amber-500/[0.04]"
      : "border-slate-800 bg-slate-900/40";

  if (escalated) {
    return (
      <div className={`relative rounded-xl border ${heat} p-3 ${leavingCls}`}>
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-rose-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-white">{task.text}</div>
            <div className="text-[10px] font-black uppercase tracking-widest text-rose-400 mt-0.5">{task.dueLabel} — do it, snooze it, or kill it</div>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <button onClick={onCheck} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-500 text-slate-950 text-[11px] font-black hover:bg-emerald-400"><Check className="w-3 h-3" /> Do it now</button>
          <div className="relative flex-1">
            <button onClick={onSnoozeMenu} className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-black text-slate-300 hover:bg-slate-700"><AlarmClock className="w-3 h-3" /> Snooze <ChevronDown className="w-3 h-3" /></button>
            {snoozeOpen && <SnoozeMenu onSnooze={onSnooze} />}
          </div>
          <button onClick={onKill} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-black text-slate-400 hover:text-rose-300 hover:border-rose-500/40"><Trash2 className="w-3 h-3" /> Kill</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`group relative flex items-center gap-2.5 rounded-xl border ${heat} px-3 ${compact ? "py-1.5" : "py-2"} ${leavingCls}`}>
      <button onClick={onCheck} className="w-4 h-4 rounded border border-slate-600 hover:border-emerald-400 hover:bg-emerald-500/10 shrink-0 transition-colors" title="Done (asks for a one-line outcome)" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold text-slate-200 truncate">{task.text}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-slate-500`}>
            <span className={`w-1.5 h-1.5 rounded-full ${TOPIC_TONES[task.topic] ?? "bg-slate-500"}`} /> {task.topic}
          </span>
          {task.recurring && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 text-[9px] font-black"><Repeat className="w-2.5 h-2.5" /> {task.recurring}</span>
          )}
          {(task.snoozes ?? 0) >= 3 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[9px] font-black"><AlarmClock className="w-2.5 h-2.5" /> snoozed {task.snoozes}× — still real?</span>
          )}
        </div>
      </div>
      {task.dueLabel && (
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wide ${
          task.bucket === "overdue" ? "bg-rose-500/15 text-rose-300 border border-rose-500/30"
          : task.bucket === "today" ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
          : "bg-blue-500/10 text-blue-300 border border-blue-500/25"
        }`}>{task.dueLabel}</span>
      )}
      <div className="shrink-0 hidden group-hover:flex items-center gap-1">
        <div className="relative">
          <button onClick={onSnoozeMenu} className="p-1 rounded-md hover:bg-slate-700 text-slate-500 hover:text-slate-200" title="Snooze"><AlarmClock className="w-3.5 h-3.5" /></button>
          {snoozeOpen && <SnoozeMenu onSnooze={onSnooze} />}
        </div>
        <button onClick={onNudge} className="p-1 rounded-md hover:bg-slate-700 text-slate-500 hover:text-slate-200" title="Nudge a person (demo)"><Send className="w-3.5 h-3.5" /></button>
        <button onClick={onKill} className="p-1 rounded-md hover:bg-slate-700 text-slate-500 hover:text-rose-300" title="Kill"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}

function SnoozeMenu({ onSnooze }: { onSnooze: (when: "tomorrow" | "next shift" | "Monday") => void }) {
  return (
    <div className="absolute right-0 top-full mt-1 z-30 w-32 rounded-xl border border-slate-700 bg-slate-800 shadow-2xl p-1 proto-flipin">
      {(["tomorrow", "next shift", "Monday"] as const).map((w) => (
        <button key={w} onClick={() => onSnooze(w)} className="w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white capitalize">
          {w}
        </button>
      ))}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="text-[11px] text-slate-600 italic px-1 py-0.5">{text}</div>;
}

function DigestCard({ overdue, today, carried, oldest }: { overdue: number; today: number; carried: number; oldest: string }) {
  return (
    <div className="rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/[0.08] via-slate-900 to-slate-900 p-4">
      <div className="flex items-center gap-2">
        <Bell className="w-4 h-4 text-violet-300" />
        <span className="text-xs font-black uppercase tracking-widest text-white">06:00 digest</span>
        <span className="px-1.5 py-0.5 rounded bg-violet-500/15 border border-violet-500/30 text-violet-300 text-[9px] font-black uppercase">preview</span>
        <button className="ml-auto text-[10px] font-black text-slate-500 hover:text-slate-300 inline-flex items-center gap-0.5">set time <ChevronDown className="w-3 h-3" /></button>
      </div>
      <div className="mt-3 space-y-1.5 text-xs">
        <div className="flex items-center gap-2 text-rose-300 font-bold"><Flame className="w-3.5 h-3.5" /> {overdue} overdue — oldest {oldest}</div>
        <div className="flex items-center gap-2 text-amber-300 font-bold"><Sun className="w-3.5 h-3.5" /> {today} due today · 1 recurring</div>
        <div className="flex items-center gap-2 text-slate-400 font-bold"><RefreshCw className="w-3.5 h-3.5" /> {carried} carried over from yesterday</div>
        <div className="flex items-center gap-2 text-slate-400 font-bold"><AlertTriangle className="w-3.5 h-3.5 text-purple-300" /> 1 new thing touches <span className="text-purple-300">E-204</span></div>
      </div>
      <div className="mt-3 text-[10px] text-slate-600 leading-relaxed">One composed bell ping at login — your whole day in a single organized reminder, dates or no dates.</div>
    </div>
  );
}

function FlightLog({ log, doneThisWeek, carried, onExport }: { log: LogEntry[]; doneThisWeek: number; carried: number; onExport: () => void }) {
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
          <span className="text-2xl font-black text-white tabular-nums">{doneThisWeek}</span>
          <span className="text-[11px] font-bold text-slate-400">done · {carried} carried over · top topic <span className="text-purple-300 font-black">E-204</span></span>
        </div>
        <button onClick={onExport} className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[10px] font-black text-slate-300 hover:text-white hover:border-emerald-500/40">
          <ArrowRight className="w-3 h-3" /> Export weekly report
        </button>
      </div>

      <div className="mt-3 space-y-2">
        {log.slice(0, 6).map((e) => (
          <div key={e.id} className="flex items-start gap-2 text-xs">
            <Check className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-slate-300 font-bold truncate">{e.text}</div>
              {e.outcome !== "—" && <div className="text-[10px] text-slate-500 italic truncate">“{e.outcome}”</div>}
            </div>
            <span className="text-[9px] font-bold text-slate-600 shrink-0 mt-0.5">{e.when}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[10px] text-slate-600">Daily · weekly · monthly rollups — proof of where the time went, and what carries over.</div>
    </div>
  );
}

function DemoBtn({ icon: Icon, label, sub, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-xl hover:bg-slate-800 text-left">
      <Icon className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-xs font-black text-slate-200">{label}</span>
        <span className="block text-[10px] text-slate-500">{sub}</span>
      </span>
    </button>
  );
}

// ─── Prototype CSS — flips, dissolves, peels, breathing ─────────────────────

const PROTO_CSS = `
.proto-scene { perspective: 1400px; }
.proto-card { display: grid; transform-style: preserve-3d; transition: transform .7s cubic-bezier(.25,.8,.25,1.08); }
.proto-card.proto-flipped { transform: rotateY(180deg); }
.proto-face { grid-area: 1 / 1; backface-visibility: hidden; -webkit-backface-visibility: hidden; min-width: 0; }
.proto-back { transform: rotateY(180deg); }

@keyframes proto-breathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(244,63,94,0); }
  50%      { box-shadow: 0 0 18px 1px rgba(244,63,94,.16); }
}
.proto-breathe { animation: proto-breathe 2.8s ease-in-out infinite; }

@keyframes proto-dissolve-kf { to { opacity: 0; transform: scale(.96) translateY(-4px); } }
.proto-dissolve { animation: proto-dissolve-kf .42s ease-in forwards; }

@keyframes proto-peel-kf { to { opacity: 0; transform: translateX(56px) rotate(3deg); } }
.proto-peel { animation: proto-peel-kf .38s ease-in forwards; }

@keyframes proto-slide-kf {
  0%   { opacity: 1; transform: translateY(0); }
  60%  { opacity: .25; transform: translateY(14px); }
  100% { opacity: 0; transform: translateY(22px); }
}
.proto-slide { animation: proto-slide-kf .52s ease-in-out forwards; }

@keyframes proto-flipin-kf { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
.proto-flipin { animation: proto-flipin-kf .34s cubic-bezier(.2,.8,.3,1.1); }

@keyframes proto-blink-kf { 0%, 55% { opacity: 1; } 56%, 100% { opacity: .15; } }
.proto-blink { animation: proto-blink-kf 1.1s step-end infinite; }
`;
