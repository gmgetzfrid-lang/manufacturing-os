// lib/pageHeader.ts
// Resolve a page's hero-header descriptor with inheritance:
//   current folder → its ancestors (nearest first) → the library.
// The title/description are always the CURRENT node's; the cover/color/
// icon fall back up the chain so one image set high up cascades down.
// Returns null when nothing should render (un-customized pages stay as-is).

import type { LibraryCollection, LibraryConfig, HeaderHeight } from "@/types/schema";

export interface ResolvedHeader {
  title: string;
  description?: string;
  icon?: string;
  color?: string;
  coverImageUrl?: string;
  coverTint?: "none" | "brand" | "mono";
  height: Exclude<HeaderHeight, "none">;
}

function firstDefined<T>(nodes: Array<Record<string, unknown>>, key: string): T | undefined {
  for (const n of nodes) {
    const v = n[key];
    if (v !== undefined && v !== null && v !== "") return v as T;
  }
  return undefined;
}

export function resolvePageHeader(
  currentFolder: LibraryCollection | null,
  folderMap: Map<string, LibraryCollection>,
  library: LibraryConfig | null,
): ResolvedHeader | null {
  if (!library) return null;

  // Chain: current node first, then ancestors nearest-first, then library.
  const chain: Array<Record<string, unknown>> = [];
  if (currentFolder) {
    chain.push(currentFolder as unknown as Record<string, unknown>);
    const ancestors = [...(currentFolder.pathIds ?? [])].reverse();
    for (const id of ancestors) {
      const node = folderMap.get(id);
      if (node) chain.push(node as unknown as Record<string, unknown>);
    }
  }
  chain.push(library as unknown as Record<string, unknown>);

  const coverImageUrl = firstDefined<string>(chain, "coverImageUrl");
  const color = firstDefined<string>(chain, "color");
  const coverTint = firstDefined<ResolvedHeader["coverTint"]>(chain, "coverTint");
  const icon = (currentFolder?.icon) ?? firstDefined<string>(chain, "icon");

  // Explicit height anywhere in the chain wins; else derive a sensible one.
  let explicitHeight: HeaderHeight | undefined;
  for (const n of chain) {
    const h = (n.pageConfig as { header?: { height?: HeaderHeight } } | undefined)?.header?.height;
    if (h) { explicitHeight = h; break; }
  }
  if (explicitHeight === "none") return null;
  // Render only when there's something to show.
  if (!coverImageUrl && !color && !explicitHeight) return null;

  const height: ResolvedHeader["height"] =
    explicitHeight ?? (coverImageUrl ? "standard" : "compact");

  return {
    title: currentFolder?.name ?? library.name,
    description: currentFolder ? currentFolder.description : library.description,
    icon,
    color,
    coverImageUrl,
    coverTint,
    height,
  };
}
