"use client";

// ProjectWizard — guided project creation, everything optional but nothing
// forgotten. Six steps: basics (job size sets the defaults), purpose &
// goals, Summary of Work, budget lines, first milestones, and the team.
// Every step past basics is skippable — impatient users click through in
// twenty seconds — but each skip is RECORDED in setup_state, and the
// project coach re-surfaces skipped steps with the payoff stated. The
// wizard is how a project starts; the coach is the wizard for the rest of
// its life.
//
// Start from a document: drop the AFE / estimate / budget sheet on Basics
// and every later step arrives prefilled — name, purpose, goals, budget
// lines with the company each is budgeted for, those companies, and any
// dated milestones. The user still walks the steps and edits; the paper is
// kept on the project as its budget basis.

import React, { useEffect, useMemo, useState } from "react";
import TimeZoneSelect from "@/components/projects/TimeZoneSelect";
import { browserTimeZone, fromDateInput } from "@/lib/scheduleTz";
import {
  Plus, X, ChevronLeft, ChevronRight, Check, FileText, Search, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { FieldError } from "@/components/ui/Field";
import { field as fieldCls, label as labelCls } from "@/components/admin/kit";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { createProject } from "@/lib/projects";
import { seedTurnoverItems } from "@/lib/turnover";
import { PROJECT_TYPES, projectTypeOf, isDefaultType } from "@/lib/projectType";
import { saveProjectType } from "@/lib/shiftTimesStore";
import { listCompanies, type Company } from "@/lib/companies";
import type { ProjectVisibility } from "@/types/schema";
import { BudgetDocDrop } from "@/components/projects/cost/BudgetImport";
import { recordBudgetBasis, suppliersOf, partyKindFor, type BudgetReadResult } from "@/lib/budgetImport";
import { projectPrefillFrom, reconcileBudget, matchParty, sameCompany, COST_TYPES, type CostType } from "@/lib/budgetDoc";
import { fmtMoney } from "@/lib/costs";
import StepPath from "@/components/ui/StepPath";
import { useDraft } from "@/hooks/useDraft";
import { appAlert } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";

// Steps by topic, then a review of every answer before the project is made.
const STEPS = [
  { key: "basics", label: "Basics" },
  { key: "purpose", label: "Purpose & goals" },
  { key: "sow", label: "Summary of Work" },
  { key: "budget", label: "Budget" },
  { key: "schedule", label: "Schedule" },
  { key: "team", label: "Team & contractors" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];
/** The last screen: every answer, each with a way back to change it. */
const REVIEW = STEPS.length;
const PATH = [...STEPS.map((s) => s.label), "Review"];

const JOB_KINDS = [
  { v: "small", label: "Small job", hint: "A repair, a swap, a short scope: light paperwork, quick closeout." },
  { v: "standard", label: "Standard project", hint: "A typical maintenance or improvement project: full turnover package." },
  { v: "capital", label: "Capital project", hint: "Major scope, serious money: full quality program, PSSR, strict gates." },
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

  // Basics
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [jobKind, setJobKind] = useState<string>("standard");
  // The kind of project (Setup › Project type): read from the name until
  // picked; "Other" saves nothing.
  const [kindPick, setKindPick] = useState<string | null>(null);
  const [moc, setMoc] = useState("");
  const [targetDate, setTargetDate] = useState("");
  // The plant's zone — prefilled from this device, which is usually at the
  // plant when a project is set up. Editable later under Edit project.
  const [timezone, setTimezone] = useState<string>(() => browserTimeZone());
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
  const [sowError, setSowError] = useState(false);
  // Budget
  const [budgetRows, setBudgetRows] = useState<Array<{ name: string; budget: string; type: string; supplier: string }>>([
    { name: "", budget: "", type: "subcontract", supplier: "" },
  ]);
  // The document the project was started from (its budget basis).
  const [fromDoc, setFromDoc] = useState<BudgetReadResult | null>(null);
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

  // Basics checked when the person leaves a field (never while typing).
  const [touched, setTouched] = useState<{ name?: boolean; description?: boolean }>({});

  // What they've typed, on every step, comes back if the page reloads or
  // they close it; so does the step they were on.
  type Typed = {
    name: string; description: string; purpose: string; successCriteria: string; goals: string[];
    step?: number; jobKind?: string; kindPick?: string | null; moc?: string; targetDate?: string; timezone?: string; visibility?: ProjectVisibility;
    budgetRows?: typeof budgetRows; milestoneRows?: typeof milestoneRows; partyRows?: typeof partyRows; skipped?: Record<string, boolean>;
  };
  const typed = useMemo<Typed>(() => ({ name, description, purpose, successCriteria, goals, step, jobKind, kindPick, moc, targetDate, timezone, visibility, budgetRows, milestoneRows, partyRows, skipped }),
    [name, description, purpose, successCriteria, goals, step, jobKind, kindPick, moc, targetDate, timezone, visibility, budgetRows, milestoneRows, partyRows, skipped]);
  const draft = useDraft<Typed>(`new-project:${orgId}`, typed, (v) => {
    setName(v.name ?? ""); setDescription(v.description ?? ""); setPurpose(v.purpose ?? "");
    setSuccessCriteria(v.successCriteria ?? ""); setGoals(Array.isArray(v.goals) ? v.goals : []);
    if (typeof v.step === "number" && v.step >= 0 && v.step <= REVIEW) setStep(v.step);
    if (v.jobKind) setJobKind(v.jobKind);
    if (v.kindPick !== undefined) setKindPick(v.kindPick);
    if (typeof v.moc === "string") setMoc(v.moc);
    if (typeof v.targetDate === "string") setTargetDate(v.targetDate);
    if (v.timezone) setTimezone(v.timezone);
    if (v.visibility) setVisibility(v.visibility);
    if (Array.isArray(v.budgetRows) && v.budgetRows.length) setBudgetRows(v.budgetRows);
    if (Array.isArray(v.milestoneRows) && v.milestoneRows.length) setMilestoneRows(v.milestoneRows);
    if (Array.isArray(v.partyRows) && v.partyRows.length) setPartyRows(v.partyRows);
    if (v.skipped) setSkipped(v.skipped);
  }, (v) => !v.name?.trim() && !v.description?.trim() && !v.purpose?.trim() && !v.successCriteria?.trim() && !(v.goals?.length)
    && !v.moc?.trim() && !v.targetDate && !(v.budgetRows ?? []).some((r) => r.name.trim()) && !(v.milestoneRows ?? []).some((r) => r.name.trim()) && !(v.partyRows ?? []).some((r) => r.name.trim()));

  const prefillFromDoc = (r: BudgetReadResult) => {
    const doc = r.parsed;
    const f = projectPrefillFrom(doc);
    // Fill what's empty; never overwrite what the user already typed.
    if (!name.trim() && f.name) setName(f.name);
    if (!description.trim() && f.description) setDescription(f.description);
    if (!moc.trim() && f.mocReference) setMoc(f.mocReference);
    if (!targetDate && f.targetDate) setTargetDate(f.targetDate);
    if (!purpose.trim() && f.purpose) setPurpose(f.purpose);
    if (goals.length === 0 && f.goals.length) setGoals(f.goals);
    if (!successCriteria.trim() && f.successCriteria) setSuccessCriteria(f.successCriteria);
    if (doc.lines.length && !budgetRows.some((b) => b.name.trim())) {
      setBudgetRows(doc.lines.map((l) => ({
        name: l.name, budget: l.amount != null ? String(l.amount) : "", type: l.costType, supplier: l.supplier ?? "",
      })));
    }
    if (doc.milestones.length && !milestoneRows.some((m) => m.name.trim())) {
      setMilestoneRows(doc.milestones.map((m) => ({ name: m.name, date: m.date })));
    }
    const sups = suppliersOf(doc.lines);
    if (sups.length && !partyRows.some((p) => p.name.trim())) {
      setPartyRows(sups.map((sp) => ({
        // Prefer the registry's spelling so the company record links.
        name: companies.find((c) => sameCompany(c.name, sp.name))?.name ?? sp.name,
        kind: partyKindFor(sp.types), trade: "",
      })));
    }
    if (doc.docType && /capital/i.test(doc.docType)) setJobKind("capital");
    setFromDoc(r);
  };

  // SOW search — org documents by number/title, debounced.
  useEffect(() => {
    const q = sowQuery.trim();
    if (q.length < 2) { setSowResults([]); setSowError(false); return; }
    const t = setTimeout(async () => {
      const { data, error: sErr } = await supabase
        .from("documents").select("id, document_number, title, name")
        .eq("org_id", orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      setSowError(!!sErr);
      setSowResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id),
        label: String(d.document_number || d.title || d.name || "Document"),
      })));
    }, 250);
    return () => clearTimeout(t);
  }, [sowQuery, orgId]);

  const stepKey: StepKey | null = step < REVIEW ? STEPS[step].key : null;
  const basicsOk = !!name.trim() && !!description.trim();
  const stepHasContent: Record<StepKey, boolean> = useMemo(() => ({
    basics: !!name.trim() && !!description.trim(),
    purpose: !!purpose.trim() || goals.length > 0 || !!successCriteria.trim(),
    sow: !!sowDoc,
    budget: budgetRows.some((r) => r.name.trim() && Number(r.budget) > 0),
    schedule: milestoneRows.some((r) => r.name.trim() && r.date),
    team: partyRows.some((r) => r.name.trim()),
  }), [name, description, purpose, goals, successCriteria, sowDoc, budgetRows, milestoneRows, partyRows]);

  const next = (didSkip: boolean) => {
    setError(null);
    if (step === REVIEW) { void finish(skipped); return; }
    if (step === 0 && !basicsOk) { setTouched({ name: true, description: true }); return; }
    if (stepKey) setSkipped((s) => ({ ...s, [stepKey]: didSkip }));
    setStep(step + 1);
  };

  const finish = async (finalSkips: Record<string, boolean>) => {
    if (!name.trim()) { setStep(0); setError("Project name is required."); return; }
    if (!description.trim()) { setStep(0); setError("Add a description: what the team will be doing."); return; }
    setBusy(true); setError(null);
    try {
      const project = await createProject({
        orgId, name, description, mocReference: moc, visibility, timezone,
        targetCompletionDate: targetDate ? new Date(targetDate).toISOString() : undefined,
        actorUserId, actorEmail, actorRole,
      });
      const projectId = project.id!;
      // The project exists from here. Anything below that doesn't save is
      // told afterwards, so it can be added on the project.
      const problems: string[] = [];

      // Wizard fields — tolerant of a pre-migration DB: the project exists
      // either way, the coach just has less to work with.
      const setupState: Record<string, string> = {};
      for (const s of STEPS) {
        setupState[s.key] = finalSkips[s.key] ? "skipped" : (stepHasContent[s.key] ? "done" : "skipped");
      }
      const { error: extErr } = await supabase.from("projects").update({
        purpose: purpose.trim() || null,
        goals: goals.length > 0 ? goals : null,
        success_criteria: successCriteria.trim() || null,
        job_kind: jobKind,
        sow_document_id: sowDoc?.id ?? null,
        setup_state: setupState,
      }).eq("id", projectId);
      if (extErr && extErr.code !== "PGRST204" && extErr.code !== "42703") {
        problems.push(`purpose, goals and Summary of Work (${extErr.message})`);
      }

      // Contractors/vendors — linked to the Known Companies registry when
      // the name matches, so performance rolls up to the permanent record.
      // Saved BEFORE budget lines so each line can point at its company.
      let savedParties: Array<{ id: string; name: string }> = [];
      const parties = partyRows.filter((r) => r.name.trim());
      if (parties.length > 0) {
        const rows = parties.map((r) => ({
          org_id: orgId, project_id: projectId,
          name: r.name.trim(), kind: r.kind, trade: r.trade.trim() || null,
          company_id: companies.find((c) => sameCompany(c.name, r.name))?.id ?? null,
          created_by: actorUserId,
        }));
        const { data: pData, error: pErr } = await supabase.from("project_parties").insert(rows).select("id, name");
        if (pErr && (pErr.code === "PGRST204" || pErr.code === "42703")) {
          // Pre-migration: company_id doesn't exist yet — save without the link.
          const { data: retry, error: retryErr } = await supabase.from("project_parties")
            .insert(rows.map(({ company_id: _c, ...rest }) => rest)).select("id, name");
          if (retryErr) problems.push(`contractors (${retryErr.message})`);
          savedParties = (retry ?? []) as Array<{ id: string; name: string }>;
        } else if (pErr) {
          problems.push(`contractors (${pErr.message})`);
        } else {
          savedParties = (pData ?? []) as Array<{ id: string; name: string }>;
        }
      }

      // Budget lines. A named row with a blank amount still saves (budget 0)
      // — typed input is never silently discarded.
      const accounts = budgetRows.filter((r) => r.name.trim() && Number(r.budget || 0) >= 0);
      if (accounts.length > 0) {
        const { error: accErr } = await supabase.from("cost_accounts").insert(accounts.map((r) => ({
          org_id: orgId, project_id: projectId,
          name: r.name.trim(), budget: Number(r.budget || 0), cost_type: r.type,
          currency: fromDoc?.parsed.currency ?? "USD",
          party_id: matchParty(r.supplier.trim() || null, savedParties)?.id ?? null,
          created_by: actorUserId,
        })));
        if (accErr) problems.push(`budget lines (${accErr.message})`);
      }

      // The paper this project was started from — kept as its budget basis.
      if (fromDoc) {
        const basis = await recordBudgetBasis({
          orgId, projectId, parsed: fromDoc.parsed, source: fromDoc.source,
          actor: { uid: actorUserId, email: actorEmail ?? null },
        }).catch((e) => ({ docId: null, error: sayError(e) }));
        if (basis.error) problems.push(`the budget document (${basis.error})`);
      }

      // First milestones.
      const ms = milestoneRows.filter((r) => r.name.trim() && r.date);
      if (ms.length > 0) {
        await supabase.from("milestones").insert(ms.map((r) => ({
          org_id: orgId, project_id: projectId,
          name: r.name.trim(), planned_at: fromDateInput(r.date, timezone, 12) ?? new Date(`${r.date}T12:00:00`).toISOString(),
          status: "planned", created_by: actorUserId,
        }))).then(({ error: msErr }) => { if (msErr) problems.push(`milestones (${msErr.message})`); },
          (e) => { problems.push(`milestones (${sayError(e)})`); });
      }

      // The kind of project, as picked (or read from the name): the
      // Projects page groups by it and the reports say it.
      {
        const guessed = projectTypeOf(null, name);
        const word = kindPick ?? (isDefaultType(guessed) ? (jobKind === "capital" ? "Capital project" : null) : guessed.word);
        const t = word && word !== "Other" ? PROJECT_TYPES.find((x) => x.word === word) : null;
        if (t) await saveProjectType(projectId, t).catch((e) => { problems.push(`the kind of project (${sayError(e)})`); });
      }

      // Turnover package seeds, sized to the job. Failure is non-fatal —
      // the Quality tab can seed on demand.
      const seeded = await seedTurnoverItems({
        orgId, projectId, jobKind, actor: { uid: actorUserId, email: actorEmail ?? null },
      }).catch((e) => ({ ok: false, error: sayError(e) }));
      if (!seeded.ok) problems.push(`the turnover list (${seeded.error ?? "not saved"})`);

      draft.clear();
      onCreated();
      router.push(`/projects/${projectId}`);
      if (problems.length) {
        void appAlert({ tone: "danger", message: `The project was made, but these didn't save: ${problems.join("; ")}. Add them on the project.` });
      }
    } catch (e) {
      setError(sayError(e));
    } finally { setBusy(false); }
  };

  // Escape closes, like the X (not while it's saving).
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [busy, onClose]);

  // A row of inputs that wraps on a phone; each input 16 px there.
  const rowIn = `${fieldCls} !w-auto min-w-0`;
  const removeBtn = "shrink-0 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)]";
  const addLink = "inline-flex items-center gap-1.5 min-h-9 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2";
  const choice = (on: boolean) => `rounded-lg border text-left transition-colors ${on ? "border-[var(--color-current)] ring-1 ring-inset ring-[var(--color-current)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] hover:border-[var(--color-border-control)] bg-[var(--color-surface)]"}`;
  const guessedKind = projectTypeOf(null, name);
  const kindNow = kindPick ?? (isDefaultType(guessedKind) ? (jobKind === "capital" ? "Capital project" : "Other") : guessedKind.word);
  const budgetLines = budgetRows.filter((r) => r.name.trim());
  const budgetSum = budgetLines.reduce((t, r) => t + (Number(r.budget) || 0), 0);
  const msLines = milestoneRows.filter((r) => r.name.trim() && r.date);
  const partyLines = partyRows.filter((r) => r.name.trim());
  // Why Next can't be pressed yet, said beside it.
  const blocked = step === 0 && !basicsOk
    ? (!name.trim() && !description.trim() ? "Add a name and a description to go on." : !name.trim() ? "Add a name to go on." : "Add a description to go on.")
    : null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="new-project-title" className="fixed inset-0 z-[200] bg-[var(--color-ink)]/55 flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="ui-float ui-float-in w-full max-w-2xl bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        {/* Where you are: the title, the step by name, and the path of steps. */}
        <div className="px-6 pt-4 pb-4 border-b border-[var(--color-border)]">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h2 id="new-project-title" className="font-display text-section font-semibold text-[var(--color-text)]">New project</h2>
              <p className="mt-0.5 text-body text-[var(--color-text-muted)]">
                <span className="max-sm:hidden font-medium text-[var(--color-text)]">Step {step + 1} of {PATH.length}: {PATH[step]}. </span>
                {step === REVIEW ? "Check it, then make the project." : step === 0 ? "Only this step is needed." : "Optional: skip it and it comes back on the project."}
                {draft.restored && step === 0 ? " What you typed before is back." : ""}
              </p>
            </div>
            <button onClick={onClose} disabled={busy} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
          </div>
          <StepPath className="mt-4 max-sm:mt-2" steps={PATH} current={step} onPick={(i) => { if (!busy) { setError(null); setStep(i); } }} />
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[60vh] overflow-y-auto">
          {step === 0 && (
            <>
              {fromDoc ? (
                <FromDocSummary result={fromDoc} onClear={() => setFromDoc(null)} />
              ) : (
                <BudgetDocDrop orgId={orgId} onRead={prefillFromDoc} compact
                  label="Start from an AFE, estimate or budget sheet to fill in every step" />
              )}
              <div>
                <label htmlFor="np-name" className={labelCls}>Name</label>
                <input id="np-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  placeholder="e.g. 2026 Q1 Turnaround, Unit 300" autoFocus autoComplete="off"
                  aria-invalid={touched.name && !name.trim() ? true : undefined} aria-describedby={touched.name && !name.trim() ? "np-name-err" : undefined}
                  className={fieldCls} />
                {touched.name && !name.trim() && <FieldError id="np-name-err">Give the project a name people will recognize.</FieldError>}
              </div>
              <div>
                <label htmlFor="np-desc" className={labelCls}>Description</label>
                <textarea id="np-desc" value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, description: true }))} rows={2}
                  placeholder="e.g. Clean and inspect the Transmix exchangers for a one-year run"
                  aria-invalid={touched.description && !description.trim() ? true : undefined} aria-describedby={touched.description && !description.trim() ? "np-desc-err" : undefined}
                  className={`${fieldCls} !h-auto min-h-[4.5rem] py-2 resize-y`} />
                {touched.description && !description.trim() && <FieldError id="np-desc-err">Say in a line what the team will do.</FieldError>}
              </div>
              <fieldset>
                <legend className={labelCls}>Kind of project</legend>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Kind of project">
                  {[...PROJECT_TYPES.map((t) => t.word), "Other"].map((w) => (
                    <button key={w} type="button" role="radio" aria-checked={kindNow === w} onClick={() => setKindPick(w)}
                      className={`${choice(kindNow === w)} inline-flex items-center gap-1.5 h-9 pointer-coarse:h-11 px-3 text-body ${kindNow === w ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                      {kindNow === w && <Check className="w-4 h-4 text-[var(--color-current)]" />}{w}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className={labelCls}>Job size</legend>
                <div className="grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Job size">
                  {JOB_KINDS.map((k) => (
                    <button key={k.v} type="button" role="radio" aria-checked={jobKind === k.v} onClick={() => setJobKind(k.v)} className={`${choice(jobKind === k.v)} p-3`}>
                      <div className="text-body font-medium text-[var(--color-text)]">{k.label}</div>
                      <div className="text-body leading-snug text-[var(--color-text-muted)] mt-0.5">{k.hint}</div>
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="grid sm:grid-cols-2 gap-x-4 gap-y-5">
                <div>
                  <label htmlFor="np-moc" className={labelCls}>MOC number <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label>
                  <input id="np-moc" value={moc} onChange={(e) => setMoc(e.target.value)} placeholder="e.g. MOC-2026-0142" autoComplete="off"
                    title="The Management of Change number authorizing this work. PSM requires it before covered processes are changed."
                    className={`${fieldCls} font-display tabular-nums`} />
                </div>
                <div>
                  <label htmlFor="np-target" className={labelCls}>Target completion <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label>
                  <input id="np-target" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
                    className={`${fieldCls} [color-scheme:light] dark:[color-scheme:dark]`} />
                </div>
              </div>
              <div>
                <span className={labelCls}>Plant time zone</span>
                <TimeZoneSelect value={timezone} onChange={setTimezone} />
                <p className="mt-1.5 text-body text-[var(--color-text-muted)]">Everyone on the project sees days, times and shifts in this zone.</p>
              </div>
              <fieldset>
                <legend className={labelCls}>Who can see it</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  {([["public", "Everyone in the workspace"], ["private", "Members only"]] as const).map(([v, l]) => (
                    <label key={v} className={`inline-flex items-center gap-2 min-h-9 pointer-coarse:min-h-11 text-body cursor-pointer ${visibility === v ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                      <input type="radio" name="np-visibility" checked={visibility === v} onChange={() => setVisibility(v)} className="w-4 h-4 accent-[var(--color-current)]" />{l}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          )}

          {step === 1 && (
            <>
              <StepIntro text="Why this job, and what does done well look like?" />
              <div>
                <label htmlFor="np-purpose" className={labelCls}>Purpose</label>
                <textarea id="np-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} autoFocus
                  placeholder="e.g. Replace the corroded E-301 exchanger circuits before they force an unplanned outage."
                  className={`${fieldCls} !h-auto min-h-[4.5rem] py-2 resize-y`} />
              </div>
              <div>
                <label htmlFor="np-goal" className={labelCls}>Goals</label>
                {goals.length > 0 && (
                  <ul className="mb-2 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                    {goals.map((g, i) => (
                      <li key={i} className="flex items-center gap-2 py-1.5 text-body">
                        <span className="flex-1 text-[var(--color-text)]">{g}</span>
                        <button type="button" onClick={() => setGoals(goals.filter((_, j) => j !== i))} aria-label={`Remove goal: ${g}`} className={removeBtn}><X className="w-4 h-4" /></button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center gap-2">
                  <input id="np-goal" value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && goalDraft.trim()) { e.preventDefault(); setGoals([...goals, goalDraft.trim()]); setGoalDraft(""); } }}
                    placeholder="e.g. Zero recordables"
                    className={`${fieldCls} flex-1`} />
                  <Button variant="secondary" disabled={!goalDraft.trim()} title={!goalDraft.trim() ? "Type a goal first" : undefined}
                    onClick={() => { if (goalDraft.trim()) { setGoals([...goals, goalDraft.trim()]); setGoalDraft(""); } }}>
                    <Plus className="w-4 h-4" /> Add
                  </Button>
                </div>
              </div>
              <div>
                <label htmlFor="np-success" className={labelCls}>Success criteria</label>
                <textarea id="np-success" value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} rows={2}
                  placeholder="e.g. Back in service by June 30, within 5% of budget, turnover package accepted."
                  className={`${fieldCls} !h-auto min-h-[4.5rem] py-2 resize-y`} />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <StepIntro text="Pick the Summary of Work from document control. Not uploaded yet? Skip and add it later." />
              {sowDoc ? (
                <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border-strong)] px-3 py-2.5 text-body">
                  <FileText className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <span className="font-medium text-[var(--color-text)] truncate">{sowDoc.label}</span>
                  <button type="button" onClick={() => setSowDoc(null)} className={`ml-auto ${addLink}`}>Change</button>
                </div>
              ) : (
                <div>
                  <label htmlFor="np-sow" className={labelCls}>Find the document</label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
                    <input id="np-sow" value={sowQuery} onChange={(e) => setSowQuery(e.target.value)} autoFocus
                      placeholder="Number or title, e.g. SOW-300"
                      className={`${fieldCls} pl-9`} />
                  </div>
                  {sowError && <ErrorNote compact className="mt-2" title="Couldn't search documents." next="Try again in a moment." />}
                  {sowResults.length > 0 && (
                    <ul className="mt-2 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                      {sowResults.map((d) => (
                        <li key={d.id}>
                          <button type="button" onClick={() => setSowDoc(d)} className="w-full px-3 min-h-10 pointer-coarse:min-h-11 text-left text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                            <FileText className="w-4 h-4 text-[var(--color-text-faint)]" /> {d.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <StepIntro text={fromDoc
                ? `Read from ${fromDoc.source.fileName}. Check each line. The company on a line is who it was budgeted for.`
                : "One line is enough to start, e.g. Piping subcontract, Scaffolding, Engineering hours."} />
              <div className="space-y-3">
                {budgetRows.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input value={r.name} onChange={(e) => setBudgetRows(rows(budgetRows, i, { name: e.target.value }))}
                      aria-label={`Budget line ${i + 1}`} placeholder="Budget line, e.g. Scaffolding" className={`${rowIn} flex-1 basis-48`} />
                    <select value={r.type} onChange={(e) => setBudgetRows(rows(budgetRows, i, { type: e.target.value as CostType }))}
                      aria-label={`Cost type for line ${i + 1}`} className={`${rowIn} w-36 px-2`}>
                      {COST_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                    </select>
                    <input value={r.supplier} onChange={(e) => setBudgetRows(rows(budgetRows, i, { supplier: e.target.value }))}
                      list="wizard-line-companies" placeholder="Company" aria-label={`Company for line ${i + 1}`}
                      title="Who this line is budgeted for: their invoices go to it"
                      className={`${rowIn} w-36`} />
                    <input value={r.budget} onChange={(e) => setBudgetRows(rows(budgetRows, i, { budget: e.target.value }))}
                      placeholder="USD" inputMode="decimal" aria-label={`Budget for line ${i + 1}, USD`}
                      className={`${rowIn} w-32 text-right font-display tabular-nums`} />
                    <button type="button" onClick={() => setBudgetRows(budgetRows.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`} className={removeBtn}><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <datalist id="wizard-line-companies">
                  {[...new Set([...partyRows.map((p) => p.name.trim()).filter(Boolean), ...companies.map((c) => c.name)])].map((n) => <option key={n} value={n} />)}
                </datalist>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => setBudgetRows([...budgetRows, { name: "", budget: "", type: "subcontract", supplier: "" }])}
                    className={addLink}><Plus className="w-4 h-4" /> Add line</button>
                  <BudgetTotal rows={budgetRows} authorized={fromDoc?.parsed.authorizedAmount ?? null} currency={fromDoc?.parsed.currency ?? "USD"} />
                </div>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <StepIntro text="A few dated milestones are enough. Import the full P6 or MS Project schedule later on Plan." />
              <div className="space-y-3">
                {milestoneRows.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input value={r.name} onChange={(e) => setMilestoneRows(rows(milestoneRows, i, { name: e.target.value }))}
                      aria-label={`Milestone ${i + 1}`}
                      placeholder={i === 0 ? "e.g. Mobilize" : i === 1 ? "e.g. Demo complete" : "Milestone"}
                      className={`${rowIn} flex-1 basis-48`} />
                    <input type="date" value={r.date} onChange={(e) => setMilestoneRows(rows(milestoneRows, i, { date: e.target.value }))}
                      aria-label={`Date for milestone ${i + 1}`}
                      className={`${rowIn} w-44 [color-scheme:light] dark:[color-scheme:dark]`} />
                    <button type="button" onClick={() => setMilestoneRows(milestoneRows.filter((_, j) => j !== i))} aria-label={`Remove milestone ${i + 1}`} className={removeBtn}><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <button type="button" onClick={() => setMilestoneRows([...milestoneRows, { name: "", date: "" }])}
                  className={addLink}><Plus className="w-4 h-4" /> Add milestone</button>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <StepIntro text="Which companies are working this job? Teammates are added later on Members." />
              <div className="space-y-3">
                {partyRows.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input value={r.name} onChange={(e) => setPartyRows(rows(partyRows, i, { name: e.target.value }))}
                      list="wizard-companies" placeholder="Company name" aria-label={`Company ${i + 1}`}
                      className={`${rowIn} flex-1 basis-48`} />
                    <select value={r.kind} onChange={(e) => setPartyRows(rows(partyRows, i, { kind: e.target.value }))}
                      aria-label={`What company ${i + 1} is`} className={`${rowIn} w-36 px-2`}>
                      {["contractor", "vendor", "rental", "internal"].map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
                    </select>
                    <input value={r.trade} onChange={(e) => setPartyRows(rows(partyRows, i, { trade: e.target.value }))}
                      aria-label={`Trade for company ${i + 1}`} placeholder="Trade, e.g. Scaffold" className={`${rowIn} w-40`} />
                    <button type="button" onClick={() => setPartyRows(partyRows.filter((_, j) => j !== i))} aria-label={`Remove company ${i + 1}`} className={removeBtn}><X className="w-4 h-4" /></button>
                  </div>
                ))}
                <datalist id="wizard-companies">
                  {companies.map((c) => <option key={c.id} value={c.name} />)}
                </datalist>
                <button type="button" onClick={() => setPartyRows([...partyRows, { name: "", kind: "contractor", trade: "" }])}
                  className={addLink}><Plus className="w-4 h-4" /> Add company</button>
              </div>
            </>
          )}

          {step === REVIEW && (
            // Every answer, each with a way back to its step.
            <dl className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)] text-body">
              {([
                [0, "Basics", <>
                  <span className="block font-medium text-[var(--color-text)]">{name.trim() || "No name yet"}</span>
                  <span className="block text-[var(--color-text-muted)]">{description.trim() || "No description yet"}</span>
                  <span className="block text-[var(--color-text-muted)]">{[kindNow, JOB_KINDS.find((k) => k.v === jobKind)?.label, moc.trim() ? `MOC ${moc.trim()}` : null, targetDate ? `Target ${targetDate}` : null, visibility === "private" ? "Members only" : "Everyone in the workspace", timezone].filter(Boolean).join(" · ")}</span>
                </>],
                [1, "Purpose & goals", stepHasContent.purpose ? <>
                  {purpose.trim() && <span className="block text-[var(--color-text)]">{purpose.trim()}</span>}
                  {goals.length > 0 && <span className="block text-[var(--color-text-muted)]">{goals.length} goal{goals.length === 1 ? "" : "s"}: {goals.join("; ")}</span>}
                  {successCriteria.trim() && <span className="block text-[var(--color-text-muted)]">Done well: {successCriteria.trim()}</span>}
                </> : null],
                [2, "Summary of Work", sowDoc ? <span className="text-[var(--color-text)]">{sowDoc.label}</span> : null],
                [3, "Budget", budgetLines.length ? <span className="text-[var(--color-text)] tabular-nums">{budgetLines.length} line{budgetLines.length === 1 ? "" : "s"}{budgetSum > 0 ? `, ${fmtMoney(budgetSum, fromDoc?.parsed.currency ?? "USD")}` : ""}{fromDoc ? `, from ${fromDoc.source.fileName}` : ""}</span> : null],
                [4, "Schedule", msLines.length ? <span className="text-[var(--color-text)]">{msLines.map((m) => `${m.name.trim()} (${m.date})`).join(", ")}</span> : null],
                [5, "Team & contractors", partyLines.length ? <span className="text-[var(--color-text)]">{partyLines.map((p) => p.name.trim()).join(", ")}</span> : null],
              ] as Array<[number, string, React.ReactNode]>).map(([i, label, body]) => (
                <div key={label} className="py-3 grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] max-sm:grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
                  <dt className="font-medium text-[var(--color-text)]">{label}</dt>
                  <dd className="min-w-0 max-sm:col-span-2 max-sm:row-start-2">{body ?? <span className="text-[var(--color-text-muted)]">Skipped. It comes back on the project to fill in.</span>}</dd>
                  <dd className="max-sm:col-start-2 max-sm:row-start-1 justify-self-end -my-2"><button type="button" onClick={() => { setError(null); setStep(i); }} className={addLink} aria-label={`Change ${label}`}>Change</button></dd>
                </div>
              ))}
            </dl>
          )}

          {error && <ErrorNote title={error} next="Fix it on its step, then make the project again." />}
        </div>

        {/* Back, skip, and the one main button; why it can't be pressed yet. */}
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex flex-wrap items-center gap-2">
          {step > 0 && (
            <Button variant="secondary" onClick={() => { setError(null); setStep(step - 1); }} disabled={busy}>
              <ChevronLeft className="w-4 h-4" /> Back
            </Button>
          )}
          <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {blocked && <span className="text-body text-[var(--color-text-muted)]" id="np-next-why">{blocked}</span>}
            {step > 0 && step < REVIEW && stepKey && !stepHasContent[stepKey] && (
              <Button variant="ghost" onClick={() => next(true)} disabled={busy}>Skip for now</Button>
            )}
            <Button onClick={() => next(false)} disabled={!!blocked} loading={busy} aria-describedby={blocked ? "np-next-why" : undefined}>
              {step === REVIEW ? <><Check className="w-4 h-4" /> Make the project</> : <>{step === REVIEW - 1 ? "Review" : "Next"} <ChevronRight className="w-4 h-4" /></>}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

function rows<T>(arr: T[], i: number, patch: Partial<T>): T[] {
  return arr.map((r, j) => (j === i ? { ...r, ...patch } : r));
}

function StepIntro({ text }: { text: string }) {
  return <p className="text-body text-[var(--color-text-muted)]">{text}</p>;
}

function FromDocSummary({ result, onClear }: { result: BudgetReadResult; onClear: () => void }) {
  const d = result.parsed;
  const recon = reconcileBudget(d);
  const cur = d.currency ?? "USD";
  const bits = [
    d.lines.length ? `${d.lines.length} budget line${d.lines.length === 1 ? "" : "s"}` : null,
    suppliersOf(d.lines).length ? `${suppliersOf(d.lines).length} companies` : null,
    d.milestones.length ? `${d.milestones.length} milestone${d.milestones.length === 1 ? "" : "s"}` : null,
    d.goals.length ? `${d.goals.length} goal${d.goals.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return (
    <div className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2.5 text-body">
      <div className="flex items-start gap-2">
        <Sparkles className="w-4 h-4 text-[var(--color-text-muted)] shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--color-text)]">
            Prefilled from {[d.docType, d.docNumber].filter(Boolean).join(" ") || result.source.fileName}
            {d.authorizedAmount != null ? ` · ${fmtMoney(d.authorizedAmount, cur)} authorized` : ""}
          </div>
          <div className="text-caption text-[var(--color-text-muted)] mt-0.5">
            {bits.length ? `Found ${bits.join(", ")}. ` : ""}Check each step. What you had typed was kept.
          </div>
          {!recon.balanced && recon.unallocated != null && (
            <div className="text-caption font-medium text-[var(--state-held-text)] mt-0.5">
              Lines total {fmtMoney(recon.linesTotal, cur)}: {fmtMoney(Math.abs(recon.unallocated), cur)} {recon.unallocated > 0 ? "short of" : "over"} the authorized amount.
            </div>
          )}
          {result.blankPages.length > 0 && (
            <div className="text-caption font-medium text-[var(--state-held-text)] mt-0.5">
              Page{result.blankPages.length === 1 ? "" : "s"} {result.blankPages.join(", ")} came through blank (scanner compression). Anything only there wasn&apos;t read.
            </div>
          )}
          {recon.overBudgetBy != null && recon.overBudgetBy > 0 && (
            <div className="text-caption font-medium text-[var(--state-held-text)] mt-0.5">
              {fmtMoney(recon.overBudgetBy, cur)} over the approved budget it cites{d.varianceNote ? `: ${d.varianceNote}` : "."}
            </div>
          )}
        </div>
        <button onClick={onClear} aria-label="Don't keep this document" className="ui-hit text-[var(--color-text-faint)] hover:text-[var(--state-overdue-text)]" title="Don't keep this document as the budget basis (prefilled fields stay)"><X className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}

function BudgetTotal({ rows, authorized, currency }: {
  rows: Array<{ budget: string }>; authorized: number | null; currency: string;
}) {
  const total = rows.reduce((t, r) => t + (Number(r.budget) || 0), 0);
  if (total <= 0) return null;
  const off = authorized != null && Math.abs(authorized - total) > Math.max(1, authorized * 0.005);
  return (
    <span className={`ml-auto text-caption font-medium tabular-nums ${off ? "text-[var(--state-held-text)]" : "text-[var(--color-text-muted)]"}`}>
      Total {fmtMoney(total, currency)}{authorized != null ? ` of ${fmtMoney(authorized, currency)} authorized` : ""}
    </span>
  );
}
