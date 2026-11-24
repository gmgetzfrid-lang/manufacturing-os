"use client";

// WatchButton — small star/bell toggle for watching a resource.
//
// Wires into lib/subscriptions. Used on documents, projects, assets
// to opt in to bell-icon notifications on activity.

import React, { useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { isWatching, watch, unwatch, type WatchResourceType } from "@/lib/subscriptions";

interface Props {
  orgId: string;
  userId: string;
  resourceType: WatchResourceType;
  resourceId: string;
  /** Small variant fits inside table rows; default = pill for headers. */
  size?: "sm" | "md";
  className?: string;
}

export default function WatchButton({ orgId, userId, resourceType, resourceId, size = "md", className = "" }: Props) {
  const [state, setState] = useState<"unknown" | "on" | "off">("unknown");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void isWatching(resourceType, resourceId, userId).then((v) => {
      if (alive) setState(v ? "on" : "off");
    });
    return () => { alive = false; };
  }, [resourceType, resourceId, userId]);

  const toggle = async () => {
    if (busy || state === "unknown") return;
    setBusy(true);
    try {
      if (state === "on") {
        await unwatch({ userId, resourceType, resourceId });
        setState("off");
      } else {
        await watch({ orgId, userId, resourceType, resourceId });
        setState("on");
      }
    } catch (e) {
      console.warn("[WatchButton] toggle failed", e);
    } finally {
      setBusy(false);
    }
  };

  const Icon = state === "on" ? Bell : BellOff;
  const label = state === "on" ? "Following" : "Follow";
  const title = state === "on"
    ? `You're following this ${resourceType}. You'll get a bell-icon notification when there's activity.`
    : `Click to follow this ${resourceType}.`;

  if (size === "sm") {
    return (
      <button
        onClick={toggle}
        title={title}
        aria-label={title}
        aria-pressed={state === "on"}
        disabled={busy || state === "unknown"}
        className={`ui-hit inline-flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
          state === "on" ? "text-[var(--color-accent-text)] hover:bg-[var(--color-surface-2)]" : "text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
        } ${className}`}
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      title={title}
      disabled={busy || state === "unknown"}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 pointer-coarse:min-h-11 rounded-lg text-caption font-medium border transition-colors ${
        state === "on"
          ? "bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent-text)] hover:bg-[var(--color-surface-2)]"
          : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
      } ${className}`}
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
      {label}
    </button>
  );
}
