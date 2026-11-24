"use client";

// /admin/billing: Stripe Checkout and the Customer Portal.
//
// Subscribe buttons POST to /api/stripe/checkout and redirect to the
// returned Stripe-hosted URL. After payment, Stripe redirects back to
// /admin/billing?checkout=success, the webhook flips status='active',
// and the page re-renders with the active-subscription card.
//
// 'Manage subscription' opens the Stripe Customer Portal where the admin
// can update card, view invoices, change plan, or cancel.

import React, { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Lock, ExternalLink, ArrowRight } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useSubscription } from "@/components/providers/SubscriptionProvider";
import { trialDaysRemaining, isTrialExpired } from "@/lib/subscription";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, type HeroFact } from "@/components/ui/PageHero";
import { sheet, link, btnQuiet, Section, Problem, shortDate } from "@/components/admin/kit";
import { said } from "@/components/admin/said";
import { Button } from "@/components/ui/Button";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";

export default function BillingPage() {
  const { activeRole, activeOrgId } = useRole();
  const { info, loading, refresh } = useSubscription();
  const isAuthorized = ["Admin", "Manager"].includes(activeRole);

  const searchParams = useSearchParams();
  const checkoutResult = searchParams.get("checkout");

  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [busyPortal, setBusyPortal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = trialDaysRemaining(info);
  const expired = isTrialExpired(info);

  const subscribe = async (plan: "starter" | "growth") => {
    if (!activeOrgId) return;
    setBusyPlan(plan); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, plan }),
      });
      const result = await res.json();
      if (!res.ok) throw Object.assign(new Error(result.error || "It didn't go through."), result.error ? {} : { status: res.status });
      if (!result.url) throw new Error("The payment page didn't open. Try again in a minute.");
      window.location.href = result.url;
    } catch (e) {
      setError(said(e, "Couldn't open the payment page."));
      setBusyPlan(null);
    }
  };

  const openPortal = async () => {
    if (!activeOrgId) return;
    setBusyPortal(true); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId }),
      });
      const result = await res.json();
      if (!res.ok) throw Object.assign(new Error(result.error || "It didn't go through."), result.error ? {} : { status: res.status });
      window.location.href = result.url;
    } catch (e) {
      setError(said(e, "Couldn't open the subscription page."));
      setBusyPortal(false);
    }
  };

  // The answer: where the subscription stands, in words.
  const planName = info?.plan ? info.plan[0].toUpperCase() + info.plan.slice(1) : null;
  const answer = loading ? "Billing"
    : !info ? "Couldn't load your subscription."
    : info.status === "trialing" && !expired ? (days != null ? `${days} day${days === 1 ? "" : "s"} left in your trial.` : "Free trial.")
    : info.status === "active" ? "Subscription active."
    : info.status === "past_due" ? "Payment past due."
    : info.status === "canceled" ? "Subscription canceled."
    : info.status === "unpaid" ? "Payment failed."
    : info.status === "paused" ? "Subscription paused."
    : expired ? "Your trial has ended."
    : "Billing needs attention.";
  const sub = !info ? "Your plan, payment method and invoices."
    : info.status === "trialing" && !expired ? "No payment needed during the trial."
    : info.status === "active" || info.status === "past_due" ? "Card, invoices and plan changes are in Manage subscription."
    : expired ? "Pick a plan below to continue."
    : "Update your payment method to restore access.";
  const showPortal = !!info && (info.status === "active" || info.status === "past_due");
  const facts: HeroFact[] = [];
  if (info) {
    if (planName) facts.push({ label: "Plan", value: planName });
    if (info.status === "trialing" && !expired && days != null) facts.push({ label: "Trial days left", value: days, tone: days <= 3 ? "warn" : undefined });
    if (info.trialEndsAt && info.status === "trialing") facts.push({ label: "Trial ends", value: shortDate(info.trialEndsAt) });
    if (info.currentPeriodEnd && (info.status === "active" || info.status === "past_due")) facts.push({ label: "Renews", value: shortDate(info.currentPeriodEnd) });
  }

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Billing"
        title={answer}
        sub={sub}
        facts={facts.length ? facts : undefined}
        primary={showPortal ? (
          <Button onClick={() => void openPortal()} loading={busyPortal}>
            {!busyPortal && <ExternalLink className="w-4 h-4" />}
            Manage subscription
          </Button>
        ) : undefined}
      />

      <PageBody>
        {checkoutResult === "success" && (
          <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-reading">
            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--color-text)]"><Check aria-hidden className="w-4 h-4 text-[var(--state-released)]" /> Subscription started.</span>
            <span className="text-[var(--color-text-muted)]">Your status can take a few seconds to update.</span>
            <button type="button" onClick={() => void refresh()} className={link}>Refresh now</button>
          </p>
        )}
        {checkoutResult === "canceled" && (
          <p className="text-reading text-[var(--color-text-muted)]">Checkout canceled. No payment was taken.</p>
        )}
        {error && <Problem>{error}</Problem>}

        {loading ? (
          <SkeletonRows rows={3} cols={1} what="your subscription" />
        ) : !info ? (
          <ErrorNote title="Couldn't load your subscription." onRetry={() => void refresh()} />
        ) : !isAuthorized ? (
          <p className="text-reading text-[var(--color-text-muted)] inline-flex items-center gap-2"><Lock aria-hidden className="w-4 h-4" /> Admin and Manager manage billing.</p>
        ) : null}

        {/* Plans side by side on one sheet */}
        {isAuthorized && info?.status !== "active" && (
          <Section label="Plans">
            <div className={`${sheet} grid grid-cols-1 md:grid-cols-3 md:divide-x max-md:divide-y divide-[var(--color-border)]`}>
              <Plan
                name="Starter" planKey="starter" price="$299" tagline="For small teams"
                features={["Up to 10 users", "All workflow features", "24-hour export presigned URLs", "Email support"]}
                onSubscribe={() => subscribe("starter")} busy={busyPlan === "starter"}
              />
              <Plan
                name="Growth" planKey="growth" featured price="$599" tagline="For most plants"
                features={["Up to 25 users", "Everything in Starter", "Scheduled S3 push backups", "Priority support"]}
                onSubscribe={() => subscribe("growth")} busy={busyPlan === "growth"}
              />
              <Plan
                name="Enterprise" planKey="enterprise" price="Contact" tagline="For large operations"
                features={["Unlimited users", "Custom SLA", "Dedicated success manager", "Priority feature requests"]}
                contactMode
              />
            </div>
          </Section>
        )}
      </PageBody>
    </PageShell>
  );
}

function Plan({
  name, price, tagline, features, featured, onSubscribe, busy, contactMode,
}: {
  name: string; planKey: string; price: string; tagline: string; features: string[];
  featured?: boolean; onSubscribe?: () => void; busy?: boolean; contactMode?: boolean;
}) {
  return (
    <div className="p-5 flex flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-section font-semibold text-[var(--color-text)]">{name}</h3>
        {featured && <span className="text-body text-[var(--color-text-muted)]">Most picked</span>}
      </div>
      <div className="text-body text-[var(--color-text-muted)]">{tagline}</div>
      <div className="mt-3 font-display text-[28px] leading-none font-semibold tabular-nums text-[var(--color-text)]">{price}{price !== "Contact" && <span className="font-sans text-body font-normal text-[var(--color-text-muted)]"> a month</span>}</div>
      <ul className="mt-4 space-y-1.5 text-reading flex-1 text-[var(--color-text)]">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check aria-hidden className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {contactMode ? (
        <a href="mailto:sales@manufacturing-os.app?subject=Enterprise%20inquiry" className={`${btnQuiet} mt-5 w-full h-10`}>
          Contact sales <ArrowRight className="w-3.5 h-3.5" />
        </a>
      ) : (
        <Button variant={featured ? "primary" : "secondary"} onClick={onSubscribe} loading={busy} className="mt-5 w-full">
          {busy ? "Opening checkout" : "Subscribe"}
        </Button>
      )}
    </div>
  );
}
