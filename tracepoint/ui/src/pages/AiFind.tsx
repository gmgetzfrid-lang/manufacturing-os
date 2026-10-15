import { useEffect, useState } from "react";
import { ArrowUp, Loader2, Search, Sparkles, X } from "lucide-react";
import { onEvent } from "../lib/api";
import type { Hit } from "../lib/types";
import { Button, cx } from "../components/ui";

export interface AiFindResult {
  understanding?: string;
  searches: { query: string; why: string; total: number }[];
  hits: Hit[];
  picked?: number;
  message?: string;
  followup?: { question: string; options: string[] } | null;
  ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  model?: string;
}

export interface AiTurn { q: string; result?: AiFindResult; error?: string }

/** Conversation panel for "Find it with AI". The parent owns the turns so
 *  the hit list can show the latest AI picks. */
export function AiFindPanel({ turns, busy, onAsk, onClose, onRunSearch }: { turns: AiTurn[]; busy: boolean; onAsk: (q: string) => void; onClose: () => void; onRunSearch: (q: string) => void }) {
  const [reply, setReply] = useState("");
  const [status, setStatus] = useState<string[]>([]);
  useEffect(() => { if (busy) setStatus([]); }, [busy]);
  useEffect(() => onEvent("aifind", (p: { status: string }) => setStatus((s) => [...s, p.status])), []);
  const last = turns[turns.length - 1];
  return (
    <div className="mx-3 mt-3 overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--color-violet)_30%,transparent)] bg-[var(--color-surface)] shadow-md animate-[var(--animate-rise)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-violet)_6%,transparent)] px-4 py-2.5">
        <Sparkles className="size-4 text-[var(--color-violet)]" />
        <span className="text-[13px] font-semibold">Find it with AI</span>
        <span className="text-[12px] text-[var(--color-text-faint)]">Reads names, folders and dates — not file contents</span>
        <button onClick={onClose} className="ml-auto text-[var(--color-text-faint)] hover:text-[var(--color-text)] cursor-pointer" title="Close AI and show normal results"><X className="size-4" /></button>
      </div>
      <div className="max-h-[300px] space-y-3 overflow-y-auto px-4 py-3">
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <div className="flex justify-end"><div className="max-w-[85%] rounded-xl rounded-br-sm bg-[var(--color-surface-3)] px-3 py-1.5 text-[13px]">{t.q}</div></div>
            {t.error && <div className="rounded-lg bg-[color-mix(in_srgb,var(--color-bad)_8%,transparent)] px-3 py-2 text-[13px] text-[var(--color-bad)]">{t.error}</div>}
            {t.result && (
              <div className="text-[13px] leading-relaxed">
                {t.result.understanding && <div className="text-[var(--color-text-muted)]"><span className="font-medium text-[var(--color-text)]">Looking for:</span> {t.result.understanding}</div>}
                {t.result.message && <div className="mt-1">{t.result.message}</div>}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11.5px] text-[var(--color-text-faint)]">Searched:</span>
                  {t.result.searches.map((s) => (
                    <button key={s.query} onClick={() => onRunSearch(s.query)} title={`${s.why} · ${s.total} results — click to run it yourself`} className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[11.5px] hover:border-[var(--color-violet)] cursor-pointer">
                      <Search className="size-3" />{s.query}<span className="text-[var(--color-text-faint)]">{s.total}</span>
                    </button>
                  ))}
                </div>
                {i === turns.length - 1 && t.result.followup && (
                  <div className="mt-2.5">
                    <div className="text-[12.5px] font-medium">{t.result.followup.question}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {t.result.followup.options.map((o) => <Button key={o} size="sm" variant="soft" onClick={() => onAsk(o)}>{o}</Button>)}
                    </div>
                  </div>
                )}
                {t.result.ms != null && <div className="mt-1.5 text-[11px] text-[var(--color-text-faint)]">{t.result.model} · {(t.result.ms / 1000).toFixed(1)} s · {t.result.tokens_in?.toLocaleString()} / {t.result.tokens_out?.toLocaleString()} tokens</div>}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="space-y-1">
            {(status.length ? status : ["Thinking…"]).map((s, i, arr) => (
              <div key={i} className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                {i === arr.length - 1 ? <Loader2 className="size-3.5 animate-spin text-[var(--color-violet)]" /> : <span className="size-1.5 rounded-full bg-[var(--color-ok)]" />}{s}
              </div>
            ))}
          </div>
        )}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) { onAsk(reply.trim()); setReply(""); } }} className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-2">
        <input value={reply} onChange={(e) => setReply(e.target.value)} disabled={busy} placeholder={last?.result?.followup ? "Answer, or tell it more…" : "Not quite? Tell it more — “the one from 2019”, “the inspection report, not the photos”…"} className="h-9 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-[var(--color-text-faint)]" />
        <button type="submit" disabled={busy || !reply.trim()} className={cx("flex size-8 items-center justify-center rounded-lg text-white transition cursor-pointer disabled:opacity-40", "bg-[var(--color-violet)]")}><ArrowUp className="size-4" /></button>
      </form>
    </div>
  );
}
