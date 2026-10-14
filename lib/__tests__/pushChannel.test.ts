// notifications Round G — N10 PUSH (GAP-205; OS-2, OS-9, OS-10, OS-11,
// TAX-12, DELIV-14, RT-7, drafting-flow ROUTE-3 (c)).
//
// Reproduced first on ce5a053: lib/notify/dispatch.ts:24 typed
// `NotifChannel = "inapp" | "email"` and emit() defaulted to those two
// (:329); nothing in app/ lib/ components/ hooks/ called pushManager,
// requestPermission or a sender; package.json had no web-push; no
// .env.example VAPID entry; push_subscriptions was named only by
// lib/schemaExpectations.ts:161, lib/exportTables.ts:319 and
// lib/dataRestore.ts:160 (bookkeeping, no reader or writer).
//
// Pinned here:
//   * emit()'s push leg — a third channel, only for KIND_META.pushWorthy
//     kinds, only beside the bell leg, only after the bell and email legs,
//     only for recipients told in full (never the redacted followers), never
//     throwing into the caller, never changing its result;
//     `channels: ["inapp"]` never attempts push (OS-9 done-when 4).
//   * lib/push/sendPush.ts — off without VAPID keys (logged once); a push
//     needs a landed bell row, push_enabled not false AND a device row;
//     push_enabled = false stops delivery without unsubscribing (GAP-205
//     acceptance 2); a 404 / 410 prunes the row (acceptance 3, OS-2
//     done-when 4); the body names nothing (acceptance 6); a replayed
//     request pushes a device once; a browser's request is capped per writer.
//   * the three routes, the cron's prune step, the env documentation, the
//     single permission-prompt site and no new cron entry (acceptance 5).
//
// Fix pass (the review of N10): the sender POSTs only to a browser push
// service's host and deletes any other row; at most PUSH_DEVICE_CAP devices
// per person; a device is CLAIMED for a row before the send (two requests at
// once send once); POST /api/push/notify answers before the sends (after());
// /api/push/subscribe stores only push-service endpoints, hands an endpoint
// over only on matching keys, in one conditional update (nothing deleted
// first), and keeps a person's newest PUSH_DEVICE_CAP; a server emit pushes
// only when its caller passes serverPush — loading lib/push/sendPush
// registers nothing, so the maintenance cron's scanStaleHolds never pushes.
//
// Fix pass 2 (the second review): pushEndpointAllowed accepts only an
// endpoint the WHATWG parser and the legacy url.parse (the one web-push
// connects by) read the same host from — pinned against the REAL web-push
// with https.request stubbed; every push request goes through
// pushServiceAgent() (push-service hosts only, public addresses only); one
// person's 1,200 registrations never cost a neighbour in the same device
// read their push; a row dated in the future is never read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import https from "node:https";
import dns from "node:dns";
import { EventEmitter } from "node:events";
import { createECDH, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  state: null as unknown as MemoryState,
  order: [] as string[],
  many: [] as Array<Record<string, unknown>>,
  emails: [] as Array<Record<string, unknown>>,
  failFor: new Set<string>(),
  sent: [] as Array<{ endpoint: string; payload: string; options: Record<string, unknown> }>,
  sendError: new Map<string, unknown>(),
  vapidThrows: false,
  user: null as null | { id: string },
  after: [] as Array<() => unknown>,
  insertError: null as null | { message: string; code?: string },
  writeBell: false,
}));

/** PostgREST's `or=(…)` for the claim the sender makes — the memory stand-in
 *  has no `or`, so this adds it: the rows matching ANY `col.is.null` /
 *  `col.lt."ts"` / `col.eq.v` term, as an `in("id", …)` filter evaluated when
 *  the chain is built (the write applies right after, as one statement does). */
function idsMatchingOr(table: string, cond: string): string[] {
  const terms = cond.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  const rows = h.state.tables[table] ?? [];
  const test = (r: Record<string, unknown>, term: string) => {
    const m = /^(\w+)\.(is|lt|eq)\.(.*)$/.exec(term);
    if (!m) throw new Error(`unsupported or-term ${term}`);
    const v = m[3].replace(/^"|"$/g, "");
    const cur = r[m[1]];
    if (m[2] === "is") return v === "null" ? cur == null : String(cur) === v;
    if (m[2] === "eq") return String(cur) === v;
    return cur != null && Date.parse(String(cur)) < Date.parse(v);
  };
  return rows.filter((r) => terms.some((t) => test(r, t))).map((r) => String(r.id));
}
/** A device read's PostgREST shape (fix pass 2): the memory stand-in ignores
 *  gte / lte / order / limit, so for push_subscriptions reads they are
 *  applied here — a read's shape decides what it returns, as PostgREST's
 *  does (a limit cuts a read short; newest first means newest first). */
type ReadShape = { gte: Array<[string, string]>; lte: Array<[string, string]>; order: [string, boolean] | null; limit: number | null; write: boolean };
const shaped = (shape: ReadShape, data: Array<Record<string, unknown>>) => {
  let rows = data;
  for (const [c, x] of shape.gte) rows = rows.filter((r) => Date.parse(String(r[c])) >= Date.parse(x));
  for (const [c, x] of shape.lte) rows = rows.filter((r) => Date.parse(String(r[c])) <= Date.parse(x));
  if (shape.order) {
    const [c, asc] = shape.order;
    rows = [...rows].sort((a, b) => (Date.parse(String(a[c])) - Date.parse(String(b[c]))) * (asc ? 1 : -1));
  }
  return shape.limit === null ? rows : rows.slice(0, shape.limit);
};
function withOr(table: string, q: Record<string, unknown>, shape: ReadShape = { gte: [], lte: [], order: null, limit: null, write: false }): Record<string, unknown> {
  return new Proxy(q, {
    get(t, prop: string) {
      const v = (t as Record<string, unknown>)[prop];
      if (prop === "then" && table === "push_subscriptions" && !shape.write && typeof v === "function") {
        return (resolve: (x: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          (v as (ok: (x: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise<unknown>)(
            (res) => {
              const r = res as { data: unknown; error: unknown };
              return resolve(Array.isArray(r.data) ? { ...r, data: shaped(shape, r.data as Array<Record<string, unknown>>) } : r);
            },
            reject,
          );
      }
      if (prop === "then" || typeof v !== "function") return v;
      if (prop === "or") {
        return (cond: string) => {
          h.state.calls.push({ table, method: "or", args: [cond] });
          return withOr(table, (t as unknown as { in: (c: string, ids: string[]) => Record<string, unknown> }).in("id", idsMatchingOr(table, cond)), shape);
        };
      }
      if (prop === "insert" && table === "push_subscriptions" && h.insertError) {
        const err = h.insertError;
        return () => ({ select: () => ({ single: async () => ({ data: null, error: err }) }) });
      }
      return (...args: unknown[]) => {
        if (prop === "insert" || prop === "update" || prop === "delete" || prop === "upsert") shape.write = true;
        if (table === "push_subscriptions") {
          if (prop === "gte" || prop === "lte") shape[prop].push([String(args[0]), String(args[1])]);
          if (prop === "order") shape.order = [String(args[0]), (args[1] as { ascending?: boolean } | undefined)?.ascending !== false];
          if (prop === "limit") shape.limit = Number(args[0]);
        }
        const r = (v as (...a: unknown[]) => unknown)(...args);
        return r && typeof r === "object" && !(r instanceof Promise) ? withOr(table, r as Record<string, unknown>, shape) : r;
      };
    },
  });
}

vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  return { supabase: mem.makeSupabase(h.state) };
});
vi.mock("@/lib/supabaseAdmin", async () => {
  const mem = await import("./helpers/memoryDb");
  if (!h.state) h.state = mem.freshState();
  const base = mem.makeSupabase(h.state);
  return {
    supabaseAdmin: {
      ...base,
      from: (t: string) => withOr(t, base.from(t) as unknown as Record<string, unknown>),
      auth: { getUser: vi.fn(async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad token" } })) },
    },
  };
});
// next/server after(): collected, run by the test (the route's answer never waits for it)
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));
const runAfter = async () => { for (const fn of h.after.splice(0)) await fn(); };
vi.mock("@/lib/notifications", () => ({
  queueEmail: vi.fn(async (input: Record<string, unknown>) => { h.order.push("email"); h.emails.push(input); }),
}));
vi.mock("@/lib/complianceNotify", () => ({
  notifyCompliance: vi.fn(async (input: Record<string, unknown>) => {
    h.order.push("inapp");
    const ok = !h.failFor.has(String(input.userId));
    // h.writeBell: the row lands as notifyCompliance writes it, so a sender
    // that ran would find its evidence
    if (ok && h.writeBell) {
      (h.state.tables.notifications ??= []).push({
        id: `bell-${(h.state.tables.notifications ?? []).length + 1}`, org_id: input.orgId, user_id: input.userId, kind: input.kind,
        resource_id: input.resourceId, link: input.link ?? null, actor_user_id: input.actorUserId ?? null,
        created_at: new Date().toISOString(), metadata: input.metadata ?? null,
      });
    }
    return ok;
  }),
  loadScanRetryPlan: vi.fn(async () => ({ unreadable: false, has: () => false, only: () => () => false })),
}));
vi.mock("@/lib/inAppNotifications", async (orig) => ({
  ...(await orig<typeof import("@/lib/inAppNotifications")>()),
  notifyMany: vi.fn(async (input: Record<string, unknown>) => {
    h.order.push("inapp");
    h.many.push(input);
    return { sent: (input.userIds as string[]).length, failed: 0 };
  }),
}));
vi.mock("web-push", () => {
  const api = {
    setVapidDetails: vi.fn(() => { if (h.vapidThrows) throw new Error("Vapid public key should be 65 bytes long when decoded."); }),
    sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string, options: Record<string, unknown>) => {
      const err = h.sendError.get(sub.endpoint);
      if (err) throw err;
      h.sent.push({ endpoint: sub.endpoint, payload, options });
      return { statusCode: 201, body: "", headers: {} };
    }),
    generateVAPIDKeys: vi.fn(),
    WebPushError: class extends Error {},
  };
  return { default: api, ...api };
});

import { emit, PUSH_LEG_TIMEOUT_MS, PUSH_REQUEST_MAX_RECIPIENTS, PUSH_OPT_IN_SINCE, PUSH_KEYS_MISMATCH, type EmitInput, type PushSendInput } from "@/lib/notify/dispatch";
import { __registerServerDiscoverCheck } from "@/lib/notify/recipients";
import {
  sendPushSafe, pushFromServer, pushConfig, pushPayloadFor, safePushUrl, __resetPushLogOnceForTests,
  PUSH_KINDS, PUSH_TITLES, PUSH_BODY, PUSH_FALLBACK_TITLE, PUSH_WRITER_CAP, PUSH_EVIDENCE_WINDOW_MS, DEVICE_READ_LIMIT,
} from "@/lib/push/sendPush";
import {
  pushEndpointAllowed, pushHostAllowed, pushAddressPublic, pushPublicLookup, pushServiceAgent, PushServiceAgent,
  PUSH_DEVICE_CAP, PUSH_FUTURE_SKEW_MS, PUSH_SERVICE_HOSTS, PUSH_SERVICE_HOST_SUFFIXES,
} from "@/lib/push/endpoints";
import { scanStaleHolds } from "@/lib/holds";
import { KIND_META, NOTIFICATION_KINDS, kindMeta } from "@/lib/notificationKinds";
import { POST as notifyRoute } from "@/app/api/push/notify/route";
import { GET as subscribeGet, POST as subscribeRoute } from "@/app/api/push/subscribe/route";
import { POST as unsubscribeRoute } from "@/app/api/push/unsubscribe/route";

const ORG = "o-1";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const VAPID = { VAPID_PUBLIC_KEY: "pub-key", VAPID_PRIVATE_KEY: "priv-key", VAPID_SUBJECT: "mailto:ops@example.com" };
const setVapid = (on: boolean) => {
  for (const [k, v] of Object.entries(VAPID)) {
    if (on) process.env[k] = v; else delete process.env[k];
  }
  __resetPushLogOnceForTests();
};
const members = (...uids: string[]) => uids.map((uid) => ({ org_id: ORG, uid, status: "active", role: "Engineer", roles: null, email: `${uid}@x.com` }));

beforeEach(() => {
  resetState(h.state);
  h.order.length = 0; h.many.length = 0; h.emails.length = 0; h.failFor.clear();
  h.sent.length = 0; h.sendError.clear(); h.vapidThrows = false; h.user = null;
  h.after.length = 0; h.insertError = null; h.writeBell = false;
  h.state.tables.org_members = members("a", "b", "actor");
  __registerServerDiscoverCheck(null);
  setVapid(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── emit()'s push leg (lib/notify/dispatch.ts) ─────────────────────────────

describe("OS-9 — emit() has a third, push, channel: guarded, after the other two, never throwing", () => {
  let calls: PushSendInput[];
  const spy = vi.fn(async (input: PushSendInput) => { h.order.push("push"); calls.push(input); });
  // a server caller allowed to push passes its sender per call (serverPush)
  const ev = (over: Partial<EmitInput> = {}): EmitInput => ({
    orgId: ORG, category: "status", kind: "checkout_force_released", title: "Checkout force-released by Pat", body: "b",
    resource: { type: "document", id: "d-1" }, actorUserId: "actor", actorName: "Pat",
    audience: { involved: ["a", "b", "actor"] }, serverPush: spy, ...over,
  });
  beforeEach(() => { calls = []; spy.mockClear(); });

  it("NotifChannel includes \"push\"; the default channels are in-app, email and push", () => {
    const src = read("lib/notify/dispatch.ts");
    expect(src).toContain('export type NotifChannel = "inapp" | "email" | "push";');
    expect(src).toContain('const DEFAULT_CHANNELS: NotifChannel[] = ["inapp", "email", "push"];');
    expect(src).toMatch(/channels\.includes\("push"\) && channels\.includes\("inapp"\) && kindMeta\(input\.kind\)\?\.pushWorthy === true/);
  });

  it("done-when 4: emit() with channels [\"inapp\"] never attempts push", async () => {
    await emit(ev({ channels: ["inapp"] }));
    expect(spy).not.toHaveBeenCalled();
    expect(h.order).not.toContain("push");
  });

  it("a push-worthy kind, default channels: the push leg runs AFTER the bell and email legs, for the recipients (the actor left out)", async () => {
    const r = await emit(ev());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({ orgId: ORG, kind: "checkout_force_released", resourceId: "d-1", recipients: ["a", "b"] });
    expect(h.order.at(-1)).toBe("push");
    expect(h.order.indexOf("push")).toBeGreaterThan(h.order.lastIndexOf("email"));
    expect(h.order.indexOf("push")).toBeGreaterThan(h.order.lastIndexOf("inapp"));
    expect(r).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } });
  });

  it("a kind that is not push-worthy never reaches the sender (checkout_message, doc_superseded, hold_released)", async () => {
    for (const kind of ["checkout_message", "doc_superseded", "hold_released"] as const) {
      await emit(ev({ kind }));
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("push follows a bell row: no in-app leg, no push; a recipient whose bell row did not land is not pushed", async () => {
    await emit(ev({ channels: ["email", "push"] }));
    expect(spy).not.toHaveBeenCalled();
    h.failFor.add("b");
    await emit(ev({ kind: "ack_requested", category: "assignment" })); // a compliance kind: per-recipient landed answers
    expect(calls.at(-1)!.recipients).toEqual(["a"]);
    h.failFor.add("a");
    spy.mockClear();
    await emit(ev({ kind: "ack_requested", category: "assignment" })); // no row landed: nothing to push about
    expect(spy).not.toHaveBeenCalled();
  });

  it("DEC-106 item 2: followers the discover check could not settle get the redacted notice and NO push", async () => {
    h.state.tables.subscriptions = [{ resource_type: "document", resource_id: "d-1", user_id: "f1" }];
    h.state.tables.org_members = members("a", "actor", "f1");
    __registerServerDiscoverCheck(async () => ({ ok: false, error: "503" }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await emit(ev({ kind: "hold_opened", audience: { involved: ["a"], followers: true } }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0].recipients).toEqual(["a"]);
    // the redacted follower did get the bell row (no push)
    const redactedRow = h.many.find((m) => (m.userIds as string[]).includes("f1"));
    expect((redactedRow?.metadata as Record<string, unknown>)?.redacted).toBe(true);
  });

  it("a sender that throws never fails emit() and never changes its answer", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const baseline = await emit(ev({ kind: "checkout_message" }));
    const r = await emit(ev({ serverPush: async () => { throw new Error("push service down"); } }));
    expect(r).toEqual(baseline);
    expect(quiet.mock.calls.some((c) => /push failed \(bell and email are unaffected\)/.test(String(c[0])))).toBe(true);
  });

  it("a sender that hangs is abandoned after PUSH_LEG_TIMEOUT_MS: emit() still resolves with the bell and email legs done", async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = emit(ev({ serverPush: () => new Promise<void>(() => undefined) })).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(PUSH_LEG_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(h.emails.length).toBe(2); // email already queued before the push leg
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } });
  });

  it("a server emit whose caller passes no serverPush (the maintenance cron): nothing pushed, said once, emit() unchanged", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const r1 = await emit(ev({ serverPush: undefined }));
    const r2 = await emit(ev({ serverPush: undefined }));
    expect(r1).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } });
    expect(r2).toEqual(r1);
    expect(spy).not.toHaveBeenCalled();
    // said at most once per process (the first such emit in this file says it)
    expect(info.mock.calls.filter((c) => /passed no push sender/.test(String(c[0]))).length).toBeLessThanOrEqual(1);
  });

  it("major 2: loading lib/push/sendPush registers no global sender — with VAPID on, a device and a landed bell row, a server emit without serverPush sends nothing; the same emit WITH pushFromServer does", async () => {
    // this file imports lib/push/sendPush at the top: the sender is loaded
    setVapid(true);
    h.writeBell = true;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.state.tables.push_subscriptions = [{ id: "s-a", user_id: "a", org_id: ORG, endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: "p", auth: "k", last_reminded_at: null, created_at: new Date().toISOString() }];
    await emit(ev({ audience: { involved: ["a"] }, inappRetry: {}, serverPush: undefined }));
    expect(h.sent).toHaveLength(0);
    expect(h.state.calls.filter((c) => c.table === "push_subscriptions")).toHaveLength(0);
    // control: the caller that is allowed to push passes the sender, and the push goes
    await emit(ev({ audience: { involved: ["a"] }, inappRetry: {}, serverPush: pushFromServer }));
    expect(h.sent.map((x) => x.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/a"]);
  });

  it("major 2: the maintenance cron's stale-hold nudge (scanStaleHolds → hold_opened) runs through the REAL emit and attempts no push, though the sender is loaded", async () => {
    setVapid(true);
    h.writeBell = true;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    h.state.tables.document_holds = [{
      id: "h-1", org_id: ORG, document_id: "d-1", reason: "Client Review", opened_by: "a", opened_by_name: "Pat",
      opened_at: old, expected_release_at: new Date(Date.now() - 86400_000).toISOString(), released_at: null,
    }];
    h.state.tables.push_subscriptions = [{ id: "s-a", user_id: "a", org_id: ORG, endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: "p", auth: "k", last_reminded_at: null, created_at: new Date().toISOString() }];
    expect(await scanStaleHolds(ORG)).toBe(1);
    // the nudge's bell row landed (so a sender that ran would have had its evidence) …
    expect((h.state.tables.notifications ?? []).filter((n) => n.kind === "hold_opened" && n.user_id === "a")).toHaveLength(1);
    // … and no push was attempted: no device read, nothing sent
    expect(h.state.calls.filter((c) => c.table === "push_subscriptions")).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(read("lib/holds.ts")).not.toMatch(/serverPush|pushFromServer|lib\/push\//);
  });

  it("the browser path sends an audience past the route's cap in parts of PUSH_REQUEST_MAX_RECIPIENTS", async () => {
    vi.stubGlobal("window", {});
    const { supabase } = await import("@/lib/supabase");
    const origAuth = (supabase as unknown as { auth: unknown }).auth;
    (supabase as unknown as { auth: unknown }).auth = { getSession: async () => ({ data: { session: { access_token: "tok" } } }) };
    const many = Array.from({ length: PUSH_REQUEST_MAX_RECIPIENTS + 20 }, (_, i) => `m${i}`);
    h.state.tables.org_members = members("actor", ...many);
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await emit(ev({ audience: { involved: many } }));
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      const sizes = fetchSpy.mock.calls.map((c) => (JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).recipients as string[]).length);
      expect(sizes).toEqual([PUSH_REQUEST_MAX_RECIPIENTS, 20]);
    } finally {
      (supabase as unknown as { auth: unknown }).auth = origAuth;
    }
  });

  it("the browser path posts /api/push/notify with the member's token — fire-and-forget (emit() does not wait), never throwing", async () => {
    vi.stubGlobal("window", {});
    const sessionSpy = vi.fn(async () => ({ data: { session: { access_token: "tok" } } }));
    const { supabase } = await import("@/lib/supabase");
    const origAuth = (supabase as unknown as { auth: unknown }).auth;
    (supabase as unknown as { auth: unknown }).auth = { getSession: sessionSpy };
    let release!: () => void;
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(new Response(null, { status: 204 })); }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await emit(ev());
      expect(r).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } }); // resolved while the push request is still open
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/push/notify");
      expect(init.method).toBe("POST");
      expect(init.keepalive).toBe(true);
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
      expect(JSON.parse(String(init.body))).toEqual({ orgId: ORG, kind: "checkout_force_released", resourceId: "d-1", recipients: ["a", "b"] });
      expect(spy).not.toHaveBeenCalled(); // the server sender is not used in a browser
      release();
      // a failing request is swallowed
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      await expect(emit(ev())).resolves.toEqual(r);
    } finally {
      (supabase as unknown as { auth: unknown }).auth = origAuth;
    }
  });
});

// ─── the sender (lib/push/sendPush.ts) ──────────────────────────────────────

describe("the push-worthy set (GAP-205 'default that set to small'; DEC-90 ruling) and what a push says", () => {
  it("KIND_META.pushWorthy marks exactly the six kinds the integrator ruled", () => {
    expect([...PUSH_KINDS].sort()).toEqual(
      ["ack_requested", "checkout_force_released", "hold_opened", "review_requested", "ticket_assigned", "ticket_mention"].sort(),
    );
    expect(NOTIFICATION_KINDS.filter((k) => kindMeta(k)?.pushWorthy === true)).toEqual([...PUSH_KINDS]);
    // the flag is per kind in the one registry — not a seventh map (GAP-207)
    expect(read("lib/notificationKinds.ts")).toMatch(/pushWorthy\?: boolean;/);
  });

  it("acceptance 6: one generic title per push-worthy kind; no title interpolates anything; the body is fixed", () => {
    for (const k of PUSH_KINDS) {
      const t = PUSH_TITLES[k];
      expect(t, k).toBeTruthy();
      expect(t, k).not.toMatch(/\$\{|%s|\{\w+\}/);
    }
    expect(PUSH_BODY).toBe("Open the app to see the details.");
    expect(read("lib/push/sendPush.ts")).not.toMatch(/\b(?:title|body):\s*`/);
  });

  it("pushPayloadFor writes exactly { title, body, url, tag } — the bell row's link as a root-relative path, never its title or body", () => {
    const p = pushPayloadFor("hold_opened", { id: "n1", link: "/documents/lib-1?doc=d-1", resource_id: "d-1" });
    expect(p).toEqual({ title: PUSH_TITLES.hold_opened, body: PUSH_BODY, url: "/documents/lib-1?doc=d-1", tag: "mfgos-hold_opened-d-1" });
    expect(Object.keys(p).sort()).toEqual(["body", "tag", "title", "url"]);
    expect(pushPayloadFor("not_a_kind", { id: "n2" })).toMatchObject({ title: PUSH_FALLBACK_TITLE, url: "/", tag: "mfgos-not_a_kind-n2" });
  });

  it("safePushUrl keeps the click inside the app", () => {
    expect(safePushUrl("/requests/t-1?c=9")).toBe("/requests/t-1?c=9");
    for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil", "javascript:alert(1)", "", null, 42, "/a\nb", `/${"x".repeat(2050)}`]) {
      expect(safePushUrl(bad), String(bad).slice(0, 30)).toBe("/");
    }
  });
});

describe("lib/push/sendPush.ts — who is pushed", () => {
  const now = () => new Date().toISOString();
  const bell = (user_id: string, over: Record<string, unknown> = {}) => ({
    id: `n-${user_id}-${Math.random().toString(36).slice(2, 7)}`, org_id: ORG, user_id, kind: "hold_opened", resource_id: "d-1",
    link: "/documents/lib-1?doc=d-1", title: "HOLD placed on PID-4412-R3 — litigation hold for Acme", body: "Pat placed a hold",
    actor_user_id: "actor", created_at: now(), metadata: null, ...over,
  });
  const device = (user_id: string, endpoint = `https://fcm.googleapis.com/fcm/send/${user_id}`, over: Record<string, unknown> = {}) => ({
    id: `s-${endpoint}`, user_id, org_id: ORG, endpoint, p256dh: "p256", auth: "authk", last_reminded_at: null, created_at: now(), ...over,
  });
  const input = (over: Partial<PushSendInput> = {}): PushSendInput => ({ orgId: ORG, kind: "hold_opened", resourceId: "d-1", recipients: ["a", "b"], ...over });

  it("OFF without VAPID keys: nothing read, nothing sent, logged once — today's behaviour", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.state.tables.notifications = [bell("a")];
    h.state.tables.push_subscriptions = [device("a")];
    expect(await sendPushSafe(input())).toMatchObject({ skipped: "unconfigured", sent: 0 });
    expect(await sendPushSafe(input())).toMatchObject({ skipped: "unconfigured" });
    expect(h.sent).toHaveLength(0);
    expect(h.state.calls).toHaveLength(0);
    expect(warn.mock.calls.filter((c) => /push channel is off/.test(String(c[0])))).toHaveLength(1);
    expect(pushConfig()).toBeNull();
  });

  it("an invalid VAPID configuration is OFF too (the reason logged, never the key)", async () => {
    setVapid(true);
    h.vapidThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(pushConfig()).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/does not validate/);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("priv-key");
  });

  it("a person is pushed on each device they turned on, with a payload that names nothing; the device records the row it was pushed for", async () => {
    setVapid(true);
    const row = bell("a");
    h.state.tables.notifications = [row];
    h.state.tables.push_subscriptions = [device("a", "https://fcm.googleapis.com/fcm/send/a-phone"), device("a", "https://fcm.googleapis.com/fcm/send/a-laptop")];
    const out = await sendPushSafe(input({ recipients: ["a"] }));
    expect(out).toMatchObject({ eligible: 1, attempted: 2, sent: 2, pruned: 0 });
    expect(h.sent.map((s) => s.endpoint).sort()).toEqual(["https://fcm.googleapis.com/fcm/send/a-laptop", "https://fcm.googleapis.com/fcm/send/a-phone"]);
    const payload = JSON.parse(h.sent[0].payload);
    expect(payload).toEqual({ title: "A document hold needs your attention", body: PUSH_BODY, url: "/documents/lib-1?doc=d-1", tag: "mfgos-hold_opened-d-1" });
    // GAP-205 "Do not put document titles, hold reasons or requester names in the push body"
    for (const leak of ["PID-4412", "litigation", "Acme", "Pat"]) expect(h.sent[0].payload).not.toContain(leak);
    expect(h.sent[0].options).toMatchObject({ vapidDetails: { subject: VAPID.VAPID_SUBJECT, publicKey: VAPID.VAPID_PUBLIC_KEY, privateKey: VAPID.VAPID_PRIVATE_KEY }, urgency: "high" });
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>).every((d) => d.last_reminded_at === row.created_at)).toBe(true);
  });

  it("OS-10 done-when 1: push_enabled's DEFAULT TRUE sends nothing without a device row", async () => {
    setVapid(true);
    h.state.tables.notifications = [bell("a"), bell("b")];
    h.state.tables.notification_preferences = [{ user_id: "a", push_enabled: true }]; // b has no row → default true
    h.state.tables.push_subscriptions = [];
    expect(await sendPushSafe(input())).toMatchObject({ eligible: 2, attempted: 0, sent: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("acceptance 2: push_enabled = false stops delivery WITHOUT unsubscribing the device (its row is not touched)", async () => {
    setVapid(true);
    h.state.tables.notifications = [bell("a"), bell("b")];
    h.state.tables.notification_preferences = [{ user_id: "a", push_enabled: false }];
    h.state.tables.push_subscriptions = [device("a"), device("b")];
    const out = await sendPushSafe(input());
    expect(out).toMatchObject({ eligible: 1, sent: 1 });
    expect(h.sent.map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/b"]);
    expect(h.state.writes.filter((w) => w.table === "push_subscriptions" && w.method === "delete")).toHaveLength(0);
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>).find((d) => d.user_id === "a")).toMatchObject({ last_reminded_at: null });
  });

  it("an unreadable preference sends nothing (fail closed)", async () => {
    setVapid(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.state.tables.notifications = [bell("a")];
    h.state.tables.push_subscriptions = [device("a")];
    h.state.readError.notification_preferences = { message: "timeout" };
    expect(await sendPushSafe(input({ recipients: ["a"] }))).toMatchObject({ skipped: "unreadable", sent: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("acceptance 3 / OS-2 done-when 4: a 410 or 404 from the push service deletes that subscription; a 500 keeps it", async () => {
    setVapid(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.state.tables.notifications = [bell("a"), bell("b")];
    h.state.tables.push_subscriptions = [device("a", "https://fcm.googleapis.com/fcm/send/gone"), device("a", "https://fcm.googleapis.com/fcm/send/missing"), device("b", "https://fcm.googleapis.com/fcm/send/flaky")];
    h.sendError.set("https://fcm.googleapis.com/fcm/send/gone", Object.assign(new Error("Received unexpected response code"), { statusCode: 410 }));
    h.sendError.set("https://fcm.googleapis.com/fcm/send/missing", Object.assign(new Error("Received unexpected response code"), { statusCode: 404 }));
    h.sendError.set("https://fcm.googleapis.com/fcm/send/flaky", Object.assign(new Error("Received unexpected response code"), { statusCode: 500 }));
    const out = await sendPushSafe(input());
    expect(out).toMatchObject({ attempted: 3, sent: 0, pruned: 2 });
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>).map((d) => d.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/flaky"]);
  });

  it("push follows a bell row: no row of this kind about this resource, an older one, or a REDACTED one — no push", async () => {
    setVapid(true);
    h.state.tables.push_subscriptions = [device("a"), device("b")];
    h.state.tables.notifications = [
      bell("a", { resource_id: "d-other" }),
      bell("a", { kind: "ack_requested" }),
      bell("b", { created_at: new Date(Date.now() - PUSH_EVIDENCE_WINDOW_MS - 5_000).toISOString() }),
      bell("b", { metadata: { redacted: true } }),
    ];
    expect(await sendPushSafe(input())).toMatchObject({ eligible: 0, sent: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("a browser's request (writerUid) counts only rows THAT member wrote", async () => {
    setVapid(true);
    h.state.tables.push_subscriptions = [device("a")];
    h.state.tables.notifications = [bell("a", { actor_user_id: "someone-else" })];
    expect(await sendPushSafe(input({ recipients: ["a"], writerUid: "actor" }))).toMatchObject({ eligible: 0, sent: 0 });
    h.state.tables.notifications = [bell("a")];
    expect(await sendPushSafe(input({ recipients: ["a"], writerUid: "actor" }))).toMatchObject({ eligible: 1, sent: 1 });
  });

  it("a device is pushed once per bell row: a replayed request (or a second tab) sends nothing more; a newer row does", async () => {
    setVapid(true);
    h.state.tables.push_subscriptions = [device("a")];
    h.state.tables.notifications = [bell("a", { created_at: new Date(Date.now() - 10_000).toISOString() })];
    await sendPushSafe(input({ recipients: ["a"], writerUid: "actor" }));
    await sendPushSafe(input({ recipients: ["a"], writerUid: "actor" }));
    expect(h.sent).toHaveLength(1);
    h.state.tables.notifications.unshift(bell("a"));
    await sendPushSafe(input({ recipients: ["a"], writerUid: "actor" }));
    expect(h.sent).toHaveLength(2);
  });

  it("a browser's request is capped per writer and person: past PUSH_WRITER_CAP rows in ten minutes the bell keeps them and no push goes", async () => {
    setVapid(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.state.tables.push_subscriptions = [device("a")];
    h.state.tables.notifications = Array.from({ length: PUSH_WRITER_CAP + 1 }, (_, i) => bell("a", { created_at: new Date(Date.now() - i * 1000).toISOString() }));
    expect(await sendPushSafe(input({ recipients: ["a"], writerUid: "actor" }))).toMatchObject({ capped: 1, sent: 0 });
    // the server path (no writer) is not capped
    expect(await sendPushSafe(input({ recipients: ["a"] }))).toMatchObject({ capped: 0, sent: 1 });
  });

  it("OS-10 done-when 3: a registration older than the opt-in control (the deleted reminders stack's) is never pushed", async () => {
    setVapid(true);
    h.state.tables.notifications = [bell("a")];
    h.state.tables.push_subscriptions = [
      device("a", "https://fcm.googleapis.com/fcm/send/reminders-era", { created_at: "2026-08-04T09:00:00Z" }),
      device("a", "https://fcm.googleapis.com/fcm/send/no-date", { created_at: null }),
    ];
    expect(await sendPushSafe(input({ recipients: ["a"] }))).toMatchObject({ eligible: 1, attempted: 0, sent: 0 });
    expect(h.sent).toHaveLength(0);
    expect(PUSH_OPT_IN_SINCE).toBe("2026-10-14T00:00:00.000Z");
    expect(read("lib/push/sendPush.ts")).toContain('.gte("created_at", PUSH_OPT_IN_SINCE)');
  });

  it("before 20260804 (no table) nothing is sent and it says so once; a kind that is not push-worthy is refused", async () => {
    setVapid(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.state.tables.notifications = [bell("a")];
    h.state.readError.push_subscriptions = { message: "Could not find the table 'public.push_subscriptions' in the schema cache", code: "PGRST205" };
    expect(await sendPushSafe(input({ recipients: ["a"] }))).toMatchObject({ skipped: "no-table" });
    await sendPushSafe(input({ recipients: ["a"] }));
    expect(warn.mock.calls.filter((c) => /20260804/.test(String(c[0])))).toHaveLength(1);
    expect(await sendPushSafe(input({ kind: "doc_superseded" }))).toMatchObject({ skipped: "kind" });
  });

  it("never throws, whatever breaks", async () => {
    setVapid(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(sendPushSafe(null as unknown as PushSendInput)).resolves.toMatchObject({ sent: 0 });
    await expect(sendPushSafe(input({ recipients: undefined as unknown as string[] }))).resolves.toMatchObject({ sent: 0 });
  });

  // ── fix pass: the review's blocker (SSRF / amplification) ──────────────────
  it("blocker: a device row naming anything but a push service's host is NEVER sent to, and is deleted; the push services' hosts are", async () => {
    setVapid(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.state.tables.notifications = [bell("a")];
    const bad = [
      "https://10.0.3.7:8443/admin/x", "https://169.254.169.254/latest/meta-data", "https://victim.example/hook",
      "https://fcm.googleapis.com:8443/fcm/send/x", "https://evil@fcm.googleapis.com/fcm/send/x", "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x", "https://notify.windows.com/w", "https://localhost/x",
    ];
    const good = [
      "https://fcm.googleapis.com/fcm/send/ok", "https://updates.push.services.mozilla.com/wpush/v2/ok",
      "https://wns2-par02p.notify.windows.com/w/?token=ok", "https://web.push.apple.com/ok",
    ];
    h.state.tables.push_subscriptions = [...bad, ...good].map((e) => device("a", e));
    const out = await sendPushSafe(input({ recipients: ["a"] }));
    expect(h.sent.map((x) => x.endpoint).sort()).toEqual([...good].sort());
    for (const e of bad) expect(h.sent.some((x) => x.endpoint === e), e).toBe(false);
    expect(out).toMatchObject({ attempted: good.length, sent: good.length, pruned: bad.length });
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>).map((d) => d.endpoint).sort()).toEqual([...good].sort());
    expect(warn.mock.calls.some((c) => /naming no push service were not sent to/.test(String(c[0])))).toBe(true);
  });

  it("pushEndpointAllowed: exact hosts and label-boundary suffixes only; https, no port, no user-info", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://FCM.googleapis.com/x",
      "https://autopush.push.services.mozilla.com/x", "https://db5p.notify.windows.com/w/?token=1", "https://api.push.apple.com/3/device/x",
      "https://fcm.googleapis.com?x=1"]) {
      expect(pushEndpointAllowed(ok), ok).toBe(true);
    }
    for (const bad of ["https://push.apple.com/x", "https://xpush.apple.com/x", "https://fcm.googleapis.com./x", "https://user:pw@web.push.apple.com/x",
      "ftp://fcm.googleapis.com/x", "https://[::1]/x", "not a url", "", null, 42, `https://fcm.googleapis.com/${"x".repeat(2100)}`,
      // fix pass 2: no port at all (url.parse keeps an explicit :443, WHATWG drops it), a path or query must follow the host
      "https://fcm.googleapis.com:443/x", "https://fcm.googleapis.com", "https://fcm.googleapis.com#x",
      // fix pass 2: nothing either parser may strip, decode or re-read
      " https://fcm.googleapis.com/x", "https://fcm.googleapis.com/x y", "https://fcm.goo\tgleapis.com/x", "https://fcm%2Egoogleapis.com/x",
      "https://fcm.googleapis.com\\@evil.example/x", "https://fcm.googleapis.com/\u00e9"]) {
      expect(pushEndpointAllowed(bad), String(bad).slice(0, 40)).toBe(false);
    }
    // fix pass 2 (the second review's blocker): a host holding a character WHATWG accepts in a host and the
    // legacy url.parse (web-push's) stops at — the two would name different hosts — is refused
    for (const ch of [";", "{", "}", "'", "`", '"', "|", "^"]) {
      for (const e of [`https://10.0.3.7${ch}.push.apple.com/x`, `https://169.254.169.254${ch}.notify.windows.com/latest`,
        `https://attacker.example${ch}.push.services.mozilla.com/hook`, `https://internal${ch}fcm.googleapis.com/x`, `https://fcm.googleapis.com${ch}/x`]) {
        expect(pushEndpointAllowed(e), e).toBe(false);
      }
    }
    expect(pushHostAllowed("fcm.googleapis.com")).toBe(true);
    expect(pushHostAllowed("10.0.3.7")).toBe(false);
    expect(pushHostAllowed("a;b.push.apple.com")).toBe(false);
    expect([...PUSH_SERVICE_HOSTS].sort()).toEqual(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
    expect([...PUSH_SERVICE_HOST_SUFFIXES].sort()).toEqual([".notify.windows.com", ".push.apple.com", ".push.services.mozilla.com"]);
  });

  it("blocker: at most PUSH_DEVICE_CAP devices per person are pushed — the newest", async () => {
    setVapid(true);
    h.state.tables.notifications = [bell("a")];
    const t0 = Date.now() - 60 * 60_000;
    h.state.tables.push_subscriptions = Array.from({ length: PUSH_DEVICE_CAP + 5 }, (_, i) =>
      device("a", `https://fcm.googleapis.com/fcm/send/dev-${String(i).padStart(2, "0")}`, { created_at: new Date(t0 + i * 60_000).toISOString() }));
    const out = await sendPushSafe(input({ recipients: ["a"] }));
    expect(PUSH_DEVICE_CAP).toBe(10);
    expect(out).toMatchObject({ attempted: PUSH_DEVICE_CAP, sent: PUSH_DEVICE_CAP });
    // the five OLDEST were left out
    expect(h.sent.map((x) => x.endpoint).sort()).toEqual(Array.from({ length: PUSH_DEVICE_CAP }, (_, i) => `https://fcm.googleapis.com/fcm/send/dev-${String(i + 5).padStart(2, "0")}`));
    const src = read("lib/push/sendPush.ts");
    expect(src).toMatch(/\.lte\("created_at", latestIso\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.limit\(limit\)/);
    expect(src).toContain("await readDevices(part, DEVICE_READ_LIMIT)");
    expect(src).toContain("await readDevices([uid], PUSH_DEVICE_CAP)");
  });

  // ── fix pass 2: one person's registrations never cost another their push ──
  it("fix pass 2: one person holding 1,200 registrations never costs a neighbour in the same device read their push — the part is read again person by person", async () => {
    setVapid(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.state.tables.notifications = [bell("a"), bell("b")];
    const t0 = Date.now() - 30 * 60_000;
    h.state.tables.push_subscriptions = [
      device("b", "https://fcm.googleapis.com/fcm/send/b-only", { created_at: new Date(t0).toISOString() }),
      // all newer than b's one device: a single 1000-row read, newest first, would hold only these
      ...Array.from({ length: 1200 }, (_, i) => device("a", `https://fcm.googleapis.com/fcm/send/a-${i}`, { created_at: new Date(t0 + 1000 + i * 1000).toISOString() })),
    ];
    const out = await sendPushSafe(input({ recipients: ["a", "b"] }));
    expect(h.sent.map((x) => x.endpoint)).toContain("https://fcm.googleapis.com/fcm/send/b-only");
    expect(h.sent.filter((x) => x.endpoint.includes("/a-")).map((x) => x.endpoint).sort())
      .toEqual(Array.from({ length: PUSH_DEVICE_CAP }, (_, i) => `https://fcm.googleapis.com/fcm/send/a-${1190 + i}`).sort());
    expect(out).toMatchObject({ eligible: 2, attempted: PUSH_DEVICE_CAP + 1, sent: PUSH_DEVICE_CAP + 1 });
    const limits = h.state.calls.filter((c) => c.table === "push_subscriptions" && c.method === "limit").map((c) => c.args[0]);
    expect(limits).toEqual([DEVICE_READ_LIMIT, PUSH_DEVICE_CAP, PUSH_DEVICE_CAP]);
    expect(warn.mock.calls.some((c) => /read again person by person/.test(String(c[0])))).toBe(true);
  });

  it("fix pass 2: a registration dated in the future is not read — hand-written rows dated 2100 never hold a person's newest places; one inside the skew margin still is", async () => {
    setVapid(true);
    h.state.tables.notifications = [bell("a")];
    h.state.tables.push_subscriptions = [
      ...Array.from({ length: PUSH_DEVICE_CAP }, (_, i) => device("a", `https://fcm.googleapis.com/fcm/send/future-${i}`, { created_at: `2100-01-01T00:00:0${i}.000Z` })),
      device("a", "https://fcm.googleapis.com/fcm/send/real"),
      device("a", "https://fcm.googleapis.com/fcm/send/skewed", { created_at: new Date(Date.now() + PUSH_FUTURE_SKEW_MS / 2).toISOString() }),
    ];
    const out = await sendPushSafe(input({ recipients: ["a"] }));
    expect(h.sent.map((x) => x.endpoint).sort()).toEqual(["https://fcm.googleapis.com/fcm/send/real", "https://fcm.googleapis.com/fcm/send/skewed"]);
    expect(out).toMatchObject({ attempted: 2, sent: 2, pruned: 0 });
    expect(PUSH_FUTURE_SKEW_MS).toBe(5 * 60_000);
  });

  // ── fix pass 2: the second review's blocker — the two URL parsers ─────────
  it("fix pass 2: every endpoint pushEndpointAllowed accepts is one the REAL web-push (https.request stubbed) addresses to a push service's host — never a host a parser gap names", async () => {
    const realMod = await vi.importActual<Record<string, unknown>>("web-push");
    const real = ((realMod as { default?: unknown }).default ?? realMod) as {
      sendNotification: (sub: unknown, payload: string, options: Record<string, unknown>) => Promise<unknown>;
      generateVAPIDKeys: () => { publicKey: string; privateKey: string };
    };
    const seen: Array<{ hostname: unknown; port: unknown; agent: unknown }> = [];
    vi.spyOn(https, "request").mockImplementation(((opts: https.RequestOptions) => {
      seen.push({ hostname: opts.hostname, port: opts.port, agent: opts.agent });
      const req = Object.assign(new EventEmitter(), {
        write: () => undefined,
        destroy: () => undefined,
        end: () => { setImmediate(() => req.emit("error", Object.assign(new Error("stubbed"), { code: "ESTUB" }))); },
      });
      return req;
    }) as unknown as typeof https.request);
    const vapid = real.generateVAPIDKeys();
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
    const named = [...PUSH_SERVICE_HOSTS, ...PUSH_SERVICE_HOST_SUFFIXES.map((x) => `edge${x}`)];
    const delimiters = [";", "{", "}", "'", "`", '"', "|", "^", "\\", "%", "@", "#", ":", " ", "\t", "[", "]", "<", ">", "&", "$", "!", "*", "(", ")", "+", ",", "=", "~", "/", "?"];
    const reviewers = ["https://10.0.3.7;.push.apple.com/x", "https://169.254.169.254{.notify.windows.com/latest", "https://attacker.example'.push.services.mozilla.com/hook"];
    const good = ["https://fcm.googleapis.com/fcm/send/ok", "https://updates.push.services.mozilla.com/wpush/v2/ok", "https://wns2-par02p.notify.windows.com/w/?token=ok", "https://web.push.apple.com/ok"];
    const candidates = [...reviewers, ...good];
    for (const ch of delimiters) {
      for (const host of named) {
        const suffix = host.slice(host.indexOf("."));
        candidates.push(`https://10.0.3.7${ch}${suffix}/x`, `https://${host}${ch}.attacker.example/x`, `https://attacker.example${ch}${host}/x`,
          `https://${host}${ch}/x`, `https://${host}:443${ch}/x`, `https://u${ch}@${host}/x`);
      }
    }
    for (const e of reviewers) expect(pushEndpointAllowed(e), e).toBe(false);
    let accepted = 0;
    for (const e of candidates) {
      if (!pushEndpointAllowed(e)) continue;
      accepted += 1;
      const before = seen.length;
      await real.sendNotification({ endpoint: e, keys }, "{}", {
        vapidDetails: { subject: "mailto:ops@example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 60, agent: pushServiceAgent(),
      }).catch(() => undefined);
      expect(seen.length, e).toBe(before + 1);
      const last = seen[seen.length - 1];
      expect(pushHostAllowed(last.hostname), `${JSON.stringify(e)} → ${String(last.hostname)}`).toBe(true);
      expect(last.hostname, e).toBe(new URL(e).hostname);
      expect(last.port ?? null, e).toBeNull();
      expect(last.agent, e).toBeInstanceOf(PushServiceAgent);
    }
    expect(accepted).toBeGreaterThanOrEqual(good.length);
    expect(candidates.length).toBeGreaterThan(1000);
  });

  it("fix pass 2 (defence in depth): every send goes through pushServiceAgent(), which connects only to a push service's host — an IP literal or any other host is refused before any socket", async () => {
    setVapid(true);
    h.state.tables.notifications = [bell("a")];
    h.state.tables.push_subscriptions = [device("a")];
    await sendPushSafe(input({ recipients: ["a"] }));
    expect(h.sent[0].options.agent).toBe(pushServiceAgent());
    expect(pushServiceAgent()).toBeInstanceOf(https.Agent);
    const agent = new PushServiceAgent();
    try {
      for (const host of ["10.0.3.7", "169.254.169.254", "attacker.example", "fcm.googleapis.com.attacker.example", "localhost", "10.0.3.7;.push.apple.com"]) {
        const err = await new Promise<Error | null>((resolve) => { agent.createConnection({ host, port: 443 }, (e) => resolve(e)); });
        expect((err as { code?: string } | null)?.code, host).toBe("EPUSHHOST");
      }
      const wrongPort = await new Promise<Error | null>((resolve) => { agent.createConnection({ host: "fcm.googleapis.com", port: 8443 }, (e) => resolve(e)); });
      expect((wrongPort as { code?: string } | null)?.code).toBe("EPUSHHOST");
      // through a real https.request (no network: refused before a socket exists)
      const viaRequest = await new Promise<{ code?: string }>((resolve) => {
        const req = https.request({ hostname: "10.0.3.7", path: "/x", method: "POST", agent });
        req.on("error", (e) => resolve(e as { code?: string }));
        req.end();
      });
      expect(viaRequest.code).toBe("EPUSHHOST");
      // a push service's host goes on to the TLS connection, with the public-only lookup
      const tls = vi.spyOn(https.Agent.prototype, "createConnection").mockImplementation((() => undefined) as never);
      agent.createConnection({ host: "fcm.googleapis.com", port: 443 }, () => undefined);
      expect(tls).toHaveBeenCalledTimes(1);
      expect((tls.mock.calls[0][0] as { lookup?: unknown; host?: unknown }).lookup).toBe(pushPublicLookup);
    } finally {
      agent.destroy();
    }
  });

  it("fix pass 2 (defence in depth): the agent's lookup refuses any DNS answer holding a loopback, private, link-local, CGNAT, multicast, mapped or reserved address", async () => {
    for (const a of ["142.250.80.10", "17.253.144.10", "2607:f8b0:4005:80b::200a"]) expect(pushAddressPublic(a), a).toBe(true);
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "::ffff:10.0.0.1", "::ffff:142.250.80.10", "fe80::1", "fd00::1", "ff02::1", "64:ff9b::a00:1", "not-an-ip"]) {
      expect(pushAddressPublic(a), a).toBe(false);
    }
    const answer = (addrs: Array<{ address: string; family: number }>) =>
      vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: Error | null, a: unknown) => void) => cb(null, addrs)) as never);
    const ask = (all: boolean) => new Promise<{ err: { code?: string } | null; address: unknown; family?: number }>((resolve) => {
      pushPublicLookup("fcm.googleapis.com", { all }, (err, address, family) => resolve({ err: err as { code?: string } | null, address, family }));
    });
    answer([{ address: "142.250.80.10", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    expect((await ask(false)).err?.code).toBe("EPUSHADDRESS");
    vi.restoreAllMocks();
    answer([{ address: "142.250.80.10", family: 4 }]);
    expect(await ask(false)).toMatchObject({ err: null, address: "142.250.80.10", family: 4 });
    expect(await ask(true)).toMatchObject({ err: null, address: [{ address: "142.250.80.10", family: 4 }] });
  });

  // ── fix pass: one push per device per bell row, claimed BEFORE the send ──
  it("two requests about the same row at once send ONE push per device (the claim lands once)", async () => {
    setVapid(true);
    h.state.tables.notifications = [bell("a")];
    h.state.tables.push_subscriptions = [device("a")];
    const [o1, o2] = await Promise.all([sendPushSafe(input({ recipients: ["a"] })), sendPushSafe(input({ recipients: ["a"] }))]);
    expect(h.sent).toHaveLength(1);
    expect(o1.sent + o2.sent).toBe(1);
    expect(o1.attempted + o2.attempted).toBe(1);
    const claims = h.state.calls.filter((c) => c.table === "push_subscriptions" && c.method === "or");
    expect(claims).toHaveLength(2);
    expect(String(claims[0].args[0])).toMatch(/^last_reminded_at\.is\.null,last_reminded_at\.lt\."[^"]+"$/);
  });

  it("the claim comes before the send; a failed send (not 404 / 410) puts it back, so a later request about the row tries again", async () => {
    setVapid(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const row = bell("a");
    h.state.tables.notifications = [row];
    h.state.tables.push_subscriptions = [device("a")];
    h.sendError.set("https://fcm.googleapis.com/fcm/send/a", Object.assign(new Error("Received unexpected response code"), { statusCode: 503 }));
    expect(await sendPushSafe(input({ recipients: ["a"] }))).toMatchObject({ attempted: 1, sent: 0, pruned: 0 });
    const writes = h.state.writes.filter((w) => w.table === "push_subscriptions" && w.method === "update");
    expect(writes.map((w) => (w.payload as Record<string, unknown>).last_reminded_at)).toEqual([row.created_at, null]);
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>)[0].last_reminded_at).toBeNull();
    h.sendError.clear();
    expect(await sendPushSafe(input({ recipients: ["a"] }))).toMatchObject({ sent: 1 });
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>)[0].last_reminded_at).toBe(row.created_at);
  });

  it("a claim the database refuses with an error sends nothing (at most once, never twice)", async () => {
    setVapid(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.state.tables.notifications = [bell("a")];
    h.state.tables.push_subscriptions = [device("a")];
    h.state.tableWriteError = { push_subscriptions: { message: "upstream timeout" } };
    expect(await sendPushSafe(input({ recipients: ["a"] }))).toMatchObject({ attempted: 0, sent: 0 });
    expect(h.sent).toHaveLength(0);
  });
});

// ─── the routes ─────────────────────────────────────────────────────────────

const post = (route: (req: NextRequest) => Promise<Response>, url: string, body: unknown, token: string | null = "tok") =>
  route(new NextRequest(`http://app.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

describe("POST /api/push/notify — the browser half of the push leg", () => {
  const body = { orgId: ORG, kind: "hold_opened", resourceId: "d-1", recipients: ["a", "b"] };

  it("off without VAPID keys: 204 before any database call", async () => {
    const res = await post(notifyRoute, "/api/push/notify", body, null);
    expect(res.status).toBe(204);
    expect(h.state.calls).toHaveLength(0);
  });

  it("401 without a session; 400 for a kind that is not push-worthy or too many recipients; 403 for a non-member", async () => {
    setVapid(true);
    expect((await post(notifyRoute, "/api/push/notify", body, null)).status).toBe(401);
    h.user = { id: "actor" };
    expect((await post(notifyRoute, "/api/push/notify", { ...body, kind: "doc_superseded" })).status).toBe(400);
    expect((await post(notifyRoute, "/api/push/notify", { ...body, recipients: Array.from({ length: 501 }, (_, i) => `u${i}`) })).status).toBe(400);
    h.user = { id: "stranger" };
    expect((await post(notifyRoute, "/api/push/notify", body)).status).toBe(403);
  });

  it("pushes only for rows the caller wrote, and never says who was pushed", async () => {
    setVapid(true);
    h.user = { id: "actor" };
    h.state.tables.notifications = [
      { id: "n1", org_id: ORG, user_id: "a", kind: "hold_opened", resource_id: "d-1", link: "/x", actor_user_id: "actor", created_at: new Date().toISOString(), metadata: null },
      { id: "n2", org_id: ORG, user_id: "b", kind: "hold_opened", resource_id: "d-1", link: "/x", actor_user_id: "other", created_at: new Date().toISOString(), metadata: null },
    ];
    h.state.tables.push_subscriptions = [
      { id: "s1", user_id: "a", endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: "p", auth: "k", last_reminded_at: null, created_at: new Date().toISOString() },
      { id: "s2", user_id: "b", endpoint: "https://fcm.googleapis.com/fcm/send/b", p256dh: "p", auth: "k", last_reminded_at: null, created_at: new Date().toISOString() },
    ];
    const res = await post(notifyRoute, "/api/push/notify", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.sent).toHaveLength(0); // nothing sent before the answer …
    await runAfter();               // … the sends run after it
    expect(h.sent.map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/a"]);
  });

  it("blocker: the answer never waits for the sends — a push service that hangs does not hold the response, and every outcome answers the same", async () => {
    setVapid(true);
    h.user = { id: "actor" };
    const now = new Date().toISOString();
    h.state.tables.notifications = [{ id: "n1", org_id: ORG, user_id: "a", kind: "hold_opened", resource_id: "d-1", link: "/x", actor_user_id: "actor", created_at: now, metadata: null }];
    h.state.tables.push_subscriptions = [{ id: "s1", user_id: "a", endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: "p", auth: "k", last_reminded_at: null, created_at: now }];
    const webpush = (await import("web-push")).default as unknown as { sendNotification: ReturnType<typeof vi.fn> };
    webpush.sendNotification.mockImplementationOnce(() => new Promise(() => undefined)); // never answers
    const res = await post(notifyRoute, "/api/push/notify", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.after).toHaveLength(1);
    // the route itself read nothing about devices or bell rows before answering
    expect(h.state.calls.filter((c) => c.table === "push_subscriptions" || c.table === "notifications")).toHaveLength(0);
    // the one send in the route is inside after()
    const route = read("app/api/push/notify/route.ts");
    expect(route).toMatch(/after\(async \(\) => \{\s*await sendPushSafe\(/);
    expect(route.match(/sendPushSafe\(/g)).toHaveLength(1);
  });
});

describe("/api/push/subscribe and /api/push/unsubscribe — the per-device opt-in", () => {
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };

  it("GET says whether push is configured and gives the PUBLIC key only", async () => {
    expect(await (await subscribeGet()).json()).toEqual({ configured: false, publicKey: null });
    setVapid(true);
    const on = await (await subscribeGet()).json();
    expect(on).toEqual({ configured: true, publicKey: "pub-key" });
    expect(JSON.stringify(on)).not.toContain("priv-key");
  });

  it("POST stores the caller's device as their own row (an active member only; 503 when push is off)", async () => {
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub }, null)).status).toBe(401);
    h.user = { id: "a" };
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub })).status).toBe(503);
    setVapid(true);
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: { ...sub, endpoint: "http://insecure.example/x" } })).status).toBe(400);
    // blocker: an https URL that is not a push service's is refused too
    for (const e of ["https://10.0.3.7:8443/admin/x", "https://victim.example/hook", "https://fcm.googleapis.com:8443/x", "https://evil@fcm.googleapis.com/x"]) {
      const r = await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: { ...sub, endpoint: e } });
      expect(r.status, e).toBe(400);
      expect((await r.json()).error).toBe("That is not a browser push subscription.");
    }
    expect(h.state.tables.push_subscriptions ?? []).toEqual([]);
    h.user = { id: "stranger" };
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub })).status).toBe(403);
    h.user = { id: "a" };
    const res = await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub });
    expect(res.status).toBe(200);
    expect(h.state.tables.push_subscriptions).toEqual([
      expect.objectContaining({ user_id: "a", org_id: ORG, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
    ]);
  });

  it("the same browser turned on by a second person becomes theirs — only when they present the SAME keys (they hold the live subscription); one conditional update, nothing deleted", async () => {
    setVapid(true);
    const earlier = new Date(Date.now() - 3600_000).toISOString();
    h.state.tables.push_subscriptions = [{ id: "old", user_id: "b", org_id: ORG, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, created_at: earlier, last_reminded_at: earlier }];
    h.user = { id: "a" };
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub })).status).toBe(200);
    const rows = h.state.tables.push_subscriptions as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "old", user_id: "a", org_id: ORG, last_reminded_at: null });
    expect(Date.parse(String(rows[0].created_at))).toBeGreaterThan(Date.parse(earlier)); // a fresh opt-in
    expect(h.state.writes.filter((w) => w.table === "push_subscriptions" && w.method === "delete")).toHaveLength(0);
    // a re-subscribe by the same person is the same conditional update
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub })).status).toBe(200);
    expect(h.state.tables.push_subscriptions).toHaveLength(1);
  });

  it("minor: knowing someone's endpoint takes nothing over — other keys answer 409 keys_mismatch and the stored row is untouched, in any tenant", async () => {
    setVapid(true);
    const theirs = { id: "theirs", user_id: "b", org_id: "o-other", endpoint: sub.endpoint, p256dh: "theirP256", auth: "theirAuth", created_at: "2026-10-14T08:00:00.000Z", last_reminded_at: null };
    h.state.tables.push_subscriptions = [{ ...theirs }];
    h.user = { id: "a" };
    h.insertError = { message: "duplicate key value violates unique constraint \"push_subscriptions_endpoint_key\"", code: "23505" };
    const res = await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: PUSH_KEYS_MISMATCH });
    expect(h.state.tables.push_subscriptions).toEqual([theirs]);
    expect(h.state.writes.filter((w) => w.table === "push_subscriptions" && w.method === "delete")).toHaveLength(0);
  });

  it("minor: a write that fails leaves the earlier registration as it was (no delete-then-insert)", async () => {
    setVapid(true);
    const before = { id: "old", user_id: "b", org_id: ORG, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, created_at: "2026-10-14T08:00:00.000Z", last_reminded_at: null };
    h.state.tables.push_subscriptions = [{ ...before }];
    h.user = { id: "a" };
    h.state.tableWriteError = { push_subscriptions: { message: "upstream timeout" } };
    const res = await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub });
    expect(res.status).toBe(500);
    expect(h.state.tables.push_subscriptions).toEqual([before]);
  });

  it("blocker: a person keeps at most PUSH_DEVICE_CAP registrations — a new one removes their oldest, never the one just made, never anyone else's", async () => {
    setVapid(true);
    h.user = { id: "a" };
    const t0 = Date.parse("2026-10-14T01:00:00.000Z");
    h.state.tables.push_subscriptions = [
      ...Array.from({ length: PUSH_DEVICE_CAP }, (_, i) => ({ id: `a-${i}`, user_id: "a", org_id: ORG, endpoint: `https://fcm.googleapis.com/fcm/send/a-${i}`, p256dh: "p", auth: "k", created_at: new Date(t0 + i * 60_000).toISOString() })),
      { id: "b-0", user_id: "b", org_id: ORG, endpoint: "https://fcm.googleapis.com/fcm/send/b-0", p256dh: "p", auth: "k", created_at: new Date(t0 - 60_000).toISOString() },
    ];
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub })).status).toBe(200);
    const rows = h.state.tables.push_subscriptions as Array<Record<string, unknown>>;
    const mine = rows.filter((r) => r.user_id === "a");
    expect(mine).toHaveLength(PUSH_DEVICE_CAP);
    expect(mine.some((r) => r.endpoint === sub.endpoint)).toBe(true);
    expect(mine.some((r) => r.id === "a-0")).toBe(false); // the oldest went
    expect(rows.some((r) => r.id === "b-0")).toBe(true);
  });

  it("before 20260804 the POST says the database update is missing and changes nothing", async () => {
    setVapid(true);
    h.user = { id: "a" };
    h.state.tableWriteError = { push_subscriptions: { message: "relation \"public.push_subscriptions\" does not exist", code: "42P01" } };
    const res = await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/20260804_push_subscriptions\.sql/);
  });

  it("unsubscribe removes only the caller's own row for that endpoint; nothing to remove is not an error", async () => {
    h.state.tables.push_subscriptions = [
      { id: "s1", user_id: "a", endpoint: "https://fcm.googleapis.com/fcm/send/1" },
      { id: "s2", user_id: "b", endpoint: "https://fcm.googleapis.com/fcm/send/2" },
    ];
    expect((await post(unsubscribeRoute, "/api/push/unsubscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/1" }, null)).status).toBe(401);
    h.user = { id: "a" };
    expect(await (await post(unsubscribeRoute, "/api/push/unsubscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/2" })).json()).toEqual({ ok: true, removed: 0 });
    expect(await (await post(unsubscribeRoute, "/api/push/unsubscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/1" })).json()).toEqual({ ok: true, removed: 1 });
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>).map((r) => r.id)).toEqual(["s2"]);
  });
});

// ─── the rest of the build, read from source ────────────────────────────────

describe("the rest of the build", () => {
  it("web-push is a dependency at an exact version (3.6.7), and the lockfile resolves it", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["web-push"]).toBe("3.6.7");
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
    expect(lock.packages[""].dependencies?.["web-push"]).toBe("3.6.7");
    expect(lock.packages["node_modules/web-push"]?.version).toBe("3.6.7");
  });

  it(".env.example documents VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT next to CRON_SECRET, blank keys; the stale reminders/run line is gone", () => {
    const env = read(".env.example");
    expect(env).toMatch(/^VAPID_PUBLIC_KEY=$/m);
    expect(env).toMatch(/^VAPID_PRIVATE_KEY=$/m);
    expect(env).toMatch(/^VAPID_SUBJECT=mailto:/m);
    expect(env.indexOf("VAPID_PUBLIC_KEY=")).toBeGreaterThan(env.indexOf("CRON_SECRET="));
    expect(env.indexOf("VAPID_PUBLIC_KEY=")).toBeLessThan(env.indexOf("RESEND_API_KEY="));
    expect(env).not.toMatch(/reminders\/run/);
    expect(env).toMatch(/embed-drain, send-queued/);
    expect(env).not.toMatch(/world-callable/);
  });

  it("acceptance 5: no new vercel.json cron entry — the two that exist, the cron only prunes", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string }> };
    expect(vercel.crons.map((c) => c.path).sort()).toEqual(["/api/cron/maintenance", "/api/data-export/run-scheduled"]);
    const cron = read("app/api/cron/maintenance/route.ts");
    expect(cron).toContain("result.pushSubscriptionsPruned = await prunePushSubscriptions(sb, result.errors, runEnd);");
    expect(cron).not.toMatch(/lib\/push\/sendPush"|sendPushSafe/);
  });

  it("OS-3 done-when 1 / 2: Notification.requestPermission is called in ONE place — the settings opt-in, behind the auth gate — and pushManager.subscribe only there", () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "__tests__" && !n.startsWith(".")) walk(p); }
        else if (/\.(tsx?|js)$/.test(n) && !n.endsWith(".d.ts")) files.push(p);
      }
    };
    for (const d of ["app", "components", "lib", "hooks"]) walk(join(root, d));
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    const callers = (re: RegExp) => files.filter((f) => re.test(strip(readFileSync(f, "utf8")))).map((f) => relative(root, f));
    expect(callers(/requestPermission\(/)).toEqual(["components/settings/PushOptIn.tsx"]);
    expect(callers(/pushManager\.subscribe\(/)).toEqual(["components/settings/PushOptIn.tsx"]);
    // mounted only on the protected settings page — never in the root layout
    expect(read("app/(protected)/settings/notifications/page.tsx")).toContain("<PushOptIn uid={uid} orgId={activeOrgId ?? null} />");
    expect(read("app/layout.tsx")).not.toMatch(/PushOptIn|requestPermission/);
    expect(read("components/pwa/ServiceWorkerManager.tsx")).not.toMatch(/requestPermission/);
  });

  it("the settings page's own Save never writes push_enabled (the card saves it alone)", () => {
    const page = read("app/(protected)/settings/notifications/page.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    expect(page).not.toMatch(/push_enabled/);   // code only — the header comment names it
    expect(read("components/settings/PushOptIn.tsx")).toContain('.upsert({ user_id: uid, push_enabled: v }, { onConflict: "user_id" })');
  });

  it("dispatch.ts stays browser-safe: it never imports web-push, the service role or the sender", () => {
    const src = read("lib/notify/dispatch.ts");
    expect(src).not.toMatch(/from "web-push"|supabaseAdmin|from "@\/lib\/push\/sendPush"|import\("@\/lib\/push\/sendPush"\)/);
  });

  it("major 2: no module-level push sender anywhere — a server push is the caller's serverPush, never load order", () => {
    const dispatch = read("lib/notify/dispatch.ts");
    expect(dispatch).not.toMatch(/__registerServerPushSender|let serverPushSender/);
    expect(dispatch).toContain("serverPush?: PushSender;");
    expect(dispatch).toContain("await pushLeg({ orgId: input.orgId, kind: input.kind, resourceId: input.resource.id, recipients: pushTo }, input.serverPush);");
    const sender = read("lib/push/sendPush.ts");
    expect(sender).not.toMatch(/__register\w*\(/);
    expect(sender).toContain("export const pushFromServer: PushSender = async (input) => { await sendPushSafe(input); };");
    // the maintenance cron passes no sender and loads none
    expect(read("app/api/cron/maintenance/route.ts")).not.toMatch(/pushFromServer|serverPush|from "@\/lib\/push\/sendPush"/);
  });

  it("blocker: the subscribe route and the sender share ONE allow-list (lib/push/endpoints.ts), and the cron prunes by it too", () => {
    expect(read("app/api/push/subscribe/route.ts")).toMatch(/!pushEndpointAllowed\(endpoint\)/);
    expect(read("app/api/push/subscribe/route.ts")).not.toMatch(/protocol === "https:"/);
    expect(read("lib/push/sendPush.ts")).toMatch(/if \(!pushEndpointAllowed\(d\.endpoint\)\) \{ offService\.push\(d\.id\); continue; \}/);
    expect(read("app/api/cron/maintenance/route.ts")).toMatch(/!pushEndpointAllowed\(r\.endpoint\)/);
    // fix pass 2: the allow-list reads the host with BOTH parsers, and the sender hands web-push the push-service agent
    const endpoints = read("lib/push/endpoints.ts");
    expect(endpoints).toContain('import { parse as legacyUrlParse } from "node:url";');
    expect(endpoints).toMatch(/legacy\.hostname === host && legacy\.port === null && legacy\.auth === null/);
    expect(read("lib/push/sendPush.ts")).toMatch(/timeout: PUSH_SEND_TIMEOUT_MS, agent,/);
  });

  it("fix pass 2: lib/push/endpoints.ts and lib/push/sendPush.ts are server-only — no browser module imports either; the card takes PUSH_KEYS_MISMATCH from dispatch.ts", () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "__tests__" && !n.startsWith(".")) walk(p); }
        else if (/\.tsx?$/.test(n) && !n.endsWith(".d.ts")) files.push(p);
      }
    };
    for (const d of ["app", "components", "lib", "hooks"]) walk(join(root, d));
    const client = files.filter((f) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(client.length).toBeGreaterThan(50);
    const offenders = client.filter((f) => /from "@\/lib\/push\/(endpoints|sendPush)"|import\("@\/lib\/push\/(endpoints|sendPush)"\)/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
    // dispatch.ts is bundled for the browser
    expect(read("lib/notify/dispatch.ts")).not.toMatch(/@\/lib\/push\/endpoints/);
    expect(read("components/settings/PushOptIn.tsx")).toContain('import { PUSH_KEYS_MISMATCH, PUSH_OPT_IN_SINCE } from "@/lib/notify/dispatch";');
    expect(PUSH_KEYS_MISMATCH).toBe("keys_mismatch");
  });

  it("OS-11 by record: the three registrations name a table the app now reads and writes", () => {
    expect(read("lib/schemaExpectations.ts")).toContain('{ table: "push_subscriptions", migration: "20260804_push_subscriptions.sql" }');
    expect(read("lib/exportTables.ts")).toMatch(/push_subscriptions:\s*\n\s*"per-device Web Push credentials/);
    expect(read("lib/dataRestore.ts")).toContain('push_subscriptions: "device push registrations are machine-specific — re-established per device"');
    for (const f of ["lib/push/sendPush.ts", "app/api/push/subscribe/route.ts", "app/api/push/unsubscribe/route.ts", "app/api/cron/maintenance/route.ts"]) {
      expect(read(f), f).toMatch(/\.from\("push_subscriptions"\)/);
    }
  });

  it("KIND_META stays the one registry: every push-worthy kind is a declared kind", () => {
    for (const k of PUSH_KINDS) expect(Object.prototype.hasOwnProperty.call(KIND_META, k)).toBe(true);
  });
});
