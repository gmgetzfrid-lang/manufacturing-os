// lib/push/endpoints.ts
//
// Where the server may ever send a Web Push, and how many devices one person
// may hold (notifications Round G, N10 PUSH fix pass — the review's blocker).
//
// A push_subscriptions row's endpoint is a URL the server POSTs to with its
// own network position (web-push calls https.request on whatever host, port
// and path the URL names). Before this file any https URL was accepted, so a
// member could name an internal address or a third party's host and have the
// server call it for them, and read from their own rows how each target
// answered. Now:
//   * /api/push/subscribe stores an endpoint only on a browser push service's
//     own host, on the default https port, with no user-info;
//   * lib/push/sendPush.ts checks again just before each send, never POSTs
//     anywhere else, and deletes a stored row that does not match;
//   * the maintenance cron (step 7c) removes such a row too;
//   * 20261211 drops push_sub_insert_own, so the route is the only writer
//     (a member can no longer insert a row through PostgREST).
//
// The hosts are the push services the browsers this app supports use:
// Chrome / Chromium browsers (FCM), Firefox (Mozilla autopush), Edge on
// Windows (WNS) and Safari / iOS Home Screen apps (Apple). A browser that
// pushes through another service is refused at the opt-in with the
// "not a browser push subscription" answer, never silently stored.
//
// Pure — no imports — so the route, the sender and the cron share it, and it
// is safe in any bundle.

/** Push-service hosts, matched exactly. */
export const PUSH_SERVICE_HOSTS: readonly string[] = Object.freeze([
  "fcm.googleapis.com", // Chrome, Chromium browsers (Brave, Opera, Samsung Internet)
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari 16+, iPhone / iPad Home Screen apps (16.4+)
]);

/** Push-service host suffixes, matched at a label boundary (the leading dot):
 *  a host ends with one and has at least one label before it. */
export const PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = Object.freeze([
  ".push.services.mozilla.com", // Firefox
  ".notify.windows.com", // Edge on Windows (WNS)
  ".push.apple.com", // Safari / Apple
]);

/** The longest endpoint stored or sent to. */
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;

/** The most device registrations one person keeps: the subscribe route keeps
 *  the newest PUSH_DEVICE_CAP (an older one is removed when a new one is
 *  added), and the sender reads no more than the newest PUSH_DEVICE_CAP per
 *  person. */
export const PUSH_DEVICE_CAP = 10;

/** POST /api/push/subscribe's 409 `code` when the endpoint is stored under
 *  OTHER keys than the caller presents (the caller has not shown it holds
 *  that subscription): components/settings/PushOptIn.tsx then starts a fresh
 *  subscription once. */
export const PUSH_KEYS_MISMATCH = "keys_mismatch";

/** Whether the server may ever POST a push to `v`: an https URL on a push
 *  service's host (PUSH_SERVICE_HOSTS / PUSH_SERVICE_HOST_SUFFIXES), on the
 *  default port, with no user-info, of sane length. */
export function pushEndpointAllowed(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > PUSH_ENDPOINT_MAX_LENGTH) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "") return false;
  const host = u.hostname.toLowerCase();
  if (PUSH_SERVICE_HOSTS.includes(host)) return true;
  return PUSH_SERVICE_HOST_SUFFIXES.some((s) => host.length > s.length && host.endsWith(s));
}
