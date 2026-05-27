"use client";

// SubscriptionProvider — fetches the active org's subscription state
// once at mount and on org change. Exposes a hook that consumers (banners,
// gates, billing page) read.
//
// Fail-open: if the lookup fails, hasAccess() returns true so we don't
// lock users out due to a transient DB error.

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import type { SubscriptionInfo } from "@/lib/subscription";

interface Ctx {
  info: SubscriptionInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const SubscriptionCtx = createContext<Ctx>({
  info: null,
  loading: true,
  refresh: async () => {},
});

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { activeOrgId } = useRole();
  const [info, setInfo] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSub = useCallback(async () => {
    if (!activeOrgId) {
      setInfo(null);
      setLoading(false);
      return;
    }
    try {
      const { data } = await supabase
        .from("orgs")
        .select("subscription_status, subscribed_plan, trial_ends_at, current_period_end, stripe_customer_id, stripe_subscription_id")
        .eq("id", activeOrgId)
        .maybeSingle();
      if (data) {
        const row = data as Record<string, unknown>;
        setInfo({
          status: (row.subscription_status as SubscriptionInfo["status"]) || "trialing",
          plan: (row.subscribed_plan as string | null) ?? null,
          trialEndsAt: (row.trial_ends_at as string | null) ?? null,
          currentPeriodEnd: (row.current_period_end as string | null) ?? null,
          stripeCustomerId: (row.stripe_customer_id as string | null) ?? null,
          stripeSubscriptionId: (row.stripe_subscription_id as string | null) ?? null,
        });
      } else {
        setInfo(null);
      }
    } catch (e) {
      console.warn("SubscriptionProvider fetch failed (failing open):", e);
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { void fetchSub(); }, [fetchSub]);

  return (
    <SubscriptionCtx.Provider value={{ info, loading, refresh: fetchSub }}>
      {children}
    </SubscriptionCtx.Provider>
  );
}

export function useSubscription(): Ctx {
  return useContext(SubscriptionCtx);
}
