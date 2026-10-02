"use client";

// BackToGraphChip — the round trip the graph was missing.
//
// Opening a document from the org graph used to be a one-way door: a hard
// navigation, and your map — the thing you were actually reading — gone.
// The graph now stamps `from=graph` on every open; any page carrying that
// param floats this chip, and one tap returns to /graph, where the per-org
// saved layout and settings restore the exact map you left.
//
// The chip sits in the bottom-centre dock's chip slot (STACK-4,
// notifications Round G N7), pinned at the edge with the projects undo
// toasts stacked above it — they used to land exactly on top of it. The slot
// keeps the chip's own layer (Z.pageChip, the z-40 it had: below every
// drawer and modal backdrop).

import React, { Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Waypoints } from "lucide-react";
import { CentrePortal } from "@/components/ui/CornerDock";

function ChipInner() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  if (params.get("from") !== "graph" || pathname === "/graph") return null;
  return (
    <CentrePortal slot="chip">
    <button
      type="button"
      onClick={() => router.push("/graph")}
      className="pointer-events-auto inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-black shadow-xl transition-colors"
      style={{ animation: "rise 0.3s var(--ease-fluid) both" }}
    >
      <Waypoints className="w-3.5 h-3.5" /> Back to graph
    </button>
    </CentrePortal>
  );
}

export default function BackToGraphChip() {
  // useSearchParams needs a Suspense boundary when the tree prerenders.
  return (
    <Suspense fallback={null}>
      <ChipInner />
    </Suspense>
  );
}
