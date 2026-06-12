"use client";

// Spinner — the one loading indicator. Accent-colored so it follows the
// workspace palette (the app had slate/blue/orange spinners screen by
// screen).

import { Loader2 } from "lucide-react";

const SIZES = { xs: "w-3.5 h-3.5", sm: "w-4 h-4", md: "w-6 h-6", lg: "w-10 h-10" } as const;

export function Spinner({
  size = "md",
  className = "",
}: {
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return <Loader2 className={`animate-spin text-[var(--color-accent)] ${SIZES[size]} ${className}`} />;
}

export default Spinner;
