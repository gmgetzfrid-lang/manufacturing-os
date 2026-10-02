"use client";

// A tab left open across deploys runs OLD code forever — and every fix
// shipped since looks like it never happened. This polls the serving build
// id (5-minute cadence + whenever the tab regains focus) and, the moment it
// diverges from the id this tab first saw, shows an unmissable refresh pill.
// "dev" ids never trigger it, so local development stays quiet.

import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { loadLatestBuild } from "@/components/pwa/ServiceWorkerManager";
import { appConfirm } from "@/components/providers/DialogProvider";
import { hasUploadsInFlight, releaseUploadUnloadGuard } from "@/lib/uploadActivity";

const POLL_MS = 5 * 60_000;

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

export default function UpdatePill() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
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
  }, []);
  if (!stale) return null;
  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-pop">
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
        <RefreshCw className="w-3.5 h-3.5" />
        This tab is running an old version — tap to load the update
      </button>
    </div>
  );
}
