import { useEffect, useState } from "react";
import { FolderSync, Monitor, RefreshCw, Users, WifiOff } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Button, Input, Mark } from "../components/ui";

interface TeamInfo { found?: string | null; default: string }

/** Shown when there's nothing to search yet: not connected to THOR, a first
 *  run, or an account that can't open any indexed folder. */
export function Welcome({ state, refresh, onContinue }: { state: AppState; refresh: () => void; onContinue: () => void }) {
  const [info, setInfo] = useState<TeamInfo | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<TeamInfo>("team.status").then((i) => { setInfo(i); setPath(i.found ?? i.default); }).catch(() => {}); }, []);
  const run = async (cmd: string, body: Record<string, unknown> = {}) => {
    setBusy(true); setErr(null);
    try { await api(cmd, body); setTimeout(refresh, 400); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const t = state.team;
  const canScan = state.user?.role === "admin" || state.user?.role === "indexer";
  let body;
  if (t.mode === "offline") {
    body = (
      <>
        <WifiOff className="mx-auto size-9 text-[var(--color-warn)]" />
        <h1 className="mt-3 text-[22px] font-[700]">You're not connected to THOR</h1>
        <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">TracePoint can't reach <span className="font-mono">{t.folder}</span>. Connect to the company network or VPN. TracePoint keeps trying by itself.</p>
        <Button variant="primary" className="mt-5" loading={busy} icon={<RefreshCw className="size-4" />} onClick={() => run("connection.retry")}>Try again</Button>
      </>
    );
  } else if (t.mode === "team") {
    body = (
      <>
        <Users className="mx-auto size-9 text-[var(--color-accent)]" />
        <h1 className="mt-3 text-[22px] font-[700]">Nothing to search yet</h1>
        <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">{state.index.message}</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button loading={busy} icon={<RefreshCw className="size-4" />} onClick={() => run("index.reload")}>Check again</Button>
          {canScan && <Button variant="primary" onClick={onContinue}>Scan THOR (Sources)</Button>}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h1 className="text-[24px] font-[750] tracking-tight">Welcome to TracePoint</h1>
        <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">Signed in as <b>{state.user?.account}</b> — your Windows account. No passwords.</p>
        <div className="mt-6 space-y-3 text-left">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="flex items-center gap-2 text-[15px] font-semibold"><FolderSync className="size-4 text-[var(--color-accent)]" />{info?.found ? "Join your team" : "Use your team's shared folder"}</div>
            <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{info?.found ? "TracePoint is already set up here. Join to search what your Windows account can open." : "If TracePoint is set up there, you'll join it. If not, you'll set it up and become its first administrator."}</p>
            <div className="mt-3 flex gap-2">
              <div className="flex-1"><Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" /></div>
              <Button variant="primary" loading={busy} onClick={() => run("team.setup", { path })}>{info?.found ? "Join" : "Set up / join"}</Button>
            </div>
          </div>
          <button onClick={onContinue} className="flex w-full items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left hover:border-[var(--color-border-strong)] cursor-pointer">
            <Monitor className="size-5 text-[var(--color-text-muted)]" />
            <span><span className="block text-[15px] font-semibold">Just this PC</span><span className="block text-[13px] text-[var(--color-text-muted)]">Scan a THOR folder yourself (Sources). Nothing is shared.</span></span>
          </button>
        </div>
      </>
    );
  }
  return (
    <div className="hero-backdrop relative flex h-full items-center justify-center overflow-y-auto">
      <div className="grid-lines absolute inset-0" />
      <div className="relative w-full max-w-[560px] px-6 py-10 text-center animate-[var(--animate-rise)]">
        <div className="mb-5 flex justify-center"><Mark size={48} /></div>
        {body}
        {err && <div className="mt-4 rounded-xl bg-[color-mix(in_srgb,var(--color-bad)_10%,transparent)] p-3 text-left text-[13px] text-[var(--color-bad)]">{err}</div>}
      </div>
    </div>
  );
}
