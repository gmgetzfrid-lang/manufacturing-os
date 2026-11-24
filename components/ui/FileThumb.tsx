"use client";

// Proof you picked the right file: a photo shows itself, anything else
// shows its type. Size goes beside it, where the caller puts it.
import React, { useEffect, useMemo } from "react";
import { FileText } from "lucide-react";

export default function FileThumb({ file, size = 40 }: { file: File; size?: number }) {
  const url = useMemo(() => (file.type.startsWith("image/") ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const ext = (file.name.split(".").pop() || "").slice(0, 4).toUpperCase();
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} className="rounded-md object-cover border border-[var(--color-border)] shrink-0" style={{ width: size, height: size }} />
  ) : (
    <span className="rounded-md bg-[var(--color-surface-2)] text-[var(--color-text-muted)] shrink-0 inline-flex flex-col items-center justify-center" style={{ width: size, height: size }}>
      <FileText className="w-4 h-4" />
      {ext && <span className="text-caption font-semibold leading-none mt-0.5">{ext}</span>}
    </span>
  );
}
