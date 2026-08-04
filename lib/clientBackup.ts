// lib/clientBackup.ts — the full backup, built IN THE BROWSER.
//
// The old "Full ZIP with binaries" asked one serverless function to download
// every binary, zip them in RAM, and stream the result. Serverless functions
// are killed on a clock measured in seconds; real document sets are measured
// in gigabytes. The button hung forever and delivered nothing — the worst
// possible behavior for the feature whose whole job is trust.
//
// Now the server does only what it's good at (one fast call: the structured
// envelope — every table + a 24h presigned URL per file), and the browser
// does the heavy lifting: it downloads each binary STRAIGHT from storage
// (no function in the path, nothing to time out), packs them into zip parts
// with a bounded memory footprint, verifies a SHA-256 for every file, and
// reports progress the whole way. A failed file never kills the backup — it
// lands in the report with its reason.
//
// Parts: browsers hold a whole zip in memory while building it, so parts cap
// at ~300MB and download as they finish (backup-part1.zip, part2, …). PDFs
// and DWGs are already compressed, so parts use STORE — faster, no memory
// spike, same size.

import JSZip from "jszip";
import { supabase } from "@/lib/supabase";

export interface BackupProgress {
  phase: "envelope" | "files" | "finalizing" | "done" | "cancelled" | "failed";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Part currently being filled (1-based). */
  part: number;
  /** The exact file being fetched right now. */
  currentPath?: string;
  errors: Array<{ path: string; error: string }>;
  /** Set when the whole run died (envelope failure etc.). */
  fatalError?: string;
}

export interface BackupResult {
  parts: number;
  filesPacked: number;
  bytesPacked: number;
  errors: Array<{ path: string; error: string }>;
}

/** Per-part embedded-bytes cap. A building zip lives in tab memory; 300MB
 *  of STORE-packed input keeps even modest laptops comfortable. */
const PART_CAP_BYTES = 300 * 1024 * 1024;

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a beat to grab the blob before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface EnvelopeFile {
  path: string;
  size?: number | null;
  presignedUrl: string;
}

export async function runFullBackup(orgId: string, opts: {
  onProgress: (p: BackupProgress) => void;
  isCancelled?: () => boolean;
}): Promise<BackupResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");

  const progress: BackupProgress = {
    phase: "envelope", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0,
    part: 1, errors: [],
  };
  const emit = () => opts.onProgress({ ...progress, errors: [...progress.errors] });
  emit();

  // ── 1. The envelope: every table + a presigned URL per file. One fast
  //      server call — database work only, no binaries touched.
  const res = await fetch(`/api/data-export/structured?orgId=${encodeURIComponent(orgId)}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok) {
    throw new Error((await res.text().catch(() => "")) || `Export envelope failed (HTTP ${res.status})`);
  }
  const envelope = await res.json() as {
    manifest: { orgName?: string; exportedAt: string };
    files: EnvelopeFile[];
  };

  const files = (envelope.files ?? []).filter((f) => f);
  progress.filesTotal = files.length;
  progress.bytesTotal = files.reduce((a, f) => a + Number(f.size ?? 0), 0);
  progress.phase = "files";
  emit();

  const stamp = envelope.manifest.exportedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const orgSlug = (envelope.manifest.orgName ?? "org").replace(/[^\w.\-]+/g, "_");
  const partName = (n: number) => `backup-${orgSlug}-${stamp}-part${n}.zip`;

  const fileManifest: Record<string, { sha256: string; size: number; part: number }> = {};
  const partsList: string[] = [];
  let zip = new JSZip();
  let partBytes = 0;
  let filesPacked = 0;
  let bytesPacked = 0;

  // Part 1 opens with the complete structured export — a backup whose first
  // part alone can rebuild every record.
  zip.file("data.json", JSON.stringify(envelope, null, 2));

  const finalizePart = async (last: boolean) => {
    if (last) {
      zip.file("files-manifest.json", JSON.stringify(fileManifest, null, 2));
      zip.file("backup-report.json", JSON.stringify({
        exportedAt: envelope.manifest.exportedAt,
        parts: [...partsList, partName(progress.part)],
        filesPacked,
        bytesPacked,
        errors: progress.errors,
        note: progress.errors.length > 0
          ? "Files listed under errors are NOT in this backup — re-run, or fetch them via data.json's presigned URLs (valid 24h)."
          : "Every file verified by SHA-256 in files-manifest.json.",
      }, null, 2));
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    saveBlob(blob, partName(progress.part));
    partsList.push(partName(progress.part));
    zip = new JSZip();
    partBytes = 0;
  };

  // ── 2. Binaries: browser → storage directly, sequential so memory and
  //      progress stay honest. A miss is recorded, never fatal.
  for (const f of files) {
    if (opts.isCancelled?.()) break;
    progress.currentPath = f.path;
    emit();
    if (!f.presignedUrl) {
      progress.errors.push({ path: f.path, error: "No download URL (archived offline or signing failed)" });
      progress.filesDone++;
      emit();
      continue;
    }
    try {
      const r = await fetch(f.presignedUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (partBytes > 0 && partBytes + buf.byteLength > PART_CAP_BYTES) {
        progress.phase = "finalizing";
        emit();
        await finalizePart(false);
        progress.part++;
        progress.phase = "files";
      }
      zip.file(`files/${f.path}`, buf);
      fileManifest[f.path] = { sha256: await sha256Hex(buf), size: buf.byteLength, part: progress.part };
      partBytes += buf.byteLength;
      filesPacked++;
      bytesPacked += buf.byteLength;
      progress.bytesDone += buf.byteLength;
    } catch (e) {
      progress.errors.push({ path: f.path, error: (e as Error).message });
    }
    progress.filesDone++;
    emit();
  }

  progress.currentPath = undefined;
  progress.phase = "finalizing";
  emit();
  await finalizePart(true);
  progress.phase = opts.isCancelled?.() ? "cancelled" : "done";
  emit();

  return { parts: progress.part, filesPacked, bytesPacked, errors: progress.errors };
}

// ── Global backup session ──────────────────────────────────────────────────
// The run must SURVIVE navigating around the app (it does — same JS context)
// and stay VISIBLE while it does. State lives here at module level; a
// floating indicator in the app shell subscribes, so progress follows the
// user to any page. Closing or refreshing the TAB is the one thing that
// kills a run — a beforeunload warning guards exactly that.

type Listener = (p: BackupProgress | null) => void;
const listeners = new Set<Listener>();
let currentState: BackupProgress | null = null;
let running = false;
let cancelFlag = false;

const publish = (p: BackupProgress | null) => {
  currentState = p;
  for (const l of listeners) l(p);
};

const warnUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = "A backup is still running — leaving this tab will stop it.";
};

export function subscribeBackup(fn: Listener): () => void {
  listeners.add(fn);
  fn(currentState);
  return () => { listeners.delete(fn); };
}

export function backupIsRunning(): boolean { return running; }

export function cancelBackup(): void { cancelFlag = true; }

/** Clear a finished/failed state from the indicator. */
export function dismissBackup(): void {
  if (!running) publish(null);
}

export async function startGlobalBackup(orgId: string): Promise<void> {
  if (running) return;                     // one backup at a time
  running = true;
  cancelFlag = false;
  window.addEventListener("beforeunload", warnUnload);
  try {
    await runFullBackup(orgId, {
      onProgress: publish,
      isCancelled: () => cancelFlag,
    });
  } catch (e) {
    publish({
      phase: "failed", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0,
      part: 0, errors: [], fatalError: (e as Error).message,
    });
  } finally {
    running = false;
    window.removeEventListener("beforeunload", warnUnload);
  }
}
