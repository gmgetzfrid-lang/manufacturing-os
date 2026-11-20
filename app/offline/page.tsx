import { WifiOff } from "lucide-react";
import Link from "next/link";

// Offline fallback, served by the service worker when a navigation can't
// reach the network and nothing is cached. Intentionally static and
// dependency-free so it works with zero connectivity: the title block and
// the sheet are drawn here with the same tokens as the shared page frame.
export default function OfflinePage() {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] px-4 pt-6 pb-12">
      <div className="mx-auto w-full max-w-[560px]">
        <header className="pb-5 border-b border-[var(--color-border-strong)]">
          <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-text-muted)]">
            <WifiOff className="w-4 h-4" /> No connection
          </div>
          <h1 className="mt-2 font-display text-[30px] sm:text-[38px] leading-[1.05] font-semibold tracking-[-0.01em] text-[var(--color-text)]">You&apos;re offline.</h1>
          <p className="mt-2 text-[15px] text-[var(--color-text-muted)]">This page wasn&apos;t saved on this device.</p>
        </header>
        <div className="mt-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 flex flex-wrap items-center gap-x-6 gap-y-4">
          <p className="flex-1 basis-[260px] text-[15px] text-[var(--color-text)]">
            Pages you opened recently still work. Try again when the connection is back.
          </p>
          <Link
            href="/"
            className="inline-flex items-center justify-center h-10 px-4 rounded-md bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[15px] font-semibold transition-colors"
          >
            Try again
          </Link>
        </div>
      </div>
    </div>
  );
}
