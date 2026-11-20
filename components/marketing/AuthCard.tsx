// The front door: a card centered on the page. Its top is the brand band
// with the page's title in white; the form sits on a white card that
// overlaps the band's bottom edge, so the two read as one object. The one
// main button inside is the accent.

import React from "react";
import { Layout } from "lucide-react";

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
    <div className="min-h-dvh bg-[var(--color-canvas)] px-4 py-8 sm:py-14 flex justify-center">
      <div className={`w-full ${wide ? "max-w-[620px]" : "max-w-[460px]"}`}>
        <section className="page-head rounded-[20px] bg-[var(--color-band)] px-6 sm:px-8 pt-6 sm:pt-7 pb-20 shadow-[0_24px_48px_-28px_rgb(0_0_0/0.55)]">
          <div className="inline-flex items-center gap-2">
            <span className="w-7 h-7 rounded-md grid place-items-center bg-white text-[var(--color-band)]"><Layout className="w-4 h-4" /></span>
            <span className="font-display text-[17px] font-semibold text-white">Manufacturing OS</span>
          </div>
          <h1 className="mt-6 font-display text-[38px] sm:text-[44px] leading-[1.02] font-semibold text-white">{title}</h1>
          {sub && <p className="mt-2 text-[15px] text-white/85">{sub}</p>}
        </section>
        <div className="relative -mt-14 mx-3 sm:mx-5 rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[0_22px_44px_-22px_rgb(15_23_42/0.45)] p-5 sm:p-6">
          {children}
        </div>
        {footer && <div className="mt-6 mx-3 sm:mx-5 space-y-3">{footer}</div>}
      </div>
    </div>
  );
}

export default AuthCard;
