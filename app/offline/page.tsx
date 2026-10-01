import { WifiOff } from "lucide-react";
import Link from "next/link";

// Offline fallback — served by the service worker when a navigation can't
// reach the network and nothing is cached. Intentionally static and
// dependency-free so it works with zero connectivity.
export default function OfflinePage() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-slate-950 text-center p-6">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500 to-orange-700 flex items-center justify-center shadow-lg mb-5">
        <WifiOff className="w-8 h-8 text-white" />
      </div>
      <h1 className="text-xl font-black text-white">You&apos;re offline</h1>
      <p className="text-sm text-[var(--color-text-faint)] mt-2 max-w-sm">
        Manufacturing OS can&apos;t reach the server right now. Documents,
        drawings and their status are read live and are not kept on this
        device, so nothing here can be checked until you reconnect — don&apos;t
        rely on a screen you opened earlier as current. Reconnect and try again.
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
