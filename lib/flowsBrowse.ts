// lib/flowsBrowse.ts — pure assembly for the PFD picker's browse model.
//
// The picker shows the user's OWN filing map: the document-control tree,
// exactly as it looks on the Documents side —
//
//   Document library
//     └─ folder
//         └─ sub-folder
//             └─ every controlled document, no caps
//
// — and EVERY document appears, each carrying its AI status. A file the AI
// can read is a "Read flows" row; a file it can't is still THERE, with the
// reason and the fix printed on it:
//
//   ready         — mirrored into a knowledge library, readable now
//   indexing      — mirrored, still being indexed (pending / indexing / stale)
//   ingest_failed — mirrored, indexing FAILED; the stored reason rides on the
//                   row (FLOW-7 — never "indexing…" forever)
//   pending_sync  — watched by a knowledge library, mirror hasn't run (Sync)
//   unwatched     — no knowledge library watches its folder (link it)
//   not_pdf       — current revision isn't a PDF (the AI reads PDFs only)
//   not_current   — superseded / void / archived
//   no_file       — no current file attached yet
//   held_back     — a controller excluded it from AI
//
// The new folder that "went missing" can't go missing here: it's a node in
// the tree the moment it holds a document, whatever that document's state.
//
// Pure and testable: the API route feeds it plain data, no I/O here.

export type DcDocState =
  | "ready" | "indexing" | "ingest_failed" | "pending_sync" | "unwatched" | "not_pdf"
  | "not_current" | "no_file" | "held_back";

/** A knowledge document's state as the picker shows it (FLOW-7): ready to
 *  read, still indexing, or failed — `error` is terminal (the ingester never
 *  picks it up again), so it is never shown as indexing. */
export function mirrorState(status: string | null | undefined): "ready" | "indexing" | "ingest_failed" {
  if (status === "ready") return "ready";
  if (status === "error") return "ingest_failed";
  return "indexing";
}

export interface DcDocRow {
  dcDocId: string;
  name: string;
  state: DcDocState;
  /** Set when mirrored into a knowledge library — the id the flow reader
   *  takes. */
  kdocId: string | null;
  pageCount: number | null;
  /** ingest_failed: the reason the ingester stored. */
  error?: string | null;
  /** The knowledge library the mirror lives in (AREA-5: the area's own shelf). */
  kLibraryId?: string | null;
}

export interface DcFolderNode {
  id: string;
  name: string;
  /** Some knowledge library watches this folder. */
  watched: boolean;
  docs: DcDocRow[];
  folders: DcFolderNode[];
  /** Docs here plus in every descendant folder. */
  totalDocs: number;
}

export interface DcLibraryNode {
  id: string;
  name: string;
  watched: boolean;
  /** Docs filed at the library root (no folder). */
  docs: DcDocRow[];
  folders: DcFolderNode[];
  totalDocs: number;
}

export interface FlowsBrowseUploadGroup {
  knowledgeLibraryId: string;
  knowledgeLibraryName: string;
  docs: Array<{
    kdocId: string; name: string; pageCount: number | null;
    state: "ready" | "indexing" | "ingest_failed";
    error?: string | null;
  }>;
}

export interface FlowsBrowseResult {
  /** The document-control tree, mirrored. */
  tree: DcLibraryNode[];
  /** PDFs uploaded straight into an AI knowledge library (no DC origin). */
  uploads: FlowsBrowseUploadGroup[];
}

export interface FlowsBrowseInputs {
  knowledgeLibraries: Array<{ id: string; name: string }>;
  knowledgeDocs: Array<{
    id: string; name: string; libraryId: string;
    pageCount: number | null; status: string | null;
    sourceDocumentId: string | null;
    /** The ingester's stored reason when status is 'error'. */
    error?: string | null;
  }>;
  sources: Array<{
    knowledgeLibraryId: string;
    sourceType: "library" | "folder";
    sourceId: string;
  }>;
  /** DC library id → name. */
  dcLibraryNames: Map<string, string>;
  /** DC folder (collection) id → shape. */
  dcFolders: Map<string, {
    name: string; libraryId: string;
    parentId: string | null;
  }>;
  /** EVERY controlled document in the org, with its AI-boundary block (null
   *  when the boundary allows it). */
  dcDocs: Array<{
    id: string; name: string; libraryId: string; collectionId: string | null;
    block: "held_back" | "not_current" | "no_file" | null;
  }>;
  /** Readable docs whose current revision is not an ingestable PDF. */
  nonPdfDocIds: Set<string>;
}

/** Folder ids in the subtree rooted at folderId (inclusive), via parent
 *  links. Mirrors the server-side sync's coverage rule exactly. */
function subtree(folderId: string, dcFolders: FlowsBrowseInputs["dcFolders"]): Set<string> {
  const children = new Map<string, string[]>();
  for (const [id, f] of dcFolders) {
    if (!f.parentId) continue;
    const list = children.get(f.parentId) ?? [];
    list.push(id);
    children.set(f.parentId, list);
  }
  const out = new Set<string>();
  const stack = [folderId];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const c of children.get(cur) ?? []) stack.push(c);
  }
  return out;
}

/** What a set of sources watches: whole DC libraries, folder subtrees, and
 *  which DC libraries are touched at all. */
export function sourceCoverage(
  sources: Array<{ sourceType: "library" | "folder"; sourceId: string }>,
  dcFolders: FlowsBrowseInputs["dcFolders"],
): { wholeLibs: Set<string>; coveredFolders: Set<string>; touchedLibs: Set<string> } {
  const wholeLibs = new Set(sources.filter((s) => s.sourceType === "library").map((s) => s.sourceId));
  const coveredFolders = new Set<string>();
  const touchedLibs = new Set<string>(wholeLibs);
  for (const s of sources) {
    if (s.sourceType !== "folder") continue;
    for (const id of subtree(s.sourceId, dcFolders)) coveredFolders.add(id);
    const home = dcFolders.get(s.sourceId)?.libraryId;
    if (home) touchedLibs.add(home);
  }
  return { wholeLibs, coveredFolders, touchedLibs };
}

/** Is a doc filed at (libraryId, collectionId) inside this coverage? Root
 *  docs (no folder) are covered only by whole-library sources. */
export function isCovered(
  doc: { libraryId: string; collectionId: string | null },
  cov: { wholeLibs: Set<string>; coveredFolders: Set<string> },
): boolean {
  if (cov.wholeLibs.has(doc.libraryId)) return true;
  return !!doc.collectionId && cov.coveredFolders.has(doc.collectionId);
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

export function assembleFlowsBrowse(inputs: FlowsBrowseInputs): FlowsBrowseResult {
  const {
    knowledgeLibraries, knowledgeDocs, sources,
    dcLibraryNames, dcFolders, dcDocs, nonPdfDocIds,
  } = inputs;

  const union = sourceCoverage(sources, dcFolders);

  // Which knowledge doc mirrors each DC doc (prefer a ready mirror).
  const mirrorByDc = new Map<string, FlowsBrowseInputs["knowledgeDocs"][number]>();
  for (const k of knowledgeDocs) {
    if (!k.sourceDocumentId) continue;
    const prev = mirrorByDc.get(k.sourceDocumentId);
    if (!prev || (prev.status !== "ready" && k.status === "ready")) {
      mirrorByDc.set(k.sourceDocumentId, k);
    }
  }

  // ── Every controlled doc becomes a row with its state ─────────────────
  const rowsByContainer = new Map<string, DcDocRow[]>(); // "lib:<id>" | "folder:<id>"
  const libsWithDocs = new Set<string>();
  for (const d of dcDocs) {
    const mirror = mirrorByDc.get(d.id);
    // A mirror still being indexed (pending/stale) is NOT ready — a "Read"
    // on it would scan page 1 of an unpaged file and blame the drawing for
    // having no flows. A FAILED one says so, with its reason (FLOW-7).
    const state: DcDocState = mirror
      ? mirrorState(mirror.status)
      : d.block
        ? d.block
        : !isCovered(d, union)
          ? "unwatched"
          : nonPdfDocIds.has(d.id)
            ? "not_pdf"
            : "pending_sync";
    const row: DcDocRow = {
      dcDocId: d.id,
      name: mirror?.name ?? d.name,
      state,
      kdocId: mirror?.id ?? null,
      pageCount: mirror?.pageCount ?? null,
      ...(state === "ingest_failed" ? { error: mirror?.error ?? null } : {}),
      ...(mirror ? { kLibraryId: mirror.libraryId } : {}),
    };
    const key = d.collectionId ? `folder:${d.collectionId}` : `lib:${d.libraryId}`;
    const list = rowsByContainer.get(key) ?? [];
    list.push(row);
    rowsByContainer.set(key, list);
    libsWithDocs.add(d.libraryId);
  }

  // ── Fold folders into trees per DC library ────────────────────────────
  const childFolders = new Map<string, string[]>(); // parent folder id → children
  const rootFolders = new Map<string, string[]>();  // dc library id → root folder ids
  for (const [id, f] of dcFolders) {
    if (f.parentId && dcFolders.has(f.parentId)) {
      const list = childFolders.get(f.parentId) ?? [];
      list.push(id);
      childFolders.set(f.parentId, list);
    } else {
      const list = rootFolders.get(f.libraryId) ?? [];
      list.push(id);
      rootFolders.set(f.libraryId, list);
    }
  }

  const buildFolder = (folderId: string): DcFolderNode | null => {
    const f = dcFolders.get(folderId);
    if (!f) return null;
    const docs = (rowsByContainer.get(`folder:${folderId}`) ?? []).sort(byName);
    const folders = (childFolders.get(folderId) ?? [])
      .map(buildFolder)
      .filter((n): n is DcFolderNode => n !== null)
      .sort(byName);
    const totalDocs = docs.length + folders.reduce((s, n) => s + n.totalDocs, 0);
    // Empty subtrees fold away — the tree shows where documents LIVE.
    if (totalDocs === 0) return null;
    return {
      id: folderId,
      name: f.name,
      watched: isCovered({ libraryId: f.libraryId, collectionId: folderId }, union),
      docs, folders, totalDocs,
    };
  };

  const tree: DcLibraryNode[] = [];
  const allLibIds = new Set<string>([...dcLibraryNames.keys(), ...libsWithDocs]);
  for (const libId of allLibIds) {
    const docs = (rowsByContainer.get(`lib:${libId}`) ?? []).sort(byName);
    const folders = (rootFolders.get(libId) ?? [])
      .map(buildFolder)
      .filter((n): n is DcFolderNode => n !== null)
      .sort(byName);
    const totalDocs = docs.length + folders.reduce((s, n) => s + n.totalDocs, 0);
    if (totalDocs === 0) continue;
    const anyFolderWatched = (function anyWatched(nodes: DcFolderNode[]): boolean {
      return nodes.some((n) => n.watched || anyWatched(n.folders));
    })(folders);
    tree.push({
      id: libId,
      name: dcLibraryNames.get(libId) ?? "Library",
      watched: union.wholeLibs.has(libId) || anyFolderWatched,
      docs, folders, totalDocs,
    });
  }
  tree.sort(byName);

  // ── Direct uploads: PDFs living only on the AI side ───────────────────
  const klName = new Map(knowledgeLibraries.map((l) => [l.id, l.name]));
  const knownDc = new Set(dcDocs.map((d) => d.id));
  const uploadsByKl = new Map<string, FlowsBrowseUploadGroup>();
  for (const k of knowledgeDocs) {
    // No DC origin — or an origin doc control no longer has: either way the
    // file exists only on the AI side, and it must not vanish from view.
    if (k.sourceDocumentId && knownDc.has(k.sourceDocumentId)) continue;
    const g = uploadsByKl.get(k.libraryId) ?? {
      knowledgeLibraryId: k.libraryId,
      knowledgeLibraryName: klName.get(k.libraryId) ?? "Knowledge library",
      docs: [],
    };
    const upState = mirrorState(k.status);
    g.docs.push({
      kdocId: k.id, name: k.name, pageCount: k.pageCount, state: upState,
      ...(upState === "ingest_failed" ? { error: k.error ?? null } : {}),
    });
    uploadsByKl.set(k.libraryId, g);
  }
  const uploads = [...uploadsByKl.values()]
    .sort((a, b) => a.knowledgeLibraryName.localeCompare(b.knowledgeLibraryName));
  for (const g of uploads) g.docs.sort(byName);

  return { tree, uploads };
}

/** AREA-5: how many documents the "this area's library" filter would show —
 *  the mirrors that live in the area's knowledge library, in the tree and
 *  among direct uploads. A document in the area's folders that is not yet
 *  mirrored (pending sync, unwatched) carries no library and is NOT counted,
 *  so a bound shelf that has not synced reads 0 and the reader opens on
 *  every library instead of an empty list. */
export function areaShelfDocCount(model: Pick<FlowsBrowseResult, "tree" | "uploads">, areaLibraryId: string): number {
  let n = 0;
  const walk = (docs: DcDocRow[], folders: DcFolderNode[]) => {
    for (const d of docs) if (d.kLibraryId === areaLibraryId) n += 1;
    for (const f of folders) walk(f.docs, f.folders);
  };
  for (const l of model.tree) walk(l.docs, l.folders);
  for (const g of model.uploads) if (g.knowledgeLibraryId === areaLibraryId) n += g.docs.length;
  return n;
}
