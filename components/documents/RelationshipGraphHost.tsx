"use client";

// Mounts once in the protected layout and listens for a global
// `open-relationship-graph` CustomEvent carrying { documentId }. This lets any
// surface (the command palette, a doc inspector button) open the relationship
// map without threading state through the tree.
//
// The listener is in the app shell from mount; the map itself
// (RelationshipGraph and its search) is fetched when the browser is first
// idle, or at the first open, and shows as soon as it lands (projects-tab
// PERF-12, projects-joint J18).

import React from "react";
import { lazyModule, usePreloadWhenIdle } from "@/lib/lazyModule";

export const relationshipGraphModule = lazyModule(
  () => import("@/components/documents/RelationshipGraph"),
  "relationship map",
);

export interface OpenRelationshipGraphDetail { documentId: string }

export function openRelationshipGraph(documentId: string) {
  window.dispatchEvent(new CustomEvent("open-relationship-graph", { detail: { documentId } }));
}

export default function RelationshipGraphHost() {
  const [docId, setDocId] = React.useState<string | null>(null);
  usePreloadWhenIdle(relationshipGraphModule);

  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenRelationshipGraphDetail>).detail;
      if (detail?.documentId) setDocId(detail.documentId);
    };
    window.addEventListener("open-relationship-graph", onOpen as EventListener);
    return () => window.removeEventListener("open-relationship-graph", onOpen as EventListener);
  }, []);

  const loaded = relationshipGraphModule.useLoaded(!!docId);
  if (!docId || !loaded) return null;
  const RelationshipGraph = loaded.default;
  return <RelationshipGraph documentId={docId} onClose={() => setDocId(null)} />;
}
