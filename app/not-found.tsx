"use client";

import Link from 'next/link';
import { SearchX, Home, ArrowLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 py-16">
        <div className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm animate-in fade-in zoom-in-95">
          <div className="flex items-start gap-4">
            <div className="mt-1 flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <SearchX className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-black tracking-tight text-[var(--color-text)]">
                Page not found
              </h1>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                The page you’re looking for doesn’t exist or may have been moved.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href="/"
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[var(--color-accent-fg)] transition-colors hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
                >
                  <Home className="h-3.5 w-3.5" /> Go home
                </Link>
                <Link
                  href="/"
                  onClick={(e) => {
                    // If JS is enabled, go back. Otherwise fall back to href="/".
                    e.preventDefault();
                    if (typeof window !== 'undefined' && window.history.length > 1) {
                      window.history.back();
                    } else {
                      window.location.href = '/';
                    }
                  }}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-bold text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Go back
                </Link>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-8 text-xs text-[var(--color-text-faint)]">
          Tip: double-check the URL, or navigate from the homepage.
        </p>
      </div>
    </main>
  );
}
