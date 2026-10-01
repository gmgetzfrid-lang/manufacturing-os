// @vitest-environment jsdom
//
// intelligence Round G (I-09) — the unit hub's FlowPanel and the plant-wide
// FlowReviewQueue, as RENDERED.
//
// Regression pins (the user's top rule): a confirmed flow is displayed on
// the unit panel as before, and a controller sees the reader and the
// decision controls. Then: controls follow the controller tier the server
// enforces (FLOW-3), a non-controller sees who decides and may withdraw
// their own proposal, an end naming deleted equipment is shown as gone with
// a remove button (IRLS-7 / FLOW-6), low-confidence proposals are apart
// (PR-7), a refused decision is said (FLOW-3), proposals elsewhere are
// counted and linked (FLOW-1), the graph pivot carries the unit's scope
// (AREA-6), and the plant-wide list shows a proposal between equipment no
// operating area holds (FLOW-1).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  flows: [] as Row[],
  assets: [] as Row[],
  updateReturns: [] as Row[] | null,
  flowsError: null as null | { message: string },
  assetsError: null as null | { message: string },
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let op = "select";
    let inIds: string[] | null = null;
    // eq / neq on a read are honoured, so a status filter is the database's
    const filters: Array<(r: Row) => boolean> = [];
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          let res: unknown;
          if (table === "process_flows" && op === "select") {
            res = db.flowsError ? { data: null, error: db.flowsError } : { data: db.flows.filter((r) => filters.every((f) => f(r))), error: null };
          }
          else if (table === "process_flows" && op === "update") res = { data: db.updateReturns, error: null };
          else if (table === "process_flows" && op === "delete") res = { data: [{ id: "x" }], error: null };
          else if (table === "assets") res = db.assetsError ? { data: null, error: db.assetsError } : { data: db.assets.filter((a) => !inIds || inIds.includes(String(a.id))), error: null };
          else res = { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          db.calls.push({ table, method: prop, args });
          if (prop === "update" || prop === "delete") op = prop;
          if (prop === "in") inIds = args[1] as string[];
          if (op === "select" && prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
          if (op === "select" && prop === "neq") filters.push((r) => r[String(args[0])] !== args[1]);
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true), appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock("@/lib/knowledge", () => ({ syncKnowledgeSources: vi.fn(), addKnowledgeSources: vi.fn(), acceptAiAgreement: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import { FlowPanel, FlowReviewQueue, unitGraphHref } from "@/components/assets/UnitOpsPanels";
import { FLOW_DECIDE_REFUSED } from "@/lib/processFlows";
import type { Asset } from "@/lib/assets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const V = "aaaaaaaa-0000-0000-0000-000000000001";
const E = "aaaaaaaa-0000-0000-0000-000000000002";
const GONE = "aaaaaaaa-0000-0000-0000-0000000000ff";
const LOOSE1 = "aaaaaaaa-0000-0000-0000-000000000011";
const LOOSE2 = "aaaaaaaa-0000-0000-0000-000000000012";
const unitAssets = [{ id: V, tag: "V-101", unit_code: "20" }, { id: E, tag: "E-201", unit_code: "20" }] as unknown as Asset[];
const flow = (over: Row): Row => ({
  id: "f", org_id: "o1", from_kind: "asset", from_ref: V, to_kind: "asset", to_ref: E, label: null,
  status: "confirmed", origin: "manual", source_document_id: null, source_page: null, evidence: null,
  created_by: "admin1", created_by_name: "admin@x.io", created_at: "2026-09-01T00:00:00Z", ...over,
});

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const render = async (el: React.ReactElement) => {
  await act(async () => { root.render(el); });
  await flush();
};
const panel = (isController: boolean, userId = "admin1") =>
  React.createElement(FlowPanel, { orgId: "o1", userId, isController, unitCode: "20", unitAssets });
const buttons = () => [...host.querySelectorAll("button")];

beforeEach(() => {
  db.calls = []; db.flowsError = null; db.assetsError = null;
  db.assets = [{ id: LOOSE1, tag: "P-900", archived: false, unit_code: null }, { id: LOOSE2, tag: "T-901", archived: false, unit_code: null }];
  db.updateReturns = [{ id: "x" }];
  db.flows = [
    flow({ id: "c1", status: "confirmed", label: "crude feed" }),
    flow({ id: "p1", status: "proposed", origin: "ai", from_ref: E, to_ref: V, evidence: { docName: "PFD-1", confidence: 0.9 }, source_page: 2 }),
  ];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("regression pins", () => {
  it("a confirmed flow is displayed on the unit panel; a controller sees the reader and the decision controls", async () => {
    await render(panel(true));
    const text = host.textContent ?? "";
    expect(text).toContain("1 confirmed · 1 proposed");
    expect(text).toContain("V-101");
    expect(text).toContain("E-201");
    expect(text).toContain("“crude feed”");
    expect(buttons().some((b) => b.textContent?.includes("Read flows from a document"))).toBe(true);
    expect(host.querySelector('button[title="Confirm — draw it on the graph"]')).not.toBeNull();
    expect(text).toContain("90% sure");
    expect(text).toContain("from PFD-1 p.2");
  });
});

describe("FLOW-3 — controls follow the controller tier", () => {
  it("a non-controller sees no reader and no decision controls — it says who decides — and may withdraw their own proposal", async () => {
    db.flows.push(flow({ id: "p2", status: "proposed", origin: "manual", from_ref: V, to_kind: "unit", to_ref: "20", created_by: "sup1", created_by_name: "sup@x.io" }));
    await render(panel(false, "sup1"));
    const text = host.textContent ?? "";
    expect(buttons().some((b) => b.textContent?.includes("Read flows from a document"))).toBe(false);
    expect(host.querySelector('button[title="Confirm — draw it on the graph"]')).toBeNull();
    expect(text).toContain("a document controller decides");
    expect(text).toContain("drawn by sup@x.io");
    expect(buttons().filter((b) => b.textContent === "Withdraw")).toHaveLength(1);
    // no remove control on the confirmed chips either
    expect(host.querySelector('button[title="Remove this flow"]')).toBeNull();
  });

  it("a decision the database filtered out is said, never a silent no-op", async () => {
    db.updateReturns = [];
    await render(panel(true));
    const confirm = host.querySelector('button[title="Confirm — draw it on the graph"]') as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    await flush();
    expect(host.textContent).toContain(FLOW_DECIDE_REFUSED);
  });
});

describe("IRLS-7 / FLOW-6 — an end naming deleted equipment is shown as gone", () => {
  it("'equipment no longer exists', marked, with a remove button for a controller (no confirm on a proposal to nothing)", async () => {
    db.flows = [
      flow({ id: "c9", status: "confirmed", to_ref: GONE }),
      flow({ id: "p9", status: "proposed", origin: "ai", from_ref: GONE, to_ref: V, evidence: { confidence: 0.9 } }),
    ];
    db.assets = [];
    await render(panel(true));
    expect(host.textContent).toContain("equipment no longer exists");
    expect(host.querySelector('button[title="This flow names equipment that no longer exists — remove it"]')).not.toBeNull();
    expect(host.querySelector('button[title="Confirm — draw it on the graph"]')).toBeNull();
  });
});

describe("PR-7 — low confidence apart", () => {
  it("an AI proposal with no confidence sits in the low-confidence bucket, labelled unknown", async () => {
    db.flows = [flow({ id: "p3", status: "proposed", origin: "ai", evidence: { docName: "PFD-1" } })];
    await render(panel(true));
    expect(host.textContent).toContain("Low confidence — the reader was unsure, or gave no confidence");
    expect(host.textContent).toContain("confidence unknown");
  });
});

describe("FLOW-1 / AREA-6 — elsewhere, and the pivot", () => {
  it("proposals touching nothing in this unit are counted with a link to the plant-wide list", async () => {
    db.flows.push(flow({ id: "p4", status: "proposed", origin: "ai", from_ref: LOOSE1, to_ref: LOOSE2, evidence: { confidence: 0.8 } }));
    await render(panel(true));
    expect(host.textContent).toContain("1 more proposal elsewhere in the plant");
    expect(host.querySelector('a[href="/admin/assets#plant-flow-review"]')).not.toBeNull();
  });

  it("the graph link carries the unit's scope key and focuses its node", async () => {
    expect(unitGraphHref("20")).toBe("/graph?scope=unit%3A20&focus=cbunit%3A20");
    await render(panel(true));
    expect([...host.querySelectorAll("a")].map((x) => x.getAttribute("href"))).toContain("/graph?scope=unit%3A20&focus=cbunit%3A20");
  });

  it("the plant-wide list shows a proposal between equipment no operating area holds", async () => {
    db.flows = [flow({ id: "p5", status: "proposed", origin: "ai", from_ref: LOOSE1, to_ref: LOOSE2, evidence: { confidence: 0.8 } })];
    await render(React.createElement(FlowReviewQueue, { orgId: "o1", userId: "admin1", isController: true }));
    const text = host.textContent ?? "";
    expect(text).toContain("Proposed flows across the plant");
    expect(text).toContain("P-900");
    expect(text).toContain("T-901");
    expect(text).toContain("no operating area");
    expect(host.querySelector('button[title="Confirm — draw it on the graph"]')).not.toBeNull();
  });

  it("the operating-areas page gives the panel the unit's FULL equipment and the controller tier, and mounts the plant-wide list", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/assets/page.tsx"), "utf8");
    expect(page).toContain("isController={isController} unitCode={unitFilter} unitAssets={areaAssets}");
    expect(page).not.toContain("unitAssets={filtered}");
    expect(page).toMatch(/<FlowReviewQueue orgId=\{activeOrgId\} userId=\{uid\} userName=\{userEmail \?\? undefined\} isController=\{isController\} \/>/);
    expect(page).toContain("const flows = await countAssetFlows(orgId, asset.id);");
  });
});

describe("FLOW-1 — the plant-wide review: proposals only, a failed read said, an unread registry never guessed", () => {
  const queue = () => React.createElement(FlowReviewQueue, { orgId: "o1", userId: "admin1", isController: true });

  it("reads only the proposals, filtered in the database — a confirmed flow is never loaded into the queue", async () => {
    db.flows = [
      flow({ id: "p5", status: "proposed", origin: "ai", from_ref: LOOSE1, to_ref: LOOSE2, evidence: { confidence: 0.8 } }),
      flow({ id: "c5", status: "confirmed" }),
    ];
    await render(queue());
    expect(db.calls.some((c) => c.table === "process_flows" && c.method === "eq" && c.args[0] === "status" && c.args[1] === "proposed")).toBe(true);
    expect(db.calls.some((c) => c.table === "process_flows" && c.method === "neq")).toBe(false);
    expect(host.textContent).toContain("1 awaiting a decision");
  });

  it("a list read that fails is SAID, even with no rows — never a vanished queue a controller reads as 'nothing to review'", async () => {
    db.flowsError = { message: "network down" };
    await render(queue());
    expect(host.textContent).toContain("Proposed flows across the plant");
    expect(host.textContent).toContain("The proposed flows could not be read: network down");
  });

  it("nothing proposed and nothing failed: the queue stays out of the way", async () => {
    db.flows = [flow({ id: "c5", status: "confirmed" })];
    await render(queue());
    expect(host.textContent).toBe("");
  });

  it("an unreadable registry: each asset end is 'unit not checked' (never 'no operating area'), and the unfiled filter is off", async () => {
    db.flows = [
      flow({ id: "p5", status: "proposed", origin: "ai", from_ref: LOOSE1, to_ref: LOOSE2, evidence: { confidence: 0.8 } }),
      flow({ id: "p6", status: "proposed", origin: "ai", from_kind: "unit", from_ref: "20", to_ref: V, evidence: { confidence: 0.8 } }),
    ];
    db.assetsError = { message: "registry down" };
    await render(queue());
    const text = host.textContent ?? "";
    expect(text).not.toContain("no operating area\u00a0");
    expect([...host.querySelectorAll("span")].filter((x) => x.textContent === "no operating area")).toHaveLength(0);
    expect([...host.querySelectorAll("span")].filter((x) => x.textContent === "unit not checked")).toHaveLength(1);
    expect([...host.querySelectorAll("span")].filter((x) => x.textContent === "Unit 20 · equipment's unit not checked")).toHaveLength(1);
    expect(text).toContain("The equipment registry could not be read");
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    // both proposals stay listed — the filter cannot hide them on a guess
    expect(text).toContain("2 awaiting a decision");
    expect(host.querySelectorAll('button[title="Confirm — draw it on the graph"]')).toHaveLength(2);
  });

  it("a readable registry keeps the filter: only proposals touching no operating area", async () => {
    db.flows = [
      flow({ id: "p5", status: "proposed", origin: "ai", from_ref: LOOSE1, to_ref: LOOSE2, evidence: { confidence: 0.8 } }),
      flow({ id: "p6", status: "proposed", origin: "ai", from_kind: "unit", from_ref: "20", to_ref: LOOSE1, evidence: { confidence: 0.8 } }),
    ];
    await render(queue());
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(false);
    await act(async () => { box.click(); });
    await flush();
    expect(host.querySelectorAll('button[title="Confirm — draw it on the graph"]')).toHaveLength(1);
    expect([...host.querySelectorAll("span")].some((x) => x.textContent === "no operating area")).toBe(true);
  });
});

describe("AREA-5 / FLOW-1 — the Read-flows modal: the area's shelf when it holds documents, and proposals outside the unit linked", () => {
  const browse = (over: Row = {}) => ({
    tree: [{
      id: "lib1", name: "PFDs", watched: true, totalDocs: 1, docs: [],
      folders: [{ id: "f1", name: "Crude", watched: true, totalDocs: 1, folders: [], docs: [
        { dcDocId: "d1", name: "PFD-100 Crude", state: "pending_sync", kdocId: null, pageCount: null },
      ] }],
    }],
    uploads: [],
    knowledgeLibraries: [{ id: "kl1", name: "Crude shelf" }],
    areaKnowledgeLibrary: { id: "kl1", name: "Crude shelf" },
    canSync: true,
    ...over,
  });
  let fetchMock: ReturnType<typeof vi.fn>;
  const openModal = async (model: Row, readReply?: Row) => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/flows/browse")) return new Response(JSON.stringify(model), { status: 200 });
      return new Response(JSON.stringify(readReply ?? {}), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await render(panel(true));
    const open = buttons().find((b) => b.textContent?.includes("Read flows from a document"))!;
    await act(async () => { open.click(); });
    await flush();
  };
  const select = () => document.body.querySelector("select") as HTMLSelectElement;

  it("a bound area whose shelf has not synced opens on ALL libraries: the area's PFD is on screen, 'Not synced yet', with its Sync button", async () => {
    await openModal(browse());
    expect(select().value).toBe("");
    expect(document.body.textContent).toContain("PFD-100 Crude");
    expect(document.body.textContent).not.toContain("No documents yet");
    expect([...document.body.querySelectorAll("button")].some((b) => b.textContent === "Sync now")).toBe(true);
  });

  it("an area shelf that holds mirrors opens on it (regression pin: AREA-5's default)", async () => {
    const model = browse();
    (model.tree as Array<{ folders: Array<{ docs: Row[] }> }>)[0].folders[0].docs = [
      { dcDocId: "d1", name: "PFD-100 Crude", state: "ready", kdocId: "kd1", pageCount: 3, kLibraryId: "kl1" },
    ];
    await openModal(model);
    expect(select().value).toBe("__area");
    expect(document.body.textContent).toContain("PFD-100 Crude");
  });

  it("the area filter chosen on an empty shelf names itself and offers every library — never 'No documents yet'", async () => {
    await openModal(browse());
    await act(async () => { select().value = "__area"; select().dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(document.body.textContent).toContain("Nothing in this area's library yet (Crude shelf)");
    expect(document.body.textContent).not.toContain("No documents yet");
    const all = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Show all document libraries")!;
    await act(async () => { all.click(); });
    await flush();
    expect(select().value).toBe("");
    expect(document.body.textContent).toContain("PFD-100 Crude");
  });

  it("a read whose proposals land outside the unit LINKS them to where they are decided", async () => {
    const model = browse();
    (model.tree as Array<{ folders: Array<{ docs: Row[] }> }>)[0].folders[0].docs = [
      { dcDocId: "d1", name: "PFD-100 Crude", state: "ready", kdocId: "kd1", pageCount: 3, kLibraryId: "kl1" },
    ];
    await openModal(model, { proposed: 2, outsideUnit: 1, note: "Read pages 1–3 of 3. 2 flows proposed." });
    const read = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("PFD-100 Crude"))!;
    await act(async () => { read.click(); });
    await flush();
    expect(host.textContent).toContain("Read pages 1–3 of 3. 2 flows proposed.");
    expect(host.textContent).toContain("1 of the proposals is outside this unit");
    const link = [...host.querySelectorAll("a")].find((x) => x.textContent === "decide it under Proposed flows across the plant");
    expect(link?.getAttribute("href")).toBe("/admin/assets#plant-flow-review");
    const readCall = fetchMock.mock.calls.find((c) => c[0] === "/api/flows/read")!;
    expect(JSON.parse(String((readCall[1] as RequestInit).body))).toMatchObject({ knowledgeDocumentId: "kd1", unitCode: "20" });
  });
});
