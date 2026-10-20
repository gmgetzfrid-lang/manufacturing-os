// lib/swSession.ts
//
// The page's half of the service-worker session contract (XEDGE-6, DEC-44 §3).
// public/sw.js keeps a device-wide runtime cache that used to outlive sign-out:
// on a shared field tablet the next person could be served the previous
// person's pages from disk, and a cached copy outlived the share revocation
// that was its only kill switch. Two messages close that:
//
//   { type: "SIGN_OUT" }     — posted by every sign-out site BEFORE the session
//                              is torn down: the worker deletes its runtime
//                              cache and forgets who was signed in.
//   { type: "SESSION", id }  — posted by the protected layout once the signed-in
//                              uid is known: an identity the worker has never
//                              seen, or a different one than it remembered,
//                              purges the runtime cache (a second account on
//                              the same device).
//
// Best-effort by design: no service worker (unsupported browser, plain HTTP,
// tests) means no cache to clear, and failing to reach the worker never blocks
// the sign-out itself.

export type SwSessionMessage = { type: "SIGN_OUT" } | { type: "SESSION"; id: string };

type WorkerLike = { postMessage: (message: unknown) => void };
type RegistrationLike =
  | { active?: WorkerLike | null; waiting?: WorkerLike | null; installing?: WorkerLike | null }
  | undefined
  | null;
export type NavigatorLike = {
  serviceWorker?: {
    controller?: WorkerLike | null;
    getRegistration?: () => Promise<RegistrationLike>;
  };
};

function defaultNavigator(): NavigatorLike | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as unknown as NavigatorLike);
}

/** Posts one message to every worker that could be serving this origin — the
 *  controller plus the registration's active / waiting / installing workers,
 *  de-duplicated (in a browser the controller IS the active worker). Returns
 *  whether anything was reached. Never throws.
 *
 *  The controller is posted SYNCHRONOUSLY, before any await: every sign-out
 *  site calls this un-awaited and RoleContext answers SIGNED_OUT with a hard
 *  navigation, which can begin before a registration lookup resolves — a
 *  message behind that await might never be sent, and the cache would
 *  survive the sign-out it was meant to end. */
export async function postServiceWorkerMessage(
  message: SwSessionMessage,
  nav: NavigatorLike | undefined = defaultNavigator(),
): Promise<boolean> {
  const reached = new Set<WorkerLike>();
  try {
    const sw = nav?.serviceWorker;
    if (!sw) return false;
    if (sw.controller) {
      sw.controller.postMessage(message);
      reached.add(sw.controller);
    }
    if (sw.getRegistration) {
      const reg = await sw.getRegistration();
      for (const w of [reg?.active, reg?.waiting, reg?.installing]) {
        if (w && !reached.has(w)) {
          w.postMessage(message);
          reached.add(w);
        }
      }
    }
    return reached.size > 0;
  } catch {
    return reached.size > 0;
  }
}

/** Sign-out: the worker drops its runtime cache and the remembered identity. */
export function clearServiceWorkerSession(nav?: NavigatorLike): Promise<boolean> {
  return postServiceWorkerMessage({ type: "SIGN_OUT" }, nav ?? defaultNavigator());
}

/** Signed in as `id`: a change of identity since the worker last looked purges its cache. */
export function announceServiceWorkerSession(id: string, nav?: NavigatorLike): Promise<boolean> {
  return postServiceWorkerMessage({ type: "SESSION", id }, nav ?? defaultNavigator());
}

// ─── Sign-out: this browser's push registration (OS-15, notifications N17) ──
//
// A push subscription belongs to the browser profile, not to the session: on
// a shared workstation the person who turned device notifications on kept
// being pushed there after signing out, until someone changed the device.
// Every sign-out site (the account menu, the profile page, the protected
// layout's "not a member of any workspace" screen, the lapsed-subscription
// screen) therefore signs out through signOutOfThisBrowser:
//
//   1. SIGN_OUT to the worker, posted synchronously as before (DEC-44 §3 —
//      the worker contract is unchanged);
//   2. POST /api/push/unsubscribe { endpoint } with the STILL-VALID token,
//      which removes only the signed-out person's own push_subscriptions row
//      for this browser's endpoint (the route filters by the caller). The
//      browser's PushSubscription itself is left alone: it may belong to the
//      next person to turn notifications on here, and their row must keep
//      working;
//   3. supabase.auth.signOut().
//
// Step 2 is best-effort and bounded: it waits at most
// SIGN_OUT_PUSH_RELEASE_MS (no subscription, no token, a failing or slow
// request — the sign-out goes on, never blocked and never delayed past the
// bound). The request is sent with `keepalive`, so one still in flight at the
// bound may still land. An expiry-driven or cross-tab SIGNED_OUT
// (RoleContext) has no live token to send and is not a sign-out the person
// chose: it keeps the registration, as it keeps the person's own work (DEC-91).

/** How long a sign-out waits for this browser's push registration to be
 *  removed before it signs out anyway. */
export const SIGN_OUT_PUSH_RELEASE_MS = 1500;

type PushSubscriptionLike = { endpoint?: string | null } | null | undefined;
type PushRegistrationLike =
  | { pushManager?: { getSubscription?: () => Promise<PushSubscriptionLike> } | null }
  | undefined
  | null;
export type PushNavigatorLike = {
  serviceWorker?: { getRegistration?: () => Promise<PushRegistrationLike> } | null;
};
export type SignOutClient = {
  auth: {
    getSession: () => Promise<{ data: { session: { access_token?: string | null } | null } | null }>;
    signOut: () => Promise<unknown>;
  };
};
type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export type PushReleaseOutcome = "released" | "no-subscription" | "no-token" | "failed" | "timeout";

/** Remove the signed-in person's push registration for THIS browser's
 *  endpoint (POST /api/push/unsubscribe), waiting at most `timeoutMs`.
 *  Never throws; says what happened (for the tests and the log). */
export async function releaseThisBrowserPush(
  client: Pick<SignOutClient, "auth">,
  opts: { nav?: PushNavigatorLike; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<PushReleaseOutcome> {
  const nav = opts.nav ?? (defaultNavigator() as PushNavigatorLike | undefined);
  const doFetch: FetchLike | undefined = opts.fetchImpl
    ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined);
  const timeoutMs = opts.timeoutMs ?? SIGN_OUT_PUSH_RELEASE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (async (): Promise<PushReleaseOutcome> => {
    try {
      const reg = await nav?.serviceWorker?.getRegistration?.();
      const sub = await reg?.pushManager?.getSubscription?.();
      const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint : "";
      if (!endpoint || !doFetch) return "no-subscription";
      const { data } = await client.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return "no-token";
      const res = await doFetch("/api/push/unsubscribe", {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint }),
      });
      return res.ok ? "released" : "failed";
    } catch {
      return "failed";
    }
  })();
  try {
    return await Promise.race([
      release,
      new Promise<PushReleaseOutcome>((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** THE sign-out (OS-15): the worker is told (SIGN_OUT, synchronously, as
 *  before), this browser's push registration for the person is removed while
 *  their token is still valid (bounded — releaseThisBrowserPush), then the
 *  session ends. Answers what client.auth.signOut() answered. A push release
 *  that fails never stops or fails the sign-out. */
export async function signOutOfThisBrowser(
  client: SignOutClient,
  opts: { nav?: NavigatorLike & PushNavigatorLike; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<unknown> {
  void clearServiceWorkerSession(opts.nav);
  const released = await releaseThisBrowserPush(client, opts);
  if (released === "failed" || released === "timeout") {
    console.info(`[sign-out] this browser's device notifications could not be turned off for this account (${released}) — signing out anyway`);
  }
  return client.auth.signOut();
}
