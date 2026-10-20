// notifications Round G — N17 PUSH PRODUCERS AND SIGN-OUT.
//
//   OS-15  an explicit sign-out removes the signed-out person's push
//          registration for THIS browser's endpoint: lib/swSession.ts
//          signOutOfThisBrowser posts SIGN_OUT (as before), then POST
//          /api/push/unsubscribe { endpoint } with the STILL-VALID token,
//          then ends the session — best-effort and bounded
//          (SIGN_OUT_PUSH_RELEASE_MS): no subscription, no token, a refused,
//          failing or hanging request never blocks the sign-out, nor delays
//          it past the bound. The browser's own PushSubscription is never
//          unsubscribed (it may be the next person's working registration).
//   OS-14  lib/notify/dispatch.ts pushAfterBellRows — emit()'s own push leg,
//          for the producers that write their bell rows outside emit(): a
//          push-worthy kind only; the browser POSTs /api/push/notify with the
//          member's token; the server pushes only through the caller's
//          sender; never throws.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const session = vi.hoisted(() => ({ token: "tok-A" as string | null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: session.token ? { access_token: session.token } : null } }) },
    from: () => { throw new Error("no table read expected"); },
  },
}));

import { signOutOfThisBrowser, releaseThisBrowserPush, SIGN_OUT_PUSH_RELEASE_MS } from "@/lib/swSession";
import { pushAfterBellRows } from "@/lib/notify/dispatch";

type Step = string;
function harness(opts: {
  endpoint?: string | null;
  token?: string | null;
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  registrationThrows?: boolean;
} = {}) {
  const steps: Step[] = [];
  const unsubscribe = vi.fn(async () => true);
  const sub = opts.endpoint === null ? null : { endpoint: opts.endpoint ?? "https://fcm.googleapis.com/fcm/send/dev-A", unsubscribe };
  const controller = { postMessage: (m: unknown) => { steps.push(`worker:${(m as { type: string }).type}`); } };
  const nav = {
    serviceWorker: {
      controller,
      getRegistration: async () => {
        if (opts.registrationThrows) throw new Error("no registration");
        return { active: controller, pushManager: { getSubscription: async () => sub } };
      },
    },
  };
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    steps.push(`fetch:${url}`);
    fetches.push({ url, init });
    return opts.fetchImpl ? opts.fetchImpl(url, init) : { ok: true, status: 200 };
  });
  const tok = opts.token === undefined ? "tok-A" : opts.token;
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: tok ? { access_token: tok } : null } })),
      signOut: vi.fn(async () => { steps.push("signOut"); return { error: null }; }),
    },
  };
  return { steps, nav, fetchImpl, fetches, client, unsubscribe };
}

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => { info = vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("OS-15 — an explicit sign-out removes this browser's push registration for the person, BEFORE the session ends", () => {
  it("SIGN_OUT to the worker, then POST /api/push/unsubscribe { endpoint } with the still-valid token, then signOut() — in that order, once each", async () => {
    const h = harness();
    const out = await signOutOfThisBrowser(h.client, { nav: h.nav, fetchImpl: h.fetchImpl });
    expect(h.steps).toEqual(["worker:SIGN_OUT", "fetch:/api/push/unsubscribe", "signOut"]);
    expect(out).toEqual({ error: null });
    expect(h.client.auth.signOut).toHaveBeenCalledTimes(1);
    const { init } = h.fetches[0];
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-A");
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/dev-A" });
    // the browser's subscription itself is left alone (it may be the next person's)
    expect(h.unsubscribe).not.toHaveBeenCalled();
  });

  it("the worker message is posted synchronously, before anything is awaited (DEC-44 §3 unchanged)", () => {
    const h = harness();
    void signOutOfThisBrowser(h.client, { nav: h.nav, fetchImpl: h.fetchImpl });
    expect(h.steps).toEqual(["worker:SIGN_OUT"]);
  });

  it("no push subscription in this browser: no request, the sign-out goes on", async () => {
    const h = harness({ endpoint: null });
    await signOutOfThisBrowser(h.client, { nav: h.nav, fetchImpl: h.fetchImpl });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.steps).toEqual(["worker:SIGN_OUT", "signOut"]);
  });

  it("no token (the session already ended elsewhere): no request, the sign-out goes on", async () => {
    const h = harness({ token: null });
    await signOutOfThisBrowser(h.client, { nav: h.nav, fetchImpl: h.fetchImpl });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.client.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("a refused or failing request, or a browser without a registration, never stops the sign-out", async () => {
    for (const h of [
      harness({ fetchImpl: async () => ({ ok: false, status: 401 }) }),
      harness({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }),
      harness({ registrationThrows: true }),
    ]) {
      await expect(signOutOfThisBrowser(h.client, { nav: h.nav, fetchImpl: h.fetchImpl })).resolves.toEqual({ error: null });
      expect(h.client.auth.signOut).toHaveBeenCalledTimes(1);
      expect(h.steps.at(-1)).toBe("signOut");
    }
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/could not be turned off for this account \(failed\) — signing out anyway/));
  });

  it("a request that never answers delays the sign-out by at most SIGN_OUT_PUSH_RELEASE_MS", async () => {
    vi.useFakeTimers();
    const h = harness({ fetchImpl: () => new Promise(() => {}) });
    const done = signOutOfThisBrowser(h.client, { nav: h.nav, fetchImpl: h.fetchImpl });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_PUSH_RELEASE_MS - 1);
    expect(h.client.auth.signOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(SIGN_OUT_PUSH_RELEASE_MS).toBeLessThanOrEqual(2000);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/\(timeout\)/));
  });

  it("releaseThisBrowserPush says what happened (and never throws)", async () => {
    expect(await releaseThisBrowserPush(harness().client, { nav: harness().nav, fetchImpl: harness().fetchImpl })).toBe("released");
    const none = harness({ endpoint: null });
    expect(await releaseThisBrowserPush(none.client, { nav: none.nav, fetchImpl: none.fetchImpl })).toBe("no-subscription");
    const noTok = harness({ token: null });
    expect(await releaseThisBrowserPush(noTok.client, { nav: noTok.nav, fetchImpl: noTok.fetchImpl })).toBe("no-token");
    expect(await releaseThisBrowserPush(harness().client, { nav: {}, fetchImpl: harness().fetchImpl })).toBe("no-subscription");
  });
});

describe("OS-14 — pushAfterBellRows is emit()'s push leg for a producer outside emit()", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    globalThis.fetch = realFetch;
    session.token = "tok-A";
  });

  it("in the browser: a fire-and-forget POST /api/push/notify with the member's token, naming the kind, the resource and the recipients (de-duplicated)", async () => {
    (globalThis as { window?: unknown }).window = {};
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return new Response(null, { status: 204 }); }) as typeof fetch;
    await pushAfterBellRows({ orgId: "o1", kind: "ack_requested", resourceId: "d1", recipients: ["u1", "u3", "u1", ""] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/api/push/notify");
    expect(calls[0].init.keepalive).toBe(true);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok-A");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ orgId: "o1", kind: "ack_requested", resourceId: "d1", recipients: ["u1", "u3"] });
  });

  it("nothing is asked for a kind that is not push-worthy, an empty audience, or a missing resource", async () => {
    (globalThis as { window?: unknown }).window = {};
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await pushAfterBellRows({ orgId: "o1", kind: "ack_complete", resourceId: "d1", recipients: ["u1"] });
    await pushAfterBellRows({ orgId: "o1", kind: "ack_requested", resourceId: "d1", recipients: [] });
    await pushAfterBellRows({ orgId: "o1", kind: "ack_requested", resourceId: "", recipients: ["u1"] });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on the server: only through the caller's sender (none → no push, logged once); a sender that throws never escapes", async () => {
    const sender = vi.fn(async () => undefined);
    await pushAfterBellRows({ orgId: "o1", kind: "review_requested", resourceId: "d1", recipients: ["r1"] }, sender);
    expect(sender).toHaveBeenCalledWith({ orgId: "o1", kind: "review_requested", resourceId: "d1", recipients: ["r1"] });
    await expect(pushAfterBellRows({ orgId: "o1", kind: "review_requested", resourceId: "d1", recipients: ["r1"] })).resolves.toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(pushAfterBellRows({ orgId: "o1", kind: "review_requested", resourceId: "d1", recipients: ["r1"] }, async () => { throw new Error("boom"); })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the review_requested push failed \(bell and email are unaffected\): boom/));
  });
});
