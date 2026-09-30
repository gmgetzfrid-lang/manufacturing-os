"use client";

// EditProjectModal — projects were immutable after creation (a typo in the
// name was permanent). Owner/controller edit of the identity fields, with
// before/after audited via updateProjectMeta — plus the four fields the
// wizard alone used to write (purpose, goals, success criteria, Summary of
// Work). Those were unrecoverable once the wizard closed, and the coach
// kept asking for them with nowhere to put them (projects-tab UX-1/UX-6).

import React, { useEffect, useState } from "react";
import { X, Loader2, Check, Pencil, Lock, Globe, Target, Plus, FileText, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { updateProjectMeta } from "@/lib/projects";
import { logAuditAction } from "@/lib/audit";
import { invalidateProjectSnapshot } from "@/lib/projectSnapshot";
import type { Project, ProjectVisibility } from "@/types/schema";

interface WizardFields {
  purpose: string;
  goals: string[];
  successCriteria: string;
  sowDocumentId: string | null;
}

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
  // The identity patch that already reached the database, if the second
  // write (the wizard's fields) then failed: Save again retries only that
  // second write, and closing the modal refreshes the page so the header
  // shows what was saved.
  const [savedIdentity, setSavedIdentity] = useState<string | null>(null);

  // The wizard's fields — the typed Project doesn't carry them, so they
  // are read here. `before` is what was stored, for the audit row.
  const [before, setBefore] = useState<WizardFields | null>(null);
  const [fieldsLoadError, setFieldsLoadError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [goalDraft, setGoalDraft] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [sowDoc, setSowDoc] = useState<{ id: string; label: string } | null>(null);
  const [sowQuery, setSowQuery] = useState("");
  const [sowResults, setSowResults] = useState<Array<{ id: string; label: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: readErr } = await supabase.from("projects")
        .select("purpose, goals, success_criteria, sow_document_id")
        .eq("id", project.id!).maybeSingle();
      if (cancelled) return;
      if (readErr) {
        // Pre-migration DB or a refused read: say so rather than offering
        // blank fields that would overwrite what is stored.
        setFieldsLoadError(readErr.message);
        return;
      }
      const row = (data ?? {}) as Record<string, unknown>;
      const loaded: WizardFields = {
        purpose: (row.purpose as string | null) ?? "",
        goals: Array.isArray(row.goals) ? (row.goals as string[]) : [],
        successCriteria: (row.success_criteria as string | null) ?? "",
        sowDocumentId: (row.sow_document_id as string | null) ?? null,
      };
      setBefore(loaded);
      setPurpose(loaded.purpose);
      setGoals(loaded.goals);
      setSuccessCriteria(loaded.successCriteria);
      if (loaded.sowDocumentId) {
        // The attachment is set the moment the fields are editable — a save
        // during the label lookup must not write sow_document_id = null.
        const sowId = loaded.sowDocumentId;
        setSowDoc({ id: sowId, label: "Document" });
        const { data: doc } = await supabase.from("documents").select("id, document_number, title, name")
          .eq("id", sowId).maybeSingle();
        if (cancelled) return;
        const d = (doc ?? {}) as Record<string, unknown>;
        const label = String(d.document_number || d.title || d.name || "Document");
        setSowDoc((cur) => (cur && cur.id === sowId ? { id: sowId, label } : cur));
      }
    })();
    return () => { cancelled = true; };
  }, [project.id]);

  // SOW search — org documents by number/title, debounced (same as the wizard).
  useEffect(() => {
    const q = sowQuery.trim();
    if (q.length < 2) { setSowResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("documents").select("id, document_number, title, name")
        .eq("org_id", project.orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      setSowResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id),
        label: String(d.document_number || d.title || d.name || "Document"),
      })));
    }, 250);
    return () => clearTimeout(t);
  }, [sowQuery, project.orgId]);

  const addGoal = () => {
    const g = goalDraft.trim();
    if (!g) return;
    setGoals([...goals, g]);
    setGoalDraft("");
  };

  /** Closing after a partial save still refreshes the page (onSaved), so
   *  the header never shows a name the database no longer holds. */
  const close = () => { if (savedIdentity) onSaved(); else onClose(); };

  const save = async () => {
    if (!name.trim()) { setError("Project name can't be empty."); return; }
    setBusy(true); setError(null);
    try {
      const patch = {
        name: name.trim(),
        description: description.trim() || null,
        mocReference: moc.trim() || null,
        targetCompletionDate: target || null,
        visibility,
      };
      // Skip only when this exact patch already landed (a retry after the
      // second write failed); an identity field edited since is written.
      const patchKey = JSON.stringify(patch);
      if (savedIdentity !== patchKey) {
        await updateProjectMeta({ projectId: project.id!, patch, actorUserId, actorEmail, actorRole });
        setSavedIdentity(patchKey);
      }

      // The wizard's fields — only when they were readable (never overwrite
      // stored values with blanks from a failed read) and only when changed.
      if (before) {
        const after: WizardFields = {
          purpose: purpose.trim(),
          goals,
          successCriteria: successCriteria.trim(),
          sowDocumentId: sowDoc?.id ?? null,
        };
        const changed = after.purpose !== before.purpose
          || after.successCriteria !== before.successCriteria
          || after.sowDocumentId !== before.sowDocumentId
          || JSON.stringify(after.goals) !== JSON.stringify(before.goals);
        if (changed) {
          const { error: extErr } = await supabase.from("projects").update({
            purpose: after.purpose || null,
            goals: after.goals.length > 0 ? after.goals : null,
            success_criteria: after.successCriteria || null,
            sow_document_id: after.sowDocumentId,
            updated_at: new Date().toISOString(),
            updated_by: actorUserId,
          }).eq("id", project.id!);
          if (extErr) throw new Error(`Name, description, MOC, target date and visibility were saved, but purpose / goals / Summary of Work were not: ${extErr.message}. Save changes retries just those.`);
          await logAuditAction({
            action: "PROJECT_UPDATED",
            resourceId: project.id!, resourceType: "project",
            orgId: project.orgId, userId: actorUserId,
            userEmail: actorEmail, userRole: actorRole,
            details: { before, after, fields: ["purpose", "goals", "success_criteria", "sow_document_id"] },
          });
        }
      }
      // No later snapshot request may be answered from a round issued
      // before this write (lib/projectSnapshot memo).
      invalidateProjectSnapshot(project.orgId, project.id!);
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const labelClass = "text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]";
  const inputClass = "mt-1 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none";

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-in fade-in" onClick={close} />
      <div className="relative w-full max-w-lg max-h-[85dvh] overflow-y-auto bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-2">
          <Pencil className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-black text-[var(--color-text)]">Edit project</span>
          <button onClick={close} aria-label="Close" className="ml-auto p-1 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block">
            <span className={labelClass}>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} h-9`} />
          </label>
          <label className="block">
            <span className={labelClass}>Description</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={`${inputClass} py-2 resize-y`} />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className={labelClass}>MOC reference</span>
              <input value={moc} onChange={(e) => setMoc(e.target.value)} className={`${inputClass} h-9 font-mono`} />
            </label>
            <label className="block">
              <span className={labelClass}>Target completion</span>
              <input type="date" value={target} onChange={(e) => setTarget(e.target.value)} className={`${inputClass} h-9 [color-scheme:light] dark:[color-scheme:dark]`} />
            </label>
          </div>
          <div>
            <span className={labelClass}>Visibility</span>
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

          {/* The wizard's fields — editable here so nothing typed at creation is permanent. */}
          <div className="pt-2 border-t border-[var(--color-border)]">
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Purpose, goals &amp; scope</div>
            {fieldsLoadError && (
              <div role="status" className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                These fields could not be read ({fieldsLoadError}) — they are left untouched by this save.
              </div>
            )}
          </div>
          {before && (
            <>
              <label className="block">
                <span className={labelClass}>Purpose</span>
                <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2}
                  placeholder="Why does this project exist?" className={`${inputClass} py-2 resize-y`} />
              </label>
              <div role="group" aria-labelledby="edit-project-goals">
                <span id="edit-project-goals" className={labelClass}>Goals</span>
                <div className="mt-1 space-y-1.5">
                  {goals.map((g, i) => (
                    <div key={`${i}-${g}`} className="flex items-center gap-2 text-xs rounded-lg border border-[var(--color-border)] px-2.5 py-1.5">
                      <Target className="w-3 h-3 text-[var(--color-accent)] shrink-0" />
                      <span className="flex-1 text-[var(--color-text)]">{g}</span>
                      <button onClick={() => setGoals(goals.filter((_, j) => j !== i))} aria-label={`Remove goal: ${g}`} className="text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <input value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGoal(); } }}
                      aria-label="Add a goal" placeholder="Add a goal and press Enter"
                      className="flex-1 h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
                    <button onClick={addGoal} aria-label="Add goal" className="p-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)]"><Plus className="w-4 h-4" /></button>
                  </div>
                </div>
              </div>
              <label className="block">
                <span className={labelClass}>Success criteria</span>
                <textarea value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} rows={2}
                  placeholder="What does 'done well' mean?" className={`${inputClass} py-2 resize-y`} />
              </label>
              <div role="group" aria-labelledby="edit-project-sow">
                <span id="edit-project-sow" className={labelClass}>Summary of Work</span>
                {sowDoc ? (
                  <div className="mt-1 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/[0.06] px-3 py-2 text-sm">
                    <FileText className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="font-bold text-[var(--color-text)] truncate">{sowDoc.label}</span>
                    <button onClick={() => setSowDoc(null)} aria-label="Remove Summary of Work" className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <div className="mt-1">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
                      <input value={sowQuery} onChange={(e) => setSowQuery(e.target.value)}
                        aria-label="Search documents by number or title" placeholder="Search documents by number or title…"
                        className="w-full h-9 pl-9 pr-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
                    </div>
                    {sowResults.length > 0 && (
                      <ul className="mt-2 rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                        {sowResults.map((d) => (
                          <li key={d.id}>
                            <button onClick={() => { setSowDoc(d); setSowQuery(""); }} className="w-full px-3 py-2 text-left text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                              <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {error && <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/[0.07] px-3 py-2 text-xs font-bold text-rose-700 dark:text-rose-300">{error}</div>}
        </div>
        <div className="px-5 py-3.5 border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={close} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5">{savedIdentity ? "Close" : "Cancel"}</button>
          <button onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
