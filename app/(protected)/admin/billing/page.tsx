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
  Clock, CheckCircle2, AlertTriangle, Lock, Loader2,
  ExternalLink, ArrowRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useSubscription } from "@/components/providers/SubscriptionProvider";
import { trialDaysRemaining, isTrialExpired } from "@/lib/subscription";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
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
    : info.status === "trialing" && !expired ? `${days} day${days === 1 ? "" : "s"} left in your trial.`
    : info.status === "active" ? "Subscription active."
    : info.status === "past_due" ? "Payment past due."
    : info.status === "canceled" ? "Subscription canceled."
    : info.status === "unpaid" ? "Payment failed."
    : info.status === "paused" ? "Subscription paused."
    : expired ? "Your trial has ended."
    : "Billing needs attention.";
  const sub = !info ? "Your plan, payment method and invoices."
    : info.status === "trialing" && !expired ? <>No payment needed during the trial.{info.trialEndsAt && <> It ends {new Date(info.trialEndsAt).toLocaleDateString()}.</>}</>
    : info.status === "active" || info.status === "past_due" ? <>Plan: {planName ?? "-"}{info.currentPeriodEnd && <> · renews {new Date(info.currentPeriodEnd).toLocaleDateString()}</>}</>
    : expired ? "Pick a plan below to continue."
    : "Update your payment method to restore access.";
  const showPortal = !!info && (info.status === "active" || info.status === "past_due");

  return (
    <PageShell width="form">
      <PageHero
        kicker="Admin · Billing"
        title={answer}
        size="md"
        sub={sub}
        primary={showPortal ? (
          <button type="button" onClick={openPortal} disabled={busyPortal} className={heroPrimary}>
            {busyPortal ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
            Manage subscription
          </button>
        ) : undefined}
      />

      <PageBody>
        {/* Current status card */}
        <Card label="Subscription">
          {checkoutResult === "success" && (
            <p role="status" className="mb-3 text-[14px] text-emerald-800 dark:text-emerald-300 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                <b>Subscription started.</b> Your status can take a few seconds to update.
                <button type="button" onClick={() => void refresh()} className="ml-1 underline font-bold">Refresh now</button>
              </span>
            </p>
          )}
          {checkoutResult === "canceled" && (
            <p className="mb-3 text-[14px] text-[var(--color-text-muted)]">
              Checkout canceled. No payment was taken.
            </p>
          )}
          {error && (
            <p role="alert" className="mb-3 text-[13px] text-red-700 dark:text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </p>
          )}
          {loading ? (
            <div className="text-[14px] text-[var(--color-text-muted)] flex items-center gap-2"><Spinner size="sm" /> Loading your subscription…</div>
          ) : !info ? (
            <div className="text-[14px] text-[var(--color-text-muted)]">Couldn&apos;t load your subscription. <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button></div>
          ) : info.status === "trialing" && !expired ? (
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[var(--color-surface-2)] rounded-[10px]"><Clock className="w-4 h-4 text-[var(--color-text-muted)]" /></div>
              <div>
                <div className="text-[14px] font-bold text-[var(--color-text)]">Free trial · {days} day{days === 1 ? "" : "s"} left</div>
                <div className="text-[13px] text-[var(--color-text-muted)]">No payment required during the trial{info.trialEndsAt ? `. Ends ${new Date(info.trialEndsAt).toLocaleDateString()}.` : "."}</div>
              </div>
            </div>
          ) : info.status === "active" || info.status === "past_due" ? (
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-[10px] bg-[var(--color-surface-2)]">
                {info.status === "past_due" ? <AlertTriangle className="w-4 h-4 text-amber-700" /> : <CheckCircle2 className="w-4 h-4 text-emerald-700" />}
              </div>
              <div>
                <div className={`text-[14px] font-bold ${info.status === "past_due" ? "text-amber-800 dark:text-amber-300" : "text-[var(--color-text)]"}`}>
                  {info.status === "past_due" ? "Payment past due" : "Active subscription"}
                </div>
                <div className="text-[13px] text-[var(--color-text-muted)]">
                  Plan: <b>{planName ?? "-"}</b>
                  {info.currentPeriodEnd && <> · Renews {new Date(info.currentPeriodEnd).toLocaleDateString()}</>}
                  . Card, invoices and plan changes are in Manage subscription.
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <div className="p-2 bg-[var(--color-surface-2)] rounded-[10px]"><AlertTriangle className="w-4 h-4 text-red-700 dark:text-red-400" /></div>
              <div>
                <div className="text-[14px] font-bold text-red-700 dark:text-red-400">
                  {info.status === "canceled" ? "Subscription canceled" :
                   info.status === "unpaid" ? "Payment failed" :
                   info.status === "paused" ? "Subscription paused" :
                   expired ? "Trial expired" : "Action required"}
                </div>
                <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">
                  {expired
                    ? "Your free trial has ended. Pick a plan below to continue."
                    : "Update your payment method to restore access."}
                </div>
              </div>
            </div>
          )}
          {!isAuthorized && (
            <p className="mt-3 pt-3 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text-muted)] flex items-start gap-2">
              <Lock className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Only Admin and Manager roles manage billing.</span>
            </p>
          )}
        </Card>

        {/* Plans grid */}
        {isAuthorized && info?.status !== "active" && (
          <Card label="Plans">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
          </Card>
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
    <div className={`rounded-xl p-4 flex flex-col ${featured ? "bg-[var(--color-surface-2)]" : "ring-1 ring-[var(--color-border)]"}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[14px] font-bold text-[var(--color-text)]">{name}</div>
        {featured && <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Most picked</span>}
      </div>
      <div className="text-[13px] text-[var(--color-text-muted)]">{tagline}</div>
      <div className="mt-2 text-[15px] font-extrabold text-[var(--color-text)]">{price}{price !== "Contact" && <span className="text-[13px] font-semibold text-[var(--color-text-muted)]"> a month</span>}</div>
      <ul className="mt-3 space-y-1.5 text-[13px] flex-1 text-[var(--color-text-muted)]">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--color-text-faint)]" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {contactMode ? (
        <a
          href="mailto:sales@manufacturing-os.app?subject=Enterprise%20inquiry"
          className="mt-4 inline-flex items-center justify-center gap-1 w-full h-10 rounded-xl text-[13px] font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-opacity"
        >
          Contact sales <ArrowRight className="w-3.5 h-3.5" />
        </a>
      ) : (
        <button
          type="button"
          onClick={onSubscribe} disabled={busy}
          className={`mt-4 inline-flex items-center justify-center gap-1 w-full h-10 rounded-xl text-[13px] font-extrabold transition-colors disabled:opacity-50 ${
            featured ? "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)]" : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)]"
          }`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          {busy ? "Opening checkout…" : "Subscribe"}
        </button>
      )}
    </div>
  );
}
