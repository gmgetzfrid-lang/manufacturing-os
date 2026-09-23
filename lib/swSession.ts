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
 *  whether anything was reached. Never throws. */
export async function postServiceWorkerMessage(
  message: SwSessionMessage,
  nav: NavigatorLike | undefined = defaultNavigator(),
): Promise<boolean> {
  try {
    const sw = nav?.serviceWorker;
    if (!sw) return false;
    const targets = new Set<WorkerLike>();
    if (sw.controller) targets.add(sw.controller);
    if (sw.getRegistration) {
      const reg = await sw.getRegistration();
      for (const w of [reg?.active, reg?.waiting, reg?.installing]) if (w) targets.add(w);
    }
    if (targets.size === 0) return false;
    for (const w of targets) w.postMessage(message);
    return true;
  } catch {
    return false;
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
