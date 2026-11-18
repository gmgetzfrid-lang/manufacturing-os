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
//      WAITING, this reports it (`reportWaitingWorker`, components/pwa/
//      swUpdate.ts) to the ONE component that owns "a newer build exists" —
//      components/system/UpdatePill.tsx, fed by both the waiting worker and
//      the build-id poll, with one wording, one place and one prompt at a
//      time (TAX-15, notifications Round G N3). Its tap activates the waiting
//      worker and reloads on controllerchange, with an unconditional reload
//      after a short timeout so the button can never do nothing (OFF-4,
//      swUpdate.ts `loadLatestBuild`). On a page without the protected shell
//      (sign-in, a share link, the transmittal portal), where that component
//      is not mounted, this renders it for the waiting worker.
//
// Registration is best-effort and only runs in the browser over HTTPS (or
// localhost). If the SW API is missing, this renders nothing and the app
// behaves exactly as before.

import React from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import {
  UPDATE_PROMPT_BUTTON_CLASS, UPDATE_PROMPT_TEXT, UPDATE_PROMPT_WRAP_CLASS, loadLatestBuildInThisTab, reloadDuringUploadConfirmText,
  reportWaitingWorker, subscribeUpdatePromptShell, subscribeWaitingWorker, updatePromptShellMounted, waitingWorkerSnapshot,
} from "@/components/pwa/swUpdate";
// The upload counters' leaf module (no Supabase import, so nothing heavy joins
// every page's root bundle): the fallback asks over an upload too (TAX-15).
import { hasUploadsInFlight, releaseUploadUnloadGuard } from "@/lib/uploadInFlight";
import { ZC } from "@/lib/zLayers";

// The update's state and reload path moved to the leaf module (TAX-15);
// re-exported so existing callers and tests keep their import.
export {
  applyServiceWorkerUpdate, loadLatestBuild, UPDATE_RELOAD_FALLBACK_MS,
  subscribeWaitingWorker, waitingWorkerSnapshot, __resetWaitingWorkerForTests,
} from "@/components/pwa/swUpdate";

// The update prompt is UpdatePill's (TAX-15). Wherever the protected shell's
// UpdatePill is not mounted — a public page, and a protected URL before the
// gate admits (authenticating, resolving the membership, no membership) — it
// is loaded on demand, only when a worker is waiting: a static import would
// put UpdatePill's dependencies (the dialog host, the upload guard and with
// it the Supabase client) into every public page's root bundle. On demand
// defers them, it does not avoid them: after a deploy, a public page with a
// waiting worker loads them with the chunk. That chunk is first asked for
// right after a deploy, when the old build's chunk may already be gone, so a
// failed load is caught here and the prompt falls back to a static button
// (UpdatePromptFallback below) — a deliberate second renderer of the prompt.
const UpdatePillForWorker = React.lazy(() =>
  import("@/components/system/UpdatePill").then((m) => ({ default: m.UpdatePillForWaitingWorker })),
);

export const OFFLINE_PILL_TEXT = "Offline — can't reach the server; data may be missing or out of date";

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

/** The update prompt when UpdatePill's chunk cannot load (a deploy has
 *  removed the old build's chunks, or the network dropped): the same words,
 *  the same place and the same reload path (`loadLatestBuild`), so a newer
 *  build is still announced and the page around it survives. Over an upload
 *  in flight it asks UpdatePill's question first (`confirmReloadFromFallback`
 *  — through `window.confirm`, because the app's dialog host is in the chunk
 *  that failed; TAX-15, notifications N13), and on yes releases the
 *  browser's own leave-page prompt so the person is not asked twice. Like
 *  the stand-in, it stands down while the shell's prompt is mounted. */
/** The fallback's question over an upload in flight (TAX-15 done-when 2's
 *  fallback limb): no upload → go; an upload → `window.confirm` in
 *  UpdatePill's words, and on OK the leave-page guard is released (as
 *  UpdatePill's "Reload anyway" does). A confirm that throws (a blocked
 *  dialog) answers "wait": the upload is never stopped without a yes. */
export function confirmReloadFromFallback(deps: {
  inFlight: () => boolean;
  confirm: (text: string) => boolean;
  release: () => void;
} = {
  inFlight: hasUploadsInFlight,
  confirm: (text) => (typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(text) : false),
  release: releaseUploadUnloadGuard,
}): boolean {
  if (!deps.inFlight()) return true;
  let ok = false;
  try { ok = deps.confirm(reloadDuringUploadConfirmText()); } catch { ok = false; }
  if (ok) deps.release();
  return ok;
}

export function UpdatePromptFallback() {
  const shellUp = React.useSyncExternalStore(subscribeUpdatePromptShell, updatePromptShellMounted, () => false);
  if (shellUp) return null;
  return (
    <div className={UPDATE_PROMPT_WRAP_CLASS} data-update-prompt data-update-prompt-fallback>
      <button
        type="button"
        onClick={() => {
          if (!confirmReloadFromFallback()) return;
          void loadLatestBuildInThisTab();
        }}
        className={UPDATE_PROMPT_BUTTON_CLASS}
      >
        <RefreshCw className="w-3.5 h-3.5" aria-hidden />
        {UPDATE_PROMPT_TEXT}
      </button>
    </div>
  );
}

/** Catches a failed load (or render) of the update prompt, so it can never
 *  take the root layout — and every page under it — down with it. */
export class UpdatePromptBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("[ServiceWorkerManager] the update prompt could not load; showing the fallback button", error);
  }
  render() {
    return this.state.failed ? <UpdatePromptFallback /> : this.props.children;
  }
}

export default function ServiceWorkerManager() {
  const [browserOffline, setBrowserOffline] = React.useState(false);
  const [unreachable, setUnreachable] = React.useState(false);
  const updateReady = React.useSyncExternalStore(subscribeWaitingWorker, waitingWorkerSnapshot, () => false);
  const shellUp = React.useSyncExternalStore(subscribeUpdatePromptShell, updatePromptShellMounted, () => false);
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
      <div className={`fixed bottom-4 left-4 ${ZC.workflowModal} flex flex-col gap-2 pointer-events-none`}>
        {offline && (
          <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-amber-500 text-white text-xs font-bold px-3 py-1.5 shadow-lg">
            <WifiOff className="w-3.5 h-3.5" />
            {OFFLINE_PILL_TEXT}
          </div>
        )}
      </div>
      {/* "A newer build exists" is UpdatePill's (TAX-15): one wording, one
          place, one prompt. Once the protected shell is up its own
          UpdatePill shows it, and nothing here is rendered or loaded; before
          that (a public page, or a protected URL still behind the gate) this
          renders it, under UpdatePromptBoundary. */}
      {updateReady && !shellUp && (
        <UpdatePromptBoundary>
          <React.Suspense fallback={null}>
            <UpdatePillForWorker />
          </React.Suspense>
        </UpdatePromptBoundary>
      )}
    </>
  );
}
