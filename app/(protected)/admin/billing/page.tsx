"use client";

// /admin/billing — placeholder until Stripe is wired up in Phase 2.
// Shows the current trial status + countdown. The Subscribe button is
// disabled with a tooltip; Phase 2 wires it to a Stripe Checkout session.

import React from "react";
import Link from "next/link";
import {
  CreditCard, Clock, CheckCircle2, AlertTriangle, ExternalLink, Lock,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useSubscription } from "@/components/providers/SubscriptionProvider";
import { trialDaysRemaining, isTrialExpired } from "@/lib/subscription";

export default function BillingPage() {
  const { activeRole } = useRole();
  const { info, loading } = useSubscription();
  const isAuthorized = ["Admin", "Manager"].includes(activeRole);

  const days = trialDaysRemaining(info);
  const expired = isTrialExpired(info);

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
            <CreditCard className="w-7 h-7 text-emerald-600" />
            Billing & Subscription
          </h1>
          <p className="text-sm text-slate-600 mt-1">Manage your plan, payment method, and invoice history.</p>
        </div>

        {!isAuthorized && (
          <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Only Admin and Manager roles can manage billing. Your role: <b>{activeRole}</b>.</span>
          </div>
        )}

        {/* Current status card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
          {loading ? (
            <div className="text-sm text-slate-500">Loading subscription state...</div>
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
          ) : info.status === "active" ? (
            <div className="flex items-start gap-3">
              <div className="p-2 bg-emerald-100 rounded-xl"><CheckCircle2 className="w-5 h-5 text-emerald-700" /></div>
              <div>
                <div className="text-base font-black text-slate-900">Active Subscription</div>
                <div className="text-xs text-slate-500">Plan: <b>{info.plan || "—"}</b></div>
                {info.currentPeriodEnd && (
                  <div className="text-xs text-slate-500 mt-0.5">Renews {new Date(info.currentPeriodEnd).toLocaleDateString()}</div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <div className="p-2 bg-red-100 rounded-xl"><AlertTriangle className="w-5 h-5 text-red-700" /></div>
              <div>
                <div className="text-base font-black text-slate-900">
                  {info.status === "past_due" ? "Payment Past Due" :
                   info.status === "canceled" ? "Subscription Canceled" :
                   info.status === "unpaid" ? "Payment Failed" :
                   expired ? "Trial Expired" : "Action Required"}
                </div>
                <div className="text-xs text-slate-600 mt-0.5">
                  {expired
                    ? "Your free trial has ended. Subscribe to keep using Manufacturing OS."
                    : "Update your payment method to restore access."}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Plans grid (placeholder — Phase 2 makes these checkout-able) */}
        <div className="mb-6">
          <h2 className="text-sm font-black text-slate-900 mb-3">Plans</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Plan name="Starter" price="$299" tagline="For small teams" features={["Up to 10 users", "All workflow features", "24-hour export presigned URLs", "Email support"]} />
            <Plan name="Growth" featured price="$599" tagline="For most plants" features={["Up to 25 users", "Everything in Starter", "Scheduled S3 push backups", "Priority support"]} />
            <Plan name="Enterprise" price="Contact" tagline="For large operations" features={["Unlimited users", "Custom SLA", "Dedicated success manager", "SSO + advanced controls"]} />
          </div>
        </div>

        <div className="p-4 bg-slate-100 border border-slate-200 rounded-2xl text-xs text-slate-600 leading-relaxed">
          <b>Coming soon (Phase 2):</b> Subscribe via Stripe Checkout directly from this page. Update payment
          method, view invoices, change plan, and cancel from a Stripe-hosted billing portal. We&apos;re finishing
          the payments integration — in the meantime, your access continues uninterrupted during your trial.
        </div>
      </div>
    </div>
  );
}

function Plan({ name, price, tagline, features, featured }: { name: string; price: string; tagline: string; features: string[]; featured?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${featured ? "bg-slate-900 text-white border-slate-700" : "bg-white border-slate-200"}`}>
      <div className="flex items-center justify-between mb-1">
        <div className={`text-sm font-black ${featured ? "text-white" : "text-slate-900"}`}>{name}</div>
        {featured && <span className="text-[10px] font-black uppercase tracking-widest bg-orange-500 text-white px-1.5 py-0.5 rounded">Popular</span>}
      </div>
      <div className={`text-xs ${featured ? "text-slate-300" : "text-slate-500"} mb-3`}>{tagline}</div>
      <div className={`text-3xl font-black ${featured ? "text-white" : "text-slate-900"} mb-1`}>{price}{price !== "Contact" && <span className="text-sm font-bold text-slate-400">/mo</span>}</div>
      <ul className={`mt-3 space-y-1.5 text-xs ${featured ? "text-slate-300" : "text-slate-600"}`}>
        {features.map((f) => (
          <li key={f} className="flex items-start gap-1.5"><CheckCircle2 className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${featured ? "text-emerald-400" : "text-emerald-600"}`} /><span>{f}</span></li>
        ))}
      </ul>
      <button
        disabled
        className="mt-4 w-full py-2 rounded-lg text-xs font-black bg-slate-200 text-slate-400 cursor-not-allowed"
        title="Stripe checkout wires up in Phase 2"
      >
        Coming Soon
      </button>
    </div>
  );
}
