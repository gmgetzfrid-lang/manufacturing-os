"use client";

// EditProjectModal — projects were immutable after creation (a typo in the
// name was permanent). Owner/controller edit of the identity fields, with
// before/after audited via updateProjectMeta.

import React, { useState } from "react";
import { X, Loader2, Check, Pencil, Lock, Globe } from "lucide-react";
import { updateProjectMeta } from "@/lib/projects";
import type { Project, ProjectVisibility } from "@/types/schema";

export default function EditProjectModal({ project, actorUserId, actorEmail, actorRole, onClose, onSaved }: {
  project: Project;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [moc, setMoc] = useState(project.mocReference ?? "");
  const [target, setTarget] = useState(
    project.targetCompletionDate ? String(project.targetCompletionDate).slice(0, 10) : "",
  );
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility ?? "public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) { setError("Project name can't be empty."); return; }
    setBusy(true); setError(null);
    try {
      await updateProjectMeta({
        projectId: project.id!,
        patch: {
          name: name.trim(),
          description: description.trim() || null,
          mocReference: moc.trim() || null,
          targetCompletionDate: target || null,
          visibility,
        },
        actorUserId, actorEmail, actorRole,
      });
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-in fade-in" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-2">
          <Pencil className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-black text-[var(--color-text)]">Edit project</span>
          <button onClick={onClose} className="ml-auto p-1 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
          </label>
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Description</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-2 text-sm resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">MOC reference</span>
              <input value={moc} onChange={(e) => setMoc(e.target.value)} className="mt-1 w-full h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm font-mono focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Target completion</span>
              <input type="date" value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1 w-full h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm [color-scheme:light] dark:[color-scheme:dark] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
            </label>
          </div>
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Visibility</span>
            <div className="mt-1 inline-flex items-center rounded-xl border border-[var(--color-border)] p-0.5 gap-0.5">
              {([
                { v: "public" as const, label: "Public", Icon: Globe },
                { v: "private" as const, label: "Private", Icon: Lock },
              ]).map(({ v, label, Icon }) => (
                <button
                  key={v}
                  onClick={() => setVisibility(v)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${visibility === v
                    ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
            </div>
            {visibility === "private" && (
              <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">Only members, the owner, and Document Control can see private projects.</div>
            )}
          </div>
          {error && <div className="rounded-lg border border-rose-500/40 bg-rose-500/[0.07] px-3 py-2 text-xs font-bold text-rose-700 dark:text-rose-300">{error}</div>}
        </div>
        <div className="px-5 py-3.5 border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5">Cancel</button>
          <button onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
