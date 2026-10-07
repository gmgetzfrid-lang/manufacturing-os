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
  // Empty since projects Round G J14: the last site — the coach's amber
  // not-migrated icon (ProjectCoach.tsx) — wears its 400 dark twin.
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
    expect(found).toEqual([]);   // J14: none left — the ratchet now holds the area at zero
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

// ── projects Round G J14: the coach's icon, the light tint slabs and every
//    status-hue text step without its dark twin ──
//
// The last -600 site (ProjectCoach.tsx's not-migrated icon) gained its 400
// dark twin, and the record's light tint slabs — `bg-{hue}-50|100` (and the
// translucent `-50/NN`) with no dark variant, in the schedule engine's
// surfaces plus the status chips of StatusControl / ProgressControl and the
// calendar tiles — wear the token recipe: a `{hue}-500` tint at 8 % (a 50
// slab) or 15 % (a 100 chip), a half-alpha border, and every coloured text
// step on them (700 / 800 / 900, hover included) its dark twin (300, or 200
// for a 900). A census over the whole Projects area pins both at zero.
const AREA = () => [...walk("components/projects"), ...walk("app/(protected)/projects"), ...walk("app/(protected)/companies"), ...walk("app/submit")];
const HUES = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
/** Every `bg-{status hue}-50|100` (alpha'd or not, any state prefix) whose
 *  own class string carries no `dark:` background variant. */
function lightSlabs(file: string, s: string): string[] {
  const out: string[] = [];
  for (const mm of s.matchAll(new RegExp(`(?<![\\w:-])((?:[\\w-]+:)*)bg-(${HUES})-(50|100)\\b`, "g"))) {
    let a = mm.index!; while (a > 0 && !"\"'`}".includes(s[a - 1])) a--;
    let b = mm.index!; while (b < s.length && !"\"'`$".includes(s[b])) b++;
    if (/dark:(?:[\w-]+:)*bg-/.test(s.slice(a, b))) continue;
    out.push(`${file}:${s.slice(0, mm.index).split("\n").length} ${mm[0]}`);
  }
  return out;
}
/** Every `text-{status hue}-700|800|900|950` (any state prefix but dark:)
 *  whose own class string carries no `dark:` text variant for that state. */
function darklessText(file: string, s: string): string[] {
  const out: string[] = [];
  for (const mm of s.matchAll(new RegExp(`(?<![\\w:-])((?:[\\w-]+:)*)text-(${HUES})-(700|800|900|950)\\b`, "g"))) {
    if (mm[1].includes("dark:")) continue;
    let a = mm.index!; while (a > 0 && !"\"'`}".includes(s[a - 1])) a--;
    let b = mm.index!; while (b < s.length && !"\"'`$".includes(s[b])) b++;
    if (new RegExp(`dark:${mm[1].replace(/:/g, "\\:")}text-`).test(s.slice(a, b))) continue;
    out.push(`${file}:${s.slice(0, mm.index).split("\n").length} ${mm[0]}`);
  }
  return out;
}

describe("A11Y-13 (J14) — no light tint slab and no darkless status text left in the Projects area", () => {
  it("the coach's not-migrated icon keeps its 600 step and wears the 400 dark twin", () => {
    const coach = readFileSync(join(ROOT, "components/projects/ProjectCoach.tsx"), "utf8");
    expect(coach).toContain('<AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />');
    expect(ratio(hex("#d97706"), hex("#ffffff"))).toBeGreaterThanOrEqual(3);
    expect(ratio(hex("#fbbf24"), hex("#111827"))).toBeGreaterThanOrEqual(3);
  });
  it("census: no `bg-{hue}-50|100` without a dark background variant anywhere in the area (was 47 at J14's base, plus 6 translucent)", () => {
    const found = AREA().flatMap((f) => lightSlabs(f, readFileSync(join(ROOT, f), "utf8")));
    expect(found).toEqual([]);
  });
  it("census: no `text-{hue}-700|800|900` without its dark twin anywhere in the area (was 76 at J14's base, all in the schedule-engine and status files); the slabs' faded text (700/80, 800/70, 900/90) is a full step now", () => {
    const found = AREA().flatMap((f) => darklessText(f, readFileSync(join(ROOT, f), "utf8")));
    expect(found).toEqual([]);
    for (const f of ["components/projects/MovePreviewSheet.tsx", "components/projects/ExecutionReportView.tsx", "components/projects/ScheduleImportModal.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/text-(amber|emerald|rose)-[789]00\/\d/);
    }
  });
  it("the censuses are mutation-checked: they catch a bare slab, a translucent slab, a darkless text and a darkless hover, and pass the recipe", () => {
    expect(lightSlabs("x.tsx", '<div className="rounded-xl border border-amber-200 bg-amber-50 p-3">')).toHaveLength(1);
    expect(lightSlabs("x.tsx", '<div className={`${on ? "bg-rose-50/40" : "x"}`}>')).toHaveLength(1);
    expect(lightSlabs("x.tsx", '<i className="hover:bg-indigo-50">')).toHaveLength(1);
    expect(lightSlabs("x.tsx", '<div className="bg-amber-500/[0.08] border-amber-500/40">')).toHaveLength(0);
    expect(lightSlabs("x.tsx", '<div className="bg-amber-50 dark:bg-amber-500/10">')).toHaveLength(0);
    expect(darklessText("x.tsx", '<b className="text-amber-900">x</b>')).toHaveLength(1);
    expect(darklessText("x.tsx", '<b className="hover:text-indigo-700">x</b>')).toHaveLength(1);
    expect(darklessText("x.tsx", '<b className="hover:text-indigo-700 dark:text-indigo-300">x</b>')).toHaveLength(1);
    expect(darklessText("x.tsx", '<b className="text-amber-900 dark:text-amber-200 hover:text-indigo-700 dark:hover:text-indigo-300">x</b>')).toHaveLength(0);
  });
  it("the recipe clears 4.5 : 1 for text in both themes, on the 8 % slab and the 15 % chip, for every hue it is used with", () => {
    type Hue = [string, RGB, RGB, RGB, RGB, RGB, RGB];   // name, 500, 700, 800, 900, 300, 200
    const HUE_STEPS: Hue[] = [
      ["amber", hex("#f59e0b"), hex("#b45309"), hex("#92400e"), hex("#78350f"), hex("#fcd34d"), hex("#fde68a")],
      ["rose", hex("#f43f5e"), hex("#be123c"), hex("#9f1239"), hex("#881337"), hex("#fda4af"), hex("#fecdd3")],
      ["emerald", hex("#10b981"), hex("#047857"), hex("#065f46"), hex("#064e3b"), hex("#6ee7b7"), hex("#a7f3d0")],
      ["blue", hex("#3b82f6"), hex("#1d4ed8"), hex("#1e40af"), hex("#1e3a8a"), hex("#93c5fd"), hex("#bfdbfe")],
      ["indigo", hex("#6366f1"), hex("#4338ca"), hex("#3730a3"), hex("#312e81"), hex("#a5b4fc"), hex("#c7d2fe")],
      ["purple", hex("#a855f7"), hex("#7e22ce"), hex("#6b21a8"), hex("#581c87"), hex("#d8b4fe"), hex("#e9d5ff")],
    ];
    const over = (fg: RGB, alpha: number, bg: RGB): RGB => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as RGB;
    const LIGHTS = [hex("#ffffff"), hex("#f8fafc")], DARKS = [hex("#111827"), hex("#0f172a")];
    for (const [name, c500, c700, c800, c900, c300, c200] of HUE_STEPS) {
      for (const alpha of [0.08, 0.15]) {
        // The 700 step sits on the 8 % slab (and indigo's on its 15 % chip);
        // the 15 % chips carry 800 / 900 text.
        const lightSteps = alpha === 0.08 || name === "indigo" ? [c700, c800, c900] : [c800, c900];
        for (const base of LIGHTS) for (const fg of lightSteps) expect(ratio(fg, over(c500, alpha, base)), `${name} light @${alpha}`).toBeGreaterThanOrEqual(4.5);
        for (const base of DARKS) for (const fg of [c300, c200]) expect(ratio(fg, over(c500, alpha, base)), `${name} dark @${alpha}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Before: the 800 / 900 text sat on a light slab that stayed light in dark
    // mode; converting the slab without the twin would put it on a dark tint.
    expect(ratio(hex("#92400e"), over(hex("#f59e0b"), 0.08, hex("#111827")))).toBeLessThan(4.5);
  });
});
