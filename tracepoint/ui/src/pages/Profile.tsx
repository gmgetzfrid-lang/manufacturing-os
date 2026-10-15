import { useState } from "react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Avatar, Button, Field, Input, Section, cx, useToast } from "../components/ui";
import { PasswordMeter } from "../screens/ChangePassword";
import { initials, when } from "../lib/format";

export function ProfilePage({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const u = state.user!;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-8 py-7">
        <div className="flex items-center gap-4">
          <Avatar text={initials(u.name, u.email)} size={56} />
          <div className="flex-1">
            <h1 className="text-[22px] font-[700] tracking-tight">{u.name || u.email}</h1>
            <div className="text-[13px] text-[var(--color-text-muted)]">{u.email} · <span className="capitalize">{u.role}</span> · last sign-in {when(u.last_login_at)}</div>
          </div>
        </div>
        <div className="mt-6"><Account state={state} setState={setState} /></div>
      </div>
    </div>
  );
}

function Account({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [conf, setConf] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [openMode, setOpenMode] = useState(state.prefs.open_mode ?? "copy");
  const save = async () => {
    setBusy(true);
    try { setState(await api<AppState>("auth.change_password", { current: cur, new: next })); setCur(""); setNext(""); setConf(""); toast("ok", "Password changed."); } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const setMode = async (m: string) => { setOpenMode(m); await api("auth.set_pref", { key: "open_mode", value: m }); toast("ok", "Saved"); };
  return (
    <div className="grid grid-cols-2 gap-6">
      <Section title="Change password" subtitle="At least 10 characters, mixing three of: lowercase, uppercase, numbers, symbols">
        <div className="space-y-3.5">
          <Field label="Current password"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label="New password"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />{next && <PasswordMeter pw={next} />}</Field>
          <Field label="Confirm" error={conf && conf !== next ? "Passwords don't match." : null}><Input type="password" value={conf} onChange={(e) => setConf(e.target.value)} /></Field>
          <Button variant="primary" loading={busy} disabled={!cur || !next || conf !== next} onClick={save}>Change password</Button>
        </div>
      </Section>
      <Section title="Opening files" subtitle="How Open behaves for files on THOR">
        <div className="space-y-2">
          {[
            { id: "copy", t: "Read-only copy (recommended)", d: "Opens a temporary copy marked read-only. Nothing you do can change the file on THOR." },
            { id: "original", t: "The original on THOR", d: "Opens the actual file. Programs like Word or Excel could save changes back to THOR." },
          ].map((o) => (
            <button key={o.id} onClick={() => setMode(o.id)} className={cx("flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition cursor-pointer", openMode === o.id ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]")}>
              <span className={cx("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2", openMode === o.id ? "border-[var(--color-accent)]" : "border-[var(--color-border-strong)]")}>{openMode === o.id && <span className="size-2 rounded-full bg-[var(--color-accent)]" />}</span>
              <span><span className="block text-[13.5px] font-semibold">{o.t}</span><span className="block text-[12.5px] text-[var(--color-text-muted)]">{o.d}</span></span>
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
