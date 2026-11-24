"use client";

// Profile → Password. People who sign in with a password change it here
// (the current one is checked on the server). People who sign in with
// Microsoft see that their company account controls it.

import React, { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/PageHero";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { said, responseError } from "@/components/admin/said";
import { MIN_PASSWORD, passwordProblem } from "@/lib/signinPolicy";

export default function ChangePassword() {
  const [kind, setKind] = useState<"loading" | "password" | "microsoft">("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [againTouched, setAgainTouched] = useState(false);
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
  const mismatch = againTouched && again.length > 0 && pw !== again;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (problem) { setMsg({ ok: false, text: problem }); return; }
    if (pw !== again) { setAgainTouched(true); return; }
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/auth/password-set", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ password: pw, current }),
      });
      if (!res.ok) throw await responseError(res);
      setCurrent(""); setPw(""); setAgain(""); setAgainTouched(false);
      setMsg({ ok: true, text: "Password changed." });
    } catch (err) {
      setMsg({ ok: false, text: said(err, "Couldn't change the password.") });
    } finally { setBusy(false); }
  };

  if (kind === "loading") return null;
  if (kind === "microsoft") {
    return (
      <Card label="Password">
        <p className="text-reading text-[var(--color-text)]">You sign in with Microsoft. Your company account sets your password and multi-factor sign-in.</p>
      </Card>
    );
  }
  return (
    <Card label="Password">
      <form onSubmit={submit} className="space-y-4 max-w-md">
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="New password" hint={problem ? undefined : `At least ${MIN_PASSWORD} characters, with numbers or symbols.`} error={problem ?? undefined}>
          <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </Field>
        <Field label="New password again" error={mismatch ? "The two new passwords don't match. Type it once more." : undefined}>
          <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} onBlur={() => setAgainTouched(true)} required />
        </Field>
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={`flex items-center gap-2 text-body font-medium ${msg.ok ? "text-[var(--color-text)]" : "text-[var(--state-overdue-text)]"}`}>
            {msg.ok && <Check aria-hidden className="w-4 h-4 text-[var(--state-released)]" />} {msg.text}
          </p>
        )}
        <Button type="submit" loading={busy} disabled={!current || !pw || !!problem || pw !== again}>Change password</Button>
      </form>
    </Card>
  );
}
