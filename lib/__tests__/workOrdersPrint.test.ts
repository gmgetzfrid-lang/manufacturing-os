// The work orders on paper: every one shown, opened up with all its steps.

import { describe, it, expect } from "vitest";
import { workOrdersHtml, printTime, stepGaps, type PrintOrder } from "@/lib/workOrdersPrint";

const tz = "America/Los_Angeles";
const at = (s: string) => Date.parse(`2026-10-26T${s}:00-07:00`);
const order: PrintOrder = {
  wo: "301235", name: "V-7 - Transmix Fractionator", desc: "Open & inspect <tower>", crews: ["Schultz"],
  standing: "In progress", pct: 40, plan: 55, hours: -2.5,
  planStart: at("06:00"), planFinish: at("18:00"), actStart: at("08:00"), actFinish: NaN,
  added: ["1 discovery step (6 h)"], done: 1,
  steps: [
    { id: "a", name: "Set Blinds", crew: "Schultz", planStart: at("06:00"), planFinish: at("10:00"), actStart: at("08:00"), actFinish: at("11:30"), status: "Done", done: true, pct: 100, latest: { at: at("11:30"), text: "Blinds set for entry complete." } },
    { id: "b", name: "Open Manways", crew: "Schultz", planStart: at("10:00"), planFinish: at("14:00"), actStart: NaN, actFinish: NaN, status: "Not started", done: false, pct: 0, added: "Discovery",
      history: [{ at: at("12:00"), id: "b", shift: "", task: "", wo: "", step: "", crew: "", what: "Progress", pct: "0% → 20%", comment: "Pulled 2/5", enteredBy: "", enteredAt: null }] },
  ],
};

describe("workOrdersHtml", () => {
  it("each work order with all its steps, the latest comment, escaped", () => {
    const h = workOrdersHtml({ project: "TA", scope: "All work orders", printedAt: at("17:00"), tz, orders: [order], format: "report" });
    expect(h).toContain("WO 301235");
    expect(h).toContain("Open &amp; inspect &lt;tower&gt;");
    expect(h).toContain("1 work order, 2 steps");
    expect(h).toContain("2.5 h behind");
    expect(h).toContain("Blinds set for entry complete.");
    expect(h).toContain("Latest comment");
    expect((h.match(/<tr><td class="n">/g) ?? []).length).toBe(2);
    expect(h).not.toContain("Pulled 2/5");
  });
  it("with history: every change under its step instead", () => {
    const h = workOrdersHtml({ project: "TA", scope: "All", printedAt: at("17:00"), tz, orders: [order], format: "history" });
    expect(h).toContain("Progress 0% → 20% - Pulled 2/5");
    expect(h).not.toContain("Latest comment");
  });
  it("field tracker: lines to write on, spare rows, what should have happened marked", () => {
    const h = workOrdersHtml({ project: "TA", scope: "All", printedAt: at("17:00"), tz, orders: [order], format: "field" });
    expect(h).toContain("Field tracker");
    // Step b: planned 10:00–14:00, nothing recorded by 17:00.
    expect(h).toContain("⚑ Should have started by Oct 26, 10:00 AM");
    expect(h).toContain("1 start time · 1 finish time");
    expect((h.match(/<tr class="spare">/g) ?? []).length).toBe(3);
    // Recorded times print; the missing ones get a line.
    expect(h).toContain("11:30 AM");
    expect((h.match(/class="blank/g) ?? []).length).toBeGreaterThan(10);
  });
  it("flags recorded times that look wrong", () => {
    const s = { ...order.steps[0], actStart: at("06:00") - 18 * 86_400_000 };
    expect(stepGaps(s, at("17:00")).check).toEqual(["start is 18 days before plan"]);
    expect(stepGaps({ ...s, actStart: at("12:00"), actFinish: at("11:00") }, at("17:00")).check).toEqual(["finish is before start"]);
  });
  it("times in plant time", () => {
    expect(printTime(at("13:30"), tz)).toBe("Oct 26, 1:30 PM");
    expect(printTime(NaN, tz)).toBe("-");
  });
});
