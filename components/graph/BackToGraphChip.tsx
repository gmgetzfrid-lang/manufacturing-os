"use client";

// BackToGraphChip — the round trip the graph was missing.
//
// Opening a document from the org graph used to be a one-way door: a hard
// navigation, and your map — the thing you were actually reading — gone.
// The graph now stamps `from=graph` on every open; any page carrying that
// param floats this chip, and one tap returns to /graph, where the per-org
// saved layout and settings restore the exact map you left.

import React, { Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Waypoints } from "lucide-react";

function ChipInner() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  if (params.get("from") !== "graph" || pathname === "/graph") return null;
  return (
    <button
      type="button"
      onClick={() => router.push("/graph")}
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-black shadow-xl transition-colors"
      style={{ animation: "rise 0.3s var(--ease-fluid) both" }}
    >
      <Waypoints className="w-3.5 h-3.5" /> Back to graph
    </button>
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
