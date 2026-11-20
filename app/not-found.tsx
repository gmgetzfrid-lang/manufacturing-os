"use client";

import Link from 'next/link';
import { Home, ArrowLeft } from 'lucide-react';
import { PageHero, PageBody, Card, heroPrimary } from '@/components/ui/PageHero';

export default function NotFound() {
  return (
    <main className="min-h-dvh bg-[var(--color-canvas)]">
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-6 pb-20">
        <PageHero
          kicker="Page not found"
          title="Nothing here."
          sub="This link doesn’t open anything. The page may have moved."
          size="md"
          primary={
            <Link href="/" className={heroPrimary}>
              <Home className="h-4 w-4" /> Go home
            </Link>
          }
        />
        <PageBody>
          <Card label="Where to next">
            <div className="flex flex-wrap items-center gap-3">
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
                className="inline-flex items-center justify-center gap-2 h-10 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[14px] font-bold text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
              >
                <ArrowLeft className="h-4 w-4" /> Go back
              </Link>
              <span className="text-[14px] text-[var(--color-text-muted)]">or search for it with the search box at the top of any page.</span>
            </div>
          </Card>
        </PageBody>
      </div>
    </main>
  );
}
