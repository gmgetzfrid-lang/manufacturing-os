// PageShell + PageHeaderBar — the shared page scaffold. Before this,
// every screen hand-built its own shell (seven max-widths, four padding
// rhythms, five header architectures, and a per-page `bg-slate-50` that
// fought the layout's canvas), which made each tool feel like a slightly
// different product. Pages now do:
//
//   <PageShell width="work">                      // or "form" for settings-style pages
//     <PageHeaderBar icon={Briefcase} title="Projects"
//       subtitle="Plan and execute scoped work" actions={<Button…/>} />
//     …content…
//   </PageShell>
//
// The shell deliberately paints NO background — the protected layout owns
// the canvas, so the floor color is identical on every screen.

import React from "react";

const WIDTHS = {
  /** Dense work surfaces: tables, boards, dashboards. */
  work: "max-w-7xl",
  /** Reading/forms: settings, profile, detail panes. */
  form: "max-w-3xl",
  /** Edge-to-edge tools (document table, viewers). */
  full: "max-w-none",
} as const;

export function PageShell({
  width = "work",
  className = "",
  children,
}: {
  width?: keyof typeof WIDTHS;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`mx-auto w-full ${WIDTHS[width]} px-4 sm:px-6 lg:px-8 py-6 pb-20 ${className}`}>
      {children}
    </div>
  );
}

export function PageHeaderBar({
  icon: Icon,
  eyebrow,
  title,
  subtitle,
  actions,
  className = "",
}: {
  icon?: React.ComponentType<{ className?: string }>;
  /** Tiny all-caps kicker above the title, e.g. "Mission control · live". */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={`relative isolate flex flex-wrap items-center justify-between gap-4 mb-6 ${className}`}>
      {/* Faint accent wash + hairline gives every page header presence and
          a touch of luster, instead of a flat title floating on the canvas. */}
      <div aria-hidden className="header-wash pointer-events-none absolute -inset-x-4 -top-6 bottom-[-0.75rem] -z-10 sm:-inset-x-6 lg:-inset-x-8" />
      <div className="flex items-center gap-3.5 min-w-0">
        {Icon && (
          <div className="grid place-items-center w-11 h-11 rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/15 shrink-0 shadow-sm">
            <Icon className="w-5.5 h-5.5" />
          </div>
        )}
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--color-text-muted)] mb-0.5">
              {eyebrow}
            </div>
          )}
          <h1 className="text-2xl font-black text-[var(--color-text)] tracking-tight truncate">{title}</h1>
          {subtitle && <p className="text-sm text-[var(--color-text-muted)] mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

export default PageShell;
