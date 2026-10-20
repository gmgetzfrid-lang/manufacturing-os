// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS —
// ROUTE-12: the request queue reads EVERY request of its scope, whatever
// PostgREST's max-rows is, and a failed read is said — never shown as an
// empty or short queue. (The integrator's ruling under DEC-90: page until a
// short page, ordered; a failed page fails the read visibly.)
//
//   lib/ticketQueueRead.ts readQueueScope — the keyset pager, against a
//   PostgREST stand-in that serves at most `maxRows` per request, in
//   (last_modified DESC NULLS FIRST, id DESC) order, after the keyset.
//   app/(protected)/requests/page.tsx — AS RENDERED: a workspace with more
//   requests than one page shows the old, untouched one in the list and in
//   Needs me; a failed page is said, with Try again; a normal workspace sees
//   exactly today's list in one request; the Drafter's two reads and the
//   requester's read are paged and ordered too.
//   Fix pass: with no count the pager never stops at a short page (a
//   server's max-rows below the page size) — only at a page that adds
//   nobody; a failed read keeps the page shell (filter bar, status filter,
//   Show Closed), so a narrower scope can still be read; at the ceiling the
//   open requests are read on their own, so Needs me and every open count
//   stay whole; overlapping reads apply only the latest; the header's
//   Refresh Data re-reads the list.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readQueueScope, QUEUE_PAGE, type QueueQuery } from "@/lib/ticketQueueRead";

type Row = Record<string, unknown>;
type Call = { m: string; a: unknown[] };

const s = vi.hoisted(() => ({
  role: { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1" } as Record<string, unknown>,
  tickets: [] as Array<Record<string, unknown>>,
  /** PostgREST's max-rows: a request never returns more. */
  maxRows: 1000,
  /** 1-based tickets list reads that fail (counted across the page's life). */
  failReads: [] as number[],
  /** Every tickets list read, with its calls. */
  reads: [] as Array<Array<{ m: string; a: unknown[] }>>,
  /** Answer no count (an old server, a proxy that drops Content-Range). */
  noCount: false,
  /** Added to the count the first page reports (rows that change mid-read). */
  countBonus: 0,
  /** The realtime listeners the page subscribed. */
  channels: [] as Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }>,
  /** A tickets read that fails when this says so (on top of `failReads`). */
  failWhen: null as null | ((calls: Array<{ m: string; a: unknown[] }>) => boolean),
  /** 1-based tickets read → a gate its answer waits on (answer computed at call time). */
  gates: {} as Record<number, Promise<void>>,
  /** The ceiling the page's reads use (the real one when null). */
  ceiling: null as number | null,
}));

/** The stand-in's keyset: parse the reader's two `or` shapes. */
function keysetOf(calls: Call[]): ((r: Row) => boolean) | null {
  const or = calls.find((c) => c.m === "or")?.a[0];
  if (typeof or !== "string") return null;
  const nullRegion = /^and\(last_modified\.is\.null,id\.lt\."([^"]+)"\),last_modified\.not\.is\.null$/.exec(or);
  if (nullRegion) {
    const id = nullRegion[1];
    return (r) => (r.last_modified == null ? String(r.id) < id : true);
  }
  const valued = /^last_modified\.lt\."([^"]+)",and\(last_modified\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/.exec(or);
  if (valued) {
    const [, lm, lm2, id] = valued;
    expect(lm2).toBe(lm);
    return (r) => r.last_modified != null && (String(r.last_modified) < lm || (String(r.last_modified) === lm && String(r.id) < id));
  }
  throw new Error(`unexpected or filter: ${or}`);
}

/** The scope's filters, as PostgREST would apply them. */
function filtered(calls: Call[]): Row[] {
  let out = [...s.tickets];
  for (const c of calls) {
    if (c.m === "eq") out = out.filter((r) => r[String(c.a[0])] === c.a[1]);
    if (c.m === "not" && c.a[1] === "in") {
      const list = String(c.a[2]).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
      out = out.filter((r) => !list.includes(String(r[String(c.a[0])])));
    }
  }
  return out;
}

/** (last_modified DESC NULLS FIRST, id DESC) — what the page asks for. */
const order = (a: Row, b: Row) => {
  const la = a.last_modified as string | null | undefined, lb = b.last_modified as string | null | undefined;
  if (la == null && lb != null) return -1;
  if (lb == null && la != null) return 1;
  if (la != null && lb != null && la !== lb) return la < lb ? 1 : -1;
  return String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0;
};

function serveTickets(calls: Call[]): { data: unknown; error: unknown; count?: number } {
  s.reads.push(calls);
  if (s.failReads.includes(s.reads.length) || s.failWhen?.(calls)) return { data: null, error: { message: "canceling statement due to statement timeout" } };
  const scoped = filtered(calls);
  const keyset = keysetOf(calls);
  const rows = (keyset ? scoped.filter(keyset) : scoped).sort(order);
  const limit = (calls.find((c) => c.m === "limit")?.a[0] as number | undefined) ?? Infinity;
  const wantsCount = (calls.find((c) => c.m === "select")?.a[1] as { count?: string } | undefined)?.count === "exact";
  return { data: rows.slice(0, Math.min(limit, s.maxRows)), error: null, ...(wantsCount && !s.noCount ? { count: scoped.length + s.countBonus } : {}) };
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
// The page's reads run under a test-sized ceiling when `s.ceiling` is set.
vi.mock("@/lib/ticketQueueRead", async (orig) => {
  const real = await orig<typeof import("@/lib/ticketQueueRead")>();
  return {
    ...real,
    readQueueScope: (build: Parameters<typeof real.readQueueScope>[0], opts?: Parameters<typeof real.readQueueScope>[1]) =>
      real.readQueueScope(build, s.ceiling ? { ...opts, ceiling: s.ceiling } : opts),
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
      if (table === "tickets") {
        result = serveTickets(calls);
        const gate = s.gates[s.reads.length];
        if (gate) return gate.then(() => result).then(ok, ko);
      } else if (table === "org_members" && calls.some((c) => c.m === "in")) result = { data: [], error: null };
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
/** n requests, newest-modified first by index; every one closed but those overridden. */
const bulk = (n: number, over: (i: number) => Row = () => ({})): Row[] =>
  Array.from({ length: n }, (_, i) => row(`t${pad(i)}`, { last_modified: new Date(Date.parse("2026-10-13T10:00:00.000Z") - i * 60_000).toISOString(), ...over(i) }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  s.role = { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1" };
  s.tickets = []; s.maxRows = 1000; s.failReads = []; s.reads = []; s.noCount = false; s.countBonus = 0; s.channels = [];
  s.failWhen = null; s.gates = {}; s.ceiling = null;
  try { localStorage.clear(); } catch { /* none */ }
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Under fake timers (the realtime tests) a tick advances the fake clock by 0.
const tick = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0)));
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await tick(); }); };
/** ROUTE-13 done-when 2 (the DF-P14 integrator ruling): the page's realtime
 *  listener is a trailing debounce of REALTIME_SETTLE_MS (500 ms). */
const SETTLE_MS = 500;
/** Fake the clock the listener's debounce runs on (after mount). */
const fakeClock = () => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); };
/** Let `ms` pass on the fake clock, then let the reads it started land. */
const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); };
const mount = async () => { await act(async () => { root!.render(React.createElement(RequestsPage)); }); await flush(); };
const q = <T extends HTMLElement>(sel: string) => host!.querySelector(sel) as T | null;
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const rowIds = () => Array.from(host!.querySelectorAll("tbody a[href^='/requests/']")).map((a) => a.getAttribute("href")).filter((h, i, all) => all.indexOf(h) === i);
const byText = (sel: string, text: RegExp) => Array.from(host!.querySelectorAll(sel)).find((e) => text.test(e.textContent ?? "")) ?? null;

// ─── the pager ────────────────────────────────────────────────────────────────

/** A builder over the stand-in, as the page builds it (select + scope filters). */
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

describe("ROUTE-12 — readQueueScope reads every row, whatever max-rows is", () => {
  it("1,400 rows behind a 1,000-row cap: every row, once, in order, in two pages", async () => {
    s.tickets = bulk(1400);
    const r = await readQueueScope(builder());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.length).toBe(1400);
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(1400);
    expect(r.rows.map((x) => x.id)).toEqual([...s.tickets].sort(order).map((x) => x.id));
    expect(r).toMatchObject({ total: 1400, complete: true, capped: false });
    expect(s.reads.length).toBe(2);
    // first page counted, ordered, limited; the second carries on from the last row
    expect(s.reads[0]).toEqual(expect.arrayContaining([
      { m: "order", a: ["last_modified", { ascending: false }] },
      { m: "order", a: ["id", { ascending: false }] },
      { m: "limit", a: [QUEUE_PAGE] },
    ]));
    expect(s.reads[1].find((c) => c.m === "select")?.a[1]).toBeUndefined();
    expect(String(s.reads[1].find((c) => c.m === "or")?.a[0])).toMatch(/^last_modified\.lt\."/);
  });

  it("a server whose max-rows is LOWER than the page asked for (250): still every row — a capped page is not the end while the count says more", async () => {
    s.tickets = bulk(1100);
    s.maxRows = 250;
    const r = await readQueueScope(builder());
    expect(r.ok && r.rows.length).toBe(1100);
    expect(r.ok && r.complete).toBe(true);
    expect(s.reads.length).toBe(5);
  });

  it("ties on last_modified and NULL last_modified rows: none skipped, none twice (the id breaks ties; NULLs come first)", async () => {
    s.tickets = [
      ...Array.from({ length: 7 }, (_, i) => row(`n${i}`, { last_modified: null })),
      ...Array.from({ length: 9 }, (_, i) => row(`s${i}`, { last_modified: "2026-05-01T00:00:00.000Z" })),
      ...bulk(5),
    ];
    s.maxRows = 3;
    const r = await readQueueScope(builder(), { pageSize: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.length).toBe(21);
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(21);
    expect(r.rows.slice(0, 7).every((x) => x.last_modified === null)).toBe(true);
  });

  it("a failed page fails the WHOLE read — never the rows before it as if they were all", async () => {
    s.tickets = bulk(2500);
    s.failReads = [2];
    const r = await readQueueScope(builder());
    expect(r).toEqual({ ok: false, error: "canceling statement due to statement timeout" });
  });

  it("FIX PASS: no count came back and the server's max-rows (250) is below the page asked for — every row still; a short page is never taken as the end, only a page that adds nobody", async () => {
    s.tickets = bulk(1400);
    s.noCount = true;
    s.maxRows = 250;
    const r = await readQueueScope(builder());
    expect(r.ok && r.rows.length).toBe(1400);
    expect(r).toMatchObject({ ok: true, total: null, complete: true, capped: false });
    expect(new Set(r.ok ? r.rows.map((x) => x.id) : []).size).toBe(1400);
    expect(s.reads.length).toBe(7); // six pages of rows (250 × 5 + 150), then one that adds nobody
  });

  it("FIX PASS: no count and a server that ignores the keyset — the read stops (no loop) and says it is NOT complete", async () => {
    s.tickets = bulk(30);
    s.maxRows = 10;
    s.noCount = true;
    const lying = (counted: boolean): QueueQuery => {
      const calls: Call[] = [{ m: "select", a: ["*", counted ? { count: "exact" } : undefined] }];
      const api = {
        order: () => api, limit: (...a: unknown[]) => { calls.push({ m: "limit", a }); return api; }, or: () => api,
        then: (ok: (v: never) => unknown) => Promise.resolve(serveTickets(calls)).then(ok as (v: unknown) => unknown),
      };
      return api as unknown as QueueQuery;
    };
    const r = await readQueueScope(lying);
    expect(r).toMatchObject({ ok: true, total: null, complete: false, capped: false });
    expect(r.ok && r.rows.length).toBe(10);
  });

  it("the ceiling: stops there and says it is not complete (N of M)", async () => {
    s.tickets = bulk(30);
    const r = await readQueueScope(builder(), { pageSize: 10, ceiling: 25 });
    expect(r).toMatchObject({ ok: true, total: 30, complete: false, capped: true });
    expect(r.ok && r.rows.length).toBe(25);
  });

  it("a server that ignores the keyset (the same page again) cannot loop the read or list anyone twice — and the read says it is short", async () => {
    s.tickets = bulk(30);
    s.maxRows = 10;
    const lying = (counted: boolean): QueueQuery => {
      const calls: Call[] = [{ m: "select", a: ["*", counted ? { count: "exact" } : undefined] }];
      const api = {
        order: () => api, limit: (...a: unknown[]) => { calls.push({ m: "limit", a }); return api; }, or: () => api,
        then: (ok: (v: never) => unknown) => Promise.resolve(serveTickets(calls)).then(ok as (v: unknown) => unknown),
      };
      return api as unknown as QueueQuery;
    };
    const r = await readQueueScope(lying);
    expect(r).toMatchObject({ ok: true, total: 30, complete: false, capped: false });
    expect(r.ok && r.rows.length).toBe(10);
    expect(s.reads.length).toBe(2);
  });
});

// ─── the queue, as rendered ───────────────────────────────────────────────────

const SPRING = "2026-04-02T08:00:00.000Z";

describe("ROUTE-12 — the queue holds every request of its scope (rendered)", () => {
  it("1,400 requests since go-live behind a 1,000-row cap: the spring request untouched since April is in the list, in Needs me, and in every count", async () => {
    s.tickets = [
      ...bulk(1399),
      // the stalled one: waiting on the supervisor's assignment since spring — the oldest-modified row
      row("old-1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, assigned_drafter_name: null, title: "Spring pump iso", last_modified: SPRING }),
    ];
    await mount();
    expect(q("[data-testid=view-needs-me]")?.textContent).toMatch(/Needs me\s*1/);
    expect(rowIds()).toEqual(["/requests/old-1"]);
    expect(q("[data-testid=view-all]")?.textContent).toMatch(/All\s*1400/);
    expect(host!.textContent).toMatch(/1400 Total Records/);
    expect(q("[data-testid=tile-action-required-count]")?.textContent).toBe("1");
    // nothing claims the list is short or failed
    expect(q("[data-testid=requests-read-failed]")).toBeNull();
    expect(q("[data-testid=requests-read-short]")).toBeNull();
  });

  it("a failed page is SAID, with Try again — never 'No matching tickets found' or a short queue", async () => {
    s.tickets = [...bulk(1399), row("old-1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, last_modified: SPRING })];
    s.failReads = [2];
    await mount();
    const alert = q("[data-testid=requests-read-failed]");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toMatch(/could not be read/);
    expect(alert?.textContent).toMatch(/statement timeout/);
    expect(host!.textContent).not.toMatch(/No matching tickets found/);
    expect(host!.textContent).not.toMatch(/Nothing needs you right now/);
    expect(host!.textContent).not.toMatch(/999 Total Records|1000 Total Records/);
    // Try again re-reads, and the full list arrives
    await click(byText("[data-testid=requests-read-failed] button", /Try again/));
    expect(q("[data-testid=requests-read-failed]")).toBeNull();
    expect(host!.textContent).toMatch(/1400 Total Records/);
    expect(rowIds()).toEqual(["/requests/old-1"]);
  });

  it("a refresh that fails after a good read keeps the list as last read and SAYS it may be out of date", async () => {
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }), row("t2", { status: "DRAFTING" })];
    await mount();
    expect(host!.textContent).toMatch(/2 Total Records/);
    s.failReads = [s.reads.length + 1];
    // a tickets event re-reads the list (the org-filtered listener) — and this read fails
    const listener = s.channels.find((c) => c.cfg.event === "*");
    expect(listener).toBeTruthy();
    fakeClock();
    await act(async () => { listener!.cb({}); });
    await pass(SETTLE_MS); // the burst settles: one read
    const alert = q("[data-testid=requests-read-failed]");
    expect(alert?.textContent).toMatch(/could not be refreshed/);
    expect(alert?.textContent).toMatch(/as last read/);
    expect(rowIds()).toEqual(["/requests/t1"]);
  });

  it("a failed read after switching workspace never shows the previous workspace's list as 'last read' — the full notice instead", async () => {
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }), row("w2", { org_id: "org-2", status: "DRAFTING" })];
    await mount();
    expect(rowIds()).toEqual(["/requests/t1"]);
    s.role = { ...s.role, activeOrgId: "org-2" };
    s.failReads = [s.reads.length + 1];
    await act(async () => { root!.render(React.createElement(RequestsPage)); });
    await flush();
    const alert = q("[data-testid=requests-read-failed]");
    expect(alert?.textContent).toMatch(/The request list could not be read/);
    expect(alert?.textContent).not.toMatch(/as last read/);
    expect(rowIds()).toEqual([]);
    expect(host!.textContent).not.toContain("Title t1");
  });

  it("REGRESSION: a normal workspace sees exactly today's list — one request, the same scope filters, every row", async () => {
    s.tickets = [
      row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }),
      row("t2", { status: "DRAFTING", last_modified: "2026-10-12T10:00:00.000Z" }),
      row("t3", { status: "CLOSED", last_modified: "2026-10-11T10:00:00.000Z" }),
      row("x9", { org_id: "org-2", status: "DRAFTING" }),
    ];
    await mount();
    expect(s.reads.length).toBe(1);
    expect(s.reads[0]).toEqual(expect.arrayContaining([{ m: "eq", a: ["org_id", "org-1"] }]));
    expect(s.reads[0].some((c) => c.m === "not")).toBe(false); // "Any" status includes closed, as before
    await click(q("[data-testid=view-all]"));
    expect(rowIds().sort()).toEqual(["/requests/t1", "/requests/t2", "/requests/t3"]);
    expect(host!.textContent).toMatch(/3 Total Records/);
    expect(q("[data-testid=requests-read-short]")).toBeNull();
  });

  it("the requester's scope is paged and ordered too: 1,200 of their own requests, every one", async () => {
    s.role = { activeRole: "Requester", roles: ["Requester"], activeOrgId: "org-1", uid: "r-1" };
    s.tickets = [...bulk(1199), row("mine-old", { status: "PENDING_REVIEW", requester_id: "r-1", last_modified: SPRING, title: "Old review" })];
    await mount();
    expect(q("[data-testid=view-all]")?.textContent).toMatch(/All\s*1200/);
    expect(s.reads.every((calls) => calls.some((c) => c.m === "eq" && c.a[0] === "requester_id" && c.a[1] === "r-1"))).toBe(true);
    expect(rowIds()).toEqual(["/requests/mine-old"]); // Needs me: their review
  });

  it("the Drafter's two scopes (assigned; the pool) are each paged and ordered: the old pool request is there", async () => {
    s.role = { activeRole: "Drafter", roles: ["Drafter"], activeOrgId: "org-1", uid: "d-9" };
    s.tickets = [
      ...bulk(1200, () => ({ status: "DRAFTING", assigned_drafter_id: "d-9" })),
      row("pool-old", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, last_modified: SPRING, title: "Spring pool request" }),
    ];
    await mount();
    expect(q("[data-testid=view-all]")?.textContent).toMatch(/All\s*1201/);
    for (const calls of s.reads) expect(calls).toEqual(expect.arrayContaining([{ m: "order", a: ["last_modified", { ascending: false }] }, { m: "order", a: ["id", { ascending: false }] }]));
    // find it: the search box narrows the list the page holds
    const search = host!.querySelector("input[placeholder^='Search by ID']") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Spring pool");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(rowIds()).toEqual(["/requests/pool-old"]);
  });

  it("a read that ends with fewer rows than its count (a request changed while it was read) says it shows N of M — never a short queue as whole", async () => {
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }), row("t2")];
    s.countBonus = 1; // the first page counted a row the pages no longer see
    await mount();
    const short = q("[data-testid=requests-read-short]");
    expect(short?.textContent).toMatch(/shows 2 of the 3 requests/);
    expect(short?.textContent).toMatch(/Refresh/);
    expect(q("[data-testid=requests-read-failed]")).toBeNull();
    // the rows it did read are listed
    await click(q("[data-testid=view-all]"));
    expect(rowIds().sort()).toEqual(["/requests/t1", "/requests/t2"]);
  });
});

describe("ROUTE-12 fix pass — the queue page (rendered)", () => {
  const statusSelect = () => Array.from(host!.querySelectorAll("select")).find((el) => Array.from((el as HTMLSelectElement).options).some((o) => o.value === "ALL")) as HTMLSelectElement;
  async function choose(sel: HTMLSelectElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  }

  it("the default 'Any status' read fails on every attempt: the filter bar stays, the notice says how to narrow, and choosing an open status reads the open list", async () => {
    s.tickets = [
      row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, title: "Waiting pump iso" }),
      row("t2", { status: "DRAFTING" }),
      row("t3", { status: "CLOSED" }),
    ];
    // the whole-history read (no terminal filter) times out; an open-only read works
    s.failWhen = (calls) => !calls.some((c) => c.m === "not");
    await mount();
    const alert = q("[data-testid=requests-read-failed]");
    expect(alert?.textContent).toMatch(/The request list could not be read/);
    expect(q("[data-testid=requests-read-failed-narrow]")?.textContent).toMatch(/choose an open status above/);
    // the shell is there: the status filter, Show Closed, the view switcher; no count is claimed
    expect(statusSelect()).toBeTruthy();
    expect(byText("button", /Show Closed/)).toBeTruthy();
    expect(q("[data-testid=view-needs-me]")?.textContent).toMatch(/Needs me\s*—/);
    expect(q("[data-testid=view-all]")?.textContent).toMatch(/All\s*—/);
    expect(q("[data-testid=tile-action-required]")).toBeNull();
    expect(host!.textContent).toMatch(/Total records unknown/);
    expect(host!.textContent).not.toMatch(/No matching tickets found/);
    // narrow to an open status: the open read succeeds and the list is there
    await choose(statusSelect(), "PENDING_ASSIGNMENT");
    expect(q("[data-testid=requests-read-failed]")).toBeNull();
    expect(s.reads.at(-1)!.some((c) => c.m === "not")).toBe(true);
    await click(q("[data-testid=view-all]"));
    expect(rowIds()).toEqual(["/requests/t1"]);
  });

  it("at the ceiling the OPEN requests are read on their own: the old open request is listed and in Needs me; the banner says only closed history is bounded", async () => {
    s.ceiling = 50;
    s.tickets = [
      // 70 closed requests touched recently (a comment after close bumps last_modified)
      ...bulk(70, () => ({ status: "CLOSED" })),
      // 9 open ones, older
      ...Array.from({ length: 9 }, (_, i) => row(`o${i}`, { status: "DRAFTING", last_modified: `2026-03-0${i + 1}T00:00:00.000Z` })),
      // and the stalled one waiting on the supervisor since spring — the oldest row of all
      row("old-1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, title: "Spring pump iso", last_modified: "2026-02-01T00:00:00.000Z" }),
    ];
    await mount();
    // the capped read, then the open scope alone
    expect(s.reads.some((calls) => calls.some((c) => c.m === "not"))).toBe(true);
    expect(q("[data-testid=view-needs-me]")?.textContent).toMatch(/Needs me\s*1/);
    expect(rowIds()).toEqual(["/requests/old-1"]);
    expect(q("[data-testid=tile-action-required-count]")?.textContent).toBe("1");
    expect(q("[data-testid=view-all]")?.textContent).toMatch(/All\s*60/);
    const banner = q("[data-testid=requests-read-short]");
    expect(banner?.textContent).toMatch(/Every open request in this view is listed, with the 50 most recently active closed or canceled ones — 80 requests in all/);
    expect(banner?.textContent).toMatch(/Older closed and canceled requests are not listed here/);
  });

  it("at the ceiling with more OPEN requests than it holds too: the banner says N of M and to choose an open status", async () => {
    s.ceiling = 50;
    s.tickets = bulk(60, () => ({ status: "DRAFTING" }));
    await mount();
    const banner = q("[data-testid=requests-read-short]");
    expect(banner?.textContent).toMatch(/shows the 50 most recently active of the 60 requests in this view/);
    expect(banner?.textContent).toMatch(/Choose an open status/);
  });

  it("overlapping reads apply only the latest: a stale failure that lands after a fresh list never covers it", async () => {
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }), row("t2", { status: "DRAFTING" })];
    await mount();
    expect(host!.textContent).toMatch(/2 Total Records/);
    const listener = s.channels.find((c) => c.cfg.event === "*")!;
    let releaseA: () => void = () => undefined;
    const n = s.reads.length;
    s.gates[n + 1] = new Promise<void>((r) => { releaseA = r; });
    s.failReads = [n + 1];
    fakeClock();
    await act(async () => { listener.cb({}); });
    await pass(SETTLE_MS); // read A (realtime, after the burst settles): will fail, late
    expect(s.reads.length).toBe(n + 1);
    s.tickets = [...s.tickets, row("t3", { status: "DRAFTING" })];
    // read B: an explicit Refresh (realtime events are coalesced behind A since
    // fix pass 2; an explicit read is not), fresh, at once
    await click(host!.querySelector("button[title='Refresh Data']"));
    expect(host!.textContent).toMatch(/3 Total Records/);
    await act(async () => { releaseA(); });
    await flush();
    expect(q("[data-testid=requests-read-failed]")).toBeNull();
    expect(host!.textContent).toMatch(/3 Total Records/);
  });

  it("overlapping reads apply only the latest: a stale success that lands after a real failure never clears it", async () => {
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }), row("t2", { status: "DRAFTING" })];
    await mount();
    const listener = s.channels.find((c) => c.cfg.event === "*")!;
    let releaseA: () => void = () => undefined;
    const n = s.reads.length;
    s.gates[n + 1] = new Promise<void>((r) => { releaseA = r; });
    fakeClock();
    await act(async () => { listener.cb({}); });
    await pass(SETTLE_MS); // read A (realtime, after the burst settles): succeeds with the old list, late
    expect(s.reads.length).toBe(n + 1);
    s.tickets = [...s.tickets, row("t3", { status: "DRAFTING" })];
    s.failReads = [n + 2];
    await click(host!.querySelector("button[title='Refresh Data']")); // read B (explicit): fails at once
    expect(q("[data-testid=requests-read-failed]")?.textContent).toMatch(/could not be refreshed/);
    await act(async () => { releaseA(); });
    await flush();
    expect(q("[data-testid=requests-read-failed]")?.textContent).toMatch(/could not be refreshed/);
  });

  describe("ROUTE-13 done-when 2 (DF-P14 integrator ruling, DEC-90): the realtime listener is a trailing debounce — at most one re-read per tab per burst", () => {
    const seed = () => { s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }), row("t2", { status: "DRAFTING" })]; };
    const listenerOf = () => s.channels.find((c) => c.cfg.event === "*")!;

    it("a burst of 5 tickets events produces exactly ONE read, after the burst settles — and it lands the latest list", async () => {
      seed();
      await mount();
      expect(host!.textContent).toMatch(/2 Total Records/);
      fakeClock();
      const n = s.reads.length;
      s.tickets = [...s.tickets, row("t3", { status: "DRAFTING" })];
      for (let i = 0; i < 5; i++) {
        await act(async () => { listenerOf().cb({}); });
        await pass(100); // events 100 ms apart: the burst has not settled
      }
      expect(s.reads.length).toBe(n); // nothing read during the burst
      await pass(SETTLE_MS - 100 - 1);
      expect(s.reads.length).toBe(n); // 499 ms after the last event: still nothing
      await pass(1);
      expect(s.reads.length).toBe(n + 1); // settled: ONE read for all five
      expect(host!.textContent).toMatch(/3 Total Records/);
      await pass(10_000);
      expect(s.reads.length).toBe(n + 1); // and nothing more
    }, 30_000);

    it("an event during an in-flight read produces ONE trailing read when that read settles", async () => {
      seed();
      await mount();
      fakeClock();
      const n = s.reads.length;
      let releaseA: () => void = () => undefined;
      s.gates[n + 1] = new Promise<void>((r) => { releaseA = r; });
      await act(async () => { listenerOf().cb({}); });
      await pass(SETTLE_MS); // read A starts and waits
      expect(s.reads.length).toBe(n + 1);
      s.tickets = [...s.tickets, row("t3", { status: "DRAFTING" })];
      for (let i = 0; i < 3; i++) await act(async () => { listenerOf().cb({}); }); // during A
      await pass(SETTLE_MS * 4); // the burst settles while A is still in flight
      expect(s.reads.length).toBe(n + 1); // only A: the events marked the list dirty
      await act(async () => { releaseA(); });
      await flush();
      expect(s.reads.length).toBe(n + 2); // ONE trailing read
      expect(host!.textContent).toMatch(/3 Total Records/);
      await pass(10_000);
      expect(s.reads.length).toBe(n + 2);
    }, 30_000);

    it("explicit reads stay immediate: Refresh Data and Try again read at once, with no wait for the debounce", async () => {
      seed();
      await mount();
      fakeClock();
      const n = s.reads.length;
      await click(host!.querySelector("button[title='Refresh Data']"));
      expect(s.reads.length).toBe(n + 1); // no fake time passed
      // a failed read's Try again, likewise
      s.failReads = [n + 2];
      await click(host!.querySelector("button[title='Refresh Data']"));
      expect(q("[data-testid=requests-read-failed]")).toBeTruthy();
      await click(byText("[data-testid=requests-read-failed] button", /Try again/));
      expect(s.reads.length).toBe(n + 3);
      expect(q("[data-testid=requests-read-failed]")).toBeNull();
    }, 30_000);

    it("a stream of events that never settles cannot starve the list: a read starts within 5 s of the first unread event", async () => {
      seed();
      await mount();
      fakeClock();
      const n = s.reads.length;
      for (let i = 0; i < 13; i++) { // one event every 400 ms for 5.2 s
        await act(async () => { listenerOf().cb({}); });
        await pass(400);
      }
      expect(s.reads.length).toBe(n + 1);
    }, 30_000);

    it("a pending re-read is dropped when the page goes away (no read after unmount)", async () => {
      seed();
      await mount();
      fakeClock();
      const n = s.reads.length;
      await act(async () => { listenerOf().cb({}); });
      act(() => root!.unmount());
      root = null;
      await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS * 2); });
      expect(s.reads.length).toBe(n);
    }, 30_000);
  });

  describe("REVIEW FIX PASS 2: Export CSV never writes an unread or short list as the queue", () => {
    /** Click the header's Export CSV and return the file name it would save (null: nothing saved). */
    async function exportName(): Promise<string | null> {
      let name: string | null = null;
      const had = Object.prototype.hasOwnProperty.call(URL, "createObjectURL");
      Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "blob:test" });
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { name = this.getAttribute("download"); });
      try {
        const btn = q<HTMLButtonElement>("[data-testid=requests-export-csv]");
        expect(btn).toBeTruthy();
        await act(async () => { btn!.click(); });
      } finally {
        clickSpy.mockRestore();
        if (!had) delete (URL as unknown as Record<string, unknown>).createObjectURL;
      }
      return name;
    }
    it("the list could not be read: Export CSV is disabled and saves nothing", async () => {
      s.tickets = [row("t1", { status: "DRAFTING" })];
      s.failWhen = () => true;
      await mount();
      expect(q("[data-testid=requests-read-failed]")).toBeTruthy();
      const btn = q<HTMLButtonElement>("[data-testid=requests-export-csv]");
      expect(btn?.disabled).toBe(true);
      expect(btn?.getAttribute("title")).toMatch(/could not be read/);
      expect(await exportName()).toBeNull();
    });
    it("a short list (N of M): the file's name says so", async () => {
      s.tickets = [row("t1", { status: "DRAFTING" }), row("t2", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
      s.countBonus = 1;
      await mount();
      expect(q("[data-testid=requests-read-short]")).toBeTruthy();
      expect(q<HTMLButtonElement>("[data-testid=requests-export-csv]")?.disabled).toBe(false);
      expect(await exportName()).toMatch(/^drafting_export_.+_partial_2_of_3\.csv$/);
    });
    it("a whole list: enabled, and the name is as before", async () => {
      s.tickets = [row("t1", { status: "DRAFTING" })];
      await mount();
      const name = await exportName();
      expect(name).toMatch(/^drafting_export_[^_]+\.csv$/);
    });
  });

  it("the header's Refresh Data re-reads the list (it only spun before)", async () => {
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    await mount();
    expect(host!.textContent).toMatch(/1 Total Records/);
    const before = s.reads.length;
    s.tickets = [...s.tickets, row("t2", { status: "DRAFTING" })];
    await click(host!.querySelector("button[title='Refresh Data']"));
    expect(s.reads.length).toBe(before + 1);
    expect(host!.textContent).toMatch(/2 Total Records/);
  });
});

describe("DF-P14 integrator rulings (3) and (4), DEC-90 — the export's name and the Drafter's short-read banner say only what is true", () => {
  const statusSelect = () => Array.from(host!.querySelectorAll("select")).find((el) => Array.from((el as HTMLSelectElement).options).some((o) => o.value === "ALL")) as HTMLSelectElement;
  async function choose(sel: HTMLSelectElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  }
  async function exportName(): Promise<string | null> {
    let name: string | null = null;
    const had = Object.prototype.hasOwnProperty.call(URL, "createObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "blob:test" });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { name = this.getAttribute("download"); });
    try {
      const btn = q<HTMLButtonElement>("[data-testid=requests-export-csv]");
      expect(btn).toBeTruthy();
      await act(async () => { btn!.click(); });
    } finally {
      clickSpy.mockRestore();
      if (!had) delete (URL as unknown as Record<string, unknown>).createObjectURL;
    }
    return name;
  }
  const drafter = () => { s.role = { activeRole: "Drafter", roles: ["Drafter"], activeOrgId: "org-1", uid: "d-9" }; };
  const banner = () => q("[data-testid=requests-read-short]")?.textContent ?? "";

  it("(3) the suffix's N is what the file holds — the filtered rows written, not the rows read", async () => {
    s.tickets = [
      row("t1", { status: "DRAFTING" }),
      row("t2", { status: "DRAFTING" }),
      row("t3", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }),
    ];
    s.countBonus = 1; // the list is short: 3 of 4
    await mount();
    expect(banner()).toMatch(/shows 3 of the 4 requests/);
    expect(await exportName()).toMatch(/^drafting_export_.+_partial_3_of_4\.csv$/); // Any status: all 3 written
    await choose(statusSelect(), "DRAFTING");
    // the open scope's read is short too (3 rows of a count of 4) — the file may miss a row: said, with N = the 2 Drafting rows written
    expect(await exportName()).toMatch(/^drafting_export_.+_partial_2_of_4\.csv$/);
  });

  it("(3) no suffix when the file cannot be missing a row: every open request was read and the filter is one open status", async () => {
    drafter();
    s.ceiling = 50;
    s.tickets = [
      // the Drafter's assigned scope holds closed history past the ceiling…
      ...bulk(70, () => ({ status: "CLOSED", assigned_drafter_id: "d-9" })),
      // …and five open requests, older than all of it
      ...Array.from({ length: 5 }, (_, i) => row(`o${i}`, { status: "DRAFTING", assigned_drafter_id: "d-9", last_modified: `2026-03-0${i + 1}T00:00:00.000Z` })),
      row("p1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }),
    ];
    await mount();
    expect(banner()).toMatch(/Every open request in this view is listed/);
    await choose(statusSelect(), "DRAFTING");
    expect(q("[data-testid=requests-read-short]")).toBeTruthy(); // the list is still short of closed history
    expect(await exportName()).toMatch(/^drafting_export_[^_]+\.csv$/); // but the five Drafting requests are all in the file
    // Any status: closed history is bounded, so the file says so
    await choose(statusSelect(), "ALL");
    expect(await exportName()).toMatch(/_partial_\d+_of_uncounted\.csv$/);
  });

  it("(4) the Drafter's capped list never sums the two scopes' overlapping counts: 'the N most recent — the list is longer than one read'", async () => {
    drafter();
    s.ceiling = 50;
    s.tickets = [
      // three requests in BOTH scopes (assigned to them and back in the pool)
      ...Array.from({ length: 3 }, (_, i) => row(`b${i}`, { status: "PENDING_ASSIGNMENT", assigned_drafter_id: "d-9" })),
      // the pool past the ceiling
      ...bulk(60, () => ({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })),
    ];
    await mount();
    const text = banner();
    expect(text).toMatch(/shows the \d+ most recent requests in this view — the list is longer than one read/);
    expect(text).not.toMatch(/\b66\b/); // 3 + 63: the old summed total
    expect(text).not.toMatch(/ of the \d+ requests/);
  });

  it("(4) the Drafter's every-open-listed banner names no summed total either", async () => {
    drafter();
    s.ceiling = 50;
    s.tickets = [
      ...bulk(70, () => ({ status: "CLOSED", assigned_drafter_id: "d-9" })),
      row("o1", { status: "DRAFTING", assigned_drafter_id: "d-9", last_modified: "2026-03-01T00:00:00.000Z" }),
      row("p1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null }),
    ];
    await mount();
    expect(banner()).toMatch(/Every open request in this view is listed, with the 50 most recently active closed or canceled ones, more than one list holds/);
    expect(banner()).not.toMatch(/requests in all/);
  });

  it("(4) the Drafter's short (not capped) list: no total M — 'the list may be longer than what was read'", async () => {
    drafter();
    s.tickets = [row("a1", { status: "DRAFTING", assigned_drafter_id: "d-9" }), row("p1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    s.countBonus = 1;
    await mount();
    expect(banner()).toMatch(/shows the 2 requests that could be read — the list may be longer than what was read/);
    expect(banner()).not.toMatch(/of the 4/);
  });

  it("REGRESSION: a non-Drafter's short list keeps its exact N of M; a whole list shows no banner and names its file as before", async () => {
    s.tickets = [row("t1", { status: "DRAFTING" }), row("t2", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    s.countBonus = 1;
    await mount();
    expect(banner()).toMatch(/shows 2 of the 3 requests in this view/);
    s.countBonus = 0;
    await click(host!.querySelector("button[title='Refresh Data']"));
    expect(q("[data-testid=requests-read-short]")).toBeNull();
    expect(await exportName()).toMatch(/^drafting_export_[^_]+\.csv$/);
  });
});
