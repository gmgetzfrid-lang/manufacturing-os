// @vitest-environment jsdom
//
// intelligence Round G (I-09) — AREA-8: the area checklist carries COVERAGE,
// not presence. The knowledge-status route counts the area shelf's FLOW
// DRAWINGS (a PFD / P&ID / block diagram by title or doc-control folder, or
// a document already read) read for flows (a FLOWS_READ record — a read,
// flows found or not — or a flow read off it), and counts the data sheets
// and manuals beside them apart; the panel ticks step 3 only when every one was
// read and step 4 only when every piece of the area's equipment has a linked
// document, shows "in progress" in between, and never ticks step 1 for a
// folder that merely carries the area's name.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  failAudit: false,
  landscape: { libraries: new Map(), folders: new Map(), teamSupervisors: new Map() } as {
    libraries: Map<string, { name: string }>;
    folders: Map<string, { name: string; library_id: string; parent_id: string | null; path_names: string[] }>;
    teamSupervisors: Map<string, unknown>;
  },
}));
function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let range: [number, number] | null = null;
  const run = () => {
    if (table === "audit_logs" && st.failAudit) return { data: null, error: { message: "down" } };
    const rows = (st.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
    return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(run());
      return (...args: unknown[]) => {
        if (prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
        if (prop === "not") filters.push((r) => r[String(args[0])] !== null && r[String(args[0])] !== undefined);
        if (prop === "range") range = [Number(args[0]), Number(args[1])];
        if (prop === "maybeSingle") { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }); }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => ({ uid: "u1", isController: true })),
  loadDcLandscape: vi.fn(async () => st.landscape),
  containerReadable: () => true,
}));
// The panel's client reads (flows, document links, plot plans).
const cl = vi.hoisted(() => ({ links: [] as Row[], flows: [] as Row[], linksError: null as { message: string } | null, linksThrow: false }));
vi.mock("@/lib/supabase", () => {
  const c = (table: string): unknown => {
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          if (table === "document_assets" && cl.linksThrow) return () => { throw new Error("network down"); };
          if (table === "document_assets" && cl.linksError) return (resolve: (v: unknown) => void) => resolve({ data: null, error: cl.linksError });
          const data = table === "document_assets" ? cl.links : table === "process_flows" ? cl.flows : [];
          return (resolve: (v: unknown) => void) => resolve({ data, error: null });
        }
        return () => new Proxy({}, h);
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => c(t), auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } };
});
vi.mock("@/lib/knowledge", () => ({
  createKnowledgeLibrary: vi.fn(), addKnowledgeSources: vi.fn(), syncKnowledgeSources: vi.fn(),
  removeKnowledgeSource: vi.fn(), browseKnowledgeContainers: vi.fn(), acceptAiAgreement: vi.fn(),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true), appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import { GET } from "@/app/api/area/knowledge-status/route";
import { AreaKnowledgePanel } from "@/components/assets/AreaKnowledgePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const get = () => GET(new NextRequest("http://x/api/area/knowledge-status?orgId=o1&unitCode=20", { headers: { authorization: "Bearer t" } }));

describe("AREA-8 — the route counts the shelf's flow drawings read for flows", () => {
  beforeEach(() => {
    st.failAudit = false;
    st.landscape = { libraries: new Map(), folders: new Map(), teamSupervisors: new Map() };
    st.rows = {
      codebook_entries: [{ org_id: "o1", kind: "unit", code: "20", label: "Crude", meta: { knowledgeLibraryId: "kl1" } }],
      knowledge_libraries: [{ id: "kl1", org_id: "o1", name: "Crude shelf" }],
      documents: [],
      knowledge_sources: [],
      knowledge_documents: [
        { id: "k1", org_id: "o1", library_id: "kl1", name: "PFD", status: "ready", source_document_id: null },
        { id: "k2", org_id: "o1", library_id: "kl1", name: "P&ID 1", status: "ready", source_document_id: null },
        { id: "k3", org_id: "o1", library_id: "kl1", name: "P&ID 2", status: "ready", source_document_id: null },
        { id: "k4", org_id: "o1", library_id: "kl1", name: "Indexing", status: "pending", source_document_id: null },
      ],
      audit_logs: [
        { id: "l1", org_id: "o1", action: "FLOWS_READ", resource_id: "k2" },
        { id: "l2", org_id: "o1", action: "FLOWS_READ", resource_id: "k4" },
        { id: "l3", org_id: "o1", action: "DOCUMENT_VIEWED", resource_id: "k3" },
      ],
      process_flows: [{ id: "f1", org_id: "o1", source_document_id: "k1" }, { id: "f2", org_id: "o1", source_document_id: null }],
    };
  });

  it("2 of the 3 flow drawings were read (one by a flow read off it, one by a read that found nothing); an indexing one is not counted", async () => {
    const json = await (await get()).json();
    expect(json.flowReads).toEqual({ readable: 3, read: 2, otherDocs: 0 });
  });

  it("a shelf of 12 PFDs beside 300 data sheets: the 12 PFDs are the denominator — the data sheets are said apart, never owed a paid read", async () => {
    st.rows.knowledge_documents = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, org_id: "o1", library_id: "kl1", name: `Crude PFD-${i}`, status: "ready", source_document_id: null })),
      ...Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, org_id: "o1", library_id: "kl1", name: `Data sheet V-${i}`, status: "ready", source_document_id: null })),
    ];
    st.rows.audit_logs = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, org_id: "o1", action: "FLOWS_READ", resource_id: `p${i}` }));
    st.rows.process_flows = [];
    const json = await (await get()).json();
    expect(json.flowReads).toEqual({ readable: 12, read: 12, otherDocs: 300 });
  });

  it("a mirror named only by its number counts as a flow drawing when doc control files it under a PFD folder; a document already read always counts", async () => {
    st.landscape.libraries.set("dl1", { name: "Drawings" });
    st.landscape.folders.set("fP", { name: "Crude", library_id: "dl1", parent_id: null, path_names: ["PFDs", "Crude"] });
    st.landscape.folders.set("fM", { name: "Crude", library_id: "dl1", parent_id: null, path_names: ["Manuals", "Crude"] });
    st.rows.documents = [
      { id: "dc7", org_id: "o1", collection_id: "fP", library_id: "dl1" },
      { id: "dc8", org_id: "o1", collection_id: "fM", library_id: "dl1" },
    ];
    st.rows.knowledge_documents.push(
      { id: "k5", org_id: "o1", library_id: "kl1", name: "Data sheet V-101", status: "ready", source_document_id: null },
      { id: "k6", org_id: "o1", library_id: "kl1", name: "Operating manual", status: "ready", source_document_id: null },
      { id: "k7", org_id: "o1", library_id: "kl1", name: "20-XX-001 Rev 2", status: "ready", source_document_id: "dc7" },
      { id: "k8", org_id: "o1", library_id: "kl1", name: "20-MN-004", status: "ready", source_document_id: "dc8" },
    );
    st.rows.audit_logs.push({ id: "l9", org_id: "o1", action: "FLOWS_READ", resource_id: "k6" });
    const json = await (await get()).json();
    // k1 k2 k3 (named), k6 (read), k7 (PFDs folder) — k5 and k8 are other documents
    expect(json.flowReads).toEqual({ readable: 5, read: 3, otherDocs: 2 });
  });

  it("P&IDs filed under 'Piping & Instrumentation Diagrams' with numbered titles are in the denominator: 3 PFDs read do NOT tick step 3", async () => {
    st.landscape.libraries.set("dl1", { name: "Drawings" });
    st.landscape.folders.set("fPID", { name: "Piping & Instrumentation Diagrams", library_id: "dl1", parent_id: null, path_names: ["Piping & Instrumentation Diagrams"] });
    st.rows.documents = Array.from({ length: 4 }, (_, i) => ({ id: `dcp${i}`, org_id: "o1", collection_id: "fPID", library_id: "dl1" }));
    st.rows.knowledge_documents = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `pfd${i}`, org_id: "o1", library_id: "kl1", name: `PFD-${i}`, status: "ready", source_document_id: null })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `pid${i}`, org_id: "o1", library_id: "kl1", name: `1001-P-00${i}`, status: "ready", source_document_id: `dcp${i}` })),
    ];
    st.rows.audit_logs = Array.from({ length: 3 }, (_, i) => ({ id: `l${i}`, org_id: "o1", action: "FLOWS_READ", resource_id: `pfd${i}` }));
    st.rows.process_flows = [];
    const json = await (await get()).json();
    expect(json.flowReads).toEqual({ readable: 7, read: 3, otherDocs: 0 });
  });

  it("the lexicon: the spelled-out P&ID counts; a 'PID controller' data sheet does not", async () => {
    st.rows.knowledge_documents = [
      { id: "s1", org_id: "o1", library_id: "kl1", name: "Piping and Instrumentation Diagram — Crude overhead", status: "ready", source_document_id: null },
      { id: "s2", org_id: "o1", library_id: "kl1", name: "Piping & Instrumentation Diagrams (book 2)", status: "ready", source_document_id: null },
      { id: "s3", org_id: "o1", library_id: "kl1", name: "PID controller datasheet TIC-101", status: "ready", source_document_id: null },
      { id: "s4", org_id: "o1", library_id: "kl1", name: "PID loop tuning guide", status: "ready", source_document_id: null },
      { id: "s5", org_id: "o1", library_id: "kl1", name: "PID-1001 Crude", status: "ready", source_document_id: null },
    ];
    st.rows.audit_logs = []; st.rows.process_flows = [];
    const json = await (await get()).json();
    expect(json.flowReads).toEqual({ readable: 3, read: 0, otherDocs: 2 });
  });

  it("a mirror titled only by its number, filed in a folder that says nothing, counts when its number decodes to a P&ID drawing type", async () => {
    st.landscape.libraries.set("dl1", { name: "Drawings" });
    st.landscape.folders.set("fX", { name: "Crude", library_id: "dl1", parent_id: null, path_names: ["Area 20", "Crude"] });
    st.rows.codebook_entries.push(
      { id: "dt2", org_id: "o1", kind: "drawing_type", code: "02", label: "P&ID", meta: {}, sort: 0 },
      { id: "dt7", org_id: "o1", kind: "drawing_type", code: "07", label: "Isometric", meta: {}, sort: 0 },
    );
    st.rows.codebook_config = [{ org_id: "o1", drawing_number: { segments: [{ kind: "unit", digits: 2 }, { kind: "drawing_type", digits: 2 }, { kind: "iterable" }] } }];
    st.rows.documents = [
      { id: "dn1", org_id: "o1", collection_id: "fX", library_id: "dl1", document_number: "20-02-001" },
      { id: "dn2", org_id: "o1", collection_id: "fX", library_id: "dl1", document_number: "20-07-001" },
    ];
    st.rows.knowledge_documents = [
      { id: "n1", org_id: "o1", library_id: "kl1", name: "20-02-001", status: "ready", source_document_id: "dn1" },
      { id: "n2", org_id: "o1", library_id: "kl1", name: "20-07-001", status: "ready", source_document_id: "dn2" },
    ];
    st.rows.audit_logs = []; st.rows.process_flows = [];
    const json = await (await get()).json();
    expect(json.flowReads).toEqual({ readable: 1, read: 0, otherDocs: 1 });
  });

  it("a read record that cannot be counted is null — 'could not be counted', never 0 of 3", async () => {
    st.failAudit = true;
    expect((await (await get()).json()).flowReads).toBeNull();
  });

  it("an unbound area has no shelf to measure: null", async () => {
    st.rows.codebook_entries[0].meta = {};
    expect((await (await get()).json()).flowReads).toBeNull();
  });
});

describe("AREA-8 — the panel ticks coverage, not presence", () => {
  let host: HTMLDivElement;
  let root: Root;
  const status = (over: Row) => ({
    unit: { code: "20", label: "Crude" },
    boundLibrary: { id: "kl1", name: "Crude shelf" },
    knowledgeLibraries: [{ id: "kl1", name: "Crude shelf" }],
    sources: [{ id: "s1", type: "folder", sourceId: "f1", name: "PFDs / Crude" }],
    counts: { ready: 40, pending: 0 },
    drift: { deadSources: [], movedOut: [], movedOutTotal: 0, newMatches: [] },
    suggestions: [],
    flowReads: { readable: 40, read: 3, otherDocs: 0 },
    canManage: true,
    ...over,
  });
  const mount = async (s: Row, assetIds = ["a1", "a2"]) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(s), { status: 200 })) as typeof fetch;
    await act(async () => {
      root.render(React.createElement(AreaKnowledgePanel, { orgId: "o1", userId: "u1", userName: "u", unit: { code: "20", label: "Crude" }, unitAssetIds: assetIds }));
    });
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  };
  const step = (n: number) => {
    const titles = ["File this area's drawings in Documents", "Connect the area's knowledge", "Deep read the drawings", "Link equipment files to assets"];
    const el = [...host.querySelectorAll("span")].find((x) => x.textContent === titles[n - 1])!;
    return el.closest("div.flex.items-start") as HTMLElement;
  };
  beforeEach(() => {
    cl.linksError = null; cl.linksThrow = false;
    cl.links = [{ document_id: "d1", asset_id: "a1" }];
    cl.flows = [{ status: "confirmed", from_kind: "unit", from_ref: "20", to_kind: "unit", to_ref: "25" }];
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("one flow and one linked document no longer tick steps 3 and 4: '3 of 40 read' and '1 of 2 equipment' are in progress", async () => {
    await mount(status({}));
    expect(step(3).textContent).toContain("3 of 40 flow drawings (PFDs, P&IDs, block diagrams) read for flows");
    expect(step(3).textContent).toContain("in progress");
    expect(step(4).textContent).toContain("1 of 2 equipment items in this area has a linked document");
    expect(step(4).textContent).toContain("in progress");
    expect(step(1).querySelector("svg")).not.toBeNull(); // bound shelf with drawings: step 1 done (the tick)
  });

  it("every drawing read and every item linked: both ticked", async () => {
    cl.links = [{ document_id: "d1", asset_id: "a1" }, { document_id: "d2", asset_id: "a2" }];
    await mount(status({ flowReads: { readable: 40, read: 40, otherDocs: 300 } }));
    expect(step(3).textContent).not.toContain("in progress");
    expect(step(4).textContent).not.toContain("in progress");
    expect(step(3).querySelector("span.bg-emerald-500")).not.toBeNull();
    expect(step(4).querySelector("span.bg-emerald-500")).not.toBeNull();
    // the data sheets beside the drawings are said, and do not hold the tick back
    expect(step(3).textContent).toContain("300 other documents on the shelf (data sheets, manuals…) not counted");
  });

  it("a shelf with no flow drawing by title or folder says so — a todo, never a tick on 0 of 0", async () => {
    await mount(status({ flowReads: { readable: 0, read: 0, otherDocs: 25 } }));
    expect(step(3).textContent).toContain("no PFD, P&ID or block diagram on the shelf by title or folder");
    expect(step(3).querySelector("span.bg-emerald-500")).toBeNull();
    expect(step(3).textContent).not.toContain("in progress");
  });

  it("unbound: a folder named like the area is a SUGGESTION, never a ticked step 1", async () => {
    await mount(status({
      boundLibrary: null, sources: [], flowReads: null,
      suggestions: [{ id: "f9", name: "Crude", libraryName: "Memos", pathNames: ["Crude"], docCount: 1 }],
    }));
    expect(step(1).querySelector("span.bg-emerald-500")).toBeNull();
    expect(step(1).textContent).toContain("Suggested: Memos / Crude (1 doc)");
    expect(step(3).textContent).toContain("connect the area's knowledge to measure the deep read");
  });

  it("regression pin: a document-links read that succeeds with no links still says '0 of 2' — a todo, as before", async () => {
    cl.links = [];
    await mount(status({}));
    expect(step(4).textContent).toContain("0 of 2 equipment items in this area have a linked document");
    expect(step(4).textContent).not.toContain("in progress");
    expect(step(4).textContent).not.toContain("not counted");
    expect(step(4).querySelector("span.bg-emerald-500")).toBeNull();
    expect(step(3).textContent).toContain("0 linked documents");
  });

  for (const [how, fail] of [
    ["returns an error", () => { cl.linksError = { message: "permission denied" }; }],
    ["throws", () => { cl.linksThrow = true; }],
  ] as const) {
    it(`a document-links read that ${how} says 'could not be counted' — never '0 of 2'; step 4 is neither done, in progress nor todo`, async () => {
      fail();
      await mount(status({}));
      const s4 = step(4).textContent ?? "";
      expect(s4).toContain("Equipment with a linked document could not be counted");
      expect(s4).not.toMatch(/\d+ of 2 equipment/);
      expect(s4).toContain("not counted"); // its own badge — not a todo's bare number
      expect(s4).not.toContain("in progress");
      expect(step(4).querySelector("span.bg-emerald-500")).toBeNull();
      expect(step(4).querySelector(".animate-spin")).toBeNull(); // settled, not loading forever
      // the same read feeds step 3's linked-document count
      const s3 = step(3).textContent ?? "";
      expect(s3).toContain("linked documents could not be counted");
      expect(s3).not.toMatch(/· 0 linked documents?/);
    });
  }
});
