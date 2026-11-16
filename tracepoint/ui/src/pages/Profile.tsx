import { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Avatar, Section, cx, useToast } from "../components/ui";
import { initials } from "../lib/format";

export function ProfilePage({ state, setState }: { state: AppState; setState: (s: AppState) => void; refresh?: () => void }) {
  const u = state.user!;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-8 py-7">
        <div className="flex items-center gap-4">
          <Avatar text={initials(u.name, "")} size={56} />
          <div className="flex-1">
            <h1 className="text-[22px] font-[700] tracking-tight">{u.name}</h1>
            <div className="text-[13px] text-[var(--color-text-muted)]">{u.account} · <span className="capitalize">{u.role}</span> · signed in with Windows</div>
          </div>
        </div>
        <div className="mt-6"><Account state={state} setState={setState} /></div>
      </div>
    </div>
  );
}

function Account({ state }: { state: AppState; setState: (s: AppState) => void }) {
  const toast = useToast();
  const [openMode, setOpenMode] = useState(state.prefs.open_mode ?? "copy");
  const setMode = async (m: string) => { setOpenMode(m); await api("auth.set_pref", { key: "open_mode", value: m }); toast("ok", "Saved"); };
  const u = state.user!;
  return (
    <div className="grid grid-cols-2 gap-6">
      <Section title="Your account" subtitle="TracePoint has no passwords of its own">
        <div className="space-y-3 text-[13px] leading-relaxed">
          <div className="rounded-xl bg-[var(--color-surface-2)] p-3"><div className="font-mono text-[13px]">{u.account}</div><div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">You're signed in as the Windows account that started TracePoint.</div></div>
          <p className="flex gap-2.5"><Lock className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />You only ever see THOR files and folders your Windows account can open. If something is missing that you should see, ask IT for access to that folder.</p>
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
