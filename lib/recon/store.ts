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
  }

  async readGray(index: number, byteLength: number): Promise<Uint8Array> {
    const d = await this.dirHandle();
    const file = await (await d.getFileHandle(`${index}.bin`)).getFile();
    return new Uint8Array(await file.slice(0, byteLength).arrayBuffer());
  }

  async readRgb(index: number, grayBytes: number, rgbBytes: number): Promise<Uint8Array> {
    const d = await this.dirHandle();
    const file = await (await d.getFileHandle(`${index}.bin`)).getFile();
    return new Uint8Array(await file.slice(grayBytes, grayBytes + rgbBytes).arrayBuffer());
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
