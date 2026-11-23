// lib/draftHandoff.ts
//
// Hand a batch of (potentially large) marked-up PDFs from the book viewer to the
// drafting-request form. PDFs are far too big for query params / sessionStorage,
// so the blobs are stashed in IndexedDB under a one-time key; the form reads them
// and deletes the entry. Best-effort: callers handle a null/throw gracefully.

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

// A key taken once in this page answers the same files again: the form's
// effect can run twice (React's strict mode, a remount), and the second
// read used to find the entry already deleted, so the files never attached.
const taken = new Map<string, Promise<DraftHandoff | null>>();

/** Read and DELETE the stashed files for `key` (one-shot; asking again for
 *  the same key in this page gives the same files). */
export function takeDraft(key: string): Promise<DraftHandoff | null> {
  let p = taken.get(key);
  if (!p) {
    p = takeDraftOnce(key);
    taken.set(key, p);
    p.catch(() => taken.delete(key));
  }
  return p;
}

async function takeDraftOnce(key: string): Promise<DraftHandoff | null> {
  const db = await openDb();
  try {
    return await new Promise<DraftHandoff | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const value = (getReq.result as DraftHandoff | undefined) ?? null;
        store.delete(key);
        resolve(value);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } finally {
    db.close();
  }
}
