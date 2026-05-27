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

async function getPresignedDownloadUrl(path: string, expiresIn = 3600): Promise<string> {
  const token = await getAuthToken();
  const res = await fetch(
    `/api/storage/download-url?path=${encodeURIComponent(path)}&expiresIn=${expiresIn}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("Failed to get download URL");
  const { url } = await res.json();
  return url;
}

/** Public helper for any UI that needs to display an R2 object by its
 *  storage path. Returns a presigned URL that's valid for `expiresIn`
 *  seconds (default 1 hour). */
export async function getSignedUrlForPath(path: string, expiresIn = 3600): Promise<string> {
  return getPresignedDownloadUrl(path, expiresIn);
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
  const uploadUrl = await getPresignedUploadUrl(path, contentType);

  // Use XMLHttpRequest for progress reporting
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (e) => {
      if (!opts?.onProgress || !e.lengthComputable) return;
      opts.onProgress({
        bytesTransferred: e.loaded,
        totalBytes: e.total,
        percent: (e.loaded / e.total) * 100,
      });
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ path, url: path, size: file.size, contentType });
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Upload network error")));
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
