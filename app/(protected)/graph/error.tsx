'use client';

// The graph runs WebGL + a force simulation — the most crash-prone surface
// in the app (context loss, out-of-memory canvases, driver quirks). Its own
// boundary keeps a renderer failure from reading as "the app broke", and
// offers the 2D fallback that works everywhere.

import * as React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function GraphError({
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
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm">
        <AlertTriangle className="mx-auto h-8 w-8 text-amber-500" />
        <h1 className="mt-3 text-base font-black text-[var(--color-text)]">The graph renderer crashed</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Usually a WebGL hiccup — a lost GPU context or a very large graph in 3D mode.
          Reloading fixes it; if it repeats, switch the graph to 2D mode.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reload the graph
        </button>
      </div>
    </div>
  );
}
