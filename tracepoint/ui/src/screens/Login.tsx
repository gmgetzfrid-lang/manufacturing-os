import { useState } from "react";
import { ArrowRight, Lock, Mail, Moon, ShieldCheck, Sun, Zap, Network, FileSearch } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Button, Field, IconButton, Input, Mark } from "../components/ui";
import { useTheme } from "../lib/theme";

export function Login({ state, onDone }: { state: AppState; onDone: (s: AppState) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mode, toggle } = useTheme();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<AppState>("auth.login", { email, password }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full">
      {/* Brand panel */}
      <div className="hero-backdrop relative hidden w-[46%] overflow-hidden border-r border-[var(--color-border)] lg:block">
        <div className="grid-lines absolute inset-0" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3">
            <Mark size={46} />
            <div>
              <div className="text-[18px] font-[800] tracking-[0.22em]">TRACEPOINT</div>
              <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-text-faint)]">THOR document intelligence</div>
            </div>
          </div>
          <div className="max-w-lg">
            <h1 className="text-[40px] font-[750] leading-[1.08] tracking-tight">
              Every THOR document,<br /><span className="brand-text">one search away.</span>
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-text-muted)]">
              Search 200,000+ files by equipment number, tag, circuit, document type or plain words. Describe what you need in plain English, and see how equipment, drawings and inspections connect.
            </p>
            <div className="mt-8 grid gap-3">
              {[
                { icon: <Zap className="size-4" />, t: "Instant", d: "Sub-second results across the whole drive, with the reason for every match." },
                { icon: <Network className="size-4" />, t: "Connected", d: "Equipment, renumbered tags, drawing families and inspections linked together." },
                { icon: <ShieldCheck className="size-4" />, t: "Read-only on THOR", d: "TracePoint never changes, moves or deletes anything on the NAS." },
              ].map((x) => (
                <div key={x.t} className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_70%,transparent)] p-3.5 backdrop-blur">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">{x.icon}</div>
                  <div>
                    <div className="text-[13.5px] font-semibold">{x.t}</div>
                    <div className="text-[12.5px] text-[var(--color-text-muted)]">{x.d}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="text-[12px] text-[var(--color-text-faint)]">TracePoint {state.version} · Built for Kern Energy mechanical integrity</div>
        </div>
      </div>
      {/* Sign-in */}
      <div className="relative flex flex-1 items-center justify-center p-8">
        <IconButton label={mode === "dark" ? "Light mode" : "Dark mode"} onClick={toggle} className="absolute right-5 top-5">
          {mode === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </IconButton>
        <form onSubmit={submit} className="w-full max-w-[380px] animate-[var(--animate-rise)]">
          <div className="mb-8 lg:hidden"><Mark size={48} /></div>
          <div className="flex size-11 items-center justify-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><FileSearch className="size-5" /></div>
          <h2 className="mt-5 text-[26px] font-[700] tracking-tight">Sign in</h2>
          <p className="mt-1.5 text-[13.5px] text-[var(--color-text-muted)]">Use the profile your TracePoint administrator created for you.</p>
          <div className="mt-7 space-y-4">
            <Field label="Email">
              <Input autoFocus type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@kernenergy.com" icon={<Mail className="size-4" />} />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" icon={<Lock className="size-4" />} />
            </Field>
          </div>
          {error && <div className="mt-4 rounded-xl border border-[color-mix(in_srgb,var(--color-bad)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-bad)_8%,transparent)] px-3.5 py-2.5 text-[13px] text-[var(--color-bad)]">{error}</div>}
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email || !password} className="mt-6 w-full">
            Sign in <ArrowRight className="size-4" />
          </Button>
          <p className="mt-6 text-center text-[12px] text-[var(--color-text-faint)]">No account? Only an administrator can create profiles.</p>
        </form>
      </div>
    </div>
  );
}
