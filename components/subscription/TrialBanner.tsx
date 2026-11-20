"use client";

// TrialBanner: one quiet line at the top of the page during the free trial.
// Hides once subscription_status leaves 'trialing'. Not a banner: the days
// left turn amber in the last week and red once it has ended, nothing else.

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
  const tone = expired
    ? "text-rose-700 dark:text-rose-400 font-semibold"
    : days !== null && days <= 6
      ? "text-amber-700 dark:text-amber-400 font-semibold"
      : "";

  return (
    <p className="px-4 py-1 text-xs text-center text-[var(--color-text-muted)] bg-[var(--color-surface)] border-b border-[var(--color-border)]">
      <span className={tone}>{label}</span>{" "}
      <Link href="/admin/billing" className="font-semibold text-[var(--color-accent)] hover:underline">
        Subscribe
      </Link>
    </p>
  );
}
