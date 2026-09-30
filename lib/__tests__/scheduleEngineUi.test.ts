// @vitest-environment jsdom
//
// projects Round G — J6b SCHEDULE-ENGINE, the schedule surfaces as RENDERED:
//
//   PT SCH-6  — the imported-rows toggle is a display filter: every figure on
//               the board is the same with it on or off, and a manual phase
//               whose imported children are hidden stays a phase (no Done).
//   PT SCH-4  — the move sheet counts what will be written, and a loop in the
//               links is a refusal shown instead of a Confirm.
//   PT SCH-9  — a link to a filtered-out task reads "hidden by filter"; the
//               picker's cycle check sees the hidden middle of a chain.
//   PT SCH-13 — an imported bar has no drag handle.
//   PT SCH-18 — a failed Undo keeps its toast and says "Couldn't undo" (Undo
//               stays as a retry); the timers map holds only toasts on screen.
//   PT PERF-5 — a 400-row board renders a window of rows, not 800 components.
//   PC SCHED-12 (limb c) — the timeline's critical-path control says what it is.
//   PT SCH-10 — the rebase form builds and shows schedule time (UTC) in every zone.
//   PT A11Y-3 — milestone row tints keep every text colour at ≥ 4.5 : 1 in both themes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase", () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return () => chain;
    },
  });
  return { supabase: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(), logMilestoneEvent: vi.fn() }));
vi.mock("@/lib/projects", () => ({ listMembers: vi.fn(async () => []) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true), appAlert: vi.fn(), appPrompt: vi.fn() }));

import ExecutionView from "@/components/projects/ExecutionView";
import MovePreviewSheet from "@/components/projects/MovePreviewSheet";
import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import { useUndoableActions } from "@/components/projects/useUndoableActions";
import { rebasePrefill, rebaseTargetIso } from "@/components/projects/RebaseScheduleModal";
import { rowWindow, scrollTopToReveal } from "@/lib/rowWindow";
import type { Milestone } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class RO { observe() {} disconnect() {} unobserve() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", projectId: "p", name: "t", weight: 1, plannedAt: "2026-03-10T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", dependsOn: [], ...o,
});
async function render(el: React.ReactElement) {
  await act(async () => { root.render(el); });
  await act(async () => { await Promise.resolve(); });
}
const board = (milestones: Milestone[], extra: Record<string, unknown> = {}) => React.createElement(ExecutionView, {
  milestones, canEdit: true, orgId: "o", projectId: "p", userId: "u",
  onRefresh: () => undefined, onMoveMany: async () => ({ ok: true }), onSetStatus: async () => true, onSetProgress: async () => true,
  ...extra,
});

// A manual phase P whose work is imported (i1 done, i2 open), plus a manual task m.
const schedule: Milestone[] = [
  mk({ id: "P", name: "Phase", isSummary: true, plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-05T00:00:00Z" }),
  mk({ id: "i1", name: "Imported one", parentId: "P", source: "p6", plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-02T00:00:00Z", status: "completed", percentComplete: 100 }),
  mk({ id: "i2", name: "Imported two", parentId: "P", source: "p6", plannedStartAt: "2026-03-03T00:00:00Z", plannedAt: "2026-03-05T00:00:00Z" }),
  mk({ id: "m", name: "Manual task", plannedStartAt: "2026-03-06T00:00:00Z", plannedAt: "2026-03-08T00:00:00Z", dependsOn: ["i2"] }),
];

describe("SCH-6 · the imported-rows toggle changes what is drawn, never a number", () => {
  it("the summary strip and the pulse read the same with imported rows hidden", async () => {
    await render(board(schedule));
    const strip = (t: string) => t.replace(/\s+/g, " ").match(/\d+%?[^]*?Schedule day[^]*?\d+ \/ \d+/)?.[0] ?? "";
    const shown = host.textContent ?? "";
    await render(board(schedule, { hideImported: true }));
    const hidden = host.textContent ?? "";
    expect(strip(hidden)).toBe(strip(shown));
    expect(hidden).toMatch(/1 \/ 3 tasks complete/); // all three leaves still counted
    expect(host.querySelector("#exec-row-i1")).toBeNull();   // …but not drawn
    expect(host.querySelector("#exec-row-i2")).toBeNull();
  });
  it("a manual phase whose imported children are hidden is still a phase — its status is read-only, never a Done control", async () => {
    await render(board(schedule, { hideImported: true }));
    const phase = host.querySelector("#exec-row-P")!;
    expect(phase).not.toBeNull();
    expect(phase.querySelector('[title="Phase status — rolls up from sub-tasks"]')).not.toBeNull();
  });
});

describe("SCH-13 · an imported bar cannot be dragged; a manual one can", () => {
  it("only the manual leaf carries the grab handle", async () => {
    await render(board(schedule));
    const grab = [...host.querySelectorAll(".cursor-grab")].map((el) => el.getAttribute("title") ?? "");
    expect(grab.some((t) => t.startsWith("Manual task"))).toBe(true);
    expect(grab.some((t) => t.startsWith("Imported two"))).toBe(false);
    const imported = [...host.querySelectorAll("[title]")].find((el) => (el.getAttribute("title") ?? "").startsWith("Imported two\n"));
    expect(imported?.getAttribute("title")).toMatch(/Imported \(p6\) — dates are set in the scheduling tool/);
  });
});

describe("PERF-5 · the board renders a window of rows, not every row", () => {
  it("400 leaves render at most the initial window (40 outline rows, 40 bars)", async () => {
    const many = Array.from({ length: 400 }, (_, i) => mk({ id: `t${i}`, name: `Task ${i}`, plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-02T00:00:00Z" }));
    await render(board(many));
    const outline = host.querySelectorAll('[id^="exec-row-"]').length;
    const bars = [...host.querySelectorAll("[title]")].filter((el) => /^Task \d+\n/.test(el.getAttribute("title") ?? "")).length;
    expect(outline).toBeLessThanOrEqual(40);
    expect(bars).toBeLessThanOrEqual(40);
    expect(outline).toBeGreaterThan(0);
    expect(host.textContent).toMatch(/0 \/ 400 tasks complete/); // every row still counted
  });
  it("rowWindow: a viewport of 15 rows renders 15 + overscan, wherever it is scrolled", () => {
    expect(rowWindow({ scrollTop: 0, viewportHeight: 600, rowHeight: 40, headerHeight: 46, count: 400 })).toEqual({ start: 0, end: 23 });
    expect(rowWindow({ scrollTop: 46 + 200 * 40, viewportHeight: 600, rowHeight: 40, headerHeight: 46, count: 400 })).toEqual({ start: 192, end: 223 });
    expect(rowWindow({ scrollTop: 99999, viewportHeight: 600, rowHeight: 40, count: 400 }).end).toBe(400);
    expect(rowWindow({ scrollTop: 0, viewportHeight: 0, rowHeight: 40, count: 400 })).toEqual({ start: 0, end: 40 });
    expect(rowWindow({ scrollTop: 0, viewportHeight: 600, rowHeight: 40, count: 0 })).toEqual({ start: 0, end: 0 });
    expect(scrollTopToReveal({ index: 50, scrollTop: 0, viewportHeight: 600, rowHeight: 40, headerHeight: 46 })).toBe(46 + 51 * 40 - 600);
    expect(scrollTopToReveal({ index: 2, scrollTop: 0, viewportHeight: 600, rowHeight: 40, headerHeight: 46 })).toBeNull();
    expect(scrollTopToReveal({ index: 2, scrollTop: 400, viewportHeight: 600, rowHeight: 40, headerHeight: 46 })).toBe(80);
  });
  it("SummaryStrip no longer scans items × items per render (source pin)", () => {
    const src = readFileSync(join(process.cwd(), "components/projects/ExecutionView.tsx"), "utf8");
    expect(src).not.toMatch(/items\.filter\(\(m\) => !items\.some\(/);
    expect(src).toMatch(/const SummaryStrip = React\.memo\(/);
    expect(src).toMatch(/\{windowRows\.map\(\(r\) => \(\s*<OutlineRow/);
    expect(src).toMatch(/\{windowRows\.map\(\(r, j\) => \(\s*<Bar/);
  });
});

describe("SCHED-12 (limb c) · the timeline's critical-path control says what it is", () => {
  it("the button and the legend name the links and the calendar caveat", async () => {
    await render(board(schedule));
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Critical path"));
    expect(btn?.getAttribute("title")).toMatch(/chain of finish-to-start links that drives the finish date \(calendar days — no working calendar\)/);
    const legend = [...host.querySelectorAll("span[title]")].find((s) => (s.getAttribute("title") ?? "").startsWith("On the critical path"));
    expect(legend?.getAttribute("title")).toMatch(/finish-to-start links .*calendar days, no working calendar/);
  });
});

describe("SCH-4 · the move sheet counts what will be written, and shows a refusal instead of Confirm", () => {
  const targets = [mk({ id: "a", name: "Weld" })];
  it("Writes 3 tasks — 1 moved, 2 more follow; the button says 3", async () => {
    await render(React.createElement(MovePreviewSheet, {
      targets, deltaDays: 2, onCancel: () => undefined, onConfirm: () => undefined,
      planFor: () => ({ rows: [{ id: "a", name: "Weld", plannedAt: "2026-03-12T00:00:00Z" }, { id: "b", name: "NDE", plannedAt: "2026-03-13T00:00:00Z" }, { id: "P", name: "Phase", plannedAt: "2026-03-13T00:00:00Z" }], held: ["Hydrotest"], refusal: null }),
    }));
    expect(host.textContent).toMatch(/Writes 3 tasks — 1 moved, 2 more follow/);
    expect(host.textContent).toMatch(/1 dependent task is done or imported, so it stays put and will now start before this finishes: Hydrotest/);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Shift 3 tasks")).toBe(true);
  });
  it("PC SCHED-3 (dw4): a cascaded dependent pushed past ITS baseline is counted from the plan, though the dragged task has none", async () => {
    await render(React.createElement(MovePreviewSheet, {
      targets, deltaDays: 2, onCancel: () => undefined, onConfirm: () => undefined,
      planFor: () => ({ rows: [
        { id: "a", name: "Weld", plannedAt: "2026-03-12T00:00:00Z", baselineFinishAt: null },
        { id: "b", name: "NDE", plannedAt: "2026-03-14T00:00:00Z", baselineFinishAt: "2026-03-13T00:00:00Z" },
      ], held: [], refusal: null }),
    }));
    expect(host.textContent).toMatch(/1 task would finish past the approved baseline\./);
  });
  it("ExecutionView hands the sheet the plan it will write (source pin)", () => {
    const src = readFileSync(join(process.cwd(), "components/projects/ExecutionView.tsx"), "utf8");
    expect(src).toMatch(/<MovePreviewSheet[\s\S]{0,300}planFor=\{planFor\}/);
    expect(src).toMatch(/const plan = changesFor\(pm, mode\);/);          // the commit writes the same computation
    expect(src).toMatch(/const p = changesFor\(pendingMove, mode\);/);   // …the sheet previews
  });
  it("a loop: the refusal is shown, Confirm is disabled", async () => {
    await render(React.createElement(MovePreviewSheet, {
      targets, deltaDays: 1, onCancel: () => undefined, onConfirm: () => undefined,
      planFor: () => ({ rows: [], held: [], refusal: "These links go round in a loop: “A” → “B” → “A”. Nothing was moved — remove one of these links first." }),
    }));
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/loop: “A” → “B” → “A”/);
    const confirm = [...host.querySelectorAll("button")].find((b) => /^(Shift|Extend) (task|\d+ tasks?)$/.test(b.textContent?.trim() ?? ""));
    expect(confirm).toBeDefined();
    expect(confirm?.hasAttribute("disabled")).toBe(true);
  });
});

describe("SCH-9 · the dependency picker reasons over every task; a hidden one is labelled as hidden", () => {
  it("'(hidden by filter)' for a filtered-out predecessor, '(deleted task)' for a dangling id; the loop through the hidden row is not offered", async () => {
    const all: Milestone[] = [
      mk({ id: "a", name: "Fit-up" }),
      mk({ id: "b", name: "Weld", source: "msproject", dependsOn: ["a"] }),     // hidden by the toggle
      mk({ id: "c", name: "NDE", dependsOn: ["b", "gone"] }),
      mk({ id: "z", name: "Paint" }),
    ];
    await render(React.createElement(TaskDetailPanel, {
      milestone: all[0], subtasks: [], allTasks: all, hiddenIds: new Set(["b"]), childCount: () => 0,
      canEdit: true, userId: "u", onClose: () => undefined, onChanged: () => undefined,
    }));
    const options = [...host.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("Paint");
    expect(options).not.toContain("NDE");                     // c depends on a through the hidden b
    expect(options.some((o) => o?.startsWith("Weld"))).toBe(false);
    await render(React.createElement(TaskDetailPanel, {
      milestone: all[2], subtasks: [], allTasks: all, hiddenIds: new Set(["b"]), childCount: () => 0,
      canEdit: true, userId: "u", onClose: () => undefined, onChanged: () => undefined,
    }));
    expect(host.textContent).toMatch(/Weld \(hidden by filter\)/);
    expect(host.textContent).toMatch(/\(deleted task\)/);
    expect(host.textContent).not.toMatch(/\(removed task\)/);
  });
});

describe("SCH-18 · a failed Undo keeps its toast and says so; timers stay bounded", () => {
  type Api = ReturnType<typeof useUndoableActions>;
  const holder: { api?: Api } = {};
  function Harness() {
    const a = useUndoableActions();
    React.useEffect(() => { holder.api = a; });
    return null;
  }
  const api = new Proxy({} as Api, { get: (_t, k: string) => (holder.api as unknown as Record<string, unknown>)[k] });
  it("a throwing undo turns the SAME toast into 'Couldn't undo: …' with Undo kept as a retry; a retry that works dismisses it", async () => {
    await render(React.createElement(Harness));
    let attempts = 0;
    await act(async () => { api.announce("Moved “Weld”", async () => { attempts++; if (attempts === 1) throw new Error("the schedule changed since that move"); }); });
    const t = api.toasts[0];
    await act(async () => { await api.runUndo(t); });
    expect(api.toasts).toHaveLength(1);
    expect(api.toasts[0].message).toBe("Couldn't undo: the schedule changed since that move — Moved “Weld”");
    expect(api.toasts[0].undo).toBeTypeOf("function");
    await act(async () => { await api.runUndo(api.toasts[0]); });
    expect(attempts).toBe(2);
    expect(api.toasts).toHaveLength(0);
  });
  it("pushing ten toasts leaves three on screen and three timers — a dropped toast takes its timer with it", async () => {
    await render(React.createElement(Harness));
    await act(async () => { for (let i = 0; i < 10; i++) api.notify(`n${i}`); });
    expect(api.toasts.map((x) => x.message)).toEqual(["n7", "n8", "n9"]);
    expect(api.timerCount()).toBe(3);
  });
  it("the schedule's undo closures throw when their handler reports a refusal (source pin)", () => {
    const src = readFileSync(join(process.cwd(), "components/projects/ExecutionView.tsx"), "utf8");
    expect(src).toMatch(/if \(!\(await onSetStatus\(id, prevStatus\)\)\) \{[^}]*\}?[\s\S]{0,200}throw new Error/);
    expect(src).toMatch(/if \(!\(await onSetProgress\(id, prevPct\)\)\)/);
    expect(src).toMatch(/const undone = await onMoveMany\(before, res\.updatedAt \? \{ expectedUpdatedAt: res\.updatedAt \} : undefined\);\s*if \(!undone\.ok\) throw/);
  });
});

describe("SCH-10 · the rebase form works in schedule time (UTC), in every zone", () => {
  for (const zone of ["America/Los_Angeles", "UTC", "Asia/Tokyo"]) {
    it(`${zone}: a midnight-UTC anchor pre-fills 00:00, and 1 September rebases to 1 September`, () => {
      const tz = process.env.TZ;
      try {
        process.env.TZ = zone;
        expect(rebasePrefill("2026-06-01T00:00:00Z", new Date("2026-06-15T12:00:00Z")).time).toBe("00:00");
        expect(rebasePrefill("2026-06-01T08:30:00Z").time).toBe("08:30");
        expect(rebaseTargetIso("2026-09-01", "00:00")).toBe("2026-09-01T00:00:00.000Z");
        expect(rebaseTargetIso("2026-09-01", "08:00")).toBe("2026-09-01T08:00:00.000Z");
        expect(rebaseTargetIso("2026-02-30", "00:00")).toBeNull();
      } finally { process.env.TZ = tz; }
    });
  }
  it("the preview renders in UTC, like the board (source pin)", () => {
    const src = readFileSync(join(process.cwd(), "components/projects/RebaseScheduleModal.tsx"), "utf8");
    expect(src).not.toMatch(/getHours\(\)|getMinutes\(\)|new Date\(`\$\{target\}T/);
    expect(src).toMatch(/timeZone: "UTC"/);
    expect(src).toMatch(/newStartIso,\n/);
  });
});

describe("A11Y-3 · milestone row tints keep every text colour at ≥ 4.5 : 1 in both themes", () => {
  // Tailwind palette values (v3 sRGB; v4's oklch steps render within a few
  // units) and the app's tokens (app/globals.css).
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const over = (fg: number[], a: number, bg: number[]) => fg.map((c, i) => c * a + bg[i] * (1 - a));
  const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const PALETTE: Record<string, string> = { "emerald-500": "#10b981", "rose-500": "#f43f5e", "amber-500": "#f59e0b" };
  const themes = {
    light: { surface: "#ffffff", texts: ["#0f172a", "#475569", "#be123c", "#047857"] },      // text · slate-600 · rose-700 · emerald-700
    dark: { surface: "#111827", texts: ["#f1f5f9", "#cbd5e1", "#fda4af", "#6ee7b7"] },       // text · slate-600→#cbd5e1 · rose-300 · emerald-300
  };
  const src = readFileSync(join(process.cwd(), "components/projects/ScheduleTab.tsx"), "utf8");
  const row = src.slice(src.indexOf("function MilestoneRow("), src.indexOf("function StatusChip("));
  it("no hardcoded light-mode -50 / -300 tint remains in the row renderer; text on the tint is not the muted token", () => {
    const tone = row.slice(row.indexOf("const tone ="), row.indexOf("const ghost"));
    expect(tone).not.toMatch(/-(50|300)\b/);
    // no light-mode palette tint or border anywhere in the row (buttons and chips included)
    expect(row.match(/\b(?:hover:)?(?:bg|border)-(?:red|rose|emerald|amber|blue)-(?:50|100|200|300)\b/g) ?? []).toEqual([]);
    expect(row.slice(row.indexOf("<div className=\"mt-1 text-[11px]"), row.indexOf("{m.description"))).not.toMatch(/text-\[var\(--color-text-muted\)\]/);
  });
  it("every tint in the renderer × every text colour × both themes clears 4.5 : 1", () => {
    const tints = [...row.matchAll(/bg-(emerald|rose|amber)-500\/\[(0\.\d+)\]/g)].map((m) => ({ color: PALETTE[`${m[1]}-500`], alpha: Number(m[2]) }));
    expect(tints.length).toBeGreaterThanOrEqual(5);
    for (const theme of Object.values(themes)) {
      for (const t of tints) {
        const bg = over(hex(t.color), t.alpha, hex(theme.surface));
        for (const fg of theme.texts) expect(ratio(hex(fg), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
