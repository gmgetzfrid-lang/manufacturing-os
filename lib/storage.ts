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

async function getPresignedUploadUrl(path: string, contentType?: string): Promise<string> {
  const token = await getAuthToken();
  const res = await fetch("/api/storage/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ path, contentType }),
  });
  if (!res.ok) throw new Error("Failed to get upload URL");
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
    if (!res.ok) throw new Error("Failed to get download URL");
    const { url } = await res.json();
    signedUrlCache.set(key, { url, expiresAt: now + expiresIn * 1000 });
    return url as string;
  })();
  signedUrlInflight.set(key, p);
  try { return await p; } finally { signedUrlInflight.delete(key); }
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

export async function uploadToPath(
  file: Blob,
  path: string,
  opts?: {
    contentType?: string;
    onProgress?: (p: UploadProgress) => void;
  }
): Promise<UploadResult> {
  const contentType = opts?.contentType || (file instanceof File ? file.type : undefined) || "application/octet-stream";
  const name = file instanceof File && file.name ? file.name : (path.split("/").pop() || "file");
  const id = `up-${Date.now()}-${++uploadSeq}`;
  emitUpload({ id, name, percent: 0, status: "uploading" });

  let uploadUrl: string;
  try {
    uploadUrl = await getPresignedUploadUrl(path, contentType);
  } catch (err) {
    emitUpload({ id, name, percent: 0, status: "error", error: (err as Error).message });
    throw err;
  }

  // Use XMLHttpRequest for progress reporting
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      const percent = (e.loaded / e.total) * 100;
      emitUpload({ id, name, percent, status: "uploading" });
      if (opts?.onProgress) {
        opts.onProgress({ bytesTransferred: e.loaded, totalBytes: e.total, percent });
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        emitUpload({ id, name, percent: 100, status: "done" });
        resolve({ path, url: path, size: file.size, contentType });
      } else {
        emitUpload({ id, name, percent: 0, status: "error", error: `Upload failed (HTTP ${xhr.status})` });
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => {
      emitUpload({ id, name, percent: 0, status: "error", error: "Network error" });
      reject(new Error("Upload network error"));
    });
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(file);
  });
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
