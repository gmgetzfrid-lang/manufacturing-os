// @vitest-environment jsdom
//
// projects-joint J15e APP AND COMPONENT WRITE SWEEP — the components/ batch
// (projects-tab SAF-22). The update / delete sites under components/ outside
// components/projects now read their matched rows (lib/checkedWrite.ts):
//   * CheckoutFlowModal — the lock claim (class a: its answer still settles
//     through resolveLockClaim, unchanged) and the join's collaborator list
//     (class b: a refusal is logged and never stops the join);
//   * LibraryOrderModal — the order save and the clear (class a: said on the
//     modal's error line, which stays open; never "nothing was changed" when
//     some positions landed);
//   * SetManager — a sheet's add and removal (class a: said in a toast, the
//     list unchanged) and the set's sheet count after an add (class b: a
//     warning, the add stands).
// Rendered under jsdom; the ordinary path of each is pinned byte-identical.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Answer = { data: unknown; error: { message: string; code?: string } | null };
type Write = { table: string; op: string; payload: unknown; calls: Array<[string, unknown[]]> };

const ui = vi.hoisted(() => ({
  writes: [] as Write[],
  /** Per-write answer; undefined → PostgREST's answer for a matched row. */
  answer: null as null | ((w: Write) => Answer | "reject" | undefined),
  /** SELECT answers by table. */
  reads: {} as Record<string, unknown>,
  toasts: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  messages: [] as string[],
  abort: vi.fn(),
  appConfirm: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const calls: Array<[string, unknown[]]> = [];
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            const op = calls[0]?.[0];
            const single = calls.some(([m]) => m === "maybeSingle" || m === "single");
            if (op === "update" || op === "delete") {
              const w: Write = { table, op, payload: calls[0][1][0], calls };
              ui.writes.push(w);
              const a = ui.answer?.(w);
              if (a === "reject") return reject(new Error("fetch failed"));
              if (a) return resolve(a);
              const id = (calls.find(([m, args]) => m === "eq" && args[0] === "id")?.[1][1] as string) ?? `${table}-1`;
              return resolve({ data: single ? { id } : [{ id }], error: null });
            }
            if (op === "insert") return resolve({ data: single ? { id: `${table}-new` } : [], error: null });
            const r = ui.reads[table];
            return resolve({ data: single ? (r ?? null) : (r ?? []), error: null });
          };
        }
        return (...a: unknown[]) => { calls.push([prop, a]); return new Proxy({}, h); };
      },
    };
    return new Proxy({}, h);
  };
  const channel = () => { const c = { on: () => c, subscribe: () => c }; return c; };
  return { supabase: { from: (t: string) => chain(t), channel, removeChannel: vi.fn() } };
});
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: (t: Record<string, unknown>) => { ui.toasts.push(t); } }) }));
vi.mock("@/components/providers/DialogProvider", () => ({
  appConfirm: (...a: unknown[]) => ui.appConfirm(...a),
  appAlert: vi.fn(async () => undefined),
  appPrompt: vi.fn(async () => null),
}));
vi.mock("@/components/ui/CornerDock", () => ({ useDockAvoidRow: () => () => undefined }));
vi.mock("@/lib/audit", () => ({ logCheckoutEvent: vi.fn(async (e: Record<string, unknown>) => { ui.events.push(e); }) }));
vi.mock("@/lib/projects", () => ({ createProject: vi.fn(), writeActivity: vi.fn(async () => undefined), listProjects: vi.fn(async () => []) }));
vi.mock("@/lib/inAppNotifications", () => ({ notifyMany: vi.fn(async () => undefined) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(() => Promise.resolve()) }));
vi.mock("@/components/documents/ActivityThread", () => ({ default: () => null }));
vi.mock("@/components/documents/CheckoutHistoryPanel", () => ({ default: () => null }));
vi.mock("@/components/documents/MarkupRequestModal", () => ({ default: () => null }));
vi.mock("@/components/documents/CheckInPanel", () => ({ default: () => null }));
vi.mock("@/lib/checkoutEpisodes", async (importOriginal) => ({
  // resolveLockClaim and activeCollaboratorNames stay real: the claim's
  // answer is settled exactly as in production.
  ...(await importOriginal<typeof import("@/lib/checkoutEpisodes")>()),
  getActiveEpisode: vi.fn(async () => null),
  adoptInFlightCheckout: vi.fn(async () => null),
  episodeSchemaIsMissing: () => false,
  ensureActiveEpisode: vi.fn(async () => ({ episode: { id: "ep-1", seq: 4 }, created: false })),
  postEpisodeSystemMessage: vi.fn(async (m: { text: string }) => { ui.messages.push(m.text); }),
  abortFailedLockClaim: (...a: unknown[]) => ui.abort(...a),
}));

import CheckoutFlowModal from "@/components/documents/CheckoutFlowModal";
import LibraryOrderModal from "@/components/documents/LibraryOrderModal";
import SetManager from "@/components/documents/SetManager";
import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  ui.writes = []; ui.answer = null; ui.reads = {}; ui.toasts = []; ui.events = []; ui.messages = [];
  ui.abort.mockReset().mockResolvedValue(undefined);
  ui.appConfirm.mockReset().mockResolvedValue(true);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); };
const type = async (el: HTMLInputElement, v: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
};
const has = (w: Write, m: string, ...args: unknown[]) => w.calls.some(([n, a]) => n === m && JSON.stringify(a) === JSON.stringify(args));

// ── CheckoutFlowModal ─────────────────────────────────────────────────────

describe("CheckoutFlowModal — the lock claim and the join's collaborator list", () => {
  const user = { uid: "u1", email: "ann@x.test", role: "Engineer" };
  const doc = (checkedOutBy: string | null) => ({
    id: "d1", orgId: "o1", libraryId: "l1", title: "Pump spec", documentNumber: "P-100", currentVersionId: "v1",
    checkedOutBy, checkedOutByName: checkedOutBy ? "olga" : null,
  }) as unknown as DocumentRecord;
  const checkout = async (checkedOutBy: string | null, onClose = vi.fn()) => {
    await act(async () => { root.render(h(CheckoutFlowModal, { isOpen: true, onClose, document: doc(checkedOutBy), currentUser: user })); });
    await settle();
    await click(button("Revision / Update"));
    await type(document.querySelector('input[placeholder^="e.g. Updating pump specs"]') as HTMLInputElement, "per MOC-2026-014");
    const go = [...document.querySelectorAll("button")].find((b) => b.getAttribute("class")?.includes("flex-1 py-3"))!;
    await click(go);
    return onClose;
  };
  const claimOf = () => ui.writes.find((w) => w.table === "documents" && (w.payload as Record<string, unknown>).checked_out_by === "u1")!;
  const collabOf = () => ui.writes.filter((w) => w.table === "documents" && Object.keys(w.payload as object).join() === "active_collaborators");

  it("regression: a claim that matches its row holds the lock — the same write, filters and CHECK_OUT row as before", async () => {
    const onClose = await checkout(null);
    const claim = claimOf();
    expect(Object.keys(claim.payload as object)).toEqual(["checked_out_by", "checked_out_by_name", "checked_out_at", "checkout_note", "current_lock_id", "active_collaborators"]);
    expect(claim.payload).toMatchObject({ checked_out_by: "u1", checked_out_by_name: "ann", checkout_note: "Revision / Update — per MOC-2026-014", current_lock_id: "ep-1", active_collaborators: ["ann"] });
    expect(claim.calls.map(([m]) => m)).toEqual(["update", "eq", "or", "select", "maybeSingle"]);
    expect(has(claim, "or", "checked_out_by.is.null,checked_out_by.eq.u1")).toBe(true);
    expect(collabOf()).toEqual([]);
    expect(ui.messages).toEqual(['ann checked out (edit) — Revision / Update: "per MOC-2026-014".']);
    expect(ui.events.map((e) => [e.type, (e.details as Record<string, unknown>).joined])).toEqual([["CHECK_OUT", undefined]]);
    expect(ui.abort).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a claim that matched no row with nobody holding the lock is still the refusal it was: rolled back and said, no CHECK_OUT", async () => {
    ui.reads.documents = { checked_out_by: null };
    ui.answer = (w) => (w.table === "documents" ? { data: null, error: null } : undefined);
    const onClose = await checkout(null);
    expect(ui.abort).toHaveBeenCalledTimes(1);
    expect(ui.toasts).toEqual([expect.objectContaining({ type: "error", title: "Checkout failed", message: expect.stringMatching(/did not complete — the lock could not be claimed: the write was refused without an error/) })]);
    expect(ui.events).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a claim whose request threw stops the checkout in plain words, as the throw did before (no rollback, no CHECK_OUT)", async () => {
    ui.answer = (w) => (w.table === "documents" ? "reject" : undefined);
    await checkout(null);
    expect(ui.toasts).toEqual([expect.objectContaining({ type: "error", title: "Checkout failed", message: "Couldn't reach the server — check your connection and try again." })]);
    expect(ui.abort).not.toHaveBeenCalled();
    expect(ui.events).toEqual([]);
  });

  it("regression: joining someone else's checkout writes the collaborator list, reads its row, and joins as before", async () => {
    ui.reads.documents = { checked_out_by: "other" };
    ui.answer = (w) => (w === claimOf() ? { data: null, error: null } : undefined);
    await checkout("other");
    const collab = collabOf();
    expect(collab).toHaveLength(1);
    expect(collab[0].payload).toEqual({ active_collaborators: ["ann"] });
    expect(collab[0].calls.map(([m]) => m)).toEqual(["update", "eq", "select"]);
    expect(ui.events.map((e) => (e.details as Record<string, unknown>).joined)).toEqual([true]);
    expect(ui.toasts).toEqual([expect.objectContaining({ type: "warning", title: "Joined an active checkout" })]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("collaborator list"), expect.anything(), expect.anything());
  });

  it("a collaborator-list write that matched no row (class b) is logged and never stops the join", async () => {
    ui.reads.documents = { checked_out_by: "other" };
    ui.answer = (w) => (w.table === "documents" ? { data: w === claimOf() ? null : [], error: null } : undefined);
    await checkout("other");
    expect(warn).toHaveBeenCalledWith("[checkout] join: the collaborator list was not updated", "refused", CHECKED_WRITE_REFUSED);
    expect(ui.messages).toEqual(['ann joined the checkout — Revision / Update: "per MOC-2026-014".']);
    expect(ui.events.map((e) => (e.details as Record<string, unknown>).joined)).toEqual([true]);
    expect(ui.toasts).toEqual([expect.objectContaining({ type: "warning", title: "Joined an active checkout" })]);
  });
});

// ── LibraryOrderModal ─────────────────────────────────────────────────────

describe("LibraryOrderModal — the order save and the clear", () => {
  const rows = [
    { id: "a", document_number: "A-1", title: "Alpha", rev: "0", sort_order: 0 },
    { id: "b", document_number: "B-1", title: "Bravo", rev: "0", sort_order: 1 },
    { id: "c", document_number: "C-1", title: "Charlie", rev: "0", sort_order: 2 },
  ];
  const open = async () => {
    const onClose = vi.fn(); const onSaved = vi.fn();
    await act(async () => { root.render(h(LibraryOrderModal, { isOpen: true, orgId: "o1", libraryId: "l1", onClose, onSaved })); });
    await settle();
    return { onClose, onSaved };
  };
  const save = async () => {
    const r = await open();
    await click(document.querySelector('button[title="Move down"]')!); // a ↔ b
    await click(button("Save order"));
    return r;
  };
  const errorLine = () => document.querySelector(".bg-red-50")?.textContent?.trim() ?? null;
  const idOf = (w: Write) => w.calls.find(([m, a]) => m === "eq" && a[0] === "id")?.[1][1];

  beforeEach(() => { ui.reads.documents = rows; });

  it("regression: a save whose positions all land writes the same three updates and closes", async () => {
    const { onClose, onSaved } = await save();
    expect(ui.writes.map((w) => [idOf(w), w.payload])).toEqual([["b", { sort_order: 0 }], ["a", { sort_order: 1 }], ["c", { sort_order: 2 }]]);
    expect(ui.writes.every((w) => has(w, "select", "id"))).toBe(true);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(errorLine()).toBeNull();
  });

  it("one position that matched no row: every position is still written, and the modal says which part did not save — never 'nothing was changed'", async () => {
    ui.answer = (w) => (idOf(w) === "a" ? { data: [], error: null } : undefined);
    const { onClose, onSaved } = await save();
    expect(ui.writes).toHaveLength(3);
    expect(errorLine()).toBe("1 of 3 positions were not saved — you may not have permission to reorder these, or someone else changed them first. The others were saved. Reload to see the order as it stands.");
    expect(errorLine()).not.toMatch(/nothing was changed/i);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(button("Save order").disabled).toBe(false);
  });

  it("a database error among them is worded from its own reason", async () => {
    ui.answer = (w) => (idOf(w) === "c" ? { data: null, error: { message: "permission denied for table documents", code: "42501" } } : undefined);
    const { onClose } = await save();
    expect(errorLine()).toBe("1 of 3 positions were not saved — You don't have permission to do this. The others were saved. Reload to see the order as it stands.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("every position refused: said without claiming the others were saved", async () => {
    ui.answer = () => ({ data: [], error: null });
    await save();
    expect(errorLine()).toBe("3 of 3 positions were not saved — you may not have permission to reorder these, or someone else changed them first. Reload to see the order as it stands.");
  });

  it("regression: a clear that matches every listed document writes the same statement and closes", async () => {
    ui.answer = (w) => (has(w, "eq", "library_id", "l1") ? { data: rows.map((r) => ({ id: r.id })), error: null } : undefined);
    const { onClose, onSaved } = await open();
    await click(button("Clear custom order"));
    expect(ui.writes).toHaveLength(1);
    expect(ui.writes[0].payload).toEqual({ sort_order: null });
    expect(ui.writes[0].calls.map(([m, a]) => [m, a])).toEqual([["update", [{ sort_order: null }]], ["eq", ["org_id", "o1"]], ["eq", ["library_id", "l1"]], ["select", ["id"]]]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a clear that matched no row is the refusal, on the error line; the modal stays open", async () => {
    ui.answer = () => ({ data: [], error: null });
    const { onClose } = await open();
    await click(button("Clear custom order"));
    expect(errorLine()).toBe(CHECKED_WRITE_REFUSED);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a clear that matched only some listed documents counts the rest and says the others were cleared", async () => {
    ui.answer = () => ({ data: [{ id: "a" }, { id: "c" }], error: null });
    const { onClose } = await open();
    await click(button("Clear custom order"));
    expect(errorLine()).toBe("The custom order was not cleared on 1 of 3 documents — you may not have permission to change them, or someone else changed them first. The others were cleared. Reload to see the order as it stands.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a clear that matched none of the listed documents does not say the others were cleared", async () => {
    ui.answer = () => ({ data: [{ id: "added-meanwhile" }], error: null });
    await open();
    await click(button("Clear custom order"));
    expect(errorLine()).toBe("The custom order was not cleared on 3 of 3 documents — you may not have permission to change them, or someone else changed them first. Reload to see the order as it stands.");
  });

  it("an empty library has nothing to clear (class c): zero rows closes as before", async () => {
    ui.reads.documents = [];
    ui.answer = () => ({ data: [], error: null });
    const { onClose } = await open();
    await click(button("Clear custom order"));
    expect(errorLine()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── SetManager ────────────────────────────────────────────────────────────

describe("SetManager — a sheet's add and removal, and the set's count", () => {
  const openSet = async (sheets: unknown[] = []) => {
    ui.reads.document_sets = [{ id: "set1", library_id: "l1", title: "Unit 100 P&IDs", current_set_rev: "0", sheet_count: 2, asset_index: {} }];
    ui.reads.documents = sheets;
    await act(async () => { root.render(h(SetManager, { isOpen: true, onClose: vi.fn(), libraryId: "l1" })); });
    await settle();
    await click([...document.querySelectorAll("span")].find((s) => s.textContent === "Unit 100 P&IDs")!.closest("div.p-3")!);
  };
  const addOne = async () => {
    await openSet();
    ui.reads.documents = [{ id: "d9", document_number: "P-100", title: "Pump", rev: "1", status: "Active" }];
    await type(document.querySelector('input[placeholder="Search to add sheet..."]') as HTMLInputElement, "P-1");
    await click([...document.querySelectorAll("span")].find((s) => s.textContent === "P-100")!.closest("div.p-2")!);
  };
  const listed = () => [...document.querySelectorAll("tbody span.text-sm")].map((s) => s.textContent);

  it("regression: an add that lands writes the sheet, then the set's count, as before", async () => {
    await addOne();
    expect(ui.writes.map((w) => [w.table, w.payload])).toEqual([
      ["documents", { set_id: "set1", sheet_number: 2, sheet_total: 3 }],
      ["document_sets", { sheet_count: 3 }],
    ]);
    expect(ui.writes.every((w) => has(w, "select", "id"))).toBe(true);
    expect(ui.toasts).toEqual([]);
    expect(listed()).toEqual(["P-100"]);
  });

  it("an add that matched no row is said, the set's count is not written, and the sheet is not listed", async () => {
    ui.answer = (w) => (w.table === "documents" ? { data: [], error: null } : undefined);
    await addOne();
    expect(ui.writes.map((w) => w.table)).toEqual(["documents"]);
    expect(ui.toasts).toEqual([{ type: "error", title: "Failed to add document to set", message: CHECKED_WRITE_REFUSED }]);
    expect(listed()).toEqual([]);
  });

  it("a count that did not land after the add (class b) is a warning: the add stands, and never 'nothing was changed'", async () => {
    ui.answer = (w) => (w.table === "document_sets" ? { data: [], error: null } : undefined);
    await addOne();
    expect(ui.writes.map((w) => w.table)).toEqual(["documents", "document_sets"]);
    expect(ui.toasts).toHaveLength(1);
    expect(ui.toasts[0]).toMatchObject({ type: "warning", title: "Added to the set, but its sheet count was not updated" });
    expect(String(ui.toasts[0].message)).not.toMatch(/nothing was changed/i);
    expect(listed()).toEqual(["P-100"]);
    // the binder keeps the count the database holds: the next add counts from 2, not 3
    ui.answer = null;
    ui.reads.documents = [{ id: "d10", document_number: "P-101", title: "Pump B", rev: "1", status: "Active" }];
    await type(document.querySelector('input[placeholder="Search to add sheet..."]') as HTMLInputElement, "P-10");
    await click([...document.querySelectorAll("span")].find((s) => s.textContent === "P-101")!.closest("div.p-2")!);
    expect(ui.writes.slice(2).map((w) => [w.table, w.payload])).toEqual([
      ["documents", { set_id: "set1", sheet_number: 2, sheet_total: 3 }],
      ["document_sets", { sheet_count: 3 }],
    ]);
  });

  it("a count that failed with a database error words its own reason", async () => {
    ui.answer = (w) => (w.table === "document_sets" ? { data: null, error: { message: "permission denied for table document_sets", code: "42501" } } : undefined);
    await addOne();
    expect(ui.toasts[0]).toMatchObject({ type: "warning", message: "You don't have permission to do this." });
    expect(listed()).toEqual(["P-100"]);
  });

  it("a removal that matched no row is said, and the sheet stays listed; one that lands removes it as before", async () => {
    const sheet = { id: "d3", org_id: "o1", library_id: "l1", document_number: "P-300", title: "Valve", rev: "2", status: "Active", set_id: "set1", sheet_number: 1, sheet_total: 2 };
    ui.answer = () => ({ data: [], error: null });
    await openSet([sheet]);
    await click(document.querySelector("tbody button")!);
    expect(ui.toasts).toEqual([{ type: "error", title: "Remove failed", message: CHECKED_WRITE_REFUSED }]);
    expect(listed()).toEqual(["P-300"]);
    ui.answer = null; ui.toasts = [];
    await click(document.querySelector("tbody button")!);
    expect(ui.writes[1].payload).toEqual({ set_id: null, sheet_number: null, sheet_total: null });
    expect(ui.toasts).toEqual([]);
    expect(listed()).toEqual([]);
  });
});
