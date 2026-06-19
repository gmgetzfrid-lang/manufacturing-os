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
  /** Progress / problem notes the user logs against a task over time.
   *  Feeds the carry-over "progress" line and the AI report. Newest last. */
  updates?: TaskUpdate[];
  /** Precise alarm time (ISO datetime) — the "timer" reminder, distinct from
   *  the calendar `dueAt` parsed from the body. Set by the AI suggestion or a
   *  manual pick; snoozing rewrites it; a future value means "quiet until
   *  then". Stored in the schemaless task_meta JSONB, so no migration. */
  remindAt?: string;
}

export interface TaskUpdate {
  /** ISO timestamp the update was recorded. */
  at: string;
  /** The note text (already AI-polished or raw user text). */
  text: string;
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
  /** Priority tier 1..4 (P1 highest) parsed from a `!pN` token, or
   *  null when unset. Sorts "next week's priorities" in the report. */
  priority: number | null;
  /** The exact `!pN` span, so the UI/report can strip it from display. */
  priorityText: string | null;
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
// 6. Priority:  !p1 (highest) … !p4 (lowest). Travels in the task text like
//    a due token so it survives edits and round-trips through the body.
const PRIORITY_RE = /!p([1-4])\b/i;

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
      const pm = body.match(PRIORITY_RE);
      const priority = pm ? Number(pm[1]) : null;
      const priorityText = pm ? pm[0] : null;
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
        priority,
        priorityText,
      });
    }
  });
  return tasks;
}

/** Display text for a task: body with due + priority tokens removed and
 *  whitespace collapsed. Used by the cards and the report. */
export function cleanTaskText(t: Pick<NoteTask, "body" | "dueText" | "priorityText">): string {
  let s = t.body;
  if (t.dueText) s = s.replace(t.dueText, "");
  if (t.priorityText) s = s.replace(t.priorityText, "");
  return s.replace(/\s{2,}/g, " ").trim();
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
    .replace(PRIORITY_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ─── Precise (timed) reminders ──────────────────────────────────
// A task's calendar `dueAt` (a date, parsed from the body) answers "what day
// is this due". A precise alarm — "remind me in 2 hours / at 3pm / Jul 1
// 9am" — is a datetime stored in task_meta[key].remindAt. It's the phone-alarm
// layer: it can fire mid-day and be snoozed by minutes/hours.

/** The precise alarm time set on a task via task_meta, or null. */
export function taskRemindAt(taskMeta: Record<string, TaskMeta> | undefined | null, taskBody: string): string | null {
  if (!taskMeta) return null;
  return taskMeta[taskKeyFor(taskBody)]?.remindAt ?? null;
}

/** Should this task fire as a "due now" alarm at `now`?
 *   - A future remindAt = quiet until then (snoozed), and it overrides dueAt.
 *   - A past/now remindAt fires.
 *   - No remindAt → fall back to the calendar bucket (overdue or today). */
export function taskIsDueNow(
  task: Pick<NoteTask, "body" | "dueAt" | "completed">,
  taskMeta: Record<string, TaskMeta> | undefined | null,
  now: Date = new Date(),
): boolean {
  if (task.completed) return false;
  const remindAt = taskRemindAt(taskMeta, task.body);
  if (remindAt) return new Date(remindAt).getTime() <= now.getTime();
  const bucket = bucketForTask(task as NoteTask, now);
  return bucket === "overdue" || bucket === "today";
}

/** now + minutes, as ISO — for phone-style snoozes (15m / 1h / 2h…). */
export function snoozeOffsetIso(minutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() + minutes * 60000).toISOString();
}

/** Set (or clear, when null) a task's precise alarm in a taskMeta map. Pure;
 *  returns a new map to persist via updateNoteTaskMeta. */
export function withTaskReminder(
  taskMeta: Record<string, TaskMeta> | undefined | null,
  taskBody: string,
  remindAtIso: string | null,
): Record<string, TaskMeta> {
  const map: Record<string, TaskMeta> = { ...(taskMeta ?? {}) };
  const key = taskKeyFor(taskBody);
  const entry: TaskMeta = { ...(map[key] ?? {}) };
  if (remindAtIso) entry.remindAt = remindAtIso;
  else delete entry.remindAt;
  map[key] = entry;
  return map;
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

/** Set (or clear, when `priority` is null) the `!pN` token on a task
 *  line. Pure body→body rewrite — persists via the same updateNoteBody
 *  path as snooze/complete. The token rides at the end of the line so it
 *  never collides with due/recurrence parsing. */
export function setTaskPriorityInBody(body: string, lineIndex: number, priority: 1 | 2 | 3 | 4 | null): string {
  const lines = body.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  const m = lines[lineIndex].match(CHECKBOX_RE);
  if (!m) return body;
  let text = m[3].replace(PRIORITY_RE, "").replace(/\s{2,}/g, " ").trim();
  if (priority) text = `${text} !p${priority}`;
  lines[lineIndex] = `${m[1]}[${m[2]}] ${text}`;
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

const LEADING_FILLER_RE = /^\s*(ok(?:ay)?|also|and|then|btw|note|fyi)[,\s]+/i;

// Verbs that BEGIN an actionable clause. Multi-word phrases first so the
// matcher prefers the longest ("follow up with" before "follow up").
const ACTION_VERB_LIST = [
  "follow up with", "follow up", "check in with", "check with", "coordinate with",
  "catch up with", "touch base with", "reach out to", "reach out", "talk to",
  "walk down", "sign off on", "sign off", "close out", "clean up", "set up",
  "pick up", "drop off", "call", "email", "text", "ping", "ask", "remind",
  "tell", "notify", "chase", "order", "schedule", "confirm", "verify", "inspect",
  "fix", "send", "submit", "update", "review", "book", "grab", "swap", "replace",
  "test", "measure", "log", "file", "print", "prep", "stage", "get", "check", "walk",
];
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const ACTION_ALT = ACTION_VERB_LIST.map(escapeRe).join("|");
// Optional lead-in: "I need to", "gotta", "don't forget to", …
const TASK_LEAD_SRC = "(?:i\\s+)?(?:need to|have to|got to|gotta|should|must|don'?t forget to|remember to|gonna|going to)\\s+";
const ACTION_START_RE = new RegExp(`^(?:also\\s+|then\\s+|and\\s+)?(?:${TASK_LEAD_SRC})?(?:${ACTION_ALT})\\b`, "i");

// People-directed verbs trigger SUBJECT-list splitting ("call A and B").
const PEOPLE_VERB_SRC = "follow up with|follow up|check in with|check with|coordinate with|catch up with|touch base with|reach out to|reach out|talk to|call|email|text|ping|ask|remind|tell|notify|chase";

// One regex to split a coordinated list, Oxford comma and "&" aware.
const LIST_SPLIT_RE = /\s*(?:,\s*and\s+|,\s*&\s*|,\s*|\s+and\s+|\s+&\s+)\s*/i;
// Trailing shared context that applies to a whole subject list.
const CONTEXT_RE = /\s+(on|about|re|regarding)\s+.+$/i;

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

/** Light tidy: drop a leading filler word, normalize "before X" → "by X"
 *  (so the due parser sees it), capitalize. Detail is preserved. */
function tidyClause(s: string): string {
  let t = s.replace(LEADING_FILLER_RE, "").replace(/\s+/g, " ").trim();
  t = t.replace(/\bbefore\s+(today|tomorrow|next\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, "by $1");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Distribute a people/subject list across separate tasks, keeping each
 *  one's context so every task is independently checkable.
 *    "follow up with steve and dave and hector on gaskets"
 *      → ["follow up with steve on gaskets", "...dave on gaskets", "...hector on gaskets"]
 *    "call steve on the spec and dave on LOTO"
 *      → ["call steve on the spec", "call dave on LOTO"]
 *  Returns [clause] unchanged when it isn't a people-list. */
function distributePeopleList(clause: string): string[] {
  const m = clause.match(new RegExp(`^((?:also\\s+|then\\s+|and\\s+)?(?:${TASK_LEAD_SRC})?)((?:${PEOPLE_VERB_SRC})\\s+(?:with\\s+|to\\s+)?)(.+)$`, "i"));
  if (!m) return [clause];
  const lead = m[1] ?? "";
  const verbPhrase = m[2].trim();
  const rest = m[3].trim();

  const items = rest.split(LIST_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (items.length < 2) return [clause];

  const build = (subject: string, ctx: string) =>
    `${lead}${verbPhrase} ${subject}${ctx ? ` ${ctx}` : ""}`.replace(/\s+/g, " ").trim();

  // Per-item context: most items carry their own "on/about X" → keep each as-is.
  if (items.filter((it) => /\b(on|about|re|regarding)\b/i.test(it)).length >= 2) {
    return items.map((it) => build(it, ""));
  }
  // Shared context: a single trailing "on/about X" applies to all subjects.
  const ctxMatch = rest.match(CONTEXT_RE);
  const subjectPart = ctxMatch ? rest.slice(0, ctxMatch.index).trim() : rest;
  const sharedCtx = ctxMatch ? ctxMatch[0].trim() : "";
  const subjects = subjectPart.split(LIST_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (subjects.length < 2) return [clause];
  return subjects.map((s) => build(s, sharedCtx));
}

/** Break ONE captured sentence into atomic tasks + leading observations.
 *  Splits coordinated actions ("order X and check Y" → two tasks) and
 *  people lists, while keeping non-action prose as findings. */
export function splitCaptureSentence(sentence: string): { tasks: string[]; findings: string[] } {
  const segs = sentence.split(LIST_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  const findings: string[] = [];
  const actionClauses: string[] = [];
  for (const seg of segs) {
    if (ACTION_START_RE.test(seg)) {
      actionClauses.push(seg);                                   // a new action
    } else if (actionClauses.length === 0) {
      findings.push(seg);                                        // leading observation
    } else {
      actionClauses[actionClauses.length - 1] += ` and ${seg}`;  // object/list of current action
    }
  }
  const tasks: string[] = [];
  for (const c of actionClauses) tasks.push(...distributePeopleList(c));
  return {
    tasks: tasks.map(tidyClause).filter(Boolean),
    findings: findings.map(tidyClause).filter(Boolean),
  };
}

/** Convenience wrapper: every atomic task a clause yields. */
export function splitConjoinedTasks(clause: string): string[] {
  return splitCaptureSentence(clause).tasks;
}

/** Shared body formatter so the AI path and the heuristic path produce
 *  identical note structure (title, finding bullets, `- [ ]` tasks). */
export function composeOrganizedBody(
  title: string, findings: string[], tasks: string[],
): { body: string; taskCount: number; findingCount: number } {
  const parts: string[] = [title.slice(0, 80), ""];
  if (findings.length > 0) parts.push(...findings.map((f) => `- ${f}`), "");
  parts.push(...tasks.map((t) => `- [ ] ${t}`));
  return {
    body: parts.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    taskCount: tasks.length,
    findingCount: findings.length,
  };
}

export interface StructuredCapture {
  title: string;
  findings: string[];
  tasks: string[];
  taskSources: string[];
}

/** Synthesize a title that sums the capture up instead of parroting the
 *  first sentence: lead with the dominant subject (tag / MOC / unit)
 *  when one exists, then the gist, then the task count. */
export function deriveCaptureTitle(findings: string[], tasks: string[]): string {
  const all = [...tasks, ...findings];
  const counts = new Map<string, number>();
  for (const t of all) {
    const top = topicForTask(t);
    if (top !== "General") counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const topic = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const gist = (findings[0] ?? tasks[0] ?? "Quick capture").replace(/\s+/g, " ").trim();
  let title = topic && !gist.toUpperCase().includes(topic.toUpperCase())
    ? `${topic} — ${gist}`
    : gist;
  if (tasks.length >= 2) title = `${title.slice(0, 62)} (${tasks.length} tasks)`;
  return title.slice(0, 80);
}

/** The organizer's structured output (title / findings / atomic tasks),
 *  before formatting. Shared by the heuristic and the AI fallback. */
export function organizeCaptureStructured(raw: string): StructuredCapture {
  const trimmed = raw.trim();
  // Split on hard sentence enders only (keep ';' and ',' for the clause
  // splitter, which is where the real work happens).
  const sentences = trimmed.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const tasks: string[] = [];
  const taskSources: string[] = [];
  const findings: string[] = [];

  for (const s of sentences) {
    const r = splitCaptureSentence(s);
    if (r.tasks.length > 0) {
      tasks.push(...r.tasks);
      taskSources.push(s);
      findings.push(...r.findings); // observations that led the task sentence
    } else {
      findings.push(...(r.findings.length > 0 ? r.findings : [tidyClause(s)]));
    }
  }
  const title = deriveCaptureTitle(findings, tasks);
  return { title, findings: findings.slice(1), tasks, taskSources };
}

export function organizeCapture(raw: string): OrganizedCapture {
  const trimmed = raw.trim();
  const s = organizeCaptureStructured(raw);

  // Nothing actionable and nothing to structure → keep the raw text.
  if (s.tasks.length === 0 && s.findings.length === 0) {
    return { title: s.title, body: trimmed, taskSources: [], taskCount: 0, findingCount: 0 };
  }

  const composed = composeOrganizedBody(s.title, s.findings, s.tasks);
  return {
    title: s.title,
    body: composed.body,
    taskSources: s.taskSources,
    taskCount: composed.taskCount,
    findingCount: composed.findingCount,
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
  /** P1..P4 (P1 highest), or null. */
  priority: number | null;
  /** Progress / problem notes logged against this task, oldest→newest. */
  updates: TaskUpdate[];
  /** Editable prose describing where the task stands (AI-written or the
   *  newest update). Carries into the exported report. */
  description: string;
}

export interface ReportRoadblock {
  text: string;
  /** Why it's flagged: the blocker phrase, "snoozed N×", or "Nd overdue". */
  reason: string;
  topic: string;
  /** "task" = an open checkbox; "finding" = blocker noted in prose. */
  kind: "task" | "finding";
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
  /** The "what's stuck" section a boss actually asks about: blocker-worded
   *  items, repeatedly-snoozed tasks, and long-overdue tasks. */
  roadblocks: ReportRoadblock[];
  /** The Excel-replacement daily log: notes written in the window,
   *  grouped by day — what you were DOING, beyond the checkboxes. */
  activity: Array<{ day: string; notes: Array<{ title: string; findings: string[] }> }>;
  stats: {
    done: number;
    carry: number;
    overdueCarry: number;
    roadblocks: number;
    topTopic: [string, number] | null;
    /** Average tookDays across achievements that have one. */
    avgTookDays: number | null;
  };
}

/** Blocker language — the phrases people actually write when stuck. */
export const BLOCKER_RE = /\b(blocked|blocker|road\s*block|waiting (?:on|for)|stuck|held up|on hold|can'?t (?:proceed|start|continue)|pending (?:approval|parts|review|safety)|no (?:parts|materials|access)|delayed by|short on)\b/i;

/** Request language — when you need something FROM someone else. Drives
 *  the "Requests" section: asks, approvals, parts, sign-offs, follow-ups. */
export const REQUEST_RE = /\b(need|needs|require|requires|request(?:ing)?|order|procure|waiting (?:on|for)|follow up with|chase|ask (?:\w+ )?(?:for|to)|sign[- ]?off|approval (?:from|on)|get .* from|send me|provide)\b/i;

// ─── Structured, editable report (the PDF deliverable) ───────────
//
// buildReportDoc() turns the scratchpad into the document a supervisor
// actually sends: a header (org · person · date range), what was
// COMPLETED (with a quiet, factual schedule note — "ahead of schedule",
// "2d late" — never cheerleading), CARRY-OVER with per-task progress
// pulled from the update notes, AI-owned IMPEDIMENTS and REQUESTS, and
// NEXT WEEK'S PRIORITIES ranked P1→P4. Every field is editable in the UI
// before export; the AI rewrite (when a provider is configured) only
// elevates the prose — the facts come from the user's own tasks.

export type PriorityTier = 1 | 2 | 3 | 4;

export interface ReportCompletedItem {
  noteId: string;
  lineIndex: number;
  text: string;
  topic: string;
  doneAt: string;
  outcome: string | null;
  /** Quiet, factual schedule read vs the due date: "ahead of schedule",
   *  "on time", "2d late", or null when there was no due date. */
  scheduleNote: string | null;
  /** Editable prose (AI-elevated outcome, or the outcome verbatim). */
  description: string;
  updates: TaskUpdate[];
}

export interface ReportPriorityItem {
  title: string;
  description: string;
  priority: PriorityTier | null;
  dueAt: string | null;
}

/** A free line for the Impediments / Requests sections. */
export interface ReportLine {
  text: string;
  /** Optional supporting detail (who/what it's waiting on, etc.). */
  detail: string;
}

export interface ReportDoc {
  /** Editable header. */
  org: string;
  person: string;
  period: ReportPeriod;
  periodLabel: string;
  sinceIso: string;
  todayIso: string;
  rangeLabel: string;
  /** One-paragraph overview (AI-written or deterministic), editable. */
  summary: string;
  completed: ReportCompletedItem[];
  carryOver: ReportCarryItem[];
  impediments: ReportLine[];
  requests: ReportLine[];
  nextPriorities: ReportPriorityItem[];
  /** Headline counts for the strip. */
  stats: { done: number; carry: number; overdueCarry: number; impediments: number; requests: number };
  /** True once an AI provider has elevated the prose. */
  aiElevated: boolean;
}

/** Which report period fits TODAY: month boundaries get monthly, the
 *  Friday→Monday window gets weekly (report-writing days), midweek gets
 *  daily. The modal still lets you switch. */
export function suggestReportPeriod(now: Date = new Date()): ReportPeriod {
  const dom = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (dom <= 3 || dom >= lastDay - 1) return "month";
  const dow = now.getDay(); // 0 Sun … 6 Sat
  if (dow === 5 || dow === 6 || dow === 0 || dow === 1) return "week";
  return "day";
}

type ReportNote = Pick<Note, "id" | "body"> & { createdAt?: string; resolved?: boolean; taskMeta?: Record<string, TaskMeta> };

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
      const updates = n.taskMeta?.[taskKeyFor(t.body)]?.updates ?? [];
      carryOver.push({
        noteId: n.id,
        lineIndex: t.lineIndex,
        text: cleanTaskText(t),
        topic: topicForTask(t.body),
        dueAt: t.dueAt,
        recurring: t.recurring,
        daysOpen: n.createdAt ? Math.max(0, daysBetweenIso(n.createdAt, todayIso)) : 0,
        overdueDays,
        priority: t.priority,
        updates,
        description: updates.length > 0 ? updates[updates.length - 1].text : "",
      });
    }
  }
  carryOver.sort((a, b) => b.overdueDays - a.overdueDays || b.daysOpen - a.daysOpen);

  // Roadblocks: blocker-worded open tasks + prose, chronically snoozed
  // tasks, and long-overdue tasks. The spotlight list, not a re-list.
  const roadblocks: ReportRoadblock[] = [];
  const rbSeen = new Set<string>();
  const pushRb = (rb: ReportRoadblock) => {
    const k = rb.text.toLowerCase();
    if (rbSeen.has(k)) return;
    rbSeen.add(k);
    roadblocks.push(rb);
  };
  for (const n of notes) {
    if (n.resolved) continue;
    for (const t of extractTasks(n, now)) {
      if (t.completed) continue;
      const text = t.dueText ? t.body.replace(t.dueText, "").replace(/\s{2,}/g, " ").trim() : t.body;
      const blockerMatch = t.body.match(BLOCKER_RE);
      const snoozes = n.taskMeta?.[taskKeyFor(t.body)]?.snoozes ?? 0;
      const overdueDays = t.dueAt && t.dueAt < todayIso ? daysBetweenIso(t.dueAt, todayIso) : 0;
      if (blockerMatch) pushRb({ text, reason: `flagged: “${blockerMatch[0].toLowerCase()}”`, topic: topicForTask(t.body), kind: "task" });
      else if (snoozes >= 3) pushRb({ text, reason: `snoozed ${snoozes}×`, topic: topicForTask(t.body), kind: "task" });
      else if (overdueDays >= 7) pushRb({ text, reason: `${overdueDays}d overdue`, topic: topicForTask(t.body), kind: "task" });
    }
    // Blocker language in prose (findings / plain lines) — roadblocks
    // often aren't tasks: "waiting on safety to release MOC-2024-051".
    for (const line of n.body.split("\n")) {
      if (/^\s*[-*]\s*\[/.test(line)) continue; // tasks handled above
      const clean = line.replace(/^\s*[-*]\s*/, "").trim();
      if (clean.length < 8) continue;
      const m = clean.match(BLOCKER_RE);
      if (m) pushRb({ text: clean, reason: `noted: “${m[0].toLowerCase()}”`, topic: topicForTask(clean), kind: "finding" });
    }
  }

  // Daily activity log: notes WRITTEN in the window, grouped by day —
  // the "what was I doing" narrative the user used to keep in Excel.
  const actByDay = new Map<string, Array<{ title: string; findings: string[] }>>();
  for (const n of notes) {
    if (!n.createdAt) continue;
    const day = n.createdAt.slice(0, 10);
    if (day < sinceIso || day > todayIso) continue;
    const lines = n.body.split("\n");
    const isCheckbox = (l: string) => /^\s*[-*]\s*\[/.test(l);
    const title = lines[0] && !isCheckbox(lines[0]) && !lines[0].startsWith("- ") ? lines[0].trim() : null;
    const findings = lines.filter((l) => /^- (?!\[)/.test(l)).map((l) => l.replace(/^- /, "").trim());
    if (!title && findings.length === 0) continue; // pure-task notes live in achievements/carry
    const arr = actByDay.get(day) ?? [];
    arr.push({ title: title ?? "Note", findings });
    actByDay.set(day, arr);
  }
  const activity = [...actByDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, ns]) => ({ day, notes: ns }));

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
    roadblocks,
    activity,
    stats: {
      done: done.length,
      carry: carryOver.length,
      overdueCarry: carryOver.filter((c) => c.overdueDays > 0).length,
      roadblocks: roadblocks.length,
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

  lines.push("", "## Roadblocks");
  if (r.roadblocks.length === 0) {
    lines.push("_No roadblocks flagged._");
  } else {
    for (const rb of r.roadblocks) {
      lines.push(`- ${rb.text} — ${rb.reason} · ${rb.topic}`);
    }
  }

  lines.push("", "## Carrying over / in progress");
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

  lines.push("", "## Daily activity");
  if (r.activity.length === 0) {
    lines.push("_No notes written in this window._");
  } else {
    for (const g of r.activity) {
      lines.push("", `### ${fmtReportDay(g.day)}`);
      for (const n of g.notes) {
        lines.push(`- **${n.title}**`);
        for (const f of n.findings) lines.push(`  - ${f}`);
      }
    }
  }
  return lines.join("\n");
}

/** The report as CSV — for the people (and bosses) who live in Excel.
 *  One flat sheet: Section, Date, Item, Detail, Days, Topic. */
export function reportToCsv(r: ReportData): string {
  const esc = (v: string | number | null | undefined): string => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: string[] = ["Section,Date,Item,Detail,Days,Topic"];
  for (const g of r.achievements) {
    for (const e of g.items) {
      rows.push([
        "Achievement", g.day, esc(e.text), esc(e.outcome ?? ""),
        e.tookDays === null ? "" : String(e.tookDays), esc(e.topic),
      ].join(","));
    }
  }
  for (const rb of r.roadblocks) {
    rows.push(["Roadblock", r.todayIso, esc(rb.text), esc(rb.reason), "", esc(rb.topic)].join(","));
  }
  for (const c of r.carryOver) {
    rows.push([
      "In progress", c.dueAt ?? "", esc(c.text),
      esc(c.overdueDays > 0 ? `${c.overdueDays}d overdue` : c.recurring ? `every ${c.recurring}` : "open"),
      String(c.daysOpen), esc(c.topic),
    ].join(","));
  }
  for (const g of r.activity) {
    for (const n of g.notes) {
      rows.push(["Activity", g.day, esc(n.title), esc(n.findings.join(" | ")), "", ""].join(","));
    }
  }
  return rows.join("\n");
}

/** Quiet, factual schedule read for a completed task — never cheerleads. */
function scheduleNoteFor(dueAt: string | null, doneAt: string): string | null {
  if (!dueAt) return null;
  if (doneAt < dueAt) return "ahead of schedule";
  if (doneAt === dueAt) return "on time";
  return `${daysBetweenIso(dueAt, doneAt)}d late`;
}

/** Build the structured, editable report document from the scratchpad.
 *  Deterministic and pure — the AI step (mergeAiIntoReportDoc) only
 *  elevates the prose afterward. `org`/`person` come from the caller. */
export function buildReportDoc(
  notes: ReportNote[],
  opts: { period: ReportPeriod; now?: Date; org?: string; person?: string },
): ReportDoc {
  const now = opts.now ?? new Date();
  const todayIso = ymd(now);
  const windowDays = opts.period === "day" ? 0 : opts.period === "week" ? 6 : 29;
  const since = new Date(now);
  since.setDate(since.getDate() - windowDays);
  const sinceIso = ymd(since);
  const periodLabel = opts.period === "day" ? "Daily" : opts.period === "week" ? "Weekly" : "Monthly";
  const rangeLabel = sinceIso === todayIso ? fmtReportDay(todayIso) : `${fmtReportDay(sinceIso)} – ${fmtReportDay(todayIso)}`;

  // COMPLETED — checked-off tasks whose ✓date falls inside the window.
  const completed: ReportCompletedItem[] = [];
  // CARRY-OVER — still-open tasks from unresolved notes.
  const carryOver: ReportCarryItem[] = [];
  // Candidate impediments / requests, deduped (the AI refines these later).
  const impediments: ReportLine[] = [];
  const requests: ReportLine[] = [];
  const impSeen = new Set<string>();
  const reqSeen = new Set<string>();
  const pushImp = (text: string, detail: string) => { const k = text.toLowerCase(); if (text.length >= 6 && !impSeen.has(k)) { impSeen.add(k); impediments.push({ text, detail }); } };
  const pushReq = (text: string, detail: string) => { const k = text.toLowerCase(); if (text.length >= 6 && !reqSeen.has(k)) { reqSeen.add(k); requests.push({ text, detail }); } };

  for (const n of notes) {
    const meta = n.taskMeta ?? {};
    for (const t of extractTasks(n, now)) {
      const key = taskKeyFor(t.body);
      const updates = meta[key]?.updates ?? [];
      const text = cleanTaskText(t);
      if (t.completed) {
        if (!t.doneAt || t.doneAt < sinceIso || t.doneAt > todayIso) continue;
        completed.push({
          noteId: n.id, lineIndex: t.lineIndex, text, topic: topicForTask(t.body),
          doneAt: t.doneAt, outcome: t.outcome,
          scheduleNote: scheduleNoteFor(t.dueAt, t.doneAt),
          description: t.outcome ?? "", updates,
        });
        // A problem flagged in an update on a done task is still an impediment.
        for (const u of updates) { const m = u.text.match(BLOCKER_RE); if (m) pushImp(u.text, `on “${text}” · ${m[0].toLowerCase()}`); }
        continue;
      }
      if (n.resolved) continue;
      const overdueDays = t.dueAt && t.dueAt < todayIso ? daysBetweenIso(t.dueAt, todayIso) : 0;
      carryOver.push({
        noteId: n.id, lineIndex: t.lineIndex, text, topic: topicForTask(t.body),
        dueAt: t.dueAt, recurring: t.recurring,
        daysOpen: n.createdAt ? Math.max(0, daysBetweenIso(n.createdAt, todayIso)) : 0,
        overdueDays, priority: t.priority, updates,
        description: updates.length > 0 ? updates[updates.length - 1].text : "",
      });
      // Impediment / request inference from the task line + its updates.
      const haystacks = [t.body, ...updates.map((u) => u.text)];
      for (const h of haystacks) {
        const bm = h.match(BLOCKER_RE);
        if (bm) pushImp(text, `${bm[0].toLowerCase()}${h !== t.body ? ` — ${h}` : ""}`);
        const rm = h.match(REQUEST_RE);
        if (rm && !bm) pushReq(text, h !== t.body ? h : `${rm[0].toLowerCase()}`);
      }
      if (overdueDays >= 7) pushImp(text, `${overdueDays}d overdue`);
    }
    // Blocker / request language in prose lines (findings), not just tasks.
    for (const line of n.body.split("\n")) {
      if (/^\s*[-*]\s*\[/.test(line)) continue;
      const clean = line.replace(/^\s*[-*]\s*/, "").trim();
      if (clean.length < 8) continue;
      const bm = clean.match(BLOCKER_RE);
      if (bm) pushImp(clean, bm[0].toLowerCase());
      const rm = clean.match(REQUEST_RE);
      if (rm && !bm) pushReq(clean, rm[0].toLowerCase());
    }
  }

  completed.sort((a, b) => b.doneAt.localeCompare(a.doneAt));
  carryOver.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || b.overdueDays - a.overdueDays || b.daysOpen - a.daysOpen);

  // NEXT WEEK'S PRIORITIES — open tasks that are prioritised, due soon, or
  // overdue. Ranked P1→P4, then by due date.
  const weekAhead = new Date(now); weekAhead.setDate(weekAhead.getDate() + 7);
  const weekAheadIso = ymd(weekAhead);
  const nextPriorities: ReportPriorityItem[] = carryOver
    .filter((c) => c.priority !== null || c.overdueDays > 0 || (c.dueAt !== null && c.dueAt <= weekAheadIso))
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"))
    .slice(0, 12)
    .map((c) => ({
      title: c.text,
      description: c.description,
      priority: (c.priority as PriorityTier | null) ?? null,
      dueAt: c.dueAt,
    }));

  const overdueCarry = carryOver.filter((c) => c.overdueDays > 0).length;
  const summary = [
    `${completed.length} item${completed.length === 1 ? "" : "s"} completed this ${opts.period === "day" ? "day" : opts.period === "week" ? "week" : "month"}`,
    `${carryOver.length} carrying over${overdueCarry > 0 ? ` (${overdueCarry} overdue)` : ""}`,
    impediments.length > 0 ? `${impediments.length} impediment${impediments.length === 1 ? "" : "s"} to clear` : null,
  ].filter(Boolean).join("; ") + ".";

  return {
    org: opts.org ?? "", person: opts.person ?? "",
    period: opts.period, periodLabel, sinceIso, todayIso, rangeLabel,
    summary, completed, carryOver, impediments, requests, nextPriorities,
    stats: { done: completed.length, carry: carryOver.length, overdueCarry, impediments: impediments.length, requests: requests.length },
    aiElevated: false,
  };
}

const PRIORITY_LABEL = (p: number | null): string => (p ? `P${p}` : "—");

/** The editable report as clean markdown — for copy, the AI prompt, and
 *  the print/PDF fallback. */
export function reportDocToMarkdown(d: ReportDoc): string {
  const L: string[] = [];
  L.push(`# ${d.periodLabel} Status Report`, "");
  if (d.org) L.push(`**Organization:** ${d.org}  `);
  if (d.person) L.push(`**Prepared by:** ${d.person}  `);
  L.push(`**Reporting period:** ${d.rangeLabel}`, "");
  if (d.summary) L.push(`> ${d.summary}`, "");

  L.push("## Completed");
  if (d.completed.length === 0) L.push("_Nothing completed in this window._");
  else for (const c of d.completed) {
    const sched = c.scheduleNote ? ` _(${c.scheduleNote})_` : "";
    L.push(`- **${c.text}**${sched} — ${c.description || c.outcome || "done"} · ${fmtReportDay(c.doneAt)} · ${c.topic}`);
  }

  L.push("", "## Carry-over / in progress");
  if (d.carryOver.length === 0) L.push("_Nothing open — clean slate._");
  else for (const c of d.carryOver) {
    const bits = [`open ${c.daysOpen}d`];
    if (c.priority) bits.unshift(PRIORITY_LABEL(c.priority));
    if (c.overdueDays > 0) bits.push(`${c.overdueDays}d overdue`);
    else if (c.dueAt) bits.push(`due ${c.dueAt}`);
    L.push(`- **${c.text}** — ${bits.join(" · ")}`);
    if (c.description) L.push(`  - ${c.description}`);
  }

  L.push("", "## Impediments");
  if (d.impediments.length === 0) L.push("_None._");
  else for (const i of d.impediments) L.push(`- ${i.text}${i.detail ? ` — ${i.detail}` : ""}`);

  L.push("", "## Requests");
  if (d.requests.length === 0) L.push("_None._");
  else for (const r of d.requests) L.push(`- ${r.text}${r.detail ? ` — ${r.detail}` : ""}`);

  L.push("", "## Next period priorities");
  if (d.nextPriorities.length === 0) L.push("_None set._");
  else for (const p of d.nextPriorities) {
    L.push(`- **${p.priority ? `[${PRIORITY_LABEL(p.priority)}] ` : ""}${p.title}**${p.dueAt ? ` _(due ${p.dueAt})_` : ""}${p.description ? ` — ${p.description}` : ""}`);
  }
  return L.join("\n");
}

/** The instruction + payload sent to the AI to elevate the report. The
 *  model returns the JSON shape in mergeAiIntoReportDoc. */
export function reportDocAiPrompt(d: ReportDoc): string {
  const payload = {
    period: d.periodLabel, range: d.rangeLabel, org: d.org, person: d.person,
    completed: d.completed.map((c) => ({ text: c.text, outcome: c.outcome, scheduleNote: c.scheduleNote, updates: c.updates.map((u) => u.text) })),
    carryOver: d.carryOver.map((c) => ({ text: c.text, priority: c.priority, dueAt: c.dueAt, daysOpen: c.daysOpen, overdueDays: c.overdueDays, updates: c.updates.map((u) => u.text) })),
    nextPriorities: d.nextPriorities.map((p) => ({ title: p.title, priority: p.priority, dueAt: p.dueAt })),
  };
  return [
    "You are writing a concise, professional engineering status report from a supervisor's scratchpad.",
    "RULES:",
    "- Use ONLY the facts given. Never invent completed work, dates, or names.",
    "- Be specific and plain. NO cheerleading, no fluff, no exclamation marks.",
    "- When a completed item has a scheduleNote, weave it in subtly (e.g. 'closed out ahead of schedule'). Do not over-celebrate.",
    "- For each completed and carry-over item, write ONE tight sentence of description using its outcome/updates.",
    "- Infer IMPEDIMENTS (what is blocking progress) and REQUESTS (what the author needs from others) from the items, their updates, and wording. Each is a short line plus an optional detail.",
    "- Write a 2-3 sentence executive summary.",
    "Return STRICT JSON, no prose, with this exact shape:",
    '{ "summary": string, "completedDescriptions": string[], "carryDescriptions": string[], "priorityDescriptions": string[], "impediments": [{"text": string, "detail": string}], "requests": [{"text": string, "detail": string}] }',
    "completedDescriptions is parallel to completed[], carryDescriptions to carryOver[], priorityDescriptions to nextPriorities[].",
    "",
    "DATA:",
    JSON.stringify(payload, null, 1),
  ].join("\n");
}

interface AiReportShape {
  summary?: string;
  completedDescriptions?: string[];
  carryDescriptions?: string[];
  priorityDescriptions?: string[];
  impediments?: Array<{ text?: string; detail?: string }>;
  requests?: Array<{ text?: string; detail?: string }>;
}

/** Merge the AI's JSON back onto the deterministic doc — prose only,
 *  facts preserved. Tolerant of missing/short arrays. Returns a new doc. */
export function mergeAiIntoReportDoc(doc: ReportDoc, raw: string): ReportDoc {
  let ai: AiReportShape;
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    ai = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart, jsonEnd + 1) : raw) as AiReportShape;
  } catch {
    return doc; // leave the deterministic doc intact on any parse failure
  }
  const applyDesc = <T extends { description: string }>(items: T[], descs?: string[]): T[] =>
    items.map((it, i) => (descs && descs[i] && descs[i].trim() ? { ...it, description: descs[i].trim() } : it));
  const lines = (arr?: Array<{ text?: string; detail?: string }>, fallback?: ReportLine[]): ReportLine[] =>
    Array.isArray(arr) && arr.length > 0
      ? arr.filter((x) => x && x.text && x.text.trim()).map((x) => ({ text: x.text!.trim(), detail: (x.detail ?? "").trim() }))
      : (fallback ?? []);
  return {
    ...doc,
    summary: ai.summary?.trim() || doc.summary,
    completed: applyDesc(doc.completed, ai.completedDescriptions),
    carryOver: applyDesc(doc.carryOver, ai.carryDescriptions),
    nextPriorities: doc.nextPriorities.map((p, i) =>
      ai.priorityDescriptions && ai.priorityDescriptions[i] && ai.priorityDescriptions[i].trim()
        ? { ...p, description: ai.priorityDescriptions[i].trim() } : p),
    impediments: lines(ai.impediments, doc.impediments),
    requests: lines(ai.requests, doc.requests),
    aiElevated: true,
  };
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
