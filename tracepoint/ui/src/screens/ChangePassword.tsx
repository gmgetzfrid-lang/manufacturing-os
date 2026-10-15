import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, LogOut, ShieldCheck, X } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Button, Field, Input, Mark, cx } from "../components/ui";

export function strength(pw: string) {
  const rules = [
    { ok: pw.length >= 10, label: "At least 10 characters" },
    { ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), label: "Upper and lower case" },
    { ok: /\d/.test(pw), label: "A number" },
    { ok: /[^A-Za-z0-9]/.test(pw), label: "A symbol" },
  ];
  const score = rules.filter((r) => r.ok).length + (pw.length >= 14 ? 1 : 0);
  return { rules, score };
}

export function PasswordMeter({ pw }: { pw: string }) {
  const { rules, score } = strength(pw);
  const colors = ["var(--color-bad)", "var(--color-bad)", "var(--color-warn)", "var(--color-warn)", "var(--color-ok)", "var(--color-ok)"];
  return (
    <div className="mt-3">
      <div className="flex gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-1.5 flex-1 rounded-full transition-colors" style={{ background: i < score ? colors[score] : "var(--color-surface-3)" }} />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {rules.map((r) => (
          <div key={r.label} className={cx("flex items-center gap-1.5 text-[12px]", r.ok ? "text-[var(--color-ok)]" : "text-[var(--color-text-faint)]")}>
            {r.ok ? <Check className="size-3.5" /> : <X className="size-3.5" />} {r.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChangePassword({ state, onDone }: { state: AppState; onDone: (s: AppState) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!next) { setProblem(null); return; }
    const t = setTimeout(() => api<{ problem: string | null }>("auth.check_password", { password: next }).then((r) => setProblem(r.problem)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [next]);
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready = useMemo(() => current && next && confirm === next && !problem, [current, next, confirm, problem]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<AppState>("auth.change_password", { current, new: next }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hero-backdrop relative flex h-full items-center justify-center overflow-hidden p-6">
      <div className="grid-lines absolute inset-0" />
      <form onSubmit={submit} className="relative card w-full max-w-[460px] p-8 shadow-2xl animate-[var(--animate-pop)]">
        <div className="flex items-center justify-between">
          <Mark size={40} />
          <button type="button" onClick={() => api<AppState>("auth.logout").then(onDone)} className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer">
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
        <div className="mt-6 flex size-11 items-center justify-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><KeyRound className="size-5" /></div>
        <h2 className="mt-4 text-[22px] font-[700] tracking-tight">Set your own password</h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Welcome{state.user?.name ? `, ${state.user.name}` : ""}. You signed in with a temporary password. Choose a new one before continuing — nothing else is available until you do.
        </p>
        <div className="mt-6 space-y-4">
          <Field label="Temporary password">
            <Input type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" error={next && problem ? problem : null}>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            {next && <PasswordMeter pw={next} />}
          </Field>
          <Field label="Confirm new password" error={mismatch ? "Passwords don't match." : null}>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </div>
        {error && <div className="mt-4 rounded-xl bg-[color-mix(in_srgb,var(--color-bad)_8%,transparent)] px-3.5 py-2.5 text-[13px] text-[var(--color-bad)]">{error}</div>}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!ready} className="mt-6 w-full">Save password and continue</Button>
        <div className="mt-5 flex items-start gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />
          Stored only as an Argon2id hash. For administrators it also locks their personal AI key, which nobody else can read or use.
        </div>
      </form>
    </div>
  );
}
