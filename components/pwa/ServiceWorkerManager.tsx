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
//   2. Update available: a quiet toast when a new app version has installed
//      and is WAITING, letting them refresh on their own schedule rather than
//      mid-task. Tapping it activates the waiting worker and reloads on
//      controllerchange, with an unconditional reload after a short timeout so
//      the button can never do nothing (OFF-4).
//
// Registration is best-effort and only runs in the browser over HTTPS (or
// localhost). If the SW API is missing, this renders nothing and the app
// behaves exactly as before.

import React from "react";
import { WifiOff, RefreshCw } from "lucide-react";

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

export default function ServiceWorkerManager() {
  const [browserOffline, setBrowserOffline] = React.useState(false);
  const [unreachable, setUnreachable] = React.useState(false);
  const [updateReady, setUpdateReady] = React.useState(false);
  const waitingRef = React.useRef<ServiceWorker | null>(null);
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
            // installs, then waits until this toast (or every tab closing)
            // lets it take over.
            const track = (worker: ServiceWorker | null) => {
              if (!worker) return;
              worker.addEventListener("statechange", () => {
                if (worker.state === "installed" && sw.controller) {
                  waitingRef.current = worker;
                  setUpdateReady(true);
                }
              });
            };
            if (reg.waiting) { waitingRef.current = reg.waiting; setUpdateReady(true); }
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

  const applyUpdate = () =>
    applyServiceWorkerUpdate(waitingRef.current, {
      serviceWorker: "serviceWorker" in navigator ? navigator.serviceWorker : null,
      reload: () => window.location.reload(),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    });

  return (
    <div className="fixed bottom-4 left-4 z-[200] flex flex-col gap-2 pointer-events-none">
      {offline && (
        <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-amber-500 text-white text-xs font-bold px-3 py-1.5 shadow-lg">
          <WifiOff className="w-3.5 h-3.5" />
          {OFFLINE_PILL_TEXT}
        </div>
      )}
      {updateReady && (
        <button
          onClick={applyUpdate}
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-xs font-bold px-3 py-1.5 shadow-lg transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Update available — tap to refresh
        </button>
      )}
    </div>
  );
}
