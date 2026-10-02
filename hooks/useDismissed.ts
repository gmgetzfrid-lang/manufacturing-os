"use client";

// hooks/useDismissed.ts — a dismissal that sticks.
//
// notifications Round G, N7 CORNER (TAX-8, STACK-6). The FirstRunHint
// pattern (components/ui/FirstRunHint.tsx) generalised: a signalling surface
// that a person dismissed stays dismissed across a remount and a reload, in
// this browser, for this account in this workspace.
//
//   - Keyed by scope (`<uid>:<orgId>` — "keyed by org", and never inherited
//     by the next account on a shared browser) under the `dismissed:` prefix.
//   - Hydration-safe: read through useSyncExternalStore with a server
//     snapshot that says "dismissed", exactly as FirstRunHint does, so a
//     dismissed surface never flashes during hydration.
//   - Never throws. localStorage can be missing, full or forbidden (private
//     mode, an embedded webview): every access is wrapped, and an in-memory
//     copy keeps the dismissal for the life of the tab when storage cannot.
//   - With no scope (signed out, no workspace yet) nothing is persisted: the
//     dismissal lives in the component's own state only.
//   - Cleared on sign-out, alongside the intel-status- snapshots
//     (RoleContext's SIGNED_OUT branch): this module subscribes to the same
//     auth event once, lazily, and removes every `dismissed:` key.

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";

export const DISMISSED_PREFIX = "dismissed:";
/** A set never grows past this many entries; the oldest are dropped. */
export const DISMISSED_SET_MAX = 200;

const memory = new Map<string, string>();
const listeners = new Set<() => void>();
let signOutSweepInstalled = false;

function storageKey(scope: string, key: string) {
  return `${DISMISSED_PREFIX}${scope}:${key}`;
}

function read(k: string): string | null {
  try {
    const v = window.localStorage.getItem(k);
    if (v !== null) return v;
  } catch { /* storage unavailable — fall back to memory */ }
  return memory.get(k) ?? null;
}

function write(k: string, v: string | null) {
  if (v === null) memory.delete(k); else memory.set(k, v);
  try {
    if (v === null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, v);
  } catch { /* memory keeps it for this tab */ }
  emit();
}

function emit() {
  for (const l of listeners) {
    try { l(); } catch { /* a bad listener must not break the others */ }
  }
}

/** Remove every persisted dismissal (all scopes). Runs on sign-out. */
export function clearDismissals(): void {
  for (const k of [...memory.keys()]) if (k.startsWith(DISMISSED_PREFIX)) memory.delete(k);
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(DISMISSED_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => window.localStorage.removeItem(k));
  } catch { /* private mode */ }
  emit();
}

function installSignOutSweep() {
  if (signOutSweepInstalled || typeof window === "undefined") return;
  signOutSweepInstalled = true;
  try {
    supabase.auth?.onAuthStateChange?.((event: string) => {
      if (event === "SIGNED_OUT") clearDismissals();
    });
  } catch { /* no auth client (tests, public pages) — keys are uid-scoped anyway */ }
}

function subscribe(cb: () => void) {
  installSignOutSweep();
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(DISMISSED_PREFIX)) cb();
  };
  try { window.addEventListener("storage", onStorage); } catch { /* no window */ }
  return () => {
    listeners.delete(cb);
    try { window.removeEventListener("storage", onStorage); } catch { /* no window */ }
  };
}

/**
 * One dismissal flag. `scope` is `<uid>:<orgId>` (or null: this component's
 * state only). Returns `[dismissed, setDismissed]`.
 */
export function useDismissed(key: string, scope: string | null): [boolean, (v: boolean) => void] {
  const k = scope ? storageKey(scope, key) : null;
  const [local, setLocal] = useState(false);
  const raw = useSyncExternalStore(subscribe, () => (k ? read(k) : null), () => "1");
  const set = useCallback((v: boolean) => {
    if (k) write(k, v ? "1" : null);
    else setLocal(v);
  }, [k]);
  return [k ? raw === "1" : local, set];
}

/**
 * A set of dismissed ids under one key (one banner row per document, say).
 * Stored as a JSON array, newest last, capped at DISMISSED_SET_MAX. A
 * malformed stored value reads as empty.
 */
export function useDismissedSet(key: string, scope: string | null): {
  has: (id: string) => boolean;
  add: (id: string) => void;
  remove: (id: string) => void;
  /** The stored ids, oldest first (empty until `ready`). */
  values: readonly string[];
  /** Replace the stored ids with `fn(current)` in one write. */
  update: (fn: (ids: string[]) => string[]) => void;
  /** False until the client snapshot is read (server render / hydration). */
  ready: boolean;
} {
  const k = scope ? storageKey(scope, key) : null;
  const [local, setLocal] = useState("");
  const stored = useSyncExternalStore(subscribe, () => (k ? read(k) ?? "" : ""), () => null);
  const raw = k ? stored : local;
  const ids = useMemo(() => parseSet(raw ?? ""), [raw]);
  const put = useCallback((next: string[]) => {
    const v = next.length ? JSON.stringify(next.slice(-DISMISSED_SET_MAX)) : null;
    if (k) write(k, v);
    else setLocal(v ?? "");
  }, [k]);
  const has = useCallback((id: string) => raw === null || ids.includes(id), [ids, raw]);
  const add = useCallback((id: string) => {
    if (ids.includes(id)) return;
    put([...ids, id]);
  }, [ids, put]);
  const remove = useCallback((id: string) => {
    if (!ids.includes(id)) return;
    put(ids.filter((x) => x !== id));
  }, [ids, put]);
  const update = useCallback((fn: (ids: string[]) => string[]) => put(fn([...ids])), [ids, put]);
  return { has, add, remove, values: ids, update, ready: raw !== null };
}

export function parseSet(raw: string): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
