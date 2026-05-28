// Shared skeleton primitives for loading.tsx route segments.
//
// Next.js renders the nearest loading.tsx INSTANTLY while the page
// component code-splits and fetches. These primitives give every
// route an immediate, route-shaped placeholder so the user always
// sees that a click registered — no "did it crash?" moments.

import { clsx } from "clsx";

interface BlockProps {
  className?: string;
}

export function SkeletonBlock({ className }: BlockProps) {
  return <div className={clsx("animate-pulse rounded-md bg-slate-200/70", className)} />;
}

export function SkeletonText({ className }: BlockProps) {
  return <div className={clsx("animate-pulse rounded bg-slate-200/70", className || "h-3 w-full")} />;
}

interface CardProps {
  lines?: number;
}

export function SkeletonCard({ lines = 3 }: CardProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <SkeletonBlock className="h-5 w-1/2" />
      <div className="mt-3 space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonBlock key={i} className={`h-3 ${i % 2 === 0 ? "w-full" : "w-4/5"}`} />
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <SkeletonBlock className="h-5 w-20 rounded-full" />
        <SkeletonBlock className="h-5 w-14 rounded-full" />
      </div>
    </div>
  );
}

interface PageHeaderProps {
  withSearch?: boolean;
}

export function SkeletonPageHeader({ withSearch }: PageHeaderProps) {
  return (
    <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8">
      <div className="space-y-2">
        <SkeletonBlock className="h-8 w-64" />
        <SkeletonBlock className="h-4 w-80" />
      </div>
      {withSearch && (
        <div className="flex items-center gap-3">
          <SkeletonBlock className="h-10 w-72 rounded-xl" />
          <SkeletonBlock className="h-10 w-28 rounded-xl" />
        </div>
      )}
    </div>
  );
}

interface RowsProps {
  rows?: number;
}

export function SkeletonTableRows({ rows = 8 }: RowsProps) {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <SkeletonBlock className="h-4 w-4 rounded" />
          <SkeletonBlock className="h-4 flex-1 max-w-[40%]" />
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-4 w-16" />
          <SkeletonBlock className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
