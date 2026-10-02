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
// shell instance is mounted, so two never show at once. The shared state
// (the waiting worker, the shell's registration, the wording, the reload
// path) lives in the leaf module components/pwa/swUpdate.ts.

import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import {
  UPDATE_PROMPT_BUTTON_CLASS, UPDATE_PROMPT_TEXT, UPDATE_PROMPT_WRAP_CLASS, loadLatestBuildInThisTab, registerUpdatePromptShell,
  subscribeUpdatePromptShell, subscribeWaitingWorker, updatePromptShellMounted, waitingWorkerSnapshot,
} from "@/components/pwa/swUpdate";
import { appConfirm } from "@/components/providers/DialogProvider";
import { hasUploadsInFlight, releaseUploadUnloadGuard } from "@/lib/uploadActivity";

const POLL_MS = 5 * 60_000;

/** The one wording for "a newer build exists" (TAX-15) — swUpdate's. */
export { UPDATE_PROMPT_TEXT };

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
  const shellUp = useSyncExternalStore(subscribeUpdatePromptShell, updatePromptShellMounted, () => false);

  // The shell's instance registers, so any other instance stands down while
  // it is mounted: one prompt at a time.
  useLayoutEffect(() => {
    if (!shell) return;
    return registerUpdatePromptShell();
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
    <div className={UPDATE_PROMPT_WRAP_CLASS} data-update-prompt>
      <button
        type="button"
        onClick={async () => {
          if (!(await confirmReloadDuringUploads())) return;
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
