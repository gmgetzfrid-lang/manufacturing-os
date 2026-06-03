// lib/pageHeader.ts
// Resolve a page's hero-header descriptor with inheritance:
//   current folder → its ancestors (nearest first) → the library.
// The title/description are always the CURRENT node's; the cover/color/
// icon fall back up the chain so one image set high up cascades down.
// Returns null when nothing should render (un-customized pages stay as-is).

import type { LibraryCollection, LibraryConfig, HeaderHeight, PageConfig } from "@/types/schema";

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

/** Build the inheritance chain: current node → ancestors (nearest first)
 *  → library. Shared by header + background resolution. */
function buildChain(
  currentFolder: LibraryCollection | null,
  folderMap: Map<string, LibraryCollection>,
  library: LibraryConfig,
): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  if (currentFolder) {
    chain.push(currentFolder as unknown as Record<string, unknown>);
    for (const id of [...(currentFolder.pathIds ?? [])].reverse()) {
      const node = folderMap.get(id);
      if (node) chain.push(node as unknown as Record<string, unknown>);
    }
  }
  chain.push(library as unknown as Record<string, unknown>);
  return chain;
}

export interface ResolvedBackground {
  type: "tint" | "image";
  imagePath?: string;
  opacity: number;          // already clamped for legibility
  tint: "brand" | "neutral";
}

/** Resolve a page background with the same inheritance as the header.
 *  Opacity is clamped so content (always on opaque cards) stays legible. */
export function resolvePageBackground(
  currentFolder: LibraryCollection | null,
  folderMap: Map<string, LibraryCollection>,
  library: LibraryConfig | null,
): ResolvedBackground | null {
  if (!library) return null;
  const chain = buildChain(currentFolder, folderMap, library);
  let bg: NonNullable<PageConfig["background"]> | undefined;
  for (const n of chain) {
    const b = (n.pageConfig as PageConfig | undefined)?.background;
    if (b && b.type) { bg = b; break; }
  }
  if (!bg || bg.type === "none" || !bg.type) return null;
  const tint = bg.tint ?? "neutral";
  if (bg.type === "image" && bg.imagePath) {
    const opacity = Math.max(0.05, Math.min(0.35, bg.opacity ?? 0.18));
    return { type: "image", imagePath: bg.imagePath, opacity, tint };
  }
  if (bg.type === "tint") {
    return { type: "tint", opacity: 1, tint };
  }
  return null;
}

export function resolvePageHeader(
  currentFolder: LibraryCollection | null,
  folderMap: Map<string, LibraryCollection>,
  library: LibraryConfig | null,
): ResolvedHeader | null {
  if (!library) return null;
  const chain = buildChain(currentFolder, folderMap, library);

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
