// lib/uploadInFlight.ts — the upload counters and the tab's leave-page
// guard, in a leaf module that imports nothing (notifications N13, TAX-15).
//
// lib/uploadActivity.ts re-exports every name here and adds the one thing
// that needs the Supabase client: releasing the guard on SIGNED_OUT (its
// header says why). It used to hold the counters itself, so a page that
// wanted to know whether an upload is on the wire had to import the Supabase
// client with it. ServiceWorkerManager's update-prompt fallback, mounted
// beside every page in app/layout.tsx, needs exactly that question
// (`hasUploadsInFlight`) and must not put the client in every page's root
// bundle — so the state lives here, one instance whichever path imports it.
//
// What the counters mean, and the guard, are unchanged (STACK-13; see
// lib/uploadActivity.ts's header).


let inFlight = 0;
let transfers = 0;
let lastFinished = 0;
const listeners = new Set<(busy: boolean) => void>();

export const UPLOAD_UNLOAD_MESSAGE = "An upload is still running — leaving this tab will stop it.";
let guardInstalled = false;
let guardReleased = false;

const warnUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = UPLOAD_UNLOAD_MESSAGE;
};

/** Install the leave-page warning while anything is in flight; remove it
 *  when nothing is. Never throws (no window in tests / on the server). */
function syncUnloadGuard() {
  if (typeof window === "undefined") return;
  const want = (inFlight > 0 || transfers > 0) && !guardReleased;
  try {
    if (want && !guardInstalled) { window.addEventListener("beforeunload", warnUnload); guardInstalled = true; }
    else if (!want && guardInstalled) { window.removeEventListener("beforeunload", warnUnload); guardInstalled = false; }
  } catch { /* no window */ }
  if (inFlight === 0 && transfers === 0) guardReleased = false;
}

/** True while an upload is actually on the wire (no cooldown). */
export function hasUploadsInFlight(): boolean {
  return inFlight > 0 || transfers > 0;
}

/** A person already confirmed leaving (UpdatePill's "Reload anyway"): drop
 *  the browser's own prompt until the in-flight work drains, so they are
 *  not asked twice. */
export function releaseUploadUnloadGuard(): void {
  guardReleased = true;
  syncUnloadGuard();
}

/** One uploadToPath transfer started / ended (lib/storage.ts). */
export function beginTransfer(): void {
  transfers += 1;
  syncUnloadGuard();
}

export function endTransfer(): void {
  transfers = Math.max(0, transfers - 1);
  syncUnloadGuard();
}

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
  syncUnloadGuard();
  notify();
}

export function endUpload(): void {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) lastFinished = Date.now();
  syncUnloadGuard();
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
