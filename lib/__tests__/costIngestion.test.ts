// lib/__tests__/costIngestion.test.ts
//
// Freezes the document-ingestion mapping: an AI extraction → a draft plan of
// ledger entries against the right cost accounts. This is the "auto-configure
// with a confirm step" core, so the kind→bucket mapping and the per-line
// account suggestion are pinned.

import { describe, it, expect } from "vitest";
import { planFromExtraction, KIND_TO_ENTRY_TYPE } from "@/lib/costIngestion";
import type { CostAccount, CostExtraction } from "@/types/schema";

const acct = (over: Partial<CostAccount>): CostAccount => ({
  orgId: "o", projectId: "p", name: "A", costType: "labor", budget: 0, ...over,
});

const accounts: CostAccount[] = [
  acct({ id: "LA", name: "Mechanical Labor", costType: "labor" }),
  acct({ id: "MA", name: "Pipe Material", costType: "material" }),
];

const invoice: CostExtraction = {
  kind: "invoice",
  vendorName: "Acme Mechanical",
  docNumber: "INV-2026-114",
  currency: "USD",
  totalAmount: 10_000,
  lineItems: [
    { description: "Welding labor", amount: 5_000, costType: "labor" },
    { description: "Carbon steel pipe", amount: 3_000, costType: "material" },
    { description: "Crane rental", amount: 2_000, costType: "equipment" },
  ],
};

describe("KIND_TO_ENTRY_TYPE — document kind posts to the right ledger bucket", () => {
  it("maps quotes→budget, POs→commitment, invoices→actual, change orders→change", () => {
    expect(KIND_TO_ENTRY_TYPE.quote).toBe("budget");
    expect(KIND_TO_ENTRY_TYPE.estimate).toBe("budget");
    expect(KIND_TO_ENTRY_TYPE.po).toBe("commitment");
    expect(KIND_TO_ENTRY_TYPE.subcontract).toBe("commitment");
    expect(KIND_TO_ENTRY_TYPE.invoice).toBe("actual");
    expect(KIND_TO_ENTRY_TYPE.change_order).toBe("change");
  });
});

describe("planFromExtraction — maps lines to accounts, suggests new ones", () => {
  const plan = planFromExtraction(invoice, accounts);
  it("posts an invoice as actuals, totalled", () => {
    expect(plan.entryType).toBe("actual");
    expect(plan.total).toBe(10_000);
  });
  it("matches existing accounts by cost type", () => {
    expect(plan.lines[0].accountId).toBe("LA"); // labor → Mechanical Labor
    expect(plan.lines[1].accountId).toBe("MA"); // material → Pipe Material
  });
  it("proposes a new account when no cost type matches", () => {
    expect(plan.lines[2].accountId).toBeNull();
    expect(plan.lines[2].newAccount).toEqual({ name: "Equipment", costType: "equipment" });
    expect(plan.newAccounts).toEqual([{ name: "Equipment", costType: "equipment" }]);
  });
});

describe("planFromExtraction — edges", () => {
  it("prefers the document's party among same-type accounts", () => {
    const multi: CostAccount[] = [
      acct({ id: "LA-A", name: "Labor", costType: "labor", partyId: "A" }),
      acct({ id: "LA-B", name: "Labor", costType: "labor", partyId: "B" }),
    ];
    const ext: CostExtraction = { kind: "invoice", lineItems: [{ description: "labor", amount: 100, costType: "labor" }] };
    expect(planFromExtraction(ext, multi, { partyId: "B" }).lines[0].accountId).toBe("LA-B");
  });
  it("breaks same-type ties by name similarity", () => {
    const multi: CostAccount[] = [
      acct({ id: "GEN", name: "General Material", costType: "material" }),
      acct({ id: "PIPE", name: "Pipe and Fittings", costType: "material" }),
    ];
    const ext: CostExtraction = { kind: "po", lineItems: [{ description: "8in carbon pipe fittings", amount: 500, costType: "material" }] };
    const plan = planFromExtraction(ext, multi);
    expect(plan.entryType).toBe("commitment");
    expect(plan.lines[0].accountId).toBe("PIPE"); // shares "pipe"/"fittings"
  });
  it("defaults a typeless line to ODC and a new ODC account", () => {
    const ext: CostExtraction = { kind: "invoice", lineItems: [{ description: "mobilization fee", amount: 1_000 }] };
    const plan = planFromExtraction(ext, []);
    expect(plan.lines[0].newAccount).toEqual({ name: "Other (ODC)", costType: "odc" });
  });
});
