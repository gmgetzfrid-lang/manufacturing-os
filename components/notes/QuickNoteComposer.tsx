"use client";
import { useToast } from "@/components/providers/ToastProvider";

// QuickNoteComposer — small inline "drop a note" widget for any
// resource. Used in the document inspector + asset card + project
// activity area. Writes to the notes table via lib/notes.createNote
// and shows the latest note inline so the user sees the context
// they added without bouncing to /scratchpad.

import React, { useCallback, useEffect, useState } from "react";
import { StickyNote, Loader2, Send, Trash2 } from "lucide-react";
import { createNote, deleteNote, listNotes, type Note } from "@/lib/notes";
import MentionableTextarea from "@/components/requests/MentionableTextarea";
import CommentBody from "@/components/requests/CommentBody";

interface Props {
  orgId: string;
  userId: string;
  userEmail?: string;
  userName?: string;
  scope: { documentId?: string; projectId?: string; assetId?: string };
}

export default function QuickNoteComposer({ orgId, userId, userEmail, userName, scope }: Props) {
  const { showToast } = useToast();
  const [body, setBody] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listNotes({
        orgId,
        documentId: scope.documentId,
        projectId: scope.projectId,
        assetId: scope.assetId,
        limit: 5,
      });
      setNotes(list);
    } finally { setLoading(false); }
  }, [orgId, scope.documentId, scope.projectId, scope.assetId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await createNote({
        orgId,
        body: text,
        documentId: scope.documentId,
        projectId: scope.projectId,
        assetId: scope.assetId,
        createdBy: userId,
        createdByName: userName ?? userEmail?.split("@")[0],
      });
      setBody("");
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't post note", message: (e as Error).message });
    } finally { setBusy(false); }
  };

  const remove = async (noteId: string) => {
    if (!confirm("Delete this note?")) return;
    try {
      await deleteNote(noteId, userId, orgId);
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Something went wrong", message: (e as Error).message });
    }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-accent-soft)] p-3">
      <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest flex items-center gap-1 mb-2">
        <StickyNote className="w-3 h-3 text-amber-600" /> Notes
        {notes.length > 0 && <span className="text-slate-400 font-mono">{notes.length}</span>}
      </div>

      {loading ? (
        <div className="py-2 text-[11px] text-slate-400 inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
      ) : notes.length === 0 ? (
        <div className="py-2 text-[11px] italic text-slate-400">No notes yet.</div>
      ) : (
        <ul className="space-y-1.5 mb-2">
          {notes.map((n) => (
            <li key={n.id} className="group flex items-start gap-2 text-xs">
              <div className="flex-1 min-w-0 bg-white rounded-md border border-slate-200 px-2 py-1.5">
                <CommentBody text={n.body} currentUserId={userId} className="text-slate-800 text-xs" />
                <div className="text-[9px] text-slate-400 mt-1">{n.createdByName ?? "—"} · {formatAgo(n.createdAt)}</div>
              </div>
              {String(n.createdBy) === String(userId) && (
                <button
                  onClick={() => void remove(n.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                  title="Delete"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div
        className="flex items-start gap-1.5"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
        }}
      >
        <div className="flex-1">
          <MentionableTextarea
            orgId={orgId}
            value={body}
            onChange={(next) => setBody(next)}
            placeholder="Add a note…  @ to mention · markdown supported · ⌘↵ to submit"
            rows={2}
          />
        </div>
        <button
          onClick={submit}
          disabled={!body.trim() || busy}
          className="p-2 rounded bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] transition-colors disabled:opacity-50"
          title="Post note"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function formatAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
    return d.toLocaleDateString();
  } catch { return ""; }
}
