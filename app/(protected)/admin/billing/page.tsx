"use client";

// /admin/billing — wired up to Stripe Checkout + Customer Portal.
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
import {
  CheckCircle2, Lock, Loader2,
  ExternalLink, ArrowRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useSubscription } from "@/components/providers/SubscriptionProvider";
import { trialDaysRemaining, isTrialExpired } from "@/lib/subscription";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary, type HeroFact } from "@/components/ui/PageHero";
import { sheet, link, btnPrimary, btnQuiet, FormRow, Section, StatusTag, Problem, shortDate } from "@/components/admin/kit";
import { Spinner } from "@/components/ui/Spinner";

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
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
      if (!result.url) throw new Error("No checkout URL returned");
      window.location.href = result.url;
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
      window.location.href = result.url;
    } catch (e) {
      setError((e as Error).message);
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
  const bad = !!info && !(info.status === "active" || (info.status === "trialing" && !expired));
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
          <button type="button" onClick={openPortal} disabled={busyPortal} className={heroPrimary}>
            {busyPortal ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
            Manage subscription
          </button>
        ) : undefined}
      />

      <PageBody>
        {checkoutResult === "success" && (
          <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px]">
            <StatusTag tone="good">Subscription started.</StatusTag>
            <span className="text-[var(--color-text-muted)]">Your status can take a few seconds to update.</span>
            <button type="button" onClick={() => void refresh()} className={link}>Refresh now</button>
          </p>
        )}
        {checkoutResult === "canceled" && (
          <p className="text-[15px] text-[var(--color-text-muted)]">Checkout canceled. No payment was taken.</p>
        )}
        {error && <Problem>{error}</Problem>}

        <Section label="Subscription">
          {loading ? (
            <div className={`${sheet} px-4 py-3 text-[15px] text-[var(--color-text-muted)] flex items-center gap-2`}><Spinner size="sm" /> Loading your subscription…</div>
          ) : !info ? (
            <Problem retry={() => void refresh()}>Couldn&apos;t load your subscription.</Problem>
          ) : (
            <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
              <FormRow label="Status">
                <div className="@xl:pt-2">
                  <StatusTag tone={bad ? "bad" : info.status === "past_due" ? "warn" : "none"} colored={bad}>
                    {info.status === "trialing" && !expired ? (days != null ? `Free trial, ${days} day${days === 1 ? "" : "s"} left` : "Free trial")
                      : info.status === "active" ? "Active"
                      : info.status === "past_due" ? "Payment past due"
                      : info.status === "canceled" ? "Canceled"
                      : info.status === "unpaid" ? "Payment failed"
                      : info.status === "paused" ? "Paused"
                      : expired ? "Trial ended" : "Action required"}
                  </StatusTag>
                </div>
              </FormRow>
              <FormRow label="Plan"><div className="@xl:pt-2 text-[15px] text-[var(--color-text)]">{planName ?? "None yet"}</div></FormRow>
              {info.currentPeriodEnd && (info.status === "active" || info.status === "past_due") && (
                <FormRow label="Renews"><div className="@xl:pt-2 text-[15px] text-[var(--color-text)]">{shortDate(info.currentPeriodEnd)}</div></FormRow>
              )}
              {info.trialEndsAt && info.status === "trialing" && (
                <FormRow label="Trial ends"><div className="@xl:pt-2 text-[15px] text-[var(--color-text)]">{shortDate(info.trialEndsAt)}</div></FormRow>
              )}
              {!isAuthorized && (
                <FormRow label="Who manages billing"><div className="@xl:pt-2 text-[15px] text-[var(--color-text-muted)] inline-flex items-center gap-2"><Lock className="w-4 h-4" /> Admin and Manager roles only.</div></FormRow>
              )}
            </div>
          )}
        </Section>

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
        <h3 className="font-display text-[19px] font-semibold text-[var(--color-text)]">{name}</h3>
        {featured && <span className="text-[13px] text-[var(--color-text-muted)]">Most picked</span>}
      </div>
      <div className="text-[14px] text-[var(--color-text-muted)]">{tagline}</div>
      <div className="mt-3 font-display text-[28px] leading-none font-semibold tabular-nums text-[var(--color-text)]">{price}{price !== "Contact" && <span className="font-sans text-[14px] font-normal text-[var(--color-text-muted)]"> a month</span>}</div>
      <ul className="mt-4 space-y-1.5 text-[15px] flex-1 text-[var(--color-text)]">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {contactMode ? (
        <a href="mailto:sales@manufacturing-os.app?subject=Enterprise%20inquiry" className={`${btnQuiet} mt-5 w-full h-10`}>
          Contact sales <ArrowRight className="w-3.5 h-3.5" />
        </a>
      ) : (
        <button type="button" onClick={onSubscribe} disabled={busy} className={`${featured ? btnPrimary : `${btnQuiet} h-10`} mt-5 w-full`}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {busy ? "Opening checkout…" : "Subscribe"}
        </button>
      )}
    </div>
  );
}
