// The front door (sign in, start a workspace, finish, set password): a
// drawing sheet you sign in on. Engineers sign drawings in the title
// block, so the form IS the title block: the sheet behind draws itself and
// keeps running (components/auth/Blueprint), and the card carries the
// block's last cells: the STATUS of the sign-in and the SIGNED line, which
// fills with the person's name when they're in. (No date or revision row:
// the owner called it noise.)
//
// On a desktop the sheet fills the screen and the title block sits bottom
// right, where it lives on a real drawing. On a phone it all fits one
// screen: the title block sits at the bottom (in reach of a thumb) and the
// drawing fills what is left above it, never a fixed share that pushes the
// card off the screen. One left edge for the words and the card. The form is
// there at once: the drawing never makes anyone wait to type. It plays in
// full once per session (then appears drawn); reduced motion shows it
// finished. Only real information is written on it.

import React, { useSyncExternalStore } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { Blueprint } from "@/components/auth/Blueprint";
import { ORG_NAME_KEY } from "@/lib/deviceWorkspace";
const PLAYED_KEY = "manufacturingos.sheetDrawn";

const subscribeNever = () => () => {};
let clientFacts: { mode: "full" | "quick"; today: string; workspace: string | null } | null = null;
/** Once per page load: was the sheet drawn this session already, today's
 *  date, and this device's workspace name. Cached, so every read agrees. */
function readFacts() {
  if (!clientFacts) {
    let seen = false;
    try { seen = sessionStorage.getItem(PLAYED_KEY) === "1"; sessionStorage.setItem(PLAYED_KEY, "1"); } catch { /* private window */ }
    let workspace: string | null = null;
    try { workspace = localStorage.getItem(ORG_NAME_KEY); } catch { /* none */ }
    clientFacts = {
      mode: seen ? "quick" : "full",
      today: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      workspace,
    };
  }
  return clientFacts;
}

function Cell({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 px-3 py-2 ${className}`}>
      <div className="text-caption uppercase tracking-[0.06em] text-[var(--color-text-faint)]">{label}</div>
      <div className="mt-0.5 text-body font-medium text-[var(--color-text)] truncate">{children}</div>
    </div>
  );
}

export function AuthCard({ title, sub, children, footer, wide = false, status, signed, leaving = false }: {
  /** Wider, for longer forms (sign up). */
  wide?: boolean;
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** The form. */
  children: React.ReactNode;
  /** Links and small print under the card. */
  footer?: React.ReactNode;
  /** The sign-in's state, in words: "Checking your sign-in". */
  status?: React.ReactNode;
  /** Who signed, once they're in: the SIGNED line fills in. */
  signed?: { name: string; at: Date } | null;
  /** Leaving for the app: the card settles away, the sheet fades. */
  leaving?: boolean;
}) {
  // Read once per page load, after hydration (the server has none of it):
  // the full drawing once per session, today's date, and the workspace
  // this device signs in to.
  const facts = useSyncExternalStore(subscribeNever, readFacts, () => null);
  const mode = facts?.mode ?? null;

  const time = signed ? signed.at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";

  return (
    <div className={`relative min-h-dvh flex flex-col md:block bg-[var(--color-canvas)] [overflow-x:clip] ${mode === "quick" ? "bp-quick" : ""} ${leaving ? "bp-leaving" : ""}`}>
      {/* The sheet. On a phone it takes the room the card leaves (at least
          enough for the words) and runs under the card's round corners. */}
      <div className="bp-stage surface-side relative flex-1 min-h-[10.5rem] -mb-5 md:mb-0 md:absolute md:inset-x-0 md:top-0 md:h-[52dvh] lg:fixed lg:inset-0 lg:h-auto overflow-hidden">
        {/* Placed, not in the flow: the drawing never sets the band's height. */}
        {mode && <div className="bp-camera absolute inset-0"><Blueprint /></div>}
        <div aria-hidden className="bp-border inset-2.5 lg:inset-5" />
        <div aria-hidden className="bp-zones top-[3px] inset-x-8 lg:top-[3px] lg:inset-x-16">
          {["1", "2", "3", "4", "5", "6", "7", "8"].map((z, i) => <span key={z} className={i > 3 ? "max-sm:hidden" : ""}>{z}</span>)}
        </div>
        <div aria-hidden className="bp-zones max-lg:hidden flex-col left-[7px] inset-y-16">
          {["A", "B", "C", "D"].map((z) => <span key={z}>{z}</span>)}
        </div>
        {/* On a phone the words sit over the drawing: the top fades back. */}
        <div aria-hidden className="md:hidden absolute inset-x-0 top-0 h-44" style={{ background: "linear-gradient(var(--side-bg, #081d48) 58%, transparent)" }} />
        <div className="bp-intro absolute left-5 right-5 top-6 sm:left-7 sm:right-7 lg:left-16 lg:top-16 lg:right-auto max-w-[30rem]">
          <p className="text-caption font-medium uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Manufacturing OS</p>
          <p className="mt-2 font-display text-section sm:text-[26px] lg:text-[34px] leading-[1.15] font-semibold text-balance text-[var(--color-text)]">
            Your site&apos;s drawings, equipment and work, in one place.
          </p>
        </div>
        {/* The one way out of the front door that isn't a door: on the
            heading's line, at the other edge. */}
        <Link href="/about"
          className="bp-intro ui-hit absolute right-5 top-6 sm:right-7 lg:right-16 lg:top-16 text-caption font-medium uppercase tracking-[0.14em] text-[var(--color-text)] underline underline-offset-4 decoration-[color-mix(in_srgb,var(--color-text)_40%,transparent)] hover:decoration-current">
          About
        </Link>
      </div>

      {/* The title block: the sign-in. */}
      <main className="relative z-10 flex flex-col justify-end md:min-h-dvh md:pt-[46dvh] md:pb-10 md:px-6 lg:p-14 lg:items-end pointer-events-none">
        <div className={`bp-rise pointer-events-auto w-full md:mx-auto lg:mx-0 ${wide ? "md:max-w-[640px]" : "md:max-w-[480px]"} rounded-t-[20px] md:rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-float)] flex flex-col overflow-hidden`}>
          <div className="order-1 px-5 pt-6 pb-4 sm:px-7 sm:pt-7 sm:pb-5">
            {/* The full stop in the app's orange: its third color, as an accent. */}
            <h1 className="font-display text-[30px] sm:text-[34px] leading-[1.1] font-bold text-[var(--color-text)]">{typeof title === "string" && title.endsWith(".") ? <>{title.slice(0, -1)}<span className="text-[var(--app-orange)]">.</span></> : title}</h1>
            {sub && <p className="mt-2 text-reading text-[var(--color-text-muted)]">{sub}</p>}
            <div className="mt-5 sm:mt-6">{children}</div>
          </div>

          {/* The status row: under the doors, and on a phone only once there
              is something to say (signing in, signed), not "Ready". */}
          <div className={`order-3 relative text-[var(--color-text)] ${!signed && (!status || status === "Ready to sign in") ? "max-md:hidden" : ""}`}>
            <div className="grid grid-cols-4 divide-x divide-[var(--color-border)] border-t border-[var(--color-border)]">
              <Cell label="Status" className="col-span-2"><span role="status">{status ?? "Ready to sign in"}</span></Cell>
              <Cell label="Signed" className="col-span-2">
                {signed
                  ? <span className="tb-ink inline-flex items-center gap-1.5 text-[var(--state-released-text)]"><Check aria-hidden className="w-4 h-4 shrink-0" /><span className="truncate">{signed.name}, {time}</span></span>
                  : <span aria-hidden className="block h-[18px] border-b border-dashed border-[var(--color-border-strong)]" />}
              </Cell>
            </div>
          </div>

          {footer && <div className="order-4 px-5 sm:px-7 pt-4 sm:pt-5 border-t border-[var(--color-border)] space-y-1 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-[max(1.25rem,env(safe-area-inset-bottom))]">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** A front-door field: 48 px tall, 16 px text (no zoom on a phone), the
 *  resting edge at 3:1, focus is the app-wide ring. */
export const authField =
  "w-full h-12 px-3.5 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-reading text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] aria-[invalid=true]:border-[var(--state-overdue)] disabled:opacity-60 transition-colors";

/** A front-door button: as tall as the fields. */
export const authBtn = "w-full !h-12 !text-reading";

export default AuthCard;
