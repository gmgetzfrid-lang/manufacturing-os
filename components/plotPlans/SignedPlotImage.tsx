"use client";

// Presigns a plot-plan storage path and renders it. R2 paths aren't public, so
// every display has to resolve a short-lived signed URL first.

import React from "react";
import { resolvePlotPlanImage } from "@/lib/plotPlans";
import { ImageIcon, Loader2 } from "lucide-react";

export function SignedPlotImage({
  path, alt, className, onLoadDims,
}: {
  path: string | null | undefined;
  alt: string;
  className?: string;
  onLoadDims?: (w: number, h: number) => void;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setUrl(null); setFailed(false);
    if (!path) { setFailed(true); return; }
    void resolvePlotPlanImage(path).then((u) => { if (alive) { if (u) setUrl(u); else setFailed(true); } });
    return () => { alive = false; };
  }, [path]);

  if (failed) {
    return <div className={`flex items-center justify-center bg-[var(--color-surface-2)] text-slate-300 ${className ?? ""}`}><ImageIcon className="w-8 h-8" /></div>;
  }
  if (!url) {
    return <div className={`flex items-center justify-center bg-[var(--color-surface-2)] ${className ?? ""}`}><Loader2 className="w-5 h-5 animate-spin text-slate-300" /></div>;
  }
  // eslint-disable-next-line @next/next/no-img-element -- signed R2 URL
  return <img src={url} alt={alt} className={className} draggable={false} onLoad={(e) => onLoadDims?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />;
}

export default SignedPlotImage;
