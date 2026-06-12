'use client';

import * as React from 'react';
import { AlertTriangle, RotateCcw, RefreshCw } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Log to console for now; wire this to Sentry/LogRocket later if you use one.
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-full">
      <main className="mx-auto flex max-w-2xl flex-col items-center justify-center px-6 py-16">
        <div className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm animate-in fade-in zoom-in-95">
          <div className="flex items-start gap-4">
            <div className="mt-1 flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-500/15">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-black tracking-tight text-[var(--color-text)]">
                Something went wrong
              </h1>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                An unexpected error occurred. You can try again, or reload the
                page.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => reset()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[var(--color-accent-fg)] transition-colors hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Try again
                </button>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-bold text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Reload page
                </button>
              </div>

              {process.env.NODE_ENV !== 'production' ? (
                <details className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
                  <summary className="cursor-pointer text-sm font-medium text-[var(--color-text-muted)]">
                    Developer details
                  </summary>
                  <pre className="mt-3 overflow-auto text-xs leading-relaxed text-[var(--color-text)]">
                    {error?.stack ?? String(error)}
                    {error?.digest ? `\n\ndigest: ${error.digest}` : ''}
                  </pre>
                </details>
              ) : null}
            </div>
          </div>
        </div>

        <p className="mt-8 text-xs text-[var(--color-text-faint)]">
          If this keeps happening, share what you were doing right before the
          error.
        </p>
      </main>
    </div>
  );
}
