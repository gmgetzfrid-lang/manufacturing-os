"use client";

// /signup - start a new workspace. The only way one starts: the company
// pays first (lib/workspaceSignupServer). Nothing is made here; the
// payment page opens, and the workspace and its first admin's account are
// made once the payment goes through. Everyone else is added by that admin.

import React, { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, Building2, User, Mail, AlertCircle } from "lucide-react";
import { AuthCard } from "@/components/marketing/AuthCard";
import { btnPrimary, link, label } from "@/components/admin/kit";

const inputCls = "w-full h-11 pl-10 pr-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-md text-[15px] text-[var(--color-text)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 transition-colors placeholder:text-[var(--color-text-faint)]";
const iconCls = "absolute left-3 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[var(--color-text-faint)] pointer-events-none";

const PLANS = [
  { key: "starter", name: "Starter", price: "$299", per: "a month", what: "Up to 10 users, email support" },
  { key: "growth", name: "Growth", price: "$599", per: "a month", what: "Up to 25 users, scheduled backups, priority support" },
] as const;

function SignupForm() {
  const canceled = useSearchParams().get("canceled") === "1";
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<"starter" | "growth">("growth");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/signup/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, name, email, plan }),
      });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) throw new Error(body?.error ?? "The payment page couldn't be opened. Try again.");
      window.location.assign(body.url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthCard
      wide
      title="Start a workspace."
      sub="For a company new here. Pay first; then you add your people."
      footer={<>
        <p className="text-[14px] text-[var(--color-text-muted)]">Your company already uses it? Your workspace admin adds your account. <Link href="/" className={link}>Sign in</Link></p>
      </>}
    >
      {(error || canceled) && (
        <div role="alert" className="mb-4 flex items-start gap-2 text-[var(--state-overdue)]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-[14px] font-semibold">{error ?? "The payment was canceled. Nothing was made."}</p>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="su-company" className={label}>Company</label>
          <div className="relative">
            <Building2 className={iconCls} />
            <input id="su-company" type="text" value={company} onChange={(e) => setCompany(e.target.value)} className={inputCls} placeholder="Kern Energy" autoComplete="organization" required />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="su-name" className={label}>Your name</label>
            <div className="relative">
              <User className={iconCls} />
              <input id="su-name" type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="First and last name" autoComplete="name" required />
            </div>
          </div>
          <div>
            <label htmlFor="su-email" className={label}>Work email</label>
            <div className="relative">
              <Mail className={iconCls} />
              <input id="su-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="name@company.com" autoComplete="email" required />
            </div>
          </div>
        </div>
        <fieldset>
          <legend className={label}>Plan</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="radiogroup">
            {PLANS.map((p) => (
              <label key={p.key} className={`rounded-lg border p-3 cursor-pointer ${plan === p.key ? "border-[var(--color-main)] ring-2 ring-[var(--color-main)]/30" : "border-[var(--color-border-strong)]"}`}>
                <input type="radio" name="plan" value={p.key} checked={plan === p.key} onChange={() => setPlan(p.key)} className="sr-only" />
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[15px] font-semibold text-[var(--color-text)]">{p.name}</span>
                  <span className="text-[15px] font-semibold tabular-nums text-[var(--color-text)]">{p.price} <span className="text-[13px] font-normal text-[var(--color-text-muted)]">{p.per}</span></span>
                </span>
                <span className="block mt-1 text-[13px] text-[var(--color-text-muted)]">{p.what}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-[13px] text-[var(--color-text-muted)]">You become the workspace&apos;s admin. After paying you set your password, then add your people. Nobody can make their own account.</p>
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full sm:w-auto h-11 px-5`}>
          {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> Opening payment…</> : <>Continue to payment <ArrowRight className="w-5 h-5" /></>}
        </button>
      </form>
    </AuthCard>
  );
}

export default function SignupPage() {
  return <React.Suspense fallback={null}><SignupForm /></React.Suspense>;
}
