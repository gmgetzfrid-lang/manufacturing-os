// lib/holdGate.ts
//
// HLD-1 — THE one hold gate. A hold is a stop-work signal on a document, and
// until Round F it was a hard block only on the "advance" transitions
// (publish / revert / supersede, through evaluatePublishGuard and the
// database's publish guard). Every other path that puts a held drawing in
// front of a person — a transmittal, a distribution acknowledgment, a share
// link, a revision-label correction, a renumber, a disposal — proceeded
// without ever reading document_holds.
//
// This module is what those paths call. One read, one decision, one refusal
// shape, so a hold means the same thing at every door:
//
//   * `assertNotOnHold(documentId, { client?, action? })` — throws
//     HoldBlockedError (code "on_hold") when the document has an active hold,
//     naming the holds. Server and client callable: it takes any client with
//     a `.from()` (a route's service-role client, the shared browser client by
//     default).
//   * FAILS CLOSED. A hold read that errors is treated as a hold — the same
//     stance /verify-hold takes ("treat the hold as ACTIVE until Document
//     Control confirms otherwise") and the PKG-4 pack gate takes. A guard that
//     fails open on a transient error is not a guard.
//   * `decideHoldGate` is the pure decision, exported for tests and for
//     callers that would rather stamp a HOLD banner than refuse (the download
//     and doc-pack limbs): they read once with `readActiveHolds` and branch on
//     the decision.
//
// It deliberately does NOT import lib/holds.ts (which pulls lib/audit and the
// notify layer) — this file must be importable from a route handler, a cron
// scan and a client component alike, with no side-effect surface.
//
// No override parameter. The publish path's controller force (canForceHold,
// lib/documentGuards.ts) is a separate, deliberate rail with its own
// audit; a door that wants an override adds it there, not by widening this.

import { supabase } from "@/lib/supabase";

/** Any client with a `.from()` — the shared browser client, or the one a
 *  route handler / cron built with the service role. */
export type HoldGateClient = Pick<typeof supabase, "from">;

export interface ActiveHoldSummary {
  id: string;
  reason: string;
  openedAt: string | null;
  openedByName: string | null;
}

export type HoldGateRead =
  | { readable: true; holds: ActiveHoldSummary[] }
  | { readable: false; error: string };

export type HoldGateDecision =
  | { blocked: false; holds: ActiveHoldSummary[] }
  | { blocked: true; holds: ActiveHoldSummary[]; unreadable: boolean; message: string };

/** Every active (unreleased) hold on the document, or the read error. Never
 *  throws — the decision layer decides what an error means. */
export async function readActiveHolds(documentId: string, client?: HoldGateClient): Promise<HoldGateRead> {
  try {
    const { data, error } = await (client ?? supabase)
      .from("document_holds")
      .select("id, reason, opened_at, opened_by_name")
      .eq("document_id", documentId)
      .is("released_at", null);
    if (error) return { readable: false, error: error.message || "hold read failed" };
    const rows = (data as Array<Record<string, unknown>> | null) ?? [];
    return {
      readable: true,
      holds: rows.map((r) => ({
        id: String(r.id),
        reason: String(r.reason ?? ""),
        openedAt: (r.opened_at as string | null) ?? null,
        openedByName: (r.opened_by_name as string | null) ?? null,
      })),
    };
  } catch (e) {
    return { readable: false, error: (e as Error)?.message || "hold read threw" };
  }
}

/** The refusal sentence, one shape everywhere. `action` names what was being
 *  attempted ("sending a transmittal") so the message says what to do. */
export function holdRefusalMessage(holds: ActiveHoldSummary[], action?: string): string {
  const reasons = holds.map((h) => h.reason).filter(Boolean).join(", ");
  const plural = holds.length > 1 ? "holds" : "hold";
  const what = action ? ` before ${action}` : "";
  return `Document has an active ${plural}${reasons ? ` (${reasons})` : ""}; release the ${plural}${what}.`;
}

/** Pure: a read → block or pass. An unreadable hold set BLOCKS. */
export function decideHoldGate(read: HoldGateRead, action?: string): HoldGateDecision {
  if (!read.readable) {
    return {
      blocked: true,
      holds: [],
      unreadable: true,
      message: `Couldn't confirm this document is free of holds (${read.error}); it is treated as held${action ? ` — retry ${action} once the hold state can be read` : ""}.`,
    };
  }
  if (read.holds.length === 0) return { blocked: false, holds: [] };
  return { blocked: true, holds: read.holds, unreadable: false, message: holdRefusalMessage(read.holds, action) };
}

export class HoldBlockedError extends Error {
  readonly code = "on_hold" as const;
  readonly holds: ActiveHoldSummary[];
  /** True when the refusal is fail-closed on a read error, not a known hold. */
  readonly unreadable: boolean;
  constructor(decision: Extract<HoldGateDecision, { blocked: true }>) {
    super(decision.message);
    this.name = "HoldBlockedError";
    this.holds = decision.holds;
    this.unreadable = decision.unreadable;
  }
}

export function isHoldBlockedError(e: unknown): e is HoldBlockedError {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "on_hold";
}

/** Refuse when the document is under an active hold (or its hold state cannot
 *  be read). Resolves to the empty decision otherwise. */
export async function assertNotOnHold(
  documentId: string,
  opts?: { client?: HoldGateClient; action?: string },
): Promise<void> {
  const decision = decideHoldGate(await readActiveHolds(documentId, opts?.client), opts?.action);
  if (decision.blocked) throw new HoldBlockedError(decision);
}
