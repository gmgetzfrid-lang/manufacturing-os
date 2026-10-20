// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P3 fix pass 3 — LEAK-9 done-when 2 / GAP-107
// acceptance 2 as RENDERED on /admin/analytics ("How Requests Ended").
//
// Until DF-P9 ships the cancel-category picker, every cancel from the request
// page records no outcome (lib/ticketOutcome.ts defaultOutcome — never a
// guessed leak), while every acknowledged close records "completed". A rate
// over the recorded rows alone is then 0 % by construction: it would tell a
// manager that nothing leaves the app, the opposite of what the instrument is
// for (DEC-29: a number never claims more than it measured). So:
//   * no cancel named a category, and some named none → the rate is NOT
//     MEASURED ('—'), and the block says how many cancels named no category;
//   * some cancels named one → the rate is shown over the recorded rows, and
//     the cancels that named none are counted NEXT to it, as not in it;
//   * per request type, the same rule per type.

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RequestOutcomes from "@/components/requests/RequestOutcomes";
import { summarizeOutcomes, type OutcomeRow } from "@/lib/ticketOutcome";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function render(rows: OutcomeRow[]): Document {
  const html = renderToStaticMarkup(React.createElement(RequestOutcomes, { summary: summarizeOutcomes(rows) }));
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}
const n = (k: number, row: OutcomeRow): OutcomeRow[] => Array.from({ length: k }, () => ({ ...row }));
const text = (d: Document, id: string) => d.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, " ").trim() ?? null;

describe("LEAK-9 — the leak-rate headline never overclaims", () => {
  it("140 acknowledged closes + 40 cancels that named no category → NOT MEASURED, never '0.0%', and the 40 are named", () => {
    const d = render([...n(140, { status: "CLOSED", outcome: "completed", requestType: "ISO" }), ...n(40, { status: "CANCELED", outcome: null, requestType: "ISO" })]);
    expect(text(d, "leak-rate")).toBe("—");
    expect(text(d, "leak-rate-line")).toContain("not measured yet: 40 cancels named no category");
    expect(d.body.textContent).not.toContain("0.0%");
    // per type: the same rule
    const row = d.querySelector('[data-testid="outcomes-type-ISO"]');
    expect(row?.textContent).toContain("—");
    expect(row?.textContent).not.toContain("0.0%");
    expect(text(d, "outcomes-type-ISO-uncategorized")).toBe("40");
  });
  it("some cancels named a category → the rate is shown over the recorded rows, and the cancels that named none are counted NEXT to it", () => {
    const d = render([
      ...n(140, { status: "CLOSED", outcome: "completed", requestType: "ISO" }),
      ...n(5, { status: "CANCELED", outcome: "withdrawn", requestType: "ISO" }),
      ...n(5, { status: "CANCELED", outcome: "duplicate", requestType: "ISO" }),
      ...n(40, { status: "CANCELED", outcome: null, requestType: "ISO" }),
    ]);
    expect(text(d, "leak-rate")).toBe("3.3%");
    expect(text(d, "leak-rate-line")).toContain("of 150 ended requests with a recorded outcome");
    expect(text(d, "leak-rate-line")).toContain("40 cancels named no category and are not in this rate");
  });
  it("REGRESSION: with no cancel lacking a category the block reads exactly as before", () => {
    const d = render([
      { status: "CLOSED", outcome: "completed", requestType: "ISO" },
      { status: "CANCELED", outcome: "handled_out_of_band", requestType: "ISO" },
      { status: "CLOSED", outcome: null, requestType: "MOC" }, // a force close that named none: not a cancel
    ]);
    expect(text(d, "leak-rate")).toBe("50.0%");
    expect(text(d, "leak-rate-line")).toContain("of 2 ended requests with a recorded outcome");
    expect(text(d, "leak-rate-line")).not.toContain("named no category");
    expect(render([]).querySelector('[data-testid="leak-rate"]')?.textContent).toBe("—");
  });
  it("summarizeOutcomes says why the rate is absent (nothing recorded vs not measured) and counts the uncategorized cancels", () => {
    const s = summarizeOutcomes([...n(3, { status: "CLOSED", outcome: "completed", requestType: "ISO" }), ...n(2, { status: "CANCELED", outcome: null, requestType: "ISO" })]);
    expect(s).toMatchObject({ leakRate: null, notMeasured: true, uncategorizedCancels: 2 });
    expect(s.byType[0]).toMatchObject({ requestType: "ISO", leakRate: null, notMeasured: true, uncategorizedCancels: 2 });
    expect(summarizeOutcomes([])).toMatchObject({ leakRate: null, notMeasured: false, uncategorizedCancels: 0 });
  });
  it("the page renders the block from the summary (no second computation)", () => {
    const p = readFileSync(join(process.cwd(), "app/(protected)/admin/analytics/page.tsx"), "utf8");
    // drafting-flow DF-P16 (GAP-13 acceptance 2): the per-reason breakdown rides beside the same summary
    expect(p).toContain("<RequestOutcomes summary={outcomes} reasons={outcomeReasons} />");
  });
});
