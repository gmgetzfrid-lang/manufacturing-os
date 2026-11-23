"use client";

// Button: the one token-driven button. Four kinds, so only one thing on a
// screen shouts:
//   primary     filled with the accent: the ONE main action per screen
//               or dialog
//   secondary   white with a hairline edge
//   tertiary    a link (no box)
//   danger      red words on a secondary button; always confirm first
//   ghost       no edge (toolbars, icon rows)
// 40 px tall, 44 on touch screens, radius 8. Focus is the app-wide ring.
//
// Every tap answers: `loading` puts a spinner inside the button (and
// blocks a second tap); `done` turns it into a check and a past-tense
// word ("Sent", "Locked") for about 1.5 s, then it goes back. The
// useActionFeedback hook runs both around an async action:
//
//   const send = useActionFeedback();
//   <Button {...send.state} doneLabel="Sent" onClick={() => send.run(doSend)}>Send</Button>

import React from "react";
import { Check, Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] border-transparent",
  secondary: "bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border-strong)] hover:border-[var(--color-border-control)]",
  tertiary: "bg-transparent border-transparent text-[var(--color-accent-text)] hover:underline underline-offset-2 !px-1",
  ghost: "bg-transparent hover:bg-[var(--color-surface-2)] text-[var(--color-text)] border-transparent",
  danger: "bg-[var(--color-surface)] text-[var(--state-overdue-text)] border-[var(--color-border-strong)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_6%,var(--color-surface))] hover:border-[color-mix(in_srgb,var(--state-overdue)_45%,var(--color-border-strong))]",
};
const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 pointer-coarse:h-10 px-3 text-[13px] gap-1.5",
  md: "h-10 pointer-coarse:h-11 px-4 text-[15px] gap-2",
};

/** How long the done state shows before the button goes back. */
export const DONE_MS = 1500;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A spinner inside the button; the button can't be pressed again. */
  loading?: boolean;
  /** When this turns true the button shows a check and `doneLabel` for
   *  about 1.5 s, then its own label again. */
  done?: boolean;
  /** The past-tense word for the done state ("Sent", "Saved", "Locked"). */
  doneLabel?: string;
}

export function Button({
  variant = "primary", size = "md", loading, done, doneLabel = "Done", disabled, className = "", children, ...rest
}: ButtonProps) {
  // `done` turning true starts the check; a timer takes it away again.
  const [prevDone, setPrevDone] = React.useState(!!done);
  const [showDone, setShowDone] = React.useState(false);
  if (!!done !== prevDone) {
    setPrevDone(!!done);
    if (done) setShowDone(true);
  }
  React.useEffect(() => {
    if (!showDone) return;
    const t = window.setTimeout(() => setShowDone(false), DONE_MS);
    return () => window.clearTimeout(t);
  }, [showDone]);
  const iconCls = size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4";
  const gap = size === "sm" ? "gap-1.5" : "gap-2";
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`relative inline-flex items-center justify-center whitespace-nowrap font-semibold rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${loading ? "disabled:opacity-80 cursor-progress" : ""} ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    >
      {/* Both labels share one cell, so the button keeps its width. */}
      <span className="grid">
        <span className={`[grid-area:1/1] inline-flex items-center justify-center ${gap} ${showDone ? "invisible" : ""}`}>
          {loading && <Loader2 aria-hidden className={`${iconCls} animate-spin`} />}
          {children}
        </span>
        <span aria-hidden={!showDone} className={`[grid-area:1/1] inline-flex items-center justify-center gap-1.5 ${showDone ? "" : "invisible"}`}>
          <Check aria-hidden className={iconCls} />{doneLabel}
        </span>
      </span>
      <span className="sr-only" aria-live="polite">{showDone ? doneLabel : ""}</span>
    </button>
  );
}

/** Loading and done for one async action:
 *  `const save = useActionFeedback(); <Button {...save.state} doneLabel="Saved" onClick={() => save.run(doSave)}>`.
 *  A failure clears the spinner and is thrown on to the caller. */
export function useActionFeedback() {
  const [loading, setLoading] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const run = React.useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setDone(false);
    setLoading(true);
    try {
      const out = await fn();
      setLoading(false);
      setDone(true);
      window.setTimeout(() => setDone(false), DONE_MS);
      return out;
    } catch (e) {
      setLoading(false);
      throw e;
    }
  }, []);
  return { run, loading, done, state: { loading, done } };
}

export default Button;
