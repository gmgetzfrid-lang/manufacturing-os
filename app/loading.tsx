export default function Loading() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 py-16">
        <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="relative mt-1 h-10 w-10 flex-none">
              <div className="h-10 w-10 rounded-full border border-slate-200" />
              <div className="absolute inset-0 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
            </div>

            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight">
                Loading…
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                Please wait while we fetch the latest content.
              </p>

              <div className="mt-6 space-y-3">
                <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          </div>
        </div>

        <p className="mt-8 text-xs text-slate-500">
          If this takes too long, refresh the page.
        </p>
      </div>
    </main>
  );
}
