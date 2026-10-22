// lib/ticketPreauthorization.ts
//
// drafting-flow Round G, DF-P22 — GAP-109 mechanism 2: STANDING
// PRE-AUTHORIZATION. A named person records their own revocable, scoped
// pre-consent to their sign-off; a request in scope whose review slot the
// workspace opted in has that slot satisfied by it, recorded on the
// request's history and on an audit row naming the pre-authorization.
//
// DEC-90 ruling (2) for DF-P22 (industry best practice, fail-safe, no
// regression):
//   * WHO: the person themselves records it (never someone on their behalf),
//     with an e-signature minted by /api/signatures/sign for the record's own
//     id, as the like-in-kind declaration's is (intent "Acknowledged", the
//     statement below — byte for byte). They, or an Admin, may revoke it at
//     any time, effective immediately (the next request no longer uses it;
//     the requests that already did keep naming it).
//   * SCOPE: from what a request already records — its library, its request
//     type, its work class (at least one; each one given must match). Never
//     the engineered lane: an engineered request is never in scope, whatever
//     the record says.
//   * EXPIRY: required, at most PREAUTH_MAX_DAYS (365) after it is recorded
//     (20261264's CHECK says the same).
//   * WHERE IT ACTS: only on a slot the workspace explicitly opted in
//     (lib/routingControl.ts accepts_preauthorization → the roster slot's
//     acceptsPreauthorization), that is BLOCKING, not the engineering slot,
//     not an assurance slot (DF-P20's opt-in), and that the same person
//     would otherwise sign NOW — lib/workflow.ts slotSignPlan offers it to
//     them as a primary or (once its window opened) an alternate, never as
//     an override, with every DEC-37 independence leg applied — and never
//     the assigned drafter's (the producer's standing consent over their own
//     work is not a check).
//   * IT NEVER ISSUES A REQUEST: a pre-authorization never satisfies the
//     last open "must sign off" slot of a review — at least one stays for a
//     person's live act, whose sign-off then completes the review as it
//     always did (the issue path is the route's, unchanged).
//   * IT IS NEVER THE SECOND PERSON (fix pass 2): the DEC-12 producer floor
//     (lib/workflow.ts rosterLacksIndependentSignOff, lib/consentWindow.ts
//     consentFloorHolds) does not count a slot it satisfied, so the drafter's
//     own sign-off can never complete a review whose only other sign-offs are
//     pre-authorizations; and it is never applied where only the drafter
//     could then act (preauthLeavesNoSecondPerson), so the review never
//     deadlocks on that floor.
//   * DEFAULT OFF: no opted-in slot, or no table (before 20261264), or any
//     read that fails → nothing is read further / nothing applied: today's
//     review, byte for byte. Applying it is bookkeeping after the person's
//     act landed (DEC-90 ruling (5)): it never refuses or delays the
//     submission that opened the review.

import type { TicketReviewRoster, TicketReviewSlot } from "@/types/schema";
import { slotSignPlan, slotBlocks } from "@/lib/workflow";
import { DECLARATION_SIGNATURE_INTENT } from "@/lib/reviewModel";

/** The migration that carries ticket_preauthorizations. */
export const PREAUTH_MIGRATION = "20261264";
/** The longest a standing pre-authorization may run (20261264's CHECK). */
export const PREAUTH_MAX_DAYS = 365;
/** The signature's resource type (e_signatures.resource_type is free-form). */
export const PREAUTH_SIGNATURE_RESOURCE = "ticket_preauthorization";
/** The signature's intent — the like-in-kind declaration's (DEC-90 ruling
 *  (2): "an e-signature as the existing consent declaration uses"). */
export const PREAUTH_SIGNATURE_INTENT = DECLARATION_SIGNATURE_INTENT;
/** A signature older than this cannot record a pre-authorization (the
 *  declaration's freshness, 15 minutes). */
export const PREAUTH_SIGNATURE_MAX_AGE_MS = 15 * 60 * 1000;
/** The machine actor on the act that applies one (DEC-87 §2). */
export const PREAUTH_ACTOR = "system:standing-preauthorization";
export const PREAUTH_AUDIT = {
  recorded: "TICKET_PREAUTHORIZATION_RECORDED",
  revoked: "TICKET_PREAUTHORIZATION_REVOKED",
  applied: "TICKET_PREAUTHORIZATION_APPLIED",
} as const;
/** The history line's action (a step: a slot was satisfied). */
export const PREAUTH_HISTORY_ACTION = "Standing pre-authorization applied";

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A standing pre-authorization as the app reads it. */
export interface Preauthorization {
  id: string;
  orgId: string;
  grantorId: string;
  grantorName: string | null;
  libraryId: string | null;
  requestType: string | null;
  workClass: string | null;
  statement: string;
  signatureId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export function preauthFromRow(r: Record<string, unknown>): Preauthorization {
  const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    id: String(r.id ?? ""), orgId: String(r.org_id ?? ""), grantorId: String(r.grantor_id ?? ""), grantorName: s(r.grantor_name),
    libraryId: s(r.library_id), requestType: s(r.request_type), workClass: s(r.work_class),
    statement: String(r.statement ?? ""), signatureId: String(r.signature_id ?? ""),
    createdAt: String(r.created_at ?? ""), expiresAt: String(r.expires_at ?? ""),
    revokedAt: s(r.revoked_at), revokedBy: s(r.revoked_by), revokeReason: s(r.revoke_reason),
  };
}

/** The scope, as a person reads it ("requests in Piping, of type ISO"). */
export function preauthScopeWords(scope: { libraryName?: string | null; libraryId?: string | null; requestType?: string | null; workClass?: string | null }): string {
  const parts: string[] = [];
  if (scope.libraryId || scope.libraryName) parts.push(`in the library "${(scope.libraryName ?? "").trim() || scope.libraryId}"`);
  if (scope.requestType) parts.push(`of the request type "${scope.requestType}"`);
  if (scope.workClass) parts.push(`of the work class "${scope.workClass}"`);
  return parts.length ? `requests ${parts.join(", ")}` : "no requests";
}

/** The day an expiry falls on, as the statement names it (UTC). */
export const preauthExpiryDay = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : iso;
};

/**
 * The statement the person signs — composed the same way by the panel (from
 * what they chose) and by the route (from what it stores), so the signature
 * is checked against exactly what it says. Pure.
 */
export function preauthorizationStatement(input: { libraryName?: string | null; libraryId?: string | null; requestType?: string | null; workClass?: string | null; expiresAt: string }): string {
  return `I give my standing pre-authorization, until ${preauthExpiryDay(input.expiresAt)} (UTC), for my sign-off on ${preauthScopeWords(input)} — only on a review slot my workspace has set to accept a standing pre-authorization and that I would otherwise sign, and never on engineered work, an engineering sign-off or an assurance check. Each request that uses it names it, and I may revoke it at any time.`;
}

/** Why a draft cannot be recorded (null when it can). `now` in ms. Pure. */
export function preauthDraftRefusal(draft: { libraryId?: string | null; requestType?: string | null; workClass?: string | null; expiresAt?: string | null }, now: number): string | null {
  const lib = (draft.libraryId ?? "").trim();
  const type = (draft.requestType ?? "").trim();
  const cls = (draft.workClass ?? "").trim();
  if (!lib && !type && !cls) return "Choose what it covers: a library, a request type or a work class (at least one).";
  if (lib && !UUID_RE.test(lib)) return "That library is not one this workspace has.";
  if (type.length > 120 || cls.length > 120) return "A request type or work class name is at most 120 characters.";
  const exp = Date.parse(String(draft.expiresAt ?? ""));
  if (!Number.isFinite(exp)) return "Choose when it expires — a standing pre-authorization always ends.";
  if (exp <= now + 60 * 60 * 1000) return "It must run for at least an hour from now.";
  // A minute's margin: the row's created_at is the database's own clock.
  if (exp > now + PREAUTH_MAX_DAYS * DAY_MS - 60 * 1000) return `It can run for at most ${PREAUTH_MAX_DAYS} days from today.`;
  return null;
}

/** The latest day the panel offers (today + 364 days, so its end of day is
 *  within 365 days of now). */
export function preauthLatestDay(now: number): string {
  return new Date(now + (PREAUTH_MAX_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** A chosen day's end (23:59:59 UTC) as the stored expiry. */
export const preauthExpiryFromDay = (day: string): string => `${day}T23:59:59.000Z`;

/** Is the record in force at `now` — recorded, not yet expired, not revoked? */
export function preauthStanding(p: Pick<Preauthorization, "createdAt" | "expiresAt" | "revokedAt">, now: number): boolean {
  if (p.revokedAt) return false;
  const c = Date.parse(p.createdAt);
  const e = Date.parse(p.expiresAt);
  if (!Number.isFinite(e) || now >= e) return false;
  if (Number.isFinite(c) && (e - c > PREAUTH_MAX_DAYS * DAY_MS || now < c)) return false;
  return true;
}

/** Does the record's scope cover this request? Every dimension it names
 *  must equal the request's own recorded value; at least one is named.
 *  Pure. */
export function preauthCovers(p: Pick<Preauthorization, "orgId" | "libraryId" | "requestType" | "workClass">, ticket: { orgId: string; libraryId?: string | null; requestType?: string | null; workClass?: string | null }): boolean {
  if (p.orgId !== ticket.orgId) return false;
  if (!p.libraryId && !p.requestType && !p.workClass) return false;
  if (p.libraryId && p.libraryId !== (ticket.libraryId ?? null)) return false;
  if (p.requestType && p.requestType !== (ticket.requestType ?? null)) return false;
  if (p.workClass && p.workClass !== (ticket.workClass ?? null)) return false;
  return true;
}

/** The e-signature a record rests on, as the route reads it. */
export interface PreauthSignatureRow {
  id?: unknown; org_id?: unknown; resource_type?: unknown; resource_id?: unknown;
  signer_user_id?: unknown; intent?: unknown; statement?: unknown; signed_at?: unknown;
}

/** Why a signature cannot record THIS pre-authorization (null when it can):
 *  minted for this record's id, by its grantor, in this workspace, as an
 *  acknowledgement of exactly this statement, recently. Pure. */
export function preauthSignatureRefusal(sig: PreauthSignatureRow | null | undefined, ctx: { orgId: string; id: string; grantorId: string; statement: string; now: number }): string | null {
  if (!sig) return "The signature was not found — sign again.";
  if (sig.org_id !== ctx.orgId) return "The signature belongs to another workspace.";
  if (sig.resource_type !== PREAUTH_SIGNATURE_RESOURCE || String(sig.resource_id ?? "").toLowerCase() !== ctx.id.toLowerCase()) return "The signature was given for something else — sign again.";
  if (sig.signer_user_id !== ctx.grantorId) return "Only the person giving a standing pre-authorization can sign it.";
  if (sig.intent !== PREAUTH_SIGNATURE_INTENT) return "The signature does not record an acknowledgement.";
  if ((sig.statement ?? "") !== ctx.statement) return "What it covers changed after it was signed — sign again.";
  const at = Date.parse(String(sig.signed_at ?? ""));
  if (!Number.isFinite(at) || ctx.now - at > PREAUTH_SIGNATURE_MAX_AGE_MS || at - ctx.now > 5 * 60 * 1000) return "The signature has expired — sign again.";
  return null;
}

/** Does a stored record still rest on its signature (when it is used)? The
 *  freshness that bound the recording is not re-applied. Pure. */
export function preauthSignatureStands(sig: PreauthSignatureRow | null | undefined, p: Pick<Preauthorization, "id" | "orgId" | "grantorId" | "signatureId" | "statement">): boolean {
  if (!sig || String(sig.id ?? "") !== p.signatureId) return false;
  return sig.org_id === p.orgId && sig.resource_type === PREAUTH_SIGNATURE_RESOURCE
    && String(sig.resource_id ?? "").toLowerCase() === p.id.toLowerCase()
    && sig.signer_user_id === p.grantorId && sig.intent === PREAUTH_SIGNATURE_INTENT && (sig.statement ?? "") === p.statement;
}

/** The roster slots a pre-authorization may ever act on: open, blocking
 *  ("must sign off"), opted in, not the engineering slot, not an assurance
 *  slot. Pure. */
export function preauthEligibleSlots(roster: Pick<TicketReviewRoster, "slots">): TicketReviewSlot[] {
  return roster.slots.filter((s) => s.status === "open" && s.mode === "blocking" && s.acceptsPreauthorization === true
    && s.engineering !== true && s.recordsExamination !== true);
}

/** One application: `slot` satisfied by `preauth`'s grantor. */
export interface PreauthApplication { slot: TicketReviewSlot; preauth: Preauthorization }

/**
 * Which slots standing pre-authorizations satisfy on this review now. Pure.
 *   * Nothing on an engineered request.
 *   * Each eligible slot (preauthEligibleSlots), in roster order, by the
 *     first person — oldest record first — who (a) is an active member,
 *     (b) is not the assigned drafter, (c) is offered the slot NOW by
 *     slotSignPlan as a primary or an active alternate (never as an
 *     override; every DEC-37 independence leg applied, on the roster as the
 *     earlier applications left it), and (d) holds a record that stands, is
 *     signed, and covers the request.
 *   * Never the last open "must sign off" slot: at least one stays open for
 *     a person's live act (a pre-authorization never issues a request).
 *   * Never one that leaves another open "must sign off" slot worse off
 *     (DF-P22 fix pass — DEC-37 looked ahead): satisfying a slot by a
 *     person's record makes that person its signer, and a slot independent
 *     of it may then refuse them; an application that would leave any other
 *     open blocking slot with no one who could still sign it (as a primary or
 *     an active alternate — or at all, overrides included) when someone
 *     could before is skipped, and the next person's record, or the next
 *     slot, is tried.
 *   * Never one after which only the drafter could act (DF-P22 fix pass 2 —
 *     preauthLeavesNoSecondPerson): a pre-authorization is never the second
 *     person of the DEC-12 producer floor, so a live sign-off by someone
 *     other than the drafter must stay possible.
 */
export function planPreauthorizations(input: {
  roster: TicketReviewRoster;
  ticket: { orgId: string; requesterId?: string | null; assignedDrafterId?: string | null; libraryId?: string | null; requestType?: string | null; workClass?: string | null };
  engineered: boolean;
  preauths: readonly Preauthorization[];
  /** Records whose signature stands (by id). */
  signed: ReadonlySet<string>;
  activeMembers: ReadonlySet<string>;
  sodActive: boolean;
  now: number;
}): PreauthApplication[] {
  if (input.engineered) return [];
  const eligible = preauthEligibleSlots(input.roster);
  if (eligible.length === 0) return [];
  const usable = [...input.preauths]
    .filter((p) => preauthStanding(p, input.now) && input.signed.has(p.id) && preauthCovers(p, input.ticket)
      && input.activeMembers.has(p.grantorId) && p.grantorId !== (input.ticket.assignedDrafterId ?? null))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  if (usable.length === 0) return [];
  const out: PreauthApplication[] = [];
  let roster = input.roster;
  for (const slot of eligible) {
    // At least one open "must sign off" slot is left for a person's live act.
    const openBlocking = roster.slots.filter((s) => s.status === "open" && s.mode === "blocking");
    if (openBlocking.length <= 1) break;
    const parties = { requesterId: input.ticket.requesterId ?? "", assignedDrafterId: input.ticket.assignedDrafterId ?? undefined };
    let next: TicketReviewRoster | null = null;
    const pick = usable.find((p) => {
      const plan = slotSignPlan(roster, parties, p.grantorId, input.sodActive, input.now);
      if (!plan.fillable.some((f) => f.slot.kind === slot.kind && (f.via === "primary" || f.via === "alternate"))) return false;
      const tentative = applyPreauthorizations(roster, [{ slot, preauth: p }], new Date(input.now).toISOString(), () => p.grantorName ?? "");
      if (preauthLeavesSlotStranded(roster, tentative, slot.kind, parties, input.sodActive, input.now)) return false;
      if (preauthLeavesNoSecondPerson(tentative, parties, input.sodActive, input.now)) return false;
      next = tentative;
      return true;
    });
    if (!pick || !next) continue;
    out.push({ slot, preauth: pick });
    roster = next;
  }
  return out;
}

/** Who could still sign one open blocking slot, judged on its own (the
 *  slots already satisfied count; the other open ones do not — someone else
 *  may sign those first): `regular` when a primary or an active alternate
 *  could, `any` when anyone could, overrides included. Pure. */
export function slotSignability(
  roster: TicketReviewRoster, kind: string, parties: { requesterId: string; assignedDrafterId?: string }, sodActive: boolean, now: number,
): { regular: boolean; any: boolean } {
  const slot = roster.slots.find((s) => s.kind === kind);
  if (!slot) return { regular: false, any: false };
  const view: TicketReviewRoster = { ...roster, slots: roster.slots.filter((s) => s.kind === kind || s.status !== "open") };
  let regular = false;
  let any = false;
  for (const uid of new Set([...slot.primaries, ...slot.alternates, ...slot.overriders])) {
    const f = slotSignPlan(view, parties, uid, sodActive, now).fillable.find((x) => x.slot.kind === kind);
    if (!f) continue;
    any = true;
    if (f.via === "primary" || f.via === "alternate") { regular = true; break; }
  }
  return { regular, any };
}

/** Would applying a record to `appliedKind` (before → after) leave another
 *  open blocking slot with no one who could sign it, when someone could
 *  before? (DEC-37 slot-to-slot independence, looked ahead.) Pure. */
export function preauthLeavesSlotStranded(
  before: TicketReviewRoster, after: TicketReviewRoster, appliedKind: string,
  parties: { requesterId: string; assignedDrafterId?: string }, sodActive: boolean, now: number,
): boolean {
  for (const s of after.slots) {
    if (s.kind === appliedKind || s.status !== "open" || s.mode !== "blocking") continue;
    const was = slotSignability(before, s.kind, parties, sodActive, now);
    const is = slotSignability(after, s.kind, parties, sodActive, now);
    if ((was.regular && !is.regular) || (was.any && !is.any)) return true;
  }
  return false;
}

/**
 * DEC-12 producer floor, looked ahead (DF-P22 fix pass 2). A slot a
 * pre-authorization satisfied is never the "someone else" the floor asks for
 * (lib/workflow.ts rosterLacksIndependentSignOff ignores via
 * "preauthorization"), so after an application the review must still be
 * able to get a LIVE sign-off from someone other than the drafter: a
 * blocking slot already satisfied by such a person, or an open blocking slot
 * a non-drafter occupant may sign now (slotSignPlan on `after`, every
 * DEC-37 leg applied). Otherwise only the drafter could act on what is left,
 * and the floor would refuse them for good — the review would sit with every
 * way forward refused — so the application is skipped and the slot waits for
 * its live sign-off, as today. Only above the threshold with a drafter
 * assigned (below it the floor does not apply). Pure.
 */
export function preauthLeavesNoSecondPerson(
  after: TicketReviewRoster, parties: { requesterId: string; assignedDrafterId?: string }, sodActive: boolean, now: number,
): boolean {
  const drafter = parties.assignedDrafterId;
  if (!sodActive || !drafter) return false;
  const blocking = after.slots.filter((s) => slotBlocks(s) && s.status !== "void");
  if (blocking.some((s) => s.status === "satisfied" && !!s.satisfiedBy && s.satisfiedBy !== drafter && s.via !== "preauthorization")) return false;
  for (const s of blocking) {
    if (s.status !== "open") continue;
    for (const uid of new Set([...s.primaries, ...s.alternates, ...s.overriders])) {
      if (!uid || uid === drafter) continue;
      if (slotSignPlan(after, parties, uid, sodActive, now).fillable.some((f) => f.slot.kind === s.kind)) return false;
    }
  }
  return true;
}

/** The roster with each application's slot satisfied by its record. Pure. */
export function applyPreauthorizations(roster: TicketReviewRoster, apps: readonly PreauthApplication[], now: string, nameOf: (uid: string) => string): TicketReviewRoster {
  const by = new Map(apps.map((a) => [a.slot.kind, a.preauth] as const));
  return {
    ...roster,
    slots: roster.slots.map((s) => {
      const p = s.status === "open" ? by.get(s.kind) : undefined;
      if (!p) return s;
      const name = (nameOf(p.grantorId) || p.grantorName || "").trim() || "a member";
      return { ...s, status: "satisfied" as const, satisfiedBy: p.grantorId, satisfiedByName: `${name} (standing pre-authorization)`, satisfiedAt: now, signatureId: p.signatureId, via: "preauthorization" as const, preauthorizationId: p.id };
    }),
  };
}

/** The history line naming every pre-authorization used. */
export interface PreauthHistoryEntry { action: string; user: string; role: string; date: string; details: string; preauthorizations: Array<{ id: string; slot: string; grantor: string }> }

export function preauthHistoryEntry(apps: readonly PreauthApplication[], now: string, nameOf: (uid: string) => string): PreauthHistoryEntry {
  const lines = apps.map((a) => {
    const who = (nameOf(a.preauth.grantorId) || a.preauth.grantorName || "").trim() || "a member";
    return `"${a.slot.label || a.slot.kind}" — signed off by ${who}'s standing pre-authorization ${a.preauth.id} (recorded ${preauthExpiryDay(a.preauth.createdAt)}, expires ${preauthExpiryDay(a.preauth.expiresAt)}; ${preauthScopeWords(a.preauth)})`;
  });
  return {
    action: PREAUTH_HISTORY_ACTION,
    user: PREAUTH_ACTOR,
    role: "System",
    date: now,
    details: `${lines.join("; ")}. A standing pre-authorization never issues a request: the review still waits on its other sign-offs.`,
    preauthorizations: apps.map((a) => ({ id: a.preauth.id, slot: a.slot.kind, grantor: a.preauth.grantorId })),
  };
}

/** True when the error says 20261264's table is not there yet. */
export function isMissingPreauthTable(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  return (code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204") && /ticket_preauthorizations/.test(String(err.message ?? ""));
}
