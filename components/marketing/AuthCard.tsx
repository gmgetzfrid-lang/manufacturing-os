// The front door (sign in, start a workspace, finish, set password).
//
// On a desktop the screen splits: a panel in the brand's deep color on the
// left says plainly what this is (the site's drawings, equipment and work)
// and what's inside, all things the app does; the form sits on the right,
// on the page. On a phone the panel becomes a short band above the form;
// the form itself is the same. The form: the page's title above it, the
// fields on one white sheet, one filled button.

import React from "react";
import Link from "next/link";
import { Logo } from "./PublicChrome";

/** What the app holds, said plainly (each one is a real part of it). */
const INSIDE = [
  "Drawings and documents under revision control, with a record of who signed.",
  "Drafting requests, from the ask to the issued package.",
  "Turnaround plans, shift reports and close-out.",
  "Answers from your own library, cited to the page.",
];

export function AuthCard({ title, sub, children, footer, wide = false }: {
  /** Wider, for longer forms (sign up). */
  wide?: boolean;
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** The form. */
  children: React.ReactNode;
  /** Links and small print under the card. */
  footer?: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] lg:grid lg:grid-cols-[minmax(360px,40fr)_minmax(0,60fr)]">
      {/* The brand side: a panel on the left on a desktop, a short band on
          top on a phone. */}
      <aside className="surface-side lg:sticky lg:top-0 lg:h-dvh flex flex-col px-5 sm:px-8 lg:px-12 py-4 lg:py-10">
        <Link href="/about" aria-label="About Manufacturing OS" className="self-start rounded-lg"><Logo /></Link>
        <p className="lg:hidden mt-1.5 text-[14px] text-[var(--color-text-muted)]">Your site&apos;s drawings, equipment and work.</p>
        <div className="max-lg:hidden mt-auto mb-auto max-w-[30rem]">
          <p className="font-display text-title font-semibold text-[var(--color-text)]">Your site&apos;s drawings, equipment and work, in one place.</p>
          <ul className="mt-6 space-y-3.5">
            {INSIDE.map((t) => (
              <li key={t} className="flex items-baseline gap-3 text-reading text-[var(--color-text-muted)]">
                <span aria-hidden className="w-1.5 h-1.5 shrink-0 rounded-full bg-[var(--color-text-faint)] -translate-y-0.5" />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="max-lg:hidden text-[13px] text-[var(--color-text-faint)]">
          Leaving takes one click: your whole dataset in standard formats.{" "}
          <Link href="/data-portability" className="text-[var(--color-accent-text)] hover:underline underline-offset-2">How</Link>
        </p>
      </aside>

      <main className="px-4 sm:px-8 py-8 sm:py-12 lg:py-16 flex justify-center lg:items-center">
        <div className={`w-full ${wide ? "max-w-[620px]" : "max-w-[440px]"}`}>
          <header className="page-head px-1 pb-6">
            <h1 className="font-display text-[32px] sm:text-[38px] leading-[1.1] font-bold text-[var(--color-text)]">{title}</h1>
            {sub && <p className="mt-2 text-reading text-[var(--color-text-muted)]">{sub}</p>}
          </header>
          <div className="relative rounded-panel bg-[var(--color-surface)] border border-[var(--color-border)] p-5 sm:p-7">
            {children}
          </div>
          {footer && <div className="mt-6 mx-1 space-y-3">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** A front-door field: 48 px tall, 16 px text (no zoom on a phone), the
 *  resting edge at 3:1, focus is the app-wide ring. */
export const authField =
  "w-full h-12 px-3.5 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-[16px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] aria-[invalid=true]:border-[var(--state-overdue)] disabled:opacity-60 transition-colors";

/** A front-door button: as tall as the fields. */
export const authBtn = "w-full !h-12 !text-[16px]";

export default AuthCard;
