"use client";

// /signup/finish?session_id=... - where the payment page sends the payer.
// Makes sure their new workspace exists, has them set their password once,
// and signs them in (lib/workspaceSignupServer).

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Loader2, Lock } from "lucide-react";
import { AuthCard } from "@/components/marketing/AuthCard";
import { btnPrimary, link, label } from "@/components/admin/kit";
import { passwordProblem } from "@/lib/signinPolicy";
import { supabase } from "@/lib/supabase";

const inputCls = "w-full h-11 pl-10 pr-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-md text-[15px] text-[var(--color-text)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 transition-colors placeholder:text-[var(--color-text-faint)]";
const iconCls = "absolute left-3 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[var(--color-text-faint)] pointer-events-none";

type State = { k: "loading" } | { k: "set"; email: string; company: string } | { k: "done"; company: string } | { k: "error"; message: string };

function Finish() {
  const router = useRouter();
  const sessionId = useSearchParams().get("session_id") ?? "";
  const [state, setState] = useState<State>({ k: "loading" });
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // The workspace may take a moment after the payment: ask a few times.
    const ask = async (tries: number): Promise<void> => {
      const res = await fetch("/api/signup/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
      const body = (await res.json().catch(() => null)) as { email?: string; company?: string; needsPassword?: boolean; error?: string } | null;
      if (!live) return;
      if (res.status === 402 && tries > 0) { await new Promise((r) => setTimeout(r, 2500)); return ask(tries - 1); }
      if (!res.ok || !body?.email) { setState({ k: "error", message: body?.error ?? "This page couldn't be opened." }); return; }
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
      router.replace("/admin/users");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (state.k === "loading") {
    return (
      <AuthCard title="Setting up your workspace." sub="This takes a few seconds after paying.">
        <p role="status" className="flex items-center gap-2 text-[15px] text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /> Working…</p>
      </AuthCard>
    );
  }
  if (state.k === "error") {
    return (
      <AuthCard title="Something's not right." footer={<p className="text-[14px]"><Link href="/" className={link}>Go to sign in</Link></p>}>
        <p role="alert" className="flex items-start gap-2 text-[15px] font-semibold text-[var(--state-overdue)]"><AlertCircle className="w-4 h-4 shrink-0 mt-1" /> {state.message}</p>
      </AuthCard>
    );
  }
  if (state.k === "done") {
    return (
      <AuthCard title="Your workspace is ready." sub={state.company}>
        <p className="text-[15px] text-[var(--color-text)]">Your password is set. Sign in to start adding your people.</p>
        <Link href="/" className={`${btnPrimary} w-full h-11 mt-5`}>Sign in</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Set your password." sub={`${state.company} · ${state.email}`}>
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 text-[var(--state-overdue)]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-[14px] font-semibold">{error}</p>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="fin-pw" className={label}>Password</label>
          <div className="relative">
            <Lock className={iconCls} />
            <input id="fin-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} className={inputCls} placeholder="At least 12 characters" autoComplete="new-password" minLength={12} required />
          </div>
        </div>
        <div>
          <label htmlFor="fin-pw2" className={label}>Password again</label>
          <div className="relative">
            <Lock className={iconCls} />
            <input id="fin-pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={inputCls} autoComplete="new-password" minLength={12} required />
          </div>
        </div>
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full h-11`}>
          {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> Setting it…</> : "Set password and sign in"}
        </button>
      </form>
    </AuthCard>
  );
}

export default function FinishPage() {
  return <React.Suspense fallback={null}><Finish /></React.Suspense>;
}
