// The pen-and-paper field tracker: a blank form, lines a step from the plan.

import { describe, it, expect } from "vitest";
import { linesFor, inRange, fieldTrackerHtml, type FieldOrder } from "@/lib/fieldTracker";

const tz = "America/Los_Angeles";
const H = 3_600_000;
const at = (d: string, hm = "06:00") => Date.parse(`2026-${d}T${hm}:00-07:00`);
const e12: FieldOrder = {
  key: "e12", wo: "301502", name: "E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2", crews: ["Schultz", "Ancon", "Inspector (KE)"],
  planStart: at("10-26", "10:00"), planFinish: at("10-29", "10:00"),
  steps: [
    { id: "a", name: "Set Blinds; Verify LOTO", crew: "Schultz", planStart: at("10-26", "10:00"), planFinish: at("10-26", "12:00") },
    { id: "b", name: "Hydroblast 10K Tubes & Shell", crew: "Ancon", planStart: at("10-27", "04:00"), planFinish: at("10-27", "08:00") },
  ],
};
const rowsOf = (h: string) => (h.match(/<td class="pct">%<\/td>/g) ?? []).length;

describe("lines a step, from how long the plan is", () => {
  it("a few hours 2, half a day 3, a day 4, two days 5, three to four 6, five to six 7, a week or more 8", () => {
    expect([2 * H, 4 * H, 10 * H, 24 * H, 40 * H, 72 * H, 96 * H, 5 * 24 * H, 6.9 * 24 * H, 7 * 24 * H, 90 * 24 * H].map(linesFor)).toEqual([2, 2, 3, 4, 5, 6, 6, 7, 7, 8, 8]);
  });
});

describe("the form", () => {
  it("blank: each work order with its resources and plan, each step with its plan and resource, Start / Finish / % / Notes", () => {
    const h = fieldTrackerHtml({ project: "TA", tz, orders: [e12], lines: "auto" });
    expect(h).toContain("TA - Field tracker");
    expect(h).toContain("WO 301502");
    expect(h).toContain('Resources <span class="pill">Schultz</span> <span class="pill">Ancon</span> <span class="pill">Inspector (KE)</span>');
    expect(h).toContain("Plan <b>Oct 26 10:00 AM to Oct 29 10:00 AM</b>");
    expect(h).toContain("Hydroblast 10K Tubes &amp; Shell");
    expect(h).toContain('Plan Oct 27 4:00 AM to Oct 27 8:00 AM</div><span class="pill">Ancon</span>');
    expect(h).toContain('Plan Oct 26 10:00 AM to Oct 26 12:00 PM</div><span class="pill">Schultz</span>');
    expect(h).toMatch(/Step &amp; plan.*Start \(date &amp; time\).*Finish \(date &amp; time\).*%.*Notes/s);
    // A 3-day work order: 6 lines for each of its 2 steps.
    expect(rowsOf(h)).toBe(12);
    expect(rowsOf(fieldTrackerHtml({ project: "TA", tz, orders: [e12], lines: 4 }))).toBe(8);
    expect(h).not.toMatch(/Step #|continuation/i);
  });
  it("one step: a sheet of its own, full of lines", () => {
    const h = fieldTrackerHtml({ project: "TA", tz, orders: [e12], lines: "auto", step: "b" });
    expect(h).toContain("Field tracker: one step");
    expect(h).toContain("<b>Hydroblast 10K Tubes &amp; Shell</b>");
    expect(h).toContain('Resource <span class="pill">Ancon</span>');
    expect(rowsOf(h)).toBe(16);
  });
  it("a date range: only the work planned then, lines from how much of each step falls in it", () => {
    const orders = inRange([e12], at("10-27", "00:00"), at("10-28", "00:00"));
    expect(orders[0].steps.map((s) => s.id)).toEqual(["b"]);
    const h = fieldTrackerHtml({ project: "TA", tz, orders, lines: "auto", range: { from: at("10-27", "00:00"), to: at("10-28", "00:00") } });
    expect(h).toContain("Field tracker: Oct 27 to Oct 27");
    // Hydroblast: 4 h in the range.
    expect(rowsOf(h)).toBe(2);
    expect(fieldTrackerHtml({ project: "TA", tz, orders: [], lines: "auto", range: { from: 0, to: 1 } })).toContain("No work planned in these dates.");
  });
});
