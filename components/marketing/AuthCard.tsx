// The front door: the page's title on the page itself (no colored band),
// then the form on a white card. The one main button inside is the
// accent.

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
        <section className="page-head px-1 pb-6">
          <div className="inline-flex items-center gap-2">
            <span className="w-7 h-7 rounded-md grid place-items-center bg-[var(--color-text)] text-[var(--color-canvas)]"><Layout className="w-4 h-4" /></span>
            <span className="font-display text-[17px] font-semibold text-[var(--color-text)]">Manufacturing OS</span>
          </div>
          <h1 className="mt-6 font-display text-[34px] sm:text-[42px] leading-[1.05] font-semibold text-[var(--color-text)]">{title}</h1>
          {sub && <p className="mt-2 text-[16px] text-[var(--color-text-muted)]">{sub}</p>}
        </section>
        <div className="relative rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] p-5 sm:p-6">
          {children}
        </div>
        {footer && <div className="mt-6 mx-1 space-y-3">{footer}</div>}
      </div>
    </div>
  );
}

export default AuthCard;
