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
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let op = "select";
    let inIds: string[] | null = null;
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          let res: unknown;
          if (table === "process_flows" && op === "select") res = { data: db.flows, error: null };
          else if (table === "process_flows" && op === "update") res = { data: db.updateReturns, error: null };
          else if (table === "process_flows" && op === "delete") res = { data: [{ id: "x" }], error: null };
          else if (table === "assets") res = { data: db.assets.filter((a) => !inIds || inIds.includes(String(a.id))), error: null };
          else res = { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          db.calls.push({ table, method: prop, args });
          if (prop === "update" || prop === "delete") op = prop;
          if (prop === "in") inIds = args[1] as string[];
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
  db.calls = [];
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
