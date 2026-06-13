"use client";

// BulkCheckoutToProjectModal — bulk-checkout N documents in a single
// submit. Two top-level paths:
//
//   - Ad-hoc: no project required. Just a purpose. Useful for
//     procedures, policies, one-off edits. 24h auto-expiry like single-
//     doc ad-hoc checkouts.
//   - Project: attach to an existing or new project. No auto-expiry.
//
// Reused by:
//   - Library multi-select bulk action bar
//   - MultiDocViewer (staged book) "Check Out All" button

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  X, Briefcase, FileText, Loader2, AlertTriangle, ChevronRight,
  Lock, Globe, Wand2,
} from "lucide-react";
import { listProjects, bulkCheckoutToProject } from "@/lib/projects";
import type { Project, DocumentRecord, ProjectVisibility } from "@/types/schema";
import IsoGuidance from "@/components/ui/IsoGuidance";

interface BulkCheckoutToProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  docs: DocumentRecord[];
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole: string;
  /** Called once the bulk checkout commits. projectId is null for ad-hoc bulk. */
  onSuccess?: (info: { projectId: string | null; checkedOutCount: number; skippedCount: number }) => void;
}

export default function BulkCheckoutToProjectModal({
  isOpen, onClose, docs, orgId, actorUserId, actorEmail, actorRole, onSuccess,
}: BulkCheckoutToProjectModalProps) {
  const router = useRouter();
  // Top-level kind. "adhoc" is the default since most operator checkouts
  // (procedures, policy edits) aren't project work.
  const [kind, setKind] = useState<"adhoc" | "project">("adhoc");
  const [choice, setChoice] = useState<"new" | "existing">("new");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");

  // New-project fields
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [moc, setMoc] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [visibility, setVisibility] = useState<ProjectVisibility>("public");

  // Shared checkout details
  const [mode, setMode] = useState<"view" | "markup" | "edit">("edit");
  const [purpose, setPurpose] = useState("");
  const [expectedReleaseAt, setExpectedReleaseAt] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the user's active visible projects when the modal opens
  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        const list = await listProjects({
          orgId,
          status: "active",
          visibleToUserId: actorUserId,
        });
        setProjects(list);
        if (list.length > 0) setSelectedProjectId(list[0].id!);
      } catch (e) {
        console.error("Failed to load projects", e);
      }
    })();
    // Reset on open
    setError(null);
  }, [isOpen, orgId, actorUserId]);

  // Surface which docs are already locked by someone else so the user knows
  // they'll be skipped.
  const conflicts = useMemo(() => {
    return docs.filter((d) => d.checkedOutBy && d.checkedOutBy !== actorUserId);
  }, [docs, actorUserId]);

  if (!isOpen) return null;

  const submit = async () => {
    setError(null);
    if (kind === "project") {
      if (choice === "new") {
        if (!name.trim()) return setError("Project name is required");
        if (!description.trim()) return setError("Project description is required — explain what the team will be doing");
      } else {
        if (!selectedProjectId) return setError("Pick a project to attach these checkouts to");
      }
    }
    if (!purpose.trim()) return setError("Purpose is required so the team knows why these are checked out");

    setBusy(true);
    try {
      const result = await bulkCheckoutToProject({
        orgId,
        docs: docs.map((d) => ({
          id: d.id!,
          libraryId: d.libraryId!,
          documentNumber: d.documentNumber,
          title: d.title || d.name,
          activeCollaborators: d.activeCollaborators,
          checkedOutBy: d.checkedOutBy ?? null,
          currentLockId: d.currentLockId ?? null,
        })),
        mode,
        purpose,
        expectedReleaseAt: expectedReleaseAt || undefined,
        existingProjectId: kind === "project" && choice === "existing" ? selectedProjectId : undefined,
        newProject: kind === "project" && choice === "new"
          ? { name, description, visibility, mocReference: moc, targetCompletionDate: targetDate ? new Date(targetDate).toISOString() : undefined }
          : undefined,
        actorUserId,
        actorEmail,
        actorRole,
      });
      onSuccess?.({
        projectId: result.projectId,
        checkedOutCount: result.checkedOutCount,
        skippedCount: result.skipped.length,
      });
      // For project checkouts, send the user to the project so they see
      // the result of their work. For ad-hoc, stay on the library.
      if (result.projectId) router.push(`/projects/${result.projectId}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className={`p-2 rounded-lg ${kind === "adhoc" ? "bg-emerald-100" : "bg-indigo-100"}`}>
            {kind === "adhoc"
              ? <Wand2 className="w-5 h-5 text-emerald-700" />
              : <Briefcase className="w-5 h-5 text-indigo-700" />}
          </div>
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">
              Bulk checkout · {docs.length} document{docs.length === 1 ? "" : "s"}
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {kind === "adhoc"
                ? "Quick checkout — no project required. Auto-expires in 24h if you forget to check back in."
                : "Attach all checkouts to the same project so the team knows they belong together."}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Kind toggle */}
        <div className="px-6 pt-4">
          <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg">
            <button
              onClick={() => setKind("adhoc")}
              className={`flex-1 py-1.5 text-xs font-bold rounded-md inline-flex items-center justify-center gap-1.5 ${kind === "adhoc" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
            >
              <Wand2 className="w-3 h-3" /> Ad-hoc (no project)
            </button>
            <button
              onClick={() => setKind("project")}
              className={`flex-1 py-1.5 text-xs font-bold rounded-md inline-flex items-center justify-center gap-1.5 ${kind === "project" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
            >
              <Briefcase className="w-3 h-3" /> Project
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Docs being checked out */}
          <div>
            <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-2">
              Documents ({docs.length})
            </div>
            <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg max-h-40 overflow-y-auto divide-y divide-[var(--color-border)]">
              {docs.map((d) => {
                const conflict = d.checkedOutBy && d.checkedOutBy !== actorUserId;
                return (
                  <div key={d.id} className="px-3 py-2 flex items-center gap-2 text-xs">
                    <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                    <span className="font-mono font-bold text-[var(--color-text)] truncate">{d.documentNumber || "—"}</span>
                    <span className="text-[var(--color-text-muted)] truncate">{d.title || d.name}</span>
                    {conflict && (
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                        <AlertTriangle className="w-3 h-3" /> already locked
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {conflicts.length > 0 && (
              <div className="mt-2 text-[10px] text-amber-700">
                {conflicts.length} document{conflicts.length === 1 ? " is" : "s are"} locked by other users and will be skipped. You can request markups from them after.
              </div>
            )}
          </div>

          {/* Project tabs — only when kind === project */}
          {kind === "project" && (
          <div>
            <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-1.5">Project</div>
            <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg mb-3">
              <button
                onClick={() => setChoice("new")}
                className={`flex-1 py-1.5 text-xs font-bold rounded-md ${choice === "new" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
              >New Project</button>
              <button
                onClick={() => setChoice("existing")}
                disabled={projects.length === 0}
                className={`flex-1 py-1.5 text-xs font-bold rounded-md ${choice === "existing" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"} disabled:opacity-40 disabled:cursor-not-allowed`}
              >Existing</button>
            </div>

            {choice === "new" ? (
              <div className="space-y-2 bg-indigo-50/40 border border-indigo-200 rounded-lg p-3">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Project name * (e.g. 2026 Q1 Turnaround)"
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                />
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description * — what's the team going to do with these documents?"
                  rows={3}
                  className="w-full px-3 py-2 border border-[var(--color-border)] rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none resize-y"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={moc}
                    onChange={(e) => setMoc(e.target.value)}
                    placeholder="MOC reference"
                    className="px-3 py-1.5 border border-[var(--color-border)] rounded-md text-xs"
                  />
                  <input
                    type="date"
                    value={targetDate}
                    onChange={(e) => setTargetDate(e.target.value)}
                    className="px-3 py-1.5 border border-[var(--color-border)] rounded-md text-xs"
                  />
                </div>
                <div className="flex bg-[var(--color-surface)] p-1 rounded-md border border-[var(--color-border)]">
                  <button onClick={() => setVisibility("public")} className={`flex-1 py-1 text-[10px] font-bold rounded ${visibility === "public" ? "bg-indigo-600 text-white" : "text-[var(--color-text-muted)]"}`}>
                    <Globe className="inline w-3 h-3 mr-1" />Public
                  </button>
                  <button onClick={() => setVisibility("private")} className={`flex-1 py-1 text-[10px] font-bold rounded ${visibility === "private" ? "bg-slate-700 text-white" : "text-[var(--color-text-muted)]"}`}>
                    <Lock className="inline w-3 h-3 mr-1" />Private
                  </button>
                </div>
              </div>
            ) : (
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm bg-[var(--color-surface)] focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                {projects.length === 0 && <option value="">No active projects — switch to New</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.visibility === "private" ? " (private)" : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
          )}

          {/* Shared checkout details */}
          <div>
            <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-1.5">Mode (applied to all)</div>
            <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg">
              {(["view", "markup", "edit"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 py-1.5 text-xs font-bold rounded-md capitalize ${mode === m ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
                >{m}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest inline-flex items-center gap-1">
              Purpose *
              <IsoGuidance topic="checkout_purpose" />
            </label>
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="What are you doing with these files?"
              className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Expected release (optional)</label>
            <input
              type="date"
              value={expectedReleaseAt ? expectedReleaseAt.slice(0, 10) : ""}
              onChange={(e) => setExpectedReleaseAt(e.target.value ? new Date(e.target.value).toISOString() : "")}
              className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm"
            />
            <div className="text-[10px] text-[var(--color-text-muted)] mt-1">
              Stale checkouts past this date surface a warning bar to the whole team.
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
          <button
            onClick={submit}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-60 ${
              kind === "adhoc" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {busy ? "Checking out…" : `Checkout ${docs.length} doc${docs.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
