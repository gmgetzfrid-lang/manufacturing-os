"use client";

// PushReminders — per-device opt-in for scheduled OS reminders (overdue /
// aging scratchpad to-dos). Subscribes this browser to Web Push and registers
// it server-side; the reminder cron then pushes a notification every ~6h when
// you have open work — even with the app closed.
//
// Degrades gracefully: renders a clear note (not a broken toggle) when the
// browser lacks push support or the server has no VAPID key configured yet.

import React, { useCallback, useEffect, useState } from "react";
import { BellRing, BellOff, Loader2, Check, AlertTriangle } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

type State = "loading" | "unsupported" | "unconfigured" | "off" | "on" | "denied";

export default function PushReminders() {
  const { activeOrgId } = useRole();
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = typeof window !== "undefined" &&
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  // Reflect the current subscription/permission state on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!supported) { if (alive) setState("unsupported"); return; }
      if (!VAPID_PUBLIC) { if (alive) setState("unconfigured"); return; }
      if (Notification.permission === "denied") { if (alive) setState("denied"); return; }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (alive) setState(sub ? "on" : "off");
      } catch {
        if (alive) setState("off");
      }
    })();
    return () => { alive = false; };
  }, [supported]);

  const enable = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "off"); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBuffer(VAPID_PUBLIC),
        });
      }
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify({ subscription: sub.toJSON(), orgId: activeOrgId ?? undefined }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      setState("on");
    } catch (e) {
      setError((e as Error).message || "Couldn't enable reminders");
    } finally {
      setBusy(false);
    }
  }, [activeOrgId]);

  const disable = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
      }
      setState("off");
    } catch (e) {
      setError((e as Error).message || "Couldn't turn reminders off");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)] grid place-items-center shrink-0">
          <BellRing className="w-4.5 h-4.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-[var(--color-text)]">Reminders on this device</div>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
            Get an OS notification roughly every 6 hours when you have overdue or aging
            scratchpad to-dos — even when the app is closed. Turn it on for each device you use.
          </p>

          {state === "loading" && (
            <div className="mt-2 text-xs text-[var(--color-text-faint)] inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…
            </div>
          )}

          {state === "unsupported" && (
            <div className="mt-2 text-xs text-[var(--color-text-muted)]">
              This browser doesn’t support push notifications. Install the app (Add to taskbar / Home Screen) or use a supported browser.
            </div>
          )}

          {state === "unconfigured" && (
            <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 inline-flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Reminders aren’t set up on the server yet (the admin needs to add the notification keys).
            </div>
          )}

          {state === "denied" && (
            <div className="mt-2 text-xs text-[var(--color-text-muted)]">
              Notifications are blocked for this site. Allow them in your browser’s site settings, then refresh.
            </div>
          )}

          {state === "off" && (
            <button
              onClick={() => void enable()}
              disabled={busy}
              className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}
              Enable reminders
            </button>
          )}

          {state === "on" && (
            <div className="mt-2.5 flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700">
                <Check className="w-3.5 h-3.5" /> Reminders are on for this device
              </span>
              <button
                onClick={() => void disable()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellOff className="w-3.5 h-3.5" />}
                Turn off
              </button>
            </div>
          )}

          {error && (
            <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">{error}</div>
          )}
        </div>
      </div>
    </div>
  );
}
