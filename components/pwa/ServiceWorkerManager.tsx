"use client";

// ServiceWorkerManager — registers the Field Mode service worker and surfaces
// two ambient signals the field needs:
//
//   1. Offline status: a small amber pill when the network drops, so a plant
//      worker knows they're seeing cached data (not stale-because-broken).
//   2. Update available: a quiet toast when a new app version is cached,
//      letting them refresh on their own schedule rather than mid-task.
//
// Registration is best-effort and only runs in the browser over HTTPS (or
// localhost). If the SW API is missing, this renders nothing and the app
// behaves exactly as before.

import React from "react";
import { WifiOff, RefreshCw } from "lucide-react";

export default function ServiceWorkerManager() {
  const [offline, setOffline] = React.useState(false);
  const [updateReady, setUpdateReady] = React.useState(false);
  const waitingRef = React.useRef<ServiceWorker | null>(null);

  React.useEffect(() => {
    setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    if ("serviceWorker" in navigator) {
      const onLoad = () => {
        navigator.serviceWorker
          .register("/sw.js")
          .then((reg) => {
            // Detect a new worker waiting to activate.
            const track = (worker: ServiceWorker | null) => {
              if (!worker) return;
              worker.addEventListener("statechange", () => {
                if (worker.state === "installed" && navigator.serviceWorker.controller) {
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
    };
  }, []);

  const applyUpdate = () => {
    const w = waitingRef.current;
    if (w) {
      w.postMessage("SKIP_WAITING");
      w.addEventListener("statechange", () => {
        if (w.state === "activated") window.location.reload();
      });
    } else {
      window.location.reload();
    }
  };

  return (
    <div className="fixed bottom-4 left-4 z-[200] flex flex-col gap-2 pointer-events-none">
      {offline && (
        <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-amber-500 text-white text-xs font-bold px-3 py-1.5 shadow-lg">
          <WifiOff className="w-3.5 h-3.5" />
          Offline — showing cached data
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
