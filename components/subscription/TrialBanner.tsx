"use client";

// TrialBanner: one quiet full-width line across the top during the free
// trial. Hides once subscription_status leaves 'trialing'. The words stay
// graphite; a small dot carries the state (amber in the last week, red once
// it has ended), and Subscribe is a plain link.

import React from "react";
import Link from "next/link";
import { useSubscription } from "@/components/providers/SubscriptionProvider";
import { trialDaysRemaining, isTrialExpired, shouldShowTrialBanner } from "@/lib/subscription";

export default function TrialBanner() {
  const { info } = useSubscription();
  if (!shouldShowTrialBanner(info)) return null;

  const days = trialDaysRemaining(info);
  const expired = isTrialExpired(info);
  const label = expired
    ? "Free trial ended."
    : days !== null
      ? `Free trial: ${days} day${days === 1 ? "" : "s"} left.`
      : "Free trial.";
  const dot = expired
    ? "bg-[var(--state-overdue)]"
    : days !== null && days <= 6
      ? "bg-[var(--state-held)]"
      : "bg-[var(--color-text-faint)]";

  return (
    <div role="status" className="shrink-0 w-full flex items-center gap-2 min-h-9 px-4 sm:px-6 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] text-body text-[var(--color-text)]">
      <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <span>{label}</span>
      <Link href="/admin/billing" className="text-[var(--color-accent-text)] hover:underline underline-offset-2">
        Subscribe
      </Link>
    </div>
  );
}
