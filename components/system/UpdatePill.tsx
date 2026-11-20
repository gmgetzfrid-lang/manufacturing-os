"use client";

// A tab left open across deploys runs OLD code forever, and every fix
// shipped since looks like it never happened. This polls the serving build
// id (5-minute cadence + whenever the tab regains focus) and, the moment it
// diverges from the id this tab first saw, shows a refresh pill.
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
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-2 rounded-full bg-[var(--color-ink)] px-4 h-10 text-[13px] font-semibold text-[var(--color-ink-fg)] shadow-[var(--shadow-card)] hover:bg-[var(--color-ink-2)] transition-colors"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        A new version is ready. Tap to reload.
      </button>
    </div>
  );
}
