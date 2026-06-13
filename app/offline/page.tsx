import { WifiOff } from "lucide-react";
import Link from "next/link";

// Offline fallback — served by the service worker when a navigation can't
// reach the network and nothing is cached. Intentionally static and
// dependency-free so it works with zero connectivity.
export default function OfflinePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-center p-6">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500 to-orange-700 flex items-center justify-center shadow-lg mb-5">
        <WifiOff className="w-8 h-8 text-white" />
      </div>
      <h1 className="text-xl font-black text-white">You&apos;re offline</h1>
      <p className="text-sm text-[var(--color-text-faint)] mt-2 max-w-sm">
        Manufacturing OS can&apos;t reach the network right now. Pages and data you
        opened recently are still available; this screen appears for anything
        that wasn&apos;t cached. Reconnect to pick up where you left off.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center justify-center h-10 px-5 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-bold transition-colors"
      >
        Try again
      </Link>
    </div>
  );
}
