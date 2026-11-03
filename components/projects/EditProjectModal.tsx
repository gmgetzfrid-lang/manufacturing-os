"use client";

// EditProjectModal — projects were immutable after creation (a typo in the
// name was permanent). Owner/controller edit of the identity fields, with
// before/after audited via updateProjectMeta. The new-project wizard's own
// fields (purpose, goals, success criteria, job size, Summary of Work) and
// the start date are here too, so a step skipped in the wizard can be
// filled in later instead of the coach asking for it forever.

import React, { useEffect, useState } from "react";
import { X, Loader2, Check, Pencil, Lock, Globe, Plus, Target, FileText, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { updateProjectMeta } from "@/lib/projects";
import type { Project, ProjectVisibility } from "@/types/schema";
import TimeZoneSelect from "@/components/projects/TimeZoneSelect";
import { DEFAULT_SCHEDULE_TZ, normalizeTimeZone, tzLabel } from "@/lib/scheduleTz";

const JOB_KINDS = [
  { v: "small", label: "Small job" },
  { v: "standard", label: "Standard project" },
  { v: "capital", label: "Capital project" },
] as const;

/** A stored instant as the calendar day it reads on this device. */
function localDay(v: unknown): string {
  const t = v ? Date.parse(String(v)) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const inputCls = "mt-1 w-full h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none";
const areaCls = "mt-1 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-2 text-sm resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none";
const labelCls = "text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]";

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
  const originalTz = normalizeTimeZone(project.timezone);
  const [timezone, setTimezone] = useState<string>(originalTz);
  // On a zone change, keep "8:00" reading 8:00 at the plant (re-anchor the
  // stored instants) — the expected outcome when correcting the zone.
  const [keepWallClock, setKeepWallClock] = useState(true);
  const tzChanged = timezone !== originalTz;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When the work started: set when the project was made, correctable here.
  const originalStart = localDay(project.startedAt);
  const [start, setStart] = useState(originalStart);

  // The wizard's fields, read when the modal opens (the typed Project
  // doesn't carry them). Absent columns (before 20261013): not shown.
  const [wizardLoaded, setWizardLoaded] = useState<"loading" | "ok" | "missing">("loading");
  const [purpose, setPurpose] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [goalDraft, setGoalDraft] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [jobKind, setJobKind] = useState<string>(project.jobKind ?? "standard");
  const [sowDoc, setSowDoc] = useState<{ id: string; label: string } | null>(null);
  const [sowQuery, setSowQuery] = useState("");
  const [sowResults, setSowResults] = useState<Array<{ id: string; label: string }>>([]);
  const [original, setOriginal] = useState<{ purpose: string; goals: string[]; success: string; jobKind: string; sowId: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const { data, error: e } = await supabase.from("projects")
        .select("purpose, goals, success_criteria, job_kind, sow_document_id").eq("id", project.id!).maybeSingle();
      if (!live) return;
      if (e || !data) { setWizardLoaded("missing"); return; }
      const r = data as { purpose: string | null; goals: unknown; success_criteria: string | null; job_kind: string | null; sow_document_id: string | null };
      const g = Array.isArray(r.goals) ? r.goals.filter((x): x is string => typeof x === "string") : [];
      setPurpose(r.purpose ?? ""); setGoals(g); setSuccessCriteria(r.success_criteria ?? "");
      setJobKind(r.job_kind ?? "standard");
      setOriginal({ purpose: r.purpose ?? "", goals: g, success: r.success_criteria ?? "", jobKind: r.job_kind ?? "standard", sowId: r.sow_document_id });
      if (r.sow_document_id) {
        const { data: d } = await supabase.from("documents").select("id, document_number, title, name").eq("id", r.sow_document_id).maybeSingle();
        const doc = d as Record<string, unknown> | null;
        if (live) setSowDoc({ id: r.sow_document_id, label: String(doc?.document_number || doc?.title || doc?.name || "Document") });
      }
      if (live) setWizardLoaded("ok");
    })();
    return () => { live = false; };
  }, [project.id]);

  // Summary of Work search: org documents by number or title.
  useEffect(() => {
    const q = sowQuery.trim().replace(/[,().\\%]/g, " ").replace(/\s+/g, " ").trim();
    if (q.length < 2) { setSowResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase.from("documents").select("id, document_number, title, name")
        .eq("org_id", project.orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      setSowResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"),
      })));
    }, 250);
    return () => clearTimeout(t);
  }, [sowQuery, project.orgId]);

  const addGoal = () => { if (goalDraft.trim()) { setGoals((g) => [...g, goalDraft.trim()]); setGoalDraft(""); } };

  const save = async () => {
    if (!name.trim()) { setError("Project name can't be empty."); return; }
    setBusy(true); setError(null);
    // Only what changed is written, so an untouched field never overwrites
    // a colleague's edit made meanwhile.
    const allGoals = goalDraft.trim() ? [...goals, goalDraft.trim()] : goals;
    const wizard = wizardLoaded === "ok" && original ? {
      ...(purpose !== original.purpose ? { purpose } : {}),
      ...(JSON.stringify(allGoals) !== JSON.stringify(original.goals) ? { goals: allGoals } : {}),
      ...(successCriteria !== original.success ? { successCriteria } : {}),
      ...(jobKind !== original.jobKind ? { jobKind } : {}),
      ...((sowDoc?.id ?? null) !== original.sowId ? { sowDocumentId: sowDoc?.id ?? null } : {}),
    } : {};
    try {
      await updateProjectMeta({
        projectId: project.id!,
        patch: {
          name: name.trim(),
          description: description.trim() || null,
          mocReference: moc.trim() || null,
          targetCompletionDate: target || null,
          visibility,
          timezone: timezone === DEFAULT_SCHEDULE_TZ ? null : timezone,
          // Midday UTC: the same calendar day wherever it's read.
          ...(start && start !== originalStart ? { startedAt: `${start}T12:00:00.000Z` } : {}),
          ...wizard,
        },
        keepWallClock,
        actorUserId, actorEmail, actorRole,
      });
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-in fade-in" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[85dvh] overflow-y-auto bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-2xl animate-in fade-in zoom-in-95 duration-150">
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
            <label className="block">
              <span className={labelCls}>Start date</span>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={`${inputCls} [color-scheme:light] dark:[color-scheme:dark]`} />
            </label>
            {wizardLoaded === "ok" && (
              <label className="block">
                <span className={labelCls}>Job size</span>
                <select value={jobKind} onChange={(e) => setJobKind(e.target.value)} className={inputCls} title="Sets the turnover package and defaults, never permissions">
                  {JOB_KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
                </select>
              </label>
            )}
          </div>
          {wizardLoaded === "ok" && (
            <>
              <label className="block">
                <span className={labelCls}>Purpose</span>
                <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} placeholder="Why the project exists, e.g. Replace the corroded E-301 circuits before they force an outage." className={areaCls} />
              </label>
              <div>
                <span className={labelCls}>Goals</span>
                <div className="mt-1 space-y-1.5">
                  {goals.map((g, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs rounded-lg border border-[var(--color-border)] px-2.5 py-1.5">
                      <Target className="w-3 h-3 text-[var(--color-accent)] shrink-0" />
                      <input value={g} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Goal ${i + 1}`}
                        className="flex-1 min-w-0 bg-transparent text-[var(--color-text)] outline-none" />
                      <button type="button" onClick={() => setGoals(goals.filter((_, j) => j !== i))} aria-label="Remove goal" className="p-1 text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <input value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGoal(); } }}
                      placeholder="Add a goal, e.g. Zero recordables" className="flex-1 h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm" />
                    <button type="button" onClick={addGoal} aria-label="Add goal" className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)]"><Plus className="w-4 h-4" /></button>
                  </div>
                </div>
              </div>
              <label className="block">
                <span className={labelCls}>Success criteria</span>
                <textarea value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} rows={2} placeholder="What done well means, e.g. Back in service by June 30, within 5% of budget." className={areaCls} />
              </label>
              <div>
                <span className={labelCls}>Summary of Work</span>
                {sowDoc ? (
                  <div className="mt-1 flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/[0.06] px-2.5 py-2 text-sm">
                    <FileText className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="font-bold text-[var(--color-text)] truncate">{sowDoc.label}</span>
                    <button type="button" onClick={() => setSowDoc(null)} className="ml-auto px-2 py-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-rose-600">Change</button>
                  </div>
                ) : (
                  <div className="mt-1">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
                      <input value={sowQuery} onChange={(e) => setSowQuery(e.target.value)} placeholder="Find the scope document by number or title…"
                        className="w-full h-9 pl-8 pr-2.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
                    </div>
                    {sowResults.length > 0 && (
                      <ul className="mt-1 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                        {sowResults.map((d) => (
                          <li key={d.id}>
                            <button type="button" onClick={() => { setSowDoc(d); setSowQuery(""); setSowResults([]); }}
                              className="w-full px-3 py-2 text-left text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                              <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">From document control - upload it there first if it isn&apos;t in yet.</div>
                  </div>
                )}
              </div>
            </>
          )}
          {wizardLoaded === "missing" && (
            <div className="text-[10px] text-[var(--color-text-faint)]">Purpose, goals, success criteria, job size and the Summary of Work need the database update 20261013_project_controls_program.sql.</div>
          )}
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Plant timezone</span>
            <TimeZoneSelect value={timezone} onChange={setTimezone} className="mt-1" />
            <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">
              Every schedule date, calendar day and shift is shown and entered in this zone, for everyone on the project.
              {originalTz === DEFAULT_SCHEDULE_TZ && !tzChanged && " Currently UTC - pick the plant's zone so evening work lands on the right day."}
            </div>
            {tzChanged && (
              <label className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                <input type="checkbox" checked={keepWallClock} onChange={(e) => setKeepWallClock(e.target.checked)} className="mt-0.5" />
                <span>
                  <b>Keep the schedule&apos;s times as written</b> - a task at 8:00 ({tzLabel(originalTz)}) becomes 8:00 ({tzLabel(timezone)}).
                  Untick to keep the exact instants instead, so the clock readings shift by the zone difference.
                </span>
              </label>
            )}
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
