// @vitest-environment jsdom
//
// intelligence Round G I-26 — AREA-4 limbs 2-3: the Operating Areas checklist
// gains "Populate this area's equipment from its drawings", between
// connecting the area's knowledge and the deep read. It shows the live count
// of the Equipment Bridge's proposals waiting on the area's drawings (its
// shelf's mirrors — never another unit's sheets in the same library), and
// launches the sweep in place (EquipmentSweepModal) for the library they sit
// in, so a P&ID bound to an area can populate its equipment without a visit
// to /documents/[libraryId].
// REGRESSION: the four existing steps keep their titles and states
// (areaKnowledgeCoverage.test.ts passes unchanged); a count that cannot be
// read says "not counted", never "0 waiting".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  fail: {} as Record<string, { code?: string; message: string } | undefined>,
  reads: [] as Array<{ table: string; cols: string }>,
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let cols = "";
    let limit = Infinity;
    const run = () => {
      db.reads.push({ table, cols });
      const key = `${table}:${cols}`;
      const f = db.fail[key] ?? db.fail[table];
      if (f) return { data: null, error: f };
      const rows = (db.tables[table] ?? []).filter((r) => filters.every((fn) => fn(r)))
        .sort((a, b) => String(a.id ?? a.document_id).localeCompare(String(b.id ?? b.document_id)));
      // only the selected columns come back, as PostgREST answers
      const pick = cols.split(",").map((x) => x.trim()).filter(Boolean);
      return { data: rows.slice(0, limit).map((r) => Object.fromEntries(pick.map((k) => [k, r[k]]))), error: null };
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
          if (prop === "gt") filters.push((r) => String(r[c]) > String(v));
          if (prop === "not") filters.push((r) => r[c] !== null && r[c] !== undefined);
          if (prop === "limit") limit = Number(a[0]);
          return new Proxy(p, h);
        };
      },
    };
    return new Proxy(p, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } };
});
const sweep = vi.hoisted(() => ({ mounts: [] as Array<{ libraryId: string; libraryName: string; onApplied: () => void; onClose: () => void }> }));
vi.mock("@/components/documents/EquipmentSweepModal", () => ({
  default: (props: { libraryId: string; libraryName: string; onApplied: () => void; onClose: () => void }) => {
    sweep.mounts.push(props);
    return React.createElement("div", { "data-sweep-modal": props.libraryId }, `Equipment sweep — ${props.libraryName}`);
  },
}));
vi.mock("@/lib/processFlows", () => ({ listProcessFlows: vi.fn(async () => []) }));
vi.mock("@/lib/knowledge", () => ({
  createKnowledgeLibrary: vi.fn(), addKnowledgeSources: vi.fn(), syncKnowledgeSources: vi.fn(),
  removeKnowledgeSource: vi.fn(), browseKnowledgeContainers: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import { pendingTagsOf, countAreaEquipmentProposals } from "@/lib/areaEquipmentProposals";
import { AreaKnowledgePanel } from "@/components/assets/AreaKnowledgePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sugg = (document_id: string, suggested: Row[], over: Row = {}) => ({ org_id: "o1", document_id, status: "pending", suggested, applied: [], dismissed: [], ...over });
function seed() {
  db.fail = {}; db.reads = [];
  db.tables = {
    knowledge_documents: [
      { id: "k1", org_id: "o1", library_id: "kl1", source_document_id: "d1" },
      { id: "k2", org_id: "o1", library_id: "kl1", source_document_id: "d2" },
      { id: "k3", org_id: "o1", library_id: "kl1", source_document_id: "d9" }, // in another library
      { id: "k4", org_id: "o1", library_id: "kl1", source_document_id: null }, // an upload — not a drawing of doc control
      { id: "kx", org_id: "o1", library_id: "kl-other", source_document_id: "d5" }, // another area's shelf
    ],
    collections: [{ id: "f1", org_id: "o1", library_id: "lib-pid" }],
    documents: [
      { id: "d1", org_id: "o1", library_id: "lib-pid", status: "Issued" },
      { id: "d2", org_id: "o1", library_id: "lib-pid", status: "Issued" },
      { id: "d5", org_id: "o1", library_id: "lib-pid", status: "Issued" }, // another unit's sheet, same library
      { id: "d9", org_id: "o1", library_id: "lib-pfd", status: "Issued" },
    ],
    document_equipment_suggestions: [
      sugg("d1", [{ tag: "P-101" }, { tag: "V-102" }, { tag: "E-103" }, { tag: "X-9", held: "unknown_prefix" }], { applied: ["E-103"] }),
      sugg("d2", [{ tag: "K-201" }, { tag: "K-202", dismissed: true }], { dismissed: [{ tag: "K-201" }] }),
      sugg("d5", [{ tag: "T-500" }]),
      sugg("d9", [{ tag: "C-1" }], { status: "applied" }),
    ],
    libraries: [{ id: "lib-pid", name: "P&IDs" }, { id: "lib-pfd", name: "PFDs" }],
  };
}

describe("AREA-4 — pendingTagsOf (the Bridge's own unnamed-apply rule)", () => {
  it("a pending row's tags not applied, not dismissed (row or tag), not held; any other status none", () => {
    expect(pendingTagsOf({ document_id: "d", status: "pending", suggested: [{ tag: "A" }, { tag: "B" }, { tag: "C", held: "unknown_prefix" }, { tag: "D", dismissed: true }, { tag: "A" }], applied: ["B"], dismissed: [] })).toEqual(["A"]);
    expect(pendingTagsOf({ document_id: "d", status: "pending", suggested: [{ tag: "A" }], dismissed: [{ tag: "A" }] })).toEqual([]);
    expect(pendingTagsOf({ document_id: "d", status: "applied", suggested: [{ tag: "A" }] })).toEqual([]);
    expect(pendingTagsOf({ document_id: "d", status: "pending", suggested: null })).toEqual([]);
  });
});

describe("AREA-4 — countAreaEquipmentProposals (the caller's own reads)", () => {
  beforeEach(seed);
  const count = () => countAreaEquipmentProposals({ orgId: "o1", knowledgeLibraryId: "kl1", sources: [{ type: "folder", sourceId: "f1" }] });

  it("counts the area's drawings only (never another unit's sheet in the same library), per library, most waiting first", async () => {
    expect(await count()).toEqual({
      shelfDocuments: 3, documents: 1, tags: 2,
      libraries: [
        { libraryId: "lib-pid", libraryName: "P&IDs", documents: 1, tags: 2 },
        { libraryId: "lib-pfd", libraryName: "PFDs", documents: 0, tags: 0 },
      ],
    });
  });
  it("a watched library with no drawings mirrored yet is still offered (the sweep can be opened before the first proposal)", async () => {
    db.tables.knowledge_documents = [];
    db.tables.libraries.push({ id: "lib-new", name: "Isometrics" });
    const p = await countAreaEquipmentProposals({ orgId: "o1", knowledgeLibraryId: "kl1", sources: [{ type: "library", sourceId: "lib-new" }, { type: "folder", sourceId: "f1" }] });
    expect(p).toEqual({ shelfDocuments: 0, documents: 0, tags: 0, libraries: [
      { libraryId: "lib-new", libraryName: "Isometrics", documents: 0, tags: 0 },
      { libraryId: "lib-pid", libraryName: "P&IDs", documents: 0, tags: 0 },
    ] });
  });
  it("before 20261171 (no dismissed column) it reads without it — a suggestion's own dismissed flag still holds it back", async () => {
    db.fail["document_equipment_suggestions:document_id, status, suggested, applied, dismissed"] = { code: "42703", message: "column document_equipment_suggestions.dismissed does not exist" };
    const p = await count();
    // K-201 is no longer held back by the (unread) row-level dismissal
    expect(p?.tags).toBe(3);
    expect(db.reads.filter((r) => r.table === "document_equipment_suggestions").map((r) => r.cols)).toEqual([
      "document_id, status, suggested, applied, dismissed", "document_id, status, suggested, applied",
    ]);
  });
  it("any read that fails is null — 'not counted', never 0", async () => {
    for (const t of ["knowledge_documents", "collections", "documents", "document_equipment_suggestions", "libraries"]) {
      seed();
      db.fail[t] = { code: "57014", message: "timeout" };
      expect(await count(), t).toBeNull();
    }
  });
});

describe("AREA-4 — the checklist step, rendered", () => {
  let host: HTMLDivElement;
  let root: Root;
  const status = (over: Row = {}) => ({
    unit: { code: "20", label: "Crude" },
    boundLibrary: { id: "kl1", name: "Crude shelf" },
    knowledgeLibraries: [{ id: "kl1", name: "Crude shelf" }],
    sources: [{ id: "s1", type: "folder", sourceId: "f1", name: "P&IDs / Crude" }],
    counts: { ready: 3, pending: 0 },
    drift: { deadSources: [], movedOut: [], movedOutTotal: 0, newMatches: [] },
    suggestions: [],
    flowReads: { readable: 3, read: 0, otherDocs: 0 },
    canManage: true,
    ...over,
  });
  const mount = async (s: Row) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(s), { status: 200 })) as typeof fetch;
    await act(async () => {
      root.render(React.createElement(AreaKnowledgePanel, { orgId: "o1", userId: "u1", userName: "u", unit: { code: "20", label: "Crude" }, unitAssetIds: [] }));
    });
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  };
  const titles = () => [...host.querySelectorAll("span.text-xs.font-black")].map((x) => x.textContent);
  const step = (title: string) => ([...host.querySelectorAll("span")].find((x) => x.textContent === title)!.closest("div.flex.items-start") as HTMLElement);
  const POPULATE = "Populate this area's equipment from its drawings";
  beforeEach(() => { seed(); sweep.mounts = []; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("sits between connecting the knowledge and the deep read, with the live count and 'in progress'", async () => {
    await mount(status());
    expect(titles()).toEqual([
      "File this area's drawings in Documents", "Connect the area's knowledge", POPULATE,
      "Deep read the drawings", "Link equipment files to assets",
    ]);
    const s = step(POPULATE);
    expect(s.textContent).toContain("2 equipment tags read off 1 of this area's drawing are waiting for review.");
    expect(s.textContent).toContain("in progress");
    expect(s.textContent).toContain("no document column needs mapping first");
  });

  it("'Review proposals' launches the sweep IN PLACE for the library they sit in; an apply re-counts", async () => {
    await mount(status());
    const btn = step(POPULATE).querySelector("[data-area-sweep='open']") as HTMLButtonElement;
    expect(btn.textContent).toContain("Review proposals");
    await act(async () => { btn.click(); });
    expect(host.querySelector("[data-sweep-modal='lib-pid']")?.textContent).toBe("Equipment sweep — P&IDs");
    // the reviewer applies everything: the ledger row is applied, the count follows
    db.tables.document_equipment_suggestions[0].status = "applied";
    db.tables.document_equipment_suggestions[1].status = "applied";
    await act(async () => { sweep.mounts[sweep.mounts.length - 1].onApplied(); });
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
    expect(step(POPULATE).textContent).toContain("No equipment proposals are waiting on this area's 3 drawings");
    expect(step(POPULATE).querySelector("svg.lucide-check")).not.toBeNull();
    await act(async () => { sweep.mounts[sweep.mounts.length - 1].onClose(); });
    expect(host.querySelector("[data-sweep-modal]")).toBeNull();
  });

  it("several libraries: each can be swept from the step", async () => {
    await mount(status());
    const pfd = host.querySelector("[data-area-sweep-library='lib-pfd'] button") as HTMLButtonElement;
    await act(async () => { pfd.click(); });
    expect(host.querySelector("[data-sweep-modal='lib-pfd']")).not.toBeNull();
  });

  it("a member who cannot manage sees the count, no launch, and who reviews them", async () => {
    await mount(status({ canManage: false }));
    const s = step(POPULATE);
    expect(s.querySelector("[data-area-sweep='open']")).toBeNull();
    expect(s.querySelector("[data-area-sweep-library] button")).toBeNull();
    expect(s.textContent).toContain("Document Control or an Admin reviews them.");
  });

  it("a count that cannot be read says 'not counted', never 0 waiting", async () => {
    db.fail.document_equipment_suggestions = { message: "permission denied", code: "42501" };
    await mount(status());
    const s = step(POPULATE);
    expect(s.textContent).toContain("not counted");
    expect(s.querySelector("[data-area-proposals='unread']")).not.toBeNull();
  });

  it("an area with no knowledge connected: the step says to connect first and reads nothing", async () => {
    await mount(status({ boundLibrary: null, sources: [] }));
    expect(step(POPULATE).textContent).toContain("Connect the area's knowledge first");
    expect(db.reads.filter((r) => r.table === "document_equipment_suggestions")).toHaveLength(0);
  });
});
