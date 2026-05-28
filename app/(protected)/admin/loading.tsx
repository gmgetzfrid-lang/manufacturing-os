import { SkeletonPageHeader, SkeletonTableRows } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-6xl mx-auto">
        <SkeletonPageHeader />
        <div className="bg-white rounded-2xl border border-slate-200">
          <SkeletonTableRows rows={8} />
        </div>
      </div>
    </div>
  );
}
