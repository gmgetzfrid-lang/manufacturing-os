// lib/draftHandoff.ts
//
// Hand a batch of (potentially large) marked-up PDFs from the book viewer to the
// drafting-request form. PDFs are far too big for query params / sessionStorage,
// so the blobs are stashed in IndexedDB under a key; the form reads them and
// discards the entry only once the request is submitted (LIFE-3: a refresh of
// /requests/new?draft=… before submitting must still yield the marked-up file —
// the old read-and-delete lost the user's redline on the first reload).
// Best-effort: callers handle a null/throw gracefully.

export interface DraftHandoffFile {
  name: string;
  blob: Blob;
  docId?: string;
  docNumber?: string;
}
export interface DraftHandoff {
  createdAt: number;
  files: DraftHandoffFile[];
}

const DB_NAME = "manufacturingos";
const STORE = "draftHandoff";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store the files and return a one-time retrieval key. */
export async function stashDraft(files: DraftHandoffFile[]): Promise<string> {
  const key = `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ createdAt: Date.now(), files } as DraftHandoff, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  return key;
}

/** Read the stashed files for `key` WITHOUT deleting them — call
 *  `discardDraft` once the request that consumed them is submitted. */
export async function readDraft(key: string): Promise<DraftHandoff | null> {
  const db = await openDb();
  try {
    return await new Promise<DraftHandoff | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const getReq = tx.objectStore(STORE).get(key);
      getReq.onsuccess = () => resolve((getReq.result as DraftHandoff | undefined) ?? null);
      getReq.onerror = () => reject(getReq.error);
    });
  } finally {
    db.close();
  }
}

/** Delete a stash whose files have been submitted (or abandoned on purpose). */
export async function discardDraft(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
