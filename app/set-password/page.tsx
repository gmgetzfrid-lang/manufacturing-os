"use client";

// /set-password: after signing in with a one-time password, the person
// sets their own before going anywhere else. It has to happen the same day
// the one-time password was issued; after that the account is suspended
// until an admin resets it.

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { AuthCard, authField, authBtn } from "@/components/marketing/AuthCard";
import { Button } from "@/components/ui/Button";
import { SkeletonText } from "@/components/ui/Skeleton";
import { label, btnLink } from "@/components/admin/kit";
import { MIN_PASSWORD, passwordProblem } from "@/lib/signinPolicy";
import { checkSignin } from "@/lib/signinCheck";
import { friendlyError } from "@/lib/friendlyError";

export default function SetPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A field's problem shows after the person leaves it, never while typing.
  const [left, setLeft] = useState<{ pw?: boolean; again?: boolean }>({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/"); return; }
      const v = await checkSignin(session.access_token);
      if (!alive) return;
      if (v.action === "ok") { router.replace("/dashboard"); return; }
      if (v.action === "not_added") { await supabase.auth.signOut(); router.replace("/?signin=not_added"); return; }
      if (v.action === "expired" || v.action === "use_microsoft") { await supabase.auth.signOut(); router.replace("/"); return; }
      setEmail(session.user.email ?? null);
      if (v.expiresAt) setUntil(new Date(v.expiresAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
    })();
    return () => { alive = false; };
  }, [router]);

  const problem = pw ? passwordProblem(pw, email) : null;
  const shownProblem = left.pw ? problem : null;
  const mismatch = left.again && again && again !== pw ? "The two don't match." : null;
  const ready = !!pw && !problem && pw === again;

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
      if (!res.ok) { setError(body.error ? friendlyError(body.error) : "Couldn't save it. Try again."); return; }
      // The flag lives in the session token: refresh it before going on.
      await supabase.auth.refreshSession();
      setSaved(true);
      router.replace("/dashboard");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Set your password." sub={until ? `Do it now. Your one-time password stops working at ${until}.` : "Do it now, before you go on."}>
      {!email ? (
        <SkeletonText lines={4} />
      ) : (
        <form onSubmit={submit}>
          {error && (
            <p role="alert" className="mb-5 flex items-start gap-2 text-body font-medium text-[var(--state-overdue-text)]"><AlertCircle aria-hidden className="w-4 h-4 mt-0.5 shrink-0" /> {error}</p>
          )}
          <p className="mb-5 text-body text-[var(--color-text-muted)]">Signed in as <b className="font-medium text-[var(--color-text)]">{email}</b> with a one-time password.</p>
          <div>
            <label htmlFor="np" className={label}>New password</label>
            <input id="np" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} onBlur={() => setLeft((l) => ({ ...l, pw: true }))}
              className={authField} required aria-invalid={!!shownProblem} aria-describedby="np-note" />
            <p id="np-note" className={`mt-1.5 text-body ${shownProblem ? "font-medium text-[var(--state-overdue-text)]" : "text-[var(--color-text-muted)]"}`}>
              {shownProblem ?? (pw && !problem
                ? <span className="inline-flex items-center gap-1 text-[var(--state-released-text)]"><Check aria-hidden className="w-3.5 h-3.5" /> Strong enough</span>
                : `At least ${MIN_PASSWORD} characters, with numbers or symbols.`)}
            </p>
          </div>
          <div className="mt-4">
            <label htmlFor="np2" className={label}>Type it again</label>
            <input id="np2" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} onBlur={() => setLeft((l) => ({ ...l, again: true }))}
              className={authField} required aria-invalid={!!mismatch} aria-describedby={mismatch ? "np2-note" : undefined} />
            {mismatch && <p id="np2-note" className="mt-1.5 text-body font-medium text-[var(--state-overdue-text)]">{mismatch}</p>}
          </div>
          {/* Wakes once both fields agree and the password is strong enough;
              says why when it can't. */}
          <Button type="submit" variant={ready ? "primary" : "secondary"} loading={busy} done={saved} doneLabel="Saved" disabled={!ready} className={`mt-6 ${authBtn}`}>
            {busy ? "Saving" : "Save and continue"}
          </Button>
          {!ready && pw && (
            <p className="mt-2 text-body text-[var(--color-text-muted)]">{problem ? "Make the password stronger to go on." : "Type the same password again to go on."}</p>
          )}
          <div className="mt-5 pt-4 border-t border-[var(--color-border)]">
            <button type="button" onClick={async () => { await supabase.auth.signOut(); router.replace("/"); }} className={btnLink}>
              Sign out instead
            </button>
          </div>
        </form>
      )}
    </AuthCard>
  );
}
