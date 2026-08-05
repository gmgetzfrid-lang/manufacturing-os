import { supabase } from "@/lib/supabase";

export type UploadProgress = {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
};

export type UploadResult = {
  path: string;
  url: string;
  size: number;
  contentType?: string;
};

// ─── Global upload activity ──────────────────────────────────────────────────
// Every upload in the app funnels through uploadToPath, so broadcasting its
// lifecycle here lets ONE global indicator show feedback for a file attach
// ANYWHERE — no per-screen wiring needed.
export type UploadActivityStatus = "uploading" | "done" | "error";
export interface UploadActivity {
  id: string;
  name: string;
  percent: number;
  status: UploadActivityStatus;
  error?: string;
}
type UploadListener = (e: UploadActivity) => void;
const uploadListeners = new Set<UploadListener>();
let uploadSeq = 0;

/** Subscribe to upload start/progress/done/error for every uploadToPath call.
 *  Returns an unsubscribe function. */
export function subscribeUploads(cb: UploadListener): () => void {
  uploadListeners.add(cb);
  return () => { uploadListeners.delete(cb); };
}
function emitUpload(e: UploadActivity) {
  uploadListeners.forEach((l) => { try { l(e); } catch { /* ignore listener errors */ } });
}

function sanitizeFilename(name: string) {
  return name.replace(/[^\w.\-()\s]/g, "_").replace(/\s+/g, " ").trim();
}

function joinPath(...parts: Array<string | undefined | null>) {
  return parts
    .filter(Boolean)
    .map((p) => String(p).replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");
}

async function getAuthToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  return session.access_token;
}

/** Thrown when the caller cancelled. Distinguished from a failure so callers
 *  can report "you stopped this" instead of "this broke". */
export class UploadCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "UploadCancelledError";
  }
}

/** The caller's cancel signal ANDed with a bound, so neither one can be
 *  forgotten. AbortSignal.any is recent enough to be worth a guard. */
function withDeadline(ms: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!signal) return deadline;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, deadline]);
  return signal;
}

async function getPresignedUploadUrl(
  path: string,
  contentType?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new UploadCancelledError();
  const token = await getAuthToken();
  // Bounded: when the platform is under load this route can 504, and an
  // unbounded fetch would leave the caller waiting on a request that is
  // never coming back.
  const res = await fetch("/api/storage/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ path, contentType }),
    signal: withDeadline(45_000, signal),
  }).catch((e: Error) => {
    if (signal?.aborted) throw new UploadCancelledError();
    throw new Error(
      e.name === "TimeoutError" || e.name === "AbortError"
        ? "timed out asking for an upload slot — the server is busy"
        : `couldn't reach the server (${e.message})`,
    );
  });
  if (!res.ok) throw new Error(`Failed to get upload URL (HTTP ${res.status})`);
  const { url } = await res.json();
  return url;
}

// ── Shared presigned-URL cache ───────────────────────────────────────────────
// A signed download URL is deterministic for its (path, expiry window) and stays
// valid for `expiresIn` seconds (default 1h). Re-minting one on every file open
// is a wasted round-trip — each costs a server-side auth.getUser + org-membership
// query + presign. Cache by path so re-opens (and the same drawing shown as a
// thumbnail, a cover, AND in the viewer) reuse one URL, and dedup concurrent
// callers to a single in-flight request. Previously every image component kept
// its own private cache and the PDF viewers had none.
type SignedEntry = { url: string; expiresAt: number };
const signedUrlCache = new Map<string, SignedEntry>();
const signedUrlInflight = new Map<string, Promise<string>>();

async function getPresignedDownloadUrl(path: string, expiresIn = 3600): Promise<string> {
  const key = `${path}::${expiresIn}`;
  const now = Date.now();
  const cached = signedUrlCache.get(key);
  // Reuse while it still has a comfortable margin of life left.
  if (cached && cached.expiresAt - now > 60_000) return cached.url;
  const inflight = signedUrlInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const token = await getAuthToken();
    const res = await fetch(
      `/api/storage/download-url?path=${encodeURIComponent(path)}&expiresIn=${expiresIn}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      // 409 = the binary was shed to an offline space archive. Surface the
      // archive identity as a typed error so viewers can prompt for the zip
      // instead of showing a broken stream.
      if (res.status === 409) {
        const body = await res.json().catch(() => null) as { archived?: boolean; archiveId?: string | null; root?: string | null; fileName?: string } | null;
        if (body?.archived) {
          throw new ArchivedFileError({
            archiveId: body.archiveId ?? null,
            root: body.root ?? null,
            fileName: body.fileName || path.split("/").pop() || "file",
          });
        }
      }
      throw new Error("Failed to get download URL");
    }
    const { url } = await res.json();
    signedUrlCache.set(key, { url, expiresAt: now + expiresIn * 1000 });
    return url as string;
  })();
  signedUrlInflight.set(key, p);
  try { return await p; } finally { signedUrlInflight.delete(key); }
}

/** Thrown when a storage key's binary was shed to an offline space archive —
 *  carries what the UI needs to prompt "provide <root>/data/<archiveId>.zip". */
export class ArchivedFileError extends Error {
  info: { archiveId: string | null; root: string | null; fileName: string };
  constructor(info: { archiveId: string | null; root: string | null; fileName: string }) {
    super("File archived offline");
    this.name = "ArchivedFileError";
    this.info = info;
  }
}

export type ResolvedFile =
  | { kind: "url"; url: string }
  | { kind: "archived"; archiveId: string | null; root: string | null; fileName: string };

/** Like resolveFileUrl, but distinguishes "shed to an offline archive" from a
 *  plain failure so viewers can show the provide-the-zip prompt. */
export async function resolveFileUrlDetailed(value: string, expiresIn = 3600): Promise<ResolvedFile | null> {
  if (!value) return null;
  if (/^https?:\/\//.test(value) || value.startsWith("blob:")) return { kind: "url", url: value };
  try {
    const url = await getPresignedDownloadUrl(value, expiresIn);
    return { kind: "url", url };
  } catch (e) {
    if (e instanceof ArchivedFileError) return { kind: "archived", ...e.info };
    return null;
  }
}

/** Public helper for any UI that needs to display an R2 object by its
 *  storage path. Returns a presigned URL that's valid for `expiresIn`
 *  seconds (default 1 hour). Cached + deduped (see above). */
export async function getSignedUrlForPath(path: string, expiresIn = 3600): Promise<string> {
  return getPresignedDownloadUrl(path, expiresIn);
}

/** Resolve a stored file reference — either an absolute http(s)/blob URL or an
 *  R2 storage path — to a usable, cached presigned URL. Viewers should use this
 *  instead of each rolling their own getSession + fetch on every open. */
export async function resolveFileUrl(value: string, expiresIn = 3600): Promise<string | null> {
  if (!value) return null;
  if (/^https?:\/\//.test(value) || value.startsWith("blob:")) return value;
  try {
    return await getPresignedDownloadUrl(value, expiresIn);
  } catch {
    return null;
  }
}

export function makeLibraryStoragePath(params: {
  orgId: string;
  libraryId: string;
  folderPath?: string[];
  filename: string;
}) {
  const { orgId, libraryId, folderPath, filename } = params;
  const safeName = sanitizeFilename(filename);
  const base = joinPath("orgs", orgId, "libraries", libraryId);
  const folder = (folderPath ?? []).map((f) => sanitizeFilename(f));
  return joinPath(base, ...folder, safeName);
}

// ── Chunked (multipart) uploads for big files ────────────────────────────────
// A single presigned PUT of a multi-GB laser scan is fragile (one network
// hiccup = start over) and impossible past R2's 5 GB per-PUT ceiling. Above
// the threshold we switch to S3 multipart: 64 MB parts, each PUT directly to
// R2 with its own presigned URL and its own retries, then a server-side
// complete. Progress is continuous across parts.
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const PART_SIZE = 64 * 1024 * 1024;
const PART_RETRIES = 3;

/** One PUT with progress; resolves the ETag header (needed for multipart
 *  complete — the bucket CORS must expose it). */
/** No progress for this long = the connection is wedged. A wall-clock
 *  timeout would be wrong (a 400MB drawing over site wifi is legitimately
 *  slow); what's never legitimate is bytes ceasing to move. */
const STALL_MS = 90_000;

function putWithXhr(
  url: string,
  body: Blob,
  contentType: string,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new UploadCancelledError()); return; }
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    let cancelled = false;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (stall) clearTimeout(stall);
      signal?.removeEventListener("abort", onCancel);
      fn();
    };
    // The user pressing Stop must actually stop the socket, not just stop the
    // UI waiting on it: an abandoned 400MB PUT keeps saturating the uplink
    // that the next attempt needs.
    function onCancel() {
      cancelled = true;
      finish(() => {
        try { xhr.abort(); } catch { /* already gone */ }
        reject(new UploadCancelledError());
      });
    }
    signal?.addEventListener("abort", onCancel, { once: true });
    // Rearmed on every byte: an upload that is still moving is never killed,
    // and one that has silently died always is. Without this an XHR that
    // never fires load/error/abort leaves its promise pending forever — and
    // any caller awaiting it (a bulk upload's Promise.all, and the spinner
    // it controls) hangs with no way back.
    const arm = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => {
        finish(() => {
          try { xhr.abort(); } catch { /* already gone */ }
          reject(new Error("stalled — no data moved for 90s"));
        });
      }, STALL_MS);
    };

    xhr.upload.addEventListener("progress", (e) => {
      arm();
      if (e.lengthComputable && onProgress) onProgress(e.loaded);
    });
    xhr.addEventListener("load", () => finish(() => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader("ETag"));
      else reject(new Error(`HTTP ${xhr.status}`));
    }));
    xhr.addEventListener("error", () => finish(() => reject(new Error("network error"))));
    xhr.addEventListener("abort", () => finish(() =>
      reject(cancelled ? new UploadCancelledError() : new Error("aborted"))));
    xhr.addEventListener("timeout", () => finish(() => reject(new Error("timed out"))));
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    arm();
    xhr.send(body);
  });
}

async function multipartCall<T>(payload: Record<string, unknown>): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch("/api/storage/multipart", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error || `multipart ${payload.action} failed (HTTP ${res.status})`);
  return body;
}

async function uploadMultipart(
  file: Blob,
  path: string,
  contentType: string,
  onBytes: (bytesTransferred: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new UploadCancelledError();
  const { uploadId } = await multipartCall<{ uploadId: string }>({ action: "create", path, contentType });
  const partCount = Math.ceil(file.size / PART_SIZE);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let doneBytes = 0;
  try {
    for (let i = 0; i < partCount; i++) {
      if (signal?.aborted) throw new UploadCancelledError();
      const partNumber = i + 1;
      const chunk = file.slice(i * PART_SIZE, Math.min((i + 1) * PART_SIZE, file.size));
      let lastErr: Error | null = null;
      let etag: string | null = null;
      for (let attempt = 0; attempt < PART_RETRIES; attempt++) {
        try {
          const { url } = await multipartCall<{ url: string }>({ action: "sign", path, uploadId, partNumber });
          etag = await putWithXhr(url, chunk, contentType, (loaded) => onBytes(doneBytes + loaded), signal);
          lastErr = null;
          break;
        } catch (e) {
          // Cancelling must not be retried three times with backoff — that is
          // the opposite of what the person pressing Stop asked for.
          if (e instanceof UploadCancelledError) throw e;
          lastErr = e as Error;
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
      if (lastErr) throw new Error(`part ${partNumber}/${partCount}: ${lastErr.message}`);
      if (!etag) {
        throw new Error(
          `part ${partNumber} uploaded but its ETag wasn't readable — the storage bucket's CORS policy must expose the ETag header (Cloudflare R2 → bucket → CORS → ExposeHeaders: ["ETag"]).`,
        );
      }
      parts.push({ partNumber, etag });
      doneBytes += chunk.size;
      onBytes(doneBytes);
    }
    await multipartCall({ action: "complete", path, uploadId, parts });
  } catch (e) {
    // Leave nothing half-assembled (or billable) behind.
    await multipartCall({ action: "abort", path, uploadId }).catch(() => undefined);
    throw e;
  }
}

/** Tiny end-to-end write probe. Distinguishes "storage refuses this site"
 *  (CORS/credentials — everything will fail) from "just the big file
 *  failed" (connection drop — retry). */
export async function storageSelfTest(orgId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const key = `orgs/${orgId}/diagnostics/probe-${Date.now()}.bin`;
    const url = await getPresignedUploadUrl(key, "application/octet-stream");
    await putWithXhr(url, new Blob([new Uint8Array(2048)]), "application/octet-stream");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function uploadToPath(
  file: Blob,
  path: string,
  opts?: {
    contentType?: string;
    onProgress?: (p: UploadProgress) => void;
    /** Abort the transfer. Rejects with UploadCancelledError, and actually
     *  closes the socket rather than just walking away from it. */
    signal?: AbortSignal;
  }
): Promise<UploadResult> {
  const contentType = opts?.contentType || (file instanceof File ? file.type : undefined) || "application/octet-stream";
  const name = file instanceof File && file.name ? file.name : (path.split("/").pop() || "file");
  const id = `up-${Date.now()}-${++uploadSeq}`;
  emitUpload({ id, name, percent: 0, status: "uploading" });

  const report = (bytesTransferred: number) => {
    const percent = (bytesTransferred / Math.max(file.size, 1)) * 100;
    emitUpload({ id, name, percent, status: "uploading" });
    opts?.onProgress?.({ bytesTransferred, totalBytes: file.size, percent });
  };

  // Big files: chunked multipart with per-part retries.
  if (file.size >= MULTIPART_THRESHOLD) {
    try {
      await uploadMultipart(file, path, contentType, report, opts?.signal);
      emitUpload({ id, name, percent: 100, status: "done" });
      return { path, url: path, size: file.size, contentType };
    } catch (err) {
      emitUpload({ id, name, percent: 0, status: "error", error: (err as Error).message });
      throw err;
    }
  }

  let uploadUrl: string;
  try {
    uploadUrl = await getPresignedUploadUrl(path, contentType, opts?.signal);
  } catch (err) {
    emitUpload({ id, name, percent: 0, status: "error", error: (err as Error).message });
    throw err;
  }

  try {
    await putWithXhr(uploadUrl, file, contentType, report, opts?.signal);
    emitUpload({ id, name, percent: 100, status: "done" });
    return { path, url: path, size: file.size, contentType };
  } catch (err) {
    emitUpload({ id, name, percent: 0, status: "error", error: (err as Error).message });
    // Cancellation is the user's own doing — keep it recognisable instead of
    // wrapping it into "Upload cancelled" prose that reads like a failure.
    if (err instanceof UploadCancelledError) throw err;
    throw new Error(`Upload ${(err as Error).message}`);
  }
}

export async function uploadFile(file: File, path: string): Promise<string> {
  await uploadToPath(file, path, { contentType: file.type });
  return path; // return storage path (resolve to URL via getFileUrl)
}

export async function getFileUrl(path: string): Promise<string> {
  return getPresignedDownloadUrl(path);
}

export async function deleteFile(path: string): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch("/api/storage/delete", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error("Failed to delete file");
}

export function makeTicketAttachmentPath(params: {
  orgId: string;
  ticketId: string;
  filename: string;
}) {
  const ts = Date.now();
  const { orgId, ticketId, filename } = params;
  return joinPath("orgs", orgId, "tickets", ticketId, `${ts}_${sanitizeFilename(filename)}`);
}

export async function uploadTicketAttachment(params: {
  orgId: string;
  ticketId: string;
  file: File;
  onProgress?: (p: UploadProgress) => void;
}) {
  const { orgId, ticketId, file, onProgress } = params;
  const path = makeTicketAttachmentPath({ orgId, ticketId, filename: file.name });
  return uploadToPath(file, path, { contentType: file.type || undefined, onProgress });
}

export function makeUserPrivatePath(params: {
  orgId: string;
  uid: string;
  relativePath: string;
}) {
  const { orgId, uid, relativePath } = params;
  return joinPath("orgs", orgId, "user_private", uid, relativePath);
}

export async function uploadUserPrivateFile(params: {
  orgId: string;
  uid: string;
  file: File;
  relativePath?: string;
  onProgress?: (p: UploadProgress) => void;
}) {
  const { orgId, uid, file, relativePath, onProgress } = params;
  const rel = relativePath?.trim() ? relativePath : sanitizeFilename(file.name);
  const path = makeUserPrivatePath({ orgId, uid, relativePath: rel });
  return uploadToPath(file, path, { contentType: file.type || undefined, onProgress });
}

export async function getStampedDownloadUrlOrDirect(params: {
  directStoragePath: string;
}) {
  return getFileUrl(params.directStoragePath);
}
