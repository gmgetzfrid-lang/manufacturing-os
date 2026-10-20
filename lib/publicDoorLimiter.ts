// lib/publicDoorLimiter.ts
//
// SERVER-ONLY. The per-IP window the two public, unauthenticated doors on the
// sign-up page share: /api/auth/signup and /api/auth/request-access
// (admin-and-org ORG-8 / BILL-14, Round G P5; the shared bucket itself is
// EGRESS-5 / DEC-19). Both doors leak whether a workspace name exists (signup
// must say a name is taken; request-access used to), so they draw on ONE
// budget per source address: PUBLIC_DOOR_MAX_PER_HOUR attempts in the trailing
// PUBLIC_DOOR_WINDOW_MS, counted from `signup_attempts` (20261010; RLS on, no
// policies — the service role only).
//
// What happens when the count cannot be decided, each branch deliberate and
// pinned by lib/__tests__/aoRoundGP5PublicDoors.test.ts:
//   · no client address (no x-forwarded-for, no x-real-ip): the attempt is
//     counted under the one shared key "unknown", so header-less callers
//     share a single budget. It used to be exempt, which let an unbounded
//     number of attempts through. Next's own server sets x-forwarded-for from
//     the socket (`next start`, and Vercel's edge), so a real browser never
//     lands in this bucket;
//   · the table is not there (42P01 / PGRST205 / 42703 / PGRST204 — 20261010
//     not pasted; MIGRATION-PASTE-ORDER.md row 9 says "unknown"): the door
//     stays open, as it always has, and says so in the log — refusing every
//     signup on a database that never had the table would be a regression;
//   · any other read failure (a denial, an outage, a timeout): the door
//     refuses with 503 and a sentence to try again. A failing count must not
//     become an unlimited door.
//
// Retention: `prune_signup_attempts()` (20261010) keeps two days — the hour
// this window reads plus a short tail an operator can read back when a door
// is being abused. The maintenance cron calls it daily (ORG-12). Rows hold a
// client address and the address typed at the door, so the table is never
// part of the data-portability export (lib/exportTables.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/checkedWrite";

/** Attempts one source address may make across both doors in the window. */
export const PUBLIC_DOOR_MAX_PER_HOUR = 8;
/** The window the count reads: the trailing hour. */
export const PUBLIC_DOOR_WINDOW_MS = 3_600_000;
/** The key a request with no client address is counted under. */
export const UNKNOWN_CLIENT_IP = "unknown";

/** The caller's address: the first x-forwarded-for entry, else x-real-ip,
 *  else the shared "unknown" key. */
export function publicDoorClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || UNKNOWN_CLIENT_IP;
}

export type PublicDoorVerdict =
  | { allowed: true; unchecked?: "table-missing" }
  | { allowed: false; status: 429 | 503; error: string };

/** The sentence a door answers when the window is spent. */
export function tooManyAttemptsMessage(what: "signup attempts" | "access requests"): string {
  return `Too many ${what} from this network. Please wait a while and try again.`;
}

/** ORG-8: the ONE answer /api/auth/request-access gives whether or not the
 *  workspace exists, and whether or not a request is already waiting. It
 *  names no workspace (the door used to echo the registered casing). */
export const REQUEST_ACCESS_ACKNOWLEDGEMENT =
  "Thanks — if a workspace by that name uses this service, its administrators have been told about your request, and you'll get an email when they answer. If you don't hear back, check the workspace's exact name with your administrator.";

/** The sentence a door answers when the count could not be read. */
export const PUBLIC_DOOR_UNCHECKED_MESSAGE =
  "We couldn't check this network's recent attempts, so nothing was submitted. Please try again in a minute.";

/** Decide whether `ip` may make another attempt. Never throws. */
export async function publicDoorVerdict(
  sb: SupabaseClient,
  ip: string,
  what: "signup attempts" | "access requests",
): Promise<PublicDoorVerdict> {
  const since = new Date(Date.now() - PUBLIC_DOOR_WINDOW_MS).toISOString();
  let count: number | null = null;
  let error: { message: string; code?: string | null } | null = null;
  try {
    const res = await sb
      .from("signup_attempts")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip || UNKNOWN_CLIENT_IP)
      .gte("created_at", since);
    count = (res as { count?: number | null }).count ?? null;
    error = (res as { error?: { message: string; code?: string | null } | null }).error ?? null;
  } catch (e) {
    error = { message: (e as Error)?.message || "the attempt count could not be read" };
  }
  if (error) {
    if (isMissingSchemaError(error)) {
      console.warn(`[public-door] signup_attempts is not there (${error.code ?? "no code"}: ${error.message}) — the per-IP window is not enforced until 20261010 is pasted`);
      return { allowed: true, unchecked: "table-missing" };
    }
    console.warn(`[public-door] the per-IP attempt count could not be read (${error.message}) — refusing rather than letting the door run unlimited`);
    return { allowed: false, status: 503, error: PUBLIC_DOOR_UNCHECKED_MESSAGE };
  }
  if ((count ?? 0) >= PUBLIC_DOOR_MAX_PER_HOUR) {
    return { allowed: false, status: 429, error: tooManyAttemptsMessage(what) };
  }
  return { allowed: true };
}

/** Record one attempt against `ip`'s window. Checked: a refused write is
 *  logged (the window then undercounts by one), never thrown and never
 *  blocking the door's answer. Answers whether the row landed. */
export async function recordPublicDoorAttempt(
  sb: SupabaseClient,
  ip: string,
  email: string | null,
  outcome: string,
): Promise<boolean> {
  try {
    const { error } = await sb.from("signup_attempts").insert({ ip: ip || UNKNOWN_CLIENT_IP, email, outcome });
    if (error) {
      if (!isMissingSchemaError(error)) console.warn(`[public-door] the attempt was not recorded (${error.message})`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[public-door] the attempt was not recorded (${(e as Error)?.message})`);
    return false;
  }
}
