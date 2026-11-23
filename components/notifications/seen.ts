"use client";

// When the person last opened their notifications (the bell, the
// notification panel or the Inbox), kept on this device. The bell's dot
// ("something changed") clears the moment one of those views opens and
// comes back only when something newer arrives; the lists mark what came
// in after it as new. Nothing is marked read on the server by this.

import { useCallback, useSyncExternalStore } from "react";
import { useRole } from "@/components/providers/RoleContext";

const EVT = "mfgos:notifications-seen";
const keyFor = (uid: string) => `mfgos.notifications.seenAt.${uid}`;

/** When this person last opened their notifications on this device (ms). */
export function readSeen(uid: string | null | undefined): number | null {
  if (!uid) return null;
  try {
    const v = Number(localStorage.getItem(keyFor(uid)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVT, cb); window.removeEventListener("storage", cb); };
}

export function useNotificationsSeen(): { seenAt: number | null; markSeen: () => void } {
  const { uid } = useRole();
  const seenAt = useSyncExternalStore(subscribe, () => readSeen(uid), () => null);
  const markSeen = useCallback(() => {
    if (!uid) return;
    try { localStorage.setItem(keyFor(uid), String(Date.now())); } catch { /* private mode: the dot just stays */ }
    window.dispatchEvent(new Event(EVT));
  }, [uid]);
  return { seenAt, markSeen };
}
