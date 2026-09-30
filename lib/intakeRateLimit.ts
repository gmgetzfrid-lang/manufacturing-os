// lib/intakeRateLimit.ts
//
// Throttling for the unauthenticated intake door (projects-tab SEC-8,
// projects-and-cost INTK-8). Serverless functions share no memory, so the
// window lives in a table — `intake_attempts` (20261105), the same shape as
// `signup_attempts` (app/api/auth/signup/route.ts:19-33, the house pattern):
//
//   * a durable per-token and per-IP window (the token is stored HASHED —
//     the attempt log never becomes a second copy of the credential);
//   * FAIL OPEN on a limiter error (GAP-401 acceptance 4): a transient
//     read failure must not lock every contractor out — the per-link cap
//     and the link's expiry still bound the damage;
//   * a 429 whose message the portal renders as-is;
//   * at most one "new submission" notice per link per window, so a burst
//     is one notice, not N (SEC-8 dw2);
//   * a per-link lifetime cap (submissions and bytes) read from the link
//     row (20261104), so one leaked token cannot grow storage without end.
//
// Limits are configurable without a code change (SEC-8 dw3): the
// INTAKE_MAX_PER_TOKEN_HOUR / INTAKE_MAX_PER_IP_HOUR / INTAKE_NOTICE_WINDOW_MIN
// environment variables, and the per-link columns max_submissions /
// max_total_bytes.
//
// Server-only (node:crypto); the client is passed in.

import { createHash } from "node:crypto";

export interface IntakeLimits {
  perTokenPerHour: number;
  perIpPerHour: number;
  noticeWindowMinutes: number;
}

export const DEFAULT_INTAKE_LIMITS: IntakeLimits = { perTokenPerHour: 30, perIpPerHour: 60, noticeWindowMinutes: 15 };

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function intakeLimits(env: Record<string, string | undefined> = process.env): IntakeLimits {
  return {
    perTokenPerHour: positiveInt(env.INTAKE_MAX_PER_TOKEN_HOUR, DEFAULT_INTAKE_LIMITS.perTokenPerHour),
    perIpPerHour: positiveInt(env.INTAKE_MAX_PER_IP_HOUR, DEFAULT_INTAKE_LIMITS.perIpPerHour),
    noticeWindowMinutes: positiveInt(env.INTAKE_NOTICE_WINDOW_MIN, DEFAULT_INTAKE_LIMITS.noticeWindowMinutes),
  };
}

/** SHA-256 hex. The attempt log keys on the token's hash, never the token. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function clientIp(req: { headers: Headers }): string {
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd ? fwd.split(",")[0]?.trim() : "";
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Any client with `.from()` (the route's service-role client). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AttemptClient = { from: (table: string) => any };

export const ATTEMPT_OUTCOME = { attempt: "attempt", notified: "notified" } as const;

export type RateVerdict = { limited: false } | { limited: true; retryAfterSec: number; message: string };

const HOUR_MS = 3600_000;

async function countSince(client: AttemptClient, col: "token_hash" | "ip", value: string, sinceIso: string): Promise<number | null> {
  const { count, error } = await client.from("intake_attempts")
    .select("id", { count: "exact", head: true })
    .eq(col, value).eq("outcome", ATTEMPT_OUTCOME.attempt)
    .gte("created_at", sinceIso);
  if (error) return null;
  return typeof count === "number" ? count : 0;
}

/** Over the per-token or per-IP hourly window? Fails OPEN on any error. */
export async function checkIntakeRate(client: AttemptClient, input: {
  tokenHash: string; ip: string; limits: IntakeLimits; now?: number;
}): Promise<RateVerdict> {
  try {
    const since = new Date((input.now ?? Date.now()) - HOUR_MS).toISOString();
    const perToken = await countSince(client, "token_hash", input.tokenHash, since);
    if (perToken != null && perToken >= input.limits.perTokenPerHour) {
      return { limited: true, retryAfterSec: 3600, message: `Too many uploads on this link in the last hour (limit ${input.limits.perTokenPerHour}). Wait a while and try again — nothing from this attempt was stored.` };
    }
    // An unknown address is not everyone's address — never pool them.
    if (input.ip !== "unknown") {
      const perIp = await countSince(client, "ip", input.ip, since);
      if (perIp != null && perIp >= input.limits.perIpPerHour) {
        return { limited: true, retryAfterSec: 3600, message: `Too many uploads from your network in the last hour (limit ${input.limits.perIpPerHour}). Wait a while and try again — nothing from this attempt was stored.` };
      }
    }
    return { limited: false };
  } catch {
    return { limited: false }; // fail open — the house pattern
  }
}

/** Best-effort: a failed attempt write is logged, never fatal. */
export async function recordIntakeAttempt(client: AttemptClient, input: {
  tokenHash: string; ip: string; outcome: string; linkId?: string | null; bytes?: number | null;
}): Promise<void> {
  try {
    const { error } = await client.from("intake_attempts").insert({
      token_hash: input.tokenHash, ip: input.ip, outcome: input.outcome,
      link_id: input.linkId ?? null, bytes: input.bytes ?? null,
    });
    if (error) console.warn("[intakeRateLimit] attempt write failed (limiter degrades open):", error.message);
  } catch (e) {
    console.warn("[intakeRateLimit] attempt write threw (limiter degrades open):", (e as Error).message);
  }
}

/** Was a submission notice already sent for this link inside the window?
 *  An unreadable log answers false — a notice too many beats a submission
 *  nobody hears about. */
export async function noticeSentRecently(client: AttemptClient, input: {
  tokenHash: string; windowMinutes: number; now?: number;
}): Promise<boolean> {
  try {
    const since = new Date((input.now ?? Date.now()) - input.windowMinutes * 60_000).toISOString();
    const { count, error } = await client.from("intake_attempts")
      .select("id", { count: "exact", head: true })
      .eq("token_hash", input.tokenHash).eq("outcome", ATTEMPT_OUTCOME.notified)
      .gte("created_at", since);
    if (error) return false;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

export interface LinkBudget {
  submissionCount: number;
  maxSubmissions: number;
  bytesReceived: number;
  maxTotalBytes: number;
}

/** The link's lifetime budget, read tolerantly: a database without the
 *  20261104 columns answers null (no cap enforced — the rate window and
 *  the link's expiry still apply). */
export async function readLinkBudget(client: AttemptClient, linkId: string): Promise<LinkBudget | null> {
  try {
    const { data, error } = await client.from("project_intake_links")
      .select("submission_count, max_submissions, bytes_received, max_total_bytes")
      .eq("id", linkId).maybeSingle();
    if (error || !data) return null;
    const r = data as Record<string, unknown>;
    if (r.max_submissions == null || r.max_total_bytes == null) return null;
    return {
      submissionCount: Number(r.submission_count ?? 0),
      maxSubmissions: Number(r.max_submissions),
      bytesReceived: Number(r.bytes_received ?? 0),
      maxTotalBytes: Number(r.max_total_bytes),
    };
  } catch {
    return null;
  }
}

/** Pure: the refusal for a link that has spent its budget, or null. */
export function linkBudgetRefusal(budget: LinkBudget | null, incomingBytes: number | null): string | null {
  if (!budget) return null;
  if (budget.submissionCount >= budget.maxSubmissions) {
    return `This link has reached its limit of ${budget.maxSubmissions} submissions — ask your project contact for a new link.`;
  }
  if (incomingBytes != null && budget.bytesReceived + incomingBytes > budget.maxTotalBytes) {
    return "This link has used its storage allowance — ask your project contact for a new link.";
  }
  return null;
}
