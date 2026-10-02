"use client";

// ServiceWorkerManager — registers the Field Mode service worker and surfaces
// two ambient signals the field needs:
//
//   1. Offline status: a small amber pill when the app cannot reach the
//      server, so a plant worker knows what's on screen may be missing or out
//      of date. It never claims cached data is being shown: documents,
//      drawings and their status are read live and are not kept on the device
//      (public-surfaces OFF-3). "Offline" comes from real fetch failures the
//      service worker reports (NETWORK messages) as well as navigator.onLine —
//      plant Wi-Fi that is associated but has no route out reports
//      onLine === true, which is exactly when a stale screen is most likely.
//   2. Update available: when a new app version has installed and is
//      WAITING, this reports it (`subscribeWaitingWorker` /
//      `waitingWorkerSnapshot`) to the ONE component that owns "a newer build
//      exists" — components/system/UpdatePill.tsx, fed by both the waiting
//      worker and the build-id poll, with one wording, one place and one
//      prompt at a time (TAX-15, notifications Round G N3). Its tap activates
//      the waiting worker and reloads on controllerchange, with an
//      unconditional reload after a short timeout so the button can never do
//      nothing (OFF-4, `loadLatestBuild` below). On a page without the
//      protected shell (sign-in, a share link, the transmittal portal), where
//      that component is not mounted, this renders it for the waiting worker.
//
// Registration is best-effort and only runs in the browser over HTTPS (or
// localhost). If the SW API is missing, this renders nothing and the app
// behaves exactly as before.

import React from "react";
import { WifiOff } from "lucide-react";

// The update prompt is UpdatePill's (TAX-15). Loaded on demand — only when a
// worker is waiting — so a page without the protected shell still gets it,
// without a static import cycle (UpdatePill imports loadLatestBuild from here).
const UpdatePillForWorker = React.lazy(() =>
  import("@/components/system/UpdatePill").then((m) => ({ default: m.UpdatePillForWaitingWorker })),
);

export const OFFLINE_PILL_TEXT = "Offline — can't reach the server; data may be missing or out of date";

/** How long the update button waits for the new worker to take control
 *  before reloading anyway (OFF-4). */
export const UPDATE_RELOAD_FALLBACK_MS = 3000;

/** While the app thinks it is offline, how often it checks whether the server
 *  is reachable again. */
const OFFLINE_PROBE_MS = 20_000;

/** The worker's reachability report — `{ type: "NETWORK", ok }` — as a
 *  boolean, or null for any other message. */
export function networkSignal(data: unknown): boolean | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { type?: unknown; ok?: unknown };
  return d.type === "NETWORK" && typeof d.ok === "boolean" ? d.ok : null;
}

type UpdateEnv = {
  serviceWorker: { addEventListener: (type: "controllerchange", listener: () => void) => void } | null;
  reload: () => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
};

/** OFF-4: tell the waiting worker to take over and reload once it controls
 *  the page — or after UPDATE_RELOAD_FALLBACK_MS regardless, so a worker that
 *  already activated (another tab tapped first) or never answers still leaves
 *  the user on the new build. Reloads exactly once. */
export function applyServiceWorkerUpdate(waiting: { postMessage: (message: unknown) => void } | null, env: UpdateEnv): void {
  let done = false;
  const reload = () => {
    if (done) return;
    done = true;
    env.reload();
  };
  if (!waiting || !env.serviceWorker) {
    reload();
    return;
  }
  env.serviceWorker.addEventListener("controllerchange", reload);
  env.setTimeout(reload, UPDATE_RELOAD_FALLBACK_MS);
  try {
    waiting.postMessage("SKIP_WAITING");
  } catch {
    reload();
  }
}

/** The build-id pill's tap (components/system/UpdatePill.tsx). Every deploy
 *  now leaves a waiting worker (OFF-4: no install-time takeover; OFF-11: sw.js
 *  changes per build), and a plain reload keeps the old worker in control, so
 *  the pill asks the registration for its waiting worker and activates it
 *  exactly as the toast does — otherwise the toast reappeared right after the
 *  user updated. No registration, no waiting worker or a failed lookup: reload. */
// ── The waiting-worker signal (TAX-15) ─────────────────────────────────────
// Module level: the worker is registered once per tab, here, and the update
// prompt (UpdatePill) reads the answer wherever it is mounted.
let workerWaiting = false;
const workerListeners = new Set<() => void>();

/** Subscribe to "a new worker is installed and waiting". */
export function subscribeWaitingWorker(cb: () => void): () => void {
  workerListeners.add(cb);
  return () => { workerListeners.delete(cb); };
}

/** Whether a new worker is installed and waiting (a newer build exists). */
export function waitingWorkerSnapshot(): boolean {
  return workerWaiting;
}

function reportWaitingWorker() {
  if (workerWaiting) return;
  workerWaiting = true;
  for (const l of workerListeners) {
    try { l(); } catch { /* a bad listener must not break the others */ }
  }
}

/** Test seam: forget the waiting-worker signal (jsdom tests share the module). */
export function __resetWaitingWorkerForTests() {
  workerWaiting = false;
  for (const l of workerListeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export async function loadLatestBuild(
  env: UpdateEnv & { getRegistration: (() => Promise<{ waiting: { postMessage: (message: unknown) => void } | null } | undefined>) | null },
): Promise<void> {
  let waiting: { postMessage: (message: unknown) => void } | null = null;
  try {
    waiting = (await env.getRegistration?.())?.waiting ?? null;
  } catch {
    waiting = null;
  }
  applyServiceWorkerUpdate(waiting, env);
}

export default function ServiceWorkerManager() {
  const [browserOffline, setBrowserOffline] = React.useState(false);
  const [unreachable, setUnreachable] = React.useState(false);
  const updateReady = React.useSyncExternalStore(subscribeWaitingWorker, waitingWorkerSnapshot, () => false);
  const offline = browserOffline || unreachable;

  React.useEffect(() => {
    setBrowserOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    const goOnline = () => setBrowserOffline(false);
    const goOffline = () => setBrowserOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    // The worker sees every same-origin request it handles and reports when
    // the network starts or stops answering; ask what it last saw, too, since
    // this page may have been served from cache by a failed navigation.
    const onMessage = (e: MessageEvent) => {
      const ok = networkSignal(e.data);
      if (ok !== null) setUnreachable(!ok);
    };
    if (sw) {
      sw.addEventListener("message", onMessage);
      try { sw.controller?.postMessage({ type: "NETWORK_STATUS" }); } catch { /* no worker yet */ }
    }

    if (sw) {
      const onLoad = () => {
        sw
          .register("/sw.js")
          .then((reg) => {
            // A new worker no longer skips waiting at install (OFF-4): it
            // installs, then waits until the update prompt (or every tab
            // closing) lets it take over.
            const track = (worker: ServiceWorker | null) => {
              if (!worker) return;
              worker.addEventListener("statechange", () => {
                if (worker.state === "installed" && sw.controller) {
                  reportWaitingWorker();
                }
              });
            };
            if (reg.waiting) { reportWaitingWorker(); }
            reg.addEventListener("updatefound", () => track(reg.installing));
          })
          .catch(() => { /* SW optional — ignore */ });
      };
      if (document.readyState === "complete") onLoad();
      else window.addEventListener("load", onLoad, { once: true });
    }

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      sw?.removeEventListener("message", onMessage);
    };
  }, []);

  // While offline, check now and then whether the server answers again (the
  // worker reports success too; this covers a page no worker controls).
  React.useEffect(() => {
    if (!offline) return;
    let stopped = false;
    const probe = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!stopped && res.ok) setUnreachable(false);
      } catch { /* still unreachable */ }
    };
    const t = window.setInterval(() => void probe(), OFFLINE_PROBE_MS);
    window.addEventListener("online", probe);
    return () => {
      stopped = true;
      window.clearInterval(t);
      window.removeEventListener("online", probe);
    };
  }, [offline]);

  return (
    <>
      <div className="fixed bottom-4 left-4 z-[200] flex flex-col gap-2 pointer-events-none">
        {offline && (
          <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-amber-500 text-white text-xs font-bold px-3 py-1.5 shadow-lg">
            <WifiOff className="w-3.5 h-3.5" />
            {OFFLINE_PILL_TEXT}
          </div>
        )}
      </div>
      {/* "A newer build exists" is UpdatePill's (TAX-15): one wording, one
          place, one prompt. Inside the protected shell the shell's own
          UpdatePill shows it and this one renders nothing. */}
      {updateReady && (
        <React.Suspense fallback={null}>
          <UpdatePillForWorker />
        </React.Suspense>
      )}
    </>
  );
}
