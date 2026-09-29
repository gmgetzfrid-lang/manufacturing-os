// lib/projectWizardWrites.ts — the wizard's follow-up writes, checked.
//
// createProject commits the projects row first and throws on failure. The
// four writes that carry what the user actually typed — the purpose/goals/
// SOW details, budget lines, first milestones, contractors — plus the
// turnover seeds used to `console.warn` (or `.then(() => undefined,
// () => undefined)`) and route to the project as if everything landed. A
// superintendent could type a $305k budget across four lines and land on a
// coach saying "Add a budget". Every write here binds its error, and the
// caller gets the list of what did NOT save so it can show it and retry
// with the rows it still holds (projects-tab UX-1 / projects-and-cost
// PM-13). Pure over an injected client so the failure path is testable.

export type WizardWriteStep = "details" | "budget" | "schedule" | "team" | "turnover";

export interface WizardWriteFailure {
  step: WizardWriteStep;
  /** What the user would call it: "4 budget lines". */
  label: string;
  message: string;
}

export const WIZARD_STEP_ORDER: WizardWriteStep[] = ["details", "budget", "schedule", "team", "turnover"];

export interface WizardWriteInput {
  orgId: string;
  projectId: string;
  actorUserId: string;
  actorEmail?: string | null;
  details: {
    purpose: string;
    goals: string[];
    successCriteria: string;
    jobKind: string;
    sowDocumentId: string | null;
    setupState: Record<string, string>;
  };
  accounts: Array<{ name: string; budget: number; type: string }>;
  milestones: Array<{ name: string; date: string }>;
  parties: Array<{ name: string; kind: string; trade: string; companyId: string | null }>;
}

export interface WriteError { message: string; code?: string | null }

export interface WizardWriteDeps {
  updateProject(patch: Record<string, unknown>): Promise<{ error: WriteError | null }>;
  insertRows(table: "cost_accounts" | "milestones" | "project_parties", rows: Record<string, unknown>[]): Promise<{ error: WriteError | null }>;
  seedTurnover(): Promise<{ ok: boolean; error?: string }>;
}

/** PostgREST's "column does not exist" codes — a database the migration
 *  has not reached. Still a failure the user must see; the message says why. */
const MISSING_COLUMN = new Set(["PGRST204", "42703"]);

function describe(err: WriteError, fields: string): string {
  if (err.code && MISSING_COLUMN.has(err.code)) {
    return `The database has not been migrated for ${fields} (${err.message}).`;
  }
  return err.message;
}

/**
 * Parse money the way people type it: "1,200,000", "$1,200,000.50",
 * "1 200 000". Returns `{ kind: "blank" }` for nothing typed, `"invalid"`
 * for something that is not a number, and the value otherwise.
 */
export function parseMoneyInput(raw: string): { kind: "blank" } | { kind: "invalid" } | { kind: "ok"; value: number } {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "blank" };
  const cleaned = trimmed.replace(/[$€£¥]/g, "").replace(/[,_\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { kind: "invalid" };
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return { kind: "invalid" };
  return { kind: "ok", value };
}

/**
 * The wizard's budget rows → account rows to insert. A named row with a
 * blank amount saves as 0 (typed input is never silently discarded); a
 * named row whose amount does not parse is reported, not dropped.
 */
export function prepareBudgetRows(rows: Array<{ name: string; budget: string; type: string }>): {
  accounts: Array<{ name: string; budget: number; type: string }>;
  invalid: string[];
} {
  const accounts: Array<{ name: string; budget: number; type: string }> = [];
  const invalid: string[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const parsed = parseMoneyInput(r.budget);
    if (parsed.kind === "invalid") { invalid.push(name); continue; }
    accounts.push({ name, budget: parsed.kind === "ok" ? parsed.value : 0, type: r.type });
  }
  return { accounts, invalid };
}

/**
 * Run the follow-up writes (all of them, or only `only`), binding every
 * error. Never throws for a refused write — the failures come back so the
 * caller can show them and retry with the rows it still holds.
 */
export async function runWizardFollowUpWrites(
  input: WizardWriteInput,
  deps: WizardWriteDeps,
  only?: ReadonlySet<WizardWriteStep>,
): Promise<{ failures: WizardWriteFailure[] }> {
  const failures: WizardWriteFailure[] = [];
  const wants = (s: WizardWriteStep) => !only || only.has(s);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  if (wants("details")) {
    const d = input.details;
    const { error } = await deps.updateProject({
      purpose: d.purpose.trim() || null,
      goals: d.goals.length > 0 ? d.goals : null,
      success_criteria: d.successCriteria.trim() || null,
      job_kind: d.jobKind,
      sow_document_id: d.sowDocumentId,
      setup_state: d.setupState,
    });
    if (error) {
      failures.push({ step: "details", label: "purpose, goals, success criteria, job size and Summary of Work", message: describe(error, "the purpose / goals / Summary of Work fields") });
    }
  }

  if (wants("budget") && input.accounts.length > 0) {
    const { error } = await deps.insertRows("cost_accounts", input.accounts.map((r) => ({
      org_id: input.orgId, project_id: input.projectId,
      name: r.name, budget: r.budget, cost_type: r.type, currency: "USD",
      created_by: input.actorUserId,
    })));
    if (error) failures.push({ step: "budget", label: plural(input.accounts.length, "budget line"), message: describe(error, "budget lines") });
  }

  if (wants("schedule") && input.milestones.length > 0) {
    const { error } = await deps.insertRows("milestones", input.milestones.map((r) => ({
      org_id: input.orgId, project_id: input.projectId,
      name: r.name, planned_at: new Date(`${r.date}T12:00:00`).toISOString(),
      status: "planned", created_by: input.actorUserId,
    })));
    if (error) failures.push({ step: "schedule", label: plural(input.milestones.length, "milestone"), message: describe(error, "milestones") });
  }

  if (wants("team") && input.parties.length > 0) {
    const rows = input.parties.map((r) => ({
      org_id: input.orgId, project_id: input.projectId,
      name: r.name, kind: r.kind, trade: r.trade || null,
      company_id: r.companyId,
      created_by: input.actorUserId,
    }));
    let { error } = await deps.insertRows("project_parties", rows);
    if (error && error.code && MISSING_COLUMN.has(error.code)) {
      // Pre-migration: company_id doesn't exist yet — save without the link.
      ({ error } = await deps.insertRows("project_parties", rows.map(({ company_id: _c, ...rest }) => rest)));
    }
    if (error) failures.push({ step: "team", label: plural(input.parties.length, "company", "companies"), message: describe(error, "companies on the job") });
  }

  if (wants("turnover")) {
    try {
      const res = await deps.seedTurnover();
      if (!res.ok) failures.push({ step: "turnover", label: "the turnover package seeds", message: res.error ?? "The turnover package could not be seeded." });
    } catch (e) {
      failures.push({ step: "turnover", label: "the turnover package seeds", message: (e as Error).message });
    }
  }

  return { failures };
}

/** One line naming what did not save: "4 budget lines and 2 milestones". */
export function summarizeWizardFailures(failures: WizardWriteFailure[]): string {
  const labels = failures.map((f) => f.label);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
