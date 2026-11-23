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
      {Icon && <Icon aria-hidden className="w-6 h-6 mx-auto mb-3 text-[var(--color-text-faint)]" />}
      <h3 className="text-[16px] font-semibold text-[var(--color-text)]">{title}</h3>
      {description && <p className="text-[14px] text-[var(--color-text-muted)] mt-1 max-w-md mx-auto leading-relaxed">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export default EmptyState;
