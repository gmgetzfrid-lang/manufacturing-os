// The pen-and-paper field tracker: a blank form, lines a step from the plan.

import { describe, it, expect } from "vitest";
import { linesFor, inRange, fieldTrackerHtml, fieldPages, sortOrders, planText, wrapLines, type FieldOrder } from "@/lib/fieldTracker";

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
    expect(h).toContain("<b>TA</b>Field tracker");
    expect(h).toContain("Page 1 of 1");
    expect(h).toContain("WO 301502");
    expect(h).toContain('Resources <span class="pill">Schultz</span> <span class="pill">Ancon</span> <span class="pill">Inspector (KE)</span>');
    expect(h).toContain("Plan <b>Oct 26 10:00 AM to Oct 29 10:00 AM</b>");
    expect(h).toContain("Hydroblast 10K Tubes &amp; Shell");
    expect(h).toContain('Plan Oct 27 4:00 AM to 8:00 AM</div><span class="pill">Ancon</span>');
    expect(h).toContain('Plan Oct 26 10:00 AM to 12:00 PM</div><span class="pill">Schultz</span>');
    expect(h).toMatch(/Step &amp; plan[\s\S]*Start \(date &amp; time\)[\s\S]*Finish \(date &amp; time\)[\s\S]*%[\s\S]*Notes/);
    // Lines from each step's own plan: 2 h and 4 h, 2 lines each.
    expect(rowsOf(h)).toBe(4);
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

const mk = (wo: string | null, name: string, start: string, steps: Array<[string, number]>, crew = "Schultz"): FieldOrder => {
  const t0 = at(start);
  let t = t0;
  const st = steps.map(([n, h], i) => { const s = { id: `${wo ?? name}-${i}`, name: n, crew, planStart: t, planFinish: t + h * H }; t += h * H; return s; });
  return { key: `${wo}:${name}`, wo, name, crews: [crew], planStart: t0, planFinish: t, steps: st };
};
const sections = (h: string) => h.split('<section class="pg').slice(1);

describe("finding a work order on paper", () => {
  const job = [
    mk(null, "Transmix-1 - Shutdown", "10-24", [["Pull Feed", 4], ["Cool Down", 12]], "Operations (KE)"),
    mk("310504", "E-16 - Trans. Diesel Cooler", "10-27", [["Set Blinds; Verify LOTO", 2], ["Remove Components", 6], ["Pull Bundle", 30]]),
    mk("301235", "V-7 - Transmix Fractionator", "10-26", Array.from({ length: 14 }, (_, i) => [`Tray section ${i + 1} inspect and repair`, 20] as [string, number])),
    mk("9000", "Small job", "10-25", [["Swap gauge", 2]]),
    mk("301502", "E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2", "10-26", [["Set Blinds; Verify LOTO", 2], ["Hydroblast 10K Tubes & Shell", 4]]),
  ];
  it("WO number order: numbers as numbers, no WO last; or as planned", () => {
    expect(sortOrders(job, "wo").map((o) => o.wo)).toEqual(["9000", "301235", "301502", "310504", null]);
    expect(sortOrders(job, "plan").map((o) => o.wo)).toEqual([null, "9000", "301502", "301235", "310504"]);
  });
  it("every page: Page n of N and the work orders on it in its corner; page 1 lists each work order and its page", () => {
    const h = fieldTrackerHtml({ project: "TA", tz, orders: job, lines: "auto" });
    const pages = sections(h);
    expect(fieldPages(h)).toBe(pages.length);
    expect(pages.length).toBeGreaterThan(2);
    pages.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${pages.length}`));
    // The index: on page 1, in WO number order, each with the page its bar is on.
    expect(pages[0]).toContain("Find a work order");
    const idx = [...pages[0].matchAll(/<div class="ie"><b>([^<]+)<\/b><span>[^<]*<\/span><i>(\d+)<\/i><\/div>/g)].map((m) => [m[1], Number(m[2])]);
    expect(idx.map((x) => x[0])).toEqual(["9000", "301235", "301502", "310504", "No WO"]);
    for (const [wo, page] of idx) {
      const word = wo === "No WO" ? "No WO" : `WO ${wo}`;
      expect(pages[(page as number) - 1]).toContain(`<span class="n">${word}</span>`);
      expect(pages[(page as number) - 1]).not.toMatch(new RegExp(`<span class="n">${word}</span>[^<]*<span class="c">continued`));
    }
    // The corner: each page names the work orders on it.
    for (const p of pages) {
      const corner = /<span class="gw">([^<]*)<\/span>/.exec(p)![1];
      const on = [...new Set([...p.matchAll(/<span class="n">(?:WO )?([^<]+)<\/span>/g)].map((m) => m[1]))];
      if (on.length <= 4) for (const w of on) expect(corner).toContain(w);
    }
  });
  it("a work order carried onto the next page says so there, with the page it starts on; a step is never split", () => {
    const h = fieldTrackerHtml({ project: "TA", tz, orders: job, lines: "auto" });
    const pages = sections(h);
    const v7 = pages.map((p, i) => (p.includes(">WO 301235</span>") ? i + 1 : 0)).filter(Boolean);
    expect(v7.length).toBeGreaterThan(1);
    for (const n of v7.slice(1)) expect(pages[n - 1]).toContain(`<span class="n">WO 301235</span>V-7 - Transmix Fractionator<span class="c">continued from page ${v7[0]}</span>`);
    // Every step's rows on one page: each page's rows add up to its steps' rowspans.
    for (const p of pages) {
      const spans = [...p.matchAll(/rowspan="(\d+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
      expect(p.match(/<td class="pct">%<\/td>/g)?.length ?? 0).toBe(spans);
    }
    // A short work order isn't split.
    expect(pages.filter((p) => p.includes(">WO 9000</span>")).length).toBe(1);
  });
  it("no page holds more than fits on a landscape letter page", () => {
    const h = fieldTrackerHtml({ project: "TA", tz, orders: job, lines: 8 });
    for (const p of sections(h)) {
      const rows = (p.match(/<tr class="r/g) ?? []).length * 0.36;
      const bars = [...p.matchAll(/min-height:([\d.]+)in/g)].reduce((n, m) => n + Number(m[1]) + 0.03, 0);
      const idx = p.includes('class="idx"') ? 0.5 + Math.ceil((p.match(/<div class="ie"><b>/g) ?? []).length / 2) * 0.215 + 0.14 : 0;
      expect(0.56 + (p.includes('class="how"') ? 0.28 : 0) + idx + (p.includes("<thead>") ? 0.27 : 0) + rows + bars).toBeLessThanOrEqual(7.55);
    }
  });
  it("one work order: no index", () => {
    const h = fieldTrackerHtml({ project: "TA", tz, orders: [job[1]], lines: "auto" });
    expect(h).not.toContain("Find a work order");
    expect(h).toContain('<span class="gw">WO 310504</span>');
  });
  it("plan on one day shows the date once; a long name wraps to more lines", () => {
    expect(planText(at("10-26", "10:00"), at("10-26", "12:00"), tz)).toBe("Oct 26 10:00 AM to 12:00 PM");
    expect(planText(at("10-26", "10:00"), at("10-27", "08:00"), tz)).toBe("Oct 26 10:00 AM to Oct 27 8:00 AM");
    expect(wrapLines("Set Blinds", 10, true, 2.4)).toBe(1);
    expect(wrapLines("Fabricate and install new vortex breaker on the bottom outlet nozzle of the tower", 10, true, 2.4)).toBeGreaterThan(2);
  });
});
