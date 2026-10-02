"use client";

// A tab left open across deploys runs OLD code forever — and every fix
// shipped since looks like it never happened. This polls the serving build
// id (5-minute cadence + whenever the tab regains focus) and, the moment it
// diverges from the id this tab first saw, shows an unmissable refresh pill.
// "dev" ids never trigger it, so local development stays quiet.
//
// It is the ONE component that says "a newer build exists" (TAX-15,
// notifications Round G N3). Two detectors feed it: the build-id poll here,
// and the service worker's waiting worker (components/pwa/ServiceWorkerManager.tsx
// reports it — every deploy leaves one, OFF-4 / OFF-11). Whichever fires
// first, the person sees one pill, top-centre, in one wording, and its tap
// goes through the one reload path: ask first over an upload in flight
// (STACK-13), then loadLatestBuild, which activates the waiting worker. The
// protected shell mounts it (and polls); a page without the shell gets it
// from ServiceWorkerManager for the waiting worker only — and only while no
// shell instance is mounted, so two never show at once.

import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { loadLatestBuild } from "@/components/pwa/ServiceWorkerManager";
import { subscribeWaitingWorker, waitingWorkerSnapshot } from "@/components/pwa/ServiceWorkerManager";
import { appConfirm } from "@/components/providers/DialogProvider";
import { hasUploadsInFlight, releaseUploadUnloadGuard } from "@/lib/uploadActivity";

const POLL_MS = 5 * 60_000;

/** The one wording for "a newer build exists" (TAX-15). It used to be two:
 *  "This tab is running an old version — tap to load the update" here and
 *  "Update available — tap to refresh" on the service worker's button. */
export const UPDATE_PROMPT_TEXT = "A newer version of the app is available — tap to load it";

/** STACK-13: loading the update reloads the tab, which kills an upload on
 *  the wire with no record. While one is in flight the pill asks first; a
 *  person who says go is not asked again by the browser's own prompt. */
export async function confirmReloadDuringUploads(deps: {
  inFlight: () => boolean;
  confirm: (o: { title: string; message: string; confirmLabel: string; cancelLabel: string; tone: "danger" }) => Promise<boolean>;
  release: () => void;
} = { inFlight: hasUploadsInFlight, confirm: appConfirm, release: releaseUploadUnloadGuard }): Promise<boolean> {
  if (!deps.inFlight()) return true;
  const ok = await deps.confirm({
    title: "An upload is still running",
    message: "Loading the update reloads this tab, which stops the upload in progress. Files that already finished are saved; the rest will need uploading again.",
    confirmLabel: "Reload anyway",
    cancelLabel: "Wait",
    tone: "danger",
  });
  if (ok) deps.release();
  return ok;
}

// The shell's instances, so the service worker's fallback instance stands
// down while one is mounted: one prompt at a time.
let shellInstances = 0;
const shellListeners = new Set<() => void>();
function subscribeShell(cb: () => void) {
  shellListeners.add(cb);
  return () => { shellListeners.delete(cb); };
}
function shellMounted(): boolean { return shellInstances > 0; }
function emitShell() {
  for (const l of shellListeners) {
    try { l(); } catch { /* ignore */ }
  }
}

/** The protected shell's mount: polls the build id and owns the prompt. */
export default function UpdatePill() {
  return <UpdatePrompt shell />;
}

/** ServiceWorkerManager's mount on a page without the shell: the waiting
 *  worker only, and nothing while a shell instance is mounted. */
export function UpdatePillForWaitingWorker() {
  return <UpdatePrompt shell={false} />;
}

function UpdatePrompt({ shell }: { shell: boolean }) {
  const [stale, setStale] = useState(false);
  const workerWaiting = useSyncExternalStore(subscribeWaitingWorker, waitingWorkerSnapshot, () => false);
  const shellUp = useSyncExternalStore(subscribeShell, shellMounted, () => false);

  useLayoutEffect(() => {
    if (!shell) return;
    shellInstances++;
    emitShell();
    return () => { shellInstances--; emitShell(); };
  }, [shell]);

  useEffect(() => {
    if (!shell) return;
    let booted: string | null = null;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const { id } = (await res.json()) as { id?: string };
        if (!id || id === "dev") return;
        if (booted === null) { booted = id; return; }
        if (id !== booted) setStale(true);
      } catch { /* offline — the next tick tries again */ }
    };
    void check();
    const t = window.setInterval(() => void check(), POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [shell]);

  if (!shell && shellUp) return null;
  if (!stale && !workerWaiting) return null;
  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-pop" data-update-prompt>
      <button
        onClick={async () => {
          if (!(await confirmReloadDuringUploads())) return;
          const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
          void loadLatestBuild({
            serviceWorker: sw,
            getRegistration: sw ? () => sw.getRegistration() : null,
            reload: () => window.location.reload(),
            setTimeout: (cb, ms) => window.setTimeout(cb, ms),
          });
        }}
        className="inline-flex items-center gap-2 rounded-full border-2 border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/95 px-4 py-2 text-xs font-black text-amber-900 dark:text-amber-200 shadow-xl hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors"
      >
        <RefreshCw className="w-3.5 h-3.5" aria-hidden />
        {UPDATE_PROMPT_TEXT}
      </button>
    </div>
  );
}
