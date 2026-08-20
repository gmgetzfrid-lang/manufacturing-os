// lib/flowsBrowse.ts — pure assembly for the PFD picker's browse model.
//
// The "Read flows from a document" picker used to show a flat, newest-first,
// 50-row list of knowledge documents — which read as "folders" to anyone
// whose mental map is their document-control structure, and silently hid
// everything past row 50. This module builds the TRUE hierarchy instead:
//
//   AI knowledge library
//     └─ the document-control container each mirrored doc came from
//        (DC library / folder path), or "Uploaded directly"
//          └─ every document, no caps
//
// and, per knowledge library, names the DC containers its sources DON'T
// cover — the honest answer to "why is a folder missing?": because it was
// never linked, not because the app lost it.
//
// Pure and testable: the API route feeds it plain data, no I/O here.

export interface FlowsBrowseDoc {
  id: string;
  name: string;
  pageCount: number | null;
  status: string | null;
}

export interface FlowsBrowseGroup {
  /** Stable key for React lists. */
  key: string;
  /** "North Library / PFDs / Unit 20" or "Uploaded directly". */
  label: string;
  docs: FlowsBrowseDoc[];
}

export interface FlowsBrowseMissing {
  label: string;
  docCount: number;
}

export interface FlowsBrowseLibrary {
  id: string;
  name: string;
  docCount: number;
  groups: FlowsBrowseGroup[];
  /** DC containers with documents this library's sources don't watch. */
  missing: FlowsBrowseMissing[];
}

export interface FlowsBrowseInputs {
  knowledgeLibraries: Array<{ id: string; name: string }>;
  knowledgeDocs: Array<{
    id: string; name: string; libraryId: string;
    pageCount: number | null; status: string | null;
    sourceDocumentId: string | null;
  }>;
  sources: Array<{
    knowledgeLibraryId: string;
    sourceType: "library" | "folder";
    sourceId: string;
  }>;
  /** DC library id → name. */
  dcLibraryNames: Map<string, string>;
  /** DC folder (collection) id → shape. pathNames is root-first. */
  dcFolders: Map<string, {
    name: string; libraryId: string;
    parentId: string | null; pathNames: string[];
  }>;
  /** Mirrored DC doc id → where it lives in doc control. */
  dcDocContainers: Map<string, { libraryId: string | null; collectionId: string | null }>;
  /** AI-readable DC docs in libraries touched by folder-scoped sources —
   *  the pool "missing" counts are drawn from. */
  dcCountableDocs: Array<{ libraryId: string; collectionId: string | null }>;
}

const UPLOADS_LABEL = "Uploaded directly";

function folderLabel(
  folderId: string,
  dcFolders: FlowsBrowseInputs["dcFolders"],
  dcLibraryNames: Map<string, string>,
): string {
  const f = dcFolders.get(folderId);
  if (!f) return "Folder (removed from document control)";
  const lib = dcLibraryNames.get(f.libraryId) ?? "Library";
  const path = f.pathNames.length > 0 ? f.pathNames : [f.name];
  return `${lib} / ${path.join(" / ")}`;
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

export function assembleFlowsBrowse(inputs: FlowsBrowseInputs): FlowsBrowseLibrary[] {
  const {
    knowledgeLibraries, knowledgeDocs, sources,
    dcLibraryNames, dcFolders, dcDocContainers, dcCountableDocs,
  } = inputs;

  const docsByLib = new Map<string, FlowsBrowseInputs["knowledgeDocs"]>();
  for (const d of knowledgeDocs) {
    const list = docsByLib.get(d.libraryId) ?? [];
    list.push(d);
    docsByLib.set(d.libraryId, list);
  }
  const sourcesByLib = new Map<string, FlowsBrowseInputs["sources"]>();
  for (const s of sources) {
    const list = sourcesByLib.get(s.knowledgeLibraryId) ?? [];
    list.push(s);
    sourcesByLib.set(s.knowledgeLibraryId, list);
  }

  return knowledgeLibraries.map((kl) => {
    // ── Group this library's docs by their DC container ──────────────────
    const groups = new Map<string, FlowsBrowseGroup>();
    const push = (key: string, label: string, doc: FlowsBrowseDoc) => {
      const g = groups.get(key) ?? { key, label, docs: [] };
      g.docs.push(doc);
      groups.set(key, g);
    };
    for (const d of docsByLib.get(kl.id) ?? []) {
      const doc: FlowsBrowseDoc = { id: d.id, name: d.name, pageCount: d.pageCount, status: d.status };
      if (!d.sourceDocumentId) {
        push("__uploads", UPLOADS_LABEL, doc);
        continue;
      }
      const at = dcDocContainers.get(d.sourceDocumentId);
      if (at?.collectionId) {
        push(`f:${at.collectionId}`, folderLabel(at.collectionId, dcFolders, dcLibraryNames), doc);
      } else if (at?.libraryId) {
        const lib = dcLibraryNames.get(at.libraryId) ?? "Library";
        push(`lr:${at.libraryId}`, `${lib} / (library root)`, doc);
      } else {
        push("__dc", "From document control", doc);
      }
    }
    const sortedGroups = [...groups.values()]
      .sort((a, b) => {
        // Uploads sink to the bottom; controlled containers sort by path.
        const au = a.key === "__uploads" ? 1 : 0;
        const bu = b.key === "__uploads" ? 1 : 0;
        if (au !== bu) return au - bu;
        return a.label.localeCompare(b.label, undefined, { numeric: true });
      });
    for (const g of sortedGroups) {
      g.docs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }

    // ── Coverage: which DC containers do this library's sources watch? ───
    const libSources = sourcesByLib.get(kl.id) ?? [];
    const wholeLibs = new Set(libSources.filter((s) => s.sourceType === "library").map((s) => s.sourceId));
    const coveredFolders = new Set<string>();
    const touchedLibs = new Set<string>(wholeLibs);
    for (const s of libSources) {
      if (s.sourceType !== "folder") continue;
      for (const id of subtree(s.sourceId, dcFolders)) coveredFolders.add(id);
      const home = dcFolders.get(s.sourceId)?.libraryId;
      if (home) touchedLibs.add(home);
    }

    // A library-scoped source covers everything in it — nothing can be
    // missing there. Folder-scoped sources leave siblings (and the library
    // root) dark: count the documents sitting in those dark corners.
    const missingCount = new Map<string, number>();
    for (const d of dcCountableDocs) {
      if (!touchedLibs.has(d.libraryId) || wholeLibs.has(d.libraryId)) continue;
      if (d.collectionId && coveredFolders.has(d.collectionId)) continue;
      const key = d.collectionId ? `f:${d.collectionId}` : `lr:${d.libraryId}`;
      missingCount.set(key, (missingCount.get(key) ?? 0) + 1);
    }
    const missing: FlowsBrowseMissing[] = [...missingCount.entries()]
      .map(([key, docCount]) => ({
        label: key.startsWith("f:")
          ? folderLabel(key.slice(2), dcFolders, dcLibraryNames)
          : `${dcLibraryNames.get(key.slice(3)) ?? "Library"} / (library root)`,
        docCount,
      }))
      .sort((a, b) => b.docCount - a.docCount)
      .slice(0, 6);

    return {
      id: kl.id,
      name: kl.name,
      docCount: (docsByLib.get(kl.id) ?? []).length,
      groups: sortedGroups,
      missing,
    };
  });
}
