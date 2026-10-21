// lib/resendWebhook.ts
//
// drafting-flow EVID-9 done-when 1 (notifications Round G, N18 DELIVERY
// RECORD; DEC-90 — fail-safe): the email provider's delivery report, read
// only when it is signed.
//
// Resend signs each webhook delivery the Standard Webhooks way (Svix): three
// headers — svix-id, svix-timestamp, svix-signature (or the webhook-*
// spellings) — and a signature that is base64(HMAC-SHA256(secret,
// "<id>.<timestamp>.<raw body>")), where the secret is the endpoint's signing
// secret ("whsec_<base64>") from the provider's dashboard, held in
// RESEND_WEBHOOK_SECRET. A report is believed only when one of the listed
// "v1,<signature>" values matches (compared in constant time) and its
// timestamp is within five minutes of now (a replayed old delivery is
// refused). Nothing here touches the database; the route
// (app/api/webhooks/resend/route.ts) does, through record_email_delivery
// (20261258).
//
// Server-only (node:crypto).

import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a delivery's timestamp may be from now (seconds), either way. */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
/** The largest body the route reads (a delivery report is a few hundred bytes). */
export const RESEND_WEBHOOK_MAX_BYTES = 256 * 1024;

/** What the provider can report about a sent email, as the row records it. */
export type DeliveryOutcome = "delayed" | "delivered" | "failed" | "bounced" | "complained";

/** The provider's event types that are a delivery outcome. Every other type
 *  (email.sent, email.opened, email.clicked, email.scheduled, …) is
 *  acknowledged and ignored: "sent" is already the drain's own fact, and
 *  opens and clicks are not delivery. */
export const OUTCOME_BY_EVENT: Readonly<Record<string, DeliveryOutcome>> = {
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
};

export function outcomeOf(type: unknown): DeliveryOutcome | null {
  return typeof type === "string" && Object.hasOwn(OUTCOME_BY_EVENT, type) ? OUTCOME_BY_EVENT[type] : null;
}

/** The signing key a "whsec_<base64>" secret holds (null when it holds none). */
function signingKey(secret: string): Buffer | null {
  const raw = secret.trim().replace(/^whsec_/, "");
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/** Whether `body` is a delivery the holder of `secret` signed, within the
 *  tolerance. Never throws. */
export function verifyWebhookSignature(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs?: number;
}): SignatureVerdict {
  const key = signingKey(input.secret);
  if (!key) return { ok: false, reason: "no signing key" };
  if (!input.id || !input.timestamp || !input.signature) return { ok: false, reason: "the signature headers are missing" };
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "the timestamp is not a number" };
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - Number(input.timestamp)) > RESEND_WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "the timestamp is outside the tolerance" };
  const expected = createHmac("sha256", key).update(`${input.id}.${input.timestamp}.${input.body}`).digest();
  for (const part of input.signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") continue;
    let given: Buffer;
    try {
      given = Buffer.from(part.slice(comma + 1), "base64");
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "no signature matches" };
}

/** One delivery report, as the row records it. */
export interface DeliveryReport {
  type: string;
  outcome: DeliveryOutcome;
  /** The provider's id for the email (the drain's provider_message_id). */
  providerMessageId: string;
  /** When the provider says it happened (ISO), or null (the database uses now). */
  at: string | null;
  /** The provider's words (a bounce's reason), at most 500 characters. */
  detail: string | null;
}

export type ParsedReport =
  | { kind: "outcome"; report: DeliveryReport }
  | { kind: "ignored"; type: string }
  | { kind: "invalid"; reason: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The provider's words for an outcome, from the event's own detail object. */
function detailOf(outcome: DeliveryOutcome, data: Record<string, unknown>): string | null {
  const obj = (k: string): Record<string, unknown> =>
    (data[k] && typeof data[k] === "object" ? data[k] : {}) as Record<string, unknown>;
  let text: string | null = null;
  if (outcome === "bounced") {
    const b = obj("bounce");
    const kind = [str(b.type), str(b.subType)].filter(Boolean).join(" / ");
    text = [kind || null, str(b.message)].filter(Boolean).join(": ") || null;
  } else if (outcome === "failed") {
    text = str(obj("failed").reason);
  } else if (outcome === "delayed") {
    text = str(obj("delivery_delayed").message) ?? str(obj("delay").message);
  }
  return text ? text.slice(0, 500) : null;
}

/** Read a verified body: an outcome to record, an event to ignore, or not a
 *  delivery report at all. Never throws. */
export function parseDeliveryReport(json: unknown): ParsedReport {
  if (!json || typeof json !== "object") return { kind: "invalid", reason: "not an event" };
  const ev = json as Record<string, unknown>;
  const type = str(ev.type);
  if (!type) return { kind: "invalid", reason: "the event names no type" };
  const outcome = outcomeOf(type);
  if (!outcome) return { kind: "ignored", type };
  const data = (ev.data && typeof ev.data === "object" ? ev.data : null) as Record<string, unknown> | null;
  const id = data ? str(data.email_id) : null;
  if (!data || !id) return { kind: "invalid", reason: "the event names no email" };
  const when = str(ev.created_at);
  const at = when && Number.isFinite(Date.parse(when)) ? new Date(Date.parse(when)).toISOString() : null;
  return { kind: "outcome", report: { type, outcome, providerMessageId: id.slice(0, 200), at, detail: detailOf(outcome, data) } };
}

/** How long the drain waits for the send's answer body before it records
 *  the email 'sent' without the provider's id (a stalled body must never
 *  leave the row 'sending' for the 15-minute reclaim to mail it again). */
export const PROVIDER_ID_READ_TIMEOUT_MS = 2000;

/** The provider's message id in a send's answer (`{ "id": "…" }`), or null.
 *  Never throws, never hangs (null after `timeoutMs`) and never fails the
 *  send: the drain records the email as sent either way. */
export async function providerMessageIdOf(resp: unknown, timeoutMs: number = PROVIDER_ID_READ_TIMEOUT_MS): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = resp as { text?: () => Promise<string> };
    if (!r || typeof r.text !== "function") return null;
    const raw = await Promise.race([
      r.text(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!raw) return null;
    const id = (JSON.parse(raw) as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.trim() && id.length <= 200 ? id.trim() : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
