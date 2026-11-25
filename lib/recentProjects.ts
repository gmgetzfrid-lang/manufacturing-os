// lib/recentProjects.ts - the projects this person opened last, per
// workspace, kept on this device (no database read): the side menu's
// "Recent projects" jumps straight back into them.

import { useSyncExternalStore } from "react";

export interface RecentProject { id: string; name: string }

const KEY = (orgId: string) => `mfgos.recentProjects:${orgId}`;
const EVENT = "recent-projects:changed";
const MAX = 3;

function read(orgId: string): RecentProject[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(orgId)) || "[]") as unknown;
    return Array.isArray(v) ? (v as RecentProject[]).filter((p) => p && typeof p.id === "string" && typeof p.name === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Put a project first in this workspace's recent list (its name refreshed). */
export function rememberProject(orgId: string, p: RecentProject): void {
  try {
    const next = [p, ...read(orgId).filter((x) => x.id !== p.id)].slice(0, MAX);
    localStorage.setItem(KEY(orgId), JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch { /* private mode: nothing remembered */ }
}

/** Drop a project (deleted, or no longer reachable). */
export function forgetProject(orgId: string, id: string): void {
  try {
    localStorage.setItem(KEY(orgId), JSON.stringify(read(orgId).filter((x) => x.id !== id)));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch { /* ignore */ }
}

/** This workspace's recent projects, kept current across tabs. */
const EMPTY: RecentProject[] = [];
const cache = new Map<string, { raw: string; list: RecentProject[] }>();
function snapshot(orgId: string): RecentProject[] {
  let raw = "[]";
  try { raw = localStorage.getItem(KEY(orgId)) ?? "[]"; } catch { /* private mode */ }
  const hit = cache.get(orgId);
  if (hit && hit.raw === raw) return hit.list;
  const list = read(orgId);
  cache.set(orgId, { raw, list });
  return list;
}
function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener("storage", onChange); };
}
export function useRecentProjects(orgId: string | null | undefined): RecentProject[] {
  return useSyncExternalStore(subscribe, () => (orgId ? snapshot(orgId) : EMPTY), () => EMPTY);
}
