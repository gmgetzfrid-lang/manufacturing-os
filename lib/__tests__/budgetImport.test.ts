// applyBudgetToProject against a database that, like production, rejects
// status values its CHECK doesn't list: the import must leave status to the
// column default and still build the cost model.

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; rows: Array<Record<string, unknown>> }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  rejectKindBudget: false,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: (r: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const rows = Array.isArray(r) ? r : [r];
        db.inserts.push({ table, rows });
        const statusCheck = (table === "cost_accounts" || table === "project_parties") && rows.some((x) => "status" in x);
        const kindCheck = table === "cost_documents" && db.rejectKindBudget;
        const error = statusCheck || kindCheck
          ? { code: "23514", message: `new row for relation "${table}" violates check constraint` } : null;
        const data = error ? null : rows.map((x, i) => ({ id: `${table}-${i}`, name: x.name }));
        const result = { data, error };
        return Object.assign(Promise.resolve(result), {
          select: () => Object.assign(Promise.resolve(result), {
            single: () => Promise.resolve({ data: data?.[0] ?? null, error }),
          }),
        });
      },
      update: (patch: Record<string, unknown>) => {
        db.updates.push({ table, patch });
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));
vi.mock("@/lib/costs", () => ({
  listAccounts: vi.fn(async () => []),
  listParties: vi.fn(async () => [{ id: "p-swat", name: "SWAT" }]),
}));

import { applyBudgetToProject } from "@/lib/budgetImport";
import { validateParsedBudgetDoc } from "@/lib/budgetDoc";

const parsed = validateParsedBudgetDoc({
  docType: "AFE", docNumber: "25008", authorizedAmount: 192000,
  lines: [
    { name: "Mechanical Labor", amount: 100000, supplier: "SWAT" },
    { name: "Hydro blasting", amount: 50000, supplier: "Ancon" },
    { name: "Scaffolding", amount: 42000, supplier: "Brand" },
  ],
});
const actor = { uid: "u1", email: "u1@x.test" };
const source = { fileKey: "orgs/o/project-costs/p/afe.pdf", fileName: "afe.pdf", mimeType: "application/pdf" };

beforeEach(() => { db.inserts = []; db.updates = []; db.rejectKindBudget = false; });

describe("applyBudgetToProject", () => {
  it("builds the model without sending a status the database may reject", async () => {
    const res = await applyBudgetToProject({ orgId: "o", projectId: "p", parsed, source, actor });
    expect(res).toMatchObject({ ok: true, accountsCreated: 3, partiesCreated: 2 });
    const accounts = db.inserts.find((i) => i.table === "cost_accounts")!.rows;
    expect(accounts.map((a) => a.party_id)).toEqual(["p-swat", "project_parties-0", "project_parties-1"]);
    expect(db.updates.find((u) => u.table === "projects")?.patch).toMatchObject({ afe_number: "25008", authorized_amount: 192000 });
  });

  it("still builds the model when the document itself can't be attached — and says so", async () => {
    db.rejectKindBudget = true;
    const res = await applyBudgetToProject({ orgId: "o", projectId: "p", parsed, source, actor });
    expect(res.ok).toBe(true);
    expect(res.accountsCreated).toBe(3);
    expect(res.error).toMatch(/document itself wasn't attached/);
  });
});
