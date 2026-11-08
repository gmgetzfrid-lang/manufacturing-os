// Full control of budget lines: what can be deleted (nothing booked on
// it), groups with subtotals, and the status an open line has.

import { describe, it, expect } from "vitest";
import { canDeleteLine, groupLines, openStatusOf } from "@/lib/costLines";
import type { CostAccount, CostEntry } from "@/lib/costs";

const acc = (id: string, x: Partial<CostAccount> = {}): CostAccount => ({ id, projectId: "p", code: null, name: id, costType: "subcontract", budget: 100, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active", ...x });
const ent = (line: string, status: "posted" | "void" = "posted") => ({ id: Math.random().toString(), costAccountId: line, projectId: "p", partyId: null, entryType: "actual", amount: 10, entryDate: "2026-11-02", description: null, reference: null, status } as CostEntry);

describe("costLines", () => {
  it("a line is deleted only with nothing booked on it, voided or not", () => {
    expect(canDeleteLine("a", [ent("b")])).toBe(true);
    expect(canDeleteLine("a", [ent("a")])).toBe(false);
    expect(canDeleteLine("a", [ent("a", "void")])).toBe(false);
  });
  it("groups with subtotals, in the order lines come", () => {
    const rows = [
      { account: acc("Mech", { budget: 720000 }), committed: 500, spent: 300 },
      { account: acc("Crane", { costType: "equipment", budget: 40000 }), committed: 0, spent: 10 },
      { account: acc("Scaff", { budget: 55000 }), committed: 0, spent: 0 },
    ];
    const g = groupLines(rows, "type", (r) => r.account.costType ?? "");
    expect(g.map((x) => [x.label, x.rows.length, x.budget, x.committed, x.spent])).toEqual([["subcontract", 2, 775000, 500, 300], ["equipment", 1, 40000, 0, 10]]);
    expect(groupLines(rows, "none", () => "x")).toHaveLength(1);
  });
  it("an open line's status is the project's own", () => {
    expect(openStatusOf([acc("a", { status: "open" as never }), acc("b", { status: "open" as never }), acc("c", { status: "closed" })])).toBe("open");
    expect(openStatusOf([acc("c", { status: "closed" })])).toBe("active");
  });
});
