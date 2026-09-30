// projects-tab UX-1 / UX-12 · projects-and-cost PM-13 — the wizard's
// follow-up writes bind every error, a refused write comes back with the
// rows still recoverable, and money typed with separators is accepted.
//
// Before: ProjectWizard.tsx:149-201 `console.warn`ed the extended-fields
// update and the budget/contractor inserts, swallowed the milestones insert
// with `.then(() => undefined, () => undefined)`, `.catch`ed the turnover
// seeds, and routed to the project as if everything landed; and
// `Number("1,200,000")` is NaN, so a comma-typed budget dropped the row.

import { describe, it, expect } from "vitest";
import {
  parseMoneyInput, prepareBudgetRows, runWizardFollowUpWrites, summarizeWizardFailures, retainedRowLines,
  type WizardWriteDeps, type WizardWriteInput, type WizardWriteStep,
} from "@/lib/projectWizardWrites";

const input = (over: Partial<WizardWriteInput> = {}): WizardWriteInput => ({
  orgId: "org1", projectId: "p1", actorUserId: "u1", actorEmail: "pat@example.com",
  details: { purpose: "Replace E-301", goals: ["Zero recordables"], successCriteria: "", jobKind: "standard", sowDocumentId: null, setupState: { basics: "done" } },
  accounts: [
    { name: "Piping subcontract", budget: 200_000, type: "subcontract" },
    { name: "Scaffolding", budget: 40_000, type: "subcontract" },
    { name: "Engineering hours", budget: 50_000, type: "labor" },
    { name: "Contingency", budget: 15_000, type: "other" },
  ],
  milestones: [{ name: "Mobilize", date: "2026-10-01" }, { name: "Demo complete", date: "2026-10-15" }],
  parties: [{ name: "Gulf Mechanical", kind: "contractor", trade: "piping", companyId: "c1" }],
  ...over,
});

/** A client where named tables refuse; everything else lands. */
function deps(refuse: Partial<Record<"projects" | "cost_accounts" | "milestones" | "project_parties" | "turnover", { message: string; code?: string }>> = {}) {
  const calls: Array<{ table: string; rows?: unknown; patch?: unknown }> = [];
  const d: WizardWriteDeps = {
    updateProject: async (patch) => { calls.push({ table: "projects", patch }); return { error: refuse.projects ?? null }; },
    insertRows: async (table, rows) => {
      calls.push({ table, rows });
      // The pre-migration retry drops company_id; let it land.
      if (table === "project_parties" && (refuse.project_parties?.code === "PGRST204" || refuse.project_parties?.code === "42703")
        && rows.every((r) => !("company_id" in r))) return { error: null };
      return { error: refuse[table] ?? null };
    },
    seedTurnover: async () => (refuse.turnover ? { ok: false, error: refuse.turnover.message } : { ok: true }),
  };
  return { d, calls };
}

describe("parseMoneyInput — money the way people type it (UX-1)", () => {
  it("accepts 1,200,000 and the other everyday spellings", () => {
    expect(parseMoneyInput("1,200,000")).toEqual({ kind: "ok", value: 1_200_000 });
    expect(parseMoneyInput("$1,200,000.50")).toEqual({ kind: "ok", value: 1_200_000.5 });
    expect(parseMoneyInput("1 200 000")).toEqual({ kind: "ok", value: 1_200_000 });
    expect(parseMoneyInput("  45000 ")).toEqual({ kind: "ok", value: 45_000 });
    expect(parseMoneyInput("0")).toEqual({ kind: "ok", value: 0 });
  });
  it("blank is blank; words and negatives are invalid, never silently 0", () => {
    expect(parseMoneyInput("")).toEqual({ kind: "blank" });
    expect(parseMoneyInput("   ")).toEqual({ kind: "blank" });
    expect(parseMoneyInput("about 40k")).toEqual({ kind: "invalid" });
    expect(parseMoneyInput("-500")).toEqual({ kind: "invalid" });
    expect(parseMoneyInput("1,2,3.4.5")).toEqual({ kind: "invalid" });
  });
  it("prepareBudgetRows keeps a named blank-amount row at 0 and REPORTS an unparseable one", () => {
    const { accounts, invalid } = prepareBudgetRows([
      { name: "Piping", budget: "1,200,000", type: "subcontract" },
      { name: "Scaffold", budget: "", type: "subcontract" },
      { name: "Cranes", budget: "TBD", type: "equipment" },
      { name: "", budget: "999", type: "other" },
    ]);
    expect(accounts).toEqual([
      { name: "Piping", budget: 1_200_000, type: "subcontract" },
      { name: "Scaffold", budget: 0, type: "subcontract" },
    ]);
    expect(invalid).toEqual(["Cranes"]);
  });
});

describe("runWizardFollowUpWrites — nothing fails silently (UX-1 / PM-13)", () => {
  it("a refused cost_accounts insert surfaces, named, with the rows untouched for a retry", async () => {
    const { d, calls } = deps({ cost_accounts: { message: "new row violates row-level security policy for table \"cost_accounts\"" } });
    const inp = input();
    const { failures } = await runWizardFollowUpWrites(inp, d);
    expect(failures).toEqual([{
      step: "budget", label: "4 budget lines",
      message: "new row violates row-level security policy for table \"cost_accounts\"",
    }]);
    // The other writes still ran — one refusal does not abandon the rest.
    expect(calls.map((c) => c.table)).toEqual(["projects", "cost_accounts", "milestones", "project_parties"]);
    // The typed rows are exactly what the retry will resend.
    expect(inp.accounts).toHaveLength(4);
    expect(summarizeWizardFailures(failures)).toBe("4 budget lines");
  });

  it("the milestones insert binds its error instead of .then(() => undefined, () => undefined)", async () => {
    const { d } = deps({ milestones: { message: "null value in column \"planned_at\"", code: "23502" } });
    const { failures } = await runWizardFollowUpWrites(input(), d);
    expect(failures).toEqual([{ step: "schedule", label: "2 milestones", message: "null value in column \"planned_at\"" }]);
  });

  it("a turnover seed that returns { ok: false } is a failure, not a swallowed catch", async () => {
    const { d } = deps({ turnover: { message: "turnover_items: permission denied" } });
    const { failures } = await runWizardFollowUpWrites(input(), d);
    expect(failures.map((f) => f.step)).toEqual(["turnover"]);
    expect(failures[0].message).toContain("permission denied");
  });

  it("a pre-migration database is named as such for the purpose / goals / SOW fields", async () => {
    const { d } = deps({ projects: { message: "Could not find the 'purpose' column of 'projects' in the schema cache", code: "PGRST204" } });
    const { failures } = await runWizardFollowUpWrites(input(), d);
    expect(failures[0].step).toBe("details");
    expect(failures[0].message).toMatch(/has not been migrated/);
  });

  it("company_id missing (pre-migration) retries the parties without the link — and that is not a failure", async () => {
    const { d, calls } = deps({ project_parties: { message: "column company_id does not exist", code: "42703" } });
    const { failures } = await runWizardFollowUpWrites(input(), d);
    expect(failures).toEqual([]);
    const partyInserts = calls.filter((c) => c.table === "project_parties");
    expect(partyInserts).toHaveLength(2);
    expect((partyInserts[1].rows as Array<Record<string, unknown>>)[0]).not.toHaveProperty("company_id");
  });

  it("several failures are all reported, in wizard order, and summarised as a sentence", async () => {
    const { d } = deps({
      cost_accounts: { message: "rls" }, milestones: { message: "rls" }, turnover: { message: "seed failed" },
    });
    const { failures } = await runWizardFollowUpWrites(input(), d);
    expect(failures.map((f) => f.step)).toEqual(["budget", "schedule", "turnover"]);
    expect(summarizeWizardFailures(failures)).toBe("4 budget lines, 2 milestones and the turnover package seeds");
  });

  it("the retry re-runs ONLY the refused steps with the retained rows", async () => {
    const { d, calls } = deps();
    const only = new Set<WizardWriteStep>(["budget", "schedule"]);
    const { failures } = await runWizardFollowUpWrites(input(), d, only);
    expect(failures).toEqual([]);
    expect(calls.map((c) => c.table)).toEqual(["cost_accounts", "milestones"]);
    expect((calls[0].rows as unknown[]).length).toBe(4);
  });

  it("the details write carries every wizard field and the setup state", async () => {
    const { d, calls } = deps();
    await runWizardFollowUpWrites(input({ details: {
      purpose: "  Replace E-301 ", goals: [], successCriteria: "Back by June 30", jobKind: "capital", sowDocumentId: "doc9",
      setupState: { basics: "done", budget: "skipped" },
    } }), d);
    expect(calls[0].patch).toEqual({
      purpose: "Replace E-301", goals: null, success_criteria: "Back by June 30", job_kind: "capital",
      sow_document_id: "doc9", setup_state: { basics: "done", budget: "skipped" },
    });
  });
});

describe("retainedRowLines — a persistent refusal still leaves what was typed on screen (UX-1 / PM-13)", () => {
  it("a data refusal fails the same way on Retry, so the typed rows are shown for every failed step", async () => {
    // A CHECK / numeric-overflow rejection is not transient: Retry resends
    // the same rows and is refused again.
    const overflow = { message: "numeric field overflow", code: "22003" };
    const { d } = deps({ cost_accounts: overflow });
    const first = await runWizardFollowUpWrites(input(), d);
    const again = await runWizardFollowUpWrites(input(), d, new Set<WizardWriteStep>(first.failures.map((f) => f.step)));
    expect(again.failures.map((f) => f.step)).toEqual(["budget"]);
    // …so the panel lists the four lines, readable and copyable, before
    // "Open project anyway" or the X can discard them.
    expect(retainedRowLines(input(), "budget")).toEqual([
      "Piping subcontract — subcontract — 200,000 USD",
      "Scaffolding — subcontract — 40,000 USD",
      "Engineering hours — labor — 50,000 USD",
      "Contingency — other — 15,000 USD",
    ]);
  });

  it("covers every step that carries typed input", () => {
    expect(retainedRowLines(input(), "schedule")).toEqual(["Mobilize — 2026-10-01", "Demo complete — 2026-10-15"]);
    expect(retainedRowLines(input(), "team")).toEqual(["Gulf Mechanical — contractor — piping"]);
    const details = input({ details: { purpose: "Replace E-301", goals: ["Zero recordables", "On budget"], successCriteria: "Back by June", jobKind: "capital", sowDocumentId: "doc-1", setupState: {} } });
    expect(retainedRowLines(details, "details", "SOW-0142")).toEqual([
      "Purpose: Replace E-301", "Goal: Zero recordables", "Goal: On budget", "Success criteria: Back by June",
      "Job size: capital", "Summary of Work: SOW-0142",
    ]);
    // Nothing typed feeds the turnover seeds.
    expect(retainedRowLines(input(), "turnover")).toEqual([]);
  });
});
