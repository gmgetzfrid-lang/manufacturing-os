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
// And — the part that kills support tickets — a document visible in doc
// control but absent here is ALWAYS explained by name. The four ways a file
// stays invisible to the AI, each reported separately:
//
//   unwatched     — its container isn't linked to ANY knowledge library
//                   (org-wide panel: "the AI can't see this folder at all")
//   missing       — this KL watches some folders of its DC library but not
//                   this one (per-library: "never linked, not lost")
//   pendingSync   — watched and readable, mirror just hasn't run (Sync now)
//   notPdf / held — watched, but the current revision isn't a PDF, or the
//                   AI boundary blocks it (not current / no file / held back)
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
  /** DC containers with documents this library's sources don't watch
   *  (folder-scoped sources leaving siblings dark). */
  missing: FlowsBrowseMissing[];
  /** Watched, readable documents the mirror hasn't picked up yet — a Sync
   *  fixes exactly these. */
  pendingSync: number;
  /** Watched documents whose current revision isn't a PDF — the AI reads
   *  PDFs only, no Sync will ever add them. */
  notPdf: number;
  /** Watched documents the AI boundary blocks, tallied by reason. */
  held: Array<{ reason: "held_back" | "not_current" | "no_file"; count: number }>;
}

export interface FlowsBrowseResult {
  libraries: FlowsBrowseLibrary[];
  /** Containers with readable documents that NO knowledge library watches —
   *  the org-wide answer to "I can see it in Documents but the AI can't". */
  unwatched: FlowsBrowseMissing[];
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
  /** Every AI-readable controlled doc in the org (status/version/exclusion
   *  gates already applied by the route). */
  dcCountableDocs: Array<{ id: string; libraryId: string; collectionId: string | null }>;
  /** Controlled docs the AI boundary blocks, with the reason. */
  dcHeldDocs: Array<{
    libraryId: string; collectionId: string | null;
    reason: "held_back" | "not_current" | "no_file";
  }>;
  /** Among covered-but-unmirrored readable docs: those whose current
   *  revision is not an ingestable PDF. */
  nonPdfDocIds: Set<string>;
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

/** What a set of sources watches: whole DC libraries, folder subtrees, and
 *  which DC libraries are touched at all. Exported so the route can pick
 *  candidates for the (bounded) PDF check with the same rule. */
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

const containerKey = (d: { libraryId: string; collectionId: string | null }) =>
  d.collectionId ? `f:${d.collectionId}` : `lr:${d.libraryId}`;

function containerLabelFromKey(
  key: string,
  dcFolders: FlowsBrowseInputs["dcFolders"],
  dcLibraryNames: Map<string, string>,
): string {
  return key.startsWith("f:")
    ? folderLabel(key.slice(2), dcFolders, dcLibraryNames)
    : `${dcLibraryNames.get(key.slice(3)) ?? "Library"} / (library root)`;
}

export function assembleFlowsBrowse(inputs: FlowsBrowseInputs): FlowsBrowseResult {
  const {
    knowledgeLibraries, knowledgeDocs, sources,
    dcLibraryNames, dcFolders, dcDocContainers,
    dcCountableDocs, dcHeldDocs, nonPdfDocIds,
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

  const libraries = knowledgeLibraries.map((kl) => {
    // ── Group this library's docs by their DC container ──────────────────
    const groups = new Map<string, FlowsBrowseGroup>();
    const push = (key: string, label: string, doc: FlowsBrowseDoc) => {
      const g = groups.get(key) ?? { key, label, docs: [] };
      g.docs.push(doc);
      groups.set(key, g);
    };
    const mirroredDcIds = new Set<string>();
    for (const d of docsByLib.get(kl.id) ?? []) {
      const doc: FlowsBrowseDoc = { id: d.id, name: d.name, pageCount: d.pageCount, status: d.status };
      if (!d.sourceDocumentId) {
        push("__uploads", UPLOADS_LABEL, doc);
        continue;
      }
      mirroredDcIds.add(d.sourceDocumentId);
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
    const cov = sourceCoverage(libSources, dcFolders);

    // A library-scoped source covers everything in it — nothing can be
    // missing there. Folder-scoped sources leave siblings (and the library
    // root) dark: count the documents sitting in those dark corners.
    const missingCount = new Map<string, number>();
    // Watched docs that aren't mirrored yet split three ways: sync just
    // hasn't run (fixable NOW), current revision isn't a PDF (never will),
    // or the AI boundary holds them (reported by reason).
    let pendingSync = 0;
    let notPdf = 0;
    for (const d of dcCountableDocs) {
      if (isCovered(d, cov)) {
        if (mirroredDcIds.has(d.id)) continue;
        if (nonPdfDocIds.has(d.id)) notPdf += 1;
        else pendingSync += 1;
        continue;
      }
      if (!cov.touchedLibs.has(d.libraryId) || cov.wholeLibs.has(d.libraryId)) continue;
      const key = containerKey(d);
      missingCount.set(key, (missingCount.get(key) ?? 0) + 1);
    }
    const heldCount = new Map<"held_back" | "not_current" | "no_file", number>();
    for (const h of dcHeldDocs) {
      if (!isCovered(h, cov)) continue;
      heldCount.set(h.reason, (heldCount.get(h.reason) ?? 0) + 1);
    }
    const missing: FlowsBrowseMissing[] = [...missingCount.entries()]
      .map(([key, docCount]) => ({
        label: containerLabelFromKey(key, dcFolders, dcLibraryNames),
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
      pendingSync,
      notPdf,
      held: [...heldCount.entries()].map(([reason, count]) => ({ reason, count })),
    };
  });

  // ── Org-wide: containers NO knowledge library watches at all ───────────
  // The single most common "it's missing" cause: a new DC folder that was
  // never linked anywhere. Only meaningful once at least one knowledge
  // library exists.
  const unwatched: FlowsBrowseMissing[] = [];
  if (knowledgeLibraries.length > 0) {
    const union = sourceCoverage(sources, dcFolders);
    const count = new Map<string, number>();
    for (const d of dcCountableDocs) {
      if (isCovered(d, union)) continue;
      const key = containerKey(d);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    unwatched.push(
      ...[...count.entries()]
        .map(([key, docCount]) => ({
          label: containerLabelFromKey(key, dcFolders, dcLibraryNames),
          docCount,
        }))
        .sort((a, b) => b.docCount - a.docCount)
        .slice(0, 8),
    );
  }

  return { libraries, unwatched };
}
