// @vitest-environment jsdom
//
// notifications Round G, N4 — RT-10's remaining limb: per-category pop-up
// toast switches.
//
//   * Every kind names its category in lib/notificationKinds.ts KIND_META —
//     one of the email toggles' five — so no seventh classification exists.
//   * readToastPreferences reads the master switch and the five
//     toast_on_<category> columns (20261200); before the paste it reads the
//     master switch alone, and before 20261148 nothing (all on). A read that
//     answers with any other error throws, so the listener keeps the last
//     value it read (the N3 hand-off's residual for readToastPreference).
//   * The toaster shows a row only when the master switch AND its kind's
//     category are on; a held burst row is dropped when its category is off.
//   * The settings page offers the five switches beside "Pop-up toasts" and
//     saves them, and saves the rest when the columns are not there yet.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const q = vi.hoisted(() => ({
  results: [] as Array<{ data: unknown; error: null | { code: string; message: string } }>,
  selects: [] as string[],
  row: null as Record<string, unknown> | null,
  upserts: [] as Array<Record<string, unknown>>,
  upsertResults: [] as Array<{ error: null | { code: string; message: string } }>,
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: (c: string) => { q.selects.push(c); return b; },
        eq: () => b,
        maybeSingle: async () => (q.results.length > 0 ? q.results.shift()! : { data: q.row, error: null }),
        upsert: async (row: Record<string, unknown>) => { q.upserts.push(row); return q.upsertResults.shift() ?? { data: null, error: null }; },
      });
      return b;
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "u1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import { KIND_META, NOTIFICATION_KINDS, TOAST_CATEGORIES } from "@/lib/notificationKinds";
import {
  readToastPreferences, toastAllowed, normalizeToastPreference, TOAST_CATEGORY_COLUMNS, TOAST_PREFERENCE_ALL_ON,
  type ToastPreference,
} from "@/lib/notificationPrefs";
import { createNotificationToaster, BURST_WINDOW_MS } from "@/components/providers/NotificationListener";
import NotificationSettingsPage from "@/app/(protected)/settings/notifications/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const allOn = (): ToastPreference => ({ enabled: true, categories: { ...TOAST_PREFERENCE_ALL_ON.categories } });

beforeEach(() => {
  q.results = []; q.selects = []; q.row = null; q.upserts = []; q.upsertResults = [];
});

describe("KIND_META.category — the email toggles' five categories, one per kind", () => {
  it("every kind has a category, and the categories are exactly the email_on_* suffixes", () => {
    expect([...TOAST_CATEGORIES]).toEqual(["mention", "assignment", "status_change", "watched_activity", "sla_warning"]);
    for (const k of NOTIFICATION_KINDS) expect(TOAST_CATEGORIES, k).toContain(KIND_META[k].category);
    // spot checks of what a member expects each switch to govern
    expect(KIND_META.ticket_mention.category).toBe("mention");
    expect(KIND_META.orchestrator_message.category).toBe("mention");
    expect(KIND_META.ticket_assigned.category).toBe("assignment");
    expect(KIND_META.ack_requested.category).toBe("assignment");
    expect(KIND_META.review_requested.category).toBe("assignment");
    expect(KIND_META.ticket_status.category).toBe("status_change");
    expect(KIND_META.hold_opened.category).toBe("status_change");
    expect(KIND_META.checkout_conflict.category).toBe("status_change");
    expect(KIND_META.ticket_comment.category).toBe("watched_activity");
    expect(KIND_META.checkout_message.category).toBe("watched_activity");
    expect(KIND_META.review_overdue.category).toBe("sla_warning");
    expect(KIND_META.checkout_released.category).toBe("sla_warning");
  });
});

describe("toastAllowed — the master switch, then the kind's category", () => {
  it("off master: nothing; a category off: only its kinds; a legacy kind follows the master alone", () => {
    expect(toastAllowed({ ...allOn(), enabled: false }, "ticket_mention")).toBe(false);
    const noMentions = { enabled: true, categories: { ...allOn().categories, mention: false } };
    expect(toastAllowed(noMentions, "ticket_mention")).toBe(false);
    expect(toastAllowed(noMentions, "ticket_comment")).toBe(true);
    expect(toastAllowed(noMentions, "task_nudge")).toBe(true);
    // a drawing recall is a safety message: no per-category switch mutes its pop-up (the master switch still does)
    const noStatus = { enabled: true, categories: { ...allOn().categories, status_change: false } };
    expect(KIND_META.doc_recalled.category).toBe("status_change");
    expect(toastAllowed(noStatus, "doc_recalled")).toBe(true);
    expect(toastAllowed(noStatus, "doc_superseded")).toBe(false);
    expect(toastAllowed({ ...noStatus, enabled: false }, "doc_recalled")).toBe(false);
    expect(normalizeToastPreference(false)).toEqual({ ...allOn(), enabled: false });
    expect(normalizeToastPreference(true)).toEqual(allOn());
  });
});

describe("readToastPreferences — the master switch and the five categories", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it("reads toast_enabled and the five toast_on_* columns for this member", async () => {
    q.results.push({ data: { toast_enabled: true, toast_on_mention: false, toast_on_assignment: true, toast_on_status_change: true, toast_on_watched_activity: false, toast_on_sla_warning: true }, error: null });
    const p = await readToastPreferences("u1");
    expect(q.selects).toEqual([["toast_enabled", ...TOAST_CATEGORY_COLUMNS].join(", ")]);
    expect(p).toEqual({ enabled: true, categories: { mention: false, assignment: true, status_change: true, watched_activity: false, sla_warning: true } });
  });

  it("no row or no uid: everything on", async () => {
    expect(await readToastPreferences("u1")).toEqual(allOn());
    expect(await readToastPreferences(null)).toEqual(allOn());
  });

  it("before 20261200: the master switch alone; before 20261148 too: everything on", async () => {
    q.results.push({ data: null, error: { code: "42703", message: "column notification_preferences.toast_on_mention does not exist" } });
    q.results.push({ data: { toast_enabled: false }, error: null });
    expect(await readToastPreferences("u1")).toEqual({ ...allOn(), enabled: false });
    expect(q.selects[1]).toBe("toast_enabled");
    q.results.push({ data: null, error: { code: "42703", message: "column notification_preferences.toast_on_mention does not exist" } });
    q.results.push({ data: null, error: { code: "42703", message: "column notification_preferences.toast_enabled does not exist" } });
    expect(await readToastPreferences("u1")).toEqual(allOn());
  });

  it("any other error throws — the listener then keeps the last value it actually read", async () => {
    q.results.push({ data: null, error: { code: "57014", message: "statement timeout" } });
    await expect(readToastPreferences("u1")).rejects.toThrow(/statement timeout/);
  });
});

describe("the toaster honours each category", () => {
  it("a category off: its rows do not toast; the others do; a held burst row of an off category is dropped", async () => {
    const shown: string[] = [];
    const timers: Array<() => void> = [];
    const pref: ToastPreference = { enabled: true, categories: { ...allOn().categories, watched_activity: false } };
    const t = createNotificationToaster({
      show: (s) => shown.push(s.title), now: () => 0,
      setTimer: (cb) => { timers.push(cb); return timers.length; }, clearTimer: () => {},
      readPreference: async () => pref,
    });
    t.receive({ id: "1", kind: "ticket_comment", title: "comment", body: null, resource_id: "t1" });
    t.receive({ id: "2", kind: "ticket_mention", title: "mention", body: null, resource_id: "t1" });
    t.receive({ id: "3", kind: "ticket_status", title: "status", body: null, resource_id: "t1" });
    t.receive({ id: "4", kind: "checkout_message", title: "thread", body: null, resource_id: "d1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toEqual(["mention", "status"]);
    expect(BURST_WINDOW_MS).toBeGreaterThan(0);
  });
});

// ── the settings page ──────────────────────────────────────────────────────
let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const sw = (label: string) => host.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLButtonElement | null;
const save = async () => {
  const btn = [...host.querySelectorAll("button")].find((b) => /Save preferences/.test(b.textContent ?? ""))!;
  await act(async () => { btn.click(); });
  await flush();
};

describe("RT-10 — the settings page offers a pop-up switch per category", () => {
  beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("five switches beside 'Pop-up toasts', loaded from the row, saved as toast_on_*", async () => {
    q.row = { user_id: "u1", toast_enabled: true, toast_on_mention: false, digest_frequency: "instant" };
    await act(async () => { root.render(React.createElement(NotificationSettingsPage)); });
    await flush();
    const labels = ["Pop-ups for mentions", "Pop-ups for assignments and requests", "Pop-ups for status changes", "Pop-ups for watched activity", "Pop-ups for overdue and at-risk items"];
    for (const l of labels) expect(sw(l), l).not.toBeNull();
    expect(sw("Pop-ups for mentions")!.getAttribute("aria-checked")).toBe("false");
    await act(async () => { sw("Pop-ups for watched activity")!.click(); });
    await save();
    expect(q.upserts[0]).toMatchObject({ toast_on_mention: false, toast_on_watched_activity: false, toast_on_assignment: true, toast_on_status_change: true, toast_on_sla_warning: true, toast_enabled: true });
  });

  it("before 20261200: the rest saves, and the page says a category setting did not", async () => {
    q.upsertResults.push({ error: { code: "PGRST204", message: "Could not find the 'toast_on_mention' column of 'notification_preferences' in the schema cache" } });
    await act(async () => { root.render(React.createElement(NotificationSettingsPage)); });
    await flush();
    await act(async () => { sw("Pop-ups for mentions")!.click(); });
    await save();
    expect(q.upserts).toHaveLength(2);
    for (const c of TOAST_CATEGORY_COLUMNS) expect(q.upserts[1], c).not.toHaveProperty(c);
    expect(q.upserts[1].toast_enabled).toBe(true);
    expect(host.textContent).toContain("the per-category pop-up settings were not saved");
  });
});
