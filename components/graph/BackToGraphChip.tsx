"use client";

// BackToGraphChip — the round trip the graph was missing.
//
// Opening a document from the org graph used to be a one-way door: a hard
// navigation, and your map — the thing you were actually reading — gone.
// The graph now stamps `from=graph` on every open; any page carrying that
// param floats this chip, and one tap returns to /graph.
//
// What comes back (GPV-11): the graph also stamps its own query string as
// `graphq` — the lens, the focused neighbourhood and its depth, the scope,
// the search and the node in the peek — so the chip lands on the view you
// left, not on a bare /graph. The forces, colours and layout restore from the
// per-org saved settings as before. Only the graph's own keys are carried
// back (sanitizeGraphQuery); a link stamped before `graphq` existed returns
// to /graph exactly as it always did. The chip rides on every protected
// page, so the graph's URL code loads only when it is tapped.

import React, { Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Waypoints } from "lucide-react";

/** Where the chip goes: /graph with the view the open was stamped with. */
export async function backToGraphHref(graphq: string | null | undefined): Promise<string> {
  if (!graphq) return "/graph";
  try {
    const { sanitizeGraphQuery } = await import("@/lib/graphSettings");
    const q = sanitizeGraphQuery(graphq);
    return q ? `/graph?${q}` : "/graph";
  } catch {
    return "/graph";
  }
}

function ChipInner() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  if (params.get("from") !== "graph" || pathname === "/graph") return null;
  const graphq = params.get("graphq");
  return (
    <button
      type="button"
      onClick={() => { void backToGraphHref(graphq).then((href) => router.push(href)); }}
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
