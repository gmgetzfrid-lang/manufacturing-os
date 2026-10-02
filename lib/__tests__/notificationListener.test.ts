// @vitest-environment jsdom
//
// notifications Round G, N3 SURFACES — the toast listener
// (components/providers/NotificationListener.tsx).
//
// REGRESSION FIRST: every notification row addressed to a member still
// toasts that member, as it did on 7c27b0c — now from ONE channel. What
// changed: the org-wide `checkout_messages` channel is gone (RT-2 / TAX-4),
// so one checkout-thread post toasts each participant exactly once (from its
// durable `checkout_message` row) and an uninvolved member never; an
// action-required kind is amber and stays (TAX-3); a row coalesces with
// another about the same event — same kind, resource and actor (RT-11 /
// OS-4); a burst is one summary (TAX-9); the member's pop-up switch is
// honoured, failing open on an error and on a read that never answers
// (RT-10).
//
// The supabase double is an in-memory bus: an INSERT is delivered to every
// subscribed channel on that table whose `col=eq.value` filter matches — the
// way Supabase realtime would route it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Row = Record<string, unknown>;
type Sub = { table: string; filter?: string; cb: (p: { new: Row }) => void };

const bus = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    subs: [] as Array<{ table: string; filter?: string; cb: (p: { new: Row }) => void }>,
    seq: 0,
  };
  return state;
});
const fx = vi.hoisted(() => ({
  pref: {} as Record<string, boolean | "throw" | "stall">,
  prefReads: [] as string[],
  toasts: [] as Array<{ uid: string; type: string; title: string; message?: string; duration?: number; coalesceKey?: string }>,
  showFor: new Map<string, (t: Record<string, unknown>) => void>(),
}));

vi.mock("@/lib/supabase", () => {
  const matches = (row: Row, filter?: string) => {
    if (!filter) return true;
    const m = filter.match(/^(\w+)=eq\.(.+)$/);
    return !!m && String(row[m[1]]) === m[2];
  };
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let inserted: Row[] | null = null;
    const read = () => (bus.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const q: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "is", "in", "not"]) q[m] = () => q;
    q.eq = (c: string, v: unknown) => { filters.push([c, v]); return q; };
    q.insert = (rowOrRows: Row | Row[]) => {
      const rows = (Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]).map((r) => ({
        id: `row-${++bus.seq}`, created_at: new Date().toISOString(), ...r,
      }));
      (bus.tables[table] ??= []).push(...rows);
      for (const r of rows) for (const s of [...bus.subs]) if (s.table === table && matches(r, s.filter)) s.cb({ new: r });
      inserted = rows;
      return q;
    };
    q.single = async () => ({ data: inserted?.[0] ?? read()[0] ?? null, error: null });
    q.maybeSingle = async () => ({ data: read()[0] ?? null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(inserted ? { data: inserted, error: null } : { data: read(), error: null }).then(ok, ko);
    return q;
  };
  const channel = (name: string) => {
    const pending: Sub[] = [];
    const ch = {
      name,
      pending,
      on: (_e: string, cfg: { table: string; filter?: string }, cb: Sub["cb"]) => { pending.push({ table: cfg.table, filter: cfg.filter, cb }); return ch; },
      subscribe: () => { bus.subs.push(...pending); return ch; },
    };
    return ch;
  };
  return {
    supabase: {
      from,
      channel,
      removeChannel: (ch: { pending: Sub[] }) => {
        for (const p of ch.pending) { const i = bus.subs.indexOf(p); if (i >= 0) bus.subs.splice(i, 1); }
      },
    },
  };
});

vi.mock("@/lib/checkoutEpisodes", () => ({
  getActiveEpisode: async () => null,
  isMissingEpisodeSchema: () => false,
}));

vi.mock("@/lib/notificationPrefs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readToastPreference: async (uid: string) => {
    fx.prefReads.push(uid);
    const v = fx.pref[uid];
    if (v === "throw") throw new Error("network");
    if (v === "stall") return new Promise<boolean>(() => {}); // associated Wi-Fi, no route out
    return v ?? true;
  },
}));

vi.mock("@/components/providers/RoleContext", async () => {
  const R = await import("react");
  const RoleTestContext = R.createContext({ activeOrgId: "o1", userEmail: "me@example.com", uid: "u1" });
  return { useRole: () => R.useContext(RoleTestContext), RoleTestContext };
});

vi.mock("@/components/providers/ToastProvider", async (orig) => {
  const actual = await orig<typeof import("@/components/providers/ToastProvider")>();
  const R = await import("react");
  const Role = (await import("@/components/providers/RoleContext")) as unknown as { RoleTestContext: React.Context<{ uid: string }> };
  return {
    ...actual,
    useToast: () => {
      const { uid } = R.useContext(Role.RoleTestContext);
      let show = fx.showFor.get(uid);
      if (!show) {
        show = (t) => { fx.toasts.push({ uid, ...(t as { type: string; title: string }) }); };
        fx.showFor.set(uid, show);
      }
      return { showToast: show };
    },
  };
});

import {
  NotificationListener, toastForRow, burstSummary, createNotificationToaster,
  BURST_WINDOW_MS, BURST_SHOWN_MAX, PREF_FRESH_MS, PREF_READ_TIMEOUT_MS, SEEN_IDS_MAX, NOTIFICATION_TOAST_MS,
} from "@/components/providers/NotificationListener";
import { postActivity } from "@/lib/activityThread";
import { TOAST_PREFERENCE_HONOURED } from "@/lib/notificationPrefs";
import * as RoleModule from "@/components/providers/RoleContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RoleTestContext = (RoleModule as unknown as { RoleTestContext: React.Context<{ activeOrgId: string; userEmail: string; uid: string }> }).RoleTestContext;
const LISTENER = readFileSync(resolve("components/providers/NotificationListener.tsx"), "utf8");

const roots: Array<{ root: Root; host: HTMLElement }> = [];
async function mountListener(uid: string, children?: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(React.createElement(RoleTestContext.Provider, { value: { activeOrgId: "o1", userEmail: `${uid}@example.com`, uid } },
      React.createElement(NotificationListener), children ?? null));
  });
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const toastsOf = (uid: string) => fx.toasts.filter((t) => t.uid === uid);
const insertNotification = (row: Row) => act(async () => {
  void (bus as unknown as { tables: Record<string, Row[]> });
  const { supabase } = await import("@/lib/supabase");
  await (supabase.from("notifications") as unknown as { insert: (r: Row) => unknown }).insert({ org_id: "o1", body: null, ...row });
});

beforeEach(() => {
  bus.tables = {};
  bus.subs = [];
  bus.seq = 0;
  fx.pref = {};
  fx.prefReads = [];
  fx.toasts = [];
  fx.showFor.clear();
});
afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.useRealTimers();
});

describe("toastForRow — the tone, the time and the event key come from the registry", () => {
  it("an action-required kind is amber and stays until dismissed; an FYI kind is the 6 s info toast it always was", () => {
    expect(toastForRow({ id: "1", kind: "checkout_released", title: "Your checkout was force-released", body: "b", resource_id: "d1", actor_user_id: "uD" }))
      .toEqual({ type: "warning", title: "Your checkout was force-released", message: "b", duration: 0, coalesceKey: "checkout_released:d1:uD" });
    expect(toastForRow({ id: "2", kind: "checkout_message", title: "Alice posted to X", body: "hi", resource_id: "d1", actor_user_id: "uA" }))
      .toEqual({ type: "info", title: "Alice posted to X", message: "hi", duration: NOTIFICATION_TOAST_MS, coalesceKey: "checkout_message:d1:uA" });
    expect(NOTIFICATION_TOAST_MS).toBe(6000);
  });

  it("a hold placed keeps its amber, FYI time; a mention stays blue; a legacy kind is FYI", () => {
    expect(toastForRow({ id: "1", kind: "hold_opened", title: "t", body: null })).toMatchObject({ type: "warning", duration: 6000 });
    expect(toastForRow({ id: "2", kind: "ticket_mention", title: "t", body: null })).toMatchObject({ type: "info", duration: 6000 });
    expect(toastForRow({ id: "3", kind: "task_nudge", title: "t", body: null })).toMatchObject({ type: "info", duration: 6000 });
  });

  it("RT-11 dw2 / OS-4 dw2: the coalesce key is the event — kind, resource and actor; a row about no resource keeps the content key (two unrelated messages never merge)", () => {
    expect(toastForRow({ id: "1", kind: "doc_superseded", title: "a", body: null, resource_id: "doc-9" }).coalesceKey).toBe("doc_superseded:doc-9:");
    expect(toastForRow({ id: "2", kind: "orchestrator_message", title: "a", body: null, resource_id: null }).coalesceKey).toBeUndefined();
    expect(LISTENER).toContain('`${row.kind}:${row.resource_id}:${row.actor_user_id ?? ""}`');
  });

  it("two people's acts on one resource are two events (the merged card would name the first): Bob's and Carol's sign-offs keep their own keys; one person's repeat shares one", () => {
    const bob = toastForRow({ id: "1", kind: "review_signed", title: "Bob signed off on P-1", body: null, resource_id: "p1", actor_user_id: "uB" });
    const carol = toastForRow({ id: "2", kind: "review_signed", title: "Carol signed off on P-1", body: null, resource_id: "p1", actor_user_id: "uC" });
    const bobAgain = toastForRow({ id: "3", kind: "review_signed", title: "Bob signed off on P-1", body: null, resource_id: "p1", actor_user_id: "uB" });
    expect(bob.coalesceKey).not.toBe(carol.coalesceKey);
    expect(bob.coalesceKey).toBe(bobAgain.coalesceKey);
    // a system row (no actor) about one resource still keys on kind + resource
    expect(toastForRow({ id: "4", kind: "review_due", title: "x", body: null, resource_id: "p1", actor_user_id: null }).coalesceKey)
      .toBe(toastForRow({ id: "5", kind: "review_due", title: "y", body: null, resource_id: "p1" }).coalesceKey);
  });
});

describe("RT-2 / TAX-4 — one checkout-thread post: one toast per participant, none for anyone else", () => {
  it("TAX-4 dw4: postActivity → exactly one toast for each participant and watcher, zero for the author and for an uninvolved member", async () => {
    bus.tables.documents = [{ id: "d1", library_id: "L1", document_number: "P-1204-03", title: "P&ID" }];
    // Pat posted earlier in this checkout (a participant); Wes watches the document.
    bus.tables.checkout_messages = [{ id: "m0", org_id: "o1", document_id: "d1", episode_id: "e1", user_id: "uP", user_name: "Pat", text: "starting", kind: "chat" }];
    bus.tables.subscriptions = [{ user_id: "uW", resource_type: "document", resource_id: "d1" }];
    bus.tables.checkout_sessions = [];
    for (const uid of ["uA", "uP", "uW", "uU"]) await mountListener(uid);

    await act(async () => {
      await postActivity({ orgId: "o1", documentId: "d1", episodeId: "e1", text: "pressure relief sizing looks wrong on sheet 3", userId: "uA", userName: "Alice" });
    });
    await flush();

    // The post itself landed (the thread line) — and nothing listens to that table any more.
    expect((bus.tables.checkout_messages ?? []).length).toBe(2);
    expect(bus.subs.some((s) => s.table === "checkout_messages")).toBe(false);
    // The durable row reached the participant and the watcher, not the author.
    expect((bus.tables.notifications ?? []).map((r) => r.user_id).sort()).toEqual(["uP", "uW"]);
    expect(toastsOf("uP")).toHaveLength(1);
    expect(toastsOf("uP")[0]).toMatchObject({ type: "info", title: "Alice posted to P-1204-03", message: "pressure relief sizing looks wrong on sheet 3", coalesceKey: "checkout_message:d1:uA" });
    expect(toastsOf("uW")).toHaveLength(1);
    expect(toastsOf("uA")).toHaveLength(0);
    // RT-2 dw3 / TAX-4 dw3: the member with no part in the document hears nothing.
    expect(toastsOf("uU")).toHaveLength(0);
  });

  it("a system line in the thread (a forced release) toasts nobody; the holder's own checkout_released row does — amber, and it stays (TAX-3 dw1 / dw3 / dw4)", async () => {
    for (const uid of ["uH", "uP", "uU"]) await mountListener(uid);
    const { supabase } = await import("@/lib/supabase");
    await act(async () => {
      await (supabase.from("checkout_messages") as unknown as { insert: (r: Row) => unknown }).insert({
        org_id: "o1", document_id: "d1", user_id: "system", user_name: "System", kind: "system",
        text: "SYSTEM ALERT: checkout force-released by Dana. All sessions ended.",
      });
    });
    await insertNotification({ user_id: "uH", kind: "checkout_released", title: "Your checkout was force-released", body: "Dana force-released the checkout.", resource_id: "d1" });
    await flush();
    expect(toastsOf("uU")).toEqual([]);
    expect(toastsOf("uP")).toEqual([]);
    expect(toastsOf("uH")).toEqual([
      { uid: "uH", type: "warning", title: "Your checkout was force-released", message: "Dana force-released the checkout.", duration: 0, coalesceKey: "checkout_released:d1:" },
    ]);
  });

  it("the listener's source subscribes to one table, filtered to the member — the org-wide channel, its seed and its id set are gone (RT-2 dw1, RT-5)", () => {
    expect(LISTENER).not.toMatch(/checkout-messages-|table: "checkout_messages"|org_id=eq\./);
    expect(LISTENER).not.toMatch(/isFirstRun|processedIds|seed\(/);
    expect(LISTENER.match(/postgres_changes/g)).toHaveLength(1);
    expect(LISTENER).toContain('table: "notifications", filter: `user_id=eq.${uid}`');
  });
});

describe("every notification still toasts its member (regression)", () => {
  it("each row addressed to the member toasts once, with its title and body; a duplicate delivery of the same row does not toast twice", async () => {
    await mountListener("u1");
    await insertNotification({ id: "n-1", user_id: "u1", kind: "ticket_mention", title: "Sam mentioned you", body: "on DR-12", resource_id: "t1" });
    await flush();
    expect(toastsOf("u1")).toEqual([{ uid: "u1", type: "info", title: "Sam mentioned you", message: "on DR-12", duration: 6000, coalesceKey: "ticket_mention:t1:" }]);
    // the same row delivered again (a reconnect replay)
    const sub = bus.subs.find((s) => s.table === "notifications")!;
    await act(async () => { sub.cb({ new: { id: "n-1", user_id: "u1", kind: "ticket_mention", title: "Sam mentioned you", body: "on DR-12" } }); });
    await flush();
    expect(toastsOf("u1")).toHaveLength(1);
    // another member's row is not this member's
    await insertNotification({ user_id: "u2", kind: "ticket_mention", title: "x", body: null });
    await flush();
    expect(toastsOf("u1")).toHaveLength(1);
  });

});

describe("TAX-9 dw4 — a burst is one summary, never one card per row", () => {
  it("40 rows in a burst: the first BURST_SHOWN_MAX toast one by one, the rest become one 'N more notifications' card when the window closes", async () => {
    vi.useFakeTimers();
    await mountListener("u1");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    for (let i = 0; i < 40; i++) {
      await insertNotification({ user_id: "u1", kind: "review_due", title: `Review due: P-${i}`, body: null, resource_id: `d${i}` });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(toastsOf("u1").map((t) => t.title)).toEqual(["Review due: P-0", "Review due: P-1"]);
    expect(BURST_SHOWN_MAX).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS); });
    expect(toastsOf("u1")).toHaveLength(3);
    expect(toastsOf("u1")[2]).toMatchObject({ type: "info", title: "38 more notifications", duration: 6000 });
    expect(burstSummary(1).title).toBe("1 more notification");
  });

  it("an action row is never folded into the summary and never waits; a lone row after the window toasts at once again", async () => {
    vi.useFakeTimers();
    await mountListener("u1");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    for (let i = 0; i < 5; i++) await insertNotification({ user_id: "u1", kind: "ack_requested", title: `Ack ${i}`, body: null, resource_id: `d${i}` });
    await insertNotification({ user_id: "u1", kind: "branch_open", title: "Branch opened on P-9", body: null, resource_id: "d9" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(toastsOf("u1").map((t) => t.title)).toEqual(["Ack 0", "Ack 1", "Branch opened on P-9"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS); });
    expect(toastsOf("u1").map((t) => t.title)).toEqual(["Ack 0", "Ack 1", "Branch opened on P-9", "3 more notifications"]);
    await insertNotification({ user_id: "u1", kind: "ticket_comment", title: "New comment", body: null, resource_id: "t1" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(toastsOf("u1").at(-1)!.title).toBe("New comment");
  });

  it("a window that holds one extra row shows it as itself, not as a summary", () => {
    const shown: string[] = [];
    let fire: (() => void) | null = null;
    const t = createNotificationToaster({
      show: (s) => shown.push(s.title), readPreference: async () => true, now: () => 0,
      setTimer: (cb) => { fire = cb; return 1; }, clearTimer: () => {},
    });
    return (async () => {
      for (const i of [1, 2, 3]) t.receive({ id: `n${i}`, kind: "ticket_comment", title: `c${i}`, body: null });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(shown).toEqual(["c1", "c2"]);
      fire!();
      expect(shown).toEqual(["c1", "c2", "c3"]);
    })();
  });

  it("a burst of one event (same kind, resource and actor) is one card: every repeat joins it and none is held for the summary; other events keep the two-card budget (OS-4 dw2, second review fix)", async () => {
    const shown: Array<{ title: string; coalesceKey?: string }> = [];
    let fire: (() => void) | null = null;
    const t = createNotificationToaster({
      show: (s) => shown.push({ title: s.title, coalesceKey: s.coalesceKey }), readPreference: async () => true, now: () => 0,
      setTimer: (cb, ms) => { if (ms === BURST_WINDOW_MS) fire = cb; return 1; }, clearTimer: () => {},
    });
    for (let i = 1; i <= 5; i++) t.receive({ id: `n${i}`, kind: "task_nudge", title: "Sam nudged you about P-7", body: null, resource_id: "p7", actor_user_id: "uS" });
    t.receive({ id: "o1", kind: "ticket_comment", title: "other 1", body: null, resource_id: "t1", actor_user_id: "uX" });
    t.receive({ id: "o2", kind: "ticket_comment", title: "other 2", body: null, resource_id: "t2", actor_user_id: "uX" });
    await new Promise((r) => setTimeout(r, 0));
    // five deliveries of the one event (ToastProvider merges them: one card ×5), then one more card
    expect(shown.map((x) => x.title)).toEqual([...Array(5).fill("Sam nudged you about P-7"), "other 1"]);
    expect(new Set(shown.slice(0, 5).map((x) => x.coalesceKey)).size).toBe(1);
    fire!();
    // only the third distinct event waited: it shows as itself
    expect(shown.map((x) => x.title).slice(6)).toEqual(["other 2"]);
  });

  it("each window's summary is its own card — two windows of '3 more' never read as '3 more ×2'", async () => {
    const shown: Array<{ title: string; coalesceKey?: string }> = [];
    let fire: (() => void) | null = null;
    const t = createNotificationToaster({
      show: (s) => shown.push({ title: s.title, coalesceKey: s.coalesceKey }), readPreference: async () => true, now: () => 0,
      setTimer: (cb, ms) => { if (ms === BURST_WINDOW_MS) fire = cb; return 1; }, clearTimer: () => {},
    });
    for (const w of [0, 1]) {
      for (let i = 0; i < 5; i++) t.receive({ id: `w${w}-${i}`, kind: "review_due", title: `due ${w}-${i}`, body: null, resource_id: `d${w}-${i}` });
      await new Promise((r) => setTimeout(r, 0));
      fire!();
    }
    const summaries = shown.filter((x) => x.title === "3 more notifications");
    expect(summaries).toHaveLength(2);
    expect(summaries[0].coalesceKey).toBeTruthy();
    expect(summaries[0].coalesceKey).not.toBe(summaries[1].coalesceKey);
  });

  it("the remembered ids are bounded (RT-5 dw2)", async () => {
    const shown: string[] = [];
    const t = createNotificationToaster({ show: (s) => shown.push(s.title), readPreference: async () => true, setTimer: () => 1, clearTimer: () => {} });
    for (let i = 0; i < SEEN_IDS_MAX + 10; i++) t.receive({ id: `n${i}`, kind: "checkout_conflict", title: `x${i}`, body: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toHaveLength(SEEN_IDS_MAX + 10);
    // the oldest id fell out of the window: a replay of it is a new delivery;
    // a replay of a recent one is not
    t.receive({ id: `n${SEEN_IDS_MAX + 9}`, kind: "checkout_conflict", title: "recent", body: null });
    t.receive({ id: "n0", kind: "checkout_conflict", title: "old", body: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(shown.slice(-1)).toEqual(["old"]);
  });
});

describe("RT-10 — the member's pop-up switch is read before a toast, re-read when the tab comes back, and fails open", () => {
  it("toast_enabled off: no toast at all (the bell row is untouched — the row still landed)", async () => {
    fx.pref.u1 = false;
    await mountListener("u1");
    await flush();
    await insertNotification({ user_id: "u1", kind: "checkout_conflict", title: "Conflict", body: null, resource_id: "d1" });
    await flush();
    expect(toastsOf("u1")).toEqual([]);
    expect((bus.tables.notifications ?? []).length).toBe(1);
  });

  it("switched back on in settings: the next toast follows once the tab comes back", async () => {
    fx.pref.u1 = false;
    await mountListener("u1");
    await flush();
    expect(fx.prefReads).toContain("u1");
    fx.pref.u1 = true;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    await insertNotification({ user_id: "u1", kind: "ticket_comment", title: "Back on", body: null, resource_id: "t1" });
    await flush();
    expect(toastsOf("u1").map((t) => t.title)).toEqual(["Back on"]);
  });

  it("a stale read is refreshed before the next toast (PREF_FRESH_MS); an unreadable preference shows toasts", async () => {
    let clock = 0;
    const reads: number[] = [];
    let pref: boolean | "throw" = true;
    const shown: string[] = [];
    const t = createNotificationToaster({
      show: (s) => shown.push(s.title), now: () => clock, setTimer: () => 1, clearTimer: () => {},
      readPreference: async () => { reads.push(clock); if (pref === "throw") throw new Error("x"); return pref; },
    });
    t.receive({ id: "a", kind: "checkout_conflict", title: "A", body: null });
    await new Promise((r) => setTimeout(r, 0));
    pref = false;
    clock = PREF_FRESH_MS - 1;
    t.receive({ id: "b", kind: "checkout_conflict", title: "B", body: null }); // still fresh: shown
    await new Promise((r) => setTimeout(r, 0));
    clock = PREF_FRESH_MS + 10;
    t.receive({ id: "c", kind: "checkout_conflict", title: "C", body: null }); // re-read: off
    await new Promise((r) => setTimeout(r, 0));
    pref = "throw";
    clock = 3 * PREF_FRESH_MS;
    t.receive({ id: "d", kind: "checkout_conflict", title: "D", body: null }); // unreadable: fail open
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toEqual(["A", "B", "D"]);
    expect(reads).toEqual([0, PREF_FRESH_MS + 10, 3 * PREF_FRESH_MS]);
  });

  it("a read that never answers fails open after PREF_READ_TIMEOUT_MS — a stalled request does not silence the tab (second review fix)", async () => {
    const shown: string[] = [];
    const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
    let reads = 0;
    const t = createNotificationToaster({
      show: (s) => shown.push(s.title), now: () => 0,
      setTimer: (cb, ms) => { const h = { cb, ms, cleared: false }; timers.push(h); return h; },
      clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
      readPreference: () => { reads++; return new Promise<boolean>(() => {}); }, // never settles
    });
    t.receive({ id: "a", kind: "checkout_released", title: "Your checkout was force-released", body: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toEqual([]); // waiting on the read…
    const timeout = timers.find((h) => h.ms === PREF_READ_TIMEOUT_MS && !h.cleared)!;
    expect(timeout).toBeTruthy();
    expect(PREF_READ_TIMEOUT_MS).toBe(3000);
    timeout.cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toEqual(["Your checkout was force-released"]); // …then fails open
    expect(reads).toBe(1);
  });

  it("a refresh never re-awaits a stalled read, and a late answer from an older read never overwrites a newer one (second review fix)", async () => {
    const shown: string[] = [];
    const answers: Array<(v: boolean) => void> = [];
    const t = createNotificationToaster({
      show: (s) => shown.push(s.title), now: () => 0, setTimer: () => 1, clearTimer: () => {},
      readPreference: () => new Promise<boolean>((resolve) => { answers.push(resolve); }),
    });
    t.refreshPreference(); // read #1 (mount) — stalls
    expect(answers).toHaveLength(1);
    t.refreshPreference(); // the tab comes back: read #2, not #1 again
    expect(answers).toHaveLength(2);
    answers[1](true); // the newer read answers: toasts on
    await new Promise((r) => setTimeout(r, 0));
    answers[0](false); // the stale read answers late: ignored for the cache
    await new Promise((r) => setTimeout(r, 0));
    t.receive({ id: "a", kind: "checkout_conflict", title: "A", body: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toEqual(["A"]);
    expect(answers).toHaveLength(2); // served from the newer read's cache
  });

  it("through the mounted listener: with every read stalled, a row still toasts once the timeout passes, and a tab return asks again rather than re-awaiting the stalled read", async () => {
    vi.useFakeTimers();
    fx.pref.u1 = "stall";
    await mountListener("u1");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fx.prefReads).toEqual(["u1"]);
    await insertNotification({ user_id: "u1", kind: "checkout_released", title: "Your checkout was force-released", body: null, resource_id: "d1" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(toastsOf("u1")).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(PREF_READ_TIMEOUT_MS); });
    expect(toastsOf("u1").map((x) => x.title)).toEqual(["Your checkout was force-released"]);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fx.prefReads).toEqual(["u1", "u1"]);
  });

  it("the settings page offers the switch now that the listener reads it (the N1 tripwire's other side)", () => {
    expect(TOAST_PREFERENCE_HONOURED).toBe(true);
    expect(LISTENER).toContain("readToastPreference(uid)");
  });
});
