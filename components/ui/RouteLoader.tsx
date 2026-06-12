// Minimal route-segment loader. Shown by Next.js loading.tsx files
// while the page component code-splits and fetches. Deliberately
// simple — a faithful skeleton of every page would be a lot of
// duplicated layout to maintain and would mislead users when the
// real page lands and looks different. Token-driven so it sits on the
// same canvas as every page, in both themes.

import { Spinner } from "@/components/ui/Spinner";

interface Props {
  label?: string;
}

export default function RouteLoader({ label = "Loading…" }: Props) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 animate-in fade-in">
        <Spinner size="md" />
        <div className="text-sm font-medium text-[var(--color-text-muted)]">{label}</div>
      </div>
    </div>
  );
}
