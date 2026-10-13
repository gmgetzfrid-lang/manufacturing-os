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
  /** When set: the tickets result for one query, from the calls made on it. */
  ticketQuery: null as null | ((own: Array<{ method: string; args: unknown[] }>) => { data: unknown; error: unknown; count?: number | null }),
  documents: [] as Array<Record<string, unknown>>,
  pages: [] as Array<Array<Record<string, unknown>>>,
  listCalls: [] as Array<Record<string, unknown>>,
  listFails: false,
  total: 0,
  beyond: [] as Array<Record<string, unknown>>,
  beyondCalls: [] as unknown[],
  ticketsFail: false,
  reconcileCalls: [] as Array<{ orgId: string; ids: string[] }>,
  retire: [] as string[],
  /** When set: runs while the reconcile request is in flight (before it answers). */
  onReconcile: null as null | ((ids: string[]) => void),
  channels: [] as Array<{ name: string; ons: Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }>; status?: (s: string) => void }>,
  role: { roles: ["Viewer"], activeOrgId: "o1", uid: "u1", membershipState: "member" },
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    let isUpdate = false;
    const own: Array<{ method: string; args: unknown[] }> = [];
    for (const m of ["select", "eq", "not", "in", "order", "limit", "range", "is", "or", "gte", "lt"]) {
      q[m] = (...args: unknown[]) => { fx.calls.push({ table, method: m, args }); own.push({ method: m, args }); return q; };
    }
    q.update = (...args: unknown[]) => { isUpdate = true; fx.calls.push({ table, method: "update", args }); return q; };
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const result = isUpdate ? { data: null, error: null }
        : table === "tickets" ? (fx.ticketsFail ? { data: null, error: { message: "tickets down" }, count: null } : fx.ticketQuery ? fx.ticketQuery(own) : { data: fx.tickets, error: null, count: fx.ticketCount })
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
    const before = opts.before && typeof opts.before === "object" ? (opts.before as { createdAt: string }).createdAt : opts.before;
    const page = before ? fx.pages.findIndex((p) => p.length > 0 && String(p[0].createdAt) < String(before)) : 0;
    return page < 0 ? [] : (fx.pages[page] ?? []);
  },
  countUnread: async () => fx.total,
  listUnreadKindsBeyond: async (...args: unknown[]) => { fx.beyondCalls.push(args); return fx.beyond; },
  markRead: async () => {},
  markAllRead: async () => {},
}));
vi.mock("@/lib/notificationReconcile", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestReconcile: async (orgId: string, ids: string[]) => {
    fx.reconcileCalls.push({ orgId, ids });
    if (fx.onReconcile) { fx.onReconcile(ids); await new Promise((r) => setTimeout(r, 20)); }
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
  fx.calls = []; fx.tickets = []; fx.ticketCount = null; fx.ticketQuery = null; fx.documents = [];
  fx.pages = [[]]; fx.listCalls = []; fx.listFails = false; fx.total = 0; fx.beyond = []; fx.beyondCalls = []; fx.ticketsFail = false;
  fx.role = { roles: ["Viewer"], activeOrgId: "o1", uid: "u1", membershipState: "member" };
  fx.reconcileCalls = []; fx.retire = []; fx.onReconcile = null; fx.channels = [];
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

  it("the ticket read selects the attention columns only (never comments / history), with an exact count; a DELETE companion hears tickets deletes — of tickets the feed holds only", async () => {
    fx.tickets = [{ id: "t-held", status: "DRAFTING" }];
    await mount(withProvider(1));
    const select = fx.calls.find((c: Call) => c.table === "tickets" && c.method === "select")!;
    expect(select.args[0]).toBe(TICKET_ATTENTION_COLUMNS);
    expect(select.args[1]).toEqual({ count: "exact" });
    expect(TICKET_ATTENTION_COLUMNS).not.toMatch(/comments|history|\*/);
    for (const col of ["status", "request_type", "unit", "requester_role", "assigned_drafter_id", "assigned_engineer_id", "attachments", "unread_by"]) expect(TICKET_ATTENTION_COLUMNS).toContain(col);
    const companion = fx.channels[0].ons.find((o) => o.cfg.table === "tickets" && o.cfg.event === "DELETE");
    expect(companion?.cfg.filter).toBeUndefined();
    // Supabase sends every tenant's tickets DELETEs to the unfiltered companion: one this feed does not hold is no refetch
    act(() => companion!.cb({ eventType: "DELETE", old: { id: "another-tenants-ticket" } }));
    act(() => companion!.cb({}));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(1);
    act(() => companion!.cb({ eventType: "DELETE", old: { id: "t-held" } }));
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
      ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, kind: "ack_requested", resourceType: "document", resourceId: `old-${i}`, metadata: { ackRequest: true }, createdAt: "2026-10-01T00:00:00Z" })),
      ...Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, kind: "library_doc_added", resourceType: "document", resourceId: `old2-${i}`, metadata: null, createdAt: "2026-10-01T00:00:00Z" })),
    ];
    await mount(withProvider(1));
    expect(last().items.length).toBe(50);
    expect(last().count).toBe(120);
    expect(last().counts).toEqual({ all: 120, action: 10, activity: 110, notifications: 120 });
    expect(last().sectionCounts.documents).toEqual({ total: 120, actionRequired: 10 });
    expect(lastStatus()).toMatchObject({ notificationsShown: 50, notificationsTotal: 120, hasMoreNotifications: true });
    // the tally reads after the window's last row by the (created_at, id) keyset — never an offset
    expect(fx.beyondCalls[0]).toEqual(["o1", { createdAt: fx.pages[0][49].createdAt, id: fx.pages[0][49].id }, 1000]);
  });

  it("the action rows BELOW the window are sent for reconcile too; a discharged one leaves the badge and the action count", async () => {
    fx.pages = [page(0, 50)];
    fx.total = 53;
    fx.beyond = [
      { id: "b1", kind: "ack_requested", resourceType: "document", resourceId: "d-1", metadata: { ackRequest: true }, createdAt: "2026-10-01T00:00:00Z" },
      { id: "b2", kind: "ack_requested", resourceType: "document", resourceId: "d-2", metadata: { ackRequest: true }, createdAt: "2026-10-01T00:00:00Z" },
      { id: "b3", kind: "library_doc_added", resourceType: "document", resourceId: "d-3", metadata: null, createdAt: "2026-10-01T00:00:00Z" },
    ];
    fx.retire = ["b1"];
    await mount(withProvider(1));
    expect(fx.reconcileCalls[0].ids).toEqual(["b1", "b2"]);
    expect(last().count).toBe(52);
    expect(last().counts.action).toBe(1);
    expect(last().sectionCounts.documents).toEqual({ total: 52, actionRequired: 1 });
  });

  it("the cron's review-health nudge (review_overdue + metadata.reviewHealth) counts as activity, not action — in the window and below it (DEC-90 A11, review fix)", async () => {
    fx.pages = [[row(1, { kind: "review_overdue", metadata: { reviewHealth: true, reviewHealthDay: "2026-10-13" } }), row(2, { kind: "review_overdue", metadata: null }), ...page(3, 48)]];
    fx.total = 52;
    fx.beyond = [
      { id: "h1", kind: "review_overdue", resourceType: "document", resourceId: "d-h", metadata: { reviewHealth: true, reviewHealthDay: "2026-10-12" }, createdAt: "2026-10-01T00:00:00Z" },
      { id: "h2", kind: "review_overdue", resourceType: "document", resourceId: "d-e", metadata: null, createdAt: "2026-10-01T00:00:00Z" },
    ];
    await mount(withProvider(1));
    const health = last().items.find((i) => i.key === "notif:n1")!;
    expect(health.actionRequired).toBe(false);
    expect(last().items.find((i) => i.key === "notif:n2")!.actionRequired).toBe(true);
    // n2 in the window and h2 below it are actions; the two review-health rows are activity
    expect(last().counts).toEqual({ all: 52, action: 2, activity: 50, notifications: 52 });
    expect(last().sectionCounts.documents.actionRequired).toBe(2);
  });

  it("'Load older' pages the created_at cursor; marking one read moves the badge down by one", async () => {
    fx.pages = [page(0, 50), page(100, 50), page(200, 20)];
    fx.total = 120;
    await mount(withProvider(1));
    act(() => lastStatus().loadMoreNotifications());
    await wait(50);
    const second = fx.listCalls[fx.listCalls.length - 1];
    // a (created_at, id) cursor: a row sharing the last row's created_at is not skipped
    expect(second.before).toEqual({ createdAt: fx.pages[0][49].createdAt, id: fx.pages[0][49].id });
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

  it("a workspace switch clears the feed: a failed read in the new workspace shows nothing of the old one", async () => {
    fx.tickets = [{ id: "t-a", ticket_id: "A-1", title: "Org A ticket", status: "DRAFTING", unread_by: ["u1"] }];
    fx.pages = [page(0, 3)];
    fx.total = 3;
    await mount(withProvider(1));
    expect(last().items.length).toBe(4);
    expect(last().count).toBe(4);
    // RoleContext.setActiveOrgId: activeOrgId changes, membershipState stays 'member'
    fx.role = { ...fx.role, activeOrgId: "o2" };
    fx.listFails = true;
    fx.ticketsFail = true;
    fx.total = 0;
    await mount(withProvider(1));
    await wait(50);
    expect(last().items).toEqual([]);
    expect(last().count).toBe(0);
    expect(last().items.some((i) => i.title.includes("Org A"))).toBe(false);
    expect(lastStatus().error).toMatch(/could not be loaded/);
    // a refetch within the same workspace still keeps its own last good read
    fx.listFails = false; fx.ticketsFail = false; fx.tickets = []; fx.pages = [page(10, 2)]; fx.total = 2;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(last().items.length).toBe(2);
    fx.listFails = true;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(last().items.length).toBe(2);
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
  /** The realtime UPDATE's new record for a row the feed holds: the row as the
   *  database has it (snake_case), with `change` applied. */
  const dbRow = (r: ReturnType<typeof row>, change: Record<string, unknown> = {}) => ({
    id: r.id, org_id: r.orgId, user_id: r.userId, kind: r.kind, title: r.title, body: r.body, link: r.link,
    resource_type: r.resourceType, resource_id: r.resourceId, actor_user_id: r.actorUserId, actor_name: r.actorName,
    metadata: r.metadata, read_at: r.readAt, created_at: r.createdAt, ...change,
  });
  /** The reconcile route's mark: metadata.superseded_at (toISOString), nothing else. */
  const serverMark = (r: ReturnType<typeof row>) => dbRow(r, { metadata: { ...((r.metadata as Record<string, unknown> | null) ?? {}), superseded_at: new Date().toISOString() } });

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
    const n3 = row(3, { kind: "hold_opened" }), n6 = row(6, { kind: "library_doc_revised" });
    fx.pages = [[n3, n6]];
    fx.total = 2;
    fx.retire = ["n3"];
    await mount(withProvider(1));
    expect(last().items.map((i) => i.notificationId)).toEqual(["n6"]);
    expect(last().count).toBe(1);
    const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
    const before = ticketFetches();
    act(() => notifs.cb({ eventType: "UPDATE", new: serverMark(n3) }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(before);
    act(() => notifs.cb({ eventType: "UPDATE", new: dbRow(n6, { read_at: new Date().toISOString() }) }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(before + 1);
  });

  it("RT-8 (third review fix): the server's mark that arrives BEFORE the reconcile answer is not a refetch; a kept candidate's later change is", async () => {
    const n3 = row(3, { kind: "hold_opened" }), n5 = row(5, { kind: "ack_requested" }), n6 = row(6, { kind: "library_doc_revised" });
    fx.pages = [[n3, n5, n6]];
    fx.total = 3;
    fx.retire = ["n3"];
    // The server writes before it answers: the UPDATE for n3 lands while the POST is still in flight.
    fx.onReconcile = () => {
      const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
      notifs.cb({ eventType: "UPDATE", new: serverMark(n3) });
    };
    await mount(withProvider(1));
    const before = ticketFetches();
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(fx.reconcileCalls[0].ids).toEqual(["n3", "n5"]);
    expect(ticketFetches()).toBe(before);
    expect(last().items.map((i) => i.notificationId)).toEqual(["n5", "n6"]);
    // n5 was kept: its change refetches
    const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
    act(() => notifs.cb({ eventType: "UPDATE", new: dbRow(n5, { title: "edited" }) }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(before + 1);
  });

  it("RT-8 (fourth review fix): the recipient's own mark-read on a candidate while the request is in flight refetches AT ONCE — it is never taken for the server's echo", async () => {
    const n3 = row(3, { kind: "hold_opened" }), n5 = row(5, { kind: "ack_requested" });
    fx.pages = [[n3, n5]];
    fx.total = 2;
    fx.retire = [];   // the server reads n5 as read and keeps it; n3 is still owed
    let refetchesDuringFlight = -1;
    fx.onReconcile = () => {
      const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
      // The bell's markRead changes read_at only — no local removal; the feed relies on this UPDATE.
      notifs.cb({ eventType: "UPDATE", new: dbRow(n5, { read_at: new Date().toISOString() }) });
      refetchesDuringFlight = ticketFetches();
    };
    await mount(withProvider(1));
    const after = ticketFetches();
    expect(refetchesDuringFlight).toBe(after);
    // the refetch was scheduled by the UPDATE itself (the debounce), not by a poll or the next trigger
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(after + 1);
  });

  it("RT-8 (fourth review fix): only EXACTLY the reconcile's mark is passed over — the workflow route's mark (superseded_by), a mark with read_at, another field, or a mark on a row the server did not retire all refetch", async () => {
    const n3 = row(3, { kind: "hold_opened", metadata: { staleHoldId: "h1" } }), n4 = row(4, { kind: "branch_open", metadata: { branchId: "b1" } }), n5 = row(5, { kind: "ack_requested" });
    fx.pages = [[n3, n4, n5]];
    fx.total = 3;
    fx.retire = ["n3", "n4"];
    const now = () => new Date().toISOString();
    fx.onReconcile = () => {
      const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
      // n5: a mark of the reconcile's shape, but the server will NOT report retiring it — decided at the answer
      notifs.cb({ eventType: "UPDATE", new: serverMark(n5) });
    };
    await mount(withProvider(1));
    const base = ticketFetches();
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(base + 1);   // n5's held-back mark was not the server's: refetched
    const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
    const b = ticketFetches();
    // n3 retired: an echo that also stamps another metadata key is not the reconcile's mark
    act(() => notifs.cb({ eventType: "UPDATE", new: dbRow(n3, { metadata: { staleHoldId: "h1", superseded_at: now(), superseded_by: "close" } }) }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(b + 1);
    // n4 retired: a mark that also sets read_at is the recipient's act too
    act(() => notifs.cb({ eventType: "UPDATE", new: dbRow(n4, { metadata: { branchId: "b1", superseded_at: now() }, read_at: now() }) }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(b + 2);
  });

  it("RT-8 (fourth review fix): a retired row's echo is passed over once; a second UPDATE to it refetches", async () => {
    const n3 = row(3, { kind: "hold_opened" });
    fx.pages = [[n3]];
    fx.total = 1;
    fx.retire = ["n3"];
    await mount(withProvider(1));
    const notifs = fx.channels[0].ons.find((o) => o.cfg.table === "notifications")!;
    const b = ticketFetches();
    act(() => notifs.cb({ eventType: "UPDATE", new: serverMark(n3) }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(b);
    act(() => notifs.cb({ eventType: "UPDATE", new: serverMark(n3) }));
    await wait(FETCH_DEBOUNCE_MS + 150);
    expect(ticketFetches()).toBe(b + 1);
  });

  it("DF-P3 EDGE-7 (fix pass 3 bell-rows limb, re-owned by N4): an SLA notice stays while its request is open — not hidden, not sent — and is retired only once it is CLOSED / CANCELED", async () => {
    const sla = (n: number, ticket: string, action: string) => row(n, { kind: "ticket_status", resourceType: "ticket", resourceId: ticket, metadata: { action, status: "DRAFTING", sla: action === "sla_breach" ? "breach" : "warn" } });
    fx.tickets = [
      { id: "t-moved", status: "PENDING_REVIEW" },   // open-to-open: still late
      { id: "t-closed", status: "CLOSED" },
      { id: "t-canceled", status: "CANCELED" },
      { id: "t-wf", status: "PENDING_REVIEW" },
    ];
    fx.pages = [[
      sla(1, "t-moved", "sla_breach"), sla(2, "t-moved", "sla_warning"),
      sla(3, "t-closed", "sla_breach"), sla(4, "t-canceled", "sla_warning"),
      sla(5, "t-gone", "sla_breach"),                 // the ticket is not in the workspace any more
      wf(6, "t-wf", "DRAFTING"),                      // an ordinary alert: moot once the status moved
    ]];
    fx.total = 6;
    await mount(withProvider(1));
    const shown = last().items.map((i) => i.notificationId).filter(Boolean);
    expect(shown).toEqual(expect.arrayContaining(["n1", "n2"]));
    for (const gone of ["n3", "n4", "n5", "n6"]) expect(shown).not.toContain(gone);
    expect(fx.reconcileCalls[0].ids).toEqual(["n3", "n4", "n5", "n6"]);
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

describe("TRAIL-7 — ticket paging (review fix): no duplicates across pages; a drafter's closed tickets are one capped read", () => {
  const trow = (i: number, over: Record<string, unknown> = {}) => ({ id: `t${i}`, org_id: "o1", ticket_id: `DR-${i}`, title: `T ${i}`, status: "DRAFTING", requester_id: "u1", unread_by: ["u1"], last_modified: "2026-10-13T00:00:00Z", ...over });

  it("a ticket modified between two page reads (it moves into a page already read) appears once — one item, counted once", async () => {
    fx.ticketQuery = (own) => {
      const range = own.find((c) => c.method === "range");
      if (!range) return { data: Array.from({ length: 500 }, (_, i) => trow(i)), error: null, count: 600 };
      // page 2: t499 was modified meanwhile and is read again, then 99 more
      return { data: [trow(499), ...Array.from({ length: 99 }, (_, i) => trow(500 + i))], error: null, count: null };
    };
    await mount(withProvider(1));
    const keys = last().items.filter((i) => i.source === "ticket").map((i) => i.key);
    expect(keys.length).toBe(599);
    expect(new Set(keys).size).toBe(599);
    expect(last().sectionCounts.requests.total).toBe(599);
    expect(lastStatus()).toMatchObject({ ticketsLoaded: 599, ticketsTotal: 600 });
  });

  it("a drafter: the assigned OPEN tickets are paged with a count, the assigned closed ones are ONE uncounted, unpaged read (an unread closed ticket still shows), and 'N of M open requests' counts open ones", async () => {
    fx.role = { roles: ["Drafter"], activeOrgId: "o1", uid: "u1", membershipState: "member" };
    const kindOf = (own: Array<{ method: string; args: unknown[] }>) =>
      own.some((c) => c.method === "in" && c.args[0] === "status") ? "closed"
        : own.some((c) => c.method === "eq" && c.args[0] === "assigned_drafter_id") ? "open" : "pool";
    fx.ticketQuery = (own) => {
      const k = kindOf(own);
      if (k === "closed") return { data: Array.from({ length: 500 }, (_, i) => trow(9000 + i, { status: "CLOSED", unread_by: i === 0 ? ["u1"] : [] })), error: null, count: 4000 };
      if (k === "open") return { data: [trow(1, { assigned_drafter_id: "u1" })], error: null, count: 1 };
      return { data: [], error: null, count: 0 };
    };
    await mount(withProvider(1));
    const ticketCalls = fx.calls.filter((c: Call) => c.table === "tickets");
    // the open assigned scope carries the status filter
    expect(ticketCalls.some((c) => c.method === "not" && c.args[0] === "status")).toBe(true);
    // the closed scope: exactly one read, no count, never ranged
    const closedSelects = ticketCalls.filter((c, i) => c.method === "select" && ticketCalls.slice(i, i + 6).some((x) => x.method === "in" && x.args[0] === "status"));
    expect(closedSelects.length).toBe(1);
    expect(closedSelects[0].args[1]).toBeUndefined();
    expect(ticketCalls.filter((c) => c.method === "range").length).toBe(0);
    // the unread closed ticket is in the feed, as before the paging
    expect(last().items.some((i) => i.key === "ticket:t9000")).toBe(true);
    // 'of M open requests': the closed rows are not counted as open requests, and nothing reads as cut
    expect(lastStatus()).toMatchObject({ ticketsLoaded: 1, ticketsTotal: 1 });
  });
});
