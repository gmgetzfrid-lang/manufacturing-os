"use client";

// Sign in. Two doors, one loud at a time: "Sign in with Microsoft" (company
// accounts, most people at a site) is the filled button while the form is
// empty; once an email and password are typed, the password "Sign in"
// becomes the filled one and Microsoft steps back. Labels sit above the
// fields; every press answers at once (a spinner in the button, then a
// check). Who may sign in and why one is refused are decided by the
// workspace's sign-in rules (lib/signinCheck), unchanged here.

import { AuthCard, authField, authBtn } from "@/components/marketing/AuthCard";
import { rememberWorkspaceName } from "@/lib/deviceWorkspace";
import { prefersReducedMotion } from "@/lib/viewTransition";
import { checkSignin, type SigninVerdict } from "@/lib/signinCheck";
import { fetchMemberships, pickMembership, SignedOut } from "@/lib/membershipClient";
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, setRememberSession, setPreferMicrosoft, prefersMicrosoft, rememberDefault } from '@/lib/supabase';
import { PasswordInput } from '@/components/ui/Field';

const noStore = () => () => {};
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { label as fieldLabel, link } from '@/components/admin/kit';
import { Button } from '@/components/ui/Button';
import { AlertCircle, LogOut } from 'lucide-react';
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
/** Why a sign-in can't go on, in the person's words (null: it can). */
function refusal(v: SigninVerdict): string | null {
  if (v.action === "not_added") return "This email isn't in a workspace here. Accounts are made by your workspace admin: ask them to add you with this email.";
  if (v.action === "use_microsoft") return "Your company account signs in with Microsoft. Use Sign in with Microsoft above.";
  if (v.action === "expired") return "Your one-time password expired at the end of the day it was issued, so the account is suspended. Ask your admin to reset it.";
  return null;
}
const NOT_ADDED = "not_added";

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
  // Starts as this device's last choice (first time: on for a phone, off
  // for a computer, which may be shared); the box changes it.
  const deviceKeep = useSyncExternalStore(noStore, rememberDefault, () => true);
  const [keepChoice, setKeepChoice] = useState<boolean | null>(null);
  const [forgot, setForgot] = useState(false);
  const keepSignedIn = keepChoice ?? deviceKeep;
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("checking");
  const [authedEmail, setAuthedEmail] = useState<string | null>(null);
  // The password button's answer once the workspace opens: a check.
  const [opened, setOpened] = useState(false);
  // The title block's SIGNED line, then the hand-off into the app.
  const [signed, setSigned] = useState<{ name: string; at: Date } | null>(null);
  const [leaving, setLeaving] = useState(false);
  // A password sign-in in progress decides its own next step (handleLogin).
  const loginInFlight = useRef(false);
  const slowSecs = useElapsed(view === "checking" || loading);

  // Decide where a signed-in account belongs. The workspace's sign-in rules
  // first (an account nobody added is signed out here, and deleted on the
  // server), then the server's answer on its workspaces. No profile is ever
  // made here: accounts and profiles are made only by an admin adding
  // someone, or by a paid new workspace.
  const routeAuthedUser = useCallback(async (user: User) => {
    if (loginInFlight.current) return;
    // If they signed in via Microsoft, remember it on this device so we can try
    // a silent sign-in next time. Email/password users are never flagged, so
    // they never get auto-redirected to Microsoft.
    const meta = user.app_metadata ?? {};
    const providers = (meta.providers as string[] | undefined) ?? [];
    if (meta.provider === "azure" || providers.includes("azure")) {
      setPreferMicrosoft(true);
    }

    const { data: { session } } = await supabase.auth.getSession();
    const verdict = await checkSignin(session?.access_token ?? null);
    const why = refusal(verdict);
    if (why) {
      if (verdict.action === NOT_ADDED) setPreferMicrosoft(false);
      await supabase.auth.signOut();
      setError(why);
      setView("login");
      return;
    }
    if (verdict.action === "set_password") { router.replace("/set-password"); return; }
    // Already signed in (or back from Microsoft): a short signing, not the
    // full one a typed sign-in gets.
    await openWorkspace(user, "quick");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  /** Into the app when the server says the account is active in a
   *  workspace; else the paused-access screen. On the way in, the title
   *  block is signed with the person's name and the time, then the sheet
   *  settles away into the app. */
  const openWorkspace = async (user: User | null, ceremony: "full" | "quick") => {
    const userEmail = user?.email ?? null;
    try {
      router.prefetch("/dashboard");
      const answer = await fetchMemberships();
      const pick = pickMembership(answer, null);
      if (pick) {
        rememberWorkspaceName(pick.orgName);
        const meta = (user?.user_metadata ?? {}) as { full_name?: unknown; name?: unknown };
        const name = typeof meta.full_name === "string" && meta.full_name.trim() ? meta.full_name.trim()
          : typeof meta.name === "string" && meta.name.trim() ? meta.name.trim()
          : userEmail ?? "Signed in";
        setLoading(false); setOpened(true);
        setSigned({ name, at: new Date() });
        // A phone has scrolled to the fields: back up to where the title
        // block shows the signature.
        try { if (window.matchMedia("(max-width: 767px)").matches) window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* old browser */ }
        const calm = prefersReducedMotion();
        await new Promise((r) => setTimeout(r, calm ? 0 : ceremony === "full" ? 750 : 420));
        setLeaving(true);
        await new Promise((r) => setTimeout(r, calm ? 0 : 360));
        router.replace("/dashboard");
        return;
      }
      setAuthedEmail(userEmail);
      setView("no-workspace");
    } catch (e) {
      if (!(e instanceof SignedOut)) setError("Couldn't reach the server to open your workspace. Check your connection and try again.");
      setView("login");
      setLoading(false);
    }
  };

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
    if (sp.get("signin") === NOT_ADDED) {
      // Don't try Microsoft again on its own: it's the account that was refused.
      setPreferMicrosoft(false);
      setError(refusal({ action: NOT_ADDED }));
    }

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

    loginInFlight.current = true;
    try {
      const { data: signedIn, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        let msg = "Failed to sign in. Please try again.";
        if (authError.message.includes("Invalid login credentials")) msg = "Invalid email or password.";
        else if (authError.message.includes("Email not confirmed")) msg = "Please confirm your email before signing in.";
        else if (authError.message.includes("Too many requests")) msg = "Too many failed attempts. Try again later.";
        setError(msg);
        setLoading(false);
        return;
      }
      // The workspace's sign-in rules decide what happens next.
      const verdict = await checkSignin(signedIn.session?.access_token ?? null);
      const why = refusal(verdict) ?? (verdict.action === "error" ? "Couldn't finish signing you in. Check your connection and try again." : null);
      if (why) {
        await supabase.auth.signOut();
        setError(why);
        setLoading(false);
      } else if (verdict.action === "set_password") {
        router.push('/set-password');
      } else {
        await openWorkspace(signedIn.user ?? null, "full");
      }
    } finally {
      loginInFlight.current = false;
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

  // The form's own button wakes (filled) once there is something to sign
  // in with; until then Microsoft leads, in its own neutral style.
  // After "your company account signs in with Microsoft", the password
  // button stays quiet: the message points up, at Microsoft.
  const typed = !!email.trim() && !!password && error !== refusal({ action: "use_microsoft" });

  // ─── Checking / OAuth redirect in progress ──────────────────────
  if (view === "checking") {
    return (
      <AuthCard title={signed ? "Signed in." : "Signing you in."} signed={signed} leaving={leaving}
        status={signed ? "Opening your workspace" : "Checking your sign-in"}>
        <SlowNotice secs={slowSecs} onStartOver={() => startOver()} />
      </AuthCard>
    );
  }

  // ─── Authenticated, but not attached to any workspace ───────────
  if (view === "no-workspace") {
    return (
      <AuthCard title="Your access is off." sub={authedEmail ?? undefined}>
        <p className="text-reading text-[var(--color-text)]">
          Your account is in a workspace, but your access there is suspended. Ask your admin to turn it back on, then sign in again.
        </p>
        <Button variant="secondary" onClick={handleSignOut} className={`mt-6 ${authBtn}`}>
          <LogOut aria-hidden className="w-4 h-4" /> Sign out
        </Button>
      </AuthCard>
    );
  }

  // ─── Login ──────────────────────────────────────────────────────
  return (
    <AuthCard
      title={signed ? "Signed in." : "Sign in."}
      signed={signed}
      leaving={leaving}
      status={signed ? "Opening your workspace"
        : loading ? "Signing in"
        : oauthLoading ? "Opening Microsoft"
        : error ? "Not signed in"
        : "Ready to sign in"}
      footer={<>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-body">
          <p className="text-[var(--color-text-muted)]">
            New company?{" "}
            <Link href="/signup" className={link}>Start a workspace</Link>
          </p>
          <Link href="/about" className={link}>About Manufacturing OS</Link>
        </div>
        <p className="text-body text-[var(--color-text-muted)]">Your workspace admin adds your account.</p>
        <p className="text-body text-[var(--color-text-muted)]">Authorized use only.</p>
      </>}
    >
            {/* A problem sits where it happened: right above the doors it's about. */}
            {error && (
              <div role="alert" className="mb-5 flex items-start gap-2 text-[var(--state-overdue-text)]">
                <AlertCircle aria-hidden className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="text-body font-medium">{error}</p>
              </div>
            )}

            {/* Company accounts: Microsoft single sign-on, in Microsoft's
                own neutral style (white, its four squares). */}
            <Button variant="secondary" onClick={handleMicrosoft} disabled={loading} loading={oauthLoading} className={`${authBtn} gap-3`}>
              {!oauthLoading && <MicrosoftLogo className="w-5 h-5" />}
              {oauthLoading ? "Opening Microsoft" : "Sign in with Microsoft"}
            </Button>

            <div className="flex items-center gap-3 my-6" aria-hidden>
              <div className="h-px bg-[var(--color-border)] flex-1" />
              <span className="text-body text-[var(--color-text-muted)]">or with a password</span>
              <div className="h-px bg-[var(--color-border)] flex-1" />
            </div>

            <form onSubmit={handleLogin}>
              <div>
                <label htmlFor="si-email" className={fieldLabel}>Email</label>
                <input
                  id="si-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  enterKeyHint="next"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={authField}
                  placeholder="name@company.com"
                  required
                />
              </div>

              <div className="mt-4">
                <div className="flex items-baseline justify-between gap-3">
                  <label htmlFor="si-password" className={fieldLabel}>Password</label>
                  <button type="button" onClick={() => setForgot((v) => !v)} aria-expanded={forgot} aria-controls="si-forgot"
                    className={`${link} text-body -my-2 py-2 pointer-coarse:py-3`}>Forgot it?</button>
                </div>
                <PasswordInput
                  id="si-password"
                  autoComplete="current-password"
                  enterKeyHint="go"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  fieldClassName={authField}
                  required
                />
                {forgot && (
                  <p id="si-forgot" className="mt-1.5 text-body text-[var(--color-text-muted)]">
                    Your workspace admin resets it. Company accounts reset through Microsoft.
                  </p>
                )}
              </div>

              <Button type="submit" variant={typed ? "primary" : "secondary"} disabled={oauthLoading} loading={loading} done={opened} doneLabel="Signed in"
                className={`mt-6 ${authBtn}`}>
                {loading ? "Signing in" : "Sign in"}
              </Button>
              {loading && <SlowNotice secs={slowSecs} onStartOver={() => startOver()} />}
            </form>

            {/* For both doors: kept on this device only. */}
            <label className="mt-5 pt-4 border-t border-[var(--color-border)] flex items-center gap-2.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={keepSignedIn}
                onChange={(e) => setKeepChoice(e.target.checked)}
                className="w-4 h-4 rounded cursor-pointer accent-[var(--color-text)]"
              />
              <span className="text-body text-[var(--color-text-muted)]">Keep me signed in on this device</span>
            </label>
    </AuthCard>
  );
}
