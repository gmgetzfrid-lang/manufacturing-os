// lib/push/endpoints.ts
//
// SERVER-ONLY. Where the server may ever send a Web Push, and how many
// devices one person may hold (notifications Round G, N10 PUSH fix pass —
// the review's blocker; fix pass 2 — the parser gap).
//
// A push_subscriptions row's endpoint is a URL the server POSTs to with its
// own network position (web-push calls https.request on whatever host, port
// and path the URL names). Before the fix pass any https URL was accepted, so
// a member could name an internal address or a third party's host and have
// the server call it for them, and read from their own rows how each target
// answered. Now:
//   * /api/push/subscribe stores an endpoint only on a browser push service's
//     own host, on the default https port, with no user-info;
//   * lib/push/sendPush.ts checks again just before each send, never POSTs
//     anywhere else, and deletes a stored row that does not match;
//   * the maintenance cron (step 7c) removes such a row too;
//   * 20261211 drops push_sub_insert_own, so the route is the only writer
//     (a member can no longer insert a row through PostgREST).
//
// Fix pass 2 (the second review's blocker): the first check read the host
// with the WHATWG parser (`new URL`), but web-push 3.6.7 picks the host it
// connects to with Node's LEGACY parser (`url.parse`, web-push-lib.js
// sendNotification and the VAPID audience). The two disagree on some
// strings: `https://10.0.3.7;.push.apple.com/x` is the host
// `10.0.3.7;.push.apple.com` to WHATWG (it ends in an allowed suffix) and
// `10.0.3.7` to url.parse — so the check passed and the request went to an
// address the member chose. pushEndpointAllowed therefore now accepts only
// a string BOTH parsers must read the same way:
//   * printable ASCII only (no space, control or non-ASCII character, which
//     either parser may strip or re-encode);
//   * the raw text, lower-cased, is exactly `https://` + host + `/` or `?` —
//     no user-info, no port (not even :443), no percent-encoded or
//     backslashed host;
//   * the host is plain letters, digits and hyphens in dot-separated labels
//     (LDH), and is a push service's host;
//   * the WHATWG parse and the legacy parse both give that same host, with
//     no port and no user-info.
// And, defence in depth at the send itself, the sender hands web-push
// pushServiceAgent(): its connections go only to a push service's host
// (whatever any parser said), and only to a public address (the DNS answer
// is checked: no loopback, private, link-local, CGNAT, multicast or
// reserved address).
//
// The hosts are the push services the browsers this app supports use:
// Chrome / Chromium browsers (FCM), Firefox (Mozilla autopush), Edge on
// Windows (WNS) and Safari / iOS Home Screen apps (Apple). A browser that
// pushes through another service is refused at the opt-in with the
// "not a browser push subscription" answer, never silently stored.
//
// Imports Node built-ins (node:url, node:https, node:dns, node:net), so it
// is never imported by a browser module — components/settings/PushOptIn.tsx
// takes PUSH_KEYS_MISMATCH from lib/notify/dispatch.ts (a test pins that no
// client module imports this file).

import { parse as legacyUrlParse } from "node:url";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import type { Duplex } from "node:stream";

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
 *  added), the sender reads no more than the newest PUSH_DEVICE_CAP per
 *  person, and the maintenance cron (step 7c) removes the rest. */
export const PUSH_DEVICE_CAP = 10;

/** A registration's created_at later than this past the reader's clock was
 *  not stamped by /api/push/subscribe (it writes the server's "now"): the
 *  sender ignores it and the maintenance cron removes it (fix pass 2 — a
 *  hand-written row dated in the future would otherwise stay "newest"). The
 *  margin covers clock skew between server instances. */
export const PUSH_FUTURE_SKEW_MS = 5 * 60_000;

/** A host made only of letters, digits and hyphens, in two or more
 *  dot-separated labels (lower case). Nothing either URL parser could read
 *  as a delimiter, an escape or an address literal. */
const LDH_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** Printable ASCII, no space. */
const PRINTABLE = /^[\x21-\x7e]+$/;

/** Whether `host` (already lower case) is a push service's host. */
export function pushHostAllowed(host: unknown): boolean {
  if (typeof host !== "string" || !LDH_HOST.test(host)) return false;
  if (PUSH_SERVICE_HOSTS.includes(host)) return true;
  return PUSH_SERVICE_HOST_SUFFIXES.some((s) => host.length > s.length && host.endsWith(s));
}

/** Whether the server may ever POST a push to `v`: an https URL on a push
 *  service's host (PUSH_SERVICE_HOSTS / PUSH_SERVICE_HOST_SUFFIXES), with no
 *  port and no user-info, of sane length — written so that the WHATWG URL
 *  parser and Node's legacy url.parse (the one web-push connects by) can
 *  only read the same host from it (see the header). */
export function pushEndpointAllowed(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > PUSH_ENDPOINT_MAX_LENGTH) return false;
  if (!PRINTABLE.test(v)) return false;
  const lower = v.toLowerCase();
  if (!lower.startsWith("https://")) return false;
  const rest = lower.slice("https://".length);
  const end = rest.search(/[/?]/);
  if (end <= 0) return false; // no path or query after the host, or no host
  const host = rest.slice(0, end);
  if (!pushHostAllowed(host)) return false;
  // the WHATWG parser reads that same host, no port, no user-info …
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.hostname !== host || u.port !== "" || u.username !== "" || u.password !== "") return false;
  // … and so does the legacy parser web-push connects by
  let legacy: ReturnType<typeof legacyUrlParse>;
  try {
    legacy = legacyUrlParse(v);
  } catch {
    return false;
  }
  return legacy.protocol === "https:" && legacy.hostname === host && legacy.port === null && legacy.auth === null;
}

// ── Defence in depth: the agent every push request goes through ─────────────

// Two lists, one per family: a BlockList holding an IPv6 rule such as
// ::ffff:0:0/96 also matches every IPv4 address checked against it (Node
// compares an IPv4 address as its IPv4-mapped IPv6 form).
const NON_PUBLIC = (() => {
  const ipv4 = new net.BlockList();
  const ipv6 = new net.BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  const v6: Array<[string, number]> = [
    ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
    ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ];
  for (const [a, p] of v4) ipv4.addSubnet(a, p, "ipv4");
  for (const [a, p] of v6) ipv6.addSubnet(a, p, "ipv6");
  return { ipv4, ipv6 };
})();

/** Whether a resolved address is a public unicast address a push service may
 *  have: not loopback, private, link-local, CGNAT, multicast, documentation,
 *  IPv4-mapped / translated or otherwise reserved. Not an IP at all: false. */
export function pushAddressPublic(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !NON_PUBLIC.ipv4.check(address, "ipv4");
  if (family === 6) return !NON_PUBLIC.ipv6.check(address, "ipv6");
  return false;
}

const refused = (message: string, code: string) => Object.assign(new Error(message), { code });

/** net's `lookup`, refusing an answer that holds any non-public address. */
export const pushPublicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) { callback(err, ""); return; }
    const list = (addresses as unknown as dns.LookupAddress[]) ?? [];
    if (list.length === 0 || list.some((a) => !pushAddressPublic(a.address))) {
      callback(refused("[push] a push service's host resolved to a non-public address — not connected", "EPUSHADDRESS"), "");
      return;
    }
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

/** An https.Agent that connects only to a push service's host
 *  (pushHostAllowed — checked on the host the request was actually
 *  addressed to, whatever parser produced it; an IP literal never passes),
 *  and only to a public address (pushPublicLookup). */
export class PushServiceAgent extends https.Agent {
  constructor() {
    super({ keepAlive: true, lookup: pushPublicLookup });
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const host = typeof options.host === "string" ? options.host.toLowerCase() : "";
    if (!pushHostAllowed(host) || (options.port != null && Number(options.port) !== 443)) {
      const err = refused("[push] refused a connection to a host that is not a browser push service's — not sent", "EPUSHHOST");
      if (callback) { callback(err, undefined as unknown as Duplex); return undefined; }
      throw err;
    }
    return super.createConnection({ ...options, lookup: pushPublicLookup }, callback);
  }
}

let agentMemo: PushServiceAgent | null = null;
/** The one PushServiceAgent the sender passes web-push (`agent`). */
export function pushServiceAgent(): PushServiceAgent {
  agentMemo ??= new PushServiceAgent();
  return agentMemo;
}
