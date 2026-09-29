// lib/userProfiles.ts
//
// USER PROFILES — one identity source for every avatar in the app.
//
// The rules every surface now follows:
//   * If the user uploaded a photo → show the photo.
//   * Else → initials derived from their DISPLAY NAME ("Grant Getzfrid" →
//     GG), falling back to the email local part ("grant.getzfrid" → GG),
//     falling back to whatever single string we have.
//   * Never the ROLE letter — an avatar identifies a person, not a job.
//
// Fetches are batched + cached module-wide (avatars repeat constantly in
// lists), and avatar paths stay signed while an avatar showing them is mounted.

import { supabase } from "@/lib/supabase";
import { peekSignedUrl, subscribeSignedUrl } from "@/lib/storage";

export interface UserProfile {
  uid: string;
  displayName: string | null;
  email: string | null;
  avatarPath: string | null;
  /** Resolved signed URL — read through cachedAvatarUrl (lib/storage's cache). */
  avatarUrl?: string | null;
}

// ─── Initials (pure — unit-tested) ───────────────────────────────────────

/**
 * "Grant Getzfrid" → "GG" · "grant.getzfrid@x.com" → "GG" · "maria" → "MA"
 * · "J R  Ewing" → "JE" (first + last word) · "" → "?".
 */
export function initialsOf(nameOrEmail?: string | null): string {
  const raw = (nameOrEmail ?? "").trim();
  if (!raw) return "?";
  // Email → local part, with separators treated as word breaks.
  const base = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
  const words = base.split(/[\s._\-]+/).filter((w) => /[a-zA-Z0-9]/.test(w));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Deterministic background tone per person, so the same name always gets
 *  the same color chip everywhere. */
export function avatarToneOf(nameOrEmail?: string | null): string {
  const TONES = [
    "#0ea5e9", "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b",
    "#10b981", "#14b8a6", "#f97316", "#64748b", "#84cc16",
  ];
  const s = (nameOrEmail ?? "?").toLowerCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return TONES[Math.abs(hash) % TONES.length];
}

// ─── Batched, cached profile reads ───────────────────────────────────────

const profileCache = new Map<string, UserProfile>();
// Avatar URLs live in lib/storage's shared cache, which carries the window the
// SERVER granted (EGR-4 / DEC-44 §2 — an hour, not the week this file used to
// ask for). Per path ON SCREEN: one ref-counted subscription (held by every
// mounted UserAvatar showing it) that re-signs before the window closes and
// re-renders avatars through notify(); it ends with the last holder, so an
// avatar scrolled out of a roster hours ago is not re-signed all day. A path
// the route refused to sign keeps a `null` marker (not retried, as before).
const avatarHolds = new Map<string, { count: number; url: string | null; release: () => void }>();
const failedAvatarPaths = new Set<string>();
let pendingUids = new Set<string>();
let pendingPromise: Promise<void> | null = null;
type Listener = () => void;
const listeners = new Set<Listener>();

/** Test hook. */
export function clearProfileCache(): void {
  profileCache.clear();
  for (const hold of avatarHolds.values()) hold.release();
  avatarHolds.clear();
  failedAvatarPaths.clear();
}

/** Subscribe to "profiles arrived" — UserAvatar re-renders through this. */
export function onProfilesChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notify(): void {
  for (const fn of listeners) { try { fn(); } catch { /* listener's problem */ } }
}

/** Synchronous cache read — what UserAvatar renders from. */
export function cachedProfile(uid: string): UserProfile | undefined {
  return profileCache.get(uid);
}

/**
 * Queue a uid for fetching. Requests within the same tick are batched into
 * one query; results land in the cache and notify subscribers. Fire-safe:
 * failures cache a stub so we never re-hammer a missing row.
 */
export function requestProfile(uid: string): void {
  if (!uid || profileCache.has(uid) || pendingUids.has(uid)) return;
  pendingUids.add(uid);
  if (pendingPromise) return;
  pendingPromise = (async () => {
    // Let the current tick finish collecting uids.
    await new Promise((r) => setTimeout(r, 0));
    const batch = [...pendingUids];
    pendingUids = new Set();
    pendingPromise = null;
    if (batch.length === 0) return;
    try {
      const { data } = await supabase
        .from("users")
        .select("id, display_name, email, avatar_path")
        .in("id", batch);
      const found = new Set<string>();
      for (const r of (data as Array<Record<string, unknown>>) ?? []) {
        const uidStr = String(r.id);
        found.add(uidStr);
        profileCache.set(uidStr, {
          uid: uidStr,
          displayName: (r.display_name as string | null) ?? null,
          email: (r.email as string | null) ?? null,
          avatarPath: (r.avatar_path as string | null) ?? null,
        });
      }
      // Stub the misses so we don't refetch them forever.
      for (const uid2 of batch) {
        if (!found.has(uid2)) {
          profileCache.set(uid2, { uid: uid2, displayName: null, email: null, avatarPath: null });
        }
      }
      notify();
    } catch {
      for (const uid2 of batch) {
        if (!profileCache.has(uid2)) {
          profileCache.set(uid2, { uid: uid2, displayName: null, email: null, avatarPath: null });
        }
      }
    }
  })();
}

/** Keep `path` signed while the caller is on screen — UserAvatar holds it
 *  from mount to unmount. The first holder of a path opens ONE lib/storage
 *  subscription (a URL now, re-signed before each granted window closes;
 *  a transient re-sign failure keeps the URL held, a refusal marks the path);
 *  later holders share it; the last release ends it. Avatars re-render
 *  through notify() only when the path's URL actually changes. Returns the
 *  release; calling it twice is harmless. */
export function holdAvatarUrl(path: string): () => void {
  if (failedAvatarPaths.has(path)) return () => {};
  let hold = avatarHolds.get(path);
  if (!hold) {
    const h = { count: 0, url: peekSignedUrl(path)?.url ?? null, release: () => {} };
    h.release = subscribeSignedUrl(path, (u) => {
      if (u === null) failedAvatarPaths.add(path);
      if (u === h.url) return;
      h.url = u;
      notify();
    });
    avatarHolds.set(path, h);
    hold = h;
  }
  hold.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hold.count--;
    if (hold.count > 0) return;
    hold.release();
    if (avatarHolds.get(path) === hold) avatarHolds.delete(path);
  };
}

/** Test hook: how many avatar paths currently hold a subscription. */
export function heldAvatarPathCount(): number {
  return avatarHolds.size;
}

/** Synchronous read of an already-resolved, still-live avatar URL:
 *  `undefined` = not resolved (or no longer live) — ask; `null` = could not be signed. */
export function cachedAvatarUrl(path: string): string | null | undefined {
  if (failedAvatarPaths.has(path)) return null;
  return peekSignedUrl(path)?.url;
}

/** Save the current user's avatar (or null to remove). Path convention:
 *  avatars/<uid>/avatar-<rand>.<ext> — user-scoped, not org-scoped, because
 *  a person is the same person in every workspace. */
export async function saveMyAvatar(uid: string, file: File | null): Promise<void> {
  let path: string | null = null;
  if (file) {
    const { uploadToPath } = await import("@/lib/storage");
    const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const rand = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
    path = `avatars/${uid}/avatar-${rand}.${ext}`;
    await uploadToPath(file, path, { contentType: file.type });
  }
  const { error } = await supabase
    .from("users")
    .upsert({ id: uid, avatar_path: path, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
  const existing = profileCache.get(uid);
  profileCache.set(uid, {
    uid,
    displayName: existing?.displayName ?? null,
    email: existing?.email ?? null,
    avatarPath: path,
  });
  notify();
}
