// The route-segment loader (Next.js loading.tsx files) while a page's code
// and data arrive: the shape of a page (a header, then a list) in skeleton
// bars, not a spinner in the middle of nothing. The side menu and top bar
// stay usable around it. Token-driven, both themes.

import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";

interface Props {
  label?: string;
}

export default function RouteLoader({ label = "Loading" }: Props) {
  return (
    <div className="mx-auto w-full max-w-[1480px] px-4 sm:px-6 lg:px-8 py-6" aria-busy="true">
      <span className="sr-only" role="status">{label.replace(/[.…]+$/, "")}</span>
      <Skeleton className="w-28 h-3" />
      <Skeleton className="mt-4 w-[min(420px,80%)] h-7" />
      <Skeleton className="mt-3 w-[min(300px,60%)] h-4" />
      <div className="mt-6 flex gap-8">
        <Skeleton className="w-16 h-10" />
        <Skeleton className="w-20 h-10 max-sm:hidden" />
      </div>
      <SkeletonRows rows={6} cols={2} className="mt-8" />
    </div>
  );
}
