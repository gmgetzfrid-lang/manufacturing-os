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
//            submission type is pressed, and has a dark variant per tone.

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
      const re = /<input\b[^>]*type="file"[^>]*>/g;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        pickers++;
        const tag = m[0];
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
