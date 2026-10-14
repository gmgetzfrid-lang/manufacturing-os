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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
}));

vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  return { supabase: mem.makeSupabase(h.state) };
});
vi.mock("@/lib/supabaseAdmin", async () => {
  const mem = await import("./helpers/memoryDb");
  if (!h.state) h.state = mem.freshState();
  return {
    supabaseAdmin: {
      ...mem.makeSupabase(h.state),
      auth: { getUser: vi.fn(async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad token" } })) },
    },
  };
});
vi.mock("@/lib/notifications", () => ({
  queueEmail: vi.fn(async (input: Record<string, unknown>) => { h.order.push("email"); h.emails.push(input); }),
}));
vi.mock("@/lib/complianceNotify", () => ({
  notifyCompliance: vi.fn(async (input: Record<string, unknown>) => {
    h.order.push("inapp");
    return !h.failFor.has(String(input.userId));
  }),
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

import { emit, __registerServerPushSender, PUSH_LEG_TIMEOUT_MS, PUSH_REQUEST_MAX_RECIPIENTS, type EmitInput, type PushSendInput } from "@/lib/notify/dispatch";
import { __registerServerDiscoverCheck } from "@/lib/notify/recipients";
import {
  sendPushSafe, pushConfig, pushPayloadFor, safePushUrl, __resetPushLogOnceForTests,
  PUSH_KINDS, PUSH_TITLES, PUSH_BODY, PUSH_FALLBACK_TITLE, PUSH_WRITER_CAP, PUSH_EVIDENCE_WINDOW_MS,
} from "@/lib/push/sendPush";
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
  const ev = (over: Partial<EmitInput> = {}): EmitInput => ({
    orgId: ORG, category: "status", kind: "checkout_force_released", title: "Checkout force-released by Pat", body: "b",
    resource: { type: "document", id: "d-1" }, actorUserId: "actor", actorName: "Pat",
    audience: { involved: ["a", "b", "actor"] }, ...over,
  });
  let calls: PushSendInput[];
  const spy = vi.fn(async (input: PushSendInput) => { h.order.push("push"); calls.push(input); });
  beforeEach(() => { calls = []; spy.mockClear(); __registerServerPushSender(spy); });

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
    __registerServerPushSender(async () => { throw new Error("push service down"); });
    const r = await emit(ev());
    expect(r).toEqual(baseline);
    expect(quiet.mock.calls.some((c) => /push failed \(bell and email are unaffected\)/.test(String(c[0])))).toBe(true);
  });

  it("a sender that hangs is abandoned after PUSH_LEG_TIMEOUT_MS: emit() still resolves with the bell and email legs done", async () => {
    vi.useFakeTimers();
    __registerServerPushSender(() => new Promise<void>(() => undefined));
    let settled = false;
    const p = emit(ev()).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(PUSH_LEG_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(h.emails.length).toBe(2); // email already queued before the push leg
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } });
  });

  it("no server sender in this context (the maintenance cron, a route that did not load it): nothing pushed, said once, emit() unchanged", async () => {
    __registerServerPushSender(null);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const r1 = await emit(ev());
    const r2 = await emit(ev());
    expect(r1).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } });
    expect(r2).toEqual(r1);
    // said at most once per process (the first emit in this file without a sender says it)
    expect(info.mock.calls.filter((c) => /no push sender in this server context/.test(String(c[0]))).length).toBeLessThanOrEqual(1);
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
  const device = (user_id: string, endpoint = `https://push.example/${user_id}`, over: Record<string, unknown> = {}) => ({
    id: `s-${endpoint}`, user_id, org_id: ORG, endpoint, p256dh: "p256", auth: "authk", last_reminded_at: null, ...over,
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
    h.state.tables.push_subscriptions = [device("a", "https://push.example/a-phone"), device("a", "https://push.example/a-laptop")];
    const out = await sendPushSafe(input({ recipients: ["a"] }));
    expect(out).toMatchObject({ eligible: 1, attempted: 2, sent: 2, pruned: 0 });
    expect(h.sent.map((s) => s.endpoint).sort()).toEqual(["https://push.example/a-laptop", "https://push.example/a-phone"]);
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
    expect(h.sent.map((s) => s.endpoint)).toEqual(["https://push.example/b"]);
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
    h.state.tables.push_subscriptions = [device("a", "https://push.example/gone"), device("a", "https://push.example/missing"), device("b", "https://push.example/flaky")];
    h.sendError.set("https://push.example/gone", Object.assign(new Error("Received unexpected response code"), { statusCode: 410 }));
    h.sendError.set("https://push.example/missing", Object.assign(new Error("Received unexpected response code"), { statusCode: 404 }));
    h.sendError.set("https://push.example/flaky", Object.assign(new Error("Received unexpected response code"), { statusCode: 500 }));
    const out = await sendPushSafe(input());
    expect(out).toMatchObject({ attempted: 3, sent: 0, pruned: 2 });
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>).map((d) => d.endpoint)).toEqual(["https://push.example/flaky"]);
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
      { id: "s1", user_id: "a", endpoint: "https://push.example/a", p256dh: "p", auth: "k", last_reminded_at: null },
      { id: "s2", user_id: "b", endpoint: "https://push.example/b", p256dh: "p", auth: "k", last_reminded_at: null },
    ];
    const res = await post(notifyRoute, "/api/push/notify", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.sent.map((s) => s.endpoint)).toEqual(["https://push.example/a"]);
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
    h.user = { id: "stranger" };
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub })).status).toBe(403);
    h.user = { id: "a" };
    const res = await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub });
    expect(res.status).toBe(200);
    expect(h.state.tables.push_subscriptions).toEqual([
      expect.objectContaining({ user_id: "a", org_id: ORG, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
    ]);
  });

  it("the same browser turned on by a second person becomes theirs (the endpoint is the browser's); a re-subscribe replaces the caller's own row", async () => {
    setVapid(true);
    h.state.tables.push_subscriptions = [{ id: "old", user_id: "b", org_id: ORG, endpoint: sub.endpoint, p256dh: "x", auth: "y" }];
    h.user = { id: "a" };
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub })).status).toBe(200);
    expect((h.state.tables.push_subscriptions as Array<Record<string, unknown>>).map((r) => r.user_id)).toEqual(["a"]);
    expect((await post(subscribeRoute, "/api/push/subscribe", { orgId: ORG, subscription: sub })).status).toBe(200);
    expect(h.state.tables.push_subscriptions).toHaveLength(1);
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
      { id: "s1", user_id: "a", endpoint: "https://push.example/1" },
      { id: "s2", user_id: "b", endpoint: "https://push.example/2" },
    ];
    expect((await post(unsubscribeRoute, "/api/push/unsubscribe", { endpoint: "https://push.example/1" }, null)).status).toBe(401);
    h.user = { id: "a" };
    expect(await (await post(unsubscribeRoute, "/api/push/unsubscribe", { endpoint: "https://push.example/2" })).json()).toEqual({ ok: true, removed: 0 });
    expect(await (await post(unsubscribeRoute, "/api/push/unsubscribe", { endpoint: "https://push.example/1" })).json()).toEqual({ ok: true, removed: 1 });
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
    expect(read("lib/push/sendPush.ts")).toContain("__registerServerPushSender(async (input) => { await sendPushSafe(input); });");
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
