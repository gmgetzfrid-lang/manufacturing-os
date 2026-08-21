// lib/exampleProject.ts — the EXAMPLE dataset behind "Preview with example
// data", pure and deterministic.
//
// The audit's finding: every chart was invisible until the tester fabricated
// a pile of data. This module is the fix — one realistic mid-size turnaround
// job (budget, three bidders, an award, invoices landing weekly, two change
// orders, milestones, a PSSR in progress) rendered through the SAME
// components as real data, always watermarked EXAMPLE, never written to the
// database. Deterministic: dates are derived from a fixed anchor so tests
// and screenshots are stable.

import type { ParsedQuote } from "@/lib/bidTab";
import type { DatedAmount } from "@/lib/costSeries";

export interface ExampleCostData {
  budget: number;
  scheduleStart: string;
  scheduleEnd: string;
  today: string;
  accounts: Array<{ id: string; code: string; name: string; budget: number; spent: number; committed: number; pinnedPct: number | null }>;
  commitments: DatedAmount[];
  actuals: DatedAmount[];
  cpi: number;
  spi: number;
  quotes: ParsedQuote[];
  rfqGroup: string;
  changeOrders: Array<{ coNumber: string; title: string; amount: number; reasonCode: string; status: string }>;
  milestones: Array<{ name: string; planned: string; status: "completed" | "in_progress" | "planned" }>;
}

const A = "2026-06-01"; // anchor start
const d = (offsetDays: number) => {
  const t = Date.parse(A) + offsetDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

export function buildExampleCostData(): ExampleCostData {
  const commitments: DatedAmount[] = [
    { date: d(7), amount: 182_000 },   // mechanical award
    { date: d(9), amount: 38_500 },    // scaffolding PO
    { date: d(12), amount: 21_400 },   // valve order
    { date: d(30), amount: 12_800 },   // CO-001 field condition
  ];
  const actuals: DatedAmount[] = [
    { date: d(14), amount: 18_400 },
    { date: d(21), amount: 27_900 },
    { date: d(28), amount: 31_200 },
    { date: d(35), amount: 29_800 },
    { date: d(42), amount: 33_500 },
    { date: d(49), amount: 26_100 },
  ];
  return {
    budget: 305_000,
    scheduleStart: d(0),
    scheduleEnd: d(90),
    today: d(52),
    cpi: 1.06,
    spi: 0.97,
    accounts: [
      { id: "ex-1", code: "01-100", name: "Piping subcontract", budget: 190_000, spent: 121_300, committed: 194_800, pinnedPct: 68 },
      { id: "ex-2", code: "01-200", name: "Scaffolding", budget: 42_000, spent: 30_400, committed: 38_500, pinnedPct: 75 },
      { id: "ex-3", code: "01-300", name: "Valves & materials", budget: 48_000, spent: 15_200, committed: 21_400, pinnedPct: 40 },
      { id: "ex-4", code: "01-900", name: "Engineering hours", budget: 25_000, spent: 9_100, committed: 0, pinnedPct: null },
    ],
    commitments,
    actuals,
    rfqGroup: "Unit 300 exchanger repipe",
    quotes: [
      {
        id: "exq-1", vendorName: "Gulf Mechanical", total: 182_000, currency: "USD",
        exclusions: ["Insulation reinstatement"], notes: null, validUntil: d(21),
        lineItems: [
          { description: "Demo + repipe E-301 A/B circuits", qty: 1, unit: "LS", unitRate: null, total: 128_000, craft: "pipefitter", hours: 1680, headcount: 8 },
          { description: "Hydrotest and reinstate", total: 24_000, hours: 300, headcount: 4, qty: 1, unit: "LS", unitRate: null, craft: "pipefitter" },
          { description: "NDE (RT 10%)", total: 30_000, hours: null, headcount: null, qty: 1, unit: "LS", unitRate: null, craft: null },
        ],
      },
      {
        id: "exq-2", vendorName: "Apex Industrial", total: 171_500, currency: "USD",
        exclusions: ["NDE", "Hydrotest water disposal", "Insulation reinstatement"], notes: null, validUntil: d(18),
        lineItems: [
          { description: "Demo + repipe E-301 A/B circuits", total: 149_000, hours: 1420, headcount: 7, qty: 1, unit: "LS", unitRate: null, craft: "pipefitter" },
          { description: "Hydrotest and reinstate", total: 22_500, hours: 260, headcount: 4, qty: 1, unit: "LS", unitRate: null, craft: "pipefitter" },
        ],
      },
      {
        id: "exq-3", vendorName: "Bayline Constructors", total: 198_400, currency: "USD",
        exclusions: [], notes: "Includes weekend premium", validUntil: d(30),
        lineItems: [
          { description: "Demo + repipe E-301 A/B circuits", total: 136_400, hours: 1810, headcount: 9, qty: 1, unit: "LS", unitRate: null, craft: "pipefitter" },
          { description: "Hydrotest and reinstate", total: 26_000, hours: 320, headcount: 4, qty: 1, unit: "LS", unitRate: null, craft: "pipefitter" },
          { description: "NDE (RT 10%)", total: 26_000, hours: null, headcount: null, qty: 1, unit: "LS", unitRate: null, craft: null },
          { description: "Insulation reinstatement", total: 10_000, hours: 220, headcount: 3, qty: 1, unit: "LS", unitRate: null, craft: "insulator" },
        ],
      },
    ],
    changeOrders: [
      { coNumber: "CO-001", title: "Corroded supports found at demo", amount: 12_800, reasonCode: "field_condition", status: "approved" },
      { coNumber: "CO-002", title: "Add second drain valve per operations", amount: 4_600, reasonCode: "owner_request", status: "proposed" },
    ],
    milestones: [
      { name: "Scaffold complete", planned: d(10), status: "completed" },
      { name: "Demo complete", planned: d(24), status: "completed" },
      { name: "Repipe 50%", planned: d(45), status: "in_progress" },
      { name: "Hydrotest", planned: d(70), status: "planned" },
      { name: "Insulation + closeout", planned: d(85), status: "planned" },
    ],
  };
}
