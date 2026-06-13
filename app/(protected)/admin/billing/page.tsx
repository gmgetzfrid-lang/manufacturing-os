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
  CreditCard, Clock, CheckCircle2, AlertTriangle, Lock, Loader2,
  ExternalLink, ArrowRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useSubscription } from "@/components/providers/SubscriptionProvider";
import { trialDaysRemaining, isTrialExpired } from "@/lib/subscription";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
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

  return (
    <PageShell width="form">
      <PageHeaderBar
        icon={CreditCard}
        title="Billing & Subscription"
        subtitle="Manage your plan, payment method, and invoice history."
      />

      {checkoutResult === "success" && (
          <div className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800 flex items-start gap-2">
            <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
            <div>
              <b>Subscription started.</b> It may take a few seconds for your status to update —
              <button onClick={() => void refresh()} className="ml-1 underline font-bold">refresh now</button>.
            </div>
          </div>
        )}
        {checkoutResult === "canceled" && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
            Checkout canceled. No payment was taken. Pick a plan below when you&apos;re ready.
          </div>
        )}
        {error && (
          <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {!isAuthorized && (
          <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Only Admin and Manager roles can manage billing. Your role: <b>{activeRole}</b>.</span>
          </div>
        )}

        {/* Current status card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
          {loading ? (
            <div className="text-sm text-slate-500 flex items-center gap-2"><Spinner size="sm" /> Loading subscription state...</div>
          ) : !info ? (
            <div className="text-sm text-slate-500">No subscription information available.</div>
          ) : info.status === "trialing" && !expired ? (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-emerald-100 rounded-xl"><Clock className="w-5 h-5 text-emerald-700" /></div>
                <div>
                  <div className="text-base font-black text-slate-900">Free Trial</div>
                  <div className="text-xs text-slate-500">No payment required during trial</div>
                </div>
              </div>
              <div className="text-4xl font-black text-slate-900 mb-1">
                {days} <span className="text-base font-bold text-slate-500">day{days === 1 ? "" : "s"} remaining</span>
              </div>
              {info.trialEndsAt && (
                <div className="text-xs text-slate-500">Trial ends {new Date(info.trialEndsAt).toLocaleDateString()}</div>
              )}
            </div>
          ) : info.status === "active" || info.status === "past_due" ? (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className={`p-2 rounded-xl ${info.status === "past_due" ? "bg-amber-100" : "bg-emerald-100"}`}>
                  {info.status === "past_due" ? <AlertTriangle className="w-5 h-5 text-amber-700" /> : <CheckCircle2 className="w-5 h-5 text-emerald-700" />}
                </div>
                <div>
                  <div className="text-base font-black text-slate-900">
                    {info.status === "past_due" ? "Payment Past Due" : "Active Subscription"}
                  </div>
                  <div className="text-xs text-slate-500">
                    Plan: <b>{info.plan ? info.plan[0].toUpperCase() + info.plan.slice(1) : "—"}</b>
                    {info.currentPeriodEnd && <> · Renews {new Date(info.currentPeriodEnd).toLocaleDateString()}</>}
                  </div>
                </div>
              </div>
              <button
                onClick={openPortal} disabled={busyPortal}
                className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-xs font-bold transition-colors disabled:opacity-50"
              >
                {busyPortal ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                Manage subscription / payment
              </button>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <div className="p-2 bg-red-100 rounded-xl"><AlertTriangle className="w-5 h-5 text-red-700" /></div>
              <div>
                <div className="text-base font-black text-slate-900">
                  {info.status === "canceled" ? "Subscription Canceled" :
                   info.status === "unpaid" ? "Payment Failed" :
                   info.status === "paused" ? "Subscription Paused" :
                   expired ? "Trial Expired" : "Action Required"}
                </div>
                <div className="text-xs text-slate-600 mt-0.5">
                  {expired
                    ? "Your free trial has ended. Pick a plan below to continue."
                    : "Update your payment method to restore access."}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Plans grid */}
        {isAuthorized && info?.status !== "active" && (
          <div className="mb-6">
            <h2 className="text-sm font-black text-slate-900 mb-3">Plans</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                features={["Unlimited users", "Custom SLA", "Dedicated success manager", "SSO + advanced controls"]}
                contactMode
              />
            </div>
          </div>
        )}
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
    <div className={`rounded-2xl border p-5 flex flex-col ${featured ? "bg-slate-900 text-white border-slate-700" : "bg-white border-slate-200"}`}>
      <div className="flex items-center justify-between mb-1">
        <div className={`text-sm font-black ${featured ? "text-white" : "text-slate-900"}`}>{name}</div>
        {featured && <span className="text-[10px] font-black uppercase tracking-widest bg-orange-500 text-white px-1.5 py-0.5 rounded">Popular</span>}
      </div>
      <div className={`text-xs ${featured ? "text-slate-300" : "text-slate-500"} mb-3`}>{tagline}</div>
      <div className={`text-3xl font-black ${featured ? "text-white" : "text-slate-900"} mb-1`}>{price}{price !== "Contact" && <span className="text-sm font-bold text-slate-400">/mo</span>}</div>
      <ul className={`mt-3 space-y-1.5 text-xs flex-1 ${featured ? "text-slate-300" : "text-slate-600"}`}>
        {features.map((f) => (
          <li key={f} className="flex items-start gap-1.5">
            <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${featured ? "text-emerald-400" : "text-emerald-600"}`} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {contactMode ? (
        <a
          href="mailto:sales@manufacturing-os.app?subject=Enterprise%20inquiry"
          className={`mt-4 inline-flex items-center justify-center gap-1 w-full py-2 rounded-lg text-xs font-black ${featured ? "bg-white text-slate-900" : "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"} hover:opacity-90 transition-opacity`}
        >
          Contact sales <ArrowRight className="w-3.5 h-3.5" />
        </a>
      ) : (
        <button
          onClick={onSubscribe} disabled={busy}
          className={`mt-4 inline-flex items-center justify-center gap-1 w-full py-2 rounded-lg text-xs font-black transition-colors disabled:opacity-50 ${
            featured ? "bg-orange-500 hover:bg-orange-400 text-white" : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)]"
          }`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          {busy ? "Redirecting..." : "Subscribe"}
        </button>
      )}
    </div>
  );
}
