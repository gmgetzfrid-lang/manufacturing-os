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
        sub="The rest of the app still works. Try again; if it stops again, pick another page from the menu and come back later."
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
      {process.env.NODE_ENV !== 'production' && (
        <PageBody>
          <Card>
            <details>
              <summary className="cursor-pointer text-body font-medium text-[var(--color-text-muted)]">Developer details</summary>
              <pre className="mt-2 overflow-auto text-caption leading-relaxed text-[var(--color-text)]">
                {error?.stack ?? String(error)}
                {error?.digest ? `\n\ndigest: ${error.digest}` : ''}
              </pre>
            </details>
          </Card>
        </PageBody>
      )}
    </PageShell>
  );
}
