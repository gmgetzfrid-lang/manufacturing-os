// lib/estate/lenses.ts — the same node, seen from another lens.
//
// One graph, several views. Each helper takes a node id and returns where
// that node is shown in the other lens, so "open in the global view" and
// "see it on the Documents map" are one-liners everywhere.

import { parseNid } from "./ids";

/** The Intelligence graph, centred on this node. */
export function globalGraphHref(nodeId: string): string {
  return `/graph?focus=${encodeURIComponent(nodeId)}`;
}

/** The Documents map: a document is revealed in its folder; anything else
 *  becomes a search for it, which lights every file it relates to. */
export function documentsGraphHref(nodeId: string, label?: string): string {
  const p = parseNid(nodeId);
  if (p?.kind === "doc" || p?.kind === "folder" || p?.kind === "lib") return `/documents/graph?reveal=${encodeURIComponent(nodeId)}`;
  return `/documents/graph?q=${encodeURIComponent(label ?? nodeId)}`;
}
