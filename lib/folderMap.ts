// lib/folderMap.ts - the map of the folder you are in.
//
//   The folder
//     → its subfolders
//     → its files (the drawings filed right here)
//         → the equipment on each file
//
// The map follows the list: in a unit's P&ID folder it shows that unit's
// P&IDs, and each one's equipment hangs off it. A piece of equipment drawn
// on three sheets shows under each of the three. A big folder's files are
// put in runs so every label can still be read. Pure.

import type { TreeNode } from "@/lib/estateTree";
import type { GraphNode } from "@/lib/orgGraph";

export interface FolderMapDoc {
  id: string;
  number: string | null;
  title: string | null;
  /** The file's name, for its icon. */
  name: string | null;
  sheet: string | null;
  href: string;
}
export interface FolderMapSub { id: string; name: string; count?: number | null }
export interface FolderMapEquip { id: string; tag: string; sub?: string | null }
export interface FolderMapInput {
  /** `id` null: the top of a library. */
  folder: { id: string | null; name: string };
  subfolders: FolderMapSub[];
  docs: FolderMapDoc[];
  /** Equipment on each file, by document id. */
  onDoc?: ReadonlyMap<string, FolderMapEquip[]>;
  /** Files in the folder that are not in `docs` (a short list shown). */
  more?: number;
}
export interface FolderMap {
  rootId: string;
  tree: TreeNode[];
  /** What each thing on the map is, by its graph id. */
  nodes: GraphNode[];
  /** The file's own name by graph id, for its icon. */
  fileNames: Record<string, string>;
}

/** More files than this are shown in runs of this many. */
export const RUN = 36;

const sheetNo = (s: string | null) => (s == null ? "" : String(s).replace(/^0+(?=\d)/, ""));

/** What a file is called on the map: its number, with the sheet when the
 *  number repeats in this folder; else its title or file name. */
export function folderDocLabels(docs: FolderMapDoc[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const d of docs) if (d.number) count.set(d.number, (count.get(d.number) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const d of docs) {
    const repeats = !!d.number && (count.get(d.number) ?? 0) > 1;
    out.set(d.id, d.number ? (repeats && sheetNo(d.sheet) ? `${d.number} · Sh ${sheetNo(d.sheet)}` : d.number) : (d.title || d.name || "Document"));
  }
  return out;
}

export const folderNodeId = (id: string | null) => `folder:${id ?? "top"}`;
/** Equipment under a file: the same equipment under another file is another dot. */
export const equipOnDocId = (assetId: string, docId: string) => `asset:${assetId}@doc:${docId}`;

export function buildFolderMap(input: FolderMapInput): FolderMap {
  const rootId = folderNodeId(input.folder.id);
  const tree: TreeNode[] = [{ id: rootId, label: input.folder.name, parentId: null, kind: "folder", graphId: rootId }];
  const nodes: GraphNode[] = [{ id: rootId, type: "library", label: input.folder.name, href: "", degree: 0 }];
  const fileNames: Record<string, string> = {};
  const seenNode = new Set<string>([rootId]);
  const addNode = (n: GraphNode) => { if (!seenNode.has(n.id)) { seenNode.add(n.id); nodes.push(n); } };

  for (const f of [...input.subfolders].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const id = folderNodeId(f.id);
    tree.push({ id, label: f.count ? `${f.name} (${f.count})` : f.name, parentId: rootId, kind: "folder", graphId: id });
    addNode({ id, type: "library", label: f.name, href: "", degree: 0 });
  }

  const labels = folderDocLabels(input.docs);
  const docs = [...input.docs].sort((a, b) => (labels.get(a.id) ?? "").localeCompare(labels.get(b.id) ?? "", undefined, { numeric: true }));
  // A folder of hundreds: its files in runs, named for the first and last in each.
  const runs: FolderMapDoc[][] = [];
  if (docs.length + input.subfolders.length > RUN * 1.5) for (let i = 0; i < docs.length; i += RUN) runs.push(docs.slice(i, i + RUN));
  const place = (d: FolderMapDoc, parentId: string) => {
    const id = `doc:${d.id}`;
    const equip = input.onDoc?.get(d.id) ?? [];
    tree.push({ id, label: labels.get(d.id) ?? "Document", parentId, kind: "document", graphId: id });
    addNode({ id, type: "document", label: labels.get(d.id) ?? "Document", sub: d.title ?? undefined, href: d.href, degree: equip.length });
    if (d.name) fileNames[id] = d.name;
    const seen = new Set<string>();
    for (const e of [...equip].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }))) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      tree.push({ id: equipOnDocId(e.id, d.id), label: e.tag, parentId: id, kind: "asset", graphId: `asset:${e.id}` });
      addNode({ id: `asset:${e.id}`, type: "asset", label: e.tag, sub: e.sub ?? undefined, href: "", degree: 0 });
    }
  };
  if (!runs.length) for (const d of docs) place(d, rootId);
  else runs.forEach((run, i) => {
    const gid = `run:${rootId}:${i}`;
    const first = labels.get(run[0].id) ?? "", last = labels.get(run[run.length - 1].id) ?? "";
    tree.push({ id: gid, label: `${first} to ${last} (${run.length})`, parentId: rootId, kind: "group", graphId: null });
    for (const d of run) place(d, gid);
  });
  // A short list: say how many are not on the map, never let it read as all.
  if (input.more && input.more > 0) tree.push({ id: `more:${rootId}`, label: `${input.more} more not shown here`, parentId: rootId, kind: "group", graphId: null });
  return { rootId, tree, nodes, fileNames };
}
