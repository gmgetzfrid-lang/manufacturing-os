// lib/notes.ts
//
// Phase 9 — Scratchpad / Operational Memory data layer.
//
// One table, one shape, free-text body with markdown-checkbox task
// syntax. Notes can attach to a document, a project, or an asset
// (or stand alone at the org level). Tasks are extracted from the
// body at read time so we never have to fight a denormalization
// trigger; toggling a task rewrites the markdown in the body.
//
// Per the directive: this layer does NOT depend on any AI provider.
// AI helpers live in lib/ai and call into this lib (read body,
// produce suggestions); they never write here on behalf of a user.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";

export interface Note {
  id: string;
  orgId: string;
  body: string;
  /** Verbatim original capture before organizeCapture() restructured it.
   *  NULL for notes typed directly. Powers flip-to-verify. Requires
   *  migration 20260730_scratchpad_cockpit.sql; null when absent. */
  rawBody: string | null;
  /** Per-task metadata keyed by taskKeyFor(): { [key]: { snoozes } }.
   *  Empty object when the column doesn't exist yet. */
  taskMeta: Record<string, TaskMeta>;
  documentId: string | null;
  projectId: string | null;
  assetId: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface TaskMeta {
  snoozes?: number;
}

/** Parsed task line from a note body. `lineIndex` is the 0-based
 *  line in the original body; mutating completion edits that line. */
export interface NoteTask {
  noteId: string;
  /** 0-based index into the body's split('\n') array. */
  lineIndex: number;
  body: string;
  completed: boolean;
  /** ISO date (YYYY-MM-DD) parsed from the body if a due hint was
   *  present. Supports `@2026-06-15`, `@06-15`, `due 2026-06-15`,
   *  `due tomorrow`, `due friday`, `by next week`, etc. */
  dueAt: string | null;
  /** The exact span that produced dueAt — useful for highlighting in
   *  the UI ("due friday" vs the rest of the line). */
  dueText: string | null;
  /** ISO date the task was completed, parsed from a trailing
   *  `✓YYYY-MM-DD` marker written by completeTaskInBody. */
  doneAt: string | null;
  /** One-line outcome recorded at completion (`✓date: outcome`). */
  outcome: string | null;
  /** Recurrence word parsed from `every monday|day|shift|week|month`.
   *  Completing a recurring task rolls its due date forward instead
   *  of checking it off. */
  recurring: string | null;
}

export type TaskBucket = "overdue" | "today" | "soon" | "later" | "no-date";

interface NoteRow {
  id: string;
  org_id: string;
  body: string;
  /** Optional — only present once 20260730_scratchpad_cockpit.sql ran. */
  raw_body?: string | null;
  task_meta?: Record<string, TaskMeta> | null;
  document_id: string | null;
  project_id: string | null;
  asset_id: string | null;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  created_by: string;
  created_by_name: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

function rowToNote(r: NoteRow): Note {
  return {
    id: r.id, orgId: r.org_id, body: r.body,
    rawBody: r.raw_body ?? null,
    taskMeta: r.task_meta ?? {},
    documentId: r.document_id, projectId: r.project_id, assetId: r.asset_id,
    resolved: r.resolved, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
    createdAt: r.created_at, createdBy: r.created_by, createdByName: r.created_by_name,
    updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}

// ─── Task extraction ────────────────────────────────────────────
//
// Markdown checkbox syntax:
//   - [ ] open task
//   - [x] done task
//   * [ ] (asterisk bullets also accepted)
// Indentation is preserved.

const CHECKBOX_RE = /^(\s*[-*]\s*)\[( |x|X)\]\s*(.*)$/;

// Patterns. Order matters — most specific first.
// 1. @YYYY-MM-DD or due YYYY-MM-DD or by YYYY-MM-DD
const DUE_ISO_RE = /(?:@|\bdue\s+|\bby\s+)(\d{4}-\d{2}-\d{2})\b/i;
// 2. @MM-DD or @MM/DD (current year assumed)
const DUE_SHORT_RE = /@(\d{1,2})[\/-](\d{1,2})\b/;
// 3. due today / tomorrow / monday / next week …
const DUE_WORDS_RE = /\b(?:due|by)\s+(today|tomorrow|next\s+week|this\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

// 4. Completion marker written by completeTaskInBody:  ✓2026-06-12: outcome
const DONE_RE = /\s*✓\s*(\d{4}-\d{2}-\d{2})(?::\s*(.+))?\s*$/;
// 5. Recurrence:  every monday | every day | every shift | every week | every month
const RECUR_RE = /\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|shift|week|month)\b/i;

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function relativeWordToDate(word: string, now: Date = new Date()): string | null {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (w === "today") return ymd(now);
  if (w === "tomorrow") {
    const d = new Date(now); d.setDate(d.getDate() + 1); return ymd(d);
  }
  if (w === "next week") {
    const d = new Date(now); d.setDate(d.getDate() + 7); return ymd(d);
  }
  if (w === "this week") {
    // End of this week = upcoming friday (or today if today IS friday-or-later)
    const d = new Date(now);
    const target = 5 - d.getDay();
    if (target >= 0) d.setDate(d.getDate() + target);
    return ymd(d);
  }
  const idx = DAY_NAMES.indexOf(w);
  if (idx === -1) return null;
  const d = new Date(now);
  let diff = idx - d.getDay();
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return ymd(d);
}

export function parseDueFromTaskBody(text: string, now: Date = new Date()): { dueAt: string | null; dueText: string | null } {
  let m = text.match(DUE_ISO_RE);
  if (m) return { dueAt: m[1], dueText: m[0] };
  m = text.match(DUE_SHORT_RE);
  if (m) {
    const mo = m[1].padStart(2, "0");
    const day = m[2].padStart(2, "0");
    return { dueAt: `${now.getFullYear()}-${mo}-${day}`, dueText: m[0] };
  }
  m = text.match(DUE_WORDS_RE);
  if (m) {
    const dueAt = relativeWordToDate(m[1], now);
    return { dueAt, dueText: m[0] };
  }
  return { dueAt: null, dueText: null };
}

export function extractTasks(note: Pick<Note, "id" | "body">, now: Date = new Date()): NoteTask[] {
  const lines = note.body.split("\n");
  const tasks: NoteTask[] = [];
  lines.forEach((line, idx) => {
    const m = line.match(CHECKBOX_RE);
    if (m) {
      let body = m[3].trim();
      // Strip + capture the completion marker before due parsing so a
      // `✓2026-06-12` suffix never reads as a due date.
      let doneAt: string | null = null;
      let outcome: string | null = null;
      const dm = body.match(DONE_RE);
      if (dm) {
        doneAt = dm[1];
        outcome = dm[2]?.trim() || null;
        body = body.slice(0, dm.index).trim();
      }
      const { dueAt, dueText } = parseDueFromTaskBody(body, now);
      const recurring = body.match(RECUR_RE)?.[1]?.toLowerCase() ?? null;
      tasks.push({
        noteId: note.id,
        lineIndex: idx,
        body,
        completed: m[2] === "x" || m[2] === "X",
        dueAt,
        dueText,
        doneAt,
        outcome,
        recurring,
      });
    }
  });
  return tasks;
}

export function bucketForTask(task: NoteTask, now: Date = new Date()): TaskBucket {
  if (!task.dueAt) return "no-date";
  const today = ymd(now);
  if (task.dueAt < today) return "overdue";
  if (task.dueAt === today) return "today";
  const week = new Date(now); week.setDate(week.getDate() + 7);
  if (task.dueAt <= ymd(week)) return "soon";
  return "later";
}

/** Toggle the checkbox at the given line index. Returns a new body
 *  string; caller is responsible for persisting. */
export function toggleTaskInBody(body: string, lineIndex: number): string {
  const lines = body.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  const m = lines[lineIndex].match(CHECKBOX_RE);
  if (!m) return body;
  const isDone = m[2] === "x" || m[2] === "X";
  lines[lineIndex] = `${m[1]}[${isDone ? " " : "x"}] ${m[3]}`;
  return lines.join("\n");
}

// ─── Cockpit mutations ──────────────────────────────────────────
//
// All pure body→body rewrites. The cockpit UI calls these then
// persists via updateNoteBody — same write path as toggleTaskInBody,
// so RLS, audit, and the existing brief/parser all keep working.

/** Stable identity for a task across snoozes/edits of its date —
 *  the task text with due tokens + completion marker stripped,
 *  lowercased and whitespace-collapsed. Keys notes.task_meta. */
export function taskKeyFor(taskBody: string): string {
  return taskBody
    .replace(DONE_RE, "")
    .replace(DUE_ISO_RE, "")
    .replace(DUE_SHORT_RE, "")
    .replace(DUE_WORDS_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Next occurrence for a recurrence word, strictly after `from`. */
export function nextOccurrence(recurring: string, from: Date = new Date()): string {
  const r = recurring.toLowerCase();
  const d = new Date(from);
  if (r === "day" || r === "shift") { d.setDate(d.getDate() + 1); return ymd(d); }
  if (r === "week") { d.setDate(d.getDate() + 7); return ymd(d); }
  if (r === "month") { d.setMonth(d.getMonth() + 1); return ymd(d); }
  const idx = DAY_NAMES.indexOf(r);
  if (idx === -1) { d.setDate(d.getDate() + 7); return ymd(d); }
  let diff = idx - d.getDay();
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return ymd(d);
}

/** Replace the line's due token with `@toIso` (or append one). */
function rewriteLineDue(line: string, toIso: string): string {
  const m = line.match(CHECKBOX_RE);
  if (!m) return line;
  let text = m[3].trim();
  if (DUE_ISO_RE.test(text)) text = text.replace(DUE_ISO_RE, `@${toIso}`);
  else if (DUE_SHORT_RE.test(text)) text = text.replace(DUE_SHORT_RE, `@${toIso}`);
  else if (DUE_WORDS_RE.test(text)) text = text.replace(DUE_WORDS_RE, `@${toIso}`);
  else text = `${text} @${toIso}`;
  return `${m[1]}[${m[2]}] ${text.replace(/\s{2,}/g, " ").trim()}`;
}

/** Snooze: rewrite the task's due date to `toIso`. Pure. */
export function snoozeTaskInBody(body: string, lineIndex: number, toIso: string): string {
  const lines = body.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  lines[lineIndex] = rewriteLineDue(lines[lineIndex], toIso);
  return lines.join("\n");
}

export interface CompleteResult {
  body: string;
  /** True when the task was recurring: the due date rolled forward
   *  and the box stays UNCHECKED. */
  rolled: boolean;
  /** The new due date when rolled. */
  nextDueAt: string | null;
}

/** Complete a task. Non-recurring: checks the box and stamps a
 *  `✓YYYY-MM-DD[: outcome]` marker (the flight-log receipt).
 *  Recurring (`every X`): rolls the due date to the next occurrence
 *  and leaves the box unchecked. Pure. */
export function completeTaskInBody(
  body: string,
  lineIndex: number,
  opts?: { outcome?: string; now?: Date },
): CompleteResult {
  const lines = body.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return { body, rolled: false, nextDueAt: null };
  const m = lines[lineIndex].match(CHECKBOX_RE);
  if (!m) return { body, rolled: false, nextDueAt: null };
  const now = opts?.now ?? new Date();
  const text = m[3].trim();
  const rec = text.match(RECUR_RE)?.[1] ?? null;
  if (rec) {
    const next = nextOccurrence(rec, now);
    lines[lineIndex] = rewriteLineDue(lines[lineIndex], next);
    return { body: lines.join("\n"), rolled: true, nextDueAt: next };
  }
  const outcome = opts?.outcome?.trim();
  lines[lineIndex] = `${m[1]}[x] ${text} ✓${ymd(now)}${outcome ? `: ${outcome}` : ""}`;
  return { body: lines.join("\n"), rolled: false, nextDueAt: null };
}

/** Append a one-line outcome to an already-completed task that has a
 *  `✓date` marker but no outcome yet. Pure; no-op if it doesn't apply. */
export function appendOutcomeToTask(body: string, lineIndex: number, outcome: string): string {
  const lines = body.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  const line = lines[lineIndex];
  const m = line.match(CHECKBOX_RE);
  if (!m) return body;
  const dm = m[3].trim().match(DONE_RE);
  if (!dm || dm[2] || !outcome.trim()) return body;
  lines[lineIndex] = `${line.trimEnd()}: ${outcome.trim()}`;
  return lines.join("\n");
}

/** Remove the task line entirely ("kill"). Returns the new body —
 *  possibly empty; caller decides whether to delete the note. */
export function removeTaskLineFromBody(body: string, lineIndex: number): string {
  const lines = body.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  if (!CHECKBOX_RE.test(lines[lineIndex])) return body;
  lines.splice(lineIndex, 1);
  return lines.join("\n");
}

// ─── Topics & entities ──────────────────────────────────────────

/** Equipment-style tag: E-204, P-101A, MOC-2024-051… */
export const ENTITY_TAG_RE = /\b([A-Z]{1,4}-\d{2,5}[A-Z]?)\b/;
const MOC_RE = /\bMOC-\d{2,4}-\d+\b/i;
const UNIT_RE = /\bunit\s*(\d+)\b/i;

/** What is this task ABOUT? First MOC ref, else first equipment tag,
 *  else a unit mention, else "General". Drives by-thing grouping. */
export function topicForTask(text: string): string {
  const moc = text.match(MOC_RE);
  if (moc) return moc[0].toUpperCase();
  const tag = text.toUpperCase().match(ENTITY_TAG_RE);
  if (tag) return tag[1];
  const unit = text.match(UNIT_RE);
  if (unit) return `Unit ${unit[1]}`;
  return "General";
}

// ─── Capture organizer ──────────────────────────────────────────
//
// Deterministic local rules — no AI call, zero egress. Takes a messy
// free-text capture and restructures it into the note format the rest
// of this lib already understands: a title line, finding bullets, and
// `- [ ]` task lines whose due words the parser resolves at read time.

const CAPTURE_VERB_RE = /\b(call|check|follow up|order|schedule|ask|confirm|verify|inspect|get|fix|send|submit|need to|don'?t forget|remember to|update|review|chase|book)\b/i;
const LEADING_FILLER_RE = /^\s*(ok(?:ay)?|also|and|then|btw|note|fyi)[,\s]+/i;

export interface OrganizedCapture {
  title: string;
  /** The structured note body to persist. */
  body: string;
  /** The original sentences that became tasks — for flip-side
   *  highlighting ("show what became tasks"). */
  taskSources: string[];
  taskCount: number;
  findingCount: number;
}

function cleanSentence(s: string): string {
  let t = s.replace(LEADING_FILLER_RE, "").trim();
  // Normalize "before friday" → "by friday" so the due parser sees it.
  t = t.replace(/\bbefore\s+(today|tomorrow|next\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, "by $1");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function organizeCapture(raw: string): OrganizedCapture {
  const trimmed = raw.trim();
  const sentences = trimmed.split(/[.!?;\n]+/).map((s) => s.trim()).filter(Boolean);
  const tasks: string[] = [];
  const taskSources: string[] = [];
  const findings: string[] = [];

  for (const s of sentences) {
    if (CAPTURE_VERB_RE.test(s)) {
      tasks.push(cleanSentence(s));
      taskSources.push(s);
    } else {
      findings.push(cleanSentence(s));
    }
  }

  // Title: the first non-task sentence; tasks shouldn't double as the
  // headline. Falls back when the capture is pure tasks.
  const title = (findings[0] ?? "Quick capture").slice(0, 64);
  const restFindings = findings.slice(1);

  // Nothing actionable and nothing to structure → keep the raw text.
  if (tasks.length === 0 && findings.length <= 1) {
    return { title, body: trimmed, taskSources: [], taskCount: 0, findingCount: 0 };
  }

  const parts: string[] = [title, ""];
  if (restFindings.length > 0) {
    parts.push(...restFindings.map((f) => `- ${f}`), "");
  }
  parts.push(...tasks.map((t) => `- [ ] ${t}`));

  return {
    title,
    body: parts.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    taskSources,
    taskCount: tasks.length,
    findingCount: restFindings.length,
  };
}

// ─── Flight log ─────────────────────────────────────────────────

export interface FlightLogEntry {
  noteId: string;
  lineIndex: number;
  text: string;
  outcome: string | null;
  doneAt: string;
  topic: string;
  /** Whole days from the note's creation to completion — "how long it
   *  took". 0 = same day. Null when the note has no createdAt. */
  tookDays: number | null;
}

function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(`${toIso.slice(0, 10)}T00:00:00`).getTime() - new Date(`${fromIso.slice(0, 10)}T00:00:00`).getTime()) / 864e5,
  );
}

type FlightLogNote = Pick<Note, "id" | "body"> & { createdAt?: string };

/** Completed-task receipts across the given notes, newest first.
 *  Derived entirely from `✓date` markers — plain text, exportable. */
export function getFlightLog(notes: FlightLogNote[], sinceIso?: string): FlightLogEntry[] {
  const out: FlightLogEntry[] = [];
  for (const n of notes) {
    for (const t of extractTasks(n)) {
      if (!t.completed || !t.doneAt) continue;
      if (sinceIso && t.doneAt < sinceIso) continue;
      out.push({
        noteId: n.id,
        lineIndex: t.lineIndex,
        text: t.dueText ? t.body.replace(t.dueText, "").replace(/\s{2,}/g, " ").trim() : t.body,
        outcome: t.outcome,
        doneAt: t.doneAt,
        topic: topicForTask(t.body),
        tookDays: n.createdAt ? Math.max(0, daysBetweenIso(n.createdAt, t.doneAt)) : null,
      });
    }
  }
  return out.sort((a, b) => b.doneAt.localeCompare(a.doneAt));
}

// ─── Reports — daily / weekly / monthly ─────────────────────────
//
// A report is NOT a metric dump: it organizes what you ACHIEVED in the
// period (when, with what outcome, how long each item took) and what's
// still OPEN and carrying over (how long it's been open, how overdue).
// Pure derivation over note bodies — exportable as markdown.

export type ReportPeriod = "day" | "week" | "month";

export interface ReportCarryItem {
  noteId: string;
  lineIndex: number;
  text: string;
  topic: string;
  dueAt: string | null;
  recurring: string | null;
  /** Days since the note holding this task was created. */
  daysOpen: number;
  /** Days past due (0 = not overdue). */
  overdueDays: number;
}

export interface ReportData {
  period: ReportPeriod;
  periodLabel: string;
  sinceIso: string;
  todayIso: string;
  /** Done items inside the window, grouped by completion day, newest day first. */
  achievements: Array<{ day: string; items: FlightLogEntry[] }>;
  /** Open tasks (from unresolved notes) that carry over past the period. */
  carryOver: ReportCarryItem[];
  stats: {
    done: number;
    carry: number;
    overdueCarry: number;
    topTopic: [string, number] | null;
    /** Average tookDays across achievements that have one. */
    avgTookDays: number | null;
  };
}

type ReportNote = Pick<Note, "id" | "body"> & { createdAt?: string; resolved?: boolean };

export function buildReport(notes: ReportNote[], opts: { period: ReportPeriod; now?: Date }): ReportData {
  const now = opts.now ?? new Date();
  const todayIso = ymd(now);
  const windowDays = opts.period === "day" ? 0 : opts.period === "week" ? 6 : 29;
  const since = new Date(now);
  since.setDate(since.getDate() - windowDays);
  const sinceIso = ymd(since);
  const periodLabel = opts.period === "day" ? "Today" : opts.period === "week" ? "Last 7 days" : "Last 30 days";

  // Achievements: completed receipts inside the window, grouped by day.
  const done = getFlightLog(notes, sinceIso);
  const byDay = new Map<string, FlightLogEntry[]>();
  for (const e of done) {
    const arr = byDay.get(e.doneAt) ?? [];
    arr.push(e);
    byDay.set(e.doneAt, arr);
  }
  const achievements = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, items]) => ({ day, items }));

  // Carry-over: every still-open task from unresolved notes.
  const carryOver: ReportCarryItem[] = [];
  for (const n of notes) {
    if (n.resolved) continue;
    for (const t of extractTasks(n, now)) {
      if (t.completed) continue;
      const overdueDays = t.dueAt && t.dueAt < todayIso ? daysBetweenIso(t.dueAt, todayIso) : 0;
      carryOver.push({
        noteId: n.id,
        lineIndex: t.lineIndex,
        text: t.dueText ? t.body.replace(t.dueText, "").replace(/\s{2,}/g, " ").trim() : t.body,
        topic: topicForTask(t.body),
        dueAt: t.dueAt,
        recurring: t.recurring,
        daysOpen: n.createdAt ? Math.max(0, daysBetweenIso(n.createdAt, todayIso)) : 0,
        overdueDays,
      });
    }
  }
  carryOver.sort((a, b) => b.overdueDays - a.overdueDays || b.daysOpen - a.daysOpen);

  const topicCounts = new Map<string, number>();
  for (const e of done) topicCounts.set(e.topic, (topicCounts.get(e.topic) ?? 0) + 1);
  const topTopic = [...topicCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const tooks = done.map((e) => e.tookDays).filter((d): d is number => d !== null);
  const avgTookDays = tooks.length > 0 ? Math.round((tooks.reduce((s, d) => s + d, 0) / tooks.length) * 10) / 10 : null;

  return {
    period: opts.period,
    periodLabel,
    sinceIso,
    todayIso,
    achievements,
    carryOver,
    stats: {
      done: done.length,
      carry: carryOver.length,
      overdueCarry: carryOver.filter((c) => c.overdueDays > 0).length,
      topTopic,
      avgTookDays,
    },
  };
}

function fmtReportDay(iso: string): string {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

/** The report as clean markdown — for copy and .md download. */
export function reportToMarkdown(r: ReportData): string {
  const lines: string[] = [];
  lines.push(`# Scratchpad report — ${r.periodLabel} (${r.sinceIso === r.todayIso ? r.todayIso : `${r.sinceIso} → ${r.todayIso}`})`, "");
  lines.push(`**${r.stats.done} done · ${r.stats.carry} carrying over${r.stats.overdueCarry > 0 ? ` (${r.stats.overdueCarry} overdue)` : ""}${r.stats.avgTookDays !== null ? ` · avg ${r.stats.avgTookDays}d to close` : ""}${r.stats.topTopic ? ` · top topic ${r.stats.topTopic[0]} (${r.stats.topTopic[1]})` : ""}**`, "");

  lines.push("## Achievements");
  if (r.achievements.length === 0) {
    lines.push("_Nothing completed in this window._");
  } else {
    for (const g of r.achievements) {
      lines.push("", `### ${fmtReportDay(g.day)}`);
      for (const e of g.items) {
        const took = e.tookDays === null ? "" : e.tookDays === 0 ? " · same day" : ` · took ${e.tookDays}d`;
        lines.push(`- [x] ${e.text}${e.outcome ? ` — “${e.outcome}”` : ""}${took} · ${e.topic}`);
      }
    }
  }

  lines.push("", "## Carrying over");
  if (r.carryOver.length === 0) {
    lines.push("_Nothing open — clean slate._");
  } else {
    for (const c of r.carryOver) {
      const bits = [`open ${c.daysOpen}d`];
      if (c.overdueDays > 0) bits.push(`${c.overdueDays}d overdue`);
      else if (c.dueAt) bits.push(`due ${c.dueAt}`);
      if (c.recurring) bits.push(`every ${c.recurring}`);
      lines.push(`- [ ] ${c.text} — ${bits.join(" · ")} · ${c.topic}`);
    }
  }
  return lines.join("\n");
}

// ─── CRUD ───────────────────────────────────────────────────────

export interface CreateNoteInput {
  orgId: string;
  body: string;
  documentId?: string | null;
  projectId?: string | null;
  assetId?: string | null;
  createdBy: string;
  createdByName?: string;
  createdByEmail?: string;
  createdByRole?: string;
}

export async function createNote(input: CreateNoteInput): Promise<Note> {
  if (!input.body.trim()) throw new Error("Note body is required.");
  const { data, error } = await supabase
    .from("notes")
    .insert({
      org_id: input.orgId,
      body: input.body,
      document_id: input.documentId ?? null,
      project_id: input.projectId ?? null,
      asset_id: input.assetId ?? null,
      created_by: input.createdBy,
      created_by_name: input.createdByName ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create note");
  const note = rowToNote(data as NoteRow);

  await logAuditAction({
    action: "NOTE_CREATED",
    resourceId: note.id,
    resourceType: "note",
    orgId: input.orgId,
    userId: input.createdBy,
    userEmail: input.createdByEmail,
    userRole: input.createdByRole,
    details: {
      documentId: note.documentId, projectId: note.projectId, assetId: note.assetId,
      bodyPreview: note.body.slice(0, 120),
    },
  });

  return note;
}

/** Create a note from an organized capture, preserving the verbatim
 *  original in raw_body. Degrades gracefully when migration
 *  20260730_scratchpad_cockpit.sql hasn't run: retries without the
 *  column so the capture is never lost. */
export async function createOrganizedNote(
  input: CreateNoteInput & { rawBody: string },
): Promise<{ note: Note; rawPreserved: boolean }> {
  const { data, error } = await supabase
    .from("notes")
    .insert({
      org_id: input.orgId,
      body: input.body,
      raw_body: input.rawBody,
      document_id: input.documentId ?? null,
      project_id: input.projectId ?? null,
      asset_id: input.assetId ?? null,
      created_by: input.createdBy,
      created_by_name: input.createdByName ?? null,
    })
    .select("*")
    .single();
  if (!error && data) {
    const note = rowToNote(data as NoteRow);
    await logAuditAction({
      action: "NOTE_CREATED",
      resourceId: note.id,
      resourceType: "note",
      orgId: input.orgId,
      userId: input.createdBy,
      userEmail: input.createdByEmail,
      userRole: input.createdByRole,
      details: { organized: true, bodyPreview: note.body.slice(0, 120) },
    });
    return { note, rawPreserved: true };
  }
  // Column likely missing — persist the organized body the plain way.
  const note = await createNote(input);
  return { note, rawPreserved: false };
}

/** Whether the cockpit columns (raw_body / task_meta) from migration
 *  20260730_scratchpad_cockpit.sql exist. Used to explain — rather than
 *  silently hide — flip-to-verify and snooze tracking when the migration
 *  hasn't been applied. */
export async function scratchpadColumnsReady(): Promise<boolean> {
  const { error } = await supabase.from("notes").select("raw_body").limit(1);
  return !error;
}

/** Persist per-task metadata (snooze counts). Silently no-ops when the
 *  task_meta column doesn't exist yet — the feature is cosmetic. */
export async function updateNoteTaskMeta(
  id: string,
  taskMeta: Record<string, TaskMeta>,
  updatedBy: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("notes")
    .update({ task_meta: taskMeta, updated_at: new Date().toISOString(), updated_by: updatedBy })
    .eq("id", id);
  return !error;
}

export interface UpdateNoteInput {
  id: string;
  body: string;
  updatedBy: string;
  updatedByEmail?: string;
  updatedByRole?: string;
}

export async function updateNoteBody(input: UpdateNoteInput): Promise<Note> {
  const { data, error } = await supabase
    .from("notes")
    .update({
      body: input.body,
      updated_at: new Date().toISOString(),
      updated_by: input.updatedBy,
    })
    .eq("id", input.id)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to update note");
  return rowToNote(data as NoteRow);
}

export interface SetResolvedInput {
  id: string;
  resolved: boolean;
  actorUserId: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}

export async function setNoteResolved(input: SetResolvedInput): Promise<Note> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("notes")
    .update({
      resolved: input.resolved,
      resolved_at: input.resolved ? now : null,
      resolved_by: input.resolved ? input.actorUserId : null,
      updated_at: now,
      updated_by: input.actorUserId,
    })
    .eq("id", input.id)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to update note");

  await logAuditAction({
    action: input.resolved ? "NOTE_RESOLVED" : "NOTE_REOPENED",
    resourceId: input.id,
    resourceType: "note",
    orgId: (data as NoteRow).org_id,
    userId: input.actorUserId,
    userEmail: input.actorUserEmail,
    userRole: input.actorUserRole,
  });

  return rowToNote(data as NoteRow);
}

export async function deleteNote(id: string, actorUserId: string, orgId: string): Promise<void> {
  const { error } = await supabase.from("notes").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await logAuditAction({
    action: "NOTE_DELETED",
    resourceId: id, resourceType: "note", orgId, userId: actorUserId,
  });
}

// ─── Reads ──────────────────────────────────────────────────────

export interface ListNotesParams {
  orgId: string;
  documentId?: string;
  projectId?: string;
  assetId?: string;
  resolved?: boolean;
  /** Free-text search against body. */
  search?: string;
  limit?: number;
  /** When set, standalone notes (no doc/project/asset scope) are
   *  filtered to this user's authored notes only. Mirrors the RLS
   *  policy in migration 20260630_scratchpad_private.sql so the UI
   *  never asks for rows it can't read. Required for the scratchpad
   *  page; optional when listing scoped notes only. */
  actorUserId?: string;
}

export async function listNotes(params: ListNotesParams): Promise<Note[]> {
  const { orgId, documentId, projectId, assetId, resolved, search, limit = 200, actorUserId } = params;
  let q = supabase.from("notes").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(limit);
  if (documentId) q = q.eq("document_id", documentId);
  if (projectId)  q = q.eq("project_id",  projectId);
  if (assetId)    q = q.eq("asset_id",    assetId);
  // Standalone scratchpad listing: only the actor's own notes.
  const isStandalone = !documentId && !projectId && !assetId;
  if (isStandalone && actorUserId) q = q.eq("created_by", actorUserId);
  if (typeof resolved === "boolean") q = q.eq("resolved", resolved);
  if (search && search.trim()) q = q.ilike("body", `%${search.trim()}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data as NoteRow[]) ?? []).map(rowToNote);
}

/** Open tasks across notes the actor can see. Standalone notes are
 *  filtered to the actor's own; scoped notes (attached to a doc /
 *  project / asset) are returned to all org members. Cheap up to
 *  ~500 notes; if volume grows, denormalize into a note_tasks table
 *  with a body-write trigger. */
export async function listOpenTasks(orgId: string, actorUserId: string, opts?: { limit?: number }): Promise<{ note: Note; task: NoteTask }[]> {
  const standalone = await listNotes({ orgId, resolved: false, actorUserId, limit: opts?.limit ?? 500 });
  const scoped = await listNotes({ orgId, resolved: false, limit: opts?.limit ?? 500 });
  const seen = new Set<string>();
  const merged: Note[] = [];
  for (const n of [...standalone, ...scoped]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    merged.push(n);
  }
  const out: { note: Note; task: NoteTask }[] = [];
  for (const n of merged) {
    // Only surface tasks from scoped notes if they were authored by
    // the actor — otherwise the Open Tasks tab fills with other
    // people's todos. Notes the actor authored anywhere are fair game.
    const isMine = n.createdBy === actorUserId;
    const isStandalone = !n.documentId && !n.projectId && !n.assetId;
    if (!isMine && !isStandalone) continue;
    for (const t of extractTasks(n)) {
      if (!t.completed) out.push({ note: n, task: t });
    }
  }
  return out;
}

// ─── Daily brief & autonomous reminders ─────────────────────────

export interface TaskWithNote {
  note: Note;
  task: NoteTask;
}

export interface DailyBrief {
  overdue: TaskWithNote[];
  today:   TaskWithNote[];
  soon:    TaskWithNote[];
  later:   TaskWithNote[];
  noDate:  TaskWithNote[];
  /** Quick counts so the UI can render a header without iterating. */
  totals: {
    overdue: number; today: number; soon: number;
    later: number;   noDate: number; total: number;
  };
  /** Most recent note the user authored, for the "pick up where you
   *  left off" affordance. May be null if the user has no notes. */
  latestNote: Note | null;
}

/** Build the cockpit view of one user's open tasks, grouped by
 *  urgency. Reads the same notes listOpenTasks reads — but sorts
 *  into buckets and includes the freshest note for context. */
export async function getDailyBrief(orgId: string, actorUserId: string, now: Date = new Date()): Promise<DailyBrief> {
  const items = await listOpenTasks(orgId, actorUserId);
  const brief: DailyBrief = {
    overdue: [], today: [], soon: [], later: [], noDate: [],
    totals: { overdue: 0, today: 0, soon: 0, later: 0, noDate: 0, total: 0 },
    latestNote: null,
  };
  for (const item of items) {
    const bucket = bucketForTask(item.task, now);
    if      (bucket === "overdue") brief.overdue.push(item);
    else if (bucket === "today")   brief.today.push(item);
    else if (bucket === "soon")    brief.soon.push(item);
    else if (bucket === "later")   brief.later.push(item);
    else                            brief.noDate.push(item);
  }
  brief.totals.overdue = brief.overdue.length;
  brief.totals.today   = brief.today.length;
  brief.totals.soon    = brief.soon.length;
  brief.totals.later   = brief.later.length;
  brief.totals.noDate  = brief.noDate.length;
  brief.totals.total   = items.length;

  // Sort within bucket: earliest due date first (then by note creation desc).
  const byDueAsc = (a: TaskWithNote, b: TaskWithNote) =>
    String(a.task.dueAt ?? "").localeCompare(String(b.task.dueAt ?? ""));
  brief.overdue.sort(byDueAsc);
  brief.today.sort(byDueAsc);
  brief.soon.sort(byDueAsc);
  brief.later.sort(byDueAsc);

  // latestNote = most recently created note authored by the actor.
  const myNotes = await listNotes({ orgId, actorUserId, limit: 1 });
  brief.latestNote = myNotes[0] ?? null;

  return brief;
}

/** Fire ONE bell notification per day per user when there are
 *  overdue tasks waiting. Idempotent — checks for a same-day digest
 *  before inserting, so opening /scratchpad ten times doesn't spam.
 *  Safe to call on every page load. */
export async function maybeNotifyOverdueDigest(
  orgId: string,
  userId: string,
  brief: DailyBrief,
): Promise<void> {
  if (brief.totals.overdue === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = `${today}T00:00:00.000Z`;
  const { data } = await supabase
    .from("notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "task_overdue_digest")
    .gte("created_at", dayStart)
    .limit(1)
    .maybeSingle();
  if (data) return; // Already sent today.
  const sample = brief.overdue[0]?.task.body?.slice(0, 100) ?? "";
  const { notify } = await import("./inAppNotifications");
  await notify({
    orgId,
    userId,
    kind: "task_overdue_digest",
    title: `${brief.totals.overdue} overdue task${brief.totals.overdue === 1 ? "" : "s"} on your scratchpad`,
    body: sample ? `Including: "${sample}"` : undefined,
    link: "/scratchpad",
  });
}

/** The composed morning digest — ONE bell notification on the first
 *  visit each day summarizing the whole board: overdue, due today,
 *  and dateless notes that are going stale. Fires even when nothing
 *  is overdue (unlike maybeNotifyOverdueDigest, which it supersedes
 *  on the cockpit), as long as there's *something* to say. Idempotent
 *  per user per day. */
export async function maybeNotifyMorningDigest(
  orgId: string,
  userId: string,
  brief: DailyBrief,
  opts?: { staleNoDateCount?: number },
): Promise<void> {
  const stale = opts?.staleNoDateCount ?? 0;
  const { overdue, today } = brief.totals;
  if (overdue + today + stale === 0) return;

  const dayIso = new Date().toISOString().slice(0, 10);
  const dayStart = `${dayIso}T00:00:00.000Z`;
  const { data } = await supabase
    .from("notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "morning_digest")
    .gte("created_at", dayStart)
    .limit(1)
    .maybeSingle();
  if (data) return; // Already composed today.

  const bits: string[] = [];
  if (overdue > 0) bits.push(`${overdue} overdue`);
  if (today > 0) bits.push(`${today} due today`);
  if (stale > 0) bits.push(`${stale} dateless note${stale === 1 ? "" : "s"} aging`);
  const top = brief.overdue[0] ?? brief.today[0];
  const sample = top?.task.body?.slice(0, 100);

  const { notify } = await import("./inAppNotifications");
  await notify({
    orgId,
    userId,
    kind: "morning_digest",
    title: `Your day: ${bits.join(" · ")}`,
    body: sample ? `Up first: "${sample}"` : undefined,
    link: "/scratchpad",
  });
}
