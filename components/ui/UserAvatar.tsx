"use client";

// UserAvatar — THE avatar for every surface in the app.
//
// Contract (do not reinvent this per-page again):
//   * photo if the person uploaded one
//   * else initials from their display name — "Grant Getzfrid" → GG
//   * else initials from their email local part — "grant.getzfrid" → GG
//   * else initials from whatever name string the caller has
//   * NEVER a role letter — an avatar identifies a person, not a job
//
// Pass `uid` when you have it (profile + photo resolve automatically via
// the batched cache); pass name/email as the fallback identity for rows
// that only carry a display string (e.g. checkout sessions).

import React, { useEffect, useState } from "react";
import {
  requestProfile, cachedProfile, onProfilesChanged,
  resolveAvatarUrl, cachedAvatarUrl, initialsOf, avatarToneOf,
} from "@/lib/userProfiles";

interface UserAvatarProps {
  uid?: string | null;
  name?: string | null;
  email?: string | null;
  /** Pixel size (width=height). Default 32. */
  size?: number;
  className?: string;
  title?: string;
  /** Corner style — matches the two shapes already in the app. */
  rounded?: "full" | "xl" | "lg";
}

export default function UserAvatar({
  uid, name, email, size = 32, className, title, rounded = "full",
}: UserAvatarProps) {
  // Re-render when the profile cache learns something new.
  const [, bump] = useState(0);
  useEffect(() => onProfilesChanged(() => bump((n) => n + 1)), []);

  useEffect(() => { if (uid) requestProfile(uid); }, [uid]);

  const profile = uid ? cachedProfile(uid) : undefined;
  const bestName = profile?.displayName || name || profile?.email || email || null;

  // Kick off (or read) the signed-URL resolve for the photo.
  const avatarPath = profile?.avatarPath ?? null;
  useEffect(() => {
    if (avatarPath && cachedAvatarUrl(avatarPath) === undefined) {
      void resolveAvatarUrl(avatarPath);
    }
  }, [avatarPath]);
  const photoUrl = avatarPath ? cachedAvatarUrl(avatarPath) : null;

  const radius = rounded === "full" ? "rounded-full" : rounded === "xl" ? "rounded-xl" : "rounded-lg";
  const fontSize = Math.max(9, Math.round(size * 0.38));

  if (photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
      <img
        src={photoUrl}
        alt={bestName ?? "User"}
        title={title ?? bestName ?? undefined}
        width={size}
        height={size}
        draggable={false}
        className={`${radius} object-cover shrink-0 border border-black/10 ${className ?? ""}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      title={title ?? bestName ?? undefined}
      className={`${radius} shrink-0 inline-flex items-center justify-center font-black text-white select-none border border-black/10 shadow-sm ${className ?? ""}`}
      style={{ width: size, height: size, fontSize, backgroundColor: avatarToneOf(bestName) }}
      aria-label={bestName ?? "User"}
    >
      {initialsOf(bestName)}
    </span>
  );
}
