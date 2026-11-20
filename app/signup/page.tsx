"use client";

import React, { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Layout, ArrowRight, Loader2, Building2, User, Mail, Lock, AlertCircle, Users } from 'lucide-react';
import { PageHero, PageBody, Card } from '@/components/ui/PageHero';
import { bandSeg, bandSegItem } from '@/components/admin/band';
import { btnPrimary, link, label } from '@/components/admin/kit';

const inputCls = "w-full h-11 pl-10 pr-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-md text-[15px] text-[var(--color-text)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 transition-colors placeholder:text-[var(--color-text-faint)]";
const iconCls = "absolute left-3 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[var(--color-text-faint)] pointer-events-none";

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
    ? "A new organization for your site's drawings and work. You'll be its Admin."
    : "Your organization's admin creates your account.";

  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] px-4 pt-6 pb-10">
      <div className="w-full max-w-[640px] mx-auto">
        {/* The band: who we are, what this page is for, and the two ways in. */}
        <PageHero
          kicker={<span className="inline-flex items-center gap-2"><span className="w-6 h-6 rounded grid place-items-center bg-[var(--color-text)] text-[var(--color-surface)]"><Layout className="w-3.5 h-3.5" /></span> <span className="font-display text-[16px] font-semibold text-[var(--color-text)]">Manufacturing OS</span></span>}
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
        <Card className="sm:p-6">

          {/* NEW ORG MODE */}
          {mode === "new-org" && (
            <>
                {error && (
                  <div role="alert" className="mb-4 flex items-start gap-2 text-[var(--state-overdue)]">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <p className="text-[14px] font-semibold">{error}</p>
                  </div>
                )}
                <form onSubmit={handleSignup} className="space-y-4">
                  <div>
                    <label htmlFor="su-company" className={label}>Company or organization</label>
                    <div className="relative">
                      <Building2 className={iconCls} />
                      <input id="su-company" type="text" value={formData.companyName} onChange={(e) => setFormData({...formData, companyName: e.target.value})}
                        className={inputCls}
                        placeholder="Acme Manufacturing Inc." required />
                    </div>
                  </div>

                  <div className="h-px bg-[var(--color-border)]" />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="su-name" className={label}>Your full name</label>
                    <div className="relative">
                      <User className={iconCls} />
                      <input id="su-name" type="text" value={formData.displayName} onChange={(e) => setFormData({...formData, displayName: e.target.value})}
                        className={inputCls}
                        placeholder="John Doe" autoComplete="name" required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="su-email" className={label}>Work email</label>
                    <div className="relative">
                      <Mail className={iconCls} />
                      <input id="su-email" type="email" value={formData.email} onChange={(e) => setFormData({...formData, email: e.target.value})}
                        className={inputCls}
                        placeholder="name@company.com" autoComplete="email" required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="su-password" className={label}>Password</label>
                    <div className="relative">
                      <Lock className={iconCls} />
                      <input id="su-password" type="password" value={formData.password} onChange={(e) => setFormData({...formData, password: e.target.value})}
                        className={inputCls}
                        placeholder="At least 6 characters" autoComplete="new-password" minLength={6} required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="su-confirm" className={label}>Confirm password</label>
                    <div className="relative">
                      <Lock className={iconCls} />
                      <input id="su-confirm" type="password" value={formData.confirmPassword} onChange={(e) => setFormData({...formData, confirmPassword: e.target.value})}
                        className={inputCls}
                        placeholder="Repeat your password" autoComplete="new-password" minLength={6} required />
                    </div>
                  </div>
                  </div>

                  <button type="submit" disabled={loading}
                    className={`${btnPrimary} w-full sm:w-auto h-11 px-5 mt-1`}>
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
                  <div className="py-2">
                    <p className="inline-flex items-center gap-2 text-[15px] font-semibold text-[var(--color-text)]">
                      <span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-released)]" /> Your request is with your admin.
                    </p>
                    <p className="mt-1 text-[15px] text-[var(--color-text-muted)]">You&rsquo;ll get an email with sign-in steps once they add you.</p>
                  </div>
                ) : (
                  <>
                    {error && (
                      <div role="alert" className="mb-4 flex items-start gap-2 text-[var(--state-overdue)]">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <p className="text-[14px] font-semibold">{error}</p>
                      </div>
                    )}
                    <form onSubmit={handleRequestAccess} className="space-y-4">
                  <div>
                    <label htmlFor="ra-name" className={label}>Your full name</label>
                    <div className="relative">
                      <User className={iconCls} />
                      <input id="ra-name" type="text" value={requestData.displayName} onChange={(e) => setRequestData({...requestData, displayName: e.target.value})}
                        className={inputCls}
                        placeholder="John Doe" autoComplete="name" required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="ra-email" className={label}>Your work email</label>
                    <div className="relative">
                      <Mail className={iconCls} />
                      <input id="ra-email" type="email" value={requestData.email} onChange={(e) => setRequestData({...requestData, email: e.target.value})}
                        className={inputCls}
                        placeholder="name@company.com" autoComplete="email" required />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="ra-org" className={label}>Organization name</label>
                    <div className="relative">
                      <Building2 className={iconCls} />
                      <input id="ra-org" type="text" value={requestData.orgName} onChange={(e) => setRequestData({...requestData, orgName: e.target.value})}
                        className={inputCls}
                        placeholder="Acme Manufacturing Inc." required />
                    </div>
                  </div>
                      <button type="submit" disabled={loading}
                        className={`${btnPrimary} w-full sm:w-auto h-11 px-5 mt-1`}>
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

        <p className="text-[14px] text-[var(--color-text-muted)]">
          Already have an account?{' '}
          <Link href="/" className={link}>Sign in</Link>
        </p>
        </PageBody>
      </div>
    </div>
  );
}
