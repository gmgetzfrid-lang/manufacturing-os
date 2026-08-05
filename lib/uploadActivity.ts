// lib/uploadActivity.ts — "is the user uploading right now?"
//
// Background knowledge indexing and a bulk upload want the same three scarce
// things: the browser's connections, the database, and the person's
// attention. Left alone they collide — an upload crawls while the indexer
// drains a 900-page standard, and the person watching concludes the upload
// is stuck.
//
// Uploads win. They're foreground work with someone waiting; indexing is
// background work that will still be there in a minute.

let inFlight = 0;
let lastFinished = 0;
const listeners = new Set<(busy: boolean) => void>();

/** Indexing stays parked for a moment after the last upload finishes, so a
 *  staged batch arriving file-by-file isn't interleaved with drain passes. */
const COOLDOWN_MS = 20_000;

function notify() {
  const busy = isUploading();
  for (const fn of listeners) {
    try { fn(busy); } catch { /* a bad listener must not break uploads */ }
  }
}

export function beginUpload(): void {
  inFlight += 1;
  notify();
}

export function endUpload(): void {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) lastFinished = Date.now();
  notify();
}

/** True while uploads are running, and briefly after the last one. */
export function isUploading(): boolean {
  return inFlight > 0 || (lastFinished > 0 && Date.now() - lastFinished < COOLDOWN_MS);
}

export function onUploadActivity(fn: (busy: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Run work with the flag held, whatever happens to it. */
export async function withUploadActivity<T>(run: () => Promise<T>): Promise<T> {
  beginUpload();
  try { return await run(); }
  finally { endUpload(); }
}
