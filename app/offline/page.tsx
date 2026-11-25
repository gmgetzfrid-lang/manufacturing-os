import Link from "next/link";
import { btnPrimary } from "@/components/admin/kit";

// Offline fallback, served by the service worker when a navigation can't
// reach the network and nothing is cached. Static and dependency-light so
// it works with zero connectivity: the header on the page (muted kicker,
// the answer as the title, one line), then one action.
export default function OfflinePage() {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] px-4 pt-10 pb-12">
      <div className="mx-auto w-full max-w-[560px]">
        <header className="page-head">
          <div className="text-body text-[var(--color-text-muted)]">No connection</div>
          <h1 className="mt-2 font-display text-title font-semibold text-[var(--color-text)]">You&apos;re offline.</h1>
          <p className="mt-1.5 text-reading text-[var(--color-text-muted)]">
            This page wasn&apos;t saved on this device, and the app&apos;s data needs the connection. Try again when it&apos;s back.
          </p>
        </header>
        <Link href="/" className={`mt-6 ${btnPrimary}`}>Try again</Link>
      </div>
    </div>
  );
}
