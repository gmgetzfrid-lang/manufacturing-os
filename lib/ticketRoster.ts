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
import { slotBlocks, rosterLacksIndependentSignOff, type SlotSignPlan } from "@/lib/workflow";
import type { RoutingControl, RoutingLevel, RoutingSlot } from "@/lib/routingControl";
import { slotLabel } from "@/lib/routingControl";
import { windowConfigOf } from "@/lib/consentWindow";
import type { TicketAttachment, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

// ─── Content binding (EVID-12) ──────────────────────────────────────────────

/** Bytes above this are not hashed in a request (the approval records why). */
export const HASH_MAX_BYTES = 200 * 1024 * 1024;

/**
 * The bounds every in-request hash runs under (DF-P5 fix pass: a storage read
 * must never hold a request open without limit). ONE overall deadline and ONE
 * byte budget per request, shared by every file hashed in it:
 *   * legacy — today's approvals and the Final's issue (EVID-12, best effort):
 *     whatever is not hashed within the deadline / budget is recorded as
 *     "not hashed (deadline)" / "not hashed (byte budget)" and the approval
 *     lands anyway — hashing never blocks or meaningfully slows it;
 *   * roster — the files a routed review binds its sign-offs to (fail
 *     closed: a deadline is transient, the submission is refused with
 *     "try again", nothing written).
 * Mutable only so tests can shorten the clock; nothing else writes it.
 */
export const HASH_LIMITS = {
  legacyDeadlineMs: 3_000,
  legacyByteBudget: 64 * 1024 * 1024,
  legacyMaxFiles: 10,
  rosterDeadlineMs: 8_000,
  rosterByteBudget: HASH_MAX_BYTES,
};

export type FileHash =
  | { ok: true; sha256: string; bytes?: number }
  | { ok: false; transient: boolean; reason: string };

/** The minimum of an S3-style GetObject answer the hasher reads. */
interface StoredObject {
  ContentLength?: number;
  Body?: AsyncIterable<Uint8Array> | { transformToByteArray?: () => Promise<Uint8Array> } | null;
}

const TOO_LARGE = "too large to hash in a request";
const BYTE_BUDGET = "not hashed (byte budget)";
const DEADLINE_REASON = "not hashed (deadline)";
const READ_DEADLINE = "not hashed (read exceeded the deadline)";
const DEADLINE: FileHash = { ok: false, transient: true, reason: DEADLINE_REASON };

/**
 * sha256 of one stored object, computed HERE from its bytes (never a store
 * tag such as an ETag). `get(key, signal)` fetches the object (the signal
 * aborts it). A missing object or a key that is not a plain storage key is
 * NOT transient (the record says so); a fetch that failed is transient (the
 * caller refuses rather than records a guess). `maxBytes` caps the bytes
 * read (default HASH_MAX_BYTES).
 */
export async function sha256OfStoredObject(
  key: string | null | undefined,
  get: (key: string, signal?: AbortSignal) => Promise<StoredObject>,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<FileHash> {
  const max = Math.min(opts.maxBytes ?? HASH_MAX_BYTES, HASH_MAX_BYTES);
  if (!key || /^[a-z]+:\/\//i.test(key) || key.includes("..")) return { ok: false, transient: false, reason: "not a storage key" };
  if (opts.signal?.aborted) return DEADLINE;
  let obj: StoredObject;
  try {
    obj = await get(key, opts.signal);
  } catch (e) {
    if (opts.signal?.aborted) return DEADLINE;
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
      return { ok: false, transient: false, reason: "the file is not in storage" };
    }
    return { ok: false, transient: true, reason: "storage could not be read" };
  }
  if (typeof obj.ContentLength === "number" && obj.ContentLength > max) {
    return { ok: false, transient: false, reason: TOO_LARGE };
  }
  const h = createHash("sha256");
  let n = 0;
  try {
    const body = obj.Body as unknown;
    if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        if (opts.signal?.aborted) return DEADLINE;
        n += chunk.length;
        if (n > max) return { ok: false, transient: false, reason: TOO_LARGE };
        h.update(chunk);
      }
    } else if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
      const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      if (bytes.length > max) return { ok: false, transient: false, reason: TOO_LARGE };
      n = bytes.length;
      h.update(bytes);
    } else {
      return { ok: false, transient: true, reason: "storage returned no bytes" };
    }
  } catch {
    if (opts.signal?.aborted) return DEADLINE;
    return { ok: false, transient: true, reason: "storage could not be read" };
  }
  return { ok: true, sha256: h.digest("hex"), bytes: n };
}

/**
 * Hash several stored objects under ONE overall deadline and ONE byte budget
 * (HASH_LIMITS). The deadline is enforced by a race, not by trusting the
 * store: a GetObject that never answers is abandoned (and aborted) when the
 * clock runs out, and every key not hashed by then is answered
 * "not hashed (deadline)". A file the remaining budget cannot cover is
 * answered "not hashed (byte budget)". Never throws.
 */
export async function hashStoredFilesBounded(
  keys: ReadonlyArray<string>,
  get: (key: string, signal?: AbortSignal) => Promise<StoredObject>,
  limits: { deadlineMs: number; byteBudget: number },
): Promise<Map<string, FileHash>> {
  const out = new Map<string, FileHash>();
  if (keys.length === 0) return out;
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve("deadline"); }, Math.max(0, limits.deadlineMs));
  });
  let remaining = Math.max(0, limits.byteBudget);
  // Which keys storage ANSWERED (the GetObject resolved): a deadline that
  // lands while such a file's bytes are still streaming is a slow, large
  // read — not a storage that does not answer (DF-P5 fix pass 2).
  const answered = new Set<string>();
  const tracked = async (k: string, signal?: AbortSignal) => {
    const o = await get(k, signal);
    answered.add(k);
    return o;
  };
  try {
    for (const key of keys) {
      if (out.has(key)) continue;
      if (ac.signal.aborted) { out.set(key, DEADLINE); continue; }
      if (remaining <= 0) { out.set(key, { ok: false, transient: false, reason: BYTE_BUDGET }); continue; }
      const r = await Promise.race([sha256OfStoredObject(key, tracked, { maxBytes: remaining, signal: ac.signal }), deadline]);
      if (r === "deadline") {
        out.set(key, answered.has(key) ? { ok: false, transient: false, reason: READ_DEADLINE } : DEADLINE);
        continue;
      }
      if (!r.ok && r.reason === TOO_LARGE && remaining < HASH_MAX_BYTES) {
        out.set(key, { ok: false, transient: false, reason: BYTE_BUDGET });
        continue;
      }
      out.set(key, r);
      if (r.ok) remaining -= r.bytes ?? 0;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
  return out;
}

/** EVID-12 (best effort): the Drafts an approval hashes — the revision being
 *  approved (`rev` = the ticket's deliverable revision; when none carries a
 *  label, the latest submitted Draft), at most HASH_LIMITS.legacyMaxFiles.
 *  Earlier rounds' Drafts are not re-hashed on every approval. */
export function draftsToHashOnApproval(attachments: readonly TicketAttachment[], underReview: string | null | undefined): TicketAttachment[] {
  const submitted = attachments.filter((a) => a?.type === "Draft" && a.status === "submitted");
  return filesUnderReview(submitted, underReview ?? null).slice(0, HASH_LIMITS.legacyMaxFiles);
}

/** The roster's content hash: sha256 over each file's own sha256 and name,
 *  in the order the files are listed. A file the request could not hash for
 *  its size or the time it takes to read (rosterBinding) is bound by its
 *  identity instead — its storage key and recorded size — and the roster
 *  says so on every sign-off. */
export function rosterContentHash(files: ReadonlyArray<{ sha256: string | null; name: string | null; url?: string | null; size?: number | null }>): string {
  return createHash("sha256").update(files.map((f) => `${f.sha256 ?? `unhashed ${f.url ?? ""} ${f.size ?? ""}`}  ${f.name ?? ""}`).join("\n")).digest("hex");
}

/** Reasons a file is too big or too slow to hash inside one request — not
 *  a fault in the file or in storage (DF-P5 fix pass 2). */
const SIZE_OR_TIME_REASONS = new Set([TOO_LARGE, BYTE_BUDGET, READ_DEADLINE]);

export type RosterBinding =
  | { ok: true; files: TicketReviewRoster["files"] }
  | { ok: false; transient: boolean; file: string; reason: string };

/**
 * How a roster binds the files under review (EVID-12; DF-P5 fix pass 2):
 *   * a file hashed here — by its sha256;
 *   * a file too large, over the request's byte budget, or still streaming
 *     at the deadline — by its identity (storage key + recorded size),
 *     marked `unhashed` with the reason; the sign-off statement names it.
 *     So is a file never reached because the clock ran out, PROVIDED storage
 *     answered for some file in this request (storage is up, the request is
 *     simply too slow for the package);
 *   * storage that answered for NO file before the deadline, or failed to
 *     read — transient: refused, "try again" (fail closed: a roster never
 *     opens on a storage outage);
 *   * a file that is not in storage or is not a storage key — refused, with
 *     that reason (it has to be replaced; it cannot be reviewed as it is).
 * Pure.
 */
export function rosterBinding(
  files: readonly TicketAttachment[],
  hashes: ReadonlyMap<string, FileHash>,
): RosterBinding {
  const results = files.map((f) => ({ f, h: (f.url ? hashes.get(f.url) : undefined) ?? ({ ok: false, transient: false, reason: "not a storage key" } as FileHash) }));
  const storageAnswered = results.some(({ h }) => h.ok || SIZE_OR_TIME_REASONS.has(h.reason));
  const out: TicketReviewRoster["files"] = [];
  for (const { f, h } of results) {
    const name = f.name ?? "a file";
    if (h.ok) { out.push({ id: f.id ?? null, name: f.name ?? null, url: f.url ?? null, sha256: h.sha256 }); continue; }
    const sizeOrTime = SIZE_OR_TIME_REASONS.has(h.reason) || (h.reason === DEADLINE_REASON && storageAnswered);
    if (sizeOrTime) {
      out.push({ id: f.id ?? null, name: f.name ?? null, url: f.url ?? null, sha256: null, size: typeof f.size === "number" ? f.size : null, unhashed: h.reason });
      continue;
    }
    return { ok: false, transient: h.transient, file: name, reason: h.reason };
  }
  return { ok: true, files: out };
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

/** The capabilities whose slot IS the ticket's engineering approval (the
 *  seed's engineering slot fills by ticket.final_approve). */
export const ENGINEERING_CAPABILITIES: readonly string[] = ["ticket.final_approve", "ticket.eng_review"];

export type OpenRosterResult =
  | { ok: true; roster: TicketReviewRoster }
  | { ok: false; code: "routing_unfillable"; error: string };

/** The kind the org-wide engineering gate's slot is rostered under when a
 *  routing table does not carry one (never a kind the table already uses). */
export const ENGINEERING_GATE_KIND = "engineering";

/** True when the table already carries the ticket's engineering approval:
 *  a BLOCKING slot filled by an engineering capability (a role-named slot is
 *  the facility's own word and is never guessed to be engineering — DEC-35). */
export function tableCarriesEngineeringGate(control: RoutingControl): boolean {
  return control.slots.some((s) => slotBlocks(s) && !!s.fill.capability && ENGINEERING_CAPABILITIES.includes(s.fill.capability));
}

/**
 * DEC-13 stage 3 / DEC-16 / DEC-36 (DF-P5 fix pass 2): a routing table may
 * ADD reviewers, never drop the org-wide engineering gate. When the gate
 * applies to this ticket (lib/workflow.ts engineerApprovalRequired, or an
 * engineering-first type) and the table has no blocking engineering slot,
 * the seed's engineering slot is appended, independent of the drafter, with
 * the management tier standing in as an override — as on the serial path
 * (lib/workflow.ts PENDING_FINAL_APPROVAL). Fix pass 5: when an engineer is
 * assigned the slot is filled by THAT engineer only (the serial path admits
 * no other engineer); only with none assigned does it fill by
 * `ticket.final_approve`. An assigned engineer who is no longer an active
 * member leaves the slot empty, and openRoster's management fallback stands
 * in — again as on the serial path. Pure. `added` says whether the slot was appended (the roster and
 * the audit row record it).
 */
export function withEngineeringGate(
  control: RoutingControl,
  gate: { required: boolean; assignedEngineerId?: string | null } | null | undefined,
): { control: RoutingControl; added: boolean } {
  if (!gate?.required || tableCarriesEngineeringGate(control)) return { control, added: false };
  const kinds = new Set(control.slots.map((s) => s.kind));
  let kind = ENGINEERING_GATE_KIND;
  for (let i = 2; kinds.has(kind); i++) kind = `${ENGINEERING_GATE_KIND}-${i}`;
  const slot: RoutingSlot = {
    kind,
    label: "Engineering sign-off",
    mode: "blocking",
    fill: gate.assignedEngineerId ? { users: [gate.assignedEngineerId] } : { capability: "ticket.final_approve" },
    independent_of: ["drafter"],
    waivable_by: { capability: "ticket.manage" },
  };
  return { control: { slots: [...control.slots, slot] }, added: true };
}

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
  /** The org-wide engineering gate for THIS ticket (withEngineeringGate). */
  engineeringGate?: { required: boolean; assignedEngineerId?: string | null } | null;
}): OpenRosterResult {
  const { ctx } = input;
  const { control, added: gateAdded } = withEngineeringGate(input.control, input.engineeringGate);
  // The appended gate slot IS the engineering approval even when it names
  // the assigned engineer rather than the capability (fix pass 5).
  const gateKind = gateAdded ? control.slots[control.slots.length - 1].kind : null;
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
      // GAP-109 (DF-P7): a consent slot's window, frozen when the roster opens.
      ...(s.mode === "consent_window" ? windowConfigOf(s) : {}),
      fallback,
      ...((s.fill.capability && ENGINEERING_CAPABILITIES.includes(s.fill.capability)) || s.kind === gateKind ? { engineering: true } : {}),
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
      ...(gateAdded ? { engineeringGateAdded: true } : {}),
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
export function rosterCompletion(
  roster: TicketReviewRoster,
  floor?: { sodActive: boolean; drafterId: string | null | undefined },
): { complete: boolean; unsatisfied: string[] } {
  const rows: SlotRow[] = roster.slots.filter(slotBlocks).map((s) => ({
    slot: "primary",
    activated: false,
    status: s.status === "satisfied" ? "signed" : "pending",
    // GAP-109 (DF-P7): a slot a consent window satisfied carries no
    // signature — its backing is the window's record (open_consent_window's
    // delivered events and the close's audit row), named here so the
    // evaluator counts it; any other satisfied slot still needs its own.
    signatureId: s.status === "satisfied" ? (s.signatureId ?? (s.via === "consent" ? `consent-window:${s.id}` : null)) : null,
    slotGroup: s.kind,
  }));
  const { complete, unsatisfiedGroups } = evaluateSlotCompletion(rows);
  // DEC-12 / DEC-37: above the threshold a review every blocking slot of
  // which the drafter alone satisfied is NOT complete, whatever the table
  // declared — the slots stay as signed and the review waits on a second
  // person (lib/workflow.ts slotSignPlan holds the same floor at signing).
  if (complete && floor?.sodActive && floor.drafterId && rosterLacksIndependentSignOff(roster, floor.drafterId)) {
    return { complete: false, unsatisfied: ["independent of the drafter"] };
  }
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
type RowsThenable = PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>;

/** True when the error means the 20261242 ledger is not there yet (defined
 *  in lib/routingControl.ts, which the request page can load). */
export { isMissingRosterLedger } from "@/lib/routingControl";

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

/** An UPDATE that must touch a row: a 0-row answer (no slot row to update —
 *  e.g. the "opened" insert never landed) is a failure, not a success. */
const onceRows = async (run: () => RowsThenable): Promise<string | null> => {
  const attempt = async () => {
    try {
      const { data, error } = await run();
      if (error) return error.message || "write refused";
      return Array.isArray(data) && data.length > 0 ? null : "no slot row on record to update";
    } catch (e) {
      return (e as Error)?.message ?? String(e);
    }
  };
  return (await attempt()) && (await attempt());
};

/** Write what a transition did to the roster into the ledger: the slots of a
 *  roster just opened, the slots just satisfied, or the slots just voided —
 *  one event row each. Every write is checked and retried once (an update
 *  that matched no slot row counts as a failure); the first failure is
 *  returned (the route reports it), never swallowed — and no event row is
 *  written for a slot whose row could not be updated. */
export async function writeRosterLedger(client: LedgerClient, input: {
  orgId: string;
  ticketId: string;
  roster: TicketReviewRoster;
  event: "opened" | "satisfied" | "voided";
  /** The slots this transition changed (all of them for "opened"). */
  slots: TicketReviewSlot[];
  /** `uid` null: a recorded system act (GAP-109's consent advance — DF-P7). */
  actor: { uid: string | null; name: string | null };
  reason?: string | null;
}): Promise<string | null> {
  const { orgId, ticketId, roster } = input;
  const slotsTable = () => client.from("ticket_review_slots") as {
    insert: (r: unknown) => Thenable;
    update: (r: unknown) => { eq: (k: string, v: unknown) => { eq: (k: string, v: unknown) => { select: (c: string) => RowsThenable } } };
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
      const err = await onceRows(() => slotsTable().update(patch).eq("roster_id", roster.id).eq("slot_kind", s.kind).select("id"));
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
