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
}

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

export function extractTasks(note: Pick<Note, "id" | "body">): NoteTask[] {
  const lines = note.body.split("\n");
  const tasks: NoteTask[] = [];
  lines.forEach((line, idx) => {
    const m = line.match(CHECKBOX_RE);
    if (m) {
      tasks.push({
        noteId: note.id,
        lineIndex: idx,
        body: m[3].trim(),
        completed: m[2] === "x" || m[2] === "X",
      });
    }
  });
  return tasks;
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
}

export async function listNotes(params: ListNotesParams): Promise<Note[]> {
  const { orgId, documentId, projectId, assetId, resolved, search, limit = 200 } = params;
  let q = supabase.from("notes").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(limit);
  if (documentId) q = q.eq("document_id", documentId);
  if (projectId)  q = q.eq("project_id",  projectId);
  if (assetId)    q = q.eq("asset_id",    assetId);
  if (typeof resolved === "boolean") q = q.eq("resolved", resolved);
  if (search && search.trim()) q = q.ilike("body", `%${search.trim()}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data as NoteRow[]) ?? []).map(rowToNote);
}

/** Org-wide unresolved tasks. Reads all unresolved notes, extracts
 *  tasks. Cheap up to ~500 notes; if volume grows, denormalize into
 *  a note_tasks table with a body-write trigger. */
export async function listOpenTasks(orgId: string, opts?: { limit?: number }): Promise<{ note: Note; task: NoteTask }[]> {
  const notes = await listNotes({ orgId, resolved: false, limit: opts?.limit ?? 500 });
  const out: { note: Note; task: NoteTask }[] = [];
  for (const n of notes) {
    for (const t of extractTasks(n)) {
      if (!t.completed) out.push({ note: n, task: t });
    }
  }
  return out;
}
