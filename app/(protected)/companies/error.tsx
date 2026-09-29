"use client";

// Segment boundary for /companies (REL-1): a render crash on the registry or
// a company profile lands here, inside the shell, with a retry — never a
// blank page and never the whole app.

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function CompaniesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-500/15">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-black text-[var(--color-text)]">The registry hit an error</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">The rest of the app is fine — only this view failed. Try again, or go back to your projects.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => reset()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-sm font-bold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]">
                <RotateCcw className="h-4 w-4" /> Try again
              </button>
              <Link href="/projects" className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3.5 py-2 text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Projects</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
