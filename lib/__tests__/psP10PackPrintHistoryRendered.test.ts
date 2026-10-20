// @vitest-environment jsdom
//
// public-surfaces PS-P10 — the work package's print history and the
// controller's recall of a printed pack, RENDERED (components/documents/
// PackPrintHistory.tsx; intelligence DACL-8 residual (c), ruling (3) under
// DEC-90): the history lists the package's print snapshots; a controller sees
// Recall on each, gives a reason, and the recall is sent by the cover's print
// id; a non-controller sees the history and no Recall; a cancelled prompt
// sends nothing; a refused recall is said; an unreadable history is said.
// And the page's wiring (source pins): the cover links its print for the
// settle, and canRecall is the role-COLLECTION controller test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const s = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  readError: null as null | { message: string },
  filters: [] as Array<[string, string, unknown]>,
  prompt: vi.fn(),
  recall: vi.fn(),
  toasts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res(s.readError ? { data: null, error: s.readError } : { data: s.rows, error: null });
        return (...args: unknown[]) => {
          if (prop === "eq") s.filters.push(["eq", String(args[0]), args[1]]);
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: () => chain() } };
});
vi.mock("@/components/providers/DialogProvider", () => ({ appPrompt: (...a: unknown[]) => s.prompt(...a) }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: (t: Record<string, unknown>) => s.toasts.push(t) }) }));
vi.mock("@/lib/printSheetTokensClient", () => ({ recallSheetPrint: (...a: unknown[]) => s.recall(...a) }));

import PackPrintHistory, { printedSheetCount, PACK_PRINT_HISTORY_LIMIT } from "@/components/documents/PackPrintHistory";

const COVER_A = "c1c1c1c1-0000-0000-0000-000000000001";
const COVER_B = "c2c2c2c2-0000-0000-0000-000000000002";
let root: Root | null = null;
let host: HTMLDivElement | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(canRecall: boolean) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(PackPrintHistory, { orgId: "org1", packageId: "pkg1", canRecall })); });
  // open the history
  const toggle = [...host.querySelectorAll("button")].find((b) => /Print history/.test(b.textContent ?? ""))!;
  await act(async () => { toggle.click(); });
  await act(async () => { await Promise.resolve(); });
}
const recallButtons = () => [...(host?.querySelectorAll("button") ?? [])].filter((b) => /Recall/.test(b.textContent ?? ""));

beforeEach(() => {
  s.rows = [
    { id: COVER_A, printed_at: "2026-10-20T08:00:05Z", printed_by_name: "jo", sheets: [{ documentId: "d1", printed: true }, { documentId: "d2", printed: true }, { documentId: "d3", printed: false }] },
    { id: COVER_B, printed_at: "2026-10-19T08:00:05Z", printed_by_name: null, sheets: [{ documentId: "d1" }] },
  ];
  s.readError = null;
  s.filters = [];
  s.prompt.mockReset();
  s.recall.mockReset();
  s.toasts = [];
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("PS-P10 — the print history, rendered", () => {
  it("lists the package's prints (this workspace, this package), each with its printed-sheet count", async () => {
    await render(false);
    const rows = host!.querySelectorAll('[data-testid="pack-print-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/jo/);
    expect(rows[0].textContent).toMatch(/2 sheets/);
    expect(rows[1].textContent).toMatch(/1 sheet\b/);
    expect(s.filters).toEqual(expect.arrayContaining([["eq", "org_id", "org1"], ["eq", "package_id", "pkg1"]]));
    expect(PACK_PRINT_HISTORY_LIMIT).toBe(10);
  });

  it("a non-controller sees the history and NO Recall", async () => {
    await render(false);
    expect(recallButtons()).toHaveLength(0);
  });

  it("a controller recalls a print: the reason is asked for, and the recall is sent by that cover's print id; the row then reads Recalled", async () => {
    s.prompt.mockResolvedValue("  Issued with the wrong revision  ");
    s.recall.mockResolvedValue({ ok: true, voided: 2, alreadyVoid: 0 });
    await render(true);
    expect(recallButtons()).toHaveLength(2);
    await act(async () => { recallButtons()[0].click(); });
    await act(async () => { await Promise.resolve(); });
    const opts = s.prompt.mock.calls[0][0] as { required: boolean; minLength: number; message: string };
    expect(opts.required).toBe(true);
    expect(opts.minLength).toBe(3);
    expect(opts.message).toMatch(/PRINT CANCELLED — DO NOT USE/);
    expect(opts.message).toMatch(/does not change the cover's own QR/);
    expect(s.recall).toHaveBeenCalledWith({ orgId: "org1", coverPrintId: COVER_A, reason: "Issued with the wrong revision" });
    expect(s.toasts[0]).toMatchObject({ type: "success", title: "Print recalled" });
    expect(String(s.toasts[0].message)).toMatch(/2 sheets of this print now scan/);
    expect(host!.querySelectorAll('[data-testid="pack-print-row"]')[0].textContent).toMatch(/Recalled/);
  });

  it("a cancelled prompt sends nothing", async () => {
    s.prompt.mockResolvedValue(null);
    await render(true);
    await act(async () => { recallButtons()[0].click(); });
    expect(s.recall).not.toHaveBeenCalled();
    expect(s.toasts).toEqual([]);
  });

  it("a refused recall (or one before database update 20261240) is said, and the row keeps its Recall", async () => {
    s.prompt.mockResolvedValue("Wrong pack");
    s.recall.mockResolvedValue({ ok: false, unavailable: true, status: 200, error: "Recalling a printed pack needs database update 20261240 — nothing was changed." });
    await render(true);
    await act(async () => { recallButtons()[0].click(); });
    await act(async () => { await Promise.resolve(); });
    expect(s.toasts[0]).toMatchObject({ type: "warning", title: "Print not recalled" });
    expect(recallButtons()).toHaveLength(2);
  });

  it("an unreadable history is said — never shown as 'Not printed yet'", async () => {
    s.readError = { message: "boom" };
    await render(true);
    expect(host!.textContent).toMatch(/could not be read just now/);
    expect(host!.textContent).not.toMatch(/Not printed yet/);
  });

  it("printedSheetCount: printed:false entries are left out; a pre-VFY-19 entry counts", () => {
    expect(printedSheetCount([{ printed: true }, { printed: false }, {}])).toBe(2);
    expect(printedSheetCount(null)).toBe(0);
  });
});

describe("PS-P10 — the packages page's wiring (source pins)", () => {
  const src = readFileSync(join(process.cwd(), "app/(protected)/packages/page.tsx"), "utf8");
  it("the cover links its recorded print for the post-download settle", () => {
    expect(src).toContain("buildCoverAfter: async (includedSheets, builderSkipped, cover) => {");
    const recorded = src.indexOf("const printId = await recordPackagePrint({");
    const linked = src.indexOf("cover.linkPrint(printId);");
    expect(recorded).toBeGreaterThan(0);
    expect(linked).toBeGreaterThan(recorded);
    expect(linked).toBeLessThan(src.indexOf("return buildPackageCover({"));
  });
  it("Recall is offered by the role-COLLECTION controller test (isControllerPrincipal over the headline and the roles)", () => {
    expect(src).toContain("const isController = isControllerPrincipal({ role: activeRole, roles });");
    expect(src).toContain("<PackPrintHistory orgId={activeOrgId} packageId={pkg.id} canRecall={isController} refreshKey={printRound} />");
  });
});
