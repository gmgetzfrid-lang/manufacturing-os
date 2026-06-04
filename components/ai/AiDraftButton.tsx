"use client";

// AiDraftButton — a small, in-contract ambient-AI affordance.
//
// Strictly within the platform's AI rules: it NEVER writes to the database. It
// drafts text from context the caller assembles, shows it with a mock/AI badge,
// and offers Copy + an optional "Use this" that hands the text back to the
// caller (which puts it in a field for the human to edit). Works on the local
// heuristic provider today; gets genuinely smart when GEMINI_API_KEY is set.

import React from "react";
import { Sparkles, Loader2, Copy, Check, CornerDownLeft, X } from "lucide-react";
import { getAiProvider } from "@/lib/ai";

type Mode = "summarize" | "handoff" | "followups";

export default function AiDraftButton({
  label = "AI draft",
  mode = "handoff",
  buildContext,
  onUse,
  className = "",
}: {
  label?: string;
  /** Which provider method to use. handoff → narrative; summarize → tighten;
   *  followups → bulleted next steps. */
  mode?: Mode;
  /** Assemble the context the AI should work from, at click time. */
  buildContext: () => string;
  /** Receive the accepted draft (the caller drops it into a field). */
  onUse?: (text: string) => void;
  className?: string;
}) {
  const ai = getAiProvider();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const run = async () => {
    const ctx = buildContext().trim();
    if (!ctx) { setErr("Add a bit of detail first — there's nothing to draft from yet."); setOpen(true); return; }
    setOpen(true); setBusy(true); setErr(null); setDraft(null);
    try {
      let out: string;
      if (mode === "summarize") out = await ai.summarize(ctx);
      else if (mode === "followups") out = (await ai.suggestFollowups(ctx)).map((l) => `• ${l}`).join("\n");
      else out = await ai.generateHandoff(ctx);
      setDraft(out);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!draft) return;
    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={run}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)] text-xs font-bold transition-colors"
      >
        <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" /> {label}
        <span className="text-[9px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">{ai.isReal ? "AI" : "mock"}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
            <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" />
            <span className="text-xs font-black text-[var(--color-text)] flex-1">Draft ({ai.isReal ? "AI" : "local heuristic"})</span>
            <button onClick={() => setOpen(false)} className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-3.5 h-3.5" /></button>
          </div>
          <div className="p-3">
            {busy ? (
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] py-4 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Drafting…</div>
            ) : err ? (
              <div className="text-xs text-rose-600">{err}</div>
            ) : draft ? (
              <>
                <div className="text-xs text-[var(--color-text)] whitespace-pre-wrap bg-[var(--color-surface-2)] rounded-lg p-2.5 max-h-56 overflow-y-auto leading-relaxed">{draft}</div>
                <div className="flex items-center gap-2 mt-2">
                  <button onClick={copy} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--color-border)] text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />} {copied ? "Copied" : "Copy"}
                  </button>
                  {onUse && (
                    <button onClick={() => { onUse(draft); setOpen(false); }} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-white text-xs font-bold hover:bg-[var(--color-accent-hover)]">
                      <CornerDownLeft className="w-3.5 h-3.5" /> Use this
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-[var(--color-text-faint)] mt-2">Review before sending — AI assists, you decide. Nothing is saved automatically.</p>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
