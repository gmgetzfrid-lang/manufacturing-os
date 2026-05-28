import { SkeletonBlock, SkeletonTableRows } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4 flex items-center gap-4">
        <SkeletonBlock className="h-6 w-6 rounded" />
        <SkeletonBlock className="h-6 w-56" />
        <div className="ml-auto flex gap-2">
          <SkeletonBlock className="h-9 w-9 rounded-lg" />
          <SkeletonBlock className="h-9 w-9 rounded-lg" />
          <SkeletonBlock className="h-9 w-28 rounded-lg" />
        </div>
      </div>
      <div className="flex-1 flex">
        <div className="w-64 border-r border-slate-200 bg-white p-4 space-y-3">
          <SkeletonBlock className="h-5 w-32" />
          <SkeletonBlock className="h-4 w-24 ml-2" />
          <SkeletonBlock className="h-4 w-28 ml-2" />
          <SkeletonBlock className="h-4 w-20 ml-2" />
          <SkeletonBlock className="h-4 w-32 ml-4" />
          <SkeletonBlock className="h-4 w-24 ml-4" />
        </div>
        <div className="flex-1 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 flex items-center gap-3">
            <SkeletonBlock className="h-4 w-24" />
            <SkeletonBlock className="h-4 w-16" />
            <SkeletonBlock className="h-4 w-20" />
            <SkeletonBlock className="h-4 w-12" />
          </div>
          <SkeletonTableRows rows={12} />
        </div>
      </div>
    </div>
  );
}
