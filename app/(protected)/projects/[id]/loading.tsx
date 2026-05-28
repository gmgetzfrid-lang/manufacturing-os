import { SkeletonBlock, SkeletonPageHeader, SkeletonTableRows } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-6xl mx-auto">
        <SkeletonPageHeader />
        <div className="flex gap-2 mb-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-9 w-24 rounded-lg" />
          ))}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200">
          <SkeletonTableRows rows={8} />
        </div>
      </div>
    </div>
  );
}
