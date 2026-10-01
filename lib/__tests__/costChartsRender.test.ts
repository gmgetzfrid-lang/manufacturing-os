// @vitest-environment jsdom
//
// projects Round G (J5 charts) — the Costs tab's picture layer as RENDERED:
// example data appears only on a project with no accounts and no entries, and
// every figure inside it is marked (REL-10); burn by budget line renders for
// real projects — each line in its own currency and against its own budget,
// as the accounts table below draws it — a budget-only project gets an
// explanation instead of a blank region, and the missing-planned-line hint
// fires whenever the line is absent (REL-11); the planned crew is one stated number with its inputs, not a flat
// "curve" announced as "Daily activity" (CHART-3, A11Y-11); the CPI scope note
// and the glossary say what the forecast covers (COST-1 chart half, MON-4 dw2).

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CostCharts, { COST_GLOSSARY_TERMS, BURN_LINES_SHOWN, accountCurrency, CostGlossary } from "@/components/projects/cost/CostCharts";
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

/** The burn list's row for a budget line (its title starts with the label). */
function burnRow(doc: Document, label: string): HTMLElement {
  const row = doc.querySelector<HTMLElement>(`[title^="${label} · "]`);
  if (!row) throw new Error(`no burn row for ${label}`);
  return row;
}
const bar = (row: HTMLElement, kind: "value" | "ghost") => row.querySelector<HTMLElement>(`[data-bar="${kind}"]`)!;
const width = (row: HTMLElement, kind: "value" | "ghost") => parseFloat(bar(row, kind).style.width);

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
  it("burn by budget line renders for a real project, the lines furthest through their budgets first", () => {
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
    // Scaffolding is 107% through its budget, Piping 26%: Scaffolding first.
    expect(text.indexOf("01-200 Scaffolding")).toBeLessThan(text.indexOf("01-100 Piping"));
  });

  it("each bar is the line's spent against its OWN budget — the account bars' scale — with committed behind it", () => {
    // The review's case: Piping $50k of $190k (26%), Scaffolding $45k of $42k
    // (107%, over budget). Scaled to the biggest spender, Piping drew full
    // width and Scaffolding 90% — the over-budget line read as the less burned.
    const accounts = [
      account({ id: "a1", code: "01-100", name: "Piping", budget: 190_000 }),
      account({ id: "a2", code: "01-200", name: "Scaffolding", budget: 42_000 }),
    ];
    const entries = [
      entry({ id: "e1", costAccountId: "a1", amount: 50_000 }),
      entry({ id: "e2", costAccountId: "a2", amount: 45_000 }),
      entry({ id: "e3", costAccountId: "a1", entryType: "commitment", amount: 150_000 }),
    ];
    const doc = charts(accounts, entries, { start: "2026-06-01", end: "2026-08-30" });
    const piping = burnRow(doc, "01-100 Piping");
    const scaffold = burnRow(doc, "01-200 Scaffolding");
    expect(width(piping, "value")).toBeCloseTo((50_000 / 190_000) * 100, 6);
    expect(width(piping, "ghost")).toBeCloseTo((150_000 / 190_000) * 100, 6);
    expect(bar(piping, "value").style.background).toBe("var(--viz-cat-1)");
    expect(bar(piping, "ghost").style.background).toBe("var(--viz-cat-2)");
    // Over budget: capped at the full track, in the alarm colour, as the account bar is.
    expect(width(scaffold, "value")).toBe(100);
    expect(bar(scaffold, "value").style.background).toBe("var(--viz-down)");
    // The scale is said under the list.
    expect(doc.querySelector("[data-burn-scale]")!.textContent).toContain("the line's spent against its own budget");
  });

  it("a line with nothing spent, or no budget to measure against, draws no stub", () => {
    const accounts = [
      account({ id: "a1", code: "01-100", name: "Piping", budget: 190_000 }),
      account({ id: "a2", code: "01-200", name: "Scaffolding", budget: 42_000 }),
      account({ id: "a3", code: "01-300", name: "Unbudgeted", budget: 0 }),
    ];
    const doc = charts(accounts, [entry({ id: "e1", costAccountId: "a3", amount: 7_500 })]);
    for (const label of ["01-100 Piping", "01-200 Scaffolding", "01-300 Unbudgeted"]) {
      expect(width(burnRow(doc, label), "value")).toBe(0);
      expect(width(burnRow(doc, label), "ghost")).toBe(0);
    }
    // The unbudgeted line still states its money, and why it has no bar.
    expect(burnRow(doc, "01-300 Unbudgeted").textContent).toContain("$7,500.00");
    expect(burnRow(doc, "01-300 Unbudgeted").textContent).toContain("$0.00 committed · no budget set");
  });

  it("each line is in its OWN currency, as the accounts table formats it — never the project's first currency", () => {
    // The review's case: a USD line first, then a CAD line with CA$45,000
    // spent. The table below prints CA$45,000; the list printed $45,000.
    const accounts = [
      account({ id: "a1", code: "01-100", name: "Piping", budget: 190_000, currency: "USD" }),
      account({ id: "a2", code: "01-200", name: "Scaffolding", budget: 42_000, currency: "CAD" }),
      account({ id: "a3", code: "01-300", name: "Valves", budget: 10_000_000, currency: "JPY" }),
    ];
    const entries = [
      entry({ id: "e1", costAccountId: "a1", amount: 50_000 }),
      entry({ id: "e2", costAccountId: "a2", amount: 45_000 }),
      entry({ id: "e3", costAccountId: "a3", amount: 5_000_000 }),
    ];
    const doc = charts(accounts, entries);
    const scaffold = burnRow(doc, "01-200 Scaffolding");
    expect(scaffold.textContent).toContain("CA$45,000");
    expect(scaffold.textContent).toContain("of CA$42,000 budget");
    expect(scaffold.getAttribute("title")).toBe("01-200 Scaffolding · CA$45,000");
    const piping = burnRow(doc, "01-100 Piping");
    expect(piping.textContent).toContain("$50,000");
    expect(piping.textContent).not.toContain("CA$");
    expect(burnRow(doc, "01-300 Valves").textContent).toContain("¥5,000,000");
    // A ¥5,000,000 line no longer dwarfs the rest: it is half its own budget.
    expect(width(burnRow(doc, "01-300 Valves"), "value")).toBe(50);
    expect(doc.querySelector("[data-burn-scale]")!.textContent).toContain("Each line is in its own currency.");
    // One currency: no such note.
    const single = charts([accounts[0]], [entries[0]]);
    expect(single.querySelector("[data-burn-scale]")!.textContent).not.toContain("its own currency");
  });

  it("a legacy line with no currency is USD, as the rollup counts it — never the project's first currency", () => {
    // The fourth review's case: the first line is CAD, an older line has
    // currency NULL. The list printed it as CA$ while the rollup (and the
    // mixed-currency banner) counted it as USD.
    const accounts = [
      account({ id: "a1", code: "01-100", name: "Piping", budget: 190_000, currency: "CAD" }),
      account({ id: "a2", code: "01-200", name: "Legacy", budget: 20_000, currency: null }),
    ];
    const entries = [
      entry({ id: "e1", costAccountId: "a1", amount: 50_000 }),
      entry({ id: "e2", costAccountId: "a2", amount: 12_000 }),
    ];
    const rollup = computeCostRollup(accounts, entries, new Map(), new Map());
    expect(rollup.currencies).toEqual(["CAD", "USD"]);
    // One rule: the helper names each line's currency as the rollup counts it.
    expect(accounts.map(accountCurrency)).toEqual(["CAD", "USD"]);
    expect(accountCurrency({ currency: "cad" })).toBe("CAD");
    const doc = charts(accounts, entries);
    const legacy = burnRow(doc, "01-200 Legacy");
    expect(legacy.getAttribute("title")).toBe("01-200 Legacy · $12,000");
    expect(legacy.textContent).toContain("of $20,000 budget");
    expect(legacy.textContent).not.toContain("CA$");
    expect(burnRow(doc, "01-100 Piping").getAttribute("title")).toBe("01-100 Piping · CA$50,000");
    expect(doc.querySelector("[data-burn-scale]")!.textContent).toContain("Each line is in its own currency.");
  });

  it("more lines than the list shows point at the accounts table", () => {
    const accounts = Array.from({ length: BURN_LINES_SHOWN + 3 }, (_, i) => account({ id: `a${i}`, code: `0${i}`, name: `Line ${i}`, budget: 1_000 * (i + 1) }));
    const doc = charts(accounts, []);
    const cut = doc.querySelector("[data-burn-cut]")!.textContent!;
    expect(cut).toContain(`Showing ${BURN_LINES_SHOWN} of ${BURN_LINES_SHOWN + 3}: lines over budget first, then lines with money but no budget, then the lines furthest through their budgets.`);
    expect(cut).toContain("Every line is in the accounts table below.");
    expect(cut).not.toContain("didn't fit"); // no alarm was cut
  });

  it("the cut never drops an alarm: an over-committed line and an unbudgeted line with spend lead the list", () => {
    // The fourth review's probe: nine lines half through their budgets, then
    // a line with $250,000 committed on a $100,000 budget and nothing
    // invoiced (over budget on exposure — DEC-50's early-job alarm), and a
    // line with $400,000 spent on no budget. Ordered on spent ÷ budget alone,
    // the list showed eight "Half" lines and neither alarm.
    const halves = Array.from({ length: 9 }, (_, i) => account({ id: `h${i}`, code: `0${i}`, name: `Half ${i}`, budget: 100_000 }));
    const accounts = [
      ...halves,
      account({ id: "oc", code: "90", name: "OverCommitted", budget: 100_000 }),
      account({ id: "ub", code: "91", name: "Unbudgeted", budget: 0 }),
    ];
    const entries = [
      ...halves.map((a, i) => entry({ id: `x${i}`, costAccountId: a.id, amount: 50_000 })),
      entry({ id: "c1", costAccountId: "oc", entryType: "commitment", amount: 250_000 }),
      entry({ id: "u1", costAccountId: "ub", amount: 400_000 }),
    ];
    const doc = charts(accounts, entries);
    const rows = [...doc.querySelectorAll<HTMLElement>("[data-bar='value']")].map((b) => b.closest<HTMLElement>("[title]")!.getAttribute("title")!);
    expect(rows).toHaveLength(BURN_LINES_SHOWN);
    // Over budget first, then money with no budget, then the rest.
    expect(rows[0]).toBe("90 OverCommitted · $0.00");
    expect(rows[1]).toBe("91 Unbudgeted · $400,000");
    expect(rows.slice(2).every((t) => t.startsWith("0"))).toBe(true);
    const oc = burnRow(doc, "90 OverCommitted");
    expect(oc.textContent).toContain("over budget"); // the accounts table's flag for the same line
    expect(bar(oc, "value").style.background).toBe("var(--viz-down)");
    expect(width(oc, "ghost")).toBe(100);
    expect(burnRow(doc, "91 Unbudgeted").textContent).toContain("no budget set");
    const cut = doc.querySelector("[data-burn-cut]")!.textContent!;
    expect(cut).toContain(`Showing ${BURN_LINES_SHOWN} of 11: lines over budget first`);
    expect(cut).not.toContain("didn't fit");
  });

  it("alarms beyond the cut are counted under the list, never dropped silently", () => {
    // Ten lines over budget: eight fit, and the list says two more did not.
    const accounts = Array.from({ length: 10 }, (_, i) => account({ id: `o${i}`, code: `${10 + i}`, name: `Over ${i}`, budget: 1_000 }));
    const entries = accounts.map((a, i) => entry({ id: `x${i}`, costAccountId: a.id, amount: 1_100 + i * 10 }));
    const doc = charts(accounts, entries);
    // Within the alarms, the line furthest over its budget first.
    const first = doc.querySelector<HTMLElement>("[data-bar='value']")!.closest("[title]")!.getAttribute("title");
    expect(first).toBe("19 Over 9 · $1,190.00");
    expect(doc.querySelector("[data-burn-cut]")!.textContent).toContain("2 more lines are over budget or unbudgeted and didn't fit.");
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

  it("blank budgets and a schedule with nothing posted: an explanation, not flat lines on a '$1' axis", () => {
    const doc = charts([account({ budget: 0 })], [], { start: "2026-06-01", end: "2026-08-30" });
    const empty = doc.querySelector('[data-empty="spend-curve"]')!;
    expect(empty.getAttribute("data-reason")).toBe("no-money");
    expect(empty.textContent).toContain("there's no money to plot");
    expect(doc.querySelector("svg[role=img]")).toBeNull();
    expect(doc.body.textContent).not.toContain("there's no planned-pace line");
    expect(doc.body.textContent).not.toMatch(/\$1(?!\d)/);
    // The same with every entry voided.
    const voided = charts([account({ budget: 0 })], [entry({ status: "void" })], { start: "2026-06-01", end: "2026-08-30" });
    expect(voided.querySelector('[data-empty="spend-curve"]')!.getAttribute("data-reason")).toBe("no-money");
    // No dates at all keeps the dates explanation.
    expect(charts([account({ budget: 0 })], []).querySelector('[data-empty="spend-curve"]')!.getAttribute("data-reason")).toBe("no-dates");
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

describe("final review · the glossary says what the rollup computes for Spent and Unspent", () => {
  // computeCostRollup: spent = actual + adjustments (signed); Unspent
  // (remainingActualsOnly) = revisedBudget − spent; Available (remaining) =
  // revisedBudget − spent − openCommitments, and openCommitments ≥ 0.
  const SPENT = "Spent = actuals plus signed adjustments (a negative adjustment credits money back).";
  const UNSPENT = "The revised budget minus Spent — it ignores open commitments, so it is never smaller than Available.";

  it("the rendered glossary carries the two sentences, and neither old misstatement", () => {
    const doc = render(React.createElement(CostGlossary));
    const entry = (term: string) => [...doc.querySelectorAll("dt")].find((dt) => dt.textContent === term)!.nextElementSibling!.textContent!;
    expect(entry("Actual")).toBe(`Money that really left — an invoice or timesheet posted against a budget line. ${SPENT}`);
    expect(entry("Unspent (actuals only)")).toBe(UNSPENT);
    const all = doc.body.textContent!;
    expect(all).not.toContain("Actuals add up to Spent");
    expect(all).not.toContain("minus the actuals alone");
  });

  it("…and each sentence is the rollup's own arithmetic, on a line with a NEGATIVE adjustment", () => {
    const accounts = [account({ id: "a1", budget: 1_000 })];
    const entries = [
      entry({ id: "e1", entryType: "actual", amount: 500, partyId: "p-q" }),
      entry({ id: "e2", entryType: "adjustment", amount: -100 }),                 // a credit back
      entry({ id: "e3", entryType: "commitment", amount: 300, partyId: "p-c" }),  // promised, not yet invoiced
    ];
    const r = computeCostRollup(accounts, entries, new Map(), new Map([["a1", 200]]));   // + an approved CO
    const line = r.accounts[0];
    expect(line.revisedBudget).toBe(1_200);
    // Spent = actuals plus signed adjustments — not the actuals alone (500)
    expect(line.spent).toBe(500 + -100);
    expect(r.spent).toBe(400);
    // Unspent = the revised budget minus Spent — not minus the actuals alone (700)
    expect(line.remainingActualsOnly).toBe(1_200 - 400);
    expect(r.remainingActualsOnly).toBe(800);
    // it ignores the open commitment that Available subtracts …
    expect(line.openCommitments).toBe(300);
    expect(line.remaining).toBe(1_200 - 400 - 300);
    // … so it is never smaller than Available: the gap is exactly the open commitments
    expect(line.remainingActualsOnly - line.remaining).toBe(line.openCommitments);
    expect(line.remainingActualsOnly).toBeGreaterThanOrEqual(line.remaining);
  });
});
