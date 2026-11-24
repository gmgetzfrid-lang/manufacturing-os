"use client";

// /signup - start a new workspace. The only way one starts: the company
// pays first (lib/workspaceSignupServer). Nothing is made here; the
// payment page opens, and the workspace and its first admin's account are
// made once the payment goes through. Everyone else is added by that admin.

import React, { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, AlertCircle } from "lucide-react";
import { AuthCard, authField, authBtn } from "@/components/marketing/AuthCard";
import { Button } from "@/components/ui/Button";
import { link, label } from "@/components/admin/kit";
import { friendlyError } from "@/lib/friendlyError";

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
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  // The main button wakes once the form has what it needs.
  const ready = !!company.trim() && !!name.trim() && /\S+@\S+\.\S+/.test(email);

  return (
    <AuthCard sheet="New workspace"
      wide
      title="Start a workspace."
      sub="For a company new here. Pay first, then add your people."
      footer={<>
        <p className="text-[14px] text-[var(--color-text-muted)]">Your company already uses it? Your workspace admin adds your account. <Link href="/" className={link}>Sign in</Link></p>
      </>}
    >
      {(error || canceled) && (
        <div role="alert" className="mb-5 flex items-start gap-2 text-[var(--state-overdue-text)]">
          <AlertCircle aria-hidden className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-[14px] font-semibold">{error ?? "The payment was canceled. Nothing was made."}</p>
        </div>
      )}
      <form onSubmit={submit}>
        <div>
          <label htmlFor="su-company" className={label}>Company</label>
          <input id="su-company" type="text" value={company} onChange={(e) => setCompany(e.target.value)} className={authField} placeholder="Kern Energy" autoComplete="organization" enterKeyHint="next" required />
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="su-name" className={label}>Your name</label>
            <input id="su-name" type="text" value={name} onChange={(e) => setName(e.target.value)} className={authField} placeholder="Jordan Ortiz" autoComplete="name" enterKeyHint="next" required />
          </div>
          <div>
            <label htmlFor="su-email" className={label}>Work email</label>
            <input id="su-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} className={authField} placeholder="name@company.com" autoComplete="email" enterKeyHint="next" required />
          </div>
        </div>
        <fieldset className="mt-6">
          <legend className={label}>Plan</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {PLANS.map((p) => {
              const on = plan === p.key;
              return (
                // The picked plan: a 2 px edge in the current color, no fill.
                <label key={p.key} className={`relative block rounded-lg border bg-[var(--color-surface)] p-3.5 cursor-pointer transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--color-focus)] ${on
                  ? "border-[var(--color-current)] shadow-[inset_0_0_0_1px_var(--color-current)]"
                  : "border-[var(--color-border-strong)] hover:border-[var(--color-border-control)]"}`}>
                  <input type="radio" name="plan" value={p.key} checked={on} onChange={() => setPlan(p.key)} className="sr-only" />
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden className={`w-4 h-4 shrink-0 rounded-full border-2 grid place-items-center ${on ? "border-[var(--color-current)]" : "border-[var(--color-border-control)]"}`}>
                      {on && <span className="w-2 h-2 rounded-full bg-[var(--color-current)]" />}
                    </span>
                    <span className="flex-1 text-[15px] font-semibold text-[var(--color-text)]">{p.name}</span>
                    <span className="text-[15px] font-semibold tabular-nums text-[var(--color-text)]">{p.price} <span className="text-[13px] font-normal text-[var(--color-text-muted)]">{p.per}</span></span>
                  </span>
                  <span className="block mt-1 pl-[26px] text-[13px] text-[var(--color-text-muted)]">{p.what}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <p className="mt-5 text-[14px] text-[var(--color-text-muted)]">You become the workspace&apos;s admin. After paying you set your password, then add your people. Nobody can make their own account.</p>
        <Button type="submit" variant={ready ? "primary" : "secondary"} loading={busy} className={`mt-6 ${authBtn} sm:!w-auto sm:px-6`}>
          {busy ? "Opening payment" : <>Continue to payment <ArrowRight aria-hidden className="w-5 h-5" /></>}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function SignupPage() {
  return <React.Suspense fallback={null}><SignupForm /></React.Suspense>;
}
