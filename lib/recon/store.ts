// Browser-local storage for reconstruction data.
//
// Five 90-second clips produce several hundred frames. Held as JavaScript
// arrays that is well over a gigabyte, which is how a tab gets killed
// mid-reconstruction. So decoded frames go straight into the Origin Private
// File System — a real filesystem, private to this origin, never uploaded —
// and are streamed back one at a time when densification needs them.
//
// The same store holds finished scenes so a reconstruction survives a reload.

const ROOT_DIR = "recon";
const FRAMES_DIR = "frames";
const SCENES_DIR = "scenes";

export interface StoredFrameMeta {
  index: number;
  clipId: string;
  width: number;
  height: number;
  colorWidth: number;
  colorHeight: number;
}

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error(
      "This browser does not provide the Origin Private File System, which is needed " +
      "to process large captures without exhausting memory.",
    );
  }
  const base = await navigator.storage.getDirectory();
  return base.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function dir(name: string, jobId?: string): Promise<FileSystemDirectoryHandle> {
  const r = await root();
  const d = await r.getDirectoryHandle(name, { create: true });
  return jobId ? d.getDirectoryHandle(jobId, { create: true }) : d;
}

/** Frames are written as raw bytes: greyscale plane first, then the RGB plane. */
export class FrameStore {
  private handle: FileSystemDirectoryHandle | null = null;

  constructor(private readonly jobId: string) {}

  private async dirHandle(): Promise<FileSystemDirectoryHandle> {
    if (!this.handle) this.handle = await dir(FRAMES_DIR, this.jobId);
    return this.handle;
  }

  async write(index: number, gray: Uint8Array, rgb: Uint8Array): Promise<void> {
    return this.explain("storing", index, async () => {
      const d = await this.dirHandle();
      const file = await d.getFileHandle(`${index}.bin`, { create: true });
      const writable = await file.createWritable();
      try {
        // The DOM typings insist on ArrayBuffer-backed views; these always are.
        await writable.write(gray as unknown as BufferSource);
        await writable.write(rgb as unknown as BufferSource);
      } finally {
        await writable.close();
      }
    });
  }

  /** Rethrow a storage failure with the context a bug report needs: which
   *  frame, which operation, and how full the origin's storage was — a bare
   *  "file not found" from deep in a 25-minute run points at nothing. */
  private async explain<T>(op: string, index: number, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      let usage = "unknown";
      try {
        const est = await navigator.storage.estimate();
        usage = `${Math.round((est.usage ?? 0) / 1e6)} of ${Math.round((est.quota ?? 0) / 1e6)}MB used`;
      } catch { /* estimate unavailable; the original error still stands */ }
      const dirState = await this.describeDir();
      throw new Error(
        `Browser storage failed while ${op} frame ${index} (${usage}; ${dirState}): ${String(err)}`,
      );
    }
  }

  /** Open a frame's file, re-acquiring the directory chain once if the first
   *  attempt fails — a cached directory handle can go stale over the length of
   *  a long reconstruction, and that must not read as "file deleted". */
  private async fileOf(index: number): Promise<File> {
    try {
      const d = await this.dirHandle();
      return await (await d.getFileHandle(`${index}.bin`)).getFile();
    } catch (first) {
      this.handle = null;
      try {
        const d = await this.dirHandle();
        return await (await d.getFileHandle(`${index}.bin`)).getFile();
      } catch {
        throw first;
      }
    }
  }

  /** Whether the job's directory still exists and how much it holds — the
   *  difference between "one file is missing" and "storage was wiped". */
  private async describeDir(): Promise<string> {
    try {
      const base = await navigator.storage.getDirectory();
      const recon = await base.getDirectoryHandle(ROOT_DIR);
      const frames = await recon.getDirectoryHandle(FRAMES_DIR);
      const job = await frames.getDirectoryHandle(this.jobId);
      let n = 0;
      // @ts-expect-error - async iteration over directory handles is not in lib.dom yet
      for await (const _ of job.entries()) n++;
      return `the job's directory still holds ${n} files`;
    } catch (err) {
      return `the job's directory itself is gone (${String(err)})`;
    }
  }

  async readGray(index: number, byteLength: number): Promise<Uint8Array> {
    return this.explain("reading", index, async () => {
      const file = await this.fileOf(index);
      return new Uint8Array(await file.slice(0, byteLength).arrayBuffer());
    });
  }

  async readRgb(index: number, grayBytes: number, rgbBytes: number): Promise<Uint8Array> {
    return this.explain("reading", index, async () => {
      const file = await this.fileOf(index);
      return new Uint8Array(await file.slice(grayBytes, grayBytes + rgbBytes).arrayBuffer());
    });
  }

  async clear(): Promise<void> {
    try {
      const frames = await dir(FRAMES_DIR);
      await frames.removeEntry(this.jobId, { recursive: true });
    } catch {
      // Nothing stored yet, or already gone.
    }
    this.handle = null;
  }
}

/** Remove frame directories left behind by interrupted runs. */
export async function clearStaleFrames(keepJobId?: string): Promise<void> {
  try {
    const frames = await dir(FRAMES_DIR);
    const names: string[] = [];
    // @ts-expect-error - async iteration over directory handles is not in lib.dom yet
    for await (const [name] of frames.entries()) names.push(name as string);
    for (const name of names) {
      if (name === keepJobId) continue;
      await frames.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch {
    // Storage unavailable; nothing to clean.
  }
}

// ── Saved scenes ────────────────────────────────────────────────────────────

export interface SavedSceneEntry {
  id: string;
  label: string;
  generated: string;
  pointCount: number;
  bytes: number;
  unified: boolean;
}

export async function saveScene(
  id: string, manifest: unknown, points: ArrayBuffer,
): Promise<void> {
  const d = await dir(SCENES_DIR, id);

  const manifestFile = await d.getFileHandle("scene.json", { create: true });
  const mw = await manifestFile.createWritable();
  await mw.write(JSON.stringify(manifest));
  await mw.close();

  const pointsFile = await d.getFileHandle("points.bin", { create: true });
  const pw = await pointsFile.createWritable();
  await pw.write(points);
  await pw.close();
}

export async function loadSceneManifest(id: string): Promise<unknown | null> {
  try {
    const d = await dir(SCENES_DIR, id);
    const file = await (await d.getFileHandle("scene.json")).getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

export async function loadScenePoints(id: string): Promise<ArrayBuffer | null> {
  try {
    const d = await dir(SCENES_DIR, id);
    const file = await (await d.getFileHandle("points.bin")).getFile();
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

export async function listScenes(): Promise<SavedSceneEntry[]> {
  try {
    const scenes = await dir(SCENES_DIR);
    const out: SavedSceneEntry[] = [];
    const names: string[] = [];
    // @ts-expect-error - see above
    for await (const [name, handle] of scenes.entries()) {
      if ((handle as FileSystemHandle).kind === "directory") names.push(name as string);
    }
    for (const name of names) {
      const manifest = (await loadSceneManifest(name)) as
        | { label?: string; generated?: string; pointCount?: number; report?: { unified?: boolean } }
        | null;
      if (!manifest) continue;
      let bytes = 0;
      try {
        const d = await dir(SCENES_DIR, name);
        const f = await (await d.getFileHandle("points.bin")).getFile();
        bytes = f.size;
      } catch { /* points missing — still list the entry */ }
      out.push({
        id: name,
        label: manifest.label ?? name,
        generated: manifest.generated ?? "",
        pointCount: manifest.pointCount ?? 0,
        bytes,
        unified: manifest.report?.unified ?? false,
      });
    }
    out.sort((a, b) => (a.generated < b.generated ? 1 : -1));
    return out;
  } catch {
    return [];
  }
}

export async function deleteScene(id: string): Promise<void> {
  try {
    const scenes = await dir(SCENES_DIR);
    await scenes.removeEntry(id, { recursive: true });
  } catch {
    // Already gone.
  }
}

// ── Storage adapter seam ────────────────────────────────────────────────────
//
// Scenes live in the browser today and that is the whole point of the proof of
// concept — nothing is uploaded. But the shape of "where a finished scene
// lives" is worth pinning down now, because the intended next step is that the
// USER's machine still does the reconstruction and only the finished dataset is
// stored remotely (e.g. Cloudflare R2). A remote adapter implements this same
// interface; no caller changes.

export interface SceneStore {
  save(id: string, manifest: unknown, points: ArrayBuffer): Promise<void>;
  loadManifest(id: string): Promise<unknown | null>;
  loadPoints(id: string): Promise<ArrayBuffer | null>;
  list(): Promise<SavedSceneEntry[]>;
  remove(id: string): Promise<void>;
}

/** The only implementation in this proof of concept: the browser's own disk. */
export const localSceneStore: SceneStore = {
  save: saveScene,
  loadManifest: loadSceneManifest,
  loadPoints: loadScenePoints,
  list: listScenes,
  remove: deleteScene,
};

// ── Single-file export ──────────────────────────────────────────────────────
//
// A scene is a JSON manifest plus a binary payload. Handing the user two files
// invites them to be separated, so export packs both into one container:
//
//   magic "MOS3D\0"          6 bytes
//   version                  uint16  little-endian
//   manifest length          uint32  little-endian
//   manifest                 UTF-8 JSON
//   points                   raw payload
//
// Deliberately trivial to parse — no zip dependency, and a future importer is
// a dozen lines.

const EXPORT_MAGIC = "MOS3D\0";
const EXPORT_VERSION = 1;

export function packScene(manifest: unknown, points: ArrayBuffer): Blob {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new ArrayBuffer(EXPORT_MAGIC.length + 2 + 4);
  const bytes = new Uint8Array(header);
  for (let i = 0; i < EXPORT_MAGIC.length; i++) bytes[i] = EXPORT_MAGIC.charCodeAt(i);
  const view = new DataView(header);
  view.setUint16(EXPORT_MAGIC.length, EXPORT_VERSION, true);
  view.setUint32(EXPORT_MAGIC.length + 2, json.byteLength, true);
  return new Blob([header, json, points], { type: "application/octet-stream" });
}

export async function unpackScene(
  file: Blob,
): Promise<{ manifest: unknown; points: ArrayBuffer }> {
  const headerSize = EXPORT_MAGIC.length + 6;
  const head = new DataView(await file.slice(0, headerSize).arrayBuffer());
  const magic = new Uint8Array(head.buffer, 0, EXPORT_MAGIC.length);
  for (let i = 0; i < EXPORT_MAGIC.length; i++) {
    if (magic[i] !== EXPORT_MAGIC.charCodeAt(i)) {
      throw new Error("This is not a 3D environment file.");
    }
  }
  const version = head.getUint16(EXPORT_MAGIC.length, true);
  if (version !== EXPORT_VERSION) {
    throw new Error(`Unsupported environment file version ${version}.`);
  }
  const jsonLength = head.getUint32(EXPORT_MAGIC.length + 2, true);
  const json = await file.slice(headerSize, headerSize + jsonLength).text();
  const points = await file.slice(headerSize + jsonLength).arrayBuffer();
  return { manifest: JSON.parse(json), points };
}
