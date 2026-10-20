// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P16 QUEUE HISTORY AND OUTCOME BREAKDOWN —
// ROUTE-13 done-when 1: any closed or canceled request of the workspace can
// be reached from the queue, whatever the history holds.
//
// The integrator's ruling under DEC-90 (fail-safe, no regression): closed
// and canceled requests are reachable ON DEMAND — the open queue's read,
// counts, Needs-me lens, realtime debounce and exports stay exactly as they
// are; the closed history is read only when asked, with the same keyset
// reader (lib/ticketQueueRead.ts), the same failure and short-read wording,
// and the same role scope (Contractor included).
//
//   lib/ticketQueueRead.ts — readQueueScope's `after` start and `cursor`
//   answer (a read from the start is exactly as before), the search filter,
//   the date cursor, the chunk fold.
//   app/(protected)/requests/page.tsx — AS RENDERED: a closed request past
//   the queue's ceiling, unreachable in the queue (reproduced — the banner
//   says older closed requests are not listed), is reached through Closed
//   history; nothing reads it until it is opened; the queue's reads, counts,
//   Needs me and realtime re-reads are unchanged with it open; a failed and
//   a short history read are said; search and date narrow it on the server;
//   the history reads the queue's own role scope.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  readQueueScope, foldHistoryChunk, historySearchFilter, historyBeforeCursor, HISTORY_CHUNK, HISTORY_SEARCH_MAX,
  type QueueQuery,
} from "@/lib/ticketQueueRead";

type Row = Record<string, unknown>;
type Call = { m: string; a: unknown[] };

const s = vi.hoisted(() => ({
  role: { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1" } as Record<string, unknown>,
  tickets: [] as Array<Record<string, unknown>>,
  maxRows: 1000,
  reads: [] as Array<Array<{ m: string; a: unknown[] }>>,
  failWhen: null as null | ((calls: Array<{ m: string; a: unknown[] }>) => boolean),
  countBonus: 0,
  noCount: false,
  channels: [] as Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }>,
  ceiling: null as number | null,
}));

/** Unescape a PostgREST double-quoted value. */
const unq = (v: string) => v.replace(/\\(.)/g, "$1");

/** The keyset `or` (the reader's two shapes), or null. */
function keysetOf(calls: Call[]): ((r: Row) => boolean) | null {
  const or = calls.filter((c) => c.m === "or").map((c) => String(c.a[0])).find((x) => /^(and\()?last_modified\./.test(x));
  if (!or) return null;
  const nullRegion = /^and\(last_modified\.is\.null,id\.lt\."([^"]+)"\),last_modified\.not\.is\.null$/.exec(or);
  if (nullRegion) {
    const id = nullRegion[1];
    return (r) => (r.last_modified == null ? String(r.id) < id : true);
  }
  const valued = /^last_modified\.lt\."([^"]+)",and\(last_modified\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/.exec(or);
  if (valued) {
    const [, lm, , id] = valued;
    const t = Date.parse(lm);
    return (r) => r.last_modified != null && (Date.parse(String(r.last_modified)) < t || (Date.parse(String(r.last_modified)) === t && String(r.id) < id));
  }
  throw new Error(`unexpected keyset filter: ${or}`);
}

/** A LIKE pattern (backslash escapes) as a case-insensitive RegExp. */
function likeRe(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%") out += ".*";
    else if (c === "_") out += ".";
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "is");
}

/** The search `or` (ticket_id / title ilike), as PostgREST applies it. */
function searchOf(calls: Call[]): ((r: Row) => boolean) | null {
  const or = calls.filter((c) => c.m === "or").map((c) => String(c.a[0])).find((x) => x.startsWith("ticket_id.ilike."));
  if (!or) return null;
  const m = /^ticket_id\.ilike\.("(?:[^"\\]|\\.)*"),title\.ilike\.("(?:[^"\\]|\\.)*")$/.exec(or);
  if (!m) throw new Error(`unexpected search filter: ${or}`);
  const re = likeRe(unq(m[1].slice(1, -1)));
  return (r) => re.test(String(r.ticket_id ?? "")) || re.test(String(r.title ?? ""));
}

function filtered(calls: Call[]): Row[] {
  let out = [...s.tickets];
  for (const c of calls) {
    if (c.m === "eq") out = out.filter((r) => r[String(c.a[0])] === c.a[1]);
    if (c.m === "in") out = out.filter((r) => (c.a[1] as unknown[]).includes(r[String(c.a[0])]));
    if (c.m === "not" && c.a[1] === "in") {
      const list = String(c.a[2]).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
      out = out.filter((r) => !list.includes(String(r[String(c.a[0])])));
    }
  }
  const search = searchOf(calls);
  return search ? out.filter(search) : out;
}

const order = (a: Row, b: Row) => {
  const la = a.last_modified as string | null | undefined, lb = b.last_modified as string | null | undefined;
  if (la == null && lb != null) return -1;
  if (lb == null && la != null) return 1;
  if (la != null && lb != null && la !== lb) return la < lb ? 1 : -1;
  return String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0;
};

function serveTickets(calls: Call[]): { data: unknown; error: unknown; count?: number } {
  s.reads.push(calls);
  if (s.failWhen?.(calls)) return { data: null, error: { message: "canceling statement due to statement timeout" } };
  const scoped = filtered(calls);
  const keyset = keysetOf(calls);
  const rows = (keyset ? scoped.filter(keyset) : scoped).sort(order);
  const limit = (calls.find((c) => c.m === "limit")?.a[0] as number | undefined) ?? Infinity;
  const wantsCount = (calls.find((c) => c.m === "select")?.a[1] as { count?: string } | undefined)?.count === "exact";
  const counted = keyset ? rows.length : scoped.length;
  return { data: rows.slice(0, Math.min(limit, s.maxRows)), error: null, ...(wantsCount && !s.noCount ? { count: counted + s.countBonus } : {}) };
}

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ ...s.role, hasAnyRole: (r: string[]) => r.some((x) => (s.role.roles as string[]).includes(x)) }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(async () => undefined), appConfirm: vi.fn(async () => true) }));
vi.mock("@/components/ui/UserAvatar", () => ({ default: () => null }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ ok: true, error: null })) }));
// The QUEUE's reads (no `after`, ceiling unset) run under a test-sized
// ceiling when `s.ceiling` is set; the history passes its own chunk ceiling.
vi.mock("@/lib/ticketQueueRead", async (orig) => {
  const real = await orig<typeof import("@/lib/ticketQueueRead")>();
  return {
    ...real,
    readQueueScope: (build: Parameters<typeof real.readQueueScope>[0], opts?: Parameters<typeof real.readQueueScope>[1]) =>
      real.readQueueScope(build, s.ceiling && !opts?.ceiling ? { ...opts, ceiling: s.ceiling } : opts),
  };
});
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadCapabilityPolicyEntry: async () => ({ policy: undefined, version: null }),
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const calls: Call[] = [];
    const api: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "in", "order", "is", "limit", "or", "lt", "gt", "range"]) {
      api[m] = (...a: unknown[]) => { calls.push({ m, a }); return api; };
    }
    api.single = async () => ({ data: null, error: null });
    api.maybeSingle = async () => ({ data: null, error: null });
    api.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      let result: unknown;
      if (table === "tickets") result = serveTickets(calls);
      else if (table === "org_members" && calls.some((c) => c.m === "in")) result = { data: [], error: null };
      else if (table === "org_members") result = { data: null, error: null, count: 4 };
      else result = { data: [], error: null };
      return Promise.resolve(result).then(ok, ko);
    };
    return api;
  };
  const channelApi: Record<string, unknown> = {};
  channelApi.on = (_e: string, cfg: Record<string, unknown>, cb: (p: unknown) => void) => { s.channels.push({ cfg, cb }); return channelApi; };
  channelApi.subscribe = () => channelApi;
  return {
    supabase: {
      from: (t: string) => chain(t),
      channel: () => channelApi,
      removeChannel: () => {},
      auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
    },
  };
});

import RequestsPage from "@/app/(protected)/requests/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pad = (n: number) => String(n).padStart(5, "0");
const row = (id: string, over: Row = {}): Row => ({
  id, org_id: "org-1", ticket_id: `KE-${id}`, title: `Title ${id}`, unit: "U-100", request_type: "ISO",
  status: "CLOSED", requester_id: "r-1", requester_name: "Rita", assigned_drafter_id: "d-1", assigned_drafter_name: "Dan",
  attachments: [], comments: [], history: [], unread_by: [], created_at: "2026-01-01T00:00:00.000Z",
  last_modified: "2026-10-13T10:00:00.000Z", ...over,
});
/** n requests, newest-modified first by index (one minute apart); closed unless overridden. */
const bulk = (n: number, over: (i: number) => Row = () => ({}), prefix = "c"): Row[] =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${pad(i)}`, { last_modified: new Date(Date.parse("2026-10-13T10:00:00.000Z") - i * 60_000).toISOString(), ...over(i) }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  s.role = { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1" };
  s.tickets = []; s.maxRows = 1000; s.reads = []; s.failWhen = null; s.countBonus = 0; s.noCount = false; s.channels = []; s.ceiling = null;
  try { localStorage.clear(); } catch { /* none */ }
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

const tick = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0)));
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await tick(); }); };
const mount = async () => { await act(async () => { root!.render(React.createElement(RequestsPage)); }); await flush(); };
const q = <T extends HTMLElement>(sel: string) => host!.querySelector(sel) as T | null;
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const queueRowIds = () => Array.from(host!.querySelectorAll("tbody a[href^='/requests/']")).map((a) => a.getAttribute("href")).filter((h, i, all) => all.indexOf(h) === i);
const historyIds = () => Array.from(host!.querySelectorAll("[data-testid=closed-history-row]")).map((a) => a.getAttribute("href"));
/** The history's reads: the ones that ask for status IN (CLOSED, CANCELED). */
const historyReads = () => s.reads.filter((calls) => calls.some((c) => c.m === "in" && c.a[0] === "status"));
const queueReads = () => s.reads.filter((calls) => !calls.some((c) => c.m === "in" && c.a[0] === "status"));
const type = async (el: HTMLInputElement | null, value: string) => {
  expect(el).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submitFind = async () => {
  const form = q("[data-testid=closed-history-find]")?.closest("form");
  expect(form).toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await flush();
};

// ─── the reader ───────────────────────────────────────────────────────────────

const builder = (filters: Call[] = [{ m: "eq", a: ["org_id", "org-1"] }]) => (counted: boolean): QueueQuery => {
  const calls: Call[] = [{ m: "select", a: ["*", counted ? { count: "exact" } : undefined] }, ...filters];
  const api = {
    order: (...a: unknown[]) => { calls.push({ m: "order", a }); return api; },
    limit: (...a: unknown[]) => { calls.push({ m: "limit", a }); return api; },
    or: (...a: unknown[]) => { calls.push({ m: "or", a }); return api; },
    then: (ok: (v: never) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(serveTickets(calls)).then(ok as (v: unknown) => unknown, ko),
  };
  return api as unknown as QueueQuery;
};

describe("ROUTE-13 done-when 1 — the reader reads on from where it stopped", () => {
  it("REGRESSION: a read from the start is as before (the same requests; the first page counted) and now says where it stopped", async () => {
    s.tickets = bulk(30);
    const r = await readQueueScope(builder(), { pageSize: 10, ceiling: 25 });
    expect(r).toMatchObject({ ok: true, total: 30, complete: false, capped: true });
    if (!r.ok) return;
    expect(r.rows.map((x) => x.id)).toEqual([...s.tickets].sort(order).slice(0, 25).map((x) => x.id));
    expect(r.cursor).toEqual({ lm: r.rows[24].last_modified, id: r.rows[24].id });
    expect(s.reads[0].find((c) => c.m === "select")?.a[1]).toEqual({ count: "exact" });
    expect(s.reads[0].some((c) => c.m === "or")).toBe(false);
  });

  it("`after` carries on strictly after that row, asks for no count, and reaches the oldest row past any ceiling", async () => {
    s.tickets = bulk(30);
    const first = await readQueueScope(builder(), { ceiling: 12 });
    expect(first.ok && first.capped).toBe(true);
    if (!first.ok) return;
    const second = await readQueueScope(builder(), { ceiling: 12, after: first.cursor });
    const third = await readQueueScope(builder(), { ceiling: 12, after: second.ok ? second.cursor : null });
    expect(second.ok && third.ok).toBe(true);
    if (!second.ok || !third.ok) return;
    expect(second.total).toBeNull();
    const all = [...first.rows, ...second.rows, ...third.rows].map((x) => x.id);
    expect(all).toEqual([...s.tickets].sort(order).map((x) => x.id));
    expect(third).toMatchObject({ capped: false, complete: true });
    // the continuation asked for no count, and started after the cursor
    const contSelect = s.reads[1].find((c) => c.m === "select")?.a[1];
    expect(contSelect).toBeUndefined();
    expect(String(s.reads[1].find((c) => c.m === "or")?.a[0])).toMatch(/^last_modified\.lt\."/);
  });

  it("foldHistoryChunk: rows once each, the first chunk's count, `next` while more may exist, `short` when it ended short of the count", () => {
    const ok = (rows: Row[], o: Partial<{ total: number | null; capped: boolean; complete: boolean }> = {}) => ({
      ok: true as const, rows, total: o.total ?? null, capped: o.capped ?? false, complete: o.complete ?? true,
      cursor: rows.length ? { lm: String(rows[rows.length - 1].last_modified), id: String(rows[rows.length - 1].id) } : null,
    });
    const rs = bulk(5);
    const a = foldHistoryChunk(null, ok(rs.slice(0, 2), { total: 5, capped: true, complete: false }));
    expect(a).toMatchObject({ total: 5, short: false });
    expect(a.next).toEqual({ lm: rs[1].last_modified, id: rs[1].id });
    const b = foldHistoryChunk(a, ok([rs[1], ...rs.slice(2, 4)], { capped: true, complete: false }));
    expect(b.rows.map((r) => r.id)).toEqual(rs.slice(0, 4).map((r) => r.id)); // rs[1] once
    expect(b.next).not.toBeNull();
    const c = foldHistoryChunk(b, ok(rs.slice(4)));
    expect(c).toMatchObject({ next: null, short: false, total: 5 });
    // the count reached exactly at a chunk's end: nothing more to read
    expect(foldHistoryChunk(null, ok(rs, { total: 5, capped: true, complete: true })).next).toBeNull();
    // read to the end with fewer rows than counted: short, said
    expect(foldHistoryChunk(null, ok(rs.slice(0, 4), { total: 5, complete: false }))).toMatchObject({ next: null, short: true });
    // a server that ignored the keyset (stalled, no count): short
    expect(foldHistoryChunk(null, ok(rs.slice(0, 2), { complete: false }))).toMatchObject({ next: null, short: true });
  });

  it("historySearchFilter: number or title, case-insensitive, quoted; % and _ are literal; blank is no filter; bounded", () => {
    expect(historySearchFilter("  ")).toBeNull();
    expect(historySearchFilter("pump iso")).toBe('ticket_id.ilike."%pump iso%",title.ilike."%pump iso%"');
    // a comma, a parenthesis and a quote stay inside the quoted value
    expect(historySearchFilter('a,b (c) "d"')).toBe('ticket_id.ilike."%a,b (c) \\"d\\"%",title.ilike."%a,b (c) \\"d\\"%"');
    // LIKE wildcards are escaped (the backslash doubled for the quoted value)
    expect(historySearchFilter("50%_x")).toBe('ticket_id.ilike."%50\\\\%\\\\_x%",title.ilike."%50\\\\%\\\\_x%"');
    const long = historySearchFilter("x".repeat(500))!;
    expect(long).toContain(`"%${"x".repeat(HISTORY_SEARCH_MAX)}%"`);
    expect(long).not.toContain("x".repeat(HISTORY_SEARCH_MAX + 1));
  });

  it("historyBeforeCursor: the end of that day (the viewer's calendar), every id; junk is no cursor", () => {
    const c = historyBeforeCursor("2025-03-14");
    expect(c).not.toBeNull();
    expect(c!.id).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(Date.parse(c!.lm!)).toBe(new Date("2025-03-14T23:59:59.999").getTime());
    expect(historyBeforeCursor("")).toBeNull();
    expect(historyBeforeCursor("14/03/2025")).toBeNull();
    expect(historyBeforeCursor("2025-13-45")).toBeNull();
  });
});

// ─── the queue, as rendered ───────────────────────────────────────────────────

/** A workspace whose history passes the queue's (test-sized) ceiling: 450
 *  closed or canceled requests touched recently, 3 open ones older, and the
 *  closed request from eighteen months ago — the oldest row of all. */
function bigHistory() {
  s.ceiling = 50;
  s.tickets = [
    ...bulk(450, (i) => ({ status: i % 7 === 0 ? "CANCELED" : "CLOSED" })),
    ...Array.from({ length: 3 }, (_, i) => row(`o${i}`, { status: "DRAFTING", last_modified: `2026-03-0${i + 1}T00:00:00.000Z` })),
    row("ancient", { status: "CLOSED", title: "Tank farm relief header", ticket_id: "KE-0042", last_modified: "2025-04-01T00:00:00.000Z", outcome: "completed" }),
  ];
}

describe("ROUTE-13 done-when 1 — a closed request past the ceiling is reached from the queue (rendered)", () => {
  it("REPRODUCED: the queue holds only the 50 most recent closed requests and says older ones are not listed — the old one is not in it", async () => {
    bigHistory();
    await mount();
    expect(q("[data-testid=requests-read-short]")?.textContent).toMatch(/Older closed and canceled requests are not listed here/);
    await click(q("[data-testid=view-all]"));
    expect(queueRowIds()).not.toContain("/requests/ancient");
    expect(host!.textContent).not.toContain("Tank farm relief header");
  });

  it("nothing reads the closed history until it is opened", async () => {
    bigHistory();
    await mount();
    expect(historyReads()).toEqual([]);
    expect(q("[data-testid=closed-history]")).toBeNull();
    expect(q("[data-testid=closed-history-toggle]")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("Closed history reaches it: the newest 200 first (N of M), then Show older until the oldest request — every closed and canceled one, once", async () => {
    bigHistory();
    await mount();
    await click(q("[data-testid=closed-history-from-banner]"));
    expect(q("[data-testid=closed-history]")).toBeTruthy();
    expect(historyIds().length).toBe(HISTORY_CHUNK);
    expect(q("[data-testid=closed-history-count]")?.textContent).toMatch(/Showing the 200 most recently active of the 451 closed and canceled requests\. Show older reads the next 200\./);
    // every history read: closed and canceled only, the queue's scope, ordered, keyset-paged
    for (const calls of historyReads()) {
      expect(calls).toEqual(expect.arrayContaining([
        { m: "eq", a: ["org_id", "org-1"] },
        { m: "in", a: ["status", ["CLOSED", "CANCELED"]] },
        { m: "order", a: ["last_modified", { ascending: false }] },
        { m: "order", a: ["id", { ascending: false }] },
      ]));
    }
    await click(q("[data-testid=closed-history-older]"));
    expect(historyIds().length).toBe(400);
    await click(q("[data-testid=closed-history-older]"));
    expect(historyIds().length).toBe(451);
    expect(historyIds().at(-1)).toBe("/requests/ancient");
    expect(new Set(historyIds()).size).toBe(451);
    expect(historyIds().some((h) => /\/requests\/o\d/.test(String(h)))).toBe(false); // no open request in it
    expect(q("[data-testid=closed-history-older]")).toBeNull();
    expect(q("[data-testid=closed-history-count]")?.textContent).toMatch(/All 451 closed and canceled requests in this workspace are listed\./);
    // the row says what it is: number, title, status in words, how it ended
    const li = Array.from(host!.querySelectorAll("[data-testid=closed-history-list] li")).at(-1)!;
    expect(li.textContent).toContain("KE-0042");
    expect(li.textContent).toContain("Tank farm relief header");
    expect(li.textContent).toContain("Closed");
    expect(li.textContent).toContain("Completed");
  });

  it("REGRESSION: the open queue is exactly as before with the history open — its reads, list, Needs me, All, and realtime re-reads", async () => {
    bigHistory();
    await mount();
    const before = {
      reads: queueReads().length,
      needs: q("[data-testid=view-needs-me]")?.textContent,
      all: q("[data-testid=view-all]")?.textContent,
      total: /\d+ Total Records/.exec(host!.textContent ?? "")?.[0],
      short: q("[data-testid=requests-read-short]")?.textContent?.replace(/Open Closed history to find any of them\./, ""),
    };
    await click(q("[data-testid=closed-history-toggle]"));
    await click(q("[data-testid=closed-history-older]"));
    expect(queueReads().length).toBe(before.reads); // opening and paging the history read nothing of the queue
    expect(q("[data-testid=view-needs-me]")?.textContent).toBe(before.needs);
    expect(q("[data-testid=view-all]")?.textContent).toBe(before.all);
    expect(/\d+ Total Records/.exec(host!.textContent ?? "")?.[0]).toBe(before.total);
    expect(q("[data-testid=requests-read-short]")?.textContent?.replace(/Open Closed history to find any of them\./, "")).toBe(before.short);
    // a tickets event re-reads the queue (500 ms debounce, unchanged) and never the history
    const histBefore = historyReads().length;
    const listener = s.channels.find((c) => c.cfg.event === "*")!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await act(async () => { listener.cb({}); });
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(queueReads().length).toBe(before.reads);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flush();
    expect(queueReads().length).toBeGreaterThan(before.reads);
    expect(historyReads().length).toBe(histBefore);
    vi.useRealTimers();
    // closing it leaves the queue as it was
    await click(q("[data-testid=closed-history-close]"));
    expect(q("[data-testid=closed-history]")).toBeNull();
    expect(q("[data-testid=view-all]")?.textContent).toBe(before.all);
  });

  it("REGRESSION: a normal workspace's queue reads exactly as before (one request, no status IN filter), and the toggle is there", async () => {
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }), row("t2", { status: "CLOSED", last_modified: "2026-10-12T10:00:00.000Z" })];
    await mount();
    expect(s.reads.length).toBe(1);
    expect(s.reads[0].some((c) => c.m === "in")).toBe(false);
    expect(q("[data-testid=closed-history-toggle]")?.textContent).toMatch(/Closed history/);
    expect(q("[data-testid=closed-history-from-banner]")).toBeNull(); // no banner when nothing is bounded
  });

  it("a failed history read is SAID with Try again — never an empty history — and the queue is untouched", async () => {
    bigHistory();
    await mount();
    const all = q("[data-testid=view-all]")?.textContent;
    s.failWhen = (calls) => calls.some((c) => c.m === "in" && c.a[0] === "status");
    await click(q("[data-testid=closed-history-toggle]"));
    const alert = q("[data-testid=closed-history-failed]");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toMatch(/The closed history could not be read — canceling statement due to statement timeout\. Nothing is shown rather than a list that may be missing requests\./);
    expect(historyIds()).toEqual([]);
    expect(q("[data-testid=closed-history-empty]")).toBeNull();
    expect(q("[data-testid=view-all]")?.textContent).toBe(all);
    s.failWhen = null;
    await click(Array.from(host!.querySelectorAll("[data-testid=closed-history-failed] button")).find((b) => /Try again/.test(b.textContent ?? "")) ?? null);
    expect(q("[data-testid=closed-history-failed]")).toBeNull();
    expect(historyIds().length).toBe(HISTORY_CHUNK);
  });

  it("a failed 'Show older' keeps what was read and says nothing past it is shown; Try again carries on", async () => {
    bigHistory();
    await mount();
    await click(q("[data-testid=closed-history-toggle]"));
    s.failWhen = (calls) => calls.some((c) => c.m === "in" && c.a[0] === "status") && calls.some((c) => c.m === "or");
    await click(q("[data-testid=closed-history-older]"));
    expect(q("[data-testid=closed-history-failed]")?.textContent).toMatch(/The older closed requests could not be read — .*What is listed is as read so far; nothing past it is shown\./);
    expect(historyIds().length).toBe(HISTORY_CHUNK);
    s.failWhen = null;
    await click(Array.from(host!.querySelectorAll("[data-testid=closed-history-failed] button")).find((b) => /Try again/.test(b.textContent ?? "")) ?? null);
    expect(historyIds().length).toBe(400);
  });

  it("a short history read says N of M with the queue's wording", async () => {
    s.tickets = bulk(5);
    s.countBonus = 1; // the first page counted a request the pages no longer see
    await mount();
    await click(q("[data-testid=closed-history-toggle]"));
    expect(historyIds().length).toBe(5);
    expect(q("[data-testid=closed-history-count]")?.textContent).toMatch(/This list shows 5 of the 6 requests in this view — requests changed while it was being read\. Refresh to read it again\./);
  });

  it("search narrows on the server (number or title), counted; a blank Find reads the newest again", async () => {
    bigHistory();
    await mount();
    await click(q("[data-testid=closed-history-toggle]"));
    await type(q<HTMLInputElement>("[data-testid=closed-history-search]"), "relief HEADER");
    await submitFind();
    expect(historyIds()).toEqual(["/requests/ancient"]);
    const last = historyReads().at(-1)!;
    expect(last).toEqual(expect.arrayContaining([{ m: "or", a: ['ticket_id.ilike."%relief HEADER%",title.ilike."%relief HEADER%"'] }]));
    expect(q("[data-testid=closed-history-count]")?.textContent).toMatch(/All 1 closed and canceled requests matching “relief HEADER” are listed\./);
    // by number
    await type(q<HTMLInputElement>("[data-testid=closed-history-search]"), "ke-0042");
    await submitFind();
    expect(historyIds()).toEqual(["/requests/ancient"]);
    // nothing matches: said
    await type(q<HTMLInputElement>("[data-testid=closed-history-search]"), "no such words");
    await submitFind();
    expect(q("[data-testid=closed-history-empty]")?.textContent).toMatch(/No closed and canceled requests matching “no such words” were found\./);
    await type(q<HTMLInputElement>("[data-testid=closed-history-search]"), "");
    await submitFind();
    expect(historyIds().length).toBe(HISTORY_CHUNK);
  });

  it("'last active on or before' starts the read at that day, on the server", async () => {
    bigHistory();
    await mount();
    await click(q("[data-testid=closed-history-toggle]"));
    await type(q<HTMLInputElement>("[data-testid=closed-history-before]"), "2025-12-31");
    const seen = historyReads().length;
    await submitFind();
    expect(historyIds()).toEqual(["/requests/ancient"]);
    // its first read starts at the end of that day (no count is asked from a date)
    const first = historyReads()[seen];
    expect(String(first.find((c) => c.m === "or")?.a[0])).toMatch(/^last_modified\.lt\."2025-12-31T|^last_modified\.lt\."2026-01-01T/);
    expect(first.find((c) => c.m === "select")?.a[1]).toBeUndefined();
    expect(q("[data-testid=closed-history-count]")?.textContent).toMatch(/last active on or before 2025-12-31/);
  });

  const scopeOf = (calls: Call[]) => calls.filter((c) => c.m === "eq").map((c) => c.a[0]).sort();

  it("the history reads the queue's own role scope: a requester (and a Contractor-only member) their own requests; a Drafter their assigned ones; a manager the workspace", async () => {
    const cases: Array<{ roles: string[]; uid: string; want: string[]; mine: Row; other: Row }> = [
      { roles: ["Requester"], uid: "r-7", want: ["org_id", "requester_id"], mine: row("m1", { requester_id: "r-7" }), other: row("x1", { requester_id: "r-8" }) },
      { roles: ["Contractor"], uid: "k-1", want: ["org_id", "requester_id"], mine: row("m2", { requester_id: "k-1" }), other: row("x2", { requester_id: "r-8" }) },
      { roles: ["Drafter"], uid: "d-9", want: ["assigned_drafter_id", "org_id"], mine: row("m3", { assigned_drafter_id: "d-9" }), other: row("x3", { assigned_drafter_id: "d-1" }) },
      { roles: ["Manager"], uid: "m-1", want: ["org_id"], mine: row("m4"), other: row("x4", { org_id: "org-2" }) },
      { roles: ["Engineer"], uid: "e-1", want: ["org_id"], mine: row("m5"), other: row("x5", { org_id: "org-2" }) },
    ];
    for (const c of cases) {
      act(() => root!.unmount());
      root = createRoot(host!);
      s.role = { activeRole: c.roles[0], roles: c.roles, activeOrgId: "org-1", uid: c.uid };
      s.tickets = [c.mine, c.other];
      s.reads = [];
      await mount();
      const queueScope = scopeOf(queueReads()[0]);
      await click(q("[data-testid=closed-history-toggle]"));
      expect(scopeOf(historyReads()[0]), c.roles.join()).toEqual(c.want);
      // the same scope filters as the queue's own read (the Drafter's queue has a second, pool read — open only)
      expect(queueScope, c.roles.join()).toEqual(c.want);
      expect(historyIds(), c.roles.join()).toEqual([`/requests/${c.mine.id}`]);
      expect(q("[data-testid=closed-history]")?.textContent).toMatch(c.roles[0] === "Drafter" ? /assigned to you/ : c.want.length === 1 ? /in this workspace/ : /you requested/);
    }
  });

  it("the toggle stays reachable when the queue's own read failed (the page shell stays)", async () => {
    bigHistory();
    s.failWhen = (calls) => !calls.some((c) => c.m === "in" && c.a[0] === "status"); // every queue read fails
    await mount();
    expect(q("[data-testid=requests-read-failed]")).toBeTruthy();
    await click(q("[data-testid=closed-history-toggle]"));
    expect(historyIds().length).toBe(HISTORY_CHUNK);
  });
});
