// lib/ticketRoster.ts
//
// drafting-flow Round G, DF-P5 ROSTER — GAP-103: the parallel reviewer roster
// on the ticket. "Do not design it": the document side already has the
// mechanics (lib/reviewControl.ts), and this module CALLS them —
// `evaluateSlotCompletion` (DC P4's per-slot completion, RG-4 / DRLS-6)
// decides whether every blocking slot is satisfied; nothing here re-implements
// it. What is ticket-specific:
//
//   * opening — the effective routing table (lib/routingControl.ts) is turned
//     into slots whose occupants are resolved from the org's active members
//     (keyset-paged: lib/ticketPickerMembers.ts) — roles by the capability
//     token rule, named people, a capability under the org's policy and the
//     ticket's resource (DEC-13), or the requester's identity. A blocking slot
//     that resolves to nobody is filled by the management tier instead,
//     marked `fallback` (a stop never resolves to nobody — GAP-112);
//   * binding — every sign-off's e-signature is bound to ONE content hash: a
//     sha256 the server computes over the bytes of the files under review
//     (EVID-12), so a signature cannot be replayed onto other bytes;
//   * signing — DEC-37: one person satisfies every slot they can fill, in
//     ONE action with ONE signature, and independence is per slot
//     (lib/workflow.ts slotSignPlan, shared with the engine and the panel);
//   * the ledger — `ticket_review_slots` / `ticket_review_slot_events`
//     (20261242), written by the workflow route as the service role after the
//     ticket's compare-and-set lands; the live roster rides the ticket row
//     (`metadata.review_roster`) so the status and the slots move together.

import { createHash } from "node:crypto";
import { evaluateSlotCompletion, type SlotRow } from "@/lib/reviewControl";
import { policyAllows, heldMatchesTokens, type CapabilityPolicy, type CapabilityResource } from "@/lib/capabilityPolicy";
import { heldRoles } from "@/lib/roleHeld";
import { slotBlocks, type SlotSignPlan } from "@/lib/workflow";
import type { RoutingControl, RoutingLevel, RoutingSlot } from "@/lib/routingControl";
import { slotLabel } from "@/lib/routingControl";
import type { TicketAttachment, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

// ─── Content binding (EVID-12) ──────────────────────────────────────────────

/** Bytes above this are not hashed in a request (the approval records why). */
export const HASH_MAX_BYTES = 200 * 1024 * 1024;

export type FileHash =
  | { ok: true; sha256: string }
  | { ok: false; transient: boolean; reason: string };

/** The minimum of an S3-style GetObject answer the hasher reads. */
interface StoredObject {
  ContentLength?: number;
  Body?: AsyncIterable<Uint8Array> | { transformToByteArray?: () => Promise<Uint8Array> } | null;
}

/**
 * sha256 of one stored object, computed HERE from its bytes (never a store
 * tag such as an ETag). `get(key)` fetches the object. A missing object or a
 * key that is not a plain storage key is NOT transient (the record says so);
 * a fetch that failed is transient (the caller refuses rather than records a
 * guess).
 */
export async function sha256OfStoredObject(key: string | null | undefined, get: (key: string) => Promise<StoredObject>): Promise<FileHash> {
  if (!key || /^[a-z]+:\/\//i.test(key) || key.includes("..")) return { ok: false, transient: false, reason: "not a storage key" };
  let obj: StoredObject;
  try {
    obj = await get(key);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
      return { ok: false, transient: false, reason: "the file is not in storage" };
    }
    return { ok: false, transient: true, reason: "storage could not be read" };
  }
  if (typeof obj.ContentLength === "number" && obj.ContentLength > HASH_MAX_BYTES) {
    return { ok: false, transient: false, reason: "too large to hash in a request" };
  }
  const h = createHash("sha256");
  try {
    const body = obj.Body as unknown;
    if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
      let n = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        n += chunk.length;
        if (n > HASH_MAX_BYTES) return { ok: false, transient: false, reason: "too large to hash in a request" };
        h.update(chunk);
      }
    } else if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
      const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      h.update(bytes);
    } else {
      return { ok: false, transient: true, reason: "storage returned no bytes" };
    }
  } catch {
    return { ok: false, transient: true, reason: "storage could not be read" };
  }
  return { ok: true, sha256: h.digest("hex") };
}

/** The roster's content hash: sha256 over each file's own sha256 and name,
 *  in the order the files are listed. A file with no hash makes the whole
 *  binding impossible — the caller never opens a roster without one. */
export function rosterContentHash(files: ReadonlyArray<{ sha256: string | null; name: string | null }>): string {
  return createHash("sha256").update(files.map((f) => `${f.sha256 ?? ""}  ${f.name ?? ""}`).join("\n")).digest("hex");
}

/** The files a roster reviews: the Drafts carrying the revision under
 *  review; when none carries a label (files from before per-file
 *  revisions), the latest submitted Draft. */
export function filesUnderReview(attachments: readonly TicketAttachment[], cycle: string | null): TicketAttachment[] {
  const drafts = attachments.filter((a) => a?.type === "Draft" && a.status !== "staged");
  const labelled = cycle ? drafts.filter((a) => a.rev === cycle) : [];
  if (labelled.length > 0) return labelled;
  return drafts.length > 0 ? [drafts[drafts.length - 1]] : [];
}

// ─── Opening ────────────────────────────────────────────────────────────────

export interface OccupantContext {
  /** Every ACTIVE member of the org (role / roles / uid / names). */
  members: ReadonlyArray<Record<string, unknown>>;
  policy: CapabilityPolicy | null | undefined;
  resource: CapabilityResource | null;
  requesterId: string | null | undefined;
}

const memberUid = (m: Record<string, unknown>): string => (typeof m.uid === "string" ? m.uid : "");

/** The members a fill names (active members only; de-duplicated, sorted). */
export function resolveFill(fill: { roles?: string[]; users?: string[]; capability?: RoutingSlot["fill"]["capability"]; identity?: "requester" }, ctx: OccupantContext): string[] {
  const out = new Set<string>();
  const active = new Map(ctx.members.map((m) => [memberUid(m), m] as const).filter(([u]) => !!u));
  if (fill.identity === "requester" && ctx.requesterId && active.has(ctx.requesterId)) out.add(ctx.requesterId);
  for (const u of fill.users ?? []) if (active.has(u)) out.add(u);
  if (fill.roles?.length || fill.capability) {
    for (const [uid, m] of active) {
      const held = heldRoles(m as { role?: unknown; roles?: unknown });
      if (held.length === 0) continue;
      if (fill.roles?.length && heldMatchesTokens(fill.roles, held)) out.add(uid);
      if (fill.capability && policyAllows(ctx.policy, fill.capability, held[0], held, uid, ctx.resource)) out.add(uid);
    }
  }
  return [...out].sort();
}

export type OpenRosterResult =
  | { ok: true; roster: TicketReviewRoster }
  | { ok: false; code: "routing_unfillable"; error: string };

/**
 * Turn the effective routing table into the roster a submission opens.
 * Pure (the route hashes the files and reads the members first).
 */
export function openRoster(input: {
  id: string;
  control: RoutingControl;
  level: RoutingLevel;
  cycle: string | null;
  files: TicketReviewRoster["files"];
  ctx: OccupantContext;
  openedBy: string | null;
  now: string;
}): OpenRosterResult {
  const { control, ctx } = input;
  const management = resolveFill({ capability: "ticket.manage" }, ctx);
  const slots: TicketReviewSlot[] = [];
  for (const s of control.slots) {
    let primaries = resolveFill(s.fill, ctx);
    let fallback = false;
    if (primaries.length === 0 && slotBlocks(s)) {
      primaries = management;
      fallback = true;
    }
    if (primaries.length === 0 && slotBlocks(s)) {
      return { ok: false, code: "routing_unfillable", error: `Nobody can fill "${slotLabel(s)}": its routing names no active member, and no one holds the management override to stand in. Ask an Admin to fix the routing table or the roles — the draft was not submitted.` };
    }
    slots.push({
      id: `${input.id}:${s.kind}`,
      kind: s.kind,
      label: slotLabel(s),
      mode: s.mode,
      primaries,
      alternates: s.alternates ? resolveFill(s.alternates, ctx).filter((u) => !primaries.includes(u)) : [],
      overriders: s.waivable_by ? resolveFill(s.waivable_by, ctx).filter((u) => !primaries.includes(u)) : [],
      independentOf: [...(s.independent_of ?? [])],
      timeoutDays: s.timeoutDays ?? null,
      fallback,
      status: slotBlocks(s) ? "open" : "told",
    });
  }
  return {
    ok: true,
    roster: {
      v: 1,
      id: input.id,
      openedAt: input.now,
      openedBy: input.openedBy,
      level: input.level,
      cycle: input.cycle,
      contentHash: rosterContentHash(input.files),
      files: input.files,
      slots,
    },
  };
}

// ─── Signing ────────────────────────────────────────────────────────────────

/** The roster with the plan's slots satisfied by `actor` under one signature. */
export function applySignPlan(
  roster: TicketReviewRoster,
  plan: SlotSignPlan,
  actor: { uid: string; name: string | null },
  signatureId: string,
  now: string,
): TicketReviewRoster {
  const via = new Map(plan.fillable.map((f) => [f.slot.kind, f.via] as const));
  return {
    ...roster,
    slots: roster.slots.map((s) => (s.status === "open" && via.has(s.kind)
      ? { ...s, status: "satisfied" as const, satisfiedBy: actor.uid, satisfiedByName: actor.name, satisfiedAt: now, signatureId, via: via.get(s.kind)! }
      : s)),
  };
}

/**
 * Is every blocking slot satisfied? CALLS lib/reviewControl.ts
 * evaluateSlotCompletion — each blocking slot is one slot group with one
 * required primary row, satisfied by a bound signature (any occupant's: the
 * ticket slot is a pool, the document slot a person; the evaluator's per-slot
 * rule is the same). Notify-only slots require nothing.
 */
export function rosterCompletion(roster: TicketReviewRoster): { complete: boolean; unsatisfied: string[] } {
  const rows: SlotRow[] = roster.slots.filter(slotBlocks).map((s) => ({
    slot: "primary",
    activated: false,
    status: s.status === "satisfied" ? "signed" : "pending",
    signatureId: s.status === "satisfied" ? (s.signatureId ?? null) : null,
    slotGroup: s.kind,
  }));
  const { complete, unsatisfiedGroups } = evaluateSlotCompletion(rows);
  return { complete, unsatisfied: unsatisfiedGroups };
}

/** The e-signature a sign-off carries, as the route reads it (service role). */
export interface SignatureRow {
  id?: unknown; org_id?: unknown; resource_type?: unknown; resource_id?: unknown;
  signer_user_id?: unknown; content_hash?: unknown; intent?: unknown; signed_at?: unknown;
}

/** Why a signature cannot carry this sign-off, or null when it can. */
export function signatureRefusal(row: SignatureRow | null, expect: {
  orgId: string; ticketId: string; signerId: string; roster: TicketReviewRoster;
}): string | null {
  if (!row) return "That signature does not exist in this workspace — sign again.";
  if (row.org_id !== expect.orgId || row.resource_type !== "ticket" || row.resource_id !== expect.ticketId) {
    return "That signature was given on something else — sign this request again.";
  }
  if (row.signer_user_id !== expect.signerId) return "That signature is someone else's.";
  if (row.intent !== "Reviewed" && row.intent !== "Approved") return "A sign-off needs a signature that reviews or approves.";
  if (row.content_hash !== expect.roster.contentHash) {
    return "The files you signed are not the files under review — reload the request and sign again.";
  }
  const signedAt = typeof row.signed_at === "string" ? Date.parse(row.signed_at) : NaN;
  if (!Number.isFinite(signedAt) || signedAt < Date.parse(expect.roster.openedAt)) {
    return "That signature was given before this review opened — sign again.";
  }
  if (expect.roster.slots.some((s) => s.signatureId === row.id)) return "That signature has already been used on this review.";
  return null;
}

// ─── The ledger (20261242) ──────────────────────────────────────────────────

type LedgerClient = { from: (t: string) => unknown };
type Thenable = PromiseLike<{ error: { code?: string; message?: string } | null }>;

/** True when the error means the 20261242 ledger is not there yet. */
export function isMissingRosterLedger(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  const m = (e.message ?? "").toLowerCase();
  return m.includes("ticket_review_slot") && (m.includes("does not exist") || m.includes("could not find") || m.includes("schema cache"));
}

const once = async (run: () => Thenable): Promise<string | null> => {
  const attempt = async () => {
    try {
      const { error } = await run();
      if (!error || error.code === "23505") return null;
      return error.message || "write refused";
    } catch (e) {
      return (e as Error)?.message ?? String(e);
    }
  };
  return (await attempt()) && (await attempt());
};

/** Write what a transition did to the roster into the ledger: the slots of a
 *  roster just opened, the slots just satisfied, or the slots just voided —
 *  one event row each. Every write is checked and retried once; the first
 *  failure is returned (the route reports it), never swallowed. */
export async function writeRosterLedger(client: LedgerClient, input: {
  orgId: string;
  ticketId: string;
  roster: TicketReviewRoster;
  event: "opened" | "satisfied" | "voided";
  /** The slots this transition changed (all of them for "opened"). */
  slots: TicketReviewSlot[];
  actor: { uid: string; name: string | null };
  reason?: string | null;
}): Promise<string | null> {
  const { orgId, ticketId, roster } = input;
  const slotsTable = () => client.from("ticket_review_slots") as {
    insert: (r: unknown) => Thenable;
    update: (r: unknown) => { eq: (k: string, v: unknown) => { eq: (k: string, v: unknown) => Thenable } };
  };
  const eventsTable = () => client.from("ticket_review_slot_events") as { insert: (r: unknown) => Thenable };
  if (input.event === "opened") {
    const err = await once(() => slotsTable().insert(input.slots.map((s) => ({
      org_id: orgId, ticket_id: ticketId, roster_id: roster.id, cycle: roster.cycle,
      slot_kind: s.kind, label: s.label, mode: s.mode, primaries: s.primaries, alternates: s.alternates,
      overriders: s.overriders, independent_of: s.independentOf, timeout_days: s.timeoutDays, fallback: s.fallback,
      status: s.status, content_hash: roster.contentHash, opened_at: roster.openedAt,
    }))));
    if (err) return err;
  } else {
    for (const s of input.slots) {
      const patch = input.event === "satisfied"
        ? { status: "satisfied", satisfied_by: s.satisfiedBy ?? null, satisfied_at: s.satisfiedAt ?? null, satisfied_via: s.via ?? null, signature_id: s.signatureId ?? null }
        : { status: "void", closed_at: roster.closedAt ?? new Date().toISOString(), closed_reason: input.reason ?? roster.closedReason ?? null };
      const err = await once(() => slotsTable().update(patch).eq("roster_id", roster.id).eq("slot_kind", s.kind));
      if (err) return err;
    }
  }
  return once(() => eventsTable().insert(input.slots.map((s) => ({
    org_id: orgId, ticket_id: ticketId, roster_id: roster.id, slot_kind: s.kind,
    event: input.event === "opened" ? (s.mode === "notify_only" ? "told" : "opened") : input.event,
    actor_id: input.actor.uid, actor_name: input.actor.name,
    signature_id: input.event === "satisfied" ? (s.signatureId ?? null) : null,
    content_hash: roster.contentHash,
    details: input.event === "opened"
      ? { primaries: s.primaries.length, alternates: s.alternates.length, fallback: s.fallback, level: roster.level }
      : input.event === "satisfied" ? { via: s.via ?? null } : { reason: input.reason ?? roster.closedReason ?? null },
  }))));
}

/** The members a roster tells when it opens: every slot's occupants. */
export function rosterRecipients(roster: TicketReviewRoster): string[] {
  return [...new Set(roster.slots.flatMap((s) => s.primaries))];
}

/** Display: the label of a Ticket's roster slots that still wait. */
export function waitingSlotLabels(roster: TicketReviewRoster): string[] {
  return roster.slots.filter((s) => s.status === "open" && slotBlocks(s)).map((s) => s.label || s.kind);
}
