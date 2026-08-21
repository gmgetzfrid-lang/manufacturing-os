// lib/folderUpload.ts
//
// Folder uploads that keep their shape. Two entry points produce the same
// normalized form — a flat list of files each tagged with the subfolder path
// it came from — and one pure planner turns those paths into an ordered
// folder-creation plan (parents first, case-insensitive dedupe, so
// "Crude/PIDs" dropped twice creates each folder exactly once):
//
//   * collectDroppedFiles — OS drag-drop, via webkitGetAsEntry recursion.
//     readEntries() batches (Chrome returns ≤100 per call) are looped until
//     empty — the classic bug where a 300-file folder uploads 100 files.
//   * filesFromDirectoryInput — an <input webkitdirectory> picker, via
//     webkitRelativePath.
//
// Junk the OS drops everywhere (.DS_Store, Thumbs.db, AppleDouble "._*",
// desktop.ini) is filtered so a drag from a Mac share doesn't create noise
// documents in a controlled library.

export interface PathedFile {
  file: File;
  /** Folder segments RELATIVE to the drop target, excluding the filename.
   *  Dropping the folder "Crude" containing "PIDs/x.pdf" yields
   *  ["Crude", "PIDs"] — the dropped folder itself is recreated. */
  relPath: string[];
}

const JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

export function isJunkFile(name: string): boolean {
  const n = name.toLowerCase();
  return JUNK_FILES.has(n) || n.startsWith("._");
}

/** Hard caps so a dropped drive root fails loudly instead of hanging. */
export const MAX_FOLDER_UPLOAD_FILES = 1000;
export const MAX_FOLDER_DEPTH = 25;

export class FolderUploadLimitError extends Error {
  constructor(message: string) { super(message); this.name = "FolderUploadLimitError"; }
}

// ── OS drag-drop traversal ──────────────────────────────────────────────

// Minimal structural types for the (non-standard but universal) FileSystem
// Entry API — lib.dom's types don't cover directory readers everywhere.
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FsFileEntry extends FsEntry {
  file(cb: (f: File) => void, err?: (e: unknown) => void): void;
}
interface FsDirEntry extends FsEntry {
  createReader(): { readEntries(cb: (es: FsEntry[]) => void, err?: (e: unknown) => void): void };
}

function readAllEntries(dir: FsDirEntry): Promise<FsEntry[]> {
  const reader = dir.createReader();
  return new Promise((resolve, reject) => {
    const all: FsEntry[] = [];
    const step = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) { resolve(all); return; }
        all.push(...batch);
        step(); // keep reading — batches are capped by the browser
      }, reject);
    };
    step();
  });
}

function entryFile(entry: FsFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(entry: FsEntry, path: string[], out: PathedFile[]): Promise<void> {
  if (out.length >= MAX_FOLDER_UPLOAD_FILES) {
    throw new FolderUploadLimitError(
      `That drop contains more than ${MAX_FOLDER_UPLOAD_FILES} files. Upload it in smaller batches.`);
  }
  if (path.length > MAX_FOLDER_DEPTH) {
    throw new FolderUploadLimitError(`Folder tree deeper than ${MAX_FOLDER_DEPTH} levels — flatten it and retry.`);
  }
  if (entry.isFile) {
    if (isJunkFile(entry.name)) return;
    const file = await entryFile(entry as FsFileEntry);
    out.push({ file, relPath: path });
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry as FsDirEntry);
    for (const child of children) {
      await walkEntry(child, [...path, entry.name], out);
    }
  }
}

/** Call SYNCHRONOUSLY inside the drop handler to capture entries (the
 *  DataTransferItemList is dead after the event), then await the result. */
export function collectDroppedFiles(items: DataTransferItemList): {
  hasDirectories: boolean;
  promise: Promise<PathedFile[]>;
} {
  type EntryGetter = { webkitGetAsEntry?: () => FsEntry | null };
  const entries: FsEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = (item as unknown as EntryGetter).webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) looseFiles.push(f);
    }
  }
  const hasDirectories = entries.some((e) => e.isDirectory);
  const promise = (async () => {
    const out: PathedFile[] = [];
    for (const f of looseFiles) {
      if (isJunkFile(f.name)) continue;
      if (out.length >= MAX_FOLDER_UPLOAD_FILES) {
        throw new FolderUploadLimitError(
          `That drop contains more than ${MAX_FOLDER_UPLOAD_FILES} files. Upload it in smaller batches.`);
      }
      out.push({ file: f, relPath: [] });
    }
    for (const entry of entries) await walkEntry(entry, [], out);
    return out;
  })();
  return { hasDirectories, promise };
}

// ── <input webkitdirectory> ─────────────────────────────────────────────

/** webkitRelativePath is "Root/Sub/file.pdf" — segments minus the filename
 *  become the folder path, so the picked folder itself is recreated. */
export function filesFromDirectoryInput(
  list: ArrayLike<{ name: string; webkitRelativePath?: string }>,
): PathedFile[] {
  const out: PathedFile[] = [];
  for (const f of Array.from(list)) {
    if (isJunkFile(f.name)) continue;
    const rel = (f.webkitRelativePath || "").split("/").filter(Boolean);
    out.push({ file: f as unknown as File, relPath: rel.length > 1 ? rel.slice(0, -1) : [] });
  }
  if (out.length > MAX_FOLDER_UPLOAD_FILES) {
    throw new FolderUploadLimitError(
      `That folder contains ${out.length} files — the limit per upload is ${MAX_FOLDER_UPLOAD_FILES}. Upload subfolders separately.`);
  }
  return out;
}

// ── Pure folder plan ────────────────────────────────────────────────────

export interface FolderPlanNode {
  /** Case-insensitive identity: lowercased segments joined with "/". */
  key: string;
  /** Display name, first-seen casing. */
  name: string;
  parentKey: string | null;
  depth: number;
}

export interface FolderPlan {
  /** Every distinct folder, parents strictly before children. */
  folders: FolderPlanNode[];
  /** file → its folder key (null = the drop root). */
  keyForFile: (f: PathedFile) => string | null;
}

export function buildFolderPlan(files: PathedFile[]): FolderPlan {
  const byKey = new Map<string, FolderPlanNode>();
  for (const f of files) {
    for (let depth = 1; depth <= f.relPath.length; depth++) {
      const segs = f.relPath.slice(0, depth);
      const key = segs.map((s) => s.toLowerCase()).join("/");
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          name: segs[segs.length - 1],
          parentKey: depth > 1 ? segs.slice(0, -1).map((s) => s.toLowerCase()).join("/") : null,
          depth,
        });
      }
    }
  }
  const folders = [...byKey.values()].sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
  return {
    folders,
    keyForFile: (f) =>
      f.relPath.length ? f.relPath.map((s) => s.toLowerCase()).join("/") : null,
  };
}
