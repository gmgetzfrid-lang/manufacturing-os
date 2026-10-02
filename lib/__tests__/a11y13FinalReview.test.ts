// @vitest-environment jsdom
//
// projects Round G — J10, final review minors, A11Y-13 (stays OPEN).
//
//   * The task panel's announced delete error (TaskDetailPanel) wore
//     `text-rose-600` with no dark variant — under 4.5 : 1 on the dark footer.
//     It now wears the area's token recipe (rose-700 / dark:rose-300),
//     RENDERED here from a refused delete.
//   * The record's residual list understated what remains: every
//     `text-{rose,red,amber,emerald}-600` (bare or hover:) in the Projects
//     area whose class string carries no `dark:` text variant is now listed
//     in projects-tab 10-accessibility-mobile.md A11Y-13 by file:line. This
//     census is a ratchet over that list: a file may lose sites (update the
//     list and the record when it does), never gain one.
//   * projects Round G J10b drove the ratchet down to the one site in a file
//     another package holds this round (ProjectCoach.tsx, J12): every text
//     pair now wears the area's recipe (rose / emerald 700, amber 800, each
//     with its 300 dark twin), every icon keeps its 600 step and gains a 400
//     dark twin (non-text, 3 : 1), and every hover-only rose-600 gains a
//     dark:hover rose-300 — each change on the element itself, no global CSS.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const m = vi.hoisted(() => ({ deleteMilestone: vi.fn(), appConfirm: vi.fn() }));

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
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: m.appConfirm, appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock("@/lib/milestones", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/milestones")>();
  return { ...real, deleteMilestone: m.deleteMilestone, listMilestoneNotes: vi.fn(async () => []) };
});

import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import type { Milestone } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── WCAG 2.x contrast (Tailwind v3 sRGB steps), as a11yProjects.test.ts ──
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const lum = ([r, g, b]: RGB) => {
  const ch = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** The footer the error sits in: `bg-slate-50/60` — light, it is near-white;
 *  dark, the bridge paints it --color-surface-2 (#0f172a). */
const FOOTER_LIGHT = hex("#f8fafc"), FOOTER_DARK = hex("#0f172a");
const ROSE600 = hex("#e11d48"), ROSE700 = hex("#be123c"), ROSE300 = hex("#fda4af");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  m.deleteMilestone.mockReset();
  m.appConfirm.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const task: Milestone = {
  id: "a", orgId: "o", projectId: "p", name: "Fit-up", weight: 1, plannedAt: "2026-03-10T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", dependsOn: [],
};

describe("A11Y-13 (final review) — the task panel's announced delete error reads in both themes", () => {
  it("rendered: a refused delete is an alert in the token recipe (rose-700 / dark:rose-300), never the bare rose-600", async () => {
    m.appConfirm.mockResolvedValue(true);
    m.deleteMilestone.mockRejectedValue(new Error("new row violates row-level security policy for table \"milestones\""));
    const onChanged = vi.fn();
    await act(async () => {
      root.render(React.createElement(TaskDetailPanel, {
        milestone: task, subtasks: [], allTasks: [task], childCount: () => 0,
        canEdit: true, userId: "u", onClose: () => undefined, onChanged,
      }));
    });
    await flush();
    const del = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete task")!;
    expect(del).toBeTruthy();
    await act(async () => { del.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(m.deleteMilestone).toHaveBeenCalledWith("a", "u");
    const alert = [...host.querySelectorAll('[role="alert"]')].find((a) => a.closest(".border-t") && a.textContent)!;
    expect(alert).toBeTruthy();
    expect(alert.textContent).not.toMatch(/row-level security|milestones/);   // translated (REL-3)
    const cls = alert.className.split(/\s+/);
    expect(cls).toContain("text-rose-700");
    expect(cls).toContain("dark:text-rose-300");
    expect(cls).not.toContain("text-rose-600");
    // the old pair failed in dark; the recipe clears 4.5 : 1 in both themes
    expect(ratio(ROSE600, FOOTER_DARK)).toBeLessThan(4.5);
    expect(ratio(ROSE700, FOOTER_LIGHT)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(ROSE300, FOOTER_DARK)).toBeGreaterThanOrEqual(4.5);
  });
});

// ── the residual census ──
const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx$/.test(name)) out.push(rel);
  }
  return out;
}
/** Every `text-{rose,red,amber,emerald}-600` (bare or with a state prefix
 *  such as hover:) whose own class string — the quoted / template chunk it
 *  sits in — carries no `dark:` text variant. */
function uncited600(file: string, s: string): string[] {
  const out: string[] = [];
  for (const mm of s.matchAll(/(?<![\w:-])((?:[\w-]+:)*)text-(rose|red|amber|emerald)-600\b/g)) {
    let a = mm.index!; while (a > 0 && !"\"'`}".includes(s[a - 1])) a--;
    let b = mm.index!; while (b < s.length && !"\"'`$".includes(s[b])) b++;
    if (/dark:(?:[\w-]+:)*text-/.test(s.slice(a, b))) continue;
    out.push(`${file}:${s.slice(0, mm.index).split("\n").length} ${mm[1]}text-${mm[2]}-600`);
  }
  return out;
}
/** The residual the A11Y-13 record lists (final review, 2026-10-01), per
 *  file: text, icon and hover-only sites together. */
const RECORDED_RESIDUAL: Record<string, number> = {
  // J12's file this round (PERF-8): the coach's amber not-migrated icon —
  // one class token, left for the file's owner.
  "components/projects/ProjectCoach.tsx": 1,
};

describe("A11Y-13 (final review) — the residual list names every uncited -600 pair with no dark variant (a ratchet)", () => {
  const files = [...walk("components/projects"), ...walk("app/(protected)/projects"), ...walk("app/(protected)/companies"), ...walk("app/submit")];
  const found = files.flatMap((f) => uncited600(f, readFileSync(join(ROOT, f), "utf8")));
  const perFile = found.reduce<Record<string, number>>((acc, site) => {
    const f = site.slice(0, site.lastIndexOf(":", site.indexOf(" ")));
    acc[f] = (acc[f] ?? 0) + 1;
    return acc;
  }, {});

  it("no file holds more such sites than the record lists, and no unlisted file holds any", () => {
    const over = Object.entries(perFile).filter(([f, n]) => n > (RECORDED_RESIDUAL[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${RECORDED_RESIDUAL[f] ?? 0}`);
    expect(over, found.join("\n")).toEqual([]);
    expect(found.length).toBeGreaterThan(0);   // the finding stays OPEN
  });

  it("the delete error, the TaskDetailPanel field note and the ExecutionReportView figures are no longer among them — they wear the recipe (J10b)", () => {
    const panel = readFileSync(join(ROOT, "components/projects/TaskDetailPanel.tsx"), "utf8");
    const fixed = '{deleteError && <span role="alert" className="text-[11px] text-rose-700 dark:text-rose-300">{deleteError}</span>}';
    expect(panel).toContain(fixed);
    expect(found.filter((x) => x.startsWith("components/projects/TaskDetailPanel.tsx"))).toEqual([]);
    expect(panel).toContain('${err ? "text-rose-700 dark:text-rose-300" : "text-amber-800 dark:text-amber-300"}');
    // the "Delete task" label: the recipe, and its hover slab no longer a light rose-50 in dark
    expect(panel).toContain("text-rose-700 dark:text-rose-300 hover:text-rose-800 dark:hover:text-rose-200 hover:bg-rose-500/10");
    expect(panel).not.toContain("hover:bg-rose-50 ");
    const report = readFileSync(join(ROOT, "components/projects/ExecutionReportView.tsx"), "utf8");
    expect(found.filter((x) => x.startsWith("components/projects/ExecutionReportView.tsx"))).toEqual([]);
    expect(report).toContain('${ahead ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}');
    expect(report).toContain('const c = tone === "emerald" ? "text-emerald-600 dark:text-emerald-400"');
  });

  it("the census is mutation-checked: it catches a bare and a hover pair, and passes one with its dark variant", () => {
    expect(uncited600("x.tsx", '<span className="text-xs text-rose-600">e</span>')).toHaveLength(1);
    expect(uncited600("x.tsx", '<b className="text-emerald-600">ok</b> <i className="text-faint hover:text-red-600">x</i>')).toHaveLength(2);
    expect(uncited600("x.tsx", '<span className={`text-xs ${bad ? "text-amber-600" : "x"}`}>e</span>')).toHaveLength(1);
    expect(uncited600("x.tsx", '<span className="text-rose-600 dark:text-rose-300">e</span>')).toHaveLength(0);
    expect(uncited600("x.tsx", '<span className="hover:text-rose-600 dark:hover:text-rose-300">e</span>')).toHaveLength(0);
  });
});

// ── projects Round G J10b: what the 60 sites now wear, in both themes ──
describe("A11Y-13 (J10b) — every pair the census held now clears its floor in both themes", () => {
  const WHITE = hex("#ffffff"), SURFACE2 = hex("#f8fafc"), DARK_SURFACE = hex("#111827"), DARK_SURFACE2 = hex("#0f172a");
  const TEXT_RECIPE: Array<[string, RGB, RGB]> = [   // light step, dark twin
    ["rose", hex("#be123c"), hex("#fda4af")],
    ["emerald", hex("#047857"), hex("#6ee7b7")],
    ["amber", hex("#92400e"), hex("#fcd34d")],
  ];
  const ICON: Array<[string, RGB, RGB]> = [          // 600 kept, 400 in dark
    ["rose", hex("#e11d48"), hex("#fb7185")],
    ["emerald", hex("#059669"), hex("#34d399")],
    ["amber", hex("#d97706"), hex("#fbbf24")],
  ];
  it("text: the 700 / 800 step clears 4.5 : 1 on the light surfaces and the 300 twin on the dark ones", () => {
    for (const [hue, light, dark] of TEXT_RECIPE) {
      for (const bg of [WHITE, SURFACE2]) expect(ratio(light, bg), hue).toBeGreaterThanOrEqual(4.5);
      for (const bg of [DARK_SURFACE, DARK_SURFACE2]) expect(ratio(dark, bg), hue).toBeGreaterThanOrEqual(4.5);
    }
    // the 600 text it replaced failed in dark (rose) or even in light (amber, emerald)
    expect(ratio(hex("#e11d48"), DARK_SURFACE2)).toBeLessThan(4.5);
    expect(ratio(hex("#d97706"), WHITE)).toBeLessThan(4.5);
    expect(ratio(hex("#059669"), WHITE)).toBeLessThan(4.5);
  });
  it("icons (SC 1.4.11, 3 : 1): the 600 step on light and the 400 twin on dark", () => {
    for (const [hue, light, dark] of ICON) {
      for (const bg of [WHITE, SURFACE2]) expect(ratio(light, bg), hue).toBeGreaterThanOrEqual(3);
      for (const bg of [DARK_SURFACE, DARK_SURFACE2]) expect(ratio(dark, bg), hue).toBeGreaterThanOrEqual(3);
    }
  });
  it("hover-only: rose-600 on the light card surface and its rose-300 dark twin clear 4.5 : 1 (the icon buttons 3 : 1 on a strip too)", () => {
    // the hover-only sites are the cards' Void / Reverse labels (on the card
    // surface) and remove / dismiss icons (non-text)
    expect(ratio(hex("#e11d48"), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("#e11d48"), SURFACE2)).toBeGreaterThanOrEqual(3);
    for (const bg of [DARK_SURFACE, DARK_SURFACE2]) expect(ratio(hex("#fda4af"), bg)).toBeGreaterThanOrEqual(4.5);
    // before: the dark hover was the same rose-600, under 4.5 : 1 on either dark surface
    for (const bg of [DARK_SURFACE, DARK_SURFACE2]) expect(ratio(hex("#e11d48"), bg)).toBeLessThan(4.5);
  });
  it("source: each change sits on its element — no global stylesheet rule was added for these hues", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    expect(css).not.toMatch(/\.dark \.text-(rose|amber|emerald|red)-600/);
    expect(css).not.toMatch(/\.dark \.hover\\:text-rose-600/);
  });
});
