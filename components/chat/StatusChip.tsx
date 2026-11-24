"use client";

// StatusChip — one quiet line for "is the machine on and what is it
// costing me": the provider and month-to-date spend against the cap, in
// plain words; a missing key or a near-full cap in its status color with
// the way to AI setup. Paints from the last snapshot instantly, refreshes
// in the background.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { getAiConnections, getAiUsage } from "@/lib/knowledge";

interface Snap {
  /** The status couldn't be read this time (not the same as "no key"). */
  failed?: boolean;
  model: string | null;
  /** Who runs the model (anthropic, openai, gemini). */
  provider?: string | null;
  keyOk: boolean;
  spentUsd: number;
  capUsd: number;
  known: boolean;
}

export default function StatusChip({ orgId, bump }: { orgId: string; /** Change to refetch (after an answer lands). */ bump: number; /** Kept for older callers; the header is plain now. */ onDark?: boolean }) {
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
      if (!conns) {
        // A failed read says so; the last snapshot, if any, stays.
        setSnap((prev) => ({ ...prev, failed: !prev.known || prev.failed === true, known: true }));
        return;
      }
      const next: Snap = {
        model: conns?.personal?.model ?? null,
        provider: conns?.personal?.provider ?? null,
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
  const money = (n: number) => `$${n.toFixed(2)}`;
  const cap = (n: number) => `$${Math.round(n)}`;
  const who = snap.provider ? (PROVIDER_NAME[snap.provider] ?? snap.provider) : "AI";
  const problem = snap.known && (snap.failed || !snap.keyOk);
  const nearCap = snap.known && !problem && pct >= 90;
  const title = !snap.known ? "Checking AI status"
    : snap.failed ? "Couldn't check the AI status"
    : !snap.keyOk ? "No API key saved, so questions can't run"
      : `${snap.model ?? "Model not set"}: ${money(snap.spentUsd)} spent${snap.capUsd > 0 ? ` of your ${cap(snap.capUsd)} cap` : ""} this month`;

  // Plain words, not a chip: who answers and what this month has cost. A
  // problem says so in its status color, with the way to fix it.
  return (
    <div title={title} className="min-w-0 flex items-center gap-2 text-body max-sm:hidden">
      {problem || nearCap ? (
        <>
          <span className={`inline-flex items-center gap-1.5 font-medium whitespace-nowrap ${snap.failed ? "text-[var(--color-text-muted)]" : nearCap ? "text-[var(--state-overdue-text)]" : "text-[var(--state-held-text)]"}`}>
            <span aria-hidden className={`w-2 h-2 rounded-full ${snap.failed ? "bg-[var(--color-text-faint)]" : nearCap ? "bg-[var(--state-overdue)]" : "bg-[var(--state-held)]"}`} />
            {snap.failed ? "AI status unknown" : nearCap ? `${money(snap.spentUsd)} of ${cap(snap.capUsd)} used this month` : "No AI key"}
          </span>
          <Link href="/intelligence/setup" className="whitespace-nowrap text-[var(--color-accent-text)] hover:underline">AI setup</Link>
        </>
      ) : (
        <span className="min-w-0 truncate text-[var(--color-text-muted)]">
          {!snap.known ? "Checking AI" : <><span className="font-medium text-[var(--color-text)]">{who}</span>{` ${money(snap.spentUsd)}${snap.capUsd > 0 ? ` of ${cap(snap.capUsd)}` : ""} this month`}</>}
        </span>
      )}
    </div>
  );
}

/** The provider by the name people know it by. */
const PROVIDER_NAME: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini" };
