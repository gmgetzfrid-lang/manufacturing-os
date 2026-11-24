"use client";

// NeededFromYou: the top of any screen someone lands on because the app
// wants something from them. One short line says what is wanted; under it,
// why (the rule, or who asked) and by when, in plain dates; then the
// buttons, one of them the primary. When the thing is done, the same box
// says so and what happens next, so the tap is answered where it was made.
//
//   <NeededFromYou
//     what="Periodic review due Nov 12: confirm this procedure is still right, or start a revision."
//     why="The folder's review rule: every 12 months. Last reviewed Nov 12, 2025."
//     when={{ text: "Overdue since Nov 12 (12 days)", late: true }}
//   >
//     <Button>Still current</Button>
//     <Button variant="secondary">Needs changes</Button>
//   </NeededFromYou>

import React from "react";
import { CheckCircle2 } from "lucide-react";

export interface NeededWhen {
  /** "Due Nov 29 (in 5 days)", "Overdue since Nov 12 (12 days)". */
  text: string;
  late?: boolean;
  soon?: boolean;
}

export interface NeededFromYouProps {
  /** One short line: what is wanted. */
  what: React.ReactNode;
  /** Why it is asked: the rule and its interval, or who asked. */
  why?: React.ReactNode;
  /** By when, in plain dates. */
  when?: NeededWhen | null;
  /** The buttons: one primary, the rest secondary or tertiary. */
  children?: React.ReactNode;
  /** A line under the buttons: what a button does, or an error. */
  note?: React.ReactNode;
  /** Done: the box says so (in `what`) and drops the buttons' urgency. */
  done?: boolean;
  /** Still finding out what is pending: a quiet placeholder line. */
  loading?: boolean;
  /** The small label over the line ("Needed from you"). */
  label?: React.ReactNode;
  className?: string;
  id?: string;
}

export function NeededFromYou({
  what, why, when, children, note, done = false, loading = false,
  label = "Needed from you", className = "", id,
}: NeededFromYouProps) {
  const edge = done
    ? "var(--state-released)"
    : when?.late ? "var(--state-overdue)" : when?.soon ? "var(--state-held)" : "var(--color-accent)";
  return (
    <section
      id={id}
      aria-label={typeof label === "string" ? label : "Needed from you"}
      aria-busy={loading || undefined}
      className={`relative rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] pl-4 pr-4 sm:pl-5 sm:pr-5 py-4 overflow-hidden ${className}`}
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: edge }} />
      <p className="text-[13px] text-[var(--color-text-muted)] flex items-center gap-1.5">
        {done && <CheckCircle2 aria-hidden className="w-3.5 h-3.5 text-[var(--state-released)]" />}
        {done ? "Done" : label}
      </p>
      {loading ? (
        <div className="mt-2 space-y-2" aria-hidden>
          <div className="ui-skeleton h-5 w-4/5 rounded" />
          <div className="ui-skeleton h-4 w-3/5 rounded" />
        </div>
      ) : (
        <>
          <p className="mt-1 text-[17px] leading-snug font-semibold text-[var(--color-heading)] break-words">{what}</p>
          {(why || when) && (
            <dl className="mt-2 space-y-1 text-[14px] leading-snug">
              {why && (
                <div className="flex gap-2">
                  <dt className="shrink-0 w-14 text-[var(--color-text-muted)]">Why</dt>
                  <dd className="min-w-0 text-[var(--color-text)]">{why}</dd>
                </div>
              )}
              {when && (
                <div className="flex gap-2">
                  <dt className="shrink-0 w-14 text-[var(--color-text-muted)]">By when</dt>
                  <dd className={`min-w-0 ${when.late ? "font-semibold text-[var(--state-overdue-text)]" : when.soon ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`}>{when.text}</dd>
                </div>
              )}
            </dl>
          )}
          {children && <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>}
          {note && <div className="mt-2 text-[14px] text-[var(--color-text-muted)]">{note}</div>}
        </>
      )}
    </section>
  );
}

export default NeededFromYou;
