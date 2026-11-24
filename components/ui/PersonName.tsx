"use client";

// PersonName: a person's name, not their email. Looks the person up in the
// profile cache (the same one avatars use) and shows their display name;
// until it is known, or if they have none, the name we were given, and
// only as a last resort the email.

import React, { useEffect, useState } from "react";
import { requestProfile, cachedProfile, onProfilesChanged } from "@/lib/userProfiles";

const looksLikeEmail = (s: string | null | undefined) => !!s && /@/.test(s);

export function PersonName({ uid, fallback, className }: { uid?: string | null; fallback?: string | null; className?: string }) {
  const [, bump] = useState(0);
  useEffect(() => onProfilesChanged(() => bump((n) => n + 1)), []);
  useEffect(() => { if (uid) requestProfile(uid); }, [uid]);
  const profile = uid ? cachedProfile(uid) : undefined;
  const name = profile?.displayName?.trim()
    || (fallback && !looksLikeEmail(fallback) ? fallback : "")
    || profile?.email || fallback || "";
  if (!name) return null;
  const email = profile?.email || (looksLikeEmail(fallback) ? fallback : undefined);
  return <span className={className} title={email && email !== name ? `${name} (${email})` : name}>{name}</span>;
}

export default PersonName;
