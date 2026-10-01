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
  "components/projects/CostsTab.tsx": 5,
  "components/projects/EditProjectModal.tsx": 3,
  "components/projects/ExecutionReportView.tsx": 15,
  "components/projects/ExecutionView.tsx": 3,
  "components/projects/IntakePanel.tsx": 2,
  "components/projects/ProjectCoach.tsx": 1,
  "components/projects/ProjectDocumentsCard.tsx": 1,
  "components/projects/ProjectWizard.tsx": 7,
  "components/projects/QualityTab.tsx": 2,
  "components/projects/ScheduleCalendarTileView.tsx": 1,
  "components/projects/ScheduleImportModal.tsx": 2,
  "components/projects/ScheduleProgress.tsx": 5,
  "components/projects/StaleCheckoutBanner.tsx": 2,
  "components/projects/TabErrorBoundary.tsx": 1,
  "components/projects/TaskDetailPanel.tsx": 3,
  "components/projects/TransitionInPanel.tsx": 3,
  "components/projects/cost/ChangeOrdersPanel.tsx": 1,
  "components/projects/cost/QuotesPanel.tsx": 1,
  "app/(protected)/companies/[id]/page.tsx": 1,
  "app/(protected)/companies/error.tsx": 1,
  "app/submit/[token]/page.tsx": 1,
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

  it("the delete error is not among them (fixed); the cited TaskDetailPanel field note and the ExecutionReportView figures are", () => {
    const panel = readFileSync(join(ROOT, "components/projects/TaskDetailPanel.tsx"), "utf8");
    const fixed = '{deleteError && <span role="alert" className="text-[11px] text-rose-700 dark:text-rose-300">{deleteError}</span>}';
    expect(panel).toContain(fixed);
    const fixedLine = panel.slice(0, panel.indexOf(fixed)).split("\n").length;
    expect(found.filter((x) => x.startsWith(`components/projects/TaskDetailPanel.tsx:${fixedLine} `))).toEqual([]);
    expect(found.filter((x) => x.startsWith("components/projects/TaskDetailPanel.tsx")).map((x) => x.split(" ")[1])).toEqual(
      expect.arrayContaining(["text-rose-600", "text-amber-600"]));
    const report = found.filter((x) => x.startsWith("components/projects/ExecutionReportView.tsx"));
    expect(report.some((x) => x.endsWith(" text-rose-600"))).toBe(true);
    expect(report.some((x) => x.endsWith(" text-emerald-600"))).toBe(true);
  });

  it("the census is mutation-checked: it catches a bare and a hover pair, and passes one with its dark variant", () => {
    expect(uncited600("x.tsx", '<span className="text-xs text-rose-600">e</span>')).toHaveLength(1);
    expect(uncited600("x.tsx", '<b className="text-emerald-600">ok</b> <i className="text-faint hover:text-red-600">x</i>')).toHaveLength(2);
    expect(uncited600("x.tsx", '<span className={`text-xs ${bad ? "text-amber-600" : "x"}`}>e</span>')).toHaveLength(1);
    expect(uncited600("x.tsx", '<span className="text-rose-600 dark:text-rose-300">e</span>')).toHaveLength(0);
    expect(uncited600("x.tsx", '<span className="hover:text-rose-600 dark:hover:text-rose-300">e</span>')).toHaveLength(0);
  });
});
