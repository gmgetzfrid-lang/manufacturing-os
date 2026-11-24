"use client";

// EmptyState: one line saying what will be here, and one action to fill
// it. A plain muted icon (no tile), a short title, an optional line under
// it. Token-driven so it themes correctly.

import React from "react";

export function EmptyState({
  icon: Icon, title, description, action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center">
      {/* The icon draws itself, like the sheet at sign-in. */}
      {Icon && <Icon aria-hidden className="ui-draw-icon w-7 h-7 mx-auto mb-3 text-[var(--color-text-faint)]" />}
      <h3 className="text-reading font-medium text-[var(--color-text)]">{title}</h3>
      {description && <p className="text-body text-[var(--color-text-muted)] mt-1 max-w-md mx-auto leading-relaxed">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export default EmptyState;
