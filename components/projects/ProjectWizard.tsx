"use client";

// ProjectWizard — guided project creation, everything optional but nothing
// forgotten. Six steps: basics (job size sets the defaults), purpose &
// goals, Summary of Work, budget lines, first milestones, and the team.
// Only Basics is required: "Create project" is available from the first
// step, and every later step is optional — but each skip is RECORDED in
// setup_state, and the project coach re-surfaces skipped steps with the
// payoff stated. The wizard is how a project starts; the coach is the
// wizard for the rest of its life.
//
// Nothing typed is silently discarded: the follow-up writes are checked
// (lib/projectWizardWrites), and if any of them is refused the wizard stays
// open naming what did not save, holding the rows for a retry.

import React, { useEffect, useMemo, useState } from "react";
import {
  Briefcase, Loader2, Plus, X, ChevronLeft, ChevronRight, Check,
  Target, FileText, CircleDollarSign, Flag, HardHat, Search, AlertTriangle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { createProject } from "@/lib/projects";
import { seedTurnoverItems } from "@/lib/turnover";
import { listCompanies, type Company } from "@/lib/companies";
import { Field } from "@/components/ui/Field";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  prepareBudgetRows, runWizardFollowUpWrites, summarizeWizardFailures,
  type WizardWriteDeps, type WizardWriteFailure, type WizardWriteInput, type WizardWriteStep,
} from "@/lib/projectWizardWrites";
import type { ProjectVisibility } from "@/types/schema";

const STEPS = [
  { key: "basics", label: "Basics", icon: Briefcase },
  { key: "purpose", label: "Purpose & goals", icon: Target },
  { key: "sow", label: "Summary of Work", icon: FileText },
  { key: "budget", label: "Budget", icon: CircleDollarSign },
  { key: "schedule", label: "Schedule", icon: Flag },
  { key: "team", label: "Team & contractors", icon: HardHat },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

const JOB_KINDS = [
  { v: "small", label: "Small job", hint: "A repair, a swap, a short scope — light paperwork, quick closeout." },
  { v: "standard", label: "Standard project", hint: "A typical maintenance or improvement project — full turnover package." },
  { v: "capital", label: "Capital project", hint: "Major scope, serious money — full quality program, PSSR, strict gates." },
] as const;

export default function ProjectWizard({ orgId, actorUserId, actorEmail, actorRole, onClose, onCreated }: {
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Partial-failure state: the project exists, but these writes were
  // refused. The typed rows stay in state for the retry.
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [failures, setFailures] = useState<WizardWriteFailure[]>([]);
  const [setupStateForRetry, setSetupStateForRetry] = useState<Record<string, string>>({});

  // Basics
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [jobKind, setJobKind] = useState<string>("standard");
  const [moc, setMoc] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [visibility, setVisibility] = useState<ProjectVisibility>("public");
  // Purpose
  const [purpose, setPurpose] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [goalDraft, setGoalDraft] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  // SOW
  const [sowQuery, setSowQuery] = useState("");
  const [sowResults, setSowResults] = useState<Array<{ id: string; label: string }>>([]);
  const [sowDoc, setSowDoc] = useState<{ id: string; label: string } | null>(null);
  // Budget
  const [budgetRows, setBudgetRows] = useState<Array<{ name: string; budget: string; type: string }>>([
    { name: "", budget: "", type: "subcontract" },
  ]);
  // Schedule
  const [milestoneRows, setMilestoneRows] = useState<Array<{ name: string; date: string }>>([
    { name: "", date: "" },
  ]);
  // Team
  const [companies, setCompanies] = useState<Company[]>([]);
  const [partyRows, setPartyRows] = useState<Array<{ name: string; kind: string; trade: string }>>([
    { name: "", kind: "contractor", trade: "" },
  ]);

  useEffect(() => {
    listCompanies(orgId).then(setCompanies).catch(() => setCompanies([]));
  }, [orgId]);

  // SOW search — org documents by number/title, debounced.
  useEffect(() => {
    const q = sowQuery.trim();
    if (q.length < 2) { setSowResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("documents").select("id, document_number, title, name")
        .eq("org_id", orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      setSowResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id),
        label: String(d.document_number || d.title || d.name || "Document"),
      })));
    }, 250);
    return () => clearTimeout(t);
  }, [sowQuery, orgId]);

  const stepKey = STEPS[step].key;
  const budgetPrep = useMemo(() => prepareBudgetRows(budgetRows), [budgetRows]);
  const stepHasContent: Record<StepKey, boolean> = useMemo(() => ({
    basics: !!name.trim() && !!description.trim(),
    purpose: !!purpose.trim() || goals.length > 0 || !!successCriteria.trim(),
    sow: !!sowDoc,
    budget: budgetPrep.accounts.some((r) => r.budget > 0),
    schedule: milestoneRows.some((r) => r.name.trim() && r.date),
    team: partyRows.some((r) => r.name.trim()),
  }), [name, description, purpose, goals, successCriteria, sowDoc, budgetPrep, milestoneRows, partyRows]);
  const basicsValid = !!name.trim() && !!description.trim();

  const next = (didSkip: boolean) => {
    setSkipped((s) => ({ ...s, [stepKey]: didSkip }));
    setError(null);
    if (step < STEPS.length - 1) setStep(step + 1);
    else void finish({ ...skipped, [stepKey]: didSkip });
  };

  /** "Create project" from ANY step: the current step counts as done when
   *  it has content, and every step not reached is recorded as skipped. */
  const createNow = () => {
    setError(null);
    void finish({ ...skipped, [stepKey]: !stepHasContent[stepKey] });
  };

  // The follow-up writes, over the real client. Kept as a builder so the
  // retry re-runs exactly the refused steps with the rows still in state.
  const writeInput = (setupState: Record<string, string>, projectId: string): WizardWriteInput => {
    const byName = new Map(companies.map((c) => [c.name.toLowerCase(), c.id]));
    return {
      orgId, projectId, actorUserId, actorEmail: actorEmail ?? null,
      details: {
        purpose, goals, successCriteria, jobKind,
        sowDocumentId: sowDoc?.id ?? null,
        setupState,
      },
      accounts: budgetPrep.accounts,
      milestones: milestoneRows.filter((r) => r.name.trim() && r.date).map((r) => ({ name: r.name.trim(), date: r.date })),
      parties: partyRows.filter((r) => r.name.trim()).map((r) => ({
        name: r.name.trim(), kind: r.kind, trade: r.trade.trim(),
        companyId: byName.get(r.name.trim().toLowerCase()) ?? null,
      })),
    };
  };
  const writeDeps = (projectId: string): WizardWriteDeps => ({
    updateProject: async (patch) => {
      const { error } = await supabase.from("projects").update(patch).eq("id", projectId);
      return { error: error ? { message: error.message, code: error.code } : null };
    },
    insertRows: async (table, rows) => {
      const { error } = await supabase.from(table).insert(rows);
      return { error: error ? { message: error.message, code: error.code } : null };
    },
    seedTurnover: () => seedTurnoverItems({
      orgId, projectId, jobKind, actor: { uid: actorUserId, email: actorEmail ?? null },
    }),
  });

  const finish = async (finalSkips: Record<string, boolean>) => {
    if (!name.trim()) { setStep(0); setError("Project name is required."); return; }
    if (!description.trim()) { setStep(0); setError("Description is required — say what the team will be doing."); return; }
    if (budgetPrep.invalid.length > 0) {
      setStep(3);
      setError(`Budget amount isn't a number for: ${budgetPrep.invalid.join(", ")}. Type digits (commas and a currency sign are fine).`);
      return;
    }
    setBusy(true); setError(null);
    try {
      const project = await createProject({
        orgId, name, description, mocReference: moc, visibility,
        targetCompletionDate: targetDate ? new Date(targetDate).toISOString() : undefined,
        actorUserId, actorEmail, actorRole,
      });
      const projectId = project.id!;
      setCreatedProjectId(projectId);

      const setupState: Record<string, string> = {};
      for (const s of STEPS) {
        setupState[s.key] = finalSkips[s.key] ? "skipped" : (stepHasContent[s.key] ? "done" : "skipped");
      }
      setSetupStateForRetry(setupState);

      const { failures: failed } = await runWizardFollowUpWrites(writeInput(setupState, projectId), writeDeps(projectId));
      if (failed.length > 0) { setFailures(failed); return; }

      onCreated();
      router.push(`/projects/${projectId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  /** Re-run only the refused writes with the rows still in state. */
  const retryFailed = async () => {
    if (!createdProjectId) return;
    setBusy(true); setError(null);
    try {
      const only = new Set<WizardWriteStep>(failures.map((f) => f.step));
      const { failures: failed } = await runWizardFollowUpWrites(writeInput(setupStateForRetry, createdProjectId), writeDeps(createdProjectId), only);
      setFailures(failed);
      if (failed.length === 0) {
        onCreated();
        router.push(`/projects/${createdProjectId}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const openAnyway = () => {
    if (!createdProjectId) return;
    onCreated();
    router.push(`/projects/${createdProjectId}`);
  };

  /** The header X. In the partial-failure state the project already exists
   *  (the list must show it) and the retained rows are about to be lost, so
   *  the user confirms, and the list refreshes on the way out. */
  const closeWizard = async () => {
    if (failures.length > 0 && createdProjectId) {
      const ok = await appConfirm({
        title: "Close without retrying?",
        message: `The project was created and will appear in the list, but ${summarizeWizardFailures(failures)} did not save and what you typed for ${failures.length === 1 ? "it" : "them"} will be lost. Use "Retry unsaved" or "Open project anyway" to keep it.`,
      });
      if (!ok) return;
      onCreated();
    }
    onClose();
  };

  const Icon = STEPS[step].icon;

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        {/* Header + stepper */}
        <div className="px-6 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--color-accent-soft)] rounded-lg"><Icon className="w-5 h-5 text-[var(--color-accent)]" /></div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-black text-[var(--color-text)] flex items-center gap-2">
                New project — {STEPS[step].label}
                {step > 0 && <span className="text-[10px] font-bold uppercase tracking-wider rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-text-muted)]">Optional</span>}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">
                Step {step + 1} of {STEPS.length}. {step === 0
                  ? "Only this step is required — create the project now, or keep going."
                  : "Skip or fill in — everything here can also be added from the project page later."} Skipped steps come back as coach suggestions, never lost.
              </div>
            </div>
            <button onClick={() => void closeWizard()} disabled={busy} aria-label="Close" className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
          </div>
          <div className="mt-3 flex items-center gap-1">
            {STEPS.map((s, i) => (
              <button key={s.key} onClick={() => i < step && setStep(i)} disabled={i > step}
                className={`h-1.5 flex-1 rounded-full transition-colors ${i < step ? "bg-[var(--color-accent)]" : i === step ? "bg-[var(--color-accent)]/50" : "bg-[var(--color-surface-2)]"}`}
                title={s.label} />
            ))}
          </div>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {failures.length > 0 && createdProjectId && (
            <div role="alert" className="rounded-xl border border-amber-500/50 bg-amber-500/[0.08] p-4 text-xs text-[var(--color-text)]">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                <div className="min-w-0">
                  <div className="font-black">The project was created, but {summarizeWizardFailures(failures)} did not save.</div>
                  <ul className="mt-2 space-y-1">
                    {failures.map((f) => (
                      <li key={f.step}><b>{f.label}</b> — {f.message}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[var(--color-text-muted)]">
                    What you typed is still here. Retry the unsaved parts, or open the project and add them from its tabs later.
                  </p>
                </div>
              </div>
            </div>
          )}
          {failures.length === 0 && step === 0 && (
            <>
              <Field label="Name *">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 Q1 Turnaround — Unit 300" autoFocus
                  className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
              </Field>
              <Field label="Description *">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                  placeholder="What is this project about? What will the team do?"
                  className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y bg-[var(--color-surface)]" />
              </Field>
              <Group label="Job size — sets sensible defaults, never permissions">
                <div className="grid sm:grid-cols-3 gap-2">
                  {JOB_KINDS.map((k) => (
                    <button key={k.v} onClick={() => setJobKind(k.v)}
                      className={`rounded-xl border p-3 text-left transition-colors ${jobKind === k.v ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/50" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>
                      <div className="text-xs font-black text-[var(--color-text)]">{k.label}</div>
                      <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{k.hint}</div>
                    </button>
                  ))}
                </div>
              </Group>
              <div className="grid grid-cols-2 gap-3">
                <Field label="MOC reference (Management of Change)">
                  <input value={moc} onChange={(e) => setMoc(e.target.value)} placeholder="MOC-2026-0142"
                    title="The Management of Change number authorizing this work — required by PSM before modifying covered processes."
                    className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm font-mono bg-[var(--color-surface)]" />
                </Field>
                <Field label="Target completion">
                  <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
                    className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] [color-scheme:light] dark:[color-scheme:dark]" />
                </Field>
              </div>
              <Group label="Visibility">
                <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg">
                  <button onClick={() => setVisibility("public")} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${visibility === "public" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>Public (everyone in org)</button>
                  <button onClick={() => setVisibility("private")} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${visibility === "private" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>Private (members only)</button>
                </div>
              </Group>
            </>
          )}

          {failures.length === 0 && step === 1 && (
            <>
              <StepIntro text="Why does this project exist, and what does 'done well' mean? Everyone who opens the project reads this first — and the AI grounds checklist assessments on it." />
              <Field label="Purpose">
                <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} autoFocus
                  placeholder="e.g. Replace the corroded E-301 exchanger circuits before they force an unplanned outage."
                  className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y bg-[var(--color-surface)]" />
              </Field>
              <Group label="Goals">
                <div className="space-y-1.5">
                  {goals.map((g, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs rounded-lg border border-[var(--color-border)] px-2.5 py-1.5">
                      <Target className="w-3 h-3 text-[var(--color-accent)] shrink-0" />
                      <span className="flex-1 text-[var(--color-text)]">{g}</span>
                      <button onClick={() => setGoals(goals.filter((_, j) => j !== i))} aria-label={`Remove goal: ${g}`} className="text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <input value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && goalDraft.trim()) { setGoals([...goals, goalDraft.trim()]); setGoalDraft(""); } }}
                      aria-label="Add a goal" placeholder="Add a goal and press Enter — e.g. Zero recordables"
                      className="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
                    <button onClick={() => { if (goalDraft.trim()) { setGoals([...goals, goalDraft.trim()]); setGoalDraft(""); } }}
                      aria-label="Add goal" className="p-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)]"><Plus className="w-4 h-4" /></button>
                  </div>
                </div>
              </Group>
              <Field label="Success criteria">
                <textarea value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} rows={2}
                  placeholder="e.g. Back in service by June 30, within 5% of budget, turnover package accepted."
                  className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y bg-[var(--color-surface)]" />
              </Field>
            </>
          )}

          {failures.length === 0 && step === 2 && (
            <>
              <StepIntro text="Attach the Summary of Work — the scope document. It feeds RFQs, grounds the AI's checklist assessment, and anchors the project report. Pick one from document control (upload it there first if it isn't in yet)." />
              {sowDoc ? (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/[0.06] px-3 py-2.5 text-sm">
                  <FileText className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="font-bold text-[var(--color-text)] truncate">{sowDoc.label}</span>
                  <button onClick={() => setSowDoc(null)} aria-label="Remove Summary of Work" className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                </div>
              ) : (
                <div>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
                    <input value={sowQuery} onChange={(e) => setSowQuery(e.target.value)} autoFocus
                      aria-label="Search documents by number or title" placeholder="Search documents by number or title…"
                      className="w-full pl-9 pr-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
                  </div>
                  {sowResults.length > 0 && (
                    <ul className="mt-2 rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                      {sowResults.map((d) => (
                        <li key={d.id}>
                          <button onClick={() => setSowDoc(d)} className="w-full px-3 py-2 text-left text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                            <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          {failures.length === 0 && step === 3 && (
            <>
              <StepIntro text="Budget lines are where money lives — 'Piping subcontract', 'Scaffolding', 'Engineering hours'. Even one line unlocks the burn bar, the S-curve, and the finish-cost forecast." />
              <div className="space-y-2">
                {budgetRows.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={r.name} onChange={(e) => setBudgetRows(rows(budgetRows, i, { name: e.target.value }))}
                      aria-label={`Budget line ${i + 1} name`} placeholder="Budget line name" className="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
                    <select value={r.type} onChange={(e) => setBudgetRows(rows(budgetRows, i, { type: e.target.value }))}
                      aria-label={`Budget line ${i + 1} cost type`} className="px-2 py-2 border border-[var(--color-border-strong)] rounded-lg text-xs bg-[var(--color-surface)]">
                      {["subcontract", "labor", "material", "equipment", "other"].map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <input value={r.budget} onChange={(e) => setBudgetRows(rows(budgetRows, i, { budget: e.target.value }))}
                      aria-label={`Budget line ${i + 1} amount (USD)`} placeholder="Budget (USD)" inputMode="decimal"
                      aria-invalid={!!r.name.trim() && budgetPrep.invalid.includes(r.name.trim()) ? true : undefined}
                      className={`w-32 px-3 py-2 border rounded-lg text-sm font-mono tabular-nums bg-[var(--color-surface)] ${!!r.name.trim() && budgetPrep.invalid.includes(r.name.trim()) ? "border-rose-500" : "border-[var(--color-border-strong)]"}`} />
                    <button onClick={() => setBudgetRows(budgetRows.filter((_, j) => j !== i))} aria-label={`Remove budget line ${i + 1}`} className="text-[var(--color-text-faint)] hover:text-rose-600 p-1"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => setBudgetRows([...budgetRows, { name: "", budget: "", type: "subcontract" }])}
                  className="inline-flex items-center gap-1 text-xs font-bold text-[var(--color-accent)]"><Plus className="w-3.5 h-3.5" /> Add line</button>
                {budgetPrep.invalid.length > 0 && (
                  <div className="text-[11px] font-bold text-rose-700 dark:text-rose-300">
                    Amount isn&apos;t a number for: {budgetPrep.invalid.join(", ")}. Digits only — commas and a currency sign are fine (1,200,000).
                  </div>
                )}
              </div>
            </>
          )}

          {failures.length === 0 && step === 4 && (
            <>
              <StepIntro text="A few dated milestones are enough to start — they unlock the schedule board, overdue alerts, and the planned-pace line on the cost curve. Import a full P6/MS Project XML later from the Schedule tab." />
              <div className="space-y-2">
                {milestoneRows.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={r.name} onChange={(e) => setMilestoneRows(rows(milestoneRows, i, { name: e.target.value }))}
                      aria-label={`Milestone ${i + 1} name`} placeholder={i === 0 ? "e.g. Mobilize" : i === 1 ? "e.g. Demo complete" : "Milestone"}
                      className="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
                    <input type="date" value={r.date} onChange={(e) => setMilestoneRows(rows(milestoneRows, i, { date: e.target.value }))}
                      aria-label={`Milestone ${i + 1} planned date`} className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] [color-scheme:light] dark:[color-scheme:dark]" />
                    <button onClick={() => setMilestoneRows(milestoneRows.filter((_, j) => j !== i))} aria-label={`Remove milestone ${i + 1}`} className="text-[var(--color-text-faint)] hover:text-rose-600 p-1"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => setMilestoneRows([...milestoneRows, { name: "", date: "" }])}
                  className="inline-flex items-center gap-1 text-xs font-bold text-[var(--color-accent)]"><Plus className="w-3.5 h-3.5" /> Add milestone</button>
              </div>
            </>
          )}

          {failures.length === 0 && step === 5 && (
            <>
              <StepIntro text="Who's working this job? Pick from your Known Companies registry (their performance record follows them) or type a new name. Teammate invites live on the project's Members tab." />
              <div className="space-y-2">
                {partyRows.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={r.name} onChange={(e) => setPartyRows(rows(partyRows, i, { name: e.target.value }))}
                      list="wizard-companies" aria-label={`Company ${i + 1} name`} placeholder="Company name"
                      className="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
                    <select value={r.kind} onChange={(e) => setPartyRows(rows(partyRows, i, { kind: e.target.value }))}
                      aria-label={`Company ${i + 1} kind`} className="px-2 py-2 border border-[var(--color-border-strong)] rounded-lg text-xs bg-[var(--color-surface)]">
                      {["contractor", "vendor", "rental", "internal"].map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    <input value={r.trade} onChange={(e) => setPartyRows(rows(partyRows, i, { trade: e.target.value }))}
                      aria-label={`Company ${i + 1} trade`} placeholder="Trade" className="w-32 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
                    <button onClick={() => setPartyRows(partyRows.filter((_, j) => j !== i))} aria-label={`Remove company ${i + 1}`} className="text-[var(--color-text-faint)] hover:text-rose-600 p-1"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                <datalist id="wizard-companies">
                  {companies.map((c) => <option key={c.id} value={c.name} />)}
                </datalist>
                <button onClick={() => setPartyRows([...partyRows, { name: "", kind: "contractor", trade: "" }])}
                  className="inline-flex items-center gap-1 text-xs font-bold text-[var(--color-accent)]"><Plus className="w-3.5 h-3.5" /> Add company</button>
              </div>
            </>
          )}

          {error && (
            <div role="alert" className="flex items-start gap-2 p-3 rounded-lg border border-rose-500/40 bg-rose-500/[0.07] text-xs font-bold text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center gap-2">
          {failures.length > 0 && createdProjectId ? (
            <span className="ml-auto flex items-center gap-2">
              <button onClick={openAnyway} disabled={busy}
                className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50">
                Open project anyway
              </button>
              <button onClick={() => void retryFailed()} disabled={busy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Retry unsaved
              </button>
            </span>
          ) : (
            <>
              {step > 0 && (
                <button onClick={() => setStep(step - 1)} disabled={busy}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                  <ChevronLeft className="w-3.5 h-3.5" /> Back
                </button>
              )}
              <span className="ml-auto flex items-center gap-2">
                {step > 0 && !stepHasContent[stepKey] && (
                  <button onClick={() => next(true)} disabled={busy}
                    className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                    Skip for now
                  </button>
                )}
                {step < STEPS.length - 1 && (
                  <button onClick={() => next(false)} disabled={busy || (step === 0 && !basicsValid)}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border disabled:opacity-50 ${step === 0
                      ? "text-[var(--color-text)] bg-[var(--color-surface)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                      : "text-[var(--color-accent-fg)] bg-[var(--color-accent)] border-transparent hover:bg-[var(--color-accent-hover)]"}`}>
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* Always reachable: Basics alone makes a project (UX-12). */}
                <button onClick={createNow} disabled={busy || !basicsValid}
                  title={basicsValid ? "Create the project now — later steps can be done from the project page" : "Name and description are required"}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black disabled:opacity-50 ${step === 0 || step === STEPS.length - 1
                    ? "text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]"
                    : "text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Create project
                </button>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function rows<T>(arr: T[], i: number, patch: Partial<T>): T[] {
  return arr.map((r, j) => (j === i ? { ...r, ...patch } : r));
}

/** A labelled GROUP of controls (button groups, list editors) — a
 *  `<label>` may wrap exactly one control, so these get role="group" with
 *  the visible label as the accessible name. Single inputs use the shared
 *  components/ui/Field, which wraps the control inside its label. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <div role="group" aria-labelledby={id}>
      <div id={id} className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function StepIntro({ text }: { text: string }) {
  return <p className="text-xs text-[var(--color-text-muted)]">{text}</p>;
}
