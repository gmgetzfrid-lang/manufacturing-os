"use client";

import React, { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Layout, ArrowRight, Loader2, Building2, User, Mail, Lock, AlertCircle, Users } from 'lucide-react';
import { PageHero, PageBody, Card } from '@/components/ui/PageHero';
import { bandSeg, bandSegItem } from '@/components/admin/band';

type Mode = "new-org" | "request-access";

export default function SignupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("new-org");

  const [formData, setFormData] = useState({
    displayName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companyName: '',
  });

  const [requestData, setRequestData] = useState({
    displayName: '',
    email: '',
    orgName: '',
    message: '',
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestSent, setRequestSent] = useState(false);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (formData.password.length < 6) {
      setError("Password must be at least 6 characters.");
      setLoading(false);
      return;
    }
    if (formData.password !== formData.confirmPassword) {
      setError("Passwords do not match.");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          displayName: formData.displayName,
          companyName: formData.companyName,
        }),
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Registration failed.");

      // Sign in immediately after account creation
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: formData.email,
        password: formData.password,
      });

      if (signInError) throw new Error("Account created. Please sign in.");

      if (typeof window !== 'undefined') {
        localStorage.setItem('manufacturingos.activeOrgId', result.orgId);
      }

      // Land new users on the inbox — the guided cockpit (daily brief,
      // setup checklist, My Desk) — not the bare dual-viewer power tool.
      router.push('/inbox');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleRequestAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `The request didn't go through (${res.status}).`);
      }
      setRequestSent(true);
    } catch (err) {
      setError(err instanceof Error && err.message ? `${err.message} Try again.` : "The request didn't go through. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const title = mode === "new-org" ? "Set up your workspace." : requestSent ? "Request sent." : "Ask for access.";
  const sub = mode === "new-org"
    ? "A new organization for your site's drawings, equipment and work. You'll be its Admin."
    : requestSent ? "Your organization's admin creates your account. You'll get an email with sign-in steps."
    : "Your organization's admin creates your account.";

  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] px-4 py-6 sm:py-10">
      <div className="w-full max-w-xl mx-auto">
        {/* The band: who we are, what this page is for, and the two ways in. */}
        <PageHero
          kicker={<span className="inline-flex items-center gap-2"><Layout className="w-3.5 h-3.5" /> Manufacturing OS</span>}
          title={title}
          sub={sub}
          size="md"
        >
          <div className={`${bandSeg} w-full`} role="group" aria-label="How to join">
            <button
              type="button"
              onClick={() => { setMode("new-org"); setError(null); }}
              aria-pressed={mode === "new-org"}
              className={`${bandSegItem(mode === "new-org")} flex-1 justify-center h-10`}
            >
              <Building2 className="w-4 h-4" />
              New organization
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("request-access"); setError(null);
                // Carry over what was already typed.
                setRequestData((r) => ({ ...r, displayName: r.displayName || formData.displayName, email: r.email || formData.email, orgName: r.orgName || formData.companyName }));
              }}
              aria-pressed={mode === "request-access"}
              className={`${bandSegItem(mode === "request-access")} flex-1 justify-center h-10`}
            >
              <Users className="w-4 h-4" />
              Join existing
            </button>
          </div>
        </PageHero>

        <PageBody>
        <Card className="sm:p-7">

          {/* NEW ORG MODE */}
          {mode === "new-org" && (
            <>
                {error && (
                  <div role="alert" className="mb-5 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    <p className="text-[14px] text-red-700 dark:text-red-400 font-medium">{error}</p>
                  </div>
                )}
                <form onSubmit={handleSignup} className="space-y-4">
                  <div>
                    <label htmlFor="su-company" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Company or organization</label>
                    <div className="relative">
                      <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                      <input id="su-company" type="text" value={formData.companyName} onChange={(e) => setFormData({...formData, companyName: e.target.value})}
                        className="w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]"
                        placeholder="Acme Manufacturing Inc." required />
                    </div>
                  </div>

                  <div className="h-px bg-[var(--color-border)]" />

                  <div>
                    <label htmlFor="su-name" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Your full name</label>
                    <div className="relative">
                      <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                      <input id="su-name" type="text" value={formData.displayName} onChange={(e) => setFormData({...formData, displayName: e.target.value})}
                        className="w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]"
                        placeholder="John Doe" autoComplete="name" required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="su-email" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Work email</label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                      <input id="su-email" type="email" value={formData.email} onChange={(e) => setFormData({...formData, email: e.target.value})}
                        className="w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]"
                        placeholder="name@company.com" autoComplete="email" required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="su-password" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                      <input id="su-password" type="password" value={formData.password} onChange={(e) => setFormData({...formData, password: e.target.value})}
                        className="w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]"
                        placeholder="At least 6 characters" autoComplete="new-password" minLength={6} required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="su-confirm" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Confirm password</label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                      <input id="su-confirm" type="password" value={formData.confirmPassword} onChange={(e) => setFormData({...formData, confirmPassword: e.target.value})}
                        className="w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]"
                        placeholder="Repeat your password" autoComplete="new-password" minLength={6} required />
                    </div>
                  </div>

                  <button type="submit" disabled={loading}
                    className="w-full h-12 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[15px] font-extrabold rounded-xl shadow-[0_12px_24px_-12px_var(--color-accent)] transition-colors flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed mt-2">
                    {loading ? (
                      <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Creating workspace…</>
                    ) : (
                      <span className="flex items-center">Create organization <ArrowRight className="w-5 h-5 ml-2" /></span>
                    )}
                  </button>
                </form>
            </>
          )}

          {/* REQUEST ACCESS MODE */}
          {mode === "request-access" && (
            <>
                {requestSent ? (
                  <div className="text-center py-6">
                    <div className="w-14 h-14 bg-emerald-50 dark:bg-emerald-950/40 rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg className="w-7 h-7 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <h3 className="text-[15px] font-bold text-[var(--color-text)] mb-1">Your request is with your admin</h3>
                    <p className="text-[14px] text-[var(--color-text-muted)]">Your organization&rsquo;s admin will receive your request and create your account. You&rsquo;ll get an email with login instructions.</p>
                  </div>
                ) : (
                  <>
                    {error && (
                      <div role="alert" className="mb-5 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                        <p className="text-[14px] text-red-700 dark:text-red-400 font-medium">{error}</p>
                      </div>
                    )}
                    <p className="mb-5 text-[14px] text-[var(--color-text-muted)]">This tells your organization&rsquo;s Admin, who creates your account.</p>
                    <form onSubmit={handleRequestAccess} className="space-y-4">
                  <div>
                    <label htmlFor="ra-name" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Your full name</label>
                    <div className="relative">
                      <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                      <input id="ra-name" type="text" value={requestData.displayName} onChange={(e) => setRequestData({...requestData, displayName: e.target.value})}
                        className="w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]"
                        placeholder="John Doe" autoComplete="name" required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="ra-email" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Your work email</label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                      <input id="ra-email" type="email" value={requestData.email} onChange={(e) => setRequestData({...requestData, email: e.target.value})}
                        className="w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]"
                        placeholder="name@company.com" autoComplete="email" required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="ra-org" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Organization name</label>
                    <div className="relative">
                      <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                      <input id="ra-org" type="text" value={requestData.orgName} onChange={(e) => setRequestData({...requestData, orgName: e.target.value})}
                        className="w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]"
                        placeholder="Acme Manufacturing Inc." required />
                    </div>
                  </div>
                      <button type="submit" disabled={loading}
                        className="w-full h-12 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[15px] font-extrabold rounded-xl shadow-[0_12px_24px_-12px_var(--color-accent)] transition-colors flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed">
                        {loading ? (
                          <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Sending request…</>
                        ) : (
                          <span className="flex items-center">Send access request <ArrowRight className="w-5 h-5 ml-2" /></span>
                        )}
                      </button>
                    </form>
                  </>
                )}
            </>
          )}
        </Card>

        <p className="text-center text-[14px] text-[var(--color-text-muted)]">
          Already have an account?{' '}
          <Link href="/" className="text-[var(--color-text)] font-bold underline underline-offset-2">Sign in</Link>
        </p>
        </PageBody>
      </div>
    </div>
  );
}
