// lib/verifyScanLog.ts
//
// public-surfaces VFY-12 — every answered scan of a public verify endpoint
// leaves a row, so verification is EVIDENCE ("this print was verified as
// superseded at 07:14 on 12 March and work proceeded anyway" is exactly what
// a PSM incident review asks for) and enumeration is VISIBLE (a walk of a
// register shows up as one address scanning many targets).
//
// The row is minimal and names no person: which endpoint, which target id
// (the document / package / hold / ticket UUID the QR carried — the org is
// derivable from it), the verdict the scanner was shown, the client IP and
// user agent, and the time. `verify_scans` (migration 20261134) is RLS-on
// with NO policies — service role only — and is pruned to 90 days by the
// maintenance cron (prune_verify_scans(); no new vercel.json entry). The same
// rows are the per-IP rate window (lib/verifyRateLimit.ts).
//
// The write is CHECKED but never blocks a scan: a refused insert is logged
// (console.error), the field still gets its answer. The one refusal that is
// the deploy order itself — the table does not exist because 20261134 has
// not been pasted — is logged once per runtime, not once per scan.

import type { VerifyClient } from "@/lib/verifyRateLimit";

export type VerifyEndpoint = "verify" | "verify-package" | "verify-hold" | "verify-ticket";

/** How long a scan row is kept (the user-informed default, 2026-09-17). */
export const VERIFY_SCAN_RETENTION_DAYS = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifyScanInput {
  endpoint: VerifyEndpoint;
  /** The UUID the QR carried; anything that is not a UUID is stored as null
   *  (an invalid code is still a scan — its verdict says "invalid"). */
  targetId: string | null;
  /** The verdict the scanner was shown (or "invalid" / "unknown" / an error class). */
  verdict: string;
  ip: string;
  userAgent: string | null;
}

/** The row as written — bounded lengths, UUID-or-null target. Exported for tests. */
export function verifyScanRow(input: VerifyScanInput): Record<string, unknown> {
  const target = input.targetId && UUID_RE.test(input.targetId) ? input.targetId.toLowerCase() : null;
  return {
    endpoint: input.endpoint,
    target_id: target,
    verdict: String(input.verdict || "unknown").slice(0, 40),
    ip: String(input.ip || "unknown").slice(0, 64),
    user_agent: input.userAgent ? input.userAgent.slice(0, 400) : null,
  };
}

let warnedMissingTable = false;

/** A refusal that means "20261134 is not applied" (the table is absent). */
export function isMissingScanTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /verify_scans/.test(error.message ?? "") && /does not exist|could not find|schema cache/i.test(error.message ?? "");
}

/** Write the scan row. Never throws and never blocks the answer; a refused
 *  write is logged. Returns whether the row landed (for tests). */
export async function recordVerifyScan(client: VerifyClient, input: VerifyScanInput): Promise<boolean> {
  try {
    const { error } = await client.from("verify_scans").insert(verifyScanRow(input));
    if (!error) return true;
    if (isMissingScanTable(error)) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.error("[verify] DEPLOY ORDER: verify_scans does not exist — migration 20261134 is not applied; public verify scans are answered but NOT recorded or rate limited until it is.");
      }
      return false;
    }
    console.error(`[verify] scan record refused (${input.endpoint}): ${error.message ?? "unknown error"}`);
    return false;
  } catch (e) {
    console.error(`[verify] scan record threw (${input.endpoint}): ${(e as Error)?.message ?? String(e)}`);
    return false;
  }
}

/** Test hook: forget the once-per-runtime missing-table warning. */
export function __resetVerifyScanLogWarnings(): void {
  warnedMissingTable = false;
}
