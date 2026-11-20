// PageShell + PageHeaderBar — the shared page scaffold. Before this,
// every screen hand-built its own shell (seven max-widths, four padding
// rhythms, five header architectures, and a per-page `bg-[var(--color-surface-2)]` that
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
import { PageHero } from "@/components/ui/PageHero";

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

/** The older header API, now drawn as the shared page band (PageHero):
 *  the title is the big line, the eyebrow the small label above it. Pages
 *  that pass an `answer` show that as the big line and the title as the
 *  label. */
export function PageHeaderBar({
  eyebrow,
  title,
  answer,
  subtitle,
  actions,
  primary,
  className = "",
}: {
  icon?: React.ComponentType<{ className?: string }>;
  /** Tiny all-caps kicker above the title. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** What matters on this page right now; shown big, with the title as the label. */
  answer?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Small controls (top right of the band). */
  actions?: React.ReactNode;
  /** The one orange action. */
  primary?: React.ReactNode;
  className?: string;
}) {
  return (
    <PageHero
      kicker={answer ? (eyebrow ? <>{eyebrow} · {title}</> : title) : eyebrow}
      title={answer ?? title}
      sub={subtitle}
      tools={actions}
      primary={primary}
      overlap={false}
      className={className}
    />
  );
}

export default PageShell;
