// lib/folderUrlSync.ts — which way does the folder sync run?
//
// The documents page keeps the open folder in two places: React state and
// the address bar (?folderId=). A reader copies URL → state; a writer copies
// state → URL. Run both blindly and a browser Back loops: the URL changes,
// the writer (still holding the old state) pushes the old folder back, the
// reader follows, and the list flips between two folders forever. The
// writer has to know WHICH side moved.

export type FolderUrlAction = "push" | "sync" | "leave";

/** prevState: the folder the writer saw last time; state: now; url: the
 *  address bar's folderId. "push" = new history step to `state`; "sync" =
 *  URL already agrees on the folder (other params may be rewritten in
 *  place); "leave" = the URL moved first — the reader will catch state up. */
export function folderUrlAction(prevState: string | null, state: string | null, url: string | null): FolderUrlAction {
  if (url === state) return "sync";
  return prevState !== state ? "push" : "leave";
}
