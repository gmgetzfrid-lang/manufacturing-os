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
import { releaseUploadUnloadGuard } from "@/lib/uploadInFlight";

// The counters and the guard live in the leaf module lib/uploadInFlight.ts
// (no Supabase import — notifications N13, TAX-15), re-exported here so every
// caller keeps importing from this file; one module instance holds the state.
export {
  UPLOAD_UNLOAD_MESSAGE, hasUploadsInFlight, releaseUploadUnloadGuard, beginTransfer, endTransfer,
  beginUpload, endUpload, isUploading, onUploadActivity, withUploadActivity,
} from "@/lib/uploadInFlight";

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
