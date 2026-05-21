import { storage } from "./firebase";
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  type UploadMetadata,
  type UploadTaskSnapshot,
} from "firebase/storage";

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

export async function uploadFile(file: File, path: string): Promise<string> {
  const result = await uploadToPath(file, path);
  return result.url;
}

export async function uploadToPath(
  file: Blob,
  path: string,
  opts?: {
    metadata?: UploadMetadata;
    onProgress?: (p: UploadProgress) => void;
  }
): Promise<UploadResult> {
  const storageRef = ref(storage, path);

  return new Promise<UploadResult>((resolve, reject) => {
    const task = uploadBytesResumable(storageRef, file, opts?.metadata);

    task.on(
      "state_changed",
      (snap: UploadTaskSnapshot) => {
        if (!opts?.onProgress) return;
        const total = snap.totalBytes || 0;
        const transferred = snap.bytesTransferred || 0;
        const percent = total > 0 ? (transferred / total) * 100 : 0;
        opts.onProgress({
          bytesTransferred: transferred,
          totalBytes: total,
          percent,
        });
      },
      (err) => reject(err),
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          resolve({
            path,
            url,
            size: task.snapshot.totalBytes || 0,
            contentType: (opts?.metadata?.contentType as string | undefined) ?? undefined,
          });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

export async function getFileUrl(path: string) {
  return getDownloadURL(ref(storage, path));
}

export async function deleteFile(path: string) {
  await deleteObject(ref(storage, path));
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
  return uploadToPath(file, path, {
    metadata: { contentType: file.type || undefined },
    onProgress,
  });
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
  return uploadToPath(file, path, {
    metadata: { contentType: file.type || undefined },
    onProgress,
  });
}

export async function getStampedDownloadUrlOrDirect(params: {
  directStoragePath: string;
}) {
  return getFileUrl(params.directStoragePath);
}
