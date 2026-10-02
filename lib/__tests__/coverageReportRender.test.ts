// @vitest-environment jsdom
//
// intelligence Round G (I-11) — GAP-308's placement (the fleet plan's
// default): the coverage report opens org-wide from the equipment sweep AND,
// scoped to the unit, from an operating unit's page. Rendered: opened with
// `initialUnitCode`, the report asks the route for that unit; its selector
// still widens it to org-wide. The unit page mounts it on demand for the
// registry writer tier.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children) }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } }));

import CoverageReport from "@/components/assets/CoverageReport";

const EMPTY = {
  scope: { unitCode: "20", label: "Crude Unit" },
  totals: { assets: 1, onSheet: 0, onNoSheet: 1, sheetTagsWithoutAsset: 0, disagree: 0 },
  agree: [], listOnly: [{ assetId: "a1", tag: "E-22", unitCode: "20", origin: "manual" }], sheetOnly: [], disagree: [], notes: [],
};

let container: HTMLDivElement;
let root: Root;
const bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ report: EMPTY }) };
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("GAP-308 — the coverage report, scoped to a unit from the unit's page", () => {
  it("opened with initialUnitCode it asks for that unit; the selector widens it to org-wide", async () => {
    await act(async () => {
      root.render(React.createElement(CoverageReport, { orgId: "o1", units: [{ code: "20", label: "Crude Unit" }, { code: "25", label: "DHT" }], initialUnitCode: "20" }));
    });
    await settle();
    expect(bodies[0]).toEqual({ action: "coverage", orgId: "o1", unitCode: "20" });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("20");
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(bodies[bodies.length - 1]).toEqual({ action: "coverage", orgId: "o1", unitCode: null });
  });
  it("without it (the sweep's mount) it opens org-wide, as before", async () => {
    await act(async () => { root.render(React.createElement(CoverageReport, { orgId: "o1", units: [] })); });
    await settle();
    expect(bodies[0]).toEqual({ action: "coverage", orgId: "o1", unitCode: null });
  });
  it("the operating unit's page mounts it on demand, scoped to the unit, for the registry writer tier", () => {
    const page = readFileSync("app/(protected)/admin/assets/page.tsx", "utf8");
    expect(page).toMatch(/import CoverageReport from "@\/components\/assets\/CoverageReport";/);
    expect(page).toMatch(/\{currentUnit && !loading && uid && activeOrgId && isAdmin && \(/);
    const at = page.indexOf("<CoverageReport orgId={activeOrgId}");
    expect(at).toBeGreaterThan(0);
    expect(page.slice(page.lastIndexOf("{showCoverage && (", at), at)).toMatch(/^\{showCoverage && \(\s*<div className="mt-2">\s*$/);
    expect(page.slice(at, page.indexOf("/>", at))).toMatch(/initialUnitCode=\{currentUnit\.code\}/);
  });
});
