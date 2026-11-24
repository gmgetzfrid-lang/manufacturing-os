// The front door (sign in, start a workspace, finish, set password).
//
// On a desktop the screen splits: a panel in the brand's deep color on the
// left says plainly what this is (the site's drawings, equipment and work)
// and what's inside, all things the app does, over a fragment of a P&ID in
// fine lines (the plant the app holds the drawings of), with a glimpse of
// the app's own Home answer; the form sits on the right, on the page. On a
// phone the panel becomes a short band above the form, the mark and one
// line beside a slice of the same drawing; the form itself is the same.
// The form: the page's title above it, the fields on one white sheet, one
// filled button.

import React from "react";
import Link from "next/link";
import { Logo } from "./PublicChrome";
import { PlantLineArt } from "./PlantLineArt";

/** What the app holds, said plainly (each one is a real part of it). */
const INSIDE = [
  "Drawings and documents under revision control, with a record of who signed.",
  "Drafting requests, from the ask to the issued package.",
  "Turnaround plans, shift reports and close-out.",
  "Answers from your own library, cited to the page.",
];

/** A small, true-to-life piece of the app: Home's answer and the one
 *  thing waiting, as the app draws them (decoration, hidden from screen
 *  readers). */
function Glimpse() {
  return (
    <div aria-hidden className="on-sheet w-[316px] rounded-panel bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-float)] p-4 select-none">
      <div className="text-[12px] text-[var(--color-text-muted)]">Home</div>
      <div className="mt-0.5 font-display text-[20px] leading-tight font-semibold text-[var(--color-text)]">1 thing needs you.</div>
      <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-start gap-2.5">
        <span className="mt-[7px] w-[7px] h-[7px] shrink-0 rounded-full bg-[var(--state-held)]" />
        <div className="min-w-0">
          <div className="text-[14px] text-[var(--color-text)] truncate"><span className="ui-id">KE-DDRT-26-0042</span> Issue the IFC package</div>
          <div className="mt-0.5 text-[12px] font-semibold text-[var(--state-held-text)]">Waiting on you</div>
        </div>
      </div>
      <div className="mt-2.5 text-[12px] text-[var(--color-text-muted)]">Rev C of 100-PID-042 issued by J. Ortiz, 2 h ago</div>
    </div>
  );
}

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
    <div className="min-h-dvh bg-[var(--color-canvas)] lg:grid lg:grid-cols-[minmax(380px,42fr)_minmax(0,58fr)]">
      {/* The brand side: a panel on the left on a desktop, a short band on
          top on a phone. The drawing sits behind, faint, in the brand's
          light tint: on a desktop the lower part of the panel, running off
          its edges like a sheet that goes on; on a phone a slice on the
          band's right. */}
      <aside className="surface-side relative isolate overflow-hidden lg:sticky lg:top-0 lg:h-dvh flex flex-col px-5 sm:px-8 lg:px-12 pt-5 pb-6 lg:py-10">
        <PlantLineArt preserveAspectRatio="xMidYMid slice"
          className="lg:hidden absolute -z-10 right-0 top-0 h-full w-[72%] text-[var(--color-accent-text)] [mask-image:linear-gradient(to_right,transparent,black_60%)]" />
        <PlantLineArt preserveAspectRatio="xMaxYMax slice"
          className="max-lg:hidden absolute -z-10 right-0 bottom-0 w-[118%] h-[60%] text-[var(--color-accent-text)] [mask-image:linear-gradient(to_bottom,transparent,black_38%)]" />
        <Link href="/about" aria-label="About Manufacturing OS" className="self-start rounded-lg"><Logo /></Link>
        <p className="lg:hidden mt-3 max-w-[62%] text-[14px] leading-snug text-[var(--color-text-muted)]">Your site&apos;s drawings, equipment and work, in one place.</p>
        <div className="max-lg:hidden mt-[9vh] max-w-[30rem]">
          <p className="font-display text-title font-semibold text-[var(--color-text)]">Your site&apos;s drawings, equipment and work, in one place.</p>
          <ul className="mt-6 space-y-3.5">
            {INSIDE.map((t) => (
              <li key={t} className="flex items-baseline gap-3 text-reading text-[var(--color-text-muted)]">
                <span aria-hidden className="w-1.5 h-1.5 shrink-0 rounded-full bg-[var(--color-text-faint)] -translate-y-0.5" />
                {t}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[13px] text-[var(--color-text-muted)]">
            Leaving takes one click: your whole dataset in standard formats.{" "}
            <Link href="/data-portability" className="text-[var(--color-accent-text)] hover:underline underline-offset-2">How</Link>
          </p>
        </div>
        <div className="max-lg:hidden mt-auto pt-10"><Glimpse /></div>
      </aside>

      <main className="px-4 sm:px-8 py-8 sm:py-12 lg:py-16 flex justify-center lg:items-center">
        <div className={`w-full ${wide ? "max-w-[620px]" : "max-w-[440px]"}`}>
          <header className="page-head px-1 pb-6">
            <h1 className="font-display text-[32px] sm:text-[38px] leading-[1.1] font-bold text-[var(--color-text)]">{title}</h1>
            {sub && <p className="mt-2 text-reading text-[var(--color-text-muted)]">{sub}</p>}
          </header>
          <div className="relative rounded-panel bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-card)] p-5 sm:p-7">
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
