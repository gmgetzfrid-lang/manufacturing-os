// @vitest-environment jsdom
//
// intelligence Round G (I-09) — AREA-8: the area checklist carries COVERAGE,
// not presence. The knowledge-status route counts the area shelf's readable
// drawings read for flows (a FLOWS_READ record — a read, flows found or not —
// or a flow read off it); the panel ticks step 3 only when every one was
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
  loadDcLandscape: vi.fn(async () => ({ libraries: new Map(), folders: new Map(), teamSupervisors: new Map() })),
  containerReadable: () => true,
}));
// The panel's client reads (flows, document links, plot plans).
const cl = vi.hoisted(() => ({ links: [] as Row[], flows: [] as Row[] }));
vi.mock("@/lib/supabase", () => {
  const c = (table: string): unknown => {
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
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

describe("AREA-8 — the route counts the shelf's drawings read for flows", () => {
  beforeEach(() => {
    st.failAudit = false;
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

  it("2 of the 3 readable drawings were read (one by a flow read off it, one by a read that found nothing); an indexing one is not counted", async () => {
    const json = await (await get()).json();
    expect(json.flowReads).toEqual({ readable: 3, read: 2 });
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
    flowReads: { readable: 40, read: 3 },
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
    cl.links = [{ document_id: "d1", asset_id: "a1" }];
    cl.flows = [{ status: "confirmed", from_kind: "unit", from_ref: "20", to_kind: "unit", to_ref: "25" }];
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("one flow and one linked document no longer tick steps 3 and 4: '3 of 40 read' and '1 of 2 equipment' are in progress", async () => {
    await mount(status({}));
    expect(step(3).textContent).toContain("3 of 40 readable drawings read for flows");
    expect(step(3).textContent).toContain("in progress");
    expect(step(4).textContent).toContain("1 of 2 equipment items in this area has a linked document");
    expect(step(4).textContent).toContain("in progress");
    expect(step(1).querySelector("svg")).not.toBeNull(); // bound shelf with drawings: step 1 done (the tick)
  });

  it("every drawing read and every item linked: both ticked", async () => {
    cl.links = [{ document_id: "d1", asset_id: "a1" }, { document_id: "d2", asset_id: "a2" }];
    await mount(status({ flowReads: { readable: 40, read: 40 } }));
    expect(step(3).textContent).not.toContain("in progress");
    expect(step(4).textContent).not.toContain("in progress");
    expect(step(3).querySelector("span.bg-emerald-500")).not.toBeNull();
    expect(step(4).querySelector("span.bg-emerald-500")).not.toBeNull();
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
});
