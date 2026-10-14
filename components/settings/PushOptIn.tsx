"use client";

// components/settings/PushOptIn.tsx — "Turn on notifications for this
// device" (notifications Round G, N10 PUSH — GAP-205; OS-3, OS-10, TAX-12).
//
// The ONLY place the app asks the browser for notification permission
// (a test pins Notification.requestPermission to this file). Mounted on
// /settings/notifications, inside the auth gate — never on load, never on a
// public page (OS-3 done-when 1 / 2: a refused browser prompt is close to
// permanent, and one shipped on load would foreclose the channel for most of
// the workforce).
//
//   1. The person clicks "Turn on notifications for this device".
//   2. The card says what will be sent — the push-worthy kinds, by name of
//      kind only — BEFORE the browser's dialog (OS-3 done-when 3).
//   3. "Allow notifications" calls Notification.requestPermission() first
//      thing in the click, then subscribes from navigator.serviceWorker.ready
//      (registration.pushManager.subscribe({ userVisibleOnly: true,
//      applicationServerKey })) and stores the device
//      (POST /api/push/subscribe). That row is the explicit per-device
//      opt-in the sender requires (OS-10 done-when 1 / 3).
//   4. "Not now", or the browser's dialog dismissed, is recorded
//      (hooks/useDismissed — this account, this workspace, this browser) and
//      the card stops inviting; the button stays for a deliberate change of
//      mind. "Blocked" (Notification.permission === 'denied') renders how to
//      unblock it, not a dead toggle (OS-3 done-when 4).
//
// The person-wide switch is notification_preferences.push_enabled, rendered
// here as a real control (OS-10 done-when 2) and saved the moment it is
// flipped (only that column — the page's Save button never writes it). Off
// stops every device and leaves each registered (GAP-205 acceptance 2).
//
// A browser without push (no service worker, no PushManager — an iPhone's
// Safari outside the installed app), or a server without VAPID keys, gets a
// sentence instead of a control. Nothing here changes the bell or email.

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, BellRing, Check, Smartphone } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useDismissed } from "@/hooks/useDismissed";
import { Button } from "@/components/ui/Button";

/** useDismissed key for "Not now" (scope `<uid>:<orgId>`). A later nudge that
 *  invites push reads the same key and stays quiet. */
export const PUSH_DECLINE_KEY = "push-optin-declined";

/** What a device notification is ever about — one line per push-worthy kind
 *  (lib/notificationKinds.ts KIND_META.pushWorthy; a test pins the count).
 *  Said before the browser's dialog. */
export const PUSH_WHAT_IS_SENT: readonly string[] = Object.freeze([
  "A hold placed on a document you work on",
  "Your checkout released by someone else",
  "A request to acknowledge a document",
  "A request to sign off a document",
  "A mention on a request",
  "A request assigned to you",
]);

export const PUSH_PRIVACY_NOTE =
  "The notification says only what kind of thing happened — never a document number, a title, a reason or a person's name — so nothing sensitive shows on a lock screen. Open it to see the details.";

export const PUSH_DENIED_TEXT =
  "Notifications are blocked for this site in your browser. To turn them on, allow notifications for this site in your browser's site settings (the icon beside the address), then reload this page.";

export const PUSH_UNSUPPORTED_TEXT =
  "This browser can't show notifications from the app. On an iPhone or iPad, add the app to your Home Screen and open it from there first.";

export const PUSH_UNCONFIGURED_TEXT = "Device notifications are not set up on this server yet.";

type DeviceState = "loading" | "unsupported" | "unconfigured" | "denied" | "off" | "working" | "on";

/** Whether this browser can receive Web Push at all. */
export function pushSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return !!navigator.serviceWorker && "PushManager" in window && "Notification" in window;
}

/** A VAPID public key (base64url) as the bytes pushManager.subscribe takes. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Whether a subscription was made with this server's key (a rotated key
 *  needs a fresh subscription). */
function sameKey(existing: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  if (a.length !== key.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== key[i]) return false;
  return true;
}

async function bearer(): Promise<Record<string, string> | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { "content-type": "application/json", authorization: `Bearer ${token}` } : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export default function PushOptIn({ uid, orgId }: { uid: string | null; orgId: string | null }) {
  const [device, setDevice] = useState<DeviceState>("loading");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [declined, setDeclined] = useDismissed(PUSH_DECLINE_KEY, uid && orgId ? `${uid}:${orgId}` : null);
  // push_enabled: null until read (or when it cannot be read — the switch is
  // then disabled rather than guessing)
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);
  const [prefError, setPrefError] = useState<string | null>(null);
  const [prefSaving, setPrefSaving] = useState(false);
  const [prefSaved, setPrefSaved] = useState(false);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.from("notification_preferences").select("push_enabled").eq("user_id", uid).maybeSingle();
        if (cancelled) return;
        if (error) { setPrefError(`Your device-notification setting could not be read: ${error.message}`); return; }
        setPushEnabled((data as { push_enabled?: unknown } | null)?.push_enabled !== false);
      } catch (e) {
        if (!cancelled) setPrefError(`Your device-notification setting could not be read: ${(e as Error).message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [uid]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) { setDevice("unsupported"); return; }
      let cfg: { configured?: unknown; publicKey?: unknown } | null = null;
      try {
        const res = await fetch("/api/push/subscribe", { cache: "no-store" });
        cfg = res.ok ? await res.json() : null;
      } catch { cfg = null; }
      if (cancelled) return;
      if (!cfg?.configured || typeof cfg.publicKey !== "string") { setDevice("unconfigured"); return; }
      const key = cfg.publicKey;
      setPublicKey(key);
      if (Notification.permission === "denied") { setDevice("denied"); return; }
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub && Notification.permission === "granted" && sameKey(sub.options?.applicationServerKey, urlBase64ToUint8Array(key))) {
          // own-row RLS (20260804): the row is visible only if it is ours
          const { data } = await supabase.from("push_subscriptions").select("id").eq("endpoint", sub.endpoint).maybeSingle();
          if (!cancelled && data) { setDevice("on"); return; }
        }
      } catch { /* treat as not on */ }
      if (!cancelled) setDevice("off");
    })();
    return () => { cancelled = true; };
  }, [uid]);

  const savePushEnabled = useCallback(async (v: boolean) => {
    if (!uid || pushEnabled === null) return;
    setPrefSaving(true); setPrefError(null); setPrefSaved(false);
    try {
      // Only this column: an existing row keeps every other preference; a
      // new row takes the column defaults, which are what "no row" meant.
      const { error } = await supabase
        .from("notification_preferences")
        .upsert({ user_id: uid, push_enabled: v }, { onConflict: "user_id" });
      if (error) { setPrefError(`Not saved: ${error.message}`); return; }
      setPushEnabled(v);
      setPrefSaved(true);
      setTimeout(() => setPrefSaved(false), 2500);
    } catch (e) {
      setPrefError(`Not saved: ${(e as Error).message}`);
    } finally {
      setPrefSaving(false);
    }
  }, [uid, pushEnabled]);

  const allow = useCallback(async () => {
    setDeviceError(null);
    // First thing in the click: a browser that needs the person's gesture
    // for the permission dialog still has it.
    let permission: NotificationPermission;
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = Notification.permission;
    }
    if (permission !== "granted") {
      setDeclined(true);
      setExplaining(false);
      setDevice(permission === "denied" ? "denied" : "off");
      return;
    }
    if (!publicKey || !orgId) { setDeviceError("Your workspace is still loading — try again in a moment."); return; }
    setDevice("working");
    try {
      const reg = await withTimeout(navigator.serviceWorker.ready, 10_000);
      if (!reg) {
        setDeviceError("The app's background worker is not running in this browser — reload the page and try again.");
        setDevice("off");
        return;
      }
      const key = urlBase64ToUint8Array(publicKey);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
        await sub.unsubscribe().catch(() => false);
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const headers = await bearer();
      if (!headers) {
        await sub.unsubscribe().catch(() => false);
        setDeviceError("You're signed out — sign in again and retry.");
        setDevice("off");
        return;
      }
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({ orgId, subscription: sub.toJSON() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        await sub.unsubscribe().catch(() => false);
        setDeviceError(typeof body?.error === "string" ? body.error : "This device could not be registered — try again.");
        setDevice("off");
        return;
      }
      setDeclined(false);
      setExplaining(false);
      setDevice("on");
    } catch (e) {
      setDeviceError(`This device could not be registered: ${(e as Error).message}`);
      setDevice("off");
    }
  }, [publicKey, orgId, setDeclined]);

  const turnOff = useCallback(async () => {
    setDeviceError(null);
    setDevice("working");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      const endpoint = sub?.endpoint;
      await sub?.unsubscribe().catch(() => false);
      const headers = await bearer();
      if (endpoint && headers) {
        await fetch("/api/push/unsubscribe", { method: "POST", headers, body: JSON.stringify({ endpoint }) });
      }
      setDevice("off");
    } catch (e) {
      setDeviceError(`This device could not be turned off: ${(e as Error).message}`);
      setDevice("on");
    }
  }, []);

  const notNow = useCallback(() => {
    setDeclined(true);
    setExplaining(false);
  }, [setDeclined]);

  return (
    <section data-push-optin className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm divide-y divide-[var(--color-border)] mt-4">
      <div className="px-5 py-4 flex items-start gap-3">
        <Smartphone className="w-5 h-5 text-[var(--color-text-muted)] shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="text-sm font-black text-[var(--color-text)]">Device notifications</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
            A notification on this computer or phone — even when the app is closed — for the few things that cannot wait. Off here pauses every device you turned on; they stay registered, and the bell and email are unchanged.
          </div>
          {prefError && <div role="alert" className="text-xs text-red-700 mt-1">{prefError}</div>}
          {prefSaved && <div className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 mt-1"><Check className="w-3.5 h-3.5" /> Saved</div>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={pushEnabled === true}
          aria-label="Device notifications"
          disabled={pushEnabled === null || prefSaving}
          onClick={() => { if (pushEnabled !== null) void savePushEnabled(!pushEnabled); }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] focus-visible:ring-offset-2 ${pushEnabled ? "bg-emerald-500" : "bg-slate-300"}`}
        >
          <span className={`inline-block h-5 w-5 transform rounded-full bg-[var(--color-surface)] shadow transition-transform ${pushEnabled ? "translate-x-5" : "translate-x-1"}`} />
        </button>
      </div>

      <div className="px-5 py-4" data-push-device={device}>
        <div className="flex items-start gap-3">
          <BellRing className="w-4 h-4 text-[var(--color-text-faint)] mt-1 shrink-0" />
          <div className="flex-1 min-w-0 text-xs text-[var(--color-text-muted)]">
            <div className="text-sm font-bold text-[var(--color-text)]">This device</div>
            {device === "loading" && <div className="mt-0.5">Checking this browser…</div>}
            {device === "unsupported" && <div className="mt-0.5">{PUSH_UNSUPPORTED_TEXT}</div>}
            {device === "unconfigured" && <div className="mt-0.5">{PUSH_UNCONFIGURED_TEXT}</div>}
            {device === "denied" && (
              <div role="status" className="mt-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {PUSH_DENIED_TEXT}
              </div>
            )}
            {device === "on" && (
              <div className="mt-0.5 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1 font-bold text-emerald-700"><Check className="w-3.5 h-3.5" /> On for this device</span>
                <Button size="sm" variant="secondary" onClick={() => { void turnOff(); }}>Turn off for this device</Button>
              </div>
            )}
            {device === "on" && pushEnabled === false && (
              <div className="mt-1 text-amber-800">Paused for all your devices — switch Device notifications back on above to receive them here.</div>
            )}
            {device === "working" && <div className="mt-0.5">Working…</div>}
            {device === "off" && !explaining && (
              <div className="mt-0.5 flex flex-wrap items-center gap-3">
                {declined
                  ? <span>You chose not to turn on notifications for this device. The app will not ask again.</span>
                  : <span>Off for this device.</span>}
                <Button size="sm" variant={declined ? "ghost" : "primary"} onClick={() => { setDeviceError(null); setExplaining(true); }}>
                  Turn on notifications for this device
                </Button>
              </div>
            )}
            {device === "off" && explaining && (
              <div data-push-explain className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-[var(--color-text)]">
                <div className="font-bold">This device will be notified, even when the app is closed, only for:</div>
                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                  {PUSH_WHAT_IS_SENT.map((line) => <li key={line}>{line}</li>)}
                </ul>
                <div className="mt-2 text-[var(--color-text-muted)]">{PUSH_PRIVACY_NOTE}</div>
                <div className="mt-2 text-[var(--color-text-muted)]">Your browser will ask for permission next.</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => { void allow(); }}>Allow notifications</Button>
                  <Button size="sm" variant="ghost" onClick={notNow}>Not now</Button>
                </div>
              </div>
            )}
            {deviceError && <div role="alert" className="mt-1 text-red-700">{deviceError}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}
