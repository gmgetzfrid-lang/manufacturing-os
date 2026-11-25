"use client";

// Sign in. Two doors, one loud at a time (Hick's law, and reel DgI9usSyEJG):
// "Sign in with Microsoft" (company accounts, most people at a site) leads;
// the email form folds into one quiet "Continue with email" button until
// it's wanted. The door this device used last leads instead, marked "Last
// used". Once an email and password are typed, the password "Sign in"
// becomes the filled one. Labels sit above the fields; every press answers
// at once (a spinner in the button, then a check). Who may sign in and why
// one is refused are decided by the workspace's sign-in rules
// (lib/signinCheck), unchanged here.

import { AuthCard, authField, authBtn } from "@/components/marketing/AuthCard";
import { rememberWorkspaceName } from "@/lib/deviceWorkspace";
import { checkSignin, type SigninVerdict } from "@/lib/signinCheck";
import { fetchMemberships, pickMembership, SignedOut, ServerBusy, signOutHere, type MembershipAnswer } from "@/lib/membershipClient";
import { friendlyError } from "@/lib/friendlyError";
import { writeMember } from "@/lib/memberCache";
import { sharedLoad, forgetLoads, dashKey } from "@/lib/warmLoads";
import { normalizeRoles, primaryRole } from "@/lib/roleCapabilities";
import type { Role } from "@/types/schema";
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, setRememberSession, setPreferMicrosoft, prefersMicrosoft, rememberDefault } from '@/lib/supabase';
import { PasswordInput } from '@/components/ui/Field';

const noStore = () => () => {};
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { label as fieldLabel, link } from '@/components/admin/kit';
import { Button } from '@/components/ui/Button';
import { AlertCircle, LogOut, Mail } from 'lucide-react';
import { SlowNotice, useElapsed, startOver } from '@/components/system/SlowNotice';

/** Whether the app's database answers within a few seconds. The last step of
 *  a Microsoft sign-in runs on Supabase's server and writes to that
 *  database; when it isn't answering, that step ends on a bare "upstream
 *  request timeout" page we can't change. Asked first, so this page can say
 *  so instead. Any answer, even "not allowed", means it's up. */
async function databaseAnswers(ms = 6000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const { error } = await supabase.from("orgs").select("id").limit(1).abortSignal(ctl.signal);
    return !(error && /abort|fetch|network/i.test(`${error.message} ${(error as { name?: string }).name ?? ""}`));
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
const SERVER_DOWN = "The app's server isn't answering, so Microsoft sign-in can't finish. Try again in a minute.";
const BUSY = "The server is busy right now, so your workspace didn't open. Try again in a minute.";
const TOO_SLOW = "The server took too long to answer. Try again in a minute.";

/** How long a sign-in check or workspace lookup may take before the page
 *  stops waiting and says so. */
const CHECK_MS = 15_000;
/** `p`, or what `late` gives when `p` hasn't answered in time. */
function inTime<T>(p: Promise<T>, late: () => T | Promise<T>, ms = CHECK_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { t = setTimeout(() => resolve(Promise.resolve().then(late)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
/** The sign-in check didn't answer in time. */
const LATE: SigninVerdict = { action: "error" };
/** The workspace lookup, given up on when it doesn't answer in time. */
const lookUp = () => inTime(fetchMemberships(), () => Promise.reject(new ServerBusy()));
/** The workspace lookup again after one that failed: at most twice, after
 *  a busy answer each a little later (and different on every device). */
async function lookUpAgain(busy: boolean): Promise<MembershipAnswer> {
  for (let i = 0; ; i++) {
    if (busy) await new Promise((r) => setTimeout(r, 2000 * 2 ** i * (0.75 + Math.random() / 2)));
    try { return await lookUp(); }
    catch (e) { if (!(e instanceof ServerBusy) || i >= 1) throw e; busy = true; }
  }
}

/** The door this device signed in through last (shown as "Last used"). */
const LAST_DOOR = "mfgos.signin.last";
type Door = "microsoft" | "email";
const rememberDoor = (d: Door) => { try { localStorage.setItem(LAST_DOOR, d); } catch { /* private mode */ } };

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
  // The server didn't answer the check before Microsoft: the next press goes
  // anyway (it may just be slow).
  const [serverSlow, setServerSlow] = useState(false);
  // The email form opens from its button (or already open when this device
  // last signed in with email).
  const [emailOpen, setEmailOpen] = useState(false);
  const [lastDoor, setLastDoor] = useState<Door | null>(null);
  useEffect(() => {
    try {
      const d = localStorage.getItem(LAST_DOOR);
      if (d === "microsoft" || d === "email") { setLastDoor(d); if (d === "email") setEmailOpen(true); }
    } catch { /* private mode */ }
  }, []);
  const keepSignedIn = keepChoice ?? deviceKeep;
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("checking");
  const [authedEmail, setAuthedEmail] = useState<string | null>(null);
  // The password button's answer once the workspace opens: a check.
  const [opened, setOpened] = useState(false);
  // The title block's SIGNED line, then the hand-off into the app.
  const [signed, setSigned] = useState<{ name: string; at: Date } | null>(null);
  // The app's code for the dashboard, fetched while the person types, so
  // nothing is left to download once the server says yes.
  useEffect(() => { router.prefetch("/dashboard"); }, [router]);
  // A password sign-in in progress decides its own next step (handleLogin).
  const loginInFlight = useRef(false);
  // A remembered sign-in being checked: the page waits on it (with the
  // slow notice), never swapping to the sign-in form underneath it.
  const checkInFlight = useRef(false);
  const slowSecs = useElapsed(view === "checking" || loading);

  // Decide where a signed-in account belongs. The workspace's sign-in rules
  // first (an account nobody added is signed out here, and deleted on the
  // server), then the server's answer on its workspaces. No profile is ever
  // made here: accounts and profiles are made only by an admin adding
  // someone, or by a paid new workspace.
  /** The workspace this device last used, when the account is still in it. */
  const lastOrg = () => { try { return window.localStorage.getItem("manufacturingos.activeOrgId"); } catch { return null; } };
  /** Start Home's own loads as soon as the account and workspace are
   *  known: its layout, what needs you, the deck, the setup checklist and
   *  the widgets (lib/dashboard/homeLoads). Home picks them up
   *  (lib/warmLoads) instead of starting again. Resolves when the first
   *  screen's loads have answered. */
  const warm = (user: User | null, answer: MembershipAnswer | null): Promise<unknown> => {
    if (!user?.id) return Promise.resolve();
    const uid = user.id;
    const pick = answer ? pickMembership(answer, lastOrg()) : null;
    if (!pick || pick.status !== "active") return warmLayout(user);
    const roles = normalizeRoles(pick.roles, pick.role as Role | undefined);
    const head = primaryRole(roles);
    // Never fails: Home loads for itself whatever didn't come in.
    return import("@/lib/dashboard/homeLoads").then((m) => m.warmHome({
      uid, orgId: pick.orgId, roles, email: user.email ?? null, isAdmin: head === "Admin" || head === "DocCtrl",
    })).catch(() => undefined);
  };
  /** The account's Home layout needs only the account: asked for the moment
   *  the password is accepted, alongside the workspace lookup. On a device
   *  that has opened a workspace before, Home's loads for that workspace
   *  start then too (those that don't depend on the account's roles); they
   *  are shown only if the server's answer opens that same workspace. */
  const warmLayout = (user: User | null): Promise<unknown> => {
    if (!user?.id) return Promise.resolve();
    const uid = user.id;
    const org = lastOrg();
    if (org) return import("@/lib/dashboard/homeLoads").then((m) => m.warmHomeOrg({ uid, orgId: org, email: user.email ?? null })).then(() => undefined, () => undefined);
    return import("@/lib/dashboard/config").then((m) => sharedLoad(dashKey(uid), () => m.loadDashboardConfig(uid))).catch(() => undefined);
  };

  const routeAuthedUser = useCallback(async (user: User) => {
    if (loginInFlight.current) return;
    checkInFlight.current = true;
    try {
      // If they signed in via Microsoft, remember it on this device so we can try
      // a silent sign-in next time. Email/password users are never flagged, so
      // they never get auto-redirected to Microsoft.
      const meta = user.app_metadata ?? {};
      const providers = (meta.providers as string[] | undefined) ?? [];
      if (meta.provider === "azure" || providers.includes("azure")) {
        setPreferMicrosoft(true);
        rememberDoor("microsoft");
      }

      const session = await inTime(supabase.auth.getSession().then((r) => r.data.session), () => null);
      // The workspace lookup runs alongside the sign-in check, not after it;
      // its answer is used only when the check lets the account in.
      void warmLayout(user).catch(() => undefined);
      const workspaces = lookUp().then((a) => { void warm(user, a).catch(() => undefined); return a; }).catch((e: unknown) => e);
      // No answer in time: a remembered sign-in checks again later.
      const verdict = await inTime(checkSignin(session?.access_token ?? null), () => LATE);
      const why = refusal(verdict);
      if (why) {
        forgetLoads();
        if (verdict.action === NOT_ADDED) setPreferMicrosoft(false);
        await signOutHere();
        setError(why);
        setView("login");
        return;
      }
      if (verdict.action === "set_password") { router.replace("/set-password"); return; }
      // Already signed in (or back from Microsoft): straight in.
      await openWorkspace(user, await workspaces);
    } finally {
      checkInFlight.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  /** Into the app when the server says the account is active in a
   *  workspace; else the paused-access screen. No pause on the way in: the
   *  dashboard opens the moment the server says yes, and the app shell is
   *  handed the membership this page already has (lib/memberCache), so it
   *  opens without asking again (it checks again in the background). */
  const openWorkspace = async (user: User | null, known?: MembershipAnswer | unknown) => {
    const userEmail = user?.email ?? null;
    try {
      router.prefetch("/dashboard");
      if (known instanceof SignedOut) throw known;
      // A busy server is asked again a little later, the slow notice up.
      const answer = known && typeof known === "object" && "memberships" in (known as object) ? known as MembershipAnswer : await lookUpAgain(known instanceof ServerBusy);
      const pick = pickMembership(answer, lastOrg());
      if (pick) {
        rememberWorkspaceName(pick.orgName);
        // The sign-in rules were just checked here: the app doesn't ask the
        // server again on the way in (app/(protected)/layout, once per visit).
        if (user?.id) { try { sessionStorage.setItem(`signin-checked:${user.id}`, "1"); } catch { /* it checks again */ } }
        const meta = (user?.user_metadata ?? {}) as { full_name?: unknown; name?: unknown };
        const name = typeof meta.full_name === "string" && meta.full_name.trim() ? meta.full_name.trim()
          : typeof meta.name === "string" && meta.name.trim() ? meta.name.trim()
          : userEmail ?? "Signed in";
        if (user?.id) {
          const roles = normalizeRoles(pick.roles, pick.role as Role | undefined);
          try {
            window.localStorage.setItem("manufacturingos.activeOrgId", pick.orgId);
            writeMember(window.localStorage, { uid: user.id, orgId: pick.orgId, role: primaryRole(roles), roles, status: pick.status, email: pick.email ?? userEmail ?? undefined });
          } catch { /* private mode: the shell looks it up */ }
        }
        setLoading(false); setOpened(true);
        setSigned({ name, at: new Date() });
        // "Opening your workspace" has a job: the top of Home (what needs
        // you, the layout) loads now, so it opens filled in. Never more than
        // 2.5 s: past that it opens and the rest arrives in place.
        await Promise.race([warm(user, answer), new Promise((r) => setTimeout(r, 2500))]);
        router.replace("/dashboard");
        return;
      }
      setAuthedEmail(userEmail);
      setView("no-workspace");
    } catch (e) {
      // Busy is never "signed out": the sign-in is kept for the next try.
      if (!(e instanceof SignedOut)) setError(e instanceof ServerBusy ? BUSY : "Couldn't reach the server to open your workspace. Check your connection and try again.");
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
        // Already decoded once by URLSearchParams (a second decode throws
        // on a stray %); said in plain words, never Microsoft's raw text.
        if (!SILENT_FALLBACK_ERRORS.has(errorCode) && errorDesc) {
          setError(friendlyError(errorDesc));
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
        // Only when the server answers: otherwise the silent try would land
        // on Supabase's timeout page before anyone pressed anything.
        void databaseAnswers(4000).then((up) => {
          if (!active) return;
          if (up) startMicrosoft({ silent: true, remember: true }); // keeps the spinner; navigates away
          else { setServerSlow(true); setError(SERVER_DOWN); setView("login"); }
        });
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
    // silently fails to produce a session. A sign-in still being checked
    // keeps the page (and its slow notice): each check has its own limit.
    const fallback = window.setTimeout(() => {
      if (active && !checkInFlight.current) {
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
      // The workspace's sign-in rules decide what happens next; the
      // workspace lookup runs alongside, used only if they let the account in.
      // Home's layout needs only the account: asked for now, too.
      void warmLayout(signedIn.user ?? null).catch(() => undefined);
      const workspaces = lookUp().then((a) => { void warm(signedIn.user ?? null, a).catch(() => undefined); return a; }).catch((e: unknown) => e);
      const verdict = await inTime(checkSignin(signedIn.session?.access_token ?? null), () => LATE);
      const why = refusal(verdict) ?? (verdict === LATE ? TOO_SLOW : verdict.action === "error" ? "Couldn't finish signing you in. Check your connection and try again." : null);
      if (why) {
        forgetLoads();
        await signOutHere();
        setError(why);
        setLoading(false);
      } else if (verdict.action === "set_password") {
        rememberDoor("email");
        router.push('/set-password');
      } else {
        rememberDoor("email");
        await openWorkspace(signedIn.user ?? null, await workspaces);
      }
    } finally {
      loginInFlight.current = false;
    }
  };

  const handleMicrosoft = async () => {
    setError(null);
    setOauthLoading(true);
    // Checked first (once): a server that isn't answering is said here, not
    // on Supabase's bare timeout page. Pressed again, it goes anyway.
    if (!serverSlow && !(await databaseAnswers())) {
      setServerSlow(true);
      setOauthLoading(false);
      setError(SERVER_DOWN);
      return;
    }
    void startMicrosoft({ silent: false, remember: keepSignedIn });
  };

  const handleSignOut = async () => {
    // Explicit sign-out: disable silent auto sign-in so we don't immediately
    // log them back in.
    setPreferMicrosoft(false);
    await signOutHere();
    setAuthedEmail(null);
    setError(null);
    setView("login");
  };

  // The form's own button wakes (filled) once there is something to sign
  // in with; until then Microsoft leads, in its own neutral style.
  // After "your company account signs in with Microsoft", the password
  // button stays quiet: the message points up, at Microsoft.
  const msRefused = error === refusal({ action: "use_microsoft" });
  const typed = !!email.trim() && !!password && !msRefused;
  // Which door leads: Microsoft, unless this device last came in by email
  // (then the password "Sign in" is the filled one from the start).
  const msLeads = lastDoor !== "email" || msRefused;

  // ─── Checking / OAuth redirect in progress ──────────────────────
  if (view === "checking") {
    return (
      <AuthCard title={signed ? "Signed in." : "Signing you in."} signed={signed}
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
     
      status={signed ? "Opening your workspace"
        : loading ? "Signing in"
        : oauthLoading ? "Opening Microsoft"
        : error ? "Not signed in"
        : "Ready to sign in"}
      footer={<>
        <p className="text-body text-[var(--color-text-muted)]">
          New company?{" "}
          <Link href="/signup" className={`${link} ui-hit`}>Start a workspace</Link>
        </p>
        <p className="text-caption text-pretty text-[var(--color-text-muted)]">No account? Your workspace admin adds you. Authorized use only.</p>
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
                own neutral style (white, its four squares). It leads unless
                this device last came in by email; never two doors equally
                loud (Hick's law, docs/design-rules.md H4). */}
            <div className="relative">
              <Button variant="secondary" onClick={handleMicrosoft} disabled={loading} loading={oauthLoading}
                className={`${authBtn} gap-3 ${msLeads ? "!border-[var(--color-border-control)] font-semibold shadow-[var(--shadow-action)]" : ""}`}>
                {!oauthLoading && <MicrosoftLogo className="w-5 h-5" />}
                {oauthLoading ? "Opening Microsoft" : serverSlow ? "Try Microsoft again" : "Sign in with Microsoft"}
              </Button>
              {lastDoor === "microsoft" && <LastUsed />}
            </div>

            {/* The email form, folded into one quiet button until it's wanted:
                the same shape as the Microsoft door, one step quieter (gray
                words, regular weight), so the two stack as one group. */}
            {!emailOpen && (
              <div className="relative mt-3">
                <Button variant="secondary" onClick={() => { setEmailOpen(true); requestAnimationFrame(() => document.getElementById("si-email")?.focus()); }}
                  aria-expanded={false} aria-controls="si-form" className={`${authBtn} gap-2 !font-normal !text-[var(--color-text-muted)]`}>
                  <Mail aria-hidden className="w-4 h-4" /> Continue with email
                </Button>
              </div>
            )}

            {emailOpen && (
            <form id="si-form" onSubmit={handleLogin} className="mt-6 relative">
              {lastDoor === "email" && <span className="absolute -top-3 right-0 px-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-caption font-medium text-[var(--color-text-muted)]">Last used</span>}
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

              <Button type="submit" variant={typed || !msLeads ? "primary" : "secondary"} disabled={oauthLoading} loading={loading} done={opened} doneLabel="Signed in"
                className={`mt-6 ${authBtn}`}>
                {loading ? "Signing in" : "Sign in"}
              </Button>
              {loading && <SlowNotice secs={slowSecs} onStartOver={() => startOver()} />}
            </form>
            )}

            {/* For both doors: kept on this device only. */}
            <label className="mt-3 flex items-center gap-2.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer select-none">
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

/** A small "Last used" tag on the door this device signed in through last. */
function LastUsed() {
  return <span className="absolute -top-2.5 right-3 px-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-caption font-medium text-[var(--color-text-muted)]">Last used</span>;
}
