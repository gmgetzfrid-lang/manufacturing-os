// @vitest-environment jsdom
//
// public-surfaces PS-P10 — the work package's print history and the
// controller's recall of a printed pack, RENDERED (components/documents/
// PackPrintHistory.tsx; intelligence DACL-8 residual (c), ruling (3) under
// DEC-90): the history lists the package's print snapshots; a controller sees
// Recall on each, gives a reason, and the recall is sent by the cover's print
// id; a non-controller sees the history and no Recall; a cancelled prompt
// sends nothing; a refused recall is said; an unreadable history is said.
// And the page's wiring (source pins): the cover links its print before the
// download, and canRecall is the role-COLLECTION controller test. The
// history and Recall shipped OFF behind PACK_PRINT_HISTORY_UI_ENABLED /
// PACK_RECALL_UI_ENABLED until public-surfaces PHYS-20; with its three limbs
// built (the integrator's ruling at the PS-P10 merge, DEC-90) both switches
// are gone: each print is marked recalled (when, by whom), stopped before its
// download, or not linked (the server's `history` read), and Recall is
// offered to a controller only on a print whose codes are linked.
// The history pages back through older prints ("Show older prints", keyset
// on printed_at, id — second review fix: every print is reachable).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const s = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  readError: null as null | { message: string },
  filters: [] as Array<[string, string, unknown]>,
  ors: [] as string[],
  orders: [] as string[],
  limits: [] as number[],
  /** when set, each read answers the next page (then the plain rows) */
  pages: [] as Array<Array<Record<string, unknown>> | "error">,
  prompt: vi.fn(),
  recall: vi.fn(),
  states: vi.fn(),
  toasts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void) => {
            const next = s.pages.length > 0 ? s.pages.shift() : undefined;
            if (next === "error") return res({ data: null, error: { message: "boom" } });
            if (next) return res({ data: next, error: null });
            res(s.readError ? { data: null, error: s.readError } : { data: s.rows, error: null });
          };
        }
        return (...args: unknown[]) => {
          if (prop === "eq") s.filters.push(["eq", String(args[0]), args[1]]);
          if (prop === "or") s.ors.push(String(args[0]));
          if (prop === "order") s.orders.push(String(args[0]));
          if (prop === "limit") s.limits.push(Number(args[0]));
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
vi.mock("@/lib/printSheetTokensClient", () => ({
  recallSheetPrint: (...a: unknown[]) => s.recall(...a),
  readSheetPrintStates: (...a: unknown[]) => s.states(...a),
}));

import * as History from "@/components/documents/PackPrintHistory";
import PackPrintHistory, { printedSheetCount, olderPrintsFilter, PACK_PRINT_HISTORY_LIMIT } from "@/components/documents/PackPrintHistory";

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
  s.ors = [];
  s.orders = [];
  s.limits = [];
  s.pages = [];
  s.prompt.mockReset();
  s.recall.mockReset();
  s.states.mockReset();
  // every print's codes linked (live) unless a test says otherwise
  s.states.mockImplementation(async ({ coverPrintIds }: { coverPrintIds: string[] }) => ({
    ok: true, available: true, prints: new Map(coverPrintIds.map((id) => [id.toLowerCase(), { state: "linked" }])),
  }));
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
    // PHYS-20 limbs 1 and 2: the sheets read recalled, and so does the cover
    expect(opts.message).toMatch(/PRINT RECALLED — DO NOT USE/);
    expect(opts.message).toMatch(/the pack's cover will read "PACK RECALLED"/);
    expect(opts.message).not.toMatch(/does not change the cover's own QR|PRINT CANCELLED/);
    expect(s.recall).toHaveBeenCalledWith({ orgId: "org1", coverPrintId: COVER_A, reason: "Issued with the wrong revision" });
    expect(s.toasts[0]).toMatchObject({ type: "success", title: "Print recalled" });
    expect(String(s.toasts[0].message)).toMatch(/2 sheets of this print now scan "PRINT RECALLED — DO NOT USE", and its cover reads "PACK RECALLED"/);
    expect(host!.querySelectorAll('[data-testid="pack-print-row"]')[0].textContent).toMatch(/Recalled/);
    // the row's recall date and author are re-read from the server
    expect(s.states).toHaveBeenLastCalledWith({ orgId: "org1", coverPrintIds: [COVER_A] });
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

  it("SHOW OLDER (second review fix): the newest ten are read first (one more to know if older exist); 'Show older prints' reads the next page strictly older than the last row shown, by (printed_at, id)", async () => {
    const mk = (i: number) => ({
      id: `c${String(i).padStart(7, "0")}-0000-0000-0000-000000000000`,
      printed_at: `2026-10-${String(20 - Math.floor(i / 2)).padStart(2, "0")}T08:00:0${i % 2}.123456+00:00`,
      printed_by_name: null,
      sheets: [{ documentId: "d1", printed: true }],
    });
    const all = Array.from({ length: 15 }, (_, i) => mk(i));
    s.pages = [all.slice(0, 11), all.slice(10, 15)];
    await render(false);
    expect(s.limits[0]).toBe(PACK_PRINT_HISTORY_LIMIT + 1);
    expect(s.orders.slice(0, 2)).toEqual(["printed_at", "id"]);
    expect(s.ors).toEqual([]);
    expect(host!.querySelectorAll('[data-testid="pack-print-row"]')).toHaveLength(10);
    const older = () => [...host!.querySelectorAll("button")].find((b) => /Show older prints/.test(b.textContent ?? ""));
    expect(older()).toBeTruthy();
    await act(async () => { older()!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(s.ors).toEqual([olderPrintsFilter({ printedAt: all[9].printed_at, id: all[9].id })]);
    expect(host!.querySelectorAll('[data-testid="pack-print-row"]')).toHaveLength(15);
    // the 15th print — older than the first page — is listed, and no more remain
    expect(older()).toBeUndefined();
  });

  it("an older page that cannot be read is said, and the shown prints and 'Show older prints' stay", async () => {
    s.rows = Array.from({ length: 11 }, (_, i) => ({ id: `id-${i}`, printed_at: `2026-10-20T08:00:${String(59 - i).padStart(2, "0")}Z`, printed_by_name: null, sheets: [] }));
    await render(false);
    s.pages = ["error"];
    const older = () => [...host!.querySelectorAll("button")].find((b) => /Show older prints/.test(b.textContent ?? ""));
    await act(async () => { older()!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(host!.textContent).toMatch(/Older prints could not be read just now/);
    expect(host!.querySelectorAll('[data-testid="pack-print-row"]')).toHaveLength(10);
    expect(older()).toBeTruthy();
  });

  it("olderPrintsFilter: strictly older in (printed_at desc, id desc), values double-quoted (a timestamp carries '.', ':' and '+')", () => {
    expect(olderPrintsFilter({ printedAt: "2026-10-20T08:00:05.123456+00:00", id: "abc" })).toBe(
      'printed_at.lt."2026-10-20T08:00:05.123456+00:00",and(printed_at.eq."2026-10-20T08:00:05.123456+00:00",id.lt."abc")',
    );
    expect(olderPrintsFilter({ printedAt: 'x"y\\z', id: "i" })).toContain('"x\\"y\\\\z"');
  });

  it("printedSheetCount: printed:false entries are left out; a pre-VFY-19 entry counts", () => {
    expect(printedSheetCount([{ printed: true }, { printed: false }, {}])).toBe(2);
    expect(printedSheetCount(null)).toBe(0);
  });
});

const COVER_C = "c3c3c3c3-0000-0000-0000-000000000003";
const COVER_D = "c4c4c4c4-0000-0000-0000-000000000004";
const rowText = (i: number) => host!.querySelectorAll('[data-testid="pack-print-row"]')[i].textContent ?? "";
const rowRecall = (i: number) => [...host!.querySelectorAll('[data-testid="pack-print-row"]')[i].querySelectorAll("button")].filter((b) => /Recall/.test(b.textContent ?? ""));

describe("PHYS-20 limb 3 — the history marks each print recalled, stopped or not linked (both states of the role)", () => {
  beforeEach(() => {
    s.rows = [
      { id: COVER_A, printed_at: "2026-10-20T08:00:05Z", printed_by_name: "jo", sheets: [{ documentId: "d1", printed: true }] },
      { id: COVER_B, printed_at: "2026-10-19T08:00:05Z", printed_by_name: "jo", sheets: [{ documentId: "d1", printed: true }] },
      { id: COVER_C, printed_at: "2026-10-18T08:00:05Z", printed_by_name: "jo", sheets: [{ documentId: "d1", printed: true }] },
      { id: COVER_D, printed_at: "2026-10-17T08:00:05Z", printed_by_name: "jo", sheets: [{ documentId: "d1", printed: true }] },
    ];
    s.states.mockImplementation(async () => ({
      ok: true, available: true,
      prints: new Map<string, unknown>([
        [COVER_A, { state: "recalled", recalledAt: "2026-10-21T09:30:00.000Z", recalledBy: "dc.lee" }],
        [COVER_B, { state: "stopped" }],
        [COVER_C, { state: "linked" }],
        [COVER_D, { state: "unlinked" }],
      ]),
    }));
  });

  for (const controller of [true, false]) {
    it(`${controller ? "a CONTROLLER" : "a NON-controller"}: recalled (date, by whom), stopped and not-linked rows are marked for every member; Recall ${controller ? "only on the linked print" : "nowhere"}`, async () => {
      await render(controller);
      expect(s.states).toHaveBeenCalledWith({ orgId: "org1", coverPrintIds: [COVER_A, COVER_B, COVER_C, COVER_D] });
      const recalledMark = host!.querySelectorAll('[data-testid="pack-print-row"]')[0].querySelector('[data-testid="pack-print-recalled"]');
      expect(recalledMark?.textContent).toMatch(/^Recalled .*2026 · by dc\.lee$/);
      expect(rowText(1)).toMatch(/Stopped — nothing downloaded/);
      expect(rowText(2)).not.toMatch(/Recalled|Stopped|not linked/);
      expect(rowText(3)).toMatch(/Per-print codes not linked/);
      expect(rowRecall(0)).toHaveLength(0);
      expect(rowRecall(1)).toHaveLength(0);
      expect(rowRecall(2)).toHaveLength(controller ? 1 : 0);
      expect(rowRecall(3)).toHaveLength(0);
      expect(recallButtons()).toHaveLength(controller ? 1 : 0);
    });
  }

  it("before database update 20261240 (the read answers not available): every row reads 'Per-print codes not linked' and no Recall is offered, even to a controller", async () => {
    s.states.mockResolvedValue({ ok: true, available: false });
    await render(true);
    for (let i = 0; i < 4; i++) expect(rowText(i)).toMatch(/Per-print codes not linked/);
    expect(recallButtons()).toHaveLength(0);
  });

  it("a state that cannot be read is said once; no row is marked; a controller keeps Recall on every row (the server decides), a non-controller sees none", async () => {
    s.states.mockResolvedValue({ ok: false, error: "boom" });
    await render(true);
    expect(host!.textContent).toMatch(/Whether these prints were recalled or stopped could not be read just now/);
    expect(host!.querySelectorAll('[data-testid="pack-print-recalled"], [data-testid="pack-print-stopped"], [data-testid="pack-print-unlinked"]')).toHaveLength(0);
    expect(recallButtons()).toHaveLength(4);
    act(() => root?.unmount());
    host?.remove();
    await render(false);
    expect(recallButtons()).toHaveLength(0);
  });

  it("older prints are marked too (their states read with their page)", async () => {
    const mk = (i: number) => ({ id: `c${String(i).padStart(7, "0")}-0000-0000-0000-000000000000`, printed_at: `2026-10-${String(20 - i).padStart(2, "0")}T08:00:00Z`, printed_by_name: null, sheets: [] });
    const all = Array.from({ length: 12 }, (_, i) => mk(i));
    s.pages = [all.slice(0, 11), all.slice(10, 12)];
    s.states.mockImplementation(async ({ coverPrintIds }: { coverPrintIds: string[] }) => ({
      ok: true, available: true, prints: new Map(coverPrintIds.map((id) => [id, { state: "stopped" }])),
    }));
    await render(false);
    const older = [...host!.querySelectorAll("button")].find((b) => /Show older prints/.test(b.textContent ?? ""))!;
    await act(async () => { older.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(s.states).toHaveBeenLastCalledWith({ orgId: "org1", coverPrintIds: [all[10].id, all[11].id] });
    expect(host!.querySelectorAll('[data-testid="pack-print-stopped"]')).toHaveLength(12);
  });
});

describe("PS-P10 — the packages page's wiring (source pins)", () => {
  const src = readFileSync(join(process.cwd(), "app/(protected)/packages/page.tsx"), "utf8");
  it("the cover links its recorded print before the download", () => {
    expect(src).toContain("buildCoverAfter: async (includedSheets, builderSkipped, cover) => {");
    const recorded = src.indexOf("const printId = await recordPackagePrint({");
    const linked = src.indexOf("cover.linkPrint(printId);");
    expect(recorded).toBeGreaterThan(0);
    expect(linked).toBeGreaterThan(recorded);
    expect(linked).toBeLessThan(src.indexOf("return buildPackageCover({"));
  });
  it("Recall is offered by the role-COLLECTION controller test (isControllerPrincipal over the headline and the roles) — and nothing else", () => {
    expect(src).toContain("const isController = isControllerPrincipal({ role: activeRole, roles });");
    expect(src).toContain("<PackPrintHistory orgId={activeOrgId} packageId={pkg.id} canRecall={isController} refreshKey={printRound} />");
  });
  it("ON (the integrator at the PS-P10 merge, DEC-90 — PHYS-20's limbs hold): the history renders for every member, the switches are gone", () => {
    expect(src).toContain('import PackPrintHistory from "@/components/documents/PackPrintHistory";');
    expect(src).toMatch(/\{activeOrgId && \(\s*<PackPrintHistory /);
    expect(src.match(/<PackPrintHistory /g)).toHaveLength(1);
    expect(src).not.toMatch(/PACK_RECALL_UI_ENABLED|PACK_PRINT_HISTORY_UI_ENABLED/);
    expect("PACK_RECALL_UI_ENABLED" in History).toBe(false);
    expect("PACK_PRINT_HISTORY_UI_ENABLED" in History).toBe(false);
  });
});
