// lib/fileDownload.ts - save a stored file because the person pressed
// Download. Never called on its own: files the browser can't show (Word,
// Excel, CAD) only leave the app this way, never by a preview frame.

import { resolveFileUrl } from "@/lib/storage";

export async function downloadStoredFile(path: string, fileName: string): Promise<void> {
  const url = await resolveFileUrl(path);
  if (!url) throw new Error("The file's download link couldn't be made. Check your connection and try again.");
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
