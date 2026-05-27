"use client";

// TrialBanner — slim top-of-page strip during the free trial.
// Hides automatically once subscription_status leaves 'trialing'.
//
// Colors get more urgent as the trial winds down:
//   30+ days left  -> emerald (informational)
//   7-29 days      -> amber (reminder)
//   1-6 days       -> orange (urgent)
//   0 days / expired -> red (blocked)

import React from "react";
import Link from "next/link";
import { Clock, ArrowRight, AlertTriangle } from "lucide-react";
import { useSubscription } from "@/components/providers/SubscriptionProvider";
import { trialDaysRemaining, isTrialExpired, shouldShowTrialBanner } from "@/lib/subscription";

export default function TrialBanner() {
  const { info } = useSubscription();
  if (!shouldShowTrialBanner(info)) return null;

  const days = trialDaysRemaining(info);
  const expired = isTrialExpired(info);

  // Pick the color tone
  let tone = "bg-emerald-600 text-white";
  let icon = <Clock className="w-4 h-4" />;
  let label = "";

  if (expired) {
    tone = "bg-red-600 text-white";
    icon = <AlertTriangle className="w-4 h-4" />;
    label = "Your free trial has ended. Subscribe to keep using Manufacturing OS.";
  } else if (days !== null) {
    if (days <= 6) {
      tone = "bg-orange-600 text-white";
      icon = <AlertTriangle className="w-4 h-4" />;
    } else if (days <= 29) {
      tone = "bg-amber-500 text-slate-900";
    }
    label = `${days} day${days === 1 ? "" : "s"} left in your free trial`;
  }

  return (
    <div className={`${tone} px-4 py-2 text-xs font-bold flex items-center justify-center gap-3 shadow`}>
      {icon}
      <span>{label}</span>
      <Link
        href="/admin/billing"
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/20 hover:bg-white/30 text-[11px] font-black uppercase tracking-wide backdrop-blur"
      >
        Subscribe <ArrowRight className="w-3 h-3" />
      </Link>
    </div>
  );
}
