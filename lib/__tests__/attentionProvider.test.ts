// @vitest-environment jsdom
//
// notifications Round G, N4 FEED-PROVIDER-AND-REALTIME — the tab's one
// attention feed (components/providers/AttentionProvider.tsx,
// hooks/useTicketNotifications.ts useAttentionFeedState).
//
//   RT-3 / TRAIL-8  one subscription and one fetch per tab, however many
//                   consumers; a burst of ticket writes is ONE refetch.
//   RT-1            a rejoin reconciles; an error / timeout says "stale";
//                   the tab coming back refetches.
//   RT-8            the reconcile pass runs after the read, once, and its
//                   echo is ignored; the browser writes no metadata.
//   TAX-6 / DELIV-10 / TRAIL-7 / PROD-7
//                   the count is exact (countUnread) whatever the page size;
//                   older pages load by a created_at cursor; a failed read
//                   is an error, never "all caught up".
//   TRAIL-12        a document row with no link opens its library, never a
//                   search for its id.
//   REGRESSION      the hook's export name and return shape are unchanged;
//                   outside the provider every consumer still works alone.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Call = { table: string; method: string; args: unknown[] };
const fx = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  tickets: [] as Array<Record<string, unknown>>,
  ticketCount: null as number | null,
  documents: [] as Array<Record<string, unknown>>,
  pages: [] as Array<Array<Record<string, unknown>>>,
  listCalls: [] as Array<Record<string, unknown>>,
  listFails: false,
  total: 0,
  beyond: [] as Array<{ kind: string; resourceId: string | null }>,
  reconcileCalls: [] as Array<{ orgId: string; ids: string[] }>,
  retire: [] as string[],
  channels: [] as Array<{ name: string; ons: Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }>; status?: (s: string) => void }>,
  role: { roles: ["Viewer"], activeOrgId: "o1", uid: "u1", membershipState: "member" },
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    let isUpdate = false;
    for (const m of ["select", "eq", "not", "in", "order", "limit", "range", "is", "or", "gte", "lt"]) {
      q[m] = (...args: unknown[]) => { fx.calls.push({ table, method: m, args }); return q; };
    }
    q.update = (...args: unknown[]) => { isUpdate = true; fx.calls.push({ table, method: "update", args }); return q; };
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const result = isUpdate ? { data: null, error: null }
        : table === "tickets" ? { data: fx.tickets, error: null, count: fx.ticketCount }
        : table === "documents" ? { data: fx.documents, error: null }
        : { data: [], error: null, count: 0 };
      return Promise.resolve(result).then(ok, ko);
    };
    return q;
  };
  return {
    supabase: {
      from: (t: string) => chain(t),
      channel: (name: string) => {
        const c = { name, ons: [] as Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }>, status: undefined as undefined | ((s: string) => void) };
        fx.channels.push(c);
        const api: Record<string, unknown> = {
          on: (_e: string, cfg: Record<string, unknown>, cb: (p: unknown) => void) => { c.ons.push({ cfg, cb }); return api; },
          subscribe: (cb?: (s: string) => void) => { c.status = cb; return api; },
        };
        return api;
      },
      removeChannel: () => {},
    },
  };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => fx.role }));
vi.mock("@/lib/capabilityPolicy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCapabilityPolicy: async () => undefined,
}));
vi.mock("@/lib/inAppNotifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMyNotifications: async (opts: Record<string, unknown>) => {
    fx.listCalls.push(opts);
    if (fx.listFails) throw new Error("connection reset");
    const page = opts.before ? fx.pages.findIndex((p) => p.length > 0 && String(p[0].createdAt) < String(opts.before)) : 0;
    return page < 0 ? [] : (fx.pages[page] ?? []);
  },
  countUnread: async () => fx.total,
  listUnreadKindsBeyond: async () => fx.beyond,
  markRead: async () => {},
  markAllRead: async () => {},
}));
vi.mock("@/lib/notificationReconcile", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestReconcile: async (orgId: string, ids: string[]) => {
    fx.reconcileCalls.push({ orgId, ids });
    return { retired: ids.filter((i) => fx.retire.includes(i)), kept: 0, failed: 0 };
  },
}));

import { AttentionProvider } from "@/components/providers/AttentionProvider";
import {
  useTicketNotifications, useAttentionStatus, TICKET_ATTENTION_COLUMNS, FETCH_DEBOUNCE_MS,
  type AttentionStatus,
} from "@/hooks/useTicketNotifications";
import { AttentionFeed } from "@/components/cockpit/AttentionFeed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const seen: Array<ReturnType<typeof useTicketNotifications>> = [];
const statuses: AttentionStatus[] = [];
function Probe() {
  const v = useTicketNotifications();
  const s = useAttentionStatus();
  React.useEffect(() => { seen.push(v); statuses.push(s); });
  return null;
}
const last = () => seen[seen.length - 1];
const lastStatus = () => statuses[statuses.length - 1];
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const wait = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); await flush(); };
const ticketFetches = () => fx.calls.filter((c: Call) => c.table === "tickets" && c.method === "limit").length;
const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: `n${n}`, orgId: "o1", userId: "u1", kind: "library_doc_revised", title: `t ${n}`, body: null, link: `/x/${n}`,
  resourceType: "document", resourceId: `doc-${n}`, actorUserId: null, actorName: null, metadata: null, readAt: null,
  createdAt: `2026-10-${String(13 - Math.floor(n / 100)).padStart(2, "0")}T00:${String(59 - (n % 60)).padStart(2, "0")}:00Z`, ...over,
});
const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i));
const mount = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); await flush(); };
const withProvider = (n: number) => React.createElement(AttentionProvider, null, ...Array.from({ length: n }, (_, i) => React.createElement(Probe, { key: i })));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  seen.length = 0; statuses.length = 0;
  fx.calls = []; fx.tickets = []; fx.ticketCount = null; fx.documents = [];
  fx.pages = [[]]; fx.listCalls = []; fx.listFails = false; fx.total = 0; fx.beyond = [];
  fx.reconcileCalls = []; fx.retire = []; fx.channels = [];
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("RT-3 / TRAIL-8 — one subscription and one fetch per tab", () => {
  it("five consumers under the provider share ONE channel and ONE fetch; the hook's return shape is unchanged", async () => {
    await mount(withProvider(5));
    expect(fx.channels.length).toBe(1);
    expect(ticketFetches()).toBe(1);
    expect(fx.listCalls.length).toBe(1);
    expect(Object.keys(last()).sort()).toEqual(["actionRequiredCount", "count", "counts", "items", "loading", "markAllRead", "markRead", "sectionCounts", "unreadCount"]);
  });

  it("outside the provider each consumer still runs its own feed (a test, a preview) — the old behaviour, unchanged", async () => {
    await mount(React.createElement(React.Fragment, null, React.createElement(Probe), React.createElement(Probe)));
    expect(fx.channels.length).toBe(2);
    expect(useAttentionStatus).toBeTypeOf("function");
    expect(lastStatus().stale).toBe(false);
  });

  it("a burst of ticket writes is ONE trailing refetch", async () => {
    await mount(withProvider(3));
    const tickets = fx.channels[0].ons.find((o) => o.cfg.table === "tickets" && o.cfg.filter)!;
    for (let i = 0; i < 6; i++) act(() => tickets.cb({}));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(2);
  });

  it("the ticket read selects the attention columns only (never comments / history), with an exact count; a DELETE companion hears tickets deletes", async () => {
    await mount(withProvider(1));
    const select = fx.calls.find((c: Call) => c.table === "tickets" && c.method === "select")!;
    expect(select.args[0]).toBe(TICKET_ATTENTION_COLUMNS);
    expect(select.args[1]).toEqual({ count: "exact" });
    expect(TICKET_ATTENTION_COLUMNS).not.toMatch(/comments|history|\*/);
    for (const col of ["status", "request_type", "unit", "requester_role", "assigned_drafter_id", "assigned_engineer_id", "attachments", "unread_by"]) expect(TICKET_ATTENTION_COLUMNS).toContain(col);
    const companion = fx.channels[0].ons.find((o) => o.cfg.table === "tickets" && o.cfg.event === "DELETE");
    expect(companion?.cfg.filter).toBeUndefined();
    act(() => companion!.cb({}));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(2);
  });
});

describe("RT-1 — reconnect, refocus, and a visible stale state", () => {
  it("the first join fetches nothing more; an error says stale; the rejoin clears it and reconciles", async () => {
    await mount(withProvider(1));
    const ch = fx.channels[0];
    act(() => ch.status!("SUBSCRIBED"));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(1);
    act(() => ch.status!("CHANNEL_ERROR"));
    await flush();
    expect(lastStatus().stale).toBe(true);
    act(() => ch.status!("SUBSCRIBED"));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(lastStatus().stale).toBe(false);
    expect(ticketFetches()).toBe(2);
    act(() => ch.status!("TIMED_OUT"));
    await flush();
    expect(lastStatus().stale).toBe(true);
  });

  it("the tab coming back (visibilitychange / focus) refetches", async () => {
    await mount(withProvider(1));
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(2);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(3);
  });
});

describe("TAX-6 / DELIV-10 / TRAIL-7 / PROD-7 — a true count, older pages, a failed read said", () => {
  it("the badge is the exact count, not the page: 50 loaded of 120 — the 70 below count by section and action", async () => {
    fx.pages = [page(0, 50), page(100, 50), page(200, 20)];
    fx.total = 120;
    fx.beyond = [
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "ack_requested", resourceId: `old-${i}` })),
      ...Array.from({ length: 60 }, (_, i) => ({ kind: "library_doc_added", resourceId: `old2-${i}` })),
    ];
    await mount(withProvider(1));
    expect(last().items.length).toBe(50);
    expect(last().count).toBe(120);
    expect(last().counts).toEqual({ all: 120, action: 10, activity: 110, notifications: 120 });
    expect(last().sectionCounts.documents).toEqual({ total: 120, actionRequired: 10 });
    expect(lastStatus()).toMatchObject({ notificationsShown: 50, notificationsTotal: 120, hasMoreNotifications: true });
  });

  it("'Load older' pages the created_at cursor; marking one read moves the badge down by one", async () => {
    fx.pages = [page(0, 50), page(100, 50), page(200, 20)];
    fx.total = 120;
    await mount(withProvider(1));
    act(() => lastStatus().loadMoreNotifications());
    await wait(50);
    const second = fx.listCalls[fx.listCalls.length - 1];
    expect(second.before).toBe(fx.pages[0][49].createdAt);
    expect(last().items.length).toBe(100);
    expect(last().count).toBe(120);
    fx.total = 119;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(last().count).toBe(119);
  });

  it("a failed notification read is an error the feed says, and keeps the last good rows — never 'all caught up'", async () => {
    fx.pages = [page(0, 3)];
    fx.total = 3;
    await mount(withProvider(1));
    expect(last().items.length).toBe(3);
    fx.listFails = true;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(last().items.length).toBe(3);
    expect(lastStatus().error).toMatch(/could not be loaded/);
  });

  it("first-load failure: the feed surface says nothing could be loaded instead of 'You're all caught up'", async () => {
    fx.listFails = true;
    function Feed() {
      const { items, counts } = useTicketNotifications();
      return React.createElement(AttentionFeed, { items, counts, filter: "all", onFilter: () => {}, onMarkRead: () => {}, onMarkAll: () => {}, markingAll: false });
    }
    await mount(React.createElement(AttentionProvider, null, React.createElement(Feed)));
    expect(host.textContent).toContain("this is not \"all caught up\"");
    expect(host.textContent).not.toContain("You're all caught up");
    expect(host.querySelector("[data-attention-status]")?.getAttribute("role")).toBe("alert");
  });

  it("the feed says 'Showing the newest N of M' with 'Load older' when rows sit below the window", async () => {
    fx.pages = [page(0, 50), page(100, 10)];
    fx.total = 60;
    function Feed() {
      const { items, counts } = useTicketNotifications();
      return React.createElement(AttentionFeed, { items, counts, filter: "all", onFilter: () => {}, onMarkRead: () => {}, onMarkAll: () => {}, markingAll: false });
    }
    await mount(React.createElement(AttentionProvider, null, React.createElement(Feed)));
    const bar = host.querySelector("[data-attention-truncation]") as HTMLElement;
    expect(bar.textContent).toContain("Showing the newest 50 of 60 unread notifications.");
    const btn = [...bar.querySelectorAll("button")].find((b) => b.textContent?.includes("Load older"))!;
    await act(async () => { btn.click(); });
    await wait(50);
    expect(host.querySelector("[data-attention-truncation]")).toBeNull();
  });
});

describe("RT-8 / NEDGE-18 / TRAIL-9 — the reconcile pass: after the read, on the server, its echo ignored", () => {
  const wf = (n: number, ticket: string, status: string) => row(n, { kind: "ticket_status", resourceType: "ticket", resourceId: ticket, metadata: { action: "assign", status } });

  it("stale workflow alerts are left out at once and sent with the other candidates; the browser writes nothing", async () => {
    fx.tickets = [{ id: "t-live", status: "DRAFTING" }, { id: "t-moved", status: "PENDING_REVIEW" }];
    fx.pages = [[
      wf(1, "t-live", "DRAFTING"), wf(2, "t-moved", "DRAFTING"),
      row(3, { kind: "hold_opened" }), row(4, { kind: "ticket_comment", resourceType: "ticket", resourceId: "t-x" }),
      row(5, { kind: "ack_requested" }),
    ]];
    fx.total = 5;
    await mount(withProvider(3));
    expect(fx.reconcileCalls.length).toBe(1);
    expect(fx.reconcileCalls[0]).toEqual({ orgId: "o1", ids: ["n2", "n3", "n5"] });
    expect(last().items.map((i) => i.notificationId).filter(Boolean)).not.toContain("n2");
    expect(fx.calls.filter((c: Call) => c.method === "update")).toEqual([]);
  });

  it("a row the server retired leaves the feed and the count; its realtime echo is not a refetch, another row's change is", async () => {
    fx.pages = [[row(3, { kind: "hold_opened" }), row(6, { kind: "library_doc_revised" })]];
    fx.total = 2;
    fx.retire = ["n3"];
    await mount(withProvider(1));
    expect(last().items.map((i) => i.notificationId)).toEqual(["n6"]);
    expect(last().count).toBe(1);
    const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
    const before = ticketFetches();
    act(() => notifs.cb({ eventType: "UPDATE", new: { id: "n3" } }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(before);
    act(() => notifs.cb({ eventType: "UPDATE", new: { id: "n6" } }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(before + 1);
  });

  it("a row the server kept is not re-sent on the next fetch (one pass, not one per refetch)", async () => {
    fx.pages = [[row(3, { kind: "hold_opened" })]];
    fx.total = 1;
    await mount(withProvider(1));
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(fx.reconcileCalls.length).toBe(1);
  });
});

describe("TRAIL-12 — a document row without a link opens its library", () => {
  it("resolved in one batched read; unresolved opens Documents; never a search for a raw id", async () => {
    fx.pages = [[row(1, { link: null, resourceId: "d-known" }), row(2, { link: null, resourceId: "d-unknown" })]];
    fx.total = 2;
    fx.documents = [{ id: "d-known", library_id: "lib-9" }];
    await mount(withProvider(1));
    const links = Object.fromEntries(last().items.map((i) => [i.notificationId, i.link]));
    expect(links.n1).toBe("/documents/lib-9?doc=d-known");
    expect(links.n2).toBe("/documents");
    expect(fx.calls.filter((c: Call) => c.table === "documents" && c.method === "in").length).toBe(1);
    for (const l of Object.values(links)) expect(l).not.toMatch(/^\/search/);
  });
});
