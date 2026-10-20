// @vitest-environment jsdom
//
// intelligence Round G I-32 — AREA-12, RENDERED: the graph shape wizard's
// document ↔ equipment link on a pair the equipment sweep already relates.
// DEC-90 ruling (3): on 23505 the wizard adopts the existing row and says so;
// any other refusal is said, never swallowed. Ruling (4): every flow that
// works today works the same (pinned below).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const sb = vi.hoisted(() => ({
  insertErr: {} as Record<string, { code?: string; message: string } | null>,
  held: { data: { source: "drawing" } as unknown, error: null as null | { message: string } },
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  heldReads: 0,
  adopt: { status: 200, body: { ok: true, adopted: true, already: null } as Record<string, unknown> },
}));

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => { sb.inserts.push({ table, row }); return { error: sb.insertErr[table] ?? null }; },
      select: () => {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          maybeSingle: async () => { sb.heldReads += 1; return sb.held; },
        };
        return chain;
      },
    }),
  },
}));

import GraphShapeWizard from "@/components/graph/GraphShapeWizard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
  if (url === "/api/graph/shape") {
    return {
      ok: true, status: 200,
      json: async () => ({
        candidates: [
          { ref: "d1", type: "document", id: "D1", label: "PID-1", title: "Charge" },
          { ref: "a1", type: "asset", id: "A1", label: "P-101", title: "Charge pump" },
          { ref: "d2", type: "document", id: "D2", label: "DS-1", title: "Datasheet" },
        ],
        suggestions: [
          { a: "d1", b: "a1", label: "Shows the pump", reason: "The answer names P-101 on PID-1.", confidence: 0.9, aiAssisted: true },
          { a: "d1", b: "d2", label: "Datasheet for", reason: "The answer cites both.", confidence: 0.9, aiAssisted: true },
        ],
      }),
    };
  }
  if (url === "/api/equipment-bridge") {
    void init;
    return { ok: sb.adopt.status < 400, status: sb.adopt.status, json: async () => sb.adopt.body };
  }
  throw new Error(`unexpected fetch ${url}`);
});

let container: HTMLDivElement;
let root: Root;
async function flush() { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function renderAndWrite() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(GraphShapeWizard, {
      orgId: "o1", userId: "u1", userName: "Ann", question: "What protects the pump?", answer: "PSV-1 on PID-1 protects P-101.",
      citedKnowledgeDocIds: [], onClose: () => undefined,
    }));
  });
  await flush();
  const write = [...container.querySelectorAll("button")].find((b) => /^Write \d+ connection/.test((b.textContent ?? "").trim()))!;
  await act(async () => { write.click(); });
  await flush();
}
const text = () => container.textContent ?? "";
const bridgeCalls = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/equipment-bridge");

beforeEach(() => {
  sb.insertErr = {};
  sb.held = { data: { source: "drawing" }, error: null };
  sb.inserts = [];
  sb.heldReads = 0;
  sb.adopt = { status: 200, body: { ok: true, adopted: true, already: null } };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const DUP = { code: "23505", message: "duplicate key value violates unique constraint \"document_assets_document_id_asset_id_key\"" };

describe("AREA-12 — the shape wizard adopts a drawing-held pair on 23505", () => {
  it("REGRESSION: a new pair is written as a manual link and counted, no adopt — exactly as before", async () => {
    await renderAndWrite();
    expect(sb.inserts.find((i) => i.table === "document_assets")?.row).toEqual({ org_id: "o1", document_id: "D1", asset_id: "A1", tag_text: "P-101", source: "manual" });
    expect(bridgeCalls()).toHaveLength(0);
    expect(sb.heldReads).toBe(0);
    expect(text()).toContain("2 connections written to the graph");
    expect(container.querySelector('[data-testid="shape-adopted"]')).toBeNull();
  });

  it("reproduction → fix: the pair the sweep read off the drawing (23505, a 'drawing' row) is ADOPTED through the Bridge, counted, and the wizard says so", async () => {
    sb.insertErr.document_assets = DUP;
    await renderAndWrite();
    expect(bridgeCalls()).toHaveLength(1);
    const call = bridgeCalls()[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(call[1].method).toBe("POST");
    expect(call[1].headers.Authorization).toBe("Bearer t");
    expect(JSON.parse(call[1].body)).toEqual({ action: "adopt", orgId: "o1", documentId: "D1", assetId: "A1" });
    expect(text()).toContain("2 connections written to the graph");
    expect(container.querySelector('[data-testid="shape-adopted"]')!.textContent).toMatch(/One of them was already read off the drawing by the equipment sweep — that link is now yours, so dismissing the sweep's reading will not remove it\./);
    expect(text()).not.toMatch(/Some links failed/);
  });

  it("a refused adopt is SAID and the link is not counted", async () => {
    sb.insertErr.document_assets = DUP;
    sb.adopt = { status: 403, body: { error: "You cannot read this document, so you cannot link it." } };
    await renderAndWrite();
    expect(text()).toContain("Some links failed: PID-1 ↔ P-101: You cannot read this document, so you cannot link it.");
    expect(text()).toContain("1 connection written to the graph");
    expect(container.querySelector('[data-testid="shape-adopted"]')).toBeNull();
  });

  it("an adopt that finds no row to make yours is said, not counted", async () => {
    sb.insertErr.document_assets = DUP;
    sb.adopt = { status: 200, body: { ok: true, adopted: false, already: null } };
    await renderAndWrite();
    expect(text()).toMatch(/Some links failed: PID-1 ↔ P-101: The existing link could not be found to make it yours/);
    expect(text()).toContain("1 connection written to the graph");
  });

  it("an adopt whose audit record could not be written counts the link (it is now the person's) and says the record is missing", async () => {
    sb.insertErr.document_assets = DUP;
    sb.adopt = { status: 200, body: { ok: true, adopted: true, already: null, auditError: "The link is now yours, but its audit record could not be written: insert refused" } };
    await renderAndWrite();
    expect(text()).toContain("2 connections written to the graph");
    expect(text()).toMatch(/PID-1 ↔ P-101 is now your link, but its audit record could not be written: The link is now yours, but its audit record could not be written: insert refused/);
  });

  it("a pair that is already a person's link (manual) needs no adopt: counted, the Bridge is not asked", async () => {
    sb.insertErr.document_assets = DUP;
    sb.held = { data: { source: "manual" }, error: null };
    await renderAndWrite();
    expect(sb.heldReads).toBe(1);
    expect(bridgeCalls()).toHaveLength(0);
    expect(text()).toContain("2 connections written to the graph");
  });

  it("a source the member's read cannot tell (an error) still goes to adopt, which decides — 'already a person's' is counted", async () => {
    sb.insertErr.document_assets = DUP;
    sb.held = { data: null, error: { message: "statement timeout" } };
    sb.adopt = { status: 200, body: { ok: true, adopted: false, already: "jsonb_sync" } };
    await renderAndWrite();
    expect(bridgeCalls()).toHaveLength(1);
    expect(text()).toContain("2 connections written to the graph");
    expect(text()).not.toMatch(/Some links failed/);
  });

  it("REGRESSION: any other refusal of the insert is said exactly as before and never sent to adopt; a doc ↔ doc 23505 still counts as already linked", async () => {
    sb.insertErr.document_assets = { code: "42501", message: "new row violates row-level security policy" };
    sb.insertErr.document_related_resources = DUP;
    await renderAndWrite();
    expect(bridgeCalls()).toHaveLength(0);
    expect(sb.heldReads).toBe(0);
    expect(text()).toContain("Some links failed: new row violates row-level security policy");
    expect(text()).toContain("1 connection written to the graph");
  });
});
