// lib/libraryMap.ts - the map on the Documents home: every library, and
// the top folders in each.
//
//   All libraries
//     → each library (named as in the list above the map)
//         → its top folders (named as in the library's own list)
//
// A click on a library or a folder opens it. Pure.

import type { TreeNode } from "@/lib/estateTree";
import type { GraphNode } from "@/lib/orgGraph";

export interface MapLibrary {
  id: string;
  name: string;
  /** The library's top folders. */
  folders: Array<{ id: string; name: string }>;
}

export interface LibrariesMap {
  rootId: string;
  tree: TreeNode[];
  nodes: GraphNode[];
  /** Folder id → its library id, for opening a folder. */
  libraryOf: Map<string, string>;
}

export const LIBS_ROOT = "libs:all";
export const libNodeId = (id: string) => `lib:${id}`;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });

export function buildLibrariesMap(libraries: MapLibrary[], rootLabel = "All libraries"): LibrariesMap {
  const tree: TreeNode[] = [{ id: LIBS_ROOT, label: rootLabel, parentId: null, kind: "group", graphId: LIBS_ROOT }];
  const nodes: GraphNode[] = [{ id: LIBS_ROOT, type: "library", label: rootLabel, href: "", degree: 0 }];
  const libraryOf = new Map<string, string>();
  for (const lib of libraries) {
    const lid = libNodeId(lib.id);
    tree.push({ id: lid, label: lib.name, parentId: LIBS_ROOT, kind: "library", graphId: lid });
    nodes.push({ id: lid, type: "library", label: lib.name, href: `/documents/${lib.id}`, degree: lib.folders.length });
    for (const f of [...lib.folders].sort(byName)) {
      const fid = `folder:${f.id}`;
      libraryOf.set(f.id, lib.id);
      tree.push({ id: fid, label: f.name, parentId: lid, kind: "folder", graphId: fid });
      nodes.push({ id: fid, type: "library", label: f.name, href: `/documents/${lib.id}?folderId=${f.id}`, degree: 0 });
    }
  }
  return { rootId: LIBS_ROOT, tree, nodes, libraryOf };
}

/** Where a click on the libraries map goes: a library, or a folder in one. */
export function libraryMapTarget(map: Pick<LibrariesMap, "libraryOf">, nodeId: string): { libraryId: string; folderId: string | null } | null {
  if (nodeId.startsWith("lib:")) return { libraryId: nodeId.slice(4), folderId: null };
  if (nodeId.startsWith("folder:")) {
    const folderId = nodeId.slice(7);
    const libraryId = map.libraryOf.get(folderId);
    return libraryId ? { libraryId, folderId } : null;
  }
  return null;
}
