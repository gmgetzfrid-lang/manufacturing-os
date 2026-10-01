// lib/orchestrator/proposals.ts — SERVER-ONLY. What the assistant proposed,
// kept where the browser cannot rewrite it (ORCH-4 / PR-1).
//
// A write the model proposes used to live only in the HTTP response. The
// confirm button posted the tool and its parameters back, and the execute
// route fingerprinted whatever arrived and approved it — so any member could
// run any write tool with any parameters, a rejected proposal stayed
// runnable forever, and one approval ran as many times as it was posted.
//
// Now, at the end of a run, every proposal that executes server-side (a
// handoff `href` never does) is stored here: who it was proposed to, in
// which org, the exact tool and parameters, its fingerprint, and a 15-minute
// expiry. /api/orchestrator/execute takes the proposal's id and runs the
// STORED action, once — for the person it was proposed to, in that org,
// before it expires. Anything else is refused with a 409 that says why.
//
// orchestrator_proposals (20261147) is RLS-on with no policies and no grants
// to anon / authenticated: only this service-role code reads or writes it.
// The permanent record is audit_logs: AI_ACTION_ATTEMPTED before a stored
// action runs, then AI_ACTION_EXECUTED (it completed) or AI_ACTION_FAILED
// (it was refused or failed). A proposal row is pruned once it is a week
// past its expiry — by the daily maintenance cron and on every store, so at
// the next of those after that week, not to the minute.

import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { PendingAction } from "@/lib/orchestrator/tools";

/** How long a proposal can be confirmed (plan default, DEC-44 (I-04)). */
export const PROPOSAL_TTL_MS = 15 * 60_000;
/** How long after expiry a proposal row is kept before the prune drops it
 *  (it goes at the next prune after that: the maintenance cron, or a store). */
export const PROPOSAL_KEEP_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60_000;
export const PROPOSALS_MIGRATION = "20261147_intel_roundG_orchestrator_proposals.sql";

/** A pending action as the client receives it: the tool's proposal plus the
 *  id of its stored row (or why it cannot be confirmed). */
export interface StoredPendingAction extends PendingAction {
  /** Present when the proposal was stored and can be confirmed. */
  proposalId?: string;
  /** When the stored proposal stops being confirmable (ISO). */
  expiresAt?: string;
  /** Set when an executable proposal could NOT be stored — it cannot be
   *  confirmed, and this says why. */
  unavailable?: string;
}

export interface StoredProposal {
  id: string;
  run_id: string;
  org_id: string;
  user_id: string;
  fingerprint: string;
  tool: string;
  parameters: Record<string, unknown>;
  summary: string | null;
  created_at: string;
  expires_at: string;
  executed_at: string | null;
  dismissed_at: string | null;
}

type DbError = { code?: string; message?: string } | null | undefined;

const isMissingTable = (e: DbError) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist|could not find the table/i.test(e.message ?? ""));

/** A proposal id is its row's UUID. Anything else names no proposal: it is
 *  refused as unknown (409) before the database is asked, where a non-UUID
 *  would raise 22P02 and read as "try again". */
export const PROPOSAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_INSTALLED =
  `Confirming an assistant action needs migration ${PROPOSALS_MIGRATION} — ask an admin to run it. Nothing was done.`;

/** The refusals, worded for the person holding the card. One wording for
 *  "no such proposal" and "someone else's proposal": the difference is not
 *  theirs to learn. */
export const REFUSAL = {
  unknown:
    "This confirmation doesn't match a proposal the assistant made for you in this workspace. Ask the assistant again. Nothing was done.",
  legacy:
    "This confirmation came from an assistant page opened before an update. Reload the page and ask again. Nothing was done.",
  expired:
    "This proposal has expired (they last 15 minutes). Ask the assistant again for a fresh one. Nothing was done.",
  executed:
    "This proposal has already been run. Each confirmation runs once. Nothing was done this time.",
  dismissed:
    "You dismissed this proposal, so it can't be run. Ask the assistant again if you want it. Nothing was done.",
} as const;

export type ProposalRefusal = {
  ok: false; status: 409 | 503; error: string;
  reason: "unknown" | "expired" | "executed" | "dismissed" | "unavailable";
};

/**
 * Store the run's executable proposals for this user and org. Handoff
 * actions (`href`) are returned unchanged: they never execute server-side.
 * When the store fails, the executable proposals come back marked
 * `unavailable` — never confirmable without a stored row (fail closed).
 */
export async function storeProposals(
  orgId: string, userId: string, runId: string, pending: readonly PendingAction[], now: number = Date.now(),
): Promise<StoredPendingAction[]> {
  const executable = pending.filter((p) => !p.href);
  if (executable.length === 0) return pending.map((p) => ({ ...p }));
  const expiresAt = new Date(now + PROPOSAL_TTL_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("orchestrator_proposals")
    .insert(executable.map((p) => ({
      // The id is minted here (the column's default is the same kind of
      // value), so the card's id is a UUID whichever side assigns it.
      id: randomUUID(),
      run_id: runId, org_id: orgId, user_id: userId,
      fingerprint: p.fingerprint, tool: p.tool,
      parameters: p.parameters, summary: p.summary,
      expires_at: expiresAt,
    })))
    .select("id, fingerprint, expires_at");
  const stored = new Map<string, { id: string; expires_at: string }>();
  if (!error) {
    for (const r of (data ?? []) as Array<{ id: string; fingerprint: string; expires_at: string }>) {
      stored.set(r.fingerprint, { id: r.id, expires_at: r.expires_at });
    }
  }
  const why = isMissingTable(error)
    ? NOT_INSTALLED
    : "This proposal could not be saved, so it can't be confirmed. Ask the assistant again.";
  // Best effort, never in the way of the answer: rows a week past expiry go.
  await pruneOrchestratorProposals(now).catch(() => undefined);
  return pending.map((p) => {
    if (p.href) return { ...p };
    const row = stored.get(p.fingerprint);
    return row ? { ...p, proposalId: row.id, expiresAt: row.expires_at } : { ...p, unavailable: why };
  });
}

/** Read one stored proposal for this caller, refusing what may not run. */
async function readForCaller(
  orgId: string, userId: string, proposalId: string, fingerprint: string | null, now: number,
): Promise<{ ok: true; proposal: StoredProposal } | ProposalRefusal> {
  if (!PROPOSAL_ID_RE.test(proposalId)) return { ok: false, status: 409, error: REFUSAL.unknown, reason: "unknown" };
  const { data, error } = await supabaseAdmin
    .from("orchestrator_proposals")
    .select("id, run_id, org_id, user_id, fingerprint, tool, parameters, summary, created_at, expires_at, executed_at, dismissed_at")
    .eq("id", proposalId)
    .maybeSingle();
  if (error) {
    return isMissingTable(error)
      ? { ok: false, status: 503, error: NOT_INSTALLED, reason: "unavailable" }
      : { ok: false, status: 503, error: "The proposal could not be checked right now. Try again. Nothing was done.", reason: "unavailable" };
  }
  const p = data as StoredProposal | null;
  if (!p || p.org_id !== orgId || p.user_id !== userId) return { ok: false, status: 409, error: REFUSAL.unknown, reason: "unknown" };
  // A card holding a different fingerprint than the stored row is not this
  // proposal (a tampered or confused client): refuse rather than guess.
  if (fingerprint !== null && fingerprint !== p.fingerprint) return { ok: false, status: 409, error: REFUSAL.unknown, reason: "unknown" };
  if (p.dismissed_at) return { ok: false, status: 409, error: REFUSAL.dismissed, reason: "dismissed" };
  if (p.executed_at) return { ok: false, status: 409, error: REFUSAL.executed, reason: "executed" };
  if (Date.parse(p.expires_at) <= now) return { ok: false, status: 409, error: REFUSAL.expired, reason: "expired" };
  return { ok: true, proposal: p };
}

/**
 * Claim a stored proposal for execution — at most once. The claim is a
 * conditional update (not yet executed, not dismissed, not expired, this
 * user and org), so two confirmations racing each other cannot both win.
 * Returns the proposal and the claim stamp (`releaseProposal` needs it).
 */
export async function claimProposal(
  orgId: string, userId: string, proposalId: string, fingerprint: string | null, now: number = Date.now(),
): Promise<{ ok: true; proposal: StoredProposal; claimedAt: string } | ProposalRefusal> {
  const read = await readForCaller(orgId, userId, proposalId, fingerprint, now);
  if (!read.ok) return read;
  const claimedAt = new Date(now).toISOString();
  const { data, error } = await supabaseAdmin
    .from("orchestrator_proposals")
    .update({ executed_at: claimedAt })
    .eq("id", proposalId).eq("org_id", orgId).eq("user_id", userId)
    .is("executed_at", null).is("dismissed_at", null)
    .gt("expires_at", claimedAt)
    .select("id");
  if (error) return { ok: false, status: 503, error: "The proposal could not be claimed right now. Try again. Nothing was done.", reason: "unavailable" };
  if (!data || (data as unknown[]).length === 0) {
    // Lost a race, or it changed since the read: say what it is now.
    const again = await readForCaller(orgId, userId, proposalId, fingerprint, now);
    return again.ok ? { ok: false, status: 409, error: REFUSAL.executed, reason: "executed" } : again;
  }
  return { ok: true, proposal: read.proposal, claimedAt };
}

/** Give a claim back after the action did NOT run (refused or failed), so
 *  the person can try again before it expires. Only the claim this request
 *  made is released. Returns whether the row was released. */
export async function releaseProposal(proposalId: string, claimedAt: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("orchestrator_proposals")
    .update({ executed_at: null })
    .eq("id", proposalId).eq("executed_at", claimedAt)
    .select("id");
  return !error && !!data && (data as unknown[]).length > 0;
}

/** Mark a proposal dismissed: it can never be run afterwards (ORCH-4). */
export async function dismissProposal(
  orgId: string, userId: string, proposalId: string, now: number = Date.now(),
): Promise<{ ok: true } | ProposalRefusal> {
  const read = await readForCaller(orgId, userId, proposalId, null, now);
  // An expired proposal can still be dismissed — it is already dead, and the
  // card should say so either way.
  if (!read.ok && read.reason !== "expired") return read;
  const { data, error } = await supabaseAdmin
    .from("orchestrator_proposals")
    .update({ dismissed_at: new Date(now).toISOString() })
    .eq("id", proposalId).eq("org_id", orgId).eq("user_id", userId)
    .is("executed_at", null).is("dismissed_at", null)
    .select("id");
  if (error) return { ok: false, status: 503, error: "The proposal could not be dismissed right now. Try again.", reason: "unavailable" };
  if (!data || (data as unknown[]).length === 0) {
    const again = await readForCaller(orgId, userId, proposalId, null, now);
    return again.ok ? { ok: false, status: 409, error: REFUSAL.executed, reason: "executed" } : again;
  }
  return { ok: true };
}

/** Drop proposal rows a week past their expiry. The maintenance cron runs
 *  it daily (its knowledge block — no cron entry of its own), and the store
 *  path runs it too, so an org that stops proposing still has its expired
 *  messages and findings removed. Returns the number of rows removed: 0
 *  before 20261147 (no table, nothing to prune); any other failure THROWS,
 *  so the cron reports it (the store path ignores it). */
export async function pruneOrchestratorProposals(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - PROPOSAL_KEEP_AFTER_EXPIRY_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("orchestrator_proposals")
    .delete()
    .lt("expires_at", cutoff)
    .select("id");
  if (error) {
    if (isMissingTable(error)) return 0;
    throw new Error(`orchestrator_proposals prune failed: ${error.message ?? "unknown error"}`);
  }
  return ((data ?? []) as unknown[]).length;
}
