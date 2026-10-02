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
//
// The same counters guard the tab (STACK-13, notifications Round G N7): a
// reload or close while an upload is on the wire kills the transfer and
// leaves no record, so a beforeunload warning is registered while one is
// in flight — the guard lib/clientBackup.ts installs for a backup. Two
// counters feed it: `inFlight` (a batch a page declared with beginUpload,
// which also parks indexing) and `transfers` (every uploadToPath transfer,
// wherever it started — lib/storage.ts holds one per call). Only `inFlight`
// parks indexing; both hold the warning.
//
// A sign-out is not held by it (N7 fourth review). RoleContext's SIGNED_OUT
// branch clears the workspace and replaces the page with "/" — after a
// sign-out button, a token that could not be refreshed, or a sign-out in
// another tab. Held by this prompt, "Stay" would leave the previous
// account's screen up in a tab with no session (a shared tablet). So the
// guard is released on SIGNED_OUT: the redirect ends the transfers either
// way. The listener is added once, when this module loads in a browser
// (lib/storage imports it, and the protected layout imports UploadIndicator,
// which imports lib/storage) — before RoleContext mounts and adds its own,
// so the release has run before that redirect, whichever path it takes.

import { supabase } from "@/lib/supabase";

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

/** Release the leave-page warning on SIGNED_OUT (see the header). Never
 *  throws: no window on the server, no auth client in some tests. */
function releaseOnSignOut() {
  if (typeof window === "undefined") return;
  try {
    supabase.auth?.onAuthStateChange?.((event: string) => {
      if (event === "SIGNED_OUT") releaseUploadUnloadGuard();
    });
  } catch { /* no auth client — nothing to listen to */ }
}
releaseOnSignOut();
