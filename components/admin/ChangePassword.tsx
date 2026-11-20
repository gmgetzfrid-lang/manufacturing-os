"use client";

// Profile → Password. People who sign in with a password change it here
// (the current one is checked on the server). People who sign in with
// Microsoft see that their company account controls it.

import React, { useEffect, useState } from "react";
import { KeyRound, Loader2, Check, AlertCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/PageHero";
import { field, label, btnPrimary } from "@/components/admin/kit";
import { MIN_PASSWORD, passwordProblem } from "@/lib/signinPolicy";

export default function ChangePassword() {
  const [kind, setKind] = useState<"loading" | "password" | "microsoft">("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data: { user } }) => {
      setEmail(user?.email ?? null);
      const providers = ((user?.app_metadata?.providers as string[] | undefined) ?? []);
      const hasPassword = providers.includes("email") || user?.app_metadata?.provider === "email";
      setKind(hasPassword ? "password" : "microsoft");
    });
  }, []);

  const problem = pw ? passwordProblem(pw, email) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (problem) { setMsg({ ok: false, text: problem }); return; }
    if (pw !== again) { setMsg({ ok: false, text: "The two new passwords don't match." }); return; }
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/auth/password-set", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ password: pw, current }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: body.error ?? "Couldn't change it." }); return; }
      setCurrent(""); setPw(""); setAgain("");
      setMsg({ ok: true, text: "Password changed." });
    } finally { setBusy(false); }
  };

  const heading = <span className="inline-flex items-center gap-2.5"><span aria-hidden className="ui-icon-tile is-sm is-solid"><KeyRound className="w-4 h-4" /></span>Password</span>;
  if (kind === "loading") return null;
  if (kind === "microsoft") {
    return (
      <Card label={heading}>
        <p className="text-[15px] text-[var(--color-text)]">You sign in with Microsoft. Your company account sets your password and multi-factor sign-in.</p>
      </Card>
    );
  }
  return (
    <Card label={heading}>
      <form onSubmit={submit} className="space-y-4 max-w-md">
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={`flex items-center gap-2 text-[14px] font-semibold ${msg.ok ? "text-[var(--state-released)]" : "text-[var(--state-overdue)]"}`}>
            {msg.ok ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />} {msg.text}
          </p>
        )}
        <div>
          <label htmlFor="cp-cur" className={label}>Current password</label>
          <input id="cp-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} required />
        </div>
        <div>
          <label htmlFor="cp-new" className={label}>New password</label>
          <input id="cp-new" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className={field} required />
          <p className={`mt-1.5 text-[13px] ${problem ? "text-[var(--state-held)]" : "text-[var(--color-text-muted)]"}`}>{problem ?? `At least ${MIN_PASSWORD} characters, with numbers or symbols.`}</p>
        </div>
        <div>
          <label htmlFor="cp-again" className={label}>New password again</label>
          <input id="cp-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={field} required />
        </div>
        <button type="submit" disabled={busy || !current || !pw || !!problem || pw !== again} className={btnPrimary}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Change password
        </button>
      </form>
    </Card>
  );
}
