import { describe, it, expect } from "vitest";
import {
  validateParsedBudgetDoc, reconcileBudget, parseMoney, cleanSupplier, inferCostType,
  sameCompany, matchParty, uniqueSuppliers, planBudgetApply, suggestAccountForInvoice,
  findDuplicateInvoice, projectPrefillFrom, budgetSourceFormat,
} from "@/lib/budgetDoc";

// What a model returns for a typical one-page AFE (cost projection table
// with suppliers in braces, two budget references, signed approvals).
const AFE_RAW = {
  docType: "AFE",
  docNumber: "25008",
  chargeAccount: "6420-6700-25008-55-XX-XX-XX",
  docDate: "2025-03-07",
  title: "Transmix No. 1 and No. 2 Turnaround - March 2025",
  authorizedAmount: "$1,250,000",
  currency: "usd",
  description: "Labor and materials to service equipment and execute work orders during the turnaround.",
  justification: "Feed limited to 2,600 bpd by fouling; cleaning restores ~4,200 bpd.",
  goals: ["Restore combined feed rate to ~4,200 bpd", ""],
  preparedBy: "B. Hutchison",
  approvals: [
    { role: "President & CEO", name: null, date: "2025-03-11" },
    { role: "Chief Financial Officer", name: null, date: "2025-03-07" },
    { role: "", name: "nobody" },
  ],
  budgetReferences: [
    { label: "Item No. 11 - Transmix No. 1 TA - April 2025", amount: 500000 },
    { label: "Item No. 12 - Transmix No. 2 TA - April 2025", amount: "500,000" },
  ],
  varianceNote: "$250,000 above budget",
  lines: [
    { name: "Mechanical Labor", amount: 884000, supplier: "{SWAT}" },
    { name: "Hydro blasting", amount: 100000, supplier: "{Ancon}" },
    { name: "Scaffolding", amount: 42000, supplier: "{Brand}" },
    { name: "Materials", amount: 30000, supplier: "{BPS}" },
    { name: "Confined Space Rescue", amount: 55000, supplier: "{Pro Safety}" },
    { name: "Rental Equipment", amount: 20000, supplier: "{Various}" },
    { name: "Crane and Operator", amount: 38000, supplier: "{OST}" },
    { name: "Chem Clean Equipment", amount: 15000, supplier: "{Various}" },
    { name: "Coriolis Servicing", amount: 8000, supplier: "{Advanced Combustion}", note: "Consignment" },
    { name: "Boxes", amount: 8000, supplier: "{Norbourn}" },
    { name: "PSV Servicing", amount: 14000, supplier: "{Bermingham}" },
    { name: "Fin Fan Retube (5530.22)", amount: 36000, supplier: "{JVG}" },
    { name: "Total", amount: 1250000 },
  ],
  milestones: [
    { name: "Transmix No. 1 shutdown", date: "2025-03-15" },
    { name: "Transmix No. 2 shutdown", date: "2025-03-22" },
    { name: "Undated thing", date: "March" },
  ],
  targetCompletionDate: "2025-03-29",
};

describe("validateParsedBudgetDoc", () => {
  const doc = validateParsedBudgetDoc(AFE_RAW);

  it("reads the header facts", () => {
    expect(doc.docNumber).toBe("25008");
    expect(doc.chargeAccount).toBe("6420-6700-25008-55-XX-XX-XX");
    expect(doc.authorizedAmount).toBe(1_250_000);
    expect(doc.currency).toBe("USD");
    expect(doc.approvals).toHaveLength(2);
    expect(doc.goals).toEqual(["Restore combined feed rate to ~4,200 bpd"]);
  });

  it("drops the printed Total row and keeps the twelve cost lines", () => {
    expect(doc.lines).toHaveLength(12);
    expect(doc.lines.some((l) => /total/i.test(l.name))).toBe(false);
  });

  it("strips supplier braces and turns 'Various' into no supplier", () => {
    expect(doc.lines[0].supplier).toBe("SWAT");
    expect(doc.lines.find((l) => l.name === "Rental Equipment")?.supplier).toBeNull();
  });

  it("infers cost types when the model gives none", () => {
    const t = (n: string) => doc.lines.find((l) => l.name === n)?.costType;
    expect(t("Mechanical Labor")).toBe("labor");
    expect(t("Materials")).toBe("material");
    expect(t("Crane and Operator")).toBe("equipment");
    expect(t("Chem Clean Equipment")).toBe("equipment");
    expect(t("Hydro blasting")).toBe("subcontract");
    expect(t("PSV Servicing")).toBe("subcontract");
  });

  it("keeps only dated milestones", () => {
    expect(doc.milestones.map((m) => m.date)).toEqual(["2025-03-15", "2025-03-22"]);
  });

  it("refuses an extraction with nothing usable", () => {
    expect(() => validateParsedBudgetDoc({ title: "x", lines: [] })).toThrow();
    expect(() => validateParsedBudgetDoc(null)).toThrow();
  });

  it("honours a valid model cost type over the inference", () => {
    const d = validateParsedBudgetDoc({ lines: [{ name: "Mechanical Labor", amount: 1, costType: "subcontract" }] });
    expect(d.lines[0].costType).toBe("subcontract");
  });
});

describe("reconcileBudget", () => {
  it("balances the AFE and reports the overrun against its budget references", () => {
    const r = reconcileBudget(validateParsedBudgetDoc(AFE_RAW));
    expect(r.linesTotal).toBe(1_250_000);
    expect(r.balanced).toBe(true);
    expect(r.budgeted).toBe(1_000_000);
    expect(r.overBudgetBy).toBe(250_000);
  });

  it("flags lines that don't add up to the authorized amount", () => {
    const r = reconcileBudget({ authorizedAmount: 100_000, budgetReferences: [], lines: [
      { name: "a", amount: 60_000, supplier: null, costType: "other", note: null },
    ] });
    expect(r.balanced).toBe(false);
    expect(r.unallocated).toBe(40_000);
    expect(r.budgeted).toBeNull();
  });
});

describe("money and names", () => {
  it("parses printed money", () => {
    expect(parseMoney("$1,250,000")).toBe(1_250_000);
    expect(parseMoney("1.25M")).toBe(1_250_000);
    expect(parseMoney("36k")).toBe(36_000);
    expect(parseMoney("(5,000)")).toBe(-5_000);
    expect(parseMoney("about a million")).toBeNull();
    expect(parseMoney(Number.NaN)).toBeNull();
  });

  it("cleans suppliers", () => {
    expect(cleanSupplier("{Pro Safety}")).toBe("Pro Safety");
    expect(cleanSupplier("TBD")).toBeNull();
    expect(cleanSupplier("")).toBeNull();
  });

  it("matches companies across suffixes and extra words, not on short fragments", () => {
    expect(sameCompany("SWAT", "S.W.A.T. Inc")).toBe(false); // punctuation-split letters aren't the same token
    expect(sameCompany("Ancon", "Ancon, LLC")).toBe(true);
    expect(sameCompany("Pro Safety", "Pro Safety Services")).toBe(true);
    expect(sameCompany("Brand", "BrandSafway")).toBe(false);
    expect(sameCompany("Co", "Coastal")).toBe(false);
    expect(matchParty("ANCON LLC", [{ id: "p1", name: "Ancon" }])?.id).toBe("p1");
  });

  it("dedupes suppliers", () => {
    expect(uniqueSuppliers([{ supplier: "SWAT" }, { supplier: "Ancon" }, { supplier: "swat" }, { supplier: null }]))
      .toEqual(["SWAT", "Ancon"]);
  });

  it("falls back to subcontract when a supplier exists and nothing else fits", () => {
    expect(inferCostType("Coriolis meters", "Emerson")).toBe("subcontract");
    expect(inferCostType("Coriolis meters", null)).toBe("other");
  });
});

describe("planBudgetApply", () => {
  it("creates new lines and companies, skips existing lines, reuses existing companies", () => {
    const doc = validateParsedBudgetDoc(AFE_RAW);
    const plan = planBudgetApply(
      doc.lines,
      [{ name: "scaffolding", budget: 40_000 }],
      [{ id: "p1", name: "SWAT Industrial LLC" }, { id: "p2", name: "Ancon" }],
    );
    expect(plan.accountsSkipped).toEqual([{ name: "Scaffolding", existingBudget: 40_000 }]);
    expect(plan.accountsToCreate).toHaveLength(11);
    expect(plan.partiesToCreate).not.toContain("Ancon");
    expect(plan.partiesToCreate).not.toContain("SWAT");
    expect(plan.partiesToCreate).not.toContain("Brand"); // its only line was skipped
    expect(plan.partiesToCreate).toContain("JVG");
  });
});

describe("suggestAccountForInvoice", () => {
  const parties = [{ id: "swat", name: "SWAT" }, { id: "ancon", name: "Ancon" }, { id: "ost", name: "OST" }];
  const accounts = [
    { id: "a1", name: "Mechanical Labor", partyId: "swat" },
    { id: "a2", name: "Hydro blasting", partyId: "ancon" },
    { id: "a3", name: "Crane and Operator", partyId: "ost" },
    { id: "a4", name: "Rental Equipment", partyId: null },
    { id: "a5", name: "Fin Fan Retube", partyId: "swat" },
  ];

  it("routes by vendor when the vendor owns one line", () => {
    const s = suggestAccountForInvoice({ vendorName: "Ancon, LLC" }, accounts, parties);
    expect(s).toMatchObject({ accountId: "a2", confidence: "high" });
  });

  it("breaks a multi-line vendor tie with the billed descriptions", () => {
    const s = suggestAccountForInvoice({ vendorName: "SWAT", lineDescriptions: ["Retube fin fan E-13"] }, accounts, parties);
    expect(s).toMatchObject({ accountId: "a5", confidence: "high" });
    const unsure = suggestAccountForInvoice({ vendorName: "SWAT" }, accounts, parties);
    expect(unsure?.confidence).toBe("medium");
  });

  it("falls back to description words for an unknown vendor", () => {
    const s = suggestAccountForInvoice({ vendorName: "Sunbelt", lineDescriptions: ["Equipment rental - light towers"] }, accounts, parties);
    expect(s).toMatchObject({ accountId: "a4", confidence: "low" });
  });

  it("says nothing rather than guess", () => {
    expect(suggestAccountForInvoice({ vendorName: "Nobody" }, accounts, parties)).toBeNull();
    expect(suggestAccountForInvoice({ vendorName: "Ancon" }, [], parties)).toBeNull();
  });

  it("skips closed lines", () => {
    const s = suggestAccountForInvoice({ vendorName: "Ancon" }, accounts.map((a) => a.id === "a2" ? { ...a, status: "closed" } : a), parties);
    expect(s).toBeNull();
  });
});

describe("findDuplicateInvoice", () => {
  const inv = (over: Record<string, unknown>) => ({
    id: "x", kind: "invoice", status: "parsed", vendorName: "Ancon", docNumber: null as string | null,
    totalAmount: 1000 as number | null, docDate: "2025-03-20" as string | null, ...over,
  });

  it("catches the same invoice number from the same vendor", () => {
    const a = inv({ id: "a", docNumber: "INV-1042" });
    const b = inv({ id: "b", docNumber: "inv 1042", vendorName: "Ancon LLC", status: "posted" });
    expect(findDuplicateInvoice(a, [a, b])?.id).toBe("b");
  });

  it("different numbers are different invoices even at the same amount", () => {
    const a = inv({ id: "a", docNumber: "1" });
    const b = inv({ id: "b", docNumber: "2" });
    expect(findDuplicateInvoice(a, [b])).toBeNull();
  });

  it("without numbers, same vendor + total + date is a duplicate; void copies don't count", () => {
    const a = inv({ id: "a" });
    expect(findDuplicateInvoice(a, [inv({ id: "b" })])?.id).toBe("b");
    expect(findDuplicateInvoice(a, [inv({ id: "b", status: "void" })])).toBeNull();
  });
});

describe("projectPrefillFrom", () => {
  it("maps the document onto wizard fields", () => {
    const p = projectPrefillFrom(validateParsedBudgetDoc(AFE_RAW));
    expect(p.name).toBe("Transmix No. 1 and No. 2 Turnaround - March 2025");
    expect(p.targetDate).toBe("2025-03-29");
    expect(p.purpose).toMatch(/4,200/);
  });
});

describe("budgetSourceFormat", () => {
  it("routes each format to its reader", () => {
    expect(budgetSourceFormat("AFE 25008.pdf", null)).toBe("pdf");
    expect(budgetSourceFormat("scan", "application/pdf")).toBe("pdf");
    expect(budgetSourceFormat("photo.JPG", null)).toBe("image");
    expect(budgetSourceFormat("estimate.xlsx", null)).toBe("sheet");
    expect(budgetSourceFormat("costs.csv", "text/csv")).toBe("sheet");
    expect(budgetSourceFormat("request.docx", null)).toBe("docx");
    expect(budgetSourceFormat("notes.txt", null)).toBe("text");
    expect(budgetSourceFormat("old.doc", "application/msword")).toBe("unsupported");
  });
});
