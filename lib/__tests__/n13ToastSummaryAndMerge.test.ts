// @vitest-environment jsdom
//
// notifications N13 LAYERS SWEEP — the two ToastProvider hand-offs, through
// the REAL ToastProvider, corner dock and listener:
//   * TAX-9 done-when 4's last limb: the burst summary card ("N more
//     notifications") opens the Notification Center — an action slot on a
//     toast; the action summary ("N more actions need you") opens it on
//     Action. Without an opener the cards are exactly as before.
//   * RT-11 / OS-4 refinement (DEC-94 item 4): a coalesce merge shows the
//     NEWEST arrival's words, not the first's. Under the content key and the
//     listener's statement key every merged arrival says the same thing, so
//     every existing card reads as before (pinned here).

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
  readToastPreferences: async () => true,
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", userEmail: "u1@example.com", uid: "u1" }),
}));

import {
  NotificationListener, createNotificationToaster, BURST_WINDOW_MS, OPEN_CENTER_LABEL, OPEN_ACTIONS_LABEL, type ToastSpec,
} from "@/components/providers/NotificationListener";
import { ToastProvider, useToast, mergeToast, toastCountTitle, type Shown } from "@/components/providers/ToastProvider";
import { CornerDock, __resetDockForTests } from "@/components/ui/CornerDock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let n = 0;
const grabbed: { show: ReturnType<typeof useToast>["showToast"] | null } = { show: null };
const openCenter = vi.fn();

function Grab() {
  const { showToast } = useToast();
  React.useEffect(() => { grabbed.show = showToast; }, [showToast]);
  return null;
}

const deliver = (row: Record<string, unknown>) => act(async () => {
  ch.deliver!({ new: { id: `n${++n}`, user_id: "u1", body: null, ...row } });
  await vi.advanceTimersByTimeAsync(5);
});
const dock = () => document.getElementById("corner-dock")!;
const text = () => document.getElementById("corner-dock")?.textContent ?? "";
const cards = () => dock().querySelectorAll('[data-dock-slot="transient"] [role="status"] > div');
const buttonNamed = (label: string) => [...dock().querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

async function mount(withOpener: boolean) {
  __resetDockForTests();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ToastProvider, null,
      React.createElement(CornerDock),
      React.createElement(Grab),
      React.createElement(NotificationListener, { onOpenCenter: withOpener ? openCenter : undefined })));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
}

beforeEach(() => {
  vi.useFakeTimers();
  openCenter.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("TAX-9 — the burst summary card opens the Notification Center", () => {
  it("five FYI rows in one window: two cards, then the summary carries 'Open notifications', which opens the center on All and dismisses the card", async () => {
    await mount(true);
    for (let i = 0; i < 5; i++) await deliver({ kind: "review_due", title: `Review due: P-${i}`, resource_id: `d${i}` });
    // the two individual cards carry no button but Dismiss
    expect(cards()).toHaveLength(2);
    expect(buttonNamed(OPEN_CENTER_LABEL)).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS); });
    expect(text()).toContain("3 more notifications");
    const open = buttonNamed(OPEN_CENTER_LABEL)!;
    expect(open).toBeTruthy();
    await act(async () => { open.click(); });
    expect(openCenter).toHaveBeenCalledTimes(1);
    expect(openCenter).toHaveBeenCalledWith("all");
    expect(text()).not.toContain("3 more notifications");
  });

  it("five action rows in one window: the sticky 'N more actions need you' card carries 'Open actions', which opens the center on Action", async () => {
    await mount(true);
    for (let i = 0; i < 5; i++) await deliver({ kind: "ack_overdue", title: "Still unconfirmed", body: `DOC-${i}`, resource_id: `d${i}` });
    await act(async () => { await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS); });
    expect(text()).toContain("3 more actions need you");
    await act(async () => { buttonNamed(OPEN_ACTIONS_LABEL)!.click(); });
    expect(openCenter).toHaveBeenCalledWith("action");
  });

  it("no opener (a listener mounted without the layout's): the summary card is exactly as before — Dismiss only", async () => {
    await mount(false);
    for (let i = 0; i < 5; i++) await deliver({ kind: "review_due", title: `Review due: P-${i}`, resource_id: `d${i}` });
    await act(async () => { await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS); });
    expect(text()).toContain("3 more notifications");
    expect(buttonNamed(OPEN_CENTER_LABEL)).toBeUndefined();
    const summary = [...cards()].find((c) => c.textContent!.includes("3 more notifications"))!;
    expect([...summary.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Dismiss"]);
  });

  it("the toaster: only the summaries gain the action; a single row's toast spec is unchanged", async () => {
    const shown: ToastSpec[] = [];
    const fires: Array<() => void> = [];
    const opened: string[] = [];
    const t = createNotificationToaster({
      show: (s) => shown.push(s), readPreference: async () => true, now: () => 0,
      setTimer: (cb, ms) => { if (ms === BURST_WINDOW_MS) fires.push(cb); return fires.length; }, clearTimer: () => {},
      openCenter: (f) => opened.push(f),
    });
    for (let i = 0; i < 4; i++) t.receive({ id: `i${i}`, kind: "review_due", title: `due ${i}`, body: null, resource_id: `r${i}` });
    await vi.advanceTimersByTimeAsync(1);
    expect(shown.map((s) => s.action)).toEqual([undefined, undefined]);
    for (const f of fires) f();
    expect(shown).toHaveLength(3);
    expect(shown[2]).toMatchObject({ title: "2 more notifications", action: { label: OPEN_CENTER_LABEL } });
    shown[2].action!.onClick();
    expect(opened).toEqual(["all"]);
    // a window holding one extra row shows it as itself — no action
    const one: ToastSpec[] = [];
    const fires2: Array<() => void> = [];
    const t2 = createNotificationToaster({
      show: (s) => one.push(s), readPreference: async () => true, now: () => 0,
      setTimer: (cb, ms) => { if (ms === BURST_WINDOW_MS) fires2.push(cb); return fires2.length; }, clearTimer: () => {},
      openCenter: () => {},
    });
    for (let i = 0; i < 3; i++) t2.receive({ id: `j${i}`, kind: "review_due", title: `due ${i}`, body: null, resource_id: `s${i}` });
    await vi.advanceTimersByTimeAsync(1);
    for (const f of fires2) f();
    expect(one.map((s) => s.title)).toEqual(["due 0", "due 1", "due 2"]);
    expect(one.every((s) => s.action === undefined)).toBe(true);
  });
});

describe("RT-11 / OS-4 refinement — a merge shows the newest arrival's words", () => {
  it("a producer key joining two differently worded toasts: one card ×2 in the NEWEST words, its tooltip says so", async () => {
    await mount(true);
    await act(async () => { grabbed.show!({ type: "info", title: "Approve · DR-12", message: "Status: APPROVED", coalesceKey: "ticket_status:t12", duration: 6000 }); });
    await act(async () => { grabbed.show!({ type: "info", title: "Release · DR-12", message: "Status: RELEASED", coalesceKey: "ticket_status:t12", duration: 6000 }); });
    expect(cards()).toHaveLength(1);
    expect(text()).toContain("Release · DR-12");
    expect(text()).toContain("Status: RELEASED");
    expect(text()).not.toContain("APPROVED");
    expect(text()).toContain("×2");
    expect(dock().querySelector('[title$="showing the newest"]')!.getAttribute("title")).toBe("2 updates — showing the newest");
  });

  it("regression: identical toasts (the content key) are one card ×3, word for word as before, 'identical messages' in the tooltip, no extra button", async () => {
    await mount(true);
    for (let i = 0; i < 3; i++) await act(async () => { grabbed.show!({ type: "success", title: "Saved", message: "Columns saved" }); });
    expect(cards()).toHaveLength(1);
    const card = cards()[0];
    expect(card.querySelector("h4")!.textContent).toBe("Saved×3");
    expect(card.querySelector("p")!.textContent).toBe("Columns saved");
    expect(card.querySelector("[title]")!.getAttribute("title")).toBe("3 identical messages");
    expect([...card.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Dismiss"]);
  });

  it("regression: the listener's statement key still keeps differently worded rows apart (DEC-94 item 4 ratified) — two cards, each in its own words", async () => {
    await mount(true);
    await deliver({ kind: "ticket_status", title: "Approve · DR-12", body: "Status: APPROVED", resource_id: "t12" });
    await deliver({ kind: "ticket_status", title: "Release · DR-12", body: "Status: RELEASED", resource_id: "t12" });
    expect(cards()).toHaveLength(2);
    expect(text()).toContain("Status: APPROVED");
    expect(text()).toContain("Status: RELEASED");
    expect(text()).not.toContain("×2");
  });

  it("mergeToast: the newest words, tone and action; count and the card's id and key kept; identical words are not 'varied'", () => {
    const first: Shown = { id: "a", key: "k", type: "info", title: "one", message: "m1", duration: 6000, count: 1, at: 0, varied: false };
    const act1 = { label: "x", onClick: () => {} };
    const merged = mergeToast(first, { type: "warning", title: "two", message: "m2", duration: 0, action: act1 }, 5);
    expect(merged).toMatchObject({ id: "a", key: "k", type: "warning", title: "two", message: "m2", duration: 0, action: act1, count: 2, at: 5, varied: true });
    expect(toastCountTitle(merged)).toBe("2 updates — showing the newest");
    const same = mergeToast(first, { type: "info", title: "one", message: "m1", duration: 6000 }, 5);
    expect(same).toMatchObject({ title: "one", message: "m1", count: 2, varied: false });
    expect(toastCountTitle(same)).toBe("2 identical messages");
    // once varied, a card stays varied
    expect(mergeToast(merged, { type: "warning", title: "two", message: "m2", duration: 0 }, 6).varied).toBe(true);
  });
});
