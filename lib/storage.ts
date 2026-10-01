import { supabase } from "@/lib/supabase";
import { PRESIGNED_MAX_SECONDS } from "@/lib/presignedLifetime";

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
// A signed download URL stays valid for the window the SERVER granted — the
// route clamps whatever `expiresIn` a caller asks for and answers with the
// window it actually signed (EGR-4 / PKG-11, DEC-44 §2). Re-minting one on
// every file open is a wasted round-trip — each costs a server-side
// auth.getUser + org-membership query + presign. Cache by PATH (the server
// decides the window, so a requested value must never fork entries) so
// re-opens (and the same drawing shown as a thumbnail, a cover, AND in the
// viewer) reuse one URL, dedup concurrent callers to a single in-flight
// request, and remember the GRANTED expiry so a URL is never handed out past
// the life the server gave it, whatever the caller asked for. The image
// components that used to keep week-long private caches now read this one.
/** `margin` is the safety margin for THIS entry: it is reused only while it
 *  has more than `margin` ms of life left, and a subscription re-signs it
 *  `margin` ms before it closes. */
export type SignedUrl = { url: string; expiresAt: number; margin: number };
const signedUrlCache = new Map<string, SignedUrl>();
const signedUrlInflight = new Map<string, Promise<SignedUrl>>();
/** The safety margin is a quarter of the granted window, capped at a minute:
 *  a full minute of margin on a 60 s grant would make every entry dead on
 *  arrival (and a subscription re-sign once a second). */
const SIGNED_URL_MARGIN_MS = 60_000;
function signedUrlMargin(seconds: number): number {
  return Math.min(SIGNED_URL_MARGIN_MS, seconds * 250);
}
/** A re-sign that failed for a transient reason (the network, a 5xx, an
 *  auth hiccup) is retried on this schedule — doubling up to the cap — while
 *  the caller keeps the URL it already holds. */
const RESIGN_RETRY_MIN_MS = 15_000;
const RESIGN_RETRY_MAX_MS = 60_000;

/** SEC-7 / DEC-49: an INLINE URL and an ATTACHMENT URL for the same path
 *  are different URLs (the route signs the disposition into them), so they
 *  are cached apart. The inline entry's key starts with a NUL, which no
 *  storage key can contain (assertSafeStorageKey refuses control bytes). */
const INLINE_KEY_PREFIX = "\u0000inline\u0000";
function signedUrlKey(path: string, inline: boolean): string {
  return inline ? INLINE_KEY_PREFIX + path : path;
}
function peekEntry(key: string): SignedUrl | undefined {
  const cached = signedUrlCache.get(key);
  return cached && cached.expiresAt - Date.now() > cached.margin ? cached : undefined;
}

/** Synchronous read of a still-live cached URL for `path` — the render-time
 *  seed for an image component; `undefined` when there is none (expired
 *  entries are not returned: an <img> mounted on one would 403). */
export function peekSignedUrl(path: string): SignedUrl | undefined {
  return peekEntry(signedUrlKey(path, false));
}

/** Test hook. */
export function clearSignedUrlCache(): void {
  signedUrlCache.clear();
  signedUrlInflight.clear();
}

async function getPresignedDownloadUrlEntry(path: string, expiresIn = PRESIGNED_MAX_SECONDS, inline = false): Promise<SignedUrl> {
  const key = signedUrlKey(path, inline);
  const live = peekEntry(key);
  if (live) return live;
  const inflight = signedUrlInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    // Counted from BEFORE the request, so the client's idea of the window is
    // never longer than the server's.
    const now = Date.now();
    const token = await getAuthToken();
    const res = await fetch(
      `/api/storage/download-url?path=${encodeURIComponent(path)}&expiresIn=${expiresIn}${inline ? "&inline=1" : ""}`,
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
      // Any other 4xx is the route's DECISION about this path (denied,
      // gone, bad key) — typed so a subscriber stops rather than retries.
      // 408 / 429 and every 5xx are the server's moment, not its answer.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new SignedUrlRefusedError(res.status);
      }
      throw new Error("Failed to get download URL");
    }
    const { url, expiresIn: granted } = await res.json() as { url: string; expiresIn?: unknown };
    // The GRANTED window, never the requested one. A server that predates the
    // `expiresIn` answer is assumed to have signed for the ceiling at most.
    const seconds = typeof granted === "number" && Number.isFinite(granted) && granted > 0
      ? granted
      : Math.min(expiresIn, PRESIGNED_MAX_SECONDS);
    const entry: SignedUrl = { url, expiresAt: now + seconds * 1000, margin: signedUrlMargin(seconds) };
    signedUrlCache.set(key, entry);
    return entry;
  })();
  signedUrlInflight.set(key, p);
  try { return await p; } finally { signedUrlInflight.delete(key); }
}

async function getPresignedDownloadUrl(path: string, expiresIn = PRESIGNED_MAX_SECONDS, inline = false): Promise<string> {
  return (await getPresignedDownloadUrlEntry(path, expiresIn, inline)).url;
}

/** Thrown when the download-url route REFUSED to sign `path` (a 4xx other
 *  than 408 / 429): the answer will not change on retry. */
export class SignedUrlRefusedError extends Error {
  status: number;
  constructor(status: number) {
    super("Failed to get download URL");
    this.name = "SignedUrlRefusedError";
    this.status = status;
  }
}

/** True when the failure is the route's decision about the path rather than
 *  a transient condition — the only failure a subscription gives up on. */
export function isSignedUrlRefusal(e: unknown): boolean {
  return e instanceof SignedUrlRefusedError || e instanceof ArchivedFileError;
}

/** Keeps `path` signed for as long as the subscription lasts: `cb` receives a
 *  URL now and a fresh one shortly before each granted window closes — for
 *  the images that stay on screen all shift (the org logo in the sidebar, a
 *  folder cover, a page background, an avatar). `cb` is called only when the
 *  URL changes. A path the route REFUSES to sign (4xx) gets `null` once and
 *  is not retried; a re-sign that fails for any other reason (the network is
 *  down after a laptop wakes, a 5xx, an expired token mid-refresh) keeps the
 *  URL the caller already holds and retries on a bounded backoff (15 s
 *  doubling to 60 s) — and at once when the browser comes back online or
 *  the tab returns to the foreground. Returns the unsubscribe. */
export function subscribeSignedUrl(path: string, cb: (url: string | null) => void): () => void {
  let active = true;
  let running = false;
  let listening = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = RESIGN_RETRY_MIN_MS;
  let lastUrl: string | null = null;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, Math.max(ms, 1000));
  };
  // While a re-sign is failing transiently, a reconnect or the tab coming
  // back to the foreground retries immediately instead of waiting out the
  // backoff (a wake from sleep fires the overdue timer before wifi is back).
  const wake = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    void tick();
  };
  const listen = (on: boolean) => {
    if (on === listening || typeof window === "undefined") return;
    listening = on;
    if (on) {
      window.addEventListener("online", wake);
      document.addEventListener("visibilitychange", wake);
    } else {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    }
  };
  const tick = async () => {
    if (!active || running) return;
    running = true;
    let entry: SignedUrl | null = null;
    let refused = false;
    try { entry = await getPresignedDownloadUrlEntry(path); }
    catch (e) { refused = isSignedUrlRefusal(e); }
    running = false;
    if (!active) return;
    if (entry) {
      retryMs = RESIGN_RETRY_MIN_MS;
      listen(false);
      if (entry.url !== lastUrl) { lastUrl = entry.url; cb(entry.url); }
      arm(entry.expiresAt - Date.now() - entry.margin);
      return;
    }
    if (refused) { listen(false); cb(null); return; }
    listen(true);
    arm(retryMs);
    retryMs = Math.min(retryMs * 2, RESIGN_RETRY_MAX_MS);
  };
  void tick();
  return () => { active = false; listen(false); if (timer) clearTimeout(timer); };
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
 *  plain failure so viewers can show the provide-the-zip prompt. A viewer
 *  resolver: asks for an INLINE URL, as resolveFileUrl does. */
export async function resolveFileUrlDetailed(value: string, expiresIn = 3600): Promise<ResolvedFile | null> {
  if (!value) return null;
  if (/^https?:\/\//.test(value) || value.startsWith("blob:")) return { kind: "url", url: value };
  try {
    const url = await getPresignedDownloadUrl(value, expiresIn, true);
    return { kind: "url", url };
  } catch (e) {
    if (e instanceof ArchivedFileError) return { kind: "archived", ...e.info };
    return null;
  }
}

/** Public helper for any UI that needs to display an R2 object by its
 *  storage path. Returns a presigned URL valid for the window the server
 *  granted (at most `expiresIn`, itself capped at the shared ceiling — the
 *  server clamps, the client caches what was granted). Cached + deduped.
 *
 *  SEC-7 / DEC-49: the URL is an ATTACHMENT by default. That is right for
 *  an <img>, a CSS background, fetch(), pdf.js and a download — none of them
 *  honours the disposition. A caller that puts the URL in a FRAME or a new
 *  TAB (a PDF preview, "open in new tab") opts in with `{ inline: true }`;
 *  the route grants inline only for a PDF or a raster image, with its
 *  Content-Type pinned, and signs anything else as an attachment anyway. */
export async function getSignedUrlForPath(
  path: string,
  expiresIn = PRESIGNED_MAX_SECONDS,
  opts: { inline?: boolean } = {},
): Promise<string> {
  return getPresignedDownloadUrl(path, expiresIn, opts.inline === true);
}

/** Resolve a stored file reference — either an absolute http(s)/blob URL or an
 *  R2 storage path — to a usable, cached presigned URL. Viewers should use this
 *  instead of each rolling their own getSession + fetch on every open.
 *
 *  SEC-7 / DEC-49: this is the VIEWERS' resolver, so it asks for an INLINE
 *  URL (its callers — MultiDocViewer, CompareRevisionsModal, the review
 *  gate's draft preview — frame or open the document). The route grants
 *  inline only for a PDF or a raster image; anything else still arrives as
 *  an attachment. */
export async function resolveFileUrl(value: string, expiresIn = 3600): Promise<string | null> {
  if (!value) return null;
  if (/^https?:\/\//.test(value) || value.startsWith("blob:")) return value;
  try {
    return await getPresignedDownloadUrl(value, expiresIn, true);
  } catch {
    return null;
  }
}

/** PKG-3: a per-upload UNIQUE storage name. makeLibraryStoragePath is a pure
 *  function of (org, library, folder, filename), and a PUT to an existing R2
 *  key overwrites it — so two same-named uploads into one folder silently
 *  collapsed to one object while both document rows survived, and the older
 *  document served the newer drawing's bytes under its own title block.
 *  Every document-creation path must salt the name exactly like the four
 *  revision paths always have: `stem__rev<label>__<millis>.ext`. */
export function uniqueUploadName(filename: string, revLabel?: string | null): string {
  const name = filename || "drawing.pdf";
  const safeRev = (revLabel ?? "0").trim().replace(/[^\w.\-]+/g, "_") || "0";
  const stem = name.replace(/\.[^.]+$/, "");
  const ext = name.includes(".") ? name.split(".").pop() || "pdf" : "pdf";
  return `${stem}__rev${safeRev}__${Date.now()}.${ext}`;
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

// Exported for the contractor portal's direct upload (projects-and-cost
// INTK-15): the intake door presigns a PUT for a staging key and the portal
// sends the bytes straight to storage with the same stall detection.
export function putWithXhr(
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
