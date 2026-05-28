import { SkeletonBlock, SkeletonPageHeader } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto">
        <SkeletonPageHeader />
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, col) => (
            <div key={col} className="space-y-2">
              <SkeletonBlock className="h-6 w-24" />
              {Array.from({ length: 3 }).map((_, i) => (
                <SkeletonBlock key={i} className="h-20 rounded-xl" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
