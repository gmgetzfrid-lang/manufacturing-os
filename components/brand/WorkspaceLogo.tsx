"use client";

// The workspace's own logo where the app shows who it belongs to before
// the side menu exists: the sign-in pages and the pages someone outside
// the company opens. The image comes from /api/brand/logo already on its
// own background color, so it reads on any page. With no logo, the
// product's name in plain text (there is no product mark).

import React, { useEffect, useState } from "react";

/** The product's name, written out. */
export function Wordmark({ className = "text-[20px]" }: { className?: string }) {
  return <span className={`font-display font-semibold leading-none text-[var(--color-text)] whitespace-nowrap ${className}`}>Manufacturing OS</span>;
}

/** A workspace logo from a link (/api/brand/logo?...&plate=1). */
export function LogoImage({ src, name, height = 44 }: { src: string; name?: string | null; height?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return name ? <span className="font-display text-[20px] font-semibold leading-none text-[var(--color-text)]">{name}</span> : <Wordmark />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- generated from the workspace's upload
    <img src={src} alt={name ? `${name} logo` : "Workspace logo"} style={{ height }} className="w-auto max-w-[240px] object-contain rounded-[8px]" draggable={false} onError={() => setFailed(true)} />
  );
}

/** The workspace this device signs in to (remembered after a sign-in),
 *  for the sign-in pages. Holds its height while it loads. */
export function DeviceWorkspaceLogo({ height = 44 }: { height?: number }) {
  const [brand, setBrand] = useState<{ logo: string | null; name: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/brand", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (live) setBrand(b && typeof b === "object" ? b : { logo: null, name: null }); })
      .catch(() => { if (live) setBrand({ logo: null, name: null }); });
    return () => { live = false; };
  }, []);
  if (!brand) return <span aria-hidden className="block" style={{ height }} />;
  if (brand.logo) return <LogoImage src={brand.logo} name={brand.name} height={height} />;
  return <span className="flex items-center" style={{ height }}><Wordmark /></span>;
}

// ── The sending company, on a page someone outside opens ───────────────
// The page says who sent it once its link is read; the top bar shows that
// company's logo (its name when it has none). One sender per page.

type Sender = { logo: string | null; name: string | null } | null;
let sender: Sender | undefined;
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Call in the page: `useSender(data, state !== "loading")`. */
export function useSender(v: { orgLogo?: string | null; orgName?: string | null } | null | undefined, known: boolean) {
  const logo = v?.orgLogo ?? null, name = v?.orgName ?? null;
  useEffect(() => {
    sender = known ? (logo || name ? { logo, name } : null) : undefined;
    listeners.forEach((f) => f());
  }, [logo, name, known]);
}

/** The sender's logo, its name, or (when the link didn't open) the
 *  product's name. Nothing while the link is being read. */
export function SenderLogo() {
  const s = React.useSyncExternalStore(subscribe, () => sender, () => undefined);
  if (s === undefined) return null;
  if (s?.logo) return <LogoImage src={s.logo} name={s.name} height={36} />;
  if (s?.name) return <span className="font-display text-[18px] font-semibold leading-none text-[var(--color-text)] truncate">{s.name}</span>;
  return <Wordmark className="text-[17px]" />;
}
