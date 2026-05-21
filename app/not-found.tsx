"use client";

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 py-16">
        <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="mt-1 h-10 w-10 flex-none rounded-full bg-slate-100 text-center leading-10">
              🔎
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight">
                Page not found
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                The page you’re looking for doesn’t exist or may have been moved.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href="/"
                  className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  Go home
                </Link>
                <Link
                  href="/"
                  onClick={(e) => {
                    // If JS is enabled, go back. Otherwise fall back to href="/".
                    e.preventDefault();
                    if (typeof window !== 'undefined' && window.history.length > 1) {
                      window.history.back();
                    } else {
                      window.location.href = '/';
                    }
                  }}
                  className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300"
                >
                  Go back
                </Link>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-8 text-xs text-slate-500">
          Tip: double-check the URL, or navigate from the homepage.
        </p>
      </div>
    </main>
  );
}
