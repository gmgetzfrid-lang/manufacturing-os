"use client";

// /signup/finish?session_id=... - where the payment page sends the payer.
// Makes sure their new workspace exists, has them set their password once,
// and signs them in (lib/workspaceSignupServer).

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { AuthCard, authField, authBtn } from "@/components/marketing/AuthCard";
import { Button } from "@/components/ui/Button";
import { btnPrimary, link, label } from "@/components/admin/kit";
import { MIN_PASSWORD, passwordProblem } from "@/lib/signinPolicy";
import { friendlyError } from "@/lib/friendlyError";
import { supabase } from "@/lib/supabase";

type State = { k: "loading" } | { k: "set"; email: string; company: string } | { k: "done"; company: string } | { k: "error"; message: string };

function Finish() {
  const router = useRouter();
  const sessionId = useSearchParams().get("session_id") ?? "";
  const [state, setState] = useState<State>({ k: "loading" });
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A field's problem shows after the person leaves it, never while typing.
  const [left, setLeft] = useState<{ pw?: boolean; pw2?: boolean }>({});

  useEffect(() => {
    let live = true;
    // The workspace may take a moment after the payment: ask a few times.
    const ask = async (tries: number): Promise<void> => {
      const res = await fetch("/api/signup/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
      const body = (await res.json().catch(() => null)) as { email?: string; company?: string; needsPassword?: boolean; error?: string } | null;
      if (!live) return;
      if (res.status === 402 && tries > 0) { await new Promise((r) => setTimeout(r, 2500)); return ask(tries - 1); }
      if (!res.ok || !body?.email) { setState({ k: "error", message: body?.error ? friendlyError(body.error) : "This page couldn't be opened." }); return; }
      setState(body.needsPassword ? { k: "set", email: body.email, company: body.company ?? "" } : { k: "done", company: body.company ?? "" });
    };
    void ask(6).catch(() => { if (live) setState({ k: "error", message: "Couldn't reach the server. Reload this page." }); });
    return () => { live = false; };
  }, [sessionId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.k !== "set") return;
    const weak = passwordProblem(pw, state.email);
    if (weak) { setError(weak); return; }
    if (pw !== pw2) { setError("The two passwords don't match."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/signup/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, password: pw }) });
      const body = (await res.json().catch(() => null)) as { email?: string; error?: string } | null;
      if (!res.ok || !body?.email) throw new Error(body?.error ?? "The password couldn't be set.");
      const { error: signErr } = await supabase.auth.signInWithPassword({ email: body.email, password: pw });
      if (signErr) { setState({ k: "done", company: state.company }); return; }
      setBusy(false);
      setSignedIn(true);
      router.replace("/admin/users");
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  if (state.k === "loading") {
    return (
      <AuthCard title="Setting up your workspace." sub="This takes a few seconds after paying.">
        <p role="status" className="flex items-center gap-2 text-reading text-[var(--color-text-muted)]">
          <Loader2 aria-hidden className="w-5 h-5 motion-safe:animate-spin" /> Making your workspace
        </p>
      </AuthCard>
    );
  }
  if (state.k === "error") {
    return (
      <AuthCard title="This didn't open." footer={<p className="text-body"><Link href="/" className={link}>Go to sign in</Link></p>}>
        <p role="alert" className="flex items-start gap-2 text-reading font-medium text-[var(--state-overdue-text)]"><AlertCircle aria-hidden className="w-4 h-4 shrink-0 mt-1" /> {state.message}</p>
        <p className="mt-2 text-body text-[var(--color-text-muted)]">Open the link from the payment page again, or sign in if your password is already set.</p>
      </AuthCard>
    );
  }
  if (state.k === "done") {
    return (
      <AuthCard title="Your workspace is ready." sub={state.company}>
        <p className="text-reading text-[var(--color-text)]">Your password is set. Sign in to start adding your people.</p>
        <Link href="/" className={`${btnPrimary} ${authBtn} mt-6`}>Sign in</Link>
      </AuthCard>
    );
  }
  const weakNow = left.pw && pw ? passwordProblem(pw, state.email) : null;
  const mismatchNow = left.pw2 && pw2 && pw2 !== pw ? "The two passwords don't match." : null;
  const ready = !!pw && pw === pw2 && !passwordProblem(pw, state.email);
  return (
    <AuthCard title="Set your password." sub={[state.company, state.email].filter(Boolean).join(", ")}>
      {error && (
        <div role="alert" className="mb-5 flex items-start gap-2 text-[var(--state-overdue-text)]">
          <AlertCircle aria-hidden className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-body font-medium">{error}</p>
        </div>
      )}
      <form onSubmit={submit}>
        <div>
          <label htmlFor="fin-pw" className={label}>Password</label>
          <input id="fin-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} onBlur={() => setLeft((l) => ({ ...l, pw: true }))}
            className={authField} autoComplete="new-password" minLength={MIN_PASSWORD} required
            aria-invalid={!!weakNow} aria-describedby="fin-pw-note" />
          <p id="fin-pw-note" className={`mt-1.5 text-body ${weakNow ? "font-medium text-[var(--state-overdue-text)]" : "text-[var(--color-text-muted)]"}`}>
            {weakNow ?? (pw && !passwordProblem(pw, state.email)
              ? <span className="inline-flex items-center gap-1 text-[var(--state-released-text)]"><Check aria-hidden className="w-3.5 h-3.5" /> Strong enough</span>
              : `At least ${MIN_PASSWORD} characters, with numbers or symbols.`)}
          </p>
        </div>
        <div className="mt-4">
          <label htmlFor="fin-pw2" className={label}>Password again</label>
          <input id="fin-pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} onBlur={() => setLeft((l) => ({ ...l, pw2: true }))}
            className={authField} autoComplete="new-password" minLength={MIN_PASSWORD} required
            aria-invalid={!!mismatchNow} aria-describedby={mismatchNow ? "fin-pw2-note" : undefined} />
          {mismatchNow && <p id="fin-pw2-note" className="mt-1.5 text-body font-medium text-[var(--state-overdue-text)]">{mismatchNow}</p>}
        </div>
        <Button type="submit" variant={ready ? "primary" : "secondary"} loading={busy} done={signedIn} doneLabel="Signed in" className={`mt-6 ${authBtn}`}>
          {busy ? "Setting it" : "Set password and sign in"}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function FinishPage() {
  return <React.Suspense fallback={null}><Finish /></React.Suspense>;
}
