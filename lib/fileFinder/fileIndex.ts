// lib/fileFinder/fileIndex.ts — one flat row per file, with every clue on it.
//
// The ranker never touches Postgres or a drive. It reads these entries, which
// carry everything a person would glance at when hunting through a messy
// share: the name, the folder chain above it, what dates it claims, how big it
// is, whether its bytes are identical to another file's. System documents and
// pasted drive listings become the SAME shape, so a search can say "not in
// the system, but the Thor drive has it in two places" in one pass.

import { canonicalForm, findIdentifiers } from "./tagForms";
import { words, years, yearOf } from "./tokens";
import type { ListedFile } from "./dirTree";
import { docTypesIn, sheetNumbersIn, revisionsIn, canonicalRev } from "./docTypes";

export interface IndexEntry {
  id: string;
  source: "system" | "listing";
  listingId?: string;
  listingName?: string;
  name: string;
  title?: string | null;
  number?: string | null;
  rev?: string | null;
  status?: string | null;
  libraryId?: string;
  libraryName?: string;
  folderId?: string | null;
  /** Folder names from the library (or listing) root down to the parent folder. */
  path: string[];
  pathIds: string[];
  /** Canonical codes found in the name/number/title/tags. */
  idents: string[];
  /** The whole file name (no extension) and document number, canonical —
   *  for "what you typed sits inside this name" matching when the code
   *  extraction cut differently than the person did. */
  nameCanon: string;
  numberCanon: string;
  /** Canonical identifiers found in the folder chain. */
  pathIdents: string[];
  words: string[];
  pathWords: string[];
  /** Years the file itself claims: effective date, dates in its name, metadata dates. */
  years: number[];
  /** Sheet number, from the row or from "SHT05" in the name. */
  sheet?: number;
  /** Revision, canonical ("3", "A"), from the row or "_R38" in the name. */
  revCanon?: string;
  /** Document-type keys named by the name, folder chain, or metadata. */
  docTypes: string[];
  /** Unit codes this file is LINKED to (estate edges on it or its folders), as
   *  opposed to units merely named in words. */
  unitCodes: string[];
  /** Asset ids and project ids linked by applied estate edges. */
  linkedAssets: string[];
  linkedProjects: string[];
  /** The AI-readable copy, when one exists for these bytes. */
  read?: { knowledgeDocId: string; status: string; pages: number; byHash: boolean; fileKey?: string };
  /** Year it landed in the system (or was listed). Never a content signal. */
  uploadYear?: number;
  sizeBytes?: number | null;
  hash?: string | null;
  href?: string;
}

export interface FolderLike {
  id: string;
  libraryId: string;
  parentId: string | null;
  name: string;
  /** Unit this folder is linked to by an applied estate edge. */
  unitCode?: string;
}

export interface LibraryLike { id: string; name: string }

export interface DocLike {
  id: string;
  library_id: string;
  collection_id: string | null;
  name?: string | null;
  title?: string | null;
  document_number?: string | null;
  rev?: string | null;
  status?: string | null;
  effective_date?: string | null;
  created_at?: string | null;
  sheet_number?: number | null;
  tags?: string[] | null;
  asset_tags?: Array<{ tag?: string }> | null;
  metadata?: Record<string, unknown> | null;
}

export interface VersionMeta {
  sourceFileName?: string | null;
  fileHash?: string | null;
  fileSize?: number | null;
  effectiveDate?: string | null;
}

/** Folder chain for a folder id, root first. Cycle-guarded. */
export function folderChain(folderId: string | null | undefined, byId: Map<string, FolderLike>): FolderLike[] {
  const out: FolderLike[] = [];
  const seen = new Set<string>();
  let cur = folderId ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = byId.get(cur);
    if (!f) break;
    out.unshift(f);
    cur = f.parentId;
  }
  return out;
}

function metadataText(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return "";
  const parts: string[] = [];
  for (const v of Object.values(meta)) {
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number") parts.push(String(v));
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === "string").join(" "));
  }
  return parts.join(" ");
}

export interface LinkMeta {
  unitCodes?: string[];
  assets?: string[];
  projects?: string[];
  read?: IndexEntry["read"];
}

export function entryFromDocument(
  d: DocLike,
  ctx: { folders: Map<string, FolderLike>; libraries: Map<string, LibraryLike>; version?: VersionMeta; links?: LinkMeta },
): IndexEntry {
  const chain = folderChain(d.collection_id, ctx.folders);
  const unitCodes = new Set<string>(ctx.links?.unitCodes ?? []);
  for (const f of chain) if (f.unitCode) unitCodes.add(f.unitCode);
  const lib = ctx.libraries.get(d.library_id);
  const v = ctx.version;
  const name = (v?.sourceFileName || d.name || d.document_number || d.title || "Untitled").trim();
  const tagText = [
    ...(d.tags ?? []),
    ...((d.asset_tags ?? []).map((t) => t?.tag ?? "")),
  ].join(" ");
  const nameText = [name, d.document_number ?? "", d.title ?? "", tagText].join(" ");
  const meta = metadataText(d.metadata);
  const pathText = chain.map((f) => f.name).join(" ");
  const ys = new Set<number>();
  for (const y of [yearOf(v?.effectiveDate ?? d.effective_date), ...years(name), ...years(meta)]) if (y) ys.add(y);
  const nameWords = [...new Set(words(nameText + " " + meta))];
  const pathWordList = [...new Set(words(pathText))];
  const sheetFromName = sheetNumbersIn(name)[0];
  const revFromName = revisionsIn(name)[0];
  return {
    id: `doc:${d.id}`,
    source: "system",
    name,
    title: d.title ?? null,
    number: d.document_number ?? null,
    rev: d.rev ?? null,
    status: d.status ?? null,
    libraryId: d.library_id,
    libraryName: lib?.name,
    folderId: d.collection_id ?? null,
    path: chain.map((f) => f.name),
    pathIds: chain.map((f) => f.id),
    idents: findIdentifiers(nameText + " " + meta),
    nameCanon: canonicalForm(name.replace(/\.[A-Za-z0-9]{1,5}$/, "")),
    numberCanon: canonicalForm(d.document_number ?? ""),
    pathIdents: findIdentifiers(pathText),
    words: nameWords,
    pathWords: pathWordList,
    years: [...ys].sort(),
    sheet: d.sheet_number ?? sheetFromName,
    revCanon: d.rev ? canonicalRev(String(d.rev)) : revFromName ? canonicalRev(revFromName) : undefined,
    // What the file calls itself wins; the folder only speaks when the name is silent.
    docTypes: docTypesIn(nameWords).length ? docTypesIn(nameWords) : docTypesIn(pathWordList),
    unitCodes: [...unitCodes],
    linkedAssets: ctx.links?.assets ?? [],
    linkedProjects: ctx.links?.projects ?? [],
    read: ctx.links?.read,
    uploadYear: yearOf(d.created_at),
    sizeBytes: v?.fileSize ?? null,
    hash: v?.fileHash ?? null,
    // Land IN the folder (no lookup round-trip), on the drawing itself (fs=1),
    // not merely with the row selected in the inspector.
    href: `/documents/${d.library_id}?${d.collection_id ? `folderId=${d.collection_id}&` : ""}doc=${d.id}&fs=1`,
  };
}

export function entriesFromListing(
  listing: { id: string; name: string; files: ListedFile[] },
): IndexEntry[] {
  return listing.files.map((f, i) => {
    const pathText = f.path.join(" ");
    const ys = new Set<number>(years(f.name));
    const dy = yearOf(f.date);
    if (dy) ys.add(dy);
    return {
      id: `ext:${listing.id}:${i}`,
      source: "listing",
      listingId: listing.id,
      listingName: listing.name,
      name: f.name,
      path: f.path,
      pathIds: f.path.map((_, k) => `extf:${listing.id}:${f.path.slice(0, k + 1).join("/")}`),
      idents: findIdentifiers(f.name),
      nameCanon: canonicalForm(f.name.replace(/\.[A-Za-z0-9]{1,5}$/, "")),
      numberCanon: "",
      pathIdents: findIdentifiers(pathText),
      words: [...new Set(words(f.name))],
      pathWords: [...new Set(words(pathText))],
      years: [...ys].sort(),
      sheet: sheetNumbersIn(f.name)[0],
      revCanon: revisionsIn(f.name)[0] ? canonicalRev(revisionsIn(f.name)[0]) : undefined,
      docTypes: docTypesIn(words(f.name)).length ? docTypesIn(words(f.name)) : docTypesIn(words(pathText)),
      unitCodes: [],
      linkedAssets: [],
      linkedProjects: [],
      sizeBytes: f.sizeBytes ?? null,
      hash: null,
    };
  });
}

/** Entries that share identical bytes, keyed by hash. Only groups of 2+. */
export function clusterByHash(entries: IndexEntry[]): Map<string, IndexEntry[]> {
  const m = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    if (!e.hash) continue;
    const arr = m.get(e.hash) ?? [];
    arr.push(e);
    m.set(e.hash, arr);
  }
  for (const [k, v] of m) if (v.length < 2) m.delete(k);
  return m;
}

export const canonicalWordsOf = (ws: string[]) => ws.map(canonicalForm);
