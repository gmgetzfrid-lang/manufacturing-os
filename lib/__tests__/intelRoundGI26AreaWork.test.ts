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
  /** table → how many statements read it (one per round trip). */
  reads: {} as Record<string, number>,
  scope: { documents: [] as string[], assets: [] as string[], label: "Crude", complete: true },
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let cols = "";
    let limit = Infinity;
    const run = () => {
      db.reads[table] = (db.reads[table] ?? 0) + 1;
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
          // ILIKE, as Postgres reads it: case-blind, % any run (newlines too), _ any one character
          if (prop === "ilike") {
            const re = new RegExp(`^${String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "is");
            filters.push((r) => r[c] != null && re.test(String(r[c])));
          }
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

import { resolveMilestoneLocation, loadAreaWork, loadAssetScheduledWork, assetLocationPattern } from "@/lib/areaWork";
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
  it("REGRESSION (review): a common word used as a unit's name never pulls in another area's work — a code beats a name, and a name is refused when another unit is named", () => {
    const units = [{ code: "20", label: "Crude" }, { code: "40", label: "Utilities" }, { code: "50", label: "North" }, { code: "60", label: "Tank Farm" }];
    const ctx = { assets: CTX.assets, units };
    // unit 20's work that mentions utilities is unit 20's
    expect(resolveMilestoneLocation("Unit 20 utilities tie-in", ctx)).toEqual({ kind: "unit", code: "20" });
    // a unit this context does not hold, designated by code, is never the one named "Utilities"
    expect(resolveMilestoneLocation("Unit 70 utilities tie-in", ctx)).toBeNull();
    expect(resolveMilestoneLocation("area #7 utilities", ctx)).toBeNull();
    // more than one unit's name in the location: nothing
    expect(resolveMilestoneLocation("North tank farm dike", ctx)).toBeNull();
    // one name, nothing else named: that unit (as before)
    expect(resolveMilestoneLocation("Utilities", ctx)).toEqual({ kind: "unit", code: "40" });
    expect(resolveMilestoneLocation("Tank Farm area tie-ins", ctx)).toEqual({ kind: "unit", code: "60" });
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
  it("REGRESSION (review): another area's milestone that mentions this area's name is not listed here — the other codebook units are read and a code beats a name", async () => {
    db.scope.label = "Utilities";
    db.tables.codebook_entries = [
      { id: "c20", org_id: "o1", kind: "unit", code: "20", label: "Crude" },
      { id: "c40", org_id: "o1", kind: "unit", code: "40", label: "Utilities" },
      { id: "c50", org_id: "o1", kind: "unit", code: "50", label: "North" },
    ];
    db.tables.milestones.push(
      { id: "m7", org_id: "o1", name: "Unit 20 tie-in", status: "planned", planned_at: "2026-11-06", location: "Unit 20 utilities tie-in", project_id: null },
      { id: "m8", org_id: "o1", name: "Utilities header", status: "planned", planned_at: "2026-11-07", location: "Utilities header", project_id: null },
      { id: "m9", org_id: "o1", name: "Shared", status: "planned", planned_at: "2026-11-08", location: "North utilities corridor", project_id: null },
      { id: "m10", org_id: "o1", name: "Unknown unit", status: "planned", planned_at: "2026-11-09", location: "Unit 70 utilities", project_id: null },
    );
    db.scope.assets = [];
    const w = await loadAreaWork("o1", "40");
    expect(w.notes).toEqual([]);
    expect(w.milestones.map((m) => m.id)).toEqual(["m8"]);
  });
  it("the other areas' names unread: said, and the list may be short of that check", async () => {
    db.fail.codebook_entries = { message: "timeout" };
    const w = await loadAreaWork("o1", "20");
    expect(w.complete).toBe(false);
    expect(w.notes).toEqual(expect.arrayContaining([expect.stringMatching(/The other areas' names could not be read \(timeout\)/)]));
    expect(w.milestones.map((m) => m.id)).toEqual(["m2", "m1"]);
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

  it("REGRESSION (review): the server reads only the locations that could name the asset — every milestone the client match accepted over the whole workspace is still returned (no narrowing), and an asset no milestone names costs one round trip", async () => {
    // A corpus of locations: spellings of the one tag grammar, near misses,
    // punctuation and case games, the two non-ASCII capitals that lowercase
    // to ASCII, newlines — and a seeded random fuzz over the same alphabet.
    const fixed = [
      "E-22", "e22", "E 22", "E_22", "E/22", "E.22", "E--22", "E\n22", "  e - 2 2  ", "Exchanger E-22 north", "near E-22A",
      "E-222", "E-2", "PE-22", "E22/E-23", "Bay 3, E-22 tube bundle", "P-101", "P101", "p 101", "P-101-A", "P-101A", "unit 20",
      "K-9", "\u212A-9", "k9", "KK-9", "I-22", "\u0130-22", "i22", "ı-22", "Kiln KI-7", "KI-7", "K\u0130-7", "", "—", "22-E",
    ];
    let state = 42;
    const rand = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
    const alphabet = ["E", "e", "2", "-", " ", "P", "1", "0", "K", "k", "I", "i", "9", "7", "A", "/", "\n", "\u212A", "\u0130", "ı", "_", "%", "x"];
    const fuzz = Array.from({ length: 4000 }, () => Array.from({ length: 1 + Math.floor(rand() * 7) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join(""));
    db.tables.milestones = [...fixed, ...fuzz].map((location, n) => ({
      id: `m${String(n).padStart(5, "0")}`, org_id: "o1", name: `M${n}`, status: "planned", planned_at: null, location, project_id: null,
    }));
    for (const asset of [{ id: "a22", tag: "E-22" }, { id: "a101", tag: "P-101A" }, { id: "a9", tag: "K-9" }, { id: "ai", tag: "I-22" }, { id: "aki", tag: "KI-7" }, { id: "a7", tag: "E-27" }]) {
      // the old read: every open located milestone, the client match deciding
      const before = db.tables.milestones
        .filter((m) => m.status !== "completed" && m.location != null)
        .filter((m) => resolveMilestoneLocation(String(m.location), { assets: [asset], units: [] })?.kind === "asset")
        .map((m) => m.id).sort();
      db.reads = {};
      const r = await loadAssetScheduledWork("o1", asset);
      expect(r.note).toBeNull();
      expect(r.milestones.map((m) => m.id).sort(), asset.tag).toEqual(before);
      if (asset.tag === "E-22") expect(before.length).toBeGreaterThan(10);
    }
    // the server's predicate holds every location the match accepts, by construction
    expect(assetLocationPattern("E-22")).toBe("%e%2%2%");
    expect(assetLocationPattern("KI-7")).toBe("%_%_%7%");
    expect(assetLocationPattern("--")).toBeNull();
    // an asset no milestone names: one statement, and nothing listed
    db.tables.milestones = [
      { id: "m1", org_id: "o1", name: "Exchanger retube", status: "planned", planned_at: null, location: "E-22", project_id: null },
      ...Array.from({ length: 2500 }, (_, n) => ({ id: `n${String(n).padStart(5, "0")}`, org_id: "o1", name: `N${n}`, status: "planned", planned_at: null, location: `Bay ${n}`, project_id: null })),
    ];
    db.reads = {};
    const none = await loadAssetScheduledWork("o1", { id: "a9", tag: "Q-77" });
    expect(none).toEqual({ milestones: [], note: null });
    expect(db.reads.milestones).toBe(1);
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
