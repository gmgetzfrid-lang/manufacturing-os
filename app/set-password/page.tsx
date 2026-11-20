"use client";

// /set-password — after signing in with a one-time password, the person
// sets their own before going anywhere else. It has to happen the same day
// the one-time password was issued; after that the account is suspended
// until an admin resets it.

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2, AlertCircle, LogOut, Check } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { AuthCard } from "@/components/marketing/AuthCard";
import { btnPrimary, btnQuiet } from "@/components/admin/kit";
import { MIN_PASSWORD, passwordProblem } from "@/lib/signinPolicy";
import { checkSignin } from "@/lib/signinCheck";

export default function SetPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/"); return; }
      const v = await checkSignin(session.access_token);
      if (!alive) return;
      if (v.action === "ok") { router.replace("/dashboard"); return; }
      if (v.action === "expired" || v.action === "use_microsoft") { await supabase.auth.signOut(); router.replace("/"); return; }
      setEmail(session.user.email ?? null);
      if (v.expiresAt) setUntil(new Date(v.expiresAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
    })();
    return () => { alive = false; };
  }, [router]);

  const problem = pw ? passwordProblem(pw, email) : null;
  const mismatch = again && again !== pw ? "The two don't match." : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const p = passwordProblem(pw, email);
    if (p) { setError(p); return; }
    if (pw !== again) { setError("The two don't match."); return; }
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/"); return; }
      const res = await fetch("/api/auth/password-set", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ password: pw }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? "Couldn't save it. Try again."); return; }
      // The flag lives in the session token: refresh it before going on.
      await supabase.auth.refreshSession();
      router.replace("/dashboard");
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full h-11 pl-10 pr-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-md text-[15px] text-[var(--color-text)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40";
  const label = "block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5";

  return (
    <AuthCard title="Set your password." sub={until ? `Do it now. Your one-time password stops working at ${until}.` : "Do it now, before you go on."}>
      {!email ? (
        <div className="py-6 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" /></div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <p role="alert" className="flex items-start gap-2 text-[14px] font-semibold text-[var(--state-overdue)]"><AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}</p>
          )}
          <p className="text-[14px] text-[var(--color-text-muted)]">Signed in as <b className="font-semibold text-[var(--color-text)]">{email}</b> with a one-time password.</p>
          <div>
            <label htmlFor="np" className={label}>New password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[var(--color-text-faint)] pointer-events-none" />
              <input id="np" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className={input} required />
            </div>
            <p className={`mt-1.5 text-[13px] ${problem ? "text-[var(--state-held)]" : pw ? "text-[var(--state-released)]" : "text-[var(--color-text-muted)]"}`}>
              {problem ?? (pw ? <span className="inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Good</span> : `At least ${MIN_PASSWORD} characters, with numbers or symbols.`)}
            </p>
          </div>
          <div>
            <label htmlFor="np2" className={label}>Type it again</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[var(--color-text-faint)] pointer-events-none" />
              <input id="np2" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={input} required />
            </div>
            {mismatch && <p className="mt-1.5 text-[13px] text-[var(--state-held)]">{mismatch}</p>}
          </div>
          <button type="submit" disabled={busy || !!problem || !pw || pw !== again} className={`${btnPrimary} w-full h-11`}>
            {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> Saving…</> : "Save and continue"}
          </button>
          <button type="button" onClick={async () => { await supabase.auth.signOut(); router.replace("/"); }} className={`${btnQuiet} w-full h-11 text-[15px]`}>
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </form>
      )}
    </AuthCard>
  );
}
