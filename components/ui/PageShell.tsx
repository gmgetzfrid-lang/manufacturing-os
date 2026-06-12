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
    <header className={`flex flex-wrap items-end justify-between gap-4 mb-6 ${className}`}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--color-text-muted)] mb-1">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-black text-[var(--color-text)] flex items-center gap-3">
          {Icon && <Icon className="w-7 h-7 text-[var(--color-accent)] shrink-0" />}
          <span className="truncate">{title}</span>
        </h1>
        {subtitle && <p className="text-sm text-[var(--color-text-muted)] mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

export default PageShell;
