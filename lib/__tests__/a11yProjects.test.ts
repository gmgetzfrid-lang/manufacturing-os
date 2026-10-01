// @vitest-environment jsdom
//
// projects Round G — J10 SURFACE-SWEEP. The accessibility baseline for the
// Projects area and the public submit portal (GAP-410), on the RENDERED
// page where a page can be rendered and on the source where the cited site
// is a pattern (a class that compiles to display:none, a colour painted on
// text):
//   A11Y-1 — every file picker is keyboard-reachable (sr-only, never
//            display:none) and the public portal is completable by keyboard;
//   A11Y-6 / A11Y-7 / A11Y-13 — the portal announces its result, says which
//            submission type is pressed, and has a dark variant per tone;
//   A11Y-2 — a compliance status is a glyph and a word, never hue alone, and
//            the accessible text of a status cell names its state (GAP-410
//            acceptance 2); the checklist card carries a legend;
//   A11Y-8 — no Quality-tab decision control is under 24 px, 44 px on a
//            coarse pointer; Accept is a signed ceremony; the wizard stepper
//            is out of the tab order;
//   A11Y-12 — decision-critical explanations are click-open disclosures or
//            visible text, never hover-only; the cost glossary opens on a
//            first visit.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => ({}), auth: { getSession: async () => ({ data: { session: null } }) } },
}));
vi.mock("@/lib/storage", () => ({
  putWithXhr: vi.fn(async () => undefined),
  UploadCancelledError: class UploadCancelledError extends Error {},
}));

import IntakePortal from "@/app/submit/[token]/page";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { StatusMark, StatusLegend, CHECKLIST_STATUS_MARKS, PUNCH_STATUS_MARKS, RUBRIC_MARKS, type StatusMarkSpec } from "@/components/projects/StatusMark";
import { CostGlossary } from "@/components/projects/cost/CostCharts";
import UndoToastHost from "@/components/projects/UndoToastHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = process.cwd();
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx$/.test(name)) out.push(rel);
  }
  return out;
}
/** The Projects area and the public portal — the surfaces GAP-410 names. */
const PROJECT_SURFACES = [
  ...walk("components/projects"),
  ...walk("app/(protected)/projects"),
  ...walk("app/(protected)/companies"),
  ...walk("app/submit"),
];

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
  vi.unstubAllGlobals();
});
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("A11Y-1 — every file picker is keyboard-reachable", () => {
  it("no file input on a Projects surface or the portal is display:none (`hidden`); each is sr-only inside a label that shows focus", () => {
    // ScheduleImportModal keeps a hidden input behind a role=button drop zone
    // (tabIndex 0, Enter / Space click the input) — a labelled keyboard
    // trigger, the other accepted pattern.
    const keyboardTriggered = new Set(["components/projects/ScheduleImportModal.tsx"]);
    const offenders: string[] = [];
    let pickers = 0;
    for (const f of PROJECT_SURFACES) {
      const s = src(f);
      for (let at = s.indexOf('type="file"'); at >= 0; at = s.indexOf('type="file"', at + 1)) {
        pickers++;
        const start = s.lastIndexOf("<input", at);
        const tag = s.slice(start, s.indexOf("/>", at));
        const m = { index: start };
        const hidden = /className="[^"]*\bhidden\b/.test(tag);
        if (keyboardTriggered.has(f)) {
          expect(s).toContain('role="button"');
          expect(s).toMatch(/onKeyDown=\{\(e\) => \{ if \(e\.key === "Enter" \|\| e\.key === " "\) fileInputRef\.current\?\.click\(\); \}\}/);
          continue;
        }
        if (hidden || !/className="[^"]*\bsr-only\b/.test(tag)) offenders.push(`${f}: ${tag.slice(0, 90)}`);
        // the label wrapping it shows the focus the hidden input carries
        const before = s.slice(Math.max(0, m.index - 900), m.index);
        const label = before.slice(before.lastIndexOf("<label"));
        if (!/focus-within:ring-2/.test(label)) offenders.push(`${f}: label shows no focus`);
      }
    }
    expect(offenders).toEqual([]);
    expect(pickers).toBeGreaterThanOrEqual(5);
  });

  it("the public portal renders every picker focusable and named — the drawing form, the quote form and each redlines request", async () => {
    const resolved = {
      projectName: "Unit 300 Turnaround", orgName: "Acme Refining", companyName: "Apex Industrial",
      allowAutoSupersede: false,
      items: [{ docId: "d1", label: "P-101 GA", rev: "A", status: "Issued", pendingReview: false, lastOutcome: "rejected", rejectionReason: "Wrong title block", updatedAt: null }],
      redlineRequests: [{ ticketRef: "t1", ticketNumber: "DFT-7", title: "Clash at E-301", docLabel: "P-101" }],
      purpose: "documents",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(resolved), { status: 200 })));
    const params = Promise.resolve({ token: "tok" });
    await act(async () => { root.render(React.createElement(Suspense, { fallback: null }, React.createElement(IntakePortal, { params }))); });
    await flush();

    const pickers = [...host.querySelectorAll('input[type="file"]')] as HTMLInputElement[];
    expect(pickers).toHaveLength(2);
    for (const p of pickers) {
      expect(p.className).not.toMatch(/\bhidden\b/);
      expect(p.className).toMatch(/\bsr-only\b/);
      expect(p.tabIndex).toBe(0);
      expect(p.disabled).toBe(false);
      // named by its label's text, or by its own aria-label
      const name = p.getAttribute("aria-label") ?? p.closest("label")?.textContent ?? "";
      expect(name.trim().length).toBeGreaterThan(3);
    }
    expect(pickers[1].getAttribute("aria-label")).toBe("Upload redlines for Clash at E-301");
    // the rejection chip reads in both themes
    const chip = [...host.querySelectorAll("span")].find((s) => /not accepted — resubmit/.test(s.textContent ?? ""))!;
    expect(chip.className).toMatch(/text-rose-700 dark:text-rose-300/);
  });

  it("the portal says which submission type is pressed, and announces the result (error as an alert, never a silent div)", async () => {
    const resolved = {
      projectName: "P", orgName: null, companyName: "Apex", allowAutoSupersede: false,
      items: [{ docId: "d1", label: "P-101", rev: "A", status: "Issued", pendingReview: false, updatedAt: null }],
      purpose: "documents",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(resolved), { status: 200 })));
    const params = Promise.resolve({ token: "tok" });
    await act(async () => { root.render(React.createElement(Suspense, { fallback: null }, React.createElement(IntakePortal, { params }))); });
    await flush();

    const group = host.querySelector('[role="group"][aria-label="What are you submitting?"]')!;
    const [newDoc, rev] = [...group.querySelectorAll("button")];
    expect(newDoc.getAttribute("aria-pressed")).toBe("true");
    expect(rev.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { rev.click(); });
    expect(newDoc.getAttribute("aria-pressed")).toBe("false");
    expect(rev.getAttribute("aria-pressed")).toBe("true");

    // Submit with no file: the refusal is an alert inside a mounted live region.
    const submit = [...host.querySelectorAll("button")].find((b) => /^\s*Submit\s*$/.test(b.textContent ?? ""))!;
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
    await act(async () => { submit.click(); });
    const alert = host.querySelector('[aria-live="polite"] [role="alert"]');
    expect(alert?.textContent).toBe("Choose a file first.");
    expect(alert?.className).toMatch(/dark:text-rose-300/);
  });
});

const lucideName = (el: Element | null) => [...(el?.querySelector("svg")?.classList ?? [])].find((c) => c.startsWith("lucide-") && c !== "lucide-icon") ?? null;

describe("A11Y-2 — a status is a glyph and a word, not hue alone", () => {
  const tables: Array<[string, Record<string, StatusMarkSpec>]> = [
    ["checklist", CHECKLIST_STATUS_MARKS], ["punch", PUNCH_STATUS_MARKS], ["rubric", RUBRIC_MARKS],
  ];
  for (const [name, marks] of tables) {
    it(`${name}: the accessible text of each status cell includes its state, and no two states share a glyph`, async () => {
      const glyphs = new Set<string>();
      for (const [key, spec] of Object.entries(marks)) {
        const cell = document.createElement("div");
        host.appendChild(cell);
        const r = createRoot(cell);
        await act(async () => { r.render(React.createElement("div", { role: "listitem" }, React.createElement(StatusMark, { spec }), "Hydrotest records")); });
        // what a screen reader reads for the row: the state, then the item
        expect(cell.textContent).toBe(`Status: ${spec.label}.Hydrotest records`);
        expect(cell.querySelector(".sr-only")?.textContent).toBe(`Status: ${spec.label}.`);
        const g = lucideName(cell);
        expect(g, `${name}.${key} has a glyph`).not.toBeNull();
        glyphs.add(g!);
        // the glyph is decoration for the word, hidden from the tree
        expect(cell.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
        act(() => r.unmount());
      }
      expect(glyphs.size).toBe(Object.keys(marks).length);
    });
  }

  it("done and void on the punch list differ by glyph and word, not by hue alone", () => {
    expect(PUNCH_STATUS_MARKS.done.label).not.toBe(PUNCH_STATUS_MARKS.void.label);
    expect(PUNCH_STATUS_MARKS.done.Glyph).not.toBe(PUNCH_STATUS_MARKS.void.Glyph);
  });

  it("the legend lists every state with its word and meaning", async () => {
    await act(async () => { root.render(React.createElement(StatusLegend, { marks: CHECKLIST_STATUS_MARKS })); });
    const t = host.textContent ?? "";
    for (const spec of Object.values(CHECKLIST_STATUS_MARKS)) expect(t).toContain(`${spec.label} — ${spec.meaning}`);
  });

  it("the checklist row, the checklist card, the punch row and the rubric row use the marks — no bare colour dot is left", () => {
    const q = src("components/projects/QualityTab.tsx");
    expect(q).toContain("<StatusMark spec={CHECKLIST_STATUS_MARKS[na ? \"na\" : item.status] ?? CHECKLIST_STATUS_MARKS.open}");
    expect(q).toContain("<StatusLegend marks={CHECKLIST_STATUS_MARKS} />");
    expect(q).toContain("<StatusMark spec={PUNCH_STATUS_MARKS[");
    expect(q).toContain("<StatusLegend marks={PUNCH_STATUS_MARKS}");
    expect(q).not.toMatch(/w-2 h-2 rounded-full/);
    expect(q).not.toContain("function StatusDot(");
    const c = src("app/(protected)/companies/[id]/page.tsx");
    expect(c).toContain("<StatusMark spec={f.covered ? RUBRIC_MARKS.covered : RUBRIC_MARKS.gap} />");
    // the one remaining dot (the safety-log event kind) sits beside the kind written out, and is hidden
    const dots = (c.match(/<span[^>]*w-2 h-2 rounded-full[^>]*>/g) ?? []).filter((d) => !d.includes('aria-hidden="true"'));
    expect(dots).toEqual([]);
    expect(c).toMatch(/<span aria-hidden="true" className=\{`mt-1 w-2 h-2 rounded-full shrink-0 \$\{\n\s+e\.kind === "recordable"/);
  });
});

describe("A11Y-8 — decision targets, Accept's confirmation, the stepper", () => {
  const q = src("components/projects/QualityTab.tsx");
  it("the target floor is 24 px and 44 px on a coarse pointer, set on the control (no bare element rule)", () => {
    expect(q).toContain('const DECISION_TARGET = "min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3";');
    expect(src("app/globals.css")).not.toMatch(/@media \(pointer: coarse\)\s*\{\s*button\b/);
  });
  it("every Received / Accept / Reject / Waive / Reopen, item decision and punch Done / Void button carries it, in clusters spaced 8 px", () => {
    for (const label of ["Received</button>", ">Reject</button>", "✓ Satisfied</button>", "✓ Verify</button>", ">N/A</button>", "✓ Confirm N/A</button>", ">Done</button>"]) {
      const at = q.indexOf(label);
      expect(at, label).toBeGreaterThan(0);
      const open = q.lastIndexOf("<button", at);
      expect(q.slice(open, at), label).toContain("${DECISION_TARGET}");
    }
    for (const fn of ["setAccepting(it)", "startWaive(it)", "reopen(it)", 'close(it, "void")']) {
      const at = q.indexOf(`onClick={() => ${fn.startsWith("set") ? fn : `void ${fn}`}}`);
      expect(at, fn).toBeGreaterThan(0);
      expect(q.slice(at, at + 400), fn).toContain("${DECISION_TARGET}");
    }
    expect((q.match(/ml-auto flex flex-wrap items-center justify-end gap-2/g) ?? []).length).toBe(2);
    expect(q).toContain("shrink-0 basis-full sm:basis-auto flex flex-wrap items-center justify-end gap-2");
  });
  it("Accept carries the same weight as Reject: it opens the document pick and then the signature ceremony — nothing fires on the click", () => {
    expect(q).toContain("<button onClick={() => setAccepting(it)}");
    expect(q).toContain('onPick={(d) => { setAccepting(null); setSigningDecision({ item: it, status: "accepted", documentId: d.id }); }}');
    expect(q).toContain('? review(pending.item, "accepted", pending.documentId, signed)');
  });
  it("the wizard stepper is out of the tab order and the current step is marked", () => {
    const w = src("components/projects/ProjectWizard.tsx");
    expect(w).toContain('aria-current={i === step ? "step" : undefined}');
    expect(w).toMatch(/tabIndex=\{-1\}/);
  });
});

describe("A11Y-12 — decision-critical knowledge is never hover-only", () => {
  it("HelpTooltip is a disclosure: a focusable button that says it is open and what it opens, closed by Escape without closing the dialog it sits in", async () => {
    await act(async () => {
      root.render(React.createElement(HelpTooltip, { label: "What the sweep does" } as React.ComponentProps<typeof HelpTooltip>, "Greens only what the platform can prove."));
    });
    const btn = host.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("What the sweep does");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.className).not.toMatch(/focus:outline-none/);
    await act(async () => { btn.click(); });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const note = document.getElementById(btn.getAttribute("aria-controls")!)!;
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).toBe("Greens only what the platform can prove.");
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // a later Escape (nothing open) is left alone for whoever owns it
    const esc2 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(esc2); });
    expect(esc2.defaultPrevented).toBe(false);
  });

  it("existing callers keep their name: the default trigger label is unchanged", async () => {
    await act(async () => { root.render(React.createElement(HelpTooltip, null, "x")); });
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("More info");
  });

  it("the cited sites explain in text or in a disclosure, not in a title alone", () => {
    const q = src("components/projects/QualityTab.tsx");
    expect(q).toContain('<HelpTooltip label="What “Which items apply to this job?” does">');
    expect(q).toContain('<HelpTooltip label="What “Check evidence we already hold” does">');
    expect(q).not.toContain('title="AI judges which items apply to THIS job');
    expect(q).toContain('{chip.source === "auto" ? "Sweep" : "Attached"}');
    const cost = src("components/projects/CostsTab.tsx");
    expect(cost).toContain('{ENTRY_TYPES.find((t) => t.v === type)?.hint}');
    expect(cost).toContain("Earned value (EV) = this line&apos;s budget × the pinned task&apos;s % complete.");
    expect(src("components/projects/cost/ChangeOrdersPanel.tsx")).toContain("The reason code scores both sides:");
    expect(src("components/projects/ScheduleTab.tsx")).toContain("<b>Weight</b> is how much this task counts in the % complete");
    expect(src("app/(protected)/companies/[id]/page.tsx")).toContain('<p id="company-status-help"');
  });

  it("the cost glossary opens on a viewer's first visit and stays collapsed after", async () => {
    window.localStorage.clear();
    await act(async () => { root.render(React.createElement(CostGlossary)); });
    expect(host.querySelector("dl")).not.toBeNull();
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(CostGlossary)); });
    expect(host.querySelector("dl")).toBeNull();
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });
});

// ── WCAG 2.x contrast over composited backgrounds (Tailwind v3 sRGB steps;
//    v4's oklch steps render within a few units). ──
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const over = (fg: RGB, alpha: number, bg: RGB): RGB => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as RGB;
const lum = ([r, g, b]: RGB) => {
  const ch = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const T = {
  white: hex("#ffffff"), surfaceDark: hex("#111827"), canvasDark: hex("#0b1120"), text: hex("#0f172a"), textDark: hex("#f1f5f9"),
  accent: hex("#ea580c"), accentSoft: hex("#fff7ed"),
  amber500: hex("#f59e0b"), amber800: hex("#92400e"), amber300: hex("#fcd34d"), amber600: hex("#d97706"),
  rose500: hex("#f43f5e"), rose700: hex("#be123c"), rose300: hex("#fda4af"),
  emerald500: hex("#10b981"), emerald800: hex("#065f46"), emerald700: hex("#047857"), emerald300: hex("#6ee7b7"),
  blue500: hex("#3b82f6"), blue800: hex("#1e40af"), blue300: hex("#93c5fd"),
};

describe("A11Y-13 — the cited pairs clear 4.5 : 1 in both themes", () => {
  it("every date / time input on the Projects surfaces follows the theme (color-scheme), not only the cited one", () => {
    const unthemed: string[] = [];
    for (const f of PROJECT_SURFACES) {
      const s = src(f);
      for (const m of s.matchAll(/<input\b/g)) {
        const tag = s.slice(m.index, s.indexOf("/>", m.index));
        if (/type="(date|datetime-local|time)"/.test(tag) && !tag.includes("dark:[color-scheme:dark]")) unthemed.push(`${f}@${m.index}`);
      }
    }
    expect(unthemed).toEqual([]);
  });
  it("amber text on the amber-500/15 chip is the 800 step in light and the 300 step in dark (was 700 at 4.47 : 1)", () => {
    expect(ratio(T.amber800, over(T.amber500, 0.15, T.white))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(T.amber300, over(T.amber500, 0.15, T.surfaceDark))).toBeGreaterThanOrEqual(4.5);
    for (const [f, chip] of [
      ["components/projects/QualityTab.tsx", "rounded bg-amber-500/15 text-amber-800 dark:text-amber-300"],
      ["components/projects/cost/ChangeOrdersPanel.tsx", "rounded bg-amber-500/15 text-amber-800 dark:text-amber-300"],
      ["components/ui/ChartKit.tsx", "rounded bg-amber-500/15 text-amber-800 dark:text-amber-300"],
    ]) expect(src(f), f).toContain(chip);
  });
  it("the awaiting-review count is amber-800 / amber-300 (amber-600 on white was 3.19 : 1)", () => {
    expect(ratio(T.amber600, T.white)).toBeLessThan(4.5);
    expect(ratio(T.amber800, T.white)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(T.amber300, T.surfaceDark)).toBeGreaterThanOrEqual(4.5);
    expect(src("components/projects/IntakePanel.tsx")).toContain('pending.length ? "text-amber-800 dark:text-amber-300"');
  });
  it("error panels are the token recipe — rose text on a rose-500/[0.08] tint — never a light slab in a dark UI", () => {
    expect(ratio(T.rose700, over(T.rose500, 0.08, T.white))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(T.rose300, over(T.rose500, 0.08, T.surfaceDark))).toBeGreaterThanOrEqual(4.5);
    for (const f of ["app/(protected)/projects/page.tsx", "app/(protected)/projects/[id]/page.tsx", "app/(protected)/companies/[id]/page.tsx", "components/projects/ScheduleTab.tsx"]) {
      expect(src(f), f).not.toMatch(/bg-red-50\b/);
      expect(src(f), f).not.toMatch(/\btext-red-(600|700)\b/);
    }
  });
  it("the action buttons and status chips on the project pages read in dark (emerald / rose / amber / blue at the 800 step on light, 300 on dark)", () => {
    for (const [c500, c800, c300] of [[T.emerald500, T.emerald800, T.emerald300], [T.rose500, T.rose700, T.rose300], [T.amber500, T.amber800, T.amber300], [T.blue500, T.blue800, T.blue300]]) {
      expect(ratio(c800, over(c500, 0.1, T.white))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c300, over(c500, 0.1, T.surfaceDark))).toBeGreaterThanOrEqual(4.5);
    }
    const page = src("app/(protected)/projects/[id]/page.tsx");
    expect(page).not.toContain("border-red-200 bg-red-50 text-red-700");
    expect(page).not.toContain("border-emerald-200 bg-emerald-50 text-emerald-700");
    expect(page).not.toContain("hover:bg-slate-50/60");
    expect(page).toContain('tone === "active" ? "bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-300"');
    for (const f of ["app/(protected)/projects/page.tsx", "app/(protected)/projects/[id]/page.tsx"]) {
      expect(src(f), f).not.toMatch(/bg-(emerald|amber|blue|red)-100 text-/);
    }
  });
  it("form errors on the Costs tab and the change-order form carry their dark variant (rose-700 alone was 2.8 : 1 in dark)", () => {
    expect(ratio(T.rose700, T.surfaceDark)).toBeLessThan(4.5);
    for (const f of ["components/projects/CostsTab.tsx", "components/projects/cost/ChangeOrdersPanel.tsx"]) {
      expect(src(f), f).not.toMatch(/text-rose-700"/);
    }
  });
  it("every date input in the Projects area follows the theme", () => {
    const offenders: string[] = [];
    for (const f of PROJECT_SURFACES) {
      const s = src(f);
      for (let at = s.indexOf('type="date"'); at >= 0; at = s.indexOf('type="date"', at + 1)) {
        const tag = s.slice(s.lastIndexOf("<input", at), s.indexOf("/>", at));
        if (!/dark:\[color-scheme:dark\]/.test(tag)) offenders.push(`${f}: ${tag.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("A11Y-7 — the selected filter and tab are visible in both themes and announced", () => {
  it("the selected pill is the accent ring on the accent tint, with text-token text (4.5 : 1 in both themes), and says it is pressed", () => {
    const accentSoftDark = over(T.accent, 0.22, T.canvasDark);
    expect(ratio(T.text, T.accentSoft)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(T.textDark, accentSoftDark)).toBeGreaterThanOrEqual(4.5);
    // the ring is what tells it apart: orange against the unselected surface, in both themes
    expect(ratio(T.accent, T.white)).toBeGreaterThanOrEqual(3);
    expect(ratio(T.accent, T.surfaceDark)).toBeGreaterThanOrEqual(3);
    for (const f of ["app/(protected)/projects/page.tsx", "app/(protected)/companies/page.tsx", "components/projects/ScheduleFilterBar.tsx"]) {
      const s = src(f);
      expect(s, f).not.toMatch(/\bbg-slate-900 text-white\b/);
      expect(s, f).toContain("aria-pressed=");
      expect(s, f).toContain("bg-[var(--color-accent-soft)] text-[var(--color-text)] border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]");
    }
  });
  it("every toggle group the finding names says which option is pressed", () => {
    expect(src("components/projects/ProjectWizard.tsx")).toContain("aria-pressed={jobKind === k.v}");
    expect(src("components/projects/ProjectWizard.tsx")).toContain('aria-pressed={visibility === "public"}');
    expect(src("components/projects/CostsTab.tsx")).toContain("aria-pressed={type === t.v}");
    expect(src("components/projects/ScheduleTab.tsx")).toContain("aria-pressed={view === id}");
    expect(src("app/submit/[token]/page.tsx")).toContain('aria-pressed={mode === "new"}');
  });
  it("the project page's seven tabs are a tablist with a selected tab and a tabpanel", () => {
    const page = src("app/(protected)/projects/[id]/page.tsx");
    expect(page).toContain('<div role="tablist" aria-label="Project sections"');
    expect(page).toMatch(/role="tab"\n\s+aria-selected=\{active\}/);
    expect(page).toContain('role="tabpanel" id="project-tabpanel"');
    expect((page.match(/<TabButton active=/g) ?? []).length).toBe(7);
  });
});

describe("A11Y-6 / UX-7 — results are announced, and an intake failure reads as an error", () => {
  it("area census: every Projects / Companies / portal file that sets a message renders it in an alert or a live region", () => {
    const silent = PROJECT_SURFACES.filter((f) => {
      const s = src(f);
      return /\bset(Err|Error|Notice|Msg)\(/.test(s) && !/role="alert"|role=\{|aria-live=/.test(s);
    });
    expect(silent).toEqual([]);
  });
  it("the schedule board's undo toasts land in a live region that stays mounted; a warning is assertive", async () => {
    const T = UndoToastHost as unknown as React.FC<Record<string, unknown>>;
    await act(async () => { root.render(React.createElement(T, { toasts: [], onUndo: () => {}, onDismiss: () => {} })); });
    const region = host.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    await act(async () => { root.render(React.createElement(T, { toasts: [{ id: 1, message: "Moved 3 tasks", tone: "warning" }], onUndo: () => {}, onDismiss: () => {} })); });
    expect(region!.querySelector('[role="alert"]')?.textContent).toContain("Moved 3 tasks");
    expect(host.querySelector('button[aria-label="Dismiss"]')).not.toBeNull();
  });
  it("the intake notice carries a tone: setMsg is an error unless the site says otherwise, and the banner is alert / status in a live region", () => {
    const p = src("components/projects/IntakePanel.tsx");
    expect(p).toContain('const setMsg = useCallback((text: string | null, tone: "error" | "success" | "info" = "error") => {');
    expect(p).toContain('<div role={msg.tone === "error" ? "alert" : "status"} data-tone={msg.tone}');
    expect(p).toContain('<div aria-live="polite" aria-atomic="true">');
    // a failed revoke / approve / reject stays an error; a landed one is success
    expect(p).toMatch(/if \(error\) \{ setMsg\(`Couldn't revoke: \$\{userFacingError\(error\)\}`\); return; \}/);
    expect(p).toContain('landed && (!swept || swept.ok) ? "success" : "error");');
    expect(p).toContain('auditErr ? "error" : "success");');
    expect(p).not.toMatch(/\{msg && <div className="rounded-xl border border-\[var\(--color-border\)\] bg-\[var\(--color-surface\)\][^"]*">\{msg\}<\/div>\}/);
  });
  it("the cited error and confirmation sites are announced", () => {
    const page = src("app/(protected)/projects/[id]/page.tsx");
    expect(page).toMatch(/\{actionError && \(\n\s+<div role="alert" className="mb-3/);
    expect(page).toContain('{error && <div role="alert" className="mt-2 text-xs font-bold text-rose-700 dark:text-rose-300">{error}</div>}');
    expect(src("components/projects/ScheduleTab.tsx")).toMatch(/<div role="alert" className="flex items-center gap-2 text-xs font-bold text-rose-700/);
    expect(src("components/projects/cost/QuotesPanel.tsx")).toContain('<span role="status" className="sr-only">{copied ? `Link copied for');
    expect(src("components/projects/CostsTab.tsx")).toMatch(/\{error && <span role="alert" className="text-\[11px\] font-bold text-rose-700 dark:text-rose-300">\{error\}<\/span>\}/);
    expect(src("app/(protected)/projects/page.tsx")).toContain('<div role="alert" className="bg-rose-500/[0.08]');
  });
});

describe("A11Y-10 — nothing stays multi-column on a phone; a clipped money value wraps", () => {
  it("the cited grids collapse below sm:, the wizard's repeater rows restack, and the stat value wraps instead of truncating", () => {
    const offenders: string[] = [];
    for (const f of ["components/projects/ProjectWizard.tsx", "app/(protected)/companies/page.tsx", "app/(protected)/companies/[id]/page.tsx"]) {
      for (const m of src(f).matchAll(/className="grid grid-cols-(2|3)\b[^"]*"/g)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
    const w = src("components/projects/ProjectWizard.tsx");
    expect((w.match(/className="flex flex-wrap sm:flex-nowrap items-center gap-2"/g) ?? []).length).toBe(3);
    expect((w.match(/w-full sm:w-auto sm:flex-1 min-w-0/g) ?? []).length).toBe(3);
    expect(src("components/projects/CostsTab.tsx")).toContain('text-lg font-black tabular-nums text-[var(--color-text)] break-words">{value}</div>');
  });
});

describe("CHART-6 — no consumer paints a score band's colour on text", () => {
  it("scoreBandColor is used only as a mark (a dial arc, a bar fill, a dot) — never as a text color, anywhere in the app", () => {
    const files = [...walk("app"), ...walk("components")];
    const asText: string[] = [];
    for (const f of files) {
      const s = src(f);
      for (const m of s.matchAll(/color:\s*scoreBandColor\(/g)) asText.push(`${f}@${m.index}`);
    }
    expect(asText).toEqual([]);
    // the 70–84 band is the white-label accent: orange-600 on white is 3.56 : 1, under the 4.5 an 11 px label needs
    expect(ratio(T.accent, T.white)).toBeLessThan(4.5);
  });
  it("the coach header and the quality-manual coverage label wear the text token, with the band as an aria-hidden dot beside the figure", () => {
    for (const [f, call] of [
      ["components/projects/ProjectCoach.tsx", "scoreBandColor(health.score)"],
      ["app/(protected)/companies/[id]/page.tsx", "scoreBandColor(company.qualityManualScore)"],
    ]) {
      const s = src(f);
      const at = s.indexOf(`style={{ background: ${call} }}`);
      expect(at, f).toBeGreaterThan(0);
      const tag = s.slice(s.lastIndexOf("<span", at), at);
      expect(tag, f).toContain('aria-hidden="true"');
      const label = s.slice(s.lastIndexOf("<span", s.lastIndexOf("<span", at) - 1), at);
      expect(label, f).toContain("text-[var(--color-text)]");
    }
  });
});
