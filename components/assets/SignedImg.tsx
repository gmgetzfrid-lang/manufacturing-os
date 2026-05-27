"use client";

// SignedImg — renders an <img> whose src is a presigned R2 URL
// resolved from a storage path. Used for asset photos, which are
// stored in R2 as opaque paths (e.g. orgs/<id>/assets/<id>/photos/foo.jpg)
// and need a signed URL to load.
//
// Also exports useSignedUrls() for bulk resolution (e.g. thumbnail
// strip in the carousel) — one fetch per path, cached by path.

import React, { useEffect, useState } from "react";
import { getSignedUrlForPath } from "@/lib/storage";

interface SignedImgProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  path: string;
  /** Optional fallback shown while the URL is resolving. */
  placeholder?: React.ReactNode;
  expiresIn?: number;
}

// Cache so multiple <SignedImg path="x" /> on the same page don't
// each fetch their own URL.
const urlCache = new Map<string, { url: string; expiresAt: number }>();

async function resolveCached(path: string, expiresIn = 3600): Promise<string> {
  const cached = urlCache.get(path);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
  const url = await getSignedUrlForPath(path, expiresIn);
  urlCache.set(path, { url, expiresAt: Date.now() + expiresIn * 1000 });
  return url;
}

export default function SignedImg({ path, placeholder, expiresIn, ...imgProps }: SignedImgProps) {
  const [src, setSrc] = useState<string | null>(() => urlCache.get(path)?.url ?? null);

  useEffect(() => {
    let alive = true;
    if (!path) return;
    resolveCached(path, expiresIn)
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [path, expiresIn]);

  if (!src) return <>{placeholder ?? null}</>;
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img src={src} {...imgProps} />;
}

export function useSignedUrls(paths: string[]): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const p of paths) {
      const cached = urlCache.get(p);
      if (cached) m.set(p, cached.url);
    }
    return m;
  });

  useEffect(() => {
    let alive = true;
    const toFetch = paths.filter((p) => !urlCache.get(p));
    if (toFetch.length === 0) {
      // Make sure map is up to date with cached entries
      const next = new Map<string, string>();
      for (const p of paths) {
        const cached = urlCache.get(p);
        if (cached) next.set(p, cached.url);
      }
      setMap(next);
      return;
    }
    Promise.all(toFetch.map((p) => resolveCached(p).catch(() => null))).then(() => {
      if (!alive) return;
      const next = new Map<string, string>();
      for (const p of paths) {
        const cached = urlCache.get(p);
        if (cached) next.set(p, cached.url);
      }
      setMap(next);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join("|")]);

  return map;
}
