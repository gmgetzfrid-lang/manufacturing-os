import { WifiOff } from "lucide-react";
import Link from "next/link";

// Offline fallback, served by the service worker when a navigation can't
// reach the network and nothing is cached. Intentionally static and
// dependency-free so it works with zero connectivity: the band and card
// are drawn here with the same tokens as the shared page frame.
export default function OfflinePage() {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] px-4 py-6">
      <div className="mx-auto w-full max-w-xl">
        <section className="rounded-[20px] bg-[var(--color-band)] px-5 sm:px-8 pt-5 sm:pt-6 pb-20 sm:pb-24 text-white">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">
            <WifiOff className="w-3.5 h-3.5" /> No connection
          </div>
          <h1 className="mt-5 sm:mt-7 text-[28px] sm:text-[38px] leading-[1.03] font-black tracking-[-0.03em]">You&apos;re offline.</h1>
          <p className="mt-3 text-[14px] sm:text-[15px] text-[var(--color-ink-text)]">
            This page wasn&apos;t saved on this device.
          </p>
        </section>
        <div className="relative -mt-14 sm:-mt-16 px-2 sm:px-5">
          <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-5">
            <p className="text-[14px] text-[var(--color-text-muted)]">
              Pages you opened recently still work. When the connection is back, try again.
            </p>
            <Link
              href="/"
              className="mt-4 inline-flex items-center justify-center h-11 px-5 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[14px] font-extrabold shadow-[0_12px_24px_-12px_var(--color-accent)] transition-colors"
            >
              Try again
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
