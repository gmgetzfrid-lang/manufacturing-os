// @vitest-environment jsdom
//
// notifications Round G, N3 SURFACES — the listener through the REAL
// ToastProvider and corner dock (N7's): a notification row still becomes a
// visible, announced, dismissible card; an FYI card leaves after its 6 s; an
// action-required card stays until dismissed (TAX-3 dw3); two rows about one
// event are one card with a count (RT-11 dw2 / OS-4 dw2, N7's coalescing
// keyed by N3's `${kind}:${resource_id}:${actor_user_id}`), and two people's
// acts on one resource stay two cards, each naming its own person.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ch = vi.hoisted(() => ({ deliver: null as null | ((p: { new: Record<string, unknown> }) => void) }));

vi.mock("@/lib/supabase", () => {
  const channel = {
    on: (_e: string, _cfg: unknown, cb: (p: { new: Record<string, unknown> }) => void) => { ch.deliver = cb; return channel; },
    subscribe: () => channel,
  };
  return { supabase: { channel: () => channel, removeChannel: () => { ch.deliver = null; }, from: () => ({}) } };
});
vi.mock("@/lib/notificationPrefs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readToastPreference: async () => true,
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", userEmail: "u1@example.com", uid: "u1" }),
}));

import { NotificationListener } from "@/components/providers/NotificationListener";
import { ToastProvider } from "@/components/providers/ToastProvider";
import { CornerDock, __resetDockForTests } from "@/components/ui/CornerDock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let n = 0;
const deliver = (row: Record<string, unknown>) => act(async () => {
  ch.deliver!({ new: { id: `n${++n}`, user_id: "u1", body: null, ...row } });
  await vi.advanceTimersByTimeAsync(5);
});
const text = () => document.getElementById("corner-dock")?.textContent ?? "";

beforeEach(async () => {
  __resetDockForTests();
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ToastProvider, null, React.createElement(CornerDock), React.createElement(NotificationListener)));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("the toast echo of a bell row, through the real dock", () => {
  it("a row becomes an announced, dismissible card; FYI leaves after 6 s, an action stays until dismissed", async () => {
    await deliver({ kind: "library_doc_revised", title: "P-100 advanced to Rev C", resource_id: "d100" });
    await deliver({ kind: "checkout_conflict", title: "Checkout conflict on P-200", resource_id: "d200" });
    const dock = document.getElementById("corner-dock")!;
    expect(dock.getAttribute("aria-live")).toBe("polite");
    expect(text()).toContain("P-100 advanced to Rev C");
    expect(text()).toContain("Checkout conflict on P-200");
    expect(dock.querySelectorAll('button[aria-label="Dismiss"]').length).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    expect(text()).not.toContain("P-100 advanced to Rev C");
    expect(text()).toContain("Checkout conflict on P-200");
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(text()).toContain("Checkout conflict on P-200");
    await act(async () => { (dock.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click(); });
    expect(text()).not.toContain("Checkout conflict on P-200");
  });

  const cards = () => document.getElementById("corner-dock")!.querySelectorAll('[data-dock-slot="transient"] .rounded-xl');

  it("two rows about one event (same kind, same resource, same actor), worded differently, are one card with a count", async () => {
    await deliver({ kind: "checkout_message", title: "Alice posted to P-1204-03", body: "first", resource_id: "d1", actor_user_id: "uA" });
    await deliver({ kind: "checkout_message", title: "Alice posted to P-1204-03", body: "second", resource_id: "d1", actor_user_id: "uA" });
    expect(cards()).toHaveLength(1);
    expect(text()).toContain("×2");
    // KNOWN TRADE-OFF, narrowed (DEC-44 (N3) item 4): N7's merge keeps the
    // FIRST row's words, so one person's repeat reads "Alice posted … first
    // ×2" and the second snippet shows only in the bell. Handed to the next
    // holder of components/providers/ToastProvider.tsx (show the newest
    // words on a merge) — this pin changes with it.
    expect(text()).toContain("first");
    expect(text()).not.toContain("second");
    // another event (a different kind, a different resource) is its own card
    // (an action row: never held by the burst rule, so it shows at once)
    await deliver({ kind: "checkout_conflict", title: "Checkout conflict on P-9", body: "x", resource_id: "d9", actor_user_id: "uA" });
    expect(cards()).toHaveLength(2);
  });

  it("a nudge burst about one thing from one person is one card with a count — no summary card after the window (OS-4 dw2, second review fix)", async () => {
    for (let i = 0; i < 5; i++) await deliver({ kind: "task_nudge", title: "Sam nudged you about P-7", body: null, resource_id: "p7", actor_user_id: "uS" });
    expect(cards()).toHaveLength(1);
    expect(text()).toContain("×5");
    await act(async () => { await vi.advanceTimersByTimeAsync(6100 - 25); });
    expect(text()).not.toContain("more notification");
  });

  it("two people on one resource are two cards, each naming its own person — Carol's sign-off is never shown as Bob's ×2 (second review fix)", async () => {
    await deliver({ kind: "review_signed", title: "Bob signed off on P-1", body: null, resource_id: "p1", actor_user_id: "uB" });
    await deliver({ kind: "review_signed", title: "Carol signed off on P-1", body: null, resource_id: "p1", actor_user_id: "uC" });
    expect(cards()).toHaveLength(2);
    expect(text()).toContain("Bob signed off on P-1");
    expect(text()).toContain("Carol signed off on P-1");
    expect(text()).not.toContain("×2");
  });
});
