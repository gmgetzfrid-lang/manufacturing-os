"use client";

// Never a blank area while something loads: skeleton rows in the shape of
// what's coming (components/ui/Skeleton), and a quiet line saying what it
// is. The rest of the screen stays usable.
import React from "react";
import { SkeletonRows } from "@/components/ui/Skeleton";

export default function LoadingBlock({ what, rows = 4, className = "" }: { what?: string; rows?: number; className?: string }) {
  return (
    <div aria-busy="true" className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>
      <SkeletonRows rows={rows} cols={1} what={what} sheet={false} />
      <p className="px-4 py-2.5 border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)]">{what ? `Loading ${what}` : "Loading"}</p>
    </div>
  );
}
