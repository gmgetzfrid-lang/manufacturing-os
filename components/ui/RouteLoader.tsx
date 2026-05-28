// Minimal route-segment loader. Shown by Next.js loading.tsx files
// while the page component code-splits and fetches. Deliberately
// simple — a faithful skeleton of every page would be a lot of
// duplicated layout to maintain and would mislead users when the
// real page lands and looks different.

import { Loader2 } from "lucide-react";

interface Props {
  label?: string;
}

export default function RouteLoader({ label = "Loading…" }: Props) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin" />
        <div className="text-sm font-medium">{label}</div>
      </div>
    </div>
  );
}
