"use client";

// A tab left open across deploys runs OLD code forever — and every fix
// shipped since looks like it never happened. This polls the serving build
// id (5-minute cadence + whenever the tab regains focus) and, the moment it
// diverges from the id this tab first saw, shows an unmissable refresh pill.
// "dev" ids never trigger it, so local development stays quiet.

import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

const POLL_MS = 5 * 60_000;

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
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-2 rounded-full border-2 border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/95 px-4 py-2 text-xs font-black text-amber-900 dark:text-amber-200 shadow-xl hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        This tab is running an old version — tap to load the update
      </button>
    </div>
  );
}
