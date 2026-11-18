// @vitest-environment jsdom
//
// notifications N13 LAYERS SWEEP — the rendered pass over overlays the sweep
// touched (STACK-14 done-when 1, TAX-14 done-when 4), through the REAL
// CornerDock, ToastProvider and UploadIndicator:
//   * the overlay's class string is byte-identical to the one it had before
//     the sweep (its layer now comes from lib/zLayers' ZC, its number does not
//     change), so the layer it paints in is the same;
//   * AT REST nothing changes: the dock is at Z.dock, under the overlay, and
//     the declared row moves nothing (DEC-85 item 4 — the dock rests under
//     every overlay from 300 up);
//   * RAISED (a modal that started an upload is open and reports it), the
//     overlay's action row is declared: the dock's cards lift above it instead
//     of covering it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const up = vi.hoisted(() => ({ listeners: new Set<(e: unknown) => void>() }));
vi.mock("@/lib/storage", () => ({
  subscribeUploads: (cb: (e: unknown) => void) => { up.listeners.add(cb); return () => { up.listeners.delete(cb); }; },
  uploadToPath: vi.fn(),
}));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "is", "neq"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: { retention_policy: null }, error: null });
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
  return { supabase: { from: () => chain, channel: () => ({ on: () => ({ subscribe: () => ({}) }) }), removeChannel: () => {} } };
});

import { CornerDock, useDockRaise, __resetDockForTests } from "@/components/ui/CornerDock";
import { ToastProvider } from "@/components/providers/ToastProvider";
import UploadIndicator from "@/components/providers/UploadIndicator";
import { Z } from "@/lib/zLayers";
import CreateColumnWizard from "@/components/documents/CreateColumnWizard";
import ExecutionGuide from "@/components/projects/ExecutionGuide";
import RetentionPolicyModal from "@/components/documents/RetentionPolicyModal";
import PublishNewDocumentModal from "@/components/requests/PublishNewDocumentModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const upload = (id: string) => { for (const l of up.listeners) l({ id, name: `${id}.pdf`, percent: 40, status: "uploading" }); };
let host: HTMLDivElement;
let root: Root;
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const dock = () => document.getElementById("corner-dock")!;
const rect = (left: number, top: number, right: number, bottom: number) =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() { return {}; } }) as DOMRect;
const viewport = (w: number, h: number) => {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
};

/** A modal that started an upload: it raises the dock (as MetadataStagingModal does once Upload All runs). */
function Raise() { useDockRaise(true); return null; }

const shell = (raised: boolean, overlay: React.ReactNode) =>
  React.createElement(ToastProvider, null,
    React.createElement(CornerDock),
    React.createElement(UploadIndicator),
    raised ? React.createElement(Raise) : null,
    overlay);

async function mount(el: React.ReactNode) {
  await act(async () => { root.render(el as React.ReactElement); });
  await flush();
}

beforeEach(() => {
  __resetDockForTests();
  up.listeners.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  viewport(1366, 768);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

interface Case {
  name: string;
  /** The overlay root's class string at b138efc7, before the sweep. */
  rootClass: string;
  layer: number;
  /** The overlay's action row (the element the sweep declared). */
  row: string;
  render: () => React.ReactNode;
  open?: () => Promise<void>;
}

const file = new File(["%PDF"], "DR-12.pdf", { type: "application/pdf" });
const CASES: Case[] = [
  {
    name: "CreateColumnWizard (z-400, the shared Modal's band)",
    rootClass: "fixed inset-0 z-[400] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 p-4 animate-in fade-in",
    layer: 400,
    row: "div.px-6.py-4.border-t",
    render: () => React.createElement(CreateColumnWizard, { isOpen: true, onClose: () => {}, onSave: async () => {} }),
  },
  {
    name: "ExecutionGuide (z-300, the overlay band)",
    rootClass: "fixed inset-0 z-[300] flex items-start sm:items-center justify-center overflow-y-auto p-4",
    layer: 300,
    row: "div.px-5.py-3.border-t",
    render: () => React.createElement(ExecutionGuide),
    open: async () => {
      const b = [...document.querySelectorAll("button")].find((x) => /how/i.test(x.textContent ?? "") || /guide/i.test(x.getAttribute("title") ?? x.getAttribute("aria-label") ?? ""));
      await act(async () => { b!.click(); });
      await flush();
    },
  },
  {
    name: "RetentionPolicyModal (z-520, the policy band)",
    rootClass: "fixed inset-0 z-[520] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4",
    layer: 520,
    row: "div.pt-2.border-t",
    render: () => React.createElement(RetentionPolicyModal, { level: "library", id: "lib-1", orgId: "o1", uid: "u1", onClose: () => {} }),
  },
  {
    name: "PublishNewDocumentModal (z-520)",
    rootClass: "fixed inset-0 z-[520] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm p-4",
    layer: 520,
    row: "div.px-5.py-3.border-t",
    render: () => React.createElement(PublishNewDocumentModal, {
      orgId: "o1", libraryId: "lib-1", libraryName: "P&IDs", ticketRowId: "t1", ticketNumber: "DR-12", defaultTitle: "Crude unit",
      file, actorUserId: "u1", onClose: () => {}, onCreated: () => {},
    }),
  },
];

const overlayRoot = (c: Case) => [...document.querySelectorAll<HTMLElement>("div")].find((d) => d.className === c.rootClass);

describe("STACK-14 / TAX-14 — the overlays the sweep touched, rendered", () => {
  for (const c of CASES) {
    it(`${c.name}: the same class string, the dock under it at rest with nothing moved; raised, the cards lift above its declared action row`, async () => {
      // The same layout in both halves: the declared row sits in the dock's
      // lane at 1366x768, the cards would overlap it.
      const row = () => document.querySelector<HTMLElement>(c.row);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.matches("[data-dock-slot]") && this.children.length > 0) return rect(1062, 466, 1350, 752);
        if (this === row()) return rect(107, 670, 1259, 730);
        return rect(0, 0, 0, 0);
      });
      // At rest — upload cards showing over the declared row, no raising modal.
      await mount(shell(false, c.render()));
      if (c.open) await c.open();
      await act(async () => { for (let i = 0; i < 4; i++) upload(`F${i}`); });
      await flush();
      await act(async () => { window.dispatchEvent(new Event("resize")); });
      await flush();
      expect(row(), "the declared action row").toBeTruthy();
      const el = overlayRoot(c);
      expect(el, "the overlay's class string is unchanged").toBeTruthy();
      expect(Number(/z-\[(\d+)\]/.exec(el!.className)![1])).toBe(c.layer);
      expect(dock().getAttribute("data-dock-raised")).toBeNull();
      expect(Number(dock().style.zIndex)).toBe(Z.dock);
      expect(Number(dock().style.zIndex)).toBeLessThan(c.layer);
      const restBottom = dock().style.bottom;
      expect(restBottom).toBe("calc(var(--dock-bottom, 0px) - 1.5rem)");
      expect(dock().getAttribute("data-dock-avoiding")).toBeNull();

      // Raised — a modal that started an upload is open and reports it.
      await act(async () => root.unmount());
      __resetDockForTests();
      up.listeners.clear();
      root = createRoot(host);
      await mount(shell(true, c.render()));
      if (c.open) await c.open();
      await act(async () => { for (let i = 0; i < 4; i++) upload(`F${i}`); });
      await flush();
      // a resize re-measures the declared row against the mocked layout
      await act(async () => { window.dispatchEvent(new Event("resize")); });
      await flush();
      expect(Number(dock().style.zIndex)).toBe(Z.dockRaised);
      expect(dock().getAttribute("data-dock-avoiding")).toBe("1");
      expect(dock().style.bottom).toBe("calc(90px - 1.5rem)");
    });
  }
});
