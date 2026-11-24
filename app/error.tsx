'use client';

import * as React from 'react';
import { RotateCcw, RefreshCw } from 'lucide-react';
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from '@/components/ui/PageHero';

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
      <main className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-6 pb-20">
        <PageHero
          kicker="Something went wrong"
          title="This screen stopped."
          sub="Try again. If it keeps happening, reload the page and tell your admin what you were doing right before."
          size="md"
          tools={
            <button type="button" onClick={() => window.location.reload()} className={heroQuiet}>
              <RefreshCw className="h-3.5 w-3.5" /> Reload page
            </button>
          }
          primary={
            <button type="button" onClick={() => reset()} className={heroPrimary}>
              <RotateCcw className="h-4 w-4" /> Try again
            </button>
          }
        />
        {process.env.NODE_ENV !== 'production' ? (
          <PageBody>
            <Card>
              <details>
                <summary className="cursor-pointer text-body font-medium text-[var(--color-text-muted)]">
                  Developer details
                </summary>
                <pre className="mt-3 overflow-auto text-xs leading-relaxed text-[var(--color-text)]">
                  {error?.stack ?? String(error)}
                  {error?.digest ? `\n\ndigest: ${error.digest}` : ''}
                </pre>
              </details>
            </Card>
          </PageBody>
        ) : null}
      </main>
    </div>
  );
}
