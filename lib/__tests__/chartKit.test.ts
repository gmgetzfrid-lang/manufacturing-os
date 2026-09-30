// @vitest-environment jsdom
//
// projects Round G (J5 charts) — the chart kit as RENDERED: the S-curve's
// scale is bounded below (CHART-1), its two money series differ by hue from
// the validated categorical scale AND by shape (CHART-2), no literal colour
// remains and the score band's text reads in both themes (CHART-4), the today
// marker sits at today and is labelled, gridlines carry values and a budget
// line is drawn whenever there is a budget (CHART-5), and stand-in data carries
// its watermark inside the figure (REL-10).

import { describe, it, expect } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SCurveChart, sCurveScale, sCurveTodayX, sCurveTodayLabel, SCURVE_VIEWBOX, scoreBandColor, ScoreDial, BarList,
  type SCurvePoint,
} from "@/components/ui/ChartKit";
import { vizCat, MiniBars } from "@/components/dashboard/viz";
import { buildCostSeries } from "@/lib/costSeries";

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function render(el: React.ReactElement): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${renderToStaticMarkup(el)}</body>`, "text/html");
}

/** Every y a mark projects to: path vertices, circles, rects, lines. */
function markYs(doc: Document): number[] {
  const ys: number[] = [];
  doc.querySelectorAll("svg path").forEach((p) => {
    for (const m of (p.getAttribute("d") ?? "").matchAll(/[ML]\s*(-?[\d.]+),(-?[\d.]+)/g)) ys.push(Number(m[2]));
  });
  doc.querySelectorAll("svg circle").forEach((c) => ys.push(Number(c.getAttribute("cy"))));
  doc.querySelectorAll("svg rect").forEach((r) => {
    const y = Number(r.getAttribute("y"));
    ys.push(y, y + Number(r.getAttribute("height")));
  });
  doc.querySelectorAll("svg line").forEach((l) => ys.push(Number(l.getAttribute("y1")), Number(l.getAttribute("y2"))));
  return ys;
}

// ── relative luminance / WCAG contrast, for the token checks ────────────────
function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** A token's value in the light @theme block and in the .dark block. */
function tokenValues(name: string): { light: string; dark: string } {
  const css = read("app/globals.css");
  const theme = css.slice(css.indexOf("@theme {"), css.indexOf("\n}", css.indexOf("@theme {")));
  const darkStart = css.indexOf(".dark {");
  const dark = css.slice(darkStart, css.indexOf("\n}", darkStart));
  const pick = (block: string) => block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? "";
  return { light: pick(theme), dark: pick(dark) };
}

// ── CHART-1 ──────────────────────────────────────────────────────────────────

describe("CHART-1 · the S-curve's scale is bounded below", () => {
  it("the audit's measured rows render entirely inside the viewBox, with a zero line", () => {
    // Row 1: $200k budget, a −$40k credit then +$150k (was max y 232.8 on a 220 canvas).
    const credit = buildCostSeries({
      budget: 200_000, scheduleStart: "2026-01-01", scheduleEnd: "2026-06-30",
      commitments: [{ date: "2026-01-15", amount: -40_000 }, { date: "2026-04-01", amount: 150_000 }], actuals: [],
    });
    // Row 2: budget 0, a single −$5,000 adjustment (was every mark ~920,196 units below).
    const lone = buildCostSeries({ budget: 0, commitments: [], actuals: [{ date: "2026-02-01", amount: -5_000 }] });
    for (const [points, budget] of [[credit, 200_000], [lone, 0]] as const) {
      const doc = render(React.createElement(SCurveChart, { points, fmt: usd, budget }));
      const ys = markYs(doc);
      expect(ys.length).toBeGreaterThan(40);
      for (const y of ys) {
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(SCURVE_VIEWBOX.height);
      }
      expect(doc.querySelector('[data-mark="zero"]')).not.toBeNull();
    }
    // The −$5,000 line is drawn inside the plot, not off it: its vertices sit on the plot's floor band.
    const doc = render(React.createElement(SCurveChart, { points: lone, fmt: usd }));
    const spent = [...(doc.querySelector('[data-series="spent"]')!.getAttribute("d") ?? "").matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...spent)).toBeLessThanOrEqual(SCURVE_VIEWBOX.height - 24);
    expect(Math.min(...spent)).toBeGreaterThanOrEqual(12);
  });

  it("a scale with nothing below zero keeps its zero floor and draws no zero line", () => {
    const s = sCurveScale([0, 50_000, 120_000]);
    expect(s.lo).toBe(0);
    expect(s.ticks[0]).toBe(0);
    expect(s.hi).toBeGreaterThanOrEqual(120_000);
    expect(s.py(0)).toBe(SCURVE_VIEWBOX.height - 24);
    const pts: SCurvePoint[] = [
      { date: "2026-01-01", planned: 0, committed: 0, actual: 0 },
      { date: "2026-02-01", planned: 10, committed: 5, actual: 3 },
    ];
    expect(render(React.createElement(SCurveChart, { points: pts, fmt: usd })).querySelector('[data-mark="zero"]')).toBeNull();
  });

  it("the domain includes negative values and clean ticks that bracket them", () => {
    const s = sCurveScale([-40_000, 0, 110_000, 200_000]);
    expect(s.lo).toBeLessThanOrEqual(-40_000);
    expect(s.hi).toBeGreaterThanOrEqual(200_000);
    expect(s.ticks).toContain(0);
    for (const v of [-40_000, 0, 200_000]) {
      expect(s.py(v)).toBeGreaterThanOrEqual(12);
      expect(s.py(v)).toBeLessThanOrEqual(SCURVE_VIEWBOX.height - 24);
    }
  });
});

// ── CHART-5 ──────────────────────────────────────────────────────────────────

describe("CHART-5 · today at today, labelled; gridlines with values; a budget line", () => {
  // Three years at 40 samples: the samples are 28 days apart.
  const long = buildCostSeries({
    budget: 3_000_000, scheduleStart: "2026-01-01", scheduleEnd: "2028-12-30",
    commitments: [{ date: "2026-02-01", amount: 1_000_000 }], actuals: [{ date: "2026-03-01", amount: 200_000 }],
  });

  it("the marker is interpolated from today's date, not snapped to the next 28-day sample", () => {
    const gap = Date.parse(long[1].date) - Date.parse(long[0].date);
    expect(gap / 86_400_000).toBeGreaterThanOrEqual(27);
    const today = "2027-03-10";
    const t0 = Date.parse(long[0].date), t1 = Date.parse(long.at(-1)!.date);
    const truth = 8 + ((Date.parse(today) - t0) / (t1 - t0)) * (SCURVE_VIEWBOX.width - 16);
    expect(sCurveTodayX(long, today)).toBeCloseTo(truth, 6);
    const doc = render(React.createElement(SCurveChart, { points: long, fmt: usd, todayIso: today }));
    const line = doc.querySelector('[data-mark="today"] line')!;
    expect(Number(line.getAttribute("x1"))).toBeCloseTo(truth, 6);
    // The old snap: the first sample on or after today.
    const idx = long.findIndex((p) => p.date >= today);
    const snapped = 8 + (idx / (long.length - 1)) * (SCURVE_VIEWBOX.width - 16);
    expect(Math.abs(snapped - truth)).toBeGreaterThan(1);
    // Labelled on the mark, titled, and in the legend.
    expect(doc.querySelector('[data-mark="today"] text')!.textContent).toBe("Today");
    expect(line.querySelector("title")!.textContent).toMatch(/^Today — /);
    expect(doc.body.textContent).toMatch(/Today$/m);
    expect([...doc.querySelectorAll("div span")].some((s) => s.textContent?.trim() === "Today")).toBe(true);
  });

  it("today on the first sample is still drawn; outside the span it is not", () => {
    expect(sCurveTodayX(long, long[0].date)).toBe(8);
    expect(render(React.createElement(SCurveChart, { points: long, fmt: usd, todayIso: long[0].date })).querySelector('[data-mark="today"]')).not.toBeNull();
    expect(sCurveTodayX(long, "2025-12-31")).toBeNull();
    expect(sCurveTodayX(long, "2029-01-01")).toBeNull();
  });

  it("every gridline carries its value", () => {
    const doc = render(React.createElement(SCurveChart, { points: long, fmt: usd, tickFmt: (n: number) => `T${n}` }));
    const grid = [...doc.querySelectorAll('[data-mark="grid"]')];
    const labels = [...doc.querySelectorAll('[data-mark="grid-label"]')];
    expect(grid.length).toBeGreaterThanOrEqual(3);
    const { ticks, py } = sCurveScale([...long.flatMap((p) => [p.planned ?? 0, p.committed, p.actual])]);
    expect(grid.map((g) => Number(g.getAttribute("data-value")))).toEqual(ticks);
    expect(labels.map((l) => l.textContent)).toEqual(ticks.map((t) => `T${t}`));
    // Each label sits on its own gridline.
    labels.forEach((l, i) => expect(Number(l.getAttribute("y"))).toBeCloseTo(py(ticks[i]) - 3, 6));
  });

  it("a budget line is drawn and labelled whenever there is a budget — schedule or not", () => {
    const noSchedule = buildCostSeries({ budget: 500_000, commitments: [{ date: "2026-01-05", amount: 40_000 }], actuals: [{ date: "2026-01-20", amount: 10_000 }] });
    expect(noSchedule.every((p) => p.planned === null)).toBe(true);
    const doc = render(React.createElement(SCurveChart, { points: noSchedule, fmt: usd, budget: 500_000 }));
    expect(doc.querySelector('[data-mark="budget"]')).not.toBeNull();
    expect(doc.querySelector('[data-mark="budget-label"]')!.textContent).toBe("Budget $500,000");
    expect(doc.querySelector("svg")!.getAttribute("aria-label")).toContain("budget $500,000");
    // No budget → no line.
    expect(render(React.createElement(SCurveChart, { points: noSchedule, fmt: usd, budget: 0 })).querySelector('[data-mark="budget"]')).toBeNull();
  });

  it("the verified-sound accessibility is kept: role=img with a value-bearing label, a text legend, a dashed planned line", () => {
    const doc = render(React.createElement(SCurveChart, { points: long, fmt: usd, budget: 3_000_000 }));
    const svg = doc.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Cost curve — actual $200,000, committed $1,000,000, planned $3,000,000, budget $3,000,000");
    expect(doc.querySelector('[data-series="planned"]')!.getAttribute("stroke-dasharray")).toBe("5 4");
    expect(doc.body.textContent).toContain("Planned pace");
    expect(doc.body.textContent).toContain("Spent $200,000");
  });
});

describe("CHART-5 / DEC-52 · the axis and labels say only what the data holds (review fix)", () => {
  it("a chart with no money in it labels only the zero gridline — never an invented '$1'", () => {
    expect(sCurveScale([0, 0, 0]).ticks).toEqual([0]);
    expect(sCurveScale([]).ticks).toEqual([0]);
    // A schedule, no budget, nothing posted: every value is zero.
    const flat = buildCostSeries({ budget: 0, scheduleStart: "2026-06-01", scheduleEnd: "2026-08-30", commitments: [], actuals: [] });
    expect(flat.length).toBeGreaterThanOrEqual(2);
    const doc = render(React.createElement(SCurveChart, { points: flat, fmt: usd }));
    expect([...doc.querySelectorAll('[data-mark="grid-label"]')].map((l) => l.textContent)).toEqual(["$0"]);
    expect(doc.querySelectorAll('[data-mark="grid"]')).toHaveLength(1);
    expect(doc.body.textContent).not.toContain("$1");
    // Real money keeps its labelled scale.
    expect(sCurveScale([0, 0.5]).ticks.length).toBeGreaterThan(1);
  });

  it("early in the span the Today label drops inside the plot, clear of the top gridline's label", () => {
    const long = buildCostSeries({
      budget: 3_000_000, scheduleStart: "2026-01-01", scheduleEnd: "2028-12-30",
      commitments: [{ date: "2026-02-01", amount: 1_000_000 }], actuals: [{ date: "2026-03-01", amount: 200_000 }],
    });
    for (const today of [long[0].date, "2026-01-20", "2026-02-20"]) {
      const doc = render(React.createElement(SCurveChart, { points: long, fmt: usd, todayIso: today }));
      const topLabel = [...doc.querySelectorAll('[data-mark="grid-label"]')].reduce((a, b) =>
        Number(a.getAttribute("y")) <= Number(b.getAttribute("y")) ? a : b);
      const todayText = doc.querySelector('[data-mark="today"] text')!;
      const x = Number(doc.querySelector('[data-mark="today"] line')!.getAttribute("x1"));
      expect(x).toBeLessThan(8 + 56);
      // Below the top label's line of text (9-unit type), and beside the marker.
      expect(Number(todayText.getAttribute("y")) - 9).toBeGreaterThanOrEqual(Number(topLabel.getAttribute("y")));
      expect(todayText.getAttribute("text-anchor")).toBe("start");
      expect(Number(todayText.getAttribute("x"))).toBeGreaterThan(x);
    }
    // Mid-span it stays above the plot, centred on the marker.
    expect(sCurveTodayLabel(300)).toEqual({ x: 300, y: 9, anchor: "middle" });
    expect(sCurveTodayLabel(590).anchor).toBe("end");
  });
});

// ── CHART-2 ──────────────────────────────────────────────────────────────────

describe("CHART-2 · Spent and Committed differ by hue from the validated scale AND by shape", () => {
  const pts = buildCostSeries({
    budget: 100_000, scheduleStart: "2026-01-01", scheduleEnd: "2026-03-01",
    commitments: [{ date: "2026-01-10", amount: 60_000 }], actuals: [{ date: "2026-01-20", amount: 20_000 }],
  });

  it("both hues are categorical slots 1 and 2, never the white-label accent; the lines and markers differ in shape", () => {
    const doc = render(React.createElement(SCurveChart, { points: pts, fmt: usd }));
    const spent = doc.querySelector('[data-series="spent"]')!;
    const committed = doc.querySelector('[data-series="committed"]')!;
    const planned = doc.querySelector('[data-series="planned"]')!;
    expect(spent.getAttribute("stroke")).toBe("var(--viz-cat-1)");
    expect(committed.getAttribute("stroke")).toBe("var(--viz-cat-2)");
    expect(doc.querySelector("svg")!.innerHTML).not.toContain("--color-accent");
    // Shape: solid vs dash-dot vs the planned line's even dash.
    expect(spent.getAttribute("stroke-dasharray")).toBeNull();
    const dash = committed.getAttribute("stroke-dasharray");
    expect(dash).toBeTruthy();
    expect(dash).not.toBe(planned.getAttribute("stroke-dasharray"));
    // Endpoint markers: a circle for Spent, a square for Committed.
    expect(doc.querySelector('svg circle[fill="var(--viz-cat-1)"]')).not.toBeNull();
    expect(doc.querySelector('svg rect[fill="var(--viz-cat-2)"]')).not.toBeNull();
    // The legend keys repeat the shape, not just the colour.
    const keys = [...doc.querySelectorAll("div > span > svg")];
    expect(keys[0].querySelector("circle")).not.toBeNull();
    expect(keys[1].querySelector("rect")).not.toBeNull();
    expect(keys[1].querySelector("line")!.getAttribute("stroke-dasharray")).toBe(dash);
  });

  it("the two slots clear 3:1 against their own surface in both themes (the palette's validated steps)", () => {
    for (const slot of ["--viz-cat-1", "--viz-cat-2"]) {
      const { light, dark } = tokenValues(slot);
      expect(contrast(light, "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(contrast(dark, "#111827")).toBeGreaterThanOrEqual(3);
    }
  });

  it("every categorical slot is spelled literally, so the stylesheet build emits its light value", () => {
    expect([0, 1, 2, 3, 4, 5].map(vizCat)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `var(--viz-cat-${n})`));
    expect(vizCat(9)).toBe("var(--viz-cat-6)"); // never cycles, never an undefined slot
    expect(vizCat(-1)).toBe("var(--viz-cat-1)");
    const src = read("components/dashboard/viz.tsx");
    for (let n = 1; n <= 6; n++) expect(src).toContain(`"var(--viz-cat-${n})"`);
    expect(src).not.toMatch(/--viz-cat-\$\{/);
  });
});

// ── CHART-4 ──────────────────────────────────────────────────────────────────

describe("CHART-4 · no literal colour in the chart kit; the band label reads in both themes", () => {
  it("ChartKit.tsx carries no hex colour and every band resolves to a theme token", () => {
    expect(read("components/ui/ChartKit.tsx")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const score of [null, 0, 49, 50, 69, 70, 84, 85, 100]) expect(scoreBandColor(score)).toMatch(/^var\(--[a-z0-9-]+\)$/);
    expect(scoreBandColor(60)).toBe("var(--state-held)");
  });

  it("--state-held clears 4.5:1 as text on every light surface and on the dark one", () => {
    const { light, dark } = tokenValues("--state-held");
    expect(light).not.toBe("");
    expect(dark).not.toBe("");
    for (const surface of ["#ffffff", "#f8fafc", "#f1f5f9"]) expect(contrast(light, surface)).toBeGreaterThanOrEqual(4.5);
    for (const surface of ["#111827", "#0f172a", "#0b1120"]) expect(contrast(dark, surface)).toBeGreaterThanOrEqual(4.5);
    // The old literal amber-600 on white, for the record.
    expect(contrast("#d97706", "#ffffff")).toBeLessThan(4.5);
  });

  it("the dial's band word wears a text token; the arc carries the band colour", () => {
    const doc = render(React.createElement(ScoreDial, { score: 60, label: "Watch" }));
    const word = [...doc.querySelectorAll("div")].find((d) => d.textContent === "Watch")!;
    expect(word.getAttribute("style")).toBeNull();
    expect(word.className).toContain("text-[var(--color-text-muted)]");
    expect(doc.querySelector('circle[stroke="var(--state-held)"]')).not.toBeNull();
  });
});

// ── REL-10 (chart kit half) ───────────────────────────────────────────────────

describe("REL-10 · stand-in data is marked in the figure itself", () => {
  const pts = buildCostSeries({
    budget: 305_000, scheduleStart: "2026-06-01", scheduleEnd: "2026-08-30",
    commitments: [{ date: "2026-06-08", amount: 182_000 }], actuals: [{ date: "2026-06-15", amount: 18_400 }],
  });

  it("the S-curve repeats its watermark inside the plot and every legend figure says example", () => {
    const doc = render(React.createElement(SCurveChart, { points: pts, fmt: usd, budget: 305_000, todayIso: "2026-07-01", example: true }));
    const marks = [...doc.querySelectorAll('svg [data-mark="watermark"]')];
    expect(marks).toHaveLength(2);
    for (const m of marks) {
      expect(m.textContent).toBe("EXAMPLE");
      expect(Number(m.getAttribute("opacity"))).toBeGreaterThanOrEqual(0.12);
    }
    expect(doc.querySelector("svg")!.getAttribute("aria-label")).toMatch(/^Example cost curve, not this project's numbers/);
    const legend = doc.querySelector("svg + div")!;
    for (const b of legend.querySelectorAll("b")) expect(b.textContent).toMatch(/\(example\)$/);
    expect(doc.querySelector('[data-mark="budget-label"]')!.textContent).toBe("Budget $305,000 (example)");
    for (const t of doc.querySelectorAll("svg rect > title")) expect(t.textContent).toMatch(/^Example — /);
    // A real chart carries none of it.
    const real = render(React.createElement(SCurveChart, { points: pts, fmt: usd, budget: 305_000 }));
    expect(real.querySelector('[data-mark="watermark"]')).toBeNull();
    expect(real.body.textContent).not.toContain("example");
  });

  it("BarList marks each value when it draws example data", () => {
    const doc = render(React.createElement(BarList, { fmt: usd, example: true, items: [{ label: "01-100 Piping", value: 121_300 }] }));
    expect(doc.body.textContent).toContain("$121,300 (example)");
    expect(render(React.createElement(BarList, { fmt: usd, items: [{ label: "01-100 Piping", value: 121_300 }] })).body.textContent).not.toContain("example");
  });
});

// ── A11Y-11 (the viz helper) ──────────────────────────────────────────────────

describe("A11Y-11 · MiniBars takes an accessible name", () => {
  it("callers can say what the bars show; the dashboard default is unchanged", () => {
    const named = render(React.createElement(MiniBars, { values: [1, 2], ariaLabel: "Crew by week: 3, 4" }));
    expect(named.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Crew by week: 3, 4");
    const plain = render(React.createElement(MiniBars, { values: [1, 2] }));
    expect(plain.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Daily activity");
  });
});
