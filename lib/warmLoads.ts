// lib/warmLoads.ts - a load started early and picked up later.
//
// The sign-in page knows the account and its workspace before the dashboard
// opens; it starts the dashboard's loads (the layout, what needs you) while
// the sign-in check runs, and the dashboard picks up the same load instead
// of starting again. A load is shared for a short while (20 s by default);
// a refresh asks with `fresh` and gets a new one.

const store = new Map<string, { at: number; p: Promise<unknown> }>();

export function sharedLoad<T>(key: string, load: () => Promise<T>, opts: { maxAgeMs?: number; fresh?: boolean } = {}): Promise<T> {
  const hit = store.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < (opts.maxAgeMs ?? 20_000)) return hit.p as Promise<T>;
  const p = load();
  store.set(key, { at: Date.now(), p });
  // A failed load is not kept: the next ask tries again.
  p.catch(() => { if (store.get(key)?.p === p) store.delete(key); });
  return p;
}

/** Forget every shared load (signing out). */
export function forgetLoads(): void { store.clear(); }

export const dashKey = (uid: string) => `dash:${uid}`;
export const inboxKey = (orgId: string, uid: string) => `inbox:${orgId}|${uid}`;
