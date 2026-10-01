// lib/verifyRateLimit.ts
//
// The door of the four unauthenticated verify endpoints (/api/verify,
// /api/verify-package, /api/verify-hold, /api/verify-ticket) — public-surfaces
// VFY-12 (volume) and VFY-13 / OFF-1 (no cached verdicts).
//
//   * A per-IP hourly cap in the house pattern (signup_attempts,
//     app/api/auth/signup/route.ts; intake_attempts, lib/intakeRateLimit.ts):
//     serverless functions share no memory, so the window lives in a table —
//     `verify_scans` (migration 20261134), which is ALSO the scan record
//     (lib/verifyScanLog.ts). One row per answered scan; the cap counts the
//     caller's rows in the last hour.
//   * GENEROUS on purpose. The traffic this protects is a crew scanning a
//     work pack — many phones behind ONE plant NAT address, every sheet of a
//     pack, re-checked before each shift — not a script. The default is
//     1200 scans per IP per hour (one every three seconds, sustained);
//     VERIFY_MAX_PER_IP_HOUR overrides it without a code change.
//   * FAILS OPEN. A field scan must answer: the verdict is the safety signal,
//     the cap is volume protection. A limiter read that errors (the table not
//     yet created because 20261134 is unapplied, a transient fault) never
//     turns a scan away. An unknown client IP is never limited either — one
//     shared "unknown" bucket would lock every scanner out at once.
//   * A refused scan writes NO row, so one address can add at most the cap
//     to the table per hour (the writes the log costs are bounded by the
//     cap, never by an attacker's request rate).
//   * Every answer carries Cache-Control: no-store (verifyJson): a revision
//     verdict must never be replayed by an intermediary or a browser cache.
//
// Server-only: the client is passed in (each route's service-role client).

import { NextResponse } from "next/server";
import { clientIp } from "@/lib/intakeRateLimit";

export { clientIp };

/** Default per-IP hourly cap (VFY-12: sized for real field use). */
export const DEFAULT_VERIFY_MAX_PER_IP_HOUR = 1200;

/** Retry hint on a 429 — the window slides, so the oldest of the caller's
 *  rows ages out continuously; five minutes is a fair "come back later". */
export const VERIFY_RETRY_AFTER_SEC = 300;

export function verifyMaxPerIpHour(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.VERIFY_MAX_PER_IP_HOUR);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_VERIFY_MAX_PER_IP_HOUR;
}

/** Any client with `.from()` (a route's service-role client). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VerifyClient = { from: (table: string) => any };

export type VerifyRateVerdict =
  | { limited: false }
  | { limited: true; retryAfterSec: number; message: string };

const HOUR_MS = 3600_000;

/** Over the per-IP hourly window? Fails OPEN on any error and for an unknown
 *  IP. Counts the caller's answered scans in `verify_scans`. */
export async function checkVerifyRate(
  client: VerifyClient,
  input: { ip: string; maxPerHour?: number; now?: number },
): Promise<VerifyRateVerdict> {
  if (!input.ip || input.ip === "unknown") return { limited: false };
  const max = input.maxPerHour ?? verifyMaxPerIpHour();
  try {
    const since = new Date((input.now ?? Date.now()) - HOUR_MS).toISOString();
    const { count, error } = await client.from("verify_scans")
      .select("id", { count: "exact", head: true })
      .eq("ip", input.ip)
      .gte("created_at", since);
    if (error) return { limited: false };
    if (typeof count === "number" && count >= max) {
      return {
        limited: true,
        retryAfterSec: VERIFY_RETRY_AFTER_SEC,
        message: "Too many verification requests from this network. Wait a few minutes and scan again — until then, treat the paper as unverified and check with Document Control before working from it.",
      };
    }
    return { limited: false };
  } catch {
    return { limited: false };
  }
}

/** The no-store header every verify answer carries (VFY-13; OFF-1 dw3). */
export const VERIFY_NO_STORE = "no-store";

/** NextResponse.json with Cache-Control: no-store — the ONLY way a verify
 *  route answers, so no intermediary or browser cache can replay a revision
 *  verdict, an error included. */
export function verifyJson(body: unknown, status = 200, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": VERIFY_NO_STORE, ...(headers ?? {}) } });
}

/** The 429 a capped scan gets — no-store, with the retry hint. */
export function verifyRateLimitedResponse(v: Extract<VerifyRateVerdict, { limited: true }>): NextResponse {
  return verifyJson({ error: v.message }, 429, { "Retry-After": String(v.retryAfterSec) });
}
