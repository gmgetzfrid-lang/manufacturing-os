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
//   2. The card says what will be sent — only what is pushed TODAY, by name
//      of kind only, and what is not sent to devices — BEFORE the browser's
//      dialog (OS-3 done-when 3; fix pass: the first pass listed request
//      mentions and assignments before any producer pushed them — OS-14,
//      since closed by notifications N17).
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
import { PUSH_KEYS_MISMATCH, PUSH_OPT_IN_SINCE } from "@/lib/notify/dispatch";
import type { ClassifiedKind } from "@/lib/notificationKinds";

/** useDismissed key for "Not now" (scope `<uid>:<orgId>`). A later nudge that
 *  invites push reads the same key and stays quiet. */
export const PUSH_DECLINE_KEY = "push-optin-declined";

/** What a device notification is about TODAY: one line per push-worthy kind
 *  whose producer reaches the push leg, worded for exactly those producers
 *  (fix pass — the review's major 3). Said before the browser's dialog.
 *   - hold_opened: openHold's stop-work notice (lib/holds.ts
 *     notifyHoldChange — the hold strip, check-in);
 *   - checkout_force_released: lib/checkoutEpisodes.ts forceReleaseDocument;
 *   - ack_requested: the distribution list's request (lib/distributionAcks.ts
 *     — DistributionAcks / DistributionRecall), and (OS-14, notifications
 *     N17) the read-&-understood list's request when a revision is issued
 *     (lib/acknowledgments.ts recomputeDocumentAck, through
 *     lib/notify/dispatch.ts pushAfterBellRows). Its re-send from the roster
 *     panel (nudgeAcknowledgment) takes the same leg, but its reminder row
 *     names no actor, so /api/push/notify cannot push it until 20261160
 *     stamps the writer — the line does not promise it, and PUSH_NOT_YET_NOTE
 *     says so (the integrator's ruling R3 at the N17 merge, DEC-90). The
 *     intake link's auto-publish opens this roster on the server and pushes
 *     it through the door's server sender (OS-16, ruling R4);
 *   - review_requested: a change proposed at check-in, sent to the document's
 *     owner (components/documents/CheckInPanel.tsx), and (OS-14) a draft's
 *     sign-off request from its review roster (lib/reviewControl.ts
 *     openReviewRoster, through pushAfterBellRows);
 *   - ticket_mention (OS-14): a mention in a request comment
 *     (app/api/tickets/comment/route.ts fanOut → sendPushSafe);
 *   - ticket_assigned (OS-14): a request assigned to you
 *     (app/api/tickets/workflow-action/route.ts fanOut → sendPushSafe).
 *  What is still bell / email only is PUSH_NOT_YET_NOTE. A test pins the
 *  list against the push-worthy set and each line to its producers.
 *  (`pushKind`, not `kind`: this card writes no notification —
 *  lib/__tests__/kindSplitProducers.test.ts counts a `kind: "…"` literal as
 *  a writer.) */
export const PUSH_SENT_TODAY: ReadonlyArray<{ pushKind: ClassifiedKind; line: string }> = Object.freeze([
  { pushKind: "hold_opened", line: "A hold placed on a document you work on or follow" },
  { pushKind: "checkout_force_released", line: "Your checkout released by someone else" },
  { pushKind: "ack_requested", line: "A request to confirm you have read a document's current revision — from its distribution list, or from its read-and-understood list when a revision is issued" },
  { pushKind: "review_requested", line: "A request to review a document — a draft waiting for your sign-off, or a change proposed at check-in to a document you own" },
  { pushKind: "ticket_mention", line: "A mention in a comment on a request" },
  { pushKind: "ticket_assigned", line: "A request assigned to you" },
]);
export const PUSH_WHAT_IS_SENT: readonly string[] = Object.freeze(PUSH_SENT_TODAY.map((l) => l.line));

/** The push-worthy kinds no producer pushes yet — none since OS-14 closed
 *  (notifications N17) — and the sentence the card says about what still
 *  reaches only the bell and email, so nobody relies on a device
 *  notification that never comes:
 *   - the daily scan's reminders (the maintenance cron never pushes —
 *     DEC-108 §6);
 *   - (ruling R3, the integrator at the N17 merge, DEC-90) a reminder
 *     re-sent from the acknowledgment list (nudgeAcknowledgment): its bell
 *     row names no actor, so POST /api/push/notify finds no row from its
 *     writer until 20261160 (the notification rails migration) stamps one —
 *     worded "until … is applied" so it stays true after the paste;
 *   - (ruling R2) the read-&-understood and sign-off requests a door opens
 *     for MANY documents in one action — the library / folder policy save
 *     (setAckPolicy), the library's multi-file upload, the bulk status
 *     editor (BulkEditModal), a split, a set rev-up (setRevUp) and the
 *     output-template filing run: each passes `notifyPush: false`, so one
 *     action never sends a push request per document. A single-document
 *     door pushes.
 *  The intake link's auto-publish is no longer here: its roster is pushed
 *  through the door's server sender (OS-16, ruling R4). Pinned in
 *  lib/__tests__/pushOptIn.test.ts and the census in
 *  lib/__tests__/n17PushRosters.test.ts. */
export const PUSH_NOT_SENT_YET: readonly ClassifiedKind[] = Object.freeze([] as ClassifiedKind[]);
export const PUSH_NOT_YET_NOTE =
  "Not sent to devices: the daily reminders about acknowledgments and sign-offs still outstanding; a reminder re-sent from the acknowledgment list, until the notification rails migration is applied; and read-and-understood and sign-off requests opened by one action across many documents — a policy set on a whole library or folder, a multi-file upload, a bulk status edit, a split, a set rev-up or a template filing run. The bell and email still bring them.";

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
          // own-row RLS (20260804): the row is visible only if it is ours;
          // one older than this control (the deleted reminders stack's) is
          // never pushed, so it does not count as on
          const { data } = await supabase.from("push_subscriptions").select("id, created_at").eq("endpoint", sub.endpoint).maybeSingle();
          const made = (data as { created_at?: unknown } | null)?.created_at;
          if (!cancelled && typeof made === "string" && Date.parse(made) >= Date.parse(PUSH_OPT_IN_SINCE)) { setDevice("on"); return; }
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
      // Whether THIS click made the subscription. One made before it (another
      // person's, on a shared browser) is never taken back on a failure here
      // — it may be their working registration (fix pass).
      let made = false;
      if (!sub) { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); made = true; }
      const headers = await bearer();
      if (!headers) {
        if (made) await sub.unsubscribe().catch(() => false);
        setDeviceError("You're signed out — sign in again and retry.");
        setDevice("off");
        return;
      }
      const register = (s: PushSubscription) => fetch("/api/push/subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({ orgId, subscription: s.toJSON() }),
      });
      let res = await register(sub);
      let body = res.ok ? null : ((await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null);
      if (!res.ok && res.status === 409 && body?.code === PUSH_KEYS_MISMATCH && !made) {
        // The server holds this endpoint under other keys than this browser's
        // live subscription: that registration is not this browser's, so a
        // fresh subscription (a new endpoint) is started, once.
        await sub.unsubscribe().catch(() => false);
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        made = true;
        res = await register(sub);
        body = res.ok ? null : ((await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null);
      }
      if (!res.ok) {
        if (made) await sub.unsubscribe().catch(() => false);
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
                <div data-push-not-yet className="mt-2 text-[var(--color-text-muted)]">{PUSH_NOT_YET_NOTE}</div>
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
