// lib/areaKnowledge.ts — the pure logic behind "this operating area's
// knowledge": which document-control folders LOOK like they belong to a
// unit (the wizard's auto-suggestions), and how a bound knowledge library
// drifts when someone reorganizes doc control after linking.
//
// The filing pattern this serves: type-first document control
// (drawings/PFDs/<unit>, drawings/P&IDs/<unit>, plot plans/<unit>…) feeding
// ONE knowledge library per unit — so asking the crude unit never surfaces
// another unit's drawings. The wizard finds the unit's folder inside each
// type library by name/code; drift detection notices when the structure
// changes underneath an existing link.
//
// Pure and tested — routes and components feed plain data.

export interface AreaFolder {
  id: string;
  name: string;
  libraryId: string;
  libraryName: string;
  /** Root-first path inside its library, e.g. ["P&IDs", "Crude Unit"]. */
  pathNames: string[];
  docCount: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Tokens too generic to identify a unit on their own — "Utilities Unit"
 *  must not match "Crude Unit" just because both say "unit". */
const GENERIC = new Set(["unit", "area", "plant", "system", "section", "block", "no", "number"]);

/** Does this folder look like it belongs to the unit? Matches on the
 *  DISTINCTIVE parts of the unit's label ("crude" in "Crude Unit"), or on
 *  the unit's code as a standalone number ("Unit 20", "20 - Crude").
 *  Checked against the folder's own name first, then its full path. */
export function folderMatchesUnit(
  unit: { code: string; label: string },
  folder: { name: string; pathNames: string[] },
): boolean {
  const distinct = norm(unit.label).split(" ").filter((t) => t.length >= 3 && !GENERIC.has(t));
  const code = unit.code.trim();
  const hits = (text: string): boolean => {
    const t = norm(text);
    if (distinct.length > 0 && distinct.every((d) => t.includes(d))) return true;
    if (code && new RegExp(`(^| )${code}( |$)`).test(t)) return true;
    return false;
  };
  return hits(folder.name) || hits(folder.pathNames.join(" "));
}

/** The wizard's pre-checked list: folders that look like this unit's,
 *  most-populated first so the real drawing sets lead. */
export function suggestFoldersForUnit(
  unit: { code: string; label: string },
  folders: AreaFolder[],
): AreaFolder[] {
  return folders
    .filter((f) => folderMatchesUnit(unit, f))
    .sort((a, b) => b.docCount - a.docCount || a.name.localeCompare(b.name));
}

// ── Drift: doc control reorganized after the link was made ────────────────

export interface AreaDriftInputs {
  unit: { code: string; label: string };
  /** The bound knowledge library's folder-scoped sources. */
  sources: Array<{ id: string; sourceId: string; sourceName: string }>;
  /** All folder ids that currently exist in doc control. */
  existingFolderIds: Set<string>;
  /** Folder ids the bound library's sources currently cover (subtrees
   *  expanded) — whole-library sources should set coversEverything. */
  coveredFolderIds: Set<string>;
  coversEverything?: boolean;
  /** Mirrored docs of the bound library and where doc control files them
   *  NOW (collectionId null = library root, absent doc = deleted). */
  mirroredDocs: Array<{ kdocId: string; name: string; collectionId: string | null; inDc: boolean }>;
  /** Every current DC folder, for fresh suggestions. */
  allFolders: AreaFolder[];
}

export interface AreaDrift {
  /** Sources whose folder no longer exists — the link points at nothing. */
  deadSources: Array<{ id: string; sourceName: string }>;
  /** Mirrored docs that were MOVED outside the watched folders — the next
   *  sync will drop them from the knowledge library. Named so a human can
   *  re-link before that happens. */
  movedOut: Array<{ kdocId: string; name: string }>;
  /** Unwatched folders that look like this unit's — new structure the
   *  library probably should watch. */
  newMatches: AreaFolder[];
}

export function computeAreaDrift(inputs: AreaDriftInputs): AreaDrift {
  const {
    unit, sources, existingFolderIds, coveredFolderIds,
    coversEverything, mirroredDocs, allFolders,
  } = inputs;

  const deadSources = sources
    .filter((s) => !existingFolderIds.has(s.sourceId))
    .map((s) => ({ id: s.id, sourceName: s.sourceName }));

  const movedOut = coversEverything ? [] : mirroredDocs
    .filter((d) => d.inDc && (!d.collectionId || !coveredFolderIds.has(d.collectionId)))
    .map((d) => ({ kdocId: d.kdocId, name: d.name }));

  const newMatches = coversEverything ? [] : allFolders
    .filter((f) => !coveredFolderIds.has(f.id) && f.docCount > 0 && folderMatchesUnit(unit, f))
    .sort((a, b) => b.docCount - a.docCount);

  return { deadSources, movedOut, newMatches };
}
