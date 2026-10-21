// notifications Round G, N11 TRAIL — RT-12 (the table_views half; DEC-105 §5).
//
// table_views stays OUT of the supabase_realtime publication (a DELETE event
// would carry its composite id — workspace, person, library — to every
// subscriber). Its cross-client sync is a Realtime Broadcast from the saver:
//   * listenTableView joins the view's own topic and re-reads the row (under
//     RLS) when a "table_view_changed" message arrives — and reads it once on
//     mount, as before;
//   * saveTableView / deleteTableView announce AFTER the write landed, with an
//     empty payload — over the tab's joined channel when it already listens
//     to that topic (kept), else over REST on a short-lived channel (removed);
//   * a refused write announces nothing; an announcement that fails never
//     fails the save;
//   * (second fix pass) the message is a hint, never data: the listener's
//     re-reads are coalesced — one in flight, one trailing re-read, about one
//     read per TABLE_VIEW_RESYNC_MS window however many messages arrive (a
//     public topic on a guessable id can be flooded or forged).

import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  writeError: null as string | null,
  rows: [] as Array<Record<string, unknown>>,
  reads: 0,
  /** When set, a read waits for release() (the read in flight). */
  hold: false,
  held: [] as Array<() => void>,
  channels: [] as Array<{ topic: string; ons: Array<{ type: string; cfg: Record<string, unknown>; cb: () => void }>; sent: unknown[]; http: unknown[][]; subscribed: boolean; removed: boolean }>,
  httpFails: false,
}));

vi.mock("@/lib/supabase", () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    let write = false;
    for (const m of ["eq", "limit"]) q[m] = () => q;
    q.select = () => q;
    q.upsert = () => { write = true; return q; };
    q.delete = () => { write = true; return q; };
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      if (write) return Promise.resolve({ error: fx.writeError ? { message: fx.writeError } : null }).then(ok, ko);
      fx.reads++;
      if (fx.hold) return new Promise((res) => { fx.held.push(() => res({ data: fx.rows, error: null })); }).then(ok, ko);
      return Promise.resolve({ data: fx.rows, error: null }).then(ok, ko);
    };
    return q;
  };
  const supabase = {
    from: () => chain(),
    getChannels: () => fx.channels.filter((c) => !c.removed).map((c) => ({
      topic: `realtime:${c.topic}`,
      send: async (msg: unknown) => { c.sent.push(msg); return "ok"; },
    })),
    channel: (topic: string) => {
      const c = { topic, ons: [] as Array<{ type: string; cfg: Record<string, unknown>; cb: () => void }>, sent: [] as unknown[], http: [] as unknown[][], subscribed: false, removed: false };
      fx.channels.push(c);
      const api: Record<string, unknown> = {
        topic: `realtime:${topic}`,
        on: (type: string, cfg: Record<string, unknown>, cb: () => void) => { c.ons.push({ type, cfg, cb }); return api; },
        subscribe: () => { c.subscribed = true; return api; },
        httpSend: async (event: string, payload: unknown) => { if (fx.httpFails) throw new Error("network"); c.http.push([event, payload]); return { success: true }; },
        __c: c,
      };
      return api;
    },
    removeChannel: async (ch: { __c?: { removed: boolean } }) => { if (ch.__c) ch.__c.removed = true; return "ok"; },
  };
  return { supabase };
});

import { listenTableView, saveTableView, deleteTableView, tableViewId, tableViewTopic, TABLE_VIEW_RESYNC_MS } from "@/lib/tableViews";

const params = { scope: "org" as const, orgId: "o1", libraryId: "lib1", collectionId: "c1" };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

const settle = async () => { await new Promise((r) => setTimeout(r, TABLE_VIEW_RESYNC_MS + 30)); await flush(); };

beforeEach(() => { fx.writeError = null; fx.rows = []; fx.reads = 0; fx.channels = []; fx.httpFails = false; fx.hold = false; fx.held = []; });

describe("RT-12 — table_views cross-client sync by Broadcast", () => {
  it("the listener joins the view's topic on a broadcast binding (no postgres_changes) and re-reads on a message", async () => {
    const seen: unknown[] = [];
    const stop = listenTableView(params, (v) => seen.push(v));
    await flush();
    expect(fx.reads).toBe(1); // the first read, as before
    const ch = fx.channels[0];
    expect(ch.topic).toBe(tableViewTopic(tableViewId(params)));
    expect(ch.ons.map((o) => [o.type, o.cfg.event])).toEqual([["broadcast", "table_view_changed"]]);
    expect(ch.subscribed).toBe(true);
    ch.ons[0].cb();
    await settle();
    expect(fx.reads).toBe(2);
    stop();
    expect(ch.removed).toBe(true);
    ch.ons[0].cb();
    await settle();
    expect(fx.reads).toBe(2); // nothing after unmount
  });

  it("a save announces after it landed: over REST on a short-lived channel (removed), empty payload", async () => {
    await saveTableView({ ...params, columns: ["title"] });
    await flush();
    expect(fx.channels.length).toBe(1);
    expect(fx.channels[0].topic).toBe(tableViewTopic(tableViewId(params)));
    expect(fx.channels[0].http).toEqual([["table_view_changed", {}]]);
    expect(fx.channels[0].removed).toBe(true);
    expect(fx.channels[0].subscribed).toBe(false);
  });

  it("a tab already listening to the topic sends on that channel and keeps it", async () => {
    const stop = listenTableView(params, () => {});
    await flush();
    await deleteTableView(params);
    await flush();
    expect(fx.channels.length).toBe(1);
    expect(fx.channels[0].sent).toEqual([{ type: "broadcast", event: "table_view_changed", payload: {} }]);
    expect(fx.channels[0].removed).toBe(false);
    stop();
  });

  it("a refused write announces nothing (and still throws, as before); a failed announcement never fails the save", async () => {
    fx.writeError = "permission denied";
    await expect(saveTableView({ ...params, columns: ["title"] })).rejects.toThrow("permission denied");
    await expect(deleteTableView(params)).rejects.toThrow("permission denied");
    await flush();
    expect(fx.channels.length).toBe(0);
    fx.writeError = null;
    fx.httpFails = true;
    await expect(saveTableView({ ...params, columns: ["title"] })).resolves.toBe(tableViewId(params));
    await flush();
    expect(fx.channels[0].removed).toBe(true);
  });
});

describe("RT-12 second fix pass — the message is a hint, and the re-reads are coalesced", () => {
  it("a flood of messages inside one window is ONE re-read; a later window is one more", async () => {
    const seen: unknown[] = [];
    const stop = listenTableView(params, (v) => seen.push(v));
    await flush();
    expect(fx.reads).toBe(1);
    const ch = fx.channels[0];
    for (let i = 0; i < 200; i++) ch.ons[0].cb();
    await flush();
    expect(fx.reads).toBe(1); // nothing before the window closes
    await settle();
    expect(fx.reads).toBe(2); // 200 messages → one read
    for (let i = 0; i < 50; i++) ch.ons[0].cb();
    await settle();
    expect(fx.reads).toBe(3);
    expect(seen.length).toBe(3);
    stop();
  });

  it("one read in flight: messages meanwhile ask for exactly one trailing re-read after it, never an overlapping read", async () => {
    fx.hold = true;
    const seen: unknown[] = [];
    const stop = listenTableView(params, (v) => seen.push(v));
    await flush();
    expect(fx.reads).toBe(1); // the first read, held in flight
    const ch = fx.channels[0];
    for (let i = 0; i < 30; i++) ch.ons[0].cb();
    await settle();
    for (let i = 0; i < 30; i++) ch.ons[0].cb();
    await settle();
    expect(fx.reads).toBe(1); // no second read while the first is in flight
    fx.hold = false;
    fx.held.shift()!();
    await flush();
    expect(seen.length).toBe(1);
    await settle();
    expect(fx.reads).toBe(2); // exactly one trailing re-read for all 60 messages
    await settle();
    expect(fx.reads).toBe(2);
    stop();
  });

  it("the payload is never read: a forged message carrying a row changes nothing but the re-read under RLS", async () => {
    fx.rows = [{ id: tableViewId(params), name: "Org Default View", columns: ["title"], library_id: "lib1" }];
    const seen: Array<{ columns: string[] } | null> = [];
    const stop = listenTableView(params, (v) => seen.push(v as { columns: string[] } | null));
    await flush();
    const ch = fx.channels[0];
    (ch.ons[0].cb as unknown as (m: unknown) => void)({ payload: { columns: ["forged"], id: "tv_other" } });
    await settle();
    expect(seen.map((v) => v?.columns)).toEqual([["title"], ["title"]]);
    stop();
  });

  it("a hint pending at unmount reads nothing", async () => {
    const stop = listenTableView(params, () => {});
    await flush();
    fx.channels[0].ons[0].cb();
    stop();
    await settle();
    expect(fx.reads).toBe(1);
  });
});
