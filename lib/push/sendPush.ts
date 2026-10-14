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
//     push_subscriptions row is written by /api/push/subscribe after they
//     clicked "Turn on notifications for this device"
//     (components/settings/PushOptIn.tsx; the route is the table's only
//     writer once 20261211 is pasted) — and whose notification_preferences.push_enabled is not false. The
//     column's DEFAULT TRUE alone sends nothing (OS-10 done-when 1). A row
//     older than that control (PUSH_OPT_IN_SINCE — the deleted reminders
//     stack's) is never pushed (OS-10 done-when 3).
//     push_enabled = false stops delivery and leaves the device registered.
//   * Push follows a bell row: a person is pushed only when a bell row of
//     this kind about this resource landed for them in the last
//     PUSH_EVIDENCE_WINDOW_MS (for a browser's request, a row naming that
//     browser's member as its actor — 20261160, once pasted, stamps every
//     browser row with its writer), to an active member of the workspace. A
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
//     created_at of the newest bell row it was pushed for, and the device is
//     CLAIMED for a row before the send (a conditional update that lands only
//     while last_reminded_at is older than the row — fix pass), so a replayed
//     request, or two tabs asking about the same row at once, sends once. A
//     send that fails (not 404 / 410) puts the claim back.
//     Fix pass 4: the watermark is never later than the server's clock
//     (pushWatermarkFor). A row dated ahead of it — a database clock ahead of
//     this server's, or, until 20261160 is pasted, a row a browser dated
//     itself — stores created_at − PUSH_FUTURE_SKEW_MS, so it can no longer
//     hold back a push for a row dated after it was pushed. Every row dated
//     at or before the server's clock stores its created_at, as before.
//   * A browser's request is capped per writer: past PUSH_WRITER_CAP push-
//     worthy rows from one member to one person in PUSH_WRITER_WINDOW_MS,
//     the bell keeps them and no more pushes go (the 20261160 caps bound the
//     rows themselves).
//   * Only to a push service (fix pass — the review's blocker): a device row
//     whose endpoint is not on a browser push service's own host
//     (lib/push/endpoints.ts pushEndpointAllowed) is never sent to and is
//     deleted; at most the PUSH_DEVICE_CAP newest devices of a person are
//     read. /api/push/subscribe stores nothing else, and 20261211 drops the
//     own-row INSERT policy, so the route is the only writer. Fix pass 2:
//     the check accepts only an endpoint the WHATWG parser and the legacy
//     url.parse (the one web-push connects by) read the same host from, and
//     every request goes through pushServiceAgent(), which connects only to
//     a push service's host and only to a public address.
//   * One person's registrations never cost another person their push (fix
//     pass 2): a device read that comes back at PostgREST's row limit is
//     read again person by person, PUSH_DEVICE_CAP rows each; a row dated
//     later than now (+ PUSH_FUTURE_SKEW_MS) is not read.
//   * The sender does not lean on 20261160 for what decides a push (fix
//     pass 3). Until that file is pasted, a browser's bell row carries
//     whatever created_at and recipient its writer chose. So a bell row
//     dated later than now (+ PUSH_FUTURE_SKEW_MS) earns nothing (a row
//     dated 2100 would otherwise become the device's watermark and refuse
//     every later push), and only an active member of input.orgId is pushed
//     (org_members, read on the service role; unreadable = nothing sent).
//     Fix pass 4: a row dated inside that margin no longer sets a watermark
//     ahead of the server's clock either (pushWatermarkFor, above).
//
// Push is best-effort by design and is never a delivery record (GAP-205;
// drafting-flow GAP-113): nothing reads a push to decide anything.
//
// Who calls this (fix pass — the review's major 2): POST /api/push/notify
// (the browser half of emit()'s push leg), and a server caller of emit()
// that is allowed to push, by passing `serverPush: pushFromServer` in its
// EmitInput. Loading this module changes nothing else: it registers no
// global sender, so whether a server emit pushes never depends on which
// modules a long-lived process happens to have loaded.
// lib/notify/dispatch.ts is bundled for the browser and never imports
// web-push or the service role. The maintenance cron passes no sender: the
// cron only prunes (app/api/cron/maintenance/route.ts step 7c), so its scan
// reminders (scanStaleHolds' hold_opened among them) stay bell / email.

import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { checkedWrite, isMissingSchemaError } from "@/lib/checkedWrite";
import { NOTIFICATION_KINDS, kindMeta, type ClassifiedKind } from "@/lib/notificationKinds";
import { PUSH_OPT_IN_SINCE, PUSH_REQUEST_MAX_RECIPIENTS, type PushSender, type PushSendInput } from "@/lib/notify/dispatch";
import { PUSH_DEVICE_CAP, PUSH_FUTURE_SKEW_MS, pushEndpointAllowed, pushServiceAgent } from "@/lib/push/endpoints";

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
  // fix pass 4: "review", not "sign off" — true of the change proposed at
  // check-in (components/documents/CheckInPanel.tsx), the only producer
  // that pushes this kind today (the sign-off roster does not yet — OS-14)
  review_requested: "You're asked to review a document",
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
/** uids per device read: PUSH_DEVICE_CAP devices each stay well under
 *  DEVICE_READ_LIMIT (PostgREST's default max-rows), so a read is cut short
 *  only when someone holds more rows than the cap — and then the part is
 *  read again person by person, PUSH_DEVICE_CAP rows each (fix pass 2: one
 *  person's rows must never crowd the others in their part out). */
const DEVICE_CHUNK = 50;
export const DEVICE_READ_LIMIT = 1000;

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
  /** subscriptions deleted: answered 404 / 410, or naming no push service */
  pruned: number;
  /** recipients over the per-writer cap */
  capped: number;
}

const none = (skipped?: PushOutcome["skipped"]): PushOutcome => ({ skipped, eligible: 0, attempted: 0, sent: 0, pruned: 0, capped: 0 });

type BellRow = { id: string; user_id: string; kind: string; resource_id: string | null; link: string | null; created_at: string; metadata: Record<string, unknown> | null };
type DeviceRow = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; last_reminded_at: string | null; created_at: string | null };

const chunks = <T,>(xs: T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

/** The device watermark a push for this bell row stores (fix pass 4 — the
 *  fourth review's minor): never later than the server's clock `now`.
 *   * A row dated at or before `now` — every row the database dated before
 *     this request, so every real row — stores its own created_at, exactly
 *     as before.
 *   * A row dated after `now` (read only inside PUSH_FUTURE_SKEW_MS: a
 *     database clock ahead of this server's, or, until 20261160 is pasted, a
 *     row a browser dated itself) stores created_at − PUSH_FUTURE_SKEW_MS.
 *     That is no later than `now`, so the row cannot hold back a push for a
 *     row dated after it was pushed. It is also the same on every request
 *     made while the row is ahead of the clock, so a replay is still refused
 *     by the claim. (A watermark of `now` itself would not be: each replay
 *     would find the device's watermark older than the row and push again.)
 *     Once the clock passes the row's date its watermark is its created_at,
 *     so a request about it then can push that device once more: at most two
 *     pushes per such row per device. And such a row is not pushed to a
 *     device whose watermark is already at or past created_at −
 *     PUSH_FUTURE_SKEW_MS (pushed in that window for a row dated at or
 *     before the server's clock): the bell keeps it (fail-safe side).
 *  Not a plain timestamp → null (the device is not pushed). */
export function pushWatermarkFor(createdAt: string, now: number): string | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+(Z|[+-][0-9:]+)?$/.test(createdAt)) return null;
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return null;
  return at <= now ? createdAt : new Date(at - PUSH_FUTURE_SKEW_MS).toISOString();
}

/** The claim's condition: the device's last push is older than this row's
 *  watermark (pushWatermarkFor — the row's created_at for every row dated at
 *  or before the server's clock), or it has none. */
function claimCondition(stamp: string): string {
  return `last_reminded_at.is.null,last_reminded_at.lt."${stamp}"`;
}

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
  // Nothing dated later than now (+ the skew margin) is read: not a bell row
  // (fix pass 3), not a device row (fix pass 2).
  const latest = now + PUSH_FUTURE_SKEW_MS;
  const latestIso = new Date(latest).toISOString();
  const writer = input.writerUid ?? null;

  // 1) The bell rows: which recipients got a row of this kind about this
  //    resource just now (and, for a browser's request, from that member).
  //    Fix pass 3: a row dated later than now (+ PUSH_FUTURE_SKEW_MS) earns
  //    nothing. Until 20261160 is pasted a browser sets a row's created_at,
  //    and the device claim stores the row's date as the watermark, so a row
  //    dated 2100 would have every later push to that person refused. (Fix
  //    pass 4: a row inside the margin stores a watermark no later than now —
  //    pushWatermarkFor.)
  const rowsByUser = new Map<string, BellRow[]>();
  for (const part of chunks(recipients)) {
    let q = supabaseAdmin
      .from("notifications")
      .select("id, user_id, kind, resource_id, link, created_at, metadata")
      .eq("org_id", input.orgId)
      .in("user_id", part)
      .in("kind", [...PUSH_KINDS])
      .gte("created_at", windowSince)
      .lte("created_at", latestIso);
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
      && Date.parse(r.created_at) <= latest
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

  // 1b) Only an active member of this workspace is pushed (fix pass 3). The
  //     sender checks it itself: until 20261160 is pasted, a member's browser
  //     can write a bell row naming anyone as its recipient — a person in
  //     another workspace included. An unreadable membership sends nothing
  //     (fail closed).
  const active = new Set<string>();
  for (const part of chunks([...evidence.keys()])) {
    const { data, error } = await supabaseAdmin
      .from("org_members")
      .select("uid")
      .eq("org_id", input.orgId)
      .eq("status", "active")
      .in("uid", part);
    if (error) {
      console.warn(`[push] memberships could not be read (${error.message}) — the ${input.kind} push was not sent`);
      return { ...none("unreadable"), capped };
    }
    for (const m of (data as Array<{ uid: string }> | null) ?? []) active.add(m.uid);
  }
  const outsiders = [...evidence.keys()].filter((u) => !active.has(u));
  for (const u of outsiders) evidence.delete(u);
  if (outsiders.length > 0) console.warn(`[push] ${outsiders.length} recipient(s) not an active member of the workspace — not pushed`);
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

  // 3) The devices each eligible person turned on: the PUSH_DEVICE_CAP newest
  //    per person, and only those on a push service's own host — a row that
  //    names anything else is never sent to, and is deleted (fix pass). A
  //    row dated later than now (+ the skew margin) was not stamped by the
  //    route and is not read (fix pass 2).
  const devices: DeviceRow[] = [];
  const offService: string[] = [];
  let cutShort = false;
  const optInSince = Date.parse(PUSH_OPT_IN_SINCE);
  const readDevices = (uids: string[], limit: number) => {
    const q = supabaseAdmin
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth, last_reminded_at, created_at");
    return (uids.length === 1 ? q.eq("user_id", uids[0]) : q.in("user_id", uids))
      .gte("created_at", PUSH_OPT_IN_SINCE)
      .lte("created_at", latestIso)
      .order("created_at", { ascending: false })
      .limit(limit);
  };
  for (const part of chunks(eligible, DEVICE_CHUNK)) {
    const { data, error } = await readDevices(part, DEVICE_READ_LIMIT);
    if (error) {
      if (isMissingSchemaError(error)) {
        logOnce("no-table", "[push] push_subscriptions does not exist (20260804_push_subscriptions.sql not applied) — no device can be pushed");
        return { ...none("no-table"), eligible: eligible.length, capped };
      }
      console.warn(`[push] device registrations could not be read (${error.message}) — the ${input.kind} push was not sent`);
      return { ...none("unreadable"), eligible: eligible.length, capped };
    }
    let rows = [...((data as DeviceRow[] | null) ?? [])];
    if (rows.length >= DEVICE_READ_LIMIT) {
      // Cut short: someone in this part holds more rows than the cap, and
      // the limit may have left the others' devices out. Read each person
      // again, at most PUSH_DEVICE_CAP rows each — a person whose read fails
      // is not pushed (fail closed), the others still are.
      cutShort = true;
      rows = [];
      for (const uid of part) {
        const one = await readDevices([uid], PUSH_DEVICE_CAP);
        if (one.error) {
          console.warn(`[push] a person's device registrations could not be read (${one.error.message}) — not pushed; bell and email are unaffected`);
          continue;
        }
        rows.push(...((one.data as DeviceRow[] | null) ?? []));
      }
    }
    // newest first, whatever order the read came back in
    rows.sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0));
    const kept = new Map<string, number>();
    for (const d of rows) {
      // the deleted reminders stack's registrations are never pushed, nor a
      // row dated in the future (checked here too, not only by the query)
      const made = d.created_at ? Date.parse(d.created_at) : NaN;
      if (!(made >= optInSince) || !(made <= latest)) continue;
      if (!pushEndpointAllowed(d.endpoint)) { offService.push(d.id); continue; }
      const n = kept.get(d.user_id) ?? 0;
      if (n >= PUSH_DEVICE_CAP) continue;
      kept.set(d.user_id, n + 1);
      devices.push(d);
    }
  }
  if (cutShort) console.warn(`[push] a device read reached ${DEVICE_READ_LIMIT} rows (someone holds more than ${PUSH_DEVICE_CAP} registrations) — that part was read again person by person, ${PUSH_DEVICE_CAP} each`);
  const outcome: PushOutcome = { eligible: eligible.length, attempted: 0, sent: 0, pruned: 0, capped };
  if (offService.length > 0) {
    // never sent to: an endpoint off every push service's host (ids in
    // parts — a long `in.(…)` is a long URL)
    for (const ids of chunks(offService)) {
      const del = await checkedWrite(supabaseAdmin.from("push_subscriptions").delete().in("id", ids).select("id"));
      if (del.ok) outcome.pruned += del.ids.length;
      else if (del.code === "db") console.warn(`[push] ${ids.length} registration(s) naming no push service could not be removed: ${del.error}`);
    }
    console.warn(`[push] ${offService.length} registration(s) naming no push service were not sent to`);
  }

  // 4) Send — once per device per bell row, in parallel. The device is
  //    claimed for the row first (a conditional update that lands only while
  //    its last push is older than the row), so two requests at once send
  //    once; the second finds the claim taken and sends nothing. Fix pass 4:
  //    what the claim compares and stores is the row's watermark
  //    (pushWatermarkFor) — its created_at for every row dated at or before
  //    `now`, and never later than `now` for a row dated after it.
  const vapidDetails = { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey };
  // every request goes through the push-service agent (fix pass 2): it
  // connects only to a push service's host, and only to a public address
  const agent = pushServiceAgent();
  await Promise.allSettled(devices.map(async (d) => {
    const row = evidence.get(d.user_id);
    if (!row) return;
    const stamp = pushWatermarkFor(row.created_at, now);
    if (!stamp) return;
    if (d.last_reminded_at && Date.parse(d.last_reminded_at) >= Date.parse(stamp)) return;
    const claim = await checkedWrite(supabaseAdmin
      .from("push_subscriptions")
      .update({ last_reminded_at: stamp })
      .eq("id", d.id)
      .or(claimCondition(stamp))
      .select("id"));
    if (!claim.ok) {
      // refused: another request claimed this device for this row (or a
      // newer one), or the device was removed meanwhile — nothing to send
      if (claim.code === "db") console.warn(`[push] a device could not be claimed (${claim.error}) — not pushed; bell and email are unaffected`);
      return;
    }
    outcome.attempted += 1;
    const subscription: WebPushSubscription = { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(pushPayloadFor(input.kind, row)), {
        vapidDetails, TTL: PUSH_TTL_SECONDS, urgency: "high", timeout: PUSH_SEND_TIMEOUT_MS, agent,
      });
      outcome.sent += 1;
    } catch (e) {
      const status = (e as { statusCode?: unknown })?.statusCode;
      if (status === 404 || status === 410) {
        // the subscription is gone (unsubscribed, expired, the browser reset)
        const del = await checkedWrite(supabaseAdmin.from("push_subscriptions").delete().eq("id", d.id).select("id"));
        if (del.ok) outcome.pruned += 1;
        else if (del.code === "db") console.warn(`[push] a dead subscription (${status}) could not be removed: ${del.error}`);
        return;
      }
      // put the claim back (only if it is still this row's — the watermark
      // this claim stored), so a later request about this row may try again
      const back = await checkedWrite(supabaseAdmin
        .from("push_subscriptions")
        .update({ last_reminded_at: d.last_reminded_at })
        .eq("id", d.id)
        .eq("last_reminded_at", stamp)
        .select("id"));
      if (!back.ok && back.code === "db") console.warn(`[push] a failed push's claim could not be put back (${back.error})`);
      console.warn(`[push] a device push failed (${typeof status === "number" ? status : (e as Error)?.message ?? "error"}) — kept; bell and email are unaffected`);
    }
  }));
  return outcome;
}

/** emit()'s server push leg, for a SERVER caller that is allowed to push:
 *  `emit({ …, serverPush: pushFromServer })` (lib/notify/dispatch.ts calls
 *  it after the bell and email legs, bounded by PUSH_LEG_TIMEOUT_MS). A
 *  server emit without it pushes nothing. Never throws. */
export const pushFromServer: PushSender = async (input) => { await sendPushSafe(input); };
