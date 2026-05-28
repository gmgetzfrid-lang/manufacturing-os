import { SkeletonBlock, SkeletonCard, SkeletonPageHeader } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-4xl mx-auto">
        <SkeletonPageHeader />
        <div className="flex gap-2 mb-4">
          <SkeletonBlock className="h-9 w-28 rounded-lg" />
          <SkeletonBlock className="h-9 w-28 rounded-lg" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} lines={2} />)}
        </div>
      </div>
    </div>
  );
}
