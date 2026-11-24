"use client";

// The sending company's logo on a page someone outside opens (a shared
// link, an upload link, a transmittal). The image comes from
// /api/brand/logo already on its own background color, so it reads on any
// page. With no logo, the company's name; with neither, the app logo.

import React, { useEffect, useState } from "react";
import { AppLogo } from "@/components/brand/AppMark";

/** A workspace logo from a link (/api/brand/logo?...&plate=1). */
export function LogoImage({ src, name, height = 44 }: { src: string; name?: string | null; height?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return name ? <span className="font-display text-[20px] font-semibold leading-none text-[var(--color-text)]">{name}</span> : <AppLogo size={28} nameClass="text-[17px]" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- generated from the workspace's upload
    <img src={src} alt={name ? `${name} logo` : "Workspace logo"} style={{ height }} className="w-auto max-w-[240px] object-contain rounded-[8px]" draggable={false} onError={() => setFailed(true)} />
  );
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
  return <AppLogo size={28} nameClass="text-[17px]" />;
}
