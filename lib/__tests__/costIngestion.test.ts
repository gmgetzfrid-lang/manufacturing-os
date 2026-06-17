// lib/__tests__/costIngestion.test.ts
//
// Freezes the document-ingestion mapping: an AI extraction → a draft plan of
// contractors + cost accounts + ledger entries. The AFE path (budget doc that
// declares contractors and their approved amounts) is the headline case.

import { describe, it, expect } from "vitest";
import { planFromExtraction, KIND_TO_ENTRY_TYPE } from "@/lib/costIngestion";
import type { CostAccount, CostExtraction, ProjectParty } from "@/types/schema";

const acct = (over: Partial<CostAccount>): CostAccount => ({
  orgId: "o", projectId: "p", name: "A", costType: "labor", budget: 0, ...over,
});
const party = (over: Partial<ProjectParty>): ProjectParty => ({
  orgId: "o", projectId: "p", name: "X", kind: "contractor", ...over,
});

describe("KIND_TO_ENTRY_TYPE — document kind posts to the right ledger bucket", () => {
  it("AFE and quotes authorise budget; POs commit; invoices are actuals", () => {
    expect(KIND_TO_ENTRY_TYPE.afe).toBe("budget");
    expect(KIND_TO_ENTRY_TYPE.quote).toBe("budget");
    expect(KIND_TO_ENTRY_TYPE.estimate).toBe("budget");
    expect(KIND_TO_ENTRY_TYPE.po).toBe("commitment");
    expect(KIND_TO_ENTRY_TYPE.subcontract).toBe("commitment");
    expect(KIND_TO_ENTRY_TYPE.invoice).toBe("actual");
    expect(KIND_TO_ENTRY_TYPE.change_order).toBe("change");
  });
});

describe("planFromExtraction — AFE builds the contractor + budget structure", () => {
  // An AFE: two contractors, two approved budgets. Acme already exists; Volt
  // is new. No cost accounts yet (the AFE creates them).
  const afe: CostExtraction = {
    kind: "afe",
    docNumber: "AFE-2026-08",
    currency: "USD",
    totalAmount: 1_300_000,
    lineItems: [
      { description: "Mechanical erection", party: "Acme Mechanical", amount: 800_000, costType: "subcontract" },
      { description: "Electrical & instrumentation", party: "Volt Electric", amount: 500_000, costType: "subcontract" },
    ],
  };
  const parties = [party({ id: "acme", name: "Acme Mechanical" })];
  const plan = planFromExtraction(afe, [], { parties });

  it("posts as budget and totals the approved amounts", () => {
    expect(plan.entryType).toBe("budget");
    expect(plan.total).toBe(1_300_000);
  });
  it("matches an existing contractor and flags a new one to create", () => {
    expect(plan.lines[0].partyId).toBe("acme");
    expect(plan.lines[0].newPartyName).toBeNull();
    expect(plan.lines[1].partyId).toBeNull();
    expect(plan.lines[1].newPartyName).toBe("Volt Electric");
  });
  it("creates a scope-named budget account per line (no $/hour needed)", () => {
    expect(plan.lines[0].accountId).toBeNull();
    expect(plan.lines[0].newAccount).toEqual({ name: "Mechanical erection", costType: "subcontract" });
    expect(plan.lines[1].newAccount).toEqual({ name: "Electrical & instrumentation", costType: "subcontract" });
  });
});

describe("planFromExtraction — invoices map onto existing accounts", () => {
  const accounts: CostAccount[] = [
    acct({ id: "LA", name: "Mechanical Labor", costType: "labor" }),
    acct({ id: "MA", name: "Pipe Material", costType: "material" }),
  ];
  const invoice: CostExtraction = {
    kind: "invoice", vendorName: "Acme", totalAmount: 10_000,
    lineItems: [
      { description: "Welding labor", amount: 5_000, costType: "labor" },
      { description: "Carbon steel pipe", amount: 3_000, costType: "material" },
      { description: "Crane rental", amount: 2_000, costType: "equipment" },
    ],
  };
  const plan = planFromExtraction(invoice, accounts);

  it("posts as actuals and matches accounts by cost type", () => {
    expect(plan.entryType).toBe("actual");
    expect(plan.lines[0].accountId).toBe("LA");
    expect(plan.lines[1].accountId).toBe("MA");
  });
  it("proposes a new account when no cost type matches", () => {
    expect(plan.lines[2].accountId).toBeNull();
    expect(plan.lines[2].newAccount).toEqual({ name: "Equipment", costType: "equipment" });
  });
});

describe("planFromExtraction — edges", () => {
  it("prefers the document's party among same-type accounts (invoice)", () => {
    const multi: CostAccount[] = [
      acct({ id: "LA-A", name: "Labor", costType: "labor", partyId: "A" }),
      acct({ id: "LA-B", name: "Labor", costType: "labor", partyId: "B" }),
    ];
    const ext: CostExtraction = { kind: "invoice", lineItems: [{ description: "labor", amount: 100, costType: "labor" }] };
    expect(planFromExtraction(ext, multi, { partyId: "B" }).lines[0].accountId).toBe("LA-B");
  });
  it("breaks same-type ties by name similarity (PO commitment)", () => {
    const multi: CostAccount[] = [
      acct({ id: "GEN", name: "General Material", costType: "material" }),
      acct({ id: "PIPE", name: "Pipe and Fittings", costType: "material" }),
    ];
    const ext: CostExtraction = { kind: "po", lineItems: [{ description: "8in carbon pipe fittings", amount: 500, costType: "material" }] };
    const plan = planFromExtraction(ext, multi);
    expect(plan.entryType).toBe("commitment");
    expect(plan.lines[0].accountId).toBe("PIPE");
  });
  it("a budget line with a known cost type names the new account after its scope", () => {
    const ext: CostExtraction = { kind: "quote", lineItems: [{ description: "Scaffolding rental", amount: 40_000, costType: "equipment" }] };
    const plan = planFromExtraction(ext, []);
    expect(plan.entryType).toBe("budget");
    expect(plan.lines[0].accountId).toBeNull();
    expect(plan.lines[0].newAccount).toEqual({ name: "Scaffolding rental", costType: "equipment" });
  });
});
