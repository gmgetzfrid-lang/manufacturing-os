'use client';

// Segment boundary for everything behind the shell. A render crash in one
// page (a bad graph frame, a viewer choking on a PDF) lands here, INSIDE
// the layout, so the sidebar and navigation stay alive and the user can
// walk away to any other page instead of losing the whole app.

import * as React from 'react';
import Link from 'next/link';
import { RotateCcw, Home } from 'lucide-react';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from '@/components/ui/PageHero';

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
    <PageShell width="form">
      <PageHero
        kicker="This page hit an error"
        title="This view stopped."
        sub="Only this view stopped. The rest of the app still works."
        size="md"
        tools={
          <Link href="/dashboard" className={heroQuiet}>
            <Home className="h-3.5 w-3.5" /> Home
          </Link>
        }
        primary={
          <button type="button" onClick={() => reset()} className={heroPrimary}>
            <RotateCcw className="h-4 w-4" /> Try again
          </button>
        }
      />
      <PageBody>
        <Card label="What to do">
          <p className="text-[14px] text-[var(--color-text-muted)]">
            Try again first. If it stops again, pick another page from the menu and come back later.
          </p>
          {process.env.NODE_ENV !== 'production' && (
            <details className="mt-4 pt-3 border-t border-[var(--color-border)]">
              <summary className="cursor-pointer text-[13px] font-semibold text-[var(--color-text-muted)]">Developer details</summary>
              <pre className="mt-2 overflow-auto text-xs leading-relaxed text-[var(--color-text)]">
                {error?.stack ?? String(error)}
                {error?.digest ? `\n\ndigest: ${error.digest}` : ''}
              </pre>
            </details>
          )}
        </Card>
      </PageBody>
    </PageShell>
  );
}
