// lib/push.ts
//
// Server-side Web Push helper. Wraps the `web-push` library + VAPID keys so
// the reminder cron can deliver OS notifications that fire even when the app
// is fully closed.
//
// Degrades gracefully: with no VAPID keys set, isPushConfigured() returns
// false and callers simply skip sending — the app builds and runs fine
// without push until the env vars are provided.

import webpush from "web-push";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:notifications@manufacturing-os.app";

let configured = false;

/** True when VAPID keys are present (push can be sent). Lazily wires the
 *  web-push details the first time it's confirmed configured. */
export function isPushConfigured(): boolean {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return false;
  if (!configured) {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  }
  return true;
}

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
}

export interface StoredSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Send one push. Returns true if delivered/accepted, false if the
 *  subscription is gone (404/410 → caller should prune). Other errors throw. */
export async function sendToSubscription(sub: StoredSub, payload: PushPayload): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 6 * 60 * 60 },
    );
    return true;
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) return false; // expired/unsubscribed
    throw e;
  }
}
