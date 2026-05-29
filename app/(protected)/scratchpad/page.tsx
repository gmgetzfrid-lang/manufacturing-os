"use client";

// /scratchpad — personal scratchpad + open-tasks view.
//
// Two tabs:
//   "Notes" — the embeddable ScratchpadPanel scoped to the user.
//             Standalone notes here are PRIVATE to the author per
//             RLS migration 20260630_scratchpad_private.sql.
//   "Open tasks" — unresolved tasks from notes the user can see:
//                  their own notes (anywhere) plus scoped notes on
//                  shared documents/projects/assets they wrote.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { StickyNote, ListChecks, Loader2, ExternalLink } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listOpenTasks, type Note, type NoteTask, toggleTaskInBody, updateNoteBody } from "@/lib/notes";
import ScratchpadPanel from "@/components/notes/ScratchpadPanel";

type Tab = "notes" | "tasks";

export default function ScratchpadPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const [tab, setTab] = useState<Tab>("notes");

  if (!activeOrgId || !uid) {
    return <div className="p-6 text-sm text-slate-500">No active organization.</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 pb-20">
      <div className="max-w-4xl mx-auto space-y-4">
        <div>
          <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <StickyNote className="w-5 h-5 text-amber-600" /> Scratchpad
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Your personal operational memory — only you can see notes here. Lines starting with <code className="font-mono bg-slate-100 px-1 rounded">- [ ]</code> become tasks you can check off.
          </p>
        </div>

        <div className="flex items-center gap-1 border-b border-slate-200 -mb-px">
          <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>
            <StickyNote className="w-3.5 h-3.5" /> Notes
          </TabButton>
          <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")}>
            <ListChecks className="w-3.5 h-3.5" /> Open Tasks
          </TabButton>
        </div>

        {tab === "notes" && (
          <ScratchpadPanel
            orgId={activeOrgId}
            userId={uid}
            userName={userEmail ?? undefined}
            userEmail={userEmail ?? undefined}
            userRole={activeRole ?? undefined}
            listMaxHeight="60vh"
          />
        )}

        {tab === "tasks" && (
          <OpenTasksList
            orgId={activeOrgId}
            actorUserId={uid}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1 border-b-2 ${
        active ? "border-amber-600 text-amber-700" : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

function OpenTasksList({ orgId, actorUserId }: { orgId: string; actorUserId: string }) {
  const [items, setItems] = useState<{ note: Note; task: NoteTask }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setItems(await listOpenTasks(orgId, actorUserId)); }
    finally { setLoading(false); }
  }, [orgId, actorUserId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onCheck = async (note: Note, lineIndex: number) => {
    setBusy(`${note.id}:${lineIndex}`);
    try {
      const newBody = toggleTaskInBody(note.body, lineIndex);
      await updateNoteBody({ id: note.id, body: newBody, updatedBy: actorUserId });
      await refresh();
    } finally { setBusy(null); }
  };

  if (loading) return <div className="text-xs text-slate-500 py-6 text-center"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" />Loading…</div>;
  if (items.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
        No open tasks across the org. Nice.
      </div>
    );
  }

  // Group by parent note for visual clarity.
  const byNote = new Map<string, { note: Note; tasks: NoteTask[] }>();
  for (const item of items) {
    const e = byNote.get(item.note.id) ?? { note: item.note, tasks: [] };
    e.tasks.push(item.task);
    byNote.set(item.note.id, e);
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
      {Array.from(byNote.values()).map(({ note, tasks }) => (
        <div key={note.id} className="p-3">
          <div className="text-[11px] text-slate-500 mb-1 flex items-center gap-2">
            <span>{formatWhen(note.createdAt)}</span>
            {note.createdByName && <span>· {note.createdByName}</span>}
            {note.documentId && <DeepLink href={`/documents`} label="document" />}
            {note.projectId && <DeepLink href={`/projects/${note.projectId}`} label="project" />}
          </div>
          <div className="space-y-1">
            {tasks.map((t) => (
              <label key={t.lineIndex} className="flex items-start gap-1.5 text-xs text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={false}
                  disabled={busy === `${note.id}:${t.lineIndex}`}
                  onChange={() => onCheck(note, t.lineIndex)}
                  className="mt-[3px]"
                />
                <span>{t.body}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DeepLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-0.5 text-blue-700 hover:text-blue-900">
      <ExternalLink className="w-3 h-3" /> {label}
    </Link>
  );
}

function formatWhen(ts: string): string {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}
