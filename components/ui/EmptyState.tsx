"use client";

// EmptyState — one consistent "nothing here yet" surface (icon, title,
// description, optional action). Token-driven so it themes correctly. Replaces
// the per-screen one-off empty cards.

import React from "react";

export function EmptyState({
  icon: Icon, title, description, action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center shadow-sm">
      <div className="w-14 h-14 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)] mx-auto flex items-center justify-center mb-4">
        <Icon className="w-7 h-7 text-[var(--color-text-muted)]" />
      </div>
      <h3 className="text-base font-black text-[var(--color-text)]">{title}</h3>
      {description && <p className="text-sm text-[var(--color-text-muted)] mt-1 max-w-md mx-auto leading-relaxed">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export default EmptyState;
