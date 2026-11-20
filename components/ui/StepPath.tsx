"use client";

// The steps of a flow, joined by a line so they read as one path. Done steps
// are filled, the current one is ringed, later ones are faint. On a phone the
// labels fold to "Step 2 of 4: Name".
import React from "react";
import { Check } from "lucide-react";

export default function StepPath({ steps, current, onPick, className = "", onDark = false }: {
  steps: string[];
  current: number;
  /** Drawn on the dark band (white path, light labels). */
  onDark?: boolean;
  /** Tap a done step to go back to it. */
  onPick?: (i: number) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className={`sm:hidden text-[12.5px] font-bold ${onDark ? "text-white" : "text-[var(--color-text)]"}`}>
        Step {Math.min(current + 1, steps.length)} of {steps.length}: {steps[current] ?? ""}
      </p>
      <ol className="flex items-start" aria-label="Steps">
        {steps.map((label, i) => {
          const done = i < current, now = i === current;
          const dot = (
            <span className={`relative z-10 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black shrink-0 ${
              onDark
                ? (done ? "bg-white text-[var(--color-band)]" : now ? "border-2 border-white bg-[var(--color-band)] text-white" : "border border-[var(--color-ink-line)] bg-[var(--color-band)] text-[var(--color-ink-muted)]")
                : done ? "bg-[var(--color-text)] text-[var(--color-surface)]"
                : now ? "border-2 border-[var(--color-text)] bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-faint)]"}`}>
              {done ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </span>
          );
          return (
            <li key={label + i} className="relative flex-1 flex flex-col items-center min-w-0" aria-current={now ? "step" : undefined}>
              {i > 0 && <span aria-hidden className={`absolute top-3 right-1/2 w-full h-0.5 ${onDark ? (i <= current ? "bg-white" : "bg-[var(--color-ink-line)]") : i <= current ? "bg-[var(--color-text)]" : "bg-[var(--color-border)]"}`} />}
              {done && onPick
                ? <button type="button" onClick={() => onPick(i)} aria-label={`Back to ${label}`} className="relative z-10 rounded-full">{dot}</button>
                : dot}
              <span className={`hidden sm:block mt-1.5 px-1 text-center text-[12px] leading-tight truncate max-w-full ${onDark ? (now ? "font-bold text-white" : "text-[var(--color-ink-muted)]") : now ? "font-bold text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
