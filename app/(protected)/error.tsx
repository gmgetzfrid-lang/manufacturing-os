'use client';

// Segment boundary for everything behind the shell. A render crash in one
// page (a bad graph frame, a viewer choking on a PDF) lands here — INSIDE
// the layout — so the sidebar and navigation stay alive and the user can
// walk away to any other page instead of losing the whole app.

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';

export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm animate-in fade-in zoom-in-95">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-500/15">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-black text-[var(--color-text)]">This page hit an error</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              The rest of the app is fine — only this view crashed. Try again, or head back to your dashboard.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => reset()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-sm font-bold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Try again
              </button>
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3.5 py-2 text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              >
                <Home className="h-3.5 w-3.5" /> Dashboard
              </Link>
            </div>
            {process.env.NODE_ENV !== 'production' && (
              <details className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
                <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-muted)]">Developer details</summary>
                <pre className="mt-2 overflow-auto text-xs leading-relaxed text-[var(--color-text)]">
                  {error?.stack ?? String(error)}
                  {error?.digest ? `\n\ndigest: ${error.digest}` : ''}
                </pre>
              </details>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
