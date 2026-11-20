import { WifiOff } from "lucide-react";
import Link from "next/link";

// Offline fallback, served by the service worker when a navigation can't
// reach the network and nothing is cached. Intentionally static and
// dependency-free so it works with zero connectivity.
export default function OfflinePage() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-[var(--color-canvas)] text-center p-6">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5 bg-[var(--color-surface-2)] text-[var(--color-text)]">
        <WifiOff className="w-8 h-8" />
      </div>
      <h1 className="text-xl font-black text-[var(--color-text)]">You&apos;re offline</h1>
      <p className="text-sm text-[var(--color-text-muted)] mt-2 max-w-sm">
        This page wasn&apos;t saved on this device. Pages you opened recently still work.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center justify-center h-10 px-5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-sm font-bold transition-colors"
      >
        Try again
      </Link>
    </div>
  );
}
