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
import { appConfirm } from "@/components/providers/DialogProvider";
import { useDraft } from "@/hooks/useDraft";

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
  const noteOn = scope.documentId ?? scope.projectId ?? scope.assetId ?? null;
  useDraft<string>(noteOn ? `note:${noteOn}` : null, body, setBody, (v) => !v.trim());
  const [notes, setNotes] = useState<Note[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
      setLoadError(null);
    } catch (e) {
      // A failed read says so, instead of "No notes yet".
      setLoadError((e as Error).message);
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
    if (!(await appConfirm({ title: "Delete this note?", tone: "danger", confirmLabel: "Delete note" }))) return;
    try {
      await deleteNote(noteId, userId, orgId);
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't delete the note", message: (e as Error).message });
    }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="text-body font-medium text-[var(--color-text)] flex items-center gap-1 mb-2">
        <StickyNote className="w-3 h-3 text-[var(--color-text-muted)]" /> Notes
        {notes.length > 0 && <span className="text-[var(--color-text-faint)] tabular-nums">{notes.length}</span>}
      </div>

      {loading ? (
        <div className="py-2 text-caption text-[var(--color-text-faint)] inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
      ) : loadError ? (
        <div role="alert" className="py-2 text-caption font-medium text-[var(--state-overdue-text)]">Couldn&apos;t load the notes: {loadError}</div>
      ) : notes.length === 0 ? (
        <div className="py-2 text-caption text-[var(--color-text-muted)]">No notes yet. A note you add below shows here.</div>
      ) : (
        // Notes sit on this panel itself (no card inside the card), spaced
        // apart; the words at the reading step of this small panel, who and
        // when one step smaller.
        <ul className="space-y-3 mb-3">
          {notes.map((n) => (
            <li key={n.id} className="group flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <CommentBody text={n.body} currentUserId={userId} className="text-[var(--color-text)] text-body" />
                <div className="text-caption text-[var(--color-text-muted)] mt-0.5">{n.createdByName ?? "-"} · {formatAgo(n.createdAt)}</div>
              </div>
              {String(n.createdBy) === String(userId) && (
                <button
                  onClick={() => void remove(n.id)}
                  className="ui-hit opacity-60 sm:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 transition-opacity p-1 text-[var(--color-text-faint)] hover:text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)] rounded"
                  title="Delete"
                  aria-label="Delete note"
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
            placeholder="Add a note. Type @ to name someone."
            aria-label="New note"
            rows={2}
          />
        </div>
        <button
          onClick={submit}
          disabled={!body.trim() || busy}
          className="ui-hit p-2 rounded bg-[var(--color-ink)] hover:opacity-90 text-[var(--color-ink-fg)] transition-opacity disabled:opacity-50"
          title="Post note"
          aria-label="Post note"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function formatAgo(iso: string | null | undefined): string {
  if (!iso) return "-";
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
