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
}

export type TaskBucket = "overdue" | "today" | "soon" | "later" | "no-date";

interface NoteRow {
  id: string;
  org_id: string;
  body: string;
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

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function ymd(d: Date): string {
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
      const body = m[3].trim();
      const { dueAt, dueText } = parseDueFromTaskBody(body, now);
      tasks.push({
        noteId: note.id,
        lineIndex: idx,
        body,
        completed: m[2] === "x" || m[2] === "X",
        dueAt,
        dueText,
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
