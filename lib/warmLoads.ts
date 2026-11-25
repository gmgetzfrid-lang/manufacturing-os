// lib/warmLoads.ts - a load started early and picked up later, and the last
// answer each load gave.
//
// The sign-in page knows the account and its workspace before the dashboard
// opens; it starts the dashboard's loads (the layout, what needs you) while
// the sign-in check runs, and the dashboard picks up the same load instead
// of starting again. A load is shared for a short while (20 s by default);
// a refresh asks with `fresh` and gets a new one.
//
// The last answer of each load is kept too (lastLoaded), so a screen opened
// again shows what it showed last time at once while it loads afresh. Every
// key names the account and the workspace it was loaded for, so one never
// shows another's; signing out forgets them all (forgetLoads).

const store = new Map<string, { at: number; p: Promise<unknown> }>();
// `n` orders the answers: the load started last wins, whichever answers first.
const last = new Map<string, { n: number; v: unknown }>();
let started = 0;
// Bumped by forgetLoads: a load still on its way when the account signs
// out never lands in `last`.
let generation = 0;

export function sharedLoad<T>(key: string, load: () => Promise<T>, opts: { maxAgeMs?: number; fresh?: boolean } = {}): Promise<T> {
  const hit = store.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < (opts.maxAgeMs ?? 20_000)) return hit.p as Promise<T>;
  const at = Date.now();
  const n = ++started;
  const gen = generation;
  const p = load();
  store.set(key, { at, p });
  p.then((v) => {
    // The newest answer wins, whichever arrives first.
    if (gen !== generation) return;
    const had = last.get(key);
    if (!had || had.n <= n) last.set(key, { n, v });
  }, () => {
    // A failed load is not kept: the next ask tries again.
    if (store.get(key)?.p === p) store.delete(key);
  });
  return p;
}

/** The last answer a load with this key gave (any age), or undefined. */
export function lastLoaded<T>(key: string | null | undefined): T | undefined {
  return key ? (last.get(key)?.v as T | undefined) : undefined;
}

/** Keep an answer a screen read on its own (not through sharedLoad). */
export function keepLoaded<T>(key: string, v: T): void {
  last.set(key, { n: ++started, v });
}

/** Forget every shared load and every kept answer (signing out). */
export function forgetLoads(): void { generation++; store.clear(); last.clear(); }

export const dashKey = (uid: string) => `dash:${uid}`;
export const inboxKey = (orgId: string, uid: string) => `inbox:${orgId}|${uid}`;
