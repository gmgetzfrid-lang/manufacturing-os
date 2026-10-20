// @vitest-environment jsdom
//
// intelligence Round G I-26 — WIRE-7 criteria 2-3.
//   2. Holds and work packages listed by operating area: the open holds on
//      the area's documents (lib/scope.ts resolveScope's one unit identity)
//      and the open work packages that carry one of them.
//   3. milestone.location resolves to an asset or a unit when it names one
//      (the one tag grammar; a unit by "unit/area <code>", its code alone or
//      its Site Codebook name), and the asset hub shows scheduled work.
// Nothing is guessed: a location that names nothing resolves to nothing; a
// read that fails is said, never shown as "nothing in flight".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  fail: {} as Record<string, { message: string } | undefined>,
  scope: { documents: [] as string[], assets: [] as string[], label: "Crude", complete: true },
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let cols = "";
    let limit = Infinity;
    const run = () => {
      if (db.fail[table]) return { data: null, error: db.fail[table] };
      const pick = cols.split(",").map((x) => x.trim()).filter(Boolean);
      const rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, limit);
      return { data: rows.map((r) => Object.fromEntries(pick.map((k) => [k, r[k]]))), error: null };
    };
    const p: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(run());
        return (...a: unknown[]) => {
          const [c, v] = a as [string, unknown];
          if (prop === "select") cols = String(a[0]);
          if (prop === "eq") filters.push((r) => r[c] === v);
          if (prop === "neq") filters.push((r) => r[c] !== v);
          if (prop === "in") filters.push((r) => (v as unknown[]).includes(r[c]));
          if (prop === "is") filters.push((r) => (v === null ? r[c] == null : r[c] === v));
          if (prop === "not") filters.push((r) => r[c] != null);
          if (prop === "gt") filters.push((r) => String(r[c]) > String(v));
          if (prop === "limit") limit = Number(a[0]);
          return new Proxy(p, h);
        };
      },
    };
    return new Proxy(p, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/scope", () => ({
  resolveScope: vi.fn(async (_o: string, ref: { code: string }) => ({
    ref, label: db.scope.label, found: true, unitCodes: [ref.code], unitIds: [], systemIds: [], plantIds: [],
    assets: db.scope.assets, documents: db.scope.documents, libraries: [], knowledgeLibraries: [],
    why: { decoded: 0, filed: 0, pinned: 0, governing: 0 }, complete: db.scope.complete, truncations: [],
  })),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import { resolveMilestoneLocation, loadAreaWork, loadAssetScheduledWork } from "@/lib/areaWork";
import { AreaWorkPanel, ScheduledWorkPanel } from "@/components/assets/AreaWorkPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CTX = { assets: [{ id: "a22", tag: "E-22" }, { id: "a101", tag: "P-101" }], units: [{ code: "20", label: "Crude" }] };

describe("WIRE-7 criterion 3 — resolveMilestoneLocation (pure, never a guess)", () => {
  it("an equipment tag anywhere in the location, in any spelling of the one tag grammar", () => {
    expect(resolveMilestoneLocation("E-22 north side", CTX)).toEqual({ kind: "asset", assetId: "a22", tag: "E-22" });
    expect(resolveMilestoneLocation("e22", CTX)).toEqual({ kind: "asset", assetId: "a22", tag: "E-22" });
    expect(resolveMilestoneLocation("Replace seal on P101 (Unit 20)", CTX)).toEqual({ kind: "asset", assetId: "a101", tag: "P-101" });
  });
  it("a unit by 'unit/area <code>', its code alone, or its Site Codebook name as whole words", () => {
    expect(resolveMilestoneLocation("Unit 20 pipe rack", CTX)).toEqual({ kind: "unit", code: "20" });
    expect(resolveMilestoneLocation("area-20", CTX)).toEqual({ kind: "unit", code: "20" });
    expect(resolveMilestoneLocation("20", CTX)).toEqual({ kind: "unit", code: "20" });
    expect(resolveMilestoneLocation("Crude unit tie-ins", CTX)).toEqual({ kind: "unit", code: "20" });
  });
  it("a location that names nothing the context holds is null — near misses included", () => {
    expect(resolveMilestoneLocation("P-1010 skid", CTX)).toBeNull();
    expect(resolveMilestoneLocation("Unit 200", CTX)).toBeNull();
    expect(resolveMilestoneLocation("Crudest estimate", CTX)).toBeNull();
    expect(resolveMilestoneLocation("Building 5, room 20b", CTX)).toBeNull();
    expect(resolveMilestoneLocation("", CTX)).toBeNull();
    expect(resolveMilestoneLocation(null, CTX)).toBeNull();
  });
});

function seed() {
  db.fail = {};
  db.scope = { documents: ["d1", "d2", "d3"], assets: ["a22"], label: "Crude", complete: true };
  db.tables = {
    documents: [
      { id: "d1", org_id: "o1", document_number: "20-02-001", library_id: "lib1" },
      { id: "d2", org_id: "o1", document_number: "20-02-002", library_id: "lib1" },
      { id: "d9", org_id: "o1", document_number: "30-02-001", library_id: "lib1" },
    ],
    document_holds: [
      { id: "h1", org_id: "o1", document_id: "d1", reason: "Awaiting HAZOP", opened_at: "2026-10-01", expected_release_at: null, released_at: null },
      { id: "h2", org_id: "o1", document_id: "d2", reason: "Released", opened_at: "2026-09-01", expected_release_at: null, released_at: "2026-09-10" },
      { id: "h9", org_id: "o1", document_id: "d9", reason: "Another unit", opened_at: "2026-10-01", expected_release_at: null, released_at: null },
    ],
    work_package_documents: [
      { id: "w1", org_id: "o1", package_id: "pk1", document_id: "d1" },
      { id: "w2", org_id: "o1", package_id: "pk1", document_id: "d2" },
      { id: "w3", org_id: "o1", package_id: "pk2", document_id: "d3" },
      { id: "w4", org_id: "o1", package_id: "pk9", document_id: "d9" },
    ],
    work_packages: [
      { id: "pk1", org_id: "o1", name: "Turnaround 2026", status: "executing" },
      { id: "pk2", org_id: "o1", name: "Old package", status: "closed" },
      { id: "pk9", org_id: "o1", name: "Unit 30 package", status: "open" },
    ],
    assets: [{ id: "a22", org_id: "o1", tag: "E-22" }, { id: "a101", org_id: "o1", tag: "P-101" }],
    milestones: [
      { id: "m1", org_id: "o1", name: "Exchanger retube", status: "planned", planned_at: "2026-11-02", location: "E-22 north side", project_id: "p1" },
      { id: "m2", org_id: "o1", name: "Tie-in window", status: "in_progress", planned_at: "2026-11-01", location: "Unit 20 pipe rack", project_id: null },
      { id: "m3", org_id: "o1", name: "Done", status: "completed", planned_at: "2026-10-01", location: "E-22", project_id: null },
      { id: "m4", org_id: "o1", name: "Elsewhere", status: "planned", planned_at: "2026-11-03", location: "Building 5", project_id: null },
      { id: "m5", org_id: "o1", name: "Another unit's pump", status: "planned", planned_at: "2026-11-04", location: "P-101", project_id: null },
      { id: "m6", org_id: "o1", name: "No location", status: "planned", planned_at: "2026-11-05", location: null, project_id: null },
    ],
  };
}

describe("WIRE-7 criterion 2 — loadAreaWork lists holds and work packages by operating area", () => {
  beforeEach(seed);
  it("open holds on the area's documents only; open packages carrying them, with how many; milestones located on the area or its equipment", async () => {
    const w = await loadAreaWork("o1", "20");
    expect(w.complete).toBe(true);
    expect(w.notes).toEqual([]);
    expect(w.holds).toEqual([{ id: "h1", documentId: "d1", documentLabel: "20-02-001", libraryId: "lib1", reason: "Awaiting HAZOP", openedAt: "2026-10-01", expectedReleaseAt: null }]);
    expect(w.workPackages).toEqual([{ id: "pk1", name: "Turnaround 2026", status: "executing", documents: 2 }]);
    // P-101 belongs to another unit (not in the scope's assets) — not this area's
    expect(w.milestones.map((m) => [m.id, m.match])).toEqual([
      ["m2", { kind: "unit", code: "20" }],
      ["m1", { kind: "asset", assetId: "a22", tag: "E-22" }],
    ]);
  });
  it("a read that fails is said — never 'nothing on hold'", async () => {
    db.fail.document_holds = { message: "timeout" };
    db.fail.milestones = { message: "permission denied" };
    const w = await loadAreaWork("o1", "20");
    expect(w.complete).toBe(false);
    expect(w.notes).toEqual(expect.arrayContaining(["The open holds could not be read (timeout).", "The scheduled milestones could not be read (permission denied)."]));
  });
  it("an incomplete scope is said", async () => {
    db.scope.complete = false;
    const w = await loadAreaWork("o1", "20");
    expect(w.complete).toBe(false);
    expect(w.notes[0]).toMatch(/could not all be placed/);
  });
});

describe("WIRE-7 criterion 3 — the asset hub's scheduled work", () => {
  beforeEach(seed);
  it("loadAssetScheduledWork: the open milestones whose location names this asset, never a unit's", async () => {
    const r = await loadAssetScheduledWork("o1", { id: "a22", tag: "E-22" });
    expect(r.note).toBeNull();
    expect(r.milestones.map((m) => m.id)).toEqual(["m1"]);
  });

  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const render = async (el: React.ReactElement) => {
    await act(async () => { root.render(el); });
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  };

  it("rendered on the hub: the milestone, its date and status, linked to its project", async () => {
    await render(React.createElement(ScheduledWorkPanel, { orgId: "o1", asset: { id: "a22", tag: "E-22" } }));
    expect(host.querySelector("[data-scheduled-work='1']")).not.toBeNull();
    const row = host.querySelector("[data-milestone='m1']")!;
    expect(row.textContent).toMatch(/Exchanger retube · .* · planned · at E-22/);
    expect(row.querySelector("a")?.getAttribute("href")).toBe("/projects/p1");
  });
  it("REGRESSION: equipment no milestone names shows nothing (the hub reads as before); a failed read is said", async () => {
    await render(React.createElement(ScheduledWorkPanel, { orgId: "o1", asset: { id: "a9", tag: "K-9" } }));
    expect(host.innerHTML).toBe("");
    db.fail.milestones = { message: "timeout" };
    await render(React.createElement(ScheduledWorkPanel, { orgId: "o1", asset: { id: "a22", tag: "E-22" } }));
    expect(host.querySelector("[data-scheduled-work-note]")?.textContent).toBe("Scheduled work could not be read (timeout).");
  });
  it("the area card lists the holds, packages and milestones in flight", async () => {
    await render(React.createElement(AreaWorkPanel, { orgId: "o1", unitCode: "20" }));
    expect(host.querySelector("[data-area-work-holds='1']")?.textContent).toContain("1 open hold on its documents");
    expect(host.querySelector("[data-area-work-holds] a")?.getAttribute("href")).toBe("/documents/lib1?doc=d1");
    expect(host.querySelector("[data-area-work-packages='1']")?.textContent).toContain("Turnaround 2026 · executing · 2 of its documents here");
    expect(host.querySelector("[data-area-work-milestones='2']")).not.toBeNull();
    expect(host.querySelector("[data-area-work-incomplete]")).toBeNull();
  });
});
