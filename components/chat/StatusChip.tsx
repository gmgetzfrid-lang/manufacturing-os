"use client";

// StatusChip — one quiet corner for "is the machine on and what is it
// costing me": key health dot, model, month-to-date spend against the cap.
// Paints from the last snapshot instantly, refreshes in the background.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { getAiConnections, getAiUsage } from "@/lib/knowledge";

interface Snap {
  model: string | null;
  keyOk: boolean;
  spentUsd: number;
  capUsd: number;
  known: boolean;
}

export default function StatusChip({ orgId, bump }: { orgId: string; /** Change to refetch (after an answer lands). */ bump: number }) {
  const [snap, setSnap] = useState<Snap>({ model: null, keyOk: false, spentUsd: 0, capUsd: 0, known: false });
  const key = `chat-status-${orgId}`;

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const cached = window.localStorage.getItem(key);
        if (cached) setSnap((prev) => (prev.known ? prev : { ...(JSON.parse(cached) as Snap), known: true }));
      } catch { /* no snapshot */ }
    });
    void (async () => {
      const [conns, usage] = await Promise.all([
        getAiConnections(orgId).catch(() => null),
        getAiUsage(orgId).catch(() => null),
      ]);
      if (cancelled) return;
      const next: Snap = {
        model: conns?.personal?.model ?? null,
        keyOk: !!conns?.personal?.keyLast4,
        spentUsd: usage?.spentUsd ?? 0,
        capUsd: usage?.capUsd ?? 0,
        known: true,
      };
      setSnap(next);
      try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* quota */ }
    })();
    return () => { cancelled = true; };
  }, [orgId, key, bump]);

  const pct = snap.capUsd > 0 ? Math.min(100, Math.round((snap.spentUsd / snap.capUsd) * 100)) : 0;
  const tone = !snap.known ? "bg-[var(--color-border-strong)]"
    : !snap.keyOk ? "bg-amber-500"
      : pct >= 90 ? "bg-rose-500" : "bg-emerald-500";

  return (
    <Link href="/intelligence/setup"
      title={!snap.known ? "Checking AI status…"
        : !snap.keyOk ? "No API key saved — questions can't run. Open AI setup."
          : `${snap.model ?? "model"} · $${snap.spentUsd.toFixed(2)}${snap.capUsd > 0 ? ` of $${snap.capUsd.toFixed(2)}` : ""} this month`}
      className="inline-flex items-center gap-2 h-7 pl-2 pr-2.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)] transition-colors max-w-[220px]">
      <span className={`w-2 h-2 rounded-full shrink-0 ${tone} ${!snap.known ? "animate-pulse" : ""}`} />
      <span className="truncate">
        {!snap.known ? "AI status" : !snap.keyOk ? "No key" : (snap.model ?? "model")}
      </span>
      {snap.known && snap.keyOk && (
        <span className="tabular-nums text-[var(--color-text-faint)] shrink-0">
          ${snap.spentUsd.toFixed(2)}{snap.capUsd > 0 ? `/${snap.capUsd.toFixed(0)}` : ""}
        </span>
      )}
    </Link>
  );
}
