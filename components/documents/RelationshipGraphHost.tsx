"use client";

// Mounts once in the protected layout and listens for a global
// `open-relationship-graph` CustomEvent carrying { documentId }. This lets any
// surface (the command palette, a doc inspector button) open the relationship
// map without threading state through the tree.

import React from "react";
import RelationshipGraph from "@/components/documents/RelationshipGraph";

export interface OpenRelationshipGraphDetail { documentId: string }

export function openRelationshipGraph(documentId: string) {
  window.dispatchEvent(new CustomEvent("open-relationship-graph", { detail: { documentId } }));
}

export default function RelationshipGraphHost() {
  const [docId, setDocId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenRelationshipGraphDetail>).detail;
      if (detail?.documentId) setDocId(detail.documentId);
    };
    window.addEventListener("open-relationship-graph", onOpen as EventListener);
    return () => window.removeEventListener("open-relationship-graph", onOpen as EventListener);
  }, []);

  if (!docId) return null;
  return <RelationshipGraph documentId={docId} onClose={() => setDocId(null)} />;
}
