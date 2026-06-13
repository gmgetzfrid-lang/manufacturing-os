import { Loader2 } from "lucide-react";
export default function Loading() {
  return (
    <div className="min-h-screen bg-[var(--color-surface-2)] flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" />
    </div>
  );
}
