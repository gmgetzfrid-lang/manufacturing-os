// @vitest-environment jsdom
//
// projects Round G (J5 charts) — the Costs tab's picture layer as RENDERED:
// example data appears only on a project with no accounts and no entries, and
// every figure inside it is marked (REL-10); burn by budget line renders for
// real projects, a budget-only project gets an explanation instead of a blank
// region, and the missing-planned-line hint fires whenever the line is absent
// (REL-11); the planned crew is one stated number with its inputs, not a flat
// "curve" announced as "Daily activity" (CHART-3, A11Y-11); the CPI scope note
// and the glossary say what the forecast covers (COST-1 chart half, MON-4 dw2).

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CostCharts, { COST_GLOSSARY_TERMS, BURN_LINES_SHOWN } from "@/components/projects/cost/CostCharts";
import { computeCostRollup, type CostAccount, type CostEntry } from "@/lib/costs";

function render(el: React.ReactElement): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${renderToStaticMarkup(el)}</body>`, "text/html");
}

const account = (over: Partial<CostAccount>): CostAccount => ({
  id: "a1", projectId: "p1", code: "01-100", name: "Piping", costType: "subcontract",
  budget: 0, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active", ...over,
});
const entry = (over: Partial<CostEntry>): CostEntry => ({
  id: "e1", costAccountId: "a1", projectId: "p1", partyId: null, entryType: "actual",
  amount: 1_000, entryDate: "2026-06-10", description: null, reference: null, status: "posted",
  sourceDocumentId: null, ...over,
});

function charts(accounts: CostAccount[], entries: CostEntry[], opts: {
  start?: string | null; end?: string | null; hours?: number | null; pct?: Map<string, number>; changes?: Map<string, number>;
} = {}): Document {
  const rollup = computeCostRollup(accounts, entries, opts.pct ?? new Map(), opts.changes ?? new Map());
  return render(React.createElement(CostCharts, {
    rollup, entries, scheduleStart: opts.start ?? null, scheduleEnd: opts.end ?? null, awardedLaborHours: opts.hours ?? null,
  }));
}

const MONEY = /[$€£]\s?-?\d/;
function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walk = root.ownerDocument!.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n as Text);
  return out;
}

describe("REL-10 · example data only on an empty project, and every figure in it marked", () => {
  it("a project with no accounts and no entries sees the example; every money figure says so", () => {
    const doc = charts([], []);
    expect(doc.body.textContent).toContain("Example data");
    const figures = textNodes(doc.body).filter((t) => MONEY.test(t.data));
    expect(figures.length).toBeGreaterThan(10);
    for (const t of figures) {
      const svg = t.parentElement!.closest("svg");
      if (svg) {
        // Inside the chart: the figure's own canvas carries the watermark.
        expect(svg.querySelectorAll('[data-mark="watermark"]').length).toBeGreaterThanOrEqual(2);
        continue;
      }
      // Outside it: the figure's own element (or its row) says "example".
      const holder = t.parentElement!.closest("b, span, div, p")!;
      const row = holder.parentElement!;
      expect(`${holder.textContent} ${row.textContent}`).toMatch(/example/i);
    }
    expect(doc.querySelector("[data-forecast]")!.textContent).toMatch(/^Example — At this performance/);
    expect(doc.querySelector('[data-stat="planned-crew"]')!.textContent).toContain("people (example)");
  });

  it("a chart of accounts with blank budgets is a real project — no example numbers", () => {
    const doc = charts([account({ id: "a1" }), account({ id: "a2", code: "01-200", name: "Scaffold" })], []);
    expect(doc.body.textContent).not.toMatch(/example/i);
    expect(doc.querySelector('[data-empty="spend-curve"]')).not.toBeNull();
    expect(doc.body.textContent).toContain("Burn by budget line");
  });

  it("a ledger whose every entry was voided is a real project too", () => {
    const doc = charts([], [entry({ status: "void", costAccountId: null })]);
    expect(doc.body.textContent).not.toMatch(/example/i);
  });
});

describe("REL-11 · the real interface draws what the example promises", () => {
  it("burn by budget line renders for a real project, the most-spent lines first", () => {
    const accounts = [
      account({ id: "a1", code: "01-100", name: "Piping", budget: 190_000 }),
      account({ id: "a2", code: "01-200", name: "Scaffolding", budget: 42_000 }),
    ];
    const entries = [
      entry({ id: "e1", costAccountId: "a1", amount: 50_000, entryDate: "2026-06-10" }),
      entry({ id: "e2", costAccountId: "a2", amount: 45_000, entryDate: "2026-06-12" }),
      entry({ id: "e3", costAccountId: "a1", entryType: "commitment", amount: 150_000, entryDate: "2026-06-02" }),
    ];
    const doc = charts(accounts, entries, { start: "2026-06-01", end: "2026-08-30" });
    const text = doc.body.textContent!;
    expect(text).toContain("Burn by budget line");
    expect(text).toContain("01-100 Piping");
    expect(text).toContain("$150,000 committed · of $190,000 budget");
    expect(text).toContain("01-200 Scaffoldingover budget"); // the flag rides the label
    expect(text).not.toMatch(/example/i);
    expect(text.indexOf("01-100 Piping")).toBeLessThan(text.indexOf("01-200 Scaffolding"));
  });

  it("more lines than the list shows point at the accounts table", () => {
    const accounts = Array.from({ length: BURN_LINES_SHOWN + 3 }, (_, i) => account({ id: `a${i}`, code: `0${i}`, name: `Line ${i}`, budget: 1_000 * (i + 1) }));
    const doc = charts(accounts, []);
    expect(doc.body.textContent).toContain(`The ${BURN_LINES_SHOWN} lines with the most spent, of ${BURN_LINES_SHOWN + 3}`);
  });

  it("a budget-only project (no schedule, no entries) gets an explanation, not a blank region", () => {
    const doc = charts([account({ budget: 250_000 })], []);
    const empty = doc.querySelector('[data-empty="spend-curve"]')!;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain("No spend curve yet");
    expect(doc.querySelector("svg[role=img]")).toBeNull();
  });

  it("the missing-planned-line hint fires whenever the line is missing, and names why", () => {
    const acts = [entry({ amount: 5_000, entryDate: "2026-06-15" })];
    // Budget 0 with a full schedule: the line is omitted — the old hint (on !scheduleStart) said nothing.
    const noBudget = charts([account({ budget: 0 })], acts, { start: "2026-06-01", end: "2026-08-30" });
    expect(noBudget.querySelector('[data-series="planned"]')).toBeNull();
    expect(noBudget.body.textContent).toContain("No budget on any line yet, so there's no planned-pace line");
    const noSchedule = charts([account({ budget: 100_000 })], acts);
    expect(noSchedule.body.textContent).toContain("No schedule dates yet, so there's no planned-pace line");
    const neither = charts([account({ budget: 0 })], acts);
    expect(neither.body.textContent).toContain("No budget and no schedule dates yet");
    const both = charts([account({ budget: 100_000 })], acts, { start: "2026-06-01", end: "2026-08-30" });
    expect(both.querySelector('[data-series="planned"]')).not.toBeNull();
    expect(both.body.textContent).not.toContain("there's no planned-pace line");
  });

  it("the S-curve draws the budget it plans against — the revised budget when a change order is approved", () => {
    const doc = charts([account({ budget: 200_000 })], [entry({ amount: 20_000 })],
      { start: "2026-06-01", end: "2026-08-30", changes: new Map([["a1", 100_000]]) });
    expect(doc.querySelector('[data-mark="budget-label"]')!.textContent).toBe("Revised budget $300,000");
    const planned = doc.querySelector('[data-series="planned"]')!.getAttribute("d")!;
    const lastY = Number(planned.match(/,(-?[\d.]+)$/)![1]);
    const budgetY = Number(doc.querySelector('[data-mark="budget"]')!.getAttribute("y1"));
    expect(lastY).toBeCloseTo(budgetY, 0);
  });
});

describe("CHART-3 / A11Y-11 · the planned crew is one stated number", () => {
  it("renders the average and its inputs as text — no bars, no 'Daily activity'", () => {
    const doc = charts([account({ budget: 305_000 })], [entry({ amount: 1_000 })],
      { start: "2026-06-01", end: "2026-08-30", hours: 1_980 });
    const stat = doc.querySelector('[data-stat="planned-crew"]')!;
    expect(stat.textContent).toContain("≈ 3.9 people"); // 1,980 h ÷ (90/7) wk ÷ 40
    expect(stat.textContent).toContain("1,980 labor hours over 90 days (12.9 weeks) ÷ 40 hours per person-week");
    expect(stat.textContent).toContain("not a crew curve");
    expect(doc.querySelector('[aria-label="Daily activity"]')).toBeNull();
  });

  it("tiny hours read as a small number, never a row of zero stubs", () => {
    const doc = charts([account({ budget: 1_000 })], [entry({ amount: 10 })],
      { start: "2026-01-01", end: "2027-01-01", hours: 40 });
    expect(doc.querySelector('[data-stat="planned-crew"]')!.textContent).toContain("Under 0.1 people");
  });
});

describe("COST-1 chart half · the forecast says what the CPI covers", () => {
  it("one pinned + one unpinned account: the scope note renders beside the CPI basis", () => {
    const accounts = [
      account({ id: "a1", budget: 1_000, wbsMilestoneId: "m1" }),
      account({ id: "a2", code: "01-200", budget: 500 }),
    ];
    const entries = [entry({ id: "e1", costAccountId: "a1", amount: 400 }), entry({ id: "e2", costAccountId: "a2", amount: 500 })];
    const doc = charts(accounts, entries, { pct: new Map([["m1", 60]]) });
    const f = doc.querySelector("[data-forecast]")!.textContent!;
    expect(f).toContain("Based on cost performance so far (CPI).");
    expect(f).toMatch(/CPI applies to the 67% of budget pinned to schedule tasks/);
  });

  it("the glossary's EAC entry no longer claims budget ÷ CPI over the whole budget", () => {
    const eac = COST_GLOSSARY_TERMS.find((t) => t.term === "EAC / forecast")!;
    expect(eac.plain).toContain("pinned to schedule tasks ÷ CPI");
    expect(eac.plain).not.toContain("(budget ÷ CPI)");
  });
});

describe("MON-4 dw2 · the glossary defines the headline figure", () => {
  it("carries the Available (uncommitted) entry the money-ledger package specified", () => {
    expect(COST_GLOSSARY_TERMS).toContainEqual({
      term: "Available (uncommitted)",
      plain: "Budget minus what you've spent minus what you've promised (open commitments, net of the invoices already posted against them). The number you can still award.",
    });
  });
});
