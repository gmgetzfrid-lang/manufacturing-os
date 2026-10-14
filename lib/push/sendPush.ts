// lib/push/sendPush.ts
//
// SERVER-ONLY. The Web Push sender (notifications Round G, N10 PUSH —
// GAP-205; OS-2, OS-9, OS-10, TAX-12, DELIV-14, RT-7). The receiver was
// always built (public/sw.js's push / notificationclick block), the storage
// too (push_subscriptions, 20260804, own-row RLS) and the preference
// (notification_preferences.push_enabled, 20260723). This is the middle.
//
// The contract (DEC-90, the integrator's rulings for N10 — fail-safe):
//   * sendPushSafe NEVER throws and never delays or fails the in-app or
//     email legs: emit() calls the push leg only after both have finished
//     (lib/notify/dispatch.ts), and a push failure is logged only. The
//     deleted 0bb13ed seam had the same contract.
//   * Push is OFF without VAPID keys (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
//     VAPID_SUBJECT, .env.example) — it logs once and does nothing, so every
//     deployment that works today works the same.
//   * Only the push-worthy kinds (KIND_META.pushWorthy — the small set: a
//     force-released checkout, a hold, an acknowledgment or sign-off asked of
//     you, a mention or an assignment on a request). Everything else stays
//     bell / email only.
//   * Only to a person who turned this channel on for a DEVICE — a
//     push_subscriptions row exists only because they clicked "Turn on
//     notifications for this device" (components/settings/PushOptIn.tsx) —
//     and whose notification_preferences.push_enabled is not false. The
//     column's DEFAULT TRUE alone sends nothing (OS-10 done-when 1).
//     push_enabled = false stops delivery and leaves the device registered.
//   * Push follows a bell row: a person is pushed only when a bell row of
//     this kind about this resource landed for them in the last
//     PUSH_EVIDENCE_WINDOW_MS (for a browser's request, a row that browser's
//     member wrote — 20261160 stamps every browser row with its writer). A
//     follower the discover check could not settle got the REDACTED notice
//     (metadata.redacted — lib/notify/dispatch.ts redactedNotice); that row
//     never earns a push (DEC-106 item 2).
//   * The body names nothing: the kind's generic title (PUSH_TITLES) and
//     "open the app" — never a document number, a title, a hold reason or a
//     requester's name. A lock screen in a control room is a public surface
//     (GAP-205 "Do not"; NEDGE-6). The detail is behind the click, and the
//     page shows it only to someone allowed to read it.
//   * A 404 / 410 from the push service means the subscription is gone:
//     its row is deleted (OS-2 done-when 4). Anything else is logged.
//   * A device is pushed once per bell row: last_reminded_at holds the
//     created_at of the newest bell row it was pushed for, so a replayed
//     request — or two tabs asking about the same row — sends nothing more.
//   * A browser's request is capped per writer: past PUSH_WRITER_CAP push-
//     worthy rows from one member to one person in PUSH_WRITER_WINDOW_MS,
//     the bell keeps them and no more pushes go (the 20261160 caps bound the
//     rows themselves).
//
// Push is best-effort by design and is never a delivery record (GAP-205;
// drafting-flow GAP-113): nothing reads a push to decide anything.
//
// Loading this module registers it as emit()'s server sender
// (__registerServerPushSender), the way lib/documentDiscoverers.ts registers
// the discover check: lib/notify/dispatch.ts is bundled for the browser and
// never imports web-push or the service role. The browser asks
// POST /api/push/notify, which calls sendPushSafe here. The maintenance cron
// does not load it: the cron only prunes (app/api/cron/maintenance/route.ts
// step 4e), so its scan reminders stay bell / email.

import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { checkedWrite, isMissingSchemaError } from "@/lib/checkedWrite";
import { NOTIFICATION_KINDS, kindMeta, type ClassifiedKind } from "@/lib/notificationKinds";
import { __registerServerPushSender, PUSH_REQUEST_MAX_RECIPIENTS, type PushSendInput } from "@/lib/notify/dispatch";

/** The push-worthy kinds, in registry order (KIND_META.pushWorthy). */
export const PUSH_KINDS: readonly ClassifiedKind[] = Object.freeze(
  NOTIFICATION_KINDS.filter((k) => kindMeta(k)?.pushWorthy === true),
);

/** The only words a push carries: one generic title per push-worthy kind.
 *  No document number, title, reason or name — ever. A test pins one per
 *  PUSH_KINDS entry and pins that none interpolates anything. */
export const PUSH_TITLES: Readonly<Partial<Record<ClassifiedKind, string>>> = Object.freeze({
  checkout_force_released: "Your checkout was released by someone else",
  hold_opened: "A document hold needs your attention",
  ack_requested: "You're asked to acknowledge a document",
  review_requested: "You're asked to sign off a document",
  ticket_mention: "You were mentioned on a request",
  ticket_assigned: "A request was assigned to you",
});
export const PUSH_FALLBACK_TITLE = "New notification";
export const PUSH_BODY = "Open the app to see the details.";

/** A bell row this recent earns its push (the browser asks right after it
 *  writes the row; the margin covers clock skew between the server and the
 *  database). */
export const PUSH_EVIDENCE_WINDOW_MS = 2 * 60_000;
/** One member may cause one person at most PUSH_WRITER_CAP pushes in
 *  PUSH_WRITER_WINDOW_MS; past it the bell keeps the rows and no push goes. */
export const PUSH_WRITER_WINDOW_MS = 10 * 60_000;
export const PUSH_WRITER_CAP = 5;
/** How long one push-service request may take before it is abandoned. */
export const PUSH_SEND_TIMEOUT_MS = 5000;
/** A push the device does not collect within the hour is dropped by the
 *  push service: an interruption that late is noise (the bell has it). */
export const PUSH_TTL_SECONDS = 3600;
/** The most recipients one request is about (POST /api/push/notify; the
 *  browser leg sends a larger audience in parts — lib/notify/dispatch.ts). */
export const PUSH_MAX_RECIPIENTS = PUSH_REQUEST_MAX_RECIPIENTS;
/** uids per `in.(…)` read (a long list is a long URL; the DIST-15 chunking). */
const CHUNK = 150;

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const loggedOnce = new Set<string>();
function logOnce(key: string, message: string): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  console.warn(message);
}
/** Tests only: forget which one-time messages were logged. */
export function __resetPushLogOnceForTests(): void {
  loggedOnce.clear();
  configMemo = null;
}

let configMemo: { key: string; config: PushConfig | null } | null = null;

/** The VAPID keys, or null when the push channel is off: any of the three is
 *  unset, or the keys / subject do not validate (web-push's own checks — the
 *  reason is logged once, never the key). */
export function pushConfig(env: Record<string, string | undefined> = process.env): PushConfig | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (env.VAPID_SUBJECT ?? "").trim();
  const key = `${publicKey}\u0000${privateKey}\u0000${subject}`;
  if (configMemo && configMemo.key === key) return configMemo.config;
  let config: PushConfig | null = null;
  if (!publicKey || !privateKey || !subject) {
    logOnce("unconfigured", "[push] VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are not all set — the push channel is off (bell and email are unaffected)");
  } else {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      config = { publicKey, privateKey, subject };
    } catch (e) {
      logOnce("invalid", `[push] the VAPID configuration does not validate (${(e as Error)?.message ?? "invalid"}) — the push channel is off (bell and email are unaffected)`);
    }
  }
  configMemo = { key, config };
  return config;
}

/** A same-origin path for the click to open: a bell row's link when it is a
 *  root-relative path (20261160 keeps a browser row's link inside the app),
 *  else the app's root. Never an absolute or protocol-relative URL. */
export function safePushUrl(link: unknown): string {
  if (typeof link !== "string") return "/";
  const s = link.trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || s.length > 2048) return "/";
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) < 0x20) return "/";
  return s;
}

/** What the service worker reads (public/sw.js: data.title, data.body,
 *  data.url, data.tag). The tag groups pushes about one thing, so a second
 *  push about the same resource replaces the first on the device. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export function pushPayloadFor(kind: string, row: { id: string; link?: string | null; resource_id?: string | null }): PushPayload {
  return {
    title: PUSH_TITLES[kind as ClassifiedKind] ?? PUSH_FALLBACK_TITLE,
    body: PUSH_BODY,
    url: safePushUrl(row.link),
    tag: `mfgos-${kind}-${row.resource_id || row.id}`,
  };
}

/** What one send did — for the route's log and the tests; never returned to
 *  a browser. */
export interface PushOutcome {
  /** why nothing was attempted, when nothing was */
  skipped?: "unconfigured" | "kind" | "no-recipients" | "unreadable" | "no-table";
  /** recipients with a qualifying bell row, push on and under the cap */
  eligible: number;
  /** device sends attempted */
  attempted: number;
  sent: number;
  /** subscriptions deleted after a 404 / 410 */
  pruned: number;
  /** recipients over the per-writer cap */
  capped: number;
}

const none = (skipped?: PushOutcome["skipped"]): PushOutcome => ({ skipped, eligible: 0, attempted: 0, sent: 0, pruned: 0, capped: 0 });

type BellRow = { id: string; user_id: string; kind: string; resource_id: string | null; link: string | null; created_at: string; metadata: Record<string, unknown> | null };
type DeviceRow = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; last_reminded_at: string | null };

const chunks = <T,>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

/** Send the push for one emit (see the header). NEVER throws. */
export async function sendPushSafe(input: PushSendInput): Promise<PushOutcome> {
  try {
    return await sendPush(input);
  } catch (e) {
    console.warn(`[push] the ${input?.kind} push was not sent: ${(e as Error)?.message ?? e} (bell and email are unaffected)`);
    return none("unreadable");
  }
}

async function sendPush(input: PushSendInput): Promise<PushOutcome> {
  const config = pushConfig();
  if (!config) return none("unconfigured");
  if (kindMeta(input.kind)?.pushWorthy !== true) return none("kind");
  const recipients = Array.from(new Set((input.recipients ?? []).filter((u): u is string => typeof u === "string" && u !== "")));
  if (!input.orgId || !input.resourceId || recipients.length === 0) return none("no-recipients");

  const now = Date.now();
  const evidenceSince = now - PUSH_EVIDENCE_WINDOW_MS;
  const windowSince = new Date(now - Math.max(PUSH_WRITER_WINDOW_MS, PUSH_EVIDENCE_WINDOW_MS)).toISOString();
  const writer = input.writerUid ?? null;

  // 1) The bell rows: which recipients got a row of this kind about this
  //    resource just now (and, for a browser's request, from that member).
  const rowsByUser = new Map<string, BellRow[]>();
  for (const part of chunks(recipients)) {
    let q = supabaseAdmin
      .from("notifications")
      .select("id, user_id, kind, resource_id, link, created_at, metadata")
      .eq("org_id", input.orgId)
      .in("user_id", part)
      .in("kind", [...PUSH_KINDS])
      .gte("created_at", windowSince);
    if (writer) q = q.eq("actor_user_id", writer);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(2000);
    if (error) {
      console.warn(`[push] the bell rows could not be read (${error.message}) — the ${input.kind} push was not sent`);
      return none("unreadable");
    }
    for (const r of (data as BellRow[] | null) ?? []) rowsByUser.set(r.user_id, [...(rowsByUser.get(r.user_id) ?? []), r]);
  }
  const evidence = new Map<string, BellRow>();
  let capped = 0;
  for (const uid of recipients) {
    const rows = rowsByUser.get(uid) ?? [];
    const row = rows.find((r) => r.kind === input.kind
      && r.resource_id === input.resourceId
      && Date.parse(r.created_at) >= evidenceSince
      && (r.metadata as { redacted?: unknown } | null)?.redacted !== true);
    if (!row) continue;
    if (writer) {
      const fromWriter = rows.filter((r) => Date.parse(r.created_at) >= now - PUSH_WRITER_WINDOW_MS).length;
      if (fromWriter > PUSH_WRITER_CAP) { capped += 1; continue; }
    }
    evidence.set(uid, row);
  }
  if (capped > 0) console.warn(`[push] ${capped} recipient(s) over the per-writer push cap (${PUSH_WRITER_CAP} per ${PUSH_WRITER_WINDOW_MS / 60_000} min) — the bell has the rows, no push sent`);
  if (evidence.size === 0) return { ...none(), capped };

  // 2) push_enabled — an unreadable preference sends nothing (fail closed:
  //    someone who turned the channel off must not be pushed because their
  //    row could not be read). No row = the column default (on); the device
  //    row below is still required.
  const off = new Set<string>();
  for (const part of chunks([...evidence.keys()])) {
    const { data, error } = await supabaseAdmin
      .from("notification_preferences")
      .select("user_id, push_enabled")
      .in("user_id", part);
    if (error) {
      console.warn(`[push] push preferences could not be read (${error.message}) — the ${input.kind} push was not sent`);
      return { ...none("unreadable"), capped };
    }
    for (const p of (data as Array<{ user_id: string; push_enabled: boolean | null }> | null) ?? []) {
      if (p.push_enabled === false) off.add(p.user_id);
    }
  }
  const eligible = [...evidence.keys()].filter((u) => !off.has(u));
  if (eligible.length === 0) return { ...none(), capped };

  // 3) The devices each eligible person turned on.
  const devices: DeviceRow[] = [];
  for (const part of chunks(eligible)) {
    const { data, error } = await supabaseAdmin
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth, last_reminded_at")
      .in("user_id", part);
    if (error) {
      if (isMissingSchemaError(error)) {
        logOnce("no-table", "[push] push_subscriptions does not exist (20260804_push_subscriptions.sql not applied) — no device can be pushed");
        return { ...none("no-table"), eligible: eligible.length, capped };
      }
      console.warn(`[push] device registrations could not be read (${error.message}) — the ${input.kind} push was not sent`);
      return { ...none("unreadable"), eligible: eligible.length, capped };
    }
    devices.push(...((data as DeviceRow[] | null) ?? []));
  }

  // 4) Send — once per device per bell row (last_reminded_at), in parallel.
  const outcome: PushOutcome = { eligible: eligible.length, attempted: 0, sent: 0, pruned: 0, capped };
  const vapidDetails = { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey };
  await Promise.allSettled(devices.map(async (d) => {
    const row = evidence.get(d.user_id);
    if (!row) return;
    if (d.last_reminded_at && Date.parse(d.last_reminded_at) >= Date.parse(row.created_at)) return;
    outcome.attempted += 1;
    const subscription: WebPushSubscription = { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(pushPayloadFor(input.kind, row)), {
        vapidDetails, TTL: PUSH_TTL_SECONDS, urgency: "high", timeout: PUSH_SEND_TIMEOUT_MS,
      });
      outcome.sent += 1;
      const w = await checkedWrite(supabaseAdmin
        .from("push_subscriptions")
        .update({ last_reminded_at: row.created_at })
        .eq("id", d.id)
        .select("id"));
      // refused: the device was removed meanwhile — nothing to keep
      if (!w.ok && w.code === "db") console.warn(`[push] a device's last push could not be recorded (${w.error}) — a repeat request may push it again`);
    } catch (e) {
      const status = (e as { statusCode?: unknown })?.statusCode;
      if (status === 404 || status === 410) {
        // the subscription is gone (unsubscribed, expired, the browser reset)
        const del = await checkedWrite(supabaseAdmin.from("push_subscriptions").delete().eq("id", d.id).select("id"));
        if (del.ok) outcome.pruned += 1;
        else if (del.code === "db") console.warn(`[push] a dead subscription (${status}) could not be removed: ${del.error}`);
        return;
      }
      console.warn(`[push] a device push failed (${typeof status === "number" ? status : (e as Error)?.message ?? "error"}) — kept; bell and email are unaffected`);
    }
  }));
  return outcome;
}

// emit()'s server sender (lib/notify/dispatch.ts): a server entry that loads
// this module pushes from its own emits. Bounded there, never awaited
// beyond PUSH_LEG_TIMEOUT_MS.
__registerServerPushSender(async (input) => { await sendPushSafe(input); });
