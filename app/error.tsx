'use client';

import * as React from 'react';

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
    <div className="min-h-full bg-white text-slate-900 rounded-2xl">
      <main className="mx-auto flex max-w-2xl flex-col items-center justify-center px-6 py-16">
        <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="mt-1 h-10 w-10 flex-none rounded-full bg-slate-100 text-center leading-10">
              ⚠️
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight">
                Something went wrong
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                An unexpected error occurred. You can try again, or reload the
                page.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => reset()}
                  className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300"
                >
                  Reload page
                </button>
              </div>

              {process.env.NODE_ENV !== 'production' ? (
                <details className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <summary className="cursor-pointer text-sm font-medium text-slate-700">
                    Developer details
                  </summary>
                  <pre className="mt-3 overflow-auto text-xs leading-relaxed text-slate-800">
                    {error?.stack ?? String(error)}
                    {error?.digest ? `\n\ndigest: ${error.digest}` : ''}
                  </pre>
                </details>
              ) : null}
            </div>
          </div>
        </div>

        <p className="mt-8 text-xs text-slate-500">
          If this keeps happening, share what you were doing right before the
          error.
        </p>
      </main>
    </div>
  );
}
