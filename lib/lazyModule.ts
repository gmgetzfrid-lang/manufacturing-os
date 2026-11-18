// A module the app shell loads on use, not on first paint (projects-tab
// PERF-12, projects-joint J18).
//
// The protected layout mounts hosts that render nothing until someone opens
// them — the command palette, the relationship map, the signature ceremony.
// Their listeners stay in the shell (mounted at the same moment, so the first
// shortcut or event is never dropped); what they render is a module of its
// own, fetched when the browser is first idle after the page is up, or at
// the first use, whichever comes first. Once loaded it renders synchronously
// — no fallback frame, no second fetch — because the loaded module is kept
// here and read through `useSyncExternalStore`, not through `React.lazy`
// (which suspends for a tick on every fresh mount).
//
// A failed fetch (offline before the module was ever fetched) is not kept:
// the next fetch starts afresh. A host never leaves a surface it was asked to
// open silently dead: `useLoaded` reports a failed fetch for an open through
// `onError` (each host then closes its request and says "couldn't load —
// check your connection and try again" in a toast), and a new open passes a
// new `attempt`, which fetches again. A failed idle preload is quiet; the
// first open fetches again and reports.

import { useEffect, useRef, useSyncExternalStore } from "react";

export interface UseLoadedOptions {
  /** Changes on every open: a new value fetches again if the module has not
   *  loaded (after a failed fetch, the next open retries). */
  attempt?: number;
  /** Called when a fetch this open started (or joined) fails, while the open
   *  still wants the module. */
  onError?: (e: unknown) => void;
}

export interface LazyModule<T> {
  /** Starts the fetch (once) and resolves with the module. */
  preload: () => Promise<T>;
  /** The module if it has loaded, else undefined. */
  peek: () => T | undefined;
  /** In a component: the module once loaded (re-renders when it arrives).
   *  With `want` true it starts the fetch if it has not started (again for
   *  each new `attempt`), and reports a failure to `onError`. On the server,
   *  and during hydration, it is always undefined. */
  useLoaded: (want: boolean, opts?: UseLoadedOptions) => T | undefined;
}

export function lazyModule<T>(load: () => Promise<T>, label = "module"): LazyModule<T> {
  let value: T | undefined;
  let pending: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  };
  const preload = (): Promise<T> => {
    if (value !== undefined) return Promise.resolve(value);
    if (!pending) {
      pending = load().then(
        (v) => {
          value = v;
          for (const l of [...listeners]) l();
          return v;
        },
        (e) => {
          pending = null;
          throw e;
        },
      );
    }
    return pending;
  };
  const peek = () => value;
  const useLoaded = (want: boolean, opts?: UseLoadedOptions): T | undefined => {
    const v = useSyncExternalStore(subscribe, peek, () => undefined);
    const onErrorRef = useRef(opts?.onError);
    useEffect(() => { onErrorRef.current = opts?.onError; });
    const attempt = opts?.attempt ?? 0;
    useEffect(() => {
      if (!want || value !== undefined) return;
      let live = true;
      preload().catch((e) => {
        console.warn(`[lazyModule] could not load the ${label}; the next open tries again`, e);
        if (live) onErrorRef.current?.(e);
      });
      return () => { live = false; };
    }, [want, attempt]);
    return v;
  };
  return { preload, peek, useLoaded };
}

/** The toast a host shows when what someone opened could not be fetched:
 *  the request is closed, and the next open fetches again. */
export function loadFailedToast(what: string): { type: "error"; title: string; message: string } {
  return { type: "error", title: `Couldn't load the ${what}`, message: "Check your connection and try again." };
}

/** Runs `fn` once the browser is idle (requestIdleCallback, at most
 *  `timeoutMs` later; a short timer where there is none). Returns a cancel. */
export function whenIdle(fn: () => void, timeoutMs = 2000): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(fn, { timeout: timeoutMs });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(fn, 200);
  return () => window.clearTimeout(t);
}

/** In a component: preloads `mod` once the browser is first idle after
 *  mount (or after `enabled` turns true — a surface only some people can
 *  open preloads only for them). A preload that fails is quiet — the first
 *  use tries again and says so. */
export function usePreloadWhenIdle<T>(mod: LazyModule<T>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return whenIdle(() => { mod.preload().catch(() => {}); });
  }, [mod, enabled]);
}
