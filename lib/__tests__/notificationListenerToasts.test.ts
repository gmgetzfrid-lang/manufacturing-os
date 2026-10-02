// @vitest-environment jsdom
//
// notifications Round G, N3 SURFACES — the listener through the REAL
// ToastProvider and corner dock (N7's): a notification row still becomes a
// visible, announced, dismissible card; an FYI card leaves after its 6 s; an
// action-required card stays until dismissed (TAX-3 dw3); two rows about one
// event are one card with a count (RT-11 dw2 / OS-4 dw2, N7's coalescing
// keyed by N3's `${kind}:${resource_id}`).

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

  it("two rows about one event (same kind, same resource), worded differently, are one card with a count", async () => {
    await deliver({ kind: "checkout_message", title: "Alice posted to P-1204-03", body: "first", resource_id: "d1" });
    await deliver({ kind: "checkout_message", title: "Bob posted to P-1204-03", body: "second", resource_id: "d1" });
    const cards = document.getElementById("corner-dock")!.querySelectorAll('[data-dock-slot="transient"] .rounded-xl');
    expect(cards).toHaveLength(1);
    expect(text()).toContain("×2");
    // KNOWN TRADE-OFF, not the goal (DEC-44 (N3) item 4): N7's merge keeps the
    // FIRST row's words, so the card reads "Alice posted … first ×2" and Bob's
    // post shows only in the bell. Handed to the next holder of
    // components/providers/ToastProvider.tsx (show the newest words, or a
    // neutral "2 posts on P-1204-03", on a merge) — this pin changes with it.
    expect(text()).toContain("Alice posted to P-1204-03");
    expect(text()).not.toContain("Bob posted to P-1204-03");
    // another event (a different kind, a different resource) is its own card
    // (an action row: never held by the burst rule, so it shows at once)
    await deliver({ kind: "checkout_conflict", title: "Checkout conflict on P-9", body: "x", resource_id: "d9" });
    expect(document.getElementById("corner-dock")!.querySelectorAll('[data-dock-slot="transient"] .rounded-xl')).toHaveLength(2);
  });
});
