"use client";

import React, { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, setRememberSession, setPreferMicrosoft, prefersMicrosoft } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PageHero, PageBody, Card } from '@/components/ui/PageHero';
import { Layout, Lock, Mail, Loader2, AlertCircle, Building2, LogOut } from 'lucide-react';
import { SlowNotice, useElapsed, startOver } from '@/components/system/SlowNotice';

/** Microsoft's four-square logo (lucide has no brand marks). */
function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={className} aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

type View = "checking" | "login" | "no-workspace";

// Per-tab guard so a failed silent sign-in attempt can't loop.
const SILENT_TRIED_KEY = "manufacturingos.silentSSOAttempted";
// Microsoft "you need to actually interact" responses — expected when a silent
// (prompt=none) attempt can't complete without UI. We swallow these and just
// show the normal login screen instead of an error.
const SILENT_FALLBACK_ERRORS = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
]);

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("checking");
  const [authedEmail, setAuthedEmail] = useState<string | null>(null);
  const slowSecs = useElapsed(view === "checking" || loading);

  // Decide where an authenticated user belongs: into the app if they hold an
  // active membership, otherwise the "no workspace" screen. Also ensures a
  // profile row exists so an admin can later attach them to an org by email.
  const routeAuthedUser = useCallback(async (user: User) => {
    const uid = user.id;
    const userEmail = user.email ?? null;

    // If they signed in via Microsoft, remember it on this device so we can try
    // a silent sign-in next time. Email/password users are never flagged, so
    // they never get auto-redirected to Microsoft.
    const meta = user.app_metadata ?? {};
    const providers = (meta.providers as string[] | undefined) ?? [];
    if (meta.provider === "azure" || providers.includes("azure")) {
      setPreferMicrosoft(true);
    }

    try {
      await supabase.from("users").upsert({
        id: uid,
        email: userEmail ?? null,
        updated_at: new Date().toISOString(),
      });
    } catch {
      /* non-fatal */
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select("org_id")
      .eq("uid", uid)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (membership?.org_id) {
      router.replace("/dashboard");
    } else {
      setAuthedEmail(userEmail);
      setView("no-workspace");
    }
  }, [router]);

  // Kick off the Microsoft OAuth redirect. `silent` adds prompt=none so an
  // already-signed-in M365 user is returned without any UI; on failure the
  // caller falls back to the normal login screen.
  const startMicrosoft = useCallback(async (opts: { silent: boolean; remember: boolean }) => {
    setRememberSession(opts.remember);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: {
        scopes: "openid email profile",
        redirectTo: `${window.location.origin}/`,
        ...(opts.silent ? { queryParams: { prompt: "none" } } : {}),
      },
    });
    // On success the browser navigates away; we only reach here if the flow
    // couldn't even start.
    if (oauthError) {
      if (opts.silent) {
        setView("login");
      } else {
        setError("Couldn't start Microsoft sign-in. Please try again.");
        setOauthLoading(false);
      }
    }
  }, []);

  // On load: forward an already-signed-in user straight through ("opens right
  // up"); finish the Microsoft redirect when we land back with an OAuth
  // response; and, for devices that have used Microsoft before, try a one-shot
  // silent sign-in so the app "just opens" without a click.
  useEffect(() => {
    let active = true;

    const params = typeof window !== "undefined" ? window.location.search : "";
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const sp = new URLSearchParams(params);
    const errorCode = sp.get("error");
    const errorDesc = sp.get("error_description") || sp.get("error");
    const hasOAuthResponse = params.includes("code=") || hash.includes("access_token");

    const cleanUrl = () => {
      try { window.history.replaceState({}, "", "/"); } catch { /* ignore */ }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      if (session?.user) {
        routeAuthedUser(session.user);
        return;
      }
      if (errorCode) {
        // A silent attempt that needs interaction is expected — fall back
        // quietly. Anything else (e.g. consent denied) is worth showing.
        if (!SILENT_FALLBACK_ERRORS.has(errorCode) && errorDesc) {
          setError(decodeURIComponent(errorDesc));
        }
        cleanUrl();
        setView("login");
        return;
      }
      if (hasOAuthResponse) {
        // Mid-exchange — stay on the spinner; SIGNED_IN below resolves it.
        return;
      }
      // No session and nothing in flight. Attempt a silent Microsoft sign-in
      // once per tab for devices that have used Microsoft before; otherwise
      // show the login form.
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(SILENT_TRIED_KEY) === "1"; } catch { /* ignore */ }
      if (prefersMicrosoft() && !alreadyTried) {
        try { sessionStorage.setItem(SILENT_TRIED_KEY, "1"); } catch { /* ignore */ }
        startMicrosoft({ silent: true, remember: true }); // keeps the spinner; navigates away
        return;
      }
      setView("login");
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "SIGNED_IN" && session?.user) {
        try { sessionStorage.removeItem(SILENT_TRIED_KEY); } catch { /* ignore */ }
        const user = session.user;
        // Defer routing OUT of this callback. supabase-js holds an internal auth
        // lock while it dispatches auth-state-change events — and an in-page
        // signInWithPassword() awaits that dispatch while still holding the lock.
        // routeAuthedUser() makes further Supabase calls that need the same lock,
        // so doing it synchronously here deadlocks: the sign-in promise never
        // resolves and the button spins forever. (Microsoft sign-in finishes on a
        // fresh page load, so its lock is already free — which is why only
        // email/password stalled.) A 0ms defer lets the lock release first.
        setTimeout(() => { if (active) void routeAuthedUser(user); }, 0);
      }
    });

    // Safety net: never strand the user on the spinner if an OAuth exchange
    // silently fails to produce a session.
    const fallback = window.setTimeout(() => {
      if (active) {
        setView((v) => (v === "checking" ? "login" : v));
      }
    }, 10000);

    return () => {
      active = false;
      subscription.unsubscribe();
      window.clearTimeout(fallback);
    };
  }, [routeAuthedUser, startMicrosoft]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setRememberSession(keepSignedIn);

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      let msg = "Failed to sign in. Please try again.";
      if (authError.message.includes("Invalid login credentials")) msg = "Invalid email or password.";
      else if (authError.message.includes("Email not confirmed")) msg = "Please confirm your email before signing in.";
      else if (authError.message.includes("Too many requests")) msg = "Too many failed attempts. Try again later.";
      setError(msg);
      setLoading(false);
    } else {
      router.push('/dashboard');
    }
  };

  const handleMicrosoft = () => {
    setError(null);
    setOauthLoading(true);
    startMicrosoft({ silent: false, remember: keepSignedIn });
  };

  const handleSignOut = async () => {
    // Explicit sign-out: disable silent auto sign-in so we don't immediately
    // log them back in.
    setPreferMicrosoft(false);
    await supabase.auth.signOut();
    setAuthedEmail(null);
    setError(null);
    setView("login");
  };

  // The front door wears the app's identity: the blue band holds the
  // answer, a white card overlaps it, and the one orange button signs in.
  const input = "w-full h-12 pl-11 pr-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-[15px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-transparent outline-none transition-all placeholder:text-[var(--color-text-faint)]";
  const fieldLabel = "block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5";
  const primaryBtn = "w-full h-12 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[15px] font-extrabold rounded-xl shadow-[0_12px_24px_-12px_var(--color-accent)] transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed";
  const quietBtn = "w-full h-12 bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-[15px] font-bold rounded-xl border border-[var(--color-border-strong)] transition-colors flex items-center justify-center gap-3 disabled:opacity-70 disabled:cursor-not-allowed";
  const kicker = <span className="inline-flex items-center gap-2"><Layout className="w-3.5 h-3.5" /> Manufacturing OS</span>;

  // ─── Checking / OAuth redirect in progress ──────────────────────
  if (view === "checking") {
    return (
      <div className="min-h-dvh bg-[var(--color-canvas)] flex flex-col items-center justify-center p-4">
        <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] animate-spin mb-4" />
        <p role="status" className="text-[14px] font-medium text-[var(--color-text-muted)]">Signing you in…</p>
        <div className="w-full max-w-sm"><SlowNotice secs={slowSecs} onStartOver={() => startOver()} /></div>
      </div>
    );
  }

  // ─── Authenticated, but not attached to any workspace ───────────
  if (view === "no-workspace") {
    return (
      <div className="min-h-dvh bg-[var(--color-canvas)] px-4 py-6 sm:py-10">
        <div className="w-full max-w-md mx-auto">
          <PageHero kicker={kicker} title="No workspace yet." sub={authedEmail ?? undefined} size="md" />
          <PageBody>
            <Card className="sm:p-7">
              <div className="flex items-start gap-3">
                <Building2 className="w-5 h-5 shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
                <p className="text-[14px] text-[var(--color-text-muted)] leading-relaxed">
                  Your Microsoft account isn&rsquo;t linked to a workspace yet. Ask your
                  organization&rsquo;s admin to add you with this email address. Once they do,
                  sign in with Microsoft again and you&rsquo;ll go straight in.
                </p>
              </div>
              <div className="mt-6 space-y-2">
                <a href="/signup" className={primaryBtn}>Ask for access or create a workspace</a>
                <button onClick={handleSignOut} className="w-full h-11 text-[14px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] rounded-xl transition-colors flex items-center justify-center gap-2">
                  <LogOut className="w-4 h-4" /> Sign out
                </button>
              </div>
            </Card>
          </PageBody>
        </div>
      </div>
    );
  }

  // ─── Login ──────────────────────────────────────────────────────
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] px-4 py-6 sm:py-10">
      <div className="w-full max-w-md mx-auto">
        <PageHero kicker={kicker} title="Sign in." sub="Your site's drawings, equipment and work, in one place." size="md" />
        <PageBody>
          <Card className="sm:p-7">
            {/* A problem sits where it happened: right above the form it's about. */}
            {error && (
              <div role="alert" className="mb-5 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <p className="text-[14px] text-red-700 dark:text-red-400 font-medium">{error}</p>
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="si-email" className={fieldLabel}>Email</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                  <input
                    id="si-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={input}
                    placeholder="name@company.com"
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="si-password" className={fieldLabel}>Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)] pointer-events-none" />
                  <input
                    id="si-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={input}
                    placeholder="Your password"
                    required
                  />
                </div>
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={keepSignedIn}
                  onChange={(e) => setKeepSignedIn(e.target.checked)}
                  className="w-4 h-4 rounded cursor-pointer accent-[var(--color-text)]"
                />
                <span className="text-[14px] text-[var(--color-text-muted)]">Keep me signed in on this device</span>
              </label>

              <button type="submit" disabled={loading || oauthLoading} className={primaryBtn}>
                {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Signing in…</> : "Sign in"}
              </button>
              {loading && <SlowNotice secs={slowSecs} onStartOver={() => startOver()} />}
            </form>

            <div className="flex items-center gap-3 my-5">
              <div className="h-px bg-[var(--color-border)] flex-1" />
              <span className="text-[13px] font-semibold text-[var(--color-text-faint)] ">or</span>
              <div className="h-px bg-[var(--color-border)] flex-1" />
            </div>

            {/* Microsoft / Azure single sign-on */}
            <button type="button" onClick={handleMicrosoft} disabled={oauthLoading || loading} className={quietBtn}>
              {oauthLoading ? (
                <><Loader2 className="w-5 h-5 animate-spin" /> Opening Microsoft…</>
              ) : (
                <><MicrosoftLogo className="w-5 h-5" /> Sign in with Microsoft</>
              )}
            </button>
          </Card>

          <div className="pt-2 pb-6 text-center space-y-2">
            <p className="text-[14px] text-[var(--color-text-muted)]">
              No workspace yet?{" "}
              <Link href="/signup" className="text-[var(--color-text)] font-bold underline underline-offset-2">Create one</Link>
            </p>
            <p className="text-[14px]">
              <Link href="/about" className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline underline-offset-2">About Manufacturing OS</Link>
            </p>
            <p className="text-[11px] text-[var(--color-text-faint)]">v2.1.0 · Authorized use only</p>
          </div>
        </PageBody>
      </div>
    </div>
  );
}
