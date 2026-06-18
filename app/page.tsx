"use client";

import React, { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, setRememberSession, setPreferMicrosoft, prefersMicrosoft } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { Layout, Lock, Mail, Loader2, AlertCircle, Building2, LogOut } from 'lucide-react';

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
        routeAuthedUser(session.user);
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

  // ─── Checking / OAuth redirect in progress ──────────────────────
  if (view === "checking") {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <Loader2 className="w-8 h-8 text-orange-500 animate-spin mb-4" />
        <p className="text-slate-400 text-sm font-medium tracking-wide">Signing you in…</p>
      </div>
    );
  }

  // ─── Authenticated, but not attached to any workspace ───────────
  if (view === "no-workspace") {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black z-0" />
        <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden relative z-20 border border-slate-800">
          <div className="bg-slate-900 p-8 text-center border-b border-slate-800">
            <div className="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-orange-500 to-orange-700 rounded-xl mb-4 shadow-lg shadow-orange-900/40 ring-1 ring-white/10">
              <Building2 className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-xl font-black text-white tracking-tight">No workspace found</h1>
            {authedEmail && (
              <p className="text-slate-400 text-xs mt-2 font-medium break-all">{authedEmail}</p>
            )}
          </div>
          <div className="p-8 bg-white">
            <p className="text-sm text-slate-600 leading-relaxed">
              Your Microsoft account isn&rsquo;t linked to a workspace yet. Ask your
              organization&rsquo;s admin to add you using this email address — once they do,
              just sign in with Microsoft again and you&rsquo;ll go straight in.
            </p>
            <div className="mt-6 space-y-3">
              <a
                href="/signup"
                className="w-full py-3.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center"
              >
                Request access or create a workspace
              </a>
              <button
                onClick={handleSignOut}
                className="w-full py-3 text-slate-500 hover:text-slate-900 font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" /> Sign out
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Login ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black z-0" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-900/50 to-transparent z-10" />

      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden relative z-20 border border-slate-800">
        <div className="bg-slate-900 p-8 text-center border-b border-slate-800">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-orange-500 to-orange-700 rounded-xl mb-4 shadow-lg shadow-orange-900/40 ring-1 ring-white/10">
            <Layout className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight">Manufacturing<span className="text-orange-500">OS</span></h1>
          <p className="text-slate-400 text-xs uppercase tracking-widest mt-2 font-medium">Enterprise Control System</p>
        </div>

        <div className="p-8 bg-white">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start animate-in fade-in slide-in-from-top-2 shadow-sm">
              <AlertCircle className="w-5 h-5 text-red-600 mr-3 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-bold text-red-900">Access Denied</h4>
                <p className="text-sm text-red-700 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Email Address</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Mail className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-12 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="name@company.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Password</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-12 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="••••••••"
                  required
                />
              </div>
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={keepSignedIn}
                onChange={(e) => setKeepSignedIn(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500 cursor-pointer"
              />
              <span className="text-sm font-medium text-slate-600">Keep me signed in on this device</span>
            </label>

            <button
              type="submit"
              disabled={loading || oauthLoading}
              className="w-full py-4 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl shadow-xl hover:shadow-2xl hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none"
            >
              {loading ? (
                <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Authenticating...</>
              ) : (
                "Sign In to Dashboard"
              )}
            </button>
          </form>

          <div className="flex items-center gap-3 my-6">
            <div className="h-px bg-slate-200 flex-1" />
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">or</span>
            <div className="h-px bg-slate-200 flex-1" />
          </div>

          {/* Microsoft / Azure single sign-on */}
          <button
            type="button"
            onClick={handleMicrosoft}
            disabled={oauthLoading || loading}
            className="w-full py-3.5 bg-white hover:bg-slate-50 text-slate-800 font-bold rounded-xl border border-slate-300 shadow-sm hover:shadow transition-all flex items-center justify-center gap-3 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {oauthLoading ? (
              <><Loader2 className="w-5 h-5 animate-spin" /> Redirecting to Microsoft…</>
            ) : (
              <><MicrosoftLogo className="w-5 h-5" /> Sign in with Microsoft</>
            )}
          </button>
        </div>

        <div className="bg-slate-50 p-6 text-center border-t border-slate-100 flex flex-col items-center gap-3">
          <p className="text-sm text-slate-600 font-medium">
            Don&rsquo;t have a workspace?{' '}
            <a href="/signup" className="text-orange-600 hover:text-orange-700 font-bold hover:underline">
              Create Account
            </a>
          </p>
          <div className="flex items-center gap-4 text-[11px] font-medium pt-1">
            <a href="/about" className="text-slate-500 hover:text-slate-900 hover:underline">About this product</a>
          </div>
          <div className="flex justify-between w-full px-2 mt-2">
            <p className="text-[10px] text-slate-400 font-medium">v2.1.0 (Enterprise)</p>
            <p className="text-[10px] text-slate-400 font-medium">Authorized Use Only</p>
          </div>
        </div>
      </div>
    </div>
  );
}
